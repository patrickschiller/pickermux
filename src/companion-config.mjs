import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { validateBridgeConfig } from "./bridge-config.mjs";

const MAX_SERVICE_CONFIG_BYTES = 1024 * 1024;
const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;

function failure(code = "COMPANION_CONFIG_INVALID") {
  const error = new Error("Installed PickerMux service configuration could not be verified.");
  error.code = code;
  return error;
}

function normalizedAbsolute(value) {
  return typeof value === "string" && value.length > 0 && path.isAbsolute(value) &&
    path.resolve(value) === value && !/[\u0000\r\n]/u.test(value);
}

function exactTarget(paths, kind) {
  if (!paths || !normalizedAbsolute(paths.codexHome) || !normalizedAbsolute(paths.installDirectory) ||
    paths.codexHome === path.parse(paths.codexHome).root ||
    paths.installDirectory !== path.join(paths.codexHome, "model-bridge")) throw failure();
  const names = {
    "service-config": ["serviceConfigPath", "service-config.json"],
    compatibility: ["compatibilityPath", "compatibility.json"],
  };
  if (!Object.hasOwn(names, kind)) throw failure();
  const [key, filename] = names[kind];
  if (!normalizedAbsolute(paths[key]) || paths[key] !== path.join(paths.installDirectory, filename)) throw failure();
  return paths[key];
}

function ownedByUser(stats) {
  return typeof process.getuid !== "function" || stats.uid === process.getuid();
}

function privateOwned(stats) {
  return ownedByUser(stats) && (stats.mode & 0o077) === 0;
}

function assertDirectory(stats, nativeCodexHome = false) {
  // Native Codex owns its home permissions; only managed state must be private.
  const disallowedPermissions = nativeCodexHome ? 0o022 : 0o077;
  if (!stats.isDirectory() || stats.isSymbolicLink() || !ownedByUser(stats) ||
    (stats.mode & disallowedPermissions) !== 0) throw failure();
}

function assertFile(stats) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || !privateOwned(stats) ||
    !Number.isSafeInteger(stats.size) || stats.size < 0 || stats.size > MAX_SERVICE_CONFIG_BYTES) throw failure();
}

function sameIdentity(left, right) {
  return ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"].every((key) => left[key] === right[key]);
}

/** Read only finite private artifact names; aliases cannot reach native auth. */
export async function readCompanionPrivateFile({ paths, kind, allowMissing = false } = {}) {
  const target = exactTarget(paths, kind);
  if (typeof allowMissing !== "boolean" || !Number.isInteger(fsConstants.O_NOFOLLOW)) throw failure();
  let handle;
  let fileObserved = false;
  try {
    const directories = [paths.codexHome, paths.installDirectory];
    const directoryIdentities = [];
    for (let index = 0; index < directories.length; index += 1) {
      const identity = await lstat(directories[index]);
      assertDirectory(identity, index === 0);
      directoryIdentities.push(identity);
    }
    const initial = await lstat(target);
    fileObserved = true;
    assertFile(initial);
    handle = await open(target, READ_FLAGS);
    const opened = await handle.stat();
    const openedPath = await lstat(target);
    assertFile(opened);
    assertFile(openedPath);
    if (!sameIdentity(initial, opened) || !sameIdentity(initial, openedPath)) throw failure();
    for (let index = 0; index < directories.length; index += 1) {
      const confirmed = await lstat(directories[index]);
      assertDirectory(confirmed, index === 0);
      if (!sameIdentity(directoryIdentities[index], confirmed)) throw failure();
    }
    const chunks = [];
    let size = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(16 * 1024, MAX_SERVICE_CONFIG_BYTES + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > MAX_SERVICE_CONFIG_BYTES) throw failure();
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const final = await handle.stat();
    const finalPath = await lstat(target);
    assertFile(final);
    assertFile(finalPath);
    if (!sameIdentity(initial, final) || !sameIdentity(initial, finalPath) || size !== final.size) throw failure();
    for (let index = 0; index < directories.length; index += 1) {
      const confirmed = await lstat(directories[index]);
      assertDirectory(confirmed, index === 0);
      if (!sameIdentity(directoryIdentities[index], confirmed)) throw failure();
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (allowMissing && !fileObserved && !handle) return null;
      if (fileObserved || handle) throw failure();
      throw failure("ENOENT");
    }
    throw failure();
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function loadCompanionServiceConfig({ paths, allowMissing = false } = {}) {
  const bytes = await readCompanionPrivateFile({ paths, kind: "service-config", allowMissing });
  if (bytes === null) return null;
  try {
    return validateBridgeConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    throw failure();
  }
}
