import { createTabAndWait, navigateTabAndWait } from "./tab-navigation.js";

const NATIVE_HOST_NAME = "com.chromium_sidecar.bridge";
const EXTENSION_VERSION = "0.4.0";
const SENSITIVE_FIELD = /pass(word)?|secret|token|authorization|auth|otp|code|pin|cvv|cvc|card|session|cookie/i;
const DEBUGGER_EVENT_ALLOWLIST = new Set([
  "Network.requestWillBeSent",
  "Network.requestWillBeSentExtraInfo",
  "Network.responseReceived",
  "Network.responseReceivedExtraInfo",
  "Network.loadingFinished",
  "Network.loadingFailed"
]);

let nativePort = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let lastNativeError = "";
let initialized = false;
let userScriptsReady = null;

const capture = {
  enabled: false,
  includeSecrets: false,
  urlPattern: "",
  captureRequestBody: false
};

const debuggerTabs = new Set();
const debuggerRequestUrls = new Map();

init();
chrome.runtime.onStartup.addListener(init);
chrome.runtime.onInstalled.addListener(init);

async function init() {
  if (initialized) return;
  initialized = true;
  const stored = await storageGet(["capture"]);
  if (stored.capture) {
    capture.urlPattern = String(stored.capture.urlPattern || "");
    capture.captureRequestBody = Boolean(stored.capture.captureRequestBody);
  }
  capture.enabled = false;
  capture.includeSecrets = false;
  connectNativeHost();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleCommand(message || {}, { popup: true, sender })
    .then(result => sendResponse({ ok: true, result }))
    .catch(error => sendResponse({ ok: false, error: errorMessage(error) }));
  return true;
});

