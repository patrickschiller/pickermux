import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as filesystem from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { isValidProviderId } from "./provider-id.mjs";
import { projectDurableTokenUsageSnapshot, TOKEN_USAGE_MAX_PROVIDERS } from "./token-usage.mjs";

export const USAGE_STORE_MAX_BYTES = 128 * 1024;
export const USAGE_STORE_FILENAME = "token-usage.json";
const LOCK_FILENAME = ".usage.lock";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const inventories = new WeakMap();
const RETRY_INITIALIZATION = Symbol("retry-usage-initialization");

export class UsageStoreError extends Error {
  constructor() {
    super("PickerMux token usage storage could not be verified.");
    this.name = "UsageStoreError";
    this.code = "USAGE_STORE_UNAVAILABLE";
  }
}

function fail() { throw new UsageStoreError(); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) { return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function zero() { return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }; }
function emptySnapshot(status = "available", resetAt = null) { return { schemaVersion: 2, status, resetAt, providers: [] }; }
function identity(stats, stable = false) {
  return Object.fromEntries((stable ? ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeMs"] :
    ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"]).map((key) => [key, stats[key]]));
}
function sameIdentity(left, right, stable = false) {
  const a = identity(left, stable);
  return Object.keys(a).every((key) => a[key] === right[key]);
}
function sameDirectory(left, right) {
  return ["dev", "ino", "uid", "mode"].every((key) => left[key] === right[key]);
}

function settings(options = {}) {
  const { directory, fsImpl = {}, uuid = randomUUID, now = Date.now,
    processAlive = defaultProcessAlive, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    lockAttempts = 200, retryMs = 10, maxPendingOperations = 128 } = options;
  if (typeof directory !== "string" || !path.isAbsolute(directory) || path.resolve(directory) !== directory ||
      path.basename(directory) !== "usage" || path.basename(path.dirname(directory)) !== "PickerMux" ||
      /[\u0000-\u001f\u007f]/u.test(directory) || typeof uuid !== "function" || typeof now !== "function" ||
      typeof processAlive !== "function" || typeof sleep !== "function" || !record(fsImpl) ||
      !Number.isSafeInteger(lockAttempts) || lockAttempts < 1 || lockAttempts > 1000 ||
      !Number.isSafeInteger(retryMs) || retryMs < 1 || retryMs > 1000 ||
      !Number.isSafeInteger(maxPendingOperations) || maxPendingOperations < 1 || maxPendingOperations > 1024 ||
      !Number.isInteger(constants.O_NOFOLLOW)) fail();
  const fs = { ...filesystem, ...fsImpl };
  for (const key of ["lstat", "open", "mkdir", "rename", "unlink", "readdir", "rmdir"]) if (typeof fs[key] !== "function") fail();
  return { directory, parent: path.dirname(directory), target: path.join(directory, USAGE_STORE_FILENAME),
    lock: path.join(directory, LOCK_FILENAME), fs, uuid, now, processAlive, sleep, lockAttempts, retryMs, maxPendingOperations };
}

function newUuid(config) {
  const value = config.uuid();
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) fail();
  return value;
}

function assertOwned(stats) {
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail();
}
function assertDirectory(stats) {
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) fail();
  assertOwned(stats);
}
function assertFile(stats, maxBytes) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || (stats.mode & 0o077) !== 0 ||
      !Number.isSafeInteger(stats.size) || stats.size < 0 || stats.size > maxBytes) fail();
  assertOwned(stats);
}

async function directories(config, create = false) {
  let parent;
  try { parent = await config.fs.lstat(config.parent); } catch (error) {
    if (error?.code === "ENOENT" && !create) return null;
    fail();
  }
  assertDirectory(parent);
  let created = false;
  if (create) {
    try { await config.fs.mkdir(config.directory, { mode: 0o700 }); created = true; } catch (error) { if (error?.code !== "EEXIST") fail(); }
  }
  let directory;
  try { directory = await config.fs.lstat(config.directory); } catch (error) {
    if (error?.code === "ENOENT" && !create) return null;
    fail();
  }
  assertDirectory(directory);
  const confirmedParent = await config.fs.lstat(config.parent);
  assertDirectory(confirmedParent);
  if (!sameDirectory(parent, confirmedParent)) fail();
  return { parent: identity(parent), directory: identity(directory), created };
}

