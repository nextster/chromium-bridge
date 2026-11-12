import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import vm from "node:vm";

const background = await readFile(new URL("../../extension/background.js", import.meta.url), "utf8");
const executeSource = background.slice(background.indexOf("async function executeUserScript("), background.indexOf("async function userScriptsAvailable("));

// Run the production extension function, including target construction and result transport.
function extensionExecutor(execute) {
  const context = vm.createContext({
    chrome: { userScripts: { execute } },
    userScriptsAvailable: async () => true,
    getTabId: async id => id,
    requiredBoundedString: value => value,
    MAX_SCRIPT_CHARS: 512 * 1024,
    userScriptsReady: true
  });
  return vm.runInContext(`${executeSource}; executeUserScript`, context);
}

test("extension retains per-frame results, validates targets, and preserves raw evaluate results", async () => {
  const calls = [];
  const results = [
    { frameId: 5, documentId: "child", result: { ok: true } },
    { frameId: 8, documentId: "denied", error: "Cannot access contents of url" }
  ];
  const execute = extensionExecutor(async args => { calls.push(args); return results; });
  assert.equal(await execute({ tabId: 42, code: "true", allFrames: true, frameResults: true }), results);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].target)), { tabId: 42, allFrames: true });
  await execute({ tabId: 42, code: "true", frameIds: [5], frameResults: true });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].target)), { tabId: 42, frameIds: [5] });
  assert.deepEqual(JSON.parse(JSON.stringify(await execute({ tabId: 42, code: "true" }))), [
    { ok: true }, { error: "Cannot access contents of url", frameId: 8 }
  ]);
  for (const frameIds of [[], [-1], ["5"]]) await assert.rejects(execute({ tabId: 42, code: "true", frameIds }), /Invalid script frameIds/);
  await assert.rejects(execute({ tabId: 42, code: "true", frameIds: [5], allFrames: true }), /conflicting allFrames/);
  await execute({ tabId: 42, code: "true", documentIds: ["child"], frameResults: true });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).target)), { tabId: 42, documentIds: ["child"] });
  for (const documentIds of [[], [5], [""]]) await assert.rejects(execute({ tabId: 42, code: "true", documentIds }), /Invalid script documentIds/);
  await assert.rejects(execute({ tabId: 42, code: "true", documentIds: ["child"], frameIds: [5] }), /conflicting frame target/);
  await assert.rejects(execute({ tabId: 42, code: "true", documentIds: ["child"], allFrames: true }), /conflicting frame target/);
});

