# Changelog

All notable changes to PickerMux will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.1] - 2026-08-30

### Added

- An explicit `uninstall --purge` lifecycle for removing receipt-owned CLI
  files, verified configuration backups, and registered provider Keychain
  credentials in addition to the managed bridge integration.
- A private, secret-free provider registry shared by credential, install,
  refresh, certification, and purge operations under one lifecycle lock.

### Fixed

- Setup now validates the account-scoped Codex model cache before activating a
  new CLI distribution, repeats that check under the installation lock and
  immediately before integration activation, and reports the safe Codex
  restart procedure without entering activation rollback when a new Codex
  version has not refreshed its cache yet.
- Doctor now reports Codex account-cache health independently of the bridge
  runtime and mixed catalog, including after an integration-only uninstall.
- Auto now keeps optional client-supplied tool catalogs on an uncertified local
  text route, excludes the schemas that the bridge will remove from its local
  context estimate, and still sends forced tool turns or tool-call history to
  the native fallback.

### Security

- LaunchAgent removal validates the exact PickerMux-owned plist before
  stopping or deleting it, while full uninstall refuses foreign backup,
  distribution, and credential ownership state.
- Runtime removal is bound byte-for-byte to the invoking PickerMux payload,
  rejects leftover or unexpected runtime entries, and deletes only the exact
  inventoried files and empty directories without recursive removal.
- Receipt-owned CLI removal revalidates the complete quarantined distribution
  after integration removal and cleans only exact inventoried paths, preserving
  concurrent additions or replacements for review.
- Provider-registry entries use the same canonical, bounded provider IDs as
  configuration, and an incomplete runtime, backup, or registry cleanup keeps
  the receipt-owned CLI available for explicit recovery.

## [0.5.0] - 2026-08-30

### Added

- Opt-in `Auto – Smart Routing` (`pickermux/auto`) with one configured LM Studio
  candidate and one exact account-visible native Codex fallback.
- Deterministic local-first selection that falls back for availability,
  context, modality, certified-tool, reasoning, request-size, and complexity
  requirements.
- Bounded, memory-only provider affinity with hashed keys, LRU-style recency,
  and a 30-minute expiry.

### Security

- Auto resolves to one concrete route before provider credential lookup or
  network activity while preserving native and external credential and header
  isolation.
- Smart routing performs no classifier call or prompt fan-out, dispatches to a
  single provider, and never automatically retries a failed local request
  against native Codex.

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
