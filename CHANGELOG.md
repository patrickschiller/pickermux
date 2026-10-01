# Changelog

All notable changes to PickerMux will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.0] - 2026-10-01

### Added

- Make the macOS menu-bar app the primary installation and distribution: a
  universal DMG with the pinned CLI/backend bundled inside the app.
- Add DMG update discovery and an explicit app-bundled backend upgrade that
  preserves installed provider settings through the existing setup transaction.
- Replace the long README with a concise app guide, side-by-side app/picker
  images, a direct DMG download link and a separate technical guide.

### Changed

- Publish only the DMG as a release asset. Keep verification metadata internal
  and publish the DMG SHA-256 in release notes. Production signing and
  notarization remain mandatory.

### Fixed

- Explain disabled companion removal using its actual status. An absent
  integration and CLI now show that only the app remains to be deleted, rather
  than incorrectly requesting an older CLI update. Partial or unverified
  installations remain blocked and are not labelled removed.

## [0.9.6] - 2026-10-01

### Fixed

- Correct companion removal when login startup has never been registered or
  was already removed. Await macOS unregister completion, recognize only its
  documented already-absent response, and verify registration before purge.
- Keep removal blocked on real login-service errors or a still-registered
  service, and distinguish that failure from removal of the integration/CLI.
- Add an explicit local Apple Development signing mode with full bundle and
  mounted-DMG signature checks; production releases still require Developer ID
  signing and notarization.

## [0.9.5] - 2026-10-01

### Added

- Add **Remove PickerMux completely…** in companion Settings with a fresh
  removal preview and explicit consent to remove the integration, runtime,
  CLI, certifications, verified backups and registered provider credentials.
- Add `uninstall --purge --restore-native` to restore native Codex defaults
  without reactivating a former Ollama gateway. Default uninstall behavior
  still restores the previous configuration.
- Disable companion login startup before removal, clear only app-owned
  preferences and notifications after success, and stop queued/background
  actions. The final screen explains how to quit and remove the app in Finder.

### Security

- Validate the native configuration plan before irreversible provider
  credential deletion, revalidate ownership at commit, and retain existing
  inventory, lock, rollback and exact-cleanup guards. Native authentication,
  account model cache, chats and unrelated settings are preserved; an inert
  provider alias keeps historical chats readable.
- Keep complete removal restricted to the receipt-owned installed backend;
  older or unverified CLI versions cannot silently use the bundled setup
  backend for removal.

## [0.9.4] - 2026-10-01

### Changed

- Describe PickerMux as a bridge from Codex Desktop to local and remote
  compatible Responses providers in the README, package metadata, and companion.
- Document the existing provider kinds, allowlist requirements, and model-bound
  certification. Identify LM Studio as the first-install default with specific
  loaded-model discovery, Efficient Fidelity, and local compaction adapters.
- Generalize setup and certification copy to available configured-provider
  models. Provider support, routing, credentials, and certification gates are
  unchanged.

## [0.9.3] - 2026-10-01

### Fixed

- Use larger 14-point text for the companion's primary content and controls,
  widen its panel, and show setup errors with readable contrast.
- Distinguish refused connections, timeouts, denied network access, provider
  authentication and invalid discovery responses during setup. Unknown failures
  no longer misleadingly instruct users to start their model server.
- Identify a failed setup message as the last attempt rather than current
  provider status; status polling does not test provider connectivity.

## [0.9.2] - 2026-10-01

### Added

- Add an original monochrome menu-bar template symbol with standard/Retina
  representations and light/dark appearance tinting.

### Fixed

- Queue manual status checks behind active polling/actions and always show
  their progress and completion time, including unchanged results.
- Open Settings and Help in persistent native windows instead of dispatching
  them from the transient menu panel; use asynchronous confirmation windows
  for recovery, additional certification and updates.
- Put the small Codex switch first and install/reactivate automatically from
  explicit toggle intent, retaining fresh status, preview-token and backend
  ownership checks. Show busy/elapsed-time feedback and actionable failures.
- Move update checks, update results and version information into Settings.

## [0.9.1] - 2026-10-01

### Added

- Add a prominent Codex integration toggle with reviewed first installation,
  receipt-bound reactivation and confirmed deactivation that retains private
  settings, certifications and backups. Keep historical chats readable while
  inactive, and collapse advanced setup details in the companion panel.
