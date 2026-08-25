#!/usr/bin/env node
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const socketPath = path.resolve(
  process.env.CHROMIUM_BRIDGE_SOCKET ||
  process.env.ARC_CODEX_SOCKET ||
  path.join(os.homedir(), ".chromium-bridge", "control.sock")
);
const [command, ...args] = process.argv.slice(2);

try {
  await main(command, args);
} catch (error) {
  console.error(friendlyError(error));
  process.exitCode = 1;
}

async function main(name, argv) {
  switch (name) {
    case "status":
      return print(await request("host.status"));
    case "host-info":
      return print(await request("host.info"));
    case "extension-reload":
      return print(await extension("runtime.reload"));
    case "providers":
      return print(await request("providers.list"));
    case "arc-spaces":
      return print(await request("arc.spaces.list"));
    case "arc-focus-space":
      return print(await request("arc.space.focus", { spaceId: required(argv[0], "space id") }));
    case "tabs":
      return print(await extension("tabs.list"));
    case "active":
      return print(await extension("tabs.active"));
    case "navigate":
      return print(await extension("tab.navigate", { url: required(argv[0], "url"), tabId: argv[1] || "active" }));
    case "reload":
      return print(await extension("tab.reload", { tabId: argv[0] || "active" }));
    case "eval":
      return print(await extension("script.execute", scriptArgs(argv, "USER_SCRIPT")));
    case "eval-main":
      return print(await extension("script.execute", scriptArgs(argv, "MAIN")));
    case "cookies":
      return print(await extension("cookies.getAll", cookieArgs(argv)));
    case "capture-start":
      return print(await extension("capture.start", captureArgs(argv)));
    case "capture-stop":
      return print(await extension("capture.stop"));
    case "capture-status":
      return print(await extension("capture.status"));
    case "debug-attach":
      return print(await extension("debugger.attach", { tabId: argv[0] || "active" }));
    case "debug-detach":
      return print(await extension("debugger.detach", { tabId: argv[0] || "active" }));
    case "command":
      return print(await extension(required(argv[0], "extension command"), parseJson(argv[1] || "{}", "command params")));
    case "events":
      return print(await request("events.list", { limit: Number(argv[0] || 100) }));
    case "clear":
      return print(await request("events.clear"));
    case "purge":
      return print(await request("captures.purge"));
    case "curl": {
      const script = await request("curl.render");
      process.stdout.write(script.endsWith("\n") ? script : `${script}\n`);
      return;
    }
    default:
      usage();
  }
}

function extension(commandName, params = {}) {
  return request("extension.command", { command: commandName, params });
}

function scriptArgs(argv, world) {
  const tabId = argv[0] || "active";
  const code = argv.slice(1).join(" ");
  return { tabId, code: required(code, "JavaScript source"), world };
}

function cookieArgs(argv) {
  const positional = [];
  const params = { includeSecrets: false };
  for (const arg of argv) {
    if (arg === "--raw") params.includeSecrets = true;
    else positional.push(arg);
  }
  if (positional[0]) params.url = positional[0];
  if (positional[1]) params.domain = positional[1];
  return params;
}

function captureArgs(argv) {
  const params = { includeSecrets: false, urlPattern: "", allUrls: false, captureRequestBody: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--raw") params.includeSecrets = true;
    else if (arg === "--body") params.captureRequestBody = true;
    else if (arg === "--no-body") params.captureRequestBody = false;
    else if (arg === "--all-urls") params.allUrls = true;
    else if (arg === "--filter") params.urlPattern = required(argv[++index], "capture filter");
    else throw new Error(`Unknown capture argument: ${arg}`);
  }
  return params;
}

function request(method, params = {}, timeoutMs = 30000) {
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffered = "";
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };

    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => finish(new Error(`Timed out waiting for ${method}`)));
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("data", chunk => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffered.slice(0, newline));
        if (response.id !== id) throw new Error("Control response id mismatch");
        if (!response.ok) throw new Error(response.error || "Control request failed");
        finish(null, response.result);
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", error => finish(error));
  });
}

function parseJson(value, label) {
  try {
    const result = JSON.parse(value);
    if (!result || Array.isArray(result) || typeof result !== "object") throw new Error("expected an object");
    return result;
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error.message}`);
  }
}

function required(value, label) {
  if (!String(value || "").trim()) throw new Error(`Missing ${label}`);
  return value;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function friendlyError(error) {
  if (["ENOENT", "ECONNREFUSED"].includes(error?.code)) {
    return `Chromium Bridge is unavailable at ${socketPath}. Start your browser and reload the Chromium Bridge extension.`;
  }
  return String(error?.message || error);
}

function usage() {
  console.log(`Usage:
  chromium-bridge status
  chromium-bridge host-info
  chromium-bridge extension-reload
  chromium-bridge providers
  chromium-bridge arc-spaces
  chromium-bridge arc-focus-space <space-id>
  chromium-bridge tabs
  chromium-bridge active
  chromium-bridge navigate <url> [tabId]
  chromium-bridge reload [tabId]
  chromium-bridge eval <tabId|active> <javascript>
  chromium-bridge eval-main <tabId|active> <javascript>
  chromium-bridge cookies [url] [domain] [--raw]
  chromium-bridge capture-start (--filter <substring> | --all-urls) [--body] [--raw]
  chromium-bridge capture-stop
  chromium-bridge capture-status
  chromium-bridge debug-attach [tabId|active]
  chromium-bridge debug-detach [tabId|active]
  chromium-bridge command <extension-command> [json-params]
  chromium-bridge events [limit]
  chromium-bridge clear
  chromium-bridge purge
  chromium-bridge curl
`);
}
