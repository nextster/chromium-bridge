import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("setup persists the Codex marketplace outside its source checkout", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "chromium-sidecar-setup-"));
  const binDir = path.join(home, "test-bin");
  const codexPath = path.join(binDir, "codex");
  const logPath = path.join(home, "codex-calls.ndjson");
  await mkdir(binDir, { recursive: true });
  await writeFile(codexPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.CODEX_TEST_LOG, JSON.stringify(args) + "\\n");
if (args.join(" ") === "plugin marketplace list --json") console.log(JSON.stringify({ marketplaces: [] }));
else if (args.join(" ") === "plugin list --json") console.log(JSON.stringify({ installed: [] }));
else console.log(JSON.stringify({ ok: true }));
`, { mode: 0o700 });
  await chmod(codexPath, 0o700);

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(projectDir, "scripts", "setup.mjs"),
      "--host-only",
      "--no-open"
    ], {
      env: {
        ...process.env,
        HOME: home,
        CODEX_TEST_LOG: logPath,
        PATH: `${binDir}:${process.env.PATH}`
      }
    });
    const result = JSON.parse(stdout);
    const marketplaceRoot = path.join(home, ".chromium-sidecar", "codex-marketplace");
    assert.equal(result.codex.marketplaceRoot, marketplaceRoot);
    assert.equal(
      JSON.parse(await readFile(path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), "utf8")).name,
      "chromium-sidecar"
    );
    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(calls.some(args => args.join(" ") === `plugin marketplace add ${marketplaceRoot} --json`));
    assert.ok(calls.some(args => args.join(" ") === "plugin add chromium-sidecar@chromium-sidecar --json"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
