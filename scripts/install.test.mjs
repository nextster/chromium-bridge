import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("shell installer verifies and installs its portable Node fallback", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-shell-install-"));
  const nodeArch = process.arch === "arm64" ? "arm64" : "x64";
  const archiveRoot = path.join(home, `node-v24.19.0-darwin-${nodeArch}`);
  const fakeNode = path.join(archiveRoot, "bin", "node");
  const archive = path.join(home, "node.tar.gz");
  await mkdir(path.dirname(fakeNode), { recursive: true });
  const systemNode = `'${process.execPath.replaceAll("'", "'\\''")}'`;
  await writeFile(fakeNode, `#!/bin/sh\nexec ${systemNode} "$@"\n`, { mode: 0o700 });
  await chmod(fakeNode, 0o700);
  await execFileAsync("tar", ["-czf", archive, "-C", home, path.basename(archiveRoot)]);
  const sha256 = crypto.createHash("sha256").update(await readFile(archive)).digest("hex");

  try {
    const { stdout } = await execFileAsync("sh", [
      path.join(projectDir, "install.sh"),
      "--dry-run",
      "--no-codex",
      "--no-open"
    ], {
      env: {
        ...process.env,
        HOME: home,
        CHROMIUM_BRIDGE_FORCE_PORTABLE_NODE: "1",
        CHROMIUM_BRIDGE_SOURCE_DIR: projectDir,
        CHROMIUM_BRIDGE_TEST_NODE_ARCHIVE: archive,
        CHROMIUM_BRIDGE_TEST_NODE_SHA256: sha256
      }
    });
    const result = JSON.parse(stdout);
    assert.equal(result.mode, "source");
    assert.equal(result.dryRun, true);
    assert.equal(
      await readFile(path.join(home, ".chromium-bridge", "node", "bin", "node"), "utf8"),
      await readFile(fakeNode, "utf8")
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("shell installer migrates the previous state directory before selecting Node", {
  skip: process.platform !== "darwin"
}, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-shell-migration-"));
  const legacyNode = path.join(home, ".chromium-sidecar", "node", "bin", "node");
  const legacyCapture = path.join(home, ".chromium-sidecar", "captures", "kept.txt");
  await mkdir(path.dirname(legacyNode), { recursive: true });
  await mkdir(path.dirname(legacyCapture), { recursive: true });
  const systemNode = `'${process.execPath.replaceAll("'", "'\\''")}'`;
  await writeFile(legacyNode, `#!/bin/sh\nexec ${systemNode} "$@"\n`, { mode: 0o700 });
  await writeFile(legacyCapture, "keep");

  try {
    const { stdout } = await execFileAsync("sh", [
      path.join(projectDir, "install.sh"),
      "--host-only",
      "--no-codex",
      "--no-open"
    ], {
      env: {
        ...process.env,
        HOME: home,
        CHROMIUM_BRIDGE_SOURCE_DIR: projectDir
      }
    });
    const result = JSON.parse(stdout);
    assert.equal(result.nativeHost.node, path.join(home, ".chromium-bridge", "node", "bin", "node"));
    assert.equal(await readFile(path.join(home, ".chromium-bridge", "captures", "kept.txt"), "utf8"), "keep");
    await assert.rejects(readFile(path.join(home, ".chromium-sidecar", "captures", "kept.txt")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
