import { readFile } from "node:fs/promises";
import { isIP } from "node:net";

import { isValidProviderId } from "./provider-id.mjs";

export const BRIDGE_SCHEMA_VERSION = 2;

export const BRIDGE_DEFAULTS = Object.freeze({
  host: "127.0.0.1",
  port: 4210,
  providerId: "model_bridge",
  defaultModel: "gpt-5.6-sol",
  reasoningEffort: "ultra",
  limits: Object.freeze({
    requestBodyBytes: 8 * 1024 * 1024,
    responseHeaderBytes: 64 * 1024,
    upstreamHeadersTimeoutMs: 60_000,
    streamIdleTimeoutMs: 5 * 60_000,
    upstreamTotalTimeoutMs: 15 * 60_000,
  }),
});

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "bridge", "providers"]);
const BRIDGE_KEYS = new Set([
  "host",
  "port",
  "providerId",
  "defaultModel",
  "reasoningEffort",
  "limits",
]);
const LIMIT_KEYS = new Set(Object.keys(BRIDGE_DEFAULTS.limits));
const PROVIDER_KEYS = new Set([
  "id",
  "kind",
  "baseUrl",
  "allowPrivateNetwork",
  "credentialEnv",
  "credentialKeychain",
  "discovery",
  "models",
]);
const DISCOVERY_KEYS = new Set(["mode", "maxModels"]);
const MODEL_KEYS = new Set([
  "id",
  "slug",
  "displayName",
  "type",
  "contextWindow",
  "reasoningEffort",
  "reasoningEfforts",
]);
const NATIVE_MODEL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SUPPORTED_PROVIDER_KINDS = new Set([
  "lmstudio-responses",
  "openai-responses",
]);
const SUPPORTED_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const LM_STUDIO_RESPONSES_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const DEFAULT_DISCOVERY = Object.freeze({ mode: "allowlist", maxModels: 64 });

