import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMatchPatterns,
  matchesSearch,
  parseMatchPatterns,
  scriptFromFields
} from "./scripts-page-model.js";

test("managed scripts page parses one explicit match pattern per line", () => {
  assert.deepEqual(
    parseMatchPatterns(" https://example.com/*\n\nhttp://localhost/* \n"),
    ["https://example.com/*", "http://localhost/*"]
  );
  assert.equal(
    formatMatchPatterns(["https://example.com/*", "http://localhost/*"]),
    "https://example.com/*\nhttp://localhost/*"
  );
});

test("managed scripts page builds the complete upsert payload", () => {
  assert.deepEqual(scriptFromFields({
    id: "  youtube-space  ",
    name: " YouTube space ",
    matches: "https://www.youtube.com/*",
    js: "window.test = true;",
    enabled: true,
    runAt: "document_start",
    world: "USER_SCRIPT"
  }), {
    id: "youtube-space",
    name: "YouTube space",
    matches: ["https://www.youtube.com/*"],
    js: "window.test = true;",
    enabled: true,
    runAt: "document_start",
    world: "USER_SCRIPT"
  });
});

test("managed scripts page search includes ids, names, and match patterns", () => {
  const script = {
    id: "youtube-space",
    name: "Space control",
    matches: ["https://www.youtube.com/*"]
  };
  assert.equal(matchesSearch(script, "YOUTUBE"), true);
  assert.equal(matchesSearch(script, "space control"), true);
  assert.equal(matchesSearch(script, "vimeo"), false);
});