- Add an original macOS app icon and native iconset/ICNS compilation in the
  universal app and DMG builder.

### Fixed

- Show first-install state instead of treating an absent compatibility
  manifest as a detected Codex update. Return actionable setup errors for
  unavailable providers, missing loaded models and stale native account cache.
- Require the explicit toggle capability before selecting an installed
  companion backend. Use reviewed bundled setup to upgrade older backends,
  and keep immutable 0.9.0 contents intact in their version directory.

## [0.9.0] - 2026-10-01

### Added

- Add a native macOS 13+ menu-bar companion for installation status, picker
  refresh, Codex opening, explicitly confirmed update recovery, live model
  certification, configuration previews, and PickerMux update checks.
- Add `pickermux companion status` and `pickermux companion run` with a
  versioned, bounded JSON protocol. Partial status and fixed error codes omit
  credentials, capability addresses, account/model identities, and raw logs.
- Include a manifest-verified backend in the app for read-only inspection and
  explicit setup when the installed CLI is absent or predates the protocol.
  Other mutations require the active receipt-owned CLI.
- Add an opt-in refresh after Codex closes, opt-in status notifications, and
  optional login startup through macOS Service Management. Recovery,
  certification, configuration switches, and updates remain user-started.
- Add a universal Apple-silicon/Intel app build with separate unsigned
  development and Developer ID/notarized release paths. A protected signing
  workflow retains reviewed release artifacts rather than publishing them
  automatically.
- Package the companion as a versioned DMG with an Applications shortcut for
  drag-to-install, alongside the existing archive. Both assets are bound by
  the release manifest and checksums; release mode signs, notarizes, staples,
  and verifies the app and disk image before retaining them for review.
- Verify fixed-origin release assets, checksums, the embedded manifest, and
  each archive file before executing an update through the existing setup
  transaction. CLI updates retain the existing rollback and incomplete
  certification boundaries.

### Changed

- Retain the explicit `model_bridge` provider and its HTTP/SSE and zero-retry
  controls. The root-only built-in-provider mode remains blocked because its
  transport defaults do not satisfy the required contract.
- Canonicalize only receipt-owned provider configuration while preserving
  user bytes and line endings. A confirmed preview token binds an Ollama or
  other gateway replacement to the inspected configuration; verified backups,
  concurrent-edit checks, rollback, and later uninstall preserve the previous
  integration and historical chat compatibility.
- Preserve configuration ownership receipts during full refresh and use
  temporary native configuration instead of reinstating a previous gateway.
  Edited suspension state blocks reactivation; a valid checkpoint resumes only
  after renewed confirmation.

### Fixed

- Keep retry, help, settings, and quit controls accessible when companion
  status fails. Node.js guidance also covers an installed runtime that cannot
  be validated, while bridge actions continue to require authoritative status.
- Accept the standard administrator-group-writable Homebrew `bin` and
  `Cellar` directories for a validated Node.js executable instead of reporting
  a missing runtime. Other ownership, ancestor, link, and world-write checks
  remain enforced.
- Show the regular installer first in the README's installation section and
  move the repair-only `--repair-chats` command into its own subsection.

The maintainer confirmed the 0.8.3 live baseline. The new companion's real
macOS Apple-event/TCC, recovery, login-start, and signed-release acceptance
remain separate checks; signing and notarization are not established by an
unsigned development build. See [the companion guide](docs/MACOS_COMPANION.md).

## [0.8.3] - 2026-09-30

### Fixed

- Validate the exact-version Codex account cache before external-provider
  discovery or credential resolution during catalog construction. A failed
  managed build preserves the existing catalog and reports `refresh --full`
  recovery, including the managed-configuration review requirement.
- Accept `refresh --FULL` as an alias for `refresh --full`, retaining the same
  interactive confirmation and option restrictions. Cover patch-update cache
  recovery and refusal to reactivate with an older cache in offline tests.
- Explain that a refused uninstall retains the integration and requires
  review before `--force`. Successful uninstall now explicitly asks for a full
  Codex restart and native-model selection in historical PickerMux chats;
  their retained compatibility provider cannot serve new turns.

See the [release notes](docs/RELEASE_NOTES_0.8.3.md) for update recovery and
validation limits.

## [0.8.2] - 2026-09-29

### Added

