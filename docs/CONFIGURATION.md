# Configuration

PickerMux reads `lmstudio-picker.config.json` from the project root by default.
Pass `--config PATH` to use another file for commands that load project
configuration. The managed release launcher points ordinary operational
commands at the installed service configuration, so it continues using the
configuration that was activated rather than silently replacing it during an
upgrade.

The schema is intentionally narrow. Unknown keys, inline secrets, ambiguous
credential sources, wildcard model entries, and configurable native Codex
destinations are rejected.

For a first release installation with a custom configuration, pass the path to
the shell that executes the installer:

```bash
/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL https://github.com/patrickschiller/pickermux/releases/latest/download/install.sh | PICKERMUX_CONFIG_PATH=/absolute/path/to/pickermux.config.json /bin/sh
```

The assignment belongs on the `/bin/sh` side of the pipeline. `setup` validates
the custom file and requires its external provider to expose at least one LLM
before creating the managed distribution. The activated contents are copied to
PickerMux's private service configuration; later upgrades reuse that copy and
do not replace it with a new release default.

## Default LM Studio configuration

The repository ships with a dynamic local configuration:

```json
{
  "schemaVersion": 2,
  "bridge": {
    "host": "127.0.0.1",
    "port": 4210,
    "providerId": "model_bridge",
    "defaultModel": "gpt-5.6-sol",
    "reasoningEffort": "ultra"
  },
  "smartRouting": {
    "enabled": false
  },
  "providers": [
    {
      "id": "lmstudio",
      "kind": "lmstudio-responses",
      "baseUrl": "http://127.0.0.1:1234/v1",
      "allowPrivateNetwork": true,
      "discovery": {
        "mode": "loaded",
        "maxModels": 32
      },
      "models": [
        {
          "id": "qwen/qwen3.8-27b",
          "slug": "lmstudio/qwen/qwen3.8-27b",
          "displayName": "Qwen3.8 27B – LM Studio",
          "reasoningEffort": "xhigh",
          "reasoningEfforts": ["none", "low", "medium", "xhigh"]
        }
      ]
    }
  ]
}
```

The explicit Qwen entry acts as a display-name and reasoning override. In
`loaded` mode, other loaded LLMs are still discovered automatically.

## Bridge fields

| Field | Purpose |
| --- | --- |
| `host` | Must be `127.0.0.1`. The bridge cannot bind to a LAN address. |
| `port` | Local bridge port. The default is `4210`. |
| `providerId` | Generated Codex provider ID. The default is `model_bridge`. |
| `defaultModel` | Native fallback selected when a local choice disappears. |
| `reasoningEffort` | Reasoning level for the native fallback. |
| `limits` | Optional bounded request, header, idle, and total-duration limits. |

The configured fallback must exist in the account-visible native catalog and
support the selected reasoning level at install time.

## Auto Smart Routing

Auto Smart Routing is an optional virtual model with the fixed public slug
`pickermux/auto`, display name `Auto – Smart Routing`, and strategy
`local-first-v1`. It is disabled by default. Omitting `smartRouting` is
equivalent to setting `enabled` to `false`, so existing schema-version-2
configurations remain valid without migration.

| Field | Default | Rules |
| --- | --- | --- |
| `enabled` | `false` | Boolean. When `true`, `localModel` is required. |
| `localModel` | None | Non-empty, single-line, namespaced slug for an exact model belonging to a configured `lmstudio-responses` provider. It cannot be `pickermux/auto`. |
| `fallbackModel` | `bridge.defaultModel` | Non-empty, single-line, unnamespaced native model slug. It cannot be `pickermux/auto` or equal `localModel`. |
| `maxLocalInputTokens` | `16384` | Positive safe integer from `1024` through `1048576`. The actual local limit is also capped at 75 percent of the current local model context window. |
| `complexityThreshold` | `3` | Integer from `1` through `10`. A score at or above this value selects the native fallback. |

These are the only accepted `smartRouting` properties. Unknown properties and
invalid supplied values are rejected even when `enabled` is `false`. The Auto
slug, display name, strategy, affinity lifetime, and affinity capacity are
fixed internal behavior in the initial implementation and are not configurable.

