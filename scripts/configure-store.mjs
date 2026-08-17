import path from "node:path";
import process from "node:process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const extensionId = String(process.argv[2] || "").trim();
if (!/^[a-p]{32}$/.test(extensionId)) {
  throw new Error("Usage: npm run configure:store -- <32-character Chrome Web Store item id>");
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.resolve(scriptDir, "../store/item.json");
await writeFile(outputPath, `${JSON.stringify({ extensionId }, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({ configured: true, extensionId, outputPath }, null, 2));
