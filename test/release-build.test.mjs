import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";

import { buildRelease } from "../scripts/build-release.mjs";

const execFileAsync = promisify(execFile);
const PRODUCTION_CURL_LINE =
  "/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 \\";
const HARNESS_CURL_LINE =
  '"$PICKERMUX_TEST_CURL" --proto \'=https\' --proto-redir \'=https\' --tlsv1.2 \\';

function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}

function readTarString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  const fieldEnd = end === -1 || end > offset + length ? offset + length : end;
  return buffer.subarray(offset, fieldEnd).toString("ascii");
}

function readTarOctal(buffer, offset, length) {
  const value = readTarString(buffer, offset, length).trim();
  return value ? Number.parseInt(value, 8) : 0;
}

function parseTarGzip(archive) {
  const tar = gunzipSync(archive);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const entryPath = readTarString(header, 0, 100);
    const size = readTarOctal(header, 124, 12);
    entries.push({
      path: entryPath,
      mode: readTarOctal(header, 100, 8),
      mtime: readTarOctal(header, 136, 12),
      type: String.fromCharCode(header[156]),
      content: tar.subarray(offset + 512, offset + 512 + size),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function writeTarString(buffer, value, offset, length) {
  const encoded = Buffer.from(value, "ascii");
  assert.equal(encoded.length, value.length, `tar field must be ASCII: ${value}`);
  assert.ok(encoded.length <= length, `tar field is too long: ${value}`);
  encoded.copy(buffer, offset);
}

function writeTarOctal(buffer, value, offset, length) {
  writeTarString(
    buffer,
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    offset,
    length,
  );
}

function createTarGzip(entries) {
  const blocks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    const header = Buffer.alloc(512, 0);
    writeTarString(header, entry.path, 0, 100);
    writeTarOctal(header, entry.mode ?? 0o644, 100, 8);
    writeTarOctal(header, 0, 108, 8);
    writeTarOctal(header, 0, 116, 8);
    writeTarOctal(header, content.length, 124, 12);
    writeTarOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    if (entry.linkTarget) writeTarString(header, entry.linkTarget, 157, 100);
    writeTarString(header, "ustar\0", 257, 6);
    writeTarString(header, "00", 263, 2);
    writeTarString(header, "root", 265, 32);
    writeTarString(header, "root", 297, 32);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeTarString(
      header,
      `${checksum.toString(8).padStart(6, "0")}\0 `,
      148,
      8,
    );
    blocks.push(header);
    if (content.length > 0) {
      blocks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding > 0) blocks.push(Buffer.alloc(padding, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 });
}

function replaceSingle(source, expected, replacement, label) {
  assert.equal(
    source.split(expected).length - 1,
    1,
    `${label} must occur exactly once in the production installer`,
  );
  return source.replace(expected, replacement);
}

function redirectProductionCurlToHarness(installer) {
  const redirected = replaceSingle(
    installer,
    PRODUCTION_CURL_LINE,
    HARNESS_CURL_LINE,
    "absolute curl command line",
  );
  const beforeLines = installer.split("\n");
  const afterLines = redirected.split("\n");
  assert.equal(afterLines.length, beforeLines.length);
  assert.deepEqual(
    beforeLines.flatMap((line, index) => (
      line === afterLines[index]
        ? []
        : [{ before: line, after: afterLines[index] }]
    )),
    [{ before: PRODUCTION_CURL_LINE, after: HARNESS_CURL_LINE }],
    "the harness may redirect only the exact production curl line",
  );
  return redirected;
}

function installerForArchive(installer, currentSha256, archive) {
  const replacementSha256 = hash(archive);
  if (replacementSha256 === currentSha256) return installer;
  return replaceSingle(
    installer,
    `expected_sha256='${currentSha256}'`,
    `expected_sha256='${replacementSha256}'`,
    "embedded archive checksum",
  );
}

async function writeExecutable(filePath, content) {
  await writeFile(filePath, content, { mode: 0o700 });
  await chmod(filePath, 0o700);
}

async function runRenderedInstaller(t, {
  archive,
  archiveName,
  installer,
  version,
}) {
  const harnessDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pickermux-installer-harness-"),
  );
  t.after(() => rm(harnessDirectory, { recursive: true, force: true }));
  const fakeBinDirectory = path.join(harnessDirectory, "bin");
  const homeDirectory = path.join(harnessDirectory, "home");
  const temporaryDirectory = path.join(harnessDirectory, "tmp");
  await mkdir(fakeBinDirectory);
  await mkdir(homeDirectory);
  await mkdir(temporaryDirectory);

  const archivePath = path.join(harnessDirectory, archiveName);
  const installerPath = path.join(harnessDirectory, "install.sh");
  const curlPath = path.join(fakeBinDirectory, "curl-fixture");
  const curlLogPath = path.join(harnessDirectory, "curl.args");
  const nodeLogPath = path.join(harnessDirectory, "node.args");
  await writeFile(archivePath, archive);
  await writeExecutable(installerPath, redirectProductionCurlToHarness(installer));
  await writeExecutable(curlPath, `#!/bin/sh
set -eu
: > "$PICKERMUX_TEST_CURL_LOG"
for argument
do
  printf '%s\\n' "$argument" >> "$PICKERMUX_TEST_CURL_LOG"
done
output=''
url=''
while [ "$#" -gt 0 ]
do
  case "$1" in
    --output)
      shift
      [ "$#" -gt 0 ] || exit 91
      output=$1
      ;;
    https://*) url=$1 ;;
  esac
  shift
done
[ -n "$output" ] || exit 92
[ "$url" = "$PICKERMUX_TEST_EXPECTED_URL" ] || exit 93
/bin/cp "$PICKERMUX_TEST_ARCHIVE" "$output"
`);
  await writeExecutable(path.join(fakeBinDirectory, "node"), `#!/bin/sh
set -eu
if [ "$#" -eq 2 ] && [ "$1" = '-e' ]; then
  exit 0
fi
if [ "$#" -eq 1 ] && [ "$1" = '--version' ]; then
  printf '%s\\n' 'v22.15.0'
  exit 0
fi
[ "$#" -eq 4 ] || exit 81
entry_point=$1
[ "$2" = 'setup' ] || exit 82
[ "$3" = '--distribution-root' ] || exit 83
distribution_root=$4
[ "$entry_point" = "$distribution_root/bin/pickermux.mjs" ] || exit 84
case "$distribution_root" in
  "$TMPDIR"/pickermux-installer.*/extracted) ;;
  *) exit 85 ;;
esac
for required_path in \
  bin/pickermux.mjs \
  src \
  package.json \
  lmstudio-picker.config.json \
  LICENSE \
  release-manifest.json
do
  [ -e "$distribution_root/$required_path" ] || exit 86
done
printf '%s\\n' "$@" > "$PICKERMUX_TEST_NODE_LOG"
`);

  const expectedUrl =
    `https://github.com/patrickschiller/pickermux/releases/download/v${version}/${archiveName}`;
  const environment = {
    HOME: homeDirectory,
    PATH: `${fakeBinDirectory}:/usr/bin:/bin`,
    PICKERMUX_TEST_ARCHIVE: archivePath,
    PICKERMUX_TEST_CURL: curlPath,
    PICKERMUX_TEST_CURL_LOG: curlLogPath,
    PICKERMUX_TEST_EXPECTED_URL: expectedUrl,
    PICKERMUX_TEST_NODE_LOG: nodeLogPath,
    TMPDIR: temporaryDirectory,
  };
  try {
    const result = await execFileAsync("/bin/sh", [installerPath], {
      encoding: "utf8",
      env: environment,
    });
    return {
      ...result,
      curlLogPath,
      homeDirectory,
      nodeLogPath,
      ok: true,
      temporaryDirectory,
    };
  } catch (error) {
    return {
      error,
      curlLogPath,
      homeDirectory,
      nodeLogPath,
      ok: false,
      temporaryDirectory,
    };
  }
}

async function assertNoNodeHandoff(nodeLogPath) {
  await assert.rejects(
    readFile(nodeLogPath, "utf8"),
    (error) => error?.code === "ENOENT",
  );
}

async function createReleaseFixture(t, {
  changelogVersion = "0.4.0",
  packageVersion = "0.4.0",
  template,
} = {}) {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "pickermux-release-source-"));
  t.after(() => rm(projectDirectory, { recursive: true, force: true }));
  await mkdir(path.join(projectDirectory, "bin"));
  await mkdir(path.join(projectDirectory, "src"));
  await mkdir(path.join(projectDirectory, "scripts"));
  await writeFile(
    path.join(projectDirectory, "bin", "pickermux.mjs"),
    '#!/usr/bin/env node\nimport { usage } from "../src/cli.mjs";\nprocess.stdout.write(usage());\n',
  );
  await writeFile(
    path.join(projectDirectory, "src", "cli.mjs"),
    'export function usage() { return "PickerMux fixture\\n"; }\n',
  );
  await writeFile(
    path.join(projectDirectory, "lmstudio-picker.config.json"),
    '{"schemaVersion":2}\n',
  );
  await writeFile(
    path.join(projectDirectory, "package.json"),
    `${JSON.stringify({
      name: "pickermux",
      version: packageVersion,
      private: true,
      license: "MIT",
      type: "module",
      engines: {
        node: ">=22.15.0",
      },
    }, null, 2)}\n`,
  );
  await writeFile(path.join(projectDirectory, "LICENSE"), "MIT fixture\n");
  await writeFile(
    path.join(projectDirectory, "CHANGELOG.md"),
    `# Changelog\n\n## [${changelogVersion}] - 2026-08-29\n\n[${changelogVersion}]: https://github.com/patrickschiller/pickermux/releases/tag/v${changelogVersion}\n`,
  );
  await writeFile(
    path.join(projectDirectory, "scripts", "install.sh.in"),
    template ?? `#!/bin/sh
set -eu
version="__PICKERMUX_VERSION__"
archive="__PICKERMUX_ARCHIVE__"
sha256="__PICKERMUX_SHA256__"
printf '%s %s %s\\n' "$version" "$archive" "$sha256"
`,
  );
  await writeFile(
    path.join(projectDirectory, "private-engineering-notes.txt"),
    "must not ship\n",
  );
  return projectDirectory;
}

