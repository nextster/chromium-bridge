import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  DEV_LINK_SCHEMA_VERSION,
  resolveRuntime
} from "../src/runtime-bootstrap.mjs";

const execFileAsync = promisify(execFile);
const bootstrapPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/runtime-bootstrap.mjs");

test("runtime bootstrap selects fixed checkout entrypoints and bundled fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-bootstrap-"));
  const checkout = path.join(root, "checkout");
  const state = path.join(root, "state");
  const runtimeDir = path.join(root, "runtime");
  await makeCheckout(checkout);
  await mkdir(state, { recursive: true, mode: 0o700 });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(path.join(runtimeDir, "mcp-server.mjs"), "export {};\n");

  try {
    const fallback = await resolveRuntime("mcp", { stateDir: state, runtimeDir });
    assert.equal(fallback.source, "bundled");
    assert.equal(fallback.entrypoint, path.join(runtimeDir, "mcp-server.mjs"));
    assert.equal(fallback.cwd, runtimeDir);

    const canonicalCheckout = await realpath(checkout);
    await writePointer(state, canonicalCheckout);
    const mcp = await resolveRuntime("mcp", { stateDir: state, runtimeDir });
    const nativeHost = await resolveRuntime("native-host", { stateDir: state });
    assert.equal(mcp.source, "checkout");
    assert.equal(mcp.entrypoint, path.join(canonicalCheckout, "native-host", "src", "mcp-server.mjs"));
    assert.equal(mcp.cwd, path.join(canonicalCheckout, "native-host", "src"));
    assert.equal(nativeHost.entrypoint, path.join(canonicalCheckout, "native-host", "src", "host.mjs"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime bootstrap launches the linked MCP entrypoint with checkout metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-bootstrap-launch-"));
  const checkout = path.join(root, "checkout");
  const state = path.join(root, "state");
  await makeCheckout(checkout);
  await mkdir(state, { recursive: true, mode: 0o700 });
  const canonicalCheckout = await realpath(checkout);
  await writePointer(state, canonicalCheckout);
  await writeFile(
    path.join(checkout, "native-host", "src", "mcp-server.mjs"),
    "console.log(JSON.stringify({ source: process.env.CHROMIUM_BRIDGE_ACTIVE_SOURCE, entrypoint: process.env.CHROMIUM_BRIDGE_ACTIVE_ENTRYPOINT, checkout: process.env.CHROMIUM_BRIDGE_ACTIVE_CHECKOUT, cwd: process.cwd() }));\n"
  );
  try {
    const { stdout } = await execFileAsync(process.execPath, [bootstrapPath, "mcp"], {
      env: { ...process.env, CHROMIUM_BRIDGE_STATE_DIR: state }
    });
    const result = JSON.parse(stdout);
    assert.equal(result.source, "checkout");
    assert.equal(result.checkout, canonicalCheckout);
    assert.equal(result.entrypoint, path.join(canonicalCheckout, "native-host", "src", "mcp-server.mjs"));
    assert.equal(result.cwd, path.join(canonicalCheckout, "native-host", "src"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime bootstrap rejects missing, moved, and insecure checkout pointers", {
  skip: process.platform === "win32" && "relies on POSIX permission bits"
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-bootstrap-invalid-"));
  const state = path.join(root, "state");
  const checkout = path.join(root, "checkout");
  await mkdir(state, { recursive: true, mode: 0o700 });
  await makeCheckout(checkout);
  try {
    await writePointer(state, await realpath(checkout));
    await rm(checkout, { recursive: true, force: true });
    await assert.rejects(resolveRuntime("cli", { stateDir: state }), /no longer exists/);

    await makeCheckout(checkout);
    const moved = path.join(root, "moved");
    await rm(moved, { recursive: true, force: true });
    await import("node:fs/promises").then(({ rename }) => rename(checkout, moved));
    await assert.rejects(resolveRuntime("cli", { stateDir: state }), /no longer exists/);

    await writePointer(state, await realpath(moved));
    await chmod(path.join(state, "dev-link.json"), 0o644);
    await assert.rejects(resolveRuntime("cli", { stateDir: state }), /permissions must be 0600/);
    const windows = await resolveRuntime("cli", { stateDir: state, platform: "win32" });
    assert.equal(windows.source, "checkout");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function makeCheckout(root) {
  await mkdir(path.join(root, "native-host", "src"), { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "chromium-bridge", version: "9.9.9" }));
  await writeFile(path.join(root, "native-host", "src", "mcp-server.mjs"), "export {};\n");
  await writeFile(path.join(root, "native-host", "src", "cli.mjs"), "export {};\n");
  await writeFile(path.join(root, "native-host", "src", "host.mjs"), "export {};\n");
}

async function writePointer(state, checkoutRoot) {
  const pointer = path.join(state, "dev-link.json");
  await writeFile(pointer, `${JSON.stringify({ schemaVersion: DEV_LINK_SCHEMA_VERSION, checkoutRoot })}\n`, { mode: 0o600 });
  await chmod(pointer, 0o600);
}
