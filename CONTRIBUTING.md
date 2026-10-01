# Contributing to PickerMux

Thank you for helping improve PickerMux. Contributions that make the bridge
safer, easier to understand, or more reliable on macOS are welcome.

PickerMux is an unofficial community project. It is not affiliated with,
endorsed by, or supported by OpenAI, Codex, or LM Studio.

## Before opening an issue

1. Search the existing issues for the same behavior or proposal.
2. Reproduce the problem with the latest release or default branch and record
   `pickermux --version` when using an installed release.
3. Run `pickermux doctor` and, when appropriate,
   `pickermux doctor --live`.
4. Remove tokens, account identifiers, cookies, capability paths, local
   usernames, and other private data from every command, log, and screenshot.

Use the bug-report form for reproducible defects and the feature-request form
for proposed changes. Security vulnerabilities belong in a private report as
described in [SECURITY.md](SECURITY.md), never in a public issue.

## Development setup

PickerMux requires macOS and Node.js 22.15.0 or newer. The repository has no
runtime npm dependencies.

```bash
git clone https://github.com/patrickschiller/pickermux.git
cd pickermux
npm test
npm run check
npm run release:build
```

`release:build` intentionally refuses to replace an existing `dist/` directory;
remove only your prior local build output before rerunning it.

Some end-to-end checks require Codex Desktop, LM Studio, and a locally loaded
model; ordinary unit and release-packaging tests must remain deterministic
without those applications.

For the optional macOS 13+ companion, use Apple command-line tools with Swift 6
tooling. The package compiles in Swift 5 language mode. Run its isolated tests
and choose a fresh output directory for an unsigned universal app and DMG build:

```bash
swift test --package-path macos
node scripts/build-companion.mjs --output /tmp/pickermux-companion-development
```

The app bundles a verified PickerMux backend and requires an externally
installed Node.js runtime. A development build does not establish release
signing or notarization. The builder mounts its newly created image read-only,
validates the app and Applications shortcut, and unmounts it without installing
the app. Tests must inject these tool operations rather than mounting images.
See [the companion guide](docs/MACOS_COMPANION.md#development-and-distribution)
for the protected signing workflow and outstanding live acceptance checks.

## Making a change

1. Create a focused branch from the current default branch.
2. Keep the existing ECMAScript-module style and avoid dependencies unless
   their benefit clearly outweighs the added supply-chain surface.
3. Add or update tests for every behavior change and regression fix.
4. Preserve the routing boundary: native Codex credentials and metadata must
   never reach an external provider.
5. Preserve conservative defaults for newly discovered external models.
6. Update user-facing documentation when commands, configuration, or behavior
   change.
7. Installer changes must preserve the versioned-asset, embedded-checksum,
   no-`sudo`, no-shell-profile-edit, receipt-ownership, and rollback contracts.
8. Run both required checks before opening a pull request:

```bash
npm test
npm run check
```

Companion changes also require the Swift tests and relevant Node protocol,
configuration, update, and build tests. Keep Swift observational: it must not
write Codex TOML, private receipts, certification state, or LaunchAgent files
directly. Use the finite versioned stdin protocol, validated process targets,
narrow environment, bounded output, and fixed GUI text. User confirmation
cannot replace the backend's ownership, lock, cache, or compatibility checks.

Exercise both successful and rejected consent, unknown schemas, oversized
requests/output, stale previews, edited suspended configuration, child-process
timeout, and absent/old installed CLI cases. Ordinary tests use temporary
directories and fake processes. Apple-event/TCC, login startup, real update
recovery, and signed/notarized distribution require explicit target-machine
acceptance; report those separately from offline tests.

## Pull requests

Keep pull requests small enough to review and explain why the change is needed,
not only what changed. Complete the pull-request checklist and include:

- the macOS, Node.js, Codex Desktop, and LM Studio versions used for testing;
- the models and reasoning modes involved, where relevant;
- redacted output for operational or routing changes;
- limitations or follow-up work that remains.

By contributing, you agree that your contribution is licensed under the MIT
License included in this repository.
