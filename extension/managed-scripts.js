export const MANAGED_SCRIPTS_STORAGE_KEY = "managedScripts";
export const MANAGED_SCRIPTS_SCHEMA_VERSION = 1;
export const MANAGED_SCRIPT_ID_PREFIX = "chromium-bridge-managed:";
export const MAX_MANAGED_SCRIPT_CHARS = 256 * 1024;
export const MAX_MANAGED_SCRIPT_COUNT = 64;
export const MAX_MANAGED_SCRIPT_TOTAL_CHARS = 4 * 1024 * 1024;

const MAX_NAME_CHARS = 128;
const MAX_MATCHES = 100;
const MAX_MATCH_PATTERN_CHARS = 2048;
const ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const RUN_AT_VALUES = new Set(["document_start", "document_end", "document_idle"]);
const WORLD_VALUES = new Set(["USER_SCRIPT", "MAIN"]);

export class ManagedScriptsManager {
  constructor({ storage, userScripts }) {
    if (!storage?.get || !storage?.set) throw new Error("Managed scripts require chrome.storage.local");
    if (!userScripts) throw new Error("Managed scripts require chrome.userScripts");
    this.storage = storage;
    this.userScripts = userScripts;
    this.queue = Promise.resolve();
  }

  list() {
    return this.exclusive(async () => {
      const state = await this.loadState();
      const registeredIds = await this.registeredOwnedIds();
      return Object.values(state.scripts)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(script => summarizeScript(script, registeredIds.has(registeredScriptId(script.id))));
    });
  }

  get(id) {
    return this.exclusive(async () => {
      const safeId = validateManagedScriptId(id);
      const state = await this.loadState();
      const script = state.scripts[safeId];
      if (!script) throw new Error(`Managed script "${safeId}" was not found`);
      const registeredIds = await this.registeredOwnedIds();
      return {
        ...script,
        registered: registeredIds.has(registeredScriptId(script.id))
      };
    });
  }

  upsert(input) {
    return this.exclusive(async () => {
      const script = normalizeManagedScript(input);
      const previous = await this.loadState();
      const next = cloneState(previous);
      next.scripts[script.id] = script;
      validateStateLimits(next);
      const changed = !sameScript(previous.scripts[script.id], script);
      return this.persistAndApply(previous, next, async () => ({
        script: summarizeScript(script, script.enabled),
        changed,
        registrationChanged: await this.syncScript(script)
      }));
    });
  }

  enable(id, enabled) {
    return this.exclusive(async () => {
      const safeId = validateManagedScriptId(id);
      if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
      const previous = await this.loadState();
      const existing = previous.scripts[safeId];
      if (!existing) throw new Error(`Managed script "${safeId}" was not found`);
      const script = { ...existing, enabled };
      const next = cloneState(previous);
      next.scripts[safeId] = script;
      return this.persistAndApply(previous, next, async () => ({
        script: summarizeScript(script, enabled),
        changed: existing.enabled !== enabled,
        registrationChanged: await this.syncScript(script)
      }));
    });
  }

  remove(id) {
    return this.exclusive(async () => {
      const safeId = validateManagedScriptId(id);
      const previous = await this.loadState();
      const next = cloneState(previous);
      const removed = Boolean(next.scripts[safeId]);
      delete next.scripts[safeId];
      return this.persistAndApply(previous, next, async () => ({
        id: safeId,
        removed,
        registrationChanged: await this.unregisterIfPresent(registeredScriptId(safeId))
      }));
    });
  }

  reconcile({ registerEnabled = true } = {}) {
    return this.exclusive(async () => {
      const registered = await this.registeredOwnedScripts();
      if (!registerEnabled) {
        for (const [id] of registered) await this.userScripts.unregister({ ids: [id] });
        const state = await this.loadState();
        return {
          schemaVersion: MANAGED_SCRIPTS_SCHEMA_VERSION,
          stored: Object.keys(state.scripts).length,
          enabled: Object.values(state.scripts).filter(script => script.enabled).length,
          registered: 0,
          changes: { registered: 0, updated: 0, unregistered: registered.size }
        };
      }

      const state = await this.loadState();
      const desired = new Map();
      for (const script of Object.values(state.scripts)) {
        if (script.enabled) desired.set(registeredScriptId(script.id), script);
      }

      let registeredCount = 0;
      let updatedCount = 0;
      let unregisteredCount = 0;
      for (const [id] of registered) {
        if (desired.has(id)) continue;
        await this.userScripts.unregister({ ids: [id] });
        unregisteredCount += 1;
      }
      for (const [id, script] of desired) {
        const current = registered.get(id);
        if (!current) {
          await this.userScripts.register([registrationFor(script)]);
          registeredCount += 1;
        } else if (!sameRegistration(current, script)) {
          await this.userScripts.update([registrationFor(script)]);
          updatedCount += 1;
        }
      }
      return {
        schemaVersion: MANAGED_SCRIPTS_SCHEMA_VERSION,
        stored: Object.keys(state.scripts).length,
        enabled: Object.values(state.scripts).filter(script => script.enabled).length,
        registered: desired.size,
        changes: { registered: registeredCount, updated: updatedCount, unregistered: unregisteredCount }
      };
    });
  }

