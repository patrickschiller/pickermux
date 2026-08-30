import {
  execFile as execFileCallback,
  spawn as spawnChild,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { isValidProviderId } from "./provider-id.mjs";

export const KEYCHAIN_SECURITY_PATH = "/usr/bin/security";
export const KEYCHAIN_SERVICE_PREFIX =
  "com.local.codex-model-bridge.provider";
export const DEFAULT_CREDENTIAL_CACHE_TTL_MS = 30_000;
export const DEFAULT_CREDENTIAL_LOOKUP_TIMEOUT_MS = 5_000;
export const KEYCHAIN_PROVIDER_REGISTRY_SCHEMA_VERSION = 1;

const MAX_CREDENTIAL_LOOKUP_TIMEOUT_MS = 60_000;
const MAX_KEYCHAIN_PROVIDER_REGISTRY_BYTES = 64 * 1024;
const MAX_KEYCHAIN_PROVIDER_REGISTRY_ENTRIES = 256;
const KEYCHAIN_PROVIDER_REGISTRY_PRODUCT = "pickermux";
const KEYCHAIN_PROVIDER_REGISTRY_OWNER = "pickermux-keychain-provider-registry";
const KEYCHAIN_PROVIDER_REGISTRY_KEYS = Object.freeze([
  "owner",
  "product",
  "providerIds",
  "schemaVersion",
]);

const KEYCHAIN_PROVIDER_REGISTRY_NAME = "keychain-state.json";
const KEYCHAIN_PROVIDER_REGISTRY_QUARANTINE_PATTERN =
  /^\.keychain-state\.json\.purge\.[1-9]\d*\.[0-9a-f]{16}\.staging$/u;
const REGISTRY_READ_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

function providerIdOf(provider) {
  const providerId =
    typeof provider === "string"
      ? provider
      : provider?.providerId ?? provider?.id;
  if (!isValidProviderId(providerId)) {
    throw new TypeError("Provider id is not valid for credential lookup");
  }
  return providerId;
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertCurrentUserOwner(stats, target) {
  const uid = currentUid();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(
      `Refusing Keychain provider registry path not owned by the current user: ${target}`,
    );
  }
}

async function lstatOptional(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertRegistryStoragePath(
  registryPath,
  { allowQuarantine = false } = {},
) {
  const filename = path.basename(registryPath);
  if (
    filename !== KEYCHAIN_PROVIDER_REGISTRY_NAME &&
    !(
      allowQuarantine &&
      KEYCHAIN_PROVIDER_REGISTRY_QUARANTINE_PATTERN.test(filename)
    )
  ) {
    throw new Error(
      `Keychain provider registry must use the exact ${KEYCHAIN_PROVIDER_REGISTRY_NAME} filename`,
    );
  }
  const directory = path.dirname(registryPath);
  if (
    path.basename(directory) !== "model-bridge" ||
    directory === path.parse(directory).root ||
    path.dirname(directory) === path.parse(directory).root
  ) {
    throw new Error(
      "Keychain provider registry must be directly inside a non-root model-bridge directory",
    );
  }
  return registryPath;
}

function resolveRegistryPath(input) {
  const configured = typeof input === "string" ? input : input?.registryPath;
  if (typeof configured !== "string" || !configured.trim()) {
    throw new TypeError("Keychain provider registryPath must be a non-empty path");
  }
  const resolved = path.resolve(configured);
  if (resolved === path.parse(resolved).root) {
    throw new Error("Keychain provider registryPath must not be a filesystem root");
  }
  return assertRegistryStoragePath(resolved);
}

function assertPrivateRegistryDirectory(stats, directory) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(
      `Keychain provider registry directory must be a real directory: ${directory}`,
    );
  }
  assertCurrentUserOwner(stats, directory);
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      `Keychain provider registry directory permissions are not private: ${directory}`,
    );
  }
}

function sameDirectoryIdentity(left, right) {
  if (left === null || right === null) return left === right;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode
  );
}

function assertRegistryDirectoryUnchanged(before, after, directory) {
  if (before !== null) assertPrivateRegistryDirectory(before, directory);
  if (after !== null) assertPrivateRegistryDirectory(after, directory);
  if (!sameDirectoryIdentity(before, after)) {
    throw new Error(
      "Keychain provider registry directory changed while it was being read",
    );
  }
}

