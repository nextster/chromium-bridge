import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readdir,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { arcProviderInfo, focusArcSpace, listArcSpaces } from "./arc-provider.mjs";
import { EXTENSION_ORIGIN, NATIVE_HOST_NAME, PRODUCT_VERSION } from "./constants.mjs";
import { readNativeMessages, writeNativeMessage } from "./native-protocol.mjs";
import { renderCurl } from "./replay.mjs";

process.umask(0o077);

const startedAt = new Date().toISOString();
const callerOrigin = process.argv[2] || "";
const expectedOrigins = allowedOrigins(
  process.env.CHROMIUM_BRIDGE_ALLOWED_ORIGINS ||
  process.env.CHROMIUM_BRIDGE_ALLOWED_ORIGIN ||
  process.env.ARC_CODEX_ALLOWED_ORIGIN ||
  EXTENSION_ORIGIN
);
const configuredStateDir = process.env.CHROMIUM_BRIDGE_STATE_DIR || process.env.ARC_CODEX_STATE_DIR;
const configuredSocketPath = process.env.CHROMIUM_BRIDGE_SOCKET || process.env.ARC_CODEX_SOCKET;
const stateDir = path.resolve(configuredStateDir || path.join(os.homedir(), ".chromium-bridge"));
const socketPath = path.resolve(configuredSocketPath || path.join(stateDir, "control.sock"));
const compatibilitySocketPath = configuredStateDir || configuredSocketPath
  ? null
  : path.resolve(process.env.CHROMIUM_BRIDGE_LEGACY_SOCKET || path.join(os.homedir(), ".arc-codex-bridge", "control.sock"));
const capturesRoot = path.resolve(
  process.env.CHROMIUM_BRIDGE_CAPTURES_DIR || process.env.ARC_CODEX_CAPTURES_DIR || path.join(stateDir, "captures")
);
const maxEvents = positiveInteger(
  process.env.CHROMIUM_BRIDGE_MAX_EVENTS || process.env.ARC_CODEX_MAX_EVENTS,
  10000,
  100000
);
const maxEventBytes = positiveInteger(process.env.CHROMIUM_BRIDGE_MAX_EVENT_BYTES, 1024 * 1024, 8 * 1024 * 1024);
const maxEventMemoryBytes = positiveInteger(
  process.env.CHROMIUM_BRIDGE_MAX_EVENT_MEMORY_BYTES,
  64 * 1024 * 1024,
  512 * 1024 * 1024
);
const maxCaptureBytes = positiveInteger(
  process.env.CHROMIUM_BRIDGE_MAX_CAPTURE_BYTES,
  256 * 1024 * 1024,
  2 * 1024 * 1024 * 1024
);
const captureDir = path.join(capturesRoot, `${stamp()}-${process.pid}`);
const eventsPath = path.join(captureDir, "events.ndjson");
const snapshotPath = path.join(captureDir, "latest.json");
const currentPath = path.join(stateDir, "current.json");
const clients = new Set();
const events = [];
const eventSizes = [];
const pending = new Map();
const listeners = [];
const CONSENT_FREE_EXTENSION_COMMANDS = new Set([
  "ping",
  "privacy.status",
  "native.reconnect",
  "runtime.reload",
  "runtime.uninstallDevelopment"
]);

let extensionInfo = null;
let commandSequence = 0;
let shuttingDown = false;
let eventWriteQueue = Promise.resolve();
let nativeWriteQueue = Promise.resolve();
let eventWriteBuffer = "";
let eventFlushTimer = null;
let eventMemoryBytes = 0;
let eventBytesWritten = 0;
let captureLimitReached = false;

if (!expectedOrigins.includes(callerOrigin)) {
  fatal(`Refusing Native Messaging caller ${callerOrigin || "<missing>"}; expected an installed extension origin`);
}

