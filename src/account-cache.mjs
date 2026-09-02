import {
  loadCachedNativeCatalog,
  loadCodexClientVersion,
} from "./catalog.mjs";

export const CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED =
  "CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED";

export class CodexAccountCacheRefreshRequiredError extends Error {
  constructor({ codexClientVersion, cause } = {}) {
    super(
      `Codex account model cache refresh is required for client ${codexClientVersion}`,
      { cause },
    );
    this.name = "CodexAccountCacheRefreshRequiredError";
    this.code = CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED;
    this.codexClientVersion = codexClientVersion;
  }
}

/**
 * Read and validate Codex's account-scoped model cache without changing either
 * Codex or PickerMux state. Supplying the already observed client version lets
 * callers bind this inspection to another compatibility check in the same run.
 */
export async function inspectCodexAccountCache({
  codexHome,
  codexPath,
  codexClientVersion,
  clientVersionImpl = loadCodexClientVersion,
  cacheImpl = loadCachedNativeCatalog,
} = {}) {
  if (typeof clientVersionImpl !== "function" || typeof cacheImpl !== "function") {
    throw new TypeError("Account cache inspection dependencies must be functions");
  }
  const currentClientVersion = codexClientVersion === undefined
    ? await clientVersionImpl({ codexPath })
    : codexClientVersion;
  if (typeof currentClientVersion !== "string" || !currentClientVersion.trim()) {
    throw new Error("Codex client version must be a non-empty string");
  }

  let account;
  try {
    account = await cacheImpl({
      codexHome,
      expectedClientVersion: currentClientVersion,
    });
  } catch (cause) {
    throw new CodexAccountCacheRefreshRequiredError({
      codexClientVersion: currentClientVersion,
      cause,
    });
  }

  return {
    ready: true,
    status: "ready",
    codexClientVersion: currentClientVersion,
    cacheClientVersion: account.clientVersion,
    fetchedAt: account.fetchedAt ?? null,
    ageMs: account.ageMs ?? null,
    warning: account.warning ?? null,
    source: account.source,
    catalog: account.catalog,
  };
}
