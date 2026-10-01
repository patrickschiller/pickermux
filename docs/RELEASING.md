# Releasing PickerMux

This checklist is for maintainers publishing a versioned GitHub release and its
one-line installer assets. PickerMux is distributed through GitHub Releases,
not the npm registry.

## Preflight

1. Confirm that all public documentation is in English and that private local
   engineering records remain ignored.
2. Keep the version identical in the Git tag, `package.json`, CLI output,
   release manifest, and `CHANGELOG.md` heading.
3. Inspect every staged file for credentials, account identifiers, private
   prompts, capability paths, hostnames, and machine-specific paths.
4. Run the complete verification suite on macOS:

   ```bash
   npm run verify
   ```

5. Build the release bundle locally and run its verification mode:

   ```bash
   node scripts/build-release.mjs --output dist
   ```

6. Confirm that `pickermux --version`, `help`, `--help`, and `-h` work from the
   extracted archive.
7. Verify README links and render the Mermaid architecture diagram.
8. For lifecycle changes, complete a real clean install, same-version rerun,
   upgrade, all three cache-mismatch preflight/race barriers, failed-upgrade
   rollback, standard uninstall, CLI removal, and full purge on supported
   macOS hardware.

## Release assets

Every release must contain all four generated assets:

- `pickermux-vX.Y.Z.tar.gz`: deterministic allowlisted payload;
- `install.sh`: release-specific bootstrap with the exact version, archive
  name, and archive SHA-256 embedded;
- `release-manifest.json`: machine-readable version, file allowlist, minimum
  Node.js version, archive name, and per-file digests;
- `SHA256SUMS`: digests for the payload, installer, and external manifest.

The payload allowlist is limited to the runtime entry points and sources,
default configuration, package metadata, release manifest, and license. Tests,
Git metadata, private notes, local artifacts, and arbitrary repository files
must not enter the archive.

The installer and archive are release artifacts. Do not point the README at
`raw.githubusercontent.com`, a branch archive, or GitHub's automatically
generated source archives.

### Optional macOS companion assets

When offering the app, add the version-matching, Developer ID signed and
notarized companion assets to the same GitHub Release:

- `PickerMux-vX.Y.Z-macos-universal.dmg`: drag-to-Applications installation;
- `PickerMux-vX.Y.Z-macos-universal.tar.gz`: the same verified app bundle;
- `companion-manifest.json`: backend pin, signing status, archive/image digests;
- `companion-SHA256SUMS`: the companion builder's checksum file, published
  under a distinct name.

The CLI's existing `SHA256SUMS` remains unchanged. Its strict updater expects
the CLI archive, installer and manifest entries. Do not merge app entries
into that file or replace it with the companion builder's checksum file.

The protected `macOS companion` signing job retains reviewed artifacts; it
does not publish them. Run that job for the exact approved release commit,
verify the downloaded artifact's checksums and `developer-id-notarized`
manifest status, then verify app/image signatures, stapled tickets and
Gatekeeper assessments. Complete real drag-to-install, launch after ejecting,
upgrade and GUI/TCC recovery acceptance before distribution. Unsigned CI
artifacts cannot fulfill these release gates.

From a fresh directory containing only the downloaded signed artifact, the
following version-specific example adds new assets after the matching CLI
release has been verified. Adapt every version to the approved tag:

```bash
shasum -a 256 --check SHA256SUMS
cp -n SHA256SUMS companion-SHA256SUMS
cmp SHA256SUMS companion-SHA256SUMS
gh release upload v0.9.5 --repo patrickschiller/pickermux \
  PickerMux-v0.9.5-macos-universal.dmg \
  PickerMux-v0.9.5-macos-universal.tar.gz \
  companion-manifest.json companion-SHA256SUMS
```

Do not use `--clobber`. After publication, download all four companion assets
from the public version-pinned release and check `companion-SHA256SUMS`, the
manifest digests, signatures and tickets again. The original CLI assets and
their checksums must still match their already verified public bytes.

## Automated release workflow

The release workflow runs only for semantic version tags and must complete
these gates before publication:

1. require the tagged commit to be part of `origin/main`;
2. compare the tag with `package.json`, CLI version output, and the changelog;
3. run `npm run verify` on macOS;
4. build the allowlisted payload twice and require identical archives;
5. generate the byte-identical internal and external release manifest, then
   embed the exact finished payload digest in the installer;
6. validate shell syntax, archive paths and file types, and required files;
7. extract the finished asset and run CLI version/help smoke tests;
8. upload the archive, installer, external release manifest, and checksum file
   to the matching GitHub Release only after every earlier gate passes.

Release assets must not be replaced after publication. If an artifact is wrong,
fix the source and publish a new version so existing pinned URLs retain a clear
security meaning.

## Initial `v0.4.0` release

The repository was published before a GitHub Release was created, so the
one-line installer is part of the first `v0.4.0` release rather than being
deferred to a later feature release.

After the release commit is on protected `main` and CI passes, create and push
the annotated tag:

```bash
git tag -a v0.4.0 -m "PickerMux v0.4.0"
git push origin v0.4.0
```

Watch the release workflow. Do not publish announcements until the generated
release exists and both the latest and version-pinned README installer URLs
work from a logged-out environment.

## Subsequent releases

For every release, require the release commit to be merged into and synchronized
with `main`, confirm that neither the tag nor release already exists, and then
create an annotated tag from that exact `main` commit. Never tag an unmerged PR
head or replace already published release assets.

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
  purge separately, without discarding retained recovery evidence;
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

- the repository and release URLs work in a logged-out browser;
- branch protection and CI are green;
- `install.sh`, the archive, `release-manifest.json`, and `SHA256SUMS` are
  present;
- the archive digest matches the value embedded in `install.sh`;
- the README's latest and pinned commands complete successfully;
- the default branch contains the license and security policy;
- announcement media contains no private account or machine information.
