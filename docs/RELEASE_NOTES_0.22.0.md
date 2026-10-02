# PickerMux 0.22.0

PickerMux 0.22.0 combines the compact menu, durable provider token usage, and
configuration recovery prepared for the unpublished 0.21.0 candidate with
experimental GPT-Live bootstrap support and corrected historical-chat recovery
guidance.

## Compact menu

The menu keeps **Use PickerMux in Codex** and its verified state at the top.
**Refresh picker**, **Open Codex**, **Check status**, and **Check installation**
are full-width menu rows. Specific feedback appears below those actions.
**More actions** groups model certification and picker repair; installation
details expand below. Settings, Help, and Quit appear as separate rows at the
bottom. The menu is 320 points wide and stacks each provider's **Last model
request** and **Since reset** usage blocks vertically. Offered actions obey
the existing backend checks.

Settings and Help keep their own reusable windows. Fully quit Codex before
changing the integration, refreshing its picker, or updating the backend.

## Token usage survives restarts

Each provider's **Last model request** and **Since reset** show reported Input,
Output, and Total. Private local storage retains those values across bridge
restarts, picker refreshes, backend upgrades, and companion restarts.
**Settings → Token usage → Reset accumulated counts…** explicitly clears
accumulated counts for all recorded providers while retaining each provider's
last model request.

Usage still covers only external model requests through PickerMux, including
tool rounds and context summaries. Native models, standalone native search,
and recognized certification requests are excluded. Missing counts remain
unavailable; cumulative sums identify incomplete coverage. These are provider
request counts rather than unique chat tokens or account-wide billing totals.

The stored projection contains only validated provider IDs, numeric counters,
and availability states. No prompts, response text, credentials, endpoints,
model/account/request identifiers, or request history are stored. Reset time
and private storage bookkeeping are also retained. Ordinary uninstall and CLI
removal retain usage; complete removal deletes only verified owned usage state.
Graceful shutdown flushes queued observations; a crash can lose counts not yet
committed. Earlier memory-only counters cannot be recovered once the old bridge
has restarted.

## Configuration recovery

An ordinary Codex `service_tier` setting inside PickerMux's marked root block
could make 0.20.1 and earlier report **Integration needs review**, even without
a manual edit. The 0.22.0 backend accepts one valid, unowned string assignment
there only when excluding it recreates the recorded receipt digest under the
existing model/reasoning selection allowance. It preserves the setting's
original bytes through selection and lifecycle changes. Duplicate, malformed,
or dotted assignments and other managed routing edits remain blocked.

## Experimental GPT-Live voice bootstrap

Older PickerMux backends returned a local **404 Endpoint not found** when
Codex started voice through the bridge. The 0.22.0 backend implements the exact
private `POST /v1/live` bootstrap and adapts the reviewed Codex multipart
request to the fixed native ChatGPT endpoint. It validates the request, SDP,
and returned call ID before responding; unknown shapes fail closed with fixed
redacted errors.

OpenAI handles voice audio and conversation context, including when a local
task model is selected. Delegated work remains on the chat's selected Responses
model. Native sign-in and account access to Codex voice are required; local
tools still require exact model certification. PickerMux does not proxy voice
media or its direct native sideband, and bridge WebSocket upgrades remain
unsupported. No native credentials reach an external provider.

The feature is experimental. Offline tests establish the adapter and isolation
boundary. Voice and local delegation require manual target-Mac validation with
native account access and a compatible client. See the
[voice procedure and limits](TECHNICAL_GUIDE.md#gpt-live-voice-and-local-tasks).

## Reconnecting in historical chats

After deactivation or removal, an old PickerMux chat can keep its saved
`model_bridge` provider even when its picker shows a native model. The retained
inert alias permits parsing but cannot serve a turn. This release corrects
README, companion-guide, CLI, and troubleshooting advice that previously
implied selecting a native model always migrates that saved provider.

The [native-provider recovery guide](TROUBLESHOOTING.md#reconnecting-in-an-old-chat-after-deactivation-or-uninstall)
describes an explicit Codex resume with an exact chat UUID, private history
backup, and preserved model and reasoning effort. It documents compatibility
limits and distinguishes the observed native resume from the source-verified
CLI procedure, which has not been separately exercised live. PickerMux does
not automatically migrate chat state, and `repair-chats` still restores parsing
compatibility only.

## Upgrade

Choose **Settings → Check for updates** in the existing app and use the
validated **Download DMG** action. Quit PickerMux, replace **PickerMux.app** in
Applications, eject the disk image, and reopen the copied app. Then review
**Settings → Update installed backend…** while Codex is fully closed and
provider models are available. Replacing the app alone does not upgrade the
installed backend or enable durable counts, the configuration fix, or the voice
bootstrap.

The existing setup transaction preserves provider settings and still-valid
certification receipts. Setup may send live certification prompts when
evidence is missing or stale. For a first installation, enable **Use PickerMux
in Codex** after copying the app, fully quitting Codex, and making provider
models available. See the [companion guide](MACOS_COMPANION.md).

## Validation and release asset

Offline Node/Swift checks, a synthetic native-menu preview, an installed-app
upgrade, production signing and notarization, live lifecycle/usage checks, and
native/local voice checks are separate acceptance steps. Offline fixtures do
not establish installed voice behavior or local delegation. Production
publication requires Developer ID signing, notarization, and the independent
public-download checks in the [release procedure](RELEASING.md).
The bridge routing contract remains `codex-responses-bridge/p6-v1`.

The public installation asset is
[PickerMux-macos-universal.dmg](https://github.com/patrickschiller/pickermux/releases/download/v0.22.0/PickerMux-macos-universal.dmg).
Release staging adds the approved SHA-256 and the single canonical distribution
record to the published release body. Manifests, app archives, and checksum
files remain internal build evidence.

Requires macOS 13 or newer on Apple silicon or Intel and Node.js 22.15.0 or
newer. PickerMux is an unofficial community project. It is not affiliated
with, endorsed by, or supported by OpenAI, Codex, or LM Studio.
