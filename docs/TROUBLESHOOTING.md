# Troubleshooting

Start with deterministic diagnostics:

```bash
./bin/pickermux.mjs status
./bin/pickermux.mjs doctor
```

Use `doctor --live` only when the static checks pass and a real model inference
is needed.

## A loaded LM Studio model is missing

1. Confirm that the LM Studio local server is running.
2. Confirm that the model is loaded as an LLM, not only downloaded.
3. Check that every loaded instance reports an active context length.
4. Run `./bin/pickermux.mjs discover`.
5. Fully quit Codex Desktop with `Command-Q`.
6. Wait a few seconds for synchronization, then run
   `./bin/pickermux.mjs refresh` if needed.
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
catalog contract. Update the PickerMux checkout, then run:

```bash
./bin/pickermux.mjs refresh
./bin/pickermux.mjs doctor
```

If the account cache is missing or belongs to another client version:

```bash
./bin/pickermux.mjs uninstall
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
./bin/pickermux.mjs certify --model lmstudio/OWNER/MODEL
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
