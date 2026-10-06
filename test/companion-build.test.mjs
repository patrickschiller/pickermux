import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, cp, link, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync, gunzipSync } from "node:zlib";
import { buildCompanion, companionArchive, developmentSigning, releaseSigning } from "../scripts/build-companion.mjs";
import { validateCompanionIcns, validateIconPng, validateMenuBarIconPng } from "../scripts/build-companion-icon.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

function iconPng(pixels, colorType = 6, template = false, rasterTransform = (raster) => raster) {
  const crc32 = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, contents) => {
    const data = Buffer.concat([Buffer.from(type, "ascii"), contents]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(contents.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(data));
    return Buffer.concat([length, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(pixels, 0);
  header.writeUInt32BE(pixels, 4);
  header[8] = 8;
  header[9] = colorType;
  const raster = Buffer.alloc((pixels * 4 + 1) * pixels);
  if (template) {
    for (let row = Math.floor(pixels / 4); row < Math.ceil(pixels * 3 / 4); row += 1) {
      for (let column = Math.floor(pixels / 4); column < Math.ceil(pixels * 3 / 4); column += 1) raster[row * (pixels * 4 + 1) + 1 + column * 4 + 3] = 255;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rasterTransform(raster))), chunk("IEND", Buffer.alloc(0))]);
}

function iconIcns(template = false) {
  const chunks = [["ic04", 16], ["ic05", 32], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024], ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512]].map(([type, pixels]) => {
    const contents = iconPng(pixels, 6, template);
    const record = Buffer.alloc(8);
    record.write(type, "ascii");
    record.writeUInt32BE(contents.length + 8, 4);
    return Buffer.concat([record, contents]);
  });
  const header = Buffer.alloc(8);
  header.write("icns", "ascii");
  header.writeUInt32BE(chunks.reduce((sum, chunk) => sum + chunk.length, 8), 4);
  return Buffer.concat([header, ...chunks]);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pickermux-companion-build-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  for (const directory of ["bin", "src", "scripts", "macos/Sources/Core", "macos/Resources"]) await mkdir(path.join(project, directory), { recursive: true });
  const files = {
    "package.json": JSON.stringify({ name: "pickermux", version: "1.2.3", license: "MIT", engines: { node: ">=22.15.0" } }),
    "LICENSE": "MIT fixture",
    "lmstudio-picker.config.json": "{}\n",
    "bin/pickermux.mjs": "// deterministic fixture\n",
    "src/control.mjs": "export const schemaVersion = 1;\n",
    "macos/Sources/Core/App.swift": "// fixture\n",
    "macos/Resources/Info.plist.in": "<plist>__PICKERMUX_VERSION__<key>CFBundleIconFile</key><string>AppIcon</string></plist>\n",
    "macos/Resources/Companion.entitlements": "<plist/>\n",
    "macos/Resources/AppIcon.png": iconPng(1024),
    "macos/Resources/MenuBarIcon.png": iconPng(1024, 6, true),
    "CHANGELOG.md": "## [1.2.3] - 2026-10-01\n\n[1.2.3]: https://github.com/patrickschiller/pickermux/releases/tag/v1.2.3\n",
    "scripts/install.sh.in": "#!/bin/sh\nversion=__PICKERMUX_VERSION__\narchive=__PICKERMUX_ARCHIVE__\ndigest=__PICKERMUX_SHA256__\n",
  };
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(project, name), contents);
  return { root, project };
}