async function confirmDirectories(config, expected) {
  const current = await directories(config);
  if (!current || !sameDirectory(expected.parent, current.parent) || !sameDirectory(expected.directory, current.directory)) fail();
}

async function capture(config, target, { missing = false, maxBytes = USAGE_STORE_MAX_BYTES } = {}) {
  let handle;
  let observed = false;
  try {
    const initial = await config.fs.lstat(target);
    observed = true;
    assertFile(initial, maxBytes);
    handle = await config.fs.open(target, READ_FLAGS);
    const opened = await handle.stat();
    const openedPath = await config.fs.lstat(target);
    assertFile(opened, maxBytes);
    assertFile(openedPath, maxBytes);
    if (!sameIdentity(initial, opened) || !sameIdentity(initial, openedPath)) fail();
    const chunks = [];
    let length = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(16 * 1024, maxBytes + 1 - length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > maxBytes) fail();
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const final = await handle.stat();
    const finalPath = await config.fs.lstat(target);
    assertFile(final, maxBytes);
    assertFile(finalPath, maxBytes);
    if (!sameIdentity(initial, final) || !sameIdentity(initial, finalPath) || length !== initial.size) fail();
    const bytes = Buffer.concat(chunks, length);
    return { bytes, sha256: hash(bytes), snapshot: identity(initial) };
  } catch (error) {
    if (missing && !observed && !handle && error?.code === "ENOENT") return null;
    fail();
  } finally {
    await handle?.close().catch(() => {});
  }
}

function decode(bytes) {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    rejectDuplicateKeys(source);
    return JSON.parse(source);
  } catch { fail(); }
}

function rejectDuplicateKeys(source) {
  let position = 0;
  const whitespace = () => { while (/[ \t\r\n]/u.test(source[position] ?? "")) position += 1; };
  const string = () => {
    const start = position++;
    while (position < source.length) {
      if (source[position] === "\\") position += 2;
      else if (source[position++] === '"') return JSON.parse(source.slice(start, position));
    }
    fail();
  };
  const value = (depth) => {
    if (depth > 16) fail();
    whitespace();
    const opening = source[position];
    if (opening === '"') { string(); return; }
    if (opening === "{" || opening === "[") {
      const closing = opening === "{" ? "}" : "]";
      const seen = new Set();
      position += 1;
      whitespace();
      if (source[position] === closing) { position += 1; return; }
      while (true) {
        whitespace();
        if (opening === "{") {
          if (source[position] !== '"') fail();
          const key = string();
          if (seen.has(key)) fail();
          seen.add(key);
          whitespace();
          if (source[position++] !== ":") fail();
        }
        value(depth + 1);
        whitespace();
        const separator = source[position++];
        if (separator === closing) return;
        if (separator !== ",") fail();
      }
    }
    const primitive = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u.exec(source.slice(position));
    if (!primitive) fail();
    position += primitive[0].length;
  };
  value(0);
  whitespace();
  if (position !== source.length) fail();
}

function parseStore(bytes) {
  const value = decode(bytes);
  if (!exactKeys(value, ["kind", "schemaVersion", "generation", "unavailable", "resetAt", "providers"]) ||
      value.kind !== "pickermux-token-usage" || value.schemaVersion !== 1 || !UUID_PATTERN.test(value.generation) ||
      typeof value.unavailable !== "boolean" || !Array.isArray(value.providers)) fail();
  for (const provider of value.providers) {
    if (!exactKeys(provider, ["providerId", "requests", "unavailableRequests", "last", "totals"]) ||
        !exactKeys(provider.last, provider.last?.status === "available" ?
          ["status", "inputTokens", "outputTokens", "totalTokens"] : ["status"]) ||
        (provider.totals !== null && !exactKeys(provider.totals, ["inputTokens", "outputTokens", "totalTokens"]))) fail();
  }
  const projected = projectDurableTokenUsageSnapshot({ schemaVersion: 2, status: "available", resetAt: value.resetAt, providers: value.providers });
  if (!projected) fail();
  return { ...value, providers: projected.providers };
}

