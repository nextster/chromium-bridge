# Chromium Bridge

Chromium Bridge connects user-authorized local tools to the Chromium browser session you already use. The repository contains a Manifest V3 extension, a macOS Native Messaging host, a CLI, and a Codex MCP plugin.

The portable extension core handles tabs, compact page snapshots, interactions, user-supplied scripts, screenshots, optional cookies, and filtered network capture. Browser-specific providers stay separate; the included Arc provider can list and focus Spaces on macOS.

## Security model

- Browser data is unavailable until the user approves website access in the extension popup.
- Website, tab, and cookie access remain unavailable until the user grants the optional permissions. Chromium requires the DevTools `debugger` permission at install time, but the extension's consent gate still blocks its use until local browser access is approved.
- Network capture requires a URL substring or an explicit all-URLs opt-in. Secret fields are redacted by default, and capture events and files are size-limited.
- Persistent scripts are stored locally, limited to explicit `http://` and `https://` match patterns, and registered only under Chromium Bridge's private script namespace. Revoking browser consent unregisters them without deleting their records.
- The extension makes no requests to a developer-operated server. It sends requested data to the user-installed local host through Chromium Native Messaging.
- Local clients, including AI tools, decide how tool output is processed and may use third-party services. Review their privacy settings before exposing sensitive pages.
- Native Messaging origins are allowlisted, the host verifies the caller origin, and local sockets and captures are owner-only.

Read [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md) before using raw cookie or capture modes.

## Install

Requirements:

- macOS
- Arc, Chrome, Chromium, Brave, Edge, or Vivaldi based on Chrome 138 or newer
- Codex desktop app or CLI. The installer detects `codex` in `PATH` and the CLI bundled inside `ChatGPT.app` or `Codex.app`.

Run:

```bash
curl -fsSL https://raw.githubusercontent.com/nextster/chromium-bridge/main/install.sh | sh
```

