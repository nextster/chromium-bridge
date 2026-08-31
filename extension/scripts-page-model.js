export const NEW_SCRIPT_DEFAULTS = Object.freeze({
  id: "",
  name: "",
  matches: ["https://example.com/*"],
  js: "",
  enabled: true,
  runAt: "document_idle",
  world: "USER_SCRIPT"
});

export function parseMatchPatterns(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean);
}

export function formatMatchPatterns(matches) {
  return Array.isArray(matches) ? matches.join("\n") : "";
}

export function scriptFromFields(fields) {
  return {
    id: String(fields.id || "").trim(),
    name: String(fields.name || "").trim(),
    matches: parseMatchPatterns(fields.matches),
    js: String(fields.js || ""),
    enabled: Boolean(fields.enabled),
    runAt: String(fields.runAt || "document_idle"),
    world: String(fields.world || "USER_SCRIPT")
  };
}

export function matchesSearch(script, query) {
  const needle = String(query || "").trim().toLocaleLowerCase();
  if (!needle) return true;
  return [script.id, script.name, ...(script.matches || [])]
    .some(value => String(value).toLocaleLowerCase().includes(needle));
}
