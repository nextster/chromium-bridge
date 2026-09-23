import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("setup registers Codex and Claude clients in the shared marketplace and uninstall preserves captures", {
  skip: process.platform !== "darwin"
}, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-setup-"));
  const binDir = path.join(home, "test-bin");
  const codexPath = path.join(binDir, "codex");
  const claudePath = path.join(binDir, "claude");
  const logPath = path.join(home, "codex-calls.ndjson");
  const claudeLogPath = path.join(home, "claude-calls.ndjson");
  await mkdir(binDir, { recursive: true });
  await writeFile(claudePath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.CLAUDE_TEST_LOG, JSON.stringify(args) + "\\n");
if (args.join(" ") === "plugin marketplace list --json") console.log("[]");
else if (args.join(" ") === "plugin list --json") console.log("[]");
else console.log("ok");
`, { mode: 0o700 });
  await chmod(claudePath, 0o700);
  await mkdir(path.join(home, "Applications", "Claude.app"), { recursive: true });
  await writeFile(codexPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.CODEX_TEST_LOG, JSON.stringify(args) + "\\n");
if (args.join(" ") === "plugin marketplace list --json") console.log(JSON.stringify({ marketplaces: [] }));
else if (args.join(" ") === "plugin list --json") console.log(JSON.stringify({ installed: [] }));
else if (args.join(" ") === "plugin add chromium-bridge@nextster --json") console.log(JSON.stringify({
  installedPath: process.env.CODEX_TEST_INSTALLED_PATH
}));
else console.log(JSON.stringify({ ok: true }));
`, { mode: 0o700 });
  await chmod(codexPath, 0o700);

  try {
    const legacyCapture = path.join(home, ".chromium-sidecar", "captures", "kept.txt");
    const legacyCli = path.join(home, ".chromium-sidecar", "bin", "chromium-sidecar");
    const legacyManifest = path.join(
      home,
      "Library",
      "Application Support",
      "Arc",
      "User Data",
      "NativeMessagingHosts",
      "com.chromium_sidecar.bridge.json"
    );
    await mkdir(path.dirname(legacyCapture), { recursive: true });
    await mkdir(path.dirname(legacyCli), { recursive: true });
    await mkdir(path.dirname(legacyManifest), { recursive: true });
    await writeFile(legacyCapture, "keep");
    await writeFile(legacyCli, "old");
    await writeFile(legacyManifest, "{}");
    await writeFile(path.join(home, ".chromium-sidecar", "dev-link.json"), "{}", { mode: 0o600 });
    const legacyMarketplaceRoot = path.join(home, ".codex", "marketplaces", "nextster");
    const marketplaceRoot = path.join(home, ".agent-plugins", "nextster");
    const legacyTelegramPlugin = path.join(legacyMarketplaceRoot, "plugins", "telegram-bridge");
    const telegramPlugin = path.join(marketplaceRoot, "plugins", "telegram-bridge");
    await mkdir(path.join(legacyMarketplaceRoot, ".agents", "plugins"), { recursive: true });
    await mkdir(legacyTelegramPlugin, { recursive: true });
    await writeFile(path.join(legacyTelegramPlugin, "marker.txt"), "keep");
    await writeFile(path.join(legacyMarketplaceRoot, ".agents", "plugins", "marketplace.json"), JSON.stringify({
      name: "nextster",
      interface: { displayName: "Nextster" },
      plugins: [{ name: "telegram-bridge", source: { source: "local", path: "./plugins/telegram-bridge" } }]
    }));
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(projectDir, "scripts", "setup.mjs"),
      "--host-only",
      "--no-open",
      "--no-wait"
    ], {
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: path.join(home, ".codex"),
        CODEX_TEST_LOG: logPath,
        CLAUDE_TEST_LOG: claudeLogPath,
        CODEX_TEST_INSTALLED_PATH: path.join(home, ".codex", "plugins", "cache", "nextster", "chromium-bridge", "0.7.3"),
        PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`
      }
    });
    const result = JSON.parse(stdout);
    assert.equal(result.migration.migrated, true);
    assert.equal(result.migration.moved, true);
    assert.equal(result.developmentLinkReset, true);
    await assert.rejects(access(path.join(home, ".chromium-bridge", "dev-link.json")));
    await assert.rejects(access(path.join(home, ".chromium-sidecar")));
    await assert.rejects(access(legacyManifest));
    await assert.rejects(access(path.join(home, ".chromium-bridge", "bin", "chromium-sidecar")));
    assert.equal(result.codex.marketplaceRoot, marketplaceRoot);
    assert.equal(result.marketplace.migration.moved, true);
    assert.equal(await readlink(legacyMarketplaceRoot), marketplaceRoot);
    assert.match(await readFile(path.join(marketplaceRoot, "README.md"), "utf8"), /shared by\nCodex and Claude Code/);
    const marketplace = JSON.parse(
      await readFile(path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), "utf8")
    );
    assert.equal(marketplace.name, "nextster");
    assert.deepEqual(marketplace.plugins.map(item => item.name), ["telegram-bridge", "chromium-bridge"]);
    assert.equal(await readFile(path.join(telegramPlugin, "marker.txt"), "utf8"), "keep");
    const mcp = JSON.parse(
      await readFile(path.join(marketplaceRoot, "plugins", "chromium-bridge", ".mcp.json"), "utf8")
    );
    const bootstrapPath = path.join(home, ".chromium-bridge", "runtime", "runtime-bootstrap.mjs");
    assert.deepEqual(mcp.mcpServers["chromium-bridge"], {
      command: result.nativeHost.node,
      args: [bootstrapPath, "mcp"]
    });
    await access(path.join(home, ".chromium-bridge", "runtime", "mcp-server.mjs"));
    const claudeMarketplace = JSON.parse(
      await readFile(path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"), "utf8")
    );
    assert.equal(claudeMarketplace.name, "nextster");
    assert.deepEqual(claudeMarketplace.plugins.map(item => [item.name, item.source]), [
      ["chromium-bridge", "./plugins/chromium-bridge"]
    ]);
    const claudeCalls = (await readFile(claudeLogPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(claudeCalls.map(args => args.join(" ")), [
      "plugin marketplace list --json",
      `plugin marketplace add ${marketplaceRoot} --scope user`,
      "plugin list --json",
      "plugin install chromium-bridge@nextster --scope user"
    ]);
    assert.equal(result.claudeDesktop.restartRequired, true);
    const desktopConfigPath = path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    assert.deepEqual(JSON.parse(await readFile(desktopConfigPath, "utf8")).mcpServers["chromium-bridge"], {
      command: result.nativeHost.node,
      args: [bootstrapPath, "mcp"]
    });
    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(calls.some(args => args.join(" ") === `plugin marketplace add ${marketplaceRoot} --json`));
    assert.ok(calls.some(args => args.join(" ") === "plugin add chromium-bridge@nextster --json"));
    assert.ok(calls.some(args => args.join(" ") === "plugin remove chromium-bridge@chromium-bridge --json"));
    assert.ok(calls.some(args => args.join(" ") === "plugin remove chromium-sidecar@chromium-sidecar --json"));
    assert.ok(calls.some(args => args.join(" ") === "plugin marketplace remove chromium-sidecar --json"));
    const retainedCapture = path.join(home, ".chromium-bridge", "captures", "kept.txt");
    assert.equal(await readFile(retainedCapture, "utf8"), "keep");
    const uninstall = JSON.parse((await execFileAsync(process.execPath, [
      path.join(projectDir, "scripts", "uninstall.mjs"),
      "--no-open"
    ], {
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: path.join(home, ".codex"),
        CODEX_TEST_LOG: logPath,
        CLAUDE_TEST_LOG: claudeLogPath,
        PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`
      }
    })).stdout);
    assert.equal(uninstall.uninstalled, true);
    assert.equal(uninstall.retainedCaptures, true);
    assert.equal(await readFile(retainedCapture, "utf8"), "keep");
    const marketplaceAfterUninstall = JSON.parse(
      await readFile(path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), "utf8")
    );
    assert.deepEqual(marketplaceAfterUninstall.plugins.map(item => item.name), ["telegram-bridge"]);
    assert.equal(await readFile(path.join(telegramPlugin, "marker.txt"), "utf8"), "keep");
    assert.equal(await readlink(legacyMarketplaceRoot), marketplaceRoot);
    assert.equal(uninstall.compatLinkRemoved, false);
    const uninstallCalls = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(uninstallCalls.some(args => args.join(" ") === "plugin remove chromium-bridge@nextster --json"));
    assert.ok(uninstallCalls.some(args => args.join(" ") === "plugin marketplace remove chromium-bridge --json"));
    assert.ok(!uninstallCalls.some(args => args.join(" ") === "plugin marketplace remove nextster --json"));
    const claudeUninstallCalls = (await readFile(claudeLogPath, "utf8")).trim().split("\n").map(JSON.parse).slice(claudeCalls.length);
    assert.deepEqual(claudeUninstallCalls.map(args => args.join(" ")), [
      "plugin uninstall chromium-bridge@nextster --scope user",
      "plugin marketplace remove nextster"
    ]);
    assert.equal(JSON.parse(await readFile(desktopConfigPath, "utf8")).mcpServers, undefined);
    assert.deepEqual(uninstall.claudeDesktop.configs.map(item => item.action), ["removed"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("setup automatically selects Store mode when an extension id is supplied", async () => {
  const storeId = "abcdefghijklmnopabcdefghijklmnop";
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(projectDir, "scripts", "setup.mjs"),
    "--dry-run",
    "--no-codex",
    "--no-claude",
    "--no-open",
    "--extension-id",
    storeId
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.mode, "store");
  assert.equal(result.storeExtensionId, storeId);
  assert.equal(result.extensionPath, null);
});

test("source setup preserves the previous unpacked extension path as a symlink", {
  skip: process.platform !== "darwin"
}, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-extension-migration-"));
  await mkdir(path.join(home, ".chromium-sidecar", "extension"), { recursive: true });
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(projectDir, "scripts", "setup.mjs"),
      "--source",
      "--no-codex",
      "--no-claude",
      "--no-open"
    ], { env: { ...process.env, HOME: home } });
    const result = JSON.parse(stdout);
    assert.equal(result.migration.migrated, true);
    assert.equal(
      await readlink(path.join(home, ".chromium-sidecar", "extension")),
      path.join(home, ".chromium-bridge", "extension")
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("setup can refresh runtime and Codex without touching an existing development extension", {
  skip: process.platform !== "darwin"
}, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-no-extension-"));
  const extensionMarker = path.join(home, ".chromium-bridge", "extension", "marker.txt");
  await mkdir(path.dirname(extensionMarker), { recursive: true });
  await writeFile(extensionMarker, "unchanged");
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(projectDir, "scripts", "setup.mjs"),
      "--host-only",
      "--no-extension",
      "--no-codex",
      "--no-claude",
      "--no-open",
      "--no-wait"
    ], { env: { ...process.env, HOME: home } });
    const result = JSON.parse(stdout);
    assert.equal(result.extensionReload.attempted, false);
    assert.equal(await readFile(extensionMarker, "utf8"), "unchanged");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
