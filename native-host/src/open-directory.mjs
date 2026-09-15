import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function directoryOpenCommand(directory, platform = process.platform) {
  if (platform === "darwin") return { executable: "/usr/bin/open", args: [directory] };
  if (platform === "win32") return { executable: "explorer.exe", args: [directory] };
  return { executable: "xdg-open", args: [directory] };
}

export async function openDirectory(directory, options = {}) {
  const platform = options.platform || process.platform;
  const command = directoryOpenCommand(directory, platform);
  const execute = options.execute || execFileAsync;
  try {
    await execute(command.executable, command.args);
  } catch (error) {
    // explorer.exe exits with status 1 even after it opens the folder.
    if (!(platform === "win32" && error?.code === 1)) throw error;
  }
  return { opened: true, path: directory };
}
