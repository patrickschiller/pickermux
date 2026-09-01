# Changelog

All notable changes to PickerMux will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/patrickschiller/pickermux/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/patrickschiller/pickermux/releases/tag/v0.5.1
[0.5.0]: https://github.com/patrickschiller/pickermux/releases/tag/v0.5.0
[0.4.1]: https://github.com/patrickschiller/pickermux/releases/tag/v0.4.1
[0.4.0]: https://github.com/patrickschiller/pickermux/releases/tag/v0.4.0
