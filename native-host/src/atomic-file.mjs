import process from "node:process";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";

const TRANSIENT_WINDOWS_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);

// Antivirus scanners, the search indexer, or a browser reading a manifest can
// briefly lock a file or directory on Windows, so renames retry there.
export async function renameWithRetry(from, to, options = {}) {
  const platform = options.platform || process.platform;
  const renameFile = options.rename || rename;
  const attempts = options.attempts ?? 20;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameFile(from, to);
      return;
    } catch (error) {
      if (platform !== "win32" || attempt >= attempts || !TRANSIENT_WINDOWS_ERRORS.has(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 100));
    }
  }
}

export async function atomicWriteFile(filePath, content, mode) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, content, { mode });
  await chmod(temporaryPath, mode);
  try {
    await renameWithRetry(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
