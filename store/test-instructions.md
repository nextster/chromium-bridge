# Reviewer Test Instructions

Chromium Bridge requires its open-source macOS Native Messaging companion. No account, payment, or test credentials are required.

1. Install the submitted extension on Chrome 138 or newer on macOS.
2. Run `curl -fsSL https://raw.githubusercontent.com/nextster/chromium-bridge/main/install.sh | sh -s -- --host-only --extension-id lgfjelplnddfhmjjbhmmmmiglbgkeilb --no-codex --no-open --no-wait`.
3. Reload the extension.
4. Open its popup, review the disclosure, and click **Enable local browser access**.
5. In the extension details, enable **Allow User Scripts**.
6. Open `https://example.com` in a normal tab.
7. Run `~/.chromium-bridge/bin/chromium-bridge status` and confirm `connected` and `consented` are true.
8. Run `~/.chromium-bridge/bin/chromium-bridge eval active 'document.title'` and confirm the page title is returned.
9. Run `~/.chromium-bridge/bin/chromium-bridge managed-script-upsert '{"id":"review-example","name":"Review example","matches":["https://example.com/*"],"js":"document.documentElement.dataset.chromiumBridgeReview = \"enabled\";","enabled":true,"runAt":"document_idle","world":"USER_SCRIPT"}'`, reload the example page, and confirm the `data-chromium-bridge-review` attribute is present on the root element.
10. Run `~/.chromium-bridge/bin/chromium-bridge managed-script-enable review-example false`, reload, and confirm the script no longer runs. Finish with `~/.chromium-bridge/bin/chromium-bridge managed-script-remove review-example`.
11. Open the popup, choose **Manage persistent scripts**, and verify a script can be added, edited, toggled, and removed from the dedicated manager screen.
12. In the popup, enter `example.com` as the capture filter, start capture, reload the example page, and stop capture. Raw secrets and request bodies can remain disabled.

Optional cookie access is not required for the basic review flow. DevTools access is declared at install time because Chromium does not permit it as an optional permission, and it remains unused unless the reviewer explicitly attaches it.
