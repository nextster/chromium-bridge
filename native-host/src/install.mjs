import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  EXTENSION_ID,
  NATIVE_HOST_NAME,
  OBSOLETE_NATIVE_HOST_NAMES,
  PRODUCT_NAME
} from "./constants.mjs";

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const dryRun = args.has("--dry-run");
const uninstall = args.has("--uninstall");
const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(sourceDir, "../..");
const extensionManifestPath = path.join(projectDir, "extension", "manifest.json");
const storeItemPath = path.join(projectDir, "store", "item.json");
const stateDir = path.resolve(
  process.env.CHROMIUM_BRIDGE_STATE_DIR ||
  process.env.ARC_CODEX_STATE_DIR ||
  path.join(os.homedir(), ".chromium-bridge")
);
const binDir = path.join(stateDir, "bin");
const runtimeDir = path.join(stateDir, "runtime");
const hostLauncherPath = path.join(binDir, "chromium-bridge-host");
const cliLauncherPath = path.join(binDir, "chromium-bridge");
const obsoleteLauncherPaths = [
  path.join(binDir, "chromium-sidecar-host"),
  path.join(binDir, "chromium-sidecar")
];
const installedHostPath = path.join(runtimeDir, "host.mjs");
const installedCliPath = path.join(runtimeDir, "cli.mjs");
const runtimeFiles = [
  "arc-provider.mjs",
  "cli.mjs",
  "constants.mjs",
  "native-protocol.mjs",
  "open-directory.mjs",
  "replay.mjs",
  "host.mjs"
];
const browserRegistrations = nativeMessagingDirectories().map(browser => ({
  ...browser,
  manifestPath: path.join(browser.directory, `${NATIVE_HOST_NAME}.json`),
  obsoleteManifestPaths: OBSOLETE_NATIVE_HOST_NAMES.map(name => path.join(browser.directory, `${name}.json`))
}));
const hostManifestPaths = browserRegistrations.map(item => item.manifestPath);
const obsoleteHostManifestPaths = browserRegistrations.flatMap(item => item.obsoleteManifestPaths);

if (uninstall) {
  if (!dryRun) {
    await Promise.all([
      ...hostManifestPaths,
      ...obsoleteHostManifestPaths
    ].map(filePath => unlink(filePath).catch(ignoreMissing)));
    await Promise.all([
      unlink(hostLauncherPath).catch(ignoreMissing),
      unlink(cliLauncherPath).catch(ignoreMissing),
      ...obsoleteLauncherPaths.map(filePath => unlink(filePath).catch(ignoreMissing)),
      ...runtimeFiles.map(fileName => unlink(path.join(runtimeDir, fileName)).catch(ignoreMissing))
    ]);
  }
  console.log(JSON.stringify({
    uninstalled: !dryRun,
    dryRun,
    stateDir,
    hostManifestPaths,
    obsoleteHostManifestPaths,
    hostLauncherPath,
    cliLauncherPath,
    obsoleteLauncherPaths,
    runtimeDir
  }, null, 2));
  process.exit(0);
}

const extensionManifest = JSON.parse(await readFile(extensionManifestPath, "utf8"));
const extensionId = extensionIdFromKey(extensionManifest.key);
if (extensionId !== EXTENSION_ID) {
  throw new Error(`Manifest key resolves to ${extensionId}, expected ${EXTENSION_ID}`);
}
const storeExtensionId = await readStoreExtensionId();
const extensionIds = Array.from(new Set([
  extensionId,
  storeExtensionId,
  ...String(process.env.CHROMIUM_BRIDGE_EXTENSION_IDS || "").split(","),
  argumentValue("--extension-id") || ""
].map(value => String(value).trim()).filter(Boolean)));
extensionIds.forEach(validateExtensionId);
const allowedOrigins = extensionIds.map(id => `chrome-extension://${id}/`);

