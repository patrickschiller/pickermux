# Releasing PickerMux

Starting with 0.10.0, end users receive one universal macOS DMG through GitHub
Releases. The app bundles the verified Node.js backend; Node.js itself remains
an external prerequisite. Earlier CLI archive releases remain available at
their immutable version-pinned URLs. PickerMux is not published to npm.

## Preflight

1. Keep the version identical in the proposed tag, `package.json`, CLI output,
   app bundle, bundled backend, manifests, and `CHANGELOG.md` heading.
2. Inspect staged files and images for private information. Exclude local
   engineering notes, real configurations, prompts, credentials, account data,
   and generated runtime artifacts.
3. Run `npm run verify` and `swift test --package-path macos` on macOS. Build
   the universal app from the exact reviewed source, never an older artifact.
4. Verify README links and both images. A rendered app preview with synthetic
   state must be labelled as a preview, rather than a live screenshot.
5. Complete the applicable live acceptance checks below on an explicitly
   authorized target installation. Offline tests do not prove TCC, login
   startup, notarization, or current Codex/provider behavior.
6. Confirm a usable **Developer ID Application** identity and existing
   `notarytool` Keychain profile. **Apple Development** and unsigned builds
   cannot satisfy this public release gate.
7. Merge the approved change into protected `main`, synchronize it, and confirm
   the exact new `main` commit has green required CI. Do not create a release
   tag until the production signing path is provisioned and acceptance passes.

## One public asset

Every new release publishes exactly this asset:

- `PickerMux-macos-universal.dmg`: Developer ID signed, notarized and stapled;
  contains the universal app and an Applications shortcut.

The stable asset name makes the README download URL independent of the version:

```text
https://github.com/patrickschiller/pickermux/releases/latest/download/PickerMux-macos-universal.dmg
```

The release tag still makes a download immutable:

```text
https://github.com/patrickschiller/pickermux/releases/download/v0.10.0/PickerMux-macos-universal.dmg
```

The build retains its versioned DMG, app archive, backend manifest, companion
manifest and checksum files for internal verification. Do not upload those
files to the public Release. GitHub's automatically generated source archives
are repository links, not uploaded installation assets.

Release notes contain the public DMG's SHA-256 checksum and one canonical
`pickermux-dmg-release-v1` metadata record. The staging helper writes this
record from verified build output. It binds the exact version, stable filename,
checksum and `developer-id-notarized` signing status. Do not edit its fields or
add another record. Checksums complement signing and notarization; they still
trust HTTPS, GitHub and the maintainer account.

## Build and stage

Configure `PICKERMUX_SIGNING_IDENTITY` and `PICKERMUX_NOTARY_PROFILE` outside
Git. The identity must be Developer ID Application, with its matching private
key available to `codesign`; the profile must already be usable by `notarytool`.
Use fresh output directories, since the tools refuse to replace existing ones:

```bash
node scripts/build-companion.mjs --release --output /tmp/pickermux-signed-0.10.0
node scripts/prepare-dmg-release.mjs --source /tmp/pickermux-signed-0.10.0 --output /tmp/pickermux-public-0.10.0 --tag v0.10.0
node scripts/prepare-dmg-release.mjs --verify /tmp/pickermux-public-0.10.0 --tag v0.10.0
```

The release builder signs and notarizes the app and DMG separately, staples
accepted tickets, assesses both with Gatekeeper, and validates the mounted
image read-only. Staging copies the final DMG bytes under the stable public
filename and checks version, production signing status, format, manifest and
checksum correspondence. Its output contains exactly the DMG,
`release-notes.md`, and `SHA256SUMS`. The latter two files are internal and
must not be uploaded as release assets.

A manifest alone is not proof of Apple's acceptance. Keep signature, stapled
ticket, Gatekeeper and target-machine acceptance evidence with the reviewed
build. Development signing is useful for local testing and must never be
relabeled as production signing or used to bypass `--release`.

## Automated release workflow

The tag workflow in `.github/workflows/release.yml` performs these gates:

1. Require the tag to match `package.json` and the exact current `origin/main`
   commit; run the complete Node and Swift tests on a hosted macOS runner.