  async persistAndApply(previous, next, apply) {
    await this.saveState(next);
    try {
      return await apply();
    } catch (error) {
      await this.saveState(previous).catch(() => {});
      await this.restoreRegistrations(previous).catch(() => {});
      throw new Error(`Managed script operation failed and was rolled back: ${errorMessage(error)}`);
    }
  }

  async restoreRegistrations(state) {
    const registered = await this.registeredOwnedScripts();
    const desired = new Map(
      Object.values(state.scripts)
        .filter(script => script.enabled)
        .map(script => [registeredScriptId(script.id), script])
    );
    for (const [id] of registered) {
      if (!desired.has(id)) await this.userScripts.unregister({ ids: [id] });
    }
    for (const [id, script] of desired) {
      const current = registered.get(id);
      if (!current) await this.userScripts.register([registrationFor(script)]);
      else if (!sameRegistration(current, script)) await this.userScripts.update([registrationFor(script)]);
    }
  }

  async syncScript(script) {
    const id = registeredScriptId(script.id);
    const current = (await this.userScripts.getScripts({ ids: [id] }))[0];
    if (!script.enabled) {
      if (!current) return false;
      await this.userScripts.unregister({ ids: [id] });
      return true;
    }
    if (!current) {
      await this.userScripts.register([registrationFor(script)]);
      return true;
    }
    if (sameRegistration(current, script)) return false;
    await this.userScripts.update([registrationFor(script)]);
    return true;
  }

  async unregisterIfPresent(id) {
    const current = await this.userScripts.getScripts({ ids: [id] });
    if (!current.length) return false;
    await this.userScripts.unregister({ ids: [id] });
    return true;
  }

  async registeredOwnedIds() {
    return new Set((await this.registeredOwnedScripts()).keys());
  }

  async registeredOwnedScripts() {
    const scripts = await this.userScripts.getScripts();
    return new Map(scripts
      .filter(script => isManagedRegistrationId(script.id))
      .map(script => [script.id, script]));
  }