- Add `pickermux repair-chats [--json]` for historical chats that cannot load
  after an older uninstall removed `model_bridge`. The command restores only
  the inert compatibility table, requires Codex Desktop to be closed, is
  idempotent, and refuses installed or ambiguous configuration state.
- Add a verified release-installer recovery mode, `install.sh --repair-chats`,
  that runs the repair from the checked payload without setup. It works when
  the installed CLI lacks the new command or a stale account model cache blocks
  setup.

### Fixed

- Preserve the inert historical `model_bridge` provider table during normal
  uninstall and `uninstall --remove-cli` for the canonical `model_bridge`
  integration, as full purge already did. Old chats remain parseable after
  removal; select a native model before sending another turn.

See the [release notes](docs/RELEASE_NOTES_0.8.2.md) for recovery instructions
and validation limits.

## [0.8.1] - 2026-09-29

### Fixed

- Make post-Codex-upgrade recovery actionable when setup finds modified
  PickerMux-managed configuration. Doctor names only known affected managed
  areas, without printing their contents, and setup explains the explicit
  review, forced-uninstall, native-cache refresh, and reinstall sequence.
  Modified configuration still blocks automatic setup and full refresh.

See the [release notes](docs/RELEASE_NOTES_0.8.1.md) for the manual recovery
procedure and validation limits.

## [0.8.0] - 2026-09-27

### Added

- Automatically certify discovered external models without a valid tool receipt
  after release setup or direct installation. Preserve existing Direct and
  Efficient Fidelity receipts and retain the activated installation if model
  certification fails, with a nonzero exit status and explicit retry guidance.
- Explain live certification's duration during installation and show model/check
  progress with elapsed-time updates every ten seconds. Progress also covers
  manual certification, uses stderr for pipe-safe output, and keeps JSON stdout
  machine-readable without logging model identifiers, prompts, or credentials.

See the [release notes](docs/RELEASE_NOTES_0.8.0.md) for installation, recovery,
and validation limits.

## [0.7.6] - 2026-09-27

### Fixed

- Detect the nested Codex executable in current macOS app bundles, preserving
  explicit `CODEX_BINARY` overrides, the older bundle location, and the `PATH`
  fallback. This fixes `Failed to read the Codex client version` during setup
  when only the newer bundle layout is present. Catalog reads use the same
  resolver, and compatibility monitoring tracks the executable itself.

See the [release notes](docs/RELEASE_NOTES_0.7.6.md) for upgrade instructions
and validation limits.

## [0.7.5] - 2026-09-14

This release contains the shared web-search feature and all fixes developed
in the unpublished 0.7.0–0.7.4 milestones below. See the
[complete release notes](docs/RELEASE_NOTES_0.7.5.md).

### Added

- Shared Codex `web.run` search for exact, tool-certified external models,
  with the native search service kept separate from the selected answer model.
- LM Studio V2 context compaction with authenticated model-bound state and
  correct continuation after a restored summary.

### Fixed

- Bounded certification transport for long LM Link requests and structured
  stream failures instead of opaque disconnects. Native credential isolation,
  byte-preserving native routes, and certification gates remain intact.

### Changed

- During exact LM Studio V2 compaction only, validate then omit the original
  top-level `instructions` before merging system messages. Codex keeps those
  base instructions outside compacted history and sends them again for ordinary
  inference. Preserve every input message, including historical system and
  developer instructions, tool results, and source URLs. Ordinary requests,
  replay, legacy compact, native routes, and other providers are unchanged.
- Ask summaries to distinguish completed actions and evidence from remaining
  work. Resume from recorded tool results; repeat a lookup when evidence is
  missing, stale, or contradictory, or instructions require a fresh check.
  This guidance addresses repeated search/compaction cycles without blocking
  tool calls, adding retries, or claiming that model behavior is guaranteed.

### Validation and limits

- The successful 0.7.4 run took 16 minutes 56 seconds and included three
  compactions totaling about 10 minutes 50 seconds. Its ordinary continuations
  already reused over 26,000 cached input tokens; no cache setting is changed.
- An offline reconstruction of the first summary through both adapter versions
  reduced its JSON body from 73,012 to 51,426 bytes (29.6%), including the new
  checkpoint instructions. All conversation input remained identical after
  removing only the separately supplied base-instruction field. This measures
  bytes, not model tokens or live latency.
- The initial full Codex prompt remains large. Keep the current model
  certification and upgrade normally from immutable 0.7.4; the encrypted-state
  format and model/key binding remain compatible.
