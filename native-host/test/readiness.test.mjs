import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  CONSENT_MESSAGE,
  INSTALL_MESSAGE,
  READY_MESSAGE,
  USER_SCRIPTS_MESSAGE,
  readinessStep
} from "../src/readiness.mjs";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.mjs");

test("readiness step names the next user action", () => {
  const approved = {
    pong: true,
    privacy: { consented: true },
    permissions: { siteAccess: true, tabs: true },
    userScriptsAvailable: true
  };
  assert.deepEqual(readinessStep(undefined), { ready: false, message: INSTALL_MESSAGE });
  assert.deepEqual(readinessStep({ pong: false }), { ready: false, message: INSTALL_MESSAGE });
  assert.deepEqual(readinessStep({ ...approved, privacy: { consented: false } }), { ready: false, message: CONSENT_MESSAGE });
  assert.deepEqual(readinessStep({ ...approved, permissions: { siteAccess: true, tabs: false } }), { ready: false, message: CONSENT_MESSAGE });
  assert.deepEqual(readinessStep({ ...approved, userScriptsAvailable: false }), { ready: false, message: USER_SCRIPTS_MESSAGE });
  assert.deepEqual(readinessStep(approved), { ready: true, message: READY_MESSAGE });
});

test("cli ready exits with status 2 and the install hint while no host is running", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-ready-"));
  const env = { ...process.env, CHROMIUM_BRIDGE_STATE_DIR: stateDir };
  delete env.CHROMIUM_BRIDGE_SOCKET;
  delete env.ARC_CODEX_SOCKET;
  try {
    await assert.rejects(execFileAsync(process.execPath, [cliPath, "ready"], { env }), error => {
      assert.equal(error.code, 2);
      assert.equal(error.stdout.trim(), INSTALL_MESSAGE);
      return true;
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
