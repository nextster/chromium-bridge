import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const purge = args.has("--purge");
const skipCodex = args.has("--no-codex");
const skipOpen = args.has("--no-open");
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = path.resolve(
  process.env.CHROMIUM_SIDECAR_STATE_DIR || path.join(os.homedir(), ".chromium-sidecar")
);
const installerPath = path.join(projectDir, "native-host", "src", "install.mjs");
const removedCodex = [];

if (process.platform !== "darwin" && !dryRun) {
  throw new Error("Chromium Sidecar uninstallation currently supports macOS only.");
}

if (!skipCodex && await commandExists("codex")) {
  for (const command of [
    ["plugin", "remove", "chromium-sidecar@chromium-sidecar", "--json"],
    ["plugin", "marketplace", "remove", "chromium-sidecar", "--json"]
  ]) {
    if (dryRun) {
      removedCodex.push({ command, dryRun: true });
    } else {
      removedCodex.push(await runOptional("codex", command));
    }
  }
}

const nativeHost = JSON.parse((await execFileAsync(process.execPath, [
  installerPath,
  "--uninstall",
  ...(dryRun ? ["--dry-run"] : [])
])).stdout);

const retainedCaptures = !purge && existsSync(path.join(stateDir, "captures"));
if (!dryRun) {
  if (purge) {
    await rm(stateDir, { recursive: true, force: true });
  } else {
    for (const entry of [
      "bin",
      "codex-marketplace",
      "current.json",
      "control.sock",
      "extension",
      "node",
      "runtime"
    ]) {
      await rm(path.join(stateDir, entry), { recursive: true, force: true });
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
  retainedCaptures,
  nativeHost,
  codex: removedCodex,
  next: [
    "Remove Chromium Sidecar from the browser extensions page that was opened",
    "Restart Codex",
    ...(retainedCaptures ? [`Captures remain under ${path.join(stateDir, "captures")}`] : [])
  ]
}, null, 2));

async function commandExists(command) {
  try {
    await execFileAsync("/usr/bin/env", ["which", command]);
    return true;
  } catch {
    return false;
  }
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