async function ensurePrivateRegistryDirectory(directory) {
  let stats = await lstatOptional(directory);
  if (stats === null) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    stats = await lstat(directory);
  }
  assertPrivateRegistryDirectory(stats, directory);
}

function validateKeychainProviderRegistry(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Keychain provider registry must be a JSON object");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== KEYCHAIN_PROVIDER_REGISTRY_KEYS.length ||
    keys.some((key, index) => key !== KEYCHAIN_PROVIDER_REGISTRY_KEYS[index])
  ) {
    throw new Error("Keychain provider registry contains unsupported fields");
  }
  if (
    value.schemaVersion !== KEYCHAIN_PROVIDER_REGISTRY_SCHEMA_VERSION ||
    value.product !== KEYCHAIN_PROVIDER_REGISTRY_PRODUCT ||
    value.owner !== KEYCHAIN_PROVIDER_REGISTRY_OWNER ||
    !Array.isArray(value.providerIds) ||
    value.providerIds.length > MAX_KEYCHAIN_PROVIDER_REGISTRY_ENTRIES
  ) {
    throw new Error("Keychain provider registry has unknown ownership metadata");
  }

  const providerIds = value.providerIds.map((providerId) =>
    providerIdOf(providerId),
  );
  const canonical = [...new Set(providerIds)].sort();
  if (
    canonical.length !== providerIds.length ||
    canonical.some((providerId, index) => providerId !== providerIds[index])
  ) {
    throw new Error(
      "Keychain provider registry providerIds must be unique and sorted",
    );
  }
  return Object.freeze({
    schemaVersion: KEYCHAIN_PROVIDER_REGISTRY_SCHEMA_VERSION,
    product: KEYCHAIN_PROVIDER_REGISTRY_PRODUCT,
    owner: KEYCHAIN_PROVIDER_REGISTRY_OWNER,
    providerIds: Object.freeze(canonical),
  });
}

function emptyKeychainProviderRegistry() {
  return validateKeychainProviderRegistry({
    schemaVersion: KEYCHAIN_PROVIDER_REGISTRY_SCHEMA_VERSION,
    product: KEYCHAIN_PROVIDER_REGISTRY_PRODUCT,
    owner: KEYCHAIN_PROVIDER_REGISTRY_OWNER,
    providerIds: [],
  });
}

function assertPrivateRegistryFile(stats, registryPath) {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(
      `Keychain provider registry must be a regular file: ${registryPath}`,
    );
  }
  assertCurrentUserOwner(stats, registryPath);
  if ((stats.mode & 0o077) !== 0) {
    throw new Error("Keychain provider registry permissions are not private");
  }
  if (stats.size > MAX_KEYCHAIN_PROVIDER_REGISTRY_BYTES) {
    throw new Error("Keychain provider registry exceeds the size limit");
  }
}

function sameRegistryFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function readBoundedRegistryFile(handle) {
  const buffer = Buffer.alloc(MAX_KEYCHAIN_PROVIDER_REGISTRY_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_KEYCHAIN_PROVIDER_REGISTRY_BYTES) {
    throw new Error("Keychain provider registry exceeds the size limit");
  }
  return buffer.subarray(0, offset);
}

