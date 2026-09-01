# PickerMux Architecture

This document describes the public v0.5.0 bridge contract. It is intended for
contributors, security reviewers, and users who want to understand what runs on
their Mac.

## Design goals

PickerMux is designed around five invariants:

1. Native Codex models and external models share a picker, not a trust domain.
2. A model slug must resolve to exactly one immutable route.
3. Native credentials and metadata must never reach an external provider.
4. External capabilities must be measured rather than assumed.
5. Installation and refresh must either complete fully or restore the previous
   working state.

## Components

```mermaid
flowchart TB
    subgraph Codex[Codex Desktop process]
        UI[Model picker]
        Client[Responses client]
    end

    subgraph Local[Private per-user PickerMux runtime]
        Catalog[Mixed model catalog]
        Bridge[Loopback bridge]
        Registry[Immutable route registry]
        Sync[Catalog synchronizer]
        Receipts[Certification receipts]
        Compat[Compatibility manifest]
    end

    subgraph Providers[Upstream providers]
        Native[Native Codex backend]
        LM[LM Studio]
        Other[Optional Responses-compatible provider]
    end

    UI --> Catalog
    Client --> Bridge
    Bridge --> Registry
    Registry --> Native
    Registry --> LM
    Registry --> Other
    Sync --> Catalog
    Receipts --> Catalog
    Compat --> Bridge
```

The service is installed as a user LaunchAgent. Its runtime copy lives outside
the source checkout so macOS privacy protection on folders such as Documents
does not break login-time startup.

## Catalog construction

PickerMux builds the catalog in the following order:

1. Read the bundled catalog from the installed Codex client as a schema donor.
2. Read the authenticated account snapshot from `models_cache.json`.
3. Require the account snapshot to match the installed Codex client version for
   `install` and `refresh`.
4. Discover external provider models under the configured policy.
5. Build conservative catalog records from the donor schema and measured
   provider metadata.
6. Apply valid model-specific certification receipts.
7. Validate the default selection and every expected catalog slug through the
   Codex client.
8. Atomically publish the catalog and compatibility manifest.

The account snapshot is the source of truth for native model visibility. The
bundled catalog is not used to invent account access. The preview-only `build`
command can use the bundle as a diagnostic fallback, but persistent installation
cannot.

External slugs must begin with their provider namespace, such as
`lmstudio/qwen/qwen3.8-27b`. An unknown, differently cased, or prefix-only slug
fails before an upstream request is opened.

## Routing boundary

The bridge binds to IPv4 loopback only. Its URL contains a high-entropy random
capability segment stored in private runtime files. Host, Origin, method, path,
query, and protocol-upgrade checks fail closed.

### Native route

For an exact native slug, PickerMux forwards only the explicitly approved
authentication, routing, tracing, content, and compression headers needed by
the native Codex request. Request bodies and server-sent events remain byte
preserving on this route.

### External route

For an exact namespaced external slug, PickerMux discards the caller's header
set and constructs a new provider request. ChatGPT bearer tokens, cookies,
account identifiers, attestation values, and Codex metadata are not eligible for
the external header set. The external JSON body also excludes Codex
`client_metadata` and internal content annotations. Ordinary provider API
`metadata` remains part of the caller's request contract. Native request bodies
remain byte preserving.

Provider credentials are resolved only for the selected route. Persistent
providers can use a provider-scoped macOS Keychain item. Successful lookups are
coalesced and held in memory for no more than 30 seconds; values are not written
to logs, status output, configuration, or certification records.

## LM Studio adaptation

Codex and local models do not always expose identical Responses API behavior.
The LM Studio adapter therefore performs bounded, explicit normalization:

- rewrites the public namespaced slug to the upstream LM Studio model ID;
- gives uncertified text-only models a compact assistant prompt instead of the
  donor Codex coding-agent prompt;
- maps supported reasoning levels and omits only known synthetic defaults;
- removes unsupported cache and encrypted-reasoning fields;
- removes generated skill-catalog, permission, and plugin-recommendation
  bootstrap blocks only when their private Codex annotation, incoming message
  role, and single complete XML envelope all match the verified contract;
  unknown or malformed annotations stop further compaction, while user
  messages, attachments, project and managed instructions, memory, environment
  facts, app context, and conversation history are retained;
