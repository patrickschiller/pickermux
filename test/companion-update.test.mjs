import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";

import { buildRelease } from "../scripts/build-release.mjs";
import { projectRoot } from "../src/paths.mjs";
import { activateVerifiedCompanionPayload, applyCompanionUpdate, checkForCompanionUpdate, inspectCompanionArchive, verifyCompanionPayload } from "../src/companion-update.mjs";
import { PICKERMUX_DMG_ASSET, dmgReleaseMarker } from "../src/companion-release.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function diskImageRelease() {
  const version = "1.0.0";
  return {
    tag_name: `v${version}`, draft: false, prerelease: false,
    body: dmgReleaseMarker({ version, sha256: "a".repeat(64) }),
    assets: [{ name: PICKERMUX_DMG_ASSET, browser_download_url: `https://github.com/patrickschiller/pickermux/releases/download/v${version}/${PICKERMUX_DMG_ASSET}` }],
  };
}

test("a DMG-only release is available without requesting old CLI assets", async () => {
  let calls = 0;
  const release = diskImageRelease();
  const result = await checkForCompanionUpdate({ currentVersion: "0.9.6", fetchImpl: async (url) => {
    calls += 1;
    assert.equal(url, "https://api.github.com/repos/patrickschiller/pickermux/releases/latest");
    return Response.json(release);
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    status: "available", distribution: "dmg", currentVersion: "0.9.6", targetVersion: "1.0.0",
    assets: { [PICKERMUX_DMG_ASSET]: release.assets[0].browser_download_url }, diskImageSha256: "a".repeat(64),
  });
});

test("a DMG update requires app replacement and never downloads or activates a CLI payload", async () => {
  let calls = 0;
  const phases = [];
  await assert.rejects(applyCompanionUpdate({ currentVersion: "0.9.6", onProgress: (event) => phases.push(event.phase),
    fetchImpl: async (url) => {
      calls += 1;
      assert.equal(url, "https://api.github.com/repos/patrickschiller/pickermux/releases/latest");
      return Response.json(diskImageRelease());
    }, activateImpl: async () => assert.fail("DMGs cannot activate the CLI"),
  }), { code: "DOWNLOAD_REQUIRED" });
  assert.equal(calls, 1);
  assert.deepEqual(phases, ["checking"]);
});

test("DMG release metadata rejects foreign, duplicate, mixed and unbound candidates", async () => {
  const mutations = [
    (release) => { release.assets[0].browser_download_url = "https://evil.example/PickerMux-macos-universal.dmg"; },
    (release) => { release.assets[0].browser_download_url = release.assets[0].browser_download_url.replace("https:", "http:"); },
    (release) => { release.assets[0].browser_download_url = release.assets[0].browser_download_url.replace("v1.0.0/", "v0.9.6/"); },
    (release) => { release.assets.push({ ...release.assets[0] }); },
    (release) => { release.assets.push({ name: "install.sh", browser_download_url: "https://github.com/patrickschiller/pickermux/releases/download/v1.0.0/install.sh" }); },
    (release) => { release.assets[0].name = "PickerMux-v1.0.0-macos-universal.dmg"; },
    (release) => { delete release.body; },
    (release) => { release.body = release.body.replace("1.0.0", "0.9.6"); },
    (release) => { release.body = release.body.replace("developer-id-notarized", "apple-development"); },
    (release) => { release.body += `\n${release.body}`; },
    (release) => { release.body = "x".repeat(64 * 1024) + release.body; },
    (release) => { release.body = release.body.replace('"sha256":', '"sha256":"b","sha256":'); },
    (release) => { release.body = release.body.replace("a".repeat(64), "z".repeat(64)); },
  ];
  for (const mutate of mutations) {
    const release = diskImageRelease();
    mutate(release);
    await assert.rejects(checkForCompanionUpdate({ currentVersion: "0.9.6", fetchImpl: async () => Response.json(release) }), { code: "UPDATE_INVALID" });
  }
});

test("a current DMG release does not download or activate anything", async () => {
  let calls = 0;
  const result = await applyCompanionUpdate({ currentVersion: "1.0.0", fetchImpl: async () => {
    calls += 1;
    return Response.json(diskImageRelease());
  }, activateImpl: async () => assert.fail("current app cannot activate an update") });
  assert.deepEqual(result, { status: "current", currentVersion: "1.0.0", targetVersion: "1.0.0" });
  assert.equal(calls, 1);
});

async function releaseFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "pickermux-update-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDirectory = path.join(root, "release");
  const result = await buildRelease({ projectDirectory: projectRoot, outputDirectory });
  const files = new Map(await Promise.all(result.assets.map(async (name) => [name, await readFile(path.join(outputDirectory, name))])));
  const release = { tag_name: `v${result.version}`, draft: false, prerelease: false, assets: result.assets.map((name) => ({ name, browser_download_url: `https://github.com/patrickschiller/pickermux/releases/download/v${result.version}/${name}` })) };
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.authorization, undefined);
    if (url === "https://api.github.com/repos/patrickschiller/pickermux/releases/latest") return Response.json(release);
    const name = url.slice(url.lastIndexOf("/") + 1);
    assert.equal(url, `https://github.com/patrickschiller/pickermux/releases/download/v${result.version}/${name}`);
    assert.ok(files.has(name));
    return new Response(files.get(name));
  };
  return { result, files, release, fetchImpl, payload: { archive: files.get(result.archiveName), manifestBytes: files.get("release-manifest.json"), checksumsBytes: files.get("SHA256SUMS"), version: result.version } };
}

