# PickerMux 0.20.1

PickerMux 0.20.1 fixes the menu-bar panel layout after the token-usage feature
in 0.20.0. A collapsed scroll viewport could hide controls and token values.
The panel now uses an explicit 400-by-600-point viewport with vertical scrolling
so longer provider totals, installation details, and available actions remain
reachable.

This patch changes the presentation wrapper. Provider-reported Input, Output,
and Total values still cover **Last model request** and **Since bridge start**.
The counters, unavailable and partial-usage handling, routing, polling, and
backend lifecycle behavior retain their existing semantics. The bridge
contract remains `codex-responses-bridge/p6-v1`.

## Upgrade

In the existing app, choose **Settings → Check for updates** and use
**Download DMG** for the validated 0.20.1 release. Quit PickerMux, replace
**PickerMux.app** in Applications, eject the image, and reopen the copied app.
Downloading or replacing the app does not upgrade the installed backend.

If an older backend is installed, review **Settings → Update installed
backend…**. Keep Codex fully closed and the configured provider models
available during setup. The existing transaction preserves provider settings
and still-valid certification receipts. Setup can send live certification
prompts if evidence is missing or stale. See the
[companion guide](MACOS_COMPANION.md#updates-and-app-versions) for upgrade and
recovery details.

For a first installation, copy and reopen the app from Applications, fully
quit Codex, keep provider models available, and enable **Use PickerMux in
Codex** to install the bundled backend.

## Validation and release asset

Layout regression checks exercise the shared production viewport with
compressed proposals and short and tall synthetic content. Offline source checks, an isolated
visual preview, production signing and notarization, and an installed-app
upgrade are separate acceptance steps. Their results must be recorded after
they run; these notes do not claim completed signing or live validation.

The public installation asset is
[PickerMux-macos-universal.dmg](https://github.com/patrickschiller/pickermux/releases/download/v0.20.1/PickerMux-macos-universal.dmg).
Release staging adds the approved SHA-256 and the single canonical distribution
record to the published release body. The stable asset name, version-pinned
URL, signing gates, and existing updater validation remain unchanged.

Requires macOS 13 or newer on Apple silicon or Intel and Node.js 22.15.0 or
newer. PickerMux is an unofficial community project. It is not affiliated
with, endorsed by, or supported by OpenAI, Codex, or LM Studio.