- combines system and developer messages into one leading system block while
  preserving chronological content;
- removes unsupported optional built-in tools;
- removes every optional function schema for an uncertified model and rejects
  forced choices or tool-call history on that text-only route;
- rejects a required tool choice when normalization would make it impossible;
- maps arbitrary Codex tool namespaces to collision-resistant function names;
- restores public namespace names in JSON and streaming responses;
- normalizes empty function parameter schemas.

Successful tool certification restores the full donor coding-agent prompt and
preserves its annotated context because those models can use the corresponding
Codex tool surface. Certification traffic itself receives the same treatment.

Request decompression supports gzip, deflate, Brotli, and Zstandard. Decoded
body size, response header size, header wait, stream idle time, and total
upstream duration are all bounded.

## Discovery and synchronization

The default LM Studio provider uses `loaded` discovery. It prefers
`/api/v1/models`, which reports loaded instances and active context sizes. A
fallback to `/v1/models` is accepted only when model type and context metadata
are explicit.

The persistent service observes Codex Desktop through LaunchServices:

- while Codex is running, endpoint discovery is paused and only local process
  state is checked;
- after Codex fully quits, synchronization begins promptly;
- while Codex remains closed, provider discovery is rate limited;
- a deliberate LM Studio connection refusal is treated as an empty loaded set;
- malformed data, timeouts, HTTP failures, and other transient errors retain the
  last known good state.

Catalog and route-registry publication is staged. If catalog publication or
selection reconciliation fails, the new route registry is not exposed.

## Tool certification

New external models are published with `tool_mode = null` and shell access
disabled. Certification runs seven serial Responses requests covering eight
required gates:

- `text`;
- `stream`;
- `function`;
- `parameterless`;
- `namespaceJson`;
- `namespaceStream`;
- `toolResult`;
- `longContext`.

Before probing, PickerMux invalidates the previous receipt and publishes a
text-only catalog. An interrupted or failed run therefore cannot preserve an
old tool grant. Certification requests carry a private per-runtime marker so
the bridge can exercise its tool adapter without reopening tools to ordinary
Codex traffic; the marker is removed by the external header allowlist. A
successful receipt is bound to the provider kind and ID, base URL, public and
upstream model IDs, active context size, reasoning metadata, capability
metadata, and Codex client version.

Receipts contain only the fingerprint, timestamp, and gate outcome. They do not
contain prompts, responses, or credentials.

## Installation and rollback

The integration installer owns only marked Codex configuration fields and
explicit files under `~/.codex/model-bridge`, plus its named LaunchAgent. It
creates a verified backup before changing Codex configuration.

Install and refresh stage the runtime, catalog, compatibility manifest, service
configuration, and selection update. The previous runtime package remains
available until catalog validation, bridge restart, Codex schema checks, and
the doctor all pass. A failure restores the previous files and service state.

Release setup validates the account-scoped Codex cache before staging a new
distribution, repeats the same read-only preflight under the lifecycle lock
before changing active CLI controls, and performs it once more immediately
before integration activation. A missing, malformed, or client-version-
mismatched cache therefore stops without changing active PickerMux state and
cannot silently fall back to the bundled catalog. The account-cache reader
opens only the exact `models_cache.json` inode and rejects symbolic or multiple
hard links before reading its payload, so it cannot be redirected to native
Codex authentication state.

Uninstall restores the verified prior Codex values and removes managed runtime
artifacts. It intentionally leaves backup directories and provider Keychain
items alone.

The release installer adds a separate, receipt-governed distribution layer.
Versioned CLI payloads live below
`~/Library/Application Support/PickerMux/versions`, an atomically replaced
`current` link selects the active payload, and `~/.local/bin/pickermux` is the
user-facing launcher. Setup never overwrites an entry or directory that cannot
be proven to belong to its private receipt.

Release activation reuses the same integration transaction: a fresh setup runs
install, while a healthy existing setup runs refresh using its installed
provider configuration. The distribution pointer is restored if activation
fails, and download, digest, or archive-validation failures occur before any
persistent mutation. Concurrent setup and removal are serialized by a private
installation lock.