test("updates are pinned to official assets, verified before activation and privately extracted", async (t) => {
  const fixture = await releaseFixture(t);
  const candidate = await checkForCompanionUpdate({ currentVersion: "0.0.1", fetchImpl: fixture.fetchImpl });
  assert.equal(candidate.status, "available");
  let staging;
  const result = await applyCompanionUpdate({
    currentVersion: "0.0.1", fetchImpl: fixture.fetchImpl,
    activateImpl: async ({ sourceRoot }) => {
      staging = sourceRoot;
      const metadata = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
      assert.equal(metadata.version, fixture.result.version);
      assert.equal(await readFile(path.join(sourceRoot, "src", "cli.mjs"), "utf8"), await readFile(path.join(projectRoot, "src", "cli.mjs"), "utf8"));
      return { updated: true, restartRequired: true };
    },
  });
  assert.equal(result.updated, true);
  assert.equal(result.targetVersion, fixture.result.version);
  await assert.rejects(readFile(path.join(staging, "package.json")), { code: "ENOENT" });
});

test("current release never downloads or activates a payload", async (t) => {
  const fixture = await releaseFixture(t);
  let count = 0;
  const result = await applyCompanionUpdate({ currentVersion: fixture.result.version, fetchImpl: async (...args) => { count += 1; return fixture.fetchImpl(...args); }, activateImpl: async () => assert.fail("must not activate") });
  assert.equal(result.status, "current");
  assert.equal(count, 1);
});

test("untrusted release metadata, duplicates and redirects fail before payload execution", async () => {
  for (const release of [
    { tag_name: "v1.0.0", draft: true, prerelease: false, assets: [] },
    { tag_name: "v1.0.0", draft: false, prerelease: false, assets: [{ name: "pickermux-v1.0.0.tar.gz", browser_download_url: "https://evil.example/payload" }] },
  ]) {
    await assert.rejects(checkForCompanionUpdate({ currentVersion: "0.0.1", fetchImpl: async () => Response.json(release) }), { code: "UPDATE_INVALID" });
  }
  await assert.rejects(checkForCompanionUpdate({ currentVersion: "0.0.1", fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }) }), { code: "UPDATE_INVALID" });
});

test("archive checksum, file inventory and embedded manifest are authoritative", async (t) => {
  const fixture = await releaseFixture(t);
  const entries = verifyCompanionPayload(fixture.payload);
  assert.ok(entries.has("src/cli.mjs"));
  const archive = Buffer.from(fixture.payload.archive);
  archive[archive.length - 1] ^= 1;
  assert.throws(() => verifyCompanionPayload({ ...fixture.payload, archive }), { code: "UPDATE_INVALID" });
  const manifestBytes = Buffer.from(JSON.stringify({ ...JSON.parse(fixture.payload.manifestBytes), files: [] }));
  const checksumsBytes = Buffer.from(`${hash(fixture.payload.archive)}  ${fixture.result.archiveName}\n${hash(manifestBytes)}  release-manifest.json\n${"a".repeat(64)}  install.sh\n`);
  assert.throws(() => verifyCompanionPayload({ ...fixture.payload, manifestBytes, checksumsBytes }), { code: "UPDATE_INVALID" });
});

test("archive links, traversal, duplicate names and malformed checksums are rejected", async (t) => {
  const fixture = await releaseFixture(t);
  const original = gunzipSync(fixture.payload.archive);
  for (const mutation of [
    (bytes) => { bytes[156] = 50; },
    (bytes) => { bytes.fill(0, 0, 100); bytes.write("../escape", 0, "ascii"); },
    (bytes) => { bytes[148] = 120; return false; },
  ]) {
    const bytes = Buffer.from(original);
    if (mutation(bytes) !== false) {
      bytes.fill(32, 148, 156);
      const sum = bytes.subarray(0, 512).reduce((total, byte) => total + byte, 0);
      bytes.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    }
    assert.throws(() => inspectCompanionArchive(gzipSync(bytes)), { code: "UPDATE_INVALID" });
  }
  const oneHeader = original.subarray(0, 512);
  assert.throws(() => inspectCompanionArchive(gzipSync(Buffer.concat([oneHeader, oneHeader, Buffer.alloc(1024)]))), { code: "UPDATE_INVALID" });
});