function publicSnapshot(state) {
  if (state.unavailable) return emptySnapshot("unavailable", state.resetAt);
  return projectDurableTokenUsageSnapshot({ schemaVersion: 2, status: "available", resetAt: state.resetAt, providers: state.providers });
}
function initialStore(config) {
  return { kind: "pickermux-token-usage", schemaVersion: 1, generation: newUuid(config), unavailable: false, resetAt: null, providers: [] };
}
async function readState(config) {
  const captured = await capture(config, config.target, { missing: true });
  return { captured, state: captured ? parseStore(captured.bytes) : null };
}

function parseLock(bytes) {
  const value = decode(bytes);
  if (!exactKeys(value, ["kind", "schemaVersion", "pid", "token"]) || value.kind !== "pickermux-usage-lock" ||
      value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1 || !UUID_PATTERN.test(value.token)) fail();
  return value;
}
function defaultProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error?.code === "ESRCH") return false; if (error?.code === "EPERM") return true; fail(); }
}

async function unlinkCaptured(config, target, expected, stable = false) {
  const current = await capture(config, target);
  if (!sameIdentity(expected.snapshot, current.snapshot, stable) || expected.sha256 !== current.sha256) fail();
  await config.fs.unlink(target);
}

async function recoverStaleLock(config) {
  // O_EXCL exposes the lock name before its owner finishes writing. Unknown or
  // changing locks are only retried, never adopted or removed by age.
  try {
    const captured = await capture(config, config.lock, { missing: true, maxBytes: 1024 });
    if (!captured) return;
    const lock = parseLock(captured.bytes);
    const alive = await config.processAlive(lock.pid);
    if (typeof alive !== "boolean" || alive) return;
    const current = await capture(config, config.lock, { maxBytes: 1024 });
    if (!sameIdentity(captured.snapshot, current.snapshot) || captured.sha256 !== current.sha256) return;
    const staged = path.join(config.directory, `${LOCK_FILENAME}.stale-${newUuid(config)}`);
    await config.fs.rename(config.lock, staged);
    try { await unlinkCaptured(config, staged, captured, true); } catch {
      try { await config.fs.lstat(config.lock); } catch (missing) { if (missing?.code === "ENOENT") await config.fs.rename(staged, config.lock).catch(() => {}); }
    }
  } catch { /* A bounded retry may observe a finished writer; ambiguity has no deletion authority. */ }
}

async function removeCreatedPrefix(config, target, initial, bytes) {
  if (!initial || !bytes) return;
  const current = await capture(config, target);
  if (!["dev", "ino", "uid", "mode", "nlink"].every((key) => initial[key] === current.snapshot[key]) ||
      current.bytes.length > bytes.length || !current.bytes.equals(bytes.subarray(0, current.bytes.length))) fail();
  await unlinkCaptured(config, target, current);
}

