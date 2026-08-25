import { createTabAndWait, navigateTabAndWait } from "./tab-navigation.js";
import {
  captureOptions,
  extractCapturedRequestBody,
  matchesCaptureUrl,
  normalizeCapturedHeaders,
  redactDebuggerValue,
  redactUrl
} from "./capture-safety.js";

const NATIVE_HOST_NAME = "com.chromium_bridge.bridge";
const EXTENSION_VERSION = "0.5.0";
const PRIVACY_CONSENT_VERSION = 1;
const MAX_SCRIPT_CHARS = 512 * 1024;
const MAX_RESPONSE_BODY_CHARS = 1024 * 1024;
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
let privacyConsentVersion = 0;

const capture = {
  enabled: false,
  includeSecrets: false,
  urlPattern: "",
  allUrls: false,
  captureRequestBody: false
};

const debuggerTabs = new Set();
const debuggerRequestUrls = new Map();
let debuggerListenersRegistered = false;

init();
chrome.runtime.onStartup.addListener(init);
chrome.runtime.onInstalled.addListener(details => {
  void init();
  if (details.reason === "install") {
    void chrome.tabs.create({ url: chrome.runtime.getURL("popup.html"), active: true });
  }
});
chrome.permissions.onAdded.addListener(() => void sendHello());
chrome.permissions.onRemoved.addListener(() => void sendHello());

async function init() {
  if (initialized) return;
  initialized = true;
  const stored = await storageGet(["capture", "privacyConsentVersion"]);
  privacyConsentVersion = Number(stored.privacyConsentVersion || 0);
  if (stored.capture) {
    capture.urlPattern = String(stored.capture.urlPattern || "");
    capture.allUrls = Boolean(stored.capture.allUrls);
    capture.captureRequestBody = Boolean(stored.capture.captureRequestBody);
  }
  capture.enabled = false;
  capture.includeSecrets = false;
  connectNativeHost();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !String(sender.url || "").startsWith(chrome.runtime.getURL(""))) {
    sendResponse({ ok: false, error: "Untrusted extension message sender" });
    return false;
  }
  const popup = String(sender.url || "").startsWith(chrome.runtime.getURL("popup.html"));
  handleCommand(message || {}, { popup, sender })
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
      url: redactUrl(details.url, capture.includeSecrets),
      type: details.type,
      initiator: redactUrl(details.initiator || "", capture.includeSecrets),
      requestBody: capture.captureRequestBody
        ? extractCapturedRequestBody(details, capture.includeSecrets)
        : undefined
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
      url: redactUrl(details.url, capture.includeSecrets),
      requestHeaders: normalizeCapturedHeaders(details.requestHeaders, capture.includeSecrets)
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
      url: redactUrl(details.url, capture.includeSecrets),
      statusCode: details.statusCode,
      statusLine: details.statusLine,
      responseHeaders: normalizeCapturedHeaders(details.responseHeaders, capture.includeSecrets)
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
      url: redactUrl(details.url, capture.includeSecrets),
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
      url: redactUrl(details.url, capture.includeSecrets),
      error: details.error
    });
  },
  { urls: ["<all_urls>"] }
);

function handleDebuggerEvent(source, method, params) {
  const tabId = source?.tabId;
  if (tabId == null || !debuggerTabs.has(tabId) || !capture.enabled) return;

  const key = debuggerRequestKey(tabId, params?.requestId);
  if (method === "Network.requestWillBeSent" && params?.request?.url && key) {
    debuggerRequestUrls.set(key, params.request.url);
  }

  const url = debuggerEventUrl(method, params) || (key ? debuggerRequestUrls.get(key) : "");
  if (!url || !shouldCapture(url)) return;

  if (DEBUGGER_EVENT_ALLOWLIST.has(method)) {
    emitEvent("debugger.event", {
      tabId,
      method,
      params: redactDebuggerValue(params, capture.includeSecrets)
    });
  }

  if (method === "Network.loadingFinished" && params?.requestId) {
    if (capture.includeSecrets) getResponseBody(tabId, params.requestId, url);
    debuggerRequestUrls.delete(key);
  } else if (method === "Network.loadingFailed" && key) {
    debuggerRequestUrls.delete(key);
  }
}

function handleDebuggerDetach(source) {
  if (source?.tabId == null) return;
  debuggerTabs.delete(source.tabId);
  deleteDebuggerRequests(source.tabId);
  emitEvent("debugger.detached", { tabId: source.tabId });
}

function ensureDebuggerListeners() {
  if (debuggerListenersRegistered) return;
  chrome.debugger.onEvent.addListener(handleDebuggerEvent);
  chrome.debugger.onDetach.addListener(handleDebuggerDetach);
  debuggerListenersRegistered = true;
}

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
  void sendHello();
}

