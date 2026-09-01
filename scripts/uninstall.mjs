import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { findCodexCli } from "./codex-cli.mjs";

const execFileAsync = promisify(execFile);
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const purge = args.has("--purge");
const skipCodex = args.has("--no-codex");
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
const nextsterMarketplaceDir = path.resolve(
  process.env.NEXTSTER_MARKETPLACE_DIR || path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    "marketplaces",
    "nextster"
  )
);
const installerPath = path.join(projectDir, "native-host", "src", "install.mjs");
const removedCodex = [];

if (process.platform !== "darwin" && !dryRun) {
  throw new Error("Chromium Bridge uninstallation currently supports macOS only.");
}

const codexPath = skipCodex ? null : await findCodexCli();
if (codexPath) {
  for (const command of [
    ["plugin", "remove", "chromium-bridge@nextster", "--json"],
    ["plugin", "remove", "chromium-bridge@chromium-bridge", "--json"],
    ["plugin", "marketplace", "remove", "chromium-bridge", "--json"],
    ["plugin", "remove", "chromium-sidecar@chromium-sidecar", "--json"],
    ["plugin", "marketplace", "remove", "chromium-sidecar", "--json"]
  ]) {
    if (dryRun) {
      removedCodex.push({ command, dryRun: true });
    } else {
      removedCodex.push(await runOptional(codexPath, command));
    }
  }
}
const nextsterCleanup = dryRun
  ? { removed: false, dryRun: true }
  : await removeNextsterPlugin();
if (codexPath && nextsterCleanup.empty) {
  const command = ["plugin", "marketplace", "remove", "nextster", "--json"];
  removedCodex.push(dryRun ? { command, dryRun: true } : await runOptional(codexPath, command));
}
if (!dryRun) await removeCodexCacheCompatibilityPaths();

const nativeHost = JSON.parse((await execFileAsync(process.execPath, [
  installerPath,
  "--uninstall",
  ...(dryRun ? ["--dry-run"] : [])
])).stdout);

const retainedCaptureDirs = purge
  ? []
  : stateDirs.map(directory => path.join(directory, "captures")).filter(existsSync);
const retainedCaptures = retainedCaptureDirs.length > 0;
if (!dryRun) {
  if (purge) {
    await Promise.all(stateDirs.map(directory => rm(directory, { recursive: true, force: true })));
  } else {
    for (const directory of stateDirs) {
      for (const entry of [
        "bin",
        "codex-marketplace",
        "current.json",
        "control.sock",
        "dev-link.json",
        "extension",
        "node",
        "runtime"
      ]) {
        await rm(path.join(directory, entry), { recursive: true, force: true });
      }
      if (!existsSync(path.join(directory, "captures"))) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}

const storeExtensionId = await readStoreExtensionId();
const browser = detectBrowser();
if (!skipOpen && !dryRun && browser) {
  const detailsUrl = `${browser.extensionsUrl}${storeExtensionId ? `?id=${storeExtensionId}` : ""}`;
  await execFileAsync("/usr/bin/open", ["-a", browser.application, detailsUrl]);
}

console.log(JSON.stringify({
  uninstalled: !dryRun,
  dryRun,
  purged: purge && !dryRun,
  stateDir,
  stateDirs,
  retainedCaptures,
  retainedCaptureDirs,
  nativeHost,
  codex: removedCodex,
  nextsterMarketplace: nextsterCleanup,
  next: [
    "Remove Chromium Bridge from the browser extensions page that was opened",
    "Start a new Codex task",
    ...retainedCaptureDirs.map(directory => `Captures remain under ${directory}`)
  ]
}, null, 2));

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

async function removeNextsterPlugin() {
  const manifestPath = path.join(nextsterMarketplaceDir, ".agents", "plugins", "marketplace.json");
  if (!existsSync(manifestPath)) return { removed: false, empty: false };
  const marketplace = JSON.parse(await readFile(manifestPath, "utf8"));
  if (marketplace.name !== "nextster" || !Array.isArray(marketplace.plugins)) {
    throw new Error(`Invalid shared marketplace at ${manifestPath}`);
  }
  const plugins = marketplace.plugins.filter(item => item.name !== "chromium-bridge");
  const removed = plugins.length !== marketplace.plugins.length;
  await rm(path.join(nextsterMarketplaceDir, "plugins", "chromium-bridge"), { recursive: true, force: true });
  if (plugins.length === 0) {
    await rm(nextsterMarketplaceDir, { recursive: true, force: true });
    return { removed, empty: true };
  }
  marketplace.plugins = plugins;
  const temporary = `${manifestPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(marketplace, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, manifestPath);
  return { removed, empty: false };
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
