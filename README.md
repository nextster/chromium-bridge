# Chromium Sidecar

Chromium Sidecar connects user-authorized local tools to the Chromium browser session you already use. The repository contains a Manifest V3 extension, a macOS Native Messaging host, a CLI, and a Codex MCP plugin.

The portable extension core handles tabs, compact page snapshots, interactions, user-supplied scripts, screenshots, optional cookies, and filtered network capture. Browser-specific providers stay separate; the included Arc provider can list and focus Spaces on macOS.

## Security model

- Browser data is unavailable until the user approves website access in the extension popup.
- Website access is an optional host permission. Cookie and DevTools access are separate optional permissions.
- Network capture requires a URL substring or an explicit all-URLs opt-in. Secret fields are redacted by default, and capture events and files are size-limited.
- The extension makes no requests to a developer-operated server. It sends requested data to the user-installed local host through Chromium Native Messaging.
- Local clients, including AI tools, decide how tool output is processed and may use third-party services. Review their privacy settings before exposing sensitive pages.
- Native Messaging origins are allowlisted, the host verifies the caller origin, and local sockets and captures are owner-only.

Read [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md) before using raw cookie or capture modes.

## Install from source

Requirements:

- macOS
- Node.js 20 or newer
- Arc, Chrome, Chromium, Brave, Edge, or Vivaldi based on Chrome 138 or newer
- Codex CLI, only if the Codex plugin is wanted

The shortest installer downloads the public repository into a temporary directory and removes it after setup:

```bash
curl -fsSL https://raw.githubusercontent.com/nextster/chromium-sidecar/main/install.sh | sh
```

To inspect the installer before running it:

```bash
curl -fsSLo chromium-sidecar-install.sh https://raw.githubusercontent.com/nextster/chromium-sidecar/main/install.sh
less chromium-sidecar-install.sh
sh chromium-sidecar-install.sh
```

The equivalent manual installation is:

```bash
git clone https://github.com/nextster/chromium-sidecar.git
cd chromium-sidecar
npm run setup
```

The setup command copies the unpacked extension and native runtime under `~/.chromium-sidecar`, registers the Native Messaging host, and installs the local Codex plugin when Codex is available.

For a source build, complete these browser steps once:

1. Enable Developer mode on the browser extensions page.
2. Choose **Load unpacked** and select `~/.chromium-sidecar/extension`.
3. Open the Chromium Sidecar popup and approve local browser access.
4. Open the extension details and enable **Allow User Scripts**.
5. Reload Codex after the plugin is installed.

Run `npm run setup` again to update installed components. Useful options are `--no-open`, `--no-codex`, and `--dry-run`.

## Store installation

The Chrome Web Store can distribute only the extension. The Native Messaging host and Codex plugin remain a separate local companion because browser stores cannot install native executables.

After the store item is published, install it from the store and run:

```bash
curl -fsSL https://raw.githubusercontent.com/nextster/chromium-sidecar/main/install.sh | sh -s -- --host-only
```

Until `store/item.json` contains the final item ID, pass it explicitly with `--extension-id ITEM_ID`.

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

The installer places the CLI at `~/.chromium-sidecar/bin/chromium-sidecar`:

```bash
~/.chromium-sidecar/bin/chromium-sidecar status
~/.chromium-sidecar/bin/chromium-sidecar tabs
~/.chromium-sidecar/bin/chromium-sidecar eval active 'document.title'
~/.chromium-sidecar/bin/chromium-sidecar capture-start --filter example.com --body
~/.chromium-sidecar/bin/chromium-sidecar capture-stop
~/.chromium-sidecar/bin/chromium-sidecar curl
~/.chromium-sidecar/bin/chromium-sidecar purge
```

Captures use owner-only files under `~/.chromium-sidecar/captures`. `purge` deletes all prior capture sessions and clears the active log.

## Architecture

```text
Codex plugin or CLI
        |
        | NDJSON RPC over ~/.chromium-sidecar/control.sock (0600)
        v
Native Messaging host <-> Chromium Sidecar extension <-> Chromium APIs
        |
        +-> optional providers, including Arc Spaces through JXA
```

There is no HTTP server or listening TCP port. Chromium launches the native host over stdin/stdout; local clients use a private Unix socket.

Node.js runs the Native Messaging host, CLI, installer, tests, and Codex MCP server. It is not a web server and does not expose a network port.

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

Version `0.5.0` retains migration aliases for the former Arc-specific build:

- `ARC_CODEX_*` environment variables remain accepted.
- `com.artem.arc_codex_bridge` remains a Native Messaging alias.
- `~/.arc-codex-bridge/control.sock` remains a compatibility socket when available.
- The source build retains the development extension ID `eiffkmiekomnbpgamfchhehdafpnfgco`.

New integrations should use `CHROMIUM_SIDECAR_*`, `com.chromium_sidecar.bridge`, and `~/.chromium-sidecar`.

## Development

```bash
npm test
npm run package:extension
npm run package:store
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for release and code-quality expectations. `npm run uninstall-host` removes host manifests and runtime launchers; captures remain until explicitly purged.
