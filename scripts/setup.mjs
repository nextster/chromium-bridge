import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const skipCodex = args.has("--no-codex");
const skipOpen = args.has("--no-open");
const dryRun = args.has("--dry-run");
const hostOnly = args.has("--host-only");
const extensionId = argumentValue("--extension-id");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const sourceExtensionDir = path.join(projectDir, "extension");
const stateDir = path.join(os.homedir(), ".chromium-sidecar");
const installedExtensionDir = path.join(stateDir, "extension");
const temporaryExtensionDir = `${installedExtensionDir}.tmp-${process.pid}`;
const installedMarketplaceDir = path.join(stateDir, "codex-marketplace");
const installerPath = path.join(projectDir, "native-host", "src", "install.mjs");

if (process.platform !== "darwin" && !dryRun) {
  throw new Error("The setup command currently supports macOS. The extension and MCP server are portable, but Native Messaging registration paths still need a platform installer.");
}
if (Number(process.versions.node.split(".")[0]) < 20) {
  throw new Error(`Node.js 20 or newer is required; found ${process.version}`);
}

if (!dryRun && !hostOnly) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await rm(temporaryExtensionDir, { recursive: true, force: true });
  await cp(sourceExtensionDir, temporaryExtensionDir, { recursive: true });
  await rm(installedExtensionDir, { recursive: true, force: true });
  await rename(temporaryExtensionDir, installedExtensionDir);
}

const hostResult = await runJson(process.execPath, [
  installerPath,
  ...(dryRun ? ["--dry-run"] : []),
  ...(extensionId ? ["--extension-id", extensionId] : [])
]);
let extensionReload = { attempted: false, reloaded: false };
if (!dryRun && !hostOnly) {
  extensionReload = await reloadRunningExtension(hostResult.cliLauncherPath);
}
let codexResult = { skipped: true, reason: skipCodex ? "disabled by --no-codex" : "Codex CLI not found" };
if (!skipCodex && await commandExists("codex")) {
  codexResult = dryRun ? { skipped: true, reason: "dry run" } : await installCodexPlugin();
}

const browser = detectBrowser();
if (!skipOpen && !dryRun && !hostOnly && browser) {
  await execFileAsync("/usr/bin/open", ["-a", browser.application, browser.extensionsUrl]);
}

const next = hostOnly
  ? [
      "Reload the store-installed Chromium Sidecar extension",
      ...(!skipCodex && !codexResult.skipped ? ["Reload Codex to activate the updated plugin"] : [])
    ]
  : extensionReload.reloaded
  ? [
      "Chromium Sidecar reloaded in the running browser",
      ...(!skipCodex && !codexResult.skipped ? ["Reload Codex to activate the updated plugin"] : [])
    ]
  : [
      `Open ${browser?.extensionsUrl || "your browser's extensions page"}`,
      "Enable Developer mode",
      `Choose Load unpacked and select ${installedExtensionDir}`,
      ...(!skipCodex && !codexResult.skipped ? ["Reload Codex after the plugin is installed"] : [])
    ];

console.log(JSON.stringify({
  installed: !dryRun,
  dryRun,
  extensionPath: hostOnly ? null : installedExtensionDir,
  extensionId: hostResult.extensionId,
  extensionReload,
  nativeHost: {
    stateDir: hostResult.stateDir,
    browsers: hostResult.browserRegistrations.map(item => item.browser),
    cli: hostResult.cliLauncherPath
  },
  codex: codexResult,
  next
}, null, 2));

async function installCodexPlugin() {
  await installCodexMarketplace();
  const marketplaces = await runJson("codex", ["plugin", "marketplace", "list", "--json"]);
  const existingMarketplace = marketplaces.marketplaces?.find(item => item.name === "chromium-sidecar");
  if (existingMarketplace && path.resolve(existingMarketplace.root) !== installedMarketplaceDir) {
    await execFileAsync("codex", ["plugin", "marketplace", "remove", "chromium-sidecar", "--json"]);
  }
  if (!existingMarketplace || path.resolve(existingMarketplace.root) !== installedMarketplaceDir) {
    await execFileAsync("codex", ["plugin", "marketplace", "add", installedMarketplaceDir, "--json"]);
  }

  const plugins = await runJson("codex", ["plugin", "list", "--json"]);
  const pluginId = "chromium-sidecar@chromium-sidecar";
  if (plugins.installed?.some(item => item.pluginId === pluginId)) {
    await execFileAsync("codex", ["plugin", "remove", pluginId, "--json"]);
  }
  const installed = await runJson("codex", ["plugin", "add", pluginId, "--json"]);
  return { skipped: false, pluginId, marketplaceRoot: installedMarketplaceDir, installed };
}

async function installCodexMarketplace() {
  const temporaryDir = `${installedMarketplaceDir}.tmp-${process.pid}`;
  const backupDir = `${installedMarketplaceDir}.backup-${process.pid}`;
  await rm(temporaryDir, { recursive: true, force: true });
  await rm(backupDir, { recursive: true, force: true });
  await mkdir(temporaryDir, { recursive: true, mode: 0o700 });
  await cp(path.join(projectDir, ".agents"), path.join(temporaryDir, ".agents"), { recursive: true });
  await cp(path.join(projectDir, "plugins"), path.join(temporaryDir, "plugins"), { recursive: true });

  let backedUp = false;
  try {
    if (existsSync(installedMarketplaceDir)) {
      await rename(installedMarketplaceDir, backupDir);
      backedUp = true;
    }
    await rename(temporaryDir, installedMarketplaceDir);
    await rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true });
    if (backedUp && !existsSync(installedMarketplaceDir)) {
      await rename(backupDir, installedMarketplaceDir);
    }
    throw error;
  }
}

async function reloadRunningExtension(cliPath) {
  try {
    const { stdout } = await execFileAsync(cliPath, ["extension-reload"], { timeout: 3000 });
    return { attempted: true, reloaded: JSON.parse(stdout).reloading === true };
  } catch (error) {
    return {
      attempted: true,
      reloaded: false,
      reason: String(error?.stderr || error?.message || error).trim()
    };
  }
}

function detectBrowser() {
  const candidates = [
    { application: "Arc", extensionsUrl: "arc://extensions", path: "/Applications/Arc.app" },
    { application: "Google Chrome", extensionsUrl: "chrome://extensions", path: "/Applications/Google Chrome.app" },
    { application: "Brave Browser", extensionsUrl: "brave://extensions", path: "/Applications/Brave Browser.app" },
    { application: "Microsoft Edge", extensionsUrl: "edge://extensions", path: "/Applications/Microsoft Edge.app" },
    { application: "Vivaldi", extensionsUrl: "vivaldi://extensions", path: "/Applications/Vivaldi.app" },
    { application: "Chromium", extensionsUrl: "chrome://extensions", path: "/Applications/Chromium.app" }
  ];
  return candidates.find(candidate => existsSync(candidate.path));
}

async function commandExists(command) {
  try {
    await execFileAsync("/usr/bin/env", ["which", command]);
    return true;
  } catch {
    return false;
  }
}

async function runJson(command, commandArgs) {
  const { stdout } = await execFileAsync(command, commandArgs, { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function argumentValue(name) {
  const index = rawArgs.indexOf(name);
  if (index < 0) return "";
  const value = rawArgs[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}