- The user confirmed a correct answer with 0.7.5 in about eight minutes and a
  faster subsequent request. This follows the roughly seventeen-minute 0.7.4
  run on the same setup; it is an individual observation, not a controlled
  benchmark or a guaranteed speedup for other models or hardware.

## [0.7.4] - 2026-09-14

Prepared locally; not published. Live continuation acceptance remains pending.
See the [candidate acceptance procedure](docs/WEB_SEARCH_ACCEPTANCE.md).

### Fixed

- After restoring an authenticated terminal compaction item for ordinary LM
  Studio inference, append one short fixed user-role continuation instruction.
  LM Studio otherwise treats the restored assistant summary as response prefill
  and continues its text instead of producing a new answer. Keep the dynamic
  summary at assistant authority; add no instruction if later conversation
  input already exists or when preparing another compaction.
- Retain the existing v1 encrypted-state format, model/key binding, tool
  authority, and native byte-preserving path. Existing 0.7.3 state continues
  after a normal upgrade without recertification.

### Validation and limits

- The 0.7.3 live test completed web search and compaction. Both the search result
  and encrypted summary contained the correct venue and official source; the
  final ordinary request ended in assistant context and produced only a sentence
  fragment. LM Studio's installed prompt builder confirms this prefill behavior.
- The three live inference phases used 26,195, 19,556, and 26,268 input tokens.
  Prompt processing accounted for approximately 13 minutes 43 seconds of the
  13 minutes 58 seconds observed. This correction closes the response boundary;
  it does not reduce the full coding harness or guarantee a faster next run.
  No additional inference or automatic retry is added.

## [0.7.3] - 2026-09-14

Prepared locally; not published. Live external-model search, compaction, and
continuation acceptance remain pending. See the
[candidate acceptance procedure](docs/WEB_SEARCH_ACCEPTANCE.md).

### Fixed

- Adapt Codex's `compaction_trigger` request for LM Studio instead of forwarding
  an unsupported input type. A requested compaction makes one bounded summary
  call to the selected model without tool schemas. Supported text history,
  public tool-call identities, results, and source URLs are supplied as data.
- Return a completed compaction item only after a complete, nonempty, bounded
  model summary. Its authenticated encrypted envelope is bound to the
  installation and exact provider/model/context catalog configuration. Later
  requests restore it as assistant context; ordinary requests add no inference.
  Native and foreign compacted state cannot enter LM Studio, and PickerMux state
  cannot cross to native or other providers on model switch.
- Preserve text-array tool results and reasoning replay. Reject malformed
  controls, unsupported media, invalid state, incomplete responses, and tool
  calls without fabricating success or replacing prior history.

### Validation and upgrade

- The installed 0.7.2 build completed external-model certification and issued
  a real web call. Its next request failed because Codex requested remote
  compaction; this was not another timeout or a missing tool grant. Completed
  sourced-answer acceptance remains pending.
- Upgrade immutable 0.7.2 packages through normal setup and retain still-valid
  certification. Ordinary refresh and upgrades preserve the derived key.
  `refresh --full` and uninstall/reinstall replace the installation capability;
  previous compacted tasks then require a new task or restored original state.
- Summaries are model-generated and lossy. Oversized context still fails without
  silent truncation. A measured `none` reasoning option is used for summaries
  when available; ordinary inference reasoning and timeouts remain unchanged.

## [0.7.2] - 2026-09-13

Prepared locally on this date; not published. Live timeout-reporting and
external-model web-search acceptance are pending; confirm the release date
before tagging. See the [candidate acceptance procedure](docs/WEB_SEARCH_ACCEPTANCE.md).

### Fixed

- Transformed external responses defer their headers until validated output
  is available, so an earlier timeout or validation failure can return a
  structured error instead of an opaque stream disconnect. Header, idle, and
  total timeouts have distinct fixed messages without provider error content.
  Native response bytes and timeout limits remain unchanged.
- After transformed external SSE output has started, an upstream transport or
  validation failure emits a minimal `response.failed` event with the fixed
  error code and message while the client remains connected, then ends the
  response normally so Codex can display the cause.
  The upstream request is stopped; no completion or tool result is fabricated.

### Validation and upgrade

