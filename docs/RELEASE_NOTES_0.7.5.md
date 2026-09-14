# PickerMux 0.7.5

PickerMux 0.7.5 adds shared web search for tool-certified external models in
Codex Desktop, fixes LM Studio Link certification and streaming errors, and
supports Codex context compaction with reliable continuation. It also reduces
the work sent to LM Studio when a conversation needs summarizing. These notes
cover the complete changes since the previous public release, 0.6.1.

## Shared web search from the same model picker

The selected external model can use Codex's `web.run` tool to retrieve sources
and then write its own answer. Search requests go to the fixed native Codex
search backend; answer requests remain on the selected external provider.
The search path requires a valid certification for the exact external model
and configuration. Uncertified models retain their conservative text-only
mode, and existing settings that disable web search remain effective.

- Search execution adds no LM Studio inference call, result-summary pass,
  result cache, or result truncation. Query generation and answering still
  require model turns; context compaction can require its own summary call.
- Optional `bridge.webSearchModel` chooses the native model parameter for
  search requests, defaulting to `bridge.defaultModel`. This does not switch
  the answer model or identify the search backend's internal models.
- One reviewed, SHA-256-pinned web-tool description is reduced from 7,507 to
  3,475 UTF-8 bytes while retaining its search and citation rules. Unknown or
  edited descriptions remain unchanged, as do schemas and search budgets.
- Install and ordinary refresh migrate the managed search configuration
  transactionally. Explicit user settings and rollback protections remain in
  place.

Tool availability does not guarantee that every model searches, follows its
sources correctly, or produces an accurate answer.

## LM Studio and LM Link fixes

- **Certification transport:** probes use bounded HTTP transport that respects
  their configured deadlines instead of Node's independent `fetch` timeout.
  A complete live certification passed through LM Link during validation.
  With LM Link, keep the Mac's local LM Studio endpoint; LM Studio forwards
  inference to the linked device internally.
- **Useful stream errors:** failures before transformed output starts return a
  structured error. After streaming starts, a connected client receives a
  failed-response event with a fixed, redacted reason. Header, idle, and total
  timeouts are distinguished without increasing their limits or fabricating
  successful output.
- **Context compaction:** Codex's `compaction_trigger` now produces one bounded
  summary request to the selected LM Studio model without tool schemas.
  Supported text history, tool-call identities, results, and source URLs are
  preserved as transcript data. A completed summary is stored in an
  authenticated encrypted envelope bound to the installation and exact model
  configuration; malformed controls, unsupported input, and invalid state fail
  safely.
- **Complete answers after compaction:** restoring a terminal summary adds a
  short, fixed continuation instruction. This prevents LM Studio from treating
  the assistant summary as response prefill and returning only a sentence
  fragment. The generated summary retains assistant authority, and ordinary
  continuation adds no extra inference call.

## Less work during summarization

Only exact LM Studio V2 summary requests omit the separately supplied
top-level `instructions`, after validation and before message merging. Codex
keeps those base instructions outside compacted history and sends them again
when answering. Every conversation input message remains, including historical
system/developer instructions and retrieved evidence. Ordinary requests,
legacy compaction, native routes, and other providers retain their existing
behavior. Summary and continuation guidance also distinguish completed
research from remaining work so recorded results can be reused when suitable.

An offline reconstruction reduced one observed summary request's JSON body
from 73,012 to 51,426 bytes: **29.6% smaller**. This measures bytes, not tokens
or elapsed time. In one user's live comparison, the first question took about
**8 minutes** with 0.7.5 after taking **16 minutes 56 seconds** with 0.7.4;
the user reported that the second question was faster. This is an observation
from one configuration, not a controlled benchmark or a speed guarantee for
other models or hardware.

The initial full Codex prompt remains substantial. Model loading, prompt
caching, reasoning, repeated searches, and further compactions still affect
latency. Summaries are model-generated and lossy; a successful summary does not
guarantee that the next request fits the model's context window.

## Upgrade and try it

Save active work and fully quit Codex Desktop with **Command-Q**. Keep the
intended model loaded and the LM Studio server running, then run the versioned
installer from Terminal:

```bash
/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL https://github.com/patrickschiller/pickermux/releases/download/v0.7.5/install.sh | /bin/sh
```

The installer verifies the versioned payload and uses normal transactional
setup. A healthy existing installation retains its provider configuration and
still-valid model certification. No extra refresh or recertification is needed
solely for this upgrade. Check the installed version and service:

```bash
~/.local/bin/pickermux --version
~/.local/bin/pickermux status
~/.local/bin/pickermux doctor
~/.local/bin/pickermux discover
```

Require `pickermux 0.7.5`, a running bridge, and passing compatibility checks.
Only if the intended model lacks a valid certification, copy its exact slug
from `discover` and certify it while no model task is active:

```bash
~/.local/bin/pickermux certify --model 'lmstudio/<exact-discovered-model-slug>'
```

Reopen Codex, select that model, and start a new task:

> Use web search to find the official venue of the Solheim Cup 2026. Keep
> search results short. Answer with venue, country, and an official source
> link in one sentence.

Check that `web.run` executes and that the answer matches the linked official
page. Then ask the model to open that source with the web tool and give the
competition dates. Record elapsed time for both questions if comparing
performance. The [acceptance guide](https://github.com/patrickschiller/pickermux/blob/v0.7.5/docs/WEB_SEARCH_ACCEPTANCE.md)
includes compaction, native-route, and recovery checks; a sourced-answer smoke
test does not establish that the entire manual lifecycle matrix has passed.

Use normal setup for this upgrade, **not `refresh --full`**. Ordinary service
restarts, refresh, and upgrades preserve the compaction key. Full refresh and
uninstall/reinstall replace the installation capability, making earlier
compacted state unavailable. Existing 0.7.3 and 0.7.4 envelopes remain compatible
after a normal upgrade; switching provider or model with compacted state
requires a new task. See [configuration and recovery details](https://github.com/patrickschiller/pickermux/blob/v0.7.5/docs/CONFIGURATION.md#lm-studio-context-compaction).

## Security and release assets

Native authentication and Codex metadata never reach an external provider.
Search uses only the native destination, external requests retain their exact
route and certification checks, and native proxy paths remain byte preserving.
Compacted state cannot cross the native/external boundary or migrate silently
to another model configuration. The runtime still has no third-party npm
dependencies.

This release contains all four generated assets:

- [pickermux-v0.7.5.tar.gz](https://github.com/patrickschiller/pickermux/releases/download/v0.7.5/pickermux-v0.7.5.tar.gz): versioned runtime payload.
- [install.sh](https://github.com/patrickschiller/pickermux/releases/download/v0.7.5/install.sh): installer with the exact payload version and SHA-256 embedded.
- [release-manifest.json](https://github.com/patrickschiller/pickermux/releases/download/v0.7.5/release-manifest.json): version, supported runtime, payload allowlist, and file digests.
- [SHA256SUMS](https://github.com/patrickschiller/pickermux/releases/download/v0.7.5/SHA256SUMS): checksums for the archive, installer, and manifest.

PickerMux requires macOS, Node.js 22.15.0 or newer, a compatible signed-in Codex
Desktop installation, and LM Studio with the intended model loaded. Automated
coverage exercises routing, credential isolation, transport failures,
compaction validation, encrypted replay, and lifecycle rollback; model-specific
live behavior remains dependent on the tested configuration.

PickerMux is an unofficial community project. It is not affiliated with,
endorsed by, or supported by OpenAI, Codex, or LM Studio.
