# Security Policy

## Supported versions

Security fixes are made on the latest release and the `main` branch. Older releases may not receive backports.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that exposes browser data, credentials, or code execution. Use GitHub's private vulnerability reporting for this repository. Include affected versions, a minimal reproduction, impact, and any suggested mitigation.

Do not include real cookies, authorization headers, capture files, or private browsing data in a report.

## Trust boundary

Chromium Sidecar trusts:

- The extension IDs listed in the installed Native Messaging manifest
- Local processes running as the same operating-system account that can access the owner-only control socket
- Local clients and AI services that the user intentionally connects

It does not expose an HTTP or TCP server. The extension rejects browser-data commands until popup consent and website permission are present. Native browser providers apply the same consent gate.

Raw cookie and capture modes intentionally expose sensitive data and should be enabled only for a specific task. Captures persist locally until purged.

## Installer runtime

The public shell installer prefers an existing Node.js 20+ executable. If none is available, it downloads a pinned macOS Node.js archive over HTTPS, verifies the architecture-specific SHA-256 embedded in `install.sh`, and installs it only under `~/.chromium-sidecar`. It does not use `sudo`, modify a global Node installation, or execute an unverified runtime archive.