await prepareFilesystem();
await startControlServer(socketPath);
if (compatibilitySocketPath && compatibilitySocketPath !== socketPath) {
  void maintainCompatibilitySocket(compatibilitySocketPath);
}
await writeCurrentState();

consumeNativeInput().catch(error => shutdown(1, error));

process.stdin.on("end", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("uncaughtException", error => shutdown(1, error));
process.on("unhandledRejection", error => shutdown(1, error));

async function consumeNativeInput() {
  for await (const message of readNativeMessages(process.stdin)) {
    if (message?.type === "hello") {
      extensionInfo = message;
      recordEvent({ type: "bridge.hello", payload: message });
      await writeCurrentState();
      continue;
    }
    if (message?.type === "event") {
      recordEvent(message.event || { type: "unknown", payload: message });
      if (message.event?.type === "capture.stopped") await writeSnapshot();
      continue;
    }
    if (message?.type === "response" && message.id != null) {
      resolvePending(message);
    }
  }
  await shutdown(0);
}

function handleClient(socket) {
  clients.add(socket);
  socket.setEncoding("utf8");
  socket.setTimeout(60000, () => socket.destroy(new Error("Control socket timed out")));
  let buffered = "";

  socket.on("data", chunk => {
    buffered += chunk;
    if (Buffer.byteLength(buffered, "utf8") > 1024 * 1024) {
      socket.destroy(new Error("Control request exceeds 1 MiB"));
      return;
    }
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      void handleControlLine(socket, line);
    }
  });
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => {});
}

async function handleControlLine(socket, line) {
  let request;
  try {
    request = JSON.parse(line);
    const result = await handleControlRequest(request);
    writeControl(socket, { id: request?.id ?? null, ok: true, result });
  } catch (error) {
    writeControl(socket, { id: request?.id ?? null, ok: false, error: errorMessage(error) });
  }
}

async function handleControlRequest(request) {
  const method = String(request?.method || "");
  const params = request?.params || {};
  switch (method) {
    case "host.info":
      return hostInfo();
    case "host.status": {
      const extension = await sendCommand("ping", {}, 5000);
      return { host: hostInfo(), extension };
    }
    case "providers.list":
      return [await arcProviderInfo()];
    case "arc.spaces.list":
      requireBrowserConsent();
      return listArcSpaces();
    case "arc.space.focus":
      requireBrowserConsent();
      return focusArcSpace(requiredString(params.spaceId, "spaceId"));
    case "events.list": {
      requireBrowserConsent();
      const limit = positiveInteger(params.limit, 100, 1000);
      return events.slice(-limit);
    }
    case "events.clear":
      await clearEvents();
      return { cleared: true, captureDir };
    case "captures.purge":
      return purgeCaptures();
    case "curl.render":
      requireBrowserConsent();
      return renderCurl(events);
    case "extension.command": {
      const command = requiredString(params.command, "command");
      if (!CONSENT_FREE_EXTENSION_COMMANDS.has(command)) requireBrowserConsent();
      return sendCommand(command, params.params || {}, params.timeoutMs);
    }
    default:
      throw new Error(`Unknown control method: ${method || "<missing>"}`);
  }
}

function sendCommand(command, params = {}, requestedTimeout) {
  const id = `cmd-${process.pid}-${++commandSequence}`;
  const timeoutMs = positiveInteger(requestedTimeout, 30000, 120000);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for extension command ${command}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    sendNative({ id, command, params }).catch(error => {
      const item = pending.get(id);
      if (!item) return;
      pending.delete(id);
      clearTimeout(item.timer);
      item.reject(error);
    });
  });
}

function resolvePending(message) {
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  clearTimeout(item.timer);
  if (message.ok) item.resolve(message.result);
  else item.reject(new Error(message.error || "Extension command failed"));
}

function sendNative(message) {
  const operation = nativeWriteQueue.then(() => writeNativeMessage(process.stdout, message));
  nativeWriteQueue = operation.catch(() => {});
  return operation;
}

