import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { execFile } from "node:child_process";
import os from "node:os";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, NATIVE_HOST_NAME, OBSOLETE_NATIVE_HOST_NAMES } from "../src/constants.mjs";
import { applyInstallation, buildInstallPlan, cmdQuote, removeInstallation, windowsRegistry } from "../src/install.mjs";

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
  assert.match(result.installedMcpServerPath, /\.chromium-bridge\/runtime\/mcp-server\.mjs$/);
  assert.deepEqual(result.registryKeys, []);
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

test("Windows plan registers one manifest through HKCU keys and cmd launchers", () => {
  const storeId = "abcdefghijklmnopabcdefghijklmnop";
  const plan = buildInstallPlan({
    platform: "win32",
    env: {},
    homedir: "C:\\Users\\Ann 100%",
    nodePath: "C:\\Users\\Ann 100%\\.chromium-bridge\\node\\node.exe",
    extensionIds: [EXTENSION_ID, storeId]
  });
  const stateDir = "C:\\Users\\Ann 100%\\.chromium-bridge";
  assert.equal(plan.stateDir, stateDir);
  assert.equal(plan.hostLauncherPath, `${stateDir}\\bin\\chromium-bridge-host.cmd`);
  assert.equal(plan.cliLauncherPath, `${stateDir}\\bin\\chromium-bridge.cmd`);
  assert.deepEqual(plan.hostManifestPaths, [`${stateDir}\\native-messaging\\${NATIVE_HOST_NAME}.json`]);
  assert.equal(plan.hostManifest.path, plan.hostLauncherPath);
  assert.deepEqual(plan.registryKeys, [
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    `HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
  ]);
  assert.deepEqual(plan.obsoleteLauncherPaths, []);
  // Paths inside the state directory go through %~dp0 because cmd.exe decodes
  // batch files with the OEM code page.
  assert.equal(plan.hostLauncher, [
    "@echo off",
    "setlocal",
    `set "CHROMIUM_BRIDGE_ALLOWED_ORIGINS=chrome-extension://${EXTENSION_ID}/,chrome-extension://${storeId}/"`,
    `"%~dp0..\\node\\node.exe" "%~dp0..\\runtime\\runtime-bootstrap.mjs" native-host %*`,
    ""
  ].join("\r\n"));
  assert.equal(plan.cliLauncher, `@echo off\r\n"%~dp0..\\node\\node.exe" "%~dp0..\\runtime\\runtime-bootstrap.mjs" cli %*\r\n`);
  assert.throws(() => cmdQuote('C:\\bad"path'), /Unsupported character/);

  const cyrillicHome = "C:\\Users\\\u0410\u0440\u0442\u0451\u043c";
  const portable = buildInstallPlan({
    platform: "win32",
    env: {},
    homedir: cyrillicHome,
    nodePath: `${cyrillicHome}\\.chromium-bridge\\node\\node.exe`,
    extensionIds: [EXTENSION_ID]
  });
  assert.match(portable.cliLauncher, /^@echo off\r\n"%~dp0\.\.\\node\\node\.exe" /);
  assert.doesNotMatch(portable.hostLauncher, /[^\x00-\x7f]/);
  const systemNode = buildInstallPlan({
    platform: "win32",
    env: {},
    homedir: cyrillicHome,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    extensionIds: [EXTENSION_ID]
  });
  assert.match(systemNode.cliLauncher, /^@echo off\r\n"C:\\Program Files\\nodejs\\node\.exe" "%~dp0/);
  assert.throws(() => buildInstallPlan({
    platform: "win32",
    env: {},
    homedir: "C:\\Users\\Ann",
    nodePath: `${cyrillicHome}\\nvm\\node.exe`,
    extensionIds: [EXTENSION_ID]
  }), /must be ASCII/);
});

test("Windows registry adapter writes default values and ignores missing keys on removal", async () => {
  const calls = [];
  const registry = windowsRegistry({
    env: { SystemRoot: "D:\\Windows" },
    execute: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "delete" || args[0] === "query") throw Object.assign(new Error("missing"), { code: 1 });
      return { stdout: "" };
    }
  });
  await registry.setDefault("HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\x", "C:\\m.json");
  await registry.remove("HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\x");
  assert.deepEqual(calls, [
    ["D:\\Windows\\System32\\reg.exe", "add", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\x", "/ve", "/t", "REG_SZ", "/d", "C:\\m.json", "/f"],
    ["D:\\Windows\\System32\\reg.exe", "delete", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\x", "/f"],
    ["D:\\Windows\\System32\\reg.exe", "query", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\x"]
  ]);

  const failing = windowsRegistry({
    env: {},
    execute: async (command, args) => {
      if (args[0] === "delete") throw new Error("access denied");
      return { stdout: "" };
    }
  });
  await assert.rejects(failing.remove("HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\x"), /access denied/);
});

test("installation apply and removal write runtime files and registry entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-install-apply-"));
  const plan = {
    ...buildInstallPlan({
      platform: process.platform === "win32" ? "win32" : "darwin",
      env: { CHROMIUM_BRIDGE_STATE_DIR: path.join(root, "state") },
      homedir: root,
      nodePath: process.execPath,
      extensionIds: [EXTENSION_ID]
    }),
    registryKeys: ["HKCU\\Software\\Test\\NativeMessagingHosts\\x"]
  };
  plan.browserRegistrations = plan.browserRegistrations.map((item, index) => index === 0
    ? { ...item, registryKey: plan.registryKeys[0] }
    : item);
  const registryCalls = [];
  const registry = {
    setDefault: async (key, value) => registryCalls.push(["set", key, value]),
    remove: async key => registryCalls.push(["remove", key])
  };
  try {
    await applyInstallation(plan, { version: "9.9.9", registry });
    assert.match(await readFile(path.join(plan.runtimeDir, "mcp-server.mjs"), "utf8"), /connectControl/);
    assert.equal(JSON.parse(await readFile(plan.runtimeMetadataPath, "utf8")).version, "9.9.9");
    assert.equal(JSON.parse(await readFile(plan.hostManifestPaths[0], "utf8")).path, plan.hostLauncherPath);
    assert.deepEqual(registryCalls, [["set", plan.registryKeys[0], plan.browserRegistrations[0].manifestPath]]);

    await removeInstallation(plan, { registry });
    assert.deepEqual(registryCalls.at(-1), ["remove", plan.registryKeys[0]]);
    await assert.rejects(access(path.join(plan.runtimeDir, "mcp-server.mjs")));
    await assert.rejects(access(plan.hostLauncherPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