function fakeTools(calls = [], override = async () => {}) {
  const diskImages = new Map();
  const attachments = new Map();
  return async (tool, args, options) => {
    calls.push({ tool, args, options });
    const result = await override(tool, args, options);
    if (result !== undefined) return result;
    if (args.includes("swiftc")) await writeFile(args[args.indexOf("-o") + 1], "fixture-slice");
    if (tool === "/usr/bin/lipo" && args.includes("-create")) await writeFile(args[args.indexOf("-output") + 1], "fixture-universal");
    if (tool === "/usr/bin/lipo" && args.includes("-archs")) return "arm64 x86_64\n";
    if (args[0] === "notarytool") return JSON.stringify({ status: "Accepted" });
    if (tool === "/usr/bin/sips") await writeFile(args.at(-1), iconPng(Number(args[args.indexOf("--resampleHeightWidth") + 1]), 6, args.at(-3).endsWith("MenuBarIcon-master.png")), { flag: "wx" });
    if (tool === "/usr/bin/iconutil") await writeFile(args[args.indexOf("--output") + 1], iconIcns(args.at(-1).endsWith("MenuBarIcon.iconset")), { flag: "wx" });
    if (tool === "/usr/bin/ditto" && !args.includes("-c")) await cp(args[0], args[1], { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    if (tool === "/usr/bin/hdiutil") {
      if (args[0] === "create") {
        const image = args[args.indexOf("-o") + 1];
        diskImages.set(image, args[args.indexOf("-srcfolder") + 1]);
        await writeFile(image, "fixture-read-only-disk-image", { flag: "wx" });
      } else if (args[0] === "imageinfo") return "UDZO\n";
      else if (args[0] === "attach") {
        const image = args[1];
        const mountpoint = args[args.indexOf("-mountpoint") + 1];
        for (const name of await readdir(diskImages.get(image))) await cp(path.join(diskImages.get(image), name), path.join(mountpoint, name), { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
        const entities = [{ "dev-entry": "/dev/disk123" }, { "dev-entry": "/dev/disk123s1", "mount-point": mountpoint }];
        attachments.set(image, { "image-path": image, "system-entities": entities });
        return JSON.stringify({ "system-entities": entities });
      } else if (args[0] === "detach") {
        for (const [image, entry] of attachments) {
          if (entry["system-entities"].some((entity) => entity["mount-point"] === args[1] || entity["dev-entry"] === args[1])) attachments.delete(image);
        }
      } else if (args[0] === "info") return JSON.stringify({ images: [...attachments.values()] });
    }
    if (tool === "/usr/bin/plutil" && args[0] === "-convert") return readFile(args.at(-1), "utf8");
    return "";
  };
}

function tarEntries(archive) {
  const tar = gunzipSync(archive);
  const entries = [];
  const field = (header, offset, length) => header.subarray(offset, offset + length).toString("ascii").split("\0")[0];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const size = parseInt(field(header, 124, 12), 8);
    const prefix = field(header, 345, 155);
    entries.push({ path: `${prefix ? `${prefix}/` : ""}${field(header, 0, 100)}`, type: String.fromCharCode(header[156]), mode: parseInt(field(header, 100, 8), 8), mtime: parseInt(field(header, 136, 12), 8), contents: tar.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("companion build pins its complete backend, builds both architectures and produces deterministic unsigned archives", async (t) => {
  const { root, project } = await fixture(t);
  const calls = [];
  const first = await buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "first"), execute: fakeTools(calls), environment: { HOME: root, PRIVATE_TOKEN: "must-not-propagate", PICKERMUX_DEVELOPMENT_SIGNING_IDENTITY: "Apple Development: Fixture (ABCDEFGHIJ)" } });
  const second = await buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "second"), execute: fakeTools(), environment: { HOME: root } });
  const archive = await readFile(path.join(first.outputDirectory, first.archiveName));
  assert.deepEqual(archive, await readFile(path.join(second.outputDirectory, second.archiveName)));
  assert.equal(first.archiveSha256, hash(archive));
  const compilers = calls.filter(({ args }) => args.includes("swiftc"));
  assert.equal(compilers.length, 2);
  assert.ok(compilers[0].args.includes("arm64-apple-macos13.0"));
  assert.ok(compilers[1].args.includes("x86_64-apple-macos13.0"));
  assert.ok(compilers.every(({ options }) => options.environment.PRIVATE_TOKEN === undefined));
  assert.ok(calls.some(({ args }) => args.includes("-archs")));
  assert.ok(calls.every(({ tool }) => tool !== "/usr/bin/codesign"));
  const entries = tarEntries(archive);
  assert.ok(entries.every(({ mtime, type }) => mtime === 0 && ["0", "5"].includes(type)));
  assert.equal(entries.find(({ path: name }) => name === "PickerMux.app/Contents/MacOS/PickerMuxCompanion").mode, 0o755);
  const manifest = JSON.parse(entries.find(({ path: name }) => name.endsWith("Backend/release-manifest.json")).contents);
  for (const file of manifest.files) {
    assert.equal(hash(entries.find(({ path: name }) => name.endsWith(`Backend/${file.path}`)).contents), file.sha256);
  }
  const distribution = JSON.parse(await readFile(path.join(first.outputDirectory, "companion-manifest.json"), "utf8"));
  assert.equal(distribution.signing, "unsigned-development");
  assert.equal(distribution.backendManifestSha256, hash(entries.find(({ path: name }) => name.endsWith("Backend/release-manifest.json")).contents));
  const packagedIcon = entries.find(({ path: name }) => name === "PickerMux.app/Contents/Resources/AppIcon.icns");
  assert.ok(packagedIcon);
  assert.equal(packagedIcon.mode, 0o644);
  validateCompanionIcns(packagedIcon.contents);
  assert.deepEqual(distribution.icon, { file: "AppIcon.icns", sha256: hash(packagedIcon.contents), source: "macos/Resources/AppIcon.png", sourceSha256: hash(await readFile(path.join(project, "macos", "Resources", "AppIcon.png"))), pixels: 1024 });
  const packagedMenuBarIcon = entries.find(({ path: name }) => name === "PickerMux.app/Contents/Resources/MenuBarIcon.icns");
  assert.equal(packagedMenuBarIcon.mode, 0o644);
  validateCompanionIcns(packagedMenuBarIcon.contents, validateMenuBarIconPng);
  assert.deepEqual(distribution.menuBarIcon, { file: "MenuBarIcon.icns", sha256: hash(packagedMenuBarIcon.contents), source: "macos/Resources/MenuBarIcon.png", sourceSha256: hash(await readFile(path.join(project, "macos", "Resources", "MenuBarIcon.png"))), pixels: 1024, template: true, pointSize: 18 });
  assert.match(entries.find(({ path: name }) => name === "PickerMux.app/Contents/Info.plist").contents.toString("utf8"), /<key>CFBundleIconFile<\/key><string>AppIcon<\/string>/u);
  const iconSizes = calls.filter(({ tool }) => tool === "/usr/bin/sips").map(({ args }) => Number(args[args.indexOf("--resampleHeightWidth") + 1]));
  assert.deepEqual(iconSizes, [16, 32, 32, 64, 128, 256, 256, 512, 512, 1024, 16, 32, 32, 64, 128, 256, 256, 512, 512, 1024]);
  assert.ok(calls.some(({ tool, args }) => tool === "/usr/bin/iconutil" && args[0] === "--convert" && args[1] === "icns"));
  assert.deepEqual(distribution.diskImage, { file: "PickerMux-v1.2.3-macos-universal.dmg", sha256: hash(await readFile(path.join(first.outputDirectory, first.diskImageName))), format: "UDZO", filesystem: "HFS+", installation: "drag-to-applications" });
  assert.equal(first.diskImageSha256, distribution.diskImage.sha256);
  const checksumLines = (await readFile(path.join(first.outputDirectory, "SHA256SUMS"), "utf8")).trim().split("\n");
  assert.equal(checksumLines.length, 3);
  for (const line of checksumLines) {
    const [digest, name] = line.split("  ");
    assert.equal(hash(await readFile(path.join(first.outputDirectory, name))), digest);
  }
  const create = calls.find(({ tool, args }) => tool === "/usr/bin/hdiutil" && args[0] === "create");
  assert.equal(create.args[create.args.indexOf("-format") + 1], "UDZO");
  assert.equal(create.args[create.args.indexOf("-fs") + 1], "HFS+");
  assert.ok(calls.some(({ tool, args }) => tool === "/usr/bin/hdiutil" && args[0] === "verify"));
  const attach = calls.find(({ tool, args }) => tool === "/usr/bin/hdiutil" && args[0] === "attach");
  assert.ok(attach.args.includes("-readonly") && attach.args.includes("-nobrowse") && attach.args.includes("-noautoopen"));
  assert.ok(calls.some(({ tool, args }) => tool === "/usr/bin/hdiutil" && args[0] === "detach"));
  assert.equal((await readdir(root)).filter((name) => name.startsWith(".pickermux-companion-")).length, 0);
});

test("release builds require explicit Developer ID and existing notarytool profile before starting tools", async (t) => {
  const { root, project } = await fixture(t);
  const calls = [];
  await assert.rejects(buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "out"), release: true, environment: {}, execute: fakeTools(calls) }), /SIGNING_IDENTITY/u);
  assert.equal(calls.length, 0);
  assert.throws(() => releaseSigning({ PICKERMUX_SIGNING_IDENTITY: "-", PICKERMUX_NOTARY_PROFILE: "profile" }), /SIGNING_IDENTITY/u);
  assert.throws(() => releaseSigning({ PICKERMUX_SIGNING_IDENTITY: "Developer ID Application: Fixture (ABCDEFGHIJ)", PICKERMUX_NOTARY_PROFILE: "profile\nsecret" }), /NOTARY_PROFILE/u);
});