2. Build with `--release` on a provisioned macOS runner labelled
   `pickermux-signing`, through the protected `companion-signing` environment.
   That environment supplies the two signing variable names above; certificate
   keys and the notary profile remain in the runner's Keychain.
3. Stage and retain the verified DMG, notes and checksum as an internal Actions
   artifact. This artifact is not a GitHub Release.
4. Recheck the exact current main commit, download that candidate, and verify
   its exact inventory, checksum and metadata record before publication.
5. Create the versioned GitHub Release using one explicit DMG filename and the
   generated notes file. An existing release is refused; assets are never
   replaced with `--clobber`.

The separately dispatched signing job in `companion.yml` remains useful for
reviewing a signed candidate before tagging. It does not publish a Release.
A missing signing runner or environment blocks publication and must be
provisioned before pushing the tag. Do not substitute an unsigned hosted build.

After the exact approved commit is on main and all gates are ready:

```bash
git tag -a v0.10.0 -m "PickerMux v0.10.0"
git push origin v0.10.0
```

Watch the workflow through publication. If a candidate is wrong, fix the
source and publish a new version; do not replace immutable published bytes.

## Public verification

Download the sole DMG from the public, version-pinned URL into a fresh directory.
Compare its SHA-256 with the approved final build and the release-body record.
Verify the image signature, stapled ticket and Gatekeeper assessment; mount it
read-only and verify the app's full signature, ticket, universal slices, version
and pinned backend inventory. Unmount after inspection.

Confirm that the release has exactly one uploaded asset, is the intended latest
stable release, and the README's latest-download URL yields the same bytes.
Check the app after copying to Applications and ejecting the image, including
an explicit upgrade from the prior installation. Download verification must
use public bytes, rather than the local build directory.

DMG update checks hand off to a locally constructed, version-pinned GitHub URL.
They do not execute the image or install a downloaded CLI. After replacing the
app, users explicitly review **Update installed backend** in Settings. The
pinned backend upgrades through the existing setup transaction, preserving
installed provider settings. Cancellation and failed activation must retain
usable prior state; ordinary removal and deactivation continue using the
validated installed backend.

## Manual acceptance matrix

For the 0.7.5 compaction adapter, earlier timeout fixes, and shared search,
first run the concise
[local web-search acceptance test](WEB_SEARCH_ACCEPTANCE.md) against the built,
extracted candidate. It verifies actual installed-version activation, a
certified external search and follow-up source open, and native text/search.
It is a functional smoke test; the lifecycle and failure-path checks below
remain required before release.

At minimum, record:

- macOS version and architecture;
- Node.js 22.15.0 and the current supported Node.js line;
- Codex Desktop and LM Studio versions;
- clean setup, `--version`, `status`, and `doctor`;
- running-service Codex executable replacement, confirming that model and
  in-flight catalog publication paths fail closed while private health reports
  only safe `update-required` enums and recovers only after refresh/restart;
- a text-only request with unique prompt, path, model, and turn canaries,
  confirming that health/doctor telemetry contains only byte/part counters and
  fixed enums;
- provider-end-marker loss before a user TOML table and at end of file,
  confirming receipt-bound `installed-marker-recovered`, no status-time write,
  safe picker selection, uninstall, and refusal after any provider-byte change;
- independent `codex-account-cache` doctor output with the runtime and mixed
  catalog absent;
- an exact-client-version account cache well beyond the former 15-minute
  threshold, confirming that normal `refresh` succeeds without an age warning
  while `doctor` reports its timestamp and age neutrally;
- `refresh --full` cancellation without the exact `FULL` response and rejection
  of `--json`, `--config`, and a non-receipt-active checkout, confirming zero
  lifecycle mutation in each case;
- a complete live `refresh --full` on macOS, confirming the first graceful
  quit, temporary PickerMux suspension, native Codex launch, acceptance only of
  a valid exact-client-version account cache with a later timestamp than any
  valid baseline, the second graceful quit, transactional reactivation, and
  final mixed-catalog Codex launch; run this from a separate interactive
  Terminal after saving active Codex work so the task performing release
  coordination is not the only observer;
