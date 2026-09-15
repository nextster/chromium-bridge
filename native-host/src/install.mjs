import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { constants as fsConstants, realpathSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  unlink
} from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  EXTENSION_ID,
  NATIVE_HOST_NAME,
  OBSOLETE_NATIVE_HOST_NAMES,
  PRODUCT_NAME
} from "./constants.mjs";
import { atomicWriteFile } from "./atomic-file.mjs";
import { resolveStateDir } from "./control-endpoint.mjs";

const execFileAsync = promisify(execFile);
const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(sourceDir, "../..");

export const RUNTIME_FILES = Object.freeze([
  "arc-provider.mjs",
  "atomic-file.mjs",
  "cli.mjs",
  "constants.mjs",
  "control-endpoint.mjs",
  "native-protocol.mjs",
  "open-directory.mjs",
  "replay.mjs",
  "host.mjs",
  "mcp-server.mjs",
  "runtime-bootstrap.mjs"
]);

const MAC_BROWSERS = [
  ["Arc", "Arc", "User Data"],
  ["Google Chrome", "Google", "Chrome"],
  ["Chromium", "Chromium"],
  ["Brave", "BraveSoftware", "Brave-Browser"],
  ["Microsoft Edge", "Microsoft Edge"],
  ["Vivaldi", "Vivaldi"]
];

// Chromium-based browsers on Windows discover hosts through HKCU registry keys
// whose default value names the manifest file. Arc for Windows is not listed
// because its registry location is undocumented.
const WINDOWS_BROWSERS = [
  ["Google Chrome", "Software\\Google\\Chrome"],
  ["Chromium", "Software\\Chromium"],
  ["Brave", "Software\\BraveSoftware\\Brave-Browser"],
  ["Microsoft Edge", "Software\\Microsoft\\Edge"],
  ["Vivaldi", "Software\\Vivaldi"]
];

if (isMainModule()) {
  await main(process.argv.slice(2));
}

async function main(rawArgs) {
  const args = new Set(rawArgs);
  const dryRun = args.has("--dry-run");
  const platform = process.platform;
  if (args.has("--uninstall")) {
    const plan = buildInstallPlan({ platform, nodePath: null, extensionIds: [EXTENSION_ID] });
    if (!dryRun) await removeInstallation(plan);
    printJson({
      uninstalled: !dryRun,
      dryRun,
      stateDir: plan.stateDir,
      hostManifestPaths: plan.hostManifestPaths,
      obsoleteHostManifestPaths: plan.obsoleteHostManifestPaths,
      registryKeys: plan.registryKeys,
      hostLauncherPath: plan.hostLauncherPath,
      cliLauncherPath: plan.cliLauncherPath,
      obsoleteLauncherPaths: plan.obsoleteLauncherPaths,
      runtimeDir: plan.runtimeDir
    });
    return;
  }

  const extensionManifest = JSON.parse(await readFile(path.join(projectDir, "extension", "manifest.json"), "utf8"));
  const extensionId = extensionIdFromKey(extensionManifest.key);
  if (extensionId !== EXTENSION_ID) {
    throw new Error(`Manifest key resolves to ${extensionId}, expected ${EXTENSION_ID}`);
  }
  const extensionIds = Array.from(new Set([
    extensionId,
    await readStoreExtensionId(),
    ...String(process.env.CHROMIUM_BRIDGE_EXTENSION_IDS || "").split(","),
    argumentValue(rawArgs, "--extension-id") || ""
  ].map(value => String(value).trim()).filter(Boolean)));
  extensionIds.forEach(validateExtensionId);

  const plan = buildInstallPlan({ platform, nodePath: await findNode({ platform }), extensionIds });
  const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
  if (!dryRun) await applyInstallation(plan, { version: packageJson.version });

  printJson({
    installed: !dryRun,
    dryRun,
    platform,
    extensionId,
    extensionIds,
    nodePath: plan.nodePath,
    stateDir: plan.stateDir,
    browserRegistrations: plan.browserRegistrations,
    hostManifestPaths: plan.hostManifestPaths,
    obsoleteHostManifestPaths: plan.obsoleteHostManifestPaths,
    registryKeys: plan.registryKeys,
    hostLauncherPath: plan.hostLauncherPath,
    cliLauncherPath: plan.cliLauncherPath,
    obsoleteLauncherPaths: plan.obsoleteLauncherPaths,
    installedHostPath: path.join(plan.runtimeDir, "host.mjs"),
    installedCliPath: path.join(plan.runtimeDir, "cli.mjs"),
    installedMcpServerPath: path.join(plan.runtimeDir, "mcp-server.mjs"),
    runtimeBootstrapPath: plan.runtimeBootstrapPath,
    runtimeMetadataPath: plan.runtimeMetadataPath,
    runtimeFiles: RUNTIME_FILES,
    hostManifest: plan.hostManifest
  });
}

