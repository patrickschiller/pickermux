# PickerMux 0.8.2

PickerMux 0.8.2 repairs historical Codex chats that can no longer load after
an older PickerMux uninstall removed the `model_bridge` provider definition.
Normal uninstall and `uninstall --remove-cli` now preserve an inert definition
for the canonical `model_bridge` integration, as full purge already did.

**Validation exception:** macOS CI and the offline suite passed. Live installed
lifecycle acceptance with current Codex Desktop and LM Studio was not recorded
before publication. The maintainer explicitly authorized the 2026-09-29 release
as an exception to the live acceptance gate in [the release checklist](RELEASING.md).

## Repair a chat before reinstalling

If Codex reports that `config.toml` cannot be loaded because “Model provider
`model_bridge` not found,” fully quit Codex Desktop with **Command-Q**, then run
the version-pinned recovery installer:

```bash
/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL https://github.com/patrickschiller/pickermux/releases/download/v0.8.2/install.sh | /bin/sh -s -- --repair-chats
```

The installer verifies the exact 0.8.2 payload, invokes `repair-chats`
without setup, and does not install or start the bridge. It works when the
installed CLI lacks the command or a stale account model cache blocks setup;
LM Studio is not required. From a trusted local 0.8.2 source checkout, you
can instead run the repair from that repository root:

```bash
node bin/pickermux.mjs repair-chats
```

Reopen the affected chat and select a **native Codex model** before sending
another message. The restored `model_bridge` table exists only for historical
chat parsing. It has no credentials, points to loopback port zero, and cannot
serve a request. To use local models again, first open Codex while signed in
until its native picker loads, fully quit it, and then run the regular
installer with LM Studio running:

```bash
/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL https://github.com/patrickschiller/pickermux/releases/download/v0.8.2/install.sh | /bin/sh
```

The repair is safe to repeat. It fails without changing `config.toml` when an
integration is still installed, managed markers remain, or a foreign, modified,
or otherwise ambiguous provider definition is present. Review that state
instead of removing a provider table manually. An installed 0.8.2 CLI also
offers `pickermux repair-chats [--json]`. The recovery installer does not
upgrade the installed CLI, so its `--version` output can remain older until
regular setup succeeds.

## Removal behavior

For the canonical `model_bridge` integration, `pickermux uninstall` and
`pickermux uninstall --remove-cli` now leave the same marker-bounded, inert
provider table that full purge already left.
The previous Codex configuration and user-owned settings are otherwise
restored under the existing ownership and compare-and-swap checks. A later
PickerMux installation removes only an exact, unchanged compatibility table
before installing its live provider definition. Modified or foreign provider
tables still fail closed.

The 0.8.1 recovery guidance for edited managed configuration remains in
effect: review and preserve intentional edits before
`pickermux uninstall --force`. Do not use `refresh --full` to bless edited
managed blocks or delete the Codex account cache. See
[troubleshooting](TROUBLESHOOTING.md#uninstall-refuses-modified-configuration).

## Security, compatibility, and validation

The chat repair does not read Codex authentication, provider credentials,
private prompts, or historical chat content. It does not reactivate the bridge
or grant external model access. The installer retains the release payload
checksum and archive-validation boundary. Native credential isolation, exact
provider routing, and the bridge contract remain unchanged.

Offline tests cover idempotent recovery, conflicting and installed states,
concurrent configuration changes, uninstall modes, and the installer recovery
dispatch. macOS CI and the full syntax and test suite passed (1,050 tests).
The release payload was built twice with `--tag v0.8.2`; all four assets were
byte-identical, `SHA256SUMS` and shell syntax passed, manifests matched,
and both extracted CLI entry points passed version/help smoke tests. The
extracted `repair-chats --json` command also ran twice in an isolated synthetic
home: the first run appended the table, the second was unchanged, the user's
config prefix and mode were preserved, and no runtime was created.

Those checks use isolated test state. Real macOS acceptance of the recovery
installer, normal install and upgrade, same-version rerun, and every uninstall
mode with current Codex Desktop and LM Studio was not recorded before release.
No live model inference or installed lifecycle success is claimed. Publication
proceeded under the maintainer's explicit exception noted above.

## Release assets

- [pickermux-v0.8.2.tar.gz](https://github.com/patrickschiller/pickermux/releases/download/v0.8.2/pickermux-v0.8.2.tar.gz): versioned runtime payload.
- [install.sh](https://github.com/patrickschiller/pickermux/releases/download/v0.8.2/install.sh): installer with the payload version and SHA-256 embedded.
- [release-manifest.json](https://github.com/patrickschiller/pickermux/releases/download/v0.8.2/release-manifest.json): runtime requirements, payload allowlist, and file digests.
- [SHA256SUMS](https://github.com/patrickschiller/pickermux/releases/download/v0.8.2/SHA256SUMS): checksums for the archive, installer, and manifest.

PickerMux requires macOS and Node.js 22.15.0 or newer. Regular setup also
requires a compatible signed-in Codex Desktop installation and LM Studio with
the intended model loaded.

PickerMux is an unofficial community project. It is not affiliated with,
endorsed by, or supported by OpenAI, Codex, or LM Studio.