  async loadState() {
    const stored = await this.storage.get(MANAGED_SCRIPTS_STORAGE_KEY);
    const raw = stored?.[MANAGED_SCRIPTS_STORAGE_KEY];
    if (raw == null) return emptyState();
    if (!raw || Array.isArray(raw) || typeof raw !== "object") {
      throw new Error("Managed scripts storage is invalid: expected an object");
    }
    if (raw.version !== MANAGED_SCRIPTS_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported managed scripts storage version ${String(raw.version)}; expected ${MANAGED_SCRIPTS_SCHEMA_VERSION}`
      );
    }
    if (!raw.scripts || Array.isArray(raw.scripts) || typeof raw.scripts !== "object") {
      throw new Error("Managed scripts storage is invalid: scripts must be an object");
    }
    const state = emptyState();
    for (const [id, value] of Object.entries(raw.scripts)) {
      const script = normalizeManagedScript(value, { requireAll: true });
      if (script.id !== id) throw new Error(`Managed scripts storage key "${id}" does not match script id "${script.id}"`);
      state.scripts[id] = script;
    }
    validateStateLimits(state);
    return state;
  }

  saveState(state) {
    validateStateLimits(state);
    return this.storage.set({ [MANAGED_SCRIPTS_STORAGE_KEY]: cloneState(state) });
  }

  exclusive(action) {
    const operation = this.queue.then(action, action);
    this.queue = operation.catch(() => {});
    return operation;
  }
}

export function normalizeManagedScript(value, { requireAll = false } = {}) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Managed script must be an object");
  }
  const id = validateManagedScriptId(value.id);
  const name = requiredString(value.name, "name").trim();
  if (name.length > MAX_NAME_CHARS) throw new Error(`name exceeds ${MAX_NAME_CHARS} characters`);
  const matches = validateMatches(value.matches);
  if (typeof value.js !== "string" || value.js.length === 0) throw new Error("js must be a non-empty string");
  if (value.js.length > MAX_MANAGED_SCRIPT_CHARS) {
    throw new Error(`js exceeds ${MAX_MANAGED_SCRIPT_CHARS} characters`);
  }
  const enabled = booleanValue(value.enabled, "enabled", requireAll ? undefined : true);
  const runAt = enumValue(value.runAt, "runAt", RUN_AT_VALUES, requireAll ? undefined : "document_idle");
  const world = enumValue(value.world, "world", WORLD_VALUES, requireAll ? undefined : "USER_SCRIPT");
  return { id, name, matches, js: value.js, enabled, runAt, world };
}

export function validateManagedScriptId(value) {
  const id = typeof value === "string" ? value : "";
  if (!ID_PATTERN.test(id)) {
    throw new Error("id must start with a lowercase letter and contain only lowercase letters, digits, dot, underscore, or hyphen (maximum 64 characters)");
  }
  return id;
}

export function validateMatchPattern(value) {
  const pattern = typeof value === "string" ? value : "";
  if (!pattern) throw new Error("match pattern must not be empty");
  if (pattern === "<all_urls>") throw new Error("<all_urls> is not allowed for managed scripts");
  if (pattern.length > MAX_MATCH_PATTERN_CHARS) {
    throw new Error(`match pattern exceeds ${MAX_MATCH_PATTERN_CHARS} characters`);
  }
  const match = /^(https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!match) throw new Error(`Invalid match pattern "${pattern}": only http:// or https:// patterns are allowed`);
  const host = match[2];
  if (/\s|@/.test(host) || (host.includes("*") && host !== "*" && !/^\*\.[a-z0-9.-]+$/i.test(host))) {
    throw new Error(`Invalid host in match pattern "${pattern}"`);
  }
  const plainHost = host.startsWith("*.") ? host.slice(2) : host;
  const hostname = /^\[[0-9a-f:]+\]$/i.test(plainHost) || plainHost.split(".").every(label =>
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  );
  if (host !== "*" && (!hostname || plainHost.startsWith(".") || plainHost.endsWith(".") || plainHost.includes(".."))) {
    throw new Error(`Invalid host in match pattern "${pattern}"`);
  }
  return pattern;
}

export function registeredScriptId(id) {
  return `${MANAGED_SCRIPT_ID_PREFIX}${validateManagedScriptId(id)}`;
}

export function isManagedRegistrationId(id) {
  return typeof id === "string" && id.startsWith(MANAGED_SCRIPT_ID_PREFIX);
}

function validateMatches(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("matches must be a non-empty array");
  if (value.length > MAX_MATCHES) throw new Error(`matches exceeds ${MAX_MATCHES} patterns`);
  const matches = value.map(validateMatchPattern);
  if (new Set(matches).size !== matches.length) throw new Error("matches must not contain duplicates");
  return matches.sort();
}

function validateStateLimits(state) {
  const scripts = Object.values(state.scripts);
  if (scripts.length > MAX_MANAGED_SCRIPT_COUNT) {
    throw new Error(`Managed scripts exceed the limit of ${MAX_MANAGED_SCRIPT_COUNT}`);
  }
  const totalChars = scripts.reduce((sum, script) => sum + script.js.length, 0);
  if (totalChars > MAX_MANAGED_SCRIPT_TOTAL_CHARS) {
    throw new Error(`Managed scripts exceed the total JavaScript limit of ${MAX_MANAGED_SCRIPT_TOTAL_CHARS} characters`);
  }
}

function registrationFor(script) {
  return {
    id: registeredScriptId(script.id),
    matches: [...script.matches],
    js: [{ code: script.js }],
    runAt: script.runAt,
    world: script.world
  };
}

function sameRegistration(current, script) {
  return current?.id === registeredScriptId(script.id) &&
    sameArray(current.matches, script.matches) &&
    current.runAt === script.runAt &&
    current.world === script.world &&
    Array.isArray(current.js) && current.js.length === 1 && current.js[0]?.code === script.js;
}

function summarizeScript(script, registered) {
  return {
    id: script.id,
    name: script.name,
    matches: [...script.matches],
    enabled: script.enabled,
    runAt: script.runAt,
    world: script.world,
    jsChars: script.js.length,
    registered
  };
}

function emptyState() {
  return { version: MANAGED_SCRIPTS_SCHEMA_VERSION, scripts: {} };
}

function cloneState(state) {
  return {
    version: state.version,
    scripts: Object.fromEntries(Object.entries(state.scripts).map(([id, script]) => [id, {
      ...script,
      matches: [...script.matches]
    }]))
  };
}

function sameScript(left, right) {
  return Boolean(left) && left.id === right.id && left.name === right.name && left.js === right.js &&
    left.enabled === right.enabled && left.runAt === right.runAt && left.world === right.world &&
    sameArray(left.matches, right.matches);
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function booleanValue(value, label, fallback) {
  if (value == null && fallback !== undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function enumValue(value, label, allowed, fallback) {
  if (value == null && fallback !== undefined) return fallback;
  if (!allowed.has(value)) throw new Error(`${label} must be one of: ${Array.from(allowed).join(", ")}`);
  return value;
}

function requiredString(value, label) {
  const string = typeof value === "string" ? value : "";
  if (!string.trim()) throw new Error(`Missing ${label}`);
  return string;
}

function errorMessage(error) {
  return String(error?.message || error);
}
