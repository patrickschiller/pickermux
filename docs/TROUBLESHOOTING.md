# Troubleshooting

Start with deterministic diagnostics:

```bash
pickermux status
pickermux doctor
```

Use `doctor --live` only when the static checks pass and a real model inference
is needed.

## A loaded LM Studio model is missing

1. Confirm that the LM Studio local server is running.
2. Confirm that the model is loaded as an LLM, not only downloaded.
3. Check that every loaded instance reports an active context length.
4. Run `pickermux discover`.
5. Fully quit Codex Desktop with `Command-Q`.
6. Wait a few seconds for synchronization, then run
   `pickermux refresh` if needed.
7. Reopen Codex Desktop.

PickerMux excludes embeddings, unloaded models, malformed IDs, and loaded
instances without a confirmed context size. It does not use a model's
theoretical maximum as if that were the active context.

## The catalog changed, but the picker did not

Codex loads `model_catalog_json` at process startup. Closing a project window is
not sufficient. Fully quit every Codex Desktop window and reopen the app.

If Codex was already closed, the normal background discovery interval can add a
short delay. Running `refresh` provides an explicit synchronized update.

## A native Codex model is missing

PickerMux cannot grant native model access. It preserves account-visible native
models from Codex's authenticated account snapshot. Confirm that the same
account can see the model without PickerMux, that the installed Codex client has
refreshed its account model cache, and that `status` does not report a client
compatibility problem. Do not add a native model slug to an external provider
configuration.

## `update-required`

The installed runtime no longer matches the verified Codex client and bundled
catalog contract. Rerun the latest-release installer, then run:

```bash
pickermux doctor
```

If the account cache is missing or belongs to another client version:

```bash
pickermux uninstall
```

Then open Codex Desktop once while signed in, fully quit it, and install
PickerMux again. This refreshes account visibility through Codex before the new
mixed catalog is created.

## LM Studio was stopped and local models disappeared

This is expected in `loaded` mode. A refused connection means the local server
is deliberately unavailable, so PickerMux publishes a native-only catalog. If
the selected model was local, the managed selection returns to the configured
native fallback.

Start LM Studio, load the desired models, run `refresh`, and fully restart Codex
Desktop.

Other failures such as timeouts, malformed responses, and temporary network
errors retain the last known good catalog instead of treating the provider as
cleanly offline.

## A model is text-only

That is the default for every newly discovered external model. Run a live
certification only when LM Studio and the target model are ready:

```bash
pickermux certify --model lmstudio/OWNER/MODEL
```

Certification removes any previous pass before probing. If a gate fails or the
run is interrupted, the model remains text-only. Context, provider, capability,
reasoning, or Codex client changes also make an old pass stale.

## Live checks are slow

`doctor --live` and `certify` perform real inference. Large prompts, long
context, model loading, quantization, and local hardware dominate latency; the
loopback bridge is normally not the expensive part.

Do not run certification in parallel with an active local-model task. Watch LM
Studio's model status and resource usage if a request appears idle.

## Uninstall refuses modified configuration

PickerMux uses ownership markers and compare-and-swap checks to avoid
overwriting manual changes. Inspect `~/.codex/config.toml` and the managed state
before deciding what should win.

Use `uninstall --force` only when you have reviewed the conflict and explicitly
want PickerMux to remove its owned block. The command still targets managed
artifacts; it does not delete provider Keychain items or backup directories.

## The release installer stops before setup

The installer fails before mutation when macOS, the CPU architecture, Node.js,
the archive digest, or the archive layout is unsupported. It also refuses root
execution and will not replace an existing unrecognized
`~/.local/bin/pickermux` entry.

Read the first reported preflight failure and correct that condition. Do not
work around it with `sudo`, a disabled checksum, a hand-extracted archive, or
`uninstall --force`. A digest failure can indicate a damaged or incorrectly
published release asset and should be reported without executing that asset.

If setup says Codex Desktop is running, use `Command-Q` and retry only after the
application has fully exited. If model discovery is empty, start the LM Studio
server and load at least one LLM.

## `pickermux` is not found after installation

The managed launcher is `~/.local/bin/pickermux`. PickerMux does not edit shell
startup files. Run it by absolute path, or add the directory to your own shell
configuration and start a new terminal:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Do not create another system-wide launcher with `sudo`; that file would be
outside the receipt-owned installation and would not be removed safely.

## Upgrade or downgrade is refused

Rerunning the latest-release installer upgrades only a healthy managed
installation. Modified, orphaned, or partially installed state fails closed;
run `pickermux status` and `pickermux doctor` before deciding how to recover.

An implicit downgrade is deliberately refused. If an older version is needed
for diagnosis, do not overwrite the active installation. Capture diagnostics
and open an issue describing the compatibility problem instead.

## Complete CLI removal is refused

`pickermux uninstall --remove-cli` removes distribution files only when their
paths and launcher match the private installation receipt. If that ownership
check fails, integration uninstall can still restore Codex safely, but the
unrecognized CLI files are left untouched for manual review. Backups and
Keychain items remain in either case.

If removal reports a private quarantine-cleanup warning, the integration and
active CLI have still been removed consistently, and a new installation is not
blocked. Inspect only the exact quarantine path printed by PickerMux before
removing that residual directory; never delete its parent directory broadly.

## Safe diagnostic sharing

Before posting output, remove:

- bearer tokens, cookies, and API keys;
- account, organization, and workspace identifiers;
- the random `/c/...` capability path;
- private prompts and model responses;
- local usernames and unrelated absolute paths;
- private hostnames, IP addresses, and model names when they reveal internal
  infrastructure.

Use `credential-status`, not direct Keychain inspection, when showing whether a
provider credential is configured. Suspected vulnerabilities belong in a
private report under [SECURITY.md](../SECURITY.md).
