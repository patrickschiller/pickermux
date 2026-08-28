# Releasing PickerMux

This checklist is for maintainers publishing a GitHub release.

## Preflight

1. Confirm that all public documentation is in English and that private local
   engineering records remain ignored.
2. Review `CHANGELOG.md`, `package.json`, and the CLI version metadata.
3. Inspect every staged file for credentials, account identifiers, private
   prompts, capability paths, hostnames, and machine-specific paths.
4. Run the complete verification suite on macOS:

   ```bash
   npm run verify
   ```

5. Confirm that `pickermux help`, `pickermux --help`, and `pickermux -h` work.
6. Verify the README links and render the Mermaid architecture diagram.
7. Test a clean install and uninstall on the supported Codex and LM Studio
   versions when the release changes lifecycle or routing behavior.

## Initial GitHub publication

Recommended repository name: `pickermux`.

Recommended description:

> Use locally loaded LM Studio models directly from the Codex Desktop picker,
> with automatic discovery, strict credential isolation, and conservative tool
> certification.

Recommended topics:

`codex`, `codex-desktop`, `lm-studio`, `local-llm`, `llm`, `macos`,
`model-router`, `openai`

After reviewing the staged files:

```bash
git branch -M main
git add .
git commit -m "Initial open-source release"
gh repo create patrickschiller/pickermux --public --source=. --remote=origin --push
```

Then set the description and topics in GitHub, enable Discussions if desired,
and enable private vulnerability reporting under **Settings > Security > Code
security and analysis**.

Protect `main` after the first push. At minimum, require the CI workflow to pass
before merging pull requests and prevent force pushes.

## Versioned release

1. Move completed entries out of `Unreleased` in `CHANGELOG.md`.
2. Update the package version and version assertions.
3. Commit the release metadata.
4. Create the annotated tag or GitHub release only after CI passes.
5. Verify that the release page, source archives, license detection, and README
   are public.

For the initial version:

```bash
gh release create v0.4.0 --title "PickerMux v0.4.0" --generate-notes
```

The package is intentionally marked `private` because this release targets
GitHub source distribution, not the npm registry. npm publication requires a
separate packaging and installation review.

## Announcement gate

Publish social announcements only after:

- the repository URL works in a logged-out browser;
- the default branch contains the license and security policy;
- CI has completed successfully;
- installation commands in the README match the public repository;
- announcement media focuses on local-model use and contains no private account
  or machine information.
