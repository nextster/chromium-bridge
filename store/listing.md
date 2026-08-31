# Chrome Web Store Listing

## Name

Chromium Bridge

## Summary

Connect user-authorized local tools to Chromium for transparent browser automation.

## Category

Developer Tools

## Language

English

## Detailed description

Chromium Bridge connects local tools that you install and control to the Chromium browser session you already use.

Use it to inspect tabs, read compact page snapshots, navigate, click, fill forms, run one-time user-supplied scripts, manage persistent scripts for explicit websites, take screenshots, and perform explicitly enabled network debugging. The included local companion provides a command-line interface and a Codex MCP integration. Arc users can optionally list and focus Spaces on macOS.

Persistent scripts can also be listed, edited, quickly enabled or disabled, and removed from a dedicated extension screen.

Browser access is disabled until you approve it in the extension popup. Website, tab, and cookie access are optional. Chromium requires the DevTools permission at install time, but Chromium Bridge does not use it until popup approval and an explicit debugging command. Network capture requires a URL filter unless you explicitly choose all URLs, and secrets are redacted by default.

Persistent scripts are stored locally, limited to explicit HTTP or HTTPS match patterns, and isolated to Chromium Bridge's own registration namespace. Revoking browser access unregisters them. Chromium Bridge does not edit Arc Boosts or scripts owned by other extensions.

The extension does not contact a developer-operated server. It communicates with the companion installed on your computer through Chromium Native Messaging. Local clients, including AI agents, may process requested output according to their own settings and privacy policies.

Requirements:

- Chrome 138 or a compatible Chromium browser
- macOS for the current native companion installer
- The one-command open-source companion from github.com/nextster/chromium-bridge

The source code, setup guide, privacy policy, and security model are public on GitHub.

## Single purpose

Connect user-authorized local tools to the user's Chromium browser so those tools can inspect and operate browser tabs at the user's request.

## Support and policy URLs

- Homepage: https://github.com/nextster/chromium-bridge
- Support: https://github.com/nextster/chromium-bridge/issues
- Privacy: https://github.com/nextster/chromium-bridge/blob/main/PRIVACY.md
