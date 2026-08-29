## Summary

Describe the problem and the approach taken to solve it.

## Validation

- macOS version:
- Node.js version(s):
- Codex Desktop version (if involved):
- LM Studio version and model(s) (if involved):
- Installer/release asset impact (if involved):
- Commands run:

```text
npm test
npm run check
```

## Security and compatibility impact

Explain any effect on native credential isolation, provider routing, model
discovery, capability certification, local configuration, or the LaunchAgent.
Write `None` if the change does not touch these areas.

## Checklist

- [ ] I kept this change focused and documented its user-visible behavior.
- [ ] I added or updated tests for behavior changes and regressions.
- [ ] `npm test` passes locally.
- [ ] `npm run check` passes locally.
- [ ] I updated relevant documentation and the changelog.
- [ ] Installer changes preserve checksum, archive-validation, ownership, and
      rollback gates.
- [ ] I did not include credentials, account data, capability paths, private
      prompts, or unredacted logs.
- [ ] I called out limitations, unsupported assumptions, and follow-up work.
