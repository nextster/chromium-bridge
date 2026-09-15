import os from "node:os";
import path from "node:path";
import process from "node:process";
import { existsSync, realpathSync } from "node:fs";
import { cp, lstat, mkdir, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { atomicWriteFile, renameWithRetry } from "../native-host/src/atomic-file.mjs";
import { runCommand } from "./platform.mjs";

export const MARKETPLACE_NAME = "nextster";
export const PLUGIN_NAME = "chromium-bridge";
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

const CODEX_MANIFEST = [".agents", "plugins", "marketplace.json"];
const CLAUDE_MANIFEST = [".claude-plugin", "marketplace.json"];
const MARKETPLACE_DESCRIPTION = "Local plugins for Codex and Claude Code installed by Nextster bridge installers.";
const OBSOLETE_CODEX_REGISTRATIONS = [
  ["plugin", "remove", "chromium-sidecar@chromium-sidecar", "--json"],
  ["plugin", "marketplace", "remove", "chromium-sidecar", "--json"],
  ["plugin", "remove", "chromium-bridge@chromium-bridge", "--json"],
  ["plugin", "marketplace", "remove", "chromium-bridge", "--json"]
];
const README = `# Nextster agent plugins

This directory is a local plugin marketplace named \`${MARKETPLACE_NAME}\`. It is shared by
Codex and Claude Code and is managed by the installers of Nextster bridges such as
Chromium Bridge, Figma Bridge, and Telegram Bridge.

- \`.agents/plugins/marketplace.json\` is the Codex marketplace manifest.
- \`.claude-plugin/marketplace.json\` is the Claude Code marketplace manifest.
- \`plugins/<name>/\` holds each installed plugin.

Rerun a bridge installer to update its plugin, or its uninstaller to remove it. Manual
edits are overwritten on the next installation.
`;

// A neutral location shared by every Nextster bridge and by both agent clients.
// Earlier releases kept a Codex-only copy under CODEX_HOME/marketplaces.
export function marketplaceLocations(options = {}) {
  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  return {
    root: path.resolve(env.NEXTSTER_MARKETPLACE_DIR || path.join(homedir, ".agent-plugins", MARKETPLACE_NAME)),
    legacyRoot: path.resolve(path.join(env.CODEX_HOME || path.join(homedir, ".codex"), "marketplaces", MARKETPLACE_NAME))
  };
}

// The legacy directory moves to the shared root and a link replaces it. Codex
// stores the registered root as written, and bridge installers that still use
// the legacy path compare it literally, so both keep working through the link.
export async function migrateLegacyMarketplace({ root, legacyRoot, platform = process.platform }) {
  if (path.resolve(root) === path.resolve(legacyRoot)) return { migrated: false };
  let legacy;
  try {
    legacy = await lstat(legacyRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return { migrated: false };
    throw error;
  }
  if (legacy.isSymbolicLink()) {
    return { migrated: false, compatLink: samePath(legacyRoot, root) ? legacyRoot : null };
  }

  if (!existsSync(root)) {
    await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
    await moveDirectory(legacyRoot, root);
    try {
      await linkDirectory(root, legacyRoot, platform);
    } catch (error) {
      await moveDirectory(root, legacyRoot);
      throw error;
    }
    return { migrated: true, moved: true, from: legacyRoot, to: root, compatLink: legacyRoot };
  }

  // Both directories exist only when something recreated the legacy root after
  // a migration, so its copies of other plugins are the newer ones.
  const legacyManifest = await readManifest(path.join(legacyRoot, ...CODEX_MANIFEST), codexManifestTemplate());
  const manifest = await readManifest(path.join(root, ...CODEX_MANIFEST), codexManifestTemplate());
  const imported = [];
  for (const entry of legacyManifest.plugins) {
    if (entry.name === PLUGIN_NAME) continue;
    const source = path.join(legacyRoot, "plugins", entry.name);
    const destination = path.join(root, "plugins", entry.name);
    if (existsSync(source)) {
      await rm(destination, { recursive: true, force: true });
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await moveDirectory(source, destination);
    }
    manifest.plugins = [...manifest.plugins.filter(item => item.name !== entry.name), entry];
    imported.push(entry.name);
  }
  await writeJson(path.join(root, ...CODEX_MANIFEST), manifest);
  await rm(legacyRoot, { recursive: true, force: true });
  const compatLink = await linkDirectory(root, legacyRoot, platform).then(() => legacyRoot, () => null);
  return { migrated: true, merged: true, from: legacyRoot, to: root, imported, compatLink };
}

// Removes the legacy link once the shared root it points to is gone.
export async function removeCompatLink({ root, legacyRoot }) {
  try {
    if (!(await lstat(legacyRoot)).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  if (existsSync(root)) return false;
  await rm(legacyRoot, { force: true });
  await removeEmptyDirectory(path.dirname(legacyRoot));
  return true;
}

export async function isRealDirectory(directory) {
  try {
    const metadata = await lstat(directory);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function installSharedMarketplace({ root, projectDir, nodePath, bootstrapPath }) {
  const pluginsDir = path.join(root, "plugins");
  const destination = path.join(pluginsDir, PLUGIN_NAME);
  const temporaryDir = path.join(pluginsDir, `.${PLUGIN_NAME}.tmp-${process.pid}`);
  await mkdir(pluginsDir, { recursive: true, mode: 0o700 });
  await rm(temporaryDir, { recursive: true, force: true });
  await cp(path.join(projectDir, "plugins", PLUGIN_NAME), temporaryDir, { recursive: true });
  // Both clients launch the stable runtime by absolute path; Claude Code ignores
  // cwd, and GUI clients may not inherit a PATH containing node.
  await writeJson(path.join(temporaryDir, ".mcp.json"), {
    mcpServers: {
      [PLUGIN_NAME]: { command: nodePath, args: [bootstrapPath, "mcp"] }
    }
  });
  await rm(destination, { recursive: true, force: true });
  await renameWithRetry(temporaryDir, destination);
  await writeFile(path.join(root, "README.md"), README, { mode: 0o600 });

  const sourceMarketplace = JSON.parse(await readFile(path.join(projectDir, ...CODEX_MANIFEST), "utf8"));
  const codexEntry = sourceMarketplace.plugins?.find(item => item.name === PLUGIN_NAME);
  if (sourceMarketplace.name !== MARKETPLACE_NAME || !codexEntry) throw new Error("Invalid Nextster marketplace source");
  const codexManifestPath = path.join(root, ...CODEX_MANIFEST);
  const codexManifest = await readManifest(codexManifestPath, codexManifestTemplate());
  codexManifest.interface = { ...(codexManifest.interface || {}), displayName: "Nextster" };
  codexManifest.plugins = [...codexManifest.plugins.filter(item => item.name !== PLUGIN_NAME), codexEntry];
  await writeJson(codexManifestPath, codexManifest);

  const pluginManifest = JSON.parse(await readFile(path.join(destination, ".claude-plugin", "plugin.json"), "utf8"));
  const claudeManifestPath = path.join(root, ...CLAUDE_MANIFEST);
  const claudeManifest = await readManifest(claudeManifestPath, claudeManifestTemplate());
  claudeManifest.owner = claudeManifest.owner || { name: "Nextster" };
  claudeManifest.metadata = { ...(claudeManifest.metadata || {}), description: MARKETPLACE_DESCRIPTION };
  claudeManifest.plugins = [
    ...claudeManifest.plugins.filter(item => item.name !== PLUGIN_NAME),
    {
      name: PLUGIN_NAME,
      source: `./plugins/${PLUGIN_NAME}`,
      description: pluginManifest.description,
      version: pluginManifest.version,
      category: "productivity"
    }
  ];
  await writeJson(claudeManifestPath, claudeManifest);
  return { root, pluginPath: destination };
}

export async function removeFromSharedMarketplace(root) {
  const codexManifestPath = path.join(root, ...CODEX_MANIFEST);
  const claudeManifestPath = path.join(root, ...CLAUDE_MANIFEST);
  if (!existsSync(codexManifestPath) && !existsSync(claudeManifestPath)) {
    return { root, existed: false, removed: false, empty: false, codexEmpty: false, claudeEmpty: false };
  }
  let removed = false;
  const remaining = {};
  for (const [client, manifestPath, template] of [
    ["codex", codexManifestPath, codexManifestTemplate()],
    ["claude", claudeManifestPath, claudeManifestTemplate()]
  ]) {
    if (!existsSync(manifestPath)) {
      remaining[client] = 0;
      continue;
    }
    const manifest = await readManifest(manifestPath, template);
    const plugins = manifest.plugins.filter(item => item.name !== PLUGIN_NAME);
    removed ||= plugins.length !== manifest.plugins.length;
    remaining[client] = plugins.length;
    manifest.plugins = plugins;
    await writeJson(manifestPath, manifest);
  }
  await rm(path.join(root, "plugins", PLUGIN_NAME), { recursive: true, force: true });
  const empty = remaining.codex === 0 && remaining.claude === 0;
  if (empty) {
    await rm(root, { recursive: true, force: true });
    await removeEmptyDirectory(path.dirname(root));
  }
  return { root, existed: true, removed, empty, codexEmpty: remaining.codex === 0, claudeEmpty: remaining.claude === 0 };
}

// Codex fails every plugin command once a registered marketplace root loses its
// manifest. Only that nextster failure is repaired; registerCodex re-adds it.
export async function recoverCodexMarketplace({ codexPath, run = runCommand }) {
  try {
    await runJson(run, codexPath, ["plugin", "marketplace", "list", "--json"]);
    return { recovered: false };
  } catch (error) {
    if (!String(error?.stderr || error?.message || error).includes(`\`${MARKETPLACE_NAME}\``)) throw error;
    await run(codexPath, ["plugin", "marketplace", "remove", MARKETPLACE_NAME, "--json"]);
    return { recovered: true };
  }
}

export async function registerCodex({ codexPath, root, run = runCommand }) {
  const removedObsolete = [];
  for (const command of OBSOLETE_CODEX_REGISTRATIONS) {
    removedObsolete.push(await runOptional(run, codexPath, command));
  }
  const marketplaces = await runJson(run, codexPath, ["plugin", "marketplace", "list", "--json"]);
  const existing = marketplaces.marketplaces?.find(item => item.name === MARKETPLACE_NAME);
  // A registration through the legacy link resolves to the shared root and stays.
  if (existing && !samePath(existing.root, root)) {
    if (existsSync(existing.root)) {
      throw new Error(`Codex marketplace ${MARKETPLACE_NAME} already points to ${existing.root}; expected ${root}`);
    }
    await run(codexPath, ["plugin", "marketplace", "remove", MARKETPLACE_NAME, "--json"]);
  }
  if (!existing || !samePath(existing.root, root)) {
    await run(codexPath, ["plugin", "marketplace", "add", root, "--json"]);
  }
  const plugins = await runJson(run, codexPath, ["plugin", "list", "--json"]);
  if (plugins.installed?.some(item => item.pluginId === PLUGIN_ID)) {
    await run(codexPath, ["plugin", "remove", PLUGIN_ID, "--json"]);
  }
  const installed = await runJson(run, codexPath, ["plugin", "add", PLUGIN_ID, "--json"]);
  return {
    skipped: false,
    command: codexPath,
    pluginId: PLUGIN_ID,
    marketplaceRoot: root,
    registeredRoot: existing?.root || root,
    removedObsolete,
    installed
  };
}

export function unregisterCodex({ codexPath, dryRun, run = runCommand }) {
  return runAll(run, codexPath, [["plugin", "remove", PLUGIN_ID, "--json"], ...OBSOLETE_CODEX_REGISTRATIONS], dryRun);
}

export function releaseCodexMarketplace({ codexPath, marketplaceEmpty, dryRun, run = runCommand }) {
  return runAll(run, codexPath, marketplaceEmpty ? [["plugin", "marketplace", "remove", MARKETPLACE_NAME, "--json"]] : [], dryRun);
}

export async function registerClaudeCode({ claudePath, root, run = runCommand }) {
  const marketplaces = await runJson(run, claudePath, ["plugin", "marketplace", "list", "--json"]);
  const existing = (Array.isArray(marketplaces) ? marketplaces : []).find(item => item.name === MARKETPLACE_NAME);
  const reinstall = [];
  let repointedFrom = null;
  if (existing && existing.source === "directory" && samePath(existing.path, root)) {
    await run(claudePath, ["plugin", "marketplace", "update", MARKETPLACE_NAME]);
  } else {
    if (existing) {
      if (existing.source !== "directory") {
        throw new Error(`Claude Code marketplace ${MARKETPLACE_NAME} already uses ${existing.source} source ${existing.path || ""}; expected ${root}`);
      }
      // Removing a Claude Code marketplace uninstalls its plugins, so sibling
      // bridge plugins are reinstalled after the marketplace moves.
      const installed = await runJson(run, claudePath, ["plugin", "list", "--json"]);
      reinstall.push(...userScopedPluginIds(installed).filter(id => id.endsWith(`@${MARKETPLACE_NAME}`) && id !== PLUGIN_ID));
      await run(claudePath, ["plugin", "marketplace", "remove", MARKETPLACE_NAME]);
      repointedFrom = existing.path;
    }
    await run(claudePath, ["plugin", "marketplace", "add", root, "--scope", "user"]);
  }

  // Claude Code caches plugins by version, so a same-version refresh needs a
  // reinstall to pick up new runtime paths.
  const installed = await runJson(run, claudePath, ["plugin", "list", "--json"]);
  if (userScopedPluginIds(installed).includes(PLUGIN_ID)) {
    await run(claudePath, ["plugin", "uninstall", PLUGIN_ID, "--scope", "user"]);
  }
  await run(claudePath, ["plugin", "install", PLUGIN_ID, "--scope", "user"]);
  const reinstalled = [];
  for (const id of reinstall) reinstalled.push(await runOptional(run, claudePath, ["plugin", "install", id, "--scope", "user"]));
  return {
    skipped: false,
    command: claudePath,
    pluginId: PLUGIN_ID,
    marketplaceRoot: root,
    repointedFrom,
    reinstalled
  };
}

export function unregisterClaudeCode({ claudePath, dryRun, run = runCommand }) {
  return runAll(run, claudePath, [["plugin", "uninstall", PLUGIN_ID, "--scope", "user"]], dryRun);
}

export function releaseClaudeMarketplace({ claudePath, marketplaceEmpty, dryRun, run = runCommand }) {
  return runAll(run, claudePath, [
    marketplaceEmpty
      ? ["plugin", "marketplace", "remove", MARKETPLACE_NAME]
      : ["plugin", "marketplace", "update", MARKETPLACE_NAME]
  ], dryRun);
}

async function runAll(run, command, commands, dryRun) {
  const results = [];
  for (const args of commands) {
    results.push(dryRun ? { command: args, dryRun: true } : await runOptional(run, command, args));
  }
  return results;
}

// Project- and local-scope installs belong to specific repositories; only the
// user-scope install is managed here.
function userScopedPluginIds(list) {
  return (Array.isArray(list) ? list : [])
    .filter(item => (item.scope || "user") === "user")
    .map(item => item.id)
    .filter(Boolean);
}

async function runJson(run, command, args) {
  const { stdout } = await run(command, args);
  return JSON.parse(stdout);
}

async function runOptional(run, command, args) {
  try {
    const { stdout } = await run(command, args);
    return { command: args, ok: true, output: parseOutput(stdout) };
  } catch (error) {
    return { command: args, ok: false, reason: String(error?.stderr || error?.message || error).trim() };
  }
}

function parseOutput(value) {
  try {
    return JSON.parse(value);
  } catch {
    return String(value || "").trim();
  }
}

function codexManifestTemplate() {
  return { name: MARKETPLACE_NAME, interface: { displayName: "Nextster" }, plugins: [] };
}

function claudeManifestTemplate() {
  return { name: MARKETPLACE_NAME, owner: { name: "Nextster" }, metadata: { description: MARKETPLACE_DESCRIPTION }, plugins: [] };
}

async function readManifest(manifestPath, template) {
  if (!existsSync(manifestPath)) return template;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.name !== MARKETPLACE_NAME || !Array.isArray(manifest.plugins)) {
    throw new Error(`Invalid shared marketplace at ${manifestPath}`);
  }
  return manifest;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

// Junctions need no elevated privileges on Windows.
function linkDirectory(target, linkPath, platform) {
  return symlink(target, linkPath, platform === "win32" ? "junction" : "dir");
}

async function removeEmptyDirectory(directory) {
  await rmdir(directory).catch(() => {});
}

async function moveDirectory(source, destination) {
  try {
    await renameWithRetry(source, destination);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await cp(source, destination, { recursive: true, preserveTimestamps: true });
    await rm(source, { recursive: true, force: true });
  }
}

function samePath(left, right) {
  const canonical = value => {
    const resolved = path.resolve(String(value || ""));
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  };
  const a = canonical(left);
  const b = canonical(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
