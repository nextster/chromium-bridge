import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { EXTENSION_ORIGIN } from "../src/constants.mjs";
import { encodeNativeMessage, readNativeMessages } from "../src/native-protocol.mjs";

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const hostPath = path.resolve(testDir, "../src/host.mjs");
const cliPath = path.resolve(testDir, "../src/cli.mjs");

test("native host bridges CLI commands and records replayable events", { timeout: 15000 }, async () => {
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-host-test-"));
  const stateDir = path.join(temporaryDir, "state");
  const socketPath = path.join(stateDir, "control.sock");
  const env = { ...process.env, ARC_CODEX_STATE_DIR: stateDir, ARC_CODEX_SOCKET: socketPath };
  const child = spawn(process.execPath, [hostPath, EXTENSION_ORIGIN], { env, stdio: ["pipe", "pipe", "pipe"] });
  const stderr = [];
  child.stderr.on("data", chunk => stderr.push(chunk.toString("utf8")));
  const nativeMessages = readNativeMessages(child.stdout)[Symbol.asyncIterator]();

  try {
    await waitFor(async () => stat(socketPath).then(() => true, () => false));
    await assert.rejects(
      control(socketPath, "extension.command", { command: "tabs.list", params: {} }),
      /has not been approved/
    );
    await assert.rejects(control(socketPath, "arc.spaces.list"), /has not been approved/);
    child.stdin.write(encodeNativeMessage({
      type: "hello",
      extension: { id: "test-extension", name: "Chromium Bridge", version: "test" },
      capture: { enabled: false },
      privacy: { consented: true, version: 1 },
      permissions: { siteAccess: true, tabs: true, cookies: false, debugger: false }
    }));

    await waitFor(async () => {
      const info = await control(socketPath, "host.info");
      return info.extension?.id === "test-extension";
    });

    const cli = await execFileAsync(process.execPath, [cliPath, "host-info"], { env });
    assert.match(cli.stdout, /test-extension/);

    const statusPromise = control(socketPath, "host.status");
    const nativeCommand = await nativeMessages.next();
    assert.equal(nativeCommand.done, false);
    assert.equal(nativeCommand.value.command, "ping");
    child.stdin.write(encodeNativeMessage({
      type: "response",
      id: nativeCommand.value.id,
      ok: true,
      result: { pong: true, userScriptsAvailable: true }
    }));
    const status = await statusPromise;
    assert.equal(status.extension.pong, true);

    const before = {
      type: "event",
      event: {
        type: "request.before",
        payload: {
          requestId: "form-1",
          method: "POST",
          url: "https://example.test/submit",
          requestBody: { kind: "formData", data: { amount: ["42"], token: ["<redacted:8>"] } }
        }
      }
    };
    const headers = {
      type: "event",
      event: {
        type: "request.headers",
        payload: {
          requestId: "form-1",
          method: "POST",
          url: "https://example.test/submit",
          requestHeaders: [{ name: "Content-Type", value: "application/x-www-form-urlencoded" }]
        }
      }
    };
    child.stdin.write(encodeNativeMessage(before));
    child.stdin.write(encodeNativeMessage(headers));

    await waitFor(async () => (await control(socketPath, "host.info")).events >= 3);
    const replay = await control(socketPath, "curl.render");
    assert.match(replay, /--data-urlencode 'amount=42'/);
    assert.match(replay, /BRIDGE_FORM_1_TOKEN_1/);

    const info = await control(socketPath, "host.info");
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    assert.equal((await stat(info.captureDir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(info.captureDir, "events.ndjson"))).mode & 0o777, 0o600);
  } finally {
    child.stdin.end();
    const exit = await waitForExit(child, 5000);
    if (exit == null) child.kill("SIGKILL");
    assert.equal(exit, 0, stderr.join(""));
    await waitFor(async () => stat(socketPath).then(() => false, () => true));
    await chmod(temporaryDir, 0o700).catch(() => {});
    await rm(temporaryDir, { recursive: true, force: true });
  }
});

test("native host rejects an unexpected extension origin", async () => {
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-origin-test-"));
  const stateDir = path.join(temporaryDir, "state");
  const child = spawn(process.execPath, [hostPath, "chrome-extension://wrong/"], {
    env: { ...process.env, ARC_CODEX_STATE_DIR: stateDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
  const exit = await waitForExit(child, 3000);
  assert.equal(exit, 1);
  assert.match(stderr, /Refusing Native Messaging caller/);
  await assert.rejects(stat(stateDir), error => error?.code === "ENOENT");
  await rm(temporaryDir, { recursive: true, force: true });
});

function control(socketPath, method, params = {}) {
  const id = `${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffered = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("data", chunk => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffered.slice(0, newline));
        socket.destroy();
        if (!response.ok) reject(new Error(response.error));
        else resolve(response.result);
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw lastError || new Error("Timed out waiting for condition");
}

function waitForExit(child, timeoutMs) {
  return new Promise(resolve => {
    if (child.exitCode != null) return resolve(child.exitCode);
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once("exit", code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
