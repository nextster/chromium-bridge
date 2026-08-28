import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SERVER_NAME = "chromium-bridge";
const SERVER_VERSION = "0.5.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const socketPath = path.resolve(
  process.env.CHROMIUM_BRIDGE_SOCKET ||
  process.env.ARC_CODEX_SOCKET ||
  path.join(os.homedir(), ".chromium-bridge", "control.sock")
);
const refMaps = new Map();
const ownedTabIds = new Set();
let controlClient;

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};
const browserMutation = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
};
const consequential = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
};

const tools = [
  tool("status", "Troubleshoot Chromium Bridge availability and capture state. Routine page work should start with snapshot instead.", {}, readOnly),
  tool("reload_extension", "Reload Chromium Bridge after its local files are updated. The bridge disconnects briefly while the browser restarts the extension.", {}, browserMutation),
  tool("providers", "List optional browser-specific providers and their capabilities.", {}, readOnly),
  tool("arc_list_spaces", "List Arc windows, Spaces, and their tabs without changing focus.", {}, readOnly),
  tool("arc_focus_space", "Focus an Arc Space. This changes the user's visible browser context, so use it only when explicitly requested.", {
    spaceId: stringProperty("Arc Space id returned by arc_list_spaces.")
  }, consequential, ["spaceId"]),
  tool("list_tabs", "List tabs in the connected Chromium browser.", {}, readOnly),
  tool("active_tab", "Return compact metadata for the active browser tab. Skip this when snapshot is needed because snapshot already includes it.", {}, readOnly),
  tool("new_tab", "Open an agent-owned browser tab in the background by default. Set active=true only when the user explicitly asked to see it.", {
    url: stringProperty("URL to open. Omit for a blank tab."),
    active: booleanProperty("Whether the new tab becomes active. Defaults to false.")
  }, browserMutation),
  tool("close_tab", "Close a tab opened by this MCP session. Existing user tabs require force=true and an explicit user request.", {
    tabId: tabProperty(),
    force: booleanProperty("Allow closing a tab not opened by this MCP session. Use only when the user explicitly requested that exact tab be closed.")
  }, consequential, ["tabId"]),
  tool("close_agent_tabs", "Close all tabs opened by this MCP session. Use at task end to remove agent-created tabs that are no longer needed; user-existing tabs are never touched.", {}, consequential),
  tool("navigate", "Navigate a browser tab to a URL.", {
    url: stringProperty("Destination URL."),
    tabId: tabProperty()
  }, browserMutation, ["url"]),
  tool("back", "Navigate a browser tab backward in history.", {
    tabId: tabProperty()
  }, browserMutation),
  tool("forward", "Navigate a browser tab forward in history.", {
    tabId: tabProperty()
  }, browserMutation),
  tool("reload", "Reload a browser tab.", {
    tabId: tabProperty()
  }, browserMutation),
  tool("snapshot", "Primary fast page inspection. Includes active-tab metadata, text, headings, and temporary refs such as e1; no status or active_tab call is needed first.", {
    tabId: tabProperty(),
    maxElements: integerProperty("Maximum interactive elements to return.", 1, 500),
    maxTextChars: integerProperty("Maximum visible-text characters to return.", 0, 20000),
    includeRects: booleanProperty("Include element coordinates. Defaults to false to keep responses small.")
  }, readOnly),
  tool("click", "Click an element ref from the latest snapshot. Inspect the target before clicks that can submit or trigger an external action.", {
    ref: stringProperty("Element ref from snapshot, for example e3."),
    tabId: tabProperty(),
    ...postActionProperties()
  }, browserMutation, ["ref"]),
  tool("fill", "Set an input, textarea, select, or contenteditable value and dispatch input/change events.", {
    ref: stringProperty("Element ref from snapshot."),
    value: stringProperty("Value to enter."),
    tabId: tabProperty(),
    ...postActionProperties()
  }, browserMutation, ["ref", "value"]),
  tool("select", "Select an option by value in a select element.", {
    ref: stringProperty("Element ref from snapshot."),
    value: stringProperty("Option value."),
    tabId: tabProperty(),
    ...postActionProperties()
  }, browserMutation, ["ref", "value"]),
  tool("evaluate", "Execute user-supplied JavaScript in the page. This is powerful and may mutate the page or trigger network actions.", {
    code: stringProperty("JavaScript expression or program."),
    tabId: tabProperty(),
    world: {
      type: "string",
      enum: ["USER_SCRIPT", "MAIN"],
      description: "Execution world. Defaults to USER_SCRIPT."
    }
  }, consequential, ["code"]),
  tool("wait_for", "Wait until text or a CSS selector is visible or hidden.", {
    text: stringProperty("Text to find in visible page text."),
    selector: stringProperty("CSS selector to inspect."),
    ref: stringProperty("Element ref from the latest snapshot."),
    state: {
      type: "string",
      enum: ["visible", "hidden"],
      description: "Target state. Defaults to visible."
    },
    timeoutMs: integerProperty("Timeout in milliseconds.", 100, 30000),
    tabId: tabProperty(),
    snapshotAfter: booleanProperty("Return a fresh compact snapshot with the match, avoiding another tool call."),
    maxElements: integerProperty("Maximum elements in the returned snapshot.", 1, 500),
    maxTextChars: integerProperty("Maximum text characters in the returned snapshot.", 0, 20000)
  }, readOnly),
  tool("screenshot", "Capture the currently visible viewport of the active browser tab.", {
    tabId: tabProperty(),
    format: {
      type: "string",
      enum: ["png", "jpeg"],
      description: "Image format. Defaults to jpeg for speed; request png only for pixel-exact inspection."
    },
    quality: integerProperty("JPEG quality. Defaults to 70.", 0, 100),
    maxWidth: integerProperty("Downscale images wider than this many physical pixels. Defaults to 1600.", 320, 4000)
  }, readOnly),
  tool("cookies", "Read matching cookies. Values are redacted unless includeSecrets is explicitly true.", {
    url: stringProperty("Filter by URL."),
    domain: stringProperty("Filter by cookie domain."),
    name: stringProperty("Filter by cookie name."),
    includeSecrets: booleanProperty("Return raw cookie values. This exposes session credentials.")
  }, {
    readOnlyHint: true,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true
  }),
  tool("capture_start", "Start filtered network capture. Secret headers and sensitive body fields are redacted unless includeSecrets is explicitly true.", {
    urlPattern: stringProperty("URL substring filter."),
    allUrls: booleanProperty("Capture every URL. Use only when the user explicitly requested unfiltered capture."),
    captureRequestBody: booleanProperty("Capture request bodies."),
    includeSecrets: booleanProperty("Capture raw cookies, authorization headers, and bodies. This stores credentials locally.")
  }, consequential),
  tool("capture_stop", "Stop network capture and detach all debugger sessions owned by the bridge.", {}, browserMutation),
  tool("capture_status", "Return current network-capture state.", {}, readOnly),
  tool("events", "List recently captured bridge and network events.", {
    limit: integerProperty("Maximum events to return.", 1, 1000)
  }, readOnly),
  tool("render_curl", "Render captured requests as a Bash script containing curl commands. Redacted secrets become environment variables.", {}, readOnly),
  tool("purge_captures", "Delete all locally stored capture sessions and clear the active capture log.", {}, consequential)
];

let inputBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  inputBuffer += chunk;
  if (Buffer.byteLength(inputBuffer, "utf8") > 8 * 1024 * 1024) {
    writeError(null, -32600, "MCP input buffer exceeded 8 MiB");
    process.exit(1);
  }
  let newline;
  while ((newline = inputBuffer.indexOf("\n")) >= 0) {
    const line = inputBuffer.slice(0, newline);
    inputBuffer = inputBuffer.slice(newline + 1);
    if (line.trim()) void handleLine(line);
  }
});
process.stdin.on("end", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeError(null, -32700, "Invalid JSON");
    return;
  }

  const id = message.id;
  try {
    switch (message.method) {
      case "initialize":
        writeResult(id, {
          protocolVersion: message.params?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: "Use Chromium Bridge for webpage interaction. Open new tabs in the background unless the user explicitly asks to see them, reuse explicit tabIds, and close agent-created tabs when done. Start routine work with snapshot; skip status and active_tab unless diagnosing or requesting metadata only."
        });
        return;
      case "notifications/initialized":
      case "notifications/cancelled":
        return;
      case "ping":
        writeResult(id, {});
        return;
      case "tools/list":
        writeResult(id, { tools });
        return;
      case "tools/call": {
        const result = await callTool(message.params?.name, message.params?.arguments || {});
        writeResult(id, result);
        return;
      }
      default:
        if (id != null) writeError(id, -32601, `Unknown method: ${message.method || "<missing>"}`);
    }
  } catch (error) {
    if (message.method === "tools/call") {
      writeResult(id, {
        content: [{ type: "text", text: friendlyError(error) }],
        isError: true
      });
    } else {
      writeError(id, -32603, friendlyError(error));
    }
  }
}

