import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  claudeDesktopLocations,
  desktopServerEntry,
  mergeDesktopServer,
  ownsDesktopEntry,
  registerClaudeDesktop,
  removeDesktopServer,
  unregisterClaudeDesktop
} from "./claude-desktop.mjs";

const entry = desktopServerEntry("/opt/node", "/home/ann/.chromium-bridge/runtime/runtime-bootstrap.mjs");

test("Claude Desktop merge preserves preferences and other servers", () => {
  const original = JSON.stringify({
    preferences: { sidebarMode: "chat" },
    mcpServers: { other: { command: "other" } }
  });
  const added = mergeDesktopServer(original, entry);
  assert.equal(added.action, "added");
  assert.deepEqual(JSON.parse(added.text), {
    preferences: { sidebarMode: "chat" },
    mcpServers: { other: { command: "other" }, "chromium-bridge": entry }
  });
  assert.equal(mergeDesktopServer(added.text, entry).action, "unchanged");
  assert.equal(mergeDesktopServer(added.text, { ...entry, command: "/usr/local/bin/node" }).action, "updated");
  assert.throws(() => mergeDesktopServer("{ not json", entry), /not valid JSON/);
  assert.throws(() => mergeDesktopServer(JSON.stringify({ mcpServers: [] }), entry), /must be an object/);
});

test("Claude Desktop removal leaves foreign entries named chromium-bridge", () => {
  const owns = value => ownsDesktopEntry(value, "/home/ann/.chromium-bridge/runtime/runtime-bootstrap.mjs", "darwin");
  const withOurs = mergeDesktopServer(JSON.stringify({ preferences: {} }), entry).text;
  const removed = removeDesktopServer(withOurs, owns);
  assert.equal(removed.action, "removed");
  assert.deepEqual(JSON.parse(removed.text), { preferences: {} });

  const foreign = JSON.stringify({ mcpServers: { "chromium-bridge": { command: "node", args: ["/elsewhere/server.mjs"] } } });
  assert.equal(removeDesktopServer(foreign, owns).action, "kept-foreign");
  assert.equal(removeDesktopServer("", owns).action, "absent");
  assert.equal(
    ownsDesktopEntry({ args: ["c:\\users\\ann\\.chromium-bridge\\runtime\\runtime-bootstrap.mjs", "mcp"] }, "C:\\Users\\Ann\\.chromium-bridge\\runtime\\runtime-bootstrap.mjs", "win32"),
    true
  );
});

test("Windows locations include the MSIX virtualized config copy", async () => {
  const env = { APPDATA: "C:\\Users\\Ann\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\Ann\\AppData\\Local" };
  const packaged = "C:\\Users\\Ann\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude";
  const existing = new Set([packaged]);
  const locations = await claudeDesktopLocations({
    platform: "win32",
    env,
    homedir: "C:\\Users\\Ann",
    exists: async candidate => existing.has(candidate),
    listDirectory: async () => ["Claude_pzs8sxrjxfjjc", "Microsoft.Other"]
  });
  assert.deepEqual(locations, {
    supported: true,
    installed: true,
    configPaths: [`${packaged}\\claude_desktop_config.json`]
  });

  const absent = await claudeDesktopLocations({
    platform: "win32",
    env,
    homedir: "C:\\Users\\Ann",
    exists: async () => false,
    listDirectory: async () => []
  });
  assert.deepEqual(absent, { supported: true, installed: false, configPaths: [] });
});

test("registration writes atomically with a backup and preserves the file mode", {
  skip: process.platform === "win32" && "uses macOS config locations and POSIX modes"
}, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-desktop-"));
  const configDir = path.join(home, "Library", "Application Support", "Claude");
  const configPath = path.join(configDir, "claude_desktop_config.json");
  const bootstrapPath = path.join(home, ".chromium-bridge", "runtime", "runtime-bootstrap.mjs");
  try {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, JSON.stringify({ preferences: { menuBarEnabled: true } }), { mode: 0o600 });
    const options = { platform: "darwin", env: {}, homedir: home, nodePath: "/opt/node", bootstrapPath };

    const dryRun = await registerClaudeDesktop({ ...options, dryRun: true });
    assert.deepEqual(dryRun.configs, [{ configPath, action: "added" }]);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).mcpServers, undefined);

    const registered = await registerClaudeDesktop(options);
    assert.equal(registered.restartRequired, true);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(`${configPath}.chromium-bridge-backup`, "utf8")), {
      preferences: { menuBarEnabled: true }
    });
    assert.equal((await registerClaudeDesktop(options)).restartRequired, false);

    const unregistered = await unregisterClaudeDesktop(options);
    assert.deepEqual(unregistered.configs, [{ configPath, action: "removed" }]);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { preferences: { menuBarEnabled: true } });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