The installer opens the [Unlisted Chrome Web Store listing](https://chromewebstore.google.com/detail/chromium-bridge/lgfjelplnddfhmjjbhmmmmiglbgkeilb). Chromium requires one explicit **Add to browser** confirmation; approve local browser access in the extension popup and enable **Allow User Scripts** when prompted.

The installer:

1. Uses an existing Node.js 20+ runtime, or installs a pinned and SHA-256-verified Node.js runtime under `~/.chromium-bridge`.
2. Installs the Native Messaging host and CLI for supported Chromium browsers.
3. Adds Chromium Bridge to the shared Nextster marketplace under `~/.codex/marketplaces/nextster` and registers `chromium-bridge@nextster`.
4. Opens the Unlisted Store listing and waits for extension installation, local-access consent, and Allow User Scripts.
5. Reports readiness after the browser bridge answers a live status check.

No administrator access, Homebrew, global npm package, HTTP server, or permanent source checkout is required. Start a new Codex task after first installation so it loads the plugin; restarting the app is not required.

To inspect the installer before running it:

```bash
curl -fsSLo chromium-bridge-install.sh https://raw.githubusercontent.com/nextster/chromium-bridge/main/install.sh
less chromium-bridge-install.sh
sh chromium-bridge-install.sh
```

The equivalent development installation is:

```bash
git clone https://github.com/nextster/chromium-bridge.git
cd chromium-bridge
npm run setup -- --source
```

The setup command copies the unpacked extension and native runtime under `~/.chromium-bridge`, registers the Native Messaging host, and installs the local Codex plugin.

For a source build, complete these browser steps once:

1. Enable Developer mode on the browser extensions page.
2. Choose **Load unpacked** and select `~/.chromium-bridge/extension`.
3. Open the Chromium Bridge popup and approve local browser access.
4. Open the extension details and enable **Allow User Scripts**.
5. Reload Codex after the plugin is installed.

Run the one-command installer again to update installed components. Useful options are `--no-open`, `--no-wait`, `--no-codex`, and `--dry-run`. Set `CHROMIUM_BRIDGE_REF=main` only when intentionally testing the unreleased development branch.

### Migrating from Load unpacked

Run the normal installation command. The installer refreshes the managed unpacked copy, verifies that the connected extension has the development ID, removes only that development extension, and opens the Store listing. Chromium still requires one explicit **Add to browser** confirmation. The installer then waits for the exact Store ID, new popup consent, and Allow User Scripts before deleting the obsolete local extension files.

An unpacked extension loaded directly from an arbitrary source checkout may be too old for automatic removal. In that case, remove that one development extension from the browser extensions page and rerun the installer; the Native Messaging host, Codex plugin, and captures remain intact.

## Store installation

The Chrome Web Store can distribute only the extension. The Native Messaging host and Codex plugin remain a separate local companion because browser stores cannot install native executables.

The normal one-command installer uses Store mode. An explicit host-only installation remains available when the extension is already installed:

```bash
curl -fsSL https://raw.githubusercontent.com/nextster/chromium-bridge/main/install.sh | sh -s -- --host-only
```

## Homebrew

The curl installer remains the shortest path and does not require Homebrew. Users who prefer Homebrew can install the companion from the official nextster tap:

```bash
brew install nextster/tap/chromium-bridge
chromium-bridge setup
```

`brew install` installs the versioned companion and its Node.js dependency. The explicit `setup` command registers the Native Messaging host for supported browsers, installs the Codex plugin, opens the Store listing, and performs the same readiness check as the curl installer.

Upgrade and re-register the installed companion with:

```bash
brew update
brew upgrade chromium-bridge
chromium-bridge setup
```

Before removing the Formula, unregister the companion and Codex plugin:

```bash
chromium-bridge uninstall
brew uninstall chromium-bridge
```

## Update and uninstall

For curl installations, update by running the installation command again, or explicitly:

```bash
curl -fsSL https://raw.githubusercontent.com/nextster/chromium-bridge/main/install.sh | sh -s -- update
```

Remove the native host, CLI, development extension copy, portable runtime, and Codex plugin registration while preserving captures:

```bash
curl -fsSL https://raw.githubusercontent.com/nextster/chromium-bridge/main/install.sh | sh -s -- uninstall
```

Add `--purge` to delete captures and all remaining `~/.chromium-bridge` data. The browser opens its extensions page because Chromium requires the user to remove the browser extension explicitly.

## What it exposes

The Codex MCP server provides:

- Browser status and provider discovery
- Tab listing, background tab creation, navigation, and guarded cleanup
- Compact DOM snapshots with stable temporary refs
- Click, fill, select, wait, and user-supplied JavaScript execution
- Bridge-managed persistent JavaScript with list, inspect, upsert, enable/disable, removal, and restart reconciliation
- Viewport screenshots
- Optional redacted cookie access and filtered network capture
- Replayable, shell-safe `curl` generation
- Arc Space listing and explicit Space focusing on macOS

Agent-created tabs open in the background by default and are tracked for cleanup. The MCP server closes remaining agent-owned tabs when it exits. Tabs that predate the MCP session cannot be closed without an explicit force flag.

## CLI

The installer places the CLI at `~/.chromium-bridge/bin/chromium-bridge`:

```bash
~/.chromium-bridge/bin/chromium-bridge status
~/.chromium-bridge/bin/chromium-bridge tabs
~/.chromium-bridge/bin/chromium-bridge eval active 'document.title'
~/.chromium-bridge/bin/chromium-bridge managed-script-list
~/.chromium-bridge/bin/chromium-bridge managed-script-get youtube-cleanup
~/.chromium-bridge/bin/chromium-bridge managed-script-enable youtube-cleanup false
~/.chromium-bridge/bin/chromium-bridge capture-start --filter example.com --body
~/.chromium-bridge/bin/chromium-bridge capture-stop
~/.chromium-bridge/bin/chromium-bridge curl
~/.chromium-bridge/bin/chromium-bridge purge
```

Captures use owner-only files under `~/.chromium-bridge/captures`. `purge` deletes all prior capture sessions and clears the active log.

### Bridge-managed scripts

Persistent scripts use `chrome.userScripts.register`, `update`, and `unregister`. Their canonical versioned records live in `chrome.storage.local`; startup reconciliation restores enabled registrations, removes stale registrations only from the `chromium-bridge-managed:` namespace, and leaves Arc Boosts and scripts owned by other extensions untouched.

Open the extension popup and choose **Manage persistent scripts** to list, search, enable, disable, add, edit, or remove Bridge-managed scripts. The manager can also reveal the fixed Chromium Bridge state directory. Script source remains canonical in browser-local extension storage and is edited through the manager, MCP tools, or CLI; the state directory is not a writable script source directory.

Each script has a Bridge-local id, name, explicit match patterns, JavaScript source, enabled state, `runAt`, and execution `world`. Source is limited to 256 KiB per script, the collection is bounded, `<all_urls>` is forbidden, and only `http://` or `https://` match patterns are accepted. Prefer the isolated `USER_SCRIPT` world; use `MAIN` only when the script must share JavaScript state with the page.

Example CLI upsert:

```bash
~/.chromium-bridge/bin/chromium-bridge managed-script-upsert '{
  "id": "youtube-cleanup",
  "name": "YouTube cleanup",
  "matches": ["https://www.youtube.com/*"],
  "js": "document.documentElement.dataset.chromiumBridge = \"enabled\";",
  "enabled": true,
  "runAt": "document_idle",
  "world": "USER_SCRIPT"
}'
```

Disabling a script retains its canonical record but unregisters it. Removing a script deletes both its record and its Bridge-owned registration. Revoking Chromium Bridge browser consent unregisters all Bridge-managed scripts while preserving their records for restoration after consent is granted again.

## Architecture

```text
Codex plugin or CLI
        |
        | NDJSON RPC over ~/.chromium-bridge/control.sock (0600)
        v
Native Messaging host <-> Chromium Bridge extension <-> Chromium APIs
        |
        +-> optional providers, including Arc Spaces through JXA
```

There is no HTTP server or listening TCP port. Chromium launches the native host over stdin/stdout; local clients use a private Unix socket.

Node.js runs the Native Messaging host, CLI, installer, tests, and Codex MCP server. It is not a web server and does not expose a network port. The installer uses a compatible system Node.js or a private verified runtime; it does not install Node globally.

## Store release

```bash
npm run package:store
```

This creates a validated Store ZIP without the development `key`. The published Store item ID is recorded in `store/item.json`. To change it for a fork or a replacement item:

```bash
npm run configure:store -- ITEM_ID
```

Then reinstall the host, test the store build, and follow [store/submission-checklist.md](store/submission-checklist.md). Store copy, privacy declarations, permission explanations, reviewer instructions, and assets live under `store/`.

## Compatibility

Version `0.6.0` renames the project from Chromium Sidecar to Chromium Bridge. The installer moves the previous state directory to `~/.chromium-bridge`, preserves captures and a private Node runtime, removes obsolete Native Messaging and Codex registrations, and installs the new identifiers. Source-mode upgrades retain only an extension-path symlink so an already loaded unpacked extension can reload without manual repair.

- `ARC_CODEX_*` environment variables remain accepted for the former Arc-specific build.
- `~/.arc-codex-bridge/control.sock` remains a compatibility socket when available.
- The source build retains the development extension ID `eiffkmiekomnbpgamfchhehdafpnfgco`.

New integrations should use `CHROMIUM_BRIDGE_*`, `com.chromium_bridge.bridge`, and `~/.chromium-bridge`.

## Development

```bash
npm run dev:link
npm run dev:status
npm test
npm run bridge -- extension-reload
npm run package:extension
npm run package:store
npm run package:source
npm run dev:unlink
```

`npm run dev:link` performs the one-time Codex registration needed for the stable runtime bootstrap, then records the canonical path of the current checkout in an owner-only local pointer. Future MCP, CLI, and Native Messaging processes load their fixed entrypoints from that checkout, while ordinary setup and release packages continue to use the copied, versioned bundled runtime. Repeating `dev:link` for the same checkout is idempotent and does not remove or add the plugin again.

The normal loop is: edit source, run tests, run `npm run bridge -- extension-reload` when extension or native-host code changed, then open a new Codex task. A new task is required after MCP tool-list or schema changes because MCP capabilities are fixed at `initialize`; already-open tasks are not hot-reloaded. Use `npm run dev:status` to compare the repository, installed plugin, configured and effective MCP entrypoint/cwd, bundled native runtime, current native-host process, and development pointer. `npm run dev:unlink` removes only that pointer and returns future processes to the installed bundled runtime.

Moving or deleting a linked checkout makes the pointer invalid instead of silently executing another path. Run `npm run dev:link` from the new checkout location to repair it. Running ordinary `npm run setup` also clears development mode before refreshing the bundled installation.

See [CONTRIBUTING.md](CONTRIBUTING.md) for release and code-quality expectations. `npm run uninstall` performs a local source-checkout uninstall; `npm run uninstall-host` removes only Native Messaging manifests and runtime launchers.
