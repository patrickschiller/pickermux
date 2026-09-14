# PickerMux 0.7.4

Prepared locally on 2026-09-14; not published. Complete the
[candidate acceptance procedure](WEB_SEARCH_ACCEPTANCE.md) before publishing.

Version 0.7.3 could complete web search and context compaction, then return only
a sentence fragment. The restored summary was the last assistant message in the
request. LM Studio interprets that shape as assistant response prefill, so it
continued the summary rather than beginning a new answer. In the observed test,
the correct venue and source were already present in the summary.

PickerMux now closes an authenticated terminal summary with one short, fixed
user-role instruction to continue the existing task. The model-generated
summary remains assistant context and is described as fallible. No instruction
is added when later user/tool input exists, during another compaction, or on
native requests. No additional inference or automatic retry is introduced.

The v1 encrypted-state format and its model/key binding remain unchanged.
Upgrade the immutable 0.7.3 package through normal setup, then restart Codex.
Keep a still-valid model certification and avoid `refresh --full`.

The recorded 13 minutes 58 seconds consisted mainly of prompt processing:
26,195 tokens before search, 19,556 for the summary, and 26,268 for the following
answer. Restoring Codex's system context and tools prevented a smaller ordinary
prompt. This correction does not claim to solve that performance limitation.
Offline tests cover the exact terminal-summary shape with LM Studio's prefill
semantics; live completion with the fixed candidate remains pending.

PickerMux is an unofficial community project. It is not affiliated with,
endorsed by, or supported by OpenAI, Codex, or LM Studio.
