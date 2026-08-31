import assert from "node:assert/strict";
import test from "node:test";
import {
  MANAGED_SCRIPT_ID_PREFIX,
  MANAGED_SCRIPTS_SCHEMA_VERSION,
  MANAGED_SCRIPTS_STORAGE_KEY,
  MAX_MANAGED_SCRIPT_CHARS,
  ManagedScriptsManager,
  normalizeManagedScript,
  validateMatchPattern
} from "./managed-scripts.js";

test("upsert registers, updates, persists, disables, re-enables, and removes a managed script", async () => {
  const fixture = createFixture();
  const manager = fixture.manager();
  const original = script({ js: "window.bridgeVersion = 1;" });

  const created = await manager.upsert(original);
  assert.equal(created.changed, true);
  assert.equal(created.registrationChanged, true);
  assert.deepEqual(fixture.calls.register, [`${MANAGED_SCRIPT_ID_PREFIX}youtube-cleanup`]);
  assert.equal(fixture.state()[MANAGED_SCRIPTS_STORAGE_KEY].version, MANAGED_SCRIPTS_SCHEMA_VERSION);
  assert.deepEqual((await manager.get("youtube-cleanup")).js, original.js);
  assert.equal((await manager.list())[0].js, undefined);
  assert.equal((await manager.list())[0].jsChars, original.js.length);

  const unchanged = await manager.upsert(original);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.registrationChanged, false);
  assert.equal(fixture.calls.update.length, 0);

  const updated = await manager.upsert({ ...original, js: "window.bridgeVersion = 2;" });
  assert.equal(updated.registrationChanged, true);
  assert.deepEqual(fixture.calls.update, [`${MANAGED_SCRIPT_ID_PREFIX}youtube-cleanup`]);

  const disabled = await manager.enable("youtube-cleanup", false);
  assert.equal(disabled.script.enabled, false);
  assert.equal(fixture.state()[MANAGED_SCRIPTS_STORAGE_KEY].scripts["youtube-cleanup"].enabled, false);
  assert.deepEqual(fixture.calls.unregister.at(-1), [`${MANAGED_SCRIPT_ID_PREFIX}youtube-cleanup`]);

  await manager.enable("youtube-cleanup", true);
  assert.equal(fixture.registered().has(`${MANAGED_SCRIPT_ID_PREFIX}youtube-cleanup`), true);

  const removed = await manager.remove("youtube-cleanup");
  assert.equal(removed.removed, true);
  assert.equal(fixture.state()[MANAGED_SCRIPTS_STORAGE_KEY].scripts["youtube-cleanup"], undefined);
  assert.equal(fixture.registered().has(`${MANAGED_SCRIPT_ID_PREFIX}youtube-cleanup`), false);
});

test("startup reconciliation restores persisted enabled scripts and leaves disabled scripts unregistered", async () => {
  const fixture = createFixture();
  const first = fixture.manager();
  await first.upsert(script());
  await first.upsert(script({ id: "disabled", name: "Disabled", enabled: false }));
  fixture.registered().clear();

  const restarted = fixture.manager();
  const result = await restarted.reconcile();
  assert.equal(result.stored, 2);
  assert.equal(result.enabled, 1);
  assert.equal(result.registered, 1);
  assert.equal(fixture.registered().has(`${MANAGED_SCRIPT_ID_PREFIX}youtube-cleanup`), true);
  assert.equal(fixture.registered().has(`${MANAGED_SCRIPT_ID_PREFIX}disabled`), false);
});

test("reconciliation updates owned scripts, removes owned orphans, and never touches foreign ids", async () => {
  const desired = script({ js: "document.body.dataset.bridge = 'current';" });
  const fixture = createFixture({
    stored: storageState([desired]),
    registered: [
      registration(script({ js: "document.body.dataset.bridge = 'old';" })),
      { ...registration(script({ id: "orphan", name: "Orphan" })), id: `${MANAGED_SCRIPT_ID_PREFIX}orphan` },
      { ...registration(script({ id: "foreign", name: "Foreign" })), id: "tampermonkey:foreign" }
    ]
  });

  const result = await fixture.manager().reconcile();
  assert.deepEqual(result.changes, { registered: 0, updated: 1, unregistered: 1 });
  assert.equal(fixture.registered().has(`${MANAGED_SCRIPT_ID_PREFIX}orphan`), false);
  assert.equal(fixture.registered().has("tampermonkey:foreign"), true);
  assert.deepEqual(fixture.calls.unregister, [[`${MANAGED_SCRIPT_ID_PREFIX}orphan`]]);
});

