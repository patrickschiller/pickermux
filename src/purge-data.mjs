import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

const MAX_BACKUP_FILES = 10_000;
const FIXED_INSTALL_FILE_NAMES = new Set([
  "bridge.log",
  "certifications.json",
  "compatibility.json",
  "keychain-state.json",
  "models.json",
  "runtime.json",
  "service-config.json",
  "state.json",
]);
const FIXED_INSTALL_DIRECTORY_NAMES = new Set(["backups", "runtime-app"]);
const PREVIOUS_RUNTIME_PATTERN = /^runtime-app\.previous-[1-9]\d*-[0-9a-f]{8}$/u;
const BACKUP_READ_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

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

function assertCurrentUserOwner(stats, target) {
  const uid = currentUid();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(
      `Refusing PickerMux backup path not owned by the current user: ${target}`,
    );
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeBackupOptions(options = {}) {
  if (
    typeof options.backupDirectory !== "string" ||
    !options.backupDirectory.trim()
  ) {
    throw new TypeError("backupDirectory must be a non-empty path");
  }
  if (typeof options.configPath !== "string" || !options.configPath.trim()) {
    throw new TypeError("configPath must be a non-empty path");
  }
  const backupDirectory = path.resolve(options.backupDirectory);
  const configPath = path.resolve(options.configPath);
  if (
    backupDirectory === path.parse(backupDirectory).root ||
    path.basename(backupDirectory) !== "backups" ||
    path.dirname(backupDirectory) === path.parse(backupDirectory).root
  ) {
    throw new Error(
      "PickerMux backupDirectory must be an exact non-root backups directory",
    );
  }
  if (configPath === path.parse(configPath).root || !path.basename(configPath)) {
    throw new Error("configPath must identify one configuration filename");
  }
  if (path.dirname(configPath) === path.parse(configPath).root) {
    throw new Error("configPath must not be directly inside a filesystem root");
  }
  const expectedBackupDirectory = path.join(
    path.dirname(configPath),
    "model-bridge",
    "backups",
  );
  if (backupDirectory !== expectedBackupDirectory) {
    throw new Error(
      "PickerMux backupDirectory must be the exact model-bridge/backups directory beside configPath",
    );
  }

  const configName = path.basename(configPath);
  const timestamp = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z`;
  const backupNamePattern = new RegExp(
    `^${escapeRegex(configName)}\\.lm-studio-model-router\\.${timestamp}\\.bak(?:\\.[1-9]\\d{0,3})?$`,
    "u",
  );
  return { backupDirectory, configPath, configName, backupNamePattern };
}

function assertRealPrivateDirectory(stats, target, label) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${target}`);
  }
  assertCurrentUserOwner(stats, target);
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are not private: ${target}`);
  }
}

function snapshot(stats) {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode & 0o777,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  });
}

function sameSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameDirectoryIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function sameStableDirectoryIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode
  );
}

/**
 * Verify that the private installation directory contains only paths emitted
 * by PickerMux. This is a purge preflight; it never removes any entry.
 */
export async function inventoryPickerMuxInstallDirectory({
  installDirectory,
} = {}) {
  if (typeof installDirectory !== "string" || !installDirectory.trim()) {
    throw new TypeError("installDirectory must be a non-empty path");
  }
  const directory = path.resolve(installDirectory);
  if (
    directory === path.parse(directory).root ||
    path.basename(directory) !== "model-bridge" ||
    path.dirname(directory) === path.parse(directory).root
  ) {
    throw new Error(
      "PickerMux installDirectory must be an exact non-root model-bridge directory",
    );
  }
  const directoryStats = await lstatOptional(directory);
  if (directoryStats === null) {
    return Object.freeze({
      exists: false,
      directory,
      entries: Object.freeze([]),
    });
  }
  assertRealPrivateDirectory(
    directoryStats,
    directory,
    "PickerMux installation directory",
  );

  const names = (await readdir(directory)).sort();
  const entries = [];
  for (const name of names) {
    const target = path.join(directory, name);
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `PickerMux installation directory contains a symbolic link: ${name}`,
      );
    }
    assertCurrentUserOwner(stats, target);
    if (FIXED_INSTALL_FILE_NAMES.has(name)) {
      if (!stats.isFile()) {
        throw new Error(
          `PickerMux managed file path is not a regular file: ${name}`,
        );
      }
      if ((stats.mode & 0o077) !== 0) {
        throw new Error(
          `PickerMux managed file permissions are not private: ${name}`,
        );
      }
    } else if (
      FIXED_INSTALL_DIRECTORY_NAMES.has(name) ||
      PREVIOUS_RUNTIME_PATTERN.test(name)
    ) {
      assertRealPrivateDirectory(
        stats,
        target,
        "PickerMux managed directory",
      );
    } else {
      throw new Error(
        `PickerMux installation directory contains an unexpected entry: ${name}`,
      );
    }
    entries.push(Object.freeze({ name, snapshot: snapshot(stats) }));
  }

  const confirmed = await lstat(directory);
  if (!sameSnapshot(snapshot(directoryStats), snapshot(confirmed))) {
    throw new Error("PickerMux installation directory changed during inventory");
  }
  return Object.freeze({
    exists: true,
    directory,
    entries: Object.freeze(entries),
  });
}

async function inspectBackupDirectory(
  directory,
  { backupNamePattern, requireManagedName },
) {
  if (requireManagedName && path.basename(directory) !== "backups") {
    throw new Error("PickerMux backup inventory requires the exact backups path");
  }
  const directoryStats = await lstatOptional(directory);
  if (directoryStats === null) {
    return Object.freeze({
      exists: false,
      directory,
      directorySnapshot: null,
      backups: Object.freeze([]),
    });
  }

  const parent = path.dirname(directory);
  const parentStats = await lstat(parent);
  assertRealPrivateDirectory(
    parentStats,
    parent,
    "PickerMux backup parent directory",
  );
  assertRealPrivateDirectory(
    directoryStats,
    directory,
    "PickerMux backup directory",
  );

  const names = (await readdir(directory)).sort();
  if (names.length > MAX_BACKUP_FILES) {
    throw new Error(
      `PickerMux backup directory exceeds the ${MAX_BACKUP_FILES}-file limit`,
    );
  }
  const backups = [];
  for (const name of names) {
    const target = path.join(directory, name);
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `PickerMux backup directory contains a symbolic link: ${name}`,
      );
    }
    if (!stats.isFile()) {
      throw new Error(
        `PickerMux backup directory contains a non-file entry: ${name}`,
      );
    }
    assertCurrentUserOwner(stats, target);
    if (!backupNamePattern.test(name)) {
      throw new Error(
        `PickerMux backup directory contains an unexpected file: ${name}`,
      );
    }
    backups.push(Object.freeze({
      name,
      path: target,
      snapshot: snapshot(stats),
    }));
  }

  const confirmedDirectory = await lstat(directory);
  const directorySnapshot = snapshot(directoryStats);
  if (!sameSnapshot(directorySnapshot, snapshot(confirmedDirectory))) {
    throw new Error("PickerMux backup directory changed during inventory");
  }
  return Object.freeze({
    exists: true,
    directory,
    directorySnapshot,
    backups: Object.freeze(backups),
  });
}

function assertSameInventory(previous, current) {
  if (
    !previous.exists ||
    !current.exists ||
    !sameDirectoryIdentity(
      previous.directorySnapshot,
      current.directorySnapshot,
    ) ||
    previous.backups.length !== current.backups.length
  ) {
    throw new Error("PickerMux backup ownership state changed during purge");
  }
  for (let index = 0; index < previous.backups.length; index += 1) {
    const before = previous.backups[index];
    const after = current.backups[index];
    if (
      before.name !== after.name ||
      !sameSnapshot(before.snapshot, after.snapshot)
    ) {
      throw new Error("PickerMux backup ownership state changed during purge");
    }
  }
}

function assertExpectedBackupFiles(directorySnapshot, expected, current) {
  if (
    !current.exists ||
    !sameStableDirectoryIdentity(
      directorySnapshot,
      current.directorySnapshot,
    ) ||
    expected.length !== current.backups.length
  ) {
    throw new Error("PickerMux backup ownership state changed during cleanup");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const before = expected[index];
    const after = current.backups[index];
    if (
      before.name !== after.name ||
      !sameSnapshot(before.snapshot, after.snapshot)
    ) {
      throw new Error("PickerMux backup ownership state changed during cleanup");
    }
  }
}

/**
 * Inventory only exact backups emitted by config-manager.mjs. An unexpected
 * file, directory or symlink makes the whole inventory fail closed.
 */
export async function inventoryPickerMuxBackups(options = {}) {
  const normalized = normalizeBackupOptions(options);
  return inspectBackupDirectory(normalized.backupDirectory, {
    backupNamePattern: normalized.backupNamePattern,
    requireManagedName: true,
  });
}

async function rollbackBackupQuarantine(
  quarantinePath,
  backupDirectory,
  renameImpl,
) {
  if (await lstatOptional(backupDirectory)) {
    throw new Error(
      `Refusing to overwrite a backup path created during rollback: ${backupDirectory}`,
    );
  }
  if (!(await lstatOptional(quarantinePath))) {
    throw new Error(`PickerMux backup quarantine is missing: ${quarantinePath}`);
  }
  await renameImpl(quarantinePath, backupDirectory);
}

async function unlinkExactBackup(target, expected, unlinkImpl) {
  let handle;
  try {
    handle = await open(target, BACKUP_READ_FLAGS);
    const stats = await handle.stat();
    const pathStats = await lstat(target);
    if (
      !stats.isFile() ||
      pathStats.isSymbolicLink() ||
      !pathStats.isFile() ||
      stats.dev !== pathStats.dev ||
      stats.ino !== pathStats.ino ||
      !sameSnapshot(expected, snapshot(stats)) ||
      !sameSnapshot(expected, snapshot(pathStats))
    ) {
      throw new Error(
        "PickerMux backup ownership state changed during cleanup",
      );
    }
    assertCurrentUserOwner(stats, target);
    assertCurrentUserOwner(pathStats, target);
    await unlinkImpl(target);
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOENT") {
      throw new Error(
        "PickerMux backup ownership state changed during cleanup",
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  if (await lstatOptional(target)) {
    throw new Error("PickerMux backup cleanup did not remove the exact file");
  }
}

async function cleanupBackupQuarantine(
  quarantinePath,
  inventory,
  normalized,
  { unlinkImpl, rmdirImpl },
) {
  let remaining = [...inventory.backups];
  while (remaining.length > 0) {
    const current = await inspectBackupDirectory(quarantinePath, {
      backupNamePattern: normalized.backupNamePattern,
      requireManagedName: false,
    });
    assertExpectedBackupFiles(
      inventory.directorySnapshot,
      remaining,
      current,
    );
    const next = remaining[0];
    await unlinkExactBackup(
      path.join(quarantinePath, next.name),
      next.snapshot,
      unlinkImpl,
    );
    remaining = remaining.slice(1);
  }

  const empty = await inspectBackupDirectory(quarantinePath, {
    backupNamePattern: normalized.backupNamePattern,
    requireManagedName: false,
  });
  assertExpectedBackupFiles(inventory.directorySnapshot, [], empty);
  await rmdirImpl(quarantinePath);
}

/**
 * Atomically detach the validated backup directory, validate it again under a
 * private quarantine name, then remove only that quarantine. Cleanup failure
 * leaves one exact path for a later retry and never widens the deletion scope.
 */
export async function purgePickerMuxBackups({
  backupDirectory,
  configPath,
  beforeCommit = async () => undefined,
  renameImpl = rename,
  unlinkImpl = unlink,
  rmdirImpl = rmdir,
} = {}) {
  if (
    typeof beforeCommit !== "function" ||
    typeof renameImpl !== "function" ||
    typeof unlinkImpl !== "function" ||
    typeof rmdirImpl !== "function"
  ) {
    throw new TypeError("Backup purge dependencies must be functions");
  }
  const normalized = normalizeBackupOptions({ backupDirectory, configPath });
  const inventory = await inventoryPickerMuxBackups(normalized);
  if (!inventory.exists) {
    await beforeCommit();
    return Object.freeze({
      changed: false,
      backupDirectory: normalized.backupDirectory,
      backups: Object.freeze([]),
      cleanupPendingPath: null,
    });
  }

  const quarantinePath = path.join(
    path.dirname(normalized.backupDirectory),
    `.backups.purge.${process.pid}.${randomBytes(8).toString("hex")}.staging`,
  );
  if (await lstatOptional(quarantinePath)) {
    throw new Error(
      `PickerMux backup quarantine already exists: ${quarantinePath}`,
    );
  }
  await renameImpl(normalized.backupDirectory, quarantinePath);
  try {
    const staged = await inspectBackupDirectory(quarantinePath, {
      backupNamePattern: normalized.backupNamePattern,
      requireManagedName: false,
    });
    assertSameInventory(inventory, staged);
    await beforeCommit();
  } catch (error) {
    try {
      await rollbackBackupQuarantine(
        quarantinePath,
        normalized.backupDirectory,
        renameImpl,
      );
    } catch (rollbackError) {
      const combined = new Error(
        `PickerMux backup purge validation failed and rollback was incomplete. Original: ${error.message}; rollback: ${rollbackError.message}`,
        { cause: new AggregateError([error, rollbackError]) },
      );
      combined.cleanupPendingPath = quarantinePath;
      throw combined;
    }
    throw error;
  }

  let cleanupPendingPath = null;
  try {
    await cleanupBackupQuarantine(
      quarantinePath,
      inventory,
      normalized,
      { unlinkImpl, rmdirImpl },
    );
  } catch {
    // A partially cleaned quarantine is still detached from active state.
  }
  if (await lstatOptional(quarantinePath)) cleanupPendingPath = quarantinePath;

  return Object.freeze({
    changed: true,
    backupDirectory: normalized.backupDirectory,
    backups: Object.freeze(inventory.backups.map(({ name }) => name)),
    cleanupPendingPath,
  });
}
