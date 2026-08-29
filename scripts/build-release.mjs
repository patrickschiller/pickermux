#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const RELEASE_MANIFEST_NAME = "release-manifest.json";
const INSTALLER_NAME = "install.sh";
const CHECKSUMS_NAME = "SHA256SUMS";
const ARCHIVE_MTIME_SECONDS = 0;
const RELEASE_DIRECTORIES = ["bin", "src"];
const RELEASE_FILES = [
  "lmstudio-picker.config.json",
  "package.json",
  "LICENSE",
];
const INSTALLER_PLACEHOLDERS = new Map([
  ["__PICKERMUX_VERSION__", "version"],
  ["__PICKERMUX_ARCHIVE__", "archiveName"],
  ["__PICKERMUX_SHA256__", "archiveSha256"],
]);
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function normalizedRelativePath(value) {
  return value.split(path.sep).join("/");
}

function comparePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function assertPathType(absolutePath, relativePath, expectedType) {
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Release input must not be a symbolic link: ${relativePath}`);
  }
  if (expectedType === "directory" && !metadata.isDirectory()) {
    throw new Error(`Release input must be a directory: ${relativePath}`);
  }
  if (expectedType === "file" && !metadata.isFile()) {
    throw new Error(`Release input must be a regular file: ${relativePath}`);
  }
}

async function walkReleaseDirectory(projectDirectory, relativeDirectory) {
  const absoluteDirectory = path.join(projectDirectory, relativeDirectory);
  await assertPathType(absoluteDirectory, relativeDirectory, "directory");

  const directories = [`${normalizedRelativePath(relativeDirectory)}/`];
  const files = [];
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => comparePaths(left.name, right.name));

  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    const normalizedPath = normalizedRelativePath(relativePath);
    const absolutePath = path.join(projectDirectory, relativePath);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Release input must not be a symbolic link: ${normalizedPath}`);
    }
    if (metadata.isDirectory()) {
      const nested = await walkReleaseDirectory(projectDirectory, relativePath);
      directories.push(...nested.directories);
      files.push(...nested.files);
    } else if (metadata.isFile()) {
      files.push(normalizedPath);
    } else {
      throw new Error(`Release input must be a regular file or directory: ${normalizedPath}`);
    }
  }

  return { directories, files };
}

async function collectReleaseInputs(projectDirectory) {
  const directoryPaths = [];
  const filePaths = [];

  for (const relativeDirectory of RELEASE_DIRECTORIES) {
    const entries = await walkReleaseDirectory(projectDirectory, relativeDirectory);
    directoryPaths.push(...entries.directories);
    filePaths.push(...entries.files);
  }

  for (const relativePath of RELEASE_FILES) {
    await assertPathType(
      path.join(projectDirectory, relativePath),
      relativePath,
      "file",
    );
    filePaths.push(relativePath);
  }

  directoryPaths.sort(comparePaths);
  filePaths.sort(comparePaths);
  const files = [];
  for (const relativePath of filePaths) {
    const content = await readFile(path.join(projectDirectory, relativePath));
    files.push({
      path: normalizedRelativePath(relativePath),
      content,
      mode: relativePath.startsWith(`bin${path.sep}`) ? 0o755 : 0o644,
    });
  }

  return { directoryPaths, files };
}

function parsePackageMetadata(content) {
  let metadata;
  try {
    metadata = JSON.parse(content);
  } catch {
    throw new Error("package.json must contain valid JSON");
  }
  if (metadata?.name !== "pickermux") {
    throw new Error('package.json name must be "pickermux"');
  }
  if (typeof metadata.version !== "string" || !SEMVER_PATTERN.test(metadata.version)) {
    throw new Error("package.json version must be a stable semantic version");
  }
  if (metadata.license !== "MIT") {
    throw new Error('package.json license must be "MIT"');
  }
  const minimumNodeMatch = /^>=(\d+\.\d+\.\d+)$/u.exec(metadata.engines?.node ?? "");
  if (!minimumNodeMatch || !SEMVER_PATTERN.test(minimumNodeMatch[1])) {
    throw new Error("package.json engines.node must declare one exact >=X.Y.Z minimum");
  }
  return {
    ...metadata,
    minimumNodeVersion: minimumNodeMatch[1],
  };
}

function assertChangelogVersion(changelog, version) {
  const escapedVersion = version.replaceAll(".", "\\.");
  const headingPattern = new RegExp(
    `^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`,
    "gmu",
  );
  const headings = changelog.match(headingPattern) ?? [];
  if (headings.length !== 1) {
    throw new Error(`CHANGELOG.md must contain exactly one dated ${version} release heading`);
  }
  if (!changelog.includes(
    `[${version}]: https://github.com/patrickschiller/pickermux/releases/tag/v${version}`,
  )) {
    throw new Error(`CHANGELOG.md must link ${version} to tag v${version}`);
  }
}

