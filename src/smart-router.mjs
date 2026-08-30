import { createHash } from "node:crypto";

import {
  AFFINITY_MAX_ENTRIES,
  AFFINITY_TTL_MS,
  AUTO_MODEL_DISPLAY_NAME,
  AUTO_MODEL_SLUG,
  SMART_ROUTING_STRATEGY,
  isAutoModelSlugVariant,
} from "./smart-routing-constants.mjs";
import { requiresToolCapability } from "./tool-policy.mjs";

export {
  AFFINITY_MAX_ENTRIES,
  AFFINITY_TTL_MS,
  AUTO_MODEL_DISPLAY_NAME,
  AUTO_MODEL_SLUG,
  SMART_ROUTING_STRATEGY,
};

export const SMART_ROUTING_REASON_CODES = Object.freeze([
  "local_eligible",
  "local_unavailable",
  "unsupported_local_input",
  "local_tools_uncertified",
  "high_reasoning_requested",
  "local_context_exceeded",
  "complexity_threshold",
  "previous_response_without_affinity",
  "affinity_local",
  "affinity_fallback",
  "affinity_local_became_ineligible",
]);

const HIGH_REASONING_EFFORTS = new Set(["high", "xhigh", "max", "ultra"]);
const UNSUPPORTED_USER_CONTENT_TYPES = new Set([
  "attachment",
  "audio",
  "file",
  "image",
  "image_url",
  "input_attachment",
  "input_audio",
  "input_file",
  "input_image",
  "input_video",
  "video",
]);
const HIGH_COMPLEXITY_TERMS = [
  "architecture",
  "Architektur",
  "migration",
  "Migration",
  "threat model",
  "Bedrohungsmodell",
  "security review",
  "Sicherheitsprüfung",
  "race condition",
  "deadlock",
  "concurrency",
  "Nebenläufigkeit",
  "Parallelität",
  "production incident",
  "Produktionsfehler",
  "root cause analysis",
  "Ursachenanalyse",
  "performance profiling",
  "cross-cutting refactor",
  "entire repository",
  "whole repository",
  "gesamtes Repository",
  "multiple subsystems",
  "mehrere Subsysteme",
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s+");
}

