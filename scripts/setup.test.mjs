import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("setup persists Codex files and uninstall preserves captures", {
  skip: process.platform !== "darwin"
}, async () => {
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
    const marketplace = JSON.parse(
      await readFile(path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), "utf8")
    );
    assert.equal(marketplace.name, "chromium-sidecar");
    const mcp = JSON.parse(
      await readFile(path.join(marketplaceRoot, "plugins", "chromium-sidecar", ".mcp.json"), "utf8")
    );
    assert.equal(mcp.mcpServers["chromium-sidecar"].command, result.nativeHost.node);
    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(calls.some(args => args.join(" ") === `plugin marketplace add ${marketplaceRoot} --json`));
    assert.ok(calls.some(args => args.join(" ") === "plugin add chromium-sidecar@chromium-sidecar --json"));

    const retainedCapture = path.join(home, ".chromium-sidecar", "captures", "kept.txt");
    await mkdir(path.dirname(retainedCapture), { recursive: true });
    await writeFile(retainedCapture, "keep");
    const uninstall = JSON.parse((await execFileAsync(process.execPath, [
      path.join(projectDir, "scripts", "uninstall.mjs"),
      "--no-open"
    ], {
      env: {
        ...process.env,
        HOME: home,
        CODEX_TEST_LOG: logPath,
        PATH: `${binDir}:${process.env.PATH}`
      }
    })).stdout);
    assert.equal(uninstall.uninstalled, true);
    assert.equal(uninstall.retainedCaptures, true);
    assert.equal(await readFile(retainedCapture, "utf8"), "keep");
    await assert.rejects(access(marketplaceRoot));
    const uninstallCalls = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(uninstallCalls.some(args => args.join(" ") === "plugin remove chromium-sidecar@chromium-sidecar --json"));
    assert.ok(uninstallCalls.some(args => args.join(" ") === "plugin marketplace remove chromium-sidecar --json"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("setup automatically selects Store mode when an extension id is supplied", async () => {
  const storeId = "abcdefghijklmnopabcdefghijklmnop";
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(projectDir, "scripts", "setup.mjs"),
    "--dry-run",
    "--no-codex",
    "--no-open",
    "--extension-id",
    storeId
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.mode, "store");
  assert.equal(result.storeExtensionId, storeId);
  assert.equal(result.extensionPath, null);
});