The namespace before the first `/` in `localModel` must identify a configured
provider whose `kind` is `lmstudio-responses`. With `discovery.mode` set to
`allowlist`, the exact slug must also appear in that provider's `models` array.
With `loaded` discovery, the slug does not need to appear in the static array and
does not need to be loaded while configuration is validated. An unavailable or
unloaded local model is a normal runtime fallback condition, not a configuration
error.

The native fallback must exist in the account-visible native catalog when the
Auto catalog entry is built. PickerMux does not silently substitute another
native model. Auto uses that exact native record as its advertised context,
modality, reasoning, tool, shell, and API capability contract, while the runtime
selector permits the local route only when the actual request is compatible.

Here is a complete enabled configuration:

```json
{
  "schemaVersion": 2,
  "bridge": {
    "host": "127.0.0.1",
    "port": 4210,
    "providerId": "model_bridge",
    "defaultModel": "gpt-5.6-sol",
    "reasoningEffort": "ultra",
    "limits": {
      "requestBodyBytes": 16777216,
      "responseHeaderBytes": 65536,
      "upstreamHeadersTimeoutMs": 600000,
      "streamIdleTimeoutMs": 600000,
      "upstreamTotalTimeoutMs": 1800000
    }
  },
  "smartRouting": {
    "enabled": true,
    "localModel": "lmstudio/qwen/qwen3.8-27b",
    "fallbackModel": "gpt-5.6-sol",
    "maxLocalInputTokens": 18000,
    "complexityThreshold": 3
  },
  "providers": [
    {
      "id": "lmstudio",
      "kind": "lmstudio-responses",
      "baseUrl": "http://127.0.0.1:1234/v1",
      "allowPrivateNetwork": true,
      "discovery": {
        "mode": "loaded",
        "maxModels": 32
      },
      "models": []
    }
  ]
}
```

Selecting `pickermux/auto` explicitly permits PickerMux to use either configured
destination. Availability, input modality, local context, current tool
certification, requested reasoning, request size, and deterministic complexity
can require the native fallback. Explicit native and namespaced external model
selections bypass Auto. Select the exact `lmstudio/...` model instead when a
request must remain local.

Auto performs no classifier request, prompt fan-out, or automatic
cross-provider retry. One inbound request is sent to one selected provider.

The context estimate is deterministic and dependency-free. PickerMux serializes
only `instructions`, `input`, and `tools`, measures their UTF-8 JSON byte length,
and conservatively divides by three. The estimate must fit both
`maxLocalInputTokens` and 75 percent of the exact local route's current context
window. Image, audio, file, and attachment input; exposed tools without current
local certification; and requested reasoning efforts `high`, `xhigh`, `max`, or
`ultra` require the native fallback.

Complexity scoring examines only the latest user-authored text, never system or
developer instructions, assistant history, function calls, or tool results. A
request receives one point at 4,000 characters, one additional point at 12,000
characters, one point at 200 lines, and two points once for a fixed bounded set
of conservative English and German high-complexity terms. A score greater than
or equal to `complexityThreshold` uses the fallback.

`pickermux status` and ordinary `pickermux doctor` report whether smart routing
is enabled, the fixed strategy and Auto slug, both configured candidates and
their current availability, the local input limit, and the complexity threshold.
A missing local model is a warning and falls back safely; a missing or
non-native fallback is an error. These checks do not submit a model prompt.

## Provider fields

| Field | Purpose |
| --- | --- |
| `id` | Lowercase provider namespace used as the external slug prefix; 1-127 characters using lowercase letters, digits, `_`, or `-`, with an alphanumeric first and last character. |
| `kind` | `lmstudio-responses` or `openai-responses`. |
| `baseUrl` | Absolute provider URL without credentials, query, or fragment. |
| `allowPrivateNetwork` | Required explicit decision for loopback, LAN, or Tailscale targets. |
| `credentialKeychain` | Resolve this provider's bearer token from the macOS Keychain. |
| `credentialEnv` | Development-only environment credential; persistent install rejects it. |
| `discovery` | `allowlist` or LM Studio-only `loaded` discovery policy. |
| `models` | Explicit model entries and optional overrides. |

Public providers must use HTTPS. Private HTTP is accepted only for recognized
private-network hosts and only when `allowPrivateNetwork` is `true`.

## Discovery modes

### `loaded`

Available only for `lmstudio-responses`. PickerMux publishes currently loaded
LLMs from LM Studio, bounded by `maxModels`. An empty `models` array is allowed;
explicit entries can still provide curated overrides.

