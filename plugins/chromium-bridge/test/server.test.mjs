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
  const managedRequests = [];
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
        } else if (request.method?.startsWith("managedScripts.")) {
          managedRequests.push({ method: request.method, params: request.params || {} });
          if (request.method === "managedScripts.list") result = [{ id: "youtube-cleanup", enabled: true }];
          else if (request.method === "managedScripts.get") result = { id: request.params.id, js: "document.title;" };
          else if (request.method === "managedScripts.remove") result = { id: request.params.id, removed: true };
          else result = { script: { id: request.params.id, enabled: request.params.enabled ?? true } };
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
  assert.equal(response(1).result.serverInfo.version, "0.6.8");
  assert.ok(response(2).result.tools.some(tool => tool.name === "snapshot"));
  assert.ok(response(2).result.tools.some(tool => tool.name === "browser_flow"));
  assert.ok(response(2).result.tools.some(tool => tool.name === "scroll"));
  assert.ok(response(2).result.tools.some(tool => tool.name === "screenshot"));
  assert.ok(response(2).result.tools.some(tool => tool.name === "close_agent_tabs"));
  assert.ok(response(2).result.tools.some(tool => tool.name === "reload_extension"));
  assert.ok(response(2).result.tools.some(tool => tool.name === "arc_list_spaces"));
  assert.ok(response(2).result.tools.some(tool => tool.name === "purge_captures"));
  for (const name of ["managed_script_list", "managed_script_get", "managed_script_upsert", "managed_script_enable", "managed_script_remove"]) {
    assert.ok(response(2).result.tools.some(tool => tool.name === name));
  }
  for (const name of ["click", "fill", "select", "browser_flow"]) {
    const browserAction = response(2).result.tools.find(tool => tool.name === name);
    assert.equal(browserAction.annotations.destructiveHint, false);
  }
  const closeTab = response(2).result.tools.find(tool => tool.name === "close_tab");
  assert.equal(closeTab.annotations.destructiveHint, true);
  for (const name of ["managed_script_list", "managed_script_get"]) {
    const managedRead = response(2).result.tools.find(tool => tool.name === name);
    assert.equal(managedRead.annotations.readOnlyHint, true);
    assert.equal(managedRead.annotations.destructiveHint, false);
  }
  for (const name of ["managed_script_upsert", "managed_script_enable"]) {
    const managedWrite = response(2).result.tools.find(tool => tool.name === name);
    assert.equal(managedWrite.annotations.readOnlyHint, false);
    assert.equal(managedWrite.annotations.destructiveHint, false);
    assert.equal(managedWrite.annotations.idempotentHint, true);
  }
  const managedRemove = response(2).result.tools.find(tool => tool.name === "managed_script_remove");
  assert.equal(managedRemove.annotations.destructiveHint, true);
  assert.equal(managedRemove.annotations.idempotentHint, true);
  const managedUpsert = response(2).result.tools.find(tool => tool.name === "managed_script_upsert");
  assert.deepEqual(managedUpsert.inputSchema.properties.world.enum, ["USER_SCRIPT", "MAIN"]);
  assert.deepEqual(managedUpsert.inputSchema.properties.runAt.enum, ["document_start", "document_end", "document_idle"]);
  assert.equal(managedUpsert.inputSchema.properties.js.maxLength, 262144);
  assert.deepEqual(managedUpsert.inputSchema.required, ["id", "name", "matches", "js", "enabled", "runAt", "world"]);
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

  writeToolCall(child, 15, "browser_flow", {
    tabId: 42,
    actions: [
      { action: "snapshot" },
      { action: "scroll", deltaY: 700 },
      { action: "fill", ref: "e1", value: "query" },
      { action: "click", ref: "e1" }
    ]
  });
  await waitUntil(() => responses.length === 15);
  const flow = JSON.parse(response(15).result.content[0].text);
  assert.equal(flow.completed, true);
  assert.equal(flow.tabId, 42);
  assert.deepEqual(flow.steps.map(step => step.action), ["snapshot", "scroll", "fill", "click"]);

  writeToolCall(child, 16, "managed_script_list", {});
  writeToolCall(child, 17, "managed_script_get", { id: "youtube-cleanup" });
  writeToolCall(child, 18, "managed_script_upsert", {
    id: "youtube-cleanup",
    name: "YouTube cleanup",
    matches: ["https://www.youtube.com/*"],
    js: "document.title;",
    enabled: true,
    runAt: "document_idle",
    world: "USER_SCRIPT"
  });
  writeToolCall(child, 19, "managed_script_enable", { id: "youtube-cleanup", enabled: false });
  writeToolCall(child, 20, "managed_script_remove", { id: "youtube-cleanup" });
  await waitUntil(() => responses.length === 20);
  assert.match(response(16).result.content[0].text, /youtube-cleanup/);
  assert.match(response(17).result.content[0].text, /document\.title/);
  assert.equal(response(18).result.isError, undefined);
  assert.equal(response(19).result.isError, undefined);
  assert.equal(response(20).result.isError, undefined);
  assert.deepEqual(managedRequests.map(item => item.method), [
    "managedScripts.list",
    "managedScripts.get",
    "managedScripts.upsert",
    "managedScripts.enable",
    "managedScripts.remove"
  ]);
  assert.deepEqual(managedRequests[3].params, { id: "youtube-cleanup", enabled: false });
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
