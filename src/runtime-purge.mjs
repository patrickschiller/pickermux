import { createHash, randomBytes } from "node:crypto";
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

const SERVICE_PACKAGE_ENTRIES = Object.freeze([
  "bin",
  "lmstudio-picker.config.json",
  "package.json",
  "src",
]);
const MAX_SERVICE_PACKAGE_ENTRIES = 2_048;
const MAX_SERVICE_PACKAGE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SERVICE_PACKAGE_TOTAL_BYTES = 64 * 1024 * 1024;
const READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const issuedInventories = new WeakSet();

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
    throw new Error(
      `Refusing service package path not owned by the current user: ${target}`,
    );
  }
}

function assertPrivateDirectory(stats, target, label) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${target}`);
  }
  assertOwned(stats, target);
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are not private: ${target}`);
  }
}

function validateRoots(serviceDirectory, sourceRoot) {
  if (typeof serviceDirectory !== "string" || !serviceDirectory.trim()) {
    throw new TypeError("serviceDirectory must be a non-empty path");
  }
  if (typeof sourceRoot !== "string" || !sourceRoot.trim()) {
    throw new TypeError("sourceRoot must be a non-empty path");
  }
  const runtime = path.resolve(serviceDirectory);
  const source = path.resolve(sourceRoot);
  if (
    runtime === path.parse(runtime).root ||
    path.basename(runtime) !== "runtime-app" ||
    path.basename(path.dirname(runtime)) !== "model-bridge"
  ) {
    throw new Error(
      "Service package must be the exact runtime-app inside model-bridge",
    );
  }
  if (source === path.parse(source).root) {
    throw new Error("Service package sourceRoot must not be a filesystem root");
  }
  return { runtime, source };
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

function sameStableDirectoryIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode
  );
}

async function inspectManagedParent(serviceDirectory) {
  const parent = path.dirname(serviceDirectory);
  const stats = await lstatOptional(parent);
  if (stats === null) return null;
  assertPrivateDirectory(
    stats,
    parent,
    "Managed service package parent",
  );
  return snapshot(stats);
}

function assertParentSnapshotMatches(
  expected,
  current,
  { stableIdentityOnly = false } = {},
) {
  const matches = expected === null
    ? current === null
    : current !== null && (stableIdentityOnly
      ? sameStableDirectoryIdentity(expected, current)
      : sameSnapshot(expected, current));
  if (!matches) {
    throw new Error("Managed service package parent changed after inventory");
  }
}

