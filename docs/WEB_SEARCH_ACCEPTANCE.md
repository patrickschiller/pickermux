# Web-search acceptance and 0.7.5 validation

This short test checks the experimental search path with a real Codex Desktop,
LM Studio, and native search backend. It changes the local
installation when you run `setup` and sends real model/search requests during
certification and the conversation tests. It does not replace the
[release-blocking manual lifecycle matrix](RELEASING.md#manual-acceptance-matrix).

PickerMux is an unofficial community project and is not affiliated with OpenAI,
Codex, or LM Studio.

## Current evidence and remaining checks

Native `web.run` search and follow-up source opening passed live smoke checks.
The installed 0.7.1 candidate then passed all eight base certification gates and
the additive tool-search gate; the installed catalog advertises that measured
capability. Preserve this certification when its bound model configuration is
unchanged. A subsequently selected model was initially text-only and produced
an ungrounded answer; certification is model-specific and does not transfer.
After that model was certified on 0.7.2, a real `web.run` call was observed.
The next request failed on LM Studio's rejection of `compaction_trigger`.
On 0.7.3, web search and compaction then completed successfully. The search
result and encrypted summary both contained the correct venue, country, and
official source. The following ordinary request ended in an assistant summary,
which LM Studio treated as response prefill; the visible result was only a
sentence fragment. The user then confirmed a correct sourced answer on 0.7.4.
Its recorded run took 16 minutes 56 seconds and performed three compactions
totalling approximately 10 minutes 50 seconds. Repeated searches were followed
by another summary each time. Ordinary continuation requests already reused
over 26,000 cached input tokens. Dedicated follow-up source-opening acceptance
remains pending.

A subsequent Codex task disconnected after ten minutes while LM Studio was
still processing its prompt. Progress reached 29% after roughly eight minutes;
the disconnect matched the configured 600,000 ms stream idle limit. This
establishes the timeout boundary, not the cause of slow model processing. The
0.7.2 stream fix, also included in 0.7.5, improves reporting without raising
timeouts or changing ordinary model requests.
Its live timeout-reporting acceptance remains pending. See
[stream timeout troubleshooting](TROUBLESHOOTING.md#stream-disconnects-during-prompt-processing).

Version 0.7.5 reduces only requested summaries by omitting separately supplied
base instructions before message merging; all conversation messages and
ordinary requests remain intact. Summary and continuation guidance explicitly
distinguish completed research from pending work. No new inference, cache
setting, tool block, or automatic retry is introduced. An offline reconstruction
reduced the first observed summary's JSON body from 73,012 to 51,426 bytes
(29.6%). This is not a token or latency measurement.
On 2026-09-14, the user confirmed a correct answer on 0.7.5 in about eight
minutes and a faster second request, then requested publication. This is a
reported observation on one setup; cache state and repeated tool calls were
not controlled, so it is not a general benchmark. This confirms the targeted
search/compaction/answer workflow. Dedicated source-opening, restart replay,
and the full clean-install/uninstall/purge matrix were not all rerun during
this release session and are not represented as completed live checks.
The summary limit does not guarantee a fitting continuation: Codex restores
system context, tool definitions, and retained messages. Record repeated
compaction after tool steps or a context-limit error as a failed acceptance
check, rather than assuming that a successful summary completes the test.

## Prepare a local release build

Use the locally built assets in `dist/v0.7.5/` and the extracted candidate in
`dist/v0.7.5-test/`. Run these commands from the repository root. The generated
`install.sh` downloads published assets. Use the extracted local CLI when
testing a build before it is published. An installed 0.7.4 package is immutable: upgrade it to
0.7.5 through normal setup rather than replacing same-version files or
bypassing content checks.

Check the local asset digests:

```bash
(cd dist/v0.7.5 && shasum -a 256 -c SHA256SUMS)
```

If the candidate has not already been extracted, create a new directory without
replacing an existing one:

```bash
mkdir dist/v0.7.5-test
tar -xzf dist/v0.7.5/pickermux-v0.7.5.tar.gz -C dist/v0.7.5-test
```

Confirm the candidate reports `pickermux 0.7.5`:

```bash
node dist/v0.7.5-test/bin/pickermux.mjs --version
node dist/v0.7.5-test/bin/pickermux.mjs --help
```

## Activate and verify the installed build

Save active work and fully quit Codex with **Command-Q**. Keep LM Studio's
server running with the intended model loaded. From a separate Terminal, run:

```bash
env -u PICKERMUX_CONFIG_PATH node dist/v0.7.5-test/bin/pickermux.mjs setup
```

Keep the model loaded for the comparison; do not restart LM Studio or reload
the model just to test this candidate. Record whether the initial request reused
cached context so a warm run is not presented as an equivalent cold-start speedup.

For an existing healthy installation, omitting `--config` reuses its installed
provider configuration. The command above also removes an inherited source-file
override for this invocation. For a fresh installation requiring custom
settings, add `--config /absolute/path/to/pickermux.config.json` instead.
`setup` activates the candidate and refreshes the bridge; no additional refresh
is needed at this point. If setup fails, follow its recovery message and do not
continue testing an older active build.
Use ordinary setup for this upgrade. `refresh --full` replaces the capability
used for compaction encryption and makes earlier compacted state unavailable.

Check the installed launcher and the installed runtime package, not the checkout
CLI. The direct runtime command below reads its version only:

```bash
~/.local/bin/pickermux --version
node "${CODEX_HOME:-$HOME/.codex}/model-bridge/runtime-app/bin/pickermux.mjs" --version
~/.local/bin/pickermux status
~/.local/bin/pickermux doctor
~/.local/bin/pickermux discover
```

Require version `0.7.5` from both packages, `bridge=running`, compatible status,
and passing doctor checks. The following prints only safe service state and the live search
contract; require `contract: 1`:

```bash
~/.local/bin/pickermux status --json | node --input-type=module -e '
let input = "";
for await (const chunk of process.stdin) input += chunk;
const s = JSON.parse(input);
console.log(JSON.stringify({bridge: s.service?.status, contract: s.service?.health?.webSearchContractVersion, compatibility: s.compatibility?.status}));
'
```

Copy the exact namespaced model slug from `discover`. Keep an existing valid
Direct or Efficient Fidelity certification; the version upgrade alone is not
a reason to rerun certification. Only if the intended model is
uncertified or its bound configuration changed, certify only that model while
Codex is still quit; replace the placeholder below:

```bash
~/.local/bin/pickermux certify --model 'lmstudio/<exact-discovered-model-slug>'
```

If certification was necessary, require `PASS certification`. An additive Efficient Fidelity failure may leave
a valid Direct fallback, which is sufficient for web search. Do not edit
certification receipts or grant tools manually. If a probe fails, record its
fixed probe label and `CERTIFICATION_*` code, inspect the reported condition,
and leave the result pending; do not repeatedly start long retries or change
reasoning defaults to claim a pass. Certification already refreshes
the catalog. If the loaded model changes later, use the installed launcher's
normal `refresh`, then fully restart Codex.

Existing `features.standalone_web_search = false` or `web_search = "disabled"`
intentionally prevents this search test. Review those explicit user settings
before proceeding; PickerMux does not overwrite them.

## Short conversation tests

Reopen Codex and start a new task without project files or attachments. Select
the exact local model with its existing intended reasoning level. Use:

> Use web search to find the official venue of the Solheim Cup 2026. Keep search
> results short. Answer with venue, country, and an official source link in one
> sentence.

Require a successful, visible `web.run` search followed by a sourced answer.
A plausible answer without an executed search does not pass. Open the official
link yourself and compare it with the answer.

For the performance comparison, record total elapsed time, the number of web
calls, and the number of automatic compactions for this first question. Compare
with the 0.7.4 baseline of 16 minutes 56 seconds and three compactions. A smaller
summary body alone does not prove a faster or equally correct answer.

Then test search continuation:

> Open that official source with the web tool. Give the competition dates in
> one sentence with the source link.

Require a successful tool call and consistent dates. A single explicit retry
can distinguish a model declining to search from a transport error; do not
repeat certification or long inference runs to work around a failed endpoint.

If Codex requests compaction after the result, require that it completes and
the task continues to a complete sourced answer, not a continuation fragment
of the summary. If this short task does not naturally
compact, exercise Codex's normal manual compaction action once, then ask for the
dates from the prior source. Require a successful summary and same-model
continuation; never inject control items or edit the recorded encrypted state.
Restart Codex and continue that task once to verify key continuity. Model or
provider switching requires a new task when the existing task has PickerMux
compacted state; do not interpret that explicit restriction as a search failure.

In a separate new task, select a native Codex model. First request
`Reply exactly PICKERMUX_NATIVE_OK`, then repeat the short venue search. Require
normal text streaming and a successful search. This checks that native usage
still works through the shared picker.

Search execution adds no LM Studio inference request of its own. Query
generation and answering still require model turns. If LM Studio exposes
prefill-token counts and time to first token, record only those numbers; model
loading, retained history, reasoning, and hardware affect the result.

If the request times out while LM Studio reports prompt processing, record the
fixed timeout code and elapsed time. Before transformed output starts, require
a structured HTTP error; after SSE output has started, require a failed
response with the fixed reason visible in Codex. Neither case may report
successful completion. Do not recertify a still-valid model or
repeat long requests solely to reach a pass. Follow the troubleshooting guide
before retrying. The timeout fix improves the error report; it does not make
model prefill faster.

## Record the result

Keep only versions, pass/fail outcomes, numeric timing/token counts, and fixed
error codes. Do not share raw status JSON, logs, configuration, account details,
capability URLs, private model slugs, or conversation exports.

```text
Test build / installed CLI / runtime package: 0.7.5 / 0.7.5 / 0.7.5
macOS / Node.js / Codex / LM Studio versions:
Bridge: running; compatibility: compatible; search contract: 1
Selected local model certification: existing valid / new pass / fail
Transformed external timeout reporting: pass / pending (error code)
External search and follow-up open: pass / fail (error code)
Local context compaction and same-model continuation: pass / pending / fail
Complete new answer after terminal compaction: pass / pending / fail
First question elapsed time / web calls / automatic compactions:
Initial request cold or cached / cached input tokens when available:
Continuation after Codex restart: pass / pending / fail
Native text and search: pass / fail (error code)
Optional uncached input tokens / time to first token:
```

A failed live search leaves this feature's backend acceptance unverified even
when every offline test passes. Resolve it before recording a release pass.