async function callTool(name, args) {
  switch (name) {
    case "status":
      return textResult(await request("host.status"));
    case "reload_extension":
      return textResult(await extension("runtime.reload"));
    case "providers":
      return textResult(await request("providers.list"));
    case "arc_list_spaces":
      return textResult(await request("arc.spaces.list"));
    case "arc_focus_space":
      return textResult(await request("arc.space.focus", {
        spaceId: requiredString(args.spaceId, "spaceId")
      }));
    case "list_tabs":
      return textResult((await extension("tabs.list")).map(tabSummary));
    case "active_tab":
      return textResult(tabSummary(await extension("tabs.active")));
    case "new_tab": {
      const tab = await extension("tabs.create", {
        ...(args.url ? { url: requiredString(args.url, "url") } : {}),
        active: args.active === true
      });
      if (Number.isInteger(tab?.id)) ownedTabIds.add(tab.id);
      return textResult({ ...tabSummary(tab), owned: true });
    }
    case "close_tab": {
      const tabId = await resolveTabId(args.tabId);
      if (!ownedTabIds.has(tabId) && args.force !== true) {
        throw new Error(
          `Refusing to close tab ${tabId} because this MCP session did not open it. ` +
          "Pass force=true only when the user explicitly asked to close that exact tab."
        );
      }
      refMaps.delete(tabId);
      const result = await extension("tab.close", { tabId });
      ownedTabIds.delete(tabId);
      return textResult(result);
    }
    case "close_agent_tabs":
      return textResult(await closeAgentTabs());
    case "navigate": {
      const tabId = await resolveTabId(args.tabId);
      refMaps.delete(tabId);
      const tab = await extension("tab.navigate", {
        tabId,
        url: requiredString(args.url, "url")
      });
      return textResult(tabSummary(tab));
    }
    case "back":
    case "forward":
    case "reload": {
      const tabId = await resolveTabId(args.tabId);
      refMaps.delete(tabId);
      return textResult(await extension(`tab.${name}`, { tabId }));
    }
    case "snapshot":
      return snapshotResult(await pageSnapshot(args));
    case "click":
      return interactionResult(await clickElement(args));
    case "fill":
      return interactionResult(await fillElement(args));
    case "select":
      return interactionResult(await selectElement(args));
    case "evaluate": {
      const tabId = await resolveTabId(args.tabId);
      return textResult(await executeScript(
        tabId,
        requiredString(args.code, "code"),
        args.world === "MAIN" ? "MAIN" : "USER_SCRIPT"
      ));
    }
    case "wait_for": {
      const result = await waitFor(args);
      return result.snapshot
        ? snapshotResult(result.snapshot, { wait: result.wait })
        : textResult(result.wait);
    }
    case "screenshot":
      return screenshotResult(await extension("tab.screenshot", {
        tabId: await resolveTabId(args.tabId),
        format: args.format === "png" ? "png" : "jpeg",
        quality: boundedInteger(args.quality, 70, 0, 100),
        maxWidth: boundedInteger(args.maxWidth, 1600, 320, 4000)
      }));
    case "cookies":
      return textResult(await extension("cookies.getAll", {
        ...(args.url ? { url: String(args.url) } : {}),
        ...(args.domain ? { domain: String(args.domain) } : {}),
        ...(args.name ? { name: String(args.name) } : {}),
        includeSecrets: args.includeSecrets === true
      }));
    case "capture_start":
      return textResult(await extension("capture.start", {
        urlPattern: String(args.urlPattern || ""),
        allUrls: args.allUrls === true,
        captureRequestBody: args.captureRequestBody === true,
        includeSecrets: args.includeSecrets === true
      }));
    case "capture_stop":
      return textResult(await extension("capture.stop"));
    case "capture_status":
      return textResult(await extension("capture.status"));
    case "events":
      return textResult(await request("events.list", {
        limit: boundedInteger(args.limit, 100, 1, 1000)
      }));
    case "render_curl":
      return textResult(await request("curl.render"));
    case "purge_captures":
      return textResult(await request("captures.purge"));
    default:
      throw new Error(`Unknown tool: ${name || "<missing>"}`);
  }
}

