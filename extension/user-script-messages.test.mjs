import assert from "node:assert/strict";
import test from "node:test";
import {
  OPEN_IN_EXISTING_TAB,
  createUserScriptMessageHandler,
  openInExistingTab,
  pickReusableTab
} from "./user-script-messages.js";

const SEARCH = "https://rutracker.net/forum/tracker.php?nm=Heat";

test("pickReusableTab prefers pinned, then the sender's window, then the most recent tab of the same host", () => {
  const sender = { id: 1, windowId: 10 };
  const tabs = [
    { id: 2, windowId: 20, url: "https://rutracker.net/forum/index.php", lastAccessed: 900 },
    { id: 3, windowId: 10, url: "https://rutracker.net/forum/viewforum.php", lastAccessed: 100 },
    { id: 4, windowId: 10, url: "https://rutracker.net/", lastAccessed: 500 },
    { id: 5, windowId: 10, url: "https://letterboxd.com/", lastAccessed: 999 }
  ];
  assert.equal(pickReusableTab(tabs, new URL(SEARCH), sender).id, 4);
  assert.equal(pickReusableTab([...tabs, { id: 6, windowId: 20, pinned: true, url: "https://rutracker.net/" }], new URL(SEARCH), sender).id, 6);
});

test("pickReusableTab ignores the sender, other hosts, incognito, and tabs without ids", () => {
  const sender = { id: 1, windowId: 10, url: "https://rutracker.net/" };
  const tabs = [
    sender,
    { id: 2, incognito: true, url: "https://rutracker.net/" },
    { url: "https://rutracker.net/" },
    { id: 3, url: "https://rutracker.org/" }
  ];
  assert.equal(pickReusableTab(tabs, new URL(SEARCH), sender), null);
});

test("openInExistingTab navigates and focuses a matching tab", async () => {
  const api = fakeApi([{ id: 7, windowId: 3, url: "https://rutracker.net/forum/index.php" }]);
  const result = await openInExistingTab(api, SEARCH, { id: 1, windowId: 3 });
  assert.deepEqual(result, { reused: true, tabId: 7 });
  assert.deepEqual(api.calls, [
    ["tabs.update", 7, { url: SEARCH, active: true }],
    ["windows.update", 3, { focused: true }]
  ]);
});

test("openInExistingTab opens a new tab when none matches", async () => {
  const api = fakeApi([]);
  const result = await openInExistingTab(api, SEARCH, { id: 1, windowId: 3 });
  assert.deepEqual(result, { reused: false, tabId: 99 });
  assert.deepEqual(api.calls, [["tabs.create", { url: SEARCH, active: true, openerTabId: 1 }]]);
});

test("openInExistingTab rejects non-http URLs", async () => {
  for (const url of ["javascript:alert(1)", "data:text/html,x", "chrome://settings", "/relative", undefined]) {
    await assert.rejects(openInExistingTab(fakeApi([]), url, {}), /absolute http\(s\) URL/);
  }
});

test("the message handler checks the sender and browser access", async () => {
  const api = fakeApi([]);
  let accessChecks = 0;
  const handler = createUserScriptMessageHandler({
    ...api,
    extensionId: "bridge",
    requireAccess: async () => { accessChecks += 1; }
  });

  assert.deepEqual(await send(handler, { type: OPEN_IN_EXISTING_TAB, url: SEARCH }, { id: "other" }), {
    ok: false,
    error: "Untrusted user script sender"
  });
  assert.equal(accessChecks, 0);

  assert.deepEqual(await send(handler, { type: OPEN_IN_EXISTING_TAB, url: SEARCH }, { id: "bridge", tab: { id: 1 } }), {
    ok: true,
    result: { reused: false, tabId: 99 }
  });
  assert.equal(accessChecks, 1);

  assert.equal((await send(handler, { type: "tabs.close" }, { id: "bridge" })).ok, false);
});

function send(handler, message, sender) {
  return new Promise(resolve => handler(message, sender, resolve));
}

function fakeApi(openTabs) {
  const calls = [];
  return {
    calls,
    tabs: {
      query: async () => openTabs,
      update: async (id, properties) => { calls.push(["tabs.update", id, properties]); return { id }; },
      create: async properties => { calls.push(["tabs.create", properties]); return { id: 99 }; }
    },
    windows: {
      update: async (id, properties) => { calls.push(["windows.update", id, properties]); return { id }; }
    }
  };
}