async function withLock(config, operation) {
  const directoryProof = await directories(config, true);
  for (let attempt = 0; attempt < config.lockAttempts; attempt += 1) {
    let handle;
    let captured;
    let created;
    let bytes;
    try {
      const token = newUuid(config);
      bytes = Buffer.from(`${JSON.stringify({ kind: "pickermux-usage-lock", schemaVersion: 1, pid: process.pid, token })}\n`);
      handle = await config.fs.open(config.lock, WRITE_FLAGS, 0o600);
      created = identity(await handle.stat());
      await handle.writeFile(bytes);
      await handle.sync();
      const stats = await handle.stat();
      assertFile(stats, 1024);
      captured = { bytes, sha256: hash(bytes), snapshot: identity(stats) };
      await handle.close();
      handle = null;
      await confirmDirectories(config, directoryProof);
      const result = await operation({ directoryProof, lockProof: captured });
      await unlinkCaptured(config, config.lock, captured);
      if (result === RETRY_INITIALIZATION) {
        captured = null;
        if (attempt + 1 < config.lockAttempts) { await config.sleep(config.retryMs); continue; }
        fail();
      }
      return result;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (captured) await unlinkCaptured(config, config.lock, captured).catch(() => {});
      else if (created) await removeCreatedPrefix(config, config.lock, created, bytes).catch(() => {});
      if (!captured && error?.code === "EEXIST") {
        await recoverStaleLock(config);
        if (attempt + 1 < config.lockAttempts) { await config.sleep(config.retryMs); continue; }
      }
      fail();
    }
  }
  fail();
}

async function writeState(config, state, previous, proof) {
  const bytes = Buffer.from(`${JSON.stringify(state)}\n`);
  if (bytes.length > USAGE_STORE_MAX_BYTES) fail();
  parseStore(bytes);
  const temporary = path.join(config.directory, `.${USAGE_STORE_FILENAME}.tmp-${newUuid(config)}`);
  let handle;
  let temporaryProof;
  let created;
  try {
    handle = await config.fs.open(temporary, WRITE_FLAGS, 0o600);
    created = identity(await handle.stat());
    await handle.writeFile(bytes);
    await handle.sync();
    const stats = await handle.stat();
    assertFile(stats, USAGE_STORE_MAX_BYTES);
    temporaryProof = { snapshot: identity(stats), sha256: hash(bytes) };
    await handle.close();
    handle = null;
    await confirmDirectories(config, proof.directoryProof);
    const lock = await capture(config, config.lock, { maxBytes: 1024 });
    if (!sameIdentity(proof.lockProof.snapshot, lock.snapshot) || proof.lockProof.sha256 !== lock.sha256) fail();
    const current = await capture(config, config.target, { missing: true });
    if (Boolean(previous) !== Boolean(current) || (previous &&
        (!sameIdentity(previous.snapshot, current.snapshot) || previous.sha256 !== current.sha256))) fail();
    const staged = await capture(config, temporary);
    if (!sameIdentity(temporaryProof.snapshot, staged.snapshot) || staged.sha256 !== temporaryProof.sha256) fail();
    await config.fs.rename(temporary, config.target);
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryProof) await unlinkCaptured(config, temporary, temporaryProof).catch(() => {});
    else if (created) await removeCreatedPrefix(config, temporary, created, bytes).catch(() => {});
  }
}

function observationCounts(value) {
  if (!record(value) || value.status !== "available" || !Number.isSafeInteger(value.inputTokens) || value.inputTokens < 0 ||
      !Number.isSafeInteger(value.outputTokens) || value.outputTokens < 0) return null;
  const totalTokens = value.inputTokens + value.outputTokens;
  if (!Number.isSafeInteger(totalTokens) || (value.totalTokens !== undefined && value.totalTokens !== totalTokens)) return null;
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens, totalTokens };
}

