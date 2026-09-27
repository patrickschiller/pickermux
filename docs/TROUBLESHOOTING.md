# Troubleshooting

Start with deterministic diagnostics:

```bash
pickermux status
pickermux doctor
```

Use `doctor --live` only when the static checks pass and a real model inference
is needed.

## `Failed to read the Codex client version`

PickerMux 0.7.5 checks the older
`/Applications/ChatGPT.app/Contents/Resources/codex` location, then `codex` on
`PATH`. Newer app bundles put the executable inside `codex-cli/CodexCLI.app`.
When the old location and a usable `PATH` command are absent, setup cannot read
the client version. You can check the newer bundled executable directly:

```bash
/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex --version
```

Upgrade with the [0.8.0 release installer](RELEASE_NOTES_0.8.0.md#upgrade).
Rerunning the 0.7.5 installer does not include the fix. Version 0.7.6 detects
both bundled layouts and continues to validate the exact client version and
catalog. A successful version check alone does not establish full
compatibility.

If `CODEX_BINARY` is set, confirm that it points to the intended bundled
executable. It overrides automatic discovery and is not saved to the installed
service. See [discovery order](CONFIGURATION.md#codex-executable-discovery).

## LM Studio reports `Channel Error` or a context-length failure

`Channel Error` can wrap different inference failures. Read the nested error
in LM Studio's diagnostics before changing configuration. For an LM Link
model, the detailed error may also be on the device running the model. Share
only the relevant redacted error, not the full request or log.

### `System message must be at the beginning`

An inner error such as `Engine protocol predict request returned 500` followed
by `Jinja Exception: System message must be at the beginning.` identifies a
prompt-template failure. Strict Qwen templates can reject a second system
message. PickerMux 0.6.0 merges system/developer input but still forwards
top-level `instructions` separately, so a request containing both can produce
two system messages in LM Studio. Multiple system/developer messages are also
covered by an [LM Studio error report](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/2298).

This explains why a short question can work in LM Studio's chat UI while its
Codex Responses API request fails: the API request carries a different
instruction structure. With LM Link, `http://127.0.0.1:1234/v1` remains the
correct target for the local LM Studio server, which forwards inference to
the linked device. See [LM Studio's API guidance](https://lmstudio.ai/docs/developer/core/lmlink).
Increasing context or changing reasoning levels does not address this Jinja
error.

This is fixed in [PickerMux 0.6.1](../CHANGELOG.md#061---2026-09-13).
It incorporates top-level instructions into the existing leading system
message and removes the separate field only when merged; instructions-only
requests keep their existing shape. Fully quit Codex Desktop, follow the
[regular upgrade procedure](../README.md#upgrade), and verify that
`pickermux --version` reports 0.6.1 or later before reopening Codex. Editing
this source checkout does not update an installed runtime; do not patch the
managed runtime directly.

### Initial prompt exceeds the loaded context

If the nested error says that the initial prompt tokens
to keep exceed the context length, compare the active value reported by
`pickermux discover` with the model's load settings in LM Studio. Unload and
reload the model with a larger supported context, then fully quit Codex, run
`pickermux refresh`, and reopen Codex so it loads the updated catalog.

PickerMux 0.4.1 and later remove optional function-tool catalogs from
uncertified text-only requests. Version 0.4.0 could forward those schemas even
though the catalog disabled tool use, making a small active context fail before
ordinary chat text was processed. PickerMux 0.5.2 also replaces the donor
coding-agent profile with a latency-first text-only profile for uncertified LM
Studio models. It excludes verified app, cross-thread-memory, tool, and
agent-mode bootstrap only when the private annotation, role, exact shape, and
any per-kind envelope or placement rule match the Codex contract. Memory and
multi-agent wording is not pinned to one Desktop version. Generic developer
context is retained, but it no longer prevents later independently verified
bootstrap from being removed. Upgrade before diagnosing the remaining prompt
size; malformed envelopes or unknown structural context still stop compaction.

## LM Studio takes minutes before the first token

LM Studio's chat timing and a Codex turn are not directly comparable. The chat
UI can send only the visible question, while Codex also supplies its model
instructions and relevant conversation context. In the LM Studio server log,
long gaps during `Prompt processing progress` are model prefill time, not
PickerMux network latency.

If Codex disconnects during that phase, see
[stream timeouts during prompt processing](#stream-disconnects-during-prompt-processing).

After upgrading to PickerMux 0.5.2, fully quit Codex Desktop, run
`pickermux refresh`, and reopen Codex so the generated catalog is reloaded. An
uncertified LM Studio model should then report substantially fewer uncached
prompt tokens for a new short conversation. PickerMux preserves user messages,
attachments, conversation history, current environment facts, AGENTS/project
and managed instructions, and explicitly selected skill instructions. Those
can legitimately make a later or project-scoped turn larger.

The latency-first text-only route does not forward Codex's generated
cross-thread memory bootstrap or collaboration/multi-agent policy. Paste any
prior context needed for the answer into the conversation. A certified
tool-capable model deliberately receives the full coding-agent prompt and
context instead. In v0.6.0, an additionally Efficient Fidelity-certified LM
Studio model can reduce the deferred-tool schema portion of its first request,
but project instructions, history, selected skills, and the rest of the Codex
harness are intentionally retained.

After one text-only request, run `pickermux doctor`. Its `text-only-context`
check compares source and forwarded byte counts and reports omitted/retained
part counts plus a fixed stop reason. This data is held only in bridge memory;
it contains no prompt text, model/provider name, path, hash, or request and
conversation identifier. A high retained-byte count means required project,
environment, generic developer, selected-skill, or conversation context—not a
network delay. If LM Studio's uncached count remains much larger than the
reported forwarded input, capture only these counters and the PickerMux/LM
Studio versions when filing an issue.

Select an uncertified text-only model when low first-token latency matters more
than workspace tools and cross-thread memory. Do not post an unredacted request
log: Codex client metadata from older PickerMux versions can contain
installation, session, thread, window, and turn identifiers.

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

An old fetch timestamp is not itself an error. If `doctor` passes
`codex-account-cache` and its client version matches the installed Codex client,
ordinary `refresh` uses that snapshot without an age warning. When the account
really has gained or lost native model access, run the explicit interactive
recovery instead:

```bash
pickermux refresh --full
```

Read the confirmation carefully: the operation gracefully quits Codex twice,
so active Codex tasks can be interrupted. Run it through the receipt-active
installed CLI and type `FULL` exactly to proceed. It rejects `--json` and
`--config` and never forces the app to terminate.

## `update-required`

The installed runtime no longer matches the verified Codex client and bundled
catalog contract. PickerMux 0.5.2 also detects a Codex executable replacement
while the service is already running. It quarantines `/models` and Responses
traffic with HTTP 503 while keeping its capability-scoped health endpoint
available, so `status` and `doctor` can report `update-required` without a
LaunchAgent restart loop. Rerun the latest-release installer. Setup checks the Codex
account cache before staging the downloaded CLI, checks it again under the
lifecycle lock before committing CLI controls, and checks it once more
immediately before integration activation. A missing, malformed, or
version-mismatched cache stops without changing active CLI or runtime state. If
the installed configuration has only a receipt-recoverable missing provider end
marker, the initial preflight first restores that exact marker atomically under
the lifecycle lock. This lets an older installed CLI complete the instructed
uninstall instead of leaving setup and uninstall blocked on each other.

After a successful setup, run:

```bash
pickermux doctor
```

`doctor` reports `codex-account-cache` independently from the bridge runtime and
mixed catalog, so this check remains useful after an integration-only
uninstall. If setup or doctor reports that the account cache needs a refresh
and the receipt-active PickerMux CLI is v0.5.4 or newer with a healthy
integration, use the managed recovery:

```bash
pickermux refresh --full
```

If PickerMux was already uninstalled or the active release predates this
command, follow setup's manual recovery: run `pickermux uninstall` first if the
older integration remains installed, open Codex Desktop while signed in, wait
for its native model picker to load, fully quit it with `Command-Q`, and install
PickerMux again. Reuse the same custom configuration path if one was used.
Never delete `models_cache.json` or `~/.codex/auth.json` as a workaround.

## Full account-cache refresh stops before completion

`refresh --full` has bounded waits and fails closed. If a valid exact-version
cache existed at the start, Codex must produce another valid snapshot with a
later `fetched_at`. If the original cache was missing or belonged to another
client version, Codex must produce a newly valid snapshot for the exact current
client. A slow network, expired sign-in, unchanged account response, refused
Apple event, or Codex process that does not settle can therefore stop the
operation safely.

If the graceful quit is refused or times out, return to Codex, save any work,
quit it normally with `Command-Q`, and rerun `pickermux refresh --full`. PickerMux
never escalates to a forced kill. If the native-cache wait expires, confirm that
Codex is signed in and can load its native picker, then follow the checkpoint's
reported recovery instruction and retry.

An interruption after temporary suspension or during reactivation leaves a
private checkpoint rather than claiming success. Run `pickermux status`; its
text output shows `full-refresh=<phase>` while recovery is pending or
`full-refresh=idle` otherwise, and `status --json` exposes
`fullRefresh.status` and `fullRefresh.phase`. Then run `pickermux doctor`, rerun
`pickermux refresh --full`, and type `FULL` again when the worker reports a
resumable phase. Do not delete the private checkpoint or diagnostic log, the
account cache, PickerMux receipts, or `~/.codex/auth.json`, and do not use
`uninstall --purge` to hide an incomplete transaction. A successful resume
finishes the receipt-validated reactivation and opens Codex with the mixed
catalog.

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

## Installation completes but model certification does not

Setup and direct installation automatically check discovered models without a
valid tool receipt after activating the installation. The live tests can take
several minutes per model, especially the long-context check. Progress shows
the model number and current check; waiting updates every ten seconds show
elapsed time, not an estimated completion percentage. Keep LM Studio and its
models running and Codex fully closed throughout setup.

If a test or recovery step fails, the installer retains the activated CLI and
bridge but reports certification as incomplete and exits with status 1. A
missing or failed base certification does not grant tools. A model may remain
blocked behind the persistent recovery barrier, and later models may not yet
have been checked. Run:

```bash
~/.local/bin/pickermux doctor
~/.local/bin/pickermux certify --all
```

Use the reported fixed probe label and redacted failure code from the explicit
retry to diagnose failures. A successful base matrix is enough for Direct tools;
failure of only the Efficient Fidelity probe retains that working mode.
Restart Codex completely after success, start a chat in the local project, and
ask the model to list files and read an existing README to check actual workspace
access. Tool certification does not itself grant filesystem permissions.

## A model is text-only

That is the default for every newly discovered external model until its
certification passes. Setup and install now attempt that automatically; models
discovered later by refresh still need explicit certification. Run a live
certification only when LM Studio and the target model are ready:

```bash
pickermux certify --model lmstudio/OWNER/MODEL
```

Certification first places the target behind a persistent request-time
deactivation barrier, publishes a verified text-only catalog, and only then
removes the previous pass and opens the private probe transport. If a base gate
fails or that phase is interrupted, ordinary requests remain blocked or the
model remains text-only; stale authority is not revived. Rerun the same
`pickermux certify` command after correcting the underlying refresh or model
problem. A successful retry safely resumes from the persisted barrier. After a
full base pass, PickerMux records Direct fidelity before it probes Efficient
Fidelity; failure of only that additive probe retains the Direct fallback.
Context, provider, capability, reasoning, or Codex client changes also make an
old pass stale.

If an interrupted loaded-model target is no longer discovered, rerun its same
`certify --model` command, or use `certify --all` to recover every absent
pending target. PickerMux first refreshes the gated service and confirms that
the route is absent from both discovery and the live catalog; only then does it
remove that model's pending barrier without fabricating a receipt. The
`tool-certifications` doctor detail reports how many recovery operations remain
pending.

## Efficient Fidelity is not active

Efficient Fidelity requires both a valid Direct receipt and the additive
model-bound tool-search gate. Run `pickermux doctor` first, then certify the
exact loaded LM Studio model and fully quit and reopen Codex so it loads the
new catalog:

```bash
pickermux certify --model lmstudio/OWNER/MODEL
```

The `tool-certifications` doctor check summarizes how many discovered models
are in Efficient Fidelity, Direct, or conservative text-only mode without
printing model identifiers or private prompt data.

If certification reports that conservative recovery is pending, do not edit
`certifications.json` or try to force-enable catalog flags. Keep LM Studio and
the exact target model available, run `pickermux doctor`, then rerun the same
certification command. The persistent barrier intentionally rejects ordinary
requests to that model until PickerMux can verify a safe catalog transition.

If the Direct matrix passes but the additional search probe cannot be verified,
PickerMux deliberately keeps Direct fidelity. The model still receives the
full Codex harness and can use tools, but LM Studio receives the complete tool
schemas instead of deferred delivery. The command reports the stable
`additive-probe-failed` reason without echoing provider response content; check
LM Studio's local server diagnostics before retrying. A failed Direct matrix
leaves the model text-only.

Efficient Fidelity optimizes deferred tool definitions, not ordinary context.
A large project instruction set, long conversation, attachment, explicit
skill, model load, or cold prompt cache can therefore still dominate time to
first output. Version 0.6.0 also sends a complete public replay for the search
round trip; it does not use `previous_response_id` for provider-side history
reuse.

If a previously active gate disappears, check whether LM Studio's endpoint,
loaded model ID, active context size, reasoning metadata, or Codex Desktop
version changed. Refresh, recertify the exact route, restart Codex, and retry.
Do not add an unsupported configuration flag or publish an unredacted Responses
request to force the feature.

## Web search is missing or fails

Standalone web search was added in 0.7.0 and is included in the prepared,
0.7.5 release.
For candidate testing, follow [the acceptance procedure](WEB_SEARCH_ACCEPTANCE.md).
After publication, upgrade first, fully quit Codex, run normal `pickermux refresh`, and
reopen Codex. The refresh must activate a bridge that reports the new search
contract; copying a source file into the installed runtime is not an upgrade.

Check the model's certification with `pickermux doctor`. Newly discovered or
stale models remain text-only. If necessary, run the normal `certify --model`
procedure only when the exact model is ready and no local-model task is active,
then restart Codex. Do not force-enable tool flags. Efficient Fidelity's
tool-inventory search is a different capability; a valid Direct-certified
model can use `web.run` without passing its optional deferred-tool probe.

An existing `features.standalone_web_search = false`, `web_search = "disabled"`,
or managed search restriction is respected. Check user-owned settings without
changing PickerMux's marked blocks. `WEB_SEARCH_CONFIG_CONFLICT` can indicate
duplicate or non-boolean feature definitions, or an inline `features` table
that needs an explicit `standalone_web_search` boolean. Resolve the reported
TOML conflict and rerun refresh.

| Error | Next step |
| --- | --- |
| `MODEL_NOT_CERTIFIED` | Certify the exact external model when it is ready. |
| `MODEL_CERTIFICATION_PENDING` | Complete the regular certification recovery; do not edit its receipt. |
| `SEARCH_MODEL_UNAVAILABLE` | Check that `bridge.webSearchModel`, or `bridge.defaultModel` when omitted, names an account-visible native model; apply configuration changes through refresh. |
| `SEARCH_SERVICE_ERROR` | The native search service rejected the request. Check native Codex sign-in, account availability, and runtime support; do not add an LM Studio API key. |
| `INVALID_WEB_SEARCH` or `UPSTREAM_RESPONSE_ERROR` | The request or reply does not match the reviewed protocol; update PickerMux and retain only the fixed error code for a report. |

Native `web.run` search and follow-up source opening passed live smoke checks.
Full external-model search acceptance remains pending. A source/fixture test
passing does not establish service availability in every installation, and a
404 may indicate missing endpoint support. PickerMux does not retry through
LM Studio or substitute an answer without sources. Do not share raw search
requests or upstream error bodies: they can contain conversation or account
context.

An available tool does not guarantee a correct answer. Ask the model to search
and cite current sources and inspect whether `web.run` actually ran. A model
that answers from memory can still invent facts. PickerMux does not add a
separate research agent for text-only models.

## LM Studio reports `Invalid type for 'input'` after a tool call

The error `invalid_union` alone does not identify a bad text field. In the
observed 0.7.2 failure, the selected model successfully issued a web call and
Codex's next request was remote compaction V2. Its final `compaction_trigger`
item is unsupported by LM Studio 0.4.24+1, even though that version accepts the
accompanying text-array tool output and reasoning content.

The prepared 0.7.4 adapter translates the compaction operation into one bounded
LM Studio summary and returns authenticated encrypted continuation state to
Codex. Upgrade through normal setup and restart Codex; a still-valid model
certification need not be repeated. Use a new task for the acceptance test and
require both actual web activity and a sourced final answer. Do not simply
delete the trigger: Codex expects a compaction result and would reject a normal
answer instead. [Compaction behavior and limits](CONFIGURATION.md#lm-studio-context-compaction).

| Adapter error | Next step |
| --- | --- |
| `INVALID_COMPACTION_REQUEST` | The control or transcript is unsupported, including nontext media. Start a text-only test task and report only the fixed code. |
| `COMPACTION_FAILED` | The model did not return a complete valid summary. Prior history remains; check the local server condition and context limits without repeated long retries. |
| `COMPACTION_UNAVAILABLE` | Update PickerMux with normal setup and its catalog. |
| `INVALID_COMPACTION_STATE` | Restore the original installation/model configuration or start a new task. Full refresh and reinstallation invalidate previous state. |
| `COMPACTION_STATE_ROUTE_MISMATCH` | Continue on the original external model or start a new task for the different provider. |

## Only a sentence fragment appears after automatic compaction

Version 0.7.3 restored the compacted context as an assistant message. If that
message ended the request, LM Studio continued its text as response prefill
instead of starting a new answer. The observed live search and summary both
contained the correct fact and official source; only 14 new tokens followed.
This was a response-boundary bug, not a missing search result or timeout.

The prepared 0.7.4 build adds one short fixed user-role instruction after an
authenticated terminal summary. The dynamic summary remains assistant context.
Upgrade through normal setup, retain the valid certification, and restart
Codex. The v1 state format is compatible; do not use full refresh or modify
encrypted history. Require a complete sourced answer in the next new-task test.

In this run, the three prompt evaluations processed 26,195, 19,556, and 26,268
tokens in approximately 13 minutes 43 seconds combined. Codex reintroduced its
system context, tools, and retained messages after compaction. A successful
summary therefore did not make the next ordinary prompt smaller. The boundary
fix adds no inference and does not claim to remove this prefill cost. Do not
increase timeouts, repeat certification, or run long retries to diagnose this
specific fragment symptom.

## A correct web answer takes many minutes

Separate initial prompt processing from repeated tool/compaction cycles. The
successful 0.7.4 run took 16 minutes 56 seconds, including three summaries
totalling roughly 10 minutes 50 seconds. Ordinary continuation requests already
reused more than 26,000 cached input tokens. This does not support disabling the
cache, increasing parallel slots, or raising timeouts as a solution.

The 0.7.5 build omits separately supplied current base instructions
from V2 summaries, while retaining all conversation input and the ordinary
Codex harness. An offline reconstruction reduced the first summary's JSON body
by 29.6%; that is not a measured token or latency reduction. It also asks the
model to preserve completed tool work and avoid repeating completed lookups
unless evidence or existing instructions require another check. The tools
remain available and model adherence is not guaranteed.

Use normal setup and keep the certified model configuration unchanged. In one
new task, repeat the short venue search and record elapsed time, search count,
compaction count, and numeric cached/input token counts if available. Require
the same correct sourced answer. Do not reload the model just to run the test;
compare cold and cached runs separately. A large initial Codex prompt still
costs minutes on this setup. See the [acceptance procedure](WEB_SEARCH_ACCEPTANCE.md).

## Certification reports `fetch failed`

Version 0.7.1 replaces certification's default Node `fetch`
with bounded local HTTP transport. Its existing ten-minute probe deadline
covers receipt of both headers and the response body. Undici has separate
five-minute header and body-inactivity defaults, so a longer abort deadline
alone does not remove those limits. This is a possible explanation for a slow
0.7.0 probe ending with generic `fetch failed`; it has not been established as
the cause of the reported LM Link failure. See
[Undici's client timeout options](https://github.com/nodejs/undici/blob/840b4e774851f19b52ecee1f75bd3a7776e8416d/docs/docs/api/Client.md).

With LM Link, `http://127.0.0.1:1234/v1` remains the local API target even when
the model runs on a linked Windows computer. LM Studio forwards the request;
see [its LM Link API documentation](https://lmstudio.ai/docs/developer/core/lmlink).
A short bridge-to-LM-Link request succeeded during investigation, but it used
reasoning `none` and does not establish that the complete certification matrix
passes with the configured reasoning level. The fix does not change reasoning
defaults, probe budgets, or capability gates.

Follow the [current candidate procedure](WEB_SEARCH_ACCEPTANCE.md) to upgrade an
installed 0.7.0 package through normal setup. Do not replace immutable runtime
files or bypass same-version checksum checks. With Codex fully quit and the
exact model loaded, resume the same certification command after upgrade.
Record only its fixed probe label and transport code if it fails again:

| Diagnostic | Meaning and next step |
| --- | --- |
| `CERTIFICATION_TIMEOUT` | The probe's deadline expired; inspect model loading and processing progress before retrying. |
| `CERTIFICATION_CONNECTION_FAILED` | Check the local LM Studio server and linked-device connection. |
| `CERTIFICATION_BODY_FAILED` | The response body was interrupted or could not be read; inspect local server diagnostics. |
| Other `CERTIFICATION_*` code | Retain the fixed code and probe label for a report; do not share raw request or error bodies. |
| `MODEL_CERTIFICATION_PENDING` | Ordinary inference is blocked while certification is pending or unavailable; complete regular certification recovery. |
| `PROVIDER_CREDENTIAL_UNAVAILABLE` | Ordinary inference could not resolve the selected provider's credential; inspect its configured credential reference. |

A failed or interrupted certification keeps its recovery barrier. Do not edit
receipts, force-enable shell or tool capabilities, or repeatedly launch long
probes to hide the failure. A full live retry with 0.7.1 passed the eight base
gates and additive tool-search gate on the tested LM Link model. Preserve a
still-valid pass when upgrading; a later task timeout does not by itself
require recertification.

## Stream disconnects during prompt processing

A stream or decoding error in Codex does not by itself identify an encoding
failure. In the investigated case, LM Studio was still processing the prompt:
progress reached 29% after roughly eight minutes, and the connection ended at
ten minutes, matching the configured `streamIdleTimeoutMs` of 600,000 ms.
Certification had already passed. This establishes the idle-timeout boundary;
it does not explain why prefill was slow or prove a Windows GPU problem.

The prepared 0.7.2 candidate delays transformed external response headers until
validated output is ready. A failure before that point can return its actual
structured HTTP error. If transformed external SSE output has already started,
PickerMux reports an upstream or validation failure with a minimal
`response.failed` event while the client remains connected, then ends the
response so Codex can display the fixed code and message. A client-side
disconnect cannot receive that event and remains a network failure. The
upstream request is stopped. Timeout diagnostics distinguish these conditions:

| Error | Meaning |
| --- | --- |
| `UPSTREAM_HEADERS_TIMEOUT` | The provider did not return response headers within the configured limit. |
| `UPSTREAM_IDLE_TIMEOUT` | No response bytes arrived within the configured idle limit, including while the model was processing its prompt. |
| `UPSTREAM_TOTAL_TIMEOUT` | The entire upstream request exceeded its configured duration. |

The fix does not increase timeouts, fabricate completion, or make model
processing faster. Lower reasoning can reduce generated reasoning work after
prefill; it does not make the same input prompt process faster. Inspect the
model's actual processing progress and hardware utilization before choosing
load-setting changes. Model weights, KV cache, and working buffers all need
memory; an enabled GPU option alone does not prove the entire workload fits in
VRAM. Measure GPU memory and utilization on the machine running the model.
Batch size and parallelism affect memory demand, so compare one deliberate
load-setting change at a time. PickerMux does not automatically change GPU
placement, batch size, parallelism, or retained context.

Upgrade through the [candidate procedure](WEB_SEARCH_ACCEPTANCE.md) and keep an
existing valid certification. Record only the fixed error code, elapsed time,
and numeric progress for diagnosis. Live timeout-reporting acceptance and
external-model web search are still pending.

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

Status `installed-marker-recovered` is healthy and specific: only the managed
provider end marker is absent, and virtually reinserting that exact line at one
unique safe boundary before the next TOML table or end of file reproduces the
private installation receipt's digest. Blank and comment-only tail lines are
preserved. Inspection leaves the file byte-for-byte unchanged while allowing
refresh, picker selection changes, and uninstall. If the old provider needs the
standalone-search migration, refresh materializes the same verified marker
within that transaction. Any provider-scoped edit, second marker, missing
begin/root boundary, ambiguous candidate, or hash
mismatch remains `inconsistent` and requires manual review.

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

`pickermux uninstall --purge` is the separate full-removal mode. It additionally
removes only validated backup files and exact provider Keychain items recorded
in PickerMux's private, secret-free registry. A modified or foreign LaunchAgent,
invalid receipt, unsafe permission, symbolic link, unexpected backup entry, or
provider-registry change stops the purge. `--force` does not override those
ownership checks.

The canonical `model_bridge` full-purge configuration restoration leaves one
intentionally unusable compatibility table in `config.toml` so historical chats
can open. It has no credentials, uses `http://127.0.0.1:0/v1`, and retries zero
times; select a native model for new turns. A later PickerMux setup removes only
the exact marker-bounded compatibility table. If setup reports a provider-table
conflict, do not delete or edit the table broadly: it was modified or is not
PickerMux-owned and needs manual review. The exact marker also records only
whether the restored `config.toml` must remain a file. It is false only when the
path was absent before installation and no user content survives restoration,
so a setup followed by ordinary uninstall preserves absence, an empty existing
file, or surviving user bytes.

All uninstall modes compare `runtime-app` byte-for-byte with the invoking
PickerMux version before changing Codex configuration. A modified or additional
runtime entry, special file, symbolic link, or leftover
`runtime-app.previous-*` package stops removal. Review or repair only the exact
reported state; never remove `~/.codex/model-bridge` recursively.

Fully quit Codex Desktop with `Command-Q` before every uninstall mode. PickerMux
rechecks that condition under the lifecycle lock before changing managed state.

A runtime, backup, or provider-registry cleanup-pending error means the
uninstall or purge failed and the receipt-owned CLI remains available or is
restored for recovery. Do not assume full removal completed. Review only the
exact private quarantine path from the error, then rerun the same uninstall
mode after that state is resolved.

If full purge reports `PICKERMUX_CREDENTIAL_PURGE_INCOMPLETE`, one or more exact
PickerMux provider credentials may already be absent, but the integration,
receipt-owned CLI, provider registry, and backups remain available. Resolve the
reported Keychain error and rerun `pickermux uninstall --purge`; already-absent
registered items count as complete. If it reports
`PICKERMUX_PURGE_COMMIT_INCOMPLETE`, the Keychain phase completed before
integration removal failed. Do not recreate registry files or delete native
Codex state manually; fix the reported integration problem and retry the same
command. PickerMux never reads credential values to manufacture a rollback.

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
