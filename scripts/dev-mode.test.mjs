import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { developmentStatus, linkDevelopment, unlinkDevelopment } from "./dev-mode.mjs";

test("dev link is idempotent and unlink restores bundled runtime", async () => {
  const fixture = await makeFixture("0.6.7", "0.6.7");
  try {
    const first = await linkDevelopment(fixture.options);
    assert.equal(first.mode, "checkout");
    assert.equal(first.idempotent, false);
    assert.equal(first.mcp.effective.source, "checkout");
    assert.equal(first.nativeHost.effective.source, "checkout");

    const second = await linkDevelopment(fixture.options);
    assert.equal(second.idempotent, true);
    assert.equal(second.refreshedBundledRuntime, false);

    const unlinked = await unlinkDevelopment(fixture.options);
    assert.equal(unlinked.removed, true);
    assert.equal(unlinked.mode, "bundled");
    assert.equal(unlinked.mcp.effective.source, "bundled");
    assert.equal(unlinked.nativeHost.effective.source, "bundled");

    const again = await unlinkDevelopment(fixture.options);
    assert.equal(again.removed, false);
  } finally {
    await fixture.cleanup();
  }
});

test("dev status reports stale versions and invalid moved checkout", async () => {
  const fixture = await makeFixture("0.6.7", "0.6.6");
  try {
    let status = await developmentStatus(fixture.options);
    assert.match(status.mismatches.join("\n"), /installed plugin 0\.6\.6 differs from repo 0\.6\.7/);

    await linkDevelopment(fixture.options);
    const moved = `${fixture.projectDir}-moved`;
    await rename(fixture.projectDir, moved);
    status = await developmentStatus({ ...fixture.options, projectDir: moved });
    assert.equal(status.devLink.valid, false);
    assert.match(status.devLink.error, /no longer exists/);

    const relinked = await linkDevelopment({ ...fixture.options, projectDir: moved });
    assert.equal(relinked.devLink.checkoutRoot, await realpath(moved));
    await rename(moved, fixture.projectDir);
  } finally {
    await fixture.cleanup();
  }
});

test("dev unlink refuses a symlink instead of deleting an arbitrary target", async () => {
  const fixture = await makeFixture("0.6.7", "0.6.7");
  const target = path.join(fixture.root, "keep.json");
  try {
    await writeFile(target, "keep\n");
    await symlink(target, path.join(fixture.stateDir, "dev-link.json"));
    await assert.rejects(unlinkDevelopment(fixture.options), /non-regular development pointer/);
    assert.equal(await readFile(target, "utf8"), "keep\n");
  } finally {
    await fixture.cleanup();
  }
});

async function makeFixture(repoVersion, installedVersion) {
  const root = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-dev-mode-"));
  const projectDir = path.join(root, "checkout");
  const stateDir = path.join(root, "state");
  const pluginDir = path.join(root, "installed-plugin");
  await mkdir(path.join(projectDir, "plugins", "chromium-bridge", "mcp"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(projectDir, "native-host", "src"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(stateDir, "runtime"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(stateDir, "bin"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(pluginDir, ".codex-plugin"), { recursive: true });
  await mkdir(path.join(pluginDir, "mcp"), { recursive: true });
  await chmod(projectDir, 0o700);
  await chmod(stateDir, 0o700);

  await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "chromium-bridge", version: repoVersion }));
  await writeFile(path.join(projectDir, "plugins", "chromium-bridge", "mcp", "server.mjs"), "export {};\n");
  await writeFile(path.join(projectDir, "native-host", "src", "cli.mjs"), "export {};\n");
  await writeFile(path.join(projectDir, "native-host", "src", "host.mjs"), "export {};\n");
  await writeFile(path.join(stateDir, "runtime", "runtime-bootstrap.mjs"), "export {};\n", { mode: 0o600 });
  await writeFile(path.join(stateDir, "runtime", "host.mjs"), "export {};\n", { mode: 0o600 });
  await writeFile(path.join(stateDir, "runtime", "cli.mjs"), "export {};\n", { mode: 0o600 });
  await writeFile(path.join(stateDir, "runtime", "runtime.json"), JSON.stringify({ version: repoVersion }));
  await writeFile(path.join(stateDir, "bin", "chromium-bridge-host"), `exec 'node' '${path.join(stateDir, "runtime", "runtime-bootstrap.mjs")}' 'native-host' "$@"\n`, { mode: 0o700 });
  await writeFile(path.join(stateDir, "bin", "chromium-bridge"), `exec 'node' '${path.join(stateDir, "runtime", "runtime-bootstrap.mjs")}' 'cli' "$@"\n`, { mode: 0o700 });
  await writeFile(path.join(pluginDir, ".codex-plugin", "plugin.json"), JSON.stringify({ version: installedVersion }));
  await writeFile(path.join(pluginDir, "mcp", "server.mjs"), "export {};\n");
  await writeFile(path.join(pluginDir, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "chromium-bridge": {
        command: "node",
        args: [path.join(stateDir, "runtime", "runtime-bootstrap.mjs"), "mcp"],
        cwd: "."
      }
    }
  }));

  return {
    root,
    projectDir,
    stateDir,
    options: { projectDir, stateDir, installedPluginPath: pluginDir, codexPath: null, skipInstall: true },
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}
