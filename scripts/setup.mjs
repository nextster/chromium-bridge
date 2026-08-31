import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { findCodexCli } from "./codex-cli.mjs";
import { bridgeKind, storeReadinessStep } from "./store-migration.mjs";

const execFileAsync = promisify(execFile);
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const skipCodex = args.has("--no-codex");
const skipOpen = args.has("--no-open");
const skipExtension = args.has("--no-extension");
const dryRun = args.has("--dry-run");
const sourceMode = args.has("--source");
const requestedHostOnly = args.has("--host-only");
const waitForBrowser = !args.has("--no-wait");
const extensionId = argumentValue("--extension-id");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const sourceExtensionDir = path.join(projectDir, "extension");
const legacyStateDir = path.join(os.homedir(), ".chromium-sidecar");
const stateDir = path.resolve(
  process.env.CHROMIUM_BRIDGE_STATE_DIR || path.join(os.homedir(), ".chromium-bridge")
);
const installedExtensionDir = path.join(stateDir, "extension");
const temporaryExtensionDir = `${installedExtensionDir}.tmp-${process.pid}`;
const installedMarketplaceDir = path.join(stateDir, "codex-marketplace");
const developmentLinkPath = path.join(stateDir, "dev-link.json");
const installerPath = path.join(projectDir, "native-host", "src", "install.mjs");
const configuredStoreExtensionId = extensionId || await readStoreExtensionId();
const storeMode = Boolean(configuredStoreExtensionId) && !sourceMode;
const hostOnly = requestedHostOnly || storeMode;
const existingDevelopmentExtension = storeMode && existsSync(installedExtensionDir);
const refreshDevelopmentExtension = !skipExtension && (!hostOnly || existingDevelopmentExtension);
const storeUrl = configuredStoreExtensionId
  ? `https://chromewebstore.google.com/detail/chromium-bridge/${configuredStoreExtensionId}`
  : "";

if (process.platform !== "darwin" && !dryRun) {
  throw new Error("The setup command currently supports macOS. The extension and MCP server are portable, but Native Messaging registration paths still need a platform installer.");
}
if (Number(process.versions.node.split(".")[0]) < 20) {
  throw new Error(`Node.js 20 or newer is required; found ${process.version}`);
}

const migration = await migrateLegacyState();

if (!dryRun) await rm(developmentLinkPath, { force: true });

if (!dryRun && refreshDevelopmentExtension) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await rm(temporaryExtensionDir, { recursive: true, force: true });
  await cp(sourceExtensionDir, temporaryExtensionDir, { recursive: true });
  await rm(installedExtensionDir, { recursive: true, force: true });
  await rename(temporaryExtensionDir, installedExtensionDir);
  if (migration.migrated && path.resolve(migration.from) === path.resolve(legacyStateDir)) {
    await mkdir(legacyStateDir, { recursive: true, mode: 0o700 });
    await rm(path.join(legacyStateDir, "extension"), { recursive: true, force: true });
    await symlink(installedExtensionDir, path.join(legacyStateDir, "extension"), "dir");
  }
}

const hostResult = await runJson(process.execPath, [
  installerPath,
  ...(dryRun ? ["--dry-run"] : []),
  ...(extensionId ? ["--extension-id", extensionId] : [])
]);
let extensionReload = { attempted: false, reloaded: false };
if (!dryRun && refreshDevelopmentExtension) {
  extensionReload = await reloadRunningExtension(hostResult.cliLauncherPath);
}
let codexResult = { skipped: true, reason: skipCodex ? "disabled by --no-codex" : "Codex CLI not found" };
const codexPath = skipCodex ? null : await findCodexCli();
if (codexPath) {
  codexResult = dryRun
    ? { skipped: true, reason: "dry run", command: codexPath }
    : await installCodexPlugin(hostResult.nodePath, codexPath);
}

const browser = detectBrowser();
if (!skipOpen && !dryRun && storeMode && browser) {
  console.error(`Opening the Chromium Bridge Store listing in ${browser.application}...`);
  await execFileAsync("/usr/bin/open", ["-a", browser.application, storeUrl]);
} else if (!skipOpen && !dryRun && !hostOnly && browser) {
  await execFileAsync("/usr/bin/open", ["-a", browser.application, browser.extensionsUrl]);
}

let readiness = null;
if (!dryRun && storeMode && waitForBrowser) {
  readiness = await waitUntilReady(
    hostResult.cliLauncherPath,
    waitSeconds(),
    configuredStoreExtensionId,
    hostResult.extensionId
  );
}
const developmentCleanup = readiness?.ready
  ? await cleanupDevelopmentExtensionFiles()
  : { removed: false };

