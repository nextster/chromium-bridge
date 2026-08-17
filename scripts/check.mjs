import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const files = await listFiles(projectDir);
const sourceFiles = files.filter(file => /\.(?:js|mjs)$/i.test(file));
const shellFiles = files.filter(file => /\.sh$/i.test(file));
const jsonFiles = files.filter(file => /\.json$/i.test(file));

await Promise.all(sourceFiles.map(file => execFileAsync(process.execPath, ["--check", path.join(projectDir, file)])));
await Promise.all(shellFiles.map(file => execFileAsync("/bin/sh", ["-n", path.join(projectDir, file)])));
await Promise.all(jsonFiles.map(async file => JSON.parse(await readFile(path.join(projectDir, file), "utf8"))));

const rootPackage = await readJson("package.json");
const versionFiles = [
  ["extension/manifest.json", "version"],
  ["native-host/package.json", "version"],
  ["plugins/chromium-sidecar/package.json", "version"],
  ["plugins/chromium-sidecar/.codex-plugin/plugin.json", "version"]
];
for (const [file, key] of versionFiles) {
  const value = (await readJson(file))[key];
  if (value !== rootPackage.version) throw new Error(`${file} version ${value} does not match ${rootPackage.version}`);
}

const textFiles = files.filter(file => /\.(?:js|mjs|sh|json|md|html|css|yml|yaml)$/i.test(file));
for (const file of textFiles) {
  const text = await readFile(path.join(projectDir, file), "utf8");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
    throw new Error(`Private key material found in ${file}`);
  }
  if (/\/Users\/[A-Za-z0-9._-]+\//.test(text)) {
    throw new Error(`Machine-specific absolute path found in ${file}`);
  }
}

console.log(`Checked ${sourceFiles.length} JavaScript files, ${shellFiles.length} shell files, ${jsonFiles.length} JSON files, and ${textFiles.length} text files.`);

async function readJson(file) {
  return JSON.parse(await readFile(path.join(projectDir, file), "utf8"));
}

async function listFiles(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if ([".git", "dist", "node_modules"].includes(entry.name)) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, child));
    else files.push(child);
  }
  return files.sort();
}
