const $ = id => document.getElementById(id);

refresh();

$("reconnect").addEventListener("click", () => run(async () => {
  await command("native.reconnect", {});
  await delay(1500);
  await refresh();
}));

$("startCapture").addEventListener("click", () => run(async () => {
  const result = await command("capture.start", {
    includeSecrets: $("includeSecrets").checked,
    urlPattern: $("urlPattern").value.trim(),
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

async function refresh() {
  try {
    const result = await command("ping", {});
    const connected = Boolean(result.nativeHost.connected);
    $("status").textContent = connected ? (result.capture.enabled ? "capture on" : "connected") : "disconnected";
    $("hostDetail").textContent = connected ? result.nativeHost.host : (result.nativeHost.lastError || "Native host unavailable");
    $("scriptsDetail").textContent = result.userScriptsAvailable ? "User scripts enabled" : "Enable Allow User Scripts in extension details";
    $("urlPattern").value = result.capture.urlPattern || "";
    $("includeSecrets").checked = Boolean(result.capture.includeSecrets);
    $("captureBody").checked = Boolean(result.capture.captureRequestBody);
  } catch (error) {
    $("status").textContent = "error";
    setOutput(errorMessage(error));
  }
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
  $("output").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function errorMessage(error) {
  return String(error?.message || error);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