export function buildInstallPlan(options) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  const windows = platform === "win32";
  const pathApi = windows ? path.win32 : path.posix;
  const stateDir = resolveStateDir({ platform, env, homedir });
  const binDir = pathApi.join(stateDir, "bin");
  const runtimeDir = pathApi.join(stateDir, "runtime");
  const runtimeBootstrapPath = pathApi.join(runtimeDir, "runtime-bootstrap.mjs");
  const launcherExtension = windows ? ".cmd" : "";
  const hostLauncherPath = pathApi.join(binDir, `chromium-bridge-host${launcherExtension}`);
  const cliLauncherPath = pathApi.join(binDir, `chromium-bridge${launcherExtension}`);
  const allowedOrigins = options.extensionIds.map(id => `chrome-extension://${id}/`);
  const hostManifest = {
    name: NATIVE_HOST_NAME,
    description: `${PRODUCT_NAME} Native Host`,
    path: hostLauncherPath,
    type: "stdio",
    allowed_origins: allowedOrigins
  };

  let browserRegistrations;
  if (windows) {
    const manifestPath = pathApi.join(stateDir, "native-messaging", `${NATIVE_HOST_NAME}.json`);
    browserRegistrations = WINDOWS_BROWSERS.map(([browser, root]) => ({
      browser,
      manifestPath,
      registryKey: `HKCU\\${root}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
      obsoleteManifestPaths: []
    }));
  } else {
    const applicationSupport = pathApi.join(homedir, "Library", "Application Support");
    browserRegistrations = MAC_BROWSERS.map(([browser, ...segments]) => {
      const directory = pathApi.join(applicationSupport, ...segments, "NativeMessagingHosts");
      return {
        browser,
        directory,
        manifestPath: pathApi.join(directory, `${NATIVE_HOST_NAME}.json`),
        obsoleteManifestPaths: OBSOLETE_NATIVE_HOST_NAMES.map(name => pathApi.join(directory, `${name}.json`))
      };
    });
  }

  return {
    platform,
    nodePath: options.nodePath,
    stateDir,
    binDir,
    runtimeDir,
    runtimeBootstrapPath,
    runtimeMetadataPath: pathApi.join(runtimeDir, "runtime.json"),
    hostLauncherPath,
    cliLauncherPath,
    obsoleteLauncherPaths: windows ? [] : [
      pathApi.join(binDir, "chromium-sidecar-host"),
      pathApi.join(binDir, "chromium-sidecar")
    ],
    hostLauncher: !options.nodePath
      ? null
      : windows
      ? cmdScript([
          "setlocal",
          `set "CHROMIUM_BRIDGE_ALLOWED_ORIGINS=${cmdValue(allowedOrigins.join(","))}"`,
          `${windowsLauncherNode(options.nodePath, stateDir)} "%~dp0..\\runtime\\runtime-bootstrap.mjs" native-host %*`
        ])
      : [
          "#!/bin/sh",
          `CHROMIUM_BRIDGE_ALLOWED_ORIGINS=${sh(allowedOrigins.join(","))}`,
          "export CHROMIUM_BRIDGE_ALLOWED_ORIGINS",
          `exec ${sh(options.nodePath)} ${sh(runtimeBootstrapPath)} 'native-host' "$@"`,
          ""
        ].join("\n"),
    cliLauncher: !options.nodePath
      ? null
      : windows
      ? cmdScript([`${windowsLauncherNode(options.nodePath, stateDir)} "%~dp0..\\runtime\\runtime-bootstrap.mjs" cli %*`])
      : `#!/bin/sh\nexec ${sh(options.nodePath)} ${sh(runtimeBootstrapPath)} 'cli' "$@"\n`,
    hostManifest,
    browserRegistrations,
    hostManifestPaths: Array.from(new Set(browserRegistrations.map(item => item.manifestPath))),
    obsoleteHostManifestPaths: browserRegistrations.flatMap(item => item.obsoleteManifestPaths),
    registryKeys: browserRegistrations.map(item => item.registryKey).filter(Boolean)
  };
}

export async function applyInstallation(plan, options = {}) {
  const registry = options.registry || windowsRegistry();
  const pathApi = plan.platform === "win32" ? path.win32 : path.posix;
  await Promise.all([
    ...plan.obsoleteHostManifestPaths,
    ...plan.obsoleteLauncherPaths
  ].map(filePath => unlink(filePath).catch(ignoreMissing)));
  for (const directory of [plan.stateDir, plan.binDir, plan.runtimeDir]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  for (const fileName of RUNTIME_FILES) {
    await atomicWriteFile(pathApi.join(plan.runtimeDir, fileName), await readFile(path.join(sourceDir, fileName)), 0o600);
  }
  await atomicWriteFile(plan.runtimeMetadataPath, `${JSON.stringify({
    schemaVersion: 1,
    version: options.version,
    source: "bundled"
  }, null, 2)}\n`, 0o600);
  await atomicWriteFile(plan.hostLauncherPath, plan.hostLauncher, 0o700);
  await atomicWriteFile(plan.cliLauncherPath, plan.cliLauncher, 0o700);
  const manifest = `${JSON.stringify(plan.hostManifest, null, 2)}\n`;
  for (const manifestPath of plan.hostManifestPaths) {
    await mkdir(pathApi.dirname(manifestPath), { recursive: true });
    await atomicWriteFile(manifestPath, manifest, 0o644);
  }
  for (const registration of plan.browserRegistrations) {
    if (registration.registryKey) await registry.setDefault(registration.registryKey, registration.manifestPath);
  }
}

export async function removeInstallation(plan, options = {}) {
  const registry = options.registry || windowsRegistry();
  const pathApi = plan.platform === "win32" ? path.win32 : path.posix;
  for (const key of plan.registryKeys) await registry.remove(key);
  await Promise.all([
    ...plan.hostManifestPaths,
    ...plan.obsoleteHostManifestPaths,
    plan.hostLauncherPath,
    plan.cliLauncherPath,
    ...plan.obsoleteLauncherPaths,
    ...RUNTIME_FILES.map(fileName => pathApi.join(plan.runtimeDir, fileName)),
    plan.runtimeMetadataPath
  ].map(filePath => unlink(filePath).catch(ignoreMissing)));
}

export function windowsRegistry(options = {}) {
  const env = options.env || process.env;
  const execute = options.execute || execFileAsync;
  const regPath = path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
  return {
    async setDefault(key, value) {
      await execute(regPath, ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], { windowsHide: true });
    },
    async remove(key) {
      try {
        await execute(regPath, ["delete", key, "/f"], { windowsHide: true });
      } catch (error) {
        const exists = await execute(regPath, ["query", key], { windowsHide: true }).then(() => true, () => false);
        if (exists) throw error;
      }
    }
  };
}

export async function findNode(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const candidates = [
    env.CHROMIUM_BRIDGE_NODE,
    env.ARC_CODEX_NODE,
    ...(platform === "darwin" ? ["/opt/homebrew/bin/node", "/usr/local/bin/node"] : []),
    options.execPath || process.execPath
  // Version-manager shims such as node.cmd need a shell, which neither Chromium
  // nor MCP clients use, so Windows launchers require the real node.exe.
  ].filter(candidate => candidate && (platform !== "win32" || /\.exe$/i.test(candidate)));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return path.resolve(candidate);
    } catch {}
  }
  throw new Error("Could not find an executable Node.js binary");
}

