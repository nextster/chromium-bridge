import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const args = new Set(process.argv.slice(2));
const skipCodex = args.has("--no-codex");
const skipOpen = args.has("--no-open");
const dryRun = args.has("--dry-run");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const sourceExtensionDir = path.join(projectDir, "extension");
const stateDir = path.join(os.homedir(), ".chromium-sidecar");
const installedExtensionDir = path.join(stateDir, "extension");
const temporaryExtensionDir = `${installedExtensionDir}.tmp-${process.pid}`;
const installerPath = path.join(projectDir, "native-host", "src", "install.mjs");

if (process.platform !== "darwin") {
  throw new Error("The setup command currently supports macOS. The extension and MCP server are portable, but Native Messaging registration paths still need a platform installer.");
}
if (Number(process.versions.node.split(".")[0]) < 20) {
  throw new Error(`Node.js 20 or newer is required; found ${process.version}`);
}

if (!dryRun) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await rm(temporaryExtensionDir, { recursive: true, force: true });
  await cp(sourceExtensionDir, temporaryExtensionDir, { recursive: true });
  await rm(installedExtensionDir, { recursive: true, force: true });
  await rename(temporaryExtensionDir, installedExtensionDir);
}

const hostResult = await runJson(process.execPath, [installerPath, ...(dryRun ? ["--dry-run"] : [])]);
let extensionReload = { attempted: false, reloaded: false };
if (!dryRun) {
  extensionReload = await reloadRunningExtension(hostResult.cliLauncherPath);
}
let codexResult = { skipped: true, reason: skipCodex ? "disabled by --no-codex" : "Codex CLI not found" };
if (!skipCodex && await commandExists("codex")) {
  codexResult = dryRun ? { skipped: true, reason: "dry run" } : await installCodexPlugin();
}

const browser = detectBrowser();
if (!skipOpen && !dryRun && browser) {
  await execFileAsync("/usr/bin/open", ["-a", browser.application, browser.extensionsUrl]);
}

const next = extensionReload.reloaded
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
  extensionPath: installedExtensionDir,
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
  const marketplaces = await runJson("codex", ["plugin", "marketplace", "list", "--json"]);
  const existingMarketplace = marketplaces.marketplaces?.find(item => item.name === "chromium-sidecar");
  if (existingMarketplace && path.resolve(existingMarketplace.root) !== projectDir) {
    await execFileAsync("codex", ["plugin", "marketplace", "remove", "chromium-sidecar", "--json"]);
  }
  if (!existingMarketplace || path.resolve(existingMarketplace.root) !== projectDir) {
    await execFileAsync("codex", ["plugin", "marketplace", "add", projectDir, "--json"]);
  }

  const plugins = await runJson("codex", ["plugin", "list", "--json"]);
  const pluginId = "chromium-sidecar@chromium-sidecar";
  if (plugins.installed?.some(item => item.pluginId === pluginId)) {
    await execFileAsync("codex", ["plugin", "remove", pluginId, "--json"]);
  }
  const installed = await runJson("codex", ["plugin", "add", pluginId, "--json"]);
  return { skipped: false, pluginId, installed };
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
