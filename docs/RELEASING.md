# Releasing PickerMux

Starting with 0.10.0, end users receive one universal macOS DMG through GitHub
Releases. The app bundles the verified Node.js backend; Node.js itself remains
an external prerequisite. Earlier CLI archive releases remain available at
their immutable version-pinned URLs. PickerMux is not published to npm.

The maintainer tested the 0.30.0 candidate and authorized PR merge, tagging,
and publication on 6 October 2026. The commands below describe its production
release procedure; every signing and verification gate still applies.

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
https://github.com/patrickschiller/pickermux/releases/download/v0.30.0/PickerMux-macos-universal.dmg
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
node scripts/build-companion.mjs --release --output /tmp/pickermux-signed-0.30.0
node scripts/prepare-dmg-release.mjs --source /tmp/pickermux-signed-0.30.0 --output /tmp/pickermux-public-0.30.0 --tag v0.30.0
node scripts/prepare-dmg-release.mjs --verify /tmp/pickermux-public-0.30.0 --tag v0.30.0
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

The tag always runs hosted macOS source verification. Automated signing and
publication require the repository-global variable
`PICKERMUX_SIGNING_RUNNER_ENABLED` to be exactly `true`, set only after the
signing runner and protected environment are provisioned. When unset or
disabled, both jobs are skipped; use the local production route below.
Skipping automation does not waive any production release requirement.

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
Do not enable automation with a missing runner or environment, or substitute
an unsigned hosted build. Signing credentials can remain entirely on a
maintainer's Mac when using the local production route.

After the exact approved commit is on main and all gates are ready:

```bash
git tag -a v0.30.0 -m "PickerMux v0.30.0"
git push origin v0.30.0
```

Watch the workflow through publication. If a candidate is wrong, fix the
source and publish a new version; do not replace immutable published bytes.

## Local production release

Use this route when Developer ID signing and the validated notary profile are
available on the maintainer's Mac, without a GitHub signing runner. Leave the
automation opt-in disabled. All preflight, acceptance, source ownership and
production signing requirements above remain mandatory.

1. Build and stage with `--release` using the commands above. Retain the actual
   Apple acceptance, signature, stapled-ticket, Gatekeeper and mounted-image
   verification evidence. The reviewed backend bytes must match the exact
   release source on protected `main`.
2. Confirm that exact `main` commit has green required CI, create its annotated
   version tag, and wait for the tag's hosted Node and Swift verification.
3. Verify the staged publication directory again, then create the release with
   one explicit DMG and its generated notes. Refuse an existing release; never
   replace its assets.

```bash
node scripts/prepare-dmg-release.mjs --verify /tmp/pickermux-public-0.30.0 --tag v0.30.0
gh release create v0.30.0 /tmp/pickermux-public-0.30.0/PickerMux-macos-universal.dmg \
  --verify-tag --title "PickerMux v0.30.0" \
  --notes-file /tmp/pickermux-public-0.30.0/release-notes.md
```

Complete the independent public-download verification below before announcing
the release. Record hosted source checks as passed, automated signing and
publication as skipped, and the actual local production checks separately.
A skipped GitHub signing job is not evidence that notarization passed.

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
app, users explicitly review **Update installed backend** in Config. The
pinned backend upgrades through the existing setup transaction, preserving
installed provider settings. Cancellation and failed activation must retain
usable prior state; ordinary removal and deactivation continue using the
validated installed backend.

## 0.30.0 compact-menu and installed-runtime acceptance

Version 0.30.0 removes duplicate setup-completion prompts from
the compact menu and restores token reset when the receipt-owned distribution
contains the reviewed optional MLX runtime. It preserves the bundled backend's
mutation boundaries and retains setup, update, reset,
ownership, or rollback checks.

On an explicitly authorized target with the reviewed 0.30.0 app and matching
backend:

1. Exercise ready, first-setup, older-installed-backend, Codex-running,
   native-only, missing-status, and busy snapshots. Confirm the compact menu
   never contains **Complete PickerMux setup** or **Complete Codex setup…**.
   The integration switch, provider usage, ordinary picker actions, and one
   divider above Config/Help/Quit must retain their existing behavior.
2. Confirm Config remains the sole setup/update recovery surface: it must expose
   the applicable installed-backend setup or update review, status and
   installation details, and a bounded disabled reason when prerequisites are
   unmet. Cancellation, stale preview, Codex-running, concurrent change, and
   activation failure must retain the prior installed state.
