# Security Policy

PickerMux sits between Codex Desktop and model providers, modifies local Codex
configuration, and installs a per-user macOS service. Security reports are
therefore especially valuable.

PickerMux is an unofficial community project and is not affiliated with,
endorsed by, or supported by OpenAI, Codex, or LM Studio.

## Supported versions

Security fixes are made against the latest release and the current default
branch. Older releases may not receive backports.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Default branch | Yes |
| Older releases | No guaranteed support |

## Reporting a vulnerability

Do not open a public issue or discussion for a suspected vulnerability.

Use GitHub's private **Report a vulnerability** form in the repository's
Security tab when it is available. If that form is not available, contact the
maintainer through the GitHub profile
[`patrickschiller`](https://github.com/patrickschiller) and request a private
reporting channel before sharing technical details.

Include, when possible:

- the affected PickerMux version or commit;
- macOS, Node.js, Codex Desktop, and LM Studio versions;
- a concise impact assessment and the conditions required to reproduce it;
- minimal reproduction steps or a proof of concept;
- whether credentials, account data, local files, or provider boundaries may
  be affected;
- suggested mitigations, if known.

Never include live access tokens, cookies, account identifiers, private model
data, or the local bridge capability path. Replace them with clearly marked
placeholders. If a secret may have been exposed, revoke or rotate it before
continuing the report.

The maintainer will coordinate validation, remediation, and disclosure with
the reporter. No fixed response-time or remediation-time guarantee is offered.

## Security-sensitive areas

Reports involving any of the following are particularly important:

- native Codex credentials or metadata reaching an external provider;
- standalone search reaching an external destination, accepting an unknown or
  uncertified model route, or exposing native service errors to an external
  model;
- requests escaping the intended loopback or provider allowlist boundary;
- capability-path disclosure or unauthorized local bridge access;
- unsafe writes to Codex configuration, backups, or the LaunchAgent runtime;
- release-installer checksum bypass, unsafe archive extraction, distribution
  receipt forgery, or replacement of an unrelated user launcher;
- uninstall or purge removing modified, foreign, or concurrently replaced
  runtime, distribution, backup, registry, or Keychain state;
- command execution, path traversal, decompression abuse, or resource
  exhaustion through untrusted requests;
- certification records enabling tools for a different model or configuration;
- Efficient Fidelity activating without its exact additive receipt, accepting
  malformed search correlation, or exposing tools outside the completed
  client-executed search output;
- uncertified or stale external routes receiving function schemas, forced tool
  choices, or tool-call history;
- secrets or sensitive prompts being persisted unexpectedly.

General hardening ideas without a concrete vulnerability can be proposed with
the public feature-request form.

## Provider request boundary

External provider headers are rebuilt from a narrow allowlist. External JSON
bodies also exclude Codex `client_metadata` and internal content annotations;
ordinary provider API `metadata` remains available to configured providers.
Native Codex request bodies remain byte preserving. Treat request logs produced
by older PickerMux releases as sensitive because they may contain installation,
session, thread, window, or turn identifiers.

Standalone web search has a distinct native trust boundary. The exact
capability-scoped `POST /v1/alpha/search` route resolves the selected model and,
for an external selection, requires its current tool authority and the same
Direct/appropriate Efficient Fidelity receipt and pending-state checks as
inference. It then validates the separately configured native search model
against the registry. No external provider URL or credential is used; native
headers are eligible only for the fixed native search destination, and
`~/.codex/auth.json` is never read.

For external-model searches, only the search request's model parameter is
rewritten. The caller's session identity, conversation input, commands,
settings, filters, reasoning, and explicit budgets remain intact and are sent
to the native search service. Search results are untrusted external content.
Successful external-model search replies must match the reviewed bounded
envelope; native errors are replaced with fixed redacted messages so account
or echoed prompt context cannot escape in an error body. Native-model search
requests and response bodies remain byte preserving after request validation.
The bridge never follows search-result URLs itself or routes search through
LM Studio. The selected external model receives the search text through
Codex's normal tool-result path, without an extra search-generation call.

Search-description compaction is authorized only by the exact `web.run`
identity, length, and reviewed SHA-256. Its replacement retains the original
search obligations, citation policy, word limits, and exceptions. Unknown or
edited descriptions remain unchanged; this optimization does not grant tools,
alter schemas, defer tools, or shorten search results.

Managed activation adds a separately marked and receipt-hashed standalone
search feature only when the user has no explicit value. User-owned disabling
settings remain effective. Provider/feature migration uses the existing
compare-and-swap and rollback boundary and requires the running search
contract; uninstall removes only an unchanged feature block PickerMux owns.

LM Studio compaction has a separate request and replay boundary. Only an exact
bare trailing `compaction_trigger` on full `/responses` replay is adapted. The
usual certification gate, external sanitization, and tool-history validation
run first. A single bounded, nonstreaming summary call receives supported text
history as data and no tool schemas or execution authority. Incomplete output,
calls, unsupported media, malformed controls, and oversized content do not
produce a successful compaction item or replace the client's previous history.
Only on this Codex V2 summary path, the original top-level `instructions` is
type-validated then excluded before message merging. Codex retains that field
outside history and supplies it again for ordinary inference. No text matching
or role-wide filtering removes historical system/developer/user content. All
ordinary request instructions and legacy/other-provider behavior are retained.

Compaction summaries use a versioned AES-256-GCM envelope with a
purpose-separated HKDF key from the installation's private local capability,
not native or provider credentials. Authenticated additional data binds the
exact provider/model/context and catalog model hash. Nonces are random; payloads,
keys, and plaintext summaries never enter logs. Decoding has strict size,
canonical encoding, UTF-8, shape, and authentication checks. Restored state is
assistant context, never a new system/developer instruction or tool grant.
For ordinary inference ending in an authenticated compaction item, a fixed
user-role instruction closes the assistant message and resumes the existing
task. Dynamic summary text is not promoted into that instruction. No such
instruction is added to subsequent compaction or native requests.

The complete own-envelope prefix family is rejected on native and other
provider routes regardless of the input item type; all other native bytes are
preserved. LM Studio rejects foreign/native encrypted compaction and unknown
aliases before provider I/O or credential resolution. Known Codex passthrough
metadata is removed from restored items. Ordinary refresh and version upgrades
preserve the key; `refresh --full` and reinstallation replace the installation
capability and invalidate earlier encrypted state. Model-configuration changes
also invalidate its binding. These are explicit recovery limits, not an
opportunity to bypass authentication or silently discard conversation content.

Model re-certification uses a private, atomically persisted pending barrier.
The active service reads it before external credential resolution or upstream
I/O for each new request. A malformed or unreadable existing store blocks that
request; an absent store is the initial empty state, so any in-memory route that
claims Direct or Efficient Fidelity authority is blocked for lack of its
receipt. Ordinary traffic newly admitted for a pending model is rejected even
if the in-memory registry still contains an older tool grant. The same gate
requires a Direct receipt for a Direct route and the additive `toolSearch` gate
for an Efficient Fidelity route; exact subject/fingerprint evaluation remains
part of managed catalog publication. A request admitted before the barrier was
persisted may finish. The private certification transport remains blocked until
a health-attested service refresh has published the target as text-only and the
same atomic commit has removed its previous receipt. Native routes do not enter
this gate.

Uncertified LM Studio text-only routes additionally omit only explicitly
allowlisted Codex-generated bootstrap context before the first conversation
item. Every omission is bound to the expected private annotation, role, exact
message/content shape, and any required standalone placement or complete exact
envelope. Dedicated memory and multi-agent annotations provide the semantic
contract across prompt-wording changes; generic developer/app/thread content is
never inferred to be disposable and is retained. A retained generic fragment
does not prevent later independently verified generated context from being
removed. Malformed envelopes, wrong roles, mixed or unknown annotations retain
the item and stop further compaction. Unknown structural fields are rejected
before forwarding. This latency-first boundary deliberately keeps generated
cross-thread memory out of the local provider request while preserving direct
user content, attachments, current environment facts, AGENTS/project and
managed instructions, selected skills, and history.

Efficient Fidelity is a separate boundary for base-certified LM Studio models.
It retains the full Codex harness and changes only delivery of functions marked
for deferred loading. Managed publication requires a current model-bound Direct
receipt and additive `toolSearch` gate before it emits the current v0.6 catalog
claim; runtime activation additionally requires that claim and the canonical
client-executed request shape. PickerMux translates protocol shapes but does
not search Codex's inventory, choose or execute a tool, interpret approval, or
replace Codex's sandbox. Only deferred functions returned in a completed,
exactly correlated `tool_search_output` become newly eligible for the LM Studio
replay; functions not marked as deferred remain in the request-local advertised
inventory.

The adapter rejects unknown execution modes and tool types, malformed or
duplicate call IDs, invalid arguments, excess inventory or schema size,
secondary input tool inventories, incomplete or unterminated streaming calls,
and `previous_response_id` on this v0.6 path. Identical tools selected by
multiple searches are exposed once, while the same identity with changed
schema fails closed. It does not infer continuation state, approval, or the
current user turn. A missing additive receipt selects the pre-existing Direct
fidelity path; a missing base receipt selects the text-only boundary. Native
request and response bytes never enter Efficient Fidelity and remain unchanged.
Every LM Studio response call is bound to the exact function inventory that
PickerMux advertised upstream. All external text-only and compact requests have
an empty response-call authority. Unknown LM Studio call types, names, IDs, or
lifecycle events fail closed. For LM Studio streaming responses, function
completion items are released only with a matching `response.completed`
terminal, so Codex cannot execute a call from a response that later proves
incomplete or inconsistent. Other configured Responses-compatible providers
retain their native response contract.

Certification transitions use a private persistent deactivation barrier. A
running bridge checks it before credential resolution or upstream I/O for each
new request and rejects new ordinary admissions for the target even when that
process still holds an older tool-enabled registry. Already admitted work can
finish, which is why certification must not run alongside an active model turn.
The instance-bound certification transport opens only after a transactional
refresh has published and verified the conservative catalog. Background
catalog publication and route-registry replacement remain blocked while the
barrier is present, and an interrupted pre-publication transition leaves the
model quarantined for explicit retry instead of restoring stale authority.

Setup and direct installation automatically invoke these same live gates after
installation commits, while retaining the lifecycle lock. Valid base receipts
are reused; no installer flag bypasses certification. A failed certification
retains the activated installation and its conservative recovery state instead
of rolling back only the CLI pointer. Installer progress uses fixed check names
and numeric counts, never provider payloads or model identifiers. Progress
callbacks cannot grant authority or change certification outcomes.

For Codex's exact remote-compaction endpoint, a namespaced call whose older
selected schema was trimmed may receive a deterministic history-only wire
name. That mapping adds no tool definition and conveys no execution authority;
it exists only so LM Studio can compact the already completed transcript. Any
new invocation in the compact response is rejected.

Text-only context telemetry is in-memory only and is projected through an
explicit schema of fixed enums, booleans, and non-negative byte/part counters.
It excludes prompt text, raw annotation kinds, roles, hashes, model/provider
names, URLs, paths, and request, message, turn, or conversation identifiers.
Telemetry sink failures cannot change request routing or upstream bytes.
Every external text-only route also rejects secondary `additional_tools`
inventory items before credential resolution; schemas cannot bypass the
top-level tool stripping boundary through conversation input.

The service watches the Codex executable identity before model requests and on
a background interval. A changed identity is fully revalidated against the
private compatibility manifest before more traffic or synchronized catalog
state can be published. Incompatible or unverifiable state fails closed with
fixed public status codes; raw verifier errors, versions, and paths are not
returned by the bridge health endpoint.

Managed configuration recovery is limited to a missing provider end marker
whose virtual reinsertion at exactly one safe line boundary before the next
TOML table or end of file recreates the receipt-recorded block digest. Blank or
comment-only tail lines remain outside the owned block and are preserved.
Status and ordinary uninstall recovery do not write the marker. A refresh
that must migrate the old owned provider to standalone search materializes
that same uniquely verified marker as part of the configuration transaction.
This grants no broader marker-repair authority. If the initial release-setup
account-cache preflight fails while this exact state is active, the downloaded
payload may materialize only the receipt-proven marker
under the private lifecycle lock. It revalidates state ownership, configuration
bytes, the unique candidate, and Codex shutdown immediately before an atomic
compare-and-swap write; CLI and runtime state remain unchanged. Missing
root/begin markers, duplicate or foreign boundaries, provider content changes,
unsafe table scope, ambiguous candidates, and receipt mismatch remain blocked.

## Full-refresh application boundary

`pickermux refresh --full` is an explicit interactive recovery operation. It
rejects `--json` and starts only after the user confirms that Codex will quit
twice and active tasks may be interrupted. Ordinary `refresh` never starts this
application-control sequence merely because an otherwise valid account cache
is old.

The one-time helper requests Codex shutdown through its normal Apple-event
lifecycle and verifies stable LaunchServices state. It never sends a forced
kill signal. Codex is reopened by its bundle identifier with a narrow allowlist
of ordinary macOS session variables; provider credentials, Codex overrides,
capability values, and the invoking shell's unrelated environment are not
forwarded to the app.

Temporary suspension uses the existing receipt and ownership boundaries. It
does not purge provider credentials, verified backups, certification receipts,
or the receipt-owned CLI distribution. Reactivation is allowed only after
Codex produces a structurally safe cache for the exact client version and after
Codex has fully quit again. When a valid baseline cache existed, the accepted
cache must also have a later fetch timestamp. The ordinary transactional
refresh and rollback checks remain authoritative for republishing the
integration.

A private checkpoint records the last completed phase so a retry can revalidate
live state before continuing a half-finished operation. It does not contain
native authentication, provider credential values, private prompts, model
responses, or the bridge capability path. A failure before suspension removes
the transient checkpoint because no integration mutation needs recovery. From
suspension onward, a failed or ambiguous phase retains private recovery
evidence and fails closed; it is not reported as a successful reactivation.

## Uninstall and purge boundary

The companion's explicit integration toggle is separate from uninstall and
full-refresh recovery. Deactivation retains the private ownership receipt,
runtime/capability record, provider settings, certification receipts and
original backup, while stopping the managed service and exposing native Codex
root configuration. The exact inert historical provider alias keeps old chats
readable. A distinct `integration-toggle-v1` suspension digest binds those
bytes; edited aliases/configuration and foreign lifecycle suspensions cannot
authorize reactivation. Deactivation requires Codex to be fully stopped,
receipt-owned runtime/source validation and the installation lock. Service
or configuration failures use the existing rollback boundary. Turning the
toggle on or off supplies explicit consent without a second modal dialog;
activation still obtains and revalidates a fresh exact preview token. GUI consent
does not bypass any of these checks.

The normal `pickermux uninstall` lifecycle restores Codex configuration and
removes the managed bridge runtime while deliberately retaining verified
PickerMux backups and provider credentials. Removing the receipt-owned CLI with
`--remove-cli` does not change that retention policy.

Receipt-owned CLI paths are detached into a private quarantine, revalidated
against the installation receipt after integration removal, and cleaned only
as exact inventoried files, the exact `current` symlink, and empty directories.
SHA-256 digests and device/inode identity bind cleanup to the state that was
inspected. Changed or additional bytes remain at the reported quarantine path;
no recursive distribution cleanup may consume data added after staging.

Every uninstall inventories `runtime-app` before changing Codex configuration
and binds its file tree byte-for-byte to the invoking PickerMux payload. It
rejects symbolic links, special files, unexpected entries, modified contents,
unsafe ownership, multiply linked regular files, and leftover
`runtime-app.previous-*` packages. Ownership-sensitive cache, configuration,
receipt, runtime, backup, and registry payloads are not read through symbolic
or hard links. Removal then unlinks only the inventoried files and empty
directories; it never recursively deletes an untrusted runtime tree.

`pickermux uninstall --purge` is the explicit full-removal operation. It may
delete only backups whose PickerMux ownership, SHA-256 digest, and filesystem
identity can be verified and only exact PickerMux Keychain entries named by the
private provider registry. The registry contains canonical provider IDs, never
credential values. Purge does not enumerate unrelated Keychain items or infer
deletion targets from untrusted configuration. Provider IDs use the canonical
configuration grammar with a 127-character maximum, and registry changes are
serialized and revalidated before deletion.

All current CLI uninstall modes for the canonical `model_bridge` integration
preserve one marker-bounded, inert provider table in `config.toml` so Codex can
parse historical chats. The temporary `refresh --full` suspension is separate
and omits the table until reactivation. The table's no-auth, loopback-port-zero,
zero-retry definition cannot route a request to an external provider. The
append is part of the atomic compare-and-swap restore; a later installation
removes only the exact unchanged end-of-file
table while producing its normal verified backup. Any modified, foreign, or
non-terminal `model_bridge` table remains a fail-closed conflict and is never
overwritten. The marker records only whether the restored config must remain a
file, without recording user content or personal data.

`pickermux repair-chats` applies the same narrow table restoration after an
older uninstall. It requires Codex to be closed and refuses active managed
state, leftover markers, foreign provider definitions, or concurrent config
changes. It neither starts the bridge nor authorizes a provider route. The
release installer's `--repair-chats` mode first verifies its exact archive
checksum and rejects unsafe entries, then invokes repair from the extracted
payload without setup. This keeps the recovery available when the installed
CLI is old or Codex's account model cache is stale; it does not relax the
configuration ownership checks.

Foreign, modified, ambiguous, publicly accessible, or otherwise unsafe
ownership state fails closed. `--force` may resolve an acknowledged conflict in
PickerMux's managed Codex configuration, but it never bypasses distribution,
runtime, backup, provider-registry, or Keychain ownership checks.

macOS Keychain does not provide an atomic transaction across multiple generic
password items. PickerMux deliberately never reads credential values for a
rollback. It therefore stages and validates every reversible filesystem change
before deleting the first registered item. If a later exact deletion fails,
purge fails, leaves the integration active, restores the CLI, backup directory,
and provider registry, and retains ownership receipts for an idempotent retry;
an item already deleted in that attempt remains absent. A later integration
failure after all Keychain deletions is likewise reported as an incomplete,
irreversible commit with recovery state retained, never as successful removal.

These checks serialize cooperating PickerMux lifecycle commands and reject
drift observable before each final filesystem operation. They do not claim to
isolate PickerMux from a malicious process already running with the same macOS
user identity: Node.js and macOS expose pathname-based unlink operations, so
such a process can race the last check by replacing a quarantined filename.
PickerMux still never performs recursive purge cleanup. Do not run purge while
another same-user process is intentionally modifying its private quarantine.

Runtime, backup, and registry deletion use private quarantine paths with a
second identity check. If one of those cleanups cannot finish, full purge fails
and retains or restores the receipt-owned CLI so the exact reported path can be
reviewed; the failure is not reported as a successful full removal.

No uninstall mode reads, modifies, or deletes native Codex authentication. In
particular, PickerMux never reads or removes `~/.codex/auth.json`.

The companion's separate complete-removal action requires a fresh native
removal preview and explicit consent to remove PickerMux, restore native Codex
defaults, delete verified backups and delete registered provider credentials.
It is available only through the receipt-validated installed backend, including
a verified toggle-deactivated installation; the bundled setup backend cannot
purge another distribution. No GUI request supplies arbitrary paths, provider
IDs or force flags. Login startup is disabled before purge. After verified
success, polling and queued background actions cannot run again, and cleanup
targets only the app's named preferences and notification identifier. The app
bundle is removed by the user in Finder rather than by recursive self-deletion.

`uninstall --purge --restore-native` is an explicit alternative to restoring the
original configuration. It omits only the receipt-recorded root model, provider,
catalog, reasoning and gateway assignments and preserves current unrelated
bytes. A native-only configuration candidate is validated and digest-bound to
the configuration, state and verified backup before the first irreversible
credential deletion. The binding is revalidated before configuration commit.
Unowned routing overrides, an active profile, ambiguous syntax or concurrent
changes block this mode instead of being removed. It cannot be combined with
`--force`. Native account caches, authentication and chat data stay outside its
removal authority; the inert historical provider alias remains.

## Release installer trust

Official end-user installation assets are attached to versioned releases in
this repository. The generated installer contains the expected SHA-256 digest
of its exact payload and validates the archive before extraction. Do not run an
installer copied from an issue, discussion, fork, mutable branch, or third-party
download mirror.

The one-line bootstrap still trusts HTTPS, GitHub, and the maintainer account;
the embedded digest does not make a compromised release publisher trustworthy.
Users with a stricter threat model should download and inspect `install.sh` and
the release metadata before executing them. A checksum mismatch is a hard
failure and must never be bypassed.
