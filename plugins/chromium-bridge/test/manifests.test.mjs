import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Codex and Claude Code manifests describe the same plugin", async () => {
  const codex = await readJson(".codex-plugin/plugin.json");
  const claude = await readJson(".claude-plugin/plugin.json");
  const packageJson = await readJson("package.json");
  assert.equal(codex.name, "chromium-bridge");
  assert.equal(claude.name, codex.name);
  assert.equal(claude.version, codex.version);
  assert.equal(packageJson.version, codex.version);
  assert.equal(claude.description, codex.description);
  assert.equal(codex.skills, "./skills/");
  assert.equal(codex.mcpServers, "./.mcp.json");
});

test("MCP template launches the stable runtime bootstrap without a cwd", async () => {
  const server = (await readJson(".mcp.json")).mcpServers["chromium-bridge"];
  assert.deepEqual(Object.keys(server).sort(), ["args", "command"]);
  assert.match(server.args[0], /\/\.chromium-bridge\/runtime\/runtime-bootstrap\.mjs$/);
  assert.equal(server.args[1], "mcp");
});

test("the bundled skill avoids client-specific policy wording", async () => {
  const skill = await readFile(path.join(pluginDir, "skills", "chromium-bridge", "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: chromium-bridge\ndescription: .+\n---\n/);
  assert.doesNotMatch(skill, /Codex/);
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(pluginDir, relativePath), "utf8"));
}
