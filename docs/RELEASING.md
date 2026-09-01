# Releasing PickerMux

This checklist is for maintainers publishing a versioned GitHub release and its
one-line installer assets. PickerMux is distributed through GitHub Releases,
not the npm registry.

## Preflight

1. Confirm that all public documentation is in English and that private local
   engineering records remain ignored.
2. Keep the version identical in the Git tag, `package.json`, CLI output,
   release manifest, and `CHANGELOG.md` heading.
3. Inspect every staged file for credentials, account identifiers, private
   prompts, capability paths, hostnames, and machine-specific paths.
4. Run the complete verification suite on macOS:

   ```bash
   npm run verify
   ```

5. Build the release bundle locally and run its verification mode:

   ```bash
   node scripts/build-release.mjs --output dist
   ```

6. Confirm that `pickermux --version`, `help`, `--help`, and `-h` work from the
   extracted archive.
7. Verify README links and render the Mermaid architecture diagram.
8. For lifecycle changes, complete a real clean install, same-version rerun,
   upgrade, all three cache-mismatch preflight/race barriers, failed-upgrade
   rollback, standard uninstall, CLI removal, and full purge on supported
   macOS hardware.

## Release assets

Every release must contain all four generated assets:

- `pickermux-vX.Y.Z.tar.gz`: deterministic allowlisted payload;
- `install.sh`: release-specific bootstrap with the exact version, archive
  name, and archive SHA-256 embedded;
- `release-manifest.json`: machine-readable version, file allowlist, minimum
  Node.js version, archive name, and per-file digests;
- `SHA256SUMS`: digests for the payload, installer, and external manifest.

The payload allowlist is limited to the runtime entry points and sources,
default configuration, package metadata, release manifest, and license. Tests,
Git metadata, private notes, local artifacts, and arbitrary repository files
must not enter the archive.

The installer and archive are release artifacts. Do not point the README at
`raw.githubusercontent.com`, a branch archive, or GitHub's automatically
generated source archives.

## Automated release workflow

The release workflow runs only for semantic version tags and must complete
these gates before publication:

1. require the tagged commit to be part of `origin/main`;
2. compare the tag with `package.json`, CLI version output, and the changelog;
3. run `npm run verify` on macOS;
4. build the allowlisted payload twice and require identical archives;
5. generate the byte-identical internal and external release manifest, then
   embed the exact finished payload digest in the installer;
6. validate shell syntax, archive paths and file types, and required files;
7. extract the finished asset and run CLI version/help smoke tests;
8. upload the archive, installer, external release manifest, and checksum file
   to the matching GitHub Release only after every earlier gate passes.

Release assets must not be replaced after publication. If an artifact is wrong,
fix the source and publish a new version so existing pinned URLs retain a clear
security meaning.

## Initial `v0.4.0` release

The repository was published before a GitHub Release was created, so the
one-line installer is part of the first `v0.4.0` release rather than being
deferred to a later feature release.

After the release commit is on protected `main` and CI passes, create and push
the annotated tag:

```bash
git tag -a v0.4.0 -m "PickerMux v0.4.0"
git push origin v0.4.0
```

Watch the release workflow. Do not publish announcements until the generated
release exists and both the latest and version-pinned README installer URLs
work from a logged-out environment.

## Subsequent releases

For every release, require the release commit to be merged into and synchronized
with `main`, confirm that neither the tag nor release already exists, and then
create an annotated tag from that exact `main` commit. Never tag an unmerged PR
head or replace already published release assets.

## Manual acceptance matrix

At minimum, record:

- macOS version and architecture;
- Node.js 22.15.0 and the current supported Node.js line;
- Codex Desktop and LM Studio versions;
- clean setup, `--version`, `status`, and `doctor`;
- independent `codex-account-cache` doctor output with the runtime and mixed
  catalog absent;
- local model visibility after a full Codex restart;
- same-version rerun and upgrade from the preceding release;
- cache mismatch before staging, under the lifecycle lock, and immediately
  before activation, confirming that active CLI and bridge state remain
  unchanged in every case;
- checksum and foreign-launcher failures without mutation;
- integration-only uninstall and receipt-owned CLI removal, confirming that
  backups and Keychain items remain;
- full purge, confirming that only verified backups and registered PickerMux
  Keychain items are removed and foreign state is refused;
- runtime removal with a byte-identical installed payload, plus refusal of a
  modified payload, an added or symbolic-link entry, and a residual
  `runtime-app.previous-*` package without recursive deletion;
- provider-registry drift and an overlong provider ID, confirming that neither
  can expand the Keychain deletion set;
- distribution-quarantine additions and file replacements before and during
  exact cleanup, confirming that foreign bytes remain pending and are not
  recursively deleted;
- interrupted runtime, backup, and registry cleanup, confirming that full
  removal is not reported and the receipt-owned CLI remains available for
  explicit recovery;
- a failure on the second registered Keychain deletion, confirming a top-level
  `PICKERMUX_CREDENTIAL_PURGE_INCOMPLETE`, an active integration, restored
  receipts, and a successful idempotent retry;
- an integration failure after the Keychain phase, confirming a top-level
  `PICKERMUX_PURGE_COMMIT_INCOMPLETE`, retained recovery receipts, and no false
  full-removal success output;
- standalone `credential-delete` with a failing registry update, confirming
  that retry safely unregisters an already-absent exact Keychain item.

CI cannot prove current Codex Desktop, LM Studio, LaunchServices, or real model
behavior. Those checks remain a release-blocking manual gate whenever the
installer, bridge lifecycle, discovery, or compatibility contract changes.

## Announcement gate

Publish announcements only after:

- the repository and release URLs work in a logged-out browser;
- branch protection and CI are green;
- `install.sh`, the archive, `release-manifest.json`, and `SHA256SUMS` are
  present;
- the archive digest matches the value embedded in `install.sh`;
- the README's latest and pinned commands complete successfully;
- the default branch contains the license and security policy;
- announcement media contains no private account or machine information.
