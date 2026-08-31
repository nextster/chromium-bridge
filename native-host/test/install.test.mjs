import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, NATIVE_HOST_NAME, OBSOLETE_NATIVE_HOST_NAMES } from "../src/constants.mjs";

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const installerPath = path.resolve(testDir, "../src/install.mjs");
const storeItemPath = path.resolve(testDir, "../../store/item.json");
const configuredStoreId = JSON.parse(await readFile(storeItemPath, "utf8")).extensionId;

test("installer dry-run emits stable manifests for common Chromium browsers", async () => {
  const { stdout } = await execFileAsync(process.execPath, [installerPath, "--dry-run"]);
  const result = JSON.parse(stdout);
  assert.equal(result.installed, false);
  assert.equal(result.extensionId, EXTENSION_ID);
  assert.deepEqual(result.extensionIds, [EXTENSION_ID, configuredStoreId]);
  assert.equal(result.hostManifest.name, NATIVE_HOST_NAME);
  assert.deepEqual(result.hostManifest.allowed_origins, [
    `chrome-extension://${EXTENSION_ID}/`,
    `chrome-extension://${configuredStoreId}/`
  ]);
  assert.deepEqual(result.browserRegistrations.map(item => item.browser), [
    "Arc",
    "Google Chrome",
    "Chromium",
    "Brave",
    "Microsoft Edge",
    "Vivaldi"
  ]);
  assert.equal(result.hostManifestPaths.length, 6);
  assert.match(result.hostManifestPaths[0], /Arc\/User Data\/NativeMessagingHosts\/com\.chromium_bridge\.bridge\.json$/);
  assert.match(result.hostManifestPaths[1], /Google\/Chrome\/NativeMessagingHosts\/com\.chromium_bridge\.bridge\.json$/);
  assert.equal(result.obsoleteHostManifestPaths.length, 12);
  assert.ok(OBSOLETE_NATIVE_HOST_NAMES.every(name =>
    result.obsoleteHostManifestPaths.some(filePath => filePath.endsWith(`${name}.json`))
  ));
  assert.match(result.installedHostPath, /\.chromium-bridge\/runtime\/host\.mjs$/);
  assert.deepEqual(result.runtimeFiles, [
    "arc-provider.mjs",
    "cli.mjs",
    "constants.mjs",
    "native-protocol.mjs",
    "open-directory.mjs",
    "replay.mjs",
    "host.mjs",
    "runtime-bootstrap.mjs"
  ]);
  assert.match(result.runtimeBootstrapPath, /\.chromium-bridge\/runtime\/runtime-bootstrap\.mjs$/);
  assert.match(result.hostManifest.path, /\.chromium-bridge\/bin\/chromium-bridge-host$/);
  assert.equal(result.hostManifest.path, result.hostLauncherPath);
  assert.deepEqual(result.obsoleteLauncherPaths.map(filePath => path.basename(filePath)), [
    "chromium-sidecar-host",
    "chromium-sidecar"
  ]);
});

test("installer can authorize a store extension id alongside the development id", async () => {
  const storeId = "abcdefghijklmnopabcdefghijklmnop";
  const { stdout } = await execFileAsync(process.execPath, [
    installerPath,
    "--dry-run",
    "--extension-id",
    storeId
  ]);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.extensionIds, [EXTENSION_ID, configuredStoreId, storeId]);
  assert.deepEqual(result.hostManifest.allowed_origins, [
    `chrome-extension://${EXTENSION_ID}/`,
    `chrome-extension://${configuredStoreId}/`,
    `chrome-extension://${storeId}/`
  ]);
});