test("development signing requires an explicit Apple Development identity and excludes release mode", async (t) => {
  const { root, project } = await fixture(t);
  for (const identity of [
    undefined, "", "-", "--sign -", "a".repeat(40),
    "Developer ID Application: Fixture (ABCDEFGHIJ)",
    "Apple Development: Fixture", "Apple Development: Fixture (abcde12345)",
    "Apple Development: Fixture (ABCDEFGHIJK)",
    "Apple Development: Fixture\nSecret (ABCDEFGHIJ)",
    "Apple Development: Fixture (ABCDEFGHIJ)\n",
    "Apple Development: Fixture\0Secret (ABCDEFGHIJ)",
    "Apple Development: Fixture\tSecret (ABCDEFGHIJ)",
    `Apple Development: ${"a".repeat(161)} (ABCDEFGHIJ)`,
  ]) {
    const calls = [];
    const environment = { PICKERMUX_DEVELOPMENT_SIGNING_IDENTITY: identity };
    assert.throws(() => developmentSigning(environment), /DEVELOPMENT_SIGNING_IDENTITY/u);
    await assert.rejects(buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "out"), developmentSigned: true, environment, execute: fakeTools(calls) }), /DEVELOPMENT_SIGNING_IDENTITY/u);
    assert.equal(calls.length, 0);
    assert.ok(!(await readdir(root)).includes("out"));
  }
  const identity = "Apple Development: Fixture (ABCDEFGHIJ)";
  assert.deepEqual(developmentSigning({ PICKERMUX_DEVELOPMENT_SIGNING_IDENTITY: identity }), { identity });
  const calls = [];
  await assert.rejects(buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "out"), release: true, developmentSigned: true, environment: {}, execute: fakeTools(calls) }), /mutually exclusive/u);
  assert.equal(calls.length, 0);
  assert.equal((await readdir(root)).filter((name) => name.startsWith(".pickermux-companion-")).length, 0);
});

test("development build signs and verifies the complete app before packaging and verifies its mounted copy", async (t) => {
  const { root, project } = await fixture(t);
  const calls = [];
  const identity = "Apple Development: Fixture (ABCDEFGHIJ)";
  const environment = {
    HOME: root,
    PICKERMUX_DEVELOPMENT_SIGNING_IDENTITY: identity,
    PICKERMUX_SIGNING_IDENTITY: "must-not-be-used",
    PICKERMUX_NOTARY_PROFILE: "must-not-be-used",
    PRIVATE_TOKEN: "must-not-propagate",
  };
  const execute = fakeTools(calls, async (tool, args) => {
    if (tool === "/usr/bin/codesign" && args.includes("--sign")) {
      const bundle = args.at(-1);
      assert.ok((await readFile(path.join(bundle, "Contents", "Resources", "Backend", "release-manifest.json"))).length > 0);
      assert.ok((await readFile(path.join(bundle, "Contents", "Resources", "MenuBarIcon.icns"))).length > 0);
      await mkdir(path.join(bundle, "Contents", "_CodeSignature"));
      await writeFile(path.join(bundle, "Contents", "_CodeSignature", "CodeResources"), "fixture-bundle-seal");
    }
  });
  const result = await buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "development-signed"), developmentSigned: true, environment, execute });
  assert.equal(result.signing, "apple-development");
  const signing = calls.filter(({ tool, args }) => tool === "/usr/bin/codesign" && args.includes("--sign"));
  assert.equal(signing.length, 1);
  assert.deepEqual(signing[0].args.slice(0, -1), ["--force", "--sign", identity, "--entitlements", path.join(project, "macos", "Resources", "Companion.entitlements"), "--timestamp=none"]);
  assert.ok(signing[0].args.at(-1).endsWith("assets/PickerMux.app"));
  const verifications = calls.filter(({ tool, args }) => tool === "/usr/bin/codesign" && args.includes("--verify"));
  assert.equal(verifications.length, 2);
  for (const { args } of verifications) assert.deepEqual(args.slice(0, 3), ["--verify", "--strict", "--deep"]);
  assert.equal(verifications[0].args.at(-1), signing[0].args.at(-1));
  assert.ok(verifications[1].args.at(-1).endsWith("disk-image-mount/PickerMux.app"));
  const copied = calls.find(({ tool, args }) => tool === "/usr/bin/ditto" && args.at(-1).endsWith("disk-image-source/PickerMux.app"));
  assert.ok(calls.indexOf(signing[0]) < calls.indexOf(verifications[0]));
  assert.ok(calls.indexOf(verifications[0]) < calls.indexOf(copied));
  const attached = calls.find(({ tool, args }) => tool === "/usr/bin/hdiutil" && args[0] === "attach");
  const detached = calls.find(({ tool, args }) => tool === "/usr/bin/hdiutil" && args[0] === "detach");
  assert.ok(calls.indexOf(attached) < calls.indexOf(verifications[1]));
  assert.ok(calls.indexOf(verifications[1]) < calls.indexOf(detached));
  assert.ok(!calls.some(({ tool, args }) => tool === "/usr/sbin/spctl" || ["notarytool", "stapler"].includes(args[0])));
  assert.ok(calls.every(({ options }) => options.environment.PICKERMUX_DEVELOPMENT_SIGNING_IDENTITY === undefined && options.environment.PRIVATE_TOKEN === undefined));
  const manifestText = await readFile(path.join(result.outputDirectory, "companion-manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.signing, "apple-development");
  assert.ok(!manifestText.includes(identity));
  assert.ok(!JSON.stringify(result).includes(identity));
  const archive = await readFile(path.join(result.outputDirectory, result.archiveName));
  const entries = tarEntries(archive);
  assert.equal(entries.find(({ path: name }) => name === "PickerMux.app/Contents/_CodeSignature/CodeResources").contents.toString("utf8"), "fixture-bundle-seal");
  for (const line of (await readFile(path.join(result.outputDirectory, "SHA256SUMS"), "utf8")).trim().split("\n")) {
    const [digest, name] = line.split("  ");
    assert.equal(hash(await readFile(path.join(result.outputDirectory, name))), digest);
  }
});