test("MCP snapshot → fill → click reaches a nested cross-origin form without reusing stale refs", {
  skip: process.platform === "win32" && "uses a Unix control socket"
}, async t => {
  const origins = await localOrigins(t);
  const frames = await loadFrames(`${origins.main}/`);
  assert.equal(frames.length, 3);
  assert.equal(new URL(frames[2].url).origin, origins.form);
  assert.notEqual(origins.main, origins.form);
  const otherTabFrames = await loadFrames(`${origins.main}/`);
  const calls = [];
  let denied = false;
  let omitDenied = false;
  let frameError = false;
  const execute = extensionExecutor(async ({ target, world, js }) => {
    assert.equal(world, "USER_SCRIPT");
    assert.ok([42, 43].includes(target.tabId));
    calls.push(JSON.parse(JSON.stringify(target)));
    const tabFrames = target.tabId === 42 ? frames : otherTabFrames;
    const selected = target.allFrames ? tabFrames : tabFrames.filter(frame => target.documentIds
      ? target.documentIds.includes(frame.documentId) : (target.frameIds || [0]).includes(frame.id));
    const results = [];
    for (const frame of selected) {
      if (frame.removed) continue;
      if (frame.id === 2 && denied) {
        if (omitDenied && target.allFrames) continue;
        throw new Error("Cannot access contents of url; host permission required");
      }
      if (frame.id === 2 && frameError) {
        results.push({ frameId: frame.id, documentId: frame.documentId, error: "Frame was removed" });
        continue;
      }
      try {
        results.push({ frameId: frame.id, documentId: frame.documentId, result: await vm.runInContext(js[0].code, frame.context) });
      } catch (error) {
        results.push({ frameId: frame.id, documentId: frame.documentId, error: error.message });
      }
    }
    return results;
  });
  const { tool, output } = await mcpFixture(t, execute);
  const snapshot = await tool("snapshot", { tabId: 42 });
  assert.match(snapshot.content[0].text, /Fictional name/);
  assert.match(snapshot.content[0].text, /"frameId":2,"documentId":"document-2"/);
  assert.ok(calls[0].allFrames);
  assert.doesNotMatch(snapshot.content[0].text, /warning: Snapshot is partial/);
  const nameRef = refFor(snapshot, "Fictional name");
  const submitRef = refFor(snapshot, "Save fiction");
  const noteRef = refFor(snapshot, "Fictional note");
  const choiceRef = refFor(snapshot, "Fictional choice");
  assert.notEqual(nameRef, refFor(snapshot, "Decoy name"));
  const fiction = "Mira Example 987";
  assert.equal((await tool("fill", { tabId: 42, ref: nameRef, value: fiction })).isError, undefined);
  assert.equal(frames[2].elements[0].value, fiction);
  assert.equal(frames[0].elements[0].value, "");
  assert.deepEqual(frames[2].elements[0].events, ["input", "change"]);
  await tool("fill", { tabId: 42, ref: noteRef, value: "invented note 654" });
  assert.equal(frames[2].elements[2].textContent, "invented note 654");
  await tool("select", { tabId: 42, ref: choiceRef, value: "imaginary" });
  assert.equal(frames[2].elements[1].value, "imaginary");
  const wrongSelect = await tool("select", { tabId: 42, ref: nameRef, value: "imaginary" });
  assert.match(wrongSelect.content[0].text, /Element is not a select/);
  frames[2].elements[0].failInput = true;
  const failedFill = await tool("fill", { tabId: 42, ref: nameRef, value: fiction, snapshotAfter: true });
  assert.match(failedFill.content[0].text, /Element action failed/);
  frames[2].elements[0].failInput = false;
  await tool("scroll", { tabId: 42, ref: nameRef, deltaY: 22 });
  assert.equal(frames[2].context.scrollY, 22);
  assert.equal(frames[0].context.scrollY, 0);
  assert.equal((await tool("wait_for", { tabId: 42, ref: nameRef, timeoutMs: 100 })).isError, undefined);
  const flow = await tool("browser_flow", { tabId: 42, actions: [
    { action: "fill", ref: nameRef, value: fiction },
    { action: "click", ref: submitRef, snapshotAfter: true, settleMs: 0 }
  ] });
  assert.equal(JSON.parse(flow.content[0].text).completed, true);
  assert.equal(frames[2].elements[3].clicks, 1);
  assert.equal(frames[0].elements[1].clicks, 0);
  assert.ok(calls.slice(1).some(call => call.documentIds?.[0] === "document-2"));
  assert.doesNotMatch(output(), /Mira Example 987|invented note 654|imaginary/);

  // A fresh snapshot never makes an older ref point at the newly numbered node.
  assertStale(await tool("click", { tabId: 42, ref: submitRef }));
  const current = await tool("snapshot", { tabId: 42 });
  const currentRef = refFor(current, "Fictional name");
  assert.equal((await tool("snapshot", { tabId: 43 })).isError, undefined);
  assertStale(await tool("fill", { tabId: 43, ref: currentRef, value: fiction }));
  const oldNode = frames[2].elements[0];
  oldNode.isConnected = false;
  frames[2].elements[0] = new Input("INPUT", oldNode.attributes, frames[2].document);
  for (const action of ["fill", "click", "scroll", "wait_for"]) {
    assertStale(await tool(action, { tabId: 42, ref: currentRef, value: fiction, timeoutMs: 100 }));
  }
  assert.equal(frames[2].elements[0].value, "");
  assertStale(await tool("wait_for", { tabId: 42, ref: currentRef, state: "hidden", timeoutMs: 100 }));
  const oldSelect = frames[2].elements[1];
  oldSelect.isConnected = false;
  frames[2].elements[1] = new Select("SELECT", oldSelect.attributes, frames[2].document);
  assertStale(await tool("select", { tabId: 42, ref: refFor(current, "Fictional choice"), value: "imaginary" }));
  assert.equal(frames[2].elements[1].value, "");

  const beforeNavigation = refFor(await tool("snapshot", { tabId: 42 }), "Save fiction");
  const replacement = makeFrame(frames[2].html, frames[2].url, 2);
  replacement.documentId = "document-after-navigation";
  frames[2] = replacement;
  assertStale(await tool("click", { tabId: 42, ref: beforeNavigation }));
  assert.equal(replacement.elements[3].clicks, 0);
  const longValue = "FictionalLongValue".repeat(300);
  const multilineValue = "Fictional first line\nFictional second line";
  let fresh = await tool("snapshot", { tabId: 42 });
  for (const value of [longValue, multilineValue]) {
    const filled = await tool("fill", { tabId: 42, ref: refFor(fresh, "Fictional name"), value, snapshotAfter: true, settleMs: 0, maxTextChars: 20 });
    assert.equal(filled.isError, undefined);
    assert.doesNotMatch(filled.content[0].text, /FictionalLongValue|Fictional first line|Fictional second line/);
    fresh = await tool("snapshot", { tabId: 42 });
  }
  const beforeRemoval = refFor(await tool("snapshot", { tabId: 42 }), "Save fiction");
  replacement.removed = true;
  assertStale(await tool("click", { tabId: 42, ref: beforeRemoval }));
  replacement.removed = false;
  const beforeDenial = refFor(await tool("snapshot", { tabId: 42 }), "Save fiction");
  denied = true;
  assertStale(await tool("click", { tabId: 42, ref: beforeDenial }));
  omitDenied = true;
  const partial = await tool("snapshot", { tabId: 42 });
  assert.match(partial.content[0].text, /warning: Snapshot is partial/);
  assert.match(partial.content[0].text, /embeddedFrame:.*\/form/);
  assert.doesNotMatch(partial.content[0].text, /Fictional name/);
  denied = false;
  frameError = true;
  assert.match((await tool("snapshot", { tabId: 42 })).content[0].text, /Frame unavailable; check website permissions/);
  assert.doesNotMatch(output(), /Mira Example 987|invented note 654|imaginary/);
});

