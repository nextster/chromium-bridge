import assert from "node:assert/strict";
import test from "node:test";
import { directoryOpenCommand, openDirectory } from "../src/open-directory.mjs";

test("data directory opener uses argument arrays instead of a shell", () => {
  const directory = "/tmp/folder with spaces";
  assert.deepEqual(directoryOpenCommand(directory, "darwin"), {
    executable: "/usr/bin/open",
    args: [directory]
  });
  assert.deepEqual(directoryOpenCommand(directory, "win32"), {
    executable: "explorer.exe",
    args: [directory]
  });
  assert.deepEqual(directoryOpenCommand(directory, "linux"), {
    executable: "xdg-open",
    args: [directory]
  });
});

test("data directory opener returns only the fixed directory it opened", async () => {
  const calls = [];
  const result = await openDirectory("/tmp/bridge", {
    platform: "darwin",
    execute: async (...args) => calls.push(args)
  });
  assert.deepEqual(calls, [["/usr/bin/open", ["/tmp/bridge"]]]);
  assert.deepEqual(result, { opened: true, path: "/tmp/bridge" });
});

test("data directory opener tolerates explorer.exe's nonzero success status", async () => {
  const result = await openDirectory("C:\\Users\\Ann\\.chromium-bridge", {
    platform: "win32",
    execute: async () => {
      throw Object.assign(new Error("Command failed"), { code: 1 });
    }
  });
  assert.equal(result.opened, true);
  await assert.rejects(openDirectory("/tmp/bridge", {
    platform: "darwin",
    execute: async () => {
      throw Object.assign(new Error("Command failed"), { code: 1 });
    }
  }), /Command failed/);
});
