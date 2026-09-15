import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Lists test files explicitly because npm runs scripts through cmd.exe on
// Windows, which does not expand shell globs.
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["extension", "scripts", "native-host/test", "plugins/chromium-bridge/test"].flatMap(directory =>
  readdirSync(path.join(projectDir, directory))
    .filter(name => name.endsWith(".test.mjs"))
    .sort()
    .map(name => path.join(directory, name))
);
const result = spawnSync(process.execPath, ["--test", ...files], { cwd: projectDir, stdio: "inherit" });
process.exitCode = result.status ?? 1;
