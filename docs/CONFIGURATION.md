# Configuration

PickerMux reads `lmstudio-picker.config.json` from the project root by default.
Pass `--config PATH` to use another file for commands that load project
configuration. The managed release launcher points ordinary operational
commands at the installed service configuration, so it continues using the
configuration that was activated rather than silently replacing it during an
upgrade.

The schema is intentionally narrow. Unknown keys, inline secrets, ambiguous
credential sources, wildcard model entries, and configurable native Codex
destinations are rejected.

## Supported provider kinds

PickerMux connects Codex Desktop to local or remote external models through
the Responses API. LM Studio is the default provider, and the core also
supports explicitly configured compatible Responses providers.
An experimental dedicated adapter also supports the managed HF MLX
server described below.

| Kind | Discovery | Required model information |
| --- | --- | --- |
| `lmstudio-responses` | Automatic loaded-model metadata or an explicit allowlist. | Loaded LM Studio instances supply metadata; configured entries may provide overrides. |
| `openai-responses` | Explicit allowlist verified against `<baseUrl>/models`. | Each model must specify `type: "llm"` and a positive `contextWindow`. |
| `mlx-chat-completions` | One explicit managed alias verified against `/models`. | `type: "llm"`, matching enforced `contextWindow`, reasoning `none`, and managed `mlxProfileDigest` (legacy Kolibri alias excepted). |

A generic provider's model list must have the OpenAI-compatible
`{"data": [{"id": "example-model"}]}` shape, and inference must implement
`<baseUrl>/responses`. Chat Completions compatibility alone does not satisfy
this contract. The explicit Kolibri kind is a separate, bounded
exception and does not accept arbitrary Chat Completions providers. Provider
credentials remain scoped to the configured provider;
native Codex credentials are never reused for an external endpoint. Tool
access requires the model-bound live certification matrix to pass.
Reviewed Kolibri tool protocols require the same complete model-bound certification as other tool-capable providers.

Automatic loaded-model discovery and PickerMux's local context-compaction
adapter are specific to LM Studio. Reviewed MLX tools can also certify
Efficient Fidelity. Other providers use
their explicit configuration and supported Responses behavior. Configure
private-network access explicitly when the endpoint is local or on a trusted
private network; the bridge itself always remains loopback-only.

The companion's first installation uses the bundled LM Studio default.
Activate a custom provider configuration through the CLI first; later
companion actions reuse that installed configuration.

For a first release installation with a custom configuration, pass the path to
the shell that executes the installer:

```bash
/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL https://github.com/patrickschiller/pickermux/releases/latest/download/install.sh | PICKERMUX_CONFIG_PATH=/absolute/path/to/pickermux.config.json /bin/sh
```

The assignment belongs on the `/bin/sh` side of the pipeline. `setup` validates
the custom file and requires its external provider to expose at least one LLM
before creating the managed distribution. The activated contents are copied to
PickerMux's private service configuration; later upgrades reuse that copy and
do not replace it with a new release default.

`setup` and `install` automatically run live tool certification for discovered
external models with missing, stale, or pending base receipts. This uses the
activated provider configuration, including any explicitly configured remote
provider. Valid Direct or Efficient Fidelity receipts are reused. Keep Codex
closed and configured models available; allow several minutes per model.
Progress and waiting updates go to stderr, including when `--json` is selected; stdout then contains
one JSON result with a `certification.status` of `complete` or `incomplete`.
An incomplete certification exits with status 1 while retaining the activated
installation and the existing certification recovery boundary. Ordinary
`refresh` does not submit certification prompts.

Legacy MLX servers and generic HF profiles without a reviewed tool protocol
remain text-only and are excluded from tool certification.

## Kolibri MLX provider