const next = readiness?.ready
  ? ["Chromium Bridge is ready. Start a new Codex task to use it."]
  : storeMode
  ? [
      `Install Chromium Bridge from ${storeUrl}`,
      ...(readiness?.migration?.error
        ? ["Remove the unpacked Chromium Bridge extension manually, then rerun setup"]
        : []),
      "Approve local browser access in the onboarding page",
      "Enable Allow User Scripts in the extension details",
      ...(!skipCodex && !codexResult.skipped ? ["Restart Codex to activate the plugin"] : [])
    ]
  : hostOnly
  ? [
      "Reload the store-installed Chromium Bridge extension",
      ...(!skipCodex && !codexResult.skipped ? ["Reload Codex to activate the updated plugin"] : [])
    ]
  : extensionReload.reloaded
  ? [
      "Chromium Bridge reloaded in the running browser",
      ...(!skipCodex && !codexResult.skipped ? ["Reload Codex to activate the updated plugin"] : [])
    ]
  : [
      `Open ${browser?.extensionsUrl || "your browser's extensions page"}`,
      "Enable Developer mode",
      `Choose Load unpacked and select ${installedExtensionDir}`,
      ...(!skipCodex && !codexResult.skipped ? ["Reload Codex after the plugin is installed"] : [])
    ];
if (!skipCodex && codexResult.reason === "Codex CLI not found") {
  next.push("Install the Codex desktop app or CLI, then rerun this installer to register the plugin");
}

console.log(JSON.stringify({
  installed: !dryRun,
  dryRun,
  extensionPath: hostOnly ? null : installedExtensionDir,
  extensionId: hostResult.extensionId,
  storeExtensionId: configuredStoreExtensionId || null,
  mode: storeMode ? "store" : hostOnly ? "host-only" : "source",
  extensionReload,
  developmentMigration: readiness?.migration || null,
  developmentCleanup,
  nativeHost: {
    stateDir: hostResult.stateDir,
    browsers: hostResult.browserRegistrations.map(item => item.browser),
    cli: hostResult.cliLauncherPath,
    node: hostResult.nodePath
  },
  codex: codexResult,
  developmentLinkReset: !dryRun,
  migration,
  readiness,
  next
}, null, 2));
if (readiness && !readiness.ready) process.exitCode = 2;

async function installCodexPlugin(nodePath, codexPath) {
  const removedObsolete = [];
  for (const command of [
    ["plugin", "remove", "chromium-sidecar@chromium-sidecar", "--json"],
    ["plugin", "marketplace", "remove", "chromium-sidecar", "--json"]
  ]) {
    removedObsolete.push(await runOptional(codexPath, command));
  }
  await installCodexMarketplace(nodePath);
  const marketplaces = await runJson(codexPath, ["plugin", "marketplace", "list", "--json"]);
  const existingMarketplace = marketplaces.marketplaces?.find(item => item.name === "chromium-bridge");
  if (existingMarketplace && path.resolve(existingMarketplace.root) !== installedMarketplaceDir) {
    await execFileAsync(codexPath, ["plugin", "marketplace", "remove", "chromium-bridge", "--json"]);
  }
  if (!existingMarketplace || path.resolve(existingMarketplace.root) !== installedMarketplaceDir) {
    await execFileAsync(codexPath, ["plugin", "marketplace", "add", installedMarketplaceDir, "--json"]);
  }

  const plugins = await runJson(codexPath, ["plugin", "list", "--json"]);
  const pluginId = "chromium-bridge@chromium-bridge";
  if (plugins.installed?.some(item => item.pluginId === pluginId)) {
    await execFileAsync(codexPath, ["plugin", "remove", pluginId, "--json"]);
  }
  const installed = await runJson(codexPath, ["plugin", "add", pluginId, "--json"]);
  const compatibilityPath = await installCodexCacheCompatibilityPath(installed.installedPath);
  return {
    skipped: false,
    command: codexPath,
    pluginId,
    marketplaceRoot: installedMarketplaceDir,
    removedObsolete,
    installed,
    compatibilityPath
  };
}

