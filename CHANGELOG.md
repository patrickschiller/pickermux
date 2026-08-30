# Changelog

All notable changes to PickerMux will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/patrickschiller/pickermux/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/patrickschiller/pickermux/releases/tag/v0.4.1
[0.4.0]: https://github.com/patrickschiller/pickermux/releases/tag/v0.4.0
