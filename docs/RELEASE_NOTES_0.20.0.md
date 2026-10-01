# PickerMux 0.20.0

PickerMux 0.20.0 shows provider-reported token usage in the macOS menu-bar
panel. Each external provider has separate Input, Output, and Total values
for **Last model request** and **Since bridge start**.

## What changed

- Count each external model request once after its response finishes, including
  tool rounds and context summaries. Concurrent chats share a provider total;
  the last request is the one that most recently finished.
- Read usage from bounded Responses JSON and SSE replies without adding model
  requests or changing provider request or response bytes. Existing status
  polling updates the panel, normally about every five seconds.
- Mark missing, malformed, unsupported, or aborted usage as **Unavailable**.
  Show partial totals when some requests lack counts, and distinguish genuinely
  reported zero counts from unavailable usage. A fully received terminal
  response can report usage even if generation was incomplete.
- Add the finite `token-usage-v1` status capability. Older backend snapshots
  remain readable and show usage as unavailable until the backend is updated.
  The menu panel scrolls when needed to keep provider totals accessible.

## What the counts cover

The figures cover external inference routed through the current PickerMux
bridge. Native Codex requests, standalone native web search, recognized
certification traffic, and requests made directly in another application are
excluded. Manual live diagnostics that use ordinary inference are counted.
No provider account-wide usage or billing information is queried.

Input includes the context, instructions, and tool definitions processed by
the provider. Cached input and reasoning output are already included in their
respective counts; they are not added again. Total is Input plus Output. A
user turn can make several model requests, so these figures do not measure
unique chat tokens or the current context size.

The counters remain in bridge memory and reset when the bridge restarts,
including a refresh or backend update that restarts it. Restarting the
companion alone keeps the running bridge's totals. No usage-history file is
written. Numeric overflow makes totals unavailable rather than presenting
rounded or saturated values.

Optional usage observation is bounded to 32 MiB per JSON response, 1 MiB per
SSE frame, and 128 providers. Oversized or compressed passthrough responses
can continue through the existing transport while their usage is unavailable.
Exceeding the provider bound makes the whole usage snapshot unavailable.

## Upgrade from the previous app

In the existing app, choose **Settings → Check for updates**. A
validated newer release offers **Download DMG**, which opens the exact
version-pinned download. Downloading the image does not install it.

Quit PickerMux, open the reviewed DMG, and replace **PickerMux.app** in
Applications. Eject the image, reopen the copied app, and then explicitly
review **Settings → Update installed backend**. Keep Codex fully closed and
the configured provider models available during that setup. Replacing the app
alone does not upgrade the installed CLI or bridge. The existing setup
transaction preserves provider settings and verifies configuration ownership.
Setup may send live certification prompts for models whose evidence is missing
or stale.

After successful backend setup, the app and backend should both show
**0.20.0** in Settings. Reopen Codex, choose an external provider model, finish
a request, and review its token values in the menu-bar panel. See the
[companion guide](MACOS_COMPANION.md#updates-and-app-versions) for the complete
upgrade and recovery workflow.

## Security, compatibility, and validation

The public status projection contains only canonical configured provider IDs,
availability, and safe integer counters. It does not include model identities,
prompts, responses, credentials, or provider and capability URLs. Native
credential isolation, exact namespaced routing, conservative certification,
configuration ownership, and transactional lifecycle checks remain enforced.
The bridge contract remains `codex-responses-bridge/p6-v1`.

Source verification passed `npm run verify` with
**1,327 Node tests** and
the companion's Swift suite with **119 tests** on macOS. The Swift checks
also compiled the companion executable. Coverage includes streaming and JSON
usage, missing and malformed counts, partial and overflow totals, provider
bounds, native byte preservation, strict schemas, older backend compatibility,
and keeping counter updates out of actionable-state notifications.

These are offline source checks. They do not establish production signing,
notarization, a successful installed-app or backend upgrade, or live inference
with current Codex Desktop and providers. Those release-artifact and target
machine checks must be recorded separately; no live upgrade success is claimed
by these notes. See the [release procedure](RELEASING.md).

## Release asset

The public installation asset is
[PickerMux-macos-universal.dmg](https://github.com/patrickschiller/pickermux/releases/download/v0.20.0/PickerMux-macos-universal.dmg).
Its approved SHA-256 and canonical distribution metadata are added to the
published release body by the release-staging workflow. Internal app archives,
manifests, and checksum files are retained for verification rather than
uploaded as installation assets.

Requires macOS 13 or newer on Apple silicon or Intel and Node.js 22.15.0 or
newer. PickerMux is an unofficial community project. It is not affiliated
with, endorsed by, or supported by OpenAI, Codex, or LM Studio.
