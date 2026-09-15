import os from "node:os";
import process from "node:process";
import { findExecutable, firstExecutable, pathApiFor } from "./platform.mjs";

export async function findCodexCli(options = {}) {
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const platform = options.platform || process.platform;
  const pathApi = pathApiFor(platform);
  const lookup = { platform, isExecutable: options.isExecutable };
  const candidates = [env.CHROMIUM_BRIDGE_CODEX, await findExecutable("codex", { ...lookup, env })];
  if (platform === "win32") {
    candidates.push(pathApi.join(env.APPDATA || pathApi.join(home, "AppData", "Roaming"), "npm", "codex.cmd"));
  } else {
    const applicationRoots = options.applicationRoots || ["/Applications", pathApi.join(home, "Applications")];
    candidates.push(...applicationRoots.flatMap(root => ["ChatGPT.app", "Codex.app"].map(app =>
      pathApi.join(root, app, "Contents", "Resources", "codex")
    )));
  }
  return firstExecutable(candidates, lookup);
}