- The installed 0.7.1 candidate passed all eight base certification gates and
  the additive tool-search gate on the tested LM Link model. A later Codex task
  hit its configured ten-minute idle limit during prompt processing; this
  identifies the disconnect boundary, not the cause of slow prefill.
- Upgrade immutable 0.7.1 packages normally to 0.7.2 and retain a still-valid
  certification. The fix adds no model requests or tokens and does not alter
  reasoning, GPU settings, or retained context. External-model search remains
  pending despite successful native search/open smoke checks.

## [0.7.1] - 2026-09-13

Prepared locally on this date; not published. Certification subsequently passed
all eight base gates and the additive tool-search gate on the tested LM Link
model. External-model web-search acceptance remains pending; the current
candidate and [acceptance procedure](docs/WEB_SEARCH_ACCEPTANCE.md) are 0.7.3.

### Fixed

- Certification uses bounded local HTTP transport instead of Node's default
  `fetch`, avoiding Undici's independent five-minute header/body timeout when
  a probe has a longer deadline. Failed probes retain a fixed probe label and
  redacted transport code. This addresses a possible cause of an otherwise
  generic `fetch failed`; the original LM Link failure has not been proven to
  have that cause, although a complete live retry with this fix passed.
- External inference now distinguishes pending or unavailable certification
  from unavailable provider credentials with separate fixed diagnostics,
  instead of reporting both as a generic service failure. Certification
  recovery and credential isolation remain enforced.

### Validation and upgrade

- A short local bridge-to-LM-Link inference and native `web.run` search/open
  smoke checks succeeded during investigation, followed by a full live
  certification pass. External-model web search remains pending. No reasoning
  defaults or unmeasured model capability grants are changed.
- The corrected candidate is 0.7.1 so it can upgrade an already installed,
  immutable 0.7.0 package normally. Same-version content and checksum checks
  remain enforced.

## [0.7.0] - 2026-09-13

Prepared locally on this date; not published. Live acceptance is pending;
confirm the release date before tagging. See the
[candidate acceptance procedure](docs/WEB_SEARCH_ACCEPTANCE.md).

### Added

- Experimental shared Codex `web.run` support through the native standalone
  search endpoint. Exact, tool-certified external models retain their own
  answer route while search requests use optional `bridge.webSearchModel` or
  the native `bridge.defaultModel`. No additional LM Studio inference request,
  provider API key, result cache, or result truncation is introduced. Native
  backend acceptance still requires live validation; the implemented protocol
  is covered by public Codex fixtures and offline tests.

### Changed

- Install and normal refresh opt the managed provider into standalone search
  and add the Codex feature only when it is not explicitly set. Existing
  disabling settings remain effective. Refresh migrates receipt-owned state
  transactionally, requires the running search contract, and rolls back on
  failure; uninstall removes only the feature block PickerMux added. When an
  old provider block needs this migration, its uniquely receipt-recovered
  missing end marker is materialized as part of that same transaction.
- One SHA-256-pinned public `web.run` description is reduced from 7,507 to 3,475
  UTF-8 bytes for LM Studio while retaining search, citation, and source-limit
  policy. Unknown or edited descriptions remain unchanged; schemas, search
  settings, explicit budgets, conversation context, and results are preserved.

### Security

- Standalone search resolves the exact selected route and requires its current
  Direct/appropriate Efficient Fidelity receipt and pending-state gate before
  external-model use. Requests target only the fixed native destination;
  native authentication never reaches an external provider. External-model
  search results use a validated envelope and fixed, redacted errors, while
  accepted native search requests and responses remain byte preserving.

## [0.6.1] - 2026-09-13

### Fixed

- LM Studio requests with both top-level `instructions` and system/developer
  input now combine them into one leading system message, with instructions
  first and the existing input order preserved. The separate `instructions`
  field is removed only when merged; instructions-only requests keep their
  existing shape. This fixes the Jinja `System message must be at the beginning`
  failure that can appear as `Channel Error`, including when LM Link chat works
  but the Codex API request fails. Native requests and other provider contracts
  are unchanged.

## [0.6.0] - 2026-09-03

### Added

- **Efficient Fidelity** for exact, additionally certified LM Studio models.
  Codex's client-executed `tool_search` and deferred tool delivery now keep
  large deferred function schemas out of the initial LM Studio request while
  retaining the complete coding harness, project instructions, conversation,
  selected skills, sandbox, approvals, and Codex-owned tool execution.