test("consent-off reconciliation unregisters only Bridge-owned scripts even if storage is unreadable", async () => {
  const fixture = createFixture({
    stored: { [MANAGED_SCRIPTS_STORAGE_KEY]: { version: 999, scripts: {} } },
    registered: [
      registration(script()),
      { ...registration(script({ id: "foreign", name: "Foreign" })), id: "arc-boost:youtube" }
    ]
  });

  await assert.rejects(fixture.manager().reconcile({ registerEnabled: false }), /Unsupported managed scripts storage version/);
  assert.equal(fixture.registered().has(`${MANAGED_SCRIPT_ID_PREFIX}youtube-cleanup`), false);
  assert.equal(fixture.registered().has("arc-boost:youtube"), true);
});

test("commands reject unsafe ids and never unregister a foreign script id", async () => {
  const fixture = createFixture({
    registered: [{ ...registration(script()), id: "tampermonkey:youtube-cleanup" }]
  });
  await assert.rejects(fixture.manager().remove("tampermonkey:youtube-cleanup"), /id must start/);
  assert.equal(fixture.registered().has("tampermonkey:youtube-cleanup"), true);
  assert.equal(fixture.calls.unregister.length, 0);
});

test("validation accepts only bounded http and https scripts", () => {
  assert.equal(validateMatchPattern("https://www.youtube.com/*"), "https://www.youtube.com/*");
  assert.equal(validateMatchPattern("http://localhost/*"), "http://localhost/*");
  for (const pattern of [
    "<all_urls>",
    "file:///*",
    "chrome://extensions/*",
    "ftp://example.com/*",
    "https://exa*mple.com/*",
    "https://-example.com/*",
    "https://user@example.com/*"
  ]) {
    assert.throws(() => validateMatchPattern(pattern), /not allowed|only http|Invalid host/);
  }
  assert.throws(
    () => normalizeManagedScript(script({ js: "x".repeat(MAX_MANAGED_SCRIPT_CHARS + 1) })),
    /js exceeds/
  );
  assert.throws(() => normalizeManagedScript(script({ matches: ["https://example.com/*", "https://example.com/*"] })), /duplicates/);
  assert.throws(() => normalizeManagedScript(script({ runAt: "before_load" })), /runAt must be one of/);
  assert.throws(() => normalizeManagedScript(script({ world: "ISOLATED" })), /world must be one of/);
  assert.throws(() => normalizeManagedScript(script({ name: 42 })), /Missing name/);
});

function script(overrides = {}) {
  return {
    id: "youtube-cleanup",
    name: "YouTube cleanup",
    matches: ["https://www.youtube.com/*"],
    js: "document.body.dataset.bridge = 'managed';",
    enabled: true,
    runAt: "document_idle",
    world: "USER_SCRIPT",
    ...overrides
  };
}

function storageState(scripts) {
  return {
    [MANAGED_SCRIPTS_STORAGE_KEY]: {
      version: MANAGED_SCRIPTS_SCHEMA_VERSION,
      scripts: Object.fromEntries(scripts.map(item => [item.id, structuredClone(item)]))
    }
  };
}

function registration(value) {
  return {
    id: `${MANAGED_SCRIPT_ID_PREFIX}${value.id}`,
    matches: [...value.matches],
    js: [{ code: value.js }],
    runAt: value.runAt,
    world: value.world
  };
}

function createFixture({ stored = {}, registered = [] } = {}) {
  let values = structuredClone(stored);
  const scripts = new Map(registered.map(item => [item.id, structuredClone(item)]));
  const calls = { register: [], update: [], unregister: [], set: 0 };
  const storage = {
    async get(key) {
      return { [key]: structuredClone(values[key]) };
    },
    async set(next) {
      values = { ...values, ...structuredClone(next) };
      calls.set += 1;
    }
  };
  const userScripts = {
    async getScripts(filter = {}) {
      const ids = filter.ids ? new Set(filter.ids) : null;
      return [...scripts.values()].filter(item => !ids || ids.has(item.id)).map(item => structuredClone(item));
    },
    async register(items) {
      for (const item of items) {
        if (scripts.has(item.id)) throw new Error(`duplicate registration ${item.id}`);
        scripts.set(item.id, structuredClone(item));
        calls.register.push(item.id);
      }
    },
    async update(items) {
      for (const item of items) {
        if (!scripts.has(item.id)) throw new Error(`missing registration ${item.id}`);
        scripts.set(item.id, structuredClone(item));
        calls.update.push(item.id);
      }
    },
    async unregister({ ids }) {
      calls.unregister.push([...ids]);
      for (const id of ids) scripts.delete(id);
    }
  };
  return {
    calls,
    manager: () => new ManagedScriptsManager({ storage, userScripts }),
    registered: () => scripts,
    state: () => structuredClone(values)
  };
}