chrome.webRequest.onBeforeRequest.addListener(
  details => {
    if (!shouldCapture(details.url)) return;
    emitEvent("request.before", {
      requestId: details.requestId,
      tabId: details.tabId,
      frameId: details.frameId,
      method: details.method,
      url: details.url,
      type: details.type,
      initiator: details.initiator || "",
      requestBody: capture.captureRequestBody ? extractRequestBody(details) : undefined
    });
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  details => {
    if (!shouldCapture(details.url)) return;
    emitEvent("request.headers", {
      requestId: details.requestId,
      tabId: details.tabId,
      frameId: details.frameId,
      method: details.method,
      url: details.url,
      requestHeaders: normalizeHeaders(details.requestHeaders)
    });
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  details => {
    if (!shouldCapture(details.url)) return;
    emitEvent("response.headers", {
      requestId: details.requestId,
      tabId: details.tabId,
      frameId: details.frameId,
      method: details.method,
      url: details.url,
      statusCode: details.statusCode,
      statusLine: details.statusLine,
      responseHeaders: normalizeHeaders(details.responseHeaders)
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  details => {
    if (!shouldCapture(details.url)) return;
    emitEvent("request.completed", {
      requestId: details.requestId,
      tabId: details.tabId,
      frameId: details.frameId,
      method: details.method,
      url: details.url,
      statusCode: details.statusCode,
      fromCache: details.fromCache,
      ip: details.ip || ""
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  details => {
    if (!shouldCapture(details.url)) return;
    emitEvent("request.error", {
      requestId: details.requestId,
      tabId: details.tabId,
      frameId: details.frameId,
      method: details.method,
      url: details.url,
      error: details.error
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source?.tabId;
  if (tabId == null || !debuggerTabs.has(tabId) || !capture.enabled) return;

  const key = debuggerRequestKey(tabId, params?.requestId);
  if (method === "Network.requestWillBeSent" && params?.request?.url && key) {
    debuggerRequestUrls.set(key, params.request.url);
  }

  const url = debuggerEventUrl(method, params) || (key ? debuggerRequestUrls.get(key) : "");
  if (!url || !shouldCapture(url)) return;

  if (DEBUGGER_EVENT_ALLOWLIST.has(method)) {
    emitEvent("debugger.event", { tabId, method, params: redactDebuggerValue(params) });
  }

  if (method === "Network.loadingFinished" && params?.requestId) {
    if (capture.includeSecrets) getResponseBody(tabId, params.requestId, url);
    debuggerRequestUrls.delete(key);
  } else if (method === "Network.loadingFailed" && key) {
    debuggerRequestUrls.delete(key);
  }
});

chrome.debugger.onDetach.addListener(source => {
  if (source?.tabId == null) return;
  debuggerTabs.delete(source.tabId);
  deleteDebuggerRequests(source.tabId);
  emitEvent("debugger.detached", { tabId: source.tabId });
});

function connectNativeHost() {
  clearTimeout(reconnectTimer);
  if (nativePort) {
    try {
      nativePort.disconnect();
    } catch {}
    nativePort = null;
  }

  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (error) {
    lastNativeError = errorMessage(error);
    scheduleReconnect();
    return;
  }

  nativePort = port;
  lastNativeError = "";
  port.onMessage.addListener(message => {
    if (port !== nativePort) return;
    handleCommand(message || {})
      .then(result => reply(message?.id, true, result))
      .catch(error => reply(message?.id, false, null, errorMessage(error)));
  });
  port.onDisconnect.addListener(() => {
    if (port !== nativePort) return;
    lastNativeError = chrome.runtime.lastError?.message || "Native host disconnected";
    nativePort = null;
    scheduleReconnect();
  });

  reconnectDelay = 1000;
  sendNative({
    type: "hello",
    extension: {
      id: chrome.runtime.id,
      name: "Chromium Sidecar",
      version: EXTENSION_VERSION,
      userAgent: navigator.userAgent
    },
    capture: captureState()
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectNativeHost, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

async function handleCommand(message) {
  const command = message.command || message.type;
  const params = message.params || {};
  switch (command) {
    case "ping":
      return {
        pong: true,
        nativeHost: nativeStatus(),
        userScriptsAvailable: await userScriptsAvailable(true),
        capture: captureState()
      };
    case "native.reconnect":
      connectNativeHost();
      return nativeStatus();
    case "runtime.reload":
      setTimeout(() => chrome.runtime.reload(), 250);
      return { reloading: true, version: EXTENSION_VERSION };
    case "capture.start":
      capture.enabled = true;
      capture.includeSecrets = Boolean(params.includeSecrets);
      capture.urlPattern = String(params.urlPattern || "");
      capture.captureRequestBody = Boolean(params.captureRequestBody);
      await persistCapturePreferences();
      emitEvent("capture.started", { capture: captureState() });
      return captureState();
    case "capture.stop":
      capture.enabled = false;
      capture.includeSecrets = false;
      await persistCapturePreferences();
      await detachAllDebuggers();
      emitEvent("capture.stopped", { capture: captureState() });
      return captureState();
    case "capture.status":
      return captureState();
    case "tabs.list":
      return chrome.tabs.query({});
    case "tabs.create":
      return createTabAndWait(chrome.tabs, {
        ...(params.url ? { url: String(params.url) } : {}),
        active: params.active === true
      });
    case "tabs.active":
      return getActiveTab();
    case "tab.close": {
      const tabId = await getTabId(params.tabId);
      await chrome.tabs.remove(tabId);
      return { closed: true, tabId };
    }
    case "tab.navigate":
      return navigateTabAndWait(
        chrome.tabs,
        await getTabId(params.tabId),
        requiredString(params.url, "url")
      );
    case "tab.back": {
      const tabId = await getTabId(params.tabId);
      await chrome.tabs.goBack(tabId);
      return { navigated: "back", tabId };
    }
    case "tab.forward": {
      const tabId = await getTabId(params.tabId);
      await chrome.tabs.goForward(tabId);
      return { navigated: "forward", tabId };
    }
    case "tab.reload":
      await chrome.tabs.reload(await getTabId(params.tabId), {});
      return { reloaded: true };
    case "tab.screenshot":
      return captureVisibleTab(params);
    case "script.execute":
      return executeUserScript(params);
    case "cookies.getAll":
      return getCookies(params);
    case "debugger.attach":
      return attachDebugger(await getTabId(params.tabId));
    case "debugger.detach":
      return detachDebugger(await getTabId(params.tabId));
    case "debugger.command":
      return debuggerCommand(await getTabId(params.tabId), params.method, params.params || {});
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function executeUserScript(params) {
  if (!await userScriptsAvailable()) {
    throw new Error("Allow User Scripts is disabled for Chromium Sidecar");
  }
  const tabId = await getTabId(params.tabId);
  const code = requiredString(params.code, "code");
  const world = params.world === "MAIN" ? "MAIN" : "USER_SCRIPT";
  let results;
  try {
    results = await chrome.userScripts.execute({
      target: { tabId },
      world,
      injectImmediately: true,
      js: [{ code }]
    });
  } catch (error) {
    userScriptsReady = null;
    throw error;
  }
  return results.map(item => item.error ? { error: item.error, frameId: item.frameId } : item.result);
}

async function userScriptsAvailable(refresh = false) {
  if (!refresh && userScriptsReady != null) return userScriptsReady;
  if (!chrome.userScripts?.getScripts) return false;
  try {
    await chrome.userScripts.getScripts();
    userScriptsReady = true;
  } catch {
    userScriptsReady = false;
  }
  return userScriptsReady;
}

async function getCookies(params) {
  const query = {};
  if (params.url) query.url = String(params.url);
  if (params.domain) query.domain = String(params.domain);
  if (params.name) query.name = String(params.name);
  const cookies = await chrome.cookies.getAll(query);
  if (params.includeSecrets === true) return cookies;
  return cookies.map(cookie => ({ ...cookie, value: `<redacted:${cookie.value.length}>` }));
}

async function captureVisibleTab(params) {
  const tabId = await getTabId(params.tabId);
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw new Error("Screenshots require the target tab to be active");
  const format = params.format === "jpeg" ? "jpeg" : "png";
  const options = { format };
  if (format === "jpeg" && params.quality != null) {
    options.quality = Math.max(0, Math.min(100, Number(params.quality)));
  }
  let dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, options);
  const maxWidth = Math.max(320, Math.min(4000, Number(params.maxWidth) || 1600));
  dataUrl = await downscaleScreenshot(dataUrl, format, options.quality ?? 70, maxWidth);
  return {
    tabId,
    title: tab.title || "",
    url: tab.url || "",
    dataUrl
  };
}

async function downscaleScreenshot(dataUrl, format, quality, maxWidth) {
  const source = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    if (source.width <= maxWidth) return dataUrl;
    const scale = maxWidth / source.width;
    const canvas = new OffscreenCanvas(maxWidth, Math.max(1, Math.round(source.height * scale)));
    const context = canvas.getContext("2d");
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const type = format === "png" ? "image/png" : "image/jpeg";
    const blob = await canvas.convertToBlob({
      type,
      ...(format === "jpeg" ? { quality: quality / 100 } : {})
    });
    return `data:${type};base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
  } finally {
    source.close();
  }
}

async function attachDebugger(tabId) {
  if (debuggerTabs.has(tabId)) return { tabId, attached: true };
  await chrome.debugger.attach({ tabId }, "1.3");
  debuggerTabs.add(tabId);
  await debuggerCommand(tabId, "Network.enable", {});
  emitEvent("debugger.attached", { tabId });
  return { tabId, attached: true };
}

async function detachDebugger(tabId) {
  if (!debuggerTabs.has(tabId)) return { tabId, attached: false };
  await chrome.debugger.detach({ tabId });
  debuggerTabs.delete(tabId);
  deleteDebuggerRequests(tabId);
  return { tabId, attached: false };
}

async function detachAllDebuggers() {
  const tabIds = Array.from(debuggerTabs);
  await Promise.all(tabIds.map(tabId => detachDebugger(tabId).catch(() => null)));
}

function debuggerCommand(tabId, method, params) {
  if (!method) throw new Error("debugger.command requires params.method");
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

async function getResponseBody(tabId, requestId, url) {
  try {
    const body = await debuggerCommand(tabId, "Network.getResponseBody", { requestId });
    emitEvent("debugger.responseBody", {
      tabId,
      requestId,
      url,
      base64Encoded: Boolean(body.base64Encoded),
      body: body.body
    });
  } catch (error) {
    emitEvent("debugger.responseBodyError", { tabId, requestId, url, error: errorMessage(error) });
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] || null;
}

async function getTabId(tabId) {
  if (tabId != null && tabId !== "active") {
    const number = Number(tabId);
    if (!Number.isInteger(number) || number < 0) throw new Error(`Invalid tab id: ${tabId}`);
    return number;
  }
  const active = await getActiveTab();
  if (active?.id == null) throw new Error("No active tab");
  return active.id;
}

function shouldCapture(url) {
  if (!capture.enabled) return false;
  if (!capture.urlPattern) return true;
  return matchesPattern(String(url || ""), capture.urlPattern);
}

function matchesPattern(url, pattern) {
  if (!pattern) return true;
  if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
    try {
      return new RegExp(pattern.slice(1, -1)).test(url);
    } catch {
      return url.includes(pattern);
    }
  }
  return url.includes(pattern);
}

function extractRequestBody(details) {
  const requestBody = details.requestBody;
  if (!requestBody) return undefined;
  if (!capture.includeSecrets && isAuthLike(details.url)) {
    return { kind: "redacted", reason: "auth-like URL" };
  }
  if (requestBody.error) return { kind: "error", error: requestBody.error };
  if (requestBody.formData) {
    return {
      kind: "formData",
      data: capture.includeSecrets ? requestBody.formData : redactFormData(requestBody.formData)
    };
  }
  if (requestBody.raw) {
    return {
      kind: "raw",
      parts: requestBody.raw.map(part => serializeUploadPart(part, capture.includeSecrets))
    };
  }
  return { kind: "unknown" };
}

function redactFormData(formData) {
  return Object.fromEntries(Object.entries(formData).map(([key, values]) => [
    key,
    SENSITIVE_FIELD.test(key) ? values.map(value => `<redacted:${String(value).length}>`) : values
  ]));
}

function serializeUploadPart(part, includeSecrets) {
  if (part.file) return { file: String(part.file) };
  if (!part.bytes) return { empty: true };
  const bytes = new Uint8Array(part.bytes);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return includeSecrets ? { base64: bytesToBase64(bytes) } : { redactedBinaryBytes: bytes.byteLength };
  }
  return { text: includeSecrets ? text : redactBodyText(text) };
}

function redactBodyText(text) {
  const value = String(text);
  try {
    return JSON.stringify(redactObject(JSON.parse(value)));
  } catch {}

  if (value.includes("=")) {
    try {
      const params = new URLSearchParams(value);
      let found = false;
      for (const key of new Set(params.keys())) {
        if (!SENSITIVE_FIELD.test(key)) continue;
        const values = params.getAll(key);
        params.delete(key);
        for (const item of values) params.append(key, `<redacted:${item.length}>`);
        found = true;
      }
      if (found) return params.toString();
    } catch {}
  }
  return value;
}

function redactObject(value, key = "") {
  if (SENSITIVE_FIELD.test(key)) return `<redacted:${String(value ?? "").length}>`;
  if (Array.isArray(value)) return value.map(item => redactObject(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactObject(child, childKey)]));
  }
  return value;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function normalizeHeaders(headers = []) {
  return headers.map(header => {
    const name = String(header.name || "");
    const value = String(header.value || "");
    if (!capture.includeSecrets && isSecretHeader(name)) {
      return { name, value: summarizeSecretHeader(value) };
    }
    return { name, value };
  });
}

function redactDebuggerValue(value, key = "") {
  if (value == null || typeof value !== "object") {
    if (isSecretHeader(key)) return summarizeSecretHeader(value);
    if (/postData/i.test(key)) return capture.includeSecrets ? value : redactBodyText(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(item => redactDebuggerValue(item));
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    childKey,
    redactDebuggerValue(child, childKey)
  ]));
}

function isSecretHeader(name) {
  return /^(cookie|set-cookie|authorization|proxy-authorization)$/i.test(String(name));
}

function isAuthLike(url) {
  return /Authenticate|ConfirmAuthenticate|ResendCode|UpdateVcode|Login|signin|sign-in|password|otp/i.test(String(url));
}

function summarizeSecretHeader(value = "") {
  const text = String(value);
  if (!text) return "[REDACTED empty]";
  return text.split(/;\s*/).filter(Boolean).map(part => {
    const equals = part.indexOf("=");
    if (equals < 0) return `<redacted:${part.length}>`;
    return `${part.slice(0, equals)}=<redacted:${part.slice(equals + 1).length}>`;
  }).join("; ");
}

function debuggerEventUrl(method, params) {
  if (method === "Network.requestWillBeSent") return params?.request?.url || "";
  if (method === "Network.responseReceived") return params?.response?.url || "";
  return "";
}

function debuggerRequestKey(tabId, requestId) {
  return requestId ? `${tabId}:${requestId}` : "";
}

function deleteDebuggerRequests(tabId) {
  const prefix = `${tabId}:`;
  for (const key of debuggerRequestUrls.keys()) {
    if (key.startsWith(prefix)) debuggerRequestUrls.delete(key);
  }
}

function captureState() {
  return {
    enabled: capture.enabled,
    includeSecrets: capture.includeSecrets,
    urlPattern: capture.urlPattern,
    captureRequestBody: capture.captureRequestBody,
    debuggerTabs: Array.from(debuggerTabs)
  };
}

async function persistCapturePreferences() {
  await storageSet({
    capture: {
      urlPattern: capture.urlPattern,
      captureRequestBody: capture.captureRequestBody
    }
  });
}

function nativeStatus() {
  return {
    connected: Boolean(nativePort),
    host: NATIVE_HOST_NAME,
    lastError: lastNativeError
  };
}

function emitEvent(type, payload) {
  sendNative({
    type: "event",
    event: {
      type,
      ts: new Date().toISOString(),
      payload
    }
  });
}

function reply(id, ok, result, error) {
  if (id == null) return;
  sendNative({ type: "response", id, ok, result, error });
}

function sendNative(message) {
  if (!nativePort) return false;
  try {
    nativePort.postMessage(message);
    return true;
  } catch (error) {
    lastNativeError = errorMessage(error);
    return false;
  }
}

function requiredString(value, label) {
  const string = String(value ?? "");
  if (!string.trim()) throw new Error(`Missing ${label}`);
  return string;
}

function errorMessage(error) {
  return String(error?.message || error);
}

function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

function storageSet(value) {
  return chrome.storage.local.set(value);
}
