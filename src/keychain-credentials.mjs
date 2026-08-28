import {
  execFile as execFileCallback,
  spawn as spawnChild,
} from "node:child_process";

export const KEYCHAIN_SECURITY_PATH = "/usr/bin/security";
export const KEYCHAIN_SERVICE_PREFIX =
  "com.local.codex-model-bridge.provider";
export const DEFAULT_CREDENTIAL_CACHE_TTL_MS = 30_000;
export const DEFAULT_CREDENTIAL_LOOKUP_TIMEOUT_MS = 5_000;

const MAX_CREDENTIAL_LOOKUP_TIMEOUT_MS = 60_000;

const PROVIDER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;

function providerIdOf(provider) {
  const providerId =
    typeof provider === "string"
      ? provider
      : provider?.providerId ?? provider?.id;
  if (typeof providerId !== "string" || !PROVIDER_ID_PATTERN.test(providerId)) {
    throw new TypeError("Provider id is not valid for credential lookup");
  }
  return providerId;
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
