# PickerMux 0.7.1

Historical local candidate notes. A subsequent live retry passed all eight
base certification gates and the additive tool-search gate on the tested LM
Link model. The current unpublished candidate is
[0.7.2](RELEASE_NOTES_0.7.2.md); its validation status supersedes the snapshot
below. External-model web search remains pending.

Prepared locally on 2026-09-13; not published. Full live certification and
external-model web-search acceptance are pending. Confirm the release date and
complete the [candidate acceptance procedure](WEB_SEARCH_ACCEPTANCE.md) before
tagging or publishing.

PickerMux 0.7.1 improves certification transport and failure diagnostics while
retaining the experimental shared web search introduced in 0.7.0.

- **Bounded certification transport:** local probe requests use Node HTTP
  transport with their existing ten-minute deadline covering headers and body.
  This avoids default `fetch`'s independent five-minute transport limits, a
  possible cause of generic `fetch failed` during slow inference. The cause of
  the reported LM Link failure remains unproven until a complete live retry.
- **Actionable, private diagnostics:** failed probes identify the fixed probe
  label and a redacted `CERTIFICATION_*` code. Ordinary inference separately
  reports `MODEL_CERTIFICATION_PENDING` and `PROVIDER_CREDENTIAL_UNAVAILABLE`.
- **Normal upgrade from 0.7.0:** the fix has a new version so existing immutable
  packages can upgrade through setup. Runtime content and checksum checks stay
  enforced. Reasoning defaults, probe budgets, and certification gates remain
  unchanged.

A short bridge-to-LM-Link inference and native `web.run` search/open smoke
checks succeeded during investigation. These do not prove full certification
or external-model search. LM Link continues to use the local LM Studio API
when a linked device runs the model; see the
[certification troubleshooting guide](TROUBLESHOOTING.md#certification-reports-fetch-failed).

Shared search still adds no LM Studio inference request or result-summary pass.
The reviewed web-tool description remains reduced from 7,507 to 3,475 UTF-8
bytes; unknown descriptions, schemas, search budgets, and results are preserved.

PickerMux is an unofficial community project. It is not affiliated with,
endorsed by, or supported by OpenAI, Codex, or LM Studio.