test("builds deterministic, allowlisted release assets with a CLI smoke", async (t) => {
  const projectDirectory = await createReleaseFixture(t);
  const parentDirectory = await mkdtemp(path.join(os.tmpdir(), "pickermux-release-output-"));
  t.after(() => rm(parentDirectory, { recursive: true, force: true }));
  const firstDirectory = path.join(parentDirectory, "first");
  const secondDirectory = path.join(parentDirectory, "second");

  const first = await buildRelease({
    projectDirectory,
    outputDirectory: firstDirectory,
    requestedVersion: "0.4.0",
    tag: "v0.4.0",
  });
  const second = await buildRelease({
    projectDirectory,
    outputDirectory: secondDirectory,
    requestedVersion: "0.4.0",
    tag: "v0.4.0",
  });

  assert.deepEqual(first.assets, [
    "pickermux-v0.4.0.tar.gz",
    "install.sh",
    "release-manifest.json",
    "SHA256SUMS",
  ]);
  for (const asset of first.assets) {
    assert.deepEqual(
      await readFile(path.join(firstDirectory, asset)),
      await readFile(path.join(secondDirectory, asset)),
      `${asset} must be reproducible`,
    );
  }

  const archive = await readFile(path.join(firstDirectory, first.archiveName));
  assert.equal(hash(archive), first.archiveSha256);
  const entries = parseTarGzip(archive);
  assert.deepEqual(entries.map((entry) => entry.path), [
    "LICENSE",
    "bin/",
    "bin/pickermux.mjs",
    "lmstudio-picker.config.json",
    "package.json",
    "release-manifest.json",
    "src/",
    "src/cli.mjs",
  ]);
  assert.ok(entries.every((entry) => entry.mtime === 0));
  assert.equal(entries.find((entry) => entry.path === "bin/").type, "5");
  assert.equal(entries.find((entry) => entry.path === "bin/pickermux.mjs").mode, 0o755);
  assert.equal(entries.find((entry) => entry.path === "src/cli.mjs").mode, 0o644);

  const manifestText = await readFile(
    path.join(firstDirectory, "release-manifest.json"),
    "utf8",
  );
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.version, "0.4.0");
  assert.equal(manifest.minimumNodeVersion, "22.15.0");
  assert.equal(manifest.archive, first.archiveName);
  assert.deepEqual(manifest.files.map((entry) => entry.path), [
    "LICENSE",
    "bin/pickermux.mjs",
    "lmstudio-picker.config.json",
    "package.json",
    "src/cli.mjs",
  ]);
  const archivedManifest = entries.find((entry) => entry.path === "release-manifest.json");
  assert.equal(archivedManifest.content.toString("utf8"), manifestText);
  for (const file of manifest.files) {
    const archived = entries.find((entry) => entry.path === file.path);
    assert.equal(archived.content.length, file.size);
    assert.equal(hash(archived.content), file.sha256);
  }

  const installer = await readFile(path.join(firstDirectory, "install.sh"), "utf8");
  assert.match(installer, /version="0\.4\.0"/u);
  assert.match(installer, /archive="pickermux-v0\.4\.0\.tar\.gz"/u);
  assert.match(installer, new RegExp(`sha256="${first.archiveSha256}"`, "u"));
  assert.doesNotMatch(installer, /__PICKERMUX_[A-Z0-9_]+__/u);
  await execFileAsync("/bin/sh", ["-n", path.join(firstDirectory, "install.sh")]);

  const checksums = await readFile(path.join(firstDirectory, "SHA256SUMS"), "utf8");
  for (const asset of [first.archiveName, "install.sh", "release-manifest.json"]) {
    assert.match(
      checksums,
      new RegExp(`^${hash(await readFile(path.join(firstDirectory, asset)))}  ${asset.replaceAll(".", "\\.")}$`, "mu"),
    );
  }
  assert.doesNotMatch(checksums, /private-engineering-notes/u);

  const extractionDirectory = path.join(parentDirectory, "extracted");
  await mkdir(extractionDirectory);
  await execFileAsync("tar", ["-xzf", path.join(firstDirectory, first.archiveName), "-C", extractionDirectory]);
  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(extractionDirectory, "bin", "pickermux.mjs")],
    { encoding: "utf8" },
  );
  assert.equal(stdout, "PickerMux fixture\n");
});