test("development signing and signature verification failures never produce output", async (t) => {
  for (const stage of ["sign", "bundle verification", "mounted verification"]) {
    await t.test(stage, async (child) => {
      const { root, project } = await fixture(child);
      const calls = [];
      const environment = { PICKERMUX_DEVELOPMENT_SIGNING_IDENTITY: "Apple Development: Fixture (ABCDEFGHIJ)" };
      const execute = fakeTools(calls, async (tool, args) => {
        if (tool !== "/usr/bin/codesign") return;
        const mounted = args.at(-1).endsWith("disk-image-mount/PickerMux.app");
        if ((stage === "sign" && args.includes("--sign")) || (stage === "bundle verification" && args.includes("--verify") && !mounted) || (stage === "mounted verification" && args.includes("--verify") && mounted)) {
          throw new Error("fixture signature failure");
        }
      });
      await assert.rejects(buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "out"), developmentSigned: true, environment, execute }), /fixture signature failure/u);
      assert.ok(!(await readdir(root)).includes("out"));
      assert.equal((await readdir(root)).filter((name) => name.startsWith(".pickermux-companion-")).length, 0);
      if (stage === "mounted verification") {
        assert.ok(calls.some(({ tool, args }) => tool === "/usr/bin/hdiutil" && args[0] === "detach"));
      } else {
        assert.ok(!calls.some(({ tool, args }) => tool === "/usr/bin/hdiutil" && args[0] === "create"));
      }
    });
  }
});

test("companion build CLI documents development signing and rejects conflicting or duplicate modes", async (t) => {
  const { root } = await fixture(t);
  const script = fileURLToPath(new URL("../scripts/build-companion.mjs", import.meta.url));
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--development-signed \| --release/u);
  assert.match(help.stdout, /PICKERMUX_DEVELOPMENT_SIGNING_IDENTITY/u);
  for (const args of [["--release", "--development-signed"], ["--development-signed", "--release"], ["--development-signed", "--development-signed"]]) {
    const output = path.join(root, "out");
    const result = spawnSync(process.execPath, [script, "--output", output, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /mutually exclusive|duplicated/u);
    assert.ok(!(await readdir(root)).includes("out"));
  }
});

test("release build requires notarization acceptance then staples and validates before packaging", async (t) => {
  const { root, project } = await fixture(t);
  const calls = [];
  const environment = { HOME: root, PICKERMUX_SIGNING_IDENTITY: "Developer ID Application: Fixture (ABCDEFGHIJ)", PICKERMUX_NOTARY_PROFILE: "fixture-profile" };
  const result = await buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "signed"), release: true, environment, execute: fakeTools(calls) });
  assert.equal(result.signing, "developer-id-notarized");
  const commandNames = calls.map(({ tool, args }) => tool === "/usr/bin/xcrun" ? args.slice(0, 2).join(" ") : path.basename(tool));
  assert.ok(commandNames.indexOf("notarytool submit") < commandNames.indexOf("stapler staple"));
  assert.ok(commandNames.indexOf("stapler staple") < commandNames.indexOf("stapler validate"));
  assert.ok(commandNames.includes("spctl"));
  assert.equal(calls.filter(({ tool, args }) => tool === "/usr/bin/codesign" && args.includes("--verify")).length, 5);
  const submissions = calls.filter(({ args }) => args[0] === "notarytool");
  assert.equal(submissions.length, 2);
  assert.ok(submissions[0].args[2].endsWith("notary-upload.zip"));
  assert.ok(submissions[1].args[2].endsWith(result.diskImageName));
  const imageSign = calls.findIndex(({ tool, args }) => tool === "/usr/bin/codesign" && args.includes("--sign") && args.at(-1).endsWith(".dmg"));
  const appStaple = calls.findIndex(({ args }) => args[0] === "stapler" && args[1] === "staple" && args.at(-1).endsWith(".app"));
  assert.ok(appStaple < imageSign);
  const imageGatekeeper = calls.find(({ tool, args }) => tool === "/usr/sbin/spctl" && args.includes("open"));
  assert.deepEqual(imageGatekeeper.args.slice(0, 6), ["--assess", "--type", "open", "--context", "context:primary-signature", path.join(path.dirname(submissions[1].args[2]), result.diskImageName)]);
  const sourceCopy = calls.find(({ tool, args }) => tool === "/usr/bin/ditto" && args.at(-1).endsWith("disk-image-source/PickerMux.app"));
  assert.ok(sourceCopy);
  assert.ok(calls.some(({ tool, args }) => tool === "/usr/bin/codesign" && args.includes("--verify") && args.at(-1).endsWith("disk-image-mount/PickerMux.app")));
  assert.ok(calls.some(({ args }) => args[0] === "stapler" && args[1] === "validate" && args.at(-1).endsWith("disk-image-mount/PickerMux.app")));
  const output = path.join(root, "rejected");
  const execute = fakeTools([], async (_tool, args) => { if (args[0] === "notarytool") throw new Error("notarization failed"); });
  await assert.rejects(buildCompanion({ projectDirectory: project, outputDirectory: output, release: true, environment, execute }), /notarization failed/u);
  assert.ok(!(await readdir(root)).includes("rejected"));
});

