import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function findCodexCli(options = {}) {
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const discovered = await commandPath("codex", env);
  const applications = ["ChatGPT.app", "Codex.app"];
  const applicationRoots = options.applicationRoots || ["/Applications", path.join(home, "Applications")];
  const candidates = [
    env.CHROMIUM_BRIDGE_CODEX,
    discovered,
    ...applicationRoots.flatMap(root => applications.map(app =>
      path.join(root, app, "Contents", "Resources", "codex")
    ))
  ].filter(Boolean);

  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate, fsConstants.X_OK);
      return path.resolve(candidate);
    } catch {}
  }
  return null;
}

async function commandPath(command, env) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/env", ["which", command], { env });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
