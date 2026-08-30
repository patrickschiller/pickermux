const DEFAULT_TIMEOUT_MS = 5_000;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

class DiscoveryHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "DiscoveryHttpError";
    this.status = status;
  }
}

/**
 * A transport state that is authoritative enough for loaded-model discovery.
 * The bridge currently recognizes only a locally refused connection as proof
 * that LM Studio is not serving any loaded models.
 */
export class DiscoveryUnavailableError extends Error {
  constructor(message, reason, options = undefined) {
    super(message, options);
    this.name = "DiscoveryUnavailableError";
    this.reason = reason;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function transportLeafCodes(error) {
  const seen = new Set();
  const codes = [];

  const visit = (value) => {
    if (value === null || typeof value !== "object") {
      codes.push(undefined);
      return;
    }
    if (seen.has(value)) {
      codes.push(undefined);
      return;
    }
    seen.add(value);

    const children = [];
    if (value.cause !== null && typeof value.cause === "object") {
      children.push(value.cause);
    }
    if (Array.isArray(value.errors)) {
      children.push(...value.errors);
    }
    if (children.length === 0) {
      codes.push(typeof value.code === "string" ? value.code : undefined);
      return;
    }
    for (const child of children) visit(child);
  };

  visit(error);
  return codes;
}

function isConnectionRefused(error) {
  const codes = transportLeafCodes(error);
  return codes.length > 0 && codes.every((code) => code === "ECONNREFUSED");
}

export function validLoadedModelId(value) {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value !== "" &&
    value !== "*" &&
    !/[\s\u0000-\u001f\u007f]/u.test(value)
  );
}

function normalizeAllowlist(allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    throw new Error("LM Studio discovery requires a non-empty explicit allowlist");
  }

  const seen = new Set();
  return allowlist.map((entry, index) => {
    const normalized =
      typeof entry === "string"
        ? { id: entry.trim() }
        : isPlainObject(entry)
          ? {
              id: String(entry.id ?? "").trim(),
              displayName:
                entry.displayName === undefined
                  ? undefined
                  : String(entry.displayName).trim(),
              type: entry.type === undefined ? undefined : String(entry.type),
              contextWindow: entry.contextWindow,
            }
          : null;

    if (!normalized?.id || /[\r\n]/u.test(normalized.id)) {
      throw new Error(`allowlist[${index}] must contain a non-empty model id`);
    }
    if (normalized.id === "*") {
      throw new Error("Wildcard model allowlists are not supported");
    }
    if (seen.has(normalized.id)) {
      throw new Error(`Duplicate allowlisted model id: ${normalized.id}`);
    }
    if (
      normalized.displayName !== undefined &&
      (!normalized.displayName || /[\r\n]/u.test(normalized.displayName))
    ) {
      throw new Error(`allowlist[${index}].displayName must be a single line`);
    }
    if (
      normalized.contextWindow !== undefined &&
      !positiveInteger(normalized.contextWindow)
    ) {
      throw new Error(
        `allowlist[${index}].contextWindow must be a positive integer`,
      );
    }

    seen.add(normalized.id);
    return normalized;
  });
}

/**
 * Normalize a user-facing LM Studio endpoint to its fixed REST and OpenAI bases.
 * LM Studio exposes /api/v1 at the origin, not below the OpenAI-compatible /v1.
 */
export function normalizeLmStudioBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error("LM Studio base URL is invalid");
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("LM Studio base URL must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("LM Studio base URL must not contain credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("LM Studio base URL must not contain a query or fragment");
  }

  const pathname = parsed.pathname.replace(/\/+$/u, "");
  if (pathname && pathname !== "/v1") {
    throw new Error("LM Studio base URL path must be / or /v1");
  }

  const origin = parsed.origin;
  return {
    origin,
    apiBaseUrl: `${origin}/v1`,
    metadataBaseUrl: `${origin}/api/v1`,
    metadataUrl: `${origin}/api/v1/models`,
    modelsUrl: `${origin}/v1/models`,
  };
}

async function requestJson({
  fetchImpl,
  url,
  label,
  apiToken,
  timeoutMs,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  const headers = { accept: "application/json" };
  if (apiToken) {
    headers.authorization = `Bearer ${apiToken}`;
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out`, { cause: error });
    }
    if (isConnectionRefused(error)) {
      throw new DiscoveryUnavailableError(
        `${label} is unavailable`,
        "connection-refused",
        { cause: error },
      );
    }
    throw new Error(`${label} request failed`, { cause: error });
  }

  if (!response?.ok) {
    clearTimeout(timeout);
    const status = Number(response?.status) || 0;
    throw new DiscoveryHttpError(`${label} returned HTTP ${status}`, status);
  }

  try {
    return await response.json();
  } catch {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out`);
    }
    throw new Error(`${label} returned invalid JSON`);
  } finally {
    clearTimeout(timeout);
  }
}

