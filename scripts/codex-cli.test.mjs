import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { findCodexCli } from "./codex-cli.mjs";

test("findCodexCli detects the CLI bundled inside a desktop app", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-codex-app-"));
  const applicationRoot = path.join(home, "Applications");
  const bundledCli = path.join(applicationRoot, "ChatGPT.app", "Contents", "Resources", "codex");
  await mkdir(path.dirname(bundledCli), { recursive: true });
  await writeFile(bundledCli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(bundledCli, 0o700);

  try {
    assert.equal(await findCodexCli({
      env: { PATH: "/usr/bin:/bin" },
      home,
      applicationRoots: [applicationRoot]
    }), bundledCli);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("findCodexCli returns null when neither a command nor app bundle exists", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-no-codex-"));
  try {
    assert.equal(await findCodexCli({
      env: { PATH: "/usr/bin:/bin" },
      home,
      applicationRoots: [path.join(home, "Applications")]
    }), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
