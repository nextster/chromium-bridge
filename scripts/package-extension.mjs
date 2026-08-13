import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const distDir = path.join(projectDir, "dist");
const outputPath = path.join(distDir, "chromium-sidecar-extension.zip");

await mkdir(distDir, { recursive: true });
await rm(outputPath, { force: true });
await execFileAsync(
  "/usr/bin/zip",
  ["-q", "-r", outputPath, ".", "-x", "*.DS_Store", "__MACOSX/*"],
  { cwd: path.join(projectDir, "extension") }
);
console.log(outputPath);
