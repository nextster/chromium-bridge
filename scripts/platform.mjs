import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function pathApiFor(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export async function isExecutableFile(filePath, platform = process.platform) {
  try {
    if (!(await stat(filePath)).isFile()) return false;
    if (platform !== "win32") await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findExecutable(name, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const isExecutable = options.isExecutable || (candidate => isExecutableFile(candidate, platform));
  const pathApi = pathApiFor(platform);
  const directories = String(env.PATH || env.Path || "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const extensions = platform === "win32" && !pathApi.extname(name)
    ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = pathApi.join(directory.replace(/^"|"$/g, ""), `${name}${extension.toLowerCase()}`);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export async function firstExecutable(candidates, options = {}) {
  const platform = options.platform || process.platform;
  const isExecutable = options.isExecutable || (candidate => isExecutableFile(candidate, platform));
  for (const candidate of new Set(candidates.filter(Boolean))) {
    if (await isExecutable(candidate)) return pathApiFor(platform).resolve(candidate);
  }
  return null;
}

// Newest versioned child first, e.g. claude-code/2.1.270 before 2.1.260.
export async function versionedChildren(directory) {
  try {
    const entries = await readdir(directory);
    return entries
      .filter(entry => /^\d+(?:\.\d+)*$/.test(entry))
      .sort((left, right) => compareVersions(right, left));
  } catch {
    return [];
  }
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

// Node refuses to execFile .cmd/.bat shims without a shell, and with a shell it
// joins arguments verbatim, so Windows command lines are quoted explicitly.
export function windowsCommandLine(command, args) {
  return [command, ...args].map(quoteWindowsArgument).join(" ");
}

function quoteWindowsArgument(value) {
  const text = String(value);
  if (/["%\r\n]/.test(text)) throw new Error(`Unsupported character in Windows command argument: ${text}`);
  return /^[A-Za-z0-9_\-.,:/\\@=+]+$/.test(text) ? text : `"${text}"`;
}

export async function runCommand(command, args, options = {}) {
  const platform = options.platform || process.platform;
  const execute = options.execute || execFileAsync;
  const { platform: _platform, execute: _execute, ...execOptions } = options;
  const execution = { maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...execOptions };
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    return execute(windowsCommandLine(command, args), [], { ...execution, shell: true });
  }
  return execute(command, args, execution);
}

export async function runJsonCommand(command, args, options = {}) {
  const { stdout } = await runCommand(command, args, options);
  return JSON.parse(stdout);
}

export function browserCandidates(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.win32.join(homedir, "AppData", "Local");
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const roots = [programFiles, programFilesX86, localAppData];
    const windowsBrowser = (name, extensionsUrl, segments, rootsForBrowser = roots) => ({
      name,
      extensionsUrl,
      executables: rootsForBrowser.map(root => path.win32.join(root, ...segments))
    });
    return [
      windowsBrowser("Google Chrome", "chrome://extensions", ["Google", "Chrome", "Application", "chrome.exe"]),
      windowsBrowser("Brave", "brave://extensions", ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"]),
      windowsBrowser("Vivaldi", "vivaldi://extensions", ["Vivaldi", "Application", "vivaldi.exe"]),
      windowsBrowser("Chromium", "chrome://extensions", ["Chromium", "Application", "chrome.exe"], [localAppData]),
      windowsBrowser("Microsoft Edge", "edge://extensions", ["Microsoft", "Edge", "Application", "msedge.exe"])
    ];
  }
  const applicationRoots = ["/Applications", path.posix.join(homedir, "Applications")];
  return [
    ["Arc", "arc://extensions"],
    ["Google Chrome", "chrome://extensions"],
    ["Brave Browser", "brave://extensions"],
    ["Microsoft Edge", "edge://extensions"],
    ["Vivaldi", "vivaldi://extensions"],
    ["Chromium", "chrome://extensions"]
  ].map(([name, extensionsUrl]) => ({
    name,
    application: name,
    extensionsUrl,
    bundles: applicationRoots.map(root => path.posix.join(root, `${name}.app`))
  }));
}

export async function detectBrowser(options = {}) {
  const exists = options.exists || (async filePath => stat(filePath).then(() => true, () => false));
  for (const candidate of browserCandidates(options)) {
    for (const location of candidate.executables || candidate.bundles) {
      if (await exists(location)) {
        const { executables, bundles, ...browser } = candidate;
        return { ...browser, path: location };
      }
    }
  }
  return null;
}

export async function openInBrowser(browser, url, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "darwin") {
    const execute = options.execute || execFileAsync;
    await execute("/usr/bin/open", ["-a", browser.application, url]);
    return;
  }
  const spawnProcess = options.spawn || spawn;
  await new Promise((resolve, reject) => {
    const child = spawnProcess(browser.path, [url], { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
