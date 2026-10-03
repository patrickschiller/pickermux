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

test("0.20.1 viewport patch retains the DMG record accepted by the 0.20.0 updater", async (t) => {
  const value = await fixture(t, "0.20.1");
  const result = await prepareDmgRelease({ ...value, tag: "v0.20.1" });
  const body = await readFile(path.join(value.outputDirectory, "release-notes.md"), "utf8");
  assert.match(body, /Changes in v0\.20\.1/u);
  assert.match(body, /collapsed menu-bar viewport.*controls and token values/u);
  assert.match(body, /fixed 400-by-600-point panel with vertical scrolling/u);
  assert.match(body, /this patch changes the menu layout/u);
  assert.doesNotMatch(body, /Changes in v0\.20\.0|introduces the macOS menu-bar app|previous public release/u);
  assert.equal(body.split("pickermux-dmg-release-v1").length, 2);
  assert.deepEqual(parseDmgReleaseRecord(body, { version: "0.20.1", file: PICKERMUX_DMG_ASSET }), {
    version: "0.20.1", file: PICKERMUX_DMG_ASSET, sha256: hash(value.diskImage), signing: "developer-id-notarized",
  });
  assert.deepEqual(await readFile(path.join(value.outputDirectory, PICKERMUX_DMG_ASSET)), value.diskImage);
  assert.equal(await readFile(path.join(value.outputDirectory, "SHA256SUMS"), "utf8"), `${result.sha256}  ${PICKERMUX_DMG_ASSET}\n`);
  assert.deepEqual(await verifyDmgPublication({ directory: value.outputDirectory, tag: "v0.20.1" }), result);
  const expectedUrl = `https://github.com/patrickschiller/pickermux/releases/download/v0.20.1/${PICKERMUX_DMG_ASSET}`;
  const update = await checkForCompanionUpdate({
    currentVersion: "0.20.0",
    fetchImpl: async () => Response.json({
      tag_name: "v0.20.1", draft: false, prerelease: false, body,
      assets: [{ name: PICKERMUX_DMG_ASSET, browser_download_url: expectedUrl }],
    }),
  });
  assert.deepEqual(update, {
    status: "available", distribution: "dmg", currentVersion: "0.20.0", targetVersion: "0.20.1",
    assets: { [PICKERMUX_DMG_ASSET]: expectedUrl }, diskImageSha256: result.sha256,
  });
});

test("0.22.0 publication combines menu, usage, recovery and experimental voice changes", async (t) => {
  const value = await fixture(t, "0.22.0");
  const result = await prepareDmgRelease({ ...value, tag: "v0.22.0" });
  const body = await readFile(path.join(value.outputDirectory, "release-notes.md"), "utf8");
  assert.match(body, /Changes in v0\.22\.0/u);
  assert.match(body, /compact 320-point macOS menu with vertically stacked token summaries/u);
  assert.match(body, /direct Refresh picker, Open Codex, Check status and Check installation/u);
  assert.match(body, /usage across bridge restarts, refreshes and backend upgrades/u);
  assert.match(body, /since reset/u);
  assert.match(body, /Reset accumulated counts….*retaining the last model request/u);
  assert.match(body, /private local storage.*prompts, response text, credentials, endpoints and request identifiers remain excluded/u);
  assert.match(body, /service_tier.*retaining receipt verification and preserving the setting/u);
  assert.match(body, /Reconnecting in historical chats after deactivation or uninstall: fully restart Codex/u);
  assert.match(body, /Changing the selected model can leave an existing chat on model_bridge; saved chat providers are unchanged/u);
  assert.match(body, /experimental GPT-Live WebRTC bootstrap.*reviewed POST \/v1\/live request/u);
  assert.match(body, /OpenAI receives voice audio and conversation context; delegated tasks retain the selected Responses model, including certified local models/u);
  assert.match(body, /A compatible Codex client, native account and voice access, and target-Mac voice acceptance are required; bridge WebSocket upgrades remain unsupported/u);
  assert.doesNotMatch(body, /Changes in v0\.2[01]\.[01]|Counts reset when the bridge restarts|live acceptance passed|acceptance remains pending|fully local voice/iu);
  assert.equal(body.split("pickermux-dmg-release-v1").length, 2);
  assert.deepEqual(parseDmgReleaseRecord(body, { version: "0.22.0", file: PICKERMUX_DMG_ASSET }), {
    version: "0.22.0", file: PICKERMUX_DMG_ASSET, sha256: hash(value.diskImage), signing: "developer-id-notarized",
  });
  assert.deepEqual((await readdir(value.outputDirectory)).sort(), [PICKERMUX_DMG_ASSET, "SHA256SUMS", "release-notes.md"].sort());
  assert.deepEqual(await readFile(path.join(value.outputDirectory, PICKERMUX_DMG_ASSET)), value.diskImage);
  assert.equal(await readFile(path.join(value.outputDirectory, "SHA256SUMS"), "utf8"), `${result.sha256}  ${PICKERMUX_DMG_ASSET}\n`);
  assert.deepEqual(await verifyDmgPublication({ directory: value.outputDirectory, tag: "v0.22.0" }), result);
  const expectedUrl = `https://github.com/patrickschiller/pickermux/releases/download/v0.22.0/${PICKERMUX_DMG_ASSET}`;
  const release = {
    tag_name: "v0.22.0", draft: false, prerelease: false, body,
    assets: [{ name: PICKERMUX_DMG_ASSET, browser_download_url: expectedUrl }],
  };
  for (const currentVersion of ["0.20.1", "0.21.0"]) {
    const update = await checkForCompanionUpdate({
      currentVersion,
      fetchImpl: async () => Response.json(release),
    });
    assert.deepEqual(update, {
      status: "available", distribution: "dmg", currentVersion, targetVersion: "0.22.0",
      assets: { [PICKERMUX_DMG_ASSET]: expectedUrl }, diskImageSha256: result.sha256,
    });
  }
  const mutations = [
    (candidate) => { candidate.body = dmgReleaseMarker({ version: "0.21.0", sha256: result.sha256 }); },
    (candidate) => { candidate.assets[0].browser_download_url = expectedUrl.replace("v0.22.0", "v0.21.0"); },
    (candidate) => { candidate.assets[0].browser_download_url = expectedUrl.replace("download/v0.22.0", "latest/download"); },
    (candidate) => { candidate.assets.push({ name: "install.sh", browser_download_url: `${expectedUrl}/install.sh` }); },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(release);
    mutate(candidate);
    await assert.rejects(checkForCompanionUpdate({
      currentVersion: "0.20.1",
      fetchImpl: async () => Response.json(candidate),
    }), { code: "UPDATE_INVALID" });
  }
});

