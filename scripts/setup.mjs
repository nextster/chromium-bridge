import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const skipCodex = args.has("--no-codex");
const skipOpen = args.has("--no-open");
const dryRun = args.has("--dry-run");
const sourceMode = args.has("--source");
const requestedHostOnly = args.has("--host-only");
const waitForBrowser = !args.has("--no-wait");
const extensionId = argumentValue("--extension-id");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const sourceExtensionDir = path.join(projectDir, "extension");
const stateDir = path.resolve(
  process.env.CHROMIUM_SIDECAR_STATE_DIR || path.join(os.homedir(), ".chromium-sidecar")
);
const installedExtensionDir = path.join(stateDir, "extension");
const temporaryExtensionDir = `${installedExtensionDir}.tmp-${process.pid}`;
const installedMarketplaceDir = path.join(stateDir, "codex-marketplace");
const installerPath = path.join(projectDir, "native-host", "src", "install.mjs");
const configuredStoreExtensionId = extensionId || await readStoreExtensionId();
const storeMode = Boolean(configuredStoreExtensionId) && !sourceMode;
const hostOnly = requestedHostOnly || storeMode;
const storeUrl = configuredStoreExtensionId
  ? `https://chromewebstore.google.com/detail/chromium-sidecar/${configuredStoreExtensionId}`
  : "";

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
const codexAvailable = await commandExists("codex");
if (!skipCodex && codexAvailable) {
  codexResult = dryRun ? { skipped: true, reason: "dry run" } : await installCodexPlugin(hostResult.nodePath);
} else if (!skipCodex && !dryRun) {
  throw new Error("Codex CLI was not found. Install Codex first or rerun with --no-codex.");
}

const browser = detectBrowser();
if (!skipOpen && !dryRun && storeMode && browser) {
  console.error(`Opening the Chromium Sidecar Store listing in ${browser.application}...`);
  await execFileAsync("/usr/bin/open", ["-a", browser.application, storeUrl]);
} else if (!skipOpen && !dryRun && !hostOnly && browser) {
  await execFileAsync("/usr/bin/open", ["-a", browser.application, browser.extensionsUrl]);
}

let readiness = null;
if (!dryRun && storeMode && waitForBrowser) {
  readiness = await waitUntilReady(hostResult.cliLauncherPath, waitSeconds());
}

const next = readiness?.ready
  ? ["Chromium Sidecar is ready. Start a new Codex task to use it."]
  : storeMode
  ? [
      `Install Chromium Sidecar from ${storeUrl}`,
      "Approve local browser access in the onboarding page",
      "Enable Allow User Scripts in the extension details",
      ...(!skipCodex && !codexResult.skipped ? ["Restart Codex to activate the plugin"] : [])
    ]
  : hostOnly
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
  storeExtensionId: configuredStoreExtensionId || null,
  mode: storeMode ? "store" : hostOnly ? "host-only" : "source",
  extensionReload,
  nativeHost: {
    stateDir: hostResult.stateDir,
    browsers: hostResult.browserRegistrations.map(item => item.browser),
    cli: hostResult.cliLauncherPath,
    node: hostResult.nodePath
  },
  codex: codexResult,
  readiness,
  next
}, null, 2));
if (readiness && !readiness.ready) process.exitCode = 2;

async function installCodexPlugin(nodePath) {
  await installCodexMarketplace(nodePath);
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

async function installCodexMarketplace(nodePath) {
  const temporaryDir = `${installedMarketplaceDir}.tmp-${process.pid}`;
  const backupDir = `${installedMarketplaceDir}.backup-${process.pid}`;
  await rm(temporaryDir, { recursive: true, force: true });
  await rm(backupDir, { recursive: true, force: true });
  await mkdir(temporaryDir, { recursive: true, mode: 0o700 });
  await cp(path.join(projectDir, ".agents"), path.join(temporaryDir, ".agents"), { recursive: true });
  await cp(path.join(projectDir, "plugins"), path.join(temporaryDir, "plugins"), { recursive: true });
  const mcpPath = path.join(temporaryDir, "plugins", "chromium-sidecar", ".mcp.json");
  const mcpConfig = JSON.parse(await readFile(mcpPath, "utf8"));
  mcpConfig.mcpServers["chromium-sidecar"].command = nodePath;
  await writeFile(mcpPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, { mode: 0o600 });

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

async function waitUntilReady(cliPath, timeoutSeconds) {
  console.error("Waiting for Store installation and browser approval...");
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastStep = "";
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const status = await runJson(cliPath, ["status"], 7000);
      const step = readinessStep(status.extension);
      if (step !== lastStep) {
        console.error(step);
        lastStep = step;
      }
      if (step === "Browser and Codex bridge are ready.") {
        return { ready: true, checkedAt: new Date().toISOString(), status };
      }
    } catch (error) {
      lastError = String(error?.stderr || error?.message || error).trim();
    }
    await delay(2000);
  }
  return {
    ready: false,
    timedOut: true,
    timeoutSeconds,
    ...(lastStep ? { step: lastStep } : {}),
    ...(lastError ? { error: lastError } : {})
  };
}

function readinessStep(extension) {
  if (!extension?.pong) return "Install the extension from the Store page.";
  if (!extension.privacy?.consented || !extension.permissions?.siteAccess || !extension.permissions?.tabs) {
    return "Approve local browser access in the Chromium Sidecar onboarding page.";
  }
  if (!extension.userScriptsAvailable) {
    return "Open extension details and enable Allow User Scripts.";
  }
  return "Browser and Codex bridge are ready.";
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

async function runJson(command, commandArgs, timeout) {
  const { stdout } = await execFileAsync(command, commandArgs, {
    maxBuffer: 16 * 1024 * 1024,
    ...(timeout ? { timeout } : {})
  });
  return JSON.parse(stdout);
}

async function readStoreExtensionId() {
  try {
    const item = JSON.parse(await readFile(path.join(projectDir, "store", "item.json"), "utf8"));
    return String(item.extensionId || "").trim();
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function waitSeconds() {
  const value = Number(argumentValue("--wait-seconds") || 600);
  if (!Number.isInteger(value) || value < 10 || value > 3600) {
    throw new Error("--wait-seconds must be an integer between 10 and 3600");
  }
  return value;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function argumentValue(name) {
  const index = rawArgs.indexOf(name);
  if (index < 0) return "";
  const value = rawArgs[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}
