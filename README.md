# PickerMux

[![CI](https://github.com/patrickschiller/pickermux/actions/workflows/ci.yml/badge.svg)](https://github.com/patrickschiller/pickermux/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: macOS 13+](https://img.shields.io/badge/platform-macOS%2013%2B-lightgrey.svg)](#requirements)

**Local and remote models in Codex Desktop, controlled from your menu bar.**

PickerMux adds compatible provider models alongside your native Codex models.
The macOS app installs the integration, refreshes the picker, and guides
recovery after Codex updates. LM Studio is the default provider.

**[Download PickerMux for macOS](https://github.com/patrickschiller/pickermux/releases/latest/download/PickerMux-macos-universal.dmg)**
— one signed and notarized DMG for Apple silicon and Intel.

<table>
  <tr>
    <td width="50%" align="center"><strong>Menu-bar companion</strong></td>
    <td width="50%" align="center"><strong>Codex model picker</strong></td>
  </tr>
  <tr>
    <td valign="top"><img src="assets/screenshots/pickermux-companion.png" alt="PickerMux 0.30.0 menu preview with LM Studio token totals, Refresh picker, Open Codex and Config" width="320"></td>
    <td valign="top"><img src="assets/screenshots/pickermux-model-picker.png" alt="Codex model picker with namespaced external models alongside native models" width="440"></td>
  </tr>
</table>

*Left: current app rendered with synthetic usage. Right: Codex picker screenshot.*

[![36-second English explainer of routing and certified tools, with synthetic examples and no audio](assets/demo/pickermux-explainer-en.gif)](assets/demo/pickermux-explainer-en.mp4)

[Download the explainer MP4](assets/demo/pickermux-explainer-en.mp4) ·
[Media details](assets/demo/README.md)

PickerMux is an unofficial community project, unaffiliated with OpenAI, Codex,
or LM Studio.

## Requirements

- macOS 13+ on Apple silicon or Intel.
- Codex Desktop, opened once while signed in to load its native model picker.
- Node.js 22.15.0+ in `/opt/homebrew/bin`, `/usr/local/bin`, or `/usr/bin`.
  [Install Node.js](https://nodejs.org/en/download) separately.
- A compatible Responses provider with an available model. For LM Studio,
  start its server and load at least one LLM.

General Chat Completions compatibility is insufficient. Custom Responses
providers and the experimental MLX adapter are described in
[configuration](docs/CONFIGURATION.md#supported-provider-kinds).

## Install

1. Open the DMG and drag **PickerMux.app** to **Applications**.
2. Eject the image and open PickerMux from Applications.
3. Fully quit Codex with **Command-Q** and keep your provider models available.
4. Turn on **Use PickerMux in Codex**.
5. Wait for setup, reopen Codex, and select a provider model.

Enabling the switch authorizes installation and live certification prompts.
Allow several minutes per model. Tools become available only after the exact
model configuration passes certification.

For an update, quit PickerMux, replace its app from the new DMG, and reopen it.
Then fully quit Codex and confirm the offered backend upgrade, or use
**Config → Update installed backend…**. App and backend versions are separate;
the backend upgrade preserves provider settings.

If an earlier setup has no external providers, **Config → Enable LM Studio
models…** offers a reviewed migration. Keep Codex closed and an LM Studio model
loaded. Existing external-provider configurations are never replaced by this
action. See [upgrade details](docs/TECHNICAL_GUIDE.md#installation-and-upgrades).

## Everyday use

Load the models you want, fully quit Codex, choose **Refresh picker**, and reopen
Codex. Models appear in Codex's picker; the PickerMux menu shows provider usage.
New models need **Certify models…** before using tools.

**Config…** contains status and installation checks, installation details,
updates, startup preferences, notifications, token reset, and **Full refresh…**.
A full refresh asks for confirmation before its two graceful Codex quits and
recovery sequence. Unavailable actions explain their prerequisites. After a
Codex update, follow the offered repair guidance.

**Token usage** shows provider-reported Input, Output, and Total for **Last
model request** and **Since reset**. Counts survive restarts and backend
upgrades. **Config → Token usage → Reset accumulated counts…** clears totals
and retains the last request. Missing counts remain unavailable; **Output
speed** appears only with a matching measurement. Provider ID `kolibri` is
hidden from the app's usage rows. [Token details](docs/MACOS_COMPANION.md#token-usage).

## Optional providers and voice

Custom local or remote Responses providers use explicit model allowlists and
provider credentials. The experimental Apple-silicon MLX adapter supports
immutable model profiles and certified Kolibri function calls; it requires
separate runtime setup. Kolibri's roughly 41 GiB model targets Macs with at
least 64 GB unified memory. Reasoning, media, and compaction are unsupported;
context changes require a new profile and certification.
[Provider and MLX setup](docs/CONFIGURATION.md#kolibri-mlx-provider).

Experimental native voice requires Codex account access. Audio and conversation
context go to OpenAI even when a local model handles delegated tasks.
[Voice setup and limits](docs/TECHNICAL_GUIDE.md#gpt-live-voice-and-local-tasks).

## Switch off or remove

Turn **Use PickerMux in Codex** off, then fully quit and reopen Codex to restore
its native picker while retaining PickerMux for later use.

For complete removal, quit Codex and choose **Config → Remove PickerMux
completely…**. Review deletion of the CLI, managed data, verified backups, and
registered provider credentials. Afterwards, quit PickerMux and move its app to
the Trash. Codex sign-in, chats, projects, and unrelated settings are retained.
An old chat that keeps reconnecting may need
[native-provider recovery](docs/TROUBLESHOOTING.md#reconnecting-in-an-old-chat-after-deactivation-or-uninstall).

## Help and contribute

The private loopback bridge resolves exact model routes and keeps native Codex
credentials isolated from external providers. Tool grants require model-bound
certification; lifecycle changes validate ownership and support rollback.

[Troubleshooting](docs/TROUBLESHOOTING.md) ·
[Technical guide and CLI](docs/TECHNICAL_GUIDE.md) ·
[Configuration](docs/CONFIGURATION.md) ·
[Companion app](docs/MACOS_COMPANION.md) ·
[Architecture](docs/ARCHITECTURE.md) · [Security](SECURITY.md)

[Report a bug or request a feature](https://github.com/patrickschiller/pickermux/issues/new/choose).
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Contributors need macOS and Node.js 22.15.0+; run `npm run verify` and the Swift
tests. See [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md),
and the [changelog](CHANGELOG.md). PickerMux uses the [MIT License](LICENSE).