test("companion build preserves existing and concurrently created output", async (t) => {
  const { root, project } = await fixture(t);
  const output = path.join(root, "occupied");
  await mkdir(output);
  await writeFile(path.join(output, "foreign"), "retain");
  await assert.rejects(buildCompanion({ projectDirectory: project, outputDirectory: output, execute: fakeTools() }), /already exists/u);
  assert.equal(await readFile(path.join(output, "foreign"), "utf8"), "retain");
  const concurrent = path.join(root, "concurrent");
  const execute = fakeTools([], async (tool, args) => {
    if (tool === "/usr/bin/plutil" && args[0] === "-lint") {
      await mkdir(concurrent);
      await writeFile(path.join(concurrent, "foreign"), "retain");
    }
  });
  await assert.rejects(buildCompanion({ projectDirectory: project, outputDirectory: concurrent, execute }), /EEXIST/u);
  assert.equal(await readFile(path.join(concurrent, "foreign"), "utf8"), "retain");
});

test("companion sources and archives reject symlink substitution", async (t) => {
  const { root, project } = await fixture(t);
  await symlink(path.join(project, "LICENSE"), path.join(project, "macos", "Sources", "injected.swift"));
  await assert.rejects(buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "out"), execute: fakeTools() }), /symbolic links/u);
  const bundle = path.join(root, "bundle");
  await mkdir(bundle);
  await symlink(path.join(project, "LICENSE"), path.join(bundle, "link"));
  await assert.rejects(companionArchive(bundle), /symbolic links/u);
});

test("app icon requires a complete square RGBA master and valid native ICNS representations", async (t) => {
  for (const [name, source, expected] of [
    ["non-PNG", Buffer.from("not a PNG"), /RGBA alpha/u],
    ["wrong master size", iconPng(512), /1024x1024/u],
    ["no alpha", iconPng(1024, 2), /RGBA alpha/u],
    ["truncated PNG", iconPng(1024).subarray(0, 35), /truncated|checksum/u],
    ["corrupt PNG CRC", Buffer.from(iconPng(1024)), /checksum/u],
  ]) {
    await t.test(name, async (child) => {
      const { root, project } = await fixture(child);
      if (name === "corrupt PNG CRC") source[32] ^= 1;
      await writeFile(path.join(project, "macos", "Resources", "AppIcon.png"), source);
      const calls = [];
      await assert.rejects(buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "out"), execute: fakeTools(calls) }), expected);
      assert.equal(calls.length, 0);
      assert.ok(!(await readdir(root)).includes("out"));
    });
  }
  validateIconPng(iconPng(1024), 1024);
  validateCompanionIcns(iconIcns());
  for (const [small, medium] of [["icp4", "icp5"], ["is32", "il32"]]) {
    const legacy = iconIcns();
    const second = 8 + legacy.readUInt32BE(12);
    legacy.write(small, 8, "ascii");
    legacy.write(medium, second, "ascii");
    validateCompanionIcns(legacy);
  }
  assert.throws(() => validateCompanionIcns(Buffer.from("not icns")), /ICNS/u);
  const truncated = iconIcns().subarray(0, 32);
  assert.throws(() => validateCompanionIcns(truncated), /complete ICNS/u);
  const missing = iconIcns();
  missing.write("zzzz", 8, "ascii");
  assert.throws(() => validateCompanionIcns(missing), /missing required/u);
  const empty = iconIcns();
  empty.writeUInt32BE(8, 12);
  assert.throws(() => validateCompanionIcns(empty), /malformed or duplicated/u);
  const duplicate = iconIcns();
  duplicate.write("ic04", 8 + duplicate.readUInt32BE(12), "ascii");
  assert.throws(() => validateCompanionIcns(duplicate), /malformed or duplicated/u);
});

test("app icon rejects missing or linked sources, wrong icon declaration and malformed native output", async (t) => {
  const cases = [
    ["missing source", async (project) => rm(path.join(project, "macos", "Resources", "AppIcon.png")), async () => {}, /ENOENT/u],
    ["linked source", async (project) => {
      const source = path.join(project, "macos", "Resources", "AppIcon.png");
      await rm(source);
      await symlink(path.join(project, "LICENSE"), source);
    }, async () => {}, /regular file without links/u],
    ["hardlinked source", async (project) => {
      const source = path.join(project, "macos", "Resources", "AppIcon.png");
      await link(source, source + ".alias");
    }, async () => {}, /regular file without links/u],
    ["wrong plist icon", async (project) => writeFile(path.join(project, "macos", "Resources", "Info.plist.in"), "<plist>__PICKERMUX_VERSION__<key>CFBundleIconFile</key><string>Other</string></plist>"), async () => {}, /declare the packaged AppIcon/u],
    ["wrong resized PNG", async () => {}, async (tool, args) => {
      if (tool === "/usr/bin/sips") { await writeFile(args.at(-1), iconPng(1024)); return ""; }
    }, /16x16/u],
    ["malformed ICNS", async () => {}, async (tool, args) => {
      if (tool === "/usr/bin/iconutil") { await writeFile(args[args.indexOf("--output") + 1], "invalid native output"); return ""; }
    }, /complete ICNS/u],
  ];
  for (const [name, prepare, override, expected] of cases) {
    await t.test(name, async (child) => {
      const { root, project } = await fixture(child);
      await prepare(project);
      await assert.rejects(buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "out"), execute: fakeTools([], override) }), expected);
      assert.ok(!(await readdir(root)).includes("out"));
      assert.equal((await readdir(root)).filter((entry) => entry.startsWith(".pickermux-companion-")).length, 0);
    });
  }
});

