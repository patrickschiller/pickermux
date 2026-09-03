# Fast Agent feasibility report

- Date: 2026-09-02
- Repository baseline: `891be4340686cc334d38cfd4eda8db7acee1053c`
- PickerMux baseline: `0.5.4`
- Result: **Architecture no-go for the proposed version-independent Fast Agent**
- v0.6.0 decision: **Ship Efficient Fidelity instead; the Fast Agent remains rejected**

## Decision

PickerMux cannot safely publish the proposed `/agent` execution profile from
the public request structures currently evidenced in this repository. The
Fast Agent contract requires all three of the following properties to be
structurally unambiguous before a provider credential is resolved or an
upstream request is sent:

1. the current user turn and its attachments;
2. the continuation/session to which a tool result belongs;
3. whether Codex approved or denied an action.

The first and third properties are not present in the available public
structures. The second is supported by the Responses API in general but is not
evidenced on the Codex-to-custom-provider request path. Guessing any of these
properties from text, array position, private annotations, or a Codex version
would violate the proposed trust boundary.

No production Fast Agent route, capability receipt, or catalog entry should be
published under this contract until the missing public signals are available
and Phase 0 is repeated. This no-go does not block v0.6.0 because that release
uses the narrower Efficient Fidelity protocol described below and does not
claim any of the missing Fast Agent properties.

## Accepted alternative for v0.6.0

Efficient Fidelity keeps Codex as the only agent and preserves its full harness.
It uses Codex's evidenced client-executed `tool_search` round trip to defer
large tool schemas on an exact, additionally certified LM Studio route.
PickerMux performs bounded protocol projection only: Codex searches its own
inventory, applies sandbox and approval policy, executes selected tools, and
returns results.

This design does not need to identify or trim a current user turn, infer an
approval outcome, or create a PickerMux session. Version 0.6.0 uses the full
public replay and explicitly does not use `previous_response_id` for this
flow. If its additive model-bound search probe is absent, stale, or fails, an
otherwise valid tool-certified model remains on Direct fidelity. Native paths
stay byte preserving, and no `/agent` endpoint or two-function broker exists.

