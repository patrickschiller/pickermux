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
- secrets or sensitive prompts being persisted unexpectedly.

General hardening ideas without a concrete vulnerability can be proposed with
the public feature-request form.

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