test("menu-bar template validates bounded raster data, transparent corners and visible artwork", () => {
  validateMenuBarIconPng(iconPng(18, 6, true), 18);
  validateMenuBarIconPng(iconPng(36, 6, true), 36);
  assert.throws(() => validateMenuBarIconPng(iconPng(18), 18), /visible artwork/u);
  assert.throws(() => validateMenuBarIconPng(iconPng(18, 2, true), 18), /RGBA alpha/u);
  assert.throws(() => validateMenuBarIconPng(iconPng(18, 6, true, (raster) => { raster[4] = 255; return raster; }), 18), /clear corners/u);
  assert.throws(() => validateMenuBarIconPng(iconPng(18, 6, true, (raster) => { raster[0] = 5; return raster; }), 18), /unknown PNG filter/u);
  assert.throws(() => validateMenuBarIconPng(iconPng(18, 6, true, (raster) => raster.subarray(0, raster.length - 1)), 18), /exact pixel bounds/u);
  assert.throws(() => validateMenuBarIconPng(iconPng(18, 6, true, (raster) => Buffer.concat([raster, Buffer.alloc(1)])), 18), /exceeds its exact pixel bounds/u);
  // Three rows with a single opaque center pixel, encoded with each standard
  // PNG predictor. Alpha carries the macOS template regardless of RGB color.
  for (const [index, rows] of [
    [[0, 0, 0], [0, 255, 1], [0, 0, 0]],
    [[0, 0, 0], [0, 255, 0], [0, 1, 0]],
    [[0, 0, 0], [0, 255, 129], [0, 129, 0]],
    [[0, 0, 0], [0, 255, 1], [0, 1, 0]],
  ].entries()) {
    validateMenuBarIconPng(iconPng(3, 6, false, (raster) => {
      for (let row = 0; row < 3; row += 1) {
        raster[row * 13] = index + 1;
        for (let column = 0; column < 3; column += 1) raster[row * 13 + 1 + column * 4 + 3] = rows[row][column];
      }
      return raster;
    }), 3);
  }
});

test("menu-bar icon rejects linked or invalid masters and substituted native template output", async (t) => {
  const cases = [
    ["missing master", async (project) => rm(path.join(project, "macos", "Resources", "MenuBarIcon.png")), async () => {}, /ENOENT/u],
    ["linked master", async (project) => {
      const source = path.join(project, "macos", "Resources", "MenuBarIcon.png");
      await rm(source);
      await symlink(path.join(project, "macos", "Resources", "AppIcon.png"), source);
    }, async () => {}, /regular file without links/u],
    ["hardlinked master", async (project) => {
      const source = path.join(project, "macos", "Resources", "MenuBarIcon.png");
      await link(source, source + ".alias");
    }, async () => {}, /regular file without links/u],
    ["wrong master dimensions", async (project) => writeFile(path.join(project, "macos", "Resources", "MenuBarIcon.png"), iconPng(512, 6, true)), async () => {}, /1024x1024/u],
    ["invisible master", async (project) => writeFile(path.join(project, "macos", "Resources", "MenuBarIcon.png"), iconPng(1024)), async () => {}, /visible artwork/u],
    ["invisible resized output", async () => {}, async (tool, args) => {
      if (tool === "/usr/bin/sips" && args.at(-3).endsWith("MenuBarIcon-master.png")) {
        await writeFile(args.at(-1), iconPng(Number(args[args.indexOf("--resampleHeightWidth") + 1]))); return "";
      }
    }, /visible artwork/u],
    ["substituted ICNS", async () => {}, async (tool, args) => {
      if (tool === "/usr/bin/iconutil" && args.at(-1).endsWith("MenuBarIcon.iconset")) {
        await writeFile(args[args.indexOf("--output") + 1], iconIcns()); return "";
      }
    }, /visible artwork/u],
  ];
  for (const [name, prepare, override, expected] of cases) {
    await t.test(name, async (child) => {
      const { root, project } = await fixture(child);
      await prepare(project);
      const calls = [];
      await assert.rejects(buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "out"), execute: fakeTools(calls, override) }), expected);
      assert.ok(!calls.some(({ args }) => args.includes("swiftc")));
      assert.ok(!(await readdir(root)).includes("out"));
      assert.equal((await readdir(root)).filter((entry) => entry.startsWith(".pickermux-companion-")).length, 0);
    });
  }
});

