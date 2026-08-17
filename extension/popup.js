const $ = id => document.getElementById(id);

refresh();

$("enableAccess").addEventListener("click", () => run(async () => {
  const granted = await chrome.permissions.request({
    origins: ["<all_urls>"],
    permissions: ["tabs"]
  });
  if (!granted) throw new Error("Website access was not granted");
  await command("privacy.consent", {});
  await refresh();
}));

$("revokeAccess").addEventListener("click", () => run(async () => {
  let commandError;
  try {
    await command("privacy.revoke", {});
  } catch (error) {
    commandError = error;
  } finally {
    await chrome.permissions.remove({
      origins: ["<all_urls>"],
      permissions: ["tabs", "cookies", "debugger"]
    });
  }
  await refresh();
  if (commandError) throw commandError;
}));

$("grantCookies").addEventListener("click", () => grantPermission("cookies"));
$("grantDebugger").addEventListener("click", () => grantPermission("debugger"));

$("reconnect").addEventListener("click", () => run(async () => {
  await command("native.reconnect", {});
  await delay(500);
  await refresh();
}));

$("startCapture").addEventListener("click", () => run(async () => {
  const includeSecrets = $("includeSecrets").checked;
  if (includeSecrets && !confirm("Raw capture can store session credentials and private request data on this computer. Continue?")) {
    return;
  }
  const result = await command("capture.start", {
    includeSecrets,
    urlPattern: $("urlPattern").value.trim(),
    allUrls: $("allUrls").checked,
    captureRequestBody: $("captureBody").checked
  });
  setOutput(result);
  await refresh();
}));

$("stopCapture").addEventListener("click", () => run(async () => {
  const result = await command("capture.stop", {});
  setOutput(result);
  await refresh();
}));

$("runScript").addEventListener("click", () => run(async () => {
  const result = await command("script.execute", {
    tabId: "active",
    code: $("scriptCode").value,
    world: "USER_SCRIPT"
  });
  setOutput(result);
}));

$("getCookies").addEventListener("click", () => run(async () => {
  const active = await command("tabs.active", {});
  if (!active?.url) throw new Error("Active tab has no readable URL");
  const result = await command("cookies.getAll", { url: active.url });
  setOutput(result);
}));

async function grantPermission(permission) {
  return run(async () => {
    const granted = await chrome.permissions.request({ permissions: [permission] });
    if (!granted) throw new Error(`${permission} access was not granted`);
    await refresh();
  });
}

async function refresh() {
  try {
    const result = await command("ping", {});
    const authorized = result.privacy.consented && result.permissions.siteAccess && result.permissions.tabs;
    $("consentPanel").classList.toggle("hidden", authorized);
    $("mainPanel").classList.toggle("hidden", !authorized);

    if (!authorized) {
      $("status").textContent = "approval needed";
      return;
    }

    const connected = Boolean(result.nativeHost.connected);
    $("status").textContent = connected ? (result.capture.enabled ? "capture on" : "connected") : "disconnected";
    $("hostDetail").textContent = connected
      ? result.nativeHost.host
      : (result.nativeHost.lastError || "Native host unavailable");
    $("scriptsDetail").textContent = result.userScriptsAvailable
      ? "User scripts enabled"
      : "Enable Allow User Scripts in extension details";
    $("urlPattern").value = result.capture.urlPattern || "";
    $("allUrls").checked = Boolean(result.capture.allUrls);
    $("includeSecrets").checked = Boolean(result.capture.includeSecrets);
    $("captureBody").checked = Boolean(result.capture.captureRequestBody);
    updatePermissionButton("grantCookies", "cookies", result.permissions.cookies);
    updatePermissionButton("grantDebugger", "DevTools", result.permissions.debugger);
  } catch (error) {
    $("status").textContent = "error";
    setOutput(errorMessage(error));
  }
}

function updatePermissionButton(id, label, granted) {
  const button = $(id);
  button.textContent = granted ? `${label} enabled` : `Enable ${label}`;
  button.disabled = granted;
}

async function run(action) {
  try {
    await action();
  } catch (error) {
    setOutput(errorMessage(error));
  }
}

function command(type, params) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, params }, response => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response?.ok) reject(new Error(response?.error || "Unknown error"));
      else resolve(response.result);
    });
  });
}

function setOutput(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const output = $("output");
  if (output) output.textContent = text;
  if (!$("consentPanel").classList.contains("hidden")) $("consentError").textContent = text;
}

function errorMessage(error) {
  return String(error?.message || error);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
