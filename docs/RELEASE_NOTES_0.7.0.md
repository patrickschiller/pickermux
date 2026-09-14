# PickerMux 0.7.0

Historical local candidate notes. The current unpublished candidate is
[0.7.2](RELEASE_NOTES_0.7.2.md); its acceptance guide and validation status
supersede the snapshot below.

Prepared locally; not published. Live acceptance is pending. Confirm the release
date and complete the [acceptance procedure](WEB_SEARCH_ACCEPTANCE.md) before
tagging or publishing.

PickerMux 0.7.0 adds experimental shared web search for tool-certified external
models. Codex executes `web.run` through the native search service, then returns
the source text to the selected model. LM Studio continues to write the answer.

- **Lower prompt overhead:** one reviewed web-search description shrinks from
  7,507 to 3,475 UTF-8 bytes (53.7%) while preserving its search and citation
  rules. Unknown descriptions and tool schemas remain unchanged.
- **No extra local search generation:** PickerMux adds no LM Studio inference
  call, result-summary pass, result cache, or result truncation. Codex's search
  context, filters, and explicit output budgets are preserved.
- **Separate search routing:** optional `bridge.webSearchModel` selects the
  native search request parameter, defaulting to `bridge.defaultModel`. The
  answer model stays selected. This setting does not identify the search
  backend's internal models or establish its billing behavior.
- **Preserved security boundaries:** native authentication stays on the native
  search path. Exact model registration, certification, and pending-state
  checks remain required; uncertified models remain text-only.
- **Recoverable activation:** install and ordinary refresh enable standalone
  search only when no explicit feature setting exists. User disabling settings
  are respected; migration and rollback preserve owned configuration, and
  uninstall removes only the feature block PickerMux added.

After publication, fully quit Codex, upgrade, run normal `pickermux refresh`,
and reopen Codex. If the desired model is text-only, run its regular certification only
when it is loaded and no local-model task is active, then restart Codex again.
See [Configuration](CONFIGURATION.md#shared-web-search) and
[Troubleshooting](TROUBLESHOOTING.md#web-search-is-missing-or-fails).

The implementation has offline coverage for the public protocol, routing,
credential isolation, error handling, and configuration recovery. Native
backend acceptance and the end-to-end live search flow remain unverified for
this candidate. Tool availability does not guarantee that every model searches
or interprets its sources correctly.

PickerMux is an unofficial community project. It is not affiliated with,
endorsed by, or supported by OpenAI, Codex, or LM Studio.