See [Architecture](ARCHITECTURE.md#efficient-fidelity) for the implemented
contract and [Releasing](RELEASING.md#manual-acceptance-matrix) for its live
acceptance gates.

## Gate evidence

### 1. Current-turn identity: failed

The realistic Codex request fixture contains multiple public `role: "user"`
messages in one `input` array:

- a bootstrap message at
  [test/responses-proxy.test.mjs](https://github.com/patrickschiller/pickermux/blob/891be4340686cc334d38cfd4eda8db7acee1053c/test/responses-proxy.test.mjs#L1023);
- the user question and attachments at
  [test/responses-proxy.test.mjs](https://github.com/patrickschiller/pickermux/blob/891be4340686cc334d38cfd4eda8db7acee1053c/test/responses-proxy.test.mjs#L1056);
- a later conversation turn at
  [test/responses-proxy.test.mjs](https://github.com/patrickschiller/pickermux/blob/891be4340686cc334d38cfd4eda8db7acee1053c/test/responses-proxy.test.mjs#L1087).

Their public message shapes do not identify which one is the current turn.
The existing text-only compactor can distinguish selected bootstrap content
only through `internal_chat_message_metadata_passthrough` and deliberately
stops conservatively for missing or unknown annotations in
[src/responses-proxy.mjs](https://github.com/patrickschiller/pickermux/blob/891be4340686cc334d38cfd4eda8db7acee1053c/src/responses-proxy.mjs#L522). The Fast Agent
contract expressly cannot depend on that private field.

Accepting exactly one public user message would be safe as an isolated parser
rule, but there is no evidence that Codex emits that shape for the proposed
catalog profile. Treating the last user item as current would be a position
heuristic, not a protocol.

### 2. Continuation identity: not proved for Codex custom providers

The public Responses API supports `previous_response_id` for multi-turn
continuations. PickerMux already uses it when PickerMux itself drives a direct
provider certification sequence in
[src/certification-runner.mjs](https://github.com/patrickschiller/pickermux/blob/891be4340686cc334d38cfd4eda8db7acee1053c/src/certification-runner.mjs#L348). This
proves the bridge-to-provider leg only.

The repository has no redacted fixture proving that Codex supplies
`previous_response_id`, an equivalent public session handle, or a
continuation-only delta to the custom HTTP provider. A PickerMux-signed
response ID is useful only if Codex reliably returns it on the next request.
That round trip therefore remains unproved. See the official
[conversation-state guide](https://developers.openai.com/api/docs/guides/conversation-state)
and the
[Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create).

### 3. Approval outcome: failed

A public `function_call_output` binds an output to a `call_id`; the documented
item status represents lifecycle state such as `in_progress`, `completed`, or
`incomplete`. It does not encode the user's approval decision. The current
PickerMux request fixtures likewise contain only `call_id` plus an arbitrary
`output` value, for example
[test/responses-proxy.test.mjs](https://github.com/patrickschiller/pickermux/blob/891be4340686cc334d38cfd4eda8db7acee1053c/test/responses-proxy.test.mjs#L2280).

Consequently the bridge cannot structurally distinguish:

- an approved action that ran and failed;
- an action denied by the user;
- ordinary tool output that happens to contain denial-like text.

Parsing output prose or retrying after a possible denial would violate both
the no-heuristics rule and Codex's ownership of execution and approval. See
the official
[function-calling guide](https://developers.openai.com/api/docs/guides/function-calling)
and the
[Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create).

### 4. Fast Agent tool-surface claim: not proved

The original review did not prove which public tool types Codex would supply to
the proposed Fast Agent entry. Existing normalization also drops some known
unsupported types instead of rejecting the complete manifest in
[src/tool-normalization.mjs](https://github.com/patrickschiller/pickermux/blob/891be4340686cc334d38cfd4eda8db7acee1053c/src/tool-normalization.mjs#L146). It therefore
cannot substantiate the claim that every Codex-supported tool remains
reachable through a two-function broker. The narrower client-executed
`tool_search` contract used by Efficient Fidelity is independently versioned
and certified; it does not validate or revive that broader broker claim.

## Security and implementation consequences

- Keep native and text routes unchanged and preserve Direct fidelity as the
  fallback beneath any additive optimization.
- Do not add an `/agent` route or advertise Fast Agent readiness.
- Do not create capability receipts for unproved structural properties.
- Do not infer the current turn from the last user item, prompt markers,
  private annotations, or client version.
- Do not infer approval from tool-output text or lifecycle status.
- Any future Fast Agent projector must reject ambiguity before the existing
  provider credential resolution at
  [src/responses-proxy.mjs](https://github.com/patrickschiller/pickermux/blob/891be4340686cc334d38cfd4eda8db7acee1053c/src/responses-proxy.mjs#L1249).

## Required evidence to reopen implementation

At least one supported public Codex contract must provide all of the following:

1. an explicit current-turn/delta identity that binds attachments without
   relying on position or private annotations;
2. a stable continuation handle that Codex returns to the custom provider;
3. a structured approval outcome bound to the exact open call;
4. redacted new-task and continuation fixtures showing the actual tool surface;
5. an explicitly authorized live approval/denial round trip through loopback
   LM Studio, followed by the negative, cancellation, restart, and model gates.

If Codex instead guarantees an input envelope with exactly one public user
turn for a newly created profile, that guarantee must be public, versioned, and
testable before PickerMux can treat the shape as an identity contract.

## Validation performed

- `git pull --ff-only origin main`: already up to date.
- `npm run verify`: 576 tests passed on the unchanged `0.5.4` baseline.
- Static review of request fixtures, request projection, tool normalization,
  certification continuation, catalog generation, routing, and compatibility
  gates.
- Official public Responses API documentation review.

No install, refresh, certification, Keychain, LaunchAgent, or live-provider
operation was performed.

This validation list records the original no-go review on v0.5.4. The v0.6.0
Efficient Fidelity release has its own automated and live acceptance gates; it
does not retroactively turn this record into evidence for a Fast Agent.
