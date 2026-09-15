import assert from "node:assert/strict";
import test from "node:test";
import { findClaudeCli } from "./claude-cli.mjs";
import { findCodexCli } from "./codex-cli.mjs";
import { detectBrowser, findExecutable, openInBrowser, runCommand, windowsCommandLine } from "./platform.mjs";

test("Windows executable lookup honors PATH and PATHEXT", async () => {
  const existing = new Set(["C:\\Users\\Ann\\AppData\\Roaming\\npm\\codex.cmd"]);
  const found = await findExecutable("codex", {
    platform: "win32",
    env: { PATH: "C:\\Windows\\System32;\"C:\\Users\\Ann\\AppData\\Roaming\\npm\"", PATHEXT: ".EXE;.CMD" },
    isExecutable: async candidate => existing.has(candidate)
  });
  assert.equal(found, "C:\\Users\\Ann\\AppData\\Roaming\\npm\\codex.cmd");
});

test("Windows command lines quote paths and reject cmd expansion characters", async () => {
  assert.equal(
    windowsCommandLine("C:\\Users\\Ann B\\npm\\codex.cmd", ["plugin", "marketplace", "add", "C:\\Users\\Ann B\\.agent-plugins\\nextster", "--json"]),
    '"C:\\Users\\Ann B\\npm\\codex.cmd" plugin marketplace add "C:\\Users\\Ann B\\.agent-plugins\\nextster" --json'
  );
  assert.throws(() => windowsCommandLine("codex.cmd", ["%PATH%"]), /Unsupported character/);

  const calls = [];
  const execute = async (...call) => {
    calls.push(call);
    return { stdout: "" };
  };
  await runCommand("C:\\npm\\codex.cmd", ["plugin", "list"], { platform: "win32", execute });
  await runCommand("C:\\bin\\claude.exe", ["plugin", "list"], { platform: "win32", execute });
  assert.equal(calls[0][0], "C:\\npm\\codex.cmd plugin list");
  assert.deepEqual(calls[0][1], []);
  assert.equal(calls[0][2].shell, true);
  assert.equal(calls[1][0], "C:\\bin\\claude.exe");
  assert.deepEqual(calls[1][1], ["plugin", "list"]);
  assert.equal(calls[1][2].shell, undefined);
});

test("agent CLIs are found in Windows user install locations", async () => {
  const home = "C:\\Users\\Ann";
  const env = { PATH: "", APPDATA: `${home}\\AppData\\Roaming` };
  const claude = await findClaudeCli({
    platform: "win32",
    env,
    home,
    listVersions: async () => [],
    isExecutable: async candidate => candidate === `${home}\\.local\\bin\\claude.exe`
  });
  assert.equal(claude, `${home}\\.local\\bin\\claude.exe`);
  const codex = await findCodexCli({
    platform: "win32",
    env,
    home,
    isExecutable: async candidate => candidate === `${home}\\AppData\\Roaming\\npm\\codex.cmd`
  });
  assert.equal(codex, `${home}\\AppData\\Roaming\\npm\\codex.cmd`);
});

test("the Claude desktop app's bundled CLI is a macOS fallback", async () => {
  const bundled = "/home/ann/Library/Application Support/Claude/claude-code/2.1.270/claude.app/Contents/MacOS/claude";
  const found = await findClaudeCli({
    platform: "darwin",
    env: { PATH: "/usr/bin" },
    home: "/home/ann",
    listVersions: async () => ["2.1.270", "2.1.260"],
    isExecutable: async candidate => candidate === bundled
  });
  assert.equal(found, bundled);
});

test("Windows browser detection prefers installed Chromium browsers before Edge", async () => {
  const env = {
    LOCALAPPDATA: "C:\\Users\\Ann\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)"
  };
  const chrome = "C:\\Users\\Ann\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
  const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const installed = new Set([chrome, edge]);
  const browser = await detectBrowser({ platform: "win32", env, exists: async candidate => installed.has(candidate) });
  assert.deepEqual(browser, { name: "Google Chrome", extensionsUrl: "chrome://extensions", path: chrome });

  installed.delete(chrome);
  assert.equal((await detectBrowser({ platform: "win32", env, exists: async candidate => installed.has(candidate) })).name, "Microsoft Edge");

  const spawned = [];
  await openInBrowser({ path: edge }, "edge://extensions", {
    platform: "win32",
    spawn: (command, args, options) => {
      spawned.push([command, args, options.detached]);
      return {
        once(event, callback) {
          if (event === "spawn") queueMicrotask(callback);
        },
        unref() {}
      };
    }
  });
  assert.deepEqual(spawned, [[edge, ["edge://extensions"], true]]);
});
