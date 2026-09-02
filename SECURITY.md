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
comment-only tail lines remain outside the owned block and are preserved. The
recovery does not write the marker. Missing root/begin markers, duplicate or
foreign boundaries, provider content changes, unsafe table scope, ambiguous
candidates, and receipt mismatch remain blocked.

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
