import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, rename, rm, symlink } from "node:fs/promises";
import { renameWithRetry } from "../native-host/src/atomic-file.mjs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  detachCodexMarketplace,
  installSharedMarketplace,
  restoreCodexMarketplace,
  marketplaceLocations,
  migrateLegacyMarketplace,
  registerClaudeCode,
  registerCodex
} from "./agent-clients.mjs";
import { findClaudeCli } from "./claude-cli.mjs";
import { claudeDesktopLocations, registerClaudeDesktop } from "./claude-desktop.mjs";
import { findCodexCli } from "./codex-cli.mjs";
import { detectBrowser, openInBrowser } from "./platform.mjs";
import { READY_STEP, bridgeKind, storeReadinessStep } from "./store-migration.mjs";

const execFileAsync = promisify(execFile);
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const skipCodex = args.has("--no-codex");
const skipClaudeCode = args.has("--no-claude") || args.has("--no-claude-code");
const skipClaudeDesktop = args.has("--no-claude") || args.has("--no-claude-desktop");
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
const marketplace = marketplaceLocations();
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

if (!["darwin", "win32"].includes(process.platform) && !dryRun) {
  throw new Error("Chromium Bridge setup supports macOS and Windows.");
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
  await renameWithRetry(temporaryExtensionDir, installedExtensionDir);
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
  extensionReload = await reloadRunningExtension();
}

const clients = await registerClients();

const browser = await detectBrowser();
if (!skipOpen && !dryRun && storeMode && browser) {
  console.error(`Opening the Chromium Bridge Store listing in ${browser.name}...`);
  await openInBrowser(browser, storeUrl);
} else if (!skipOpen && !dryRun && !hostOnly && browser) {
  await openInBrowser(browser, browser.extensionsUrl);
}

let readiness = null;
if (!dryRun && storeMode && waitForBrowser) {
  readiness = await waitUntilReady(waitSeconds(), configuredStoreExtensionId, hostResult.extensionId);
}
const developmentCleanup = readiness?.ready
  ? await cleanupDevelopmentExtensionFiles()
  : { removed: false };

const activate = activationStep(clients);
const next = readiness?.ready
  ? [`Chromium Bridge is ready.${activate ? ` ${activate}` : ""}`]
  : storeMode
  ? [
      `Install Chromium Bridge from ${storeUrl}`,
      ...(readiness?.migration?.error
        ? ["Remove the unpacked Chromium Bridge extension manually, then rerun setup"]
        : []),
      "Approve local browser access in the onboarding page",
      "Enable Allow User Scripts in the extension details",
      ...(activate ? [activate] : [])
    ]
  : hostOnly
  ? ["Reload the store-installed Chromium Bridge extension", ...(activate ? [activate] : [])]
  : extensionReload.reloaded
  ? ["Chromium Bridge reloaded in the running browser", ...(activate ? [activate] : [])]
  : [
      `Open ${browser?.extensionsUrl || "your browser's extensions page"}`,
      "Enable Developer mode",
      `Choose Load unpacked and select ${installedExtensionDir}`,
      ...(activate ? [activate] : [])
    ];
if (clients.missingAll) {
  next.push("Install Codex, Claude Code, or Claude Desktop, then rerun this installer to register Chromium Bridge");
}

console.log(JSON.stringify({
  installed: !dryRun,
  dryRun,
  platform: process.platform,
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
  marketplace: clients.marketplace,
  codex: clients.codex,
  claudeCode: clients.claudeCode,
  claudeDesktop: clients.claudeDesktop,
  developmentLinkReset: !dryRun,
  migration,
  readiness,
  next
}, null, 2));
if (readiness && !readiness.ready) process.exitCode = 2;

