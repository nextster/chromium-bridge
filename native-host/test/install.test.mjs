import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, LEGACY_NATIVE_HOST_NAME, NATIVE_HOST_NAME } from "../src/constants.mjs";

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const installerPath = path.resolve(testDir, "../src/install.mjs");

test("installer dry-run emits stable manifests for common Chromium browsers", async () => {
  const { stdout } = await execFileAsync(process.execPath, [installerPath, "--dry-run"]);
  const result = JSON.parse(stdout);
  assert.equal(result.installed, false);
  assert.equal(result.extensionId, EXTENSION_ID);
  assert.deepEqual(result.extensionIds, [EXTENSION_ID]);
  assert.equal(result.hostManifest.name, NATIVE_HOST_NAME);
  assert.deepEqual(result.hostManifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
  assert.deepEqual(result.browserRegistrations.map(item => item.browser), [
    "Arc",
    "Google Chrome",
    "Chromium",
    "Brave",
    "Microsoft Edge",
    "Vivaldi"
  ]);
  assert.equal(result.hostManifestPaths.length, 6);
  assert.match(result.hostManifestPaths[0], /Arc\/User Data\/NativeMessagingHosts\/com\.chromium_sidecar\.bridge\.json$/);
  assert.match(result.hostManifestPaths[1], /Google\/Chrome\/NativeMessagingHosts\/com\.chromium_sidecar\.bridge\.json$/);
  assert.equal(result.legacyHostManifest.name, LEGACY_NATIVE_HOST_NAME);
  assert.equal(result.legacyHostManifestPaths.length, 6);
  assert.match(result.installedHostPath, /\.chromium-sidecar\/runtime\/host\.mjs$/);
  assert.deepEqual(result.runtimeFiles, [
    "arc-provider.mjs",
    "cli.mjs",
    "constants.mjs",
    "native-protocol.mjs",
    "replay.mjs",
    "host.mjs"
  ]);
  assert.equal(result.hostManifest.path, result.hostLauncherPath);
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
  assert.deepEqual(result.extensionIds, [EXTENSION_ID, storeId]);
  assert.deepEqual(result.hostManifest.allowed_origins, [
    `chrome-extension://${EXTENSION_ID}/`,
    `chrome-extension://${storeId}/`
  ]);
});