function recordEvent(event) {
  let normalized = {
    ts: event?.ts || new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    type: String(event?.type || "unknown"),
    payload: event?.payload ?? {}
  };
  let line = `${JSON.stringify(normalized)}\n`;
  let lineBytes = Buffer.byteLength(line, "utf8");
  if (lineBytes > maxEventBytes) {
    normalized = {
      ts: normalized.ts,
      receivedAt: normalized.receivedAt,
      type: normalized.type,
      payload: { truncated: true, originalBytes: lineBytes, limitBytes: maxEventBytes }
    };
    line = `${JSON.stringify(normalized)}\n`;
    lineBytes = Buffer.byteLength(line, "utf8");
  }

  events.push(normalized);
  eventSizes.push(lineBytes);
  eventMemoryBytes += lineBytes;
  while (events.length > maxEvents || eventMemoryBytes > maxEventMemoryBytes) {
    events.shift();
    eventMemoryBytes -= eventSizes.shift() || 0;
  }

  if (!captureLimitReached && eventBytesWritten + Buffer.byteLength(eventWriteBuffer, "utf8") + lineBytes <= maxCaptureBytes) {
    eventWriteBuffer += line;
  } else {
    captureLimitReached = true;
  }
  if (Buffer.byteLength(eventWriteBuffer, "utf8") >= 64 * 1024) {
    void flushEventWrites();
  } else if (!eventFlushTimer) {
    eventFlushTimer = setTimeout(() => void flushEventWrites(), 25);
    eventFlushTimer.unref?.();
  }
}

function flushEventWrites() {
  if (eventFlushTimer) {
    clearTimeout(eventFlushTimer);
    eventFlushTimer = null;
  }
  if (!eventWriteBuffer) return eventWriteQueue;
  const payload = eventWriteBuffer;
  eventWriteBuffer = "";
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  eventBytesWritten += payloadBytes;
  const operation = eventWriteQueue.then(() => appendFile(eventsPath, payload, { mode: 0o600 }));
  eventWriteQueue = operation.catch(error => logError(`capture write failed: ${errorMessage(error)}`));
  return operation;
}

async function clearEvents() {
  events.length = 0;
  eventSizes.length = 0;
  eventMemoryBytes = 0;
  await flushEventWrites();
  await writeFile(eventsPath, "", { mode: 0o600 });
  eventBytesWritten = 0;
  captureLimitReached = false;
  await writeSnapshot();
}

async function purgeCaptures() {
  await clearEvents();
  const entries = await readdir(capturesRoot, { withFileTypes: true }).catch(error => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  let removed = 0;
  for (const entry of entries) {
    const entryPath = path.resolve(capturesRoot, entry.name);
    if (entryPath === captureDir) continue;
    await rm(entryPath, { recursive: true, force: true });
    removed += 1;
  }
  return { purged: true, removed, activeCaptureDir: captureDir };
}

async function writeSnapshot() {
  await flushEventWrites();
  await writePrivateJson(snapshotPath, { events });
}

function hostInfo() {
  return {
    name: NATIVE_HOST_NAME,
    version: PRODUCT_VERSION,
    pid: process.pid,
    startedAt,
    callerOrigin,
    socketPath,
    socketPaths: listeners.map(listener => listener.filePath),
    compatibilitySocketPath,
    captureDir,
    events: events.length,
    captureStorage: {
      bytesWritten: eventBytesWritten,
      maxBytes: maxCaptureBytes,
      limitReached: captureLimitReached
    },
    extension: extensionInfo?.extension || null,
    privacy: extensionInfo?.privacy || { consented: false },
    permissions: extensionInfo?.permissions || {}
  };
}

async function prepareFilesystem() {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  await mkdir(captureDir, { recursive: true, mode: 0o700 });
  await chmod(captureDir, 0o700);
  await writeFile(eventsPath, "", { mode: 0o600 });
}

async function startControlServer(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(filePath), 0o700);
  await ensureSocketAvailable(filePath);
  const server = net.createServer(handleClient);
  await listen(server, filePath);
  await chmod(filePath, 0o600);
  listeners.push({ server, filePath, identity: await socketInode(filePath) });
}