async function readKeychainProviderRegistryState(
  registryPath,
  { allowQuarantine = false } = {},
) {
  assertRegistryStoragePath(registryPath, { allowQuarantine });
  const directory = path.dirname(registryPath);
  const directoryStats = await lstatOptional(directory);
  if (directoryStats !== null) {
    assertPrivateRegistryDirectory(directoryStats, directory);
  }

  let handle;
  try {
    handle = await open(registryPath, REGISTRY_READ_FLAGS);
  } catch (error) {
    const confirmedDirectory = await lstatOptional(directory);
    assertRegistryDirectoryUnchanged(
      directoryStats,
      confirmedDirectory,
      directory,
    );
    if (error?.code === "ENOENT") {
      return {
        exists: false,
        raw: null,
        registry: emptyKeychainProviderRegistry(),
      };
    }
    if (error?.code === "ELOOP") {
      throw new Error(
        `Keychain provider registry must be a regular file: ${registryPath}`,
        { cause: error },
      );
    }
    throw error;
  }

  let raw;
  try {
    const stats = await handle.stat();
    const pathStats = await lstat(registryPath);
    assertPrivateRegistryFile(stats, registryPath);
    if (
      pathStats.isSymbolicLink() ||
      !sameRegistryFileIdentity(stats, pathStats)
    ) {
      throw new Error(
        "Keychain provider registry changed while it was being read",
      );
    }
    raw = await readBoundedRegistryFile(handle);
    const confirmed = await handle.stat();
    const confirmedPath = await lstat(registryPath);
    assertPrivateRegistryFile(confirmed, registryPath);
    if (
      confirmedPath.isSymbolicLink() ||
      !sameRegistryFileIdentity(stats, confirmed) ||
      !sameRegistryFileIdentity(confirmed, confirmedPath) ||
      raw.length !== confirmed.size
    ) {
      throw new Error(
        "Keychain provider registry changed while it was being read",
      );
    }
  } finally {
    await handle.close();
  }

  const confirmedDirectory = await lstatOptional(directory);
  assertRegistryDirectoryUnchanged(
    directoryStats,
    confirmedDirectory,
    directory,
  );
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error("Keychain provider registry is invalid JSON", { cause: error });
  }
  return {
    exists: true,
    raw,
    registry: validateKeychainProviderRegistry(parsed),
  };
}