function refFor(result, name) {
  const line = result.content[0].text.split("\n").find(line => line.includes(`name=${JSON.stringify(name)}`));
  assert.ok(line, `Missing element ${name}`);
  return line.trim().split(" ")[0];
}
function assertStale(result) {
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /stale|inaccessible/i);
  assert.match(result.content[0].text, /new snapshot/);
}
async function localOrigins(t) {
  let formOrigin;
  const servers = [];
  async function start(routes) {
    const server = http.createServer(async (request, response) => {
      const file = routes[request.url];
      if (!file) { response.writeHead(404).end(); return; }
      const html = await readFile(new URL(`./fixtures/iframe/${file}.html`, import.meta.url), "utf8");
      response.setHeader("content-type", "text/html");
      response.end(html.replaceAll("FORM_ORIGIN", formOrigin));
    });
    servers.push(server);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  t.after(() => { for (const server of servers) { server.closeAllConnections(); server.close(); } });
  formOrigin = await start({ "/form": "form" });
  return { main: await start({ "/": "main", "/wrapper": "wrapper" }), form: formOrigin };
}
async function loadFrames(url, frames = []) {
  const html = await (await fetch(url)).text();
  const frame = makeFrame(html, url, frames.length);
  frames.push(frame);
  for (const embed of frame.embeds) await loadFrames(embed.src, frames);
  return frames;
}

// Deliberately small DOM adapter for the local fixture. Chrome and DOM are mocked;
// the actual snapshot/action scripts and host ↔ extension transport run unchanged.
class Element {
  constructor(tag, attributes, document) {
    this.tagName = tag; this.attributes = attributes; this.ownerDocument = document;
    this.isConnected = true; this.events = []; this.clicks = 0;
    this.innerText = attributes.text || ""; this.textContent = this.innerText;
    this.isContentEditable = attributes.contenteditable === "true";
    this.type = attributes.type || (tag === "INPUT" ? "text" : "");
  }
  getAttribute(name) { return this.attributes[name] || null; }
  getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 30 }; }
  scrollIntoView() {}
  focus() {}
  dispatchEvent(event) {
    if (this.failInput) throw new Error(`Page handler echoed ${this.value}`);
    this.events.push(event.type);
    this.ownerDocument.body.innerText = this.value || this.textContent;
  }
  click() { this.clicks += 1; }
}
class Input extends Element {
  get value() { return this.currentValue || ""; }
  set value(value) { this.currentValue = value; }
}
class Select extends Input {}
class Textarea extends Input {}
function makeFrame(html, url, id) {
  const document = { title: /<title>(.*?)<\/title>/.exec(html)?.[1], readyState: "complete", body: { innerText: "Fixture" }, documentElement: {} };
  const elements = [];
  for (const match of html.matchAll(/<(input|button|select|div)\b([^>]*)>([^<]*)/g)) {
    const attributes = Object.fromEntries(Array.from(match[2].matchAll(/([\w-]+)="([^"]*)"/g), item => [item[1], item[2]]));
    attributes.text = match[3];
    const tag = match[1].toUpperCase();
    const Type = tag === "INPUT" ? Input : tag === "SELECT" ? Select : Element;
    elements.push(new Type(tag, attributes, document));
  }
  const embeds = Array.from(html.matchAll(/<iframe src="([^"]+)"/g), item => ({ src: new URL(item[1], url).href }));
  document.querySelectorAll = selector => selector === "iframe,frame" ? embeds : selector.startsWith("h1,") ? [] : elements;
  const context = vm.createContext({
    document, location: { href: url }, innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    HTMLInputElement: Input, HTMLSelectElement: Select, HTMLTextAreaElement: Textarea,
    Event: class { constructor(type) { this.type = type; } },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout, setInterval, clearInterval,
    scrollX: 0, scrollY: 0
  });
  context.window = context;
  context.scrollBy = ({ left, top }) => { context.scrollX += left; context.scrollY += top; };
  return { id, url, html, documentId: `document-${id}`, document, context, elements, embeds };
}
async function mcpFixture(t, execute) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "bridge-iframe-"));
  const socketPath = path.join(temp, "control.sock");
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    createInterface({ input: socket }).on("line", async line => {
      const request = JSON.parse(line);
      try {
        assert.equal(request.params.command, "script.execute");
        const result = await execute(request.params.params);
        socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
      } catch (error) {
        socket.write(`${JSON.stringify({ id: request.id, ok: false, error: error.message })}\n`);
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const child = spawn(process.execPath, [new URL("../src/mcp-server.mjs", import.meta.url).pathname], {
    env: { ...process.env, CHROMIUM_BRIDGE_SOCKET: socketPath }, stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(async () => {
    child.kill();
    for (const socket of sockets) socket.destroy();
    server.close();
    await rm(temp, { recursive: true, force: true });
  });
  let allOutput = "";
  child.stderr.on("data", data => { allOutput += data; });
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", line => {
    allOutput += line;
    const response = JSON.parse(line);
    pending.get(response.id)?.(response.result);
    pending.delete(response.id);
  });
  let sequence = 0;
  return {
    output: () => allOutput,
    tool: (name, args) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => reject(new Error(`MCP timeout: ${name}`)), 5000);
      pending.set(id, result => { clearTimeout(timer); resolve(result); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
    })
  };
}
