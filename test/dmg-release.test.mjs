import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { prepareDmgRelease, verifyDmgPublication } from "../scripts/prepare-dmg-release.mjs";
import { PICKERMUX_DMG_ASSET, dmgReleaseMarker, parseDmgReleaseRecord } from "../src/companion-release.mjs";
import { checkForCompanionUpdate } from "../src/companion-update.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const version = "1.2.3";
const tag = `v${version}`;

async function fixture(t, releaseVersion = version) {
  const root = await mkdtemp(path.join(tmpdir(), "pickermux-dmg-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDirectory = path.join(root, "source");
  const outputDirectory = path.join(root, "publication");
  await mkdir(sourceDirectory);
  const diskImage = Buffer.from("fixture immutable signed and notarized disk image");
  const manifest = {
    schemaVersion: 1, product: "pickermux-companion", version: releaseVersion, minimumMacOS: "13.0",
    architectures: ["arm64", "x86_64"], signing: "developer-id-notarized",
    backendManifestSha256: "c".repeat(64),
    archive: `PickerMux-v${releaseVersion}-macos-universal.tar.gz`, archiveSha256: "b".repeat(64),
    diskImage: { file: `PickerMux-v${releaseVersion}-macos-universal.dmg`, sha256: hash(diskImage), format: "UDZO", filesystem: "HFS+", installation: "drag-to-applications" },
  };
  const saveManifest = async () => {
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(sourceDirectory, "companion-manifest.json"), bytes);
    await writeFile(path.join(sourceDirectory, "SHA256SUMS"), `${manifest.archiveSha256}  ${manifest.archive}\n${manifest.diskImage.sha256}  ${manifest.diskImage.file}\n${hash(bytes)}  companion-manifest.json\n`);
  };
  await saveManifest();
  await writeFile(path.join(sourceDirectory, manifest.diskImage.file), diskImage);
  return { root, sourceDirectory, outputDirectory, diskImage, manifest, saveManifest };
}

test("publication stages exactly one unchanged DMG with a bound body checksum", async (t) => {
  const value = await fixture(t);
  const result = await prepareDmgRelease({ ...value, tag });
  assert.deepEqual(result, { version, diskImage: PICKERMUX_DMG_ASSET, sha256: hash(value.diskImage), signing: "developer-id-notarized" });
  assert.deepEqual((await readdir(value.outputDirectory)).sort(), [PICKERMUX_DMG_ASSET, "SHA256SUMS", "release-notes.md"].sort());
  assert.deepEqual(await readFile(path.join(value.outputDirectory, PICKERMUX_DMG_ASSET)), value.diskImage);
  const body = await readFile(path.join(value.outputDirectory, "release-notes.md"), "utf8");
  assert.deepEqual(parseDmgReleaseRecord(body, { version, file: PICKERMUX_DMG_ASSET }), { version, file: PICKERMUX_DMG_ASSET, sha256: result.sha256, signing: result.signing });
  assert.deepEqual(await verifyDmgPublication({ directory: value.outputDirectory, tag }), result);
  assert.deepEqual(await readFile(path.join(value.sourceDirectory, value.manifest.diskImage.file)), value.diskImage);
  assert.doesNotMatch(body, /introduces the macOS menu-bar app|previous public release|v0\.8\.3/u);
});

test("0.20.0 publication describes provider tokens and retains one canonical updater record", async (t) => {
  const value = await fixture(t, "0.20.0");
  const result = await prepareDmgRelease({ ...value, tag: "v0.20.0" });
  const body = await readFile(path.join(value.outputDirectory, "release-notes.md"), "utf8");
  assert.match(body, /Changes in v0\.20\.0/u);
  assert.match(body, /each external provider's input, output and total tokens/u);
  assert.match(body, /last finalized request/u);
  assert.match(body, /since bridge start/u);
  assert.match(body, /Missing counts are never treated as zero/u);
  assert.match(body, /no prompts, response text, credentials or request identifiers are persisted/u);
  assert.match(body, /For a first installation.*Use PickerMux in Codex.*to install the bundled backend/u);
  assert.match(body, /Existing users quit PickerMux, replace the app in Applications, eject the disk image and reopen PickerMux from Applications/u);
  assert.match(body, /Keep Codex fully quit and your provider models available, then choose \*\*Settings → Update installed backend…\*\*/u);
  assert.doesNotMatch(body, /Use PickerMux in Codex.*install or upgrade/u);
  assert.doesNotMatch(body, /introduces the macOS menu-bar app|previous public release|v0\.8\.3/u);
  assert.equal(body.split("pickermux-dmg-release-v1").length, 2);
  assert.deepEqual(parseDmgReleaseRecord(body, { version: "0.20.0", file: PICKERMUX_DMG_ASSET }), {
    version: "0.20.0", file: PICKERMUX_DMG_ASSET, sha256: hash(value.diskImage), signing: "developer-id-notarized",
  });
  assert.equal(await readFile(path.join(value.outputDirectory, "SHA256SUMS"), "utf8"), `${result.sha256}  ${PICKERMUX_DMG_ASSET}\n`);
  assert.deepEqual(await verifyDmgPublication({ directory: value.outputDirectory, tag: "v0.20.0" }), result);
  const update = await checkForCompanionUpdate({
    currentVersion: "0.10.0",
    fetchImpl: async () => Response.json({
      tag_name: "v0.20.0", draft: false, prerelease: false, body,
      assets: [{ name: PICKERMUX_DMG_ASSET, browser_download_url: `https://github.com/patrickschiller/pickermux/releases/download/v0.20.0/${PICKERMUX_DMG_ASSET}` }],
    }),
  });
  assert.equal(update.status, "available");
  assert.equal(update.distribution, "dmg");
  assert.equal(update.targetVersion, "0.20.0");
  assert.equal(update.diskImageSha256, result.sha256);
});

test("unsigned and Apple Development builds cannot become public releases", async (t) => {
  for (const signing of ["unsigned-development", "apple-development"]) {
    const value = await fixture(t);
    value.manifest.signing = signing;
    await value.saveManifest();
    await assert.rejects(prepareDmgRelease({ ...value, tag }), /Developer ID/u);
    await assert.rejects(readdir(value.outputDirectory), { code: "ENOENT" });
  }
});

test("wrong versions, unsafe names and incomplete platform metadata fail before staging", async (t) => {
  const mutations = [
    (manifest) => { manifest.version = "1.2.2"; },
    (manifest) => { manifest.diskImage.file = "../foreign.dmg"; },
    (manifest) => { manifest.diskImage.installation = "run-installer"; },
    (manifest) => { manifest.diskImage.format = "UDRW"; },
    (manifest) => { manifest.architectures = ["arm64"]; },
    (manifest) => { manifest.backendManifestSha256 = "invalid"; },
  ];
  for (const mutate of mutations) {
    const value = await fixture(t);
    mutate(value.manifest);
    await value.saveManifest();
    await assert.rejects(prepareDmgRelease({ ...value, tag }), /DMG publication/u);
    await assert.rejects(readdir(value.outputDirectory), { code: "ENOENT" });
  }
  const value = await fixture(t);
  for (const invalidTag of ["1.2.3", "v1.2.3-beta", "v../escape"]) {
    await assert.rejects(prepareDmgRelease({ ...value, tag: invalidTag }), /DMG publication/u);
  }
});

test("tampered disk image, manifest or checksums never produce a public candidate", async (t) => {
  const mutations = [
    async (value) => writeFile(path.join(value.sourceDirectory, value.manifest.diskImage.file), "changed disk image"),
    async (value) => writeFile(path.join(value.sourceDirectory, "companion-manifest.json"), JSON.stringify({ ...value.manifest, backendManifestSha256: "d".repeat(64) })),
    async (value) => writeFile(path.join(value.sourceDirectory, "SHA256SUMS"), `${"a".repeat(64)}  ${value.manifest.diskImage.file}\n`),
  ];
  for (const mutate of mutations) {
    const value = await fixture(t);
    await mutate(value);
    await assert.rejects(prepareDmgRelease({ ...value, tag }), /DMG publication/u);
    await assert.rejects(readdir(value.outputDirectory), { code: "ENOENT" });
  }
});

test("publication refuses linked assets and preserves existing output", async (t) => {
  for (const makeLink of [symlink, link]) {
    const value = await fixture(t);
    const diskImagePath = path.join(value.sourceDirectory, value.manifest.diskImage.file);
    const foreign = path.join(value.root, "foreign.dmg");
    await writeFile(foreign, value.diskImage);
    await rm(diskImagePath);
    await makeLink(foreign, diskImagePath);
    await assert.rejects(prepareDmgRelease({ ...value, tag }));
    assert.deepEqual(await readFile(foreign), value.diskImage);
    await assert.rejects(readdir(value.outputDirectory), { code: "ENOENT" });
  }
  const value = await fixture(t);
  await mkdir(value.outputDirectory);
  await writeFile(path.join(value.outputDirectory, "contributor.txt"), "preserve me");
  await assert.rejects(prepareDmgRelease({ ...value, tag }), { code: "EEXIST" });
  assert.equal(await readFile(path.join(value.outputDirectory, "contributor.txt"), "utf8"), "preserve me");
});

test("final publication verification rejects extra assets, altered bytes and stale body records", async (t) => {
  const mutations = [
    async (value) => writeFile(path.join(value.outputDirectory, "install.sh"), "unreviewed asset"),
    async (value) => writeFile(path.join(value.outputDirectory, PICKERMUX_DMG_ASSET), "changed disk image"),
    async (value) => writeFile(path.join(value.outputDirectory, "release-notes.md"), dmgReleaseMarker({ version: "1.2.2", sha256: hash(value.diskImage) })),
    async (value) => writeFile(path.join(value.outputDirectory, "release-notes.md"), `${dmgReleaseMarker({ version, sha256: hash(value.diskImage) })}\n${dmgReleaseMarker({ version, sha256: hash(value.diskImage) })}`),
  ];
  for (const mutate of mutations) {
    const value = await fixture(t);
    await prepareDmgRelease({ ...value, tag });
    await mutate(value);
    await assert.rejects(verifyDmgPublication({ directory: value.outputDirectory, tag }));
  }
});

test("tag release workflow gates one explicit DMG on exact main, tests and protected signing", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /run: npm run verify/u);
  assert.match(workflow, /run: swift test --package-path macos/u);
  assert.match(workflow, /runs-on: \[self-hosted, macOS, pickermux-signing\]/u);
  assert.match(workflow, /signed-dmg:\n    name: [^\n]+\n    needs: verify\n    if: vars\.PICKERMUX_SIGNING_RUNNER_ENABLED == 'true'/u);
  assert.match(workflow, /environment: companion-signing/u);
  assert.match(workflow, /scripts\/build-companion\.mjs --release/u);
  assert.match(workflow, /needs: signed-dmg/u);
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME" release-assets\/PickerMux-macos-universal\.dmg \\/u);
  assert.equal(workflow.includes("release-assets/*"), false);
  assert.equal(workflow.includes("--generate-notes"), false);
  assert.match(workflow, /git rev-parse refs\/remotes\/origin\/main/u);
  // Parse each literal run block with the shell without executing any command.
  for (const block of workflow.matchAll(/^        run: \|\n((?:          .*\n)+)/gmu)) {
    const shell = block[1].split("\n").map((line) => line.slice(10)).join("\n");
    const result = spawnSync("/bin/bash", ["-n"], { input: shell, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});
