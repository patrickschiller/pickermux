import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, link, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { buildCompanion, companionArchive, releaseSigning } from "../scripts/build-companion.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

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
    "macos/Resources/Info.plist.in": "<plist>__PICKERMUX_VERSION__</plist>\n",
    "macos/Resources/Companion.entitlements": "<plist/>\n",
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
  const first = await buildCompanion({ projectDirectory: project, outputDirectory: path.join(root, "first"), execute: fakeTools(calls), environment: { HOME: root, PRIVATE_TOKEN: "must-not-propagate" } });
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
  const probes = Object.fromEntries(Object.entries({ metadata: { version: "0.9.0" }, desktop: "stopped", installation: "installed", managedConfig: "installed", service: "running", compatibility: "compatible", accountCache: "ready", recovery: null, integration: "pickermux" }).map(([name, value]) => [name, async () => value]));
  const cases = [
    ["status", ["status"], await collectCompanionStatus({ probes })],
    ["partial-status", ["status"], await collectCompanionStatus({ probes: {} })],
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
  assert.equal(managedLauncherContents({ currentPath: "/FIXTURE_HOME/Library/Application Support/PickerMux/current", installedConfigPath: "/FIXTURE_HOME/.codex/model-bridge/service-config.json" }), golden.launcherTemplate);
});