test("disk-image verification rejects changed contents, permissions, links and extra payloads and always detaches", async (t) => {
  const cases = [
    ["extra payload", async (mountpoint) => writeFile(path.join(mountpoint, "unreviewed.pkg"), "foreign"), /only PickerMux/u],
    ["Applications destination", async (mountpoint) => {
      const target = path.join(mountpoint, "Applications");
      assert.equal(await readlink(target), "/Applications");
      await rm(target);
      await symlink("/tmp", target);
    }, /exactly to \/Applications/u],
    ["app substitution", async (mountpoint) => {
      await rm(path.join(mountpoint, "PickerMux.app"), { recursive: true });
      await symlink("/Applications", path.join(mountpoint, "PickerMux.app"));
    }, /symbolic links/u],
    ["app byte change", async (mountpoint) => writeFile(path.join(mountpoint, "PickerMux.app", "Contents", "Info.plist"), "changed"), /differs from/u],
    ["app mode change", async (mountpoint) => chmod(path.join(mountpoint, "PickerMux.app", "Contents", "MacOS", "PickerMuxCompanion"), 0o644), /differs from/u],
    ["app special permission bits", async (mountpoint) => chmod(path.join(mountpoint, "PickerMux.app"), 0o1755), /differs from/u],
    ["app hard link", async (mountpoint) => link(path.join(mountpoint, "PickerMux.app", "Contents", "Info.plist"), path.join(mountpoint, "PickerMux.app", "Contents", "duplicate")), /hard link/u],
  ];
  for (const [name, mutate, message] of cases) {
    await t.test(name, async (child) => {
      const { root, project } = await fixture(child);
      const calls = [];
      const execute = fakeTools(calls, async (tool, args) => {
        if (tool === "/usr/bin/plutil" && args.at(-1).endsWith("disk-image-attachment.plist")) await mutate(path.join(path.dirname(args.at(-1)), "disk-image-mount"));
      });
      await assert.rejects(buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "out"), execute }), message);
      assert.ok(calls.some(({ tool, args }) => tool === "/usr/bin/hdiutil" && args[0] === "detach"));
      assert.equal((await readdir(root)).filter((entry) => entry.startsWith(".pickermux-companion-")).length, 0);
      assert.ok(!(await readdir(root)).includes("out"));
    });
  }
});

test("disk-image build rejects writable format, unexpected mount and unaccepted image notarization", async (t) => {
  const { root, project } = await fixture(t);
  const formatCalls = [];
  await assert.rejects(buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "writable"), execute: fakeTools(formatCalls, async (tool, args) => {
    if (tool === "/usr/bin/hdiutil" && args[0] === "imageinfo") return "UDRW\n";
  }) }), /read-only UDZO/u);
  assert.ok(!formatCalls.some(({ args }) => args[0] === "attach"));
  const mountCalls = [];
  await assert.rejects(buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "wrong-mount"), execute: fakeTools(mountCalls, async (tool, args) => {
    if (tool === "/usr/bin/plutil" && args.at(-1).endsWith("disk-image-attachment.plist")) return JSON.stringify({ "system-entities": [{ "mount-point": "/foreign-volume" }] });
  }) }), /unexpected location/u);
  assert.ok(mountCalls.some(({ tool, args }) => tool === "/usr/bin/hdiutil" && args[0] === "detach"));
  const environment = { PICKERMUX_SIGNING_IDENTITY: "Developer ID Application: Fixture (ABCDEFGHIJ)", PICKERMUX_NOTARY_PROFILE: "fixture" };
  const notaryCalls = [];
  await assert.rejects(buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "rejected-image"), release: true, environment, execute: fakeTools(notaryCalls, async (_tool, args) => {
    if (args[0] === "notarytool" && args[2].endsWith(".dmg")) return JSON.stringify({ status: "Invalid" });
  }) }), /disk-image notarization/u);
  assert.ok(!notaryCalls.some(({ args }) => args[0] === "stapler" && args[1] === "staple" && args.at(-1).endsWith(".dmg")));
  assert.ok(!(await readdir(root)).includes("rejected-image"));
});

test("disk-image cleanup retries only its owned device when attach partially fails", async (t) => {
  const { root, project } = await fixture(t);
  const calls = [];
  let diskImage;
  let stillAttached = true;
  const execute = fakeTools(calls, async (tool, args) => {
    if (tool !== "/usr/bin/hdiutil") return;
    if (args[0] === "create") diskImage = args.at(-1);
    else if (args[0] === "attach") throw new Error("fixture partial attach failure");
    else if (args[0] === "detach" && args[1] !== "/dev/disk123") throw new Error("fixture volume not mounted");
    else if (args[0] === "detach") stillAttached = false;
    else if (args[0] === "info") return JSON.stringify({ images: [
      ...(stillAttached ? [{ "image-path": diskImage, "system-entities": [{ "dev-entry": "/dev/disk123" }] }] : []),
      { "image-path": "/foreign-volume/foreign.dmg", "system-entities": [{ "dev-entry": "/dev/disk999" }] },
    ] });
  });
  await assert.rejects(buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "out"), execute }), /partial attach failure/u);
  assert.equal(stillAttached, false);
  const detachedDevices = calls.filter(({ tool, args }) => tool === "/usr/bin/hdiutil" && args[0] === "detach" && args[1].startsWith("/dev/"));
  assert.deepEqual(detachedDevices.map(({ args }) => args[1]), ["/dev/disk123"]);
  assert.ok(calls.every(({ args }) => !args.includes("-force")));
  assert.equal((await readdir(root)).filter((name) => name.startsWith(".pickermux-companion-")).length, 0);
});

test("release disk-image build rejects a lost mounted app ticket and detaches before failing", async (t) => {
  const { root, project } = await fixture(t);
  const calls = [];
  const environment = { PICKERMUX_SIGNING_IDENTITY: "Developer ID Application: Fixture (ABCDEFGHIJ)", PICKERMUX_NOTARY_PROFILE: "fixture" };
  const execute = fakeTools(calls, async (_tool, args) => {
    if (args[0] === "stapler" && args[1] === "validate" && args.at(-1).endsWith("disk-image-mount/PickerMux.app")) throw new Error("fixture mounted app ticket missing");
  });
  await assert.rejects(buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "out"), release: true, environment, execute }), /mounted app ticket missing/u);
  assert.ok(calls.some(({ tool, args }) => tool === "/usr/bin/hdiutil" && args[0] === "detach"));
  assert.equal((await readdir(root)).filter((name) => name.startsWith(".pickermux-companion-")).length, 0);
  assert.ok(!(await readdir(root)).includes("out"));
});

