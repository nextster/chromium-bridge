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
  LEGACY_NATIVE_HOST_NAME,
  NATIVE_HOST_NAME,
  PRODUCT_NAME
} from "./constants.mjs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const uninstall = args.has("--uninstall");
const installLegacyAlias = !args.has("--no-legacy-alias");
const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(sourceDir, "../..");
const extensionManifestPath = path.join(projectDir, "extension", "manifest.json");
const stateDir = path.resolve(
  process.env.CHROMIUM_SIDECAR_STATE_DIR ||
  process.env.ARC_CODEX_STATE_DIR ||
  path.join(os.homedir(), ".chromium-sidecar")
);
const binDir = path.join(stateDir, "bin");
const runtimeDir = path.join(stateDir, "runtime");
const hostLauncherPath = path.join(binDir, "chromium-sidecar-host");
const cliLauncherPath = path.join(binDir, "chromium-sidecar");
const installedHostPath = path.join(runtimeDir, "host.mjs");
const installedCliPath = path.join(runtimeDir, "cli.mjs");
const runtimeFiles = [
  "arc-provider.mjs",
  "cli.mjs",
  "constants.mjs",
  "native-protocol.mjs",
  "replay.mjs",
  "host.mjs"
];
const browserRegistrations = nativeMessagingDirectories().map(browser => ({
  ...browser,
  manifestPath: path.join(browser.directory, `${NATIVE_HOST_NAME}.json`),
  legacyManifestPath: path.join(browser.directory, `${LEGACY_NATIVE_HOST_NAME}.json`)
}));
const hostManifestPaths = browserRegistrations.map(item => item.manifestPath);
const legacyHostManifestPaths = browserRegistrations.map(item => item.legacyManifestPath);

if (uninstall) {
  if (!dryRun) {
    await Promise.all([
      ...hostManifestPaths,
      ...legacyHostManifestPaths
    ].map(filePath => unlink(filePath).catch(ignoreMissing)));
    await Promise.all([
      unlink(hostLauncherPath).catch(ignoreMissing),
      unlink(cliLauncherPath).catch(ignoreMissing),
      ...runtimeFiles.map(fileName => unlink(path.join(runtimeDir, fileName)).catch(ignoreMissing))
    ]);
  }
  console.log(JSON.stringify({
    uninstalled: !dryRun,
    dryRun,
    stateDir,
    hostManifestPaths,
    legacyHostManifestPaths,
    hostLauncherPath,
    cliLauncherPath,
    runtimeDir
  }, null, 2));
  process.exit(0);
}

const extensionManifest = JSON.parse(await readFile(extensionManifestPath, "utf8"));
const extensionId = extensionIdFromKey(extensionManifest.key);
if (extensionId !== EXTENSION_ID) {
  throw new Error(`Manifest key resolves to ${extensionId}, expected ${EXTENSION_ID}`);
}

const nodePath = await findNode();
const hostLauncher = `#!/bin/sh\nexec ${sh(nodePath)} ${sh(installedHostPath)} "$@"\n`;
const cliLauncher = `#!/bin/sh\nexec ${sh(nodePath)} ${sh(installedCliPath)} "$@"\n`;
const hostManifest = nativeHostManifest(NATIVE_HOST_NAME, hostLauncherPath, extensionId);
const legacyHostManifest = nativeHostManifest(LEGACY_NATIVE_HOST_NAME, hostLauncherPath, extensionId);

if (!dryRun) {
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
    if (installLegacyAlias) {
      await atomicWrite(registration.legacyManifestPath, `${JSON.stringify(legacyHostManifest, null, 2)}\n`, 0o644);
    }
  }
}

console.log(JSON.stringify({
  installed: !dryRun,
  dryRun,
  extensionId,
  nodePath,
  stateDir,
  browserRegistrations,
  hostManifestPaths,
  legacyHostManifestPaths: installLegacyAlias ? legacyHostManifestPaths : [],
  hostLauncherPath,
  cliLauncherPath,
  installedHostPath,
  installedCliPath,
  runtimeFiles,
  hostManifest,
  legacyHostManifest: installLegacyAlias ? legacyHostManifest : null
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

function nativeHostManifest(name, launcherPath, extensionId) {
  return {
    name,
    description: `${PRODUCT_NAME} Native Host`,
    path: launcherPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`]
  };
}

async function findNode() {
  const candidates = [
    process.env.CHROMIUM_SIDECAR_NODE,
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

function ignoreMissing(error) {
  if (error?.code !== "ENOENT") throw error;
}

function sh(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
