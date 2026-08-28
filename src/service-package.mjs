import { randomBytes } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function resolveManagedPath(target, label) {
  if (typeof target !== "string" || !target.trim()) {
    throw new TypeError(`${label} must be a non-empty path`);
  }
  const resolved = path.resolve(target);
  if (resolved === path.parse(resolved).root) {
    throw new Error(`${label} must not be a filesystem root`);
  }
  return resolved;
}

function validatePreviousPackagePath(serviceDirectory, previousPath) {
  const destination = resolveManagedPath(serviceDirectory, "Service directory");
  const previous = resolveManagedPath(previousPath, "Previous service package");
  if (path.dirname(previous) !== path.dirname(destination)) {
    throw new Error("Previous service package must be a direct sibling of the active runtime");
  }
  const expectedName = new RegExp(
    `^${path.basename(destination).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\.previous-[1-9]\\d*-[0-9a-f]{8}$`,
    "u",
  );
  if (!expectedName.test(path.basename(previous))) {
    throw new Error("Previous service package does not have a managed runtime backup name");
  }
  return { destination, previous };
}

async function writePrivateAtomic(destination, text) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle;
  let temporaryCreated = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
  } catch (error) {
    const cleanupFailures = [];
    if (handle) {
      await handle.close().catch((cleanupError) => {
        cleanupFailures.push(cleanupError);
      });
    }
    if (temporaryCreated) {
      await unlink(temporary).catch((cleanupError) => {
        if (cleanupError?.code !== "ENOENT") cleanupFailures.push(cleanupError);
      });
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        `Private atomic write failed and temporary cleanup was incomplete: ${temporary}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function readOptionalPrivateFile(filePath) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function restorePrivateFile(filePath, contents) {
  if (contents === null) {
    await unlink(filePath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    return null;
  }
  if (!Buffer.isBuffer(contents) && typeof contents !== "string") {
    throw new TypeError("Private file snapshot must be a Buffer, string, or null");
  }
  await writePrivateAtomic(filePath, contents);
  return path.resolve(filePath);
}

export async function writeServiceConfig(serviceConfigPath, config) {
  await writePrivateAtomic(serviceConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  return path.resolve(serviceConfigPath);
}

/**
 * Copy the dependency-free runtime outside Documents so a login LaunchAgent
 * is not blocked by macOS Files & Folders privacy controls. Existing versions
 * are retained as an exact previous directory instead of being deleted.
 */
export async function stageServicePackage({ sourceRoot, installDirectory, config }) {
  const source = path.resolve(sourceRoot);
  const destination = path.join(path.resolve(installDirectory), "runtime-app");
  const staging = path.join(
    path.resolve(installDirectory),
    `.runtime-app.${process.pid}.${randomBytes(8).toString("hex")}.staging`,
  );
  const serviceConfigPath = path.join(path.resolve(installDirectory), "service-config.json");
  const previousServiceConfig = await readOptionalPrivateFile(serviceConfigPath);
  await mkdir(path.resolve(installDirectory), { recursive: true, mode: 0o700 });
  let previousPath;
  let destinationPromoted = false;
  try {
    await mkdir(staging, { recursive: false, mode: 0o700 });
    await cp(path.join(source, "bin"), path.join(staging, "bin"), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    await cp(path.join(source, "src"), path.join(staging, "src"), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    if (await exists(destination)) {
      previousPath = `${destination}.previous-${Date.now()}-${randomBytes(4).toString("hex")}`;
      await rename(destination, previousPath);
    }
    await rename(staging, destination);
    destinationPromoted = true;
    await writeServiceConfig(serviceConfigPath, config);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (destinationPromoted) {
      await rm(destination, { recursive: true, force: true }).catch(() => {});
    }
    if (previousPath) await rename(previousPath, destination).catch(() => {});
    await restorePrivateFile(serviceConfigPath, previousServiceConfig).catch(() => {});
    throw error;
  }
  return {
    serviceDirectory: destination,
    serviceConfigPath,
    binPath: path.join(destination, "bin", "lmstudio-picker.mjs"),
    previousPath,
    previousServiceConfig,
  };
}


export async function restoreServicePackage({
  serviceDirectory,
  previousPath,
  serviceConfigPath,
  previousServiceConfig,
}) {
  const destination = path.resolve(serviceDirectory);
  await rm(destination, { recursive: true, force: true });
  if (previousPath) {
    if (!(await exists(previousPath))) {
      throw new Error(`Previous service package is missing: ${previousPath}`);
    }
    await rename(previousPath, destination);
  }
  await restorePrivateFile(serviceConfigPath, previousServiceConfig);
  return { restoredPreviousPackage: Boolean(previousPath) };
}

/**
 * Commit a successful staged package update. The previous package is removed
 * only through this explicit success-path call and only when it is a managed,
 * direct sibling of the active runtime. This prevents a corrupted rollback
 * path from turning finalization into an arbitrary recursive delete.
 */
export async function finalizeServicePackage({ serviceDirectory, previousPath }) {
  if (previousPath === undefined || previousPath === null) {
    return { removedPreviousPackage: false };
  }
  const { destination, previous } = validatePreviousPackagePath(
    serviceDirectory,
    previousPath,
  );
  const active = await lstat(destination).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`Active service package is missing: ${destination}`);
    }
    throw error;
  });
  if (!active.isDirectory() || active.isSymbolicLink()) {
    throw new Error(`Active service package is not a managed directory: ${destination}`);
  }
  const previousStats = await lstat(previous).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (previousStats === null) {
    return { removedPreviousPackage: false };
  }
  if (!previousStats.isDirectory() || previousStats.isSymbolicLink()) {
    throw new Error(`Previous service package is not a managed directory: ${previous}`);
  }
  await rm(previous, { recursive: true, force: false });
  return { removedPreviousPackage: true };
}

/**
 * Remove only the paths supplied by the caller as bridge-owned artifacts.
 * Backups, project files and Keychain entries are deliberately outside this
 * helper's scope. Missing paths are ignored so uninstall can be repeated.
 */
export async function cleanupManagedArtifacts({
  managedFiles = [],
  runtimeDirectories = [],
} = {}) {
  if (!Array.isArray(managedFiles) || !Array.isArray(runtimeDirectories)) {
    throw new TypeError("Managed files and runtime directories must be arrays");
  }
  const removedFiles = [];
  const removedRuntimeDirectories = [];

  for (const target of new Set(managedFiles.map((entry) => resolveManagedPath(entry, "Managed file")))) {
    const stats = await lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (stats === null) continue;
    if (stats.isDirectory()) {
      throw new Error(`Managed file path is a directory: ${target}`);
    }
    await unlink(target);
    removedFiles.push(target);
  }

  for (const target of new Set(
    runtimeDirectories.map((entry) => resolveManagedPath(entry, "Runtime directory")),
  )) {
    const stats = await lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (stats === null) continue;
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Runtime path is not a managed directory: ${target}`);
    }
    await rm(target, { recursive: true, force: false });
    removedRuntimeDirectories.push(target);
  }

  return { removedFiles, removedRuntimeDirectories };
}