/** Each finalized observation contributes one delta, never a session snapshot. */
export function createUsageStore(options) {
  const config = settings(options);
  let queue = Promise.resolve();
  let pending = 0;
  let unavailable = false;
  let knownGeneration = null;
  let hasPersistedState = false;
  function noteGeneration(state) {
    if (knownGeneration !== null && knownGeneration !== state.generation) unavailable = false;
    knownGeneration = state.generation;
  }
  function enqueue(operation) {
    if (pending >= config.maxPendingOperations) { unavailable = true; return Promise.reject(new UsageStoreError()); }
    pending += 1;
    const task = queue.then(operation);
    const settled = task.finally(() => { pending -= 1; });
    queue = settled.catch(() => {});
    return settled;
  }
  return Object.freeze({
    async canReset() {
      await queue;
      try {
        const proof = await directories(config);
        if (!proof) return true;
        await readState(config);
        await confirmDirectories(config, proof);
        return true;
      } catch { return false; }
    },
    async readSnapshot() {
      await queue;
      try {
        const proof = await directories(config);
        if (!proof) return unavailable || hasPersistedState ? emptySnapshot("unavailable") : emptySnapshot();
        const { state } = await readState(config);
        await confirmDirectories(config, proof);
        if (!state) return emptySnapshot("unavailable");
        hasPersistedState = true;
        noteGeneration(state);
        return unavailable ? emptySnapshot("unavailable", state.resetAt) : publicSnapshot(state);
      } catch { return emptySnapshot("unavailable"); }
    },
    async record(providerId, value) {
      if (!isValidProviderId(providerId)) return false;
      // Capture only numeric/fixed fields before entering the asynchronous queue.
      const counts = observationCounts(value);
      try {
        return await enqueue(() => withLock(config, async (proof) => {
          const previous = await readState(config);
          if (!previous.state && hasPersistedState) fail();
          // Only this transaction's successful mkdir proves fresh installation.
          // A competing first writer releases its lock so the creator can finish;
          // a preexisting empty directory requires an explicit user reset.
          if (!previous.state && !proof.directoryProof.created) return RETRY_INITIALIZATION;
          if (previous.state) hasPersistedState = true;
          const state = previous.state ?? initialStore(config);
          noteGeneration(state);
          if (unavailable) state.unavailable = true;
          let provider = state.providers.find((entry) => entry.providerId === providerId);
          if ((!provider && state.providers.length >= TOKEN_USAGE_MAX_PROVIDERS) || provider?.requests === Number.MAX_SAFE_INTEGER) {
            state.unavailable = true;
            await writeState(config, state, previous.captured, proof);
            return false;
          }
          if (!provider) {
            provider = { providerId, requests: 0, unavailableRequests: 0, last: { status: "unavailable" }, totals: zero() };
            state.providers.push(provider);
          }
          provider.requests += 1;
          if (!counts) {
            provider.unavailableRequests += 1;
            provider.last = { status: "unavailable" };
          } else {
            provider.last = { status: "available", ...counts };
            if (provider.totals !== null) provider.totals = observationCounts({ status: "available",
              inputTokens: provider.totals.inputTokens + counts.inputTokens, outputTokens: provider.totals.outputTokens + counts.outputTokens });
          }
          await writeState(config, state, previous.captured, proof);
          hasPersistedState = true;
          return true;
        }));
      } catch { unavailable = true; return false; }
    },
    async resetCumulative() {
      try {
        return await enqueue(() => withLock(config, async (proof) => {
          const previous = await readState(config);
          const state = previous.state ?? initialStore(config);
          const resetAt = new Date(config.now()).toISOString();
          state.generation = newUuid(config);
          state.unavailable = false;
          state.resetAt = resetAt;
          state.providers = state.providers.map((provider) => ({ ...provider, requests: 0, unavailableRequests: 0, totals: zero() }));
          await writeState(config, state, previous.captured, proof);
          hasPersistedState = true;
          knownGeneration = state.generation;
          unavailable = false;
          return publicSnapshot(state);
        }));
      } catch { fail(); }
    },
    async flush() {
      await queue;
      if (!unavailable) return;
      try {
        await enqueue(() => withLock(config, async (proof) => {
          const previous = await readState(config);
          if (!previous.state) fail();
          const state = previous.state;
          noteGeneration(state);
          if (!unavailable || state.unavailable) return;
          state.unavailable = true;
          await writeState(config, state, previous.captured, proof);
          hasPersistedState = true;
        }));
      } catch { /* A failed persistence marker has no inference or deletion authority. */ }
    },
  });
}

function sameCapture(left, right, stable = false) {
  return sameIdentity(left.snapshot, right.snapshot, stable) && left.sha256 === right.sha256;
}

