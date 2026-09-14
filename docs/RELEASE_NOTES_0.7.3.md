# PickerMux 0.7.3

Prepared locally on 2026-09-14; not published. Complete the
[candidate acceptance procedure](WEB_SEARCH_ACCEPTANCE.md) before publishing.

After an external model uses a web tool, Codex can ask the shared provider to
compact its context. Previously PickerMux forwarded the native-only
`compaction_trigger` input item to LM Studio, which rejected the request with
`Invalid type for 'input'` / `invalid_union`.

PickerMux now translates that operation into one bounded text-summary request
to the selected LM Studio model. It includes supported text history and source
URLs as data, omits tool schemas, and grants no tools to the summarizer. Only a
completed, nonempty summary produces an authenticated encrypted compaction item.
Later requests to the same installation and model configuration restore it as
assistant context. Ordinary requests add no inference.

Invalid or foreign state, unsupported media, truncated responses, and unexpected
tool calls fail safely. Compacted state cannot move between LM Studio and
native/other provider routes. Native requests without PickerMux-owned state
remain byte preserving. Summaries depend on model quality; the adapter cannot
guarantee factual completeness or that every prompt fits the loaded context.

Upgrade the immutable 0.7.2 package with normal setup, then restart Codex. Keep a
valid certification. Ordinary refresh and upgrades retain the installation key;
`refresh --full` or uninstall/reinstall replace it. A changed bound model
configuration also makes older state unavailable: restore the original state
or start a new task. Do not use full refresh for this upgrade.

Offline tests cover compaction, replay, restart, credential isolation, tampering,
model switches, malformed responses, and native byte preservation. A real
external web call has been observed, but the fixed compaction and final sourced
answer still require live acceptance by the user.

PickerMux is an unofficial community project. It is not affiliated with,
endorsed by, or supported by OpenAI, Codex, or LM Studio.