async function validateReleaseMetadata(projectDirectory, requestedVersion, tag) {
  const packagePath = path.join(projectDirectory, "package.json");
  const changelogPath = path.join(projectDirectory, "CHANGELOG.md");
  await assertPathType(packagePath, "package.json", "file");
  await assertPathType(changelogPath, "CHANGELOG.md", "file");
  const packageMetadata = parsePackageMetadata(
    await readFile(packagePath, "utf8"),
  );
  const version = requestedVersion ?? packageMetadata.version;
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`Release version must be stable SemVer: ${version}`);
  }
  if (version !== packageMetadata.version) {
    throw new Error(
      `Requested release ${version} does not match package.json ${packageMetadata.version}`,
    );
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match package.json v${version}`);
  }
  assertChangelogVersion(
    await readFile(changelogPath, "utf8"),
    version,
  );
  return { packageMetadata, version };
}

function writeAsciiField(buffer, value, offset, length, label) {
  if (!/^[\x00\x20-\x7e]*$/u.test(value)) {
    throw new Error(`Tar ${label} must contain ASCII only`);
  }
  const encoded = Buffer.from(value, "ascii");
  if (encoded.length > length) {
    throw new Error(`Tar ${label} is too long: ${value}`);
  }
  encoded.copy(buffer, offset);
}

function writeOctalField(buffer, value, offset, length, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Tar ${label} must be a non-negative integer`);
  }
  const octal = value.toString(8);
  if (octal.length > length - 1) {
    throw new Error(`Tar ${label} exceeds its field width`);
  }
  writeAsciiField(
    buffer,
    `${octal.padStart(length - 1, "0")}\0`,
    offset,
    length,
    label,
  );
}

function createTarHeader({ entryPath, mode, size, type }) {
  if (Buffer.byteLength(entryPath, "ascii") !== entryPath.length) {
    throw new Error(`Release archive path must contain ASCII only: ${entryPath}`);
  }
  if (entryPath.length > 100) {
    throw new Error(`Release archive path exceeds the ustar limit: ${entryPath}`);
  }

  const header = Buffer.alloc(512, 0);
  writeAsciiField(header, entryPath, 0, 100, "path");
  writeOctalField(header, mode, 100, 8, "mode");
  writeOctalField(header, 0, 108, 8, "uid");
  writeOctalField(header, 0, 116, 8, "gid");
  writeOctalField(header, size, 124, 12, "size");
  writeOctalField(header, ARCHIVE_MTIME_SECONDS, 136, 12, "mtime");
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  writeAsciiField(header, "ustar\0", 257, 6, "magic");
  writeAsciiField(header, "00", 263, 2, "version");
  writeAsciiField(header, "root", 265, 32, "owner");
  writeAsciiField(header, "root", 297, 32, "group");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  const encodedChecksum = `${checksum.toString(8).padStart(6, "0")}\0 `;
  writeAsciiField(header, encodedChecksum, 148, 8, "checksum");
  return header;
}

function createDeterministicArchive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const content = entry.content ?? Buffer.alloc(0);
    blocks.push(createTarHeader({
      entryPath: entry.path,
      mode: entry.mode,
      size: content.length,
      type: entry.type,
    }));
    if (content.length > 0) {
      blocks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding > 0) blocks.push(Buffer.alloc(padding, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks), {
    level: 9,
    mtime: 0,
  });
}

