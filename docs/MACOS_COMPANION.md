# macOS companion

PickerMux 0.9.5 includes an optional SwiftUI menu-bar app for inspecting and
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

The companion build produces `PickerMux-v0.9.5-macos-universal.dmg` alongside
the app archive. The planned release includes a Developer ID signed and
notarized image for macOS 13+ on Apple silicon and Intel. Development images
are labelled `unsigned-development` and remain local test artifacts.

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
bundle with the matching reviewed release. CLI/runtime updates and app
replacement remain separate operations. The live release acceptance includes
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
Actions show a busy indicator and elapsed time while setup or certification
is running; keep configured models available until the operation finishes.
Primary content and controls use 14-point text in a wider panel. A setup
failure describes the last attempt. A successful status check inspects the
installation and Codex state; it does not prove that the model server is
reachable. After addressing the error, turn the switch on again to retry setup.

**Retry status**, **Help…**, **Settings…**, and **Quit** remain visible at the
top when a status check fails. Help explains the Node.js requirement and opens
only the fixed official download or troubleshooting links you choose.
Homebrew-installed Node.js is supported; an existing runtime that fails
validation needs review rather than an automatic reinstallation. See
[Node.js troubleshooting](TROUBLESHOOTING.md#companion-cannot-find-or-validate-the-cli-or-nodejs).
Bridge actions remain unavailable until a validated status permits them.

## Activate or deactivate in Codex

The small **Use PickerMux in Codex** switch is the first row and the main setup
control. On a first
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

Setup and status details are expandable so that the toggle remains prominent.
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
| Update PickerMux… (Settings) | Verify the release payload and explicitly activate it through the existing setup transaction. |
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

Login startup is unregistered before purge; if that fails, removal does not
start. A purge failure retains the app for recovery and leaves login startup
disabled. After verified success, the app clears only its own refresh and
notification preferences and its named notification, and stops polling and
queued automatic actions. A local-cleanup retry never reruns a successful
backend purge. Quit the app, move **PickerMux.app** from Applications to the
Trash in Finder, and reopen Codex. The app does not delete its own bundle.

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
`capabilities: ["integration-toggle-v1", "native-uninstall-v1"]` markers,
the PickerMux version, fixed
component status enums, a state, allowed actions, and fixed safe issues. Recovery
contains only a known phase and an operation UUID. No path, capability URL,
model/account identifier, prompt, credential, or raw exception is returned.

`run` accepts exactly one UTF-8 JSON request from stdin, up to 4,096 bytes,
with a bounded wait. It rejects duplicate or unknown fields, extra requests,
unknown schema versions, and arbitrary action parameters. For example:

```bash
printf '%s\n' '{"schemaVersion":1,"action":"configuration-preview"}' | pickermux companion run
```

The finite actions are `refresh`, `open`, `recover`, `certify`, `diagnose`,
`update-check`, `update`, `configuration-preview`, `configuration-apply`,
`integration-deactivate`, `uninstall-preview`, and `uninstall`.
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
The current 0.9.5 payload installs into its own version directory; the older
0.9.0 contents are never overwritten to add this feature.

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

The update check uses only the PickerMux repository's fixed GitHub release API.
Downloads start at exact versioned asset URLs. HTTPS redirects are limited to
GitHub release storage, with no credentials or native authentication headers.
Size and time limits apply before parsing.

Before execution, the updater verifies the archive and manifest checksums,
the identical manifest inside the archive, each allowlisted file's size,
mode and digest, package/version/runtime correspondence, and the supported
ustar structure. Links, traversal, duplicate entries, extension headers, and
unowned files are rejected. The verified payload is extracted privately and
run through the existing `setup` transaction. Failed activation retains or
restores the previous installation. An activated installation whose live
certification is incomplete remains installed with conservative model gates
and is reported separately.

This updates the CLI and managed runtime. It does not silently replace the
running `PickerMux.app`. The panel shows an app/CLI version difference; install
the matching reviewed app build separately. The checksum trust still depends
on HTTPS, GitHub, and the maintainer account. A locally generated checksum does
not establish Developer ID signing or Apple notarization.

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
`PickerMux-v0.9.5-macos-universal.tar.gz`,
`PickerMux-v0.9.5-macos-universal.dmg`, `companion-manifest.json`, and
`SHA256SUMS`. The universal binary contains `arm64` and `x86_64` slices
targeting macOS 13. The manifest distinguishes `unsigned-development` from
`developer-id-notarized` artifacts and binds the bundled backend manifest,
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
The workflow does not publish a GitHub release automatically.
When publishing alongside the CLI, retain its existing `SHA256SUMS` and
publish the companion checksum file as `companion-SHA256SUMS`. See the
[companion release procedure](RELEASING.md#optional-macos-companion-assets)
for the version-matching assets and public-download verification.

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
