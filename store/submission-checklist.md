# Chrome Web Store Submission Checklist

## Before creating the item

- [x] Manifest V3 package
- [x] Chrome 138 minimum for the per-extension Allow User Scripts toggle
- [x] Narrow single-purpose description
- [x] Explicit consent before browser-data access
- [x] Website, cookie, and debugger access made optional where possible
- [x] Redaction, capture limits, origin validation, and owner-only local storage
- [x] Privacy policy, Limited Use statement, permission justifications, and reviewer instructions
- [ ] Approved 128x128 icon and 440x280 small promotional image
- [ ] At least one 1280x800 or 640x400 screenshot of the real extension experience

## Draft item

1. Add approved icons under `extension/icons`, then build `npm run package:store`.
2. Create the Chrome Web Store draft and upload the Store ZIP.
3. Record the assigned item ID with `npm run configure:store -- ITEM_ID`.
4. Commit and publish `store/item.json` before review so the companion automatically authorizes the Store extension.
5. Rebuild the Store ZIP and confirm the SHA-256 recorded by the package command.

## Dashboard

- [ ] Use the copy in `store/listing.md`.
- [ ] Upload `extension/icons/icon-128.png` as the extension icon.
- [ ] Upload `store/assets/promo-small-440x280.png` as the small promotional image.
- [ ] Upload a truthful product screenshot at 1280x800 or 640x400.
- [ ] Set the public privacy-policy URL to the repository `PRIVACY.md` page.
- [ ] Enter every justification from `store/permission-justifications.md`.
- [ ] Declare remote code **Yes** and use the user-supplied-script explanation.
- [ ] Disclose every data category listed in the permission document.
- [ ] Certify the Limited Use statements.
- [ ] Paste `store/test-instructions.md`, replacing `ITEM_ID`.
- [ ] Choose **Unlisted** for the first reviewed release.
- [ ] Choose deferred publishing so approval does not publish automatically.

## Final verification

- [ ] Install the actual Store draft/test build, not the unpacked development extension.
- [ ] Run `npm run setup -- --host-only` from the exact public commit reviewers will see.
- [ ] Approve popup access and enable Allow User Scripts.
- [ ] Verify status, a snapshot/eval, background tab create/close, redacted cookies, filtered capture, and purge.
- [ ] Revoke access and confirm browser-data commands are rejected.
- [ ] Confirm no agent-created tabs or active capture remain.

Official references: [prepare](https://developer.chrome.com/docs/webstore/prepare), [privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [images](https://developer.chrome.com/docs/webstore/images), [permissions policy](https://developer.chrome.com/docs/webstore/program-policies/permissions), and [remote hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code).