function renderInstaller(template, values) {
  let rendered = template;
  for (const [placeholder, property] of INSTALLER_PLACEHOLDERS) {
    if (!rendered.includes(placeholder)) {
      throw new Error(`Installer template is missing ${placeholder}`);
    }
    rendered = rendered.replaceAll(placeholder, values[property]);
  }
  const unresolved = rendered.match(/__PICKERMUX_[A-Z0-9_]+__/gu);
  if (unresolved) {
    throw new Error(`Installer template contains unresolved placeholder ${unresolved[0]}`);
  }
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

function releaseManifest(version, minimumNodeVersion, archiveName, files) {
  return `${JSON.stringify({
    schemaVersion: 1,
    name: "pickermux",
    version,
    minimumNodeVersion,
    archive: archiveName,
    files: files.map((entry) => ({
      path: entry.path,
      mode: entry.mode.toString(8).padStart(4, "0"),
      size: entry.content.length,
      sha256: sha256(entry.content),
    })),
  }, null, 2)}\n`;
}

async function assertOutputDoesNotExist(outputDirectory) {
  try {
    await lstat(outputDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Release output already exists: ${outputDirectory}`);
}

export async function buildRelease({
  projectDirectory,
  outputDirectory,
  requestedVersion,
  tag,
}) {
  const resolvedProjectDirectory = path.resolve(projectDirectory);
  const resolvedOutputDirectory = path.resolve(outputDirectory);
  if (resolvedOutputDirectory === resolvedProjectDirectory) {
    throw new Error("Release output directory must not be the project root");
  }
  await assertOutputDoesNotExist(resolvedOutputDirectory);

  const { packageMetadata, version } = await validateReleaseMetadata(
    resolvedProjectDirectory,
    requestedVersion,
    tag,
  );
  const archiveName = `pickermux-v${version}.tar.gz`;
  const inputs = await collectReleaseInputs(resolvedProjectDirectory);
  const manifest = releaseManifest(
    version,
    packageMetadata.minimumNodeVersion,
    archiveName,
    inputs.files,
  );
  const archiveEntries = [
    ...inputs.directoryPaths.map((entryPath) => ({
      path: entryPath,
      mode: 0o755,
      type: "5",
    })),
    ...inputs.files.map((entry) => ({
      ...entry,
      type: "0",
    })),
    {
      path: RELEASE_MANIFEST_NAME,
      content: Buffer.from(manifest, "utf8"),
      mode: 0o644,
      type: "0",
    },
  ].sort((left, right) => comparePaths(left.path, right.path));
  const archive = createDeterministicArchive(archiveEntries);
  const archiveSha256 = sha256(archive);
  const installerTemplatePath = path.join(
    resolvedProjectDirectory,
    "scripts",
    "install.sh.in",
  );
  await assertPathType(installerTemplatePath, "scripts/install.sh.in", "file");
  const installerTemplate = await readFile(installerTemplatePath, "utf8");
  const installer = renderInstaller(installerTemplate, {
    version,
    archiveName,
    archiveSha256,
  });
  const checksumEntries = [
    [archiveName, archive],
    [INSTALLER_NAME, Buffer.from(installer, "utf8")],
    [RELEASE_MANIFEST_NAME, Buffer.from(manifest, "utf8")],
  ];
  const checksums = `${checksumEntries
    .map(([name, content]) => `${sha256(content)}  ${name}`)
    .join("\n")}\n`;

  const parentDirectory = path.dirname(resolvedOutputDirectory);
  await mkdir(parentDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(
    path.join(parentDirectory, `.pickermux-release-${randomUUID()}-`),
  );
  let outputCreated = false;
  try {
    await writeFile(path.join(stagingDirectory, archiveName), archive, {
      flag: "wx",
      mode: 0o644,
    });
    await writeFile(path.join(stagingDirectory, INSTALLER_NAME), installer, {
      flag: "wx",
      mode: 0o755,
    });
    await chmod(path.join(stagingDirectory, INSTALLER_NAME), 0o755);
    await writeFile(path.join(stagingDirectory, RELEASE_MANIFEST_NAME), manifest, {
      flag: "wx",
      mode: 0o644,
    });
    await writeFile(path.join(stagingDirectory, CHECKSUMS_NAME), checksums, {
      flag: "wx",
      mode: 0o644,
    });
    await mkdir(resolvedOutputDirectory);
    outputCreated = true;
    for (const asset of [archiveName, INSTALLER_NAME, RELEASE_MANIFEST_NAME, CHECKSUMS_NAME]) {
      await rename(
        path.join(stagingDirectory, asset),
        path.join(resolvedOutputDirectory, asset),
      );
    }
    await rm(stagingDirectory, { recursive: true });
  } catch (error) {
    if (outputCreated) {
      await rm(resolvedOutputDirectory, { recursive: true, force: true });
    }
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    version,
    archiveName,
    archiveSha256,
    outputDirectory: resolvedOutputDirectory,
    assets: [archiveName, INSTALLER_NAME, RELEASE_MANIFEST_NAME, CHECKSUMS_NAME],
  };
}

function usage() {
  return `Build deterministic PickerMux release assets.

Usage:
  node scripts/build-release.mjs [--version X.Y.Z] [--tag vX.Y.Z] --output PATH
`;
}

function parseArguments(argv) {
  const options = {
    outputDirectory: undefined,
    requestedVersion: undefined,
    tag: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!["--output", "--output-dir", "--version", "--tag"].includes(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    if (argument === "--output" || argument === "--output-dir") {
      if (options.outputDirectory !== undefined) {
        throw new Error("Release output may be specified only once");
      }
      options.outputDirectory = value;
    } else if (argument === "--version") options.requestedVersion = value;
    else options.tag = value;
  }
  if (!options.help && !options.outputDirectory) {
    throw new Error("--output is required");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const projectDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const result = await buildRelease({ projectDirectory, ...options });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`build-release: ${message}\n`);
    process.exitCode = 1;
  });
}