// cmd.exe decodes batch files with the OEM code page, so non-ASCII profile
// paths are expressed through %~dp0, which cmd expands from the Unicode path.
function windowsLauncherNode(nodePath, stateDir) {
  const portableRoot = `${path.win32.join(stateDir, "node")}\\`;
  if (nodePath.toLowerCase().startsWith(portableRoot.toLowerCase())) {
    return `"%~dp0..\\node\\${cmdValue(nodePath.slice(portableRoot.length))}"`;
  }
  if (/[^\x20-\x7e]/.test(nodePath)) {
    throw new Error(`Node.js path must be ASCII for Windows launchers: ${nodePath}. Rerun install.ps1 with CHROMIUM_BRIDGE_FORCE_PORTABLE_NODE=1 to use the private runtime.`);
  }
  return cmdQuote(nodePath);
}

// cmd.exe expands %VAR% even inside quotes, so literal percent signs are doubled.
// Double quotes and line breaks cannot appear in Windows paths.
export function cmdQuote(value) {
  return `"${cmdValue(value)}"`;
}

function cmdValue(value) {
  const text = String(value);
  if (/["\r\n]/.test(text)) throw new Error(`Unsupported character in Windows launcher value: ${text}`);
  return text.replaceAll("%", "%%");
}

function cmdScript(lines) {
  return ["@echo off", ...lines, ""].join("\r\n");
}

function extensionIdFromKey(key) {
  if (!key) throw new Error("extension/manifest.json has no stable key");
  const digest = crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  return Array.from(digest).flatMap(byte => [byte >> 4, byte & 15]).map(value => String.fromCharCode(97 + value)).join("");
}

function validateExtensionId(value) {
  if (!/^[a-p]{32}$/.test(value)) throw new Error(`Invalid Chromium extension id: ${value}`);
}

function argumentValue(rawArgs, name) {
  const index = rawArgs.indexOf(name);
  if (index < 0) return "";
  const value = rawArgs[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
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

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function ignoreMissing(error) {
  if (error?.code !== "ENOENT") throw error;
}

function sh(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