- An additive, model-bound `toolSearch` certification gate. The base live
  matrix is committed first as Direct fidelity, then a separate full-replay
  search probe can authorize Efficient Fidelity for the same provider, model,
  context, capabilities, and Codex client version.

### Changed

- LM Studio search calls are projected into a bounded temporary function and
  mapped back to public `tool_search_call` items. On the Codex replay, only the
  exactly correlated deferred tools in the completed `tool_search_output` are
  added through the existing namespace adapter; functions that were not
  deferred remain advertised normally.
- Remote Codex compaction keeps working after a search, including when Codex
  trims older selected schemas: historical namespace names are mapped for the
  compact request without re-advertising or re-authorizing those tools.
- A missing, stale, failed, or inapplicable additive gate now uses Direct
  fidelity when the base tool receipt remains valid. Base-uncertified models
  continue to use the conservative text-only path. PickerMux does not add a
  Fast Agent route, tool broker, or provider-wide capability switch. Failed
  additive probes report a fixed diagnostic reason without exposing provider
  response content.
- The bridge compatibility contract advances to `codex-responses-bridge/p6-v1`
  so older or non-p6 catalog entries cannot activate the new delivery mode.

### Security

- Efficient Fidelity fails closed for non-client execution, unknown search or
  loaded-tool types, malformed arguments, duplicate or mismatched call IDs,
  secondary tool inventories, incomplete or unterminated streaming calls, and
  bounded-inventory violations. Repeated identical search results are safely
  deduplicated, while schema drift under the same identity is rejected. Version
  0.6.0 requires full public replay and rejects `previous_response_id` on this
  path instead of inferring continuation state.
- Re-certification now uses a persisted request-time deactivation barrier. It
  blocks stale ordinary tool authority in an already-running service, opens the
  private probe transport only after conservative publication, and remains in
  place across interrupted pre-publication transitions until an explicit retry
  can recover safely. The same gate rejects Direct or Efficient Fidelity route
  claims when their required receipt grant has disappeared.
- LM Studio response calls are bound to the exact request-local advertised
  function inventory. All external text-only and compaction responses have no
  call authority, and LM Studio streaming calls remain held until a consistent
  successful terminal commits them.
- Native Codex request and response paths remain byte preserving and never
  enter the Efficient Fidelity adapter.

## [0.5.4] - 2026-09-02

### Fixed

- A successful canonical `pickermux uninstall --purge` now leaves a
  marker-bounded, credential-free, loopback-port-zero `model_bridge`
  compatibility table so Codex can open historical PickerMux chats without
  reviving an external route. Later installation removes only that exact table;
  modified or foreign provider definitions still fail closed. The table retains
  only config-file retention provenance so a later ordinary uninstall preserves
  an absent path, an empty existing file, or surviving user content.

### Added

- An explicit, interactive `pickermux refresh --full` recovery mode can refresh
  native account visibility without discarding the installed provider
  configuration, certifications, verified backups, or Keychain credentials. It
  gracefully quits Codex, temporarily suspends PickerMux, opens Codex natively,
  waits for a newly valid account cache for the exact installed client (and a
  later fetch timestamp when a valid baseline existed), quits Codex again,
  transactionally reactivates PickerMux, and reopens Codex with the mixed
  catalog.

### Changed

- A structurally valid account cache for the exact Codex client version no
  longer produces a warning merely because of its age. `doctor` retains its
  fetch timestamp and reports age only as neutral diagnostic metadata; missing,
  malformed, unsafe, future-dated, or version-mismatched caches still fail
  closed.

### Security

- Full refresh requires an explicit terminal confirmation, rejects `--json`,
  never escalates to a forced process kill, and records a private checkpoint so
  interrupted operations have bounded recovery instructions instead of being
  reported as complete. Reactivation retains the existing transactional
  lifecycle and ownership checks. Scheduler dispatch, worker execution, and
  helper cleanup share the lifecycle lock; indeterminate `launchctl` or
  checkpoint reads fail closed without deleting recovery state.

## [0.5.3] - 2026-09-02

### Fixed

- Setup no longer leaves an older CLI unable to uninstall when a
  receipt-recoverable provider end marker coincides with a missing or stale
  Codex account cache. Before the initial cache preflight returns its recovery
  instructions, the downloaded setup payload atomically restores only that
  uniquely receipt-proven marker under the lifecycle lock. CLI and runtime
  activation remain unchanged, while every ambiguous or edited configuration
  still fails closed.