const nodePath = await findNode();
const hostLauncher = [
  "#!/bin/sh",
  `CHROMIUM_BRIDGE_ALLOWED_ORIGINS=${sh(allowedOrigins.join(","))}`,
  "export CHROMIUM_BRIDGE_ALLOWED_ORIGINS",
  `exec ${sh(nodePath)} ${sh(installedHostPath)} "$@"`,
  ""
].join("\n");
const cliLauncher = `#!/bin/sh\nexec ${sh(nodePath)} ${sh(installedCliPath)} "$@"\n`;
const hostManifest = nativeHostManifest(NATIVE_HOST_NAME, hostLauncherPath, extensionIds);

if (!dryRun) {
  await Promise.all([
    ...obsoleteHostManifestPaths,
    ...obsoleteLauncherPaths
  ].map(filePath => unlink(filePath).catch(ignoreMissing)));
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  await chmod(binDir, 0o700);
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  for (const fileName of runtimeFiles) {
    await atomicWrite(path.join(runtimeDir, fileName), await readFile(path.join(sourceDir, fileName)), 0o600);
  }
  await atomicWrite(hostLauncherPath, hostLauncher, 0o700);
  await atomicWrite(cliLauncherPath, cliLauncher, 0o700);
  for (const registration of browserRegistrations) {
    await mkdir(registration.directory, { recursive: true });
    await atomicWrite(registration.manifestPath, `${JSON.stringify(hostManifest, null, 2)}\n`, 0o644);
  }
}

console.log(JSON.stringify({
  installed: !dryRun,
  dryRun,
  extensionId,
  extensionIds,
  nodePath,
  stateDir,
  browserRegistrations,
  hostManifestPaths,
  obsoleteHostManifestPaths,
  hostLauncherPath,
  cliLauncherPath,
  obsoleteLauncherPaths,
  installedHostPath,
  installedCliPath,
  runtimeFiles,
  hostManifest
}, null, 2));

function nativeMessagingDirectories() {
  const applicationSupport = path.join(os.homedir(), "Library", "Application Support");
  return [
    ["Arc", "Arc", "User Data"],
    ["Google Chrome", "Google", "Chrome"],
    ["Chromium", "Chromium"],
    ["Brave", "BraveSoftware", "Brave-Browser"],
    ["Microsoft Edge", "Microsoft Edge"],
    ["Vivaldi", "Vivaldi"]
  ].map(([browser, ...segments]) => ({
    browser,
    directory: path.join(applicationSupport, ...segments, "NativeMessagingHosts")
  }));
}

function nativeHostManifest(name, launcherPath, extensionIds) {
  return {
    name,
    description: `${PRODUCT_NAME} Native Host`,
    path: launcherPath,
    type: "stdio",
    allowed_origins: extensionIds.map(id => `chrome-extension://${id}/`)
  };
}

async function findNode() {
  const candidates = [
    process.env.CHROMIUM_BRIDGE_NODE,
    process.env.ARC_CODEX_NODE,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    process.execPath
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return path.resolve(candidate);
    } catch {}
  }
  throw new Error("Could not find an executable Node.js binary");
}

async function atomicWrite(filePath, content, mode) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, content, { mode });
  await chmod(temporaryPath, mode);
  await rename(temporaryPath, filePath);
}

function extensionIdFromKey(key) {
  if (!key) throw new Error("extension/manifest.json has no stable key");
  const digest = crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  return Array.from(digest).flatMap(byte => [byte >> 4, byte & 15]).map(value => String.fromCharCode(97 + value)).join("");
}

function validateExtensionId(value) {
  if (!/^[a-p]{32}$/.test(value)) throw new Error(`Invalid Chromium extension id: ${value}`);
}

function argumentValue(name) {
  const index = rawArgs.indexOf(name);
  if (index < 0) return "";
  const value = rawArgs[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

async function readStoreExtensionId() {
  try {
    const item = JSON.parse(await readFile(storeItemPath, "utf8"));
    return String(item.extensionId || "").trim();
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function ignoreMissing(error) {
  if (error?.code !== "ENOENT") throw error;
}

function sh(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