async function readRegularFile(target, initialStats) {
  if (initialStats.size > MAX_SERVICE_PACKAGE_FILE_BYTES) {
    throw new Error(`Service package file exceeds the size limit: ${target}`);
  }
  let handle;
  try {
    handle = await open(target, READ_FLAGS);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      !sameSnapshot(snapshot(initialStats), snapshot(opened))
    ) {
      throw new Error(`Service package file changed while opening: ${target}`);
    }
    const contents = await handle.readFile();
    const confirmed = await handle.stat();
    if (
      contents.length > MAX_SERVICE_PACKAGE_FILE_BYTES ||
      !sameSnapshot(snapshot(opened), snapshot(confirmed))
    ) {
      throw new Error(`Service package file changed while reading: ${target}`);
    }
    return contents;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function collectTree(
  root,
  { exactRootEntries = false, requirePrivateRoot = false } = {},
) {
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Service package root must be a real directory: ${root}`);
  }
  assertOwned(rootStats, root);
  if (requirePrivateRoot && (rootStats.mode & 0o077) !== 0) {
    throw new Error(`Managed service package root permissions are not private: ${root}`);
  }
  const entries = [];
  let totalBytes = 0;

  async function visit(directory, relativeDirectory = "") {
    const names = (await readdir(directory)).sort();
    if (relativeDirectory === "" && exactRootEntries) {
      if (
        names.length !== SERVICE_PACKAGE_ENTRIES.length ||
        names.some((name, index) => name !== SERVICE_PACKAGE_ENTRIES[index])
      ) {
        throw new Error("Managed service package root contains unexpected entries");
      }
    }
    for (const name of names) {
      if (entries.length >= MAX_SERVICE_PACKAGE_ENTRIES) {
        throw new Error("Service package exceeds the entry limit");
      }
      const target = path.join(directory, name);
      const relativePath = relativeDirectory
        ? path.posix.join(relativeDirectory, name)
        : name;
      const stats = await lstat(target);
      if (stats.isSymbolicLink()) {
        throw new Error(`Service package contains a symbolic link: ${relativePath}`);
      }
      assertOwned(stats, target);
      if (stats.isDirectory()) {
        entries.push(Object.freeze({
          path: relativePath,
          type: "directory",
          snapshot: snapshot(stats),
        }));
        await visit(target, relativePath);
      } else if (stats.isFile()) {
        const contents = await readRegularFile(target, stats);
        totalBytes += contents.length;
        if (totalBytes > MAX_SERVICE_PACKAGE_TOTAL_BYTES) {
          throw new Error("Service package exceeds the total size limit");
        }
        entries.push(Object.freeze({
          path: relativePath,
          type: "file",
          sha256: createHash("sha256").update(contents).digest("hex"),
          snapshot: snapshot(stats),
        }));
      } else {
        throw new Error(
          `Service package contains an unsupported file type: ${relativePath}`,
        );
      }
    }
  }

  await visit(root);
  const confirmedRoot = await lstat(root);
  if (!sameSnapshot(snapshot(rootStats), snapshot(confirmedRoot))) {
    throw new Error("Service package root changed during inventory");
  }
  return Object.freeze({
    rootSnapshot: snapshot(rootStats),
    entries: Object.freeze(entries),
  });
}

async function collectSourceTree(sourceRoot) {
  const entries = [];
  for (const name of SERVICE_PACKAGE_ENTRIES) {
    const target = path.join(sourceRoot, name);
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      throw new Error(`Service package source contains a symbolic link: ${name}`);
    }
    assertOwned(stats, target);
    if (stats.isDirectory()) {
      entries.push(Object.freeze({
        path: name,
        type: "directory",
        snapshot: snapshot(stats),
      }));
      const nested = await collectTree(target);
      for (const entry of nested.entries) {
        entries.push(Object.freeze({
          ...entry,
          path: path.posix.join(name, entry.path),
        }));
      }
    } else if (stats.isFile()) {
      const contents = await readRegularFile(target, stats);
      entries.push(Object.freeze({
        path: name,
        type: "file",
        sha256: createHash("sha256").update(contents).digest("hex"),
        snapshot: snapshot(stats),
      }));
    } else {
      throw new Error(`Service package source has an unsupported type: ${name}`);
    }
  }
  return Object.freeze(entries);
}

function assertPackageMatchesSource(sourceEntries, runtimeEntries) {
  if (sourceEntries.length !== runtimeEntries.length) {
    throw new Error("Managed service package path set differs from its source");
  }
  for (let index = 0; index < sourceEntries.length; index += 1) {
    const source = sourceEntries[index];
    const runtime = runtimeEntries[index];
    if (source.path !== runtime.path || source.type !== runtime.type) {
      throw new Error("Managed service package path set differs from its source");
    }
    if (
      source.type === "file" &&
      (source.sha256 !== runtime.sha256 ||
        source.snapshot.mode !== runtime.snapshot.mode)
    ) {
      throw new Error(
        `Managed service package file differs from its source: ${source.path}`,
      );
    }
  }
}

function assertRuntimeSnapshotMatches(
  previous,
  current,
  { rootIdentityOnly = false } = {},
) {
  const rootMatches = rootIdentityOnly
    ? previous.rootSnapshot.dev === current.rootSnapshot.dev &&
      previous.rootSnapshot.ino === current.rootSnapshot.ino &&
      previous.rootSnapshot.mode === current.rootSnapshot.mode
    : sameSnapshot(previous.rootSnapshot, current.rootSnapshot);
  if (!rootMatches || previous.entries.length !== current.entries.length) {
    throw new Error("Managed service package changed after inventory");
  }
  for (let index = 0; index < previous.entries.length; index += 1) {
    const before = previous.entries[index];
    const after = current.entries[index];
    if (
      before.path !== after.path ||
      before.type !== after.type ||
      before.sha256 !== after.sha256 ||
      !sameSnapshot(before.snapshot, after.snapshot)
    ) {
      throw new Error("Managed service package changed after inventory");
    }
  }
}

/**
 * Bind one installed runtime-app byte-for-byte to a validated PickerMux
 * distribution before any uninstall mutation occurs.
 */
export async function inventoryManagedServicePackage({
  serviceDirectory,
  sourceRoot,
} = {}) {
  const roots = validateRoots(serviceDirectory, sourceRoot);
  const parentSnapshot = await inspectManagedParent(roots.runtime);
  const runtimeStats = await lstatOptional(roots.runtime);
  if (runtimeStats === null) {
    const confirmedParent = await inspectManagedParent(roots.runtime);
    assertParentSnapshotMatches(parentSnapshot, confirmedParent);
    const inventory = Object.freeze({
      exists: false,
      serviceDirectory: roots.runtime,
      sourceRoot: roots.source,
      parentSnapshot,
      runtime: null,
    });
    issuedInventories.add(inventory);
    return inventory;
  }
  if (parentSnapshot === null) {
    throw new Error("Managed service package parent is missing");
  }
  const sourceEntries = await collectSourceTree(roots.source);
  const runtime = await collectTree(roots.runtime, {
    exactRootEntries: true,
    requirePrivateRoot: true,
  });
  assertPackageMatchesSource(sourceEntries, runtime.entries);
  const confirmedParent = await inspectManagedParent(roots.runtime);
  assertParentSnapshotMatches(parentSnapshot, confirmedParent);
  const inventory = Object.freeze({
    exists: true,
    serviceDirectory: roots.runtime,
    sourceRoot: roots.source,
    parentSnapshot,
    runtime,
  });
  issuedInventories.add(inventory);
  return inventory;
}

function assertIssuedInventory(inventory) {
  if (!issuedInventories.has(inventory)) {
    throw new TypeError("A service package inventory issued by this module is required");
  }
}

/**
 * Revalidate one issued inventory without changing any filesystem state.
 */
export async function revalidateManagedServicePackageInventory(inventory) {
  assertIssuedInventory(inventory);
  const parentBefore = await inspectManagedParent(inventory.serviceDirectory);
  assertParentSnapshotMatches(inventory.parentSnapshot, parentBefore);
  const runtimeStats = await lstatOptional(inventory.serviceDirectory);
  if (!inventory.exists) {
    if (runtimeStats !== null) {
      throw new Error("Managed service package appeared after inventory");
    }
  } else {
    if (runtimeStats === null) {
      throw new Error("Managed service package disappeared after inventory");
    }
    const current = await collectTree(inventory.serviceDirectory, {
      exactRootEntries: true,
      requirePrivateRoot: true,
    });
    assertRuntimeSnapshotMatches(inventory.runtime, current);
  }
  const parentAfter = await inspectManagedParent(inventory.serviceDirectory);
  assertParentSnapshotMatches(inventory.parentSnapshot, parentAfter);
  return inventory;
}

async function assertParentStableAfterRename(inventory) {
  const current = await inspectManagedParent(inventory.serviceDirectory);
  assertParentSnapshotMatches(inventory.parentSnapshot, current, {
    stableIdentityOnly: true,
  });
}

async function assertOriginalPathAbsent(serviceDirectory) {
  if (await lstatOptional(serviceDirectory)) {
    throw new Error("Service package path was recreated during cleanup");
  }
}

async function rollbackQuarantine(
  quarantinePath,
  serviceDirectory,
  renameImpl,
  inventory,
) {
  await assertParentStableAfterRename(inventory);
  await assertOriginalPathAbsent(serviceDirectory);
  const staged = await collectTree(quarantinePath, {
    exactRootEntries: true,
    requirePrivateRoot: true,
  }).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error("Service package quarantine is missing during rollback", {
        cause: error,
      });
    }
    throw error;
  });
  assertRuntimeSnapshotMatches(inventory.runtime, staged, {
    rootIdentityOnly: true,
  });
  await assertOriginalPathAbsent(serviceDirectory);
  await assertParentStableAfterRename(inventory);
  await renameImpl(quarantinePath, serviceDirectory);
  const restored = await collectTree(serviceDirectory, {
    exactRootEntries: true,
    requirePrivateRoot: true,
  });
  assertRuntimeSnapshotMatches(inventory.runtime, restored, {
    rootIdentityOnly: true,
  });
  const parent = await inspectManagedParent(serviceDirectory);
  assertParentSnapshotMatches(inventory.parentSnapshot, parent, {
    stableIdentityOnly: true,
  });
}

/**
 * Detach and revalidate the issued inventory, then remove only its exact files
 * and empty directories. No recursive deletion is used.
 */
export async function removeInventoriedServicePackage({
  inventory,
  renameImpl = rename,
  unlinkImpl = unlink,
  rmdirImpl = rmdir,
} = {}) {
  assertIssuedInventory(inventory);
  if (
    typeof renameImpl !== "function" ||
    typeof unlinkImpl !== "function" ||
    typeof rmdirImpl !== "function"
  ) {
    throw new TypeError("Service package cleanup dependencies must be functions");
  }
  await revalidateManagedServicePackageInventory(inventory);
  if (!inventory.exists) {
    return Object.freeze({ changed: false, cleanupPendingPath: null });
  }

  const quarantinePath = path.join(
    path.dirname(inventory.serviceDirectory),
    `.runtime-app.purge.${process.pid}.${randomBytes(8).toString("hex")}.staging`,
  );
  if (await lstatOptional(quarantinePath)) {
    throw new Error("Service package purge quarantine already exists");
  }
  await renameImpl(inventory.serviceDirectory, quarantinePath);
  try {
    await assertOriginalPathAbsent(inventory.serviceDirectory);
    await assertParentStableAfterRename(inventory);
    const staged = await collectTree(quarantinePath, {
      exactRootEntries: true,
      requirePrivateRoot: true,
    });
    assertRuntimeSnapshotMatches(inventory.runtime, staged, {
      rootIdentityOnly: true,
    });
    await assertOriginalPathAbsent(inventory.serviceDirectory);
    await assertParentStableAfterRename(inventory);
  } catch (error) {
    try {
      await rollbackQuarantine(
        quarantinePath,
        inventory.serviceDirectory,
        renameImpl,
        inventory,
      );
    } catch (rollbackError) {
      const combined = new Error(
        "Service package purge validation failed and rollback was incomplete",
        { cause: new AggregateError([error, rollbackError]) },
      );
      combined.cleanupPendingPath = quarantinePath;
      throw combined;
    }
    throw error;
  }

  try {
    const files = inventory.runtime.entries
      .filter((entry) => entry.type === "file")
      .sort((left, right) => right.path.localeCompare(left.path));
    for (const entry of files) {
      const target = path.join(quarantinePath, entry.path);
      const stats = await lstat(target);
      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        !sameSnapshot(entry.snapshot, snapshot(stats))
      ) {
        throw new Error(`Service package file changed before removal: ${entry.path}`);
      }
      const contents = await readRegularFile(target, stats);
      const digest = createHash("sha256").update(contents).digest("hex");
      if (digest !== entry.sha256) {
        throw new Error(`Service package file changed before removal: ${entry.path}`);
      }
      await unlinkImpl(target);
    }

    const directories = inventory.runtime.entries
      .filter((entry) => entry.type === "directory")
      .sort((left, right) => {
        const depth = right.path.split("/").length - left.path.split("/").length;
        return depth || right.path.localeCompare(left.path);
      });
    for (const entry of directories) {
      const target = path.join(quarantinePath, entry.path);
      const stats = await lstat(target);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(
          `Service package directory changed before removal: ${entry.path}`,
        );
      }
      assertOwned(stats, target);
      if (stats.dev !== entry.snapshot.dev || stats.ino !== entry.snapshot.ino) {
        throw new Error(
          `Service package directory identity changed before removal: ${entry.path}`,
        );
      }
      if ((await readdir(target)).length !== 0) {
        throw new Error(
          `Service package directory gained entries during removal: ${entry.path}`,
        );
      }
      await rmdirImpl(target);
    }
    if ((await readdir(quarantinePath)).length !== 0) {
      throw new Error("Service package root gained entries during removal");
    }
    await assertOriginalPathAbsent(inventory.serviceDirectory);
    await assertParentStableAfterRename(inventory);
    const rootStats = await lstat(quarantinePath);
    if (
      !rootStats.isDirectory() ||
      rootStats.isSymbolicLink() ||
      rootStats.dev !== inventory.runtime.rootSnapshot.dev ||
      rootStats.ino !== inventory.runtime.rootSnapshot.ino
    ) {
      throw new Error("Service package root changed during removal");
    }
    await rmdirImpl(quarantinePath);
  } catch (error) {
    const combined = new Error(
      "Service package cleanup stopped with a private quarantine pending",
      { cause: error },
    );
    combined.cleanupPendingPath = quarantinePath;
    throw combined;
  }
  return Object.freeze({ changed: true, cleanupPendingPath: null });
}
