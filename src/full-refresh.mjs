import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED,
  inspectCodexAccountCache,
} from "./account-cache.mjs";
import {
  openCodexDesktop,
  requestCodexDesktopQuit,
} from "./codex-desktop-state.mjs";

const execFile = promisify(execFileCallback);
const CHECKPOINT_SCHEMA_VERSION = 1;
const CHECKPOINT_PRODUCT = "pickermux";
const CHECKPOINT_KIND = "full-refresh";
const MAX_MANAGED_FILE_BYTES = 256 * 1024;
const MANAGED_READ_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const DEFAULT_CACHE_TIMEOUT_MS = 120_000;
const DEFAULT_CACHE_POLL_INTERVAL_MS = 500;
const LAUNCHCTL_SERVICE_NOT_FOUND = 113;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const FULL_REFRESH_LABEL_PATTERN =
  /^com\.local\.pickermux-full-refresh(?:\.[a-z0-9-]{1,64})?$/u;

export const FULL_REFRESH_PHASES = Object.freeze([
  "prepared",
  "first-quit-complete",
  "suspended",
  "native-opened",
  "cache-refreshed",
  "second-quit-complete",
  "reactivated",
  "completed",
]);

const PHASE_INDEX = new Map(
  FULL_REFRESH_PHASES.map((phase, index) => [phase, index]),
);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function requireFunction(value, label) {
  if (typeof value !== "function") {
    throw new TypeError(`${label} must be a function`);
  }
  return value;
}

function requireBoundedInteger(value, label, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be an integer of at least ${minimum}`);
  }
  return value;
}

function requireSafeAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    /[\u0000\r\n]/u.test(value)
  ) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  return value;
}

function requireContainedPath(installDirectory, target, label) {
  requireSafeAbsolutePath(installDirectory, "installDirectory");
  requireSafeAbsolutePath(target, label);
  const relative = path.relative(installDirectory, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must be below the PickerMux install directory`);
  }
  return target;
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

function assertOwned(stats, target, { allowRoot = false } = {}) {
  const uid = currentUid();
  if (
    uid !== undefined &&
    stats.uid !== uid &&
    !(allowRoot && stats.uid === 0)
  ) {
    throw new Error(`Managed full-refresh path has unsafe ownership: ${target}`);
  }
}

function assertDirectory(stats, target, { privateDirectory = false } = {}) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Managed full-refresh directory must be real: ${target}`);
  }
  assertOwned(stats, target);
  const unsafeMask = privateDirectory ? 0o077 : 0o022;
  if ((stats.mode & unsafeMask) !== 0) {
    throw new Error(`Managed full-refresh directory permissions are unsafe: ${target}`);
  }
}

function assertManagedFile(
  stats,
  target,
  { privateFile = true, allowRoot = false, requireExecutable = false } = {},
) {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Managed full-refresh path must be a regular file: ${target}`);
  }
  if (stats.nlink !== 1) {
    throw new Error(`Managed full-refresh file must have one hard link: ${target}`);
  }
  assertOwned(stats, target, { allowRoot });
  const unsafeMask = privateFile ? 0o077 : 0o022;
  if ((stats.mode & unsafeMask) !== 0) {
    throw new Error(`Managed full-refresh file permissions are unsafe: ${target}`);
  }
  if (requireExecutable && (stats.mode & 0o111) === 0) {
    throw new Error(`Managed full-refresh executable is not executable: ${target}`);
  }
}

