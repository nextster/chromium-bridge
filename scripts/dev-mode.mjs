import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { findCodexCli } from "./codex-cli.mjs";
import {
  DEV_LINK_FILE,
  DEV_LINK_SCHEMA_VERSION,
  readDevLink,
  resolveRuntime,
  validateCheckout
} from "../native-host/src/runtime-bootstrap.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectDir = path.resolve(scriptDir, "..");
const PLUGIN_ID = "chromium-bridge@nextster";

export async function linkDevelopment(options = {}) {
  const projectDir = await validateCheckout(path.resolve(options.projectDir || defaultProjectDir), { requireCanonical: false });
  const stateDir = stateDirectory(options);
  let before = await developmentStatus({ ...options, projectDir, stateDir });
  let refreshedBundledRuntime = false;

  if (!before.mcp.bootstrapReady || !before.nativeHost.bootstrapReady) {
    if (options.skipInstall) {
      throw new Error("Bundled runtime bootstrap is not installed");
    }
    const setupPath = path.join(projectDir, "scripts", "setup.mjs");
    await execFileAsync(process.execPath, [
      setupPath,
      "--host-only",
      "--no-extension",
      "--no-open",
      "--no-wait"
    ], {
      env: { ...process.env, ...(options.env || {}), CHROMIUM_BRIDGE_STATE_DIR: stateDir },
      maxBuffer: 16 * 1024 * 1024
    });
    refreshedBundledRuntime = true;
    before = await developmentStatus({ ...options, projectDir, stateDir });
    if (!before.mcp.bootstrapReady || !before.nativeHost.bootstrapReady) {
      throw new Error("Setup completed but the stable development bootstrap is still unavailable");
    }
  }

  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const pointerPath = path.join(stateDir, DEV_LINK_FILE);
  const pointer = {
    schemaVersion: DEV_LINK_SCHEMA_VERSION,
    checkoutRoot: projectDir
  };
  await atomicPrivateJson(pointerPath, pointer);
  const status = await developmentStatus({ ...options, projectDir, stateDir });
  return { linked: true, idempotent: before.devLink.valid && before.devLink.checkoutRoot === projectDir, refreshedBundledRuntime, ...status };
}