test("the rendered production installer enforces its bootstrap trust boundaries", async (t) => {
  const projectDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const parentDirectory = await mkdtemp(
    path.join(os.tmpdir(), "pickermux-production-installer-"),
  );
  t.after(() => rm(parentDirectory, { recursive: true, force: true }));
  const outputDirectory = path.join(parentDirectory, "release");
  const release = await buildRelease({ projectDirectory, outputDirectory });
  const productionInstaller = await readFile(
    path.join(outputDirectory, "install.sh"),
    "utf8",
  );
  const productionArchive = await readFile(
    path.join(outputDirectory, release.archiveName),
  );
  const productionEntries = parseTarGzip(productionArchive);

  await t.test("hands the verified extracted distribution to setup", async (t) => {
    const execution = await runRenderedInstaller(t, {
      archive: productionArchive,
      archiveName: release.archiveName,
      installer: productionInstaller,
      version: release.version,
    });
    assert.equal(execution.ok, true, execution.error?.stderr);
    assert.equal(execution.stderr, "");
    const curlArguments = (await readFile(execution.curlLogPath, "utf8"))
      .trimEnd()
      .split("\n");
    assert.deepEqual(curlArguments.slice(0, 18), [
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--tlsv1.2",
      "--connect-timeout",
      "15",
      "--max-time",
      "300",
      "--retry",
      "3",
      "--retry-delay",
      "1",
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--output",
    ]);
    assert.equal(curlArguments.length, 20);
    assert.ok(
      curlArguments[18].startsWith(
        `${execution.temporaryDirectory}/pickermux-installer.`,
      ),
    );
    assert.ok(curlArguments[18].endsWith(`/${release.archiveName}`));
    assert.equal(
      curlArguments[19],
      `https://github.com/patrickschiller/pickermux/releases/download/v${release.version}/${release.archiveName}`,
    );

    const nodeArguments = (await readFile(execution.nodeLogPath, "utf8"))
      .trimEnd()
      .split("\n");
    assert.equal(nodeArguments.length, 4);
    assert.equal(nodeArguments[0], `${nodeArguments[3]}/bin/pickermux.mjs`);
    assert.deepEqual(nodeArguments.slice(1, 3), ["setup", "--distribution-root"]);
    assert.ok(
      nodeArguments[3].startsWith(
        `${execution.temporaryDirectory}/pickermux-installer.`,
      ),
    );
    assert.deepEqual(await readdir(execution.homeDirectory), []);
    assert.deepEqual(await readdir(execution.temporaryDirectory), []);
  });

  await t.test("rejects an archive whose bytes do not match the embedded checksum", async (t) => {
    const tamperedArchive = Buffer.concat([
      productionArchive,
      Buffer.from("tampered\n", "utf8"),
    ]);
    const execution = await runRenderedInstaller(t, {
      archive: tamperedArchive,
      archiveName: release.archiveName,
      installer: productionInstaller,
      version: release.version,
    });
    assert.equal(execution.ok, false);
    assert.equal(execution.error.code, 1);
    assert.match(execution.error.stderr, /release archive checksum mismatch/u);
    await assertNoNodeHandoff(execution.nodeLogPath);
  });

  await t.test("rejects a path-traversal archive before extraction", async (t) => {
    const traversalArchive = createTarGzip([
      ...productionEntries,
      {
        path: "../pickermux-installer-escaped",
        mode: 0o644,
        type: "0",
        content: Buffer.from("must not escape\n", "utf8"),
      },
    ]);
    const execution = await runRenderedInstaller(t, {
      archive: traversalArchive,
      archiveName: release.archiveName,
      installer: installerForArchive(
        productionInstaller,
        release.archiveSha256,
        traversalArchive,
      ),
      version: release.version,
    });
    assert.equal(execution.ok, false);
    assert.equal(execution.error.code, 1);
    assert.match(
      execution.error.stderr,
      /unsafe archive path: \.\.\/pickermux-installer-escaped/u,
    );
    await assertNoNodeHandoff(execution.nodeLogPath);
    assert.deepEqual(await readdir(execution.temporaryDirectory), []);
  });

  await t.test("rejects a symbolic-link archive entry", async (t) => {
    const linkedArchive = createTarGzip([
      ...productionEntries,
      {
        path: "linked-license",
        mode: 0o777,
        type: "2",
        linkTarget: "LICENSE",
      },
    ]);
    const execution = await runRenderedInstaller(t, {
      archive: linkedArchive,
      archiveName: release.archiveName,
      installer: installerForArchive(
        productionInstaller,
        release.archiveSha256,
        linkedArchive,
      ),
      version: release.version,
    });
    assert.equal(execution.ok, false);
    assert.equal(execution.error.code, 1);
    assert.match(
      execution.error.stderr,
      /release archive contains a link or unsupported file type/u,
    );
    await assertNoNodeHandoff(execution.nodeLogPath);
  });

  await t.test("rejects an extracted distribution missing a required file", async (t) => {
    const incompleteArchive = createTarGzip(
      productionEntries.filter((entry) => entry.path !== "LICENSE"),
    );
    const execution = await runRenderedInstaller(t, {
      archive: incompleteArchive,
      archiveName: release.archiveName,
      installer: installerForArchive(
        productionInstaller,
        release.archiveSha256,
        incompleteArchive,
      ),
      version: release.version,
    });
    assert.equal(execution.ok, false);
    assert.equal(execution.error.code, 1);
    assert.match(execution.error.stderr, /release archive is missing LICENSE/u);
    await assertNoNodeHandoff(execution.nodeLogPath);
  });
});

