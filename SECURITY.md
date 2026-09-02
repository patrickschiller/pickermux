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

Text-only context telemetry is in-memory only and is projected through an
explicit schema of fixed enums, booleans, and non-negative byte/part counters.
It excludes prompt text, raw annotation kinds, roles, hashes, model/provider
names, URLs, paths, and request, message, turn, or conversation identifiers.
Telemetry sink failures cannot change request routing or upstream bytes.

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
Status, refresh, and ordinary uninstall recovery do not write the marker. If
the initial release-setup account-cache preflight fails while this exact state
is active, the downloaded payload may materialize only the receipt-proven marker
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

The canonical `model_bridge` full-purge configuration restore may append one
marker-bounded, inert compatibility table in `config.toml` so Codex can parse
historical chats. Its no-auth, loopback-port-zero, zero-retry definition cannot
route a new request to an external provider. The append is part of the atomic
compare-and-swap restore; a later installation removes only the exact unchanged
end-of-file table while producing its normal verified backup. Any modified,
foreign, or non-terminal `model_bridge` table remains a fail-closed conflict
and is never overwritten. The bounded marker contains only a boolean for
whether the restored config must remain a file. It is false only when the path
was absent before installation and no user bytes survive restoration, preserving
absence, an empty file, or surviving user content without recording that content
or personal data.

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
