# Representative Codex 0.151 context fixtures

These files contain only generated bootstrap payloads used to exercise
PickerMux's prompt-compaction trust boundary across wording changes. They
contain no user messages, account identifiers, capability URLs, or local
workspace paths. Their version identifies the observed source; the bytes are
regression inputs, not omission-authorizing hashes.

`codex-memory-read-path-0.151.md` comes from the Apache-2.0-licensed
`openai/codex` tag `rust-v0.151.0-alpha.7.2`, commit
`f70e26c29ccb731e22d1104de550b1b9594d7070`. The desktop-app,
thread-coordination, and root/subagent multi-agent policy fixtures are isolated
generated payloads observed with that Codex 0.151 Desktop contract. Tests use
them to prove that broad `generic.developer_instructions` remain intact while
private semantic kinds and exact wrapper envelopes can be compacted without
depending on version-specific prose.
