import assert from "node:assert/strict";
import test from "node:test";
import { scheduleDevelopmentUninstall } from "../extension/development-migration.js";

test("development migration schedules a confirmation-free self uninstall", async () => {
  const calls = [];
  const management = {
    getSelf: async () => ({ id: "development-id", installType: "development" }),
    uninstallSelf: async options => calls.push(options)
  };
  const scheduled = [];
  const result = await scheduleDevelopmentUninstall(management, (callback, delay) => {
    scheduled.push({ callback, delay });
  });

  assert.deepEqual(result, {
    uninstalling: true,
    id: "development-id",
    installType: "development"
  });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 250);
  await scheduled[0].callback();
  assert.deepEqual(calls, [{ showConfirmDialog: false }]);
});

test("development migration never uninstalls a Store extension", async () => {
  let scheduled = false;
  const result = await scheduleDevelopmentUninstall({
    getSelf: async () => ({ id: "store-id", installType: "normal" }),
    uninstallSelf: async () => assert.fail("Store extension must not uninstall itself")
  }, () => {
    scheduled = true;
  });

  assert.deepEqual(result, { uninstalling: false, id: "store-id", installType: "normal" });
  assert.equal(scheduled, false);
});
