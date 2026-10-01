// Messages that Bridge-managed user scripts may send with chrome.runtime.sendMessage.
// Messaging is enabled for the USER_SCRIPT world only, so these handlers never see page scripts.

export const OPEN_IN_EXISTING_TAB = "tabs.openInExistingTab";

export function createUserScriptMessageHandler({ tabs, windows, extensionId, requireAccess }) {
  return (message, sender, sendResponse) => {
    if (sender?.id !== extensionId) {
      sendResponse({ ok: false, error: "Untrusted user script sender" });
      return false;
    }
    handleUserScriptMessage(message || {}, sender, { tabs, windows, requireAccess })
      .then(result => sendResponse({ ok: true, result }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  };
}

async function handleUserScriptMessage(message, sender, api) {
  switch (message.type) {
    case OPEN_IN_EXISTING_TAB:
      await api.requireAccess();
      return openInExistingTab(api, message.url, sender.tab);
    default:
      throw new Error(`Unknown user script message: ${message.type}`);
  }
}

// Loads `url` in an already open tab of the same site and switches to it, so a pinned tab
// (or an Arc sidebar tab) is reused instead of piling up new ones. Opens a new tab otherwise.
export async function openInExistingTab({ tabs, windows }, value, senderTab) {
  const url = httpUrl(value);
  const target = pickReusableTab(await tabs.query({}), url, senderTab);
  if (!target) {
    const created = await tabs.create({
      url: url.href,
      active: true,
      ...(Number.isInteger(senderTab?.id) ? { openerTabId: senderTab.id } : {})
    });
    return { reused: false, tabId: created.id };
  }
  await tabs.update(target.id, { url: url.href, active: true });
  if (Number.isInteger(target.windowId)) await windows.update(target.windowId, { focused: true });
  return { reused: true, tabId: target.id };
}

// Arc does not report its sidebar pins as `pinned`, so any tab of the same host qualifies;
// real pins, the sender's window, and recent use break ties.
export function pickReusableTab(candidates, url, senderTab) {
  const host = url.hostname;
  const score = tab => [
    tab.pinned ? 1 : 0,
    tab.windowId === senderTab?.windowId ? 1 : 0,
    Number(tab.lastAccessed) || 0
  ];
  return candidates
    .filter(tab => Number.isInteger(tab.id) && tab.id !== senderTab?.id && !tab.incognito && hostOf(tab.url) === host)
    .sort((a, b) => compareScores(score(b), score(a)))[0] || null;
}

function compareScores(a, b) {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function hostOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function httpUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("url must be an absolute http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("url must be an absolute http(s) URL");
  }
  return url;
}
