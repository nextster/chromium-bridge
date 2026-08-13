const token = new URLSearchParams(location.search).get("token") || "manual";
const storageKey = `reload-token:${token}`;
const stored = await chrome.storage.local.get(storageKey);

if (stored[storageKey]) {
  document.getElementById("status").textContent = "Chromium Sidecar is updated.";
} else {
  await chrome.storage.local.set({ [storageKey]: true });
  setTimeout(() => chrome.runtime.reload(), 500);
}
