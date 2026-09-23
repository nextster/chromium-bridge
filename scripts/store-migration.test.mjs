import assert from "node:assert/strict";
import test from "node:test";
import { READY_STEP, bridgeKind, storeNextSteps, storeReadinessStep } from "./store-migration.mjs";

const storeId = "store-id";
const developmentId = "development-id";

function status(id, overrides = {}) {
  return {
    host: { extension: id ? { id } : null },
    extension: {
      pong: Boolean(id),
      privacy: { consented: true },
      permissions: { siteAccess: true, tabs: true },
      userScriptsAvailable: true,
      ...overrides
    }
  };
}

test("Store readiness rejects the unpacked development id", () => {
  const value = status(developmentId);
  assert.equal(bridgeKind(value, storeId, developmentId), "development");
  assert.equal(
    storeReadinessStep(value, storeId, developmentId),
    "Removing the unpacked development extension."
  );
});

test("Store readiness accepts only a fully approved Store extension", () => {
  assert.equal(bridgeKind(status(storeId), storeId, developmentId), "store");
  assert.equal(
    storeReadinessStep(status(storeId), storeId, developmentId),
    READY_STEP
  );
  assert.equal(
    storeReadinessStep(status(storeId, { userScriptsAvailable: false }), storeId, developmentId),
    "Open the extension details and enable Allow User Scripts."
  );
});

test("Store readiness identifies missing and conflicting extensions", () => {
  assert.equal(bridgeKind(status(""), storeId, developmentId), "missing");
  assert.equal(bridgeKind(status("other-id"), storeId, developmentId), "other");
});

test("Store next steps list only what the user still has to do", () => {
  const storeUrl = "https://example.test/store";
  assert.deepEqual(storeNextSteps(null, storeId, developmentId, storeUrl), [
    `Install Chromium Bridge from ${storeUrl}`,
    "Approve local browser access in the onboarding page",
    "Enable Allow User Scripts in the extension details"
  ]);
  assert.deepEqual(storeNextSteps(status(storeId, { privacy: { consented: false } }), storeId, developmentId, storeUrl), [
    "Approve local browser access in the onboarding page"
  ]);
  assert.deepEqual(storeNextSteps(status(storeId, { userScriptsAvailable: false }), storeId, developmentId, storeUrl), [
    "Enable Allow User Scripts in the extension details"
  ]);
  assert.deepEqual(storeNextSteps(status(storeId), storeId, developmentId, storeUrl), []);
  assert.match(storeNextSteps(status(developmentId), storeId, developmentId, storeUrl)[0], /^Remove the unpacked development extension/);
  assert.match(storeNextSteps(status("other-id"), storeId, developmentId, storeUrl)[0], /^Disable the conflicting/);
});