async function registerClients() {
  const codexPath = skipCodex ? null : await findCodexCli();
  const claudePath = skipClaudeCode ? null : await findClaudeCli();
  const desktop = skipClaudeDesktop ? null : await claudeDesktopLocations();
  const result = {
    marketplace: null,
    codex: skipped(skipCodex ? "disabled by --no-codex" : "Codex CLI not found", codexPath),
    claudeCode: skipped(skipClaudeCode ? "disabled by --no-claude-code" : "Claude Code CLI not found", claudePath),
    claudeDesktop: skipped(skipClaudeDesktop ? "disabled by --no-claude-desktop" : "Claude Desktop not found"),
    missingAll: !skipCodex && !skipClaudeCode && !skipClaudeDesktop && !codexPath && !claudePath && !desktop?.installed
  };

  if (codexPath || claudePath) {
    if (dryRun) {
      result.marketplace = { root: marketplace.root, dryRun: true };
    } else {
      // The Codex-only legacy directory moves only when Codex can be re-pointed;
      // otherwise its registration would lose the manifest it depends on.
      const codexDetach = codexPath ? await detachCodexMarketplace({ codexPath, ...marketplace }) : null;
      let migrated;
      try {
        migrated = codexPath
          ? await migrateLegacyMarketplace(marketplace)
          : { migrated: false, reason: "Codex CLI unavailable" };
        await installSharedMarketplace({
          root: marketplace.root,
          projectDir,
          nodePath: hostResult.nodePath,
          bootstrapPath: hostResult.runtimeBootstrapPath
        });
      } catch (error) {
        if (codexDetach?.detachedFrom || codexDetach?.recovered) await restoreCodexMarketplace({ codexPath, ...marketplace });
        throw error;
      }
      result.marketplace = { root: marketplace.root, migration: migrated, codexDetach };
    }
  }
  if (codexPath) {
    result.codex = dryRun
      ? { skipped: true, reason: "dry run", command: codexPath }
      : await registerCodex({ codexPath, root: marketplace.root });
  }
  if (claudePath) {
    result.claudeCode = dryRun
      ? { skipped: true, reason: "dry run", command: claudePath }
      : await registerClaudeCode({ claudePath, root: marketplace.root });
  }
  if (desktop?.installed) {
    result.claudeDesktop = await registerClaudeDesktop({
      nodePath: hostResult.nodePath,
      bootstrapPath: hostResult.runtimeBootstrapPath,
      dryRun
    });
  }
  return result;
}

function skipped(reason, command) {
  return { skipped: true, reason, ...(command ? { command } : {}) };
}

function activationStep(result) {
  const steps = [];
  if (!result.codex.skipped) steps.push("start a new Codex task");
  if (!result.claudeCode.skipped) steps.push("start a new Claude Code session");
  if (result.claudeDesktop.restartRequired) steps.push("restart Claude Desktop");
  if (!steps.length) return "";
  const sentence = steps.length > 1 ? `${steps.slice(0, -1).join(", ")} or ${steps.at(-1)}` : steps[0];
  return `To use it, ${sentence}.`;
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

async function waitUntilReady(timeoutSeconds, storeExtensionId, developmentExtensionId) {
  console.error("Waiting for Store installation and browser approval...");
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastStep = "";
  let lastError = "";
  let migration = { requested: false };
  let nextMigrationAttempt = 0;
  while (Date.now() < deadline) {
    try {
      const status = await runBridgeCli(["status"], 7000);
      const kind = bridgeKind(status, storeExtensionId, developmentExtensionId);
      if (kind === "development" && !migration.requested && Date.now() >= nextMigrationAttempt) {
        migration = await requestDevelopmentUninstall();
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
      if (step === READY_STEP) {
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

async function requestDevelopmentUninstall() {
  try {
    const result = await runBridgeCli(["command", "runtime.uninstallDevelopment", "{}"], 5000);
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

async function reloadRunningExtension() {
  try {
    const result = await runBridgeCli(["extension-reload"], 3000);
    return { attempted: true, reloaded: result.reloading === true };
  } catch (error) {
    return {
      attempted: true,
      reloaded: false,
      reason: String(error?.stderr || error?.message || error).trim()
    };
  }
}

// Invoke the installed CLI through node directly: Windows launchers are .cmd
// files, which Node cannot execute without a shell.
function runBridgeCli(commandArgs, timeout) {
  return runJson(hostResult.nodePath, [hostResult.runtimeBootstrapPath, "cli", ...commandArgs], timeout);
}

async function runJson(command, commandArgs, timeout) {
  const { stdout } = await execFileAsync(command, commandArgs, {
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
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