The MLX provider needs an Apple silicon Mac and an isolated Python environment
with `mlx==0.32.3`, `mlx-lm==0.32.0`, `transformers==5.7.0` and
`huggingface-hub==1.5.0`. These are the currently reviewed pins, not arbitrary
installed versions. The Kolibri conversion has about 41 GiB of weights and
requires ample unified memory; see its [model card](https://huggingface.co/velaia/Kolibri-1-MLX-4bit).

From a source checkout, install the optional Python environment and load the model:

```bash
python3.12 -m venv .artifacts/mlx-venv
.artifacts/mlx-venv/bin/python -m pip install -r scripts/kolibri-requirements.txt
node bin/pickermux.mjs mlx-load velaia/Kolibri-1-MLX-4bit \
  --alias kolibri-1-mlx-4bit --python "$PWD/.artifacts/mlx-venv/bin/python" \
  --revision 3f5adf3fc8149f57738cc5a99f02ae26b601e7b0 --port 8081
```

The command prints a conservative provider stanza with `mlxProfileDigest`.
Add it to your reviewed custom configuration, retaining needed providers and
bridge settings. Use a provider-specific namespace; the printed example uses
`mlx/kolibri-1-mlx-4bit`. With Codex fully closed, activate that configuration:

```bash
node bin/pickermux.mjs setup --config /private/path/pickermux.config.json
```

Setup automatically certifies eligible models without a current receipt. Later,
`pickermux certify --model mlx/kolibri-1-mlx-4bit` repeats the complete matrix.
Only passing Direct gates enable function, file and shell tools. Passing the
additional tool-search roundtrip enables Efficient Fidelity. Web research uses
Codex's configured native search service and requires its normal account access;
search credentials never reach the local model. Generic HF models remain text-only
until their architecture/tool protocol has been reviewed and measured.

`mlx-prepare` downloads/verifies without starting inference. `mlx-start --model
NAME --port 8081`, `mlx-status --json`, and `mlx-stop --model NAME` manage prepared
profiles. `--context-window` (1024–8192) and `--max-output-tokens` (1–2048) bind
profile identity; the tokenizer enforces the combined prompt/output reservation.
An omitted HF revision resolves `main` to a fixed commit before downloading.
Existing aliases cannot be reassigned to different weights/settings. New public
HF models must use built-in MLX architectures; downloaded executable Python and
remote-code loading are rejected. Commands never use an implicit HF login token.
Repeating preparation with `main` reuses and verifies the already pinned profile;
use a new alias to load a newer revision or different settings.

If the reviewed Kolibri snapshot already exists, add `--model-dir
/private/path/verified-model` to import it in place after checking all hashes,
ownership and private permissions. The manager never scans the HF cache or copies
those weights. Failed downloads resume their fixed staging plan and preserve
working profiles. The detached inference process survives shell exit, but is not
a login service; start it again after reboot. Stop verifies the exact owned
instance and refuses to interrupt an active generation.

The legacy `scripts/serve-kolibri.py` source launcher remains available with
[kolibri-picker.config.json](../kolibri-picker.config.json), using port 8080 and
`kolibri/kolibri-1-mlx-4bit`. Its updated reviewed server can also certify tools;
older text-only copies must be replaced through source/managed workflows.
Do not patch the installed bridge runtime directly.

MLX supports text and certified functions with reasoning `none`. Native summary
display preferences are ignored. Images, audio, stored continuation IDs and
context compaction remain unsupported. Oversized history is rejected intact.
The companion shows latest input/output/total and saved accumulated tokens.
`token-performance-v1` adds the measured output generation tokens/s after a
finalized MLX request, excluding prompt prefill and network time. Timing resets
with the bridge and is never written into the usage ledger; missing measurements
are shown as unavailable.

## Codex executable discovery

PickerMux 0.7.6 checks these locations in order:

1. A nonempty `CODEX_BINARY` environment override for the current command.
2. `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`.
3. The older `/Applications/ChatGPT.app/Contents/Resources/codex` location.
4. `codex` on `PATH` when neither bundled location exists.

An explicit override remains authoritative; a failed override does not silently
select another client. The override is not saved to the installed LaunchAgent,
so setting it only for installation is not a persistent service configuration.
See [troubleshooting](TROUBLESHOOTING.md#failed-to-read-the-codex-client-version)
for the affected 0.7.5 release and a version check.

## Default LM Studio configuration

The repository ships with a dynamic local configuration:

```json
{
  "schemaVersion": 2,
  "bridge": {
    "host": "127.0.0.1",
    "port": 4210,
    "providerId": "model_bridge",
    "defaultModel": "gpt-5.6-sol",
    "reasoningEffort": "ultra"
  },
  "providers": [
    {
      "id": "lmstudio",
      "kind": "lmstudio-responses",
      "baseUrl": "http://127.0.0.1:1234/v1",
      "allowPrivateNetwork": true,
      "discovery": {
        "mode": "loaded",
        "maxModels": 32
      },
      "models": [
        {
          "id": "qwen/qwen3.8-27b",
          "slug": "lmstudio/qwen/qwen3.8-27b",
          "displayName": "Qwen3.8 27B – LM Studio",
          "reasoningEffort": "xhigh",
          "reasoningEfforts": ["none", "low", "medium", "xhigh"]
        }
      ]
    }
  ]
}
```

The explicit Qwen entry acts as a display-name and reasoning override. In
`loaded` mode, other loaded LLMs are still discovered automatically.

## Bridge fields

| Field | Purpose |
| --- | --- |
| `host` | Must be `127.0.0.1`. The bridge cannot bind to a LAN address. |
| `port` | Local bridge port. The default is `4210`. |
| `providerId` | Generated Codex provider ID. The default is `model_bridge`; it uses the same bounded ID grammar as provider namespaces. |
| `defaultModel` | Native fallback selected when a local choice disappears; also the default native search request model for external-model searches. |
| `webSearchModel` | Optional native model ID for standalone search requests made while an external model is selected. Defaults to `defaultModel`; does not change the answer model. |
| `reasoningEffort` | Reasoning level for the native fallback. |
| `limits` | Optional bounded request, header, idle, and total-duration limits. |

The configured fallback must exist in the account-visible native catalog and
support the selected reasoning level at install time.

`webSearchModel` must be a native ID without a provider namespace. The search
route also verifies that the configured ID resolves to a native model in the
active registry; an absent or external selection fails with
`SEARCH_MODEL_UNAVAILABLE` before making a search request.

## Shared web search

Version 0.7.5 uses one native
search path for Codex's `web.run` function. The selected external model must already have a
valid tool certification; text-only models do not receive a search exception.
An Efficient Fidelity route must retain its additive receipt as well as its
Direct receipt. Web search is independent of the tool-inventory search that
Efficient Fidelity optimizes.

For external-model searches, PickerMux replaces only the search request's
`model` with `bridge.webSearchModel`, falling back to `bridge.defaultModel`.
For example, an existing bridge configuration can include:

```json
{
  "defaultModel": "gpt-5.6-sol",
  "webSearchModel": "gpt-5.6-sol"
}
```

These are fields inside the existing `bridge` object, not a complete
configuration. The setting selects the native search service parameter only;
it leaves the external `/responses` route and answer model unchanged. It does
not identify the backend's internal search models or promise particular
pricing, token usage, or latency. A native-model search keeps its original
model and request bytes.

Codex sends searches using its normal native authentication. PickerMux does
not read `~/.codex/auth.json`, resolve an external provider credential, or send
native headers to LM Studio for this operation. Search commands, conversation
context selected by Codex, settings, domain filters, and explicit output
budgets are preserved. Search does not require an additional LM Studio
generation; Codex sends the returned text to the selected model for its answer.
PickerMux adds no result cache, summary, or truncation pass.

Install and ordinary refresh set the receipt-owned provider capability
`supports_standalone_web_search = true`. They add
`features.standalone_web_search = true` only when that feature has no explicit
setting. An existing user-owned `true` or `false` remains unchanged; they do not
change Codex's `web_search` mode or managed restrictions. To disable web search
through Codex, use its user-level `web_search = "disabled"` setting. Keep each
TOML key unique and leave PickerMux's marked blocks under lifecycle ownership.
If a user-owned inline `features` table exists without this feature, add an
explicit boolean there before refreshing, as directed by
`WEB_SEARCH_CONFIG_CONFLICT`.

After upgrading to a build containing this support, fully quit Codex, run
normal `pickermux refresh`, and reopen Codex. If the selected model remains
text-only, follow the regular certification procedure when it is loaded and
no local-model task is active, then fully restart Codex. No model-wide setting
or manual catalog edit replaces that certification.

Refresh migrates only verified owned provider/feature state, checks the
running bridge's `webSearchContractVersion = 1`, and restores the previous
state if activation fails. Existing user feature settings are not adopted as
owned content; uninstall removes only a feature block added by PickerMux.

This is an experimental Codex endpoint. Native search/open smoke checks have
succeeded, and the public client contract is covered by offline fixtures.
Full certification, external-model search, and a correct sourced answer have
passed for the tested LM Link setup. See
the [acceptance record and procedure](WEB_SEARCH_ACCEPTANCE.md).
The relevant
capability remains subject to Codex runtime, account, and managed-policy
support. See the [official standalone-search documentation](https://learn.chatgpt.com/docs/web-search?surface=app#app-search-with-a-custom-model-provider).

## LM Studio context compaction

The 0.7.5 adapter handles Codex's full-replay `compaction_trigger`
request on `/v1/responses`. No configuration switch is needed. It sends one
bounded summary request to the selected LM Studio model when Codex requests
compaction, with no tool definitions or execution authority. The raw top-level
`instructions` is validated and omitted from that summary only: Codex retains
these base instructions separately and sends them again for ordinary answers.
Historical system/developer/user messages are retained, even when they contain
the same text. There is no role-wide filtering or change to ordinary requests.
Supported text
history, public tool identities, results, and source URLs remain available to
the summarizer. A measured `none` reasoning mode is used for this operation when
available; other turns keep their selected reasoning settings.

The completed summary is encrypted in the normal Codex history. Its key is
derived with a separate purpose from the private installation capability, and
the envelope is authenticated against the exact provider, model, loaded context,
and catalog model hash. Replay restores assistant context, not new developer
instructions or tool authority. Normal requests do not trigger another summary.
If the restored compaction item ends an ordinary request, one short fixed
user-role continuation instruction closes the assistant message. LM Studio
would otherwise treat it as response prefill and continue the summary text.
The dynamic summary stays at assistant authority. Later conversation input and
another compaction do not receive this extra instruction.
The summary prompt separates completed actions and evidence from remaining
work, and the continuation prompt asks the model to reuse recorded results.
Missing, stale, or conflicting evidence and instructions requiring a fresh
check still permit another lookup. This is model guidance, not a tool blocker
or a guarantee against repeated searches.

Service restarts, ordinary refresh, and version upgrades retain the key.
`refresh --full` and uninstall/reinstall create a new installation capability,
making previous compacted state unavailable. Changing the bound model
configuration has the same effect. Restore the original state or start a new
task; do not edit or copy encrypted state between models. Native and other
provider routes refuse PickerMux-owned compacted state.

This adapter supports text history only. Unsupported media, foreign encrypted
state, malformed controls, failed or incomplete summaries, and still-oversized
prompts fail without silently removing history. Summary quality depends on the
selected model. The legacy `/responses/compact` endpoint is not replaced by
this V2 adapter. Search and the final sourced answer passed on 0.7.5; the user
reported about eight minutes and a faster follow-up. Timing remains dependent
on the model, hardware, cache state, and number of tool/compaction steps.

The summary output is capped at 2,048 tokens, but the next ordinary request
still includes Codex's system context, tools, and retained messages. Compaction
therefore cannot guarantee that the full request fits a 32K context window.
If that fixed context stays near the limit, Codex may request another summary
after the next tool step; the adapter performs one inference per requested
compaction and does not retry it automatically.

## Provider fields

| Field | Purpose |
| --- | --- |
| `id` | Lowercase provider namespace used as the external slug prefix; 1-127 characters using lowercase letters, digits, `_`, or `-`, with an alphanumeric first and last character. |
| `kind` | `lmstudio-responses` or `openai-responses`. |
| `baseUrl` | Absolute provider URL without credentials, query, or fragment. |
| `allowPrivateNetwork` | Required explicit decision for loopback, LAN, or Tailscale targets. |
| `credentialKeychain` | Resolve this provider's bearer token from the macOS Keychain. |
| `credentialEnv` | Development-only environment credential; persistent install rejects it. |
| `discovery` | `allowlist` or LM Studio-only `loaded` discovery policy. |
| `models` | Explicit model entries and optional overrides. |

Public providers must use HTTPS. Private HTTP is accepted only for recognized
private-network hosts and only when `allowPrivateNetwork` is `true`.

## Discovery modes

### `loaded`

Available only for `lmstudio-responses`. PickerMux publishes currently loaded
LLMs from LM Studio, bounded by `maxModels`. An empty `models` array is allowed;
explicit entries can still provide curated overrides.

### `allowlist`

Publishes only models explicitly listed in `models`. This is the default and is
required for generic `openai-responses` providers.

Each model has:

- `id`: exact upstream model ID;
- `slug`: public namespaced picker slug beginning with `<provider-id>/`;
- `displayName`: one-line picker label;
- optional `type`, which must be `llm`;
- optional positive `contextWindow`;
- optional `reasoningEffort` and `reasoningEfforts`.

## Remote LM Studio over Tailscale

PickerMux can reach LM Studio on another trusted Mac while keeping the bridge
itself loopback-only. Replace the provider URL with the remote Mac's stable
Tailscale IP or MagicDNS name:

```json
{
  "id": "lmstudio",
  "kind": "lmstudio-responses",
  "baseUrl": "http://100.64.0.10:1234/v1",
  "allowPrivateNetwork": true,
  "discovery": {
    "mode": "loaded",
    "maxModels": 32
  },
  "models": []
}
```

LM Studio must listen on the trusted interface and expose compatible
`/api/v1/models`, `/v1/models`, and `/v1/responses` endpoints. Do not expose LM
Studio directly to the public internet. Verify the Tailscale path before
installing:

```bash
curl http://100.64.0.10:1234/api/v1/models
pickermux discover --config /path/to/pickermux.config.json
```

Use a stable `.ts.net` MagicDNS name instead of an IP when appropriate.

## Authenticated Responses-compatible provider

This adapter supports explicitly configured local or remote Responses
providers. The example below uses a remote endpoint and an explicit model
allowlist. Its model list and Responses behavior must satisfy the contract
described above; it does not imply that every OpenAI-compatible service is
supported. Persistent authenticated services should use the macOS Keychain:

```json
{
  "id": "vendor",
  "kind": "openai-responses",
  "baseUrl": "https://api.vendor.example/v1",
  "allowPrivateNetwork": false,
  "credentialKeychain": true,
  "discovery": {
    "mode": "allowlist",
    "maxModels": 8
  },
  "models": [
    {
      "id": "vendor-reasoner",
      "slug": "vendor/vendor-reasoner",
      "displayName": "Vendor Reasoner",
      "type": "llm",
      "contextWindow": 32768,
      "reasoningEffort": "high",
      "reasoningEfforts": ["low", "medium", "high"]
    }
  ]
}
```

Store and inspect the credential without putting it on the command line:

```bash
pickermux credential-set vendor
pickermux credential-status vendor
```

`credential-set` records only the provider's canonical ID in a private provider
registry before delegating interactive secret capture to `/usr/bin/security`.
Recording first keeps the deletion boundary recoverable if the Keychain
operation is interrupted. The registry never contains the credential, password,
token, or other Keychain value. Status output reports only `available` or
`missing`.

`credential-delete` removes the exact provider-scoped Keychain item before it
updates that registry; Keychain and filesystem writes cannot share one atomic
transaction. If the registry update then fails, the credential remains absent
while its provider ID remains safely registered. Resolve the reported registry
problem and rerun the same command: an already-absent Keychain item is treated
as deleted and the retry completes the registry update without reading a secret.

A successful install or refresh also registers every configured
`credentialKeychain` provider ID. This safely establishes deletion ownership
for credentials created by PickerMux before the registry was introduced; it
still stores no credential value and can target only PickerMux's
provider-scoped Keychain service namespace.

Normal removal deliberately retains provider credentials and verified
PickerMux configuration backups, including when the receipt-owned CLI is
removed:

```bash
pickermux uninstall
pickermux uninstall --remove-cli
```

Use the explicit full-removal mode only when those retained items should also
be deleted:

```bash
pickermux uninstall --purge
```

Purge uses the private registry to target only the exact PickerMux Keychain
entries previously registered by credential or lifecycle operations. It also
removes only backups whose PickerMux ownership, content hash, and device/inode
identity can be verified. An unsafe, foreign, modified, or ambiguous registry,
backup, launcher, runtime, or distribution state is refused instead of guessed
at. `--force` does not bypass these ownership checks. Purge never reads or
deletes native Codex authentication, including `~/.codex/auth.json`.

Every uninstall also requires the installed `runtime-app` to match the invoking
PickerMux distribution byte-for-byte. Unexpected entries, modified files,
symbolic links, special files, or a leftover `runtime-app.previous-*` package
stop removal for explicit review; no unrecognized runtime directory is deleted
recursively.

### Full removal with native Codex defaults

Ordinary uninstall, including `--purge`, restores the original configuration.
After a switch from Ollama, this may restore Ollama's gateway and catalog.
PickerMux 0.9.5 provides a separate explicit mode:

```bash
pickermux uninstall --purge --restore-native
```

It removes the verified integration without reinstating its recorded prior
root `model`, `model_provider`, `model_catalog_json`, `model_reasoning_effort`
or `openai_base_url`. Codex then selects its native defaults. Current unrelated
settings, comments and provider tables are preserved. Unowned overrides,
ambiguous configuration or concurrent edits stop the operation; this mode
cannot be combined with `--force` or used without `--purge`.

The native candidate and its ownership binding are checked before registered
provider credentials are deleted and again before configuration commit. It works
for an active or verified toggle-deactivated installation. It does not edit
the native account cache, authentication or historical chats. The inert
`model_bridge` provider alias remains solely to keep old chats readable.

The companion exposes this mode as **Settings → Remove PickerMux completely…**,
with explicit consent and a fresh removal preview. It also disables its login
startup and clears only its own preferences and notifications. After success,
quit the companion and move its app bundle to the Trash in Finder.

## Efficient Fidelity is not a provider setting

Version 0.6.0 does not add an `agent`, `toolDelivery`, or similar provider-wide
configuration field. Efficient Fidelity is an additive, model-bound capability
for `lmstudio-responses` routes. It becomes available only after the exact model
configuration first passes Direct tool certification and then passes the live
client-executed tool-search probe.

This separation prevents one successful model or endpoint from granting
deferred tool delivery to another. Provider ID and kind, base URL, public and
upstream model IDs, active context, reasoning and capability metadata, and the
Codex client version remain part of the receipt binding. A change to any bound
property requires certification again.

When the additive gate is absent or stale, a still-valid Direct-certified model
continues with the full tool definitions. A model without a valid base receipt
remains text-only. There is no Fast Agent route or PickerMux tool broker, and
the v0.6 Efficient Fidelity flow does not use `previous_response_id` to shorten
conversation history. Native Codex routing and configuration are unaffected.

## Applying configuration changes

### Codex integration ownership and companion previews

PickerMux 0.9.0 retains an explicit `model_bridge` provider. Its additional
transport fields are deliberate: WebSockets remain disabled, request/stream
retries remain zero, and configured stream timeout controls are retained.
The root-only built-in-provider mode is blocked because its defaults do not
satisfy the required transport contract. A gateway switch cannot grant tools
or substitute for exact model certification.

The companion's **Preview configuration changes** action returns the active
integration classification, a finite list of proposed changes, and a digest
token bound to the inspected configuration/receipt bytes. It recognizes the
supported local Ollama gateway and catalog; other unowned root overrides are
classified as foreign. No private TOML, path, account, model, or gateway
capability appears in the preview.

An active root `profile` selector is outside this integration contract.
Fresh setup reports `integration-conflict`, and an already managed profile
configuration is inconsistent. Review and resolve the selector explicitly;
PickerMux does not guess which profile-specific gateway or catalog wins.

With Codex fully closed and a valid account cache, **Apply configuration
changes…** requires explicit replacement confirmation and that exact token.
Setup rechecks the preview before committing, retains a verified backup,
preserves unrelated user bytes and line endings, and rolls back a failed
activation. Concurrent edits require a fresh preview. Edited owned blocks or
ambiguous state stop the operation. The bundled backend permits first setup
or an upgrade from a CLI predating the protocol, using the same existing
distribution ownership checks.

An Ollama switch has one active gateway owner; it does not combine two
independent integrations. Ordinary uninstall restores the verified prior
root settings, including the Ollama gateway when it was the recorded baseline,
and keeps the historical `model_bridge` compatibility alias. Subsequent full
refreshes preserve this original uninstall baseline. Cleanup canonicalizes
only PickerMux-owned provider layout, not arbitrary user TOML.

The GUI accepts no custom configuration path. First setup uses the safe
release default; an existing installation reuses its activated private
configuration. Use the existing custom-config installer or CLI flow for
provider configuration changes. See [the companion guide](MACOS_COMPANION.md)
for its protocol and distribution limits.

### Provider configuration changes

If the provider identity and managed bridge contract remain compatible, apply
the edited source file explicitly:

```bash
pickermux refresh --config /absolute/path/to/pickermux.config.json
```

Without `--config`, the installed launcher intentionally reuses PickerMux's
private service-configuration copy rather than rereading the original source
file.

If PickerMux reports that the installed configuration differs from the project
configuration, use the explicit lifecycle:

```bash
pickermux uninstall
pickermux setup --config /absolute/path/to/pickermux.config.json
```

Fully quit and reopen Codex Desktop after a successful install, refresh, or
certification so it reloads the static catalog.

Ordinary `refresh` accepts an account cache for the exact installed Codex
client regardless of cache age. The fetch timestamp and derived age remain
available as neutral `doctor` diagnostics; age by itself does not require a
configuration change or reinstall.

When native account visibility really must be refreshed, use the explicit
interactive recovery mode:

```bash
pickermux refresh --full
```

Full refresh preserves the already activated private service configuration,
certification receipts, verified backups, and provider credentials while it
temporarily suspends the Codex integration. It confirms the disruptive
operation, gracefully quits Codex, opens it without PickerMux, requires a
newly valid account cache for the exact client version, gracefully quits Codex
again, transactionally reactivates the preserved integration, and opens Codex
with the mixed catalog. A valid starting cache requires a later `fetched_at`;
when no valid exact-version baseline exists, the recovery requires a newly
valid exact-version cache. It rejects both `--json` and `--config` and never uses
a forced kill. Do not use this mode merely to apply provider edits; use the
normal explicit `refresh --config` flow above for that purpose.

After suspension starts, the recovery helper keeps a private checkpoint until
the sequence reaches a terminal success. A resumable failure explicitly tells
you to rerun `pickermux refresh --full`; after the confirmation, the
receipt-active helper continues the validated checkpoint. Do not delete
`models_cache.json`, modify the installed service configuration, or run purge
as a shortcut.

Version 0.9.0 also retains the configuration ownership receipt through temporary
suspension. It removes the active owned blocks into neutral native settings
instead of reinstating a previous Ollama or foreign gateway during the cache
fetch. The unchanged temporary state is reported as `suspended`; changed
configuration/state produces `suspension-conflict` and blocks reactivation.
Successful reactivation keeps the original verified backup and uninstall
baseline. Full refresh still changes the capability and invalidates earlier
encrypted compaction continuations.

The companion uses the same helper after its native confirmation; it does not
feed the CLI's `FULL` word into a simulated terminal. Resume requires renewed
confirmation. Pending recovery prevents configuration migration and ordinary
mutations until the validated operation is resolved.

`pickermux status` reports `full-refresh=idle` when no recovery is pending and
the current phase otherwise. Its JSON form exposes the same information under
`fullRefresh.status` and `fullRefresh.phase`.

PickerMux normally requires every receipt-owned configuration marker to remain
present. A missing provider end marker is treated as a virtual boundary only
when reinserting that exact marker at one unique safe line boundary before the
next TOML table (or end of file) reproduces the provider block SHA-256 stored in
the private state receipt. Blank and comment-only tail lines remain outside the
owned block and are preserved. `status` then reports
`installed-marker-recovered`. Refresh, picker selection changes, and uninstall
remain available. If the old managed provider needs the standalone-search
migration, refresh materializes that same receipt-proven end marker while
transactionally replacing the provider block. Other recovered-marker reads
leave the file unchanged. Any provider-scoped content change, duplicate or
missing begin/root marker, unsafe scope tail, ambiguous candidate, or receipt
mismatch still fails closed.

If this recovered-marker state coincides with a failed initial account-cache
preflight during release setup, the downloaded payload atomically materializes
only the receipt-proven marker under the lifecycle lock before returning the
uninstall-and-cache-refresh instructions. This changes neither the active CLI
nor runtime, but it allows an older installed CLI to perform the safe uninstall.