async function inventory(config) {
  const directoryProof = await directories(config);
  if (!directoryProof) return { exists: false, directoryProof: null, files: [] };
  const names = (await config.fs.readdir(config.directory)).sort();
  const files = [];
  for (const name of names) {
    const temporary = new RegExp(`^\\.${USAGE_STORE_FILENAME.replaceAll(".", "\\.")}\\.tmp-([0-9a-f-]{36})$`, "u").exec(name);
    const stale = /^\.usage\.lock\.stale-([0-9a-f-]{36})$/u.exec(name);
    if (name !== USAGE_STORE_FILENAME && name !== LOCK_FILENAME &&
        !(temporary && UUID_PATTERN.test(temporary[1])) && !(stale && UUID_PATTERN.test(stale[1]))) fail();
    const captured = await capture(config, path.join(config.directory, name), { maxBytes: name === LOCK_FILENAME || stale ? 1024 : USAGE_STORE_MAX_BYTES });
    if (name === LOCK_FILENAME || stale) {
      const lock = parseLock(captured.bytes);
      const alive = await config.processAlive(lock.pid);
      if (typeof alive !== "boolean" || alive) fail();
    } else parseStore(captured.bytes);
    files.push({ name, ...captured });
  }
  const confirmed = await directories(config);
  if (!confirmed || !sameIdentity(directoryProof.directory, confirmed.directory) || !sameDirectory(directoryProof.parent, confirmed.parent) ||
      JSON.stringify(names) !== JSON.stringify((await config.fs.readdir(config.directory)).sort())) fail();
  return { exists: true, directoryProof: confirmed, files };
}

/** Full removal uses an opaque exact inventory; callers must first stop writers. */
export async function inventoryUsageStore(options) {
  const config = settings(options);
  const captured = await inventory(config);
  const receipt = Object.freeze({ exists: captured.exists });
  inventories.set(receipt, { config, captured });
  return receipt;
}

export async function revalidateUsageStoreInventory(receipt, { directory } = {}) {
  const details = inventories.get(receipt);
  if (!details || (directory !== undefined && directory !== details.config.directory)) fail();
  const current = await inventory(details.config);
  const previous = details.captured;
  if (current.exists !== previous.exists || current.files.length !== previous.files.length ||
      (previous.exists && (!sameIdentity(previous.directoryProof.directory, current.directoryProof.directory) ||
        !sameDirectory(previous.directoryProof.parent, current.directoryProof.parent))) ||
      previous.files.some((entry, index) => entry.name !== current.files[index].name || !sameCapture(entry, current.files[index]))) fail();
  return receipt;
}

export async function removeUsageStoreInventory(receipt) {
  const details = inventories.get(receipt);
  if (!details) fail();
  await revalidateUsageStoreInventory(receipt);
  const { config, captured } = details;
  if (!captured.exists) return { removed: false, cleanupPendingPath: null };
  const staged = path.join(config.parent, `.usage.purge-${newUuid(config)}`);
  await config.fs.rename(config.directory, staged);
  try {
    const directoryStats = await config.fs.lstat(staged);
    assertDirectory(directoryStats);
    if (!sameDirectory(captured.directoryProof.directory, identity(directoryStats)) ||
        JSON.stringify((await config.fs.readdir(staged)).sort()) !== JSON.stringify(captured.files.map((entry) => entry.name))) fail();
    for (const entry of captured.files) await unlinkCaptured(config, path.join(staged, entry.name), entry, true);
    if ((await config.fs.readdir(staged)).length !== 0) fail();
    const final = await config.fs.lstat(staged);
    assertDirectory(final);
    if (!sameDirectory(captured.directoryProof.directory, identity(final))) fail();
    await config.fs.rmdir(staged);
    return { removed: true, cleanupPendingPath: null };
  } catch {
    // A partial exact cleanup remains recoverable; never recurse or replace a new directory.
    try { await config.fs.lstat(config.directory); } catch (error) {
      if (error?.code === "ENOENT") {
        try { await config.fs.rename(staged, config.directory); return { removed: false, cleanupPendingPath: config.directory }; } catch { /* Retain the staged directory. */ }
      }
    }
    return { removed: false, cleanupPendingPath: staged };
  }
}
