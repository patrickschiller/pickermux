import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
  return async (tool, args, options) => {
    calls.push({ tool, args, options });
    await override(tool, args, options);
    if (args.includes("swiftc")) await writeFile(args[args.indexOf("-o") + 1], "fixture-slice");
    if (tool === "/usr/bin/lipo" && args.includes("-create")) await writeFile(args[args.indexOf("-output") + 1], "fixture-universal");
    if (tool === "/usr/bin/lipo" && args.includes("-archs")) return "arm64 x86_64\n";
    if (args[0] === "notarytool") return JSON.stringify({ status: "Accepted" });
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
  assert.equal(calls.filter(({ tool, args }) => tool === "/usr/bin/codesign" && args.includes("--verify")).length, 2);
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
    if (tool === "/usr/bin/plutil") {
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
