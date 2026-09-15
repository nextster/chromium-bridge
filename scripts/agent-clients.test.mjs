import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  marketplaceLocations,
  migrateLegacyMarketplace,
  detachCodexMarketplace,
  registerClaudeCode,
  registerCodex,
  releaseClaudeMarketplace,
  removeFromSharedMarketplace
} from "./agent-clients.mjs";

test("marketplace locations default to a neutral shared directory", () => {
  assert.deepEqual(marketplaceLocations({ env: {}, homedir: "/home/example" }), {
    root: "/home/example/.agent-plugins/nextster",
    legacyRoot: "/home/example/.codex/marketplaces/nextster"
  });
  assert.deepEqual(marketplaceLocations({
    env: { NEXTSTER_MARKETPLACE_DIR: "/opt/market", CODEX_HOME: "/opt/codex" },
    homedir: "/home/example"
  }), { root: "/opt/market", legacyRoot: "/opt/codex/marketplaces/nextster" });
});

test("legacy marketplace copies of other plugins replace shared copies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-market-merge-"));
  const shared = path.join(root, "shared");
  const legacy = path.join(root, "legacy");
  try {
    await writeManifest(shared, [{ name: "chromium-bridge" }, { name: "figma-bridge", version: "old" }]);
    await mkdir(path.join(shared, "plugins", "figma-bridge"), { recursive: true });
    await writeFile(path.join(shared, "plugins", "figma-bridge", "marker.txt"), "stale");
    await writeManifest(legacy, [{ name: "chromium-bridge" }, { name: "figma-bridge", version: "new" }]);
    await mkdir(path.join(legacy, "plugins", "figma-bridge"), { recursive: true });
    await writeFile(path.join(legacy, "plugins", "figma-bridge", "marker.txt"), "fresh");

    const result = await migrateLegacyMarketplace({ root: shared, legacyRoot: legacy });
    assert.deepEqual(result.imported, ["figma-bridge"]);
    await assert.rejects(access(legacy));
    assert.equal(await readFile(path.join(shared, "plugins", "figma-bridge", "marker.txt"), "utf8"), "fresh");
    const manifest = JSON.parse(await readFile(path.join(shared, ".agents", "plugins", "marketplace.json"), "utf8"));
    assert.deepEqual(manifest.plugins.map(item => [item.name, item.version]), [["chromium-bridge", undefined], ["figma-bridge", "new"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex detaches the legacy marketplace, recovers from a lost root, and refuses unrelated roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-codex-repoint-"));
  const shared = path.join(root, "shared");
  const legacy = path.join(root, "legacy");
  await mkdir(shared, { recursive: true });
  await mkdir(legacy, { recursive: true });
  try {
    const calls = [];
    const detached = await detachCodexMarketplace({
      codexPath: "codex",
      root: shared,
      legacyRoot: legacy,
      run: fakeRun(calls, { "plugin marketplace list --json": { marketplaces: [{ name: "nextster", root: legacy }] } })
    });
    assert.deepEqual(detached, { detachedFrom: legacy, recovered: false });
    assert.deepEqual(calls.map(args => args.join(" ")), [
      "plugin marketplace list --json",
      "plugin marketplace remove nextster --json"
    ]);

    let listed = 0;
    const recoveryCalls = [];
    const recovered = await detachCodexMarketplace({
      codexPath: "codex",
      root: shared,
      legacyRoot: legacy,
      run: async (command, args) => {
        recoveryCalls.push(args.join(" "));
        if (args.join(" ") === "plugin marketplace list --json" && listed++ === 0) {
          throw Object.assign(new Error("failed"), {
            stderr: `failed to load marketplace(s):\n- \`nextster\` at ${legacy}: marketplace root does not contain a supported manifest`
          });
        }
        return { stdout: args.includes("list") ? JSON.stringify({ marketplaces: [] }) : "" };
      }
    });
    assert.deepEqual(recovered, { detachedFrom: null, recovered: true });
    assert.deepEqual(recoveryCalls, [
      "plugin marketplace list --json",
      "plugin marketplace remove nextster --json",
      "plugin marketplace list --json"
    ]);
    const unrelated = [];
    await assert.rejects(detachCodexMarketplace({
      codexPath: "codex",
      root: shared,
      legacyRoot: legacy,
      run: async (command, args) => {
        unrelated.push(args.join(" "));
        throw Object.assign(new Error("failed"), { stderr: "- `other` at /x: marketplace root does not contain a supported manifest" });
      }
    }), /failed/);
    assert.deepEqual(unrelated, ["plugin marketplace list --json"]);

    const registration = [];
    await registerCodex({
      codexPath: "codex",
      root: shared,
      run: fakeRun(registration, {
        "plugin marketplace list --json": { marketplaces: [] },
        "plugin list --json": { installed: [] },
        "plugin add chromium-bridge@nextster --json": { installed: true }
      })
    });
    assert.ok(registration.some(args => args.join(" ") === `plugin marketplace add ${shared} --json`));

    const other = path.join(root, "other");
    await mkdir(other);
    await assert.rejects(detachCodexMarketplace({
      codexPath: "codex",
      root: shared,
      legacyRoot: legacy,
      run: fakeRun([], { "plugin marketplace list --json": { marketplaces: [{ name: "nextster", root: other }] } })
    }), /already points to/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude Code registration refreshes in place and reinstalls siblings after a move", async () => {
  const calls = [];
  await registerClaudeCode({
    claudePath: "claude",
    root: "/tmp/shared",
    run: fakeRun(calls, {
      "plugin marketplace list --json": [{ name: "nextster", source: "directory", path: "/tmp/shared" }],
      "plugin list --json": [{ id: "chromium-bridge@nextster" }]
    })
  });
  assert.deepEqual(calls.map(args => args.join(" ")), [
    "plugin marketplace list --json",
    "plugin marketplace update nextster",
    "plugin list --json",
    "plugin uninstall chromium-bridge@nextster --scope user",
    "plugin install chromium-bridge@nextster --scope user"
  ]);

  const moved = [];
  const result = await registerClaudeCode({
    claudePath: "claude",
    root: "/tmp/shared",
    run: fakeRun(moved, {
      "plugin marketplace list --json": [{ name: "nextster", source: "directory", path: "/tmp/old" }],
      "plugin list --json": [
        { id: "figma-bridge@nextster", scope: "user" },
        { id: "telegram-bridge@nextster", scope: "project", projectPath: "/work/repo" },
        { id: "other@elsewhere", scope: "user" }
      ]
    })
  });
  assert.equal(result.repointedFrom, "/tmp/old");
  assert.deepEqual(moved.map(args => args.join(" ")), [
    "plugin marketplace list --json",
    "plugin list --json",
    "plugin marketplace remove nextster",
    "plugin marketplace add /tmp/shared --scope user",
    "plugin list --json",
    "plugin install chromium-bridge@nextster --scope user",
    "plugin install figma-bridge@nextster --scope user"
  ]);

  const projectOnly = [];
  await registerClaudeCode({
    claudePath: "claude",
    root: "/tmp/shared",
    run: fakeRun(projectOnly, {
      "plugin marketplace list --json": [{ name: "nextster", source: "directory", path: "/tmp/shared" }],
      "plugin list --json": [{ id: "chromium-bridge@nextster", scope: "project", projectPath: "/work/repo" }]
    })
  });
  assert.ok(!projectOnly.some(args => args[1] === "uninstall"));
  assert.deepEqual(projectOnly.at(-1), ["plugin", "install", "chromium-bridge@nextster", "--scope", "user"]);

  await assert.rejects(registerClaudeCode({
    claudePath: "claude",
    root: "/tmp/shared",
    run: fakeRun([], { "plugin marketplace list --json": [{ name: "nextster", source: "github", path: "x/y" }] })
  }), /already uses github/);
});

test("removal keeps sibling plugins per client manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chromium-bridge-market-remove-"));
  try {
    await writeManifest(root, [{ name: "chromium-bridge" }, { name: "telegram-bridge" }]);
    await mkdir(path.join(root, ".claude-plugin"), { recursive: true });
    await writeFile(path.join(root, ".claude-plugin", "marketplace.json"), JSON.stringify({
      name: "nextster",
      owner: { name: "Nextster" },
      plugins: [{ name: "chromium-bridge", source: "./plugins/chromium-bridge" }]
    }));
    const result = await removeFromSharedMarketplace(root);
    assert.deepEqual(
      { existed: result.existed, empty: result.empty, codexEmpty: result.codexEmpty, claudeEmpty: result.claudeEmpty },
      { existed: true, empty: false, codexEmpty: false, claudeEmpty: true }
    );
    const claude = JSON.parse(await readFile(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
    assert.deepEqual(claude.plugins, []);

    const calls = [];
    await releaseClaudeMarketplace({ claudePath: "claude", marketplaceEmpty: result.claudeEmpty, run: fakeRun(calls, {}) });
    assert.deepEqual(calls, [["plugin", "marketplace", "remove", "nextster"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fakeRun(calls, responses) {
  return async (command, args) => {
    calls.push(args);
    const response = responses[args.join(" ")];
    return { stdout: response === undefined ? "" : JSON.stringify(response) };
  };
}

async function writeManifest(root, plugins) {
  await mkdir(path.join(root, ".agents", "plugins"), { recursive: true });
  await writeFile(path.join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "nextster", plugins }));
}