3. Use a receipt-owned candidate distribution containing exactly
   `runtime/mlx/{kolibri.py,manage.py,model_store.py,server.py}`. Confirm status
   selects the installed backend and **Config → Token usage → Reset
   accumulated counts…** is enabled when `usage-reset` is otherwise authorized.
   Confirming reset must clear accumulated counts, set a canonical reset time,
   and retain the last model request without changing routing, credentials,
   certification, or configuration.
4. In isolated fixtures, independently test a missing runtime file, added file
   or directory, changed bytes, hard link, symbolic directory, and group/world-
   accessible runtime directory. Each case must fail before the installed
   entry point executes. The app's manifest-verified bundled fallback must not
   gain `usage-reset` or write another distribution's durable usage store.
5. Build and stage fresh 0.30.0 artifacts, then inspect the generated notes and
   canonical release record. They must describe the menu cleanup, Config-only
   setup/update recovery, strict optional-runtime validation, restored reset,
   and unchanged security/transaction boundaries. Complete every public
   release gate above before tagging and publication.

## 0.24.6 native-only setup and menu-state acceptance

This local development build fixes the case where the prior valid
`providers: []` configuration was preserved across an update, leaving no
external route for the Codex model picker and no provider usage for the menu.
It adds one receipt-active, fixed LM Studio migration; it does not add a general
provider editor or authorize publication. Offline review must cover the redacted
preview, exact confirmation grammar, stale/concurrent state, installed-source
binding, no-overwrite rule, transaction/rollback, and private-data redaction.

On an explicitly authorized target with the reviewed 0.24.6 app and matching
backend:

1. Start from a verified active `providers: []` installation. Confirm that the
   Codex model picker contains only native models and that the menu shows no
   invented LM Studio provider usage. Confirm Config offers **Enable LM Studio
   models…** only in this exact state.
2. Keep Codex running and confirm setup cannot start. Fully quit it, keep LM
   Studio stopped or with no loaded LLM, and confirm the prerequisite blocks
   setup without changing service configuration. Then start the server and load
   one test model.
3. Open **Enable LM Studio models…**, inspect the **Enable LM Studio models?**
   preview, and cancel. Confirm no state changed. Review again and choose
   **Enable LM Studio**. Require the receipt-active bundled default, exact
   preview token, fresh preflight and transactional setup; inject stale preview,
   concurrent edit and activation failure paths and confirm recoverable prior
   state.
4. Verify that bridge settings, unrelated Codex settings and historical chats
   remain intact. Repeat with a nonempty external-provider configuration and
   confirm the LM Studio action is not authorized and no configuration bytes are
   replaced. Do not record endpoints, model IDs, credentials, prompts, paths, or
   private receipts as evidence.
5. After successful setup, reopen Codex and confirm the loaded external model
   appears in the Codex model picker. Complete a request and confirm the compact
   menu labels the provider and its usage rather than showing an individual
   model list.
6. Across ready, missing-status, older-backend, bundled-backend, and busy states,
   confirm **Full refresh…** and **Reset accumulated counts…** remain visible in
   Config. Each disabled control must show its bounded reason. Confirm the
   compact menu has exactly one divider above the Config/Help/Quit footer and no
   divider between those three rows.
7. Supply matching and mismatched synthetic performance snapshots. Confirm the
   label is **Output speed**, a row appears only for a finite measurement bound
   to that provider's latest completed request, and no generic, stale, or
   cross-provider rate is shown. The existing `kolibri` UI filter must not alter
   backend telemetry.
8. Generate and verify the 0.24.6 candidate notes locally. They must describe
   the native-only root cause, fixed confirmed LM Studio setup, model-picker vs
   provider-menu distinction, disabled-state visibility, single footer divider,
   and conditional Output speed while retaining the historical 0.24.5 text.
   Do not tag or publish 0.24.6 without separate authorization and every public
   release gate above.

## 0.24.5 Config, full-refresh, and token-presentation acceptance

This release reorganizes native presentation and adds one finite companion
action without widening backend authority. Source review and offline tests must
cover the exact `full-refresh` request grammar, fresh-status enforcement,
receipt-bound scheduling, cancellation/failure, and rejection of provider,
model, executable, path, or force fields. UI filtering of provider ID `kolibri`
must not remove or mutate bounded backend telemetry or durable usage data.

On an explicitly authorized target with the reviewed app and matching backend:

1. Open the compact menu with no operation running. Confirm that general
   **Token usage**, **Refresh picker**, and **Open Codex** remain directly
   visible. Confirm that **Check status**, **Check installation**,
   **Installation details**, and **Full refresh…** occur only in **Config**.
2. Exercise Config, Help, and Quit repeatedly. Config and Help must reuse their
   windows. Confirm that update checks, app/backend versions, preferences,
   token reset, and complete removal remain reachable in Config.
