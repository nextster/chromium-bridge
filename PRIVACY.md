# Chromium Bridge Privacy Policy

Effective date: August 14, 2026

Chromium Bridge is a user-operated browser automation bridge. This policy describes the extension, Native Messaging host, CLI, and bundled Codex plugin in this repository.

## Single purpose

Chromium Bridge connects local tools that the user installs and controls to the user's Chromium browser so those tools can inspect and operate browser tabs at the user's request.

## Data handled

Depending on the command the user runs, Chromium Bridge may handle:

- Website content and resources, including visible text, form metadata, screenshots, HTTP request and response metadata, and user-requested script results
- Web browsing activity, including tab titles, URLs, navigation state, and the domains or resources involved in a filtered capture
- Authentication information, including cookies, authorization headers, and request data, only when the user grants optional cookie access or explicitly starts capture
- Information displayed by websites, which may include identifiers, communications, location, health, financial, or payment information
- Browser interaction data needed to click, fill, select, wait, navigate, or close a tab
- Basic extension and host diagnostics, including versions, process identifiers, and connection errors

The extension requires an explicit approval in its popup before browser data is available. Cookie and DevTools access are separate optional permissions. Raw secrets are excluded from normal cookie output and capture unless the user explicitly enables a raw mode.

Chromium Bridge does not request access to incognito browsing.

## How data is used

Data is used only to perform the browser automation, inspection, debugging, capture, and replay operation requested by the user. Chromium Bridge does not use browser data for advertising, profiling, credit decisions, analytics, or sale.

The use of information received from Chrome APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Data sharing and network transfer

The extension does not contact a developer-operated server. It transfers requested data to the user-installed Chromium Bridge native host on the same computer through Chromium Native Messaging.

Chromium Bridge is designed to be called by local third-party clients, including command-line tools and AI agents. Those clients may transmit tool inputs or outputs to services selected by the user. Such processing is controlled by the client, not by Chromium Bridge, and is governed by that client's configuration and privacy policy. Users should not grant a client access to sensitive browser data unless they trust that client and its service providers.

Chromium Bridge does not sell user data or transfer it to advertising platforms, data brokers, or information resellers.

## Local storage and retention

The extension stores only consent state and capture preferences in `chrome.storage.local`. Active capture is disabled whenever the extension service worker starts, and raw-secret mode is never persisted.

When capture is started, the native host writes owner-only files under `~/.chromium-bridge/captures`. The append-only event log is capped at 256 MiB per host session by default, and the latest-event snapshot and in-memory retention are separately bounded. Capture files remain until the user deletes them.

Users can delete all capture sessions with:

```bash
~/.chromium-bridge/bin/chromium-bridge purge
```

Uninstalling the extension stops future access but does not silently delete capture files. Users may also remove `~/.chromium-bridge/captures` themselves.

## Security

Native Messaging manifests authorize explicit extension origins, and the host independently validates its caller origin. Local control sockets and capture directories use owner-only permissions. Secret headers, sensitive field names, URL credentials, and sensitive URL parameters are redacted by default. Capture inputs and stored events are size-limited.

No system can eliminate all risk. Any same-account process that the user authorizes to connect to the private control socket is inside Chromium Bridge's local trust boundary. Raw cookie and capture modes can expose active session credentials.

## User controls

Users can:

- Decline initial website access
- Revoke browser access from the extension popup
- Grant or remove optional cookie and DevTools permissions
- Require a narrow URL filter for capture or explicitly opt into all-URL capture
- Stop capture at any time
- Purge locally stored captures
- Remove the extension, native host, or Codex plugin

## Changes and contact

Material changes will be published in this repository with an updated effective date. Questions and reports can be filed at [github.com/nextster/chromium-bridge/issues](https://github.com/nextster/chromium-bridge/issues). Security reports should follow [SECURITY.md](SECURITY.md).