async function sendHello() {
  sendNative({
    type: "hello",
    extension: {
      id: chrome.runtime.id,
      name: "Chromium Bridge",
      version: EXTENSION_VERSION,
      ...(privacyState().consented ? { userAgent: navigator.userAgent } : {})
    },
    capture: captureState(),
    privacy: privacyState(),
    permissions: await permissionState()
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectNativeHost, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

async function handleCommand(message, context = {}) {
  const command = message.command || message.type;
  const params = message.params || {};
  switch (command) {
    case "ping":
      return {
        pong: true,
        nativeHost: nativeStatus(),
        userScriptsAvailable: await userScriptsAvailable(true),
        capture: captureState(),
        privacy: privacyState(),
        permissions: await permissionState()
      };
    case "privacy.status":
      return { privacy: privacyState(), permissions: await permissionState() };
    case "privacy.consent": {
      requirePopup(context);
      const permissions = await permissionState();
      if (!permissions.siteAccess || !permissions.tabs) {
        throw new Error("Grant access to websites before enabling Chromium Bridge");
      }
      await storageSet({ privacyConsentVersion: PRIVACY_CONSENT_VERSION });
      privacyConsentVersion = PRIVACY_CONSENT_VERSION;
      await sendHello();
      return { privacy: privacyState(), permissions };
    }
    case "privacy.revoke":
      requirePopup(context);
      await stopCapture();
      privacyConsentVersion = 0;
      try {
        await storageSet({ privacyConsentVersion });
      } finally {
        await sendHello();
      }
      return { privacy: privacyState(), permissions: await permissionState() };
    case "native.reconnect":
      connectNativeHost();
      return nativeStatus();
    case "runtime.reload":
      setTimeout(() => chrome.runtime.reload(), 250);
      return { reloading: true, version: EXTENSION_VERSION };
  }

  await requireBrowserAccess();
  switch (command) {
    case "capture.start": {
      Object.assign(capture, captureOptions(params), { enabled: true });
      await persistCapturePreferences();
      emitEvent("capture.started", { capture: captureState() });
      return captureState();
    }
    case "capture.stop":
      return stopCapture();
    case "capture.status":
      return captureState();
    case "tabs.list":
      return chrome.tabs.query({});
    case "tabs.create":
      return createTabAndWait(chrome.tabs, {
        ...(params.url ? { url: safeNavigationUrl(params.url) } : {}),
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
        safeNavigationUrl(params.url)
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
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function executeUserScript(params) {
  if (!await userScriptsAvailable()) {
    throw new Error("Allow User Scripts is disabled for Chromium Bridge");
  }
  const tabId = await getTabId(params.tabId);
  const code = requiredBoundedString(params.code, "code", MAX_SCRIPT_CHARS);
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
  await requireOptionalPermission("cookies");
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
  await requireOptionalPermission("debugger");
  ensureDebuggerListeners();
  if (debuggerTabs.has(tabId)) return { tabId, attached: true };
  await chrome.debugger.attach({ tabId }, "1.3");
  debuggerTabs.add(tabId);
  await sendDebuggerCommand(tabId, "Network.enable", {});
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

function sendDebuggerCommand(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

async function getResponseBody(tabId, requestId, url) {
  try {
    const body = await sendDebuggerCommand(tabId, "Network.getResponseBody", { requestId });
    const rawBody = String(body.body || "");
    const truncated = rawBody.length > MAX_RESPONSE_BODY_CHARS;
    emitEvent("debugger.responseBody", {
      tabId,
      requestId,
      url: redactUrl(url, capture.includeSecrets),
      base64Encoded: Boolean(body.base64Encoded),
      body: rawBody.slice(0, MAX_RESPONSE_BODY_CHARS),
      ...(truncated ? { truncatedChars: rawBody.length - MAX_RESPONSE_BODY_CHARS } : {})
    });
  } catch (error) {
    emitEvent("debugger.responseBodyError", {
      tabId,
      requestId,
      url: redactUrl(url, capture.includeSecrets),
      error: errorMessage(error)
    });
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
  return capture.enabled && matchesCaptureUrl(url, capture);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
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
    allUrls: capture.allUrls,
    captureRequestBody: capture.captureRequestBody,
    debuggerTabs: Array.from(debuggerTabs)
  };
}

async function stopCapture() {
  const wasEnabled = capture.enabled;
  capture.enabled = false;
  capture.includeSecrets = false;
  await persistCapturePreferences();
  await detachAllDebuggers();
  if (wasEnabled) emitEvent("capture.stopped", { capture: captureState() });
  return captureState();
}

async function persistCapturePreferences() {
  await storageSet({
    capture: {
      urlPattern: capture.urlPattern,
      allUrls: capture.allUrls,
      captureRequestBody: capture.captureRequestBody
    }
  });
}

function privacyState() {
  return {
    consented: privacyConsentVersion === PRIVACY_CONSENT_VERSION,
    version: privacyConsentVersion,
    requiredVersion: PRIVACY_CONSENT_VERSION
  };
}

async function permissionState() {
  const [siteAccess, tabs, cookies, debuggerAccess] = await Promise.all([
    chrome.permissions.contains({ origins: ["<all_urls>"] }),
    chrome.permissions.contains({ permissions: ["tabs"] }),
    chrome.permissions.contains({ permissions: ["cookies"] }),
    chrome.permissions.contains({ permissions: ["debugger"] })
  ]);
  return { siteAccess, tabs, cookies, debugger: debuggerAccess };
}

async function requireBrowserAccess() {
  if (!privacyState().consented) {
    throw new Error("Open the Chromium Bridge popup and approve local browser access first");
  }
  const permissions = await permissionState();
  if (!permissions.siteAccess || !permissions.tabs) {
    throw new Error("Chromium Bridge no longer has website access; grant it again from the popup");
  }
}

async function requireOptionalPermission(permission) {
  if (!await chrome.permissions.contains({ permissions: [permission] })) {
    throw new Error(`Enable optional ${permission} access from the Chromium Bridge popup first`);
  }
}

function requirePopup(context) {
  if (context.popup !== true) throw new Error("This action requires an explicit click in the extension popup");
}

function safeNavigationUrl(value) {
  const url = requiredString(value, "url");
  if (/^(?:javascript|data):/i.test(url.trim())) {
    throw new Error("javascript: and data: navigation are not allowed");
  }
  return url;
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

function requiredBoundedString(value, label, maximumLength) {
  const string = requiredString(value, label);
  if (string.length > maximumLength) {
    throw new Error(`${label} exceeds ${maximumLength} characters`);
  }
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
