import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, readlink, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  marketplaceLocations,
  releaseClaudeMarketplace,
  releaseCodexMarketplace,
  removeFromSharedMarketplace,
  unregisterClaudeCode,
  unregisterCodex
} from "./agent-clients.mjs";
import { findClaudeCli } from "./claude-cli.mjs";
import { unregisterClaudeDesktop } from "./claude-desktop.mjs";
import { findCodexCli } from "./codex-cli.mjs";
import { detectBrowser, openInBrowser } from "./platform.mjs";

const execFileAsync = promisify(execFile);
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const purge = args.has("--purge");
const skipCodex = args.has("--no-codex");
const skipClaudeCode = args.has("--no-claude") || args.has("--no-claude-code");
const skipClaudeDesktop = args.has("--no-claude") || args.has("--no-claude-desktop");
const skipOpen = args.has("--no-open");
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacyStateDir = path.join(os.homedir(), ".chromium-sidecar");
const stateDir = path.resolve(
  process.env.CHROMIUM_BRIDGE_STATE_DIR || path.join(os.homedir(), ".chromium-bridge")
);
const stateDirs = [
  stateDir,
  ...(!process.env.CHROMIUM_BRIDGE_STATE_DIR && path.resolve(legacyStateDir) !== stateDir ? [legacyStateDir] : [])
];
const marketplace = marketplaceLocations();
const installerPath = path.join(projectDir, "native-host", "src", "install.mjs");
const bootstrapPath = path.join(stateDir, "runtime", "runtime-bootstrap.mjs");

if (!["darwin", "win32"].includes(process.platform) && !dryRun) {
  throw new Error("Chromium Bridge uninstallation supports macOS and Windows.");
}

const codexPath = skipCodex ? null : await findCodexCli();
const claudePath = skipClaudeCode ? null : await findClaudeCli();
const codex = codexPath ? await unregisterCodex({ codexPath, dryRun }) : [];
const claudeCode = claudePath ? await unregisterClaudeCode({ claudePath, dryRun }) : [];

// Both the shared root and a not-yet-migrated Codex-only root may hold this
// plugin; the client marketplace is released only when no plugin remains.
const marketplaceCleanup = [];
if (!dryRun) {
  for (const root of new Set([marketplace.root, marketplace.legacyRoot])) {
    marketplaceCleanup.push(await removeFromSharedMarketplace(root));
  }
}
const existingMarketplaces = marketplaceCleanup.filter(item => item.existed);
const codexMarketplaceEmpty = existingMarketplaces.length > 0 && existingMarketplaces.every(item => item.codexEmpty);
const claudeMarketplaceEmpty = existingMarketplaces.length > 0 && existingMarketplaces.every(item => item.claudeEmpty);
if (codexPath) codex.push(...await releaseCodexMarketplace({ codexPath, marketplaceEmpty: codexMarketplaceEmpty, dryRun }));
if (claudePath) claudeCode.push(...await releaseClaudeMarketplace({ claudePath, marketplaceEmpty: claudeMarketplaceEmpty, dryRun }));
const claudeDesktop = skipClaudeDesktop
  ? { skipped: true, reason: "disabled by --no-claude-desktop" }
  : await unregisterClaudeDesktop({ bootstrapPath, dryRun });
if (!dryRun) await removeCodexCacheCompatibilityPaths();

const nativeHost = JSON.parse((await execFileAsync(process.execPath, [
  installerPath,
  "--uninstall",
  ...(dryRun ? ["--dry-run"] : [])
], { windowsHide: true })).stdout);

const retainedCaptureDirs = purge
  ? []
  : stateDirs.map(directory => path.join(directory, "captures")).filter(existsSync);
const retainedCaptures = retainedCaptureDirs.length > 0;
const retainedPaths = [];
if (!dryRun) {
  if (purge) {
    for (const directory of stateDirs) await removePath(directory);
  } else {
    for (const directory of stateDirs) {
      for (const entry of [
        "bin",
        "codex-marketplace",
        "current.json",
        "control.sock",
        "control.token",
        "dev-link.json",
        "extension",
        "native-messaging",
        "node",
        "runtime"
      ]) {
        await removePath(path.join(directory, entry));
      }
      if (!existsSync(path.join(directory, "captures"))) {
        await removePath(directory);
      }
    }
  }
}

const storeExtensionId = await readStoreExtensionId();
const browser = await detectBrowser();
if (!skipOpen && !dryRun && browser) {
  await openInBrowser(browser, `${browser.extensionsUrl}${storeExtensionId ? `?id=${storeExtensionId}` : ""}`);
}

console.log(JSON.stringify({
  uninstalled: !dryRun,
  dryRun,
  purged: purge && !dryRun,
  stateDir,
  stateDirs,
  retainedCaptures,
  retainedCaptureDirs,
  retainedPaths,
  nativeHost,
  codex,
  claudeCode,
  claudeDesktop,
  nextsterMarketplace: marketplaceCleanup,
  next: [
    "Remove Chromium Bridge from the browser extensions page that was opened",
    ...(codexPath ? ["Start a new Codex task"] : []),
    ...(claudePath ? ["Start a new Claude Code session"] : []),
    ...(claudeDesktop.configs?.some(item => item.action === "removed") ? ["Restart Claude Desktop"] : []),
    ...retainedCaptureDirs.map(directory => `Captures remain under ${directory}`),
    ...retainedPaths.map(filePath => `Close browsers that use Chromium Bridge, then delete ${filePath}`)
  ]
}, null, 2));

// Windows cannot delete a running node.exe, such as the portable runtime that
// executes this script or a native host kept alive by an open browser.
async function removePath(target) {
  try {
    await rm(target, { recursive: true, force: true });
  } catch (error) {
    if (process.platform !== "win32" || !["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(error?.code)) throw error;
    retainedPaths.push(target);
  }
}

async function removeCodexCacheCompatibilityPaths() {
  const cacheDir = path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    "plugins",
    "cache",
    "chromium-bridge"
  );
  let entries;
  try {
    entries = await readdir(cacheDir);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries.filter(entry => /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(entry)).map(async entry => {
    const candidate = path.join(cacheDir, entry);
    const stat = await lstat(candidate);
    if (!stat.isSymbolicLink()) return;
    const target = await readlink(candidate);
    if (target === path.join("chromium-bridge", entry)) await rm(candidate, { force: true });
  }));
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