test("disk-image cleanup retains its work directory when owned volume cannot be detached", async (t) => {
  const { root, project } = await fixture(t);
  const calls = [];
  const execute = fakeTools(calls, async (tool, args) => {
    if (tool === "/usr/bin/hdiutil" && args[0] === "detach") throw new Error("fixture busy");
  });
  await assert.rejects(buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "out"), execute }), (error) => {
    assert.equal(error.preserveBuildDirectory, true);
    assert.match(error.message, /retained for safe cleanup/u);
    return true;
  });
  const directories = (await readdir(root)).filter((name) => name.startsWith(".pickermux-companion-"));
  assert.equal(directories.length, 1);
  assert.equal(await readlink(path.join(root, directories[0], "disk-image-mount", "Applications")), "/Applications");
  assert.equal(calls.filter(({ tool, args }) => tool === "/usr/bin/hdiutil" && args[0] === "detach" && args[1] === "/dev/disk123").length, 3);
  assert.ok(!(await readdir(root)).includes("out"));
});

test("disk-image command paths are canonical even with an aliased output parent", async (t) => {
  const { root, project } = await fixture(t);
  const parent = path.join(root, "aliased-parent");
  await symlink(root, parent);
  const calls = [];
  const result = await buildCompanion({ projectDirectory: project, outputDirectory: path.join(parent, "out"), execute: fakeTools(calls) });
  const create = calls.find(({ tool, args }) => tool === "/usr/bin/hdiutil" && args[0] === "create");
  const attach = calls.find(({ tool, args }) => tool === "/usr/bin/hdiutil" && args[0] === "attach");
  assert.ok(create.args.at(-1).startsWith(await realpath(root)));
  assert.ok(!create.args.at(-1).includes("aliased-parent"));
  assert.ok(!attach.args[attach.args.indexOf("-mountpoint") + 1].includes("aliased-parent"));
  assert.equal(result.diskImageSha256, hash(await readFile(path.join(result.outputDirectory, result.diskImageName))));
});

test("Swift protocol fixtures match the actual projected companion CLI", async () => {
  const { Readable } = await import("node:stream");
  const { runCompanionCli } = await import("../src/companion-cli.mjs");
  const { collectCompanionStatus } = await import("../src/companion-control.mjs");
  const fixtures = new URL("../macos/Tests/PickerMuxCompanionCoreTests/Fixtures/", import.meta.url);
  const projectResponse = async (argv, result, action) => {
    let output = "";
    await runCompanionCli(argv, {
      input: Readable.from([JSON.stringify({ schemaVersion: 1, action })]),
      output: { write(value) { output += value; } }, progressOutput: { write() {} },
      statusImpl: async () => result, executeImpl: async () => result,
    });
    return output;
  };
  const probes = Object.fromEntries(Object.entries({ metadata: { version: "0.9.0" }, desktop: "stopped", installation: "installed", managedConfig: "installed", service: "running", compatibility: "compatible", accountCache: "ready", recovery: null, integration: "pickermux", providerConfiguration: "external" }).map(([name, value]) => [name, async () => value]));
  const tokenProbes = {
    ...probes,
    service: async () => ({ status: "running", healthy: true, health: { tokenUsage: {
      schemaVersion: 1, status: "available", providers: [{
        providerId: "lmstudio", requests: 3, unavailableRequests: 1,
        last: { status: "available", inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        totals: { inputTokens: 200, outputTokens: 40, totalTokens: 240 },
      }, {
        providerId: "remote-provider", requests: 1, unavailableRequests: 1,
        last: { status: "unavailable" },
        totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      }, {
        providerId: "overflow-provider", requests: 2, unavailableRequests: 0,
        last: { status: "available", inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        totals: null,
      }],
    } } }),
  };
  const cases = [
    ["status", ["status"], await collectCompanionStatus({ probes })],
    ["partial-status", ["status"], await collectCompanionStatus({ probes: {} })],
    ["token-status", ["status"], await collectCompanionStatus({ probes: tokenProbes })],
    ["preview", ["run"], { schemaVersion: 1, status: "ollama", canApply: true, requiresConfirmation: true, changes: ["replace-integration", "preserve-user-settings", "preserve-historical-chats", "create-backup", "restore-on-failure", "retain-explicit-provider"], previewToken: "a".repeat(64) }, "configuration-preview"],
    ["update", ["run"], { status: "updated", currentVersion: "0.8.3", targetVersion: "0.9.0", updated: true, restartRequired: true, certificationIncomplete: true }, "update"],
  ];
  for (const [name, argv, result, action] of cases) {
    assert.equal(await projectResponse(argv, result, action), await readFile(new URL(`${name}.json`, fixtures), "utf8"));
  }
});

test("Swift pre-execution distribution digest fixture matches the authoritative installer", async (t) => {
  const { distributionDigest, managedLauncherContents } = await import("../src/distribution-installer.mjs");
  const { root } = await fixture(t);
  const target = path.join(root, "receipt-active");
  await mkdir(target, { mode: 0o700 });
  const golden = JSON.parse(await readFile(new URL("../macos/Tests/PickerMuxCompanionCoreTests/Fixtures/distribution-digest.json", import.meta.url), "utf8"));
  for (const name of ["bin", "src"]) await mkdir(path.join(target, name), { mode: 0o700 });
  for (const [name, contents] of Object.entries(golden.files)) await writeFile(path.join(target, name), contents, { mode: 0o600 });
  assert.equal(await distributionDigest(target), golden.sha256);
  await mkdir(path.join(target, "runtime", "mlx"), { recursive: true, mode: 0o700 });
  for (const [name, contents] of Object.entries(golden.runtimeFiles)) {
    await writeFile(path.join(target, name), contents, { mode: 0o600 });
  }
  assert.equal(await distributionDigest(target), golden.runtimeSha256);
  assert.equal(managedLauncherContents({ currentPath: "/FIXTURE_HOME/Library/Application Support/PickerMux/current", installedConfigPath: "/FIXTURE_HOME/.codex/model-bridge/service-config.json" }), golden.launcherTemplate);
});