async function lstatOptional(target, lstatImpl = lstat) {
  try {
    return await lstatImpl(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertPrivateDirectoryChain(
  installDirectory,
  destinationDirectory,
  {
    create = false,
    allowMissing = false,
    lstatImpl = lstat,
    mkdirImpl = mkdir,
    chmodImpl = chmod,
  } = {},
) {
  requireSafeAbsolutePath(installDirectory, "installDirectory");
  requireSafeAbsolutePath(destinationDirectory, "managed directory");
  const destinationRelative = path.relative(
    installDirectory,
    destinationDirectory,
  );
  if (
    destinationRelative === ".." ||
    destinationRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(destinationRelative)
  ) {
    throw new Error("Managed full-refresh directory escapes the install directory");
  }

  const rootStats = await lstatOptional(installDirectory, lstatImpl);
  if (rootStats === null) {
    if (allowMissing) return false;
    throw new Error(`PickerMux install directory is missing: ${installDirectory}`);
  }
  assertDirectory(rootStats, installDirectory, { privateDirectory: true });
  let current = installDirectory;
  const relative = path.relative(installDirectory, destinationDirectory);
  for (const component of relative ? relative.split(path.sep) : []) {
    if (!component || component === "." || component === "..") {
      throw new Error("Managed full-refresh directory has an unsafe component");
    }
    current = path.join(current, component);
    let stats = await lstatOptional(current, lstatImpl);
    if (stats === null && create) {
      await mkdirImpl(current, { mode: 0o700 });
      await chmodImpl(current, 0o700);
      stats = await lstatImpl(current);
    }
    if (stats === null) {
      if (allowMissing) return false;
      throw new Error(`Managed full-refresh directory is missing: ${current}`);
    }
    assertDirectory(stats, current, { privateDirectory: true });
  }
  return true;
}

async function readIdentityBoundFile(
  target,
  {
    allowMissing = false,
    privateFile = true,
    allowRoot = false,
    maxBytes = MAX_MANAGED_FILE_BYTES,
    lstatImpl = lstat,
    openImpl = open,
  } = {},
) {
  const initialStats = await lstatOptional(target, lstatImpl);
  if (initialStats === null && allowMissing) return null;
  if (initialStats === null) {
    throw new Error(`Managed full-refresh file is missing: ${target}`);
  }
  assertManagedFile(initialStats, target, { privateFile, allowRoot });
  if (initialStats.size > maxBytes) {
    throw new Error(`Managed full-refresh file is too large: ${target}`);
  }
  const initial = snapshot(initialStats);

  let handle;
  try {
    handle = await openImpl(target, MANAGED_READ_FLAGS);
    const [openedStats, pathStats] = await Promise.all([
      handle.stat(),
      lstatImpl(target),
    ]);
    assertManagedFile(openedStats, target, { privateFile, allowRoot });
    assertManagedFile(pathStats, target, { privateFile, allowRoot });
    if (
      !sameSnapshot(initial, snapshot(openedStats)) ||
      !sameSnapshot(initial, snapshot(pathStats))
    ) {
      throw new Error(`Managed full-refresh file changed before read: ${target}`);
    }
    const contents = await handle.readFile();
    const [confirmedStats, confirmedPathStats] = await Promise.all([
      handle.stat(),
      lstatImpl(target),
    ]);
    assertManagedFile(confirmedStats, target, { privateFile, allowRoot });
    assertManagedFile(confirmedPathStats, target, { privateFile, allowRoot });
    if (
      contents.length > maxBytes ||
      contents.length !== confirmedStats.size ||
      !sameSnapshot(initial, snapshot(confirmedStats)) ||
      !sameSnapshot(initial, snapshot(confirmedPathStats))
    ) {
      throw new Error(`Managed full-refresh file changed during read: ${target}`);
    }
    return Object.freeze({ contents, snapshot: initial });
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOENT") {
      throw new Error(`Managed full-refresh file changed before read: ${target}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writePrivateAtomic(
  installDirectory,
  destination,
  contents,
  {
    requireMissing = false,
    lstatImpl = lstat,
    mkdirImpl = mkdir,
    chmodImpl = chmod,
    openImpl = open,
    renameImpl = rename,
    unlinkImpl = unlink,
    randomBytesImpl = randomBytes,
  } = {},
) {
  requireContainedPath(installDirectory, destination, "managed file path");
  const directory = path.dirname(destination);
  await assertPrivateDirectoryChain(installDirectory, directory, {
    create: true,
    lstatImpl,
    mkdirImpl,
    chmodImpl,
  });
  const previousStats = await lstatOptional(destination, lstatImpl);
  if (previousStats !== null) {
    assertManagedFile(previousStats, destination);
    if (requireMissing) {
      throw new Error(`Managed full-refresh file already exists: ${destination}`);
    }
  }
  const previous = previousStats === null ? null : snapshot(previousStats);
  const suffix = randomBytesImpl(8).toString("hex");
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${suffix}.tmp`,
  );
  let handle;
  let created = false;
  try {
    handle = await openImpl(temporary, "wx", 0o600);
    created = true;
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmodImpl(temporary, 0o600);

    const confirmedPrevious = await lstatOptional(destination, lstatImpl);
    if (
      (previous === null && confirmedPrevious !== null) ||
      (previous !== null &&
        (confirmedPrevious === null ||
          !sameSnapshot(previous, snapshot(confirmedPrevious))))
    ) {
      throw new Error(`Managed full-refresh file changed before replace: ${destination}`);
    }
    await renameImpl(temporary, destination);
    created = false;
    const published = await lstatImpl(destination);
    assertManagedFile(published, destination);
    return snapshot(published);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await unlinkImpl(temporary).catch(() => {});
    throw error;
  }
}

function parseIsoTimestamp(value, label) {
  const milliseconds = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return { value, milliseconds };
}

function normalizeBaseline(baseline) {
  if (baseline === null || typeof baseline !== "object" || Array.isArray(baseline)) {
    throw new Error("Full-refresh baseline must be an object");
  }
  const clientVersion = baseline.clientVersion ?? baseline.codexClientVersion;
  const cacheClientVersion = baseline.cacheClientVersion ?? clientVersion;
  if (
    typeof clientVersion !== "string" ||
    !VERSION_PATTERN.test(clientVersion) ||
    cacheClientVersion !== clientVersion
  ) {
    throw new Error("Full-refresh baseline must match one exact Codex client version");
  }
  const fetchedAt = baseline.fetchedAt === null
    ? null
    : parseIsoTimestamp(
        baseline.fetchedAt,
        "Full-refresh baseline fetchedAt",
      ).value;
  return Object.freeze({ clientVersion, fetchedAt });
}

function validateCheckpoint(checkpoint) {
  if (
    checkpoint === null ||
    typeof checkpoint !== "object" ||
    Array.isArray(checkpoint)
  ) {
    throw new Error("Full-refresh checkpoint must be a JSON object");
  }
  const allowedKeys = new Set([
    "schemaVersion",
    "product",
    "kind",
    "operationId",
    "phase",
    "clientVersion",
    "baselineFetchedAt",
    "refreshedCacheFetchedAt",
    "createdAt",
    "updatedAt",
  ]);
  if (Object.keys(checkpoint).some((key) => !allowedKeys.has(key))) {
    throw new Error("Full-refresh checkpoint contains unsupported or sensitive fields");
  }
  if (
    checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION ||
    checkpoint.product !== CHECKPOINT_PRODUCT ||
    checkpoint.kind !== CHECKPOINT_KIND ||
    typeof checkpoint.operationId !== "string" ||
    !OPERATION_ID_PATTERN.test(checkpoint.operationId) ||
    !PHASE_INDEX.has(checkpoint.phase) ||
    typeof checkpoint.clientVersion !== "string" ||
    !VERSION_PATTERN.test(checkpoint.clientVersion)
  ) {
    throw new Error("Full-refresh checkpoint has invalid ownership or phase metadata");
  }
  const baseline = checkpoint.baselineFetchedAt === null
    ? null
    : parseIsoTimestamp(
        checkpoint.baselineFetchedAt,
        "Full-refresh checkpoint baselineFetchedAt",
      );
  const created = parseIsoTimestamp(
    checkpoint.createdAt,
    "Full-refresh checkpoint createdAt",
  );
  const updated = parseIsoTimestamp(
    checkpoint.updatedAt,
    "Full-refresh checkpoint updatedAt",
  );
  if (updated.milliseconds < created.milliseconds) {
    throw new Error("Full-refresh checkpoint updatedAt predates createdAt");
  }
  const phaseIndex = PHASE_INDEX.get(checkpoint.phase);
  if (phaseIndex < PHASE_INDEX.get("cache-refreshed")) {
    if (checkpoint.refreshedCacheFetchedAt !== null) {
      throw new Error("Full-refresh checkpoint records a cache before validation");
    }
  } else {
    const refreshed = parseIsoTimestamp(
      checkpoint.refreshedCacheFetchedAt,
      "Full-refresh checkpoint refreshedCacheFetchedAt",
    );
    if (baseline !== null && refreshed.milliseconds <= baseline.milliseconds) {
      throw new Error("Full-refresh checkpoint cache is not newer than its baseline");
    }
  }
  return Object.freeze({ ...checkpoint });
}

function isoNow(nowImpl) {
  const observed = nowImpl();
  const date = observed instanceof Date ? observed : new Date(observed);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Full-refresh clock returned an invalid time");
  }
  return date.toISOString();
}

function createCheckpoint(baseline, { operationId, nowImpl }) {
  const createdAt = isoNow(nowImpl);
  return validateCheckpoint({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    product: CHECKPOINT_PRODUCT,
    kind: CHECKPOINT_KIND,
    operationId,
    phase: "prepared",
    clientVersion: baseline.clientVersion,
    baselineFetchedAt: baseline.fetchedAt,
    refreshedCacheFetchedAt: null,
    createdAt,
    updatedAt: createdAt,
  });
}

function advanceCheckpoint(checkpoint, phase, { refreshedAt, nowImpl }) {
  const currentIndex = PHASE_INDEX.get(checkpoint.phase);
  const nextIndex = PHASE_INDEX.get(phase);
  if (nextIndex !== currentIndex + 1) {
    throw new Error(
      `Invalid full-refresh phase transition ${checkpoint.phase} -> ${phase}`,
    );
  }
  return validateCheckpoint({
    ...checkpoint,
    phase,
    refreshedCacheFetchedAt:
      refreshedAt ?? checkpoint.refreshedCacheFetchedAt,
    updatedAt: isoNow(nowImpl),
  });
}

export async function readFullRefreshCheckpoint({
  installDirectory,
  checkpointPath,
  allowMissing = false,
  lstatImpl = lstat,
  openImpl = open,
} = {}) {
  requireContainedPath(installDirectory, checkpointPath, "checkpointPath");
  const directoryExists = await assertPrivateDirectoryChain(
    installDirectory,
    path.dirname(checkpointPath),
    { allowMissing, lstatImpl },
  );
  if (!directoryExists) return null;
  const captured = await readIdentityBoundFile(checkpointPath, {
    allowMissing,
    lstatImpl,
    openImpl,
  });
  if (captured === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(captured.contents.toString("utf8"));
  } catch (error) {
    throw new Error("Full-refresh checkpoint is invalid JSON", { cause: error });
  }
  return validateCheckpoint(parsed);
}

export async function writeFullRefreshCheckpoint({
  installDirectory,
  checkpointPath,
  checkpoint,
  ...fileOptions
} = {}) {
  const validated = validateCheckpoint(checkpoint);
  await writePrivateAtomic(
    installDirectory,
    checkpointPath,
    `${JSON.stringify(validated, null, 2)}\n`,
    fileOptions,
  );
  return validated;
}

export async function removeFullRefreshCheckpoint({
  installDirectory,
  checkpointPath,
  allowMissing = false,
  lstatImpl = lstat,
  openImpl = open,
  unlinkImpl = unlink,
} = {}) {
  requireContainedPath(installDirectory, checkpointPath, "checkpointPath");
  const directoryExists = await assertPrivateDirectoryChain(
    installDirectory,
    path.dirname(checkpointPath),
    { allowMissing, lstatImpl },
  );
  if (!directoryExists) return false;
  const captured = await readIdentityBoundFile(checkpointPath, {
    allowMissing,
    lstatImpl,
    openImpl,
  });
  if (captured === null) return false;
  let parsed;
  try {
    parsed = JSON.parse(captured.contents.toString("utf8"));
  } catch (error) {
    throw new Error("Full-refresh checkpoint is invalid JSON", { cause: error });
  }
  validateCheckpoint(parsed);
  const confirmed = await lstatImpl(checkpointPath);
  if (!sameSnapshot(captured.snapshot, snapshot(confirmed))) {
    throw new Error("Full-refresh checkpoint changed before removal");
  }
  await unlinkImpl(checkpointPath);
  return true;
}

export async function captureFullRefreshBaseline({
  codexHome,
  codexPath,
  inspectAccountCacheImpl = inspectCodexAccountCache,
} = {}) {
  requireFunction(inspectAccountCacheImpl, "inspectAccountCacheImpl");
  let inspected;
  try {
    inspected = await inspectAccountCacheImpl({ codexHome, codexPath });
  } catch (error) {
    if (
      error?.code === CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED &&
      typeof error.codexClientVersion === "string"
    ) {
      return normalizeBaseline({
        clientVersion: error.codexClientVersion,
        fetchedAt: null,
      });
    }
    throw error;
  }
  if (
    inspected?.ready !== true ||
    inspected?.status !== "ready" ||
    inspected?.source !== "codex-account-cache"
  ) {
    throw new Error("A safely validated Codex account cache baseline is required");
  }
  return normalizeBaseline(inspected);
}

/**
 * Create the durable `prepared` record before the one-shot helper is armed, or
 * return an existing validated record for an explicit resume.
 */
export async function prepareFullRefreshCheckpoint({
  installDirectory,
  checkpointPath,
  baseline,
  codexHome,
  codexPath,
  operationId = randomUUID(),
  inspectAccountCacheImpl = inspectCodexAccountCache,
  nowImpl = () => new Date(),
  readCheckpointImpl = readFullRefreshCheckpoint,
  writeCheckpointImpl = writeFullRefreshCheckpoint,
} = {}) {
  for (const [label, implementation] of Object.entries({
    inspectAccountCacheImpl,
    nowImpl,
    readCheckpointImpl,
    writeCheckpointImpl,
  })) {
    requireFunction(implementation, label);
  }
  requireContainedPath(installDirectory, checkpointPath, "checkpointPath");
  const existing = await readCheckpointImpl({
    installDirectory,
    checkpointPath,
    allowMissing: true,
  });
  if (existing !== null) {
    if (baseline !== undefined) {
      const expected = normalizeBaseline(baseline);
      if (
        expected.clientVersion !== existing.clientVersion ||
        expected.fetchedAt !== existing.baselineFetchedAt
      ) {
        throw new Error("Existing full-refresh checkpoint has a different baseline");
      }
    }
    return Object.freeze({ checkpoint: existing, resumed: true });
  }
  if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error("Full-refresh operationId is invalid");
  }
  const normalizedBaseline = baseline === undefined
    ? await captureFullRefreshBaseline({
        codexHome,
        codexPath,
        inspectAccountCacheImpl,
      })
    : normalizeBaseline(baseline);
  const checkpoint = createCheckpoint(normalizedBaseline, {
    operationId,
    nowImpl,
  });
  await writeCheckpointImpl({ installDirectory, checkpointPath, checkpoint });
  return Object.freeze({ checkpoint, resumed: false });
}

function callbackContext(checkpoint) {
  return Object.freeze({
    operationId: checkpoint.operationId,
    phase: checkpoint.phase,
    baseline: Object.freeze({
      clientVersion: checkpoint.clientVersion,
      fetchedAt: checkpoint.baselineFetchedAt,
    }),
    refreshedCacheFetchedAt: checkpoint.refreshedCacheFetchedAt,
  });
}

function validateRefreshedCache(inspected, baseline) {
  if (
    inspected?.ready !== true ||
    inspected?.status !== "ready" ||
    inspected?.source !== "codex-account-cache" ||
    inspected.codexClientVersion !== baseline.clientVersion ||
    inspected.cacheClientVersion !== baseline.clientVersion ||
    inspected.catalog === null ||
    typeof inspected.catalog !== "object" ||
    !Array.isArray(inspected.catalog.models) ||
    inspected.catalog.models.length === 0
  ) {
    return null;
  }
  const refreshed = parseIsoTimestamp(
    inspected.fetchedAt,
    "Refreshed Codex account cache fetchedAt",
  );
  if (baseline.fetchedAt === null) return refreshed.value;
  const previous = parseIsoTimestamp(
    baseline.fetchedAt,
    "Full-refresh baseline fetchedAt",
  );
  return refreshed.milliseconds > previous.milliseconds ? refreshed.value : null;
}

async function waitForRefreshedCache({
  baseline,
  codexHome,
  codexPath,
  inspectAccountCacheImpl,
  timeoutMs,
  pollIntervalMs,
  sleepImpl,
}) {
  requireBoundedInteger(timeoutMs, "cacheTimeoutMs");
  requireBoundedInteger(pollIntervalMs, "cachePollIntervalMs", { minimum: 1 });
  const maximumObservations = Math.floor(timeoutMs / pollIntervalMs) + 1;
  for (let observation = 0; observation < maximumObservations; observation += 1) {
    try {
      const inspected = await inspectAccountCacheImpl({
        codexHome,
        codexPath,
        codexClientVersion: baseline.clientVersion,
      });
      const refreshedAt = validateRefreshedCache(inspected, baseline);
      if (refreshedAt !== null) return refreshedAt;
    } catch (error) {
      if (error?.code !== CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED) throw error;
    }
    if (observation + 1 < maximumObservations) {
      await sleepImpl(Math.min(pollIntervalMs, timeoutMs));
    }
  }
  throw new Error(
    `Codex account model cache was not refreshed within ${timeoutMs} ms`,
  );
}

/**
 * Execute or resume the confirmation-neutral full-refresh state machine. The
 * caller owns user confirmation and supplies the PickerMux lifecycle callbacks.
 */
export async function runFullRefreshWorkflow({
  installDirectory,
  checkpointPath,
  baseline,
  codexHome,
  codexPath,
  operationId = randomUUID(),
  quitCodexImpl = requestCodexDesktopQuit,
  temporarySuspendImpl,
  openNativeCodexImpl = openCodexDesktop,
  inspectAccountCacheImpl = inspectCodexAccountCache,
  reactivateAndDoctorImpl,
  finalOpenImpl = openCodexDesktop,
  progressImpl = () => {},
  nowImpl = () => new Date(),
  sleepImpl = sleep,
  cacheTimeoutMs = DEFAULT_CACHE_TIMEOUT_MS,
  cachePollIntervalMs = DEFAULT_CACHE_POLL_INTERVAL_MS,
  readCheckpointImpl = readFullRefreshCheckpoint,
  writeCheckpointImpl = writeFullRefreshCheckpoint,
  removeCheckpointImpl = removeFullRefreshCheckpoint,
} = {}) {
  for (const [label, implementation] of Object.entries({
    quitCodexImpl,
    temporarySuspendImpl,
    openNativeCodexImpl,
    inspectAccountCacheImpl,
    reactivateAndDoctorImpl,
    finalOpenImpl,
    progressImpl,
    nowImpl,
    sleepImpl,
    readCheckpointImpl,
    writeCheckpointImpl,
    removeCheckpointImpl,
  })) {
    requireFunction(implementation, label);
  }
  if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error("Full-refresh operationId is invalid");
  }
  requireContainedPath(installDirectory, checkpointPath, "checkpointPath");

  let checkpoint;
  let checkpointValidated = false;
  let mutationStarted = false;
  try {
    checkpoint = await readCheckpointImpl({
      installDirectory,
      checkpointPath,
      allowMissing: true,
    });
    checkpointValidated = checkpoint !== null;
    if (checkpoint === null) {
      const normalizedBaseline = baseline === undefined
        ? await captureFullRefreshBaseline({
            codexHome,
            codexPath,
            inspectAccountCacheImpl,
          })
        : normalizeBaseline(baseline);
      checkpoint = createCheckpoint(normalizedBaseline, {
        operationId,
        nowImpl,
      });
      await writeCheckpointImpl({ installDirectory, checkpointPath, checkpoint });
      checkpointValidated = true;
    } else if (baseline !== undefined) {
      const expected = normalizeBaseline(baseline);
      if (
        expected.clientVersion !== checkpoint.clientVersion ||
        expected.fetchedAt !== checkpoint.baselineFetchedAt
      ) {
        throw new Error("Existing full-refresh checkpoint has a different baseline");
      }
    }
    mutationStarted =
      PHASE_INDEX.get(checkpoint.phase) >= PHASE_INDEX.get("suspended");

    const persistNext = async (phase, options = {}) => {
      checkpoint = advanceCheckpoint(checkpoint, phase, { ...options, nowImpl });
      await writeCheckpointImpl({ installDirectory, checkpointPath, checkpoint });
      await progressImpl(callbackContext(checkpoint));
    };

    if (checkpoint.phase === "prepared") {
      await quitCodexImpl({ stage: "before-suspend", ...callbackContext(checkpoint) });
      await persistNext("first-quit-complete");
    }
    if (checkpoint.phase === "first-quit-complete") {
      // A lifecycle callback can fail after partial work, so preserve recovery
      // state as soon as control crosses this mutation boundary.
      mutationStarted = true;
      await temporarySuspendImpl(callbackContext(checkpoint));
      await persistNext("suspended");
    }
    if (checkpoint.phase === "suspended") {
      await openNativeCodexImpl(callbackContext(checkpoint));
      await persistNext("native-opened");
    }
    if (checkpoint.phase === "native-opened") {
      const refreshedAt = await waitForRefreshedCache({
        baseline: {
          clientVersion: checkpoint.clientVersion,
          fetchedAt: checkpoint.baselineFetchedAt,
        },
        codexHome,
        codexPath,
        inspectAccountCacheImpl,
        timeoutMs: cacheTimeoutMs,
        pollIntervalMs: cachePollIntervalMs,
        sleepImpl,
      });
      await persistNext("cache-refreshed", { refreshedAt });
    }
    if (checkpoint.phase === "cache-refreshed") {
      await quitCodexImpl({ stage: "before-reactivation", ...callbackContext(checkpoint) });
      await persistNext("second-quit-complete");
    }
    if (checkpoint.phase === "second-quit-complete") {
      await reactivateAndDoctorImpl(callbackContext(checkpoint));
      await persistNext("reactivated");
    }
    if (checkpoint.phase === "reactivated") {
      await finalOpenImpl(callbackContext(checkpoint));
      await persistNext("completed");
    }
    if (checkpoint.phase !== "completed") {
      throw new Error(`Unsupported full-refresh phase: ${checkpoint.phase}`);
    }
    const result = Object.freeze({
      completed: true,
      operationId: checkpoint.operationId,
      clientVersion: checkpoint.clientVersion,
      baselineFetchedAt: checkpoint.baselineFetchedAt,
      refreshedCacheFetchedAt: checkpoint.refreshedCacheFetchedAt,
    });
    return result;
  } catch (error) {
    if (checkpointValidated && !mutationStarted) {
      try {
        await removeCheckpointImpl({
          installDirectory,
          checkpointPath,
          allowMissing: true,
        });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Full refresh failed before mutation and checkpoint cleanup also failed",
        );
      }
    }
    throw error;
  }
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderFullRefreshLaunchAgent({
  installDirectory,
  label,
  nodePath,
  workerPath,
  checkpointPath,
  launchAgentPath,
  logPath,
} = {}) {
  requireSafeAbsolutePath(nodePath, "nodePath");
  requireContainedPath(installDirectory, workerPath, "workerPath");
  requireContainedPath(installDirectory, checkpointPath, "checkpointPath");
  requireContainedPath(installDirectory, launchAgentPath, "launchAgentPath");
  requireContainedPath(installDirectory, logPath, "logPath");
  if (typeof label !== "string" || !FULL_REFRESH_LABEL_PATTERN.test(label)) {
    throw new Error("Full-refresh LaunchAgent label is invalid");
  }
  const operationDirectory = path.dirname(checkpointPath);
  if (
    path.basename(operationDirectory) !== "full-refresh" ||
    path.dirname(operationDirectory) !== installDirectory ||
    path.basename(checkpointPath) !== "full-refresh-state.json" ||
    path.dirname(launchAgentPath) !== operationDirectory ||
    path.basename(launchAgentPath) !== `${label}.plist` ||
    path.dirname(logPath) !== operationDirectory ||
    path.basename(logPath) !== "full-refresh.log"
  ) {
    throw new Error("Full-refresh artifacts must use the managed operation paths");
  }
  const argumentsXml = [
    nodePath,
    workerPath,
    "refresh",
    "--full-worker",
    "--checkpoint",
    checkpointPath,
  ]
    .map((argument) => `      <string>${xml(argument)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(installDirectory)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>LaunchOnlyOnce</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>Umask</key>
    <integer>63</integer>
    <key>StandardOutPath</key>
    <string>${xml(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(logPath)}</string>
  </dict>
</plist>
`;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function validateDistributionReceipt(receipt, installDirectory) {
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    receipt.schemaVersion !== 1 ||
    receipt.product !== "pickermux" ||
    receipt.owner !== "pickermux-cli-installer" ||
    typeof receipt.activeVersion !== "string" ||
    !VERSION_PATTERN.test(receipt.activeVersion) ||
    receipt.activeTarget !== `versions/${receipt.activeVersion}` ||
    !Array.isArray(receipt.versions)
  ) {
    throw new Error("PickerMux install receipt cannot bind a full-refresh worker");
  }
  const activeRecords = receipt.versions.filter(
    (entry) =>
      entry?.version === receipt.activeVersion &&
      entry.path === receipt.activeTarget &&
      typeof entry.sha256 === "string" &&
      SHA256_PATTERN.test(entry.sha256),
  );
  if (activeRecords.length !== 1) {
    throw new Error("PickerMux install receipt does not own one active worker");
  }
  return path.join(
    installDirectory,
    receipt.activeTarget,
    "bin",
    "pickermux.mjs",
  );
}

async function validateExecutablePath(
  executablePath,
  { allowRoot, realpathImpl = realpath, lstatImpl = lstat } = {},
) {
  requireSafeAbsolutePath(executablePath, "executable path");
  const canonical = await realpathImpl(executablePath);
  requireSafeAbsolutePath(canonical, "canonical executable path");
  const stats = await lstatImpl(canonical);
  assertManagedFile(stats, canonical, {
    privateFile: false,
    allowRoot,
    requireExecutable: true,
  });
  return { path: canonical, snapshot: snapshot(stats) };
}

async function isFullRefreshLaunchAgentLoaded({
  label,
  execFileImpl,
}) {
  const uid = currentUid();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("A numeric user id is required to inspect full refresh");
  }
  try {
    await execFileImpl(
      "/bin/launchctl",
      ["print", `gui/${uid}/${label}`],
      { encoding: "utf8", timeout: 10_000 },
    );
    return true;
  } catch (error) {
    if (error?.code === LAUNCHCTL_SERVICE_NOT_FOUND) return false;
    throw new Error("Failed to inspect the full-refresh worker", {
      cause: error,
    });
  }
}

/**
 * Validate the active distribution receipt and atomically bootstrap a one-shot
 * per-user worker. The rendered worker path is the exact versioned receipt
 * target, never the mutable `current` symlink.
 */
export async function armFullRefreshLaunchAgent({
  installDirectory,
  label,
  nodePath,
  workerPath,
  checkpointPath,
  launchAgentPath,
  logPath,
  receiptPath,
  execFileImpl = execFile,
  realpathImpl = realpath,
  lstatImpl = lstat,
  openImpl = open,
} = {}) {
  requireFunction(execFileImpl, "execFileImpl");
  requireContainedPath(installDirectory, receiptPath, "receiptPath");
  requireContainedPath(installDirectory, workerPath, "workerPath");
  requireContainedPath(installDirectory, checkpointPath, "checkpointPath");
  requireContainedPath(installDirectory, launchAgentPath, "launchAgentPath");
  requireContainedPath(installDirectory, logPath, "logPath");
  await assertPrivateDirectoryChain(installDirectory, installDirectory, {
    lstatImpl,
  });
  await readFullRefreshCheckpoint({
    installDirectory,
    checkpointPath,
    lstatImpl,
    openImpl,
  });
  const receiptFile = await readIdentityBoundFile(receiptPath, {
    lstatImpl,
    openImpl,
  });
  let receipt;
  try {
    receipt = JSON.parse(receiptFile.contents.toString("utf8"));
  } catch (error) {
    throw new Error("PickerMux install receipt is invalid JSON", { cause: error });
  }
  const expectedWorkerPath = validateDistributionReceipt(
    receipt,
    installDirectory,
  );
  if (workerPath !== expectedWorkerPath) {
    throw new Error("Full-refresh worker is not the receipt-owned active worker");
  }

  const validatedNode = await validateExecutablePath(nodePath, {
    allowRoot: true,
    realpathImpl,
    lstatImpl,
  });
  const validatedWorker = await validateExecutablePath(workerPath, {
    allowRoot: false,
    realpathImpl,
    lstatImpl,
  });
  if (validatedWorker.path !== workerPath) {
    throw new Error("Full-refresh worker path must not contain symbolic links");
  }

  const existingLog = await lstatOptional(logPath, lstatImpl);
  if (existingLog === null) {
    await writePrivateAtomic(installDirectory, logPath, "", {
      requireMissing: true,
      lstatImpl,
      openImpl,
    });
  } else {
    assertManagedFile(existingLog, logPath);
  }
  const plist = renderFullRefreshLaunchAgent({
    installDirectory,
    label,
    nodePath: validatedNode.path,
    workerPath: validatedWorker.path,
    checkpointPath,
    launchAgentPath,
    logPath,
  });
  const existingPlist = await readIdentityBoundFile(launchAgentPath, {
    allowMissing: true,
    lstatImpl,
    openImpl,
  });
  const alreadyLoaded = await isFullRefreshLaunchAgentLoaded({
    label,
    execFileImpl,
  });
  if (existingPlist === null && alreadyLoaded) {
    throw new Error(
      "Refusing to replace a loaded full-refresh job without its managed plist",
    );
  }
  if (existingPlist !== null) {
    if (existingPlist.contents.toString("utf8") !== plist) {
      throw new Error("Refusing to replace a modified full-refresh LaunchAgent");
    }
    if (alreadyLoaded) {
      const uid = currentUid();
      try {
        await execFileImpl(
          "/bin/launchctl",
          ["bootout", `gui/${uid}/${label}`],
          { encoding: "utf8", timeout: 10_000 },
        );
      } catch (error) {
        throw new Error("Failed to unload the prior full-refresh worker", {
          cause: error,
        });
      }
    }
    await removeExactManagedFile({
      target: launchAgentPath,
      expectedContents: plist,
      allowMissing: false,
      lstatImpl,
      openImpl,
    });
  }
  await writePrivateAtomic(installDirectory, launchAgentPath, plist, {
    requireMissing: true,
    lstatImpl,
    openImpl,
  });

  try {
    const [confirmedReceipt, confirmedWorker, confirmedNode] = await Promise.all([
      readIdentityBoundFile(receiptPath, { lstatImpl, openImpl }),
      lstatImpl(validatedWorker.path),
      lstatImpl(validatedNode.path),
    ]);
    assertManagedFile(confirmedWorker, validatedWorker.path, {
      privateFile: false,
      requireExecutable: true,
    });
    assertManagedFile(confirmedNode, validatedNode.path, {
      privateFile: false,
      allowRoot: true,
      requireExecutable: true,
    });
    if (
      !sameSnapshot(receiptFile.snapshot, confirmedReceipt.snapshot) ||
      sha256(confirmedReceipt.contents) !== sha256(receiptFile.contents) ||
      !sameSnapshot(validatedWorker.snapshot, snapshot(confirmedWorker)) ||
      !sameSnapshot(validatedNode.snapshot, snapshot(confirmedNode))
    ) {
      throw new Error("Full-refresh receipt or executable changed before bootstrap");
    }
    const uid = currentUid();
    if (!Number.isSafeInteger(uid) || uid < 0) {
      throw new Error("A numeric user id is required to bootstrap full refresh");
    }
    await execFileImpl(
      "/bin/launchctl",
      ["bootstrap", `gui/${uid}`, launchAgentPath],
      { encoding: "utf8", timeout: 15_000 },
    );
  } catch (error) {
    let loadedAfterFailure;
    try {
      loadedAfterFailure = await isFullRefreshLaunchAgentLoaded({
        label,
        execFileImpl,
      });
    } catch (inspectionError) {
      throw new Error(
        "Failed to arm the full-refresh worker and its launchd state is indeterminate",
        { cause: new AggregateError([error, inspectionError]) },
      );
    }
    if (!loadedAfterFailure) {
      await removeExactManagedFile({
        target: launchAgentPath,
        expectedContents: plist,
        allowMissing: true,
        lstatImpl,
        openImpl,
      });
    }
    throw new Error("Failed to arm full-refresh worker", { cause: error });
  }
  return Object.freeze({
    label,
    nodePath: validatedNode.path,
    workerPath: validatedWorker.path,
    checkpointPath,
    launchAgentPath,
    logPath,
    receiptSha256: sha256(receiptFile.contents),
  });
}

async function removeExactManagedFile({
  target,
  expectedContents,
  allowMissing = true,
  lstatImpl = lstat,
  openImpl = open,
  unlinkImpl = unlink,
} = {}) {
  const captured = await readIdentityBoundFile(target, {
    allowMissing,
    lstatImpl,
    openImpl,
  });
  if (captured === null) return false;
  if (
    expectedContents !== undefined &&
    !captured.contents.equals(Buffer.from(expectedContents))
  ) {
    throw new Error(`Refusing to remove modified full-refresh state: ${target}`);
  }
  const confirmed = await lstatImpl(target);
  assertManagedFile(confirmed, target);
  if (!sameSnapshot(captured.snapshot, snapshot(confirmed))) {
    throw new Error(`Full-refresh state changed before removal: ${target}`);
  }
  await unlinkImpl(target);
  return true;
}

/**
 * Remove exact one-shot artifacts. A resumable failure unloads/removes only
 * the receipt-bound plist; a completed run also removes its checkpoint and
 * private log. Missing artifacts make retries harmless.
 */
export async function cleanupFullRefreshArtifacts({
  successful,
  installDirectory,
  label,
  nodePath,
  workerPath,
  checkpointPath,
  launchAgentPath,
  logPath,
  execFileImpl = execFile,
  lstatImpl = lstat,
  openImpl = open,
  readdirImpl = readdir,
  rmdirImpl = rmdir,
  unlinkImpl = unlink,
  processImpl = process,
} = {}) {
  if (typeof successful !== "boolean") {
    throw new TypeError("successful must be a boolean");
  }
  requireFunction(execFileImpl, "execFileImpl");
  requireFunction(processImpl?.on, "processImpl.on");
  requireFunction(processImpl?.off, "processImpl.off");
  requireContainedPath(installDirectory, workerPath, "workerPath");
  requireContainedPath(installDirectory, checkpointPath, "checkpointPath");
  requireContainedPath(installDirectory, launchAgentPath, "launchAgentPath");
  requireContainedPath(installDirectory, logPath, "logPath");
  const operationDirectory = path.dirname(checkpointPath);
  if (
    operationDirectory === installDirectory ||
    path.basename(operationDirectory) !== "full-refresh" ||
    path.dirname(operationDirectory) !== installDirectory ||
    path.dirname(launchAgentPath) !== operationDirectory ||
    path.dirname(logPath) !== operationDirectory
  ) {
    throw new Error("Full-refresh artifacts must share one managed directory");
  }
  const plist = renderFullRefreshLaunchAgent({
    installDirectory,
    label,
    nodePath,
    workerPath,
    checkpointPath,
    launchAgentPath,
    logPath,
  });
  const existingPlist = await readIdentityBoundFile(launchAgentPath, {
    allowMissing: true,
    lstatImpl,
    openImpl,
  });
  if (
    existingPlist !== null &&
    existingPlist.contents.toString("utf8") !== plist
  ) {
    throw new Error("Refusing to remove modified full-refresh state");
  }
  const loaded = existingPlist === null
    ? false
    : await isFullRefreshLaunchAgentLoaded({ label, execFileImpl });
  // A worker can unload its own launchd job. Keep SIGTERM non-fatal only for
  // the bounded bootout-and-cleanup window so the checkpoint remains atomic.
  const preserveSelfDuringBootout = () => {};
  let signalGuardInstalled = false;
  try {
    if (existingPlist !== null && loaded) {
      const uid = currentUid();
      if (!Number.isSafeInteger(uid) || uid < 0) {
        throw new Error("A numeric user id is required to unload full refresh");
      }
      processImpl.on("SIGTERM", preserveSelfDuringBootout);
      signalGuardInstalled = true;
      try {
        await execFileImpl(
          "/bin/launchctl",
          ["bootout", `gui/${uid}/${label}`],
          { encoding: "utf8", timeout: 10_000 },
        );
      } catch (error) {
        throw new Error("Failed to unload the full-refresh worker", {
          cause: error,
        });
      }
    }

    const plistPresent = await removeExactManagedFile({
      target: launchAgentPath,
      expectedContents: plist,
      allowMissing: true,
      lstatImpl,
      openImpl,
      unlinkImpl,
    });

    if (successful) {
      await removeExactManagedFile({
        target: logPath,
        allowMissing: true,
        lstatImpl,
        openImpl,
        unlinkImpl,
      });
      await removeFullRefreshCheckpoint({
        installDirectory,
        checkpointPath,
        allowMissing: true,
        lstatImpl,
        openImpl,
        unlinkImpl,
      });
      const directoryStats = await lstatOptional(operationDirectory, lstatImpl);
      if (directoryStats !== null) {
        assertDirectory(directoryStats, operationDirectory, {
          privateDirectory: true,
        });
        const names = await readdirImpl(operationDirectory);
        const confirmed = await lstatImpl(operationDirectory);
        assertDirectory(confirmed, operationDirectory, {
          privateDirectory: true,
        });
        if (
          names.length !== 0 ||
          !sameSnapshot(snapshot(directoryStats), snapshot(confirmed))
        ) {
          throw new Error(
            "Refusing to remove a changed or non-empty full-refresh directory",
          );
        }
        await rmdirImpl(operationDirectory);
      }
    }

    return Object.freeze({
      successful,
      launchAgentRemoved: plistPresent,
      resumableStateRetained: !successful,
    });
  } finally {
    if (signalGuardInstalled) {
      processImpl.off("SIGTERM", preserveSelfDuringBootout);
    }
  }
}
