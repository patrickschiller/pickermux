# PickerMux 0.7.6

PickerMux 0.7.6 fixes `Failed to read the Codex client version` during
installation after the Codex app moved its bundled CLI. The web search and
context compaction features from 0.7.5 remain available.

## Codex executable discovery

PickerMux now detects the current executable at
`/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`.
It retains the older `Contents/Resources/codex` location and the `codex` command
on `PATH` as fallbacks. A nonempty `CODEX_BINARY` override remains authoritative;
failure to run that override does not silently choose another client.

Catalog reads and version checks use the same resolver. Compatibility
monitoring tracks the actual executable, so an app update is detectable even
when the `codex-cli/bin/codex` shell wrapper stays unchanged. Failure messages
now point to the installed app and any explicit binary override.

`CODEX_BINARY` applies only to the invoking command and is not saved to the
installed LaunchAgent. The corrected automatic discovery works in both the
installer and service without requiring a shell-only override.

## Upgrade

Save active work and fully quit Codex Desktop with **Command-Q**. Keep the
intended model loaded and the LM Studio server running, then run the versioned
installer from Terminal:

```bash
/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL https://github.com/patrickschiller/pickermux/releases/download/v0.7.6/install.sh | /bin/sh
```

Use this installer also when a 0.7.5 installation attempt failed with the
version-read error. Setup verifies the payload checksum and uses the existing
transactional installation or upgrade flow. Healthy existing installations
retain their provider configuration and still-valid certification. This fix
does not require `refresh --full`, uninstalling, or editing installed files.

Check the installation before reopening Codex:

```bash
~/.local/bin/pickermux --version
~/.local/bin/pickermux status
~/.local/bin/pickermux doctor
~/.local/bin/pickermux discover
```

Require `pickermux 0.7.6`, a running bridge, and passing compatibility checks.
If a separate account-cache or compatibility error remains, follow the
[troubleshooting guide](https://github.com/patrickschiller/pickermux/blob/v0.7.6/docs/TROUBLESHOOTING.md).

## Compatibility, security, and validation

The bridge contract remains `codex-responses-bridge/p6-v1`. Exact client and
catalog validation, conservative model capabilities, credential isolation,
byte-preserving native routes, and transactional rollback remain in place.
This change does not bypass a schema mismatch or grant new model capabilities.

Offline regression coverage exercises both bundle layouts, override precedence,
missing paths, version and catalog reads, and redacted failures. All 1,009 tests
and syntax checks passed locally. Two release builds produced identical assets;
checksums, installer shell syntax, and both extracted CLI entry points passed.
Read-only
checks on the current local app confirmed that the new executable returns its
version and bundled catalog. No installed lifecycle operation or live model
inference was performed for this release; the earlier 0.7.5 acceptance results
remain historical evidence, not a new 0.7.6 live validation claim.

## Release assets

- [pickermux-v0.7.6.tar.gz](https://github.com/patrickschiller/pickermux/releases/download/v0.7.6/pickermux-v0.7.6.tar.gz): versioned runtime payload.
- [install.sh](https://github.com/patrickschiller/pickermux/releases/download/v0.7.6/install.sh): installer with the payload version and SHA-256 embedded.
- [release-manifest.json](https://github.com/patrickschiller/pickermux/releases/download/v0.7.6/release-manifest.json): runtime requirements, payload allowlist, and file digests.
- [SHA256SUMS](https://github.com/patrickschiller/pickermux/releases/download/v0.7.6/SHA256SUMS): checksums for the archive, installer, and manifest.

PickerMux requires macOS, Node.js 22.15.0 or newer, a compatible signed-in Codex
Desktop installation, and LM Studio with the intended model loaded.

PickerMux is an unofficial community project. It is not affiliated with,
endorsed by, or supported by OpenAI, Codex, or LM Studio.
