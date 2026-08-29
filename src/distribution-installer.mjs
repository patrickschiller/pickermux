import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { readPickerMuxMetadata } from "./version.mjs";

const RECEIPT_SCHEMA_VERSION = 1;
const RECEIPT_PRODUCT = "pickermux";
const RECEIPT_OWNER = "pickermux-cli-installer";
const REQUIRED_DISTRIBUTION_ENTRIES = Object.freeze([
  "LICENSE",
  "bin",
  "lmstudio-picker.config.json",
  "package.json",
  "src",
]);
const OPTIONAL_DISTRIBUTION_ENTRIES = Object.freeze([
  "release-manifest.json",
]);
const ALL_DISTRIBUTION_ENTRIES = new Set([
  ...REQUIRED_DISTRIBUTION_ENTRIES,
  ...OPTIONAL_DISTRIBUTION_ENTRIES,
]);
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

async function lstatOptional(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwned(stats, target) {
  const uid = currentUid();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`Refusing path not owned by the current user: ${target}`);
  }
}

async function assertDirectory(target, label) {
  const stats = await lstatOptional(target);
  if (stats === null) throw new Error(`${label} is missing: ${target}`);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${target}`);
  }
  assertOwned(stats, target);
  return stats;
}

async function ensureDirectory(target, mode) {
  const previous = await lstatOptional(target);
  if (previous !== null) {
    const stats = await assertDirectory(target, "Managed directory");
    const unsafeMask = mode === 0o700 ? 0o077 : 0o022;
    if ((stats.mode & unsafeMask) !== 0) {
      throw new Error(`Managed directory permissions are unsafe: ${target}`);
    }
    return stats;
  }
  await mkdir(target, { recursive: true, mode });
  const stats = await assertDirectory(target, "Managed directory");
  await chmod(target, mode);
  return stats;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function writeAtomic(destination, contents, mode, directoryMode = 0o700) {
  await ensureDirectory(path.dirname(destination), directoryMode);
  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle;
  let created = false;
  try {
    handle = await open(temporary, "wx", mode);
    created = true;
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, mode);
    await rename(temporary, destination);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await unlink(temporary).catch(() => {});
    throw error;
  }
}

function shellQuote(value) {
  if (typeof value !== "string" || /[\u0000\r\n]/u.test(value)) {
    throw new Error("Managed launcher paths must not contain control characters");
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function managedLauncherContents(paths) {
  const entryPoint = path.join(paths.currentPath, "bin", "pickermux.mjs");
  const defaultConfigPath = path.join(
    paths.currentPath,
    "lmstudio-picker.config.json",
  );
  return `#!/bin/sh
set -eu
if [ -f ${shellQuote(paths.installedConfigPath)} ] && [ ! -L ${shellQuote(paths.installedConfigPath)} ]; then
  PICKERMUX_CONFIG_PATH=${shellQuote(paths.installedConfigPath)} exec node ${shellQuote(entryPoint)} "$@"
fi
PICKERMUX_CONFIG_PATH=${shellQuote(defaultConfigPath)} exec node ${shellQuote(entryPoint)} "$@"
`;
}

async function collectDistributionFiles(root, { allowExtraRootEntries = false } = {}) {
  const resolvedRoot = path.resolve(root);
  const rootStats = await assertDirectory(resolvedRoot, "Distribution root");
  if (!allowExtraRootEntries && (rootStats.mode & 0o077) !== 0) {
    throw new Error(`Managed distribution permissions are not private: ${resolvedRoot}`);
  }
  const rootEntries = await readdir(resolvedRoot);
  for (const required of REQUIRED_DISTRIBUTION_ENTRIES) {
    if (!rootEntries.includes(required)) {
      throw new Error(`Distribution is missing required entry: ${required}`);
    }
  }
  if (!allowExtraRootEntries) {
    const unexpected = rootEntries.filter((entry) => !ALL_DISTRIBUTION_ENTRIES.has(entry));
    if (unexpected.length > 0) {
      throw new Error(`Managed distribution contains unexpected entries: ${unexpected.join(", ")}`);
    }
  }

  const files = [];
  async function visit(absolute, relative) {
    const stats = await lstat(absolute);
    assertOwned(stats, absolute);
    if (!allowExtraRootEntries && (stats.mode & 0o077) !== 0) {
      throw new Error(`Managed distribution permissions are not private: ${relative}`);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Distribution must not contain symbolic links: ${relative}`);
    }
    if (stats.isDirectory()) {
      const names = (await readdir(absolute)).sort();
      for (const name of names) {
        await visit(path.join(absolute, name), path.posix.join(relative, name));
      }
      return;
    }
    if (!stats.isFile()) {
      throw new Error(`Distribution contains an unsupported file type: ${relative}`);
    }
    files.push({ absolute, relative });
  }

  for (const entry of [...REQUIRED_DISTRIBUTION_ENTRIES, ...OPTIONAL_DISTRIBUTION_ENTRIES]) {
    if (rootEntries.includes(entry)) {
      await visit(path.join(resolvedRoot, entry), entry);
    }
  }
  return files;
}

