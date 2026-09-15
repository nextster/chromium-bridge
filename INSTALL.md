# Installing Chromium Bridge with an agent

These instructions are for an AI agent, such as Codex or Claude Code, that installs Chromium Bridge on the user's computer. People can follow them too.

Chromium Bridge has two parts:

- **Local companion.** The installer adds the Native Messaging host, the CLI, and the MCP server, and registers Codex, Claude Code, and Claude Desktop. The agent runs it.
- **Browser extension.** It comes from the Chrome Web Store. The user installs it.

## Rules

- Show the user each command before you run it.
- Do not install, enable, or configure the browser extension yourself. Do not use a built-in, embedded, headless, or automated browser for any step. The user installs the extension in the Chromium browser they use every day.
- Do not use `sudo` or administrator rights, and do not edit Codex, Claude, browser, or registry configuration by hand. The installer does all of it.
- Do not change the installer's arguments beyond what these steps say.

## 1. Run the installer

macOS, in a shell:

```bash
curl -fsSL https://raw.githubusercontent.com/nextster/chromium-bridge/main/install.sh | sh -s -- --no-open --no-wait
```

Windows, in PowerShell:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/nextster/chromium-bridge/main/install.ps1))) --no-open --no-wait
```

Windows, from a POSIX shell such as Git Bash:

```bash
powershell -NoProfile -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/nextster/chromium-bridge/main/install.ps1))) --no-open --no-wait"
```

`--no-open` leaves the Store listing to the user, and `--no-wait` returns right away so the command does not outlive your tool timeout.

The installer is idempotent. It prints JSON last; read it before you continue:

- `nativeHost.browsers` lists the browsers that can reach the companion.
- `codex`, `claudeCode`, and `claudeDesktop` report each client. `skipped: true` with `reason: "... not found"` is normal for a client that is not installed.
- `next` lists what is left for the user.

If the installer fails, run the same command once more. If it fails again, stop and show the user the last lines of the error verbatim. Check [Troubleshooting](#troubleshooting) first.

## 2. Hand the extension to the user

Give the user this link and ask them to open it in their everyday browser:

https://chromewebstore.google.com/detail/chromium-bridge/lgfjelplnddfhmjjbhmmmmiglbgkeilb

Ask the user to do these steps in that browser:

1. Click **Add to browser**. In Microsoft Edge, first allow extensions from other stores when Edge asks.
2. Approve local browser access in the Chromium Bridge popup or onboarding page.
3. Open the extension details and enable **Allow User Scripts**.

Chrome, Edge, Brave, Vivaldi, and Chromium work on both systems; Arc works on macOS.

## 3. Wait until the bridge is ready

Every 5 seconds, for up to 10 minutes, run the status command.

macOS:

```bash
~/.chromium-bridge/bin/chromium-bridge status
```

Windows, in PowerShell:

```powershell
& "$env:USERPROFILE\.chromium-bridge\bin\chromium-bridge.cmd" status
```

The bridge is ready when the JSON output has:

- `extension.pong` set to `true`
- `extension.privacy.consented` set to `true`
- `extension.permissions.siteAccess` and `extension.permissions.tabs` set to `true`
- `extension.userScriptsAvailable` set to `true`

While you wait, map the output to one reminder for the user:

- **`Chromium Bridge is unavailable at …`:** the extension is not installed yet, or the browser is closed. Remind the user to add the extension and keep the browser open.
- **`privacy.consented` or a permission is `false`:** remind the user to approve access in the popup.
- **`userScriptsAvailable` is `false`:** remind the user to enable Allow User Scripts.
- **`host.extension.id` is not `lgfjelplnddfhmjjbhmmmmiglbgkeilb`:** another Chromium Bridge build is connected. Ask the user to remove it and install the Store version.

## 4. Finish

Tell the user the result. Tools load only in new sessions, so remind them to:

- start a new Codex task or Claude Code session;
- restart Claude Desktop if `claudeDesktop.restartRequired` was `true`.

Claude Desktop gets the MCP tools only. The routing skill works in Codex and Claude Code.

## Troubleshooting

- **The Node.js download or checksum fails:** the network or a proxy blocked `nodejs.org`. Retry, or install Node.js 20 or newer and rerun.
- **`CODEX_HOME points to … but that path does not exist`:** unset `CODEX_HOME` or create that directory, then rerun.
- **`Claude Desktop config is not valid JSON`:** `claude_desktop_config.json` is damaged. Ask the user to fix or remove it, or rerun with `--no-claude-desktop`.
- **`Node.js path must be ASCII for Windows launchers`:** rerun with the private runtime. In PowerShell, run `$env:CHROMIUM_BRIDGE_FORCE_PORTABLE_NODE = '1'` first, then the Windows installer command.
- **`Codex marketplace nextster already points to …`:** a different `nextster` marketplace is registered in Codex. Show the user the path; do not remove it yourself.
- **Windows file errors (`EPERM` or `EBUSY`):** a browser or antivirus was holding a file. Ask the user to close browsers that use Chromium Bridge, then rerun.
- **The browser still reports unavailable after installation:** ask the user to restart the browser once, so it rereads the Native Messaging registration.

To skip a client, add `--no-codex`, `--no-claude-code`, `--no-claude-desktop`, or `--no-claude` (both Claude clients) to the installer arguments.

## Uninstall

macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/nextster/chromium-bridge/main/install.sh | sh -s -- uninstall --no-open
```

Windows, in PowerShell:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/nextster/chromium-bridge/main/install.ps1))) uninstall --no-open
```

Add `--purge` to also delete captures. The user removes the extension from the browser's extensions page.
