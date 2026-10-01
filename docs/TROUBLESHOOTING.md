# Troubleshooting

Start with deterministic diagnostics:

```bash
pickermux status
pickermux doctor
```

Use `doctor --live` only when the static checks pass and a real model inference
is needed.

## Companion cannot find or validate the CLI or Node.js

The optional menu-bar app requires macOS 13+ and Node.js 22.15.0+ installed in
`/opt/homebrew/bin`, `/usr/local/bin`, or `/usr/bin`. A Node runtime added only
by a shell profile is unavailable to the app's narrow process environment.
The panel keeps **Retry status**, **Help…**, **Settings…**, and **Quit** visible
even before a backend status is available. **Help…** explains the supported
locations and links to the official Node.js downloads and this guide.

If Node.js is missing or too old, install a supported runtime from
[Node.js downloads](https://nodejs.org/en/download) or through the existing
Homebrew installation, then choose **Retry status**. The app does not start a
terminal or install Node.js automatically. An installed runtime that cannot
be verified needs review of its installation rather than repeated setup.
Keep credentials out of shell workarounds and app launch arguments.

Standard Homebrew Node.js installations are supported, including the
administrator-group-writable Homebrew `bin` and `Cellar` directories. Earlier
companion builds incorrectly rejected that normal layout and displayed an install-Node
message even when a supported version was present. The corrected validator
recognizes only those exact standard directories under `/opt/homebrew` or
`/usr/local`; it continues to reject unsafe executable ownership,
world-writable directories, unsafe link targets, and untrusted ancestors.
Update the companion and retry status instead of
changing Homebrew permissions to work around the old check.

Bridge actions appear only after a validated status grants them. A Node.js
failure does not authorize configuration setup, refresh, recovery, or an
update. Copying the app from the DMG installs its bundle; enable the top switch
once status is available to authorize automatic setup if the integration is
not installed yet.

The app validates the receipt-owned launcher, current pointer, source
inventory, and bounded protocol output. It can fall back to its verified
bundled backend for read-only checks and explicitly authorized configuration
setup when the installed CLI is absent or predates the protocol. Other
mutations require the active installed CLI. If ownership validation fails,
review the CLI installation; replacing receipts or disabling checks is not a
recovery procedure.

App and CLI version differences are shown in the panel. Install the matching
reviewed app build after a CLI update. An unsigned development build does not
prove that a signed/notarized app is available; see
[the companion guide](MACOS_COMPANION.md#development-and-distribution).

## Companion configuration preview is blocked or stale

An Ollama or other gateway owns the same root catalog and gateway fields that
PickerMux uses. Fully quit Codex, ensure its signed-in account cache matches
the installed client, then enable **Use PickerMux in Codex** to authorize the
switch. The automatically acquired preview is bound to the inspected
configuration and receipt; after any edit, request a fresh preview.

## Companion cannot enable PickerMux in Codex

Copying the app from a DMG installs the menu-bar utility. Turn on
**Use PickerMux in Codex** to authorize automatic CLI/bridge setup. First
installation is shown as setup required; the absence of a compatibility
manifest alone does not mean that Codex was updated.

Setup needs Codex fully closed, its account model cache matching the installed
client, and loaded external models at the configured provider. The default
provider is LM Studio. If the app reports a provider unavailable, start its
server; if it reports no loaded models, load a model before retrying. Installing
Ollama alone does not satisfy the LM Studio default configuration.

From 0.9.3, setup reports separate fixed messages for a refused connection,
timeout, denied access during discovery, HTTP 401/403 authentication, and malformed or
unsupported discovery responses. A general setup failure does not imply that
the server is stopped. For authentication, review the configured provider's
credential settings without changing native Codex authentication. For an
invalid response, check that the configured endpoint serves a supported model
API; setup stops rather than guessing a schema. For denied access, review the
app's access before retrying; do not disable system protections.

The displayed error records the last setup attempt. **Check status** checks
the installation and Codex state without testing provider connectivity. After
starting the server or fixing the reported prerequisite, turn the switch on
again to retry setup. The 0.9.3 panel uses larger primary text and controls.

For an account-cache message, open signed-in Codex until the native picker has
loaded, fully quit it with Command-Q, and check status again. Do not delete
native authentication or replace ownership receipts to work around setup.

The toggle follows the verified integration rather than a pending UI choice.
Cancellation or a failure leaves its actual state visible. An installation can
remain active after incomplete model certification; its unverified routes stay
conservative and the app offers the existing certification recovery.

An older CLI can lack toggle support even if its displayed version matches the
app. The new app uses its pinned setup backend when the required feature marker
is absent. Confirm the offered setup upgrade first; only the current
receipt-owned CLI can deactivate its bridge. Edited suspended configuration
and pending full-refresh recovery block toggle changes until reviewed.

## Companion buttons appear unresponsive

Use the 0.9.2 companion or newer. Earlier builds could drop a manual status
request during polling and open settings or modal alerts from the transient
menu panel. The corrected app queues manual checks, always shows their result
time, and opens Settings and Help in their own reusable windows. Enabling the
top switch installs automatically without the old second popup. Recovery and
software updates use a separate asynchronous confirmation window.

A busy indicator and elapsed time mean the requested operation is still
running. Installation can take several minutes while loaded models are
certified. If a fixed model-server error appears, start the configured provider
and load a model, then retry; reopening Settings or clicking status cannot
satisfy that setup prerequisite. Update checks and their results are in
Settings.

Modified managed blocks, ambiguous root assignments, unknown ownership state,
or an interrupted recovery prevent automatic switching. Keep the original
bytes and review the conflict. The app has no force option. Ordinary uninstall
uses the verified pre-switch backup to restore the former gateway. Historical
`model_bridge` aliases remain necessary for old chats and must not be removed
as cosmetic cleanup.

An active root `profile` selector also blocks integration setup or migration.
A fresh configuration reports `integration-conflict`; a managed one is
inconsistent. Review the profile selection explicitly before retrying instead
of deleting ownership markers or choosing a gateway by guesswork.

## Companion refresh, update, or repair is unavailable

Refresh, certification, updates, and configuration changes require Codex to be
fully quit with `Command-Q`. Closing its last window does not establish that
state. The optional automatic refresh runs only once after an observed full
close while the installation is ready; it does not resolve a cache/version or
configuration conflict.

Use **Check status** or the safe structured CLI snapshot:

```bash
pickermux companion status
```

`CODEX_RUNNING` requires a normal full quit. `BUSY` requires waiting for the
other lifecycle operation. `DISTRIBUTION_INVALID` requires review of the
installed CLI ownership. `ACCOUNT_CACHE_REFRESH_REQUIRED` or `UPDATE_REQUIRED`
directs you to confirmed account-cache recovery. `RECOVERY_PENDING` requires
resuming that checkpoint, with renewed confirmation, before another mutation.
`CONFIGURATION_CONFLICT` requires review or a fresh configuration preview.

`UPDATE_UNAVAILABLE` can be retried after connectivity returns.
`UPDATE_INVALID` means release integrity/schema validation failed; do not
execute the refused payload or bypass checksums. `UPDATE_UNSUPPORTED` requires
review of the runtime or available release package. Software updates do not
automatically replace the running app bundle.

If an operation times out or the app closes, recheck status before retrying.
The recovery helper runs independently once armed. Setup can also retain a
committed installation when certification is incomplete; use the existing
[certification recovery](#installation-completes-but-model-certification-does-not)
instead of assuming the old version remains active.

## Companion login startup, notifications, or Apple events are denied

Enable login startup and notifications only through the app's settings.
Review **System Settings > General > Login Items**, notification authorization,
or **Privacy & Security > Automation** when macOS asks for approval. A refused
or timed-out graceful Codex quit leaves recovery pending or blocked; it never
authorizes a forced Codex kill. Save work, quit Codex normally, check status,
and explicitly resume the validated repair.

The new companion's real TCC, login-start, notification, and Codex-update
acceptance checks are separate from the maintainer-confirmed 0.8.3 live
baseline. An offline test or unsigned build cannot establish those permissions
or a successful signed/notarized distribution.

## Historical chats cannot load `model_bridge`

An older `pickermux uninstall` or `uninstall --remove-cli` can remove the
`model_bridge` provider table while old chats still name that provider. Codex
may then say it cannot load `config.toml` because “Model provider
`model_bridge` not found.” The repair restores a provider definition only so
those chats can open. It does not restart PickerMux or make that provider usable.

Fully quit Codex Desktop with `Command-Q`, then run the version-pinned 0.8.3
recovery installer. It verifies the release payload and invokes only the
repair, without setup, LM Studio, or a current account model cache:

```bash
/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL https://github.com/patrickschiller/pickermux/releases/download/v0.8.3/install.sh | /bin/sh -s -- --repair-chats
```

From a trusted local 0.8.3 source checkout, you can instead run
`node bin/pickermux.mjs repair-chats` from the repository root. Reopen Codex
and the affected chat after repair. Choose a native model before sending
another message. The inert `model_bridge` table points to loopback port zero
and cannot serve a turn. If you want PickerMux again, first let the signed-in
native picker refresh its account model cache, fully quit Codex, and then run
the [regular installer](../README.md#install).

The installed 0.8.3 CLI also offers `pickermux repair-chats [--json]`.
The installer mode helps when the old CLI lacks that command or setup is
blocked by a stale cache. The repair is idempotent. It refuses an active
installation, managed markers, a foreign or modified `model_bridge` table, and
other ambiguous configuration state rather than overwriting it. Review such a
failure with `pickermux status` and `pickermux doctor` where available; do not
delete a provider table or use `--force` to bypass ownership checks.

Starting with 0.8.2, normal uninstall and `uninstall --remove-cli` for the
canonical `model_bridge` integration leave this same inert compatibility table.
Full purge already preserved it.

## `Failed to read the Codex client version`

PickerMux 0.7.5 checks the older
`/Applications/ChatGPT.app/Contents/Resources/codex` location, then `codex` on
`PATH`. Newer app bundles put the executable inside `codex-cli/CodexCLI.app`.
When the old location and a usable `PATH` command are absent, setup cannot read
the client version. You can check the newer bundled executable directly:

```bash
/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex --version
```

Upgrade with the [latest release installer](../README.md#install).
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
LaunchAgent restart loop. If `managed-config` is also `modified`, follow
[modified-configuration recovery](#uninstall-refuses-modified-configuration)
before retrying the installer; do not use `refresh --full`. Otherwise, rerun
the latest-release installer. Setup checks the Codex
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
and the receipt-active PickerMux CLI is v0.5.4 or newer with intact managed
configuration and receipt-owned runtime, use the managed recovery:

```bash
pickermux refresh --full
```

If PickerMux was already uninstalled or the active release predates this
command, follow setup's manual recovery: run `pickermux uninstall` first if the
older integration remains installed, open Codex Desktop while signed in, wait
for its native model picker to load, fully quit it with `Command-Q`, and install
PickerMux again. Reuse the same custom configuration path if one was used.
Never delete `models_cache.json` or `~/.codex/auth.json` as a workaround.

## Refresh reports an account-cache version mismatch after a Codex update

A cache from `0.159.0` cannot authorize a catalog for client `0.159.2`, even
though both are patch versions of the same release. Normal refresh stops before
external-provider discovery and leaves the installed catalog and account cache
unchanged. It reports the mismatch and the recovery command:

```bash
pickermux refresh --full
```

Run it from the installed CLI in a terminal and confirm with `FULL`. Starting
with 0.8.3, `--FULL` is also accepted as an option alias; earlier releases use
lowercase `--full`. Recovery can start while the bridge is
quarantined as `update-required`, provided the managed configuration and
receipt-owned runtime remain intact. It temporarily suspends PickerMux so
Codex can fetch its own exact-version account cache, then reactivates the
integration through the ordinary validation gates. No patch-version exception
or bundled-catalog substitution grants account access.

If the option is unknown, check `pickermux --version` and `pickermux help` to
identify the CLI being invoked; try the canonical lowercase `--full`. If that
command is also absent, use the manual uninstall/native-cache/reinstall
sequence above. If PickerMux has already been removed, open Codex natively
while signed in until its picker loads, fully quit it with `Command-Q`, and
run the [0.8.3 installer](RELEASE_NOTES_0.8.3.md#upgrade-and-verify).
If `doctor` reports modified managed configuration, follow
[the reviewed conflict recovery](#uninstall-refuses-modified-configuration).

## Connection failed after uninstall

Fully quit and reopen Codex Desktop, open the affected chat, and select a
native model before sending. Historical PickerMux chats can still retain their
`model_bridge` provider. The inert compatibility table preserves parsing but
deliberately cannot serve a new turn; sending through it can report
“Connection failed: error sending request.” Restarting alone does not change
the provider stored for that chat.

If uninstall instead reports that managed blocks were edited, it refused
removal before stopping the service. The integration remains installed; inspect
`pickermux doctor` and follow
[modified-configuration recovery](#uninstall-refuses-modified-configuration).
`--force` is for choosing to remove those reviewed owned blocks. It does not
renew Codex's account cache or migrate historical chats to another provider.

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

In 0.9.0, `managedConfig.status` can be `suspended` while the verified recovery
checkpoint is pending. The original ownership receipt and uninstall baseline
remain present. A `suspension-conflict` means the temporary native config or
receipt changed; preserve those files and review the conflict before retrying.
Configuration migration is unavailable during recovery. The companion's
**Repair after a Codex update…** resumes through the same helper after renewed
confirmation; the capability replacement still invalidates earlier encrypted
compaction continuations.

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

When this state occurs together with `update-required` after a Codex Desktop
upgrade, normal setup and `refresh --full` intentionally remain blocked: neither
operation is allowed to bless edited managed bytes as a new baseline. Use this
manual recovery sequence instead:

1. Fully quit Codex Desktop with `Command-Q`.
2. Run the installed `pickermux doctor`. Version 0.8.0 may report only
   `managed-config: modified`; that is enough to follow this recovery. Version
   0.8.1 names only known affected receipt-owned areas, such as `provider` or
   `provider-scope-tail`, without printing their contents.
3. Review `~/.codex/config.toml` and decide whether the edit must be preserved.
   Keep a private copy of intentional changes, including edits inside PickerMux's
   marked blocks, before forced uninstall removes them. After reinstalling,
   reapply desired settings through supported configuration rather than copying
   old managed blocks back wholesale.
4. If PickerMux's recorded configuration should win, run
   `pickermux uninstall --force`. Do not use `--purge`, delete
   `models_cache.json`, or edit PickerMux's private receipt.
5. Open Codex without PickerMux while signed in and wait for its native model
   picker to load. Fully quit it again.
6. Rerun the latest PickerMux installer, reusing the same custom PickerMux
   configuration if applicable, and then run `pickermux doctor`.

This uninstall/reinstall path also creates a new private bridge capability. If
a diagnostic was shared without redacting the `/c/...` URL, complete this
recovery rather than attempting to reuse the old bridge runtime, and remove the
unredacted diagnostic wherever possible. A browser opening the Responses URL
uses `GET`; `METHOD_NOT_ALLOWED` is expected because inference accepts only its
validated request method and is not evidence that the bridge is healthy.

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

Every current CLI uninstall mode for the canonical `model_bridge` integration
leaves one intentionally unusable compatibility table in `config.toml` so
historical chats can open. It has no credentials, uses
`http://127.0.0.1:0/v1`, and retries zero times; select a
native model for new turns. A later PickerMux setup removes only the exact
marker-bounded table. If setup reports a provider-table conflict, do not delete
or edit the table broadly: it was modified or is not PickerMux-owned and needs
manual review. The marker records only whether the restored config must remain
a file; it stores no user content.

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