export async function distributionDigest(root, options = {}) {
  const hash = createHash("sha256");
  const files = await collectDistributionFiles(root, options);
  for (const file of files.sort((left, right) => left.relative.localeCompare(right.relative))) {
    const contents = await readFile(file.absolute);
    hash.update(`${Buffer.byteLength(file.relative, "utf8")}:`);
    hash.update(file.relative, "utf8");
    hash.update(`${contents.length}:`);
    hash.update(contents);
  }
  return hash.digest("hex");
}

async function hardenDistribution(root) {
  async function visit(target, executable = false) {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      throw new Error(`Staged distribution contains a symbolic link: ${target}`);
    }
    if (stats.isDirectory()) {
      await chmod(target, 0o700);
      const names = await readdir(target);
      for (const name of names) {
        await visit(path.join(target, name), executable || path.basename(target) === "bin");
      }
      return;
    }
    if (!stats.isFile()) {
      throw new Error(`Staged distribution contains an unsupported file type: ${target}`);
    }
    await chmod(target, executable ? 0o700 : 0o600);
  }
  await visit(root);
}

function parseVersion(version) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error(`Unsupported PickerMux version: ${version}`);
  }
  const [core, prerelease] = version.split("-", 2);
  return {
    core: core.split(".").map(Number),
    prerelease: prerelease?.split(".") ?? null,
  };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function validateReceiptShape(receipt, paths) {
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("PickerMux install receipt must be a JSON object");
  }
  if (
    receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    receipt.product !== RECEIPT_PRODUCT ||
    receipt.owner !== RECEIPT_OWNER
  ) {
    throw new Error("PickerMux install receipt has unknown ownership metadata");
  }
  parseVersion(receipt.activeVersion);
  if (
    receipt.activeTarget !== `versions/${receipt.activeVersion}` ||
    receipt.launcherPath !== paths.launcherPath ||
    !/^[0-9a-f]{64}$/u.test(receipt.launcherSha256) ||
    !Array.isArray(receipt.versions) ||
    receipt.versions.length === 0
  ) {
    throw new Error("PickerMux install receipt contains unsafe managed paths");
  }
  const seen = new Set();
  for (const entry of receipt.versions) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.version !== "string" ||
      !VERSION_PATTERN.test(entry.version) ||
      entry.path !== `versions/${entry.version}` ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256) ||
      seen.has(entry.version)
    ) {
      throw new Error("PickerMux install receipt contains an invalid version record");
    }
    seen.add(entry.version);
  }
  if (!seen.has(receipt.activeVersion)) {
    throw new Error("PickerMux install receipt does not own its active version");
  }
  return receipt;
}

async function readReceipt(paths) {
  const stats = await lstatOptional(paths.receiptPath);
  if (stats === null) return { receipt: null, raw: null };
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`PickerMux install receipt is not a regular file: ${paths.receiptPath}`);
  }
  assertOwned(stats, paths.receiptPath);
  if ((stats.mode & 0o077) !== 0) {
    throw new Error("PickerMux install receipt permissions are not private");
  }
  const raw = await readFile(paths.receiptPath);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error("PickerMux install receipt is invalid JSON", { cause: error });
  }
  return { receipt: validateReceiptShape(parsed, paths), raw };
}

