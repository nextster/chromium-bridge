import assert from "node:assert/strict";
import test from "node:test";
import { renameWithRetry } from "../src/atomic-file.mjs";

test("renames retry transient Windows locks but fail fast elsewhere", async () => {
  let attempts = 0;
  const flaky = async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("locked"), { code: "EBUSY" });
  };
  await renameWithRetry("a", "b", { platform: "win32", rename: flaky, delayMs: 1 });
  assert.equal(attempts, 3);

  attempts = 0;
  await assert.rejects(renameWithRetry("a", "b", { platform: "darwin", rename: flaky, delayMs: 1 }), /locked/);
  assert.equal(attempts, 1);

  const missing = async () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
  await assert.rejects(renameWithRetry("a", "b", { platform: "win32", rename: missing, delayMs: 1 }), /missing/);
});