test("download limits and unsafe release-storage redirects prevent activation", async (t) => {
  const fixture = await releaseFixture(t);
  await assert.rejects(applyCompanionUpdate({ currentVersion: "0.0.1", fetchImpl: async (url, options) => url.includes("api.github.com") ? fixture.fetchImpl(url, options) : new Response(null, { status: 302, headers: { location: "http://release-assets.githubusercontent.com/payload" } }), activateImpl: async () => assert.fail("must not activate") }), { code: "UPDATE_INVALID" });
  await assert.rejects(checkForCompanionUpdate({ currentVersion: "0.0.1", fetchImpl: async () => new Response("{}", { headers: { "content-length": "999999999" } }) }), { code: "UPDATE_INVALID" });
});

test("failed activation cleans only the private staging payload", async (t) => {
  const fixture = await releaseFixture(t);
  let staging;
  await assert.rejects(applyCompanionUpdate({ currentVersion: "0.0.1", fetchImpl: fixture.fetchImpl, activateImpl: async ({ sourceRoot }) => { staging = sourceRoot; throw new Error("fixture failure"); } }), /fixture failure/u);
  await assert.rejects(readFile(path.join(staging, "package.json")), { code: "ENOENT" });
});

test("activation reports committed certification failures without exposing child diagnostics", async () => {
  const options = { sourceRoot: "/private/verified", targetVersion: "1.0.0", environment: { HOME: "/safe/home", PROVIDER_TOKEN: "SECRET", NODE_OPTIONS: "unsafe" } };
  const execFileImpl = async (file, argumentsList, childOptions) => {
    assert.equal(file, process.execPath);
    assert.deepEqual(argumentsList, ["/private/verified/bin/pickermux.mjs", "setup", "--distribution-root", "/private/verified", "--json"]);
    assert.equal(childOptions.env.PROVIDER_TOKEN, undefined);
    assert.equal(childOptions.env.NODE_OPTIONS, undefined);
    const error = new Error("PRIVATE_DIAGNOSTICS");
    error.code = 1;
    error.stdout = JSON.stringify({ version: "1.0.0", activation: { action: "upgrade" }, certification: { status: "incomplete", error: "PRIVATE_DIAGNOSTICS" } });
    throw error;
  };
  assert.deepEqual(await activateVerifiedCompanionPayload({ ...options, execFileImpl }), { updated: true, restartRequired: true, certificationIncomplete: true });
  for (const result of [{ version: "0.9.0", activation: { action: "upgrade" }, certification: { status: "incomplete" } }, { version: "1.0.0", activation: { action: "upgrade" }, certification: { status: "complete" } }]) {
    await assert.rejects(activateVerifiedCompanionPayload({ ...options, execFileImpl: async () => { const error = new Error("PRIVATE"); error.code = 1; error.stdout = JSON.stringify(result); throw error; } }), { code: "UPDATE_INVALID" });
  }
  await assert.rejects(activateVerifiedCompanionPayload({ ...options, execFileImpl: async () => { const error = new Error("PRIVATE"); error.code = 1; error.killed = true; error.stdout = "{}"; throw error; } }), { code: "UPDATE_INVALID" });
});

test("network failures have a fixed actionable failure code", async () => {
  await assert.rejects(checkForCompanionUpdate({ currentVersion: "0.0.1", fetchImpl: async () => { throw new Error("PRIVATE_NETWORK_DIAGNOSTICS"); } }), { code: "UPDATE_UNAVAILABLE" });
  await assert.rejects(checkForCompanionUpdate({ currentVersion: "0.0.1", fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("PRIVATE_NETWORK_DIAGNOSTICS")); } })) }), { code: "UPDATE_UNAVAILABLE" });
});

test("a fully hashed archive cannot disagree with its declared minimum Node version", async (t) => {
  const fixture = await releaseFixture(t);
  const originalEntries = inspectCompanionArchive(fixture.payload.archive);
  const originalPackage = originalEntries.get("package.json").bytes;
  const packageBytes = Buffer.from(originalPackage.toString("utf8").replace(">=22.15.0", ">=20.00.0"));
  assert.equal(packageBytes.length, originalPackage.length);
  const originalManifest = JSON.parse(fixture.payload.manifestBytes);
  const packageRecord = originalManifest.files.find((record) => record.path === "package.json");
  const manifestBytes = Buffer.from(fixture.payload.manifestBytes.toString("utf8").replace(packageRecord.sha256, hash(packageBytes)));
  assert.equal(manifestBytes.length, fixture.payload.manifestBytes.length);
  const tar = gunzipSync(fixture.payload.archive);
  let offset = 0;
  while (offset + 512 <= tar.length && tar[offset] !== 0) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, header.indexOf(0)).toString("ascii");
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii"), 8);
    if (name === "package.json") packageBytes.copy(tar, offset + 512);
    if (name === "release-manifest.json") manifestBytes.copy(tar, offset + 512);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const archive = gzipSync(tar);
  const checksumsBytes = Buffer.from(`${hash(archive)}  ${fixture.result.archiveName}\n${hash(manifestBytes)}  release-manifest.json\n${hash(fixture.files.get("install.sh"))}  install.sh\n`);
  assert.throws(() => verifyCompanionPayload({ archive, manifestBytes, checksumsBytes, version: fixture.result.version }), { code: "UPDATE_INVALID" });
});