async function assertManagedLauncher(paths, receipt) {
  const stats = await lstatOptional(paths.launcherPath);
  if (stats === null || !stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Managed PickerMux launcher is missing or has an unsafe file type");
  }
  assertOwned(stats, paths.launcherPath);
  if ((stats.mode & 0o077) !== 0) {
    throw new Error("Managed PickerMux launcher permissions are not private");
  }
  const contents = await readFile(paths.launcherPath);
  const expected = managedLauncherContents(paths);
  if (
    sha256(contents) !== receipt.launcherSha256 ||
    contents.toString("utf8") !== expected
  ) {
    throw new Error("Managed PickerMux launcher was modified; refusing to overwrite it");
  }
  return { contents, mode: stats.mode & 0o777 };
}

export async function validateDistributionInstallation({
  paths,
  permittedUnreceiptedVersions = [],
}) {
  await assertDirectory(paths.applicationDirectory, "PickerMux application directory");
  const { receipt, raw } = await readReceipt(paths);
  if (!receipt) return { installed: false, receipt: null, raw: null };

  const currentStats = await lstatOptional(paths.currentPath);
  if (currentStats === null || !currentStats.isSymbolicLink()) {
    throw new Error("Managed PickerMux current pointer is missing or was replaced");
  }
  assertOwned(currentStats, paths.currentPath);
  const currentTarget = await readlink(paths.currentPath);
  if (currentTarget !== receipt.activeTarget) {
    throw new Error("Managed PickerMux current pointer differs from its receipt");
  }

  const launcher = await assertManagedLauncher(paths, receipt);
  await assertDirectory(paths.versionsDirectory, "PickerMux versions directory");
  for (const entry of receipt.versions) {
    const versionPath = path.join(paths.applicationDirectory, entry.path);
    await assertDirectory(versionPath, `Managed PickerMux ${entry.version} distribution`);
    const digest = await distributionDigest(versionPath);
    if (digest !== entry.sha256) {
      throw new Error(`Managed PickerMux ${entry.version} distribution was modified`);
    }
  }
  const expectedVersions = new Set([
    ...receipt.versions.map((entry) => entry.version),
    ...permittedUnreceiptedVersions,
  ]);
  const actualVersions = await readdir(paths.versionsDirectory);
  if (
    actualVersions.length !== expectedVersions.size ||
    actualVersions.some((entry) => !expectedVersions.has(entry))
  ) {
    throw new Error("PickerMux versions directory contains unowned state");
  }
  return {
    installed: true,
    receipt,
    raw,
    launcher,
    currentTarget,
    activeDirectory: path.join(paths.applicationDirectory, receipt.activeTarget),
  };
}

async function assertFreshDestination(paths, permittedVersion) {
  const launcher = await lstatOptional(paths.launcherPath);
  if (launcher !== null) {
    throw new Error(`Refusing to overwrite an unmanaged launcher: ${paths.launcherPath}`);
  }
  const entries = await readdir(paths.applicationDirectory);
  for (const entry of entries) {
    if (entry === path.basename(paths.lockPath)) continue;
    if (entry === "versions") {
      await assertDirectory(paths.versionsDirectory, "PickerMux versions directory");
      const versions = await readdir(paths.versionsDirectory);
      if (
        versions.length === 0 ||
        (permittedVersion &&
          versions.length === 1 &&
          versions[0] === permittedVersion)
      ) {
        continue;
      }
    }
    throw new Error(
      `PickerMux application directory contains unmanaged state: ${path.join(paths.applicationDirectory, entry)}`,
    );
  }
}

async function captureManagedPath(target) {
  const stats = await lstatOptional(target);
  if (stats === null) return { type: "missing" };
  assertOwned(stats, target);
  if (stats.isSymbolicLink()) {
    return { type: "symlink", target: await readlink(target) };
  }
  if (stats.isFile()) {
    return {
      type: "file",
      mode: stats.mode & 0o777,
      contents: await readFile(target),
    };
  }
  return { type: "unsupported" };
}