async function installCodexCacheCompatibilityPath(installedPath) {
  if (!installedPath) return null;
  const target = path.resolve(installedPath);
  const pluginDir = path.dirname(target);
  const marketplaceDir = path.dirname(pluginDir);
  if (
    path.basename(pluginDir) !== "chromium-bridge" ||
    path.basename(marketplaceDir) !== "chromium-bridge"
  ) {
    return null;
  }
  const compatibilityPath = path.join(marketplaceDir, path.basename(target));
  if (compatibilityPath === target) return null;
  await mkdir(marketplaceDir, { recursive: true, mode: 0o700 });
  try {
    const existing = await lstat(compatibilityPath);
    if (!existing.isSymbolicLink()) return null;
    await rm(compatibilityPath, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await symlink(path.relative(marketplaceDir, target), compatibilityPath, "dir");
  return compatibilityPath;
}

async function migrateLegacyState() {
  if (process.env.CHROMIUM_BRIDGE_STATE_DIR || path.resolve(legacyStateDir) === stateDir) {
    return { needed: false, skipped: true, reason: "custom state directory" };
  }
  const preMigratedFrom = String(process.env.CHROMIUM_BRIDGE_MIGRATION_SOURCE || "").trim();
  if (preMigratedFrom) {
    return { needed: true, migrated: true, moved: true, beforeSetup: true, from: preMigratedFrom, to: stateDir };
  }
  if (!existsSync(legacyStateDir)) return { needed: false, migrated: false };
  if (dryRun) return { needed: true, migrated: false, dryRun: true, from: legacyStateDir, to: stateDir };

  if (!existsSync(stateDir)) {
    await rename(legacyStateDir, stateDir);
    return { needed: true, migrated: true, moved: true, from: legacyStateDir, to: stateDir };
  }

  let captures = null;
  const sourceCaptures = path.join(legacyStateDir, "captures");
  if (existsSync(sourceCaptures)) {
    captures = path.join(stateDir, "captures", `imported-before-rename-${Date.now()}`);
    await mkdir(path.dirname(captures), { recursive: true, mode: 0o700 });
    await cp(sourceCaptures, captures, { recursive: true });
  }

  const runningFromLegacyState = path.resolve(process.execPath).startsWith(`${path.resolve(legacyStateDir)}${path.sep}`);
  if (!runningFromLegacyState) await rm(legacyStateDir, { recursive: true, force: true });
  return {
    needed: true,
    migrated: true,
    merged: true,
    from: legacyStateDir,
    to: stateDir,
    captures,
    legacyRuntimeRetained: runningFromLegacyState
  };
}

async function installCodexMarketplace(nodePath) {
  const temporaryDir = `${installedMarketplaceDir}.tmp-${process.pid}`;
  const backupDir = `${installedMarketplaceDir}.backup-${process.pid}`;
  await rm(temporaryDir, { recursive: true, force: true });
  await rm(backupDir, { recursive: true, force: true });
  await mkdir(temporaryDir, { recursive: true, mode: 0o700 });
  await cp(path.join(projectDir, ".agents"), path.join(temporaryDir, ".agents"), { recursive: true });
  await cp(path.join(projectDir, "plugins"), path.join(temporaryDir, "plugins"), { recursive: true });
  const mcpPath = path.join(temporaryDir, "plugins", "chromium-bridge", ".mcp.json");
  const mcpConfig = JSON.parse(await readFile(mcpPath, "utf8"));
  mcpConfig.mcpServers["chromium-bridge"].command = nodePath;
  mcpConfig.mcpServers["chromium-bridge"].args = [
    path.join(stateDir, "runtime", "runtime-bootstrap.mjs"),
    "mcp"
  ];
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

async function waitUntilReady(cliPath, timeoutSeconds, storeExtensionId, developmentExtensionId) {
  console.error("Waiting for Store installation and browser approval...");
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastStep = "";
  let lastError = "";
  let migration = { requested: false };
  let nextMigrationAttempt = 0;
  while (Date.now() < deadline) {
    try {
      const status = await runJson(cliPath, ["status"], 7000);
      const kind = bridgeKind(status, storeExtensionId, developmentExtensionId);
      if (kind === "development" && !migration.requested && Date.now() >= nextMigrationAttempt) {
        migration = await requestDevelopmentUninstall(cliPath);
        nextMigrationAttempt = Date.now() + 5000;
        if (migration.requested) {
          console.error("Removed the unpacked development extension; waiting for the Store version...");
          await delay(500);
          continue;
        }
      }
      const step = storeReadinessStep(status, storeExtensionId, developmentExtensionId);
      if (step !== lastStep) {
        console.error(step);
        lastStep = step;
      }
      if (step === "Browser and Codex bridge are ready.") {
        return { ready: true, checkedAt: new Date().toISOString(), status, migration };
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
    ...(lastError ? { error: lastError } : {}),
    migration
  };
}

async function requestDevelopmentUninstall(cliPath) {
  try {
    const result = await runJson(
      cliPath,
      ["command", "runtime.uninstallDevelopment", "{}"],
      5000
    );
    if (result.uninstalling) return { requested: true, result };
    return { requested: false, refused: true, result };
  } catch (error) {
    return {
      requested: false,
      error: String(error?.stderr || error?.message || error).trim()
    };
  }
}

async function cleanupDevelopmentExtensionFiles() {
  const removed = [];
  if (existsSync(installedExtensionDir)) {
    await rm(installedExtensionDir, { recursive: true, force: true });
    removed.push(installedExtensionDir);
  }
  const legacyExtensionPath = path.join(legacyStateDir, "extension");
  try {
    if ((await lstat(legacyExtensionPath)).isSymbolicLink()) {
      await rm(legacyExtensionPath, { force: true });
      removed.push(legacyExtensionPath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { removed: removed.length > 0, paths: removed };
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

async function runJson(command, commandArgs, timeout) {
  const { stdout } = await execFileAsync(command, commandArgs, {
    maxBuffer: 16 * 1024 * 1024,
    ...(timeout ? { timeout } : {})
  });
  return JSON.parse(stdout);
}

async function runOptional(command, commandArgs) {
  try {
    const { stdout } = await execFileAsync(command, commandArgs);
    return { command: commandArgs, removed: true, output: parseJson(stdout) };
  } catch (error) {
    return {
      command: commandArgs,
      removed: false,
      reason: String(error?.stderr || error?.message || error).trim()
    };
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return String(value || "").trim();
  }
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
