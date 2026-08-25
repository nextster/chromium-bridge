import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(pluginDir, "mcp", "server.mjs");

test("MCP server exposes Chromium and provider tools over the control socket", async t => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-mcp-"));
  const socketPath = path.join(tempDir, "control.sock");
  let connections = 0;
  let nextTabId = 90;
  const extensionCommands = [];
  const controlServer = net.createServer(socket => {
    connections += 1;
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("data", chunk => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        let result = null;
        if (request.method === "host.status") {
          result = { host: { pid: 1234 }, extension: { pong: true } };
        } else if (request.method === "providers.list") {
          result = [{ id: "arc", available: true, capabilities: ["spaces.list", "space.focus"] }];
        } else if (request.method === "arc.spaces.list") {
          result = { running: true, windows: [{ id: 1, spaces: [{ id: "space-1", title: "Work", tabs: [] }] }] };
        } else if (request.method === "arc.space.focus") {
          result = { focused: true, spaceId: request.params.spaceId };
        } else if (request.params?.command === "tabs.active") {
          result = {
            id: 42,
            windowId: 7,
            index: 2,
            active: true,
            title: "Fast page",
            url: "https://example.test/",
            status: "complete",
            favIconUrl: "https://example.test/favicon.ico"
          };
        } else if (request.params?.command === "script.execute") {
          result = [{
            title: "Fast page",
            url: "https://example.test/",
            readyState: "complete",
            viewport: { width: 1200, height: 800, devicePixelRatio: 2 },
            text: "Ready",
            headings: [{ level: 1, text: "Fast page" }],
            elements: [{
              ref: "e1",
              selector: "#go",
              tag: "button",
              role: "button",
              type: "button",
              name: "Go",
              value: ""
            }]
          }];
        } else if (request.params?.command === "tabs.create") {
          extensionCommands.push({
            command: request.params.command,
            params: request.params.params
          });
          result = {
            id: ++nextTabId,
            windowId: 7,
            index: nextTabId,
            active: request.params.params.active,
            title: "",
            url: request.params.params.url || "about:blank",
            status: "complete"
          };
        } else if (request.params?.command === "tab.close") {
          extensionCommands.push({
            command: request.params.command,
            params: request.params.params
          });
          result = { closed: true, tabId: request.params.params.tabId };
        }
        socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    controlServer.once("error", reject);
    controlServer.listen(socketPath, resolve);
  });

  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, CHROMIUM_BRIDGE_SOCKET: socketPath },
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(async () => {
    child.kill();
    controlServer.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const responses = [];
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    output += chunk;
    let newline;
    while ((newline = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });

  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }
  })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "status", arguments: {} }
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "active_tab", arguments: {} }
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "snapshot", arguments: { tabId: 42 } }
  })}\n`);

  await waitUntil(() => responses.length === 5);
  const response = id => responses.find(item => item.id === id);
  assert.equal(response(1).result.serverInfo.name, "chromium-bridge");
  assert.ok(response(2).result.tools.some(tool => tool.name === "snapshot"));
  assert.ok(response(2).result.tools.some(tool => tool.name === "screenshot"));
  assert.ok(response(2).result.tools.some(tool => tool.name === "close_agent_tabs"));
  assert.ok(response(2).result.tools.some(tool => tool.name === "reload_extension"));
  assert.ok(response(2).result.tools.some(tool => tool.name === "arc_list_spaces"));
  assert.ok(response(2).result.tools.some(tool => tool.name === "purge_captures"));
  assert.match(response(3).result.content[0].text, /"pong":true/);
  assert.doesNotMatch(response(4).result.content[0].text, /favIconUrl/);
  assert.match(response(5).result.content[0].text, /e1 role=button tag=button name="Go"/);
  assert.doesNotMatch(response(5).result.content[0].text, /rect=/);
  assert.equal(connections, 1);

  writeToolCall(child, 6, "new_tab", { url: "https://background.test/" });
  await waitUntil(() => responses.length === 6);
  const created = JSON.parse(response(6).result.content[0].text);
  assert.equal(created.active, false);
  assert.equal(created.owned, true);
  assert.deepEqual(extensionCommands.at(-1), {
    command: "tabs.create",
    params: { url: "https://background.test/", active: false }
  });

  writeToolCall(child, 7, "close_tab", { tabId: 42 });
  await waitUntil(() => responses.length === 7);
  assert.equal(response(7).result.isError, true);
  assert.match(response(7).result.content[0].text, /did not open it/);

  writeToolCall(child, 8, "close_tab", { tabId: created.id });
  await waitUntil(() => responses.length === 8);
  assert.equal(response(8).result.isError, undefined);
  assert.deepEqual(extensionCommands.at(-1), {
    command: "tab.close",
    params: { tabId: created.id }
  });

  writeToolCall(child, 9, "new_tab", { url: "https://cleanup.test/" });
  await waitUntil(() => responses.length === 9);
  const cleanupTab = JSON.parse(response(9).result.content[0].text);
  writeToolCall(child, 10, "close_agent_tabs", {});
  await waitUntil(() => responses.length === 10);
  assert.deepEqual(JSON.parse(response(10).result.content[0].text), {
    closed: [cleanupTab.id],
    failed: []
  });

  writeToolCall(child, 11, "close_tab", { tabId: 42, force: true });
  await waitUntil(() => responses.length === 11);
  assert.equal(response(11).result.isError, undefined);
  assert.deepEqual(extensionCommands.at(-1), {
    command: "tab.close",
    params: { tabId: 42 }
  });

  writeToolCall(child, 12, "providers", {});
  writeToolCall(child, 13, "arc_list_spaces", {});
  writeToolCall(child, 14, "arc_focus_space", { spaceId: "space-1" });
  await waitUntil(() => responses.length === 14);
  assert.match(response(12).result.content[0].text, /"id":"arc"/);
  assert.match(response(13).result.content[0].text, /"title":"Work"/);
  assert.deepEqual(JSON.parse(response(14).result.content[0].text), {
    focused: true,
    spaceId: "space-1"
  });
});

function writeToolCall(child, id, name, args) {
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args }
  })}\n`);
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for MCP response");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
