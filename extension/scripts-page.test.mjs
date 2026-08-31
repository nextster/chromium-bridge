import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const extensionDir = fileURLToPath(new URL(".", import.meta.url));

test("managed scripts page exposes all required management controls", async () => {
  const html = await readFile(new URL("scripts.html", import.meta.url), "utf8");
  for (const id of [
    "openDataFolder",
    "reloadScripts",
    "searchScripts",
    "newScript",
    "scriptList",
    "scriptForm",
    "scriptId",
    "scriptName",
    "scriptEnabled",
    "scriptMatches",
    "scriptRunAt",
    "scriptWorld",
    "scriptCode",
    "deleteScript"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id} in ${extensionDir}`);
  }
  assert.match(html, /<script type="module" src="scripts\.js"><\/script>/);
  assert.doesNotMatch(html, /<script(?![^>]+src=)[^>]*>/);
});

test("popup links to the managed scripts page", async () => {
  const [html, js] = await Promise.all([
    readFile(new URL("popup.html", import.meta.url), "utf8"),
    readFile(new URL("popup.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="manageScripts"/);
  assert.match(js, /chrome\.runtime\.getURL\("scripts\.html"\)/);
});
