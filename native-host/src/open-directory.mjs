import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function directoryOpenCommand(directory, platform = process.platform) {
  if (platform === "darwin") return { executable: "/usr/bin/open", args: [directory] };
  if (platform === "win32") return { executable: "explorer.exe", args: [directory] };
  return { executable: "xdg-open", args: [directory] };
}

export async function openDirectory(directory, options = {}) {
  const command = directoryOpenCommand(directory, options.platform);
  const execute = options.execute || execFileAsync;
  await execute(command.executable, command.args);
  return { opened: true, path: directory };
}