3. With a verified active installation and Codex running, select **Full
   refresh…** and cancel the confirmation. No lifecycle state may change. In an
   authorized recovery run, require the same three consents, two graceful quits,
   private checkpoint, native-cache refresh, and transactional reactivation as
   `pickermux refresh --full`. Refused quits, changed ownership, pending
   recovery, and failed reactivation must retain recoverable state.
4. Complete provider requests with valid and missing usage. Confirm that
   non-Kolibri provider totals remain visible, `lmstudio` is labelled **LM
   Studio**, and unavailable/partial states are unchanged. Confirm that every
   visible usage and performance row omits exactly provider ID `kolibri` while
   the bounded `companion status` projection and private ledger retain its
   telemetry. Do not capture prompts, response text, endpoints, model IDs, or
   capability URLs as evidence.
5. Prepare and verify the 0.24.5 release notes. They must use **Config → Update
   installed backend…**, describe the guarded full refresh and UI-only Kolibri
   filter, contain one canonical DMG record, and leave earlier version-specific
   release text unchanged.

## 0.22.2 automatic backend review and explainer acceptance

This patch changes companion review presentation, version guidance, and the
confirmation flow. The finite backend protocol, pinned preview/apply setup
transaction, configuration ownership, certification, and rollback contracts
are unchanged. Source review and injected offline tests cover readiness gates,
one offer per version pair and app process, cancellation, failure, manual retry,
and the existing one-confirmation apply path. These offline checks do not
establish an actual upgrade of the app or backend on the target Mac.
Publication authorization does not authorize changing a live target
installation. All existing preflight, production signing,
public verification, and applicable live acceptance gates remain in force.

On 2026-10-03, the maintainer reported all targeted copied-app checks below
as passed against the reviewed, Developer ID signed and notarized candidate:
the version hint without an automatic offer while Codex was running; one
offer after Codex quit; unchanged state and no repeated offer after cancel;
manual review cancellation; a new offer after restarting PickerMux; and one
confirmation upgrading the backend to 0.22.2, with both displayed versions
matching and provider settings preserved. This is maintainer-reported
target-Mac evidence, distinct from the automated offline tests. It does not
establish new live inference, TCC, or login-startup behavior.

On an explicitly authorized target, retain the previous installation for
recovery and record the starting app and backend versions without private data:

1. Replace the app with the reviewed 0.22.2 bundle and reopen it while Codex is
   running. Confirm the version mismatch and Settings action are visible and
   that no automatic upgrade review opens or closes Codex.
2. Quit Codex normally. Once a successful status check confirms an active,
   validated older backend, ready cache and compatibility, no pending recovery,
   and an idle operation/confirmation queue, require one automatic review of
   the existing backend upgrade. Review the proposed versions and setup change.
3. Cancel that review. Confirm that installed state is unchanged and subsequent
   checks do not repeat the popup for that pair in the same app process. Retry
   explicitly through **Settings → Update installed backend…** and cancel that
   manual review to retain the previous backend for the next check.
4. Restart PickerMux, require the automatic review again, and confirm it once.
   This checks that the offer history belongs only to the current app process.
   Require the existing pinned preview/apply
   transaction, with no second confirmation, and verify both app and installed
   backend report 0.22.2. Check preservation of provider configuration, valid
   certification, and normal status/deactivation/removal authority.
5. Use isolated injected state to exercise failed activation, blocked cache,
   recovery or compatibility, and inactive, foreign, or unsafe integrations.
   Preserve the existing rollback checks; no automatic activation or repeated
   failure popup may occur. Also test the manual apply path with one confirmation.

The README's 36-second English GIF/MP4 is a synthetic vector explainer of the
existing request and tool paths. Its source, rendering, media properties, and
fixed example content were reviewed offline. It contains no captured user
state and provides no evidence that a live model chose or used a tool correctly.

## 0.22.1 web and tool-discovery guidance acceptance

This patch changes LM Studio tool descriptions. It preserves tool schemas,
certification grants, routing, and the discovery and lifecycle contracts.
Offline tests verify the advertised alias, direct-URL example, original
discovery-description preservation, and rejection of unadvertised calls. They
do not establish that a real model chooses the tool or returns correct facts;
that effect remains unverified until a targeted live check passes. All
applicable release and announcement gates remain in force.

On an explicitly authorized target with the exact installed backend and a
valid certification for the selected model, repeat the reported source-opening
failure. Supply a public source URL and ask the model to open it with the
available web tool, discover and load that tool if needed, and verify the
requested facts from the returned text. Confirm an actual tool execution and
a sourced answer, or record the fixed failure code. Test an already loaded
tool and deferred discovery when available; retain the exact existing
certification and capability settings rather than granting broader access.
Keep private conversation, account, and capability data out of release evidence.

