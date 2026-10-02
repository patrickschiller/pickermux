# macOS companion

PickerMux 0.21.0 includes a SwiftUI menu-bar app with native macOS controls for inspecting and
operating the existing PickerMux installation. It requires macOS 13 or newer,
Apple silicon or Intel, and Node.js 22.15.0 or newer. The supported Node
locations are `/opt/homebrew/bin/node`, `/usr/local/bin/node`, and
`/usr/bin/node`; a runtime available only through an interactive shell profile
is insufficient for the app.

The app includes a manifest-verified PickerMux backend but does not bundle
Node.js. Providers, routing, tool certification, configuration ownership,
LaunchAgents, rollback, and account-cache recovery remain implemented by the
Node.js core. PickerMux remains an unofficial community project, unaffiliated
with OpenAI, Codex, or LM Studio.

## Install from a disk image

The public release offers only `PickerMux-macos-universal.dmg`, a Developer ID
signed and notarized image for macOS 13+ on Apple silicon and Intel. Internal
build output retains versioned filenames and manifests. Development images
are labelled `unsigned-development` or `apple-development` and remain local
test artifacts. Use the [DMG download](../README.md#install).

1. Install a supported Node.js runtime at one of the locations listed above.
2. Open the reviewed disk image and drag **PickerMux.app** to **Applications**.
3. Eject the disk image and open the copied app from **Applications**.
4. With Codex fully closed and the configured provider's models available, turn on
   **Use PickerMux in Codex** to authorize automatic installation.

The image contains only the app and an Applications shortcut. Dragging the
app installs its bundle; it does not install the CLI, modify Codex TOML,
start a bridge, or authorize provider requests. Setup remains the explicit
transaction described below. The app does not need to run from the mounted
image after it has been copied.

For an app upgrade, quit the existing companion before replacing its copied
bundle with the matching reviewed release. Then explicitly review **Update
installed backend** in Settings when the app includes a newer backend. Setup
preserves the installed provider configuration; replacing the app alone does
not upgrade the CLI or runtime. The live release acceptance includes
mounting the image, copying and opening the app, and testing the app upgrade
on the target Mac.

## Daily use

Open `PickerMux.app` and click its menu-bar icon. The panel shows Codex state,
bridge state, compatibility, account-cache status, integration ownership, and
any recovery phase. Status is checked on a five-second polling cycle; slow
checks can extend that interval. The backend isolates failed probes so one
broken component does not disclose raw diagnostics or discard other results.
Manual **Check status** requests wait behind a running check and show a visible
checking state followed by the completion time, even when the result is
unchanged. **Settings…** and **Help…** open persistent, reusable windows.
Actions show their current progress while setup or certification
is running; keep configured models available until the operation finishes. A setup
failure describes the last attempt. A successful status check inspects the
installation and Codex state; it does not prove that the model server is
reachable. After addressing the error, turn the switch on again to retry setup.

The menu-bar panel places the integration state and token usage before
**Refresh picker** and **Open Codex**, followed by **Check status** and
**Check installation**, with specific feedback immediately below those actions.
**More actions** groups certification and repair; **Installation details**
expands below. **Settings…**, **Help…**, and **Quit** stay visible in its footer. The
400-by-600-point viewport scrolls its main content when needed; the footer
stays in place. Bridge actions are offered according to the verified state
and are disabled while another operation is running.

**Check status**, **Help…**, **Settings…**, and **Quit** remain visible when a
status check fails. Help explains the Node.js requirement and opens
only the fixed official download or troubleshooting links you choose.
Homebrew-installed Node.js is supported; an existing runtime that fails
validation needs review rather than an automatic reinstallation. See
[Node.js troubleshooting](TROUBLESHOOTING.md#companion-cannot-find-or-validate-the-cli-or-nodejs).
Bridge actions remain unavailable until a validated status permits them.

## Token usage

The panel shows **Token usage** for each external provider with recorded usage.
**Last model request** and **Since reset** each show separate Input, Output,
and Total values.
The last request is the one that most recently finished, including when
several chats run concurrently. A user turn can make several model requests
for tools and context summaries; each is counted once. The values are updated
with the existing status polling, normally about every five seconds, after
the response finishes. No additional inference or provider-history request is
made to collect them.

Counts come from the provider's Responses `usage` fields. Input includes the
context, instructions, and tool definitions the provider processes. Cached
input and reasoning output are already included in their respective counts
and are not added again. Total is Input plus Output. These are request-usage
figures, not the number of unique tokens in a chat or its current context size.

An aborted response, missing or malformed usage, an unsupported response
format, or a compressed passthrough reply is marked **Unavailable**. Fully
received terminal responses can still report consumed tokens when their
generation was incomplete. The cumulative values sum only verified reported
counts; if some requests lack counts, the panel identifies the partial sum
and the number of unavailable requests. If none have reported counts, it shows
Unavailable instead of zero. Genuine reported zero counts remain valid.
If cumulative counts exceed the safe numeric range, totals are unavailable
rather than displayed as an exact rounded or saturated value.
Observation is bounded to 32 MiB for a JSON response and 1 MiB for each SSE
frame. A larger payload is still handled by the existing transport contract,
but its optional usage cannot be reported. More than 128 observed providers
make the usage snapshot unavailable instead of omitting providers.

The statistics cover only external inference through PickerMux. Native Codex
models, standalone native web search, and recognized certification traffic are
excluded. Requests made directly in LM Studio or other applications are outside
this scope. Explicit manual live diagnostics that use the ordinary inference
path are counted. No account-wide usage or billing total is queried.

Private local usage storage preserves accumulated counts and the last model
request across bridge restarts, refreshes, backend upgrades, and companion
restarts. **Settings → Token usage → Reset accumulated counts…** clears the
accumulated counts for all recorded providers and starts a new **Since reset**
total. It retains each provider's last model request. Usage before installing
a persistence-capable backend cannot be reconstructed after an older bridge
has restarted.

The private file is `~/Library/Application Support/PickerMux/usage/token-usage.json`.
Ordinary uninstall and CLI removal retain it; complete PickerMux removal
deletes only verified owned usage state. Graceful bridge shutdown flushes queued
observations. A forced termination or crash can lose observations that were
not yet committed. An unsafe or corrupt store is retained for review and
makes usage unavailable; it does not stop model routing or authorize an
overwrite. Reset is offered only when the installed backend validates the
reset authority. An existing empty usage directory or a missing statistics
file shows usage as unavailable until you explicitly choose **Reset accumulated
counts…**; new requests do not silently restart the totals at zero. This narrow
recovery does not permit overwriting malformed or foreign statistics files.

Stored usage contains canonical configured provider IDs, availability, numeric
counters, the reset time, and private storage bookkeeping, never model names,
prompts, responses, credentials, or endpoint/capability URLs. No request history
is stored or queried. Older finite backend snapshots remain readable and their
session totals are labelled **Since bridge start**; update the app and installed
backend together to enable durable **Since reset** counts and explicit reset.

## Activate or deactivate in Codex

The **Use PickerMux in Codex** switch reflects the verified integration
state and is the main setup control. On a first
installation, turning it on obtains a fresh status and configuration preview,
then automatically installs using that exact preview token. Switching on is
your explicit consent; there is no second confirmation popup. Setup may
replace the current integration after a verified backup and send live
certification test prompts to configured models. On an inactive installation it offers
reactivation with the retained provider settings. It displays the verified
backend state after the operation; a cancelled or failed request cannot turn
the switch on by itself.

Fully quit Codex before changing the toggle. Setup requires the current native
account cache and a reachable configured provider with an available external
model. The first-install default uses LM Studio and requires loaded models.
A missing server or loaded model produces a specific setup message; it does not remove that prerequisite
or infer compatibility from an Ollama installation.
Setup also distinguishes a discovery timeout, access denied by the operating
system, HTTP 401/403 authentication, and malformed JSON or unsupported model
metadata. Other failures retain a generic safe message rather than claiming
the server is stopped. Failed preflight does not install or activate anything.

Turning the toggle off authorizes deactivation. PickerMux stops its
bridge and removes the active integration from the Codex root, while retaining
the CLI, service configuration, original backup, certification receipts and
runtime for reactivation. An inert historical `model_bridge` provider alias
keeps old chats readable; select a native model to continue an old chat while
PickerMux is off. Deactivation is separate from account-cache recovery and
does not create a full-refresh checkpoint. Pending recovery, edited ownership
state or concurrent configuration changes block the operation.

Reopen Codex after successful deactivation to load its native picker. The
generated mixed catalog retained on disk is inactive while the toggle is off;
the inert provider alias adds no picker models. A historical chat may still
show its former model selection until you choose a native model.

Setup and status details live under **Installation details** so that the
integration control remains prominent.
The app has a dedicated Finder/Dock icon compiled from the versioned
[master artwork](../macos/Resources/AppIcon.md).
Its separate monochrome [menu-bar mark](../macos/Resources/MenuBarIcon.md)
uses native vector geometry and macOS template tinting for light and dark mode.

The menu offers actions according to the current validated state:

| Action | Behavior |
| --- | --- |
| Use PickerMux in Codex | Automatically install/reactivate when turned on; deactivate while retaining installed state when turned off. |
| Refresh picker | Run the ordinary transaction with Codex fully closed. It does not quit Codex or submit certification prompts. |
| Open Codex | Open Codex after the ready integration and active CLI have been verified. A refreshed catalog is loaded at app startup. |
| Repair after a Codex update… | Confirm two graceful quits, possible task interruption, and invalidation of earlier encrypted compaction continuations, then schedule the independent recovery helper. |
| Certify models… | Confirm live provider probes for the discovered models. Keep Codex closed and configured models available; allow several minutes per model. |
| Check installation | Run the deterministic doctor without live inference. |
| Check for PickerMux updates (Settings) | Inspect the fixed public release endpoint without modifying the installation. |
| Download DMG (Settings) | Open the exact version-pinned GitHub download for a validated newer app release. |
| Update installed backend (Settings) | Review setup using the verified newer backend bundled with the app; preserve installed provider settings. |
| Reset accumulated counts… (Settings → Token usage) | Clear all providers' accumulated usage while retaining each last model request. |
| Remove PickerMux completely… (Settings) | Preview and confirm native Codex restoration plus complete owned removal, then stop background actions and explain app deletion in Finder. |

The app controls models from the installed provider configuration, including
local or remote compatible Responses providers. New GUI installations use
LM Studio by default. For another provider, activate a custom configuration
through the CLI first; later app actions reuse it. There is no provider
selection or credential editor in the current GUI. See
[supported provider kinds](CONFIGURATION.md#supported-provider-kinds).

With LM Studio, load the desired weights and start its server before refreshing
or installing. Other Responses providers use explicit model allowlists and
must keep their configured models available. Model downloads,
load/unload controls, and chaining an active Ollama gateway through PickerMux
are outside this release.

In **Settings**, login startup uses `SMAppService.mainApp`. Automatic refresh
and notifications are off by default. An enabled automatic refresh runs once
after Codex changes from running to fully stopped, while the integration is
ready and no operation or recovery is pending. It does not repair mismatches,
change configuration, certify models, update software, or quit Codex.
Notifications concern meaningful actionable state changes rather than every
poll. macOS may require approval in **System Settings > General > Login Items**
or notification settings.
Update checks, their results, and app/backend versions also live in Settings.
Opening or reopening Settings does not automatically download or activate an
update. Recovery, live certification and software updates still require their
explicit asynchronous confirmation before starting.

## Remove PickerMux completely

Fully quit Codex with **Command-Q**, then choose **Settings → Remove PickerMux
completely…**. The app obtains a fresh removal preview and asks for explicit
consent before deleting the integration, runtime, CLI, certifications, verified
backups and registered PickerMux provider credentials. It restores native Codex
defaults instead of bringing back a former Ollama gateway/catalog. The action
works with a verified active or toggle-deactivated installation. Provider
availability and a current account cache are not required for removal.

Login startup is disabled before purge. The app skips an explicitly
unregistered service, otherwise awaits macOS unregister completion and
recognizes its documented already-absent response. A `notFound` status alone
does not authorize removal. A bounded status check must confirm the service
is no longer registered; permission, signature, unknown-service errors and a
still-registered service retain the integration and CLI. A purge failure
retains the app for recovery and leaves login startup disabled. After verified
success, the app clears only its own refresh and
notification preferences and its named notification, and stops polling and
queued automatic actions. A local-cleanup retry never reruns a successful
backend purge. Quit the app, move **PickerMux.app** from Applications to the
Trash in Finder, and reopen Codex. The app does not delete its own bundle.

After reopening an app whose integration and CLI are already absent, removal
is disabled because there is nothing left to uninstall. The Settings message
directs you to quit and delete the remaining app in Finder. It does not ask you
to reinstall or update the CLI. Partial or unknown installation state is
reported separately and never treated as confirmed absence.

Native sign-in, the account model cache, projects, chats and unrelated settings
are preserved. One inert `model_bridge` provider table remains so older chats
can open; it contains no catalog models or usable provider route. Select a
native model before continuing an older PickerMux chat.

Removal requires the receipt-owned installed CLI with the new native-uninstall
capability. An older or unverified backend cannot use the bundled setup payload
to purge an installed distribution. Update the matching app/CLI explicitly or
follow the supported manual uninstall instructions; the app does not run setup
or certification automatically merely to enable removal.

The equivalent CLI command is:

```bash
pickermux uninstall --purge --restore-native
```

Without `--restore-native`, the existing uninstall modes continue restoring the
original configuration, which may include a previous Ollama integration.
Native restoration rejects foreign, edited or ambiguous routing state and
cannot be combined with `--force`.

## Switching from Ollama or cleaning configuration

PickerMux and Ollama can both write the root gateway and model-catalog fields.
The preview identifies an Ollama integration only from its supported local
gateway/catalog structure; other overrides remain a foreign integration.
There is one active owner of these fields.

With Codex fully closed and its account cache matching the installed client,
turn on **Use PickerMux in Codex**. This authorizes replacement of the current
picker gateway through a fresh preview. The activation is bound to a
lowercase hexadecimal preview token generated from the inspected
configuration and ownership state. The token stays inside the control protocol
and is not displayed as a capability or credential.

Before activation, PickerMux checks the same configuration again, creates a
verified backup, preserves unrelated user bytes and LF/CRLF line endings, and
uses the existing installation lock and rollback. A concurrent edit or unknown
schema stops the switch. Modified managed blocks require review instead of
automatic replacement. During pending recovery, configuration migration is
unavailable.

Only PickerMux-owned provider layout is canonicalized. Explicit HTTP/SSE,
WebSocket exclusion, zero request/stream retries, and configured timeout
controls remain. The optional root-only built-in-provider mode is blocked:
its default retries differ and the complete required transport contract has
not qualified. Shorter TOML alone cannot authorize a mode change.

The original verified configuration remains the uninstall baseline after a
switch and after subsequent full refreshes. Uninstall restores that baseline,
including a previous Ollama gateway when applicable, while retaining the
receipt-proven historical `model_bridge` compatibility table. An old chat must
select a usable model before sending another turn; the inert alias preserves
parsing and cannot serve requests.

For a first installation with custom providers, use the existing
[custom-config installer](CONFIGURATION.md). The GUI accepts no custom path or
provider argument. Existing installations reuse their activated private
service configuration.

## Recovery after a Codex update

The bridge validates the actual Codex executable before admitting model
requests and on its background poll. The companion observes that verdict and
the independently checked account cache. It offers recovery when required;
cache age alone does not trigger it.

The confirmation explicitly covers two graceful quits, interrupted active
tasks, and the capability replacement that prevents replay of earlier
encrypted compaction continuations. The helper follows these recorded phases:

`prepared → first-quit-complete → suspended → native-opened → cache-refreshed
→ second-quit-complete → reactivated → completed`

Temporary suspension retains the private ownership receipt and original
backup. It gives Codex neutral native configuration rather than restoring an
earlier gateway during the account-cache fetch. The suspended configuration is
bound to its receipt; changed bytes produce `suspension-conflict` and block
reactivation. Successful recovery retains the original eventual-uninstall
baseline.

The helper runs independently after scheduling. Closing the companion does
not cancel a committed recovery. A refused Apple event or timed-out graceful
quit never becomes a forced Codex kill. An interrupted operation retains its
validated checkpoint and requires the full confirmation again to resume.
Read [recovery troubleshooting](TROUBLESHOOTING.md#full-account-cache-refresh-stops-before-completion)
before changing private recovery files.

## Local control protocol

The app invokes a validated absolute launcher or a verified bundled backend
with argument arrays and a narrow environment. It does not interpolate a shell
command, run a terminal, accept caller-selected executables, or create an HTTP
control server. Normal mutations require the active receipt-owned installed
CLI. The bundled backend is limited to status, diagnosis, update checks,
configuration preview, and explicitly confirmed setup through configuration
apply.

Read-only status can also be inspected from the CLI:

```bash
pickermux companion status
```

Its direct JSON snapshot has `schemaVersion: 1`, the fixed
`capabilities: ["integration-toggle-v1", "native-uninstall-v1", "token-usage-v2", "token-usage-reset-v1"]` markers,
the PickerMux version, fixed
component status enums, a state, allowed actions, and fixed safe issues. Recovery
contains only a known phase and an operation UUID. `tokenUsage` contains a
`schemaVersion: 2`, a fixed availability status, a canonical UTC `resetAt` time
or `null`, and bounded per-provider request counts, last counts, and cumulative
counts. Request counts and cumulative counts are measured since reset; they
may be zero while a last request from before the reset remains. Live bridge
usage requires instance attestation; durable counts can also be read from the
verified installed backend's private usage store while the bridge is stopped.
Missing or invalid usage becomes an unavailable empty
snapshot without changing lifecycle permissions. Older finite status payloads
without usage or with `token-usage-v1` remain readable. The v1 and v2 usage
capabilities are mutually exclusive. No path, capability URL, model/account
identifier, prompt, credential, or raw exception is returned.

`run` accepts exactly one UTF-8 JSON request from stdin, up to 4,096 bytes,
with a bounded wait. It rejects duplicate or unknown fields, extra requests,
unknown schema versions, and arbitrary action parameters. For example:

```bash
printf '%s\n' '{"schemaVersion":1,"action":"configuration-preview"}' | pickermux companion run
```

The finite actions are `refresh`, `open`, `recover`, `certify`, `diagnose`,
`update-check`, `update`, `configuration-preview`, `configuration-apply`,
`integration-deactivate`, `usage-reset`, `uninstall-preview`, and `uninstall`.
Recovery requires `confirmation` containing exactly `quitCodexTwice: true`,
`interruptTasks: true`, and `invalidateCompaction: true`. Configuration apply
requires the exact prior `previewToken` and
`confirmation: {"replaceIntegration": true}`. Paths, provider selections,
executables, and `force` are not part of the request schema.
Deactivation requires exactly
`confirmation: {"deactivateIntegration": true}` and a freshly verified active
integration with Codex stopped. It is available only through the receipt-owned
installed CLI. The app detects older backends even when both versions are
labelled 0.9.0; the missing capability marker selects its pinned setup backend
before any mutation. Confirm setup to upgrade that CLI before deactivating.
The current 0.21.0 payload installs into its own version directory; the older
0.9.0 contents are never overwritten to add this feature.

`usage-reset` requires exactly
`confirmation: {"resetAccumulatedUsage": true}` and a validated installed
backend with available durable usage. It accepts no provider, path, or count
parameters. Successful `data` reports `action: "usage-reset"`,
`status: "reset"`, the canonical UTC `resetAt`, and
`lastRequestPreserved: true`. This action changes statistics only; it does not
change Codex configuration, provider credentials, or model routing.

`uninstall-preview` returns only fixed removal changes and a digest token.
`uninstall` requires that exact `previewToken` and a confirmation containing
exactly `removePickerMux: true`, `restoreNativeCodex: true`,
`deleteProviderCredentials: true`, and `deleteBackups: true`. A successful
removal result must explicitly report `status: "removed"`, `removed: true`,
`nativeRestored: true`, and `historicalChatsPreserved: true` before the GUI
claims completion. An old toggle-only capability remains readable but cannot
authorize removal.

Successful action output has `schemaVersion`, `ok`, `code`, and a bounded
`data` object. Failures contain a fixed safe code and message, such as
`CODEX_RUNNING`, `CONFIGURATION_CONFLICT`, `ACCOUNT_CACHE_REFRESH_REQUIRED`,
`RECOVERY_PENDING`, or `DISTRIBUTION_INVALID`. Callers must inspect `ok`; a
completed subprocess alone does not mean the action succeeded. Structured
progress uses separate JSON lines on stderr. The app drains that stream and
shows a busy indicator plus recovery state from snapshots.

## Updates and app versions

Update checks run through the pinned backend bundled with the app, so an older
installed CLI can discover the DMG distribution. The endpoint is fixed to the
PickerMux repository's GitHub release API, with bounded HTTPS responses and
redirects. A DMG release requires exactly one stable-named image and one
canonical metadata record binding version, filename, checksum and production
signing status. Ambiguous assets, mixed CLI/DMG packages or invalid metadata
fail closed.

**Download DMG** opens a URL constructed locally from the validated version and
fixed repository and filename. Response-supplied URLs never open a browser.
No image is executed or installed by the update check. The CLI's old `update`
action returns `DOWNLOAD_REQUIRED` for this distribution before downloading
an asset or changing the installation. Immutable historical CLI releases
retain their existing archive/manifest/checksum verification path.

Quit PickerMux, replace its app from the reviewed DMG, eject the image, and
reopen the copied app. If its canonical version is newer than the validated
installed backend, Settings offers **Update installed backend**. Keep Codex
closed, ensure its native account cache is ready, and review the setup change.
Updating an inactive installation also activates it; the confirmation explains
that setup can send live model-certification prompts.

The explicit setup client proves the newer bundled version matches the app,
validates the installed launcher and pinned backend afresh, and permits only
configuration preview/apply. No equal-version or downgrade activation is
inferred. Setup keeps the installed provider configuration and uses the core's
existing ownership, lock, certification and rollback checks. Normal status,
deactivation, removal and other service actions remain bound to the validated
installed CLI. An action that may have committed is never retried via a
different source. Legacy installations missing required capabilities retain
the separately reviewed bootstrap setup path.

Checksums and metadata trust HTTPS, GitHub and the maintainer account. The
release build additionally verifies Developer ID signatures and accepted,
stapled Apple notarization; a checksum alone does not establish those properties.

## Development and distribution

Use macOS with Apple command-line tools. The Swift package requires Swift 6
tooling and compiles in Swift 5 language mode. Ordinary tests use temporary
files and fake processes and do not install services or touch live credentials.

```bash
npm run verify
swift test --package-path macos
node scripts/build-companion.mjs --output /tmp/pickermux-companion-development
```

Choose a new output directory for each build; the builder refuses to replace
one. The output contains `PickerMux.app`,
`PickerMux-v0.21.0-macos-universal.tar.gz`,
`PickerMux-v0.21.0-macos-universal.dmg`, `companion-manifest.json`, and
`SHA256SUMS`. The universal binary contains `arm64` and `x86_64` slices
targeting macOS 13. The manifest distinguishes `unsigned-development`,
`apple-development` and `developer-id-notarized` artifacts and binds the bundled backend manifest,
archive, and disk image. Its `diskImage` entry records the versioned filename,
SHA-256 digest, `UDZO` format, `HFS+` filesystem, and
`drag-to-applications` installation method. Unsigned development output is for
local validation; it is not evidence of a distributable signed release.

When the selected command-line tools do not match the installed Xcode, use
the full Xcode toolchain for this command without changing the system-wide
selection:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer node scripts/build-companion.mjs --output /tmp/pickermux-companion-xcode
```

Login startup uses Apple's ServiceManagement API, which requires a signed app
bundle. A linker-signed executable inside an unsigned bundle is insufficient.
For a local test with an existing Apple Development identity, configure it
outside the repository and choose a fresh output directory:

```bash
PICKERMUX_DEVELOPMENT_SIGNING_IDENTITY="Apple Development: Developer Name (TEAMID1234)" node scripts/build-companion.mjs --development-signed --output /tmp/pickermux-companion-development-signed
```

This mode signs and verifies the complete app before packaging and verifies
its signature again in the read-only mounted DMG. It does not notarize or
claim a Developer ID release. `--development-signed` and `--release` are
mutually exclusive. The default unsigned build remains available for offline
packaging checks; it does not establish working login-startup operations.

For a release, configure an existing Developer ID Application identity and
existing `notarytool` Keychain profile outside the repository.

To check the identity in Xcode, open **Xcode > Settings > Accounts**, select
the account and team, then choose **Manage Certificates**. The required type
is **Developer ID Application**; **Apple Development** is for development.
The certificate and its matching private key must be available locally for
this command-line signing workflow. Xcode can also use cloud-managed
certificates in its Organizer distribution workflow; their availability
does not establish a local `codesign` identity. See Apple's
[signing identity instructions](https://developer.apple.com/documentation/xcode/sharing-your-teams-signing-certificates)
and [cloud-managed certificate guide](https://developer.apple.com/help/account/certificates/cloud-managed-certificates/).

Once the local identity and profile are configured:

```bash
node scripts/build-companion.mjs --release --output /tmp/pickermux-companion-release
```

The build reads `PICKERMUX_SIGNING_IDENTITY` and `PICKERMUX_NOTARY_PROFILE`.
Missing signing configuration fails before a release is produced. The release
path enables the hardened runtime and Apple-event entitlement, verifies the
signature, requires an accepted notarization, staples and validates the
ticket, and assesses the app with Gatekeeper before packaging it. It then
creates a compressed read-only DMG containing exactly the app and
`Applications` pointing to `/Applications`. The image receives its own
Developer ID signature, accepted notarization, stapled ticket, signature
validation, and Gatekeeper assessment. Both release assets are checksummed
after their final signatures and tickets are applied.

Every build checks disk-image integrity and format and mounts it read-only
to verify the complete app tree against the packaged bundle before unmounting
it. Unexpected entries, altered app bytes or modes, and a changed Applications
shortcut fail the build. These checks do not open the app or run setup.

The `macOS companion` workflow tests Swift and build boundaries and retains
unsigned development archive and DMG artifacts. Its separately dispatched
signed-release job requires the protected `companion-signing` environment
and provisioned macOS runner labeled `pickermux-signing`; it retains both
assets for release review.
That review workflow does not publish a GitHub release. The separate tag
workflow in `release.yml` runs the verification and protected signing gates,
then publishes only the stable-named DMG. Manifests and checksum files remain
internal; the DMG checksum and bound metadata record appear in the release
body. See the [release procedure](RELEASING.md) for production prerequisites
and independent public-download verification.

## Acceptance status

The maintainer confirmed the 0.8.3 live baseline on 1 October 2026. That is
the working starting point for 0.9.0 and does not validate new app behavior.
Offline Node/Swift tests and an unsigned universal build cannot establish the
following live checks:

- Native app startup, menu actions, and a matching installed CLI on macOS.
- Apple-event/TCC approval and denial, refused graceful quit, actual Codex
  update recovery, interruption/resume, and historical chat opening.
- Confirmed Ollama switching, restored eventual uninstall, and failure with
  intentional user edits on the target installation.
- Login startup, notification authorization, and an opt-in refresh after
  Codex fully closes.
- A real signed/notarized app and DMG, drag-to-install/open after ejecting the
  image, and app/CLI upgrade through the release channel.

These remain release acceptance checks. The release build requires a usable
Developer ID Application identity with its private key and an existing
notarytool Keychain profile. An Apple Development identity does not fulfill
this distribution requirement. Offline tests and development artifacts do
not demonstrate successful signing or notarization.
