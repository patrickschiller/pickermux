# Contributor and Agent Guide

This file applies to the entire repository. A more specific `AGENTS.md` in a
subdirectory may add or override instructions for that subtree.

PickerMux is a security-sensitive macOS bridge between Codex Desktop and
external model providers. Treat credential isolation, exact routing, private
local state, and recoverable lifecycle changes as product requirements, not
implementation details.

## Start here

Before changing code:

1. Read `README.md` and `CONTRIBUTING.md`.
2. Read `docs/ARCHITECTURE.md` for routing, catalog, certification, service, or
   lifecycle work.
3. Read `SECURITY.md` before handling diagnostics, credentials, headers, local
   state, or vulnerability-related changes.
4. Inspect the current Git status and preserve unrelated work. Never discard a
   contributor's uncommitted changes.
5. Keep the change focused. Do not combine opportunistic refactors with a bug
   fix or feature.

## Repository map

- `bin/pickermux.mjs`: primary executable entry point.
- `bin/lmstudio-picker.mjs`: compatibility alias; keep behavior aligned with
  the primary entry point.
- `src/`: ESM implementation for configuration, discovery, catalog generation,
  routing, request/response adaptation, certification, diagnostics, and the
  installed service lifecycle.
- `test/`: deterministic tests using the built-in `node:test` runner.
- `docs/`: architecture, configuration, troubleshooting, and release guidance.
- `lmstudio-picker.config.json`: checked-in example/default project
  configuration. It must never contain credentials.
- `.github/`: CI, issue forms, ownership, and pull-request guidance.

The source checkout and the installed runtime are different things. Implement
changes in this repository; do not patch `~/.codex/model-bridge/runtime-app`
directly.

## Supported development environment

- macOS.
- Node.js 22.15.0 or newer.
- ECMAScript modules (`.mjs`, `"type": "module"`).
- No third-party runtime npm dependencies.

Use the repository scripts:

```bash
npm test
npm run check
npm run verify
```

For a focused iteration, run the relevant test file first:

```bash
node --test test/header-policy.test.mjs
node --check src/header-policy.mjs
```

Run `npm run verify` before handing off a completed change. CI repeats the test
and syntax checks on macOS with the supported Node.js versions.

## Code conventions

- Match the existing style: two-space indentation, double-quoted strings,
  semicolons, trailing commas in multiline constructs, and descriptive names.
- Use Node.js built-ins and `async`/`await`. Add a dependency only when its
  benefit clearly outweighs the added supply-chain and maintenance surface.
- Prefer small modules and explicit data flow. Inject filesystem, network,
  clock, process, and credential dependencies where practical so tests remain
  isolated.
- Validate untrusted configuration and provider data at the boundary. Reject
  unknown, ambiguous, malformed, or unsafe input instead of guessing.
- Keep errors actionable, but never include credential values, cookies,
  account identifiers, private prompts, capability paths, or sensitive request
  bodies.
- Preserve byte-for-byte behavior on native proxy paths unless the change
  explicitly requires otherwise and has regression coverage.
- Comments should explain security intent, compatibility constraints, or a
  non-obvious tradeoff. Do not narrate straightforward code.

## Non-negotiable invariants

Every change must preserve these guarantees:

1. Native Codex models and external models may share a picker, but never a
   trust domain.
2. Native credentials, cookies, account data, attestation values, and Codex
   metadata must never reach an external provider.
3. External requests are built from a narrow allowlist and use only the
   credential belonging to the selected provider.
4. A public model slug resolves to exactly one immutable route. External slugs
   remain provider-namespaced, and unknown or prefix-only routes fail closed.
5. The bridge binds only to `127.0.0.1` and keeps its capability path private.
6. Newly discovered external models start conservatively. Do not grant tools,
   shell access, context size, or reasoning capabilities that were not measured
   and bound to the exact model configuration.
7. Compatibility mismatches and unknown Codex/provider schemas stop safely;
   they are not opportunities for silent best-effort adaptation.
8. Install, refresh, certification, rollback, and uninstall operations remain
   transactional. A failed operation must retain or restore the last known good
   state.
9. Managed files remain private, ownership boundaries stay explicit, and
   concurrent or user-edited state is never overwritten silently.
10. The implementation must not read `~/.codex/auth.json`.

Changes to headers, routing, model identity, URL validation, decompression,
tool normalization, credentials, service installation, or rollback require
both positive and negative tests at the trust boundary.

## Protect the contributor's machine

Ordinary unit tests and syntax checks must not require Codex Desktop, LM Studio,
network access, a real Keychain item, or a user's live Codex configuration.
Use temporary directories, loopback test servers, injected fetch functions,
and fake credential resolvers. Register cleanup with the test context.

Do not run state-changing or live commands against a contributor's machine
unless the task explicitly requests that operation and the target environment
has been confirmed. This includes:

- `pickermux install`, `refresh`, or `uninstall`;
- `pickermux credential-set` or `credential-delete`;
- `pickermux certify`;
- `pickermux doctor --live`.

Setting a temporary `CODEX_HOME` does not by itself isolate macOS Keychain or
LaunchAgent effects. Prefer unit-level dependency injection for lifecycle work.
Never print or commit real configuration snapshots, tokens, cookies, account
IDs, local usernames, private model data, capability URLs, or unredacted logs.

## Tests and documentation

- Add or update tests for every behavior change and regression fix.
- Keep tests deterministic and offline by default. Live inference belongs only
  in explicitly requested manual validation.
- Test failure paths, rollback, malformed input, stale state, and secret
  non-disclosure, not only the successful path.
- Update `README.md`, the relevant file under `docs/`, CLI help, and
  `CHANGELOG.md` when user-visible commands, configuration, behavior, recovery,
  or compatibility changes.
- Keep examples safe to copy: use placeholders, private-network examples, and
  namespaced model slugs. Never embed a usable secret or personal endpoint.
- Preserve the statement that PickerMux is an unofficial community project and
  is not affiliated with OpenAI, Codex, or LM Studio.

## Git and pull requests

- Work from the current default branch on a focused topic branch unless the
  maintainer explicitly requests a direct change.
- Use concise, imperative commit messages and keep commits reviewable.
- Do not bypass failing checks, weaken a security assertion to make a test
  pass, or silently change compatibility behavior.
- Follow `.github/pull_request_template.md`. State the validation performed and
  the security/compatibility impact, including `None` when appropriate.
- Report suspected vulnerabilities privately according to `SECURITY.md`; do
  not open a public issue with exploit details or sensitive diagnostics.

## Definition of done

A change is complete when the diff is focused, relevant tests cover the new
behavior and failure modes, `npm run verify` passes, user-facing documentation
is synchronized, and no private data or generated local runtime artifacts are
included.