## 0.22.0 native menu, durable usage, and updater acceptance

Use an explicitly authorized installation of the previous app to test the
complete update path. Record the starting app and backend versions and retain
the prior installation for recovery. These checks supplement source tests;
publishing an artifact does not establish that the installed upgrade passed.

- In the previous app, check for updates and confirm that 0.22.0 is offered
  with **Download DMG**. Confirm that the browser opens the exact
  version-pinned 0.22.0 URL and that the downloaded public bytes pass the
  independent signature, ticket, checksum, and inventory checks above.
- Quit PickerMux, replace its copied app, eject the image, and reopen it.
  Confirm that Settings identifies app 0.22.0 while the installed backend
  remains at its prior version until **Update installed backend** is reviewed.
  With Codex fully closed and provider models available, complete that explicit
  setup and confirm that both versions are then 0.22.0. Verify that installed
  provider settings and still-valid certification receipts are preserved.
- Open and reopen the native menu after status and token-usage changes.
  Confirm the compact 320-point presentation, vertically stacked Last model
  request/Since reset blocks, and full-width action rows. Integration state,
  Refresh picker, Open Codex, Check status, and Check installation must remain
  directly accessible with specific feedback.
  Exercise permitted/disabled actions, the More actions and Installation details
  disclosure groups, Settings/Help windows, and Quit. Verify empty, unavailable, partial,
  and multiple-provider snapshots. Record installed-app visual acceptance
  separately from synthetic native-menu tests or a preview.
- Exercise cancellation and an injected failed backend activation separately
  using isolated test state. Confirm that usable prior state remains available
  and that no possibly committed mutation is retried through another backend.
- After live external JSON and streaming requests, compare the menu's Input,
  Output, and Total with the provider's reported usage. Confirm that tool rounds
  and context summaries accumulate once, simultaneous chats share provider
  totals, and Last model request follows the most recently finished response.
  Confirm that Since reset, each last request, and partial/unavailable coverage
  survive companion and bridge restarts, refresh, and the backend upgrade.
  Keep inspected provider payloads private and do not retain prompt content
  or raw diagnostics as release evidence.
- Confirm that native requests, standalone native search, and recognized
  certification requests do not increase the counters. Reopening the app
  preserves counts, as does restarting the bridge. Choose Settings → Token
  usage → Reset accumulated counts… and confirm that all accumulated totals
  reset while each last request remains. Use injected
  replies for missing, malformed, aborted, compressed, oversized, zero-count,
  and numeric-overflow cases; confirm unavailable and partial totals without
  changing forwarded bytes. Exercise private usage-file permissions,
  malformed/oversized or concurrently changed state, unsafe links, atomic
  persistence failures, and the defined retention/removal policy with isolated
  state. Older finite backend snapshots remain readable without treating their
  session totals as durable counts.
- Insert one valid user-owned service_tier string inside an otherwise
  receipt-proven root block in isolated lifecycle fixtures. Verify status
  performs no write, selection/migration preserve it, and deactivation,
  full-refresh suspension, and ordinary/native-restoring uninstall retain its
  raw bytes. Reject duplicate, dotted, malformed, or ambiguous assignments and
  edited routing fields. On the authorized target, verify the backend upgrade
  resolves this sole false ownership conflict without reinstalling, purging,
  editing the receipt, or losing the Codex setting.

## 0.22.0 voice and historical-chat recovery acceptance

GPT-Live remains experimental. Follow the
[target-Mac voice procedure](TECHNICAL_GUIDE.md#gpt-live-voice-and-local-tasks)
using the exact installed release backend and an account with native voice
access. Record native voice start/reply/end, certified local-model delegation,
voice restart, and ordinary text/tool continuation separately. Offline adapter
tests do not establish native service availability or successful voice audio.
Keep SDP, call IDs, transcripts, capability URLs, credentials, and upstream
errors out of release evidence; use tested versions and fixed result codes.

The Reconnecting change supplies recovery guidance and corrected CLI text; it
does not add automatic chat migration. Review the
[native-provider procedure](TROUBLESHOOTING.md#reconnecting-in-an-old-chat-after-deactivation-or-uninstall)
and its pinned source/compatibility limits. Preserve its distinction between
the observed native `thread/resume` recovery and the CLI repair procedure that
has not been separately exercised live. Do not claim a new migration command,
rewrite private chat databases or rollout files, or make the inert provider
alias into a live route.

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