## [0.5.2] - 2026-09-02

### Fixed

- Missing managed provider end markers are now recovered at the unique safe
  line boundary whose reconstructed block matches the private receipt. This
  preserves intervening blank or comment lines instead of requiring the marker
  to sit immediately before the next TOML table; ambiguous and provider-scoped
  content changes still fail closed.

## [0.5.1] - 2026-09-01

### Added

- Privacy-safe, in-memory text-only context telemetry reports byte and part
  counts without retaining prompt text, model or provider identifiers,
  filesystem paths, hashes, or request and conversation identifiers.
- The running bridge now watches the installed Codex executable identity and
  revalidates the client version and bundled catalog when it changes. A
  confirmed compatibility drift is quarantined with a stable `update-required`
  response; an unverifiable check fails closed as `check-failed` and remains
  retryable instead of continuing on stale startup state.

### Fixed

- Text-only prompt compaction no longer depends on full-payload hashes from one
  Codex Desktop release. Generic developer context is retained, while later
  memory, multi-agent, and exactly wrapped generated bootstrap remains
  independently removable through private semantic annotations, expected
  roles, exact shapes, and fail-closed envelope checks.
- A receipt-verified missing managed provider end marker is recovered
  virtually when reinserting that one exact marker recreates the recorded
  block digest at the next TOML table or end of file. Status, refresh,
  selection changes, and uninstall remain recoverable without silently editing
  the user's configuration; every ambiguous or modified case still fails
  closed.
- Catalog synchronization now checks the live compatibility gate at each
  publication boundary and rolls back selection or catalog changes if a Codex
  update races an in-flight discovery cycle.

### Security

- Unknown generic bootstrap is never guessed away, user and project context is
  still retained, and compatibility and telemetry endpoints expose only fixed
  status enums and aggregate numeric counters.

## [0.5.0] - 2026-09-01

### Added

- A standalone `codex-account-cache` check in `pickermux doctor`, independent
  of bridge-runtime and mixed-catalog availability.
- An explicit `pickermux uninstall --purge` lifecycle that removes the managed
  integration, receipt-owned CLI distribution, verified configuration backups,
  and registered PickerMux provider credentials.

### Fixed

- Setup now validates the account-scoped Codex model cache before staging,
  repeats that read-only preflight under the lifecycle lock, and checks it once
  more immediately before activation. A missing or version-mismatched cache
  leaves the active PickerMux installation unchanged.
- Reduced LM Studio prompt-prefill overhead for uncertified text-only models by
  replacing the donor coding-agent profile with a latency-first allowlisted
  prompt and excluding verified desktop-app, cross-thread-memory, tool, and
  agent-mode bootstrap whose private annotation, incoming role, and exact
  message/content shape plus per-kind envelope or pinned-template verifier match
  the Codex contract. User content, attachments, current environment facts,
  project and managed instructions, selected skill instructions, and history
  remain intact. A recognized pinned/template mismatch is retained without
  re-enabling later independently verified bootstrap context.

### Security

- Runtime, CLI, backup, and provider-registry removal now use exact ownership
  inventories with receipt, digest, and filesystem-identity revalidation;
  changed or foreign data is retained for review instead of being deleted
  recursively.
- Full purge deletes only exact provider-scoped Keychain entries recorded in
  PickerMux's private, secret-free registry. Native Codex authentication,
  including `~/.codex/auth.json`, is never read, modified, or removed.
- External Responses requests now remove Codex `client_metadata`, including
  installation, session, thread, window, and turn identifiers. Native request
  bodies remain byte preserving and ordinary provider `metadata` is retained.

## [0.4.1] - 2026-08-30

### Fixed

- Enforce conservative `text-only` model status at the bridge boundary by
  removing optional function-tool catalogs before external requests are sent.
- Reject forced tool choices and tool-call history for models without a valid
  model-bound certification receipt.
- Preserve live certification through a private per-runtime marker that is
  accepted only by the local bridge and is never forwarded to providers.

### Security

- Tool certification is now a transport-enforced capability instead of relying
  only on Codex catalog metadata. This prevents uncertified models from
  receiving large or executable function schemas when a client still submits
  them.

## [0.4.0] - 2026-08-29

### Added

