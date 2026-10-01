# macOS companion

PickerMux 0.9.0 includes an optional SwiftUI menu-bar app for inspecting and
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

The companion build produces `PickerMux-v0.9.0-macos-universal.dmg` alongside
the app archive. The planned release includes a Developer ID signed and
notarized image for macOS 13+ on Apple silicon and Intel. Development images
are labelled `unsigned-development` and remain local test artifacts.

1. Install a supported Node.js runtime at one of the locations listed above.
2. Open the reviewed disk image and drag **PickerMux.app** to **Applications**.
3. Eject the disk image and open the copied app from **Applications**.
4. With Codex fully closed and the provider's models loaded, inspect the status
   and choose **Preview configuration changes**, then confirm
   **Apply configuration changes…** if a new integration is required.

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

The menu offers actions according to the current validated state:

| Action | Behavior |
| --- | --- |
| Refresh picker | Run the ordinary transaction with Codex fully closed. It does not quit Codex or submit certification prompts. |
| Open Codex | Open Codex after the ready integration and active CLI have been verified. A refreshed catalog is loaded at app startup. |
| Repair after a Codex update… | Confirm two graceful quits, possible task interruption, and invalidation of earlier encrypted compaction continuations, then schedule the independent recovery helper. |
| Certify loaded models… | Confirm live provider probes for the discovered models. Keep Codex closed and models loaded; allow several minutes per model. |
| Check installation | Run the deterministic doctor without live inference. |
| Check for PickerMux updates | Inspect the fixed public release endpoint without modifying the installation. |
| Update PickerMux… | Verify the release payload and explicitly activate it through the existing setup transaction. |
| Preview configuration changes | Inspect the active gateway and proposed ownership changes without writing TOML. |
| Apply configuration changes… | Confirm the preview, revalidate its token, and set up or migrate the integration transactionally. |

The app controls already loaded models. Load the desired weights and start the
server in LM Studio before refreshing or installing. Model downloads,
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

## Switching from Ollama or cleaning configuration

PickerMux and Ollama can both write the root gateway and model-catalog fields.
The preview identifies an Ollama integration only from its supported local
gateway/catalog structure; other overrides remain a foreign integration.
There is one active owner of these fields.

With Codex fully closed and its account cache matching the installed client,
choose **Preview configuration changes**. Review the current integration and
proposed changes, then choose **Apply configuration changes…**. The confirmation
is bound to a lowercase hexadecimal preview token generated from the inspected
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

Its direct JSON snapshot has `schemaVersion: 1`, the PickerMux version, fixed
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
`update-check`, `update`, `configuration-preview`, and `configuration-apply`.
Recovery requires `confirmation` containing exactly `quitCodexTwice: true`,
`interruptTasks: true`, and `invalidateCompaction: true`. Configuration apply
requires the exact prior `previewToken` and
`confirmation: {"replaceIntegration": true}`. Paths, provider selections,
executables, and `force` are not part of the request schema.

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
`PickerMux-v0.9.0-macos-universal.tar.gz`,
`PickerMux-v0.9.0-macos-universal.dmg`, `companion-manifest.json`, and
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
