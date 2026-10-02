# PickerMux 0.21.0

PickerMux 0.21.0 uses a compact macOS-style menu with direct everyday actions, keeps
provider token totals across bridge restarts, and fixes a configuration warning
that could appear after Codex added an unrelated setting.

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
a manual edit. The 0.21.0 backend accepts one valid, unowned string assignment
there only when excluding it recreates the recorded receipt digest under the
existing model/reasoning selection allowance. It preserves the setting's
original bytes through selection and lifecycle changes. Duplicate, malformed,
or dotted assignments and other managed routing edits remain blocked.

## Upgrade

Choose **Settings → Check for updates** in the existing app and use the
validated **Download DMG** action. Quit PickerMux, replace **PickerMux.app** in
Applications, eject the disk image, and reopen the copied app. Then review
**Settings → Update installed backend…** while Codex is fully closed and
provider models are available. Replacing the app alone does not upgrade the
installed backend or enable durable counts and the configuration fix.

The existing setup transaction preserves provider settings and still-valid
certification receipts. Setup may send live certification prompts when
evidence is missing or stale. For a first installation, enable **Use PickerMux
in Codex** after copying the app, fully quitting Codex, and making provider
models available. See the [companion guide](MACOS_COMPANION.md).

## Validation and release asset

Offline Node/Swift checks, a synthetic native-menu preview, an installed-app
upgrade, production signing and notarization, and live lifecycle/usage checks
are separate acceptance steps. Results must be recorded after those checks
run; these notes do not claim completed signing or live acceptance.
The bridge routing contract remains `codex-responses-bridge/p6-v1`.

The public installation asset is
[PickerMux-macos-universal.dmg](https://github.com/patrickschiller/pickermux/releases/download/v0.21.0/PickerMux-macos-universal.dmg).
Release staging adds the approved SHA-256 and the single canonical distribution
record to the published release body. Manifests, app archives, and checksum
files remain internal build evidence.

Requires macOS 13 or newer on Apple silicon or Intel and Node.js 22.15.0 or
newer. PickerMux is an unofficial community project. It is not affiliated
with, endorsed by, or supported by OpenAI, Codex, or LM Studio.
