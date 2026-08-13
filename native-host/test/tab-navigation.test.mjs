import assert from "node:assert/strict";
import test from "node:test";

import {
  createTabAndWait,
  navigateTabAndWait
} from "../../extension/tab-navigation.js";

test("createTabAndWait waits for a fresh tab URL to commit", async () => {
  const tabs = fakeTabs();
  tabs.createResult = tab({ id: 91, url: "", status: "loading" });
  tabs.current = tab({ id: 91, url: "chrome://newtab/", status: "loading" });

  const created = createTabAndWait(tabs, {
    url: "https://example.test/",
    active: false
  }, 100);
  queueMicrotask(() => tabs.commit("https://example.test/"));

  assert.equal((await created).url, "https://example.test/");
  assert.equal(tabs.onUpdated.listenerCount, 0);
});

test("navigateTabAndWait does not return stale chrome new-tab metadata", async () => {
  const tabs = fakeTabs();
  tabs.current = tab({ id: 42, url: "chrome://newtab/", status: "complete" });
  tabs.updateResult = tab({ id: 42, url: "chrome://new-tab-page/", status: "loading" });

  const navigated = navigateTabAndWait(tabs, 42, "https://example.test/", 100);
  queueMicrotask(() => tabs.commit("https://example.test/"));

  assert.equal((await navigated).url, "https://example.test/");
  assert.equal(tabs.onUpdated.listenerCount, 0);
});

test("navigateTabAndWait accepts the committed redirect URL", async () => {
  const tabs = fakeTabs();
  tabs.current = tab({ id: 42, url: "https://old.test/", status: "complete" });
  tabs.updateResult = tab({ id: 42, url: "https://old.test/", status: "loading" });

  const navigated = navigateTabAndWait(tabs, 42, "https://redirect.test/", 100);
  queueMicrotask(() => tabs.commit("https://final.test/"));

  assert.equal((await navigated).url, "https://final.test/");
  assert.equal(tabs.onUpdated.listenerCount, 0);
});

test("navigateTabAndWait removes its listener when navigation fails", async () => {
  const tabs = fakeTabs();
  tabs.current = tab({ id: 42, url: "https://old.test/", status: "complete" });
  tabs.updateError = new Error("navigation rejected");

  await assert.rejects(
    navigateTabAndWait(tabs, 42, "https://example.test/", 100),
    /navigation rejected/
  );
  assert.equal(tabs.onUpdated.listenerCount, 0);
});

test("navigateTabAndWait times out cleanly when the URL never commits", async () => {
  const tabs = fakeTabs();
  tabs.current = tab({ id: 42, url: "chrome://newtab/", status: "loading" });
  tabs.updateResult = tabs.current;

  await assert.rejects(
    navigateTabAndWait(tabs, 42, "https://example.test/", 10),
    /Timed out waiting for tab 42/
  );
  assert.equal(tabs.onUpdated.listenerCount, 0);
});

function fakeTabs() {
  const listeners = new Set();
  return {
    current: null,
    createResult: null,
    updateResult: null,
    updateError: null,
    onUpdated: {
      addListener(listener) {
        listeners.add(listener);
      },
      removeListener(listener) {
        listeners.delete(listener);
      },
      get listenerCount() {
        return listeners.size;
      }
    },
    async create() {
      return this.createResult;
    },
    async get() {
      return this.current;
    },
    async update() {
      if (this.updateError) throw this.updateError;
      return this.updateResult;
    },
    commit(url) {
      this.current = tab({ id: this.current?.id || 42, url, status: "loading" });
      for (const listener of listeners) {
        listener(this.current.id, { url, status: "loading" }, this.current);
      }
    }
  };
}

function tab(overrides) {
  return {
    id: 42,
    windowId: 7,
    index: 1,
    active: false,
    title: "",
    url: "",
    status: "complete",
    ...overrides
  };
}
