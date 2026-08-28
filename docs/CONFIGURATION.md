# Configuration

PickerMux reads `lmstudio-picker.config.json` from the project root by default.
Pass `--config PATH` to use another file for commands that load project
configuration.

The schema is intentionally narrow. Unknown keys, inline secrets, ambiguous
credential sources, wildcard model entries, and configurable native Codex
destinations are rejected.

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

## Provider fields

| Field | Purpose |
| --- | --- |
| `id` | Lowercase provider namespace used as the external slug prefix. |
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
./bin/pickermux.mjs discover
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
./bin/pickermux.mjs credential-set vendor
./bin/pickermux.mjs credential-status vendor
```

`credential-set` delegates interactive secret capture to `/usr/bin/security`.
Status output reports only `available` or `missing`.

## Applying configuration changes

If the provider identity and managed bridge contract remain compatible, run:

```bash
./bin/pickermux.mjs refresh
```

If PickerMux reports that the installed configuration differs from the project
configuration, use the explicit lifecycle:

```bash
./bin/pickermux.mjs uninstall
./bin/pickermux.mjs install
```

Fully quit and reopen Codex Desktop after a successful install, refresh, or
certification so it reloads the static catalog.