Integration uninstall and distribution removal are intentionally distinct.
`uninstall` restores Codex and removes the bridge runtime; the explicit
`--remove-cli` option additionally removes only receipt-owned launcher and
version directories. Owned CLI paths are first moved into a private quarantine;
only then is the integration removed. A partial quarantine-cleanup failure
in this distribution layer cannot recreate or fragment the active installation
and does not block a later setup. After integration removal, the staged receipt,
launcher, pointer, versions, SHA-256 digests, and device/inode identities are
revalidated. Cleanup unlinks only that exact inventory and removes empty
directories without recursive deletion. Neither mode purges backups or
Keychain credentials.

Before any uninstall mutation, `runtime-app` is inventoried and compared
byte-for-byte with the invoking source distribution. Symlinks, special files,
modified or additional entries, and residual `runtime-app.previous-*` packages
fail closed. The accepted tree is renamed, revalidated by content digest and
filesystem identity, and removed one exact file and empty directory at a time;
runtime cleanup never uses recursive deletion.

The explicit `uninstall --purge` mode implies receipt-validated CLI removal and
also removes only validated PickerMux backup files and provider Keychain items
listed in the private, secret-free credential registry. Backup and registry
state is inventoried, quarantined, and revalidated before exact cleanup. It
rejects foreign or modified LaunchAgents, unexpected backup contents, unsafe
paths, and invalid ownership state. Native Codex credentials and unrecognized
files are always outside its scope; `~/.codex/auth.json` is never read,
modified, or removed.

Runtime, backup, and registry quarantines are separate from the distribution
quarantine. If one of their exact cleanups remains pending, purge fails and the
receipt-owned CLI is retained or restored for recovery instead of reporting a
successful full removal.

Credential mutation, install, refresh, certification, and purge serialize
registry updates through the same private lifecycle lock. Successful install
and refresh register configured Keychain provider IDs so upgrades from a
pre-registry release retain exact, secret-free deletion ownership. Registry
entries use the configuration's canonical provider-ID grammar and
127-character maximum.

Because macOS Keychain cannot atomically delete several items, the credential
phase begins only after CLI, registry, backup, runtime, and configuration
ownership has been staged or revalidated. Credential values are never read for
rollback. A partial credential failure leaves the integration active and
restores reversible state for an idempotent retry, while exact entries already
deleted remain absent. An integration failure after the credential phase also
retains the CLI and ownership receipts and is reported as an incomplete commit.

Receipts, hashes, inode identity, private random quarantines, and the lifecycle
lock protect against stale state and drift observed by cooperating PickerMux
commands. The final file removal primitive remains pathname based; a malicious
process already running as the same macOS user can race that last syscall. This
same-user boundary is explicit in `SECURITY.md`, and no purge path broadens into
recursive deletion.

## Compatibility contract

The installed `compatibility.json` binds the bridge contract to the Codex client
version and a canonical fingerprint of the bundled catalog. `status`, `doctor`,
and bridge startup all validate this contract. An unknown or changed contract
produces `update-required` and stops the bridge rather than silently adapting to
an unverified client update.

`doctor` also runs the account-cache inspection as an independent check. It can
therefore report whether the signed-in account cache matches the current Codex
client even when the bridge runtime or generated mixed catalog is absent.

## Private local data

The managed data directory is `~/.codex/model-bridge` unless `CODEX_HOME` is
overridden.

| Artifact | Purpose | Expected mode |
| --- | --- | --- |
| `models.json` | Generated mixed model catalog | Private file |
| `state.json` | Managed Codex configuration ownership state | Private file |
| `runtime.json` | Capability and runtime coordinates | Private file |
| `service-config.json` | Installed secret-free provider configuration | Private file |
| `certifications.json` | Model-bound tool certification receipts | Private file |
| `compatibility.json` | Installed client and catalog contract | Private file |
| `keychain-state.json` | Secret-free registry of PickerMux provider credential IDs | Private file |
| `runtime-app/` | Self-contained service runtime | Private directory |
| `backups/` | Verified configuration backups | Private directory |

The LaunchAgent is stored at
`~/Library/LaunchAgents/com.local.codex-model-bridge.plist`.

Release-distribution metadata is stored separately below
`~/Library/Application Support/PickerMux` so CLI version management cannot be
confused with Codex configuration ownership.
