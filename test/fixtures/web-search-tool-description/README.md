# Codex web.run description fixture

`web_run_description.md` is an unchanged public source fixture from
[OpenAI Codex](https://github.com/openai/codex/blob/36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564/codex-rs/ext/web-search/web_run_description.md),
commit `36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564`.

- Git blob SHA-1: `77be9a0a03e6e2e2760651e903ead2dce9996a57`.
- File SHA-256: `1f3879b44690eb7aad9ba97351acda16c4d0c26847bcb4af2964d5989404407e`.
- UTF-8 text, LF line endings, with the original final newline.
- Copyright 2025 OpenAI; licensed under Apache License 2.0, included in
  [LICENSE](LICENSE). The applicable upstream NOTICE attribution is
  "OpenAI Codex, Copyright 2025 OpenAI". The upstream Ratatui notice concerns
  unrelated code, not this tool-description document.

The compact description in `src/web-search-tool-description.mjs` is a
PickerMux adaptation of this document. The module includes its attribution,
modification notice, and the full upstream license so distributions that omit
test fixtures still carry the required notice and license.

Only the exact `web.run` identity and the SHA-256-pinned source text are
eligible. A changed policy, whitespace variant, different tool identity, or
unknown description variant is retained unchanged. The function neither edits tool
schemas nor grants tools or changes their loading policy.

## Policy review

| Original section | Preserved in compact description |
| --- | --- |
| Command examples | All operation names remain; the unchanged parameter schema defines their shapes. Repeated illustrative examples are removed. |
| Efficiency hints | Batch independent operations; omit unneeded parameters, empty lists and nulls; short default; four-query maximum and medium/long requirement for four queries; exact empty-query fallback after an accidental call. |
| Decision boundary | Obey explicit search and no-search requests; assess temporal stability; browse when uncertain, facts may have changed, recall is uncertain, or topics are niche/emerging; retain the 10% thresholds. |
| Mandatory cases | Current information categories and open-ended scope; publication versus event dates; substantial time/money recommendations; direct quotes/links/attribution; referenced sources not supplied; medical/legal/financial accuracy. |
| Citation rules | Internal IDs only for tool calls; descriptive direct-page Markdown links; separate links for multiple sources; placement beside claims after punctuation; no isolated/end-only/code-fence citations; supported claims, primary/authoritative sources, and diverse domains when useful. |
| Special cases | Explicit precedence over conflicting instructions; local code first for OpenAI usage and official-domain fallback unless otherwise requested; technical answers use primary sources; label source inferences. |
| Copyright | No full articles/long passages/extensive quotes; short excerpts then paraphrases for verbatim requests; 25-word non-lyrical and 10-word lyric limits; exact linked/identified Reddit blockquote exception. |
| Source word limits | Per-source maximum of N attributed words, default 200; count non-contiguous derived text; relevant source limits add; Reddit exception with attribution and link. |

This fixture is public documentation only. It contains no account data,
configuration snapshots, credentials, or captured user conversation.