async function pageSnapshot(args) {
  const tabId = await resolveTabId(args.tabId);
  const maxElements = boundedInteger(args.maxElements, 60, 1, 500);
  const maxTextChars = boundedInteger(args.maxTextChars, 3000, 0, 20000);
  const snapshot = await executeScript(
    tabId,
    snapshotSource(maxElements, maxTextChars, args.includeRects === true)
  );
  const refs = new Map();
  for (const element of snapshot.elements || []) {
    refs.set(element.ref, element.selector);
    delete element.selector;
  }
  refMaps.set(tabId, refs);
  return { tabId, ...snapshot };
}

async function closeAgentTabs() {
  const tabIds = Array.from(ownedTabIds);
  const closed = [];
  const failed = [];
  await Promise.all(tabIds.map(async tabId => {
    try {
      await extension("tab.close", { tabId });
      closed.push(tabId);
    } catch (error) {
      failed.push({ tabId, error: String(error?.message || error) });
    } finally {
      ownedTabIds.delete(tabId);
      refMaps.delete(tabId);
    }
  }));
  closed.sort((a, b) => a - b);
  failed.sort((a, b) => a.tabId - b.tabId);
  return { closed, failed };
}

let shuttingDown = false;

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.race([closeAgentTabs(), delay(2000)]).catch(() => {});
  controlClient.close();
  process.exit(code);
}

async function clickElement(args) {
  const tabId = await resolveTabId(args.tabId);
  const selector = resolveRef(tabId, args.ref);
  const action = await executeScript(tabId, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error("Element is no longer present; take a new snapshot");
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    return { clicked: true, tag: element.tagName.toLowerCase(), text: (element.innerText || element.value || "").trim().slice(0, 200) };
  })()`);
  return finishInteraction(tabId, action, args);
}

async function fillElement(args) {
  const tabId = await resolveTabId(args.tabId);
  const selector = resolveRef(tabId, args.ref);
  const value = requiredPresent(args.value, "value");
  const action = await executeScript(tabId, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error("Element is no longer present; take a new snapshot");
    const value = ${JSON.stringify(String(value))};
    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus();
    if (element.isContentEditable) {
      element.textContent = value;
    } else if ("value" in element) {
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
    } else {
      throw new Error("Element cannot be filled");
    }
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return { filled: true, tag: element.tagName.toLowerCase() };
  })()`);
  return finishInteraction(tabId, action, args);
}

async function selectElement(args) {
  const tabId = await resolveTabId(args.tabId);
  const selector = resolveRef(tabId, args.ref);
  const value = requiredPresent(args.value, "value");
  const action = await executeScript(tabId, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLSelectElement)) throw new Error("Element is not a select");
    element.value = ${JSON.stringify(String(value))};
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return { selected: true, value: element.value };
  })()`);
  return finishInteraction(tabId, action, args);
}

async function waitFor(args) {
  const tabId = await resolveTabId(args.tabId);
  const text = args.text == null ? "" : String(args.text);
  const selector = args.ref ? resolveRef(tabId, args.ref) : String(args.selector || "");
  if (!text && !selector) throw new Error("wait_for requires text, selector, or ref");
  const state = args.state === "hidden" ? "hidden" : "visible";
  const timeoutMs = boundedInteger(args.timeoutMs, 10000, 100, 30000);
  const startedAt = Date.now();
  let wait;
  while (Date.now() - startedAt < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    try {
      wait = await executeScript(
        tabId,
        waitForSource({ selector, text, state, timeoutMs: Math.min(2000, remainingMs) })
      );
      if (wait?.matched) break;
    } catch (error) {
      if (!isTransientFrameError(error)) throw error;
    }
    if (Date.now() - startedAt < timeoutMs) await delay(50);
  }
  if (!wait?.matched) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${state}`);
  wait.elapsedMs = Date.now() - startedAt;
  if (args.snapshotAfter !== true) return { wait };
  return {
    wait,
    snapshot: await pageSnapshotWithRetry({
      tabId,
      maxElements: args.maxElements,
      maxTextChars: args.maxTextChars
    })
  };
}

async function finishInteraction(tabId, action, args) {
  if (args.snapshotAfter !== true) return { tabId, action };
  const settleMs = boundedInteger(args.settleMs, 150, 0, 5000);
  if (settleMs) await delay(settleMs);
  return {
    action,
    snapshot: await pageSnapshotWithRetry({
      tabId,
      maxElements: args.maxElements,
      maxTextChars: args.maxTextChars
    })
  };
}

