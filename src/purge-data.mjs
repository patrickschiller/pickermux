import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
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
const RUNTIME_METADATA_FILE_NAMES = Object.freeze([
  "bridge.log",
  "certifications.json",
  "compatibility.json",
  "models.json",
  "runtime.json",
  "service-config.json",
]);
const PREVIOUS_RUNTIME_PATTERN = /^runtime-app\.previous-[1-9]\d*-[0-9a-f]{8}$/u;
const BACKUP_READ_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const issuedInstallInventories = new WeakSet();
const issuedBackupInventories = new WeakSet();

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

function assertSingleLink(stats, target) {
  if (stats.nlink !== 1) {
    throw new Error(
      `Refusing PickerMux managed file with multiple hard links: ${target}`,
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
    uid: stats.uid,
    mode: stats.mode & 0o777,
    nlink: stats.nlink,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  });
}

function sameSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameDirectoryIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function readExactRegularFile(target, expectedSnapshot) {
  let handle;
  try {
    const initialPathStats = await lstat(target);
    if (initialPathStats.isSymbolicLink() || !initialPathStats.isFile()) {
      throw new Error(`PickerMux managed file changed while reading: ${target}`);
    }
    assertSingleLink(initialPathStats, target);
    assertCurrentUserOwner(initialPathStats, target);
    const initialSnapshot = snapshot(initialPathStats);
    if (
      expectedSnapshot &&
      !sameSnapshot(expectedSnapshot, initialSnapshot)
    ) {
      throw new Error(`PickerMux managed file changed while reading: ${target}`);
    }

    handle = await open(target, BACKUP_READ_FLAGS);
    const stats = await handle.stat();
    const pathStats = await lstat(target);
    if (
      !stats.isFile() ||
      pathStats.isSymbolicLink() ||
      !pathStats.isFile() ||
      stats.dev !== pathStats.dev ||
      stats.ino !== pathStats.ino ||
      stats.nlink !== 1 ||
      pathStats.nlink !== 1 ||
      !sameSnapshot(initialSnapshot, snapshot(stats)) ||
      !sameSnapshot(initialSnapshot, snapshot(pathStats)) ||
      (expectedSnapshot && (
        !sameSnapshot(expectedSnapshot, snapshot(stats)) ||
        !sameSnapshot(expectedSnapshot, snapshot(pathStats))
      ))
    ) {
      throw new Error(`PickerMux managed file changed while reading: ${target}`);
    }
    assertCurrentUserOwner(stats, target);
    const contents = await handle.readFile();
    const confirmed = await handle.stat();
    const confirmedPath = await lstat(target);
    if (
      !sameSnapshot(snapshot(stats), snapshot(confirmed)) ||
      !sameSnapshot(snapshot(stats), snapshot(confirmedPath)) ||
      contents.length !== confirmed.size
    ) {
      throw new Error(`PickerMux managed file changed while reading: ${target}`);
    }
    return Object.freeze({
      contents,
      sha256: sha256(contents),
      snapshot: snapshot(confirmed),
    });
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOENT") {
      throw new Error(`PickerMux managed file changed while reading: ${target}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sameStableDirectoryIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode
  );
}

function sameStableFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
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
    const inventory = Object.freeze({
      exists: false,
      directory,
      directorySnapshot: null,
      entries: Object.freeze([]),
    });
    issuedInstallInventories.add(inventory);
    return inventory;
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
      assertSingleLink(stats, target);
      const captured = await readExactRegularFile(target, snapshot(stats));
      entries.push(Object.freeze({
        name,
        path: target,
        type: "file",
        sha256: captured.sha256,
        snapshot: captured.snapshot,
      }));
    } else if (
      FIXED_INSTALL_DIRECTORY_NAMES.has(name) ||
      PREVIOUS_RUNTIME_PATTERN.test(name)
    ) {
      assertRealPrivateDirectory(
        stats,
        target,
        "PickerMux managed directory",
      );
      entries.push(Object.freeze({
        name,
        path: target,
        type: "directory",
        snapshot: snapshot(stats),
      }));
    } else {
      throw new Error(
        `PickerMux installation directory contains an unexpected entry: ${name}`,
      );
    }
  }

  const confirmed = await lstat(directory);
  if (!sameSnapshot(snapshot(directoryStats), snapshot(confirmed))) {
    throw new Error("PickerMux installation directory changed during inventory");
  }
  const inventory = Object.freeze({
    exists: true,
    directory,
    directorySnapshot: snapshot(confirmed),
    entries: Object.freeze(entries),
  });
  issuedInstallInventories.add(inventory);
  return inventory;
}

function assertIssuedInstallInventory(inventory) {
  if (!issuedInstallInventories.has(inventory)) {
    throw new TypeError(
      "A PickerMux installation inventory issued by this module is required",
    );
  }
}

function sameInstallInventory(previous, current) {
  if (previous.exists !== current.exists) return false;
  if (!previous.exists) return true;
  if (
    !sameSnapshot(previous.directorySnapshot, current.directorySnapshot) ||
    previous.entries.length !== current.entries.length
  ) {
    return false;
  }
  return previous.entries.every((before, index) => {
    const after = current.entries[index];
    return (
      before.name === after.name &&
      before.type === after.type &&
      before.sha256 === after.sha256 &&
      sameSnapshot(before.snapshot, after.snapshot)
    );
  });
}

export async function revalidatePickerMuxInstallDirectoryInventory(inventory) {
  assertIssuedInstallInventory(inventory);
  const current = await inventoryPickerMuxInstallDirectory({
    installDirectory: inventory.directory,
  });
  if (!sameInstallInventory(inventory, current)) {
    throw new Error("PickerMux installation ownership state changed after inventory");
  }
  return inventory;
}

function runtimeMetadataEntries(inventory) {
  const entriesByName = new Map(
    inventory.entries.map((entry) => [entry.name, entry]),
  );
  return RUNTIME_METADATA_FILE_NAMES.map((name) => ({
    name,
    entry: entriesByName.get(name) ?? null,
  }));
}

async function assertInventoriedRuntimeMetadataEntry(inventory, name, entry) {
  const target = path.join(inventory.directory, name);
  const stats = await lstatOptional(target);
  if (entry === null) {
    if (stats !== null) {
      throw new Error(`PickerMux runtime metadata appeared after inventory: ${name}`);
    }
    return;
  }
  if (stats === null || entry.type !== "file") {
    throw new Error(`PickerMux runtime metadata changed after inventory: ${name}`);
  }
  const captured = await readExactRegularFile(target, entry.snapshot);
  if (captured.sha256 !== entry.sha256) {
    throw new Error(`PickerMux runtime metadata hash changed after inventory: ${name}`);
  }
}

export async function revalidateInventoriedRuntimeMetadata(inventory) {
  assertIssuedInstallInventory(inventory);
  for (const { name, entry } of runtimeMetadataEntries(inventory)) {
    await assertInventoriedRuntimeMetadataEntry(inventory, name, entry);
  }
  return inventory;
}

async function assertStagedRuntimeMetadata(target, entry) {
  const captured = await readExactRegularFile(target);
  if (
    !sameStableFileIdentity(entry.snapshot, captured.snapshot) ||
    entry.sha256 !== captured.sha256
  ) {
    throw new Error(
      `PickerMux runtime metadata changed during removal: ${entry.name}`,
    );
  }
  return captured;
}

async function rollbackRuntimeMetadataQuarantine(
  stagingDirectory,
  installDirectory,
  moved,
  renameImpl,
  rmdirImpl,
) {
  for (const entry of [...moved].reverse()) {
    const staged = path.join(stagingDirectory, entry.name);
    const destination = path.join(installDirectory, entry.name);
    if (await lstatOptional(destination)) {
      throw new Error(
        `PickerMux runtime metadata path appeared during rollback: ${entry.name}`,
      );
    }
    await assertStagedRuntimeMetadata(staged, entry);
    await renameImpl(staged, destination);
  }
  if ((await readdir(stagingDirectory)).length !== 0) {
    throw new Error("PickerMux runtime metadata quarantine gained entries");
  }
  await rmdirImpl(stagingDirectory);
}

/**
 * Remove only the six fixed runtime metadata files captured by an issued
 * installation inventory. Files are detached, hash/inode revalidated, and
 * unlinked one by one; foreign entries and recursive deletion are out of scope.
 */
export async function removeInventoriedRuntimeMetadata({
  inventory,
  renameImpl = rename,
  unlinkImpl = unlink,
  rmdirImpl = rmdir,
} = {}) {
  assertIssuedInstallInventory(inventory);
  if (
    typeof renameImpl !== "function" ||
    typeof unlinkImpl !== "function" ||
    typeof rmdirImpl !== "function"
  ) {
    throw new TypeError("Runtime metadata cleanup dependencies must be functions");
  }
  await revalidateInventoriedRuntimeMetadata(inventory);
  const entries = runtimeMetadataEntries(inventory)
    .map(({ entry }) => entry)
    .filter(Boolean);
  if (entries.length === 0) {
    return Object.freeze({
      changed: false,
      removedFiles: Object.freeze([]),
      cleanupPendingPath: null,
    });
  }

  const stagingDirectory = path.join(
    inventory.directory,
    `.runtime-metadata.purge.${process.pid}.${randomBytes(8).toString("hex")}.staging`,
  );
  if (await lstatOptional(stagingDirectory)) {
    throw new Error("PickerMux runtime metadata quarantine already exists");
  }
  await mkdir(stagingDirectory, { mode: 0o700 });
  const stagingStats = await lstat(stagingDirectory);
  assertRealPrivateDirectory(
    stagingStats,
    stagingDirectory,
    "PickerMux runtime metadata quarantine",
  );

  const moved = [];
  try {
    for (const entry of entries) {
      await assertInventoriedRuntimeMetadataEntry(
        inventory,
        entry.name,
        entry,
      );
      await renameImpl(
        path.join(inventory.directory, entry.name),
        path.join(stagingDirectory, entry.name),
      );
      moved.push(entry);
      await assertStagedRuntimeMetadata(
        path.join(stagingDirectory, entry.name),
        entry,
      );
    }
  } catch (error) {
    try {
      await rollbackRuntimeMetadataQuarantine(
        stagingDirectory,
        inventory.directory,
        moved,
        renameImpl,
        rmdirImpl,
      );
    } catch (rollbackError) {
      const combined = new Error(
        "PickerMux runtime metadata validation failed and rollback was incomplete",
        { cause: new AggregateError([error, rollbackError]) },
      );
      combined.cleanupPendingPath = stagingDirectory;
      throw combined;
    }
    throw error;
  }

  let cleanupPendingPath = null;
  const removedFiles = [];
  try {
    for (const entry of entries) {
      const target = path.join(stagingDirectory, entry.name);
      await assertStagedRuntimeMetadata(target, entry);
      await unlinkImpl(target);
      if (await lstatOptional(target)) {
        throw new Error(
          `PickerMux runtime metadata cleanup was incomplete: ${entry.name}`,
        );
      }
      removedFiles.push(path.join(inventory.directory, entry.name));
    }
    if ((await readdir(stagingDirectory)).length !== 0) {
      throw new Error("PickerMux runtime metadata quarantine gained entries");
    }
    const confirmedStaging = await lstat(stagingDirectory);
    if (
      confirmedStaging.dev !== stagingStats.dev ||
      confirmedStaging.ino !== stagingStats.ino
    ) {
      throw new Error("PickerMux runtime metadata quarantine changed identity");
    }
    await rmdirImpl(stagingDirectory);
  } catch {
    cleanupPendingPath = stagingDirectory;
  }
  if (await lstatOptional(stagingDirectory)) {
    cleanupPendingPath = stagingDirectory;
  }
  return Object.freeze({
    changed: true,
    removedFiles: Object.freeze(removedFiles),
    cleanupPendingPath,
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
    assertSingleLink(stats, target);
    assertCurrentUserOwner(stats, target);
    if (!backupNamePattern.test(name)) {
      throw new Error(
        `PickerMux backup directory contains an unexpected file: ${name}`,
      );
    }
    const captured = await readExactRegularFile(target, snapshot(stats));
    backups.push(Object.freeze({
      name,
      path: target,
      sha256: captured.sha256,
      snapshot: captured.snapshot,
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
      before.sha256 !== after.sha256 ||
      !sameStableFileIdentity(before.snapshot, after.snapshot)
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
      before.sha256 !== after.sha256 ||
      !sameStableFileIdentity(before.snapshot, after.snapshot)
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
  const inspected = await inspectBackupDirectory(normalized.backupDirectory, {
    backupNamePattern: normalized.backupNamePattern,
    requireManagedName: true,
  });
  const inventory = Object.freeze({
    ...inspected,
    configPath: normalized.configPath,
  });
  issuedBackupInventories.add(inventory);
  return inventory;
}

export async function revalidatePickerMuxBackupInventory(inventory) {
  if (!issuedBackupInventories.has(inventory)) {
    throw new TypeError("A PickerMux backup inventory issued by this module is required");
  }
  const normalized = normalizeBackupOptions({
    backupDirectory: inventory.directory,
    configPath: inventory.configPath,
  });
  const current = await inspectBackupDirectory(normalized.backupDirectory, {
    backupNamePattern: normalized.backupNamePattern,
    requireManagedName: true,
  });
  if (!inventory.exists) {
    if (current.exists) {
      throw new Error("PickerMux backup ownership state changed during purge");
    }
    return inventory;
  }
  assertSameInventory(inventory, current);
  return inventory;
}

/**
 * Read one exact backup through an issued inventory. The caller supplies the
 * path recorded in managed state; paths outside the inventoried directory, or
 * paths not present in the receipt, are rejected before any file is opened.
 */
export async function readInventoriedPickerMuxBackup({
  inventory,
  backupPath,
} = {}) {
  if (!issuedBackupInventories.has(inventory)) {
    throw new TypeError(
      "A PickerMux backup inventory issued by this module is required",
    );
  }
  if (typeof backupPath !== "string" || !backupPath.trim()) {
    throw new TypeError("backupPath must be a non-empty path");
  }
  const target = path.resolve(backupPath);
  if (
    target !== backupPath ||
    path.dirname(target) !== inventory.directory
  ) {
    throw new Error(
      "PickerMux managed state references a backup outside the issued backup inventory",
    );
  }
  const entry = inventory.backups.find(
    (candidate) => candidate.path === target,
  );
  if (!entry) {
    throw new Error(
      "PickerMux managed state references a backup absent from the issued backup inventory",
    );
  }
  const captured = await readExactRegularFile(target, entry.snapshot);
  if (captured.sha256 !== entry.sha256) {
    throw new Error(
      "PickerMux managed backup hash changed after inventory",
    );
  }
  return Object.freeze({
    path: target,
    contents: Buffer.from(captured.contents),
    sha256: captured.sha256,
    snapshot: captured.snapshot,
  });
}

function stagedBackupReader(inventory, quarantinePath) {
  return async (backupPath) => {
    if (typeof backupPath !== "string" || !backupPath.trim()) {
      throw new TypeError("backupPath must be a non-empty path");
    }
    const original = path.resolve(backupPath);
    if (
      original !== backupPath ||
      path.dirname(original) !== inventory.directory
    ) {
      throw new Error(
        "PickerMux managed state references a backup outside the issued backup inventory",
      );
    }
    const entry = inventory.backups.find(
      (candidate) => candidate.path === original,
    );
    if (!entry) {
      throw new Error(
        "PickerMux managed state references a backup absent from the issued backup inventory",
      );
    }
    const stagedPath = path.join(quarantinePath, entry.name);
    const captured = await readExactRegularFile(stagedPath, entry.snapshot);
    if (captured.sha256 !== entry.sha256) {
      throw new Error(
        "PickerMux managed backup hash changed after quarantine staging",
      );
    }
    return Object.freeze({
      path: original,
      contents: Buffer.from(captured.contents),
      sha256: captured.sha256,
      snapshot: captured.snapshot,
    });
  };
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
    const initialPathStats = await lstat(target);
    if (
      initialPathStats.isSymbolicLink() ||
      !initialPathStats.isFile() ||
      !sameStableFileIdentity(expected.snapshot, snapshot(initialPathStats))
    ) {
      throw new Error(
        "PickerMux backup ownership state changed during cleanup",
      );
    }
    assertSingleLink(initialPathStats, target);
    assertCurrentUserOwner(initialPathStats, target);
    const initialSnapshot = snapshot(initialPathStats);

    handle = await open(target, BACKUP_READ_FLAGS);
    const stats = await handle.stat();
    const pathStats = await lstat(target);
    if (
      !stats.isFile() ||
      pathStats.isSymbolicLink() ||
      !pathStats.isFile() ||
      stats.dev !== pathStats.dev ||
      stats.ino !== pathStats.ino ||
      stats.nlink !== 1 ||
      pathStats.nlink !== 1 ||
      !sameSnapshot(initialSnapshot, snapshot(stats)) ||
      !sameSnapshot(initialSnapshot, snapshot(pathStats)) ||
      !sameStableFileIdentity(expected.snapshot, snapshot(stats)) ||
      !sameStableFileIdentity(expected.snapshot, snapshot(pathStats))
    ) {
      throw new Error(
        "PickerMux backup ownership state changed during cleanup",
      );
    }
    assertCurrentUserOwner(stats, target);
    assertCurrentUserOwner(pathStats, target);
    const contents = await handle.readFile();
    const confirmed = await handle.stat();
    const confirmedPath = await lstat(target);
    if (
      !sameStableFileIdentity(expected.snapshot, snapshot(confirmed)) ||
      !sameStableFileIdentity(expected.snapshot, snapshot(confirmedPath)) ||
      sha256(contents) !== expected.sha256
    ) {
      throw new Error(
        "PickerMux backup ownership state changed during cleanup",
      );
    }
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
      next,
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
  inventory,
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
  const removalInventory = inventory ??
    await inventoryPickerMuxBackups(normalized);
  if (!issuedBackupInventories.has(removalInventory)) {
    throw new TypeError("A PickerMux backup inventory issued by this module is required");
  }
  if (
    removalInventory.directory !== normalized.backupDirectory ||
    removalInventory.configPath !== normalized.configPath
  ) {
    throw new Error("PickerMux backup inventory does not match purge paths");
  }
  await revalidatePickerMuxBackupInventory(removalInventory);
  if (!removalInventory.exists) {
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
    assertSameInventory(removalInventory, staged);
    await beforeCommit(Object.freeze({
      readBackup: stagedBackupReader(
        removalInventory,
        quarantinePath,
      ),
    }));
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
      removalInventory,
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
    backups: Object.freeze(removalInventory.backups.map(({ name }) => name)),
    cleanupPendingPath,
  });
}
