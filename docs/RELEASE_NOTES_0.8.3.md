# PickerMux 0.8.3

PickerMux 0.8.3 improves recovery after a Codex Desktop update leaves the
account model cache on the previous client version. It also clarifies why a
historical PickerMux chat may show a connection failure after uninstall.

## What changed

- Catalog construction checks the exact-version Codex account cache before
  external-provider discovery or credential resolution. An unavailable
  external provider can no longer hide the cache recovery requirement. A
  failed managed build leaves the existing catalog and account cache unchanged.
- The cache error points to `pickermux refresh --full` and explains that edited
  managed configuration must be reviewed first. `--FULL` is now an alias for
  `--full`, with the same confirmation and option restrictions.
- A refused uninstall explains that removal did not happen and names the
  reviewed `--force` recovery. Successful uninstall explicitly asks for a full
  Codex restart and native-model selection in existing PickerMux chats.

## Recover after a Codex Desktop update

An account cache from `0.159.0` cannot authorize a catalog for client
`0.159.2`. Patch versions still require an exact match. If PickerMux remains
installed with intact managed configuration and its receipt-owned runtime,
run the installed CLI in an interactive terminal:

```bash
pickermux refresh --full
```

Confirm with `FULL` after saving active Codex work. The helper gracefully
quits Codex, temporarily suspends PickerMux, opens Codex natively to renew its
own account cache, quits it again, and reactivates PickerMux through the usual
validation gates. A bridge quarantined as `update-required` can enter this
recovery when its ownership checks pass. No stale cache grants model access.

If the managed configuration was edited, run `pickermux doctor`, preserve
intentional edits privately, and follow
[modified-configuration recovery](TROUBLESHOOTING.md#uninstall-refuses-modified-configuration).
`--force` is limited to the reviewed configuration conflict; it does not renew
the cache or bypass runtime and distribution ownership checks.

If PickerMux was already uninstalled, open Codex natively while signed in,
wait for its native picker to load, fully quit it with **Command-Q**, and then
run the installer below. Do not delete `models_cache.json`, the private
PickerMux receipts, or Codex authentication as a workaround.

## Connection failures in historical chats after uninstall

Fully quit and reopen Codex, then select a native model in the affected chat
before sending another turn. The retained `model_bridge` compatibility table
lets historical chats open, but its credential-free loopback-port-zero
definition cannot serve requests. A chat that still selects it can show
“Connection failed: error sending request.” Restart alone does not change the
chat's provider. This release clarifies recovery; it does not silently rewrite
historical chat state or claim that every connection failure has this cause.

## Upgrade and verify

With the account cache ready, LM Studio running, and Codex fully quit, use:

```bash
/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL https://github.com/patrickschiller/pickermux/releases/download/v0.8.3/install.sh | /bin/sh
```

Reuse `--config PATH` when upgrading an installation with a custom PickerMux
configuration. After setup completes, check:

```bash
~/.local/bin/pickermux --version
~/.local/bin/pickermux status
~/.local/bin/pickermux doctor
```

The version must be `pickermux 0.8.3`. Fully reopen Codex after the checks pass.
Setup retains still-valid model certifications and tests models whose base
certification is missing, stale, or pending recovery.

## Security, compatibility, and validation

Exact client-version checks, credential isolation, namespaced routing,
conservative certification, configuration ownership, and transactional
reactivation remain enforced. The bridge contract stays
`codex-responses-bridge/p6-v1`. The installed full-refresh state machine,
uninstall ownership checks, and historical compatibility table are unchanged.

The local syntax and deterministic test suite passes with 1,064 tests on macOS
27.0.1 arm64 and Node.js 26.10.0. Regression coverage includes missing and
malformed caches, `0.159.0` to `0.159.2` recovery, refusing an older cache,
preserving the published catalog before external access, alias cancellation
and restrictions, uninstall conflict non-disclosure, and removal with a stale
account cache. CI repeats validation on Node.js 22.15.0, 24.x, and 26.x.

Release validation builds the tagged payload twice, compares all four assets,
checks archive and installer digests, checks shell syntax and manifest
consistency, and smoke-tests both extracted CLI entry points. These checks do
not run setup or alter a user's installed integration.

**Validation limitation:** a live full-refresh, uninstall, install/upgrade, or
model-inference acceptance run with current Codex Desktop and LM Studio was
not performed for 0.8.3. The reported connection failure was not reproduced
live. Publication was requested with this offline-validation limitation
disclosed; no installed lifecycle success is claimed. See
[the release checklist](RELEASING.md) for the live acceptance matrix.

## Release assets

- [pickermux-v0.8.3.tar.gz](https://github.com/patrickschiller/pickermux/releases/download/v0.8.3/pickermux-v0.8.3.tar.gz): versioned runtime payload.
- [install.sh](https://github.com/patrickschiller/pickermux/releases/download/v0.8.3/install.sh): installer with the exact archive digest embedded.
- [release-manifest.json](https://github.com/patrickschiller/pickermux/releases/download/v0.8.3/release-manifest.json): runtime requirements, payload allowlist, and file digests.
- [SHA256SUMS](https://github.com/patrickschiller/pickermux/releases/download/v0.8.3/SHA256SUMS): archive, installer, and manifest checksums.

PickerMux requires macOS and Node.js 22.15.0 or newer. Regular setup also
requires a compatible signed-in Codex Desktop installation and LM Studio with
the intended model loaded.

PickerMux is an unofficial community project. It is not affiliated with,
endorsed by, or supported by OpenAI, Codex, or LM Studio.
