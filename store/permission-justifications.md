# Permission Justifications

Use these descriptions in the Chrome Web Store Privacy practices tab.

## `nativeMessaging`

Connects the extension to the user-installed Chromium Sidecar companion on the same computer. This local bridge is the extension's single purpose and replaces any remote web service.

## `storage`

Stores the user's consent version and non-secret capture preferences. Capture is always disabled at startup, and raw-secret mode is never persisted.

## Optional `tabs`

Lists and operates browser tabs selected by the user or local tool, including background tab creation, navigation, guarded closing, metadata, and screenshots. It is requested together with website access only after the popup disclosure.

## `userScripts`

Executes JavaScript supplied by a local tool at the user's request for page inspection and interaction. Users must separately enable Chromium's Allow User Scripts setting. The extension does not fetch scripts from a developer server.

## `webRequest`

Provides the explicitly started, user-facing network-capture feature. Capture is off by default, requires a URL substring or an explicit all-URL opt-in, redacts secrets by default, and is size-limited.

## Optional host access: `<all_urls>`

Allows the user-authorized local tool to work on websites the user chooses. Access is requested from the popup only after a prominent disclosure and can be revoked there. Browser-data commands remain blocked without consent and this permission.

## Optional `cookies`

Reads cookies only when the user separately grants cookie access and requests the cookie tool. Values are redacted unless raw output is explicitly requested.

## Optional `debugger`

Supports an advanced, explicitly enabled network-debugging mode for response capture through the Chrome DevTools Protocol. The bridge exposes only attach, detach, and its fixed Network-domain operations; it does not expose arbitrary DevTools commands.

## Remote code declaration

Select **Yes**. Chromium Sidecar accepts user-supplied JavaScript from the user-installed local companion and executes it through `chrome.userScripts`. This is the extension's disclosed developer-tool purpose. The extension does not download executable JavaScript or WebAssembly from developer-controlled servers, and no third-party library is loaded at runtime.

## Data-use disclosures

Disclose website content, web browsing activity, authentication information, and user activity. Because operated pages may contain them, also disclose personally identifiable, communication, location, health, financial, and payment information. State that processing is local to the extension and companion, while user-selected local clients may transmit requested outputs under their own privacy policies.
