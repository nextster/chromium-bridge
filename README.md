# Chromium Sidecar

Chromium Sidecar lets a local AI agent operate the browser session you already use. It combines a Manifest V3 extension, a local Native Messaging host, a command-line client, and a Codex plugin in one repository.

The portable core uses Chromium extension APIs for tabs, DOM snapshots, clicks, form input, JavaScript, screenshots, cookies, and filtered network capture. Optional providers add browser-specific features; the included Arc provider can list and focus Spaces on macOS.

## Install

Requirements:

- macOS
- Node.js 20 or newer
- Arc, Chrome, Chromium, Brave, Edge, or Vivaldi
- Codex CLI, if the Codex plugin is wanted

Clone this repository, then run:

```bash
git clone https://github.com/nextster/chromium-sidecar.git
cd chromium-sidecar
npm run setup
```

The setup command:

1. Copies the extension to `~/.chromium-sidecar/extension`.
2. Installs the Native Messaging runtime under `~/.chromium-sidecar`.
3. Registers it for the supported Chromium browsers.
4. Adds this repository as a local Codex marketplace and installs the `chromium-sidecar` plugin when Codex is available.
5. Opens the installed browser's extensions page.

Chromium requires one manual step for an extension that is not store-published:

1. Enable **Developer mode** on the extensions page.
2. Choose **Load unpacked**.
3. Select `~/.chromium-sidecar/extension`.
4. Open the extension details and enable **Allow User Scripts** if the browser shows that toggle.
5. Reload Codex so it discovers the new plugin.

Run `npm run setup` again to update all installed components. Once version `0.4.0` is loaded, setup also asks the running extension to reload itself. Useful options are `--no-open`, `--no-codex`, and `--dry-run`:

```bash
npm run setup -- --no-open
```

## What It Exposes

The Codex MCP server provides:

- Browser status and provider discovery
- Tab listing, background tab creation, navigation, and guarded cleanup
- Compact DOM snapshots with stable element refs
- Click, fill, select, wait, and JavaScript execution
- Viewport screenshots
- Redacted cookie access and filtered network capture
- Replayable `curl` generation
- Arc Space listing and explicit Space focusing on macOS

Agent-created tabs open in the background by default and are tracked for cleanup. Tabs that predate the MCP session cannot be closed without an explicit force flag.

## CLI

The installer places the CLI at `~/.chromium-sidecar/bin/chromium-sidecar`:

```bash
~/.chromium-sidecar/bin/chromium-sidecar status
~/.chromium-sidecar/bin/chromium-sidecar extension-reload
~/.chromium-sidecar/bin/chromium-sidecar tabs
~/.chromium-sidecar/bin/chromium-sidecar eval active 'document.title'
~/.chromium-sidecar/bin/chromium-sidecar arc-spaces
~/.chromium-sidecar/bin/chromium-sidecar capture-start --filter example.com
~/.chromium-sidecar/bin/chromium-sidecar capture-stop
~/.chromium-sidecar/bin/chromium-sidecar curl
```

Captures are stored with owner-only permissions under `~/.chromium-sidecar/captures`. Cookie values, authorization headers, and sensitive request fields are redacted unless raw capture is explicitly requested.

## Architecture

```text
Codex plugin or CLI
        |
        | NDJSON RPC over ~/.chromium-sidecar/control.sock (0600)
        v
Native Messaging host <-> Chromium Sidecar extension <-> browser APIs
        |
        +-> optional providers, including Arc Spaces through JXA
```

There is no HTTP server or listening TCP port. The browser launches the native host and communicates over stdin/stdout; local clients use a private Unix socket.

## Compatibility

Version `0.4.0` keeps migration aliases for the former Arc-specific build:

- `ARC_CODEX_*` environment variables remain accepted.
- `com.artem.arc_codex_bridge` is registered as a legacy Native Messaging host alias.
- `~/.arc-codex-bridge/control.sock` is served as a compatibility socket when available.
- The extension keeps its original signing key, so its stable ID remains `eiffkmiekomnbpgamfchhehdafpnfgco`.

New integrations should use `CHROMIUM_SIDECAR_*`, `com.chromium_sidecar.bridge`, and `~/.chromium-sidecar`.

## Development

```bash
npm test
npm run setup -- --dry-run --no-codex --no-open
npm run package:extension
```

Repository layout:

```text
extension/                    Manifest V3 browser extension
native-host/                  Native Messaging host, CLI, providers, and tests
plugins/chromium-sidecar/     Codex plugin, MCP server, skill, and tests
scripts/                      Setup and packaging commands
.agents/plugins/              Local Codex marketplace metadata
```

`npm run uninstall-host` removes host manifests and runtime launchers. Captures are intentionally preserved.