const LIMIT_RANGES = Object.freeze({
  requestBodyBytes: [1_024, 64 * 1024 * 1024],
  responseHeaderBytes: [1_024, 1024 * 1024],
  upstreamHeadersTimeoutMs: [1_000, 60 * 60_000],
  streamIdleTimeoutMs: [1_000, 60 * 60_000],
  upstreamTotalTimeoutMs: [1_000, 24 * 60 * 60_000],
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unsupported property ${key}`);
    }
  }
}

function requireSingleLine(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a non-empty single line`);
  }
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label} must be a non-empty single line`);
  }
  return normalized;
}

function normalizeLimits(input) {
  if (input === undefined) {
    return { ...BRIDGE_DEFAULTS.limits };
  }
  assertPlainObject(input, "bridge.limits");
  assertOnlyKeys(input, LIMIT_KEYS, "bridge.limits");

  const limits = { ...BRIDGE_DEFAULTS.limits };
  for (const [name, value] of Object.entries(input)) {
    const [minimum, maximum] = LIMIT_RANGES[name];
    if (
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > maximum
    ) {
      throw new Error(
        `bridge.limits.${name} must be an integer between ${minimum} and ${maximum}`,
      );
    }
    limits[name] = value;
  }
  if (limits.upstreamTotalTimeoutMs < limits.upstreamHeadersTimeoutMs) {
    throw new Error(
      "bridge.limits.upstreamTotalTimeoutMs must not be shorter than upstreamHeadersTimeoutMs",
    );
  }
  return limits;
}

function normalizeBridge(input) {
  assertPlainObject(input, "bridge");
  assertOnlyKeys(input, BRIDGE_KEYS, "bridge");

  const host = input.host ?? BRIDGE_DEFAULTS.host;
  if (host !== BRIDGE_DEFAULTS.host) {
    throw new Error("bridge.host must be exactly 127.0.0.1");
  }

  const port = input.port ?? BRIDGE_DEFAULTS.port;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("bridge.port must be an integer between 1 and 65535");
  }

  const providerId = input.providerId ?? BRIDGE_DEFAULTS.providerId;
  if (providerId !== BRIDGE_DEFAULTS.providerId) {
    throw new Error("bridge.providerId must be exactly model_bridge");
  }

  const defaultModel = requireSingleLine(
    input.defaultModel ?? BRIDGE_DEFAULTS.defaultModel,
    "bridge.defaultModel",
  );
  if (!NATIVE_MODEL_ID_PATTERN.test(defaultModel)) {
    throw new Error(
      "bridge.defaultModel must be a native model id without a provider namespace",
    );
  }

  const reasoningEffort = requireSingleLine(
    input.reasoningEffort ?? BRIDGE_DEFAULTS.reasoningEffort,
    "bridge.reasoningEffort",
  );
  if (!SUPPORTED_REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error("bridge.reasoningEffort is not supported");
  }

  return {
    host,
    port,
    providerId,
    defaultModel,
    reasoningEffort,
    limits: normalizeLimits(input.limits),
  };
}

function parseIpv4(hostname) {
  if (isIP(hostname) !== 4) return null;
  const octets = hostname.split(".").map(Number);
  return octets.length === 4 ? octets : null;
}

/**
 * Lexical classification for static configuration validation. Runtime DNS and
 * redirect checks remain the proxy's responsibility.
 */
export function isPrivateNetworkHost(value) {
  if (typeof value !== "string") return false;
  const hostname = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  if (!hostname || hostname === "0.0.0.0" || hostname === "::") return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;

  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    const [a, b] = ipv4;
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  if (isIP(hostname) === 6) {
    return (
      hostname === "::1" ||
      hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      /^fe[89ab]/u.test(hostname)
    );
  }

  // Single-label and explicitly local DNS suffixes are private only after the
  // operator also opts in through allowPrivateNetwork.
  return (
    !hostname.includes(".") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    hostname.endsWith(".ts.net")
  );
}

function normalizeProviderBaseUrl(value, allowPrivateNetwork, label) {
  const raw = requireSingleLine(value, label);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute HTTP or HTTPS URL`);
  }

  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain URL credentials`);
  }
  if (url.search || url.hash) {
    throw new Error(`${label} must not contain a query string or fragment`);
  }
  if (!url.hostname) {
    throw new Error(`${label} must contain a host`);
  }

  const privateHost = isPrivateNetworkHost(url.hostname);
  if (privateHost && allowPrivateNetwork !== true) {
    throw new Error(
      `${label} targets a private network; set allowPrivateNetwork to true explicitly`,
    );
  }
  if (url.protocol === "http:" && !privateHost) {
    throw new Error(`${label} must use HTTPS for a public provider`);
  }
  if (url.protocol === "http:" && allowPrivateNetwork !== true) {
    throw new Error(`${label} permits private HTTP only with allowPrivateNetwork`);
  }

  return url.toString().replace(/\/+$/u, "");
}

function normalizeModel(input, providerId, providerKind, index, seenIds, seenSlugs) {
  const label = `providers[${providerId}].models[${index}]`;
  assertPlainObject(input, label);
  assertOnlyKeys(input, MODEL_KEYS, label);

  const id = requireSingleLine(input.id, `${label}.id`);
  if (seenIds.has(id)) {
    throw new Error(`Duplicate upstream model id ${id} for provider ${providerId}`);
  }

  const slug = requireSingleLine(input.slug, `${label}.slug`);
  const prefix = `${providerId}/`;
  if (!slug.startsWith(prefix) || slug.length === prefix.length) {
    throw new Error(`${label}.slug must start with ${prefix}`);
  }
  if (/\s/u.test(slug)) {
    throw new Error(`${label}.slug must not contain whitespace`);
  }
  if (seenSlugs.has(slug)) {
    throw new Error(`Duplicate external model slug: ${slug}`);
  }

  const displayName = requireSingleLine(
    input.displayName,
    `${label}.displayName`,
  );
  const normalized = { id, slug, displayName };

  if (input.type !== undefined) {
    if (input.type !== "llm") {
      throw new Error(`${label}.type must be llm when supplied`);
    }
    normalized.type = input.type;
  }

  if (input.contextWindow !== undefined) {
    if (
      !Number.isSafeInteger(input.contextWindow) ||
      input.contextWindow <= 0
    ) {
      throw new Error(`${label}.contextWindow must be a positive integer`);
    }
    normalized.contextWindow = input.contextWindow;
  }

  const supportedReasoningEfforts =
    providerKind === "lmstudio-responses"
      ? LM_STUDIO_RESPONSES_REASONING_EFFORTS
      : SUPPORTED_REASONING_EFFORTS;
  if (input.reasoningEffort !== undefined) {
    if (!supportedReasoningEfforts.has(input.reasoningEffort)) {
      throw new Error(`${label}.reasoningEffort is not supported`);
    }
    normalized.reasoningEffort = input.reasoningEffort;
  }

  if (input.reasoningEfforts !== undefined) {
    if (!Array.isArray(input.reasoningEfforts) || input.reasoningEfforts.length === 0) {
      throw new Error(`${label}.reasoningEfforts must contain at least one effort`);
    }
    const efforts = input.reasoningEfforts.map((effort, effortIndex) => {
      if (!supportedReasoningEfforts.has(effort)) {
        throw new Error(`${label}.reasoningEfforts[${effortIndex}] is not supported`);
      }
      return effort;
    });
    if (new Set(efforts).size !== efforts.length) {
      throw new Error(`${label}.reasoningEfforts must not contain duplicates`);
    }
    if (
      normalized.reasoningEffort !== undefined &&
      !efforts.includes(normalized.reasoningEffort)
    ) {
      throw new Error(`${label}.reasoningEffort must be included in reasoningEfforts`);
    }
    if (normalized.reasoningEffort === undefined) {
      normalized.reasoningEffort = efforts[0];
    }
    normalized.reasoningEfforts = efforts;
  }

  seenIds.add(id);
  seenSlugs.add(slug);
  return normalized;
}

function normalizeDiscovery(input, providerKind, label) {
  if (input === undefined) return { ...DEFAULT_DISCOVERY };
  assertPlainObject(input, `${label}.discovery`);
  assertOnlyKeys(input, DISCOVERY_KEYS, `${label}.discovery`);

  const mode = input.mode ?? DEFAULT_DISCOVERY.mode;
  if (mode !== "allowlist" && mode !== "loaded") {
    throw new Error(`${label}.discovery.mode must be allowlist or loaded`);
  }
  if (mode === "loaded" && providerKind !== "lmstudio-responses") {
    throw new Error(
      `${label}.discovery.mode loaded is supported only for lmstudio-responses`,
    );
  }

  const maxModels = input.maxModels ?? DEFAULT_DISCOVERY.maxModels;
  if (!Number.isSafeInteger(maxModels) || maxModels < 1 || maxModels > 64) {
    throw new Error(`${label}.discovery.maxModels must be an integer between 1 and 64`);
  }
  return { mode, maxModels };
}

function normalizeProvider(input, index, seenProviderIds, seenSlugs) {
  const label = `providers[${index}]`;
  assertPlainObject(input, label);
  assertOnlyKeys(input, PROVIDER_KEYS, label);

  const id = requireSingleLine(input.id, `${label}.id`);
  if (!isValidProviderId(id)) {
    throw new Error(
      `${label}.id must be at most 127 characters and contain only lowercase letters, digits, underscores, or hyphens`,
    );
  }
  if (id === BRIDGE_DEFAULTS.providerId || id === "openai") {
    throw new Error(`${label}.id ${id} is reserved`);
  }
  if (seenProviderIds.has(id)) {
    throw new Error(`Duplicate provider id: ${id}`);
  }

  if (!SUPPORTED_PROVIDER_KINDS.has(input.kind)) {
    throw new Error(
      `${label}.kind must be lmstudio-responses or openai-responses`,
    );
  }
  const discovery = normalizeDiscovery(input.discovery, input.kind, label);
  if (typeof input.allowPrivateNetwork !== "boolean") {
    throw new Error(`${label}.allowPrivateNetwork must be a boolean`);
  }
  const baseUrl = normalizeProviderBaseUrl(
    input.baseUrl,
    input.allowPrivateNetwork,
    `${label}.baseUrl`,
  );

  let credentialEnv;
  if (input.credentialEnv !== undefined) {
    credentialEnv = requireSingleLine(
      input.credentialEnv,
      `${label}.credentialEnv`,
    );
    if (!ENV_NAME_PATTERN.test(credentialEnv)) {
      throw new Error(`${label}.credentialEnv must be an environment variable name`);
    }
  }
  let credentialKeychain;
  if (input.credentialKeychain !== undefined) {
    if (input.credentialKeychain !== true) {
      throw new Error(`${label}.credentialKeychain must be true when supplied`);
    }
    credentialKeychain = true;
  }
  if (credentialEnv !== undefined && credentialKeychain === true) {
    throw new Error(
      `${label}.credentialEnv and credentialKeychain are mutually exclusive`,
    );
  }

  if (!Array.isArray(input.models)) {
    throw new Error(`${label}.models must be an array`);
  }
  if (input.models.length === 0 && discovery.mode !== "loaded") {
    throw new Error(`${label}.models must contain at least one model`);
  }
  const seenIds = new Set();
  const models = input.models.map((model, modelIndex) =>
    normalizeModel(model, id, input.kind, modelIndex, seenIds, seenSlugs),
  );

  seenProviderIds.add(id);
  const provider = {
    id,
    kind: input.kind,
    baseUrl,
    allowPrivateNetwork: input.allowPrivateNetwork,
    discovery,
    models,
  };
  if (credentialEnv !== undefined) provider.credentialEnv = credentialEnv;
  if (credentialKeychain === true) provider.credentialKeychain = true;
  return provider;
}

/**
 * Validate and normalize the user-maintained bridge configuration. The native
 * OpenAI destination deliberately has no configuration surface here.
 */
export function validateBridgeConfig(input) {
  assertPlainObject(input, "Bridge config");
  assertOnlyKeys(input, TOP_LEVEL_KEYS, "Bridge config");
  if (input.schemaVersion !== BRIDGE_SCHEMA_VERSION) {
    throw new Error(`Bridge config schemaVersion must be ${BRIDGE_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(input.providers)) {
    throw new Error("providers must be an array");
  }

  const seenProviderIds = new Set();
  const seenSlugs = new Set();
  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    bridge: normalizeBridge(input.bridge),
    providers: input.providers.map((provider, index) =>
      normalizeProvider(provider, index, seenProviderIds, seenSlugs),
    ),
  };
}

export async function loadBridgeConfig(configPath) {
  if (typeof configPath !== "string" || !configPath.trim()) {
    throw new Error("Bridge config path must not be empty");
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read bridge config ${configPath}: ${error.message}`, {
      cause: error,
    });
  }
  return validateBridgeConfig(parsed);
}
