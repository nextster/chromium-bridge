import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { readFile } from "node:fs/promises";

export const CONTROL_TOKEN_FILE = "control.token";

const PIPE_PREFIX = "\\\\.\\pipe\\";
const AUTH_CONTEXT = "chromium-bridge-control-v1";
const HEX_256 = /^[a-f0-9]{64}$/;
const HANDSHAKE_TIMEOUT_MS = 5000;

export function resolveStateDir(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.resolve(
    env.CHROMIUM_BRIDGE_STATE_DIR ||
    env.ARC_CODEX_STATE_DIR ||
    pathApi.join(options.homedir || os.homedir(), ".chromium-bridge")
  );
}

// Unix sockets rely on owner-only filesystem permissions. Windows named pipes
// live in a machine-wide namespace with a default DACL, so every connection
// performs a mutual HMAC handshake with a per-host token from the state dir.
export function controlEndpoint(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const stateDir = resolveStateDir({ ...options, platform, env });
  const configured = env.CHROMIUM_BRIDGE_SOCKET || env.ARC_CODEX_SOCKET;
  const tokenPath = pathApi.join(stateDir, CONTROL_TOKEN_FILE);

  if (platform === "win32") {
    const pipePath = configured || defaultPipePath(stateDir);
    if (!isPipePath(pipePath)) {
      throw new Error(`Windows control endpoint must be a named pipe under ${PIPE_PREFIX}: ${pipePath}`);
    }
    return { transport: "pipe", path: pipePath, stateDir, authenticated: true, tokenPath };
  }

  const authenticated = env.CHROMIUM_BRIDGE_CONTROL_AUTH === "1";
  return {
    transport: "unix",
    path: pathApi.resolve(configured || pathApi.join(stateDir, "control.sock")),
    stateDir,
    authenticated,
    tokenPath: authenticated ? tokenPath : null
  };
}

export function defaultPipePath(stateDir) {
  const digest = crypto.createHash("sha256").update(String(stateDir).toLowerCase()).digest("hex").slice(0, 24);
  return `${PIPE_PREFIX}chromium-bridge-${digest}`;
}

export function isPipePath(value) {
  return String(value).startsWith(PIPE_PREFIX) && String(value).length > PIPE_PREFIX.length;
}

export function createControlToken() {
  return crypto.randomBytes(32).toString("hex");
}

export async function readControlToken(tokenPath) {
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!HEX_256.test(token)) throw new Error(`Invalid Chromium Bridge control token: ${tokenPath}`);
  return token;
}

export function authProof(token, role, clientNonce, serverNonce) {
  return crypto
    .createHmac("sha256", Buffer.from(token, "hex"))
    .update(`${AUTH_CONTEXT}\n${role}\n${clientNonce}\n${serverNonce}`)
    .digest("hex");
}

function proofMatches(expected, actual) {
  if (!HEX_256.test(String(actual || ""))) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

export function createServerHandshake(token) {
  const serverNonce = crypto.randomBytes(32).toString("hex");
  let clientNonce = null;
  return {
    receive(message) {
      if (!clientNonce) {
        if (message?.type !== "auth.hello" || !HEX_256.test(String(message.nonce || ""))) {
          throw new Error("Control client must authenticate first");
        }
        clientNonce = message.nonce;
        return {
          authenticated: false,
          reply: {
            type: "auth.challenge",
            nonce: serverNonce,
            proof: authProof(token, "server", clientNonce, serverNonce)
          }
        };
      }
      if (message?.type !== "auth.response" || !proofMatches(authProof(token, "client", clientNonce, serverNonce), message.proof)) {
        throw new Error("Control client authentication failed");
      }
      return { authenticated: true };
    }
  };
}

export function connectControl(endpoint, options = {}) {
  const connect = options.connect || net.createConnection;
  const readToken = options.readToken || readControlToken;
  const timeoutMs = options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint.path);
    let settled = false;
    let buffered = "";
    let token = null;
    let clientNonce = null;
    let timer = null;

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", fail);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onData = chunk => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        if (buffered.length > 4096) fail(new Error("Chromium Bridge control handshake is too large"));
        return;
      }
      try {
        if (buffered.slice(newline + 1)) throw new Error("Unexpected control data during authentication");
        const message = JSON.parse(buffered.slice(0, newline));
        if (
          message?.type !== "auth.challenge" ||
          !HEX_256.test(String(message.nonce || "")) ||
          !proofMatches(authProof(token, "server", clientNonce, message.nonce), message.proof)
        ) {
          throw new Error("Chromium Bridge control endpoint failed authentication");
        }
        socket.write(`${JSON.stringify({
          type: "auth.response",
          proof: authProof(token, "client", clientNonce, message.nonce)
        })}\n`);
        succeed();
      } catch (error) {
        fail(error);
      }
    };

    socket.setEncoding("utf8");
    socket.once("error", fail);
    socket.once("connect", async () => {
      if (!endpoint.authenticated) {
        succeed();
        return;
      }
      timer = setTimeout(() => fail(new Error("Timed out authenticating with Chromium Bridge")), timeoutMs);
      try {
        token = await readToken(endpoint.tokenPath);
      } catch (error) {
        fail(error);
        return;
      }
      if (settled) return;
      clientNonce = crypto.randomBytes(32).toString("hex");
      socket.on("data", onData);
      socket.write(`${JSON.stringify({ type: "auth.hello", nonce: clientNonce })}\n`);
    });
  });
}