async function pageSnapshotWithRetry(args, timeoutMs = 2000) {
  const startedAt = Date.now();
  let lastError;
  do {
    try {
      return await pageSnapshot(args);
    } catch (error) {
      if (!isTransientFrameError(error)) throw error;
      lastError = error;
      await delay(100);
    }
  } while (Date.now() - startedAt < timeoutMs);
  throw lastError;
}

function isTransientFrameError(error) {
  return /frame .*removed|context .*destroyed|no frame|frame result|cannot access contents/i.test(
    String(error?.message || error)
  );
}

async function executeScript(tabId, code, world = "USER_SCRIPT") {
  const results = await extension("script.execute", { tabId, code, world });
  if (!Array.isArray(results) || !results.length) throw new Error("Script returned no frame result");
  const first = results[0];
  if (first && typeof first === "object" && "error" in first) throw new Error(first.error);
  return first;
}

async function resolveTabId(value) {
  if (value != null && value !== "active") {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) throw new Error(`Invalid tabId: ${value}`);
    return number;
  }
  const tab = await extension("tabs.active");
  if (!Number.isInteger(tab?.id)) throw new Error("The connected browser has no active tab");
  return tab.id;
}

function resolveRef(tabId, value) {
  const ref = requiredString(value, "ref");
  const selector = refMaps.get(tabId)?.get(ref);
  if (!selector) throw new Error(`Unknown or stale ref ${ref}; take a new snapshot`);
  return selector;
}

function request(method, params = {}, timeoutMs = 30000) {
  return controlClient.request(method, params, timeoutMs);
}

function extension(command, params = {}) {
  return request("extension.command", { command, params });
}

class ControlClient {
  constructor(filePath) {
    this.filePath = filePath;
    this.socket = null;
    this.connecting = null;
    this.buffer = "";
    this.sequence = 0;
    this.pending = new Map();
  }

