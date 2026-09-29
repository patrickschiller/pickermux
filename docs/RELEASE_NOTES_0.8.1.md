# PickerMux 0.8.1

PickerMux 0.8.1 clarifies recovery when a Codex Desktop update and an edited
PickerMux-managed configuration block prevent setup. PickerMux still refuses to
overwrite edited managed bytes automatically. The installed bridge must match
the current Codex client before external models can be used again.

## What changed

- `pickermux doctor` names only known receipt-owned areas of a modified managed
  configuration, such as `provider` or `provider-scope-tail`. It does not print
  the block contents or unknown values.
- Setup explains the review, forced-uninstall, native account-cache refresh,
  and reinstall sequence when it finds modified managed configuration. Other
  inconsistent states point to the state-specific troubleshooting guidance.

This release changes recovery guidance and diagnostics. It does not bypass the
compatibility check or make `refresh --full` safe for edited managed blocks.

## Recover after a Codex Desktop upgrade

Use this sequence when doctor reports both `update-required` compatibility and
`managed-config: modified`:

1. Fully quit Codex Desktop with **Command-Q**.
2. Run the installed `~/.local/bin/pickermux doctor`. Version 0.8.0 may report
   only `managed-config: modified`; that is enough to follow this recovery.
   Version 0.8.1 names known affected managed areas without showing contents.
3. Review `~/.codex/config.toml`. Keep a private copy of intentional changes,
   including edits inside PickerMux's marked blocks, before forced uninstall
   removes them. Reapply desired settings through supported configuration after
   reinstalling; do not paste old managed blocks back wholesale.
4. If PickerMux's recorded configuration should be removed, run the installed
   `~/.local/bin/pickermux uninstall --force`. Do not use `--purge`, edit the
   private receipt, or delete the Codex account cache.
5. Open Codex while signed in, wait for its native model picker to load, and
   fully quit it again. This lets Codex refresh its own account model cache.
6. Run the 0.8.1 installer, reusing the same custom PickerMux configuration if
   one was used, then run `~/.local/bin/pickermux doctor` again.

See [modified-configuration recovery](TROUBLESHOOTING.md#uninstall-refuses-modified-configuration)
for the full procedure. A `METHOD_NOT_ALLOWED` response from opening a private
Responses URL in a browser is expected for a `GET` request; it is not a bridge
health check. If a diagnostic containing an unredacted `/c/...` capability URL
was shared, complete the uninstall/reinstall sequence to rotate that capability
and remove the shared diagnostic wherever possible.

## Upgrade and verify

For a healthy installation, save active work, fully quit Codex Desktop, and run:

```bash
/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL https://github.com/patrickschiller/pickermux/releases/download/v0.8.1/install.sh | /bin/sh
```

The installer verifies its exact payload checksum and preserves the existing
provider configuration during a healthy upgrade. After setup finishes, check:

```bash
~/.local/bin/pickermux --version
~/.local/bin/pickermux status
~/.local/bin/pickermux doctor
```

The version must be `pickermux 0.8.1`. Compatibility, managed configuration,
bridge service, and model certification should pass before reopening Codex.
Existing valid model certifications remain in use; ordinary refresh does not
run live certification for newly discovered models.

## Security, compatibility, and validation

The modified-configuration check remains fail-closed. Doctor's added detail is
restricted to an allowlist of managed block names; it does not show block
contents, credentials, account data, or capability URLs. Native credential
isolation, exact provider routing, and the bridge contract remain unchanged.

Offline regression coverage checks both the recovery message and that doctor
omits an unknown block name. The macOS CI and tagged-release workflow run the
complete syntax and test suite. This release does not claim a live installation,
upgrade, or model-inference acceptance run on the current Codex Desktop build.

## Release assets

- [pickermux-v0.8.1.tar.gz](https://github.com/patrickschiller/pickermux/releases/download/v0.8.1/pickermux-v0.8.1.tar.gz): versioned runtime payload.
- [install.sh](https://github.com/patrickschiller/pickermux/releases/download/v0.8.1/install.sh): installer with the payload version and SHA-256 embedded.
- [release-manifest.json](https://github.com/patrickschiller/pickermux/releases/download/v0.8.1/release-manifest.json): runtime requirements, payload allowlist, and file digests.
- [SHA256SUMS](https://github.com/patrickschiller/pickermux/releases/download/v0.8.1/SHA256SUMS): checksums for the archive, installer, and manifest.

PickerMux requires macOS, Node.js 22.15.0 or newer, a compatible signed-in Codex
Desktop installation, and LM Studio with the intended model loaded.

PickerMux is an unofficial community project. It is not affiliated with,
endorsed by, or supported by OpenAI, Codex, or LM Studio.
