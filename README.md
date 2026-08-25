# Chromium Bridge

Chromium Bridge connects user-authorized local tools to the Chromium browser session you already use. The repository contains a Manifest V3 extension, a macOS Native Messaging host, a CLI, and a Codex MCP plugin.

The portable extension core handles tabs, compact page snapshots, interactions, user-supplied scripts, screenshots, optional cookies, and filtered network capture. Browser-specific providers stay separate; the included Arc provider can list and focus Spaces on macOS.

## Security model

- Browser data is unavailable until the user approves website access in the extension popup.
- Website access is an optional host permission. Cookie and DevTools access are separate optional permissions.
- Network capture requires a URL substring or an explicit all-URLs opt-in. Secret fields are redacted by default, and capture events and files are size-limited.
- The extension makes no requests to a developer-operated server. It sends requested data to the user-installed local host through Chromium Native Messaging.
- Local clients, including AI tools, decide how tool output is processed and may use third-party services. Review their privacy settings before exposing sensitive pages.
- Native Messaging origins are allowlisted, the host verifies the caller origin, and local sockets and captures are owner-only.

Read [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md) before using raw cookie or capture modes.

## One-command installation

Requirements:

- macOS
- Arc, Chrome, Chromium, Brave, Edge, or Vivaldi based on Chrome 138 or newer
- Codex CLI available as `codex`

Run:

```bash
curl -fsSL https://raw.githubusercontent.com/nextster/chromium-bridge/main/install.sh | sh
```

The installer:

1. Uses an existing Node.js 20+ runtime, or installs a pinned and SHA-256-verified Node.js runtime under `~/.chromium-bridge`.
2. Installs the Native Messaging host and CLI for supported Chromium browsers.
3. Copies the Codex marketplace to a persistent location and registers the Chromium Bridge plugin.
4. When a Store item ID is configured, opens the Unlisted Store listing and waits for extension installation, local-access consent, and Allow User Scripts.
5. Reports readiness after the browser bridge answers a live status check.

No administrator access, Homebrew, global npm package, HTTP server, or permanent source checkout is required. Restart Codex after first installation so it loads the plugin.

Until `store/item.json` contains a published Store item ID, the same command installs the development extension under `~/.chromium-bridge/extension` and opens the browser extensions page. Development mode still requires selecting **Load unpacked** once.

To inspect the installer before running it:

```bash
curl -fsSLo chromium-bridge-install.sh https://raw.githubusercontent.com/nextster/chromium-bridge/main/install.sh
less chromium-bridge-install.sh
sh chromium-bridge-install.sh
```

The equivalent source installation is:

```bash
git clone https://github.com/nextster/chromium-bridge.git
cd chromium-bridge
npm run setup
```

The setup command copies the unpacked extension and native runtime under `~/.chromium-bridge`, registers the Native Messaging host, and installs the local Codex plugin.

For a source build, complete these browser steps once:

1. Enable Developer mode on the browser extensions page.
2. Choose **Load unpacked** and select `~/.chromium-bridge/extension`.
3. Open the Chromium Bridge popup and approve local browser access.
4. Open the extension details and enable **Allow User Scripts**.
5. Reload Codex after the plugin is installed.

Run the one-command installer again to update installed components. Source developers can use `npm run setup -- --source`. Useful options are `--no-open`, `--no-wait`, `--no-codex`, and `--dry-run`.

## Store installation

The Chrome Web Store can distribute only the extension. The Native Messaging host and Codex plugin remain a separate local companion because browser stores cannot install native executables.

After the Store item is published and recorded in `store/item.json`, the normal one-command installer automatically uses Store mode. An explicit host-only installation remains available:

```bash
curl -fsSL https://raw.githubusercontent.com/nextster/chromium-bridge/main/install.sh | sh -s -- --host-only
```

Until `store/item.json` contains the final item ID, pass it explicitly with `--extension-id ITEM_ID`.

## Update and uninstall

Update by running the installation command again, or explicitly:

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
~/.chromium-bridge/bin/chromium-bridge capture-start --filter example.com --body
~/.chromium-bridge/bin/chromium-bridge capture-stop
~/.chromium-bridge/bin/chromium-bridge curl
~/.chromium-bridge/bin/chromium-bridge purge
```

Captures use owner-only files under `~/.chromium-bridge/captures`. `purge` deletes all prior capture sessions and clears the active log.

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

This creates a validated Store ZIP without the development `key`. After creating the draft item, record its ID:

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
npm test
npm run package:extension
npm run package:store
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for release and code-quality expectations. `npm run uninstall` performs a local source-checkout uninstall; `npm run uninstall-host` removes only Native Messaging manifests and runtime launchers.
