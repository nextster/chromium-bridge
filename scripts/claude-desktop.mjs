import os from "node:os";
import process from "node:process";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { atomicWriteFile } from "../native-host/src/atomic-file.mjs";
import { pathApiFor } from "./platform.mjs";

const execFileAsync = promisify(execFile);

export const CLAUDE_DESKTOP_SERVER_NAME = "chromium-bridge";
const CONFIG_FILE = "claude_desktop_config.json";

// Claude Desktop reads local MCP servers from claude_desktop_config.json. The
// Windows Store (MSIX) build may keep a virtualized copy under its package
// LocalCache, so every existing copy is updated.
export async function claudeDesktopLocations(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  const pathApi = pathApiFor(platform);
  const exists = options.exists || (async filePath => stat(filePath).then(() => true, () => false));
  const listDirectory = options.listDirectory || (async directory => readdir(directory).catch(() => []));

  let primaryDir;
  let configDirs;
  let applications;
  if (platform === "win32") {
    const appData = env.APPDATA || pathApi.join(homedir, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA || pathApi.join(homedir, "AppData", "Local");
    const packagesDir = pathApi.join(localAppData, "Packages");
    primaryDir = pathApi.join(appData, "Claude");
    const packaged = (await listDirectory(packagesDir))
      .filter(name => /^Claude_/i.test(name))
      .map(name => pathApi.join(packagesDir, name, "LocalCache", "Roaming", "Claude"));
    configDirs = [primaryDir, ...packaged];
    applications = [pathApi.join(localAppData, "AnthropicClaude"), ...packaged];
  } else if (platform === "darwin") {
    primaryDir = pathApi.join(homedir, "Library", "Application Support", "Claude");
    configDirs = [primaryDir];
    applications = ["/Applications/Claude.app", pathApi.join(homedir, "Applications", "Claude.app")];
  } else {
    return { supported: false, installed: false, configPaths: [] };
  }

  const existingDirs = [];
  for (const directory of configDirs) {
    if (await exists(directory)) existingDirs.push(directory);
  }
  let applicationFound = false;
  for (const application of applications) {
    if (await exists(application)) {
      applicationFound = true;
      break;
    }
  }
  const installed = applicationFound || existingDirs.length > 0;
  const targetDirs = existingDirs.length ? existingDirs : installed ? [primaryDir] : [];
  return {
    supported: true,
    installed,
    configPaths: targetDirs.map(directory => pathApi.join(directory, CONFIG_FILE))
  };
}

// Claude Desktop reads mcpServers at startup and rewrites the whole config
// from memory whenever it saves its own settings, so an entry added while it
// runs survives only if the app restarts before its next save.
export async function isClaudeDesktopRunning(options = {}) {
  const platform = options.platform || process.platform;
  const execute = options.execute || execFileAsync;
  try {
    if (platform === "win32") {
      const { stdout } = await execute("tasklist.exe", ["/FI", "IMAGENAME eq Claude.exe", "/NH"], { windowsHide: true });
      return /^claude\.exe/im.test(stdout);
    }
    if (platform === "darwin") {
      const { stdout } = await execute("/bin/ps", ["-axo", "comm="]);
      return stdout.split("\n").some(line => line.trim().endsWith("/Claude.app/Contents/MacOS/Claude"));
    }
  } catch {}
  return false;
}

export function desktopServerEntry(nodePath, bootstrapPath) {
  return { command: nodePath, args: [bootstrapPath, "mcp"] };
}

export function mergeDesktopServer(text, entry) {
  const config = parseConfig(text);
  const servers = config.mcpServers ?? {};
  if (!isPlainObject(servers)) throw new Error("Claude Desktop config mcpServers must be an object");
  const previous = servers[CLAUDE_DESKTOP_SERVER_NAME];
  if (previous && JSON.stringify(previous) === JSON.stringify(entry)) {
    return { action: "unchanged", text };
  }
  config.mcpServers = { ...servers, [CLAUDE_DESKTOP_SERVER_NAME]: entry };
  return { action: previous ? "updated" : "added", text: `${JSON.stringify(config, null, 2)}\n` };
}

export function removeDesktopServer(text, isOwnedEntry) {
  if (!String(text || "").trim()) return { action: "absent", text };
  const config = parseConfig(text);
  const servers = config.mcpServers;
  if (!isPlainObject(servers) || !(CLAUDE_DESKTOP_SERVER_NAME in servers)) return { action: "absent", text };
  if (!isOwnedEntry(servers[CLAUDE_DESKTOP_SERVER_NAME])) return { action: "kept-foreign", text };
  const { [CLAUDE_DESKTOP_SERVER_NAME]: _removed, ...rest } = servers;
  if (Object.keys(rest).length) config.mcpServers = rest;
  else delete config.mcpServers;
  return { action: "removed", text: `${JSON.stringify(config, null, 2)}\n` };
}

export function ownsDesktopEntry(entry, bootstrapPath, platform = process.platform) {
  const normalize = value => {
    const resolved = pathApiFor(platform).resolve(String(value || ""));
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return Array.isArray(entry?.args) && entry.args[1] === "mcp" && normalize(entry.args[0]) === normalize(bootstrapPath);
}

export async function registerClaudeDesktop(options) {
  const locations = await claudeDesktopLocations(options);
  if (!locations.installed) return { skipped: true, reason: "Claude Desktop not found" };
  const entry = desktopServerEntry(options.nodePath, options.bootstrapPath);
  const results = [];
  for (const configPath of locations.configPaths) {
    const before = await readOptional(configPath);
    const merged = mergeDesktopServer(before, entry);
    if (merged.action !== "unchanged" && !options.dryRun) {
      await writeConfig(configPath, before, merged.text, options.platform);
    }
    results.push({ configPath, action: merged.action });
  }
  const restartRequired = results.some(item => item.action !== "unchanged");
  return {
    skipped: false,
    dryRun: Boolean(options.dryRun),
    server: CLAUDE_DESKTOP_SERVER_NAME,
    configs: results,
    restartRequired,
    appRunning: restartRequired ? await isClaudeDesktopRunning(options) : false
  };
}

export async function unregisterClaudeDesktop(options) {
  const locations = await claudeDesktopLocations(options);
  const results = [];
  for (const configPath of locations.configPaths) {
    const before = await readOptional(configPath);
    const removed = removeDesktopServer(before, entry => ownsDesktopEntry(entry, options.bootstrapPath, options.platform));
    if (removed.action === "removed" && !options.dryRun) {
      await writeConfig(configPath, before, removed.text, options.platform);
    }
    results.push({ configPath, action: removed.action });
  }
  return { dryRun: Boolean(options.dryRun), configs: results };
}

async function writeConfig(configPath, before, text, platform = process.platform) {
  const pathApi = pathApiFor(platform);
  await mkdir(pathApi.dirname(configPath), { recursive: true });
  const mode = await stat(configPath).then(item => item.mode & 0o777, () => 0o600);
  if (before) await copyFile(configPath, `${configPath}.chromium-bridge-backup`);
  await atomicWriteFile(configPath, text, mode);
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function parseConfig(text) {
  if (!String(text || "").trim()) return {};
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new Error(`Claude Desktop config is not valid JSON; leaving it unchanged: ${error.message}`);
  }
  if (!isPlainObject(config)) throw new Error("Claude Desktop config must be a JSON object");
  return config;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
