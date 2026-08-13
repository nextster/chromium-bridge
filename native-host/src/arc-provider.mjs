import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ARC_APPLICATION_PATHS = [
  "/Applications/Arc.app",
  path.join(os.homedir(), "Applications", "Arc.app")
];

export async function arcProviderInfo(options = {}) {
  const accessFn = options.accessFn || access;
  const platform = options.platform || process.platform;
  let applicationPath = null;
  for (const candidate of ARC_APPLICATION_PATHS) {
    try {
      await accessFn(candidate);
      applicationPath = candidate;
      break;
    } catch {}
  }
  return {
    id: "arc",
    name: "Arc",
    available: platform === "darwin" && Boolean(applicationPath),
    applicationPath,
    capabilities: ["spaces.list", "space.focus"]
  };
}

export async function listArcSpaces(options = {}) {
  return runArcScript(LIST_SPACES_SCRIPT, [], options);
}

export async function focusArcSpace(spaceId, options = {}) {
  const id = requiredString(spaceId, "spaceId");
  return runArcScript(FOCUS_SPACE_SCRIPT, [id], options);
}

async function runArcScript(script, args, options) {
  const platform = options.platform || process.platform;
  if (platform !== "darwin") throw new Error("Arc Spaces are available only on macOS");
  const runJxa = options.runJxa || executeJxa;
  const result = await runJxa(script, args);
  try {
    return JSON.parse(String(result).trim());
  } catch {
    throw new Error("Arc returned an invalid Spaces response");
  }
}

async function executeJxa(script, args) {
  const { stdout } = await execFileAsync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", script, "--", ...args],
    { maxBuffer: 8 * 1024 * 1024 }
  );
  return stdout;
}

function requiredString(value, label) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`Missing ${label}`);
  return result;
}

const LIST_SPACES_SCRIPT = String.raw`
function value(read, fallback) {
  try { return read(); } catch (_) { return fallback; }
}

function tabRecord(tab) {
  return {
    id: value(() => tab.id(), null),
    title: value(() => tab.title(), ""),
    url: value(() => tab.url(), ""),
    location: String(value(() => tab.location(), ""))
  };
}

function run() {
  const arc = Application("Arc");
  if (!arc.running()) return JSON.stringify({ running: false, windows: [] });
  const windows = [];
  const windowsRef = arc.windows;
  windowsRef().forEach((_, windowIndex) => {
    const windowRef = windowsRef[windowIndex];
    const spaces = [];
    const spacesRef = windowRef.spaces;
    spacesRef().forEach((_, spaceIndex) => {
      const spaceRef = spacesRef[spaceIndex];
      const tabs = [];
      const tabsRef = spaceRef.tabs;
      tabsRef().forEach((_, tabIndex) => tabs.push(tabRecord(tabsRef[tabIndex])));
      spaces.push({
        id: value(() => spaceRef.id(), null),
        title: value(() => spaceRef.title(), ""),
        tabs
      });
    });
    const activeSpaceRef = windowRef.activeSpace;
    windows.push({
      id: value(() => windowRef.id(), null),
      name: value(() => windowRef.name(), ""),
      activeSpaceId: value(() => activeSpaceRef.id(), null),
      spaces
    });
  });
  return JSON.stringify({ running: true, windows });
}
`;

const FOCUS_SPACE_SCRIPT = String.raw`
function value(read, fallback) {
  try { return read(); } catch (_) { return fallback; }
}

function run(argv) {
  const targetId = String(argv[0] || "");
  const arc = Application("Arc");
  if (!arc.running()) throw new Error("Arc is not running");
  let result = null;
  const windowsRef = arc.windows;
  windowsRef().forEach((_, windowIndex) => {
    if (result) return;
    const spacesRef = windowsRef[windowIndex].spaces;
    spacesRef().forEach((_, spaceIndex) => {
      if (result) return;
      const spaceRef = spacesRef[spaceIndex];
      const id = String(value(() => spaceRef.id(), ""));
      if (id !== targetId) return;
      spaceRef.focus();
      result = { focused: true, spaceId: id, title: value(() => spaceRef.title(), "") };
    });
  });
  if (result) return JSON.stringify(result);
  throw new Error("Arc space not found: " + targetId);
}
`;