function nativeModel(model, allowlisted) {
  if (!isPlainObject(model) || model.key !== allowlisted.id) {
    return null;
  }
  if (model.type !== "llm") {
    return { skipped: "not-an-llm" };
  }

  const loadedInstances = Array.isArray(model.loaded_instances)
    ? model.loaded_instances
    : [];
  if (loadedInstances.length === 0) {
    return { skipped: "not-loaded" };
  }
  const contextLengths = loadedInstances.map(
    (instance) => instance?.config?.context_length,
  );
  if (contextLengths.some((contextLength) => !positiveInteger(contextLength))) {
    return { skipped: "loaded-context-not-confirmed" };
  }

  const capabilities = isPlainObject(model.capabilities)
    ? model.capabilities
    : {};
  const reasoning = isPlainObject(capabilities.reasoning)
    ? capabilities.reasoning
    : {};

  const reasoningOptions = Array.isArray(reasoning.allowed_options)
    ? reasoning.allowed_options.filter((option) => typeof option === "string")
    : [];
  const reasoningDefault =
    typeof reasoning.default === "string"
      ? reasoning.default
      : typeof reasoning.default_option === "string"
        ? reasoning.default_option
        : undefined;
  const parsed = {
    id: allowlisted.id,
    displayName:
      allowlisted.displayName ||
      (typeof model.display_name === "string" && model.display_name.trim()) ||
      allowlisted.id,
    type: "llm",
    loaded: true,
    // Multiple loaded instances may differ. The minimum is the safe promise.
    contextWindow: Math.min(...contextLengths),
    source: "lmstudio-rest",
    capabilities: {
      trainedForToolUse: capabilities.trained_for_tool_use === true,
      vision: capabilities.vision === true,
      reasoningOptions,
    },
  };
  if (reasoningDefault !== undefined) {
    parsed.capabilities.reasoningDefault = reasoningDefault;
  }
  return parsed;
}

function groupNativeModels(payload) {
  const byId = new Map();
  for (const model of payload.models) {
    if (!isPlainObject(model) || typeof model.key !== "string") continue;
    const existing = byId.get(model.key);
    if (existing) existing.push(model);
    else byId.set(model.key, [model]);
  }
  return byId;
}

function mergeNativeModelRecords(records) {
  if (records.length === 1) return { model: records[0] };
  const referenceType = records[0].type;
  const referenceCapabilities = JSON.stringify(records[0].capabilities ?? null);
  if (
    records.some(
      (record) =>
        record.type !== referenceType ||
        JSON.stringify(record.capabilities ?? null) !== referenceCapabilities,
    )
  ) {
    return { skipped: "inconsistent-model-metadata" };
  }
  return {
    model: {
      ...records[0],
      // Duplicate top-level metadata must not let the first record over-promise
      // its context. Treat every reported loaded instance as a possible target.
      loaded_instances: records.flatMap((record) =>
        Array.isArray(record.loaded_instances) ? record.loaded_instances : [],
      ),
    },
  };
}

function parseNativeModels(payload, allowlist) {
  if (!isPlainObject(payload) || !Array.isArray(payload.models)) {
    throw new Error("LM Studio metadata returned an unexpected response shape");
  }

  const byId = groupNativeModels(payload);
  const models = [];
  const skipped = [];

  for (const allowed of allowlist) {
    const records = byId.get(allowed.id);
    if (!records) {
      skipped.push({ id: allowed.id, reason: "not-found" });
      continue;
    }
    const merged = mergeNativeModelRecords(records);
    if (merged.skipped) {
      skipped.push({ id: allowed.id, reason: merged.skipped });
      continue;
    }
    const parsed = nativeModel(merged.model, allowed);
    if (parsed?.skipped) {
      skipped.push({ id: allowed.id, reason: parsed.skipped });
      continue;
    }
    if (parsed) {
      models.push(parsed);
    }
  }

  return { models, skipped };
}

