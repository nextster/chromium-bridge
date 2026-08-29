import assert from "node:assert/strict";
import test from "node:test";
import { bridgeKind, storeReadinessStep } from "./store-migration.mjs";

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
    "Browser and Codex bridge are ready."
  );
  assert.equal(
    storeReadinessStep(status(storeId, { userScriptsAvailable: false }), storeId, developmentId),
    "Open extension details and enable Allow User Scripts."
  );
});

test("Store readiness identifies missing and conflicting extensions", () => {
  assert.equal(bridgeKind(status(""), storeId, developmentId), "missing");
  assert.equal(bridgeKind(status("other-id"), storeId, developmentId), "other");
});
