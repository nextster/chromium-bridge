# Security Policy

## Supported versions

Security fixes are made on the latest release and the `main` branch. Older releases may not receive backports.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that exposes browser data, credentials, or code execution. Use GitHub's private vulnerability reporting for this repository. Include affected versions, a minimal reproduction, impact, and any suggested mitigation.

Do not include real cookies, authorization headers, capture files, or private browsing data in a report.

## Trust boundary

Chromium Bridge trusts:

- The extension IDs listed in the installed Native Messaging manifest
- Local processes running as the same operating-system account that can access the owner-only control endpoint
- Local clients and AI services that the user intentionally connects

It does not expose an HTTP or TCP server. The extension rejects browser-data commands until popup consent and website permission are present. Native browser providers apply the same consent gate.

## Local control endpoint

On macOS the control endpoint is a Unix socket with mode `0600` inside the `0700` state directory, so filesystem permissions restrict it to the current account.

Windows named pipes live in a machine-wide namespace. Node.js creates them with the default pipe security descriptor and does not opt out of remote SMB clients, so Chromium Bridge does not rely on the pipe ACL for access control and authenticates every pipe connection instead:

- The native host creates the first pipe instance exclusively. If another process already owns the name, the host fails instead of sharing it.
- At startup the host writes a random 256-bit token to `%USERPROFILE%\.chromium-bridge\control.token`, which inherits the user profile ACL, and removes it on exit.
- Client and host exchange random nonces and prove knowledge of the token with HMAC-SHA256 in both directions before any request is processed. The token itself never crosses the pipe.

A process that cannot read the token file, including another local non-admin user or a remote client, cannot send commands. A process that squats the pipe name cannot impersonate the host, because clients reject a host that fails the proof before sending any request. Administrators, SYSTEM, and malware running as the same user can read the token and remain inside the trust boundary, as they do on macOS.

Raw cookie and capture modes intentionally expose sensitive data and should be enabled only for a specific task. Captures persist locally until purged.

Bridge-managed scripts are persistent code execution scoped to explicit `http://` or `https://` match patterns. Script ids are validated and mapped into the private `chromium-bridge-managed:` namespace; reconciliation and removal ignore every registration outside that namespace. `<all_urls>`, privileged schemes, oversized source, and malformed patterns are rejected. The isolated `USER_SCRIPT` world should be preferred; `MAIN` intentionally shares JavaScript state with the matched page and therefore has a larger page-level trust surface.

All managed-script reads and mutations require the same popup consent and website permissions as other browser-data commands. Revoking consent unregisters Bridge-managed scripts while preserving their local records. Any trusted same-account client with access to the private control socket can request persistent script mutations, so users should review the source and match patterns before authorizing such automation.

The extension UI may reveal only the Native Host's fixed state directory. Browser messages cannot supply a filesystem path, and the host launches the platform file manager with an argument array rather than a shell command.

## Installer runtime

The public installers prefer an existing Node.js 20+ executable. If none is available, `install.sh` downloads a pinned macOS Node.js archive and `install.ps1` downloads a pinned Windows Node.js ZIP over HTTPS, verify the architecture-specific SHA-256 embedded in the script, and install it only under the Chromium Bridge state directory. They do not use `sudo` or administrator rights, modify a global Node installation, or execute an unverified runtime archive.

Windows Native Messaging registration writes only per-user `HKCU\Software\<browser>\NativeMessagingHosts\com.chromium_bridge.bridge` keys. Agent client registration edits only Chromium Bridge's own entries in the shared plugin marketplace and in `claude_desktop_config.json`, and it keeps a backup of the previous Claude Desktop config.
