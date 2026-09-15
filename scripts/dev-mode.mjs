import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { findClaudeCli } from "./claude-cli.mjs";
import { findCodexCli } from "./codex-cli.mjs";
import { runJsonCommand } from "./platform.mjs";
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
const BOOTSTRAP_LAUNCHER = /runtime-bootstrap\.mjs['"] '?(native-host|cli)'?/;

export async function linkDevelopment(options = {}) {
  const projectDir = await validateCheckout(path.resolve(options.projectDir || defaultProjectDir), { requireCanonical: false });
  const stateDir = stateDirectory(options);
  let before = await developmentStatus({ ...options, projectDir, stateDir });
  let refreshedBundledRuntime = false;

  if (!bootstrapUsable(before)) {
    if (options.skipInstall) {
      throw new Error("Bundled runtime bootstrap is missing or differs from the checkout");
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
    if (!bootstrapUsable(before)) {
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
  const claudeCode = await claudePluginStatus({ ...options, stateDir });
  const runtimeMetadata = await readJson(path.join(stateDir, "runtime", "runtime.json")).catch(() => null);
  const nativeBootstrapPath = path.join(stateDir, "runtime", "runtime-bootstrap.mjs");
  const nativeHost = {
    bootstrapPath: nativeBootstrapPath,
    bootstrapReady: existsSync(nativeBootstrapPath) && launchersUseBootstrap(stateDir),
    bootstrapCurrent: await sameFileContent(nativeBootstrapPath, path.join(projectDir, "native-host", "src", "runtime-bootstrap.mjs")),
    runtimeVersion: runtimeMetadata?.version || null,
    runtimeMetadata,
    configuredHostLauncher: path.join(stateDir, "bin", "chromium-bridge-host"),
    configuredCliLauncher: path.join(stateDir, "bin", "chromium-bridge")
  };
  nativeHost.effective = await effectiveRuntime("native-host", stateDir, path.join(stateDir, "runtime"));
  nativeHost.running = await runningHostStatus(stateDir, nativeBootstrapPath, options.env);

  const mismatches = [];
  if (!repoPackage?.version) mismatches.push("repo version unavailable");
  if (!codex.installed && !claudeCode.installed) mismatches.push("No Codex or Claude Code plugin is installed");
  for (const [label, client] of [["plugin", codex], ["Claude Code plugin", claudeCode]]) {
    if (client.version && repoPackage?.version && client.version !== repoPackage.version) {
      mismatches.push(`installed ${label} ${client.version} differs from repo ${repoPackage.version}`);
    }
  }
  if (runtimeMetadata?.version && repoPackage?.version && runtimeMetadata.version !== repoPackage.version) {
    mismatches.push(`native runtime ${runtimeMetadata.version} differs from repo ${repoPackage.version}`);
  }
  if (devLink.present && !devLink.valid) mismatches.push(devLink.error);
  if (devLink.valid && devLink.checkoutRoot !== projectDir) {
    mismatches.push(`development pointer targets ${devLink.checkoutRoot}, not ${projectDir}`);
  }
  if (codex.installed && !codex.bootstrapReady) mismatches.push("Codex MCP configuration does not use the stable bootstrap");
  if (claudeCode.installed && !claudeCode.bootstrapReady) {
    mismatches.push("Claude Code MCP configuration does not use the stable bootstrap");
  }
  if (!nativeHost.bootstrapReady) mismatches.push("native host launchers do not use the stable bootstrap");
  if (!nativeHost.bootstrapCurrent) mismatches.push("installed runtime bootstrap differs from the checkout; run npm run dev:link");
  if (nativeHost.running?.unavailable) mismatches.push(`native host is not reachable: ${nativeHost.running.error}`);

  return {
    mode: devLink.valid ? "checkout" : devLink.present ? "invalid" : "bundled",
    repo: { root: projectDir, version: repoPackage?.version || null },
    stateDir,
    devLink,
    mcp: codex,
    claudeCode,
    nativeHost,
    mismatches,
    healthy: mismatches.length === 0
  };
}

async function codexPluginStatus(options) {
  const codexPath = options.codexPath === null
    ? null
    : options.codexPath || await findCodexCli({ env: options.env || process.env });
  let item = null;
  let error = null;
  if (options.installedPluginPath) {
    item = { version: null, source: { path: path.resolve(options.installedPluginPath) } };
  } else if (codexPath) {
    try {
      const result = await runJsonCommand(codexPath, ["plugin", "list", "--json"], { env: { ...process.env, ...(options.env || {}) } });
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
    ? path.join(codexHome, "plugins", "cache", "nextster", "chromium-bridge", installedVersion)
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
  return {
    installed: Boolean(item),
    codexPath,
    error,
    version: manifest?.version || installedVersion,
    pluginPath,
    registrationPath,
    cachedPath,
    ...await mcpServerStatus(server, options.stateDir)
  };
}

async function claudePluginStatus(options) {
  const claudePath = options.claudePath === null
    ? null
    : options.claudePath || await findClaudeCli({ env: options.env || process.env });
  let item = null;
  let error = null;
  if (claudePath) {
    try {
      const result = await runJsonCommand(claudePath, ["plugin", "list", "--json"], { env: { ...process.env, ...(options.env || {}) } });
      item = (Array.isArray(result) ? result : []).find(candidate => candidate.id === PLUGIN_ID) || null;
    } catch (caught) {
      error = String(caught?.stderr || caught?.message || caught).trim();
    }
  }
  const pluginPath = item?.installPath ? path.resolve(item.installPath) : null;
  const mcpConfig = pluginPath ? await readJson(path.join(pluginPath, ".mcp.json")).catch(() => null) : null;
  return {
    installed: Boolean(item),
    claudePath,
    error,
    version: item?.version || null,
    pluginPath,
    ...await mcpServerStatus(mcpConfig?.mcpServers?.["chromium-bridge"] || item?.mcpServers?.["chromium-bridge"] || null, options.stateDir)
  };
}

async function mcpServerStatus(server, stateDir) {
  const expectedBootstrap = path.join(stateDir, "runtime", "runtime-bootstrap.mjs");
  const bootstrapReady = Boolean(
    server &&
    path.resolve(String(server.args?.[0] || "")) === expectedBootstrap &&
    server.args?.[1] === "mcp"
  );
  return {
    configured: server ? { command: server.command, args: server.args || [] } : null,
    bootstrapReady,
    effective: bootstrapReady ? await effectiveRuntime("mcp", stateDir, path.dirname(expectedBootstrap)) : null
  };
}

async function effectiveRuntime(kind, stateDir, runtimeDir) {
  try {
    return await resolveRuntime(kind, { stateDir, runtimeDir });
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
  const extension = process.platform === "win32" ? ".cmd" : "";
  try {
    const host = readFileSync(path.join(stateDir, "bin", `chromium-bridge-host${extension}`), "utf8");
    const cli = readFileSync(path.join(stateDir, "bin", `chromium-bridge${extension}`), "utf8");
    return host.match(BOOTSTRAP_LAUNCHER)?.[1] === "native-host" && cli.match(BOOTSTRAP_LAUNCHER)?.[1] === "cli";
  } catch {
    return false;
  }
}

async function runningHostStatus(stateDir, bootstrapPath, env) {
  if (!existsSync(bootstrapPath)) return null;
  try {
    const { stdout } = await execFileAsync(process.execPath, [bootstrapPath, "cli", "host-info"], {
      env: { ...process.env, ...(env || {}), CHROMIUM_BRIDGE_STATE_DIR: stateDir },
      timeout: 2000,
      maxBuffer: 1024 * 1024
    });
    return JSON.parse(stdout);
  } catch (error) {
    return { unavailable: true, error: String(error?.stderr || error?.message || error).trim() };
  }
}

function bootstrapUsable(status) {
  return (status.mcp.bootstrapReady || status.claudeCode.bootstrapReady) &&
    status.nativeHost.bootstrapReady &&
    status.nativeHost.bootstrapCurrent;
}

// An installed bootstrap from another release may resolve different checkout
// entrypoints, so development mode requires the checkout's own bootstrap.
async function sameFileContent(left, right) {
  try {
    const [a, b] = await Promise.all([readFile(left), readFile(right)]);
    return a.equals(b);
  } catch {
    return false;
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
