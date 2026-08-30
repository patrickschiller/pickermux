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
- command execution, path traversal, decompression abuse, or resource
  exhaustion through untrusted requests;
- certification records enabling tools for a different model or configuration;
- uncertified or stale external routes receiving function schemas, forced tool
  choices, or tool-call history;
- secrets or sensitive prompts being persisted unexpectedly;
- Auto resolving after credential lookup, dispatching to more than one
  provider, or replaying a request across provider boundaries.

General hardening ideas without a concrete vulnerability can be proposed with
the public feature-request form.

## Auto Smart Routing

Auto Smart Routing is opt-in. Selecting `pickermux/auto` is explicit consent
that PickerMux may send the request to either the configured LM Studio model or
the configured native Codex fallback. Users who require guaranteed local
execution must select the explicit namespaced `lmstudio/...` model instead.

The Auto route is virtual: it has no upstream URL, provider identity, or
credential. PickerMux selects one exact concrete route locally before provider
credential lookup, DNS resolution, or an upstream connection. It opens at most
one upstream request. No classifier receives the prompt, the prompt is not sent
to multiple providers, and a local failure is never automatically replayed
against native Codex.

The selected concrete route retains the existing trust boundary. Native uses
only the approved native header allowlist. External requests receive a newly
constructed provider-scoped header set that excludes native bearer tokens,
cookies, account identifiers, attestation values, Codex metadata, and unrelated
routing or session state. Auto introduces no new credential and never weakens
either header policy.

Provider affinity is process-local and bounded. PickerMux accepts only a
validated `prompt_cache_key`, hashes it with SHA-256 before lookup, keeps no more
than 256 entries for at most 30 minutes, and uses LRU-style recency. Raw affinity
values are never logged or persisted, affinity hashes are not persisted, and no
routing history survives the bridge process. Routing diagnostics exclude prompt
text, instructions, request bodies, headers, credentials, account identifiers,
affinity values and hashes, and private capability URLs.

## Uninstall and purge boundary

The normal `pickermux uninstall` lifecycle restores Codex configuration and
removes the managed bridge runtime while deliberately retaining verified
PickerMux backups and provider credentials. Removing the receipt-owned CLI with
`--remove-cli` does not change that retention policy.

Receipt-owned CLI paths are detached into a private quarantine, revalidated
against the installation receipt after integration removal, and cleaned only
as exact inventoried files, the exact `current` symlink, and empty directories.
No recursive distribution cleanup may consume state added after staging;
changed or additional bytes remain at the reported quarantine path.

Every uninstall inventories `runtime-app` before changing Codex configuration
and binds its file tree byte-for-byte to the invoking PickerMux payload. It
rejects symbolic links, special files, unexpected entries, modified contents,
unsafe ownership, and leftover `runtime-app.previous-*` packages. Removal then
unlinks only the inventoried files and empty directories; it never recursively
deletes an untrusted runtime tree.

`pickermux uninstall --purge` is the explicit full-removal operation. It may
delete only backups whose PickerMux ownership and integrity can be verified and
only the exact PickerMux Keychain entries named by the private provider
registry. The registry contains canonical provider IDs, never credential
values. Purge does not enumerate unrelated Keychain items or infer deletion
targets from untrusted configuration. Provider IDs are canonical configuration
identifiers with a 127-character maximum, and registry changes are serialized
and revalidated before deletion.

Foreign, modified, ambiguous, publicly accessible, or otherwise unsafe
ownership state fails closed. `--force` may resolve an acknowledged conflict in
PickerMux's managed Codex configuration, but it never bypasses distribution,
backup, provider-registry, or Keychain ownership checks.

Runtime, backup, and registry deletion use private quarantine paths with a
second identity check. If one of those cleanups cannot finish, full purge fails
and retains or restores the receipt-owned CLI so the exact reported path can be
reviewed; the failure is not reported as a successful full removal.

Neither uninstall mode reads, modifies, or deletes native Codex authentication.
In particular, PickerMux never reads or removes `~/.codex/auth.json`.

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