### `allowlist`

Publishes only models explicitly listed in `models`. This is the default and is
required for generic `openai-responses` providers.

Each model has:

- `id`: exact upstream model ID;
- `slug`: public namespaced picker slug beginning with `<provider-id>/`;
- `displayName`: one-line picker label;
- optional `type`, which must be `llm`;
- optional positive `contextWindow`;
- optional `reasoningEffort` and `reasoningEfforts`.

## Remote LM Studio over Tailscale

PickerMux can reach LM Studio on another trusted Mac while keeping the bridge
itself loopback-only. Replace the provider URL with the remote Mac's stable
Tailscale IP or MagicDNS name:

```json
{
  "id": "lmstudio",
  "kind": "lmstudio-responses",
  "baseUrl": "http://100.64.0.10:1234/v1",
  "allowPrivateNetwork": true,
  "discovery": {
    "mode": "loaded",
    "maxModels": 32
  },
  "models": []
}
```

LM Studio must listen on the trusted interface and expose compatible
`/api/v1/models`, `/v1/models`, and `/v1/responses` endpoints. Do not expose LM
Studio directly to the public internet. Verify the Tailscale path before
installing:

```bash
curl http://100.64.0.10:1234/api/v1/models
pickermux discover --config /path/to/pickermux.config.json
```

Use a stable `.ts.net` MagicDNS name instead of an IP when appropriate.

## Authenticated Responses-compatible provider

Persistent services should use the macOS Keychain:

```json
{
  "id": "vendor",
  "kind": "openai-responses",
  "baseUrl": "https://api.vendor.example/v1",
  "allowPrivateNetwork": false,
  "credentialKeychain": true,
  "discovery": {
    "mode": "allowlist",
    "maxModels": 8
  },
  "models": [
    {
      "id": "vendor-reasoner",
      "slug": "vendor/vendor-reasoner",
      "displayName": "Vendor Reasoner",
      "type": "llm",
      "contextWindow": 32768,
      "reasoningEffort": "high",
      "reasoningEfforts": ["low", "medium", "high"]
    }
  ]
}
```

Store and inspect the credential without putting it on the command line:

```bash
pickermux credential-set vendor
pickermux credential-status vendor
```

`credential-set` delegates interactive secret capture to `/usr/bin/security`.
After a successful update, PickerMux records only the provider's canonical ID
in a private provider registry. The registry never contains the credential,
password, token, or other Keychain value. Status output reports only `available`
or `missing`.

A successful install or refresh also registers every configured
`credentialKeychain` provider ID. This safely migrates deletion ownership for
credentials created by PickerMux before the registry was introduced; it still
stores no credential value and can target only PickerMux's provider-scoped
Keychain service namespace.

Normal removal deliberately retains provider credentials and verified PickerMux
configuration backups, including when the receipt-owned CLI is removed:

```bash
pickermux uninstall
pickermux uninstall --remove-cli
```

Use the explicit full-removal mode only when those retained items should also
be deleted:

```bash
pickermux uninstall --purge
```

Purge uses the private registry to target only the exact PickerMux Keychain
entries previously registered by `credential-set`. It also removes only
backups whose PickerMux ownership and integrity can be verified. An unsafe,
foreign, modified, or ambiguous registry, backup, launcher, or distribution
state is refused instead of guessed at. `--force` does not bypass these
ownership checks. Purge never reads or deletes native Codex authentication,
including `~/.codex/auth.json`.

Uninstall also requires the installed `runtime-app` to match the invoking
PickerMux distribution byte-for-byte. Unexpected entries, modified files, or a
leftover `runtime-app.previous-*` package stop removal for explicit review; no
unrecognized runtime directory is deleted recursively.

## Applying configuration changes

If the provider identity and managed bridge contract remain compatible, apply
the edited source file explicitly:

```bash
pickermux refresh --config /absolute/path/to/pickermux.config.json
```

Without `--config`, the installed launcher intentionally reuses PickerMux's
private service-configuration copy rather than rereading the original source
file.

If PickerMux reports that the installed configuration differs from the project
configuration, use the explicit lifecycle:

```bash
pickermux uninstall
pickermux setup --config /absolute/path/to/pickermux.config.json
```

Fully quit and reopen Codex Desktop after a successful install, refresh, or
certification so it reloads the static catalog.
