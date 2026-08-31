# Permission Justifications

Use these descriptions in the Chrome Web Store Privacy practices tab.

## `nativeMessaging`

Connects the extension to the user-installed Chromium Bridge companion on the same computer. This local bridge is the extension's single purpose and replaces any remote web service.

## `storage`

Stores the user's consent version, non-secret capture preferences, and versioned Bridge-managed persistent-script records. Script source, explicit website match patterns, execution settings, and enabled state stay local to the browser profile. Capture is always disabled at startup, and raw-secret mode is never persisted.

## Optional `tabs`

Lists and operates browser tabs selected by the user or local tool, including background tab creation, navigation, guarded closing, metadata, and screenshots. It is requested together with website access only after the popup disclosure.

## `userScripts`

Executes JavaScript supplied by a local tool at the user's request for page inspection and interaction, and registers user-requested persistent scripts for explicit `http://` or `https://` match patterns. Persistent source and enabled state are stored locally, size-limited, and reconciled only within Chromium Bridge's own registration namespace. Users must separately enable Chromium's Allow User Scripts setting. The extension does not fetch scripts from a developer server.

## `webRequest`

Provides the explicitly started, user-facing network-capture feature. Capture is off by default, requires a URL substring or an explicit all-URL opt-in, redacts secrets by default, and is size-limited.

## Optional host access: `<all_urls>`

Allows the user-authorized local tool to work on websites the user chooses. Access is requested from the popup only after a prominent disclosure and can be revoked there. Browser-data commands remain blocked without consent and this permission.

## Optional `cookies`

Reads cookies only when the user separately grants cookie access and requests the cookie tool. Values are redacted unless raw output is explicitly requested.

## `debugger`

Chromium does not permit `debugger` in `optional_permissions`, so it must be declared at install time. Chromium Bridge still blocks its use behind popup consent and an explicit local debugging command. It supports response capture through the Chrome DevTools Protocol and exposes only attach, detach, and fixed Network-domain operations, not arbitrary DevTools commands.

## Remote code declaration

Select **Yes**. Chromium Bridge accepts user-supplied JavaScript from the user-installed local companion and executes or persistently registers it through `chrome.userScripts`. This is the extension's disclosed developer-tool purpose. The extension does not download executable JavaScript or WebAssembly from developer-controlled servers, and no third-party library is loaded at runtime.

## Data-use disclosures

Disclose website content, web browsing activity, authentication information, and user activity. Because operated pages may contain them, also disclose personally identifiable, communication, location, health, financial, and payment information. State that processing is local to the extension and companion, while user-selected local clients may transmit requested outputs under their own privacy policies.