- full-refresh preservation of the installed custom provider configuration,
  certification receipts, verified backups, registered Keychain credentials,
  and receipt-owned CLI distribution;
- a refused or timed-out Codex quit, confirming that no forced kill is sent and
  that the operation fails closed with actionable recovery output;
- unchanged, malformed, future-dated, and wrong-client account-cache candidates
  during full refresh, confirming that none can authorize reactivation;
- interruption at each full-refresh checkpoint phase plus a reactivation
  failure, confirming checkpoint removal before suspension, retention from
  suspension onward, bounded resume/recovery behavior, private checkpoint and
  log permissions, and no false success report;
- local model visibility after a full Codex restart;
- an exact base-certified LM Studio model without the additive `toolSearch`
  gate, confirming Direct fidelity remains available and the catalog does not
  advertise client tool search;
- the v0.6.0 Efficient Fidelity certification round trip, confirming the base
  receipt is committed before the additive probe, the probe uses a full public
  replay without `previous_response_id`, and only an exact pass adds the
  catalog capability;
- a new Codex task with full harness canaries and a large deferred tool
  inventory, confirming LM Studio initially receives the canaries plus the
  single bounded search function rather than the deferred schemas, Codex
  performs the local search, only the returned deferred tools are added on the
  replay, non-deferred functions remain advertised, and the selected call still
  passes through Codex approval, sandbox, execution, and result handling;
- JSON and streaming Efficient Fidelity calls, plus negative cases for
  server-executed or unknown search variants, non-automatic tool choice,
  malformed arguments, duplicate or mismatched call IDs, unknown loaded-tool
  types, secondary input tool inventories, oversized selected inventories,
  incomplete or unterminated streams, and `previous_response_id`, confirming
  fail-closed handling, no subsequent upstream continuation after an invalid
  round trip, and no silent downgrade inside an authorized search flow;
- repeated searches returning the same tool, confirming its unchanged schema
  is exposed once while the same identity with a changed schema is rejected;
- remote `/responses/compact` after a search, both with selected schemas and
  with Codex's trimmed `tool_search_output.tools: []` history, confirming that
  historical namespace calls remain compactable without making their schemas
  visible or callable again and that a new JSON or streaming response call is
  rejected;
- a failed additive probe after a successful base matrix, confirming Direct
  fidelity remains active, followed by a bound model, context, endpoint, and
  Codex-version change confirming the stale evidence cannot activate Efficient
  Fidelity;
- an interrupted certification after the base receipt is written, confirming
  the pending barrier keeps that receipt dormant until an explicit retry
  completes recovery;
- the 0.7.1 bounded certification transport with a slow or interrupted probe,
  confirming that its deadline covers headers and body, failures expose only
  fixed probe labels and transport codes, and ordinary inference distinguishes
  pending certification from unavailable provider credentials;
- the 0.7.2 transformed response path failing before validated output,
  confirming a structured timeout error without early success headers, raw
  provider details, fabricated completion, or changes to the native path; also
  fail after transformed SSE output begins and confirm a minimal
  `response.failed` with the fixed code/message, upstream cancellation, normal
  HTTP end-of-response, and the actual reason visible in Codex;
- the 0.7.5 local compaction operation after a web result, confirming one bounded
  model summary with no tool schemas, one authenticated compaction item, and a
  successful same-model continuation with source URLs retained; restart and
  ordinary refresh must preserve replay, while malformed state and provider
  switching fail before credentials or upstream requests;
- a terminal restored summary with no later user/tool input, confirming that
  LM Studio starts a complete new answer rather than continuing the summary;
  a fixed resume instruction must not appear during another compaction or when
  later conversation input already supplies the continuation;
- 0.7.5 summary input reduction, confirming that only the original top-level
  instructions are omitted and all conversation messages remain. Compare
  elapsed time, cache state, and repeated search/compaction count with 0.7.4;
  byte reduction alone is not live performance acceptance;
- a failed, truncated, or tool-calling summary, confirming no successful
  compaction and no history replacement; use offline injection for these failure
  cases rather than spending real model calls repeatedly;
