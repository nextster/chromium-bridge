# Contributing

## Development checks

Use Node.js 20 or newer and run:

```bash
npm test
npm run package:extension
npm run package:store
```

The checks parse every JSON file, syntax-check JavaScript, keep package versions aligned, reject machine-specific paths and private-key material, verify extension permissions, validate icon dimensions, and test both ZIP archives.

CI runs on macOS and Linux only. Windows code paths take injectable `platform`, `env`, registry, and process adapters so they can be unit-tested on macOS; verify installer changes manually on a Windows machine with `$env:CHROMIUM_BRIDGE_SOURCE_DIR` pointing at the checkout before a release. Packaging scripts require macOS.

## Security-sensitive changes

Changes to browser permissions, Native Messaging origins, consent, cookies, capture, script execution, generated replay commands, and control-socket handling require focused tests. Keep secret access opt-in, narrow capture by default, and avoid adding remote services or runtime dependencies without documenting the resulting trust and privacy changes.

Do not commit captures, credentials, private keys, developer-dashboard exports, or machine-specific paths.

## Releases

Keep versions synchronized across the extension, host, packages, and the Codex and Claude plugin manifests. Build the Store archive with `npm run package:store`; do not upload the development ZIP to the Chrome Web Store because it contains the unpacked-development key.

For a release, stage the complete source tree and run `npm run package:source`. The deterministic archive excludes `Formula/`, so its SHA-256 can be recorded in `Formula/chromium-bridge.rb` without a self-reference. Update the default `ref` in `install.sh` and `install.ps1`, then verify the Formula with `brew style`, `brew audit --strict`, and a local install before pushing.
