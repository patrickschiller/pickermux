# PickerMux 0.8.0

PickerMux 0.8.0 includes model tool certification in installation. A loaded
model appearing in the picker does not by itself mean that it can read project
files or run commands. Setup now checks that capability and explains its
progress before the user starts working in Codex.

## Automatic model certification

The release installer, `pickermux setup`, and `pickermux install` automatically
run live certification for discovered external models without a valid base
receipt. The checks cover text, streaming, functions, tool results, namespaced
calls, and long context. LM Studio models also receive the additive Efficient
Fidelity tool-search checks after passing the base matrix.

Valid Direct and Efficient Fidelity receipts are reused. Failure of only the
additive checks retains Direct tools. Ordinary `refresh` does not run live
certification; models discovered later still need `pickermux certify --model
SLUG` before they can use tools.

Tool execution remains in Codex and follows its sandbox and approval controls.
Certification does not itself grant filesystem permissions. Open the intended
folder as a local project and start a new chat there after restarting Codex.

## Progress and recovery

Live requests can take several minutes per model, or longer on slow hardware.
Keep the intended models loaded and Codex fully closed until installation
finishes. Progress shows the model number, current check, and elapsed time.
Waiting updates appear every ten seconds, including during a piped one-line
installation. Manual certification uses the same check progress. Progress goes
to stderr; `--json` stdout remains machine-readable.

If certification fails, the activated CLI and bridge remain installed. The
command reports incomplete certification and exits with status 1. Models
without a valid base receipt remain text-only or blocked pending recovery;
later models may not have been tested. With the models loaded, run:

```bash
~/.local/bin/pickermux doctor
~/.local/bin/pickermux certify --all
```

The explicit retry reports the failed probe and redacted diagnostic. Fully
quit and reopen Codex after it succeeds. Do not edit certification receipts or
force-enable catalog capabilities.

## Upgrade

Save active work and fully quit Codex Desktop with **Command-Q**. Keep the
intended models loaded and the LM Studio server running, then run from Terminal:

```bash
/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL https://github.com/patrickschiller/pickermux/releases/download/v0.8.0/install.sh | /bin/sh
```

The installer verifies its exact payload checksum and retains the installed
provider configuration on upgrade. Still-valid model certification is reused.
The Codex executable discovery fix from 0.7.6, shared web search, and context
compaction remain available.

Before reopening Codex, check:

```bash
~/.local/bin/pickermux --version
~/.local/bin/pickermux status
~/.local/bin/pickermux doctor
```

Require `pickermux 0.8.0`, a running bridge, and passing compatibility checks.
For tool access, `tool-certifications` should report Direct or Efficient
Fidelity models. An executed file-listing or README-reading tool call in the
local project confirms actual workspace access.

## Security, compatibility, and validation

The bridge contract remains `codex-responses-bridge/p6-v1`. Native credential
isolation, exact routing, model-bound evidence, and all existing certification
gates remain intact. Installation commits before live certification begins,
while retaining the lifecycle lock. Certification failures use the existing
pending barrier and conservative recovery instead of rolling back only the
CLI pointer after a new runtime has activated. Progress contains fixed check
names and numeric counts, not model identifiers, prompts, or credentials.

Offline regression coverage includes first installation and upgrade, valid
receipt reuse, stale and pending models, additive fallback, failed checks,
interruption, progress timing, JSON output, and release packaging. The complete
suite contains 1,029 tests. Release verification also checks reproducible builds,
asset checksums, shell syntax, and version/help commands in the extracted archive.

No new live installation, upgrade, uninstall, purge, or model-inference run was
performed for this candidate. Automated coverage does not establish current
Codex Desktop, LM Studio, or LaunchServices behavior; live installation-time
certification remains unverified for this release.

## Release assets

- [pickermux-v0.8.0.tar.gz](https://github.com/patrickschiller/pickermux/releases/download/v0.8.0/pickermux-v0.8.0.tar.gz): versioned runtime payload.
- [install.sh](https://github.com/patrickschiller/pickermux/releases/download/v0.8.0/install.sh): installer with the payload version and SHA-256 embedded.
- [release-manifest.json](https://github.com/patrickschiller/pickermux/releases/download/v0.8.0/release-manifest.json): runtime requirements, payload allowlist, and file digests.
- [SHA256SUMS](https://github.com/patrickschiller/pickermux/releases/download/v0.8.0/SHA256SUMS): checksums for the archive, installer, and manifest.

PickerMux requires macOS, Node.js 22.15.0 or newer, a compatible signed-in Codex
Desktop installation, and LM Studio with the intended model loaded.

PickerMux is an unofficial community project. It is not affiliated with,
endorsed by, or supported by OpenAI, Codex, or LM Studio.
