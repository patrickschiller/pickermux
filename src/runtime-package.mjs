import * as fileSystem from "node:fs/promises";
import path from "node:path";

export const MLX_RUNTIME_FILES = Object.freeze([
  "kolibri.py",
  "manage.py",
  "model_store.py",
  "server.py",
]);

export function assertMlxRuntimeDirectoryEntries(relative, names) {
  const expected = relative === "runtime" ? ["mlx"] : relative === "runtime/mlx" ? MLX_RUNTIME_FILES : null;
  if (expected && (names.length !== expected.length ||
      [...names].sort().some((name, index) => name !== expected[index]))) {
    throw new Error("MLX runtime must contain exactly the reviewed files and directories");
  }
}

/** Optional for earlier distributions; present runtimes are a finite owned tree. */
export async function inspectOptionalMlxRuntime(root, {
  fsImpl = fileSystem,
  ownerUid = typeof process.getuid === "function" ? process.getuid() : undefined,
} = {}) {
  const directory = path.join(path.resolve(root), "runtime");
  let initial;
  try { initial = await fsImpl.lstat(directory); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const owned = (stats) => {
    if (ownerUid !== undefined && stats.uid !== ownerUid) {
      throw new Error("MLX runtime must be owned by the current user");
    }
  };
  const realDirectory = (stats) => {
    owned(stats);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("MLX runtime must contain only real directories");
    }
  };
  realDirectory(initial);
  assertMlxRuntimeDirectoryEntries("runtime", await fsImpl.readdir(directory));
  const mlx = path.join(directory, "mlx");
  realDirectory(await fsImpl.lstat(mlx));
  assertMlxRuntimeDirectoryEntries("runtime/mlx", await fsImpl.readdir(mlx));
  for (const name of MLX_RUNTIME_FILES) {
    const stats = await fsImpl.lstat(path.join(mlx, name));
    owned(stats);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > 4 * 1024 * 1024) {
      throw new Error("MLX runtime files must be bounded regular files with one filesystem link");
    }
  }
  return MLX_RUNTIME_FILES.map((name) => `runtime/mlx/${name}`);
}
