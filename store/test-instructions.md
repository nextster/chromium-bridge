# Reviewer Test Instructions

Chromium Sidecar requires its open-source macOS Native Messaging companion. No account, payment, or test credentials are required.

1. Install the submitted extension on Chrome 138 or newer on macOS.
2. Run `curl -fsSL https://raw.githubusercontent.com/nextster/chromium-sidecar/main/install.sh | sh -s -- --host-only --extension-id ITEM_ID --no-codex --no-open --no-wait`, replacing `ITEM_ID` with this Store item's ID.
4. Reload the extension.
5. Open its popup, review the disclosure, and click **Enable local browser access**.
6. In the extension details, enable **Allow User Scripts**.
7. Open `https://example.com` in a normal tab.
8. Run `~/.chromium-sidecar/bin/chromium-sidecar status` and confirm `connected` and `consented` are true.
9. Run `~/.chromium-sidecar/bin/chromium-sidecar eval active 'document.title'` and confirm the page title is returned.
10. In the popup, enter `example.com` as the capture filter, start capture, reload the example page, and stop capture. Raw secrets and request bodies can remain disabled.

Optional cookie and DevTools permissions are not required for the basic review flow.
