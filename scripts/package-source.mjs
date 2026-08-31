import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
const outputDir = path.join(projectDir, "dist");
const outputPath = path.join(outputDir, `chromium-bridge-${packageJson.version}.tar.gz`);
const sourceRef = process.env.CHROMIUM_BRIDGE_SOURCE_REF || "HEAD";
const archiveRef = `${sourceRef}^{tree}`;
const { stdout: archive } = await execFileAsync("git", [
  "archive",
  "--format=tar",
  "--mtime=1980-01-01T00:00:00Z",
  `--prefix=chromium-bridge-${packageJson.version}/`,
  archiveRef,
  "--",
  ".",
  ":(exclude)Formula",
  ":(exclude)dist"
], { cwd: projectDir, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
const compressed = gzipSync(archive, { level: 9, mtime: 0 });

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, compressed);
console.log(JSON.stringify({
  outputPath,
  version: packageJson.version,
  sourceRef,
  bytes: compressed.byteLength,
  sha256: crypto.createHash("sha256").update(compressed).digest("hex")
}, null, 2));