async function recoverStaleInstallationLock(paths, processKillImpl) {
  const stats = await lstat(paths.lockPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (stats === null) return true;
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("PickerMux setup lock has an unsafe file type; refusing to remove it");
  }
  assertOwned(stats, paths.lockPath);
  if ((stats.mode & 0o077) !== 0) {
    throw new Error("PickerMux setup lock permissions are unsafe; refusing to remove it");
  }
  const raw = await readFile(paths.lockPath, "utf8");
  if (!/^[1-9]\d*\n$/u.test(raw)) {
    throw new Error("PickerMux setup lock has invalid ownership data; refusing to remove it");
  }
  const pid = Number(raw.trim());
  if (!Number.isSafeInteger(pid)) {
    throw new Error("PickerMux setup lock PID is invalid; refusing to remove it");
  }
  let alive = true;
  try {
    processKillImpl(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") alive = false;
    else if (error?.code !== "EPERM") throw error;
  }
  if (alive) {
    throw new Error(
      `Another PickerMux setup or removal is in progress (PID ${pid})`,
    );
  }

  const stalePath = `${paths.lockPath}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await rename(paths.lockPath, stalePath);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  const movedStats = await lstat(stalePath);
  if (movedStats.dev !== stats.dev || movedStats.ino !== stats.ino) {
    await rename(stalePath, paths.lockPath).catch(() => {});
    throw new Error("PickerMux setup lock changed during stale-lock recovery");
  }
  await unlink(stalePath);
  return true;
}

async function acquireInstallationLock(
  paths,
  { processKillImpl = process.kill.bind(process) } = {},
) {
  await ensureDirectory(paths.applicationDirectory, 0o700);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    let created = false;
    try {
      handle = await open(paths.lockPath, "wx", 0o600);
      created = true;
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.sync();
      await handle.close();
      const ownedLock = await lstat(paths.lockPath);
      return async () => {
        const current = await lstatOptional(paths.lockPath);
        if (current === null) return;
        if (
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.dev !== ownedLock.dev ||
          current.ino !== ownedLock.ino
        ) {
          throw new Error("PickerMux setup lock changed during the operation");
        }
        await unlink(paths.lockPath);
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (created) await unlink(paths.lockPath).catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      if (attempt === 1) {
        throw new Error(
          `Another PickerMux setup or removal is in progress (${paths.lockPath})`,
        );
      }
      await recoverStaleInstallationLock(paths, processKillImpl);
    }
  }
  throw new Error("PickerMux setup lock could not be acquired");
}

export async function withInstallationLock(paths, operation, options) {
  const release = await acquireInstallationLock(paths, options);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function copyDistribution({ sourceRoot, destination, versionsDirectory }) {
  const source = path.resolve(sourceRoot);
  await collectDistributionFiles(source, { allowExtraRootEntries: true });
  await ensureDirectory(versionsDirectory, 0o700);
  const staging = path.join(
    versionsDirectory,
    `.distribution.${process.pid}.${randomBytes(8).toString("hex")}.staging`,
  );
  try {
    await mkdir(staging, { mode: 0o700 });
    for (const entry of [...REQUIRED_DISTRIBUTION_ENTRIES, ...OPTIONAL_DISTRIBUTION_ENTRIES]) {
      const sourcePath = path.join(source, entry);
      if (await lstatOptional(sourcePath)) {
        await cp(sourcePath, path.join(staging, entry), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
    }
    await hardenDistribution(staging);
    await collectDistributionFiles(staging);
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return distributionDigest(destination);
}

async function replaceCurrentPointer(paths, target) {
  const temporary = path.join(
    paths.applicationDirectory,
    `.current.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await symlink(target, temporary);
    await rename(temporary, paths.currentPath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function restoreSnapshot(
  destination,
  snapshot,
  mode = 0o600,
  directoryMode = 0o700,
) {
  if (snapshot === null) {
    await unlink(destination).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  } else {
    await writeAtomic(destination, snapshot, mode, directoryMode);
  }
}

async function rollbackActivation({
  paths,
  previous,
  createdVersionPath,
  cause,
}) {
  const failures = [];
  try {
    if (previous.currentTarget === null) {
      await unlink(paths.currentPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    } else {
      await replaceCurrentPointer(paths, previous.currentTarget);
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    await restoreSnapshot(
      paths.launcherPath,
      previous.launcher,
      previous.launcherMode ?? 0o700,
      0o755,
    );
  } catch (error) {
    failures.push(error);
  }
  try {
    await restoreSnapshot(paths.receiptPath, previous.receipt, 0o600);
  } catch (error) {
    failures.push(error);
  }
  if (createdVersionPath) {
    try {
      await rm(createdVersionPath, { recursive: true, force: false });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `PickerMux setup failed and CLI activation rollback was incomplete. Original: ${cause.message}; rollback: ${failures.map((error) => error.message).join("; ")}`,
      { cause: new AggregateError([cause, ...failures]) },
    );
  }
  throw new Error(
    `PickerMux setup failed; previous CLI activation was restored: ${cause.message}`,
    { cause },
  );
}

export async function setupManagedDistribution({
  sourceRoot,
  paths,
  activate,
  now = () => new Date(),
  processKillImpl,
  beforeControlCommit = async () => undefined,
}) {
  if (typeof activate !== "function") throw new TypeError("Setup requires an activation callback");
  if (currentUid() === 0) {
    throw new Error("PickerMux setup must not run as root or with sudo");
  }
  const source = path.resolve(sourceRoot);
  const metadata = await readPickerMuxMetadata(source);
  const sourceDigest = await distributionDigest(source, { allowExtraRootEntries: true });

  return withInstallationLock(paths, async () => {
    const installed = await validateDistributionInstallation({ paths });
    if (!installed.installed) await assertFreshDestination(paths);
    if (
      installed.installed &&
      compareVersions(metadata.version, installed.receipt.activeVersion) < 0
    ) {
      throw new Error(
        `Refusing to downgrade PickerMux from ${installed.receipt.activeVersion} to ${metadata.version}`,
      );
    }

    const destination = path.join(paths.versionsDirectory, metadata.version);
    const existingVersion = installed.receipt?.versions.find(
      (entry) => entry.version === metadata.version,
    );
    let createdVersionPath;
    let destinationDigest;
    if (existingVersion) {
      if (existingVersion.sha256 !== sourceDigest) {
        throw new Error(
          `PickerMux ${metadata.version} is already installed with different immutable contents`,
        );
      }
      destinationDigest = existingVersion.sha256;
    } else {
      if (await lstatOptional(destination)) {
        throw new Error(`Refusing to overwrite an unowned PickerMux version: ${destination}`);
      }
      destinationDigest = await copyDistribution({
        sourceRoot: source,
        destination,
        versionsDirectory: paths.versionsDirectory,
      });
      createdVersionPath = destination;
    }

    const launcher = managedLauncherContents(paths);
    const previous = {
      currentTarget: installed.currentTarget ?? null,
      launcher: installed.launcher?.contents ?? null,
      launcherMode: installed.launcher?.mode,
      receipt: installed.raw ?? null,
    };
    const versions = installed.receipt
      ? [...installed.receipt.versions]
      : [];
    if (!versions.some((entry) => entry.version === metadata.version)) {
      versions.push({
        version: metadata.version,
        path: `versions/${metadata.version}`,
        sha256: destinationDigest,
      });
      versions.sort((left, right) => compareVersions(left.version, right.version));
    }
    const receipt = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      product: RECEIPT_PRODUCT,
      owner: RECEIPT_OWNER,
      activeVersion: metadata.version,
      activeTarget: `versions/${metadata.version}`,
      launcherPath: paths.launcherPath,
      launcherSha256: sha256(launcher),
      versions,
      updatedAt: now().toISOString(),
    };

    try {
      await beforeControlCommit();
      if (installed.installed) {
        const confirmed = await validateDistributionInstallation({
          paths,
          permittedUnreceiptedVersions: createdVersionPath
            ? [metadata.version]
            : [],
        });
        if (
          !confirmed.installed ||
          !confirmed.raw.equals(installed.raw) ||
          confirmed.currentTarget !== installed.currentTarget ||
          confirmed.launcher.mode !== installed.launcher.mode ||
          !confirmed.launcher.contents.equals(installed.launcher.contents)
        ) {
          throw new Error(
            "PickerMux ownership state changed concurrently; refusing to overwrite it",
          );
        }
      } else {
        await assertFreshDestination(
          paths,
          createdVersionPath ? metadata.version : undefined,
        );
      }
      if ((await distributionDigest(destination)) !== destinationDigest) {
        throw new Error(
          `PickerMux ${metadata.version} changed after staging; refusing to activate it`,
        );
      }
    } catch (error) {
      if (createdVersionPath) {
        try {
          await rm(createdVersionPath, { recursive: true, force: false });
        } catch (cleanupError) {
          throw new Error(
            `PickerMux setup stopped before activation, but staged-version cleanup failed. Original: ${error.message}; cleanup: ${cleanupError.message}`,
            { cause: new AggregateError([error, cleanupError]) },
          );
        }
      }
      throw error;
    }

    try {
      await ensureDirectory(path.dirname(paths.launcherDirectory), 0o755);
      await ensureDirectory(paths.launcherDirectory, 0o755);
      await writeAtomic(paths.launcherPath, launcher, 0o700, 0o755);
      await replaceCurrentPointer(paths, receipt.activeTarget);
      await writeAtomic(
        paths.receiptPath,
        `${JSON.stringify(receipt, null, 2)}\n`,
        0o600,
      );
      const activation = await activate({
        distributionRoot: destination,
        configPath: path.join(destination, "lmstudio-picker.config.json"),
        previousVersion: installed.receipt?.activeVersion ?? null,
        version: metadata.version,
      });
      return {
        version: metadata.version,
        previousVersion: installed.receipt?.activeVersion ?? null,
        upgraded:
          installed.installed && installed.receipt.activeVersion !== metadata.version,
        reused: Boolean(existingVersion),
        launcherPath: paths.launcherPath,
        currentPath: paths.currentPath,
        activation,
      };
    } catch (error) {
      await rollbackActivation({
        paths,
        previous,
        createdVersionPath,
        cause: error,
      });
    }
  }, { processKillImpl });
}

async function rollbackStagedRemoval(staging, moves, renameImpl) {
  const failures = [];
  for (const move of [...moves].reverse()) {
    try {
      if (await lstatOptional(move.source)) {
        throw new Error(
          `Refusing to overwrite a path created during removal rollback: ${move.source}`,
        );
      }
      if (!(await lstatOptional(move.staged))) {
        throw new Error(`Staged removal path is missing: ${move.staged}`);
      }
      await renameImpl(move.staged, move.source);
    } catch (error) {
      failures.push(error);
    }
  }
  await rmdir(staging).catch((error) => {
    if (error?.code !== "ENOENT") failures.push(error);
  });
  if (failures.length > 0) {
    throw new AggregateError(failures, "PickerMux CLI removal rollback was incomplete");
  }
}

async function validateStagedRemoval(staging, installation) {
  const expectedEntries = ["current", "launcher", "receipt", "versions"];
  const actualEntries = (await readdir(staging)).sort();
  if (
    actualEntries.length !== expectedEntries.length ||
    actualEntries.some((entry, index) => entry !== expectedEntries[index])
  ) {
    throw new Error("PickerMux staged removal contains unexpected state");
  }

  const launcher = await captureManagedPath(path.join(staging, "launcher"));
  if (
    launcher.type !== "file" ||
    launcher.mode !== installation.launcher.mode ||
    !launcher.contents.equals(installation.launcher.contents)
  ) {
    throw new Error("PickerMux launcher changed while removal was staged");
  }
  const current = await captureManagedPath(path.join(staging, "current"));
  if (current.type !== "symlink" || current.target !== installation.currentTarget) {
    throw new Error("PickerMux current pointer changed while removal was staged");
  }
  const receipt = await captureManagedPath(path.join(staging, "receipt"));
  if (
    receipt.type !== "file" ||
    (receipt.mode & 0o077) !== 0 ||
    !receipt.contents.equals(installation.raw)
  ) {
    throw new Error("PickerMux receipt changed while removal was staged");
  }

  const stagedVersions = path.join(staging, "versions");
  await assertDirectory(stagedVersions, "Staged PickerMux versions directory");
  const expectedVersions = new Set(
    installation.receipt.versions.map((entry) => entry.version),
  );
  const actualVersions = await readdir(stagedVersions);
  if (
    actualVersions.length !== expectedVersions.size ||
    actualVersions.some((entry) => !expectedVersions.has(entry))
  ) {
    throw new Error("PickerMux versions changed while removal was staged");
  }
  for (const entry of installation.receipt.versions) {
    const versionPath = path.join(staging, entry.path);
    await assertDirectory(versionPath, `Staged PickerMux ${entry.version} distribution`);
    if ((await distributionDigest(versionPath)) !== entry.sha256) {
      throw new Error(`PickerMux ${entry.version} changed while removal was staged`);
    }
  }
}

async function stageDistributionRemoval(paths, installation, renameImpl) {
  const stagingParent = path.dirname(paths.applicationDirectory);
  await assertDirectory(stagingParent, "PickerMux application parent directory");
  const staging = path.join(
    stagingParent,
    `.PickerMux.removal.${process.pid}.${randomBytes(8).toString("hex")}.staging`,
  );
  await mkdir(staging, { mode: 0o700 });
  const moves = [
    { source: paths.launcherPath, staged: path.join(staging, "launcher") },
    { source: paths.currentPath, staged: path.join(staging, "current") },
    { source: paths.versionsDirectory, staged: path.join(staging, "versions") },
    { source: paths.receiptPath, staged: path.join(staging, "receipt") },
  ];
  const completed = [];
  try {
    for (const move of moves) {
      await renameImpl(move.source, move.staged);
      completed.push(move);
    }
    await validateStagedRemoval(staging, installation);
    return { staging, moves: completed };
  } catch (error) {
    try {
      await rollbackStagedRemoval(staging, completed, renameImpl);
    } catch (rollbackError) {
      throw new Error(
        `PickerMux CLI removal staging failed and rollback was incomplete. Original: ${error.message}; rollback: ${rollbackError.errors?.map((entry) => entry.message).join("; ") ?? rollbackError.message}`,
        { cause: new AggregateError([error, rollbackError]) },
      );
    }
    throw error;
  }
}

export async function removeManagedDistribution({
  paths,
  beforeRemove = async () => undefined,
  processKillImpl,
  renameImpl = rename,
  rmImpl = rm,
}) {
  let result;
  result = await withInstallationLock(paths, async () => {
    const installation = await validateDistributionInstallation({ paths });
    if (!installation.installed) {
      throw new Error("No receipt-validated PickerMux CLI installation was found");
    }
    const confirmed = await validateDistributionInstallation({ paths });
    if (
      !confirmed.installed ||
      !confirmed.raw.equals(installation.raw)
    ) {
      throw new Error("PickerMux CLI ownership state changed during removal");
    }
    const staged = await stageDistributionRemoval(paths, confirmed, renameImpl);
    let beforeResult;
    try {
      beforeResult = await beforeRemove(confirmed);
    } catch (error) {
      try {
        await rollbackStagedRemoval(staged.staging, staged.moves, renameImpl);
      } catch (rollbackError) {
        throw new Error(
          `PickerMux integration removal failed and CLI rollback was incomplete. Original: ${error.message}; rollback: ${rollbackError.errors?.map((entry) => entry.message).join("; ") ?? rollbackError.message}`,
          { cause: new AggregateError([error, rollbackError]) },
        );
      }
      throw new Error(
        `PickerMux integration removal failed; the CLI distribution was restored: ${error.message}`,
        { cause: error },
      );
    }
    let cleanupPendingPath = null;
    try {
      await rmImpl(staged.staging, { recursive: true, force: false });
    } catch {
      if (await lstatOptional(staged.staging)) {
        cleanupPendingPath = staged.staging;
      }
    }
    const removed = {
      launcherPath: paths.launcherPath,
      versions: confirmed.receipt.versions.map((entry) => entry.version),
      cleanupPendingPath,
    };
    return { beforeResult, removed };
  }, { processKillImpl });
  await rmdir(paths.versionsDirectory).catch((error) => {
    if (!new Set(["ENOENT", "ENOTEMPTY"]).has(error?.code)) throw error;
  });
  await rmdir(paths.applicationDirectory).catch((error) => {
    if (!new Set(["ENOENT", "ENOTEMPTY"]).has(error?.code)) throw error;
  });
  return result;
}
