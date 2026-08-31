import os from "node:os";
import path from "node:path";
import process from "node:process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";

export const DEV_LINK_SCHEMA_VERSION = 1;
export const DEV_LINK_FILE = "dev-link.json";

const ENTRYPOINTS = Object.freeze({
  mcp: "plugins/chromium-bridge/mcp/server.mjs",
  cli: "native-host/src/cli.mjs",
  "native-host": "native-host/src/host.mjs"
});

const currentFile = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  try {
    await launch(process.argv[2]);
  } catch (error) {
    console.error(`Chromium Bridge runtime bootstrap: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

export async function launch(kind, options = {}) {
  const resolved = await resolveRuntime(kind, options);
  process.argv.splice(2, 1);
  process.env.CHROMIUM_BRIDGE_ACTIVE_SOURCE = resolved.source;
  process.env.CHROMIUM_BRIDGE_ACTIVE_ENTRYPOINT = resolved.entrypoint;
  if (resolved.checkoutRoot) {
    process.env.CHROMIUM_BRIDGE_ACTIVE_CHECKOUT = resolved.checkoutRoot;
  } else {
    delete process.env.CHROMIUM_BRIDGE_ACTIVE_CHECKOUT;
  }
  process.chdir(resolved.cwd);
  await import(pathToFileURL(resolved.entrypoint).href);
}

export async function resolveRuntime(kind, options = {}) {
  const relativeEntrypoint = ENTRYPOINTS[kind];
  if (!relativeEntrypoint) {
    throw new Error(`Unknown runtime kind ${JSON.stringify(kind)}; expected mcp, cli, or native-host`);
  }

  const stateDir = path.resolve(
    options.stateDir || process.env.CHROMIUM_BRIDGE_STATE_DIR || path.join(os.homedir(), ".chromium-bridge")
  );
  const pointerPath = path.join(stateDir, DEV_LINK_FILE);
  const pointer = await readDevLink(pointerPath);
  if (pointer) {
    const checkoutRoot = await validateCheckout(pointer.checkoutRoot);
    const entrypoint = await resolveContainedFile(checkoutRoot, relativeEntrypoint);
    return {
      source: "checkout",
      kind,
      pointerPath,
      checkoutRoot,
      entrypoint,
      cwd: kind === "mcp" ? path.dirname(path.dirname(entrypoint)) : path.dirname(entrypoint)
    };
  }

  const runtimeDir = path.resolve(options.runtimeDir || path.dirname(currentFile));
  const fallback = kind === "mcp"
    ? path.resolve(options.fallbackCwd || process.cwd(), "mcp", "server.mjs")
    : path.join(runtimeDir, kind === "cli" ? "cli.mjs" : "host.mjs");
  await requireRegularFile(fallback, `bundled ${kind} entrypoint`);
  return {
    source: "bundled",
    kind,
    pointerPath,
    checkoutRoot: null,
    entrypoint: fallback,
    cwd: kind === "mcp" ? path.dirname(path.dirname(fallback)) : path.dirname(fallback)
  };
}

export async function readDevLink(pointerPath) {
  let metadata;
  try {
    metadata = await lstat(pointerPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Development pointer must be a regular file: ${pointerPath}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`Development pointer is not owned by the current user: ${pointerPath}`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Development pointer permissions must be 0600: ${pointerPath}`);
  }

  let pointer;
  try {
    pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  } catch (error) {
    throw new Error(`Development pointer is invalid JSON: ${errorMessage(error)}`);
  }
  if (pointer?.schemaVersion !== DEV_LINK_SCHEMA_VERSION) {
    throw new Error(`Unsupported development pointer schema: ${String(pointer?.schemaVersion)}`);
  }
  if (typeof pointer.checkoutRoot !== "string" || !path.isAbsolute(pointer.checkoutRoot)) {
    throw new Error("Development pointer checkoutRoot must be an absolute path");
  }
  return pointer;
}

export async function validateCheckout(checkoutRoot, options = {}) {
  const requested = path.resolve(checkoutRoot);
  let canonical;
  try {
    canonical = await realpath(requested);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Linked checkout no longer exists: ${requested}`);
    }
    throw error;
  }
  if (options.requireCanonical !== false && canonical !== requested) {
    throw new Error(`Linked checkout is not canonical: ${requested} resolves to ${canonical}`);
  }
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Linked checkout must be a real directory: ${canonical}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`Linked checkout is not owned by the current user: ${canonical}`);
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error(`Linked checkout must not be group- or world-writable: ${canonical}`);
  }
  const packagePath = await resolveContainedFile(canonical, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  if (packageJson.name !== "chromium-bridge") {
    throw new Error(`Linked checkout is not Chromium Bridge: ${canonical}`);
  }
  for (const relativeEntrypoint of Object.values(ENTRYPOINTS)) {
    await resolveContainedFile(canonical, relativeEntrypoint);
  }
  return canonical;
}

async function resolveContainedFile(root, relativePath) {
  const candidate = path.resolve(root, relativePath);
  const canonical = await realpath(candidate).catch(error => {
    if (error?.code === "ENOENT") throw new Error(`Linked checkout is missing ${relativePath}: ${root}`);
    throw error;
  });
  if (canonical !== candidate || !canonical.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Linked checkout path escapes its root: ${relativePath}`);
  }
  await requireRegularFile(canonical, relativePath);
  return canonical;
}

async function requireRegularFile(filePath, label) {
  const metadata = await lstat(filePath).catch(error => {
    if (error?.code === "ENOENT") throw new Error(`Missing ${label}: ${filePath}`);
    throw error;
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
}

function errorMessage(error) {
  return String(error?.message || error);
}
