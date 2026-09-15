import os from "node:os";
import process from "node:process";
import { findExecutable, firstExecutable, pathApiFor, versionedChildren } from "./platform.mjs";

// Claude Code's CLI and the desktop app's Code tab share ~/.claude, so any of
// these binaries can register the plugin for both.
export async function findClaudeCli(options = {}) {
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const platform = options.platform || process.platform;
  const pathApi = pathApiFor(platform);
  const lookup = { platform, isExecutable: options.isExecutable };
  const listVersions = options.listVersions || versionedChildren;
  const candidates = [env.CHROMIUM_BRIDGE_CLAUDE, await findExecutable("claude", { ...lookup, env })];

  if (platform === "win32") {
    candidates.push(pathApi.join(home, ".local", "bin", "claude.exe"));
    const bundledRoot = pathApi.join(env.APPDATA || pathApi.join(home, "AppData", "Roaming"), "Claude", "claude-code");
    for (const version of await listVersions(bundledRoot)) {
      candidates.push(pathApi.join(bundledRoot, version, "claude.exe"));
    }
    candidates.push(pathApi.join(env.APPDATA || pathApi.join(home, "AppData", "Roaming"), "npm", "claude.cmd"));
  } else {
    candidates.push(pathApi.join(home, ".local", "bin", "claude"));
    const bundledRoot = pathApi.join(home, "Library", "Application Support", "Claude", "claude-code");
    for (const version of await listVersions(bundledRoot)) {
      candidates.push(pathApi.join(bundledRoot, version, "claude.app", "Contents", "MacOS", "claude"));
    }
  }
  return firstExecutable(candidates, lookup);
}
