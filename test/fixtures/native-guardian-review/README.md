# Native Guardian review contract

The tests use synthetic requests and freshly generated test-only encrypted
checkpoints. No captured prompts, account data, request identifiers, credentials
or usable capability URLs are stored here.

Protocol provenance is official Codex revision
`4d3ed3f3b47d39f8fe0b60df74a20f528b6fc618`:

- [Client transport](https://github.com/openai/codex/blob/4d3ed3f3b47d39f8fe0b60df74a20f528b6fc618/codex-rs/core/src/client.rs)
  emits the subagent transport header and recognizes the optional Guardian
  reviewer header.
- [Guardian tests](https://github.com/openai/codex/blob/4d3ed3f3b47d39f8fe0b60df74a20f528b6fc618/codex-rs/core/tests/suite/guardian_review.rs)
  identify review input by the structured client metadata, verify matching
  subagent transport on the shared client path and distinguish the optional
  credits reviewer header.
- [Checkpoint policy](https://github.com/openai/codex/blob/4d3ed3f3b47d39f8fe0b60df74a20f528b6fc618/codex-rs/core/src/guardian/review_session_context.rs)
  supplies a single parent checkpoint to the separate reviewer.
- [Native SSE fixtures](https://github.com/openai/codex/blob/4d3ed3f3b47d39f8fe0b60df74a20f528b6fc618/codex-rs/core/tests/common/responses.rs)
  and the [client parser](https://github.com/openai/codex/blob/4d3ed3f3b47d39f8fe0b60df74a20f528b6fc618/codex-rs/codex-api/src/sse/responses.rs)
  establish that the completed event can carry ID and usage without duplicating
  status/output. The response guard accepts that form and preserves successful
  bytes. It buffers only projected review replies within 32 MiB and rejects
  HTTP/JSON/SSE failures before any output reaches the external parent's error.

The synthetic `metadata-stream.sse` adds the native side-event contract from
official revision `33d306d457a4632b22bebf214e0c25d91f90f6e8`:

- [SSE parser](https://github.com/openai/codex/blob/33d306d457a4632b22bebf214e0c25d91f90f6e8/codex-rs/codex-api/src/sse/responses.rs)
  recognizes `codex.response.metadata` and `responsesapi.websocket_timing`.
- [Native transport tests](https://github.com/openai/codex/blob/33d306d457a4632b22bebf214e0c25d91f90f6e8/codex-rs/core/tests/suite/client_websockets.rs)
  combine metadata and `codex.rate_limits` with the response lifecycle.
- [Timing telemetry](https://github.com/openai/codex/blob/33d306d457a4632b22bebf214e0c25d91f90f6e8/codex-rs/otel/src/events/session_telemetry.rs)
  names the timing event and its metrics field.

All values and the deny verdict in this fixture are synthetic. Tests exercise
these exact metadata names before and after completion, LF/CRLF framing,
unchanged successful bytes and end-to-end checkpoint projection. Metadata-only
streams, unknown event families, mismatched names, duplicate completion, errors
and data after DONE stay rejected. The original reported review payload was
not captured; these fixtures establish the protocol regression without
claiming a live approval decision or the exact event in that failed request.

The two required markers are the HTTP `x-openai-subagent: guardian` header
and `client_metadata["x-openai-subagent"] = "guardian"`. An optional
`x-codex-guardian` header must equal `reviewer`. These identify an operation
from the existing private-capability client; they are not an approval or a new
authentication credential. The bridge separately authenticates the ciphertext
against an exact current external route and applies its certification gate.

Unknown modes and incomplete markers fail closed. Ordinary native/provider
switches retain their rejection. The summary is assistant data, not trusted
user authorization or reviewer policy. Native allow and deny output is relayed
unchanged; PickerMux does not interpret it or execute the proposed command.
