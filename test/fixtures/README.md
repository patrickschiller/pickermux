# Codex 0.151 context fixtures

These files contain only generated bootstrap payloads used to verify PickerMux's
fail-closed prompt-compaction contract. They contain no user messages, account
identifiers, capability URLs, or local workspace paths.

`codex-memory-read-path-0.151.md` comes from the Apache-2.0-licensed
`openai/codex` tag `rust-v0.151.0-alpha.7.2`, commit
`f70e26c29ccb731e22d1104de550b1b9594d7070`. The desktop-app,
thread-coordination, and root/subagent multi-agent policy fixtures are isolated
generated payloads observed with that Codex 0.151 Desktop contract. Their
complete normalized bytes are pinned; tests must not weaken a mismatch into a
partial or fuzzy match.