- Initial public release under the PickerMux name.
- A single loopback bridge that adds currently loaded LM Studio models to the
  normal Codex Desktop picker while preserving account-visible native models.
- Strict namespace and header separation between native Codex traffic and
  external providers.
- Dynamic discovery of loaded LM Studio models and their active context sizes.
- Conservative text-only defaults for external models plus per-model tool-use
  certification gates.
- Request and streaming-response normalization for the LM Studio Responses API.
- Transactional install, refresh, rollback, status, doctor, and uninstall
  workflows for the managed catalog and per-user LaunchAgent.
- Optional provider-scoped credential storage in the macOS Keychain, with
  secret-free status output and isolated credential resolution.
- A private compatibility manifest that detects drift between the installed
  bridge contract, Codex Desktop version, and bundled catalog.
- Automatic selection reconciliation when a local model or reasoning mode is
  no longer available.
- Automated tests and syntax checks across supported Node.js releases on
  macOS.
- A one-line, versioned GitHub Release installer with a persistent user-local
  CLI, idempotent setup, explicit upgrades, version reporting, and safe
  distribution removal.
- Deterministic release archives, generated checksums, and automated release
  publication gates.

### Security

- Native authentication, account, cookie, attestation, and Codex metadata are
  excluded from requests routed to external providers.
- Inline secrets, wildcard model allowlists, and unapproved private-network
  targets are rejected by configuration validation.
- Certification evidence is bound to model, provider, capability, context, and
  client-version metadata so stale evidence cannot silently enable tools.
- Release setup verifies an embedded SHA-256 digest, rejects unsafe archive
  paths and file types, refuses root execution and foreign launchers, and
  restores the previous distribution state when activation fails.

[Unreleased]: https://github.com/patrickschiller/pickermux/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/patrickschiller/pickermux/releases/tag/v0.10.0
[0.9.6]: https://github.com/patrickschiller/pickermux/releases/tag/v0.9.6
[0.9.5]: https://github.com/patrickschiller/pickermux/releases/tag/v0.9.5
[0.9.4]: https://github.com/patrickschiller/pickermux/releases/tag/v0.9.4
[0.9.3]: https://github.com/patrickschiller/pickermux/releases/tag/v0.9.3
[0.9.2]: https://github.com/patrickschiller/pickermux/releases/tag/v0.9.2
[0.9.1]: https://github.com/patrickschiller/pickermux/releases/tag/v0.9.1
[0.9.0]: https://github.com/patrickschiller/pickermux/releases/tag/v0.9.0
[0.8.3]: https://github.com/patrickschiller/pickermux/releases/tag/v0.8.3
[0.8.2]: https://github.com/patrickschiller/pickermux/releases/tag/v0.8.2
[0.8.1]: https://github.com/patrickschiller/pickermux/releases/tag/v0.8.1
[0.8.0]: https://github.com/patrickschiller/pickermux/releases/tag/v0.8.0
[0.7.6]: https://github.com/patrickschiller/pickermux/releases/tag/v0.7.6
[0.7.5]: https://github.com/patrickschiller/pickermux/releases/tag/v0.7.5
[0.7.4]: docs/RELEASE_NOTES_0.7.4.md
[0.7.3]: docs/RELEASE_NOTES_0.7.3.md
[0.7.2]: docs/RELEASE_NOTES_0.7.2.md
[0.7.1]: docs/RELEASE_NOTES_0.7.1.md
[0.7.0]: docs/RELEASE_NOTES_0.7.0.md
[0.6.1]: https://github.com/patrickschiller/pickermux/releases/tag/v0.6.1
[0.6.0]: https://github.com/patrickschiller/pickermux/releases/tag/v0.6.0
[0.5.4]: https://github.com/patrickschiller/pickermux/releases/tag/v0.5.4
[0.5.3]: https://github.com/patrickschiller/pickermux/releases/tag/v0.5.3
[0.5.2]: https://github.com/patrickschiller/pickermux/releases/tag/v0.5.2
[0.5.1]: https://github.com/patrickschiller/pickermux/releases/tag/v0.5.1
[0.5.0]: https://github.com/patrickschiller/pickermux/releases/tag/v0.5.0
[0.4.1]: https://github.com/patrickschiller/pickermux/releases/tag/v0.4.1
[0.4.0]: https://github.com/patrickschiller/pickermux/releases/tag/v0.4.0
