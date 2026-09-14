# PickerMux 0.7.2

Prepared locally on 2026-09-13; not published. Live timeout-reporting and
external-model web-search acceptance are pending. Confirm the release date and
complete the [candidate acceptance procedure](WEB_SEARCH_ACCEPTANCE.md) before
tagging or publishing.

PickerMux 0.7.2 improves error reporting when transformed external responses
fail before validated output is ready. It delays response headers so a timeout
or validation failure can return a structured error instead of an opaque
stream disconnect. Header, idle, and total timeouts have distinct fixed
messages; provider error content remains private.

If transformed external SSE output has already started and the client remains
connected, PickerMux reports an upstream or validation failure with a minimal
`response.failed` event and normal HTTP end-of-response so Codex can display
the fixed error reason. It stops the upstream request without
fabricating a successful completion or tool result. Native failure handling
remains unchanged.

The installed 0.7.1 candidate passed all eight base certification gates and the
additive tool-search gate on the tested LM Link model. A subsequent Codex task
reached its configured ten-minute idle limit while LM Studio was still
processing the prompt. This identifies the disconnect boundary, not the cause
of slow prefill. See the
[stream timeout guide](TROUBLESHOOTING.md#stream-disconnects-during-prompt-processing).

Upgrade immutable 0.7.1 packages through normal setup and retain a still-valid
certification. The fix adds no model requests or tokens and does not change
native response bytes, timeout limits, reasoning defaults, GPU settings, or
retained context. Native web search/open has passed smoke checks; external-model
web search remains pending.

PickerMux is an unofficial community project. It is not affiliated with,
endorsed by, or supported by OpenAI, Codex, or LM Studio.