export async function unlinkDevelopment(options = {}) {
  const projectDir = path.resolve(options.projectDir || defaultProjectDir);
  const stateDir = stateDirectory(options);
  const pointerPath = path.join(stateDir, DEV_LINK_FILE);
  let removed = false;
  try {
    const metadata = await lstat(pointerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Refusing to remove non-regular development pointer: ${pointerPath}`);
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error(`Refusing to remove development pointer owned by another user: ${pointerPath}`);
    }
    await rm(pointerPath);
    removed = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const status = await developmentStatus({ ...options, projectDir, stateDir });
  return { unlinked: true, removed, ...status };
}

export async function developmentStatus(options = {}) {
  const projectDir = path.resolve(options.projectDir || defaultProjectDir);
  const stateDir = stateDirectory(options);
  const pointerPath = path.join(stateDir, DEV_LINK_FILE);
  const repoPackage = await readJson(path.join(projectDir, "package.json")).catch(() => null);
  const devLink = await pointerStatus(pointerPath);
  const codex = await codexPluginStatus({ ...options, stateDir });
  const runtimeMetadata = await readJson(path.join(stateDir, "runtime", "runtime.json")).catch(() => null);
  const nativeBootstrapPath = path.join(stateDir, "runtime", "runtime-bootstrap.mjs");
  const nativeHost = {
    bootstrapPath: nativeBootstrapPath,
    bootstrapReady: existsSync(nativeBootstrapPath) && launchersUseBootstrap(stateDir),
    runtimeVersion: runtimeMetadata?.version || null,
    runtimeMetadata,
    configuredHostLauncher: path.join(stateDir, "bin", "chromium-bridge-host"),
    configuredCliLauncher: path.join(stateDir, "bin", "chromium-bridge")
  };
  nativeHost.effective = await effectiveRuntime("native-host", stateDir, null, path.join(stateDir, "runtime"));
  nativeHost.running = await runningHostStatus(stateDir, options.env);

  const mismatches = [];
  if (!repoPackage?.version) mismatches.push("repo version unavailable");
  if (!codex.installed) mismatches.push("Codex plugin is not installed");
  if (codex.version && repoPackage?.version && codex.version !== repoPackage.version) {
    mismatches.push(`installed plugin ${codex.version} differs from repo ${repoPackage.version}`);
  }
  if (runtimeMetadata?.version && repoPackage?.version && runtimeMetadata.version !== repoPackage.version) {
    mismatches.push(`native runtime ${runtimeMetadata.version} differs from repo ${repoPackage.version}`);
  }
  if (devLink.present && !devLink.valid) mismatches.push(devLink.error);
  if (devLink.valid && devLink.checkoutRoot !== projectDir) {
    mismatches.push(`development pointer targets ${devLink.checkoutRoot}, not ${projectDir}`);
  }
  if (!codex.bootstrapReady) mismatches.push("Codex MCP configuration does not use the stable bootstrap");
  if (!nativeHost.bootstrapReady) mismatches.push("native host launchers do not use the stable bootstrap");
  if (nativeHost.running?.unavailable) mismatches.push(`native host is not reachable: ${nativeHost.running.error}`);

  return {
    mode: devLink.valid ? "checkout" : devLink.present ? "invalid" : "bundled",
    repo: { root: projectDir, version: repoPackage?.version || null },
    stateDir,
    devLink,
    mcp: codex,
    nativeHost,
    mismatches,
    healthy: mismatches.length === 0
  };
}

async function codexPluginStatus(options) {
  const codexPath = options.codexPath === null ? null : options.codexPath || await findCodexCli(options.env || process.env);
  let item = null;
  let error = null;
  if (options.installedPluginPath) {
    item = { version: null, source: { path: path.resolve(options.installedPluginPath) } };
  } else if (codexPath) {
    try {
      const result = await runJson(codexPath, ["plugin", "list", "--json"], options.env);
      item = result.installed?.find(candidate => candidate.pluginId === PLUGIN_ID) || null;
    } catch (caught) {
      error = String(caught?.stderr || caught?.message || caught).trim();
    }
  }
  const registrationPath = item?.source?.path ? path.resolve(item.source.path) : null;
  const registrationManifest = registrationPath
    ? await readJson(path.join(registrationPath, ".codex-plugin", "plugin.json")).catch(() => null)
    : null;
  const installedVersion = registrationManifest?.version || item?.version || null;
  const codexHome = path.resolve(
    options.codexHome || options.env?.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
  );
  const cachedCandidate = installedVersion && !options.installedPluginPath
    ? path.join(codexHome, "plugins", "cache", "chromium-bridge", "chromium-bridge", installedVersion)
    : null;
  const cachedPath = cachedCandidate && existsSync(cachedCandidate) ? cachedCandidate : null;
  const pluginPath = cachedPath || registrationPath;
  const manifest = pluginPath
    ? await readJson(path.join(pluginPath, ".codex-plugin", "plugin.json")).catch(() => null)
    : null;
  const mcpConfig = pluginPath
    ? await readJson(path.join(pluginPath, ".mcp.json")).catch(() => null)
    : null;
  const server = mcpConfig?.mcpServers?.["chromium-bridge"] || null;
  const configuredCwd = pluginPath && server
    ? path.resolve(pluginPath, server.cwd || ".")
    : null;
  const expectedBootstrap = path.join(options.stateDir, "runtime", "runtime-bootstrap.mjs");
  const bootstrapReady = Boolean(
    server &&
    path.resolve(String(server.args?.[0] || "")) === expectedBootstrap &&
    server.args?.[1] === "mcp"
  );
  return {
    installed: Boolean(item),
    codexPath,
    error,
    version: manifest?.version || installedVersion,
    pluginPath,
    registrationPath,
    cachedPath,
    configured: server ? { command: server.command, args: server.args || [], cwd: configuredCwd } : null,
    bootstrapReady,
    effective: configuredCwd ? await effectiveRuntime("mcp", options.stateDir, configuredCwd) : null
  };
}

async function effectiveRuntime(kind, stateDir, fallbackCwd, runtimeDir) {
  try {
    return await resolveRuntime(kind, { stateDir, fallbackCwd, runtimeDir });
  } catch (error) {
    return { source: "invalid", error: String(error?.message || error) };
  }
}

async function pointerStatus(pointerPath) {
  if (!existsSync(pointerPath)) return { present: false, valid: false, pointerPath, checkoutRoot: null };
  try {
    const pointer = await readDevLink(pointerPath);
    const checkoutRoot = await validateCheckout(pointer.checkoutRoot);
    return { present: true, valid: true, pointerPath, checkoutRoot };
  } catch (error) {
    return { present: true, valid: false, pointerPath, checkoutRoot: null, error: String(error?.message || error) };
  }
}

function launchersUseBootstrap(stateDir) {
  try {
    const host = readFileSync(path.join(stateDir, "bin", "chromium-bridge-host"), "utf8");
    const cli = readFileSync(path.join(stateDir, "bin", "chromium-bridge"), "utf8");
    return host.includes("runtime-bootstrap.mjs' 'native-host'") && cli.includes("runtime-bootstrap.mjs' 'cli'");
  } catch {
    return false;
  }
}

async function runJson(command, args, env) {
  const { stdout } = await execFileAsync(command, args, {
    env: { ...process.env, ...(env || {}) },
    maxBuffer: 16 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

async function runningHostStatus(stateDir, env) {
  const cliLauncher = path.join(stateDir, "bin", "chromium-bridge");
  if (!existsSync(cliLauncher)) return null;
  try {
    const { stdout } = await execFileAsync(cliLauncher, ["host-info"], {
      env: { ...process.env, ...(env || {}), CHROMIUM_BRIDGE_STATE_DIR: stateDir },
      timeout: 2000,
      maxBuffer: 1024 * 1024
    });
    return JSON.parse(stdout);
  } catch (error) {
    return { unavailable: true, error: String(error?.stderr || error?.message || error).trim() };
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function stateDirectory(options) {
  return path.resolve(
    options.stateDir || options.env?.CHROMIUM_BRIDGE_STATE_DIR || process.env.CHROMIUM_BRIDGE_STATE_DIR || path.join(os.homedir(), ".chromium-bridge")
  );
}

async function atomicPrivateJson(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, filePath);
}
