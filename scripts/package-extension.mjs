import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const extensionDir = path.join(projectDir, "extension");
const distDir = path.join(projectDir, "dist");
const storeBuild = process.argv.includes("--store");
const manifest = JSON.parse(await readFile(path.join(extensionDir, "manifest.json"), "utf8"));
const label = storeBuild ? "store" : "development";
const outputPath = path.join(distDir, `chromium-sidecar-${label}-${manifest.version}.zip`);
const stageDir = path.join(distDir, `.extension-stage-${process.pid}`);

validateManifest(manifest);
if (storeBuild) await validateStoreAssets();
await mkdir(distDir, { recursive: true });
await rm(stageDir, { recursive: true, force: true });
await rm(outputPath, { force: true });

try {
  await cp(extensionDir, stageDir, { recursive: true });
  if (storeBuild) {
    const storeManifest = { ...manifest };
    delete storeManifest.key;
    await writeFile(
      path.join(stageDir, "manifest.json"),
      `${JSON.stringify(storeManifest, null, 2)}\n`,
      { mode: 0o644 }
    );
  }
  const packageFiles = await validatePackageFiles(stageDir);
  const normalizedTime = new Date("1980-01-01T00:00:00.000Z");
  await Promise.all(packageFiles.map(file => utimes(path.join(stageDir, file), normalizedTime, normalizedTime)));
  await execFileAsync(
    "/usr/bin/zip",
    ["-X", "-q", outputPath, ...packageFiles],
    { cwd: stageDir }
  );
  await execFileAsync("/usr/bin/unzip", ["-tqq", outputPath]);
} finally {
  await rm(stageDir, { recursive: true, force: true });
}

const archive = await readFile(outputPath);
console.log(JSON.stringify({
  outputPath,
  build: label,
  version: manifest.version,
  bytes: archive.byteLength,
  sha256: crypto.createHash("sha256").update(archive).digest("hex")
}, null, 2));

function validateManifest(value) {
  if (value.manifest_version !== 3) throw new Error("Chrome Web Store builds must use Manifest V3");
  if (Number(value.minimum_chrome_version) < 138) throw new Error("minimum_chrome_version must be at least 138");
  if (!value.description || value.description.length > 132) throw new Error("Manifest description must be 1-132 characters");
  if (value.permissions?.includes("activeTab")) throw new Error("activeTab is redundant with Sidecar website access");
  for (const permission of ["tabs", "cookies", "debugger"]) {
    if (value.permissions?.includes(permission)) throw new Error(`${permission} must remain optional`);
  }
  if (!value.optional_host_permissions?.includes("<all_urls>")) {
    throw new Error("Website access must remain an explicit optional permission");
  }
  if (value.externally_connectable) throw new Error("External extension messaging must not be enabled");
  if (value.incognito !== "not_allowed") throw new Error("Store builds must not access incognito browsing");
}

async function validateStoreAssets() {
  for (const size of [16, 32, 48, 128]) {
    const filePath = path.join(extensionDir, "icons", `icon-${size}.png`);
    const bytes = await readRequiredAsset(filePath, "approved extension icon");
    if (bytes.toString("ascii", 1, 4) !== "PNG") throw new Error(`${filePath} is not a PNG`);
    if (bytes.readUInt32BE(16) !== size || bytes.readUInt32BE(20) !== size) {
      throw new Error(`${filePath} must be ${size}x${size}`);
    }
  }
}

async function readRequiredAsset(filePath, label) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Store build blocked: missing ${label} at ${filePath}`);
    }
    throw error;
  }
}

async function validatePackageFiles(root) {
  const files = await listFiles(root);
  const forbidden = files.filter(file => /(?:^|\/)(?:\.DS_Store|node_modules|test|store|dist)(?:\/|$)|\.(?:pem|key|log|map)$/i.test(file));
  if (forbidden.length) throw new Error(`Forbidden extension package files: ${forbidden.join(", ")}`);
  for (const file of files.filter(file => /\.(?:js|html|json|css)$/i.test(file))) {
    const text = await readFile(path.join(root, file), "utf8");
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
      throw new Error(`Private key material found in ${file}`);
    }
  }
  return files;
}

async function listFiles(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, child));
    else files.push(child);
  }
  return files.sort();
}