const HIGH_COMPLEXITY_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${HIGH_COMPLEXITY_TERMS.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_])`,
  "iu",
);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part) =>
        isPlainObject(part) &&
        (part.type === "input_text" || part.type === "text") &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

/** Extract only the latest user-authored text used by the lexical heuristic. */
export function extractLatestUserText(requestBody) {
  const input = requestBody?.input;
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";

  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!isPlainObject(item) || item.role !== "user") continue;
    if (typeof item.content === "string" || Array.isArray(item.content)) {
      return textFromContent(item.content);
    }
    if (
      (item.type === "input_text" || item.type === "text") &&
      typeof item.text === "string"
    ) {
      return item.text;
    }
    return "";
  }
  return "";
}

/** Deterministic, dependency-free request complexity score. */
export function scoreRequestComplexity(requestBody) {
  const text = extractLatestUserText(requestBody);
  let score = 0;
  if (text.length >= 4_000) score += 1;
  if (text.length >= 12_000) score += 1;
  let lines = 1;
  for (let index = 0; index < text.length && lines < 200; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit === 13) {
      lines += 1;
      if (text.charCodeAt(index + 1) === 10) index += 1;
    } else if (codeUnit === 10) {
      lines += 1;
    }
  }
  if (lines >= 200) score += 1;
  if (HIGH_COMPLEXITY_PATTERN.test(text)) score += 2;
  return score;
}

/** Conservative input estimate covering only the documented request fields. */
export function estimateInputTokens(requestBody) {
  const serialized = JSON.stringify({
    instructions: requestBody?.instructions,
    input: requestBody?.input,
    tools: requestBody?.tools,
  });
  return Math.ceil(Buffer.byteLength(serialized, "utf8") / 3);
}

function hasUnsupportedContentPart(content) {
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) =>
      isPlainObject(part) &&
      typeof part.type === "string" &&
      UNSUPPORTED_USER_CONTENT_TYPES.has(part.type.toLowerCase()),
  );
}

export function hasUnsupportedLocalInput(requestBody) {
  const input = requestBody?.input;
  if (input === undefined || typeof input === "string") return false;
  if (!Array.isArray(input)) return true;

  return input.some((item) => {
    if (!isPlainObject(item)) return false;
    const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
    if (UNSUPPORTED_USER_CONTENT_TYPES.has(type)) return true;
    return item.role === "user" && hasUnsupportedContentPart(item.content);
  });
}

function contextWindowOf(route) {
  for (const value of [
    route?.contextWindow,
    route?.model?.contextWindow,
    route?.model?.context_window,
  ]) {
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return 0;
}

function evaluateLocalEligibility(requestBody, localRoute, autoRoute) {
  const result = (
    eligible,
    reason,
    estimatedInputTokens = null,
    complexityScore = null,
  ) => ({
    eligible,
    reason,
    estimatedInputTokens,
    complexityScore,
  });

  if (hasUnsupportedLocalInput(requestBody)) {
    return result(false, "unsupported_local_input");
  }
  if (
    requiresToolCapability(requestBody) &&
    localRoute.toolsEnabled !== true
  ) {
    return result(false, "local_tools_uncertified");
  }
  if (HIGH_REASONING_EFFORTS.has(requestBody?.reasoning?.effort)) {
    return result(false, "high_reasoning_requested");
  }

  const estimatedInputTokens = estimateInputTokens(
    localRoute.toolsEnabled === true
      ? requestBody
      : {
          instructions: requestBody?.instructions,
          input: requestBody?.input,
        },
  );
  const localInputLimit = Math.min(
    autoRoute.maxLocalInputTokens,
    Math.floor(contextWindowOf(localRoute) * 0.75),
  );
  if (localInputLimit < 1 || estimatedInputTokens > localInputLimit) {
    return result(false, "local_context_exceeded", estimatedInputTokens);
  }
  const complexityScore = scoreRequestComplexity(requestBody);
  if (complexityScore >= autoRoute.complexityThreshold) {
    return result(
      false,
      "complexity_threshold",
      estimatedInputTokens,
      complexityScore,
    );
  }
  return result(true, "local_eligible", estimatedInputTokens, complexityScore);
}

export class SmartRouterError extends Error {
  constructor(message = "The smart-routing configuration is invalid", { cause } = {}) {
    super(message, { cause });
    this.name = "SmartRouterError";
    this.code = "INVALID_ROUTE";
    this.statusCode = 500;
  }
}

function assertAutoRoute(autoRoute) {
  if (
    !isPlainObject(autoRoute) ||
    autoRoute.kind !== "smart-router" ||
    autoRoute.slug !== AUTO_MODEL_SLUG ||
    autoRoute.strategy !== SMART_ROUTING_STRATEGY ||
    typeof autoRoute.localModel !== "string" ||
    !autoRoute.localModel ||
    typeof autoRoute.fallbackModel !== "string" ||
    !autoRoute.fallbackModel ||
    isAutoModelSlugVariant(autoRoute.localModel) ||
    isAutoModelSlugVariant(autoRoute.fallbackModel) ||
    autoRoute.localModel === autoRoute.fallbackModel ||
    !Number.isSafeInteger(autoRoute.maxLocalInputTokens) ||
    autoRoute.maxLocalInputTokens < 1_024 ||
    autoRoute.maxLocalInputTokens > 1_048_576 ||
    !Number.isSafeInteger(autoRoute.complexityThreshold) ||
    autoRoute.complexityThreshold < 1 ||
    autoRoute.complexityThreshold > 10
  ) {
    throw new SmartRouterError();
  }
}

function isNativeRoute(route, slug) {
  return (
    isPlainObject(route) &&
    (route.kind === "native-openai" || route.kind === "native") &&
    route.slug === slug &&
    route.upstreamModel === slug
  );
}

function isLocalRoute(route, slug) {
  return (
    isPlainObject(route) &&
    route.kind === "external" &&
    route.providerKind === "lmstudio-responses" &&
    route.slug === slug
  );
}

function affinityHash(requestBody) {
  const value = requestBody?.prompt_cache_key;
  if (
    typeof value !== "string" ||
    value.length === 0
  ) {
    return undefined;
  }
  let characters = 0;
  for (const character of value) {
    characters += 1;
    if (characters > 1_024) return undefined;
    if (/\p{Cc}/u.test(character)) return undefined;
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasPreviousResponse(requestBody) {
  return isPlainObject(requestBody) && Object.hasOwn(requestBody, "previous_response_id");
}

/**
 * Select one exact concrete route without touching transport, credentials, or
 * persistent state. Affinity stores only a hashed key and a route class; every
 * hit re-resolves the current immutable registry snapshot.
 */
export function createSmartRouter({
  registry,
  now = Date.now,
  onDecision = () => {},
} = {}) {
  if (!registry || typeof registry.resolve !== "function") {
    throw new TypeError("A model registry with resolve(model) is required");
  }
  if (typeof now !== "function" || typeof onDecision !== "function") {
    throw new TypeError("Smart-router clock and decision observer must be functions");
  }

  const affinity = new Map();

  function currentTime() {
    const value = now();
    if (!Number.isFinite(value)) throw new SmartRouterError();
    return value;
  }

  function purgeExpired(time) {
    for (const [key, entry] of affinity) {
      if (entry.expiresAt <= time) affinity.delete(key);
    }
  }

  function lookupAffinity(key, time) {
    purgeExpired(time);
    if (key === undefined) return undefined;
    const entry = affinity.get(key);
    if (!entry) return undefined;
    affinity.delete(key);
    affinity.set(key, entry);
    return entry;
  }

  function storeAffinity(key, selection, time) {
    purgeExpired(time);
    if (key === undefined) return;
    affinity.delete(key);
    while (affinity.size >= AFFINITY_MAX_ENTRIES) {
      affinity.delete(affinity.keys().next().value);
    }
    affinity.set(key, {
      selection,
      expiresAt: time + AFFINITY_TTL_MS,
    });
  }

  function resolveFallback(autoRoute) {
    let route;
    try {
      route = registry.resolve(autoRoute.fallbackModel);
    } catch (cause) {
      throw new SmartRouterError(undefined, { cause });
    }
    if (!isNativeRoute(route, autoRoute.fallbackModel)) {
      throw new SmartRouterError();
    }
    return route;
  }

  function resolveLocal(autoRoute) {
    let route;
    try {
      route = registry.resolve(autoRoute.localModel);
    } catch (error) {
      if (error?.code === "UNKNOWN_MODEL") return undefined;
      throw new SmartRouterError(undefined, { cause: error });
    }
    if (!isLocalRoute(route, autoRoute.localModel)) {
      throw new SmartRouterError();
    }
    return route;
  }

  function publishDecision({ route, reason, estimatedInputTokens = null, complexityScore = null, affinity: affinityState }) {
    const decision = Object.freeze({
      route,
      selectedModel: route.slug,
      reason,
      estimatedInputTokens,
      complexityScore,
      affinity: affinityState,
    });
    try {
      onDecision(Object.freeze({
        selectedModel: decision.selectedModel,
        reason: decision.reason,
        estimatedInputTokens: decision.estimatedInputTokens,
        complexityScore: decision.complexityScore,
        affinity: decision.affinity,
      }));
    } catch {
      // A diagnostic observer must never alter provider selection or dispatch.
    }
    return decision;
  }

  function select({ requestBody, autoRoute } = {}) {
    if (!isPlainObject(requestBody)) {
      throw new SmartRouterError("The smart router requires a decoded request object");
    }
    assertAutoRoute(autoRoute);

    const fallbackRoute = resolveFallback(autoRoute);
    const time = currentTime();
    const key = affinityHash(requestBody);
    const pinned = lookupAffinity(key, time);

    if (pinned?.selection === "fallback") {
      return publishDecision({
        route: fallbackRoute,
        reason: "affinity_fallback",
        affinity: "fallback",
      });
    }

    if (!pinned && hasPreviousResponse(requestBody)) {
      storeAffinity(key, "fallback", time);
      return publishDecision({
        route: fallbackRoute,
        reason: "previous_response_without_affinity",
        affinity: key === undefined ? "none" : "miss",
      });
    }

    const localRoute = resolveLocal(autoRoute);
    if (!localRoute) {
      storeAffinity(key, "fallback", time);
      return publishDecision({
        route: fallbackRoute,
        reason: pinned?.selection === "local"
          ? "affinity_local_became_ineligible"
          : "local_unavailable",
        affinity: pinned?.selection === "local"
          ? "local_became_ineligible"
          : key === undefined ? "none" : "miss",
      });
    }

    const eligibility = evaluateLocalEligibility(requestBody, localRoute, autoRoute);
    if (pinned?.selection === "local") {
      if (eligibility.eligible) {
        return publishDecision({
          route: localRoute,
          reason: "affinity_local",
          estimatedInputTokens: eligibility.estimatedInputTokens,
          complexityScore: eligibility.complexityScore,
          affinity: "local",
        });
      }
      storeAffinity(key, "fallback", time);
      return publishDecision({
        route: fallbackRoute,
        reason: "affinity_local_became_ineligible",
        estimatedInputTokens: eligibility.estimatedInputTokens,
        complexityScore: eligibility.complexityScore,
        affinity: "local_became_ineligible",
      });
    }

    const route = eligibility.eligible ? localRoute : fallbackRoute;
    storeAffinity(key, eligibility.eligible ? "local" : "fallback", time);
    return publishDecision({
      route,
      reason: eligibility.reason,
      estimatedInputTokens: eligibility.estimatedInputTokens,
      complexityScore: eligibility.complexityScore,
      affinity: key === undefined ? "none" : "miss",
    });
  }

  return Object.freeze({
    select,
    get affinitySize() {
      purgeExpired(currentTime());
      return affinity.size;
    },
  });
}