  request(method, params, timeoutMs) {
    const id = `${process.pid}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ensureConnected()
        .then(socket => socket.write(`${JSON.stringify({ id, method, params })}\n`))
        .catch(error => this.settle(id, error));
    });
  }

  ensureConnected() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.filePath);
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        this.socket = socket;
        this.connecting = null;
        resolve(socket);
      });
      socket.on("data", chunk => this.handleData(chunk));
      socket.once("error", error => {
        if (this.connecting) {
          this.connecting = null;
          reject(error);
        }
        this.handleDisconnect(socket, error);
      });
      socket.once("close", () => this.handleDisconnect(socket, new Error("Chromium Bridge control socket closed")));
    });
    return this.connecting;
  }

  handleData(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > 96 * 1024 * 1024) {
      this.handleDisconnect(this.socket, new Error("Chromium Bridge control response exceeded 96 MiB"));
      this.socket?.destroy();
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch (error) {
        this.handleDisconnect(this.socket, error);
        this.socket?.destroy();
        return;
      }
      this.settle(
        response.id,
        response.ok ? null : new Error(response.error || "Control request failed"),
        response.result
      );
    }
  }

  settle(id, error, result) {
    const item = this.pending.get(id);
    if (!item) return;
    this.pending.delete(id);
    clearTimeout(item.timer);
    if (error) item.reject(error);
    else item.resolve(result);
  }

  handleDisconnect(socket, error) {
    if (socket !== this.socket && this.socket) return;
    if (socket === this.socket) this.socket = null;
    this.buffer = "";
    for (const id of this.pending.keys()) this.settle(id, error);
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
  }
}

controlClient = new ControlClient(socketPath);

function snapshotSource(maxElements, maxTextChars, includeRects) {
  return `(() => {
    const maxElements = ${maxElements};
    const maxTextChars = ${maxTextChars};
    const includeRects = ${includeRects};
    const sensitive = /pass(word)?|secret|token|authorization|auth|otp|pin|cvv|cvc|card|session|cookie/i;
    const rects = new WeakMap();
    const rectFor = element => {
      let rect = rects.get(element);
      if (!rect) {
        rect = element.getBoundingClientRect();
        rects.set(element, rect);
      }
      return rect;
    };
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = rectFor(element);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const compact = value => String(value || "").replace(/\\s+/g, " ").trim();
    const accessibleName = element => {
      const labelledBy = compact(element.getAttribute("aria-labelledby"))
        .split(" ")
        .filter(Boolean)
        .map(id => compact(document.getElementById(id)?.innerText))
        .filter(Boolean)
        .join(" ");
      const label = element.labels ? Array.from(element.labels).map(item => compact(item.innerText)).join(" ") : "";
      return compact(
        element.getAttribute("aria-label") ||
        labelledBy ||
        label ||
        element.alt ||
        element.title ||
        element.placeholder ||
        element.innerText ||
        element.textContent
      ).slice(0, 300);
    };
    const roleFor = element => element.getAttribute("role") || ({
      A: "link",
      BUTTON: "button",
      SELECT: "combobox",
      TEXTAREA: "textbox"
    }[element.tagName] || (element.tagName === "INPUT" ? (element.type || "textbox") : ""));
    const selectorFor = element => {
      const escape = value => CSS.escape(String(value));
      if (element.id) {
        const selector = "#" + escape(element.id);
        if (document.querySelectorAll(selector).length === 1) return selector;
      }
      for (const name of ["data-testid", "data-test", "name", "aria-label"]) {
        const value = element.getAttribute(name);
        if (!value) continue;
        const selector = element.tagName.toLowerCase() + "[" + name + "=\\"" + escape(value) + "\\"]";
        try {
          if (document.querySelectorAll(selector).length === 1) return selector;
        } catch {}
      }
      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement && parts.length < 10) {
        let part = current.tagName.toLowerCase();
        const siblings = current.parentElement
          ? Array.from(current.parentElement.children).filter(item => item.tagName === current.tagName)
          : [];
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        parts.unshift(part);
        const selector = parts.join(" > ");
        try {
          if (document.querySelectorAll(selector).length === 1) return selector;
        } catch {}
        current = current.parentElement;
      }
      return parts.join(" > ");
    };
    const candidates = [];
    for (const element of document.querySelectorAll(
      "a[href],button,input:not([type=hidden]),textarea,select,[contenteditable=true],[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[tabindex]:not([tabindex='-1'])"
    )) {
      if (visible(element)) candidates.push(element);
      if (candidates.length >= maxElements) break;
    }
    const elements = candidates.map((element, index) => {
      const key = [element.name, element.id, element.getAttribute("autocomplete"), element.getAttribute("aria-label")].filter(Boolean).join(" ");
      const type = compact(element.type);
      const rawValue = "value" in element ? compact(element.value) : "";
      const value = type === "password" || sensitive.test(key) ? (rawValue ? "<redacted>" : "") : rawValue.slice(0, 300);
      const rect = rectFor(element);
      return {
        ref: "e" + (index + 1),
        selector: selectorFor(element),
        tag: element.tagName.toLowerCase(),
        role: roleFor(element),
        type,
        name: accessibleName(element),
        value,
        checked: "checked" in element ? Boolean(element.checked) : undefined,
        disabled: "disabled" in element ? Boolean(element.disabled) : undefined,
        ...(includeRects ? {
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        } : {})
      };
    });
    const headings = [];
    for (const element of document.querySelectorAll("h1,h2,h3,[role=heading]")) {
      if (!visible(element)) continue;
      const heading = {
        level: Number(element.getAttribute("aria-level")) || Number(element.tagName.slice(1)) || null,
        text: compact(element.innerText || element.textContent).slice(0, 500)
      };
      if (heading.text) headings.push(heading);
      if (headings.length >= 40) break;
    }
    return {
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      text: compact(document.body?.innerText || "").slice(0, maxTextChars),
      headings,
      elements
    };
  })()`;
}

function waitForSource({ selector, text, state, timeoutMs }) {
  return `(() => new Promise(resolve => {
    const selector = ${JSON.stringify(selector)};
    const expectedText = ${JSON.stringify(text)};
    const targetState = ${JSON.stringify(state)};
    const timeoutMs = ${timeoutMs};
    const startedAt = Date.now();
    let interval;
    let observer;
    const visible = element => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const matches = () => {
      const present = selector
        ? visible(document.querySelector(selector))
        : (document.body?.innerText || "").includes(expectedText);
      return targetState === "visible" ? present : !present;
    };
    const finish = matched => {
      clearInterval(interval);
      observer?.disconnect();
      resolve({ matched, state: targetState, elapsedMs: Date.now() - startedAt });
    };
    const check = () => {
      if (matches()) finish(true);
      else if (Date.now() - startedAt >= timeoutMs) finish(false);
    };
    observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true
    });
    interval = setInterval(check, 100);
    check();
  }))()`;
}

function screenshotResult(result) {
  const match = /^data:(image\/(?:png|jpeg));base64,(.+)$/s.exec(result?.dataUrl || "");
  if (!match) throw new Error("The browser returned an invalid screenshot");
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ tabId: result.tabId, title: result.title, url: result.url })
      },
      {
        type: "image",
        mimeType: match[1],
        data: match[2]
      }
    ]
  };
}

function interactionResult(result) {
  return result.snapshot
    ? snapshotResult(result.snapshot, { action: result.action })
    : textResult({ tabId: result.tabId, ...result.action });
}

function snapshotResult(snapshot, metadata = {}) {
  const lines = [];
  for (const [key, value] of Object.entries(metadata)) {
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push(`tabId: ${snapshot.tabId}`);
  lines.push(`title: ${JSON.stringify(snapshot.title || "")}`);
  lines.push(`url: ${JSON.stringify(snapshot.url || "")}`);
  lines.push(`state: ${snapshot.readyState || "unknown"}`);
  if (snapshot.viewport) {
    lines.push(`viewport: ${snapshot.viewport.width}x${snapshot.viewport.height}@${snapshot.viewport.devicePixelRatio || 1}`);
  }
  if (snapshot.text) lines.push(`text: ${JSON.stringify(snapshot.text)}`);
  if (snapshot.headings?.length) {
    lines.push("headings:");
    for (const heading of snapshot.headings) {
      lines.push(`  h${heading.level || "?"} ${JSON.stringify(heading.text)}`);
    }
  }
  if (snapshot.elements?.length) {
    lines.push("elements:");
    for (const element of snapshot.elements) lines.push(`  ${formatElement(element)}`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

function formatElement(element) {
  const parts = [
    element.ref,
    `role=${element.role || "generic"}`,
    `tag=${element.tag || "unknown"}`
  ];
  if (element.name) parts.push(`name=${JSON.stringify(element.name)}`);
  if (element.type) parts.push(`type=${JSON.stringify(element.type)}`);
  if (element.value) parts.push(`value=${JSON.stringify(element.value)}`);
  if (element.checked != null) parts.push(`checked=${element.checked}`);
  if (element.disabled) parts.push("disabled=true");
  if (element.rect) {
    parts.push(`rect=${element.rect.width}x${element.rect.height}@${element.rect.x},${element.rect.y}`);
  }
  return parts.join(" ");
}

function textResult(value) {
  return {
    content: [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value)
    }]
  };
}

function tabSummary(tab) {
  if (!tab) return null;
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    audible: Boolean(tab.audible),
    status: tab.status || "",
    title: tab.title || "",
    url: tab.url || ""
  };
}

function tool(name, description, properties, annotations, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false
    },
    annotations
  };
}

function stringProperty(description) {
  return { type: "string", description };
}

function booleanProperty(description) {
  return { type: "boolean", description };
}

function postActionProperties() {
  return {
    snapshotAfter: booleanProperty("Return a fresh compact snapshot with the action result, avoiding another tool call."),
    settleMs: integerProperty("Delay before the optional snapshot. Defaults to 150 ms.", 0, 5000),
    maxElements: integerProperty("Maximum elements in the optional snapshot.", 1, 500),
    maxTextChars: integerProperty("Maximum text characters in the optional snapshot.", 0, 20000)
  };
}

function integerProperty(description, minimum, maximum) {
  return { type: "integer", minimum, maximum, description };
}

function tabProperty() {
  return {
    oneOf: [
      { type: "integer", minimum: 0 },
      { type: "string", enum: ["active"] }
    ],
    description: "Browser tab id. Defaults to the active tab."
  };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number)) throw new Error(`Expected an integer, got ${value}`);
  return Math.max(minimum, Math.min(maximum, number));
}

function requiredString(value, label) {
  const string = String(value ?? "");
  if (!string.trim()) throw new Error(`Missing ${label}`);
  return string;
}

function requiredPresent(value, label) {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function friendlyError(error) {
  if (["ENOENT", "ECONNREFUSED"].includes(error?.code)) {
    return `Chromium Bridge is unavailable at ${socketPath}. Start your browser and reload the Chromium Bridge extension.`;
  }
  return String(error?.message || error);
}

function writeResult(id, result) {
  if (id == null) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id, code, message) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  })}\n`);
}
