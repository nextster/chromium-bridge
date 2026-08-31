# Security Policy

## Supported versions

Security fixes are made on the latest release and the `main` branch. Older releases may not receive backports.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that exposes browser data, credentials, or code execution. Use GitHub's private vulnerability reporting for this repository. Include affected versions, a minimal reproduction, impact, and any suggested mitigation.

Do not include real cookies, authorization headers, capture files, or private browsing data in a report.

## Trust boundary

Chromium Bridge trusts:

- The extension IDs listed in the installed Native Messaging manifest
- Local processes running as the same operating-system account that can access the owner-only control socket
- Local clients and AI services that the user intentionally connects

It does not expose an HTTP or TCP server. The extension rejects browser-data commands until popup consent and website permission are present. Native browser providers apply the same consent gate.

Raw cookie and capture modes intentionally expose sensitive data and should be enabled only for a specific task. Captures persist locally until purged.

Bridge-managed scripts are persistent code execution scoped to explicit `http://` or `https://` match patterns. Script ids are validated and mapped into the private `chromium-bridge-managed:` namespace; reconciliation and removal ignore every registration outside that namespace. `<all_urls>`, privileged schemes, oversized source, and malformed patterns are rejected. The isolated `USER_SCRIPT` world should be preferred; `MAIN` intentionally shares JavaScript state with the matched page and therefore has a larger page-level trust surface.

All managed-script reads and mutations require the same popup consent and website permissions as other browser-data commands. Revoking consent unregisters Bridge-managed scripts while preserving their local records. Any trusted same-account client with access to the private control socket can request persistent script mutations, so users should review the source and match patterns before authorizing such automation.

The extension UI may reveal only the Native Host's fixed state directory. Browser messages cannot supply a filesystem path, and the host launches the platform file manager with an argument array rather than a shell command.

## Installer runtime

The public shell installer prefers an existing Node.js 20+ executable. If none is available, it downloads a pinned macOS Node.js archive over HTTPS, verifies the architecture-specific SHA-256 embedded in `install.sh`, and installs it only under `~/.chromium-bridge`. It does not use `sudo`, modify a global Node installation, or execute an unverified runtime archive.
