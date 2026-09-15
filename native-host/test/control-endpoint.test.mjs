import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { EXTENSION_ORIGIN } from "../src/constants.mjs";
import {
  authProof,
  connectControl,
  controlEndpoint,
  createControlToken,
  createServerHandshake,
  defaultPipePath
} from "../src/control-endpoint.mjs";

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const hostPath = path.resolve(testDir, "../src/host.mjs");
const cliPath = path.resolve(testDir, "../src/cli.mjs");

test("control endpoint keeps the owner-only Unix socket on macOS and honors the state directory", () => {
  const home = "/home/example";
  assert.deepEqual(controlEndpoint({ platform: "darwin", env: {}, homedir: home }), {
    transport: "unix",
    path: "/home/example/.chromium-bridge/control.sock",
    stateDir: "/home/example/.chromium-bridge",
    authenticated: false,
    tokenPath: null
  });
  const custom = controlEndpoint({ platform: "darwin", env: { CHROMIUM_BRIDGE_STATE_DIR: "/tmp/bridge-state" }, homedir: home });
  assert.equal(custom.path, "/tmp/bridge-state/control.sock");
  const explicit = controlEndpoint({ platform: "darwin", env: { ARC_CODEX_SOCKET: "/tmp/legacy.sock" }, homedir: home });
  assert.equal(explicit.path, "/tmp/legacy.sock");
});

test("control endpoint uses an authenticated per-state-directory named pipe on Windows", () => {
  const home = "C:\\Users\\Example User";
  const endpoint = controlEndpoint({ platform: "win32", env: {}, homedir: home });
  assert.equal(endpoint.transport, "pipe");
  assert.equal(endpoint.authenticated, true);
  assert.equal(endpoint.stateDir, "C:\\Users\\Example User\\.chromium-bridge");
  assert.equal(endpoint.tokenPath, "C:\\Users\\Example User\\.chromium-bridge\\control.token");
  assert.match(endpoint.path, /^\\\\\.\\pipe\\chromium-bridge-[a-f0-9]{24}$/);
  assert.equal(endpoint.path, defaultPipePath("c:\\users\\example user\\.chromium-bridge"));

  const other = controlEndpoint({ platform: "win32", env: { CHROMIUM_BRIDGE_STATE_DIR: "D:\\bridge" }, homedir: home });
  assert.notEqual(other.path, endpoint.path);
  assert.throws(
    () => controlEndpoint({ platform: "win32", env: { CHROMIUM_BRIDGE_SOCKET: "C:\\bridge.sock" }, homedir: home }),
    /must be a named pipe/
  );
});

test("control handshake authenticates both sides without sending the token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-handshake-"));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\chromium-bridge-test-${process.pid}-${Date.now()}`
    : path.join(root, "control.sock");
  const token = createControlToken();
  const seen = [];
  const server = net.createServer(socket => {
    socket.setEncoding("utf8");
    const handshake = createServerHandshake(token);
    let buffered = "";
    socket.on("data", chunk => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        seen.push(line);
        try {
          const step = handshake.receive(JSON.parse(line));
          if (step.reply) socket.write(`${JSON.stringify(step.reply)}\n`);
          if (step.authenticated) socket.write(`${JSON.stringify({ ok: true })}\n`);
        } catch {
          socket.destroy();
        }
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const endpoint = { path: socketPath, authenticated: true, tokenPath: "unused" };

  try {
    const socket = await connectControl(endpoint, { readToken: async () => token });
    const reply = await new Promise(resolve => socket.once("data", resolve));
    assert.deepEqual(JSON.parse(reply), { ok: true });
    socket.destroy();
    assert.ok(seen.every(line => !line.includes(token)));

    await assert.rejects(
      connectControl(endpoint, { readToken: async () => createControlToken() }),
      /failed authentication/
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("server handshake rejects skipped or forged client proofs", () => {
  const token = createControlToken();
  const clientNonce = "a".repeat(64);
  assert.throws(() => createServerHandshake(token).receive({ id: 1, method: "host.info" }), /must authenticate/);

  const handshake = createServerHandshake(token);
  const { reply } = handshake.receive({ type: "auth.hello", nonce: clientNonce });
  assert.equal(reply.proof, authProof(token, "server", clientNonce, reply.nonce));
  assert.throws(
    () => handshake.receive({ type: "auth.response", proof: authProof(token, "server", clientNonce, reply.nonce) }),
    /authentication failed/
  );
  assert.deepEqual(
    createServerHandshakeRoundTrip(token, clientNonce),
    { authenticated: true }
  );
});

test("native host requires the handshake when control authentication is enabled", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-auth-host-"));
  const stateDir = path.join(root, "state");
  const env = { ...process.env, CHROMIUM_BRIDGE_STATE_DIR: stateDir, CHROMIUM_BRIDGE_CONTROL_AUTH: "1" };
  delete env.CHROMIUM_BRIDGE_SOCKET;
  delete env.ARC_CODEX_SOCKET;
  const endpoint = controlEndpoint({ env });
  const tokenPath = endpoint.tokenPath;
  const socketPath = endpoint.path;
  const child = spawn(process.execPath, [hostPath, EXTENSION_ORIGIN], { env, stdio: ["pipe", "pipe", "pipe"] });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(chunk.toString("utf8")));

  try {
    await waitFor(async () => stat(tokenPath).then(() => true, () => false));
    if (process.platform !== "win32") assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
    assert.match((await readFile(tokenPath, "utf8")).trim(), /^[a-f0-9]{64}$/);

    const { stdout } = await execFileAsync(process.execPath, [cliPath, "host-info"], { env });
    const info = JSON.parse(stdout);
    assert.equal(info.controlAuthenticated, true);

    const unauthenticated = await rawRequest(socketPath, { id: "x", method: "host.info" });
    assert.equal(unauthenticated, "");
  } finally {
    child.stdin.end();
    await waitForExit(child, 5000);
    await waitFor(async () => stat(tokenPath).then(() => false, () => true)).catch(() => {
      throw new Error(`control token was not removed: ${stderr.join("")}`);
    });
    await rm(root, { recursive: true, force: true });
  }
});

function createServerHandshakeRoundTrip(token, clientNonce) {
  const handshake = createServerHandshake(token);
  const { reply } = handshake.receive({ type: "auth.hello", nonce: clientNonce });
  return handshake.receive({ type: "auth.response", proof: authProof(token, "client", clientNonce, reply.nonce) });
}

function rawRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", chunk => { received += chunk; });
    socket.once("close", () => resolve(received));
    socket.once("error", () => resolve(received));
  });
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

function waitForExit(child, timeoutMs) {
  return new Promise(resolve => {
    if (child.exitCode != null) return resolve(child.exitCode);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    child.once("exit", code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