async function maintainCompatibilitySocket(filePath) {
  let reported = false;
  while (!shuttingDown) {
    try {
      await startControlServer(filePath);
      await writeCurrentState();
      return;
    } catch (error) {
      if (error?.code !== "EADDRINUSE") {
        logError(`legacy socket failed: ${errorMessage(error)}`);
        return;
      }
      if (!reported) {
        logError(`waiting for legacy bridge socket ${filePath}`);
        reported = true;
      }
      await delay(500);
    }
  }
}

async function writeCurrentState() {
  await writePrivateJson(currentPath, hostInfo());
}

async function writePrivateJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

function writeControl(socket, value) {
  if (socket.destroyed) return;
  socket.write(`${JSON.stringify(value)}\n`);
}

async function ensureSocketAvailable(filePath) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  if (await socketAcceptsConnections(filePath)) {
    const error = new Error(`Another Chromium Bridge native host is already listening on ${filePath}`);
    error.code = "EADDRINUSE";
    throw error;
  }
  await unlink(filePath).catch(error => {
    if (error?.code !== "ENOENT") throw error;
  });
}

function socketAcceptsConnections(filePath) {
  return new Promise(resolve => {
    const socket = net.createConnection(filePath);
    const timer = setTimeout(() => finish(false), 300);
    const finish = result => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", error => finish(!["ENOENT", "ECONNREFUSED"].includes(error?.code)));
  });
}

function listen(netServer, filePath) {
  return new Promise((resolve, reject) => {
    const onError = error => reject(error);
    netServer.once("error", onError);
    netServer.listen(filePath, () => {
      netServer.off("error", onError);
      resolve();
    });
  });
}

async function socketInode(filePath) {
  try {
    return (await lstat(filePath)).ino;
  } catch {
    return null;
  }
}

async function shutdown(code, error) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (error) logError(errorMessage(error));
  for (const socket of clients) socket.destroy();
  for (const [id, item] of pending) {
    pending.delete(id);
    clearTimeout(item.timer);
    item.reject(new Error("Native host is shutting down"));
  }
  await flushEventWrites().catch(() => {});
  await writeSnapshot().catch(() => {});
  for (const listener of listeners) {
    await new Promise(resolve => listener.server.close(() => resolve())).catch(() => {});
  }
  for (const listener of listeners) {
    if (listener.identity != null && await socketInode(listener.filePath) === listener.identity) {
      await unlink(listener.filePath).catch(() => {});
    }
  }
  process.exit(code);
}

function positiveInteger(value, fallback, maximum) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`Expected a positive integer, got ${value}`);
  return Math.min(number, maximum);
}

function requiredString(value, label) {
  const result = String(value ?? "");
  if (!result.trim()) throw new Error(`Missing ${label}`);
  return result;
}

function requireBrowserConsent() {
  if (
    extensionInfo?.privacy?.consented !== true ||
    extensionInfo?.permissions?.siteAccess !== true ||
    extensionInfo?.permissions?.tabs !== true
  ) {
    throw new Error("Browser access has not been approved in the Chromium Bridge popup");
  }
}

function allowedOrigins(value) {
  const origins = String(value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
  if (!origins.length || origins.length > 16) throw new Error("Invalid Native Messaging origin allowlist");
  for (const origin of origins) {
    if (!/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin)) {
      throw new Error(`Invalid Native Messaging extension origin: ${origin}`);
    }
  }
  return Array.from(new Set(origins));
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return String(error?.message || error);
}

function logError(message) {
  process.stderr.write(`[chromium-bridge] ${message}\n`);
}

function fatal(message) {
  logError(message);
  process.exit(1);
}
