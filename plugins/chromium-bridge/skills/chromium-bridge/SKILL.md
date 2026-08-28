---
name: chromium-bridge
description: Use for every task that requires interacting with a website or browser. Controls the user's existing authenticated Chromium browser through Chromium Bridge.
---

# Chromium Bridge

Use the `chromium-bridge` MCP server for all webpage and browser interaction.

## Routing

- Use Chromium Bridge for navigation, page inspection, clicks, form filling, screenshots, tabs, cookies, JavaScript, and network capture.
- Do not switch to Playwright, another browser plugin, an in-app browser, or Computer Use for webpage interaction.
- If the bridge is unavailable, ask the user to start their supported Chromium browser or reload the Chromium Bridge extension. Do not silently fall back to another browser backend.
- If a tool reports that browser access is not approved, ask the user to open the extension popup and approve local browser access. Do not attempt to bypass the consent gate.
- Computer Use remains appropriate for non-browser desktop applications. If browser chrome itself is not exposed by the bridge, explain that limitation instead of switching backends.

## Fast Path

1. Start routine work with one `snapshot` call. It already targets the active tab and returns its `tabId`, title, URL, text, headings, and element refs. Do not call `status` or `active_tab` first.
2. Reuse the returned `tabId` on later calls. This avoids active-tab lookup and prevents operating on a tab the user switched to.
3. Reuse refs until navigation or a substantial DOM replacement. Do not snapshot again merely to reconfirm an unchanged page.
4. Once refs are known, prefer one `browser_flow` call for deterministic sequences such as `fill → click → wait_for → snapshot`. Keep any action that needs new judgment or confirmation outside the flow.
5. For a single action, set `snapshotAfter: true` on `click`, `fill`, or `select` when the immediate result must be inspected. For asynchronous updates, call `wait_for` with `snapshotAfter: true`.
6. Use `list_tabs` only to select a non-active tab. Use `active_tab` only when metadata is needed without page content. Use `status` only after a bridge error or for explicit diagnostics.
7. Use snapshot defaults first. Increase `maxElements` or `maxTextChars` only when needed content was truncated; request `includeRects` only for coordinate or layout questions.
8. Take screenshots only when visual evidence matters. Keep the fast JPEG default; request PNG only for pixel-exact or small-text inspection.
9. When a catalog reports result counts but its product cards are absent, treat it as virtualized content: use `scroll` with `snapshotAfter: true`, or include `scroll → wait_for → snapshot` in one `browser_flow`, before concluding that products are unavailable.

Prefer the fewest semantically complete tool calls. Independent read-only operations on different tabs may run in parallel; actions on one tab remain ordered.

## Latency Discipline

- Browser bridge calls are normally sub-second. Begin with the required tool call instead of spending time describing the intended interaction.
- Give at most one concise progress update before a routine browser sequence. Do not narrate each click, field, product, or loading state.
- After the user supplies requested information or confirmation, resume the pending browser action immediately. Do not restate the plan.
- Budget one snapshot per stable page state. Do not call `status`, `active_tab`, `list_tabs`, or `screenshot` as reassurance when the current `tabId` and refs remain valid.
- On large result pages, prefer one read-only `evaluate` that returns a small structured candidate list over repeated snapshots, scrolling, or one-tool-per-item inspection.
- When several already-authorized actions are deterministic and require no intermediate judgment, use `browser_flow`. Use one `evaluate` only when a structured bulk read cannot be expressed by snapshot. Keep purchase, payment, message-send, publish, and other externally consequential actions separate for confirmation.
- Use `snapshotAfter` or `wait_for(snapshotAfter: true)` to combine action, settling, and inspection. Avoid fixed sleeps; give `wait_for` the shortest realistic timeout.
- Treat a stale ref or actual navigation as the reason for a fresh snapshot. Do not preemptively refresh state.

## Tab Lifecycle

- Work in the user's current tab only when the request clearly refers to that page.
- When a new tab is useful, call `new_tab` without `active` or with `active: false`. Set `active: true` only when the user explicitly asks to open or show a page in the foreground.
- Keep the returned `tabId` and operate on that background tab explicitly. Do not rely on whichever tab the user currently has active.
- Close an agent-created tab as soon as it is no longer useful. Before finishing, call `close_agent_tabs` if any agent-created tabs remain.
- Never close a tab that existed before the workflow, including the user's active tab, unless the user explicitly requests that exact closure. `force: true` exists only for that explicit case.
- Do not activate a background tab merely to take a screenshot. Use DOM snapshots for background work; explain the limitation when visual verification would require stealing focus.

## Browser Providers

- Call `providers` only when browser-specific capabilities are relevant.
- Arc adds `arc_list_spaces` and `arc_focus_space` through its macOS scripting provider.
- `arc_list_spaces` is read-only. `arc_focus_space` changes the user's visible context and must be used only when the user explicitly asks for that focus change.
- Normal tabs and page operations use Chromium extension APIs and are not Arc-specific.

## Safety

- Ordinary navigation, field entry, option selection, and non-submitting UI clicks can proceed directly when they are within the user's request.
- Judge consequences by the target action, not merely by the tool name. `evaluate` may combine routine actions, but must not bypass confirmation for an external side effect.
- Do not submit forms, publish content, send messages, change account settings, make purchases, make payments, or file government forms without the confirmation required by the active Codex policy.
- Keep `includeSecrets` false by default for cookies and capture.
- Set `includeSecrets` true only when the user explicitly requests raw credentials or an exact authenticated replay and understands that secrets will enter local Codex tool output or capture files.
- Filter capture to the narrowest relevant domain and stop it immediately after the required flow.
- Never request all-URL capture unless the user explicitly asked for unfiltered capture; ordinary capture requires a URL substring.
- Always call `capture_stop` before finishing a task that started capture, even after an error.
- Prefer snapshot and ref tools. Use one read-only `evaluate` call when a known DOM or API expression can answer the question more directly; do not use it to bypass confirmation for consequential actions.

## Network Investigation

1. Start a redacted capture with a narrow `urlPattern`.
2. Perform only the minimum action needed.
3. Stop capture.
4. Inspect `events`.
5. Use `render_curl` to produce replay commands.

Redacted replay scripts intentionally require environment variables for cookies and authorization headers.

Use `purge_captures` when the user asks to delete locally stored capture sessions. Revoking extension access stops future browser access but does not silently delete prior local capture files.