function compareModelIds(left, right) {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function parseLoadedNativeModels(payload, overrides, maxModels) {
  if (!isPlainObject(payload) || !Array.isArray(payload.models)) {
    throw new Error("LM Studio metadata returned an unexpected response shape");
  }

  const overrideById = new Map(overrides.map((entry) => [entry.id, entry]));
  const discoveredById = new Map();
  const skipped = [];
  const seenInvalidOrExcluded = new Set();

  const grouped = groupNativeModels(payload);
  for (const raw of payload.models) {
    const rawId = isPlainObject(raw) ? raw.key : undefined;
    if (!validLoadedModelId(rawId)) {
      skipped.push({
        id: typeof rawId === "string" && rawId ? rawId : "<invalid>",
        reason: "invalid-id",
      });
    }
  }

  for (const [rawId, records] of grouped) {
    if (!validLoadedModelId(rawId)) continue;

    const merged = mergeNativeModelRecords(records);
    if (merged.skipped) {
      skipped.push({ id: rawId, reason: merged.skipped });
      seenInvalidOrExcluded.add(rawId);
      continue;
    }
    const parsed = nativeModel(
      merged.model,
      overrideById.get(rawId) ?? { id: rawId },
    );
    if (parsed?.skipped) {
      if (!seenInvalidOrExcluded.has(rawId)) {
        skipped.push({ id: rawId, reason: parsed.skipped });
        seenInvalidOrExcluded.add(rawId);
      }
      continue;
    }
    if (parsed) discoveredById.set(rawId, parsed);
  }

  const models = [];
  for (const override of overrides) {
    const discovered = discoveredById.get(override.id);
    if (discovered) {
      models.push(discovered);
      discoveredById.delete(override.id);
    } else if (!seenInvalidOrExcluded.has(override.id)) {
      skipped.push({ id: override.id, reason: "not-found" });
    }
  }
  models.push(...[...discoveredById.values()].sort(compareModelIds));

  if (models.length > maxModels) {
    throw new Error(
      `LM Studio loaded discovery found ${models.length} publishable models, exceeding maxModels ${maxModels}`,
    );
  }
  return { models, skipped };
}

function parseOpenAiCompatibleModels(payload, allowlist) {
  if (!isPlainObject(payload) || !Array.isArray(payload.data)) {
    throw new Error("LM Studio /v1/models returned an unexpected response shape");
  }

  const available = new Set(
    payload.data
      .map((model) => model?.id)
      .filter((id) => typeof id === "string"),
  );
  const models = [];
  const skipped = [];

  for (const allowed of allowlist) {
    if (!available.has(allowed.id)) {
      skipped.push({ id: allowed.id, reason: "not-found" });
      continue;
    }
    if (allowed.type !== "llm") {
      skipped.push({ id: allowed.id, reason: "type-not-confirmed-as-llm" });
      continue;
    }
    if (!positiveInteger(allowed.contextWindow)) {
      skipped.push({ id: allowed.id, reason: "loaded-context-not-confirmed" });
      continue;
    }

    models.push({
      id: allowed.id,
      displayName: allowed.displayName || allowed.id,
      type: "llm",
      loaded: true,
      contextWindow: allowed.contextWindow,
      source: "openai-compatible-fallback",
      capabilities: {
        trainedForToolUse: false,
        vision: false,
        reasoningOptions: [],
      },
    });
  }

  return { models, skipped };
}

/** Discover either the allowlist or every loaded LLM from one LM Studio server. */
export async function discoverLmStudio({
  baseUrl,
  allowlist,
  discovery,
  apiToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A Fetch API implementation is required");
  }
  if (!positiveInteger(timeoutMs)) {
    throw new Error("Discovery timeout must be a positive integer");
  }

  const endpoints = normalizeLmStudioBaseUrl(baseUrl);
  const mode = discovery?.mode ?? "allowlist";
  if (mode !== "allowlist" && mode !== "loaded") {
    throw new Error("LM Studio discovery mode must be allowlist or loaded");
  }
  const maxModels = discovery?.maxModels ?? 64;
  if (!Number.isSafeInteger(maxModels) || maxModels < 1 || maxModels > 64) {
    throw new Error("LM Studio discovery maxModels must be an integer between 1 and 64");
  }
  const allowed =
    mode === "loaded"
      ? Array.isArray(allowlist) && allowlist.length > 0
        ? normalizeAllowlist(allowlist)
        : []
      : normalizeAllowlist(allowlist);
  let parsed;
  let source;

  try {
    const nativePayload = await requestJson({
      fetchImpl,
      url: endpoints.metadataUrl,
      label: "LM Studio metadata discovery",
      apiToken,
      timeoutMs,
    });
    parsed =
      mode === "loaded"
        ? parseLoadedNativeModels(nativePayload, allowed, maxModels)
        : parseNativeModels(nativePayload, allowed);
    source = "lmstudio-rest";
  } catch (error) {
    if (mode === "loaded") throw error;
    if (
      error instanceof DiscoveryHttpError &&
      (error.status === 401 || error.status === 403)
    ) {
      throw error;
    }

    const fallbackPayload = await requestJson({
      fetchImpl,
      url: endpoints.modelsUrl,
      label: "LM Studio OpenAI-compatible discovery",
      apiToken,
      timeoutMs,
    });
    parsed = parseOpenAiCompatibleModels(fallbackPayload, allowed);
    source = "openai-compatible-fallback";
  }

  if (parsed.models.length === 0 && mode !== "loaded") {
    const fallbackHint =
      source === "openai-compatible-fallback"
        ? "; fallback discovery requires allowlist type=llm and contextWindow"
        : "; allowlisted models must be type=llm and currently loaded";
    throw new Error(`No publishable allowlisted LM Studio models${fallbackHint}`);
  }

  return {
    baseUrl: endpoints.apiBaseUrl,
    apiBaseUrl: endpoints.apiBaseUrl,
    metadataBaseUrl: endpoints.metadataBaseUrl,
    metadataUrl: endpoints.metadataUrl,
    modelsUrl: endpoints.modelsUrl,
    source,
    models: parsed.models,
    skipped: parsed.skipped,
  };
}