function renderKeychainProviderRegistry(providerIds) {
  const registry = validateKeychainProviderRegistry({
    schemaVersion: KEYCHAIN_PROVIDER_REGISTRY_SCHEMA_VERSION,
    product: KEYCHAIN_PROVIDER_REGISTRY_PRODUCT,
    owner: KEYCHAIN_PROVIDER_REGISTRY_OWNER,
    providerIds,
  });
  const rendered = Buffer.from(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
  if (rendered.length > MAX_KEYCHAIN_PROVIDER_REGISTRY_BYTES) {
    throw new Error("Keychain provider registry exceeds the size limit");
  }
  return rendered;
}

async function assertRegistryUnchanged(registryPath, previous) {
  const current = await readKeychainProviderRegistryState(registryPath);
  if (
    current.exists !== previous.exists ||
    (current.raw !== null && !current.raw.equals(previous.raw))
  ) {
    throw new Error("Keychain provider registry changed concurrently");
  }
}

async function writeKeychainProviderRegistryAtomic(
  registryPath,
  providerIds,
  previous,
) {
  const directory = path.dirname(registryPath);
  await ensurePrivateRegistryDirectory(directory);
  const rendered = renderKeychainProviderRegistry(providerIds);
  const temporary = path.join(
    directory,
    `.${path.basename(registryPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  let created = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    created = true;
    await handle.writeFile(rendered);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await assertRegistryUnchanged(registryPath, previous);
    await rename(temporary, registryPath);
    created = false;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** List exact provider ids only. The registry never stores credential values. */
export async function listRegisteredKeychainProviderIds(options) {
  const registryPath = resolveRegistryPath(options);
  const state = await readKeychainProviderRegistryState(registryPath);
  return Object.freeze([...state.registry.providerIds]);
}

/** Add one exact provider id to the private, canonical registry. */
export async function registerKeychainProvider(provider, options) {
  const providerId = providerIdOf(provider);
  const registryPath = resolveRegistryPath(options);
  const previous = await readKeychainProviderRegistryState(registryPath);
  const providerIds = [...new Set([
    ...previous.registry.providerIds,
    providerId,
  ])].sort();
  const added = !previous.registry.providerIds.includes(providerId);
  if (added) {
    await writeKeychainProviderRegistryAtomic(
      registryPath,
      providerIds,
      previous,
    );
  }
  return Object.freeze({
    providerId,
    added,
    providerIds: Object.freeze(providerIds),
  });
}

/** Remove one exact provider id while preserving a valid empty registry. */
export async function unregisterKeychainProvider(provider, options) {
  const providerId = providerIdOf(provider);
  const registryPath = resolveRegistryPath(options);
  const previous = await readKeychainProviderRegistryState(registryPath);
  const providerIds = previous.registry.providerIds.filter(
    (candidate) => candidate !== providerId,
  );
  const removed = providerIds.length !== previous.registry.providerIds.length;
  if (removed) {
    await writeKeychainProviderRegistryAtomic(
      registryPath,
      providerIds,
      previous,
    );
  }
  return Object.freeze({
    providerId,
    removed,
    providerIds: Object.freeze(providerIds),
  });
}

function canonicalProviderIds(providerIds) {
  if (!Array.isArray(providerIds)) {
    throw new TypeError("expectedProviderIds must be an array");
  }
  const canonical = [...new Set(providerIds.map((providerId) =>
    providerIdOf(providerId),
  ))].sort();
  if (canonical.length !== providerIds.length) {
    throw new Error("expectedProviderIds must be unique");
  }
  return canonical;
}

function sameProviderIds(left, right) {
  return left.length === right.length && left.every(
    (providerId, index) => providerId === right[index],
  );
}

function sameRegistryState(left, right, expectedProviderIds) {
  return (
    left.exists &&
    right.exists &&
    left.raw.equals(right.raw) &&
    sameProviderIds(right.registry.providerIds, expectedProviderIds)
  );
}

/**
 * Remove only a validated registry whose exact provider ids were inventoried
 * before purge started. The file is detached and revalidated before deletion
 * so a concurrent replacement is restored rather than treated as owned state.
 */
export async function purgeKeychainProviderRegistry({
  registryPath: configuredRegistryPath,
  expectedProviderIds = [],
  beforeCommit = async () => undefined,
  renameImpl = rename,
  unlinkImpl = unlink,
} = {}) {
  if (
    typeof beforeCommit !== "function" ||
    typeof renameImpl !== "function" ||
    typeof unlinkImpl !== "function"
  ) {
    throw new TypeError("Keychain provider registry purge dependencies must be functions");
  }
  const registryPath = resolveRegistryPath(configuredRegistryPath);
  const expected = canonicalProviderIds(expectedProviderIds);
  const initial = await readKeychainProviderRegistryState(registryPath);
  if (!sameProviderIds(initial.registry.providerIds, expected)) {
    throw new Error("Keychain provider registry changed before purge");
  }
  if (!initial.exists) {
    await beforeCommit();
    return Object.freeze({
      changed: false,
      providerIds: Object.freeze([]),
      cleanupPendingPath: null,
    });
  }

  const quarantinePath = path.join(
    path.dirname(registryPath),
    `.${path.basename(registryPath)}.purge.${process.pid}.${randomBytes(8).toString("hex")}.staging`,
  );
  if (await lstatOptional(quarantinePath)) {
    throw new Error("Keychain provider registry purge quarantine already exists");
  }
  await renameImpl(registryPath, quarantinePath);
  try {
    const staged = await readKeychainProviderRegistryState(quarantinePath, {
      allowQuarantine: true,
    });
    if (!sameRegistryState(initial, staged, expected)) {
      throw new Error("Keychain provider registry changed during purge");
    }
    await beforeCommit();
  } catch (error) {
    let staged;
    try {
      staged = await readKeychainProviderRegistryState(quarantinePath, {
        allowQuarantine: true,
      });
    } catch {
      // An unsafe quarantine is retained for manual inspection.
    }
    if (
      await lstatOptional(registryPath) ||
      !staged ||
      !sameRegistryState(initial, staged, expected)
    ) {
      const combined = new Error(
        "Keychain provider registry changed during purge and could not be restored safely",
        { cause: error },
      );
      combined.cleanupPendingPath = quarantinePath;
      throw combined;
    }
    await renameImpl(quarantinePath, registryPath);
    throw error;
  }

  let cleanupPendingPath = null;
  try {
    const committed = await readKeychainProviderRegistryState(quarantinePath, {
      allowQuarantine: true,
    });
    if (sameRegistryState(initial, committed, expected)) {
      await unlinkImpl(quarantinePath);
    }
  } catch {
    // The validated registry is already detached from active state.
  }
  if (await lstatOptional(quarantinePath)) cleanupPendingPath = quarantinePath;
  return Object.freeze({
    changed: true,
    providerIds: Object.freeze(expected),
    cleanupPendingPath,
  });
}

function credentialSource(provider) {
  if (provider?.credentialEnv) return "environment";
  if (provider?.credentialKeychain === true) return "keychain";
  return "none";
}

function defaultExecFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFileCallback(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function defaultInteractiveExec(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnChild(file, args, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve({});
        return;
      }
      const error = new Error("Interactive credential command failed");
      error.code = code;
      error.signal = signal;
      reject(error);
    });
  });
}

function isMissingKeychainItem(error) {
  return error?.code === 44 || error?.code === "44";
}

function sanitizedCredentialError(
  providerId,
  operation,
  source = "keychain",
  safeReference,
) {
  const message = source === "environment" && safeReference
    ? `Provider ${providerId} requires environment variable ${safeReference}`
    : `Provider credential ${operation} failed for ${providerId} (${source})`;
  const error = new Error(message);
  error.name = "ProviderCredentialError";
  error.code = "PROVIDER_CREDENTIAL_ERROR";
  error.providerId = providerId;
  error.source = source;
  return error;
}

function validateLookupTimeoutMs(timeoutMs) {
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > MAX_CREDENTIAL_LOOKUP_TIMEOUT_MS
  ) {
    throw new TypeError(
      `Credential lookup timeoutMs must be between 1 and ${MAX_CREDENTIAL_LOOKUP_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

/**
 * Bound both the real child process and injected implementations. The native
 * exec timeout kills `/usr/bin/security`; the Promise deadline also protects
 * callers when a substitute ignores the exec options or never settles.
 */
async function runBoundedLookup(
  execFileImpl,
  args,
  options,
  timeoutMs,
) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error("Credential lookup deadline exceeded");
      error.code = "ETIMEDOUT";
      reject(error);
    }, timeoutMs);
  });
  const lookup = Promise.resolve().then(() => execFileImpl(
    KEYCHAIN_SECURITY_PATH,
    args,
    {
      ...options,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    },
  ));
  try {
    return await Promise.race([lookup, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

/** Stable, non-secret Keychain coordinates derived only from the provider id. */
export function keychainReferenceForProvider(provider) {
  const providerId = providerIdOf(provider);
  return Object.freeze({
    service: `${KEYCHAIN_SERVICE_PREFIX}.${providerId}`,
    account: providerId,
  });
}

async function readKeychainCredential(provider, execFileImpl, lookupTimeoutMs) {
  const providerId = providerIdOf(provider);
  const reference = keychainReferenceForProvider(providerId);
  try {
    const result = await runBoundedLookup(
      execFileImpl,
      [
        "find-generic-password",
        "-s",
        reference.service,
        "-a",
        reference.account,
        "-w",
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
      lookupTimeoutMs,
    );
    const value = typeof result === "string" ? result : result?.stdout;
    const credential = typeof value === "string" ? value.replace(/[\r\n]+$/u, "") : "";
    if (!credential.trim()) {
      throw sanitizedCredentialError(providerId, "lookup");
    }
    return credential;
  } catch (error) {
    if (error?.name === "ProviderCredentialError") throw error;
    throw sanitizedCredentialError(providerId, "lookup");
  }
}

/**
 * Resolve environment or Keychain credentials through one async interface.
 * Successful values are cached only in memory for a bounded TTL. Errors never
 * expose subprocess output, argv, or credential contents.
 */
export function createCredentialResolver({
  environment = process.env,
  execFileImpl = defaultExecFile,
  ttlMs = DEFAULT_CREDENTIAL_CACHE_TTL_MS,
  lookupTimeoutMs = DEFAULT_CREDENTIAL_LOOKUP_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0 || ttlMs > 60 * 60_000) {
    throw new TypeError("Credential cache ttlMs must be between 0 and 3600000");
  }
  if (typeof execFileImpl !== "function" || typeof now !== "function") {
    throw new TypeError("Credential resolver dependencies must be functions");
  }
  validateLookupTimeoutMs(lookupTimeoutMs);

  const cache = new Map();
  const pending = new Map();

  async function resolve(provider) {
    const source = credentialSource(provider);
    if (source === "none") return undefined;
    const providerId = providerIdOf(provider);
    const cacheKey = source === "environment"
      ? `${source}:${providerId}:${provider.credentialEnv}`
      : `${source}:${providerId}`;
    const cached = cache.get(cacheKey);
    const currentTime = now();
    if (cached && cached.expiresAt > currentTime) return cached.value;
    if (pending.has(cacheKey)) return pending.get(cacheKey);

    const lookup = (async () => {
      let value;
      if (source === "environment") {
        value = environment[provider.credentialEnv];
        if (typeof value !== "string" || !value.trim()) {
          throw sanitizedCredentialError(
            providerId,
            "lookup",
            source,
            provider.credentialEnv,
          );
        }
      } else {
        value = await readKeychainCredential(
          provider,
          execFileImpl,
          lookupTimeoutMs,
        );
      }
      if (ttlMs > 0) {
        cache.set(cacheKey, { value, expiresAt: now() + ttlMs });
      }
      return value;
    })();
    pending.set(cacheKey, lookup);
    try {
      return await lookup;
    } finally {
      pending.delete(cacheKey);
    }
  }

  resolve.clear = (provider) => {
    if (provider === undefined) {
      cache.clear();
      return;
    }
    const providerId = providerIdOf(provider);
    for (const key of cache.keys()) {
      if (key.startsWith(`environment:${providerId}:`) || key === `keychain:${providerId}`) {
        cache.delete(key);
      }
    }
  };
  return resolve;
}

/** Report only availability and source; never return a credential value. */
export async function providerCredentialStatus(provider, {
  environment = process.env,
  execFileImpl = defaultExecFile,
  lookupTimeoutMs = DEFAULT_CREDENTIAL_LOOKUP_TIMEOUT_MS,
} = {}) {
  validateLookupTimeoutMs(lookupTimeoutMs);
  const providerId = providerIdOf(provider);
  const source = credentialSource(provider);
  if (source === "none") {
    return Object.freeze({ providerId, source, configured: false, available: false });
  }
  if (source === "environment") {
    const value = environment[provider.credentialEnv];
    return Object.freeze({
      providerId,
      source,
      configured: true,
      available: typeof value === "string" && Boolean(value.trim()),
    });
  }

  const reference = keychainReferenceForProvider(providerId);
  try {
    await runBoundedLookup(
      execFileImpl,
      ["find-generic-password", "-s", reference.service, "-a", reference.account],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
      lookupTimeoutMs,
    );
    return Object.freeze({ providerId, source, configured: true, available: true });
  } catch (error) {
    if (isMissingKeychainItem(error)) {
      return Object.freeze({ providerId, source, configured: true, available: false });
    }
    throw sanitizedCredentialError(providerId, "status");
  }
}

/**
 * Prompt through macOS `security` itself. `-w` deliberately remains the final
 * argv item so the secret is read interactively via inherited stdio.
 */
export async function setProviderCredential(provider, {
  execFileImpl = defaultInteractiveExec,
} = {}) {
  const providerId = providerIdOf(provider);
  const reference = keychainReferenceForProvider(providerId);
  try {
    await execFileImpl(
      KEYCHAIN_SECURITY_PATH,
      [
        "add-generic-password",
        "-U",
        "-s",
        reference.service,
        "-a",
        reference.account,
        "-w",
      ],
      { stdio: "inherit" },
    );
  } catch {
    throw sanitizedCredentialError(providerId, "set");
  }
}

export async function deleteProviderCredential(provider, {
  execFileImpl = defaultInteractiveExec,
} = {}) {
  const providerId = providerIdOf(provider);
  const reference = keychainReferenceForProvider(providerId);
  try {
    await execFileImpl(
      KEYCHAIN_SECURITY_PATH,
      ["delete-generic-password", "-s", reference.service, "-a", reference.account],
      { stdio: "inherit" },
    );
  } catch (error) {
    if (isMissingKeychainItem(error)) return false;
    throw sanitizedCredentialError(providerId, "delete");
  }
  return true;
}