- interruption and injected refresh failure at every certification
  deactivation phase, confirming the persistent request-time barrier blocks
  ordinary traffic in the still-running old process, private probes open only
  after conservative publication, background catalog and route publication is
  blocked, and a retry can recover without reviving an old receipt;
- native JSON and streaming canaries across the same scenarios, confirming the
  request and event bytes remain unchanged;
- the 0.7.0 standalone search path with native and exact tool-certified external
  selections, confirming successful backend responses, follow-up reference
  resolution, the configured native search model parameter, and unchanged
  external answer-model routing;
- migration from a healthy pre-0.7.0 installation, confirming that the running
  service attests search contract 1 before configuration publication, existing
  custom provider settings and explicit search disables survive, and a failed
  activation restores the prior configuration receipt and service;
- missing or edited standalone-search markers, orphaned markers, and markers
  placed inside TOML strings, confirming fail-closed ownership checks rather
  than a silent grant or removal of user content;
- same-version rerun and upgrade from the preceding release, including an
  immutable installed 0.7.4 package to 0.7.5 without bypassing content checks or
  rerunning still-valid model certification;
- cache mismatch before staging, under the lifecycle lock, and immediately
  before activation, confirming that active CLI and bridge state remain
  unchanged in every case;
- the initial cache mismatch combined with a receipt-recovered provider end
  marker, confirming that only the exact marker is materialized under lock,
  the older CLI can then uninstall, and distribution/runtime state remains
  unchanged;
- checksum and foreign-launcher failures without mutation;
- integration-only uninstall and receipt-owned CLI removal, confirming that
  backups and Keychain items remain;
- full purge, confirming that only verified backups and registered PickerMux
  Keychain items are removed and foreign state is refused;
- companion full removal from active and toggle-off states, confirming native
  defaults without reactivating a prior Ollama gateway, retained historical
  chat readability, disabled login startup, exact app-preference/notification
  cleanup, and no queued polling/refresh after success. Verify native sign-in,
  account cache and chats are untouched; manually quit and delete the app in
  Finder only after successful removal. Check cancellation and failure before
  purge separately, without discarding retained recovery evidence. Exercise
  never-enabled, already-unregistered, enabled and approval-pending login
  startup with a fully signed bundle; confirm genuine signature/permission
  failures retain the integration and CLI;
- runtime removal with a byte-identical installed payload, plus refusal of a
  modified payload, an added or symbolic-link entry, and a residual
  `runtime-app.previous-*` package without recursive deletion;
- provider-registry drift and an overlong provider ID, confirming that neither
  can expand the Keychain deletion set;
- distribution-quarantine additions and file replacements before and during
  exact cleanup, confirming that foreign bytes remain pending and are not
  recursively deleted;
- interrupted runtime, backup, and registry cleanup, confirming that full
  removal is not reported and the receipt-owned CLI remains available for
  explicit recovery;
- a failure on the second registered Keychain deletion, confirming a top-level
  `PICKERMUX_CREDENTIAL_PURGE_INCOMPLETE`, an active integration, restored
  receipts, and a successful idempotent retry;
- an integration failure after the Keychain phase, confirming a top-level
  `PICKERMUX_PURGE_COMMIT_INCOMPLETE`, retained recovery receipts, and no false
  full-removal success output;
- standalone `credential-delete` with a failing registry update, confirming
  that retry safely unregisters an already-absent exact Keychain item.

CI cannot prove current Codex Desktop, LM Studio, LaunchServices, or real model
behavior. Those checks remain a release-blocking manual gate whenever the
installer, bridge lifecycle, discovery, or compatibility contract changes. In
particular, simulated protocol coverage does not replace the live macOS
Efficient Fidelity round trip for v0.6.0, and simulated state-machine coverage
does not replace the live `refresh --full` acceptance sequence introduced in
v0.5.4.

## Announcement gate

Publish announcements only after:

- protected main, the exact tag and required CI are verified;
- the public release has exactly the reviewed, signed and notarized DMG;
- public bytes match the checksum, release-body record and approved build;
- both latest and version-pinned DMG download links work;
- app installation, explicit backend upgrade and applicable live acceptance
  have passed on the target Mac;
- screenshots contain no private account, prompt or machine information.
