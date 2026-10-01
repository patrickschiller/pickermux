# PickerMux

[![CI](https://github.com/patrickschiller/pickermux/actions/workflows/ci.yml/badge.svg)](https://github.com/patrickschiller/pickermux/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#requirements)
[![Node.js 22.15+](https://img.shields.io/badge/Node.js-22.15%2B-43853d.svg)](#requirements)

**Use local LM Studio models directly from the Codex Desktop picker.**

**Version 0.9.0 adds a native macOS menu-bar companion.**
Check the picker, refresh it after Codex closes, preview a switch from Ollama,
and start confirmed recovery after a Codex update. The app uses PickerMux's
existing installation and routing core. See the
[companion guide](docs/MACOS_COMPANION.md) for builds, usage, and the remaining
live acceptance checks.

For installation, upgrade, and diagnostic problems, see
[Troubleshooting](docs/TROUBLESHOOTING.md).

Certified external models can also use Codex's `web.run` tool to search the web,
read sources, and answer with links. See [Web search](#web-search-tool).

PickerMux makes local models feel like a first-class part of Codex Desktop. Load
a model in LM Studio, refresh PickerMux, and select it from the same familiar
model picker—without maintaining separate Codex profiles, repeatedly editing
providers, or switching to a separate local-only workflow.

Your existing Codex models remain in place while PickerMux adds clear,
namespaced entries for the local models that are actually loaded. The result is
a fast local-model workflow with accurate context information, model-specific
reasoning levels, and a strict routing boundary between native and external
providers.

Version 0.6.0 introduced **Efficient Fidelity**: certified LM Studio models can
keep the complete Codex coding harness while deferring large tool schemas until
the model asks Codex to find the relevant tools.

Version 0.7.5 reduces LM Studio summary requests by excluding the
separately supplied base instructions that Codex sends again when answering.
It retains conversation messages, source results, and encrypted continuation
state. Summary instructions distinguish completed research from remaining work. See
[context compaction](docs/CONFIGURATION.md#lm-studio-context-compaction) for
model-switch and recovery limits. A user reported a correct sourced answer in
about eight minutes with 0.7.5, compared with about seventeen minutes before;
a subsequent request was faster. This is one setup's observation, not a general
benchmark. Large initial Codex prompts can still be slow on local hardware.

![PickerMux model picker showing local LM Studio models alongside existing Codex models](assets/screenshots/pickermux-model-picker.png)

*Load models in LM Studio, refresh PickerMux, and select them directly in Codex
Desktop.*

PickerMux is an unofficial community project. It is not affiliated with,
endorsed by, or supported by OpenAI, Codex, or LM Studio.

## Requirements

- macOS on Apple silicon or Intel;
- Codex Desktop installed, opened once while signed in, and then fully quit;
- LM Studio with its local server enabled and at least one LLM loaded;
- Node.js 22.15.0 or newer with native Zstandard support;
- a valid account model cache created by the installed Codex Desktop build.

The optional companion requires macOS 13 or newer and a supported Node.js
runtime in `/opt/homebrew/bin`, `/usr/local/bin`, or `/usr/bin`. Node.js remains
an external prerequisite; the app bundles the verified PickerMux backend.

The cache must match the installed Codex client version. Its age alone does not
make it invalid or require an uninstall.

PickerMux is macOS-specific because it uses LaunchAgents, LaunchServices, and
the macOS Keychain. The installer runs entirely as the current user: it neither
uses `sudo` nor edits shell startup files.

Confirm that the required Node.js runtime is visible in the terminal before
installing:

```bash
node --version
```

The command must report `v22.15.0` or newer. If it reports `node: command not
found` or `env: node: No such file or directory`, install a supported Node.js
release, open a new terminal, and rerun the check.

## Install

After satisfying the requirements above, fully quit Codex Desktop with
`Command-Q` and install the latest published release:

```bash
/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL https://github.com/patrickschiller/pickermux/releases/latest/download/install.sh | /bin/sh
```

The release installer downloads an exact versioned archive, verifies its
embedded SHA-256 digest, rejects unsafe archive entries, and then hands off to
PickerMux's transactional setup lifecycle. It stores versioned CLI files below
`~/Library/Application Support/PickerMux` and exposes the command as
`~/.local/bin/pickermux`.

Setup then automatically certifies discovered external models that do not have
a valid tool certification. These live test requests enable Codex tools for
reading project files and running commands only after the model passes. Allow
several minutes per model, or longer on slow hardware. Keep the models loaded
and Codex fully closed until setup finishes. Progress shows the model number,
current check, and elapsed time, with an update every ten seconds while waiting.
Existing valid Direct and Efficient Fidelity certifications are retained.

If certification fails, setup reports **installation retained, certification
incomplete** and exits unsuccessfully. Models without a valid certification
remain text-only or blocked pending recovery; later models may not yet have
been tested. Run `pickermux doctor`, then `pickermux certify --all` with the
models loaded to retry. See [certification recovery](docs/TROUBLESHOOTING.md#installation-completes-but-model-certification-does-not).

If `~/.local/bin` is not already in `PATH`, the installer prints the exact
one-time shell configuration needed. It does not change `.zprofile`, `.zshrc`,
or another shell file automatically. Until then, use the absolute command path.

For the published 0.8.3 reference install or upgrade, use:

```bash
/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL https://github.com/patrickschiller/pickermux/releases/download/v0.8.3/install.sh | /bin/sh
```

The one-line installers execute code downloaded from GitHub. The archive checksum
protects against corruption or asset substitution after the installer starts,
but the bootstrap still trusts HTTPS, GitHub, and the maintainer account. To
review it first, download `install.sh`, inspect it locally, and execute the saved
file only after you are satisfied.

Reopen Codex Desktop after setup. The mixed catalog is loaded only at process
startup, so closing a window is not enough: use **Codex > Quit Codex** or press
`Command-Q` before reopening it.

The included configuration expects LM Studio at
`http://127.0.0.1:1234/v1`. To use a trusted remote Mac over Tailscale or add
another Responses-compatible provider, create the custom configuration first
and follow the managed setup procedure in
[Configuration](docs/CONFIGURATION.md).

With LM Link, keep that local LM Studio URL: LM Studio forwards inference to
the linked device internally. See LM Studio's
[LM Link API documentation](https://lmstudio.ai/docs/developer/core/lmlink).

If setup stops with `Failed to read the Codex client version`, see the
[Codex executable discovery troubleshooting](docs/TROUBLESHOOTING.md#failed-to-read-the-codex-client-version).

### Repair historical chats

Use this repair-only mode if an older uninstall left historical chats unable
to open with “Model provider `model_bridge` not found.” Fully quit Codex
Desktop with `Command-Q`, then run the version-pinned 0.8.3 recovery installer:

```bash
/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL https://github.com/patrickschiller/pickermux/releases/download/v0.8.3/install.sh | /bin/sh -s -- --repair-chats
```

The installer verifies its exact payload and runs only the repair; it does not
run setup or require a new installed CLI, LM Studio, or a current Codex account
model cache. From a trusted local 0.8.3 source checkout, you can instead run
the repair from that repository root:

```bash
node bin/pickermux.mjs repair-chats
```

Reopen the affected chat and choose a native model before sending another
message: the restored provider table cannot serve requests. When the native
picker and model cache are ready, use the [regular installer](#install) if you
want PickerMux again.

See [historical chat recovery](docs/TROUBLESHOOTING.md#historical-chats-cannot-load-model_bridge).

## Verify the installation

```bash
~/.local/bin/pickermux --version
~/.local/bin/pickermux status
~/.local/bin/pickermux doctor
~/.local/bin/pickermux discover
```

After installing 0.8.3, the first command must print `pickermux 0.8.3`.
`status` checks the managed configuration, catalog, compatibility contract,
and bridge.
It also reports `full-refresh=idle` normally or the current recovery phase;
`status --json` exposes the same state as `fullRefresh.status` and
`fullRefresh.phase`. `discover` lists the LLMs currently loaded in LM Studio.
`doctor` is deterministic and does not submit a model prompt. Its independent
`codex-account-cache` check reports whether the signed-in account cache matches
the installed Codex client even when the bridge runtime or mixed catalog is
absent. Use `pickermux doctor --live` only when you intentionally want a real
LM Studio inference check. Once `~/.local/bin` is in `PATH`, the shorter
`pickermux` form is equivalent.

## macOS companion

The companion build includes an installable
`PickerMux-v0.9.0-macos-universal.dmg` for the planned release. Open the disk
image, drag **PickerMux.app** to **Applications**, eject the image, and open the
copied app. Node.js remains a prerequisite. Copying the app does not install
the CLI or change Codex configuration; use the app's explicit preview and
setup action when the integration needs installation. Use a signed and
notarized release image for distribution; unsigned development images are
local test builds. See [installation details](docs/MACOS_COMPANION.md#install-from-a-disk-image).

Open `PickerMux.app` to inspect the bridge, Codex compatibility, account cache,
and active integration from the menu bar. Available actions use the same
receipt checks, installation locks, certification gates, and rollback as the
CLI. A bundled backend can preview and set up the integration when the
installed CLI is missing or too old; it cannot control another CLI's service.
If Node.js cannot be found or validated, **Retry status**, **Help…**,
**Settings…**, and **Quit** stay available. Help links to Node.js setup and
[troubleshooting](docs/TROUBLESHOOTING.md#companion-cannot-find-or-validate-the-cli-or-nodejs).

Choose **Refresh picker** with Codex fully closed, then **Open Codex** to load
the updated catalog. The settings offer an optional refresh when Codex closes,
login startup, and notifications for meaningful state changes. These settings
are off by default. Model weights must already be loaded in LM Studio.

**Repair after a Codex update…** asks before the two graceful Codex quits,
possible task interruption, and capability change that invalidates earlier
encrypted compaction continuations. An interrupted repair requires the same
confirmation before resuming its checkpoint.

**Preview configuration changes** shows ownership and proposed changes before
a confirmed switch from an Ollama or other gateway. Concurrent edits stop the
switch; uninstall restores the verified previous configuration. PickerMux
retains an explicit provider because the built-in provider's retry and
transport defaults have not qualified for the bridge's safety contract.

The update action verifies the CLI release before activating its existing setup
transaction. App and CLI versions are shown separately; install a matching app
build after updating the CLI. App builds, signing requirements, and validation
limits are documented in [the companion guide](docs/MACOS_COMPANION.md).

## Daily workflow

1. Start the LM Studio server and load the LLMs you want to expose.
2. Run `pickermux refresh`.
3. Fully quit and reopen Codex Desktop.
4. Select the namespaced LM Studio model from the normal Codex model picker.

Normal `refresh` does not warn merely because the matching Codex account cache
is old. Its fetch time and neutral age remain visible through `doctor`.
After a Codex update, a version mismatch stops refresh before external-provider
discovery or credential resolution and points to `pickermux refresh --full`.
The existing catalog and account cache remain unchanged.

Models first discovered after installation still need
`pickermux certify --model SLUG` before they can use tools. Ordinary refresh
does not run live certification automatically.

## Refresh native account visibility

Use the opt-in recovery mode when a newly entitled native model is missing or
PickerMux reports that the account cache does not match the installed Codex
client:

```bash
pickermux refresh --full
```

`--FULL` is accepted as an alias for `--full`; the confirmation token remains
`FULL`. A quarantined bridge reporting `update-required` can use this recovery
when its managed configuration and receipt-owned runtime are intact. Edited
managed configuration still requires review before recovery.

This is an interactive macOS lifecycle operation, not the normal daily refresh.
Run it from the receipt-active installed PickerMux CLI, not directly from a
development checkout. It first explains that Codex will quit twice and that
active Codex tasks can be interrupted, then requires you to type `FULL` exactly.
`--full` cannot be combined with `--json` or `--config`; it always reuses the
installed service configuration.

After confirmation, a one-time helper performs the recovery independently of
the Codex process:

1. request a graceful Codex quit and verify that the app fully stopped;
2. temporarily suspend the PickerMux integration while retaining its installed
   configuration, certifications, backups, and provider credentials;
3. open Codex without PickerMux and wait for a newly valid account cache that
   matches the installed client version; when a valid starting cache existed,
   the new `fetched_at` must also be later;
4. request another graceful quit, transactionally reactivate the preserved
   PickerMux configuration, and run the normal validation gates;
5. reopen Codex so it loads the refreshed mixed catalog.

During suspension, private configuration receipts and the original backup stay
intact. Codex receives temporary native settings rather than a previously
configured gateway. Reactivation refuses edits to those temporary settings.
Full refresh replaces the capability, so earlier encrypted compaction
continuations cannot be resumed afterward.

PickerMux never escalates a refused or timed-out graceful quit to a forced kill.
The helper uses bounded waits and a private checkpoint. If the sequence pauses
after suspension, rerunning `pickermux refresh --full` and confirming again
resumes that validated checkpoint. It otherwise fails closed rather than
claiming that PickerMux was reactivated successfully. See
[Troubleshooting](docs/TROUBLESHOOTING.md#full-account-cache-refresh-stops-before-completion).

## Text-only performance

PickerMux 0.5.2 reduces prompt-prefill work for newly discovered, uncertified
LM Studio models. Codex Desktop can attach a large generated coding-agent
bootstrap even to a short question. On a text-only route, PickerMux replaces
the donor coding-agent profile with a compact assistant prompt, removes
optional tool schemas, and omits only generated bootstrap fragments that prove
their private semantic kind, expected role, exact shape, and any required
complete envelope.

This optimization does not discard the conversation. User messages,
attachments, conversation history, current environment facts, AGENTS/project
and managed instructions, and explicitly selected skill instructions still go
to the model. Generated cross-thread memory and collaboration/multi-agent
policy carry dedicated private kinds and can be omitted without pinning their
wording to one Codex release. Generic developer context is retained, but no
longer prevents later independently verified generated fragments from being
compacted. A tool-certified model deliberately receives the full coding-agent
prompt and context instead.

For an Efficient Fidelity-certified LM Studio model, the full coding-agent
prompt and context are still retained. Only deferred tool definitions are kept
out of the initial LM Studio request and supplied later through Codex's
client-executed tool search. This reduces schema-prefill work without replacing
or trimming the Codex harness.

The improvement targets time spent processing the input; it does not make the
model generate tokens faster. For a meaningful comparison with LM Studio's
chat UI, start a new short Codex conversation, use an uncertified model, and
compare the uncached prompt tokens and time to first output in LM Studio's
server log. Project context, retained history, model loading, quantization, and
hardware can still dominate latency. See
[Troubleshooting](docs/TROUBLESHOOTING.md#lm-studio-takes-minutes-before-the-first-token)
if a new short turn still sends an unexpectedly large prompt.

`pickermux doctor` can report privacy-safe counters from the most recent
text-only request, including input and forwarded bytes plus omitted and retained
part counts. These counters stay in memory and never contain prompt text,
model/provider names, paths, hashes, or request and conversation identifiers.

## Efficient Fidelity

Efficient Fidelity is the low-overhead tool path for an exact, independently
certified LM Studio model. Codex remains the agent: it keeps the complete
instructions and conversation, searches its own deferred tool inventory,
executes the selected tools, and retains its normal sandbox and approval
controls. PickerMux only translates the public client-executed `tool_search`
round trip to and from LM Studio's supported function-call shape.

On the first model request, deferred function schemas are replaced by one
bounded search function. When the model requests a tool search, Codex performs
that search locally and returns the selected public tool definitions. PickerMux
then exposes only those selected deferred functions to LM Studio for the next
inference; functions that Codex did not defer remain advertised throughout. It
does not choose tools, execute them, approve actions, or act as a separate agent
or broker.

The optimization is additive to direct tool certification and is granted only
to the exact LM Studio model configuration that passes its own live tool-search
probe. If that additional evidence is missing, stale, or fails, the model keeps
the existing Direct fidelity path when its base tool receipt is still valid.
New or base-uncertified models remain text-only. There is no provider-wide
configuration switch that can bypass these model-bound receipts.

Version 0.6.0 deliberately uses Codex's full public replay for the tool-search
round trip and does not use `previous_response_id` as a history-compression or
session mechanism. Stateful continuation optimization remains future work.
Remote compaction can consume completed tool history but cannot create a new
executable call. Native Codex routes are unchanged and byte preserving.

The rejected broader Fast Agent design and the evidence behind this narrower
architecture are recorded in the
[Fast Agent feasibility report](docs/FAST_AGENT_FEASIBILITY.md).

<a id="shared-web-search"></a>

## Web search tool

Version 0.7.5 includes support for Codex's
client-executed `web.run` tool across registered, tool-certified external
models. Codex performs the search through the native search service and returns
the source text to the selected model. LM Studio continues to write the answer;
PickerMux makes no extra LM Studio inference request to execute the search.
This is separate from Efficient Fidelity's search for available tools.

Select a certified external model and ask, for example:

> Use web search to find the official venue of the Solheim Cup 2026. Answer
> with the venue, country, and an official source link in one sentence.

Codex should show an executed web search before the answer. You can then ask
the model to open the source and check a detail. An answer containing a link
alone does not prove that a search ran. Search requires Codex's native search
access and a valid tool certification for the exact external model; it is not
limited to a particular model family. Uncertified models remain text-only.

Search uses `bridge.webSearchModel`, or the existing native
`bridge.defaultModel` when that optional field is absent, as its native service
request parameter. It does not change the selected answer model or establish
which internal models the search backend uses or how it bills requests. Search
reuses the native credentials supplied by Codex; they stay on the native search
path and never reach LM Studio. No additional provider API key is configured.

PickerMux preserves Codex's search context, filters, and requested result
budgets. It does not cache or truncate results. For one reviewed, exact version
of the `web.run` description, it removes repeated explanations while retaining
the search and citation rules: 7,507 becomes 3,475 UTF-8 bytes, a 53.7% reduction
in that description. Tool schemas, conversation history, and returned source
text remain intact. Other description versions pass through unchanged.

Upgrade with the normal installer and fully restart Codex. If refreshing an
existing installation, use normal `refresh`. Install and refresh enable the standalone-search feature
only when no explicit feature setting exists; an existing `false` and
`web_search = "disabled"` remain respected. Uncertified models stay text-only;
run the usual [certification](#tool-certification) only when the model is ready
and no local-model task is active, then restart Codex again.

The endpoint is experimental. Its contract is covered by public Codex source
fixtures and offline tests. Native search and follow-up opening have passed
live smoke checks; external-model search, context compaction, and a correct
sourced answer were confirmed on 0.7.5. The
[acceptance record and procedure](docs/WEB_SEARCH_ACCEPTANCE.md) distinguish
observed checks from remaining coverage. Tool availability cannot
guarantee that every model chooses to search or interprets results correctly.
See [Configuration](docs/CONFIGURATION.md#shared-web-search) and
[Troubleshooting](docs/TROUBLESHOOTING.md#web-search-is-missing-or-fails).

## Upgrade

Version 0.9.0 adds the optional companion and its versioned control protocol.
Existing healthy configurations retain the explicit provider. Configuration
cleanup and replacement of an Ollama gateway require a reviewed preview and
confirmation. See [the companion guide](docs/MACOS_COMPANION.md) before using
an unsigned development app or preparing a signed release.

Version 0.8.3 checks the exact-version Codex account cache before contacting
external providers and points a blocked refresh to `refresh --full`. The
uppercase `--FULL` alias uses the same confirmation and safety checks.
If PickerMux is already uninstalled, first open Codex natively while signed in
until its model picker loads, fully quit it, and then run the
[0.8.3 installer](#install).
If managed blocks were edited, review them before using forced uninstall.
See the [0.8.3 release notes](docs/RELEASE_NOTES_0.8.3.md) and
[update recovery](docs/TROUBLESHOOTING.md#refresh-reports-an-account-cache-version-mismatch-after-a-codex-update).

Version 0.8.2 keeps historical chats parseable after normal
`pickermux uninstall` and `uninstall --remove-cli`. For a chat already broken by
an older uninstall, use the [repair command](#repair-historical-chats) before
regular setup.
The [0.8.2 release notes](docs/RELEASE_NOTES_0.8.2.md) explain the recovery
and its validation limits.

Version 0.8.1 makes a blocked upgrade easier to diagnose when the managed Codex
configuration was edited. Setup still refuses to overwrite it. Review the edit
before using the explicit forced-uninstall recovery described in the
[0.8.1 release notes](docs/RELEASE_NOTES_0.8.1.md) and
[Troubleshooting](docs/TROUBLESHOOTING.md#uninstall-refuses-modified-configuration).

Version 0.8.0 added automatic installation-time model certification and progress
reporting. It retained the Codex executable discovery fix from 0.7.6 and the web
search and context compaction from 0.7.5. Upgrade through the normal release
installer. Do not replace immutable package files or bypass a same-version
checksum mismatch. Setup retains valid tool certifications and tests only
models whose base certification is missing, stale, or pending recovery. See the
[0.8.0 release notes](docs/RELEASE_NOTES_0.8.0.md) for certification behavior and
its validation limits.

PickerMux never updates silently. Run the same latest-release installer again
to stage and activate a newer version. A healthy installation is refreshed
transactionally; failed activation restores the previous CLI and bridge state.
The same version is safe to run again, while an implicit downgrade is refused.
Setup checks the account-scoped Codex model cache before staging, repeats the
check under the lifecycle lock, and checks it again immediately before
activation. A missing or client-version-mismatched cache leaves the active
installation unchanged. Once v0.5.4 is active, later account-cache recovery can
use `pickermux refresh --full` without a destructive reinstall. Fully quit Codex
Desktop with `Command-Q` before running setup. After the installer completes,
repeat the
[verification commands](#verify-the-installation), then reopen Codex Desktop so
it loads the new catalog.

## Uninstall

Fully quit Codex Desktop with `Command-Q` before running any uninstall mode.

Remove only the Codex integration, LaunchAgent, and managed runtime with:

```bash
pickermux uninstall
```

To remove the integration and the receipt-owned CLI distribution as well, use:

```bash
pickermux uninstall --remove-cli
```

Verified configuration backups and provider credentials in the macOS Keychain
are deliberately retained in both cases. PickerMux never removes unrecognized
launcher files or distribution paths.

For a canonical `model_bridge` integration, the current CLI's normal uninstall
and `uninstall --remove-cli` leave an inert, marker-bounded provider table in
`config.toml` so historical PickerMux chats can still open. Full purge already
preserved that table. After removing PickerMux, reopen an affected chat and
select a native model before continuing.

For an explicit full removal, including verified PickerMux backups and every
PickerMux provider credential identified by its private, secret-free provider
registry, use:

```bash
pickermux uninstall --purge
```

`--purge` implies `--remove-cli`. Runtime, CLI, backup, and registry state is
inventoried and revalidated using installation receipts, SHA-256 hashes, and
device/inode identity before exact entries are removed. State observed as
modified, foreign, ambiguous, or concurrently replaced fails closed and remains
available for review; PickerMux does not recursively delete an untrusted
directory. Ownership-sensitive cache, configuration, receipt, runtime, backup,
and registry files are rejected before payload reads when they are symbolic or
multiply linked. The same-user final-syscall race boundary is documented in
[SECURITY.md](SECURITY.md), together with recovery semantics for a partial
multi-item Keychain deletion. Full purge never reads, changes, or removes
native Codex authentication, including `~/.codex/auth.json`.

The canonical `model_bridge` compatibility table has no credentials, targets
`127.0.0.1:0`, and has zero request and stream retries, so turns through it fail
locally. A later PickerMux installation removes only the exact unchanged table
as part of its atomic configuration update; a modified or foreign table remains
a fail-closed conflict. Its marker records only whether the restored config
must remain a file, without recording user content. An uninstall retains
surviving user bytes while adding the compatibility table.

## Why PickerMux

Running a model in LM Studio is straightforward. Using it repeatedly inside
Codex Desktop is where friction usually starts: provider changes, model IDs,
context settings, and separate launch modes interrupt the flow.

PickerMux turns that setup into a short, repeatable workflow while staying
deliberately conservative:

- **Load, refresh, select.** Models currently loaded in LM Studio are discovered
  and added to the normal Codex Desktop picker.
- **One familiar interface.** Move between local models without maintaining a
  collection of Codex profiles or editing configuration for every switch.
- **No fake capabilities.** Context size and reasoning options come from the
  loaded LM Studio instance. PickerMux never inflates a model's context window.
- **Safe model defaults.** Newly discovered external models start in text-only
  mode. The bridge enforces the text-only boundary, reduces verified generated
  bootstrap for faster prompt prefill, and rejects forced tool turns until that
  exact model and configuration pass a live certification matrix. Dedicated
  memory and multi-agent bootstrap remain removable across wording changes,
  while unknown kinds, wrong roles, malformed shapes, and unrecognized
  envelopes are retained conservatively. See
  [Text-only performance](#text-only-performance).
- **Efficient Fidelity.** An additionally certified LM Studio model keeps the
  full Codex harness while Codex supplies deferred tool schemas only when the
  model searches for them. A missing or stale additive receipt falls back to
  Direct fidelity rather than creating a reduced chatbot or a second agent.
- **Credential isolation.** Native Codex authentication and metadata are never
  forwarded to LM Studio or another external provider, including Codex client
  metadata carried inside a Responses request body.
- **Transactional lifecycle.** Install, refresh, rollback, diagnostics, and
  uninstall are designed as one managed workflow rather than a collection of
  manual edits to `~/.codex`.
- **Live compatibility quarantine.** The service rechecks Codex when the
  executable changes and refuses model traffic until PickerMux is refreshed if
  the installed client/catalog contract no longer matches.
- **Small supply-chain surface.** The runtime has no third-party npm
  dependencies.

## How it works

PickerMux uses Codex's documented custom-provider configuration and the
[`model_catalog_json`](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml)
catalog loaded at application startup.

```mermaid
flowchart LR
    C[Codex Desktop] -->|one loopback provider| B[PickerMux bridge]
    B -->|native model slug<br/>approved native headers| O[Native Codex backend]
    B -->|namespaced model slug<br/>clean provider headers| L[LM Studio Responses API]
    D[Loaded-model discovery] --> B
    B --> K[Generated mixed catalog]
    K -. loaded at startup .-> C
```

The bridge listens only on `127.0.0.1` behind a randomly generated capability
path. Native model slugs remain on the native Codex route. External model slugs
are namespaced, resolved through an immutable provider registry, and sent with
a newly constructed header set.

See [Architecture](docs/ARCHITECTURE.md) for the complete trust boundary,
catalog lifecycle, request normalization, and certification design.

## Commands

| Command | Purpose |
| --- | --- |
| `pickermux --version` | Print the exact PickerMux release version. |
| `pickermux setup [--config PATH] [--json]` | Install or upgrade, then certify discovered models without a valid tool receipt. |
| `pickermux discover` | List external models that are safe to publish from the current provider state. |
| `pickermux build` | Build and validate a mixed catalog without installing it. |
| `pickermux install` | Install the catalog, configuration, and bridge service, then certify models without a valid tool receipt. |
| `pickermux refresh` | Rediscover models and atomically refresh the catalog and runtime. |
| `pickermux refresh --full` | Interactively suspend PickerMux, refresh Codex account visibility, transactionally reactivate it, and reopen Codex. |
| `pickermux status` | Show managed configuration, service, and compatibility status. |
| `pickermux companion status` | Return a version-1, secret-free status snapshot for the macOS companion. |
| `pickermux companion run` | Execute one strictly bounded, versioned JSON request read from stdin. |
| `pickermux doctor` | Run deterministic installation and routing checks. |
| `pickermux doctor --live` | Add a real LM Studio inference check. |
| `pickermux repair-chats [--json]` | Restore the inert historical `model_bridge` table after an older uninstall, without setup. |
| `pickermux certify --model SLUG` | Run the base live tool-use matrix and the LM Studio Efficient Fidelity probe for one model. |
| `pickermux certify --all` | Run the applicable model-bound certification probes for every discovered external model. |
| `pickermux credential-set PROVIDER` | Store a provider credential interactively in the macOS Keychain. |
| `pickermux credential-status PROVIDER` | Report only whether a provider credential is available. |
| `pickermux credential-delete PROVIDER` | Delete the named provider's Keychain item. |
| `pickermux uninstall` | Restore previous Codex settings and remove managed runtime files; canonical `model_bridge` installations retain historical chat parsing. |
| `pickermux uninstall --remove-cli` | Also remove only the receipt-owned CLI launcher and versioned distribution. |
| `pickermux uninstall --purge` | Remove the integration, receipt-owned CLI, verified backups, and registered provider Keychain credentials; canonical `model_bridge` installations retain the inert chat table. |

Run `pickermux help`, `pickermux --help`, or `pickermux -h` for the compact CLI
reference. `bin/lmstudio-picker.mjs` remains available as a compatibility alias.

When running directly from a development clone, replace `pickermux` with
`./bin/pickermux.mjs`.

## Model discovery

The default `loaded` mode reads LM Studio's `/api/v1/models` metadata and
publishes only models that are currently loaded as LLMs. Embedding models,
unloaded models, invalid identifiers, foreign namespaces, and models without a
confirmed loaded context size are excluded.

For multiple loaded instances of the same model, PickerMux uses the smallest
reported context window. Models below 32,768 tokens receive a visible warning
marker in the picker, but their real context value remains unchanged.

If LM Studio is intentionally stopped, PickerMux publishes a native-only
catalog the next time synchronization is allowed. If the selected local model
disappears, the managed selection returns to the configured native fallback.
Transient discovery failures keep the last known good catalog instead of
silently erasing models.

## Tool certification

Every new external model starts conservatively with no Codex tool surface. A
live certification run first verifies text, streaming, direct functions,
parameterless functions, namespaced functions, tool results, and long-context
behavior. A base pass grants Direct fidelity. For LM Studio, PickerMux then
runs a separate client-executed tool-search probe; its pass is recorded as an
additive Efficient Fidelity gate. Both forms of evidence are bound to the
provider, model, context, capability metadata, and Codex client version.

`setup` (including the release installer) and `install` run this certification
automatically after installation for models without a valid base receipt.
They preserve valid Direct receipts even if Efficient Fidelity is unavailable.
To explicitly retest a model or try Efficient Fidelity again, use `certify`:

```bash
pickermux certify --model lmstudio/qwen/qwen3.8-27b
```

If any bound property changes, the receipt becomes stale and the model falls
back to text-only mode. If only the additive tool-search probe is unavailable
or fails while the base receipt remains valid, the model uses Direct fidelity
with the full tool schemas. Certification sends real prompts to the selected
model; do not run it in parallel with an active local-model turn.

Re-certification uses a persistent deactivation barrier. Once the running
service observes it, every new ordinary request to the target is blocked even
when that process has an older registry; a request already admitted before the
barrier may finish. PickerMux then publishes a verified text-only catalog
before allowing the private probe transport. If that transition is
interrupted, the model remains quarantined; correct the reported problem and
rerun the same `pickermux certify` command to recover safely.

## Security model

PickerMux treats the bridge as a security boundary, not just a convenience
proxy.

- It never reads `~/.codex/auth.json`.
- ChatGPT tokens, cookies, account identifiers, attestation data, and Codex
  metadata are stripped before every external request.
- Native credentials are forwarded only to native inference or standalone
  search destinations; external models never receive them.
- External requests receive a fresh allowlisted header set.
- Uncertified external routes are transport-enforced as text-only even if the
  client submits function schemas; the private certification marker is never
  forwarded upstream.
- Provider secrets can be stored under provider-specific macOS Keychain items;
  they are never written to project configuration or status output.
- Inline secrets, URL credentials, wildcard model lists, unapproved private
  network targets, path traversal, and unsafe configuration ownership fail
  closed.
- Configuration changes, catalogs, compatibility data, service files, and
  rollback state are written privately and transactionally.
- A missing managed provider end marker is accepted only when one unique
  virtual reinsertion recreates the receipt-recorded block digest at a safe
  line boundary before the next TOML table; blank or comment-only tail lines
  are preserved, while ambiguous or edited state remains blocked.
- If that exact recovered-marker state coincides with a failed initial account
  cache preflight, the downloaded setup payload atomically restores only the
  receipt-proven marker so an older installed CLI can complete recovery; active
  CLI and runtime state are not changed.
- Release payloads are versioned, checksum-verified, and extracted only after
  unsafe paths and file types have been rejected.
- Companion requests use fixed actions and explicit recovery/switch consent;
  no caller-selected executable, path, provider, or `--force` is accepted.
  GUI snapshots and progress omit credentials, capability paths, account/model
  identifiers, prompts, and raw diagnostics.
- Uninstall inventories and revalidates exact owned paths before removal. Full
  purge refuses modified or foreign runtime, distribution, backup, and
  provider-registry state instead of deleting it recursively.

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability or sharing
diagnostic output.

## After Codex or LM Studio updates

Run:

```bash
pickermux status
pickermux doctor
```

If `managed-config` is `modified`, review the edit and follow the
[modified-configuration recovery](docs/TROUBLESHOOTING.md#uninstall-refuses-modified-configuration)
before retrying the installer. Do not run `refresh --full` in that state.

Otherwise, if compatibility is reported as `update-required`, rerun the latest-release
installer. Setup performs the cache check at all three activation barriers and
does not change active PickerMux state when the cache still belongs to an older
Codex version. If the receipt-active installed CLI is v0.5.4 or newer and the
managed configuration and receipt-owned runtime are intact, run
`pickermux refresh --full` and follow its
confirmation and recovery output. If the active release predates that command
or the integration is already absent, follow setup's manual recovery: run
`pickermux uninstall` first if the older integration remains installed, launch
Codex while signed in, wait for its native picker to load, fully quit with
`Command-Q`, and rerun setup with the same custom configuration, if one was
used. Do not delete `models_cache.json` or `~/.codex/auth.json` as a workaround.

After uninstall, fully quit and reopen Codex. In an existing PickerMux chat,
select a native model before sending another turn. The retained historical
provider table lets the chat open but cannot serve requests, so sending through
it can show “Connection failed: error sending request.” `--force` only resolves
an explicitly reviewed managed-configuration conflict; it does not refresh the
account cache or change a chat's selected provider.

See [Troubleshooting](docs/TROUBLESHOOTING.md) for recovery procedures and
redaction guidance.

## Current scope and limitations

- PickerMux currently supports macOS only.
- Picker catalog changes require a full Codex Desktop restart; there is no
  supported live catalog reload.
- `refresh --full` changes real macOS application and LaunchAgent state. Unit
  tests cover its state machine and failure paths, but a release still requires
  a live macOS acceptance run with Codex Desktop.
- Access-controlled native models appear only when the authenticated account
  is entitled to them.
- Local quality, tool reliability, and latency depend on the selected model,
  quantization, context size, hardware, and LM Studio configuration.
- If LM Link chat works but a Codex request reports `Channel Error`, inspect
  the nested error. PickerMux 0.6.1 fixes the strict prompt-template failure
  `System message must be at the beginning` caused by separate top-level
  instructions and system/developer input; [upgrade](#upgrade) from 0.6.0 to
  receive the fix. Other nested errors require their own diagnosis; see the
  [troubleshooting guide](docs/TROUBLESHOOTING.md#lm-studio-reports-channel-error-or-a-context-length-failure).
- Efficient Fidelity reduces the initial deferred-tool schema payload; it does
  not compact project instructions, conversation history, selected skills, or
  other Codex harness context, and v0.6.0 does not reuse provider-side response
  state through `previous_response_id`.
- `setup`, `install`, `doctor --live`, and certification can perform real
  provider inference and take several minutes per model.
- Codex and LM Studio updates can change compatibility. The running bridge
  quarantines model traffic when its installed contract is no longer verified;
  its private health endpoint remains available so `status` and `doctor` can
  explain the required refresh without a LaunchAgent restart loop.

## Development

For an auditable development installation from a clone:

```bash
git clone https://github.com/patrickschiller/pickermux.git
cd pickermux
npm run verify
./bin/pickermux.mjs discover
./bin/pickermux.mjs install
```

The clone remains the source for these direct commands; use the release
installer for the managed, versioned end-user CLI.

```bash
npm test
npm run check
npm run verify
```

Automated coverage includes catalog construction, routing, credential
isolation, lifecycle rollback, release packaging, installer failures,
discovery, tool normalization, and compatibility handling. CI runs on macOS
with Node.js 22.15, 24, and 26.

The native companion has separate Swift protocol, process, and ownership tests,
plus a universal app build. See [companion development and release checks](docs/MACOS_COMPANION.md#development-and-distribution).

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), follow
the [Code of Conduct](CODE_OF_CONDUCT.md), and use [SUPPORT.md](SUPPORT.md) to
choose the right support channel.

## License

PickerMux is released under the [MIT License](LICENSE).

OpenAI, Codex, ChatGPT, LM Studio, and all other product names are trademarks of
their respective owners. Their use here is descriptive and does not imply
affiliation or endorsement.