test("rejects tag, package, and changelog version drift", async (t) => {
  const projectDirectory = await createReleaseFixture(t);
  const parentDirectory = await mkdtemp(path.join(os.tmpdir(), "pickermux-release-drift-"));
  t.after(() => rm(parentDirectory, { recursive: true, force: true }));

  await assert.rejects(
    buildRelease({
      projectDirectory,
      outputDirectory: path.join(parentDirectory, "tag"),
      tag: "v0.4.1",
    }),
    /tag v0\.4\.1 does not match package\.json v0\.4\.0/u,
  );
  await assert.rejects(
    buildRelease({
      projectDirectory,
      outputDirectory: path.join(parentDirectory, "version"),
      requestedVersion: "0.4.1",
    }),
    /release 0\.4\.1 does not match package\.json 0\.4\.0/u,
  );

  const packagePath = path.join(projectDirectory, "package.json");
  const packageMetadata = JSON.parse(await readFile(packagePath, "utf8"));
  packageMetadata.engines.node = "^22.15.0";
  await writeFile(packagePath, `${JSON.stringify(packageMetadata, null, 2)}\n`);
  await assert.rejects(
    buildRelease({
      projectDirectory,
      outputDirectory: path.join(parentDirectory, "node-engine"),
    }),
    /engines\.node must declare one exact >=X\.Y\.Z minimum/u,
  );
  packageMetadata.engines.node = ">=22.15.0";
  await writeFile(packagePath, `${JSON.stringify(packageMetadata, null, 2)}\n`);

  await writeFile(
    path.join(projectDirectory, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n",
  );
  await assert.rejects(
    buildRelease({
      projectDirectory,
      outputDirectory: path.join(parentDirectory, "changelog"),
    }),
    /CHANGELOG\.md must contain exactly one dated 0\.4\.0 release heading/u,
  );
});

test("rejects symlinked payload inputs and incomplete installer templates", async (t) => {
  const projectDirectory = await createReleaseFixture(t);
  const parentDirectory = await mkdtemp(path.join(os.tmpdir(), "pickermux-release-invalid-"));
  t.after(() => rm(parentDirectory, { recursive: true, force: true }));
  await symlink("../LICENSE", path.join(projectDirectory, "src", "linked.mjs"));
  await assert.rejects(
    buildRelease({
      projectDirectory,
      outputDirectory: path.join(parentDirectory, "symlink"),
    }),
    /must not be a symbolic link: src\/linked\.mjs/u,
  );

  await rm(path.join(projectDirectory, "src", "linked.mjs"));
  await writeFile(
    path.join(projectDirectory, "scripts", "install.sh.in"),
    '#!/bin/sh\nversion="__PICKERMUX_VERSION__"\narchive="__PICKERMUX_ARCHIVE__"\n',
  );
  await assert.rejects(
    buildRelease({
      projectDirectory,
      outputDirectory: path.join(parentDirectory, "template"),
    }),
    /missing __PICKERMUX_SHA256__/u,
  );
});

test("refuses to replace an existing release output", async (t) => {
  const projectDirectory = await createReleaseFixture(t);
  const parentDirectory = await mkdtemp(path.join(os.tmpdir(), "pickermux-release-existing-"));
  t.after(() => rm(parentDirectory, { recursive: true, force: true }));
  const outputDirectory = path.join(parentDirectory, "release");
  await mkdir(outputDirectory);
  await writeFile(path.join(outputDirectory, "owned.txt"), "keep\n");

  await assert.rejects(
    buildRelease({ projectDirectory, outputDirectory }),
    /Release output already exists/u,
  );
  assert.equal(await readFile(path.join(outputDirectory, "owned.txt"), "utf8"), "keep\n");
});

test("the repository itself produces a smoke-testable release archive", async (t) => {
  const projectDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const parentDirectory = await mkdtemp(path.join(os.tmpdir(), "pickermux-repository-release-"));
  t.after(() => rm(parentDirectory, { recursive: true, force: true }));
  const outputDirectory = path.join(parentDirectory, "release");
  const result = await buildRelease({ projectDirectory, outputDirectory });
  const archiveEntries = parseTarGzip(
    await readFile(path.join(outputDirectory, result.archiveName)),
  );
  const archivePaths = new Set(archiveEntries.map((entry) => entry.path));
  assert.equal(archivePaths.has("src/account-cache.mjs"), true);
  assert.equal(archivePaths.has("src/provider-id.mjs"), true);
  assert.equal(archivePaths.has("src/purge-data.mjs"), true);
  assert.equal(archivePaths.has("src/runtime-purge.mjs"), true);
  assert.equal(archivePaths.has("src/smart-router.mjs"), true);
  assert.equal(archivePaths.has("src/smart-routing-constants.mjs"), true);
  const extractionDirectory = path.join(parentDirectory, "extracted");
  await mkdir(extractionDirectory);
  await execFileAsync("tar", [
    "-xzf",
    path.join(outputDirectory, result.archiveName),
    "-C",
    extractionDirectory,
  ]);
  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(extractionDirectory, "bin", "pickermux.mjs"), "help"],
    { encoding: "utf8" },
  );
  assert.match(stdout, /PickerMux/u);
});