test("0.22.1 web guidance patch preserves the signed DMG update contract", async (t) => {
  const value = await fixture(t, "0.22.1");
  const result = await prepareDmgRelease({ ...value, tag: "v0.22.1" });
  const body = await readFile(path.join(value.outputDirectory, "release-notes.md"), "utf8");
  assert.match(body, /Changes in v0\.22\.1/u);
  assert.match(body, /Codex web\.run.*advertised function alias/u);
  assert.match(body, /source URL directly with open\.ref_id/u);
  assert.match(body, /open and find are parameters/u);
  assert.match(body, /find and load a needed tool before declaring it unavailable/u);
  assert.match(body, /Preserve original discovery instructions.*certification requirements/u);
  assert.match(body, /offline regression tests.*still require live validation/u);
  assert.doesNotMatch(body, /live acceptance passed|guarantee(?:d|s)? factual accuracy/iu);
  assert.equal(body.split("pickermux-dmg-release-v1").length, 2);
  assert.deepEqual(await verifyDmgPublication({ directory: value.outputDirectory, tag: "v0.22.1" }), result);
  const expectedUrl = `https://github.com/patrickschiller/pickermux/releases/download/v0.22.1/${PICKERMUX_DMG_ASSET}`;
  const release = {
    tag_name: "v0.22.1", draft: false, prerelease: false, body,
    assets: [{ name: PICKERMUX_DMG_ASSET, browser_download_url: expectedUrl }],
  };
  assert.deepEqual(await checkForCompanionUpdate({
    currentVersion: "0.22.0",
    fetchImpl: async () => Response.json(release),
  }), {
    status: "available", distribution: "dmg", currentVersion: "0.22.0", targetVersion: "0.22.1",
    assets: { [PICKERMUX_DMG_ASSET]: expectedUrl }, diskImageSha256: result.sha256,
  });
  const mismatched = structuredClone(release);
  mismatched.body = dmgReleaseMarker({ version: "0.22.0", sha256: result.sha256 });
  await assert.rejects(checkForCompanionUpdate({
    currentVersion: "0.22.0",
    fetchImpl: async () => Response.json(mismatched),
  }), { code: "UPDATE_INVALID" });
});

test("0.22.2 automatic review and video retain one immutable DMG update contract", async (t) => {
  const value = await fixture(t, "0.22.2");
  const result = await prepareDmgRelease({ ...value, tag: "v0.22.2" });
  const body = await readFile(path.join(value.outputDirectory, "release-notes.md"), "utf8");
  assert.match(body, /One confirmation starts the existing upgrade transaction/u);
  assert.match(body, /never enables an inactive integration or quits Codex/u);
  assert.match(body, /cancellation or failure suppresses repeated automatic offers/u);
  assert.match(body, /confirm \*\*Update backend\*\*/u);
  assert.match(body, /Settings → Update installed backend…/u);
  assert.match(body, /36-second German explainer.*\/blob\/v0\.22\.2\/README\.md/u);
  assert.match(body, /maintainer reported target-Mac acceptance/u);
  assert.match(body, /confirmed backend upgrade to 0\.22\.2 with provider settings preserved/u);
  assert.doesNotMatch(body, /live acceptance passed|automatically installs without confirmation/iu);
  assert.equal(body.split("pickermux-dmg-release-v1").length, 2);
  assert.deepEqual(await verifyDmgPublication({ directory: value.outputDirectory, tag: "v0.22.2" }), result);
  const expectedUrl = `https://github.com/patrickschiller/pickermux/releases/download/v0.22.2/${PICKERMUX_DMG_ASSET}`;
  const release = {
    tag_name: "v0.22.2", draft: false, prerelease: false, body,
    assets: [{ name: PICKERMUX_DMG_ASSET, browser_download_url: expectedUrl }],
  };
  for (const currentVersion of ["0.22.0", "0.22.1"]) {
    assert.deepEqual(await checkForCompanionUpdate({ currentVersion, fetchImpl: async () => Response.json(release) }), {
      status: "available", distribution: "dmg", currentVersion, targetVersion: "0.22.2",
      assets: { [PICKERMUX_DMG_ASSET]: expectedUrl }, diskImageSha256: result.sha256,
    });
  }
  for (const mutate of [
    (candidate) => { candidate.body = dmgReleaseMarker({ version: "0.22.1", sha256: result.sha256 }); },
    (candidate) => { candidate.assets.push({ name: "explainer.mp4", browser_download_url: `${expectedUrl}/explainer.mp4` }); },
  ]) {
    const candidate = structuredClone(release);
    mutate(candidate);
    await assert.rejects(checkForCompanionUpdate({ currentVersion: "0.22.1", fetchImpl: async () => Response.json(candidate) }), { code: "UPDATE_INVALID" });
  }
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
