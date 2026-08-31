import {
  NEW_SCRIPT_DEFAULTS,
  formatMatchPatterns,
  matchesSearch,
  scriptFromFields
} from "./scripts-page-model.js";

const $ = id => document.getElementById(id);
let scripts = [];
let selectedId = null;
let busy = false;

$("reloadScripts").addEventListener("click", () => run(refresh));
$("openDataFolder").addEventListener("click", () => run(async () => {
  const result = await command("native.openDataFolder", {});
  setMessage(`Opened ${result.path}`);
}));
$("newScript").addEventListener("click", () => selectNewScript());
$("searchScripts").addEventListener("input", renderList);
$("scriptForm").addEventListener("submit", event => {
  event.preventDefault();
  void run(saveScript);
});
$("deleteScript").addEventListener("click", () => run(removeSelectedScript));

selectNewScript();
void refresh();

async function refresh() {
  const ping = await command("ping", {});
  if (!ping.privacy.consented || !ping.permissions.siteAccess || !ping.permissions.tabs) {
    throw new Error("Approve local browser access from the Chromium Bridge popup first");
  }
  if (!ping.userScriptsAvailable) {
    throw new Error("Enable Allow User Scripts in the Chromium Bridge extension details");
  }
  scripts = await command("managedScripts.list", {});
  setConnection(
    ping.nativeHost.connected ? `${scripts.length} managed script${scripts.length === 1 ? "" : "s"}` : "Native host disconnected",
    !ping.nativeHost.connected
  );
  renderList();
  if (selectedId && scripts.some(script => script.id === selectedId)) {
    await loadScript(selectedId);
  } else if (selectedId) {
    selectNewScript();
  }
}

async function loadScript(id) {
  const script = await command("managedScripts.get", { id });
  selectedId = script.id;
  writeForm(script);
  $("scriptId").disabled = true;
  $("editorTitle").textContent = script.name;
  $("registrationState").textContent = script.registered ? "Registered" : "Not registered";
  $("deleteScript").classList.remove("hidden");
  renderList();
  setMessage("");
}

function selectNewScript() {
  selectedId = null;
  writeForm(NEW_SCRIPT_DEFAULTS);
  $("scriptId").disabled = false;
  $("editorTitle").textContent = "New script";
  $("registrationState").textContent = "";
  $("deleteScript").classList.add("hidden");
  renderList();
  setMessage("");
  $("scriptId").focus();
}

async function saveScript() {
  const payload = scriptFromFields({
    id: $("scriptId").value,
    name: $("scriptName").value,
    matches: $("scriptMatches").value,
    js: $("scriptCode").value,
    enabled: $("scriptEnabled").checked,
    runAt: $("scriptRunAt").value,
    world: $("scriptWorld").value
  });
  const result = await command("managedScripts.upsert", payload);
  selectedId = result.script.id;
  await refresh();
  setMessage(result.changed ? "Saved" : "No changes");
}

async function removeSelectedScript() {
  if (!selectedId) return;
  const script = scripts.find(item => item.id === selectedId);
  if (!confirm(`Delete “${script?.name || selectedId}”?`)) return;
  await command("managedScripts.remove", { id: selectedId });
  scripts = scripts.filter(item => item.id !== selectedId);
  selectNewScript();
  renderList();
  setMessage("Deleted");
}

async function setEnabled(id, enabled) {
  await command("managedScripts.enable", { id, enabled });
  const item = scripts.find(script => script.id === id);
  if (item) {
    item.enabled = enabled;
    item.registered = enabled;
  }
  if (selectedId === id) {
    $("scriptEnabled").checked = enabled;
    $("registrationState").textContent = enabled ? "Registered" : "Not registered";
  }
  renderList();
}

function renderList() {
  const list = $("scriptList");
  list.replaceChildren();
  const visible = scripts.filter(script => matchesSearch(script, $("searchScripts").value));
  $("emptyList").classList.toggle("hidden", visible.length > 0);

  for (const script of visible) {
    const row = document.createElement("div");
    row.className = `script-row${script.id === selectedId ? " selected" : ""}`;

    const select = document.createElement("button");
    select.type = "button";
    select.className = "script-select";
    select.addEventListener("click", () => run(() => loadScript(script.id)));

    const name = document.createElement("span");
    name.className = "script-name";
    name.textContent = script.name;
    const meta = document.createElement("span");
    meta.className = "script-meta";
    meta.textContent = `${script.id} · ${script.matches.length} site pattern${script.matches.length === 1 ? "" : "s"}`;
    select.append(name, meta);

    const toggleLabel = document.createElement("label");
    toggleLabel.className = "quick-toggle";
    toggleLabel.title = script.enabled ? "Disable script" : "Enable script";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = script.enabled;
    toggle.setAttribute("aria-label", `${script.enabled ? "Disable" : "Enable"} ${script.name}`);
    toggle.addEventListener("change", () => run(() => setEnabled(script.id, toggle.checked)));
    toggleLabel.append(toggle);

    row.append(select, toggleLabel);
    list.append(row);
  }
}

function writeForm(script) {
  $("scriptId").value = script.id || "";
  $("scriptName").value = script.name || "";
  $("scriptMatches").value = formatMatchPatterns(script.matches);
  $("scriptCode").value = script.js || "";
  $("scriptEnabled").checked = script.enabled !== false;
  $("scriptRunAt").value = script.runAt || "document_idle";
  $("scriptWorld").value = script.world || "USER_SCRIPT";
}

async function run(action) {
  if (busy) return;
  busy = true;
  document.body.classList.add("busy");
  try {
    await action();
  } catch (error) {
    setMessage(errorMessage(error), true);
    setConnection("Error", true);
  } finally {
    busy = false;
    document.body.classList.remove("busy");
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

function setConnection(message, error = false) {
  $("connectionStatus").textContent = message;
  $("connectionStatus").classList.toggle("error", error);
}

function setMessage(message, error = false) {
  $("formMessage").textContent = message;
  $("formMessage").classList.toggle("error", error);
}

function errorMessage(error) {
  return String(error?.message || error);
}
