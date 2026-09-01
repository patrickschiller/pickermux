import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

const ACCOUNT_CACHE_NAME = "models_cache.json";
const ACCOUNT_CACHE_READ_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function snapshot(stats) {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    uid: stats.uid,
    mode: stats.mode,
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

function assertCurrentUserOwner(stats, target) {
  const uid = currentUid();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`Codex account model cache is not owned by the current user: ${target}`);
  }
}

function assertRealAccountCacheFile(stats, target) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error(
      `Codex account model cache must be a regular file with one filesystem link: ${target}`,
    );
  }
  assertCurrentUserOwner(stats, target);
}

function assertRealCacheDirectory(stats, directory) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(
      `Codex account model cache parent must be a real directory: ${directory}`,
    );
  }
  assertCurrentUserOwner(stats, directory);
  if ((stats.mode & 0o022) !== 0) {
    throw new Error(
      `Codex account model cache parent permissions are unsafe: ${directory}`,
    );
  }
}

/**
 * Read only the exact account-cache inode. Symlinks and hardlinks are rejected
 * before reading so this path can never be redirected to native auth.json.
 */
export async function readCodexAccountCacheFile(target, encoding = undefined) {
  if (
    typeof target !== "string" ||
    !path.isAbsolute(target) ||
    path.basename(target) !== ACCOUNT_CACHE_NAME
  ) {
    throw new Error(`Codex account model cache must use ${ACCOUNT_CACHE_NAME}`);
  }
  const directory = path.dirname(target);
  const directoryStats = await lstat(directory);
  assertRealCacheDirectory(directoryStats, directory);

  let handle;
  try {
    handle = await open(target, ACCOUNT_CACHE_READ_FLAGS);
    const [opened, pathStats] = await Promise.all([
      handle.stat(),
      lstat(target),
    ]);
    assertRealAccountCacheFile(opened, target);
    assertRealAccountCacheFile(pathStats, target);
    if (!sameSnapshot(snapshot(opened), snapshot(pathStats))) {
      throw new Error("Codex account model cache changed while it was opened");
    }
    const initial = snapshot(opened);
    const contents = await handle.readFile(encoding);
    const [confirmed, confirmedPath, confirmedDirectory] = await Promise.all([
      handle.stat(),
      lstat(target),
      lstat(directory),
    ]);
    assertRealAccountCacheFile(confirmed, target);
    assertRealAccountCacheFile(confirmedPath, target);
    assertRealCacheDirectory(confirmedDirectory, directory);
    if (
      !sameSnapshot(initial, snapshot(confirmed)) ||
      !sameSnapshot(initial, snapshot(confirmedPath)) ||
      !sameSnapshot(snapshot(directoryStats), snapshot(confirmedDirectory))
    ) {
      throw new Error("Codex account model cache changed while it was read");
    }
    return contents;
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error("Codex account model cache must not be a symbolic link", {
        cause: error,
      });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}
