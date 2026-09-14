import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

import {
  buildExternalRequestHeaders,
  buildNativeRequestHeaders,
  sanitizeUpstreamResponseHeaders,
} from "./header-policy.mjs";
import { BodyCodecError, decodeJsonBody, readLimitedBody } from "./body-codec.mjs";
import { createCredentialResolver } from "./keychain-credentials.mjs";
import {
  projectClientToolSearch,
  rewriteClientToolSearchInput,
} from "./efficient-fidelity.mjs";
import {
  createTextOnlyToolResponseCodec,
  normalizeLmStudioToolRequest,
} from "./tool-normalization.mjs";
import { isCertificationRequest } from "./certification-transport.mjs";
import {
  createCompactionEnvelopeCodec,
  isCompactionEnvelope,
} from "./compaction-envelope.mjs";
import {
  MAX_COMPACTION_RESPONSE_BYTES,
  buildCompactionResponse,
  classifyCompactionRequest,
  prepareCompactionSummaryRequest,
} from "./lmstudio-compaction.mjs";
import {
  WEB_SEARCH_PATH,
  projectWebSearchResponse,
  validateWebSearchRequest,
} from "./web-search-wire.mjs";
import {
  RESPONSE_TRANSFORM_MAX_BYTES,
  createSseResponseTransformer,
  shouldTransformResponse,
  transformJsonResponse,
} from "./responses-transform.mjs";

const DEFAULT_NATIVE_BASE_URL = "https://chatgpt.com/backend-api/codex";
const RESPONSE_PATHS = new Set(["/v1/responses", "/v1/responses/compact"]);
const LM_STUDIO_RESPONSES_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const LEGACY_LM_STUDIO_REASONING_ALIASES = Object.freeze({
  off: "none",
  on: "xhigh",
  max: "xhigh",
  ultra: "xhigh",
});
// Private semantic kinds are the stable omission contract. Broad generic
// developer instructions are deliberately absent: their bytes are retained,
// while later independently classified bootstrap remains eligible for removal.
const LM_STUDIO_TEXT_ONLY_OMITTED_CONTEXT = new Map([
  [
    "memories.instructions",
    {
      roles: new Set(["developer"]),
      annotatedText: true,
    },
  ],
  [
    "host_skills.instructions",
    {
      roles: new Set(["developer"]),
      markers: ["<skills_instructions>", "</skills_instructions>"],
    },
  ],
  [
    "skills.catalog",
    {
      roles: new Set(["developer"]),
      markers: ["<skills_instructions>", "</skills_instructions>"],
    },
  ],
  [
    "skills.instructions",
    {
      roles: new Set(["developer"]),
      markers: ["<skills_instructions>", "</skills_instructions>"],
    },
  ],
  [
    "orchestrator_skills.instructions",
    {
      roles: new Set(["developer"]),
      markers: ["<skills_instructions>", "</skills_instructions>"],
    },
  ],
  [
    "permissions.instructions",
    {
      roles: new Set(["developer"]),
      markers: ["<permissions instructions>", "</permissions instructions>"],
    },
  ],
  [
    "apps.instructions",
    {
      roles: new Set(["developer"]),
      markers: ["<apps_instructions>", "</apps_instructions>"],
    },
  ],
  [
    "plugins.usage_instructions",
    {
      roles: new Set(["developer"]),
      markers: ["<plugins_instructions>", "</plugins_instructions>"],
    },
  ],
  [
    "environments.instructions",
    {
      roles: new Set(["developer"]),
      markers: ["<environments_instructions>", "</environments_instructions>"],
    },
  ],
  [
    "collaboration_mode.instructions",
    {
      roles: new Set(["developer"]),
      markers: ["<collaboration_mode>", "</collaboration_mode>"],
    },
  ],
  [
    "multi_agent.mode_instructions",
    {
      roles: new Set(["developer"]),
      markers: ["<multi_agent_mode>", "</multi_agent_mode>"],
    },
  ],
  [
    "multi_agent.usage_hint",
    {
      roles: new Set(["developer"]),
      standalone: true,
      annotatedText: true,
    },
  ],
  [
    "multi_agent.role_instructions",
    {
      roles: new Set(["developer"]),
      standalone: true,
      annotatedText: true,
    },
  ],
  [
    "tools.deferred_namespaces",
    {
      roles: new Set(["developer"]),
      markers: ["<tools>", "</tools>"],
    },
  ],
  [
    "plugins.recommendations",
    {
      roles: new Set(["user"]),
      markers: ["<recommended_plugins>", "</recommended_plugins>"],
    },
  ],
]);
const LM_STUDIO_TEXT_ONLY_RETAINED_CONTEXT_PREFIXES = Object.freeze([
  "additional_content.",
  "agents_md.",
  "app.",
  "app_context.",
  "codex_app.",
  "collaboration_mode.",
  "compaction.",
  "current_time.",
  "environments.",
  "extension.",
  "generic.",
  "goals.",
  "guardian.",
  "hooks.",
  "managed_config.",
  "memory.",
  "memories.",
  "model.",
  "model_switch.",
  "multi_agent.",
  "network_proxy.",
  "notes.",
  "personality.",
  "persistent_mode.",
  "realtime_conversation.",
  "rollout_budget.",
  "skills.selected_skill_instructions",
  "token_budget.",
]);
const LM_STUDIO_TEXT_ONLY_BOOTSTRAP_ROLES = new Set([
  "system",
  "developer",
  "user",
]);
const LM_STUDIO_TEXT_ONLY_MESSAGE_KEYS = new Set([
  "content",
  "id",
  "internal_chat_message_metadata_passthrough",
  "role",
  "type",
]);
const LM_STUDIO_TEXT_ONLY_METADATA_KEYS = new Set([
  "content_item_kinds",
  "create_time",
  "turn_id",
]);
const LM_STUDIO_TEXT_ONLY_INPUT_TEXT_KEYS = new Set(["text", "type"]);

const DEFAULT_LIMITS = Object.freeze({
  requestBodyBytes: 8 * 1024 * 1024,
  responseHeaderBytes: 64 * 1024,
  upstreamHeadersTimeoutMs: 30_000,
  streamIdleTimeoutMs: 120_000,
  upstreamTotalTimeoutMs: 15 * 60_000,
});

const PUBLIC_ERROR_CODES = new Set([
  "COMPACTION_FAILED",
  "COMPACTION_STATE_ROUTE_MISMATCH",
  "COMPACTION_UNAVAILABLE",
  "INVALID_COMPACTION_REQUEST",
  "INVALID_COMPACTION_STATE",
  "BODY_TOO_LARGE",
  "BRIDGE_ERROR",
  "CLIENT_ABORTED",
  "CONTENT_ENCODING_UNAVAILABLE",
  "DECODED_BODY_TOO_LARGE",
  "INSECURE_CREDENTIAL_ROUTE",
  "INVALID_BODY",
  "INVALID_COMPRESSION",
  "INVALID_JSON",
  "INVALID_JSON_OBJECT",
  "INVALID_REASONING_EFFORT",
  "INVALID_REASONING_POLICY",
  "INVALID_ROUTE",
  "INVALID_ROUTE_PROTOCOL",
  "INVALID_ROUTE_URL",
  "INVALID_TOOL_SEARCH",
  "INVALID_UPSTREAM_MODEL",
  "INVALID_WEB_SEARCH",
  "MISSING_MODEL",
  "MISSING_TOOL_SEARCH_OUTPUT",
  "MODEL_CERTIFICATION_PENDING",
  "MODEL_NOT_CERTIFIED",
  "NOT_FOUND",
  "PROVIDER_CREDENTIAL_UNAVAILABLE",
  "SEARCH_MODEL_UNAVAILABLE",
  "SEARCH_SERVICE_ERROR",
  "TOOL_SEARCH_LIMIT_EXCEEDED",
  "UNKNOWN_MODEL",
  "UNKNOWN_TOOL_SEARCH_CALL",
  "UNSUPPORTED_CONTENT_ENCODING",
  "UNSUPPORTED_LOADED_TOOL_TYPE",
  "UNSUPPORTED_TOOL_CHOICE",
  "UNSUPPORTED_TOOL_SEARCH_EXECUTION",
  "UNSUPPORTED_TOOL_TYPE",
  "UPSTREAM_ABORTED",
  "UPSTREAM_ADDRESS_NOT_ALLOWED",
  "UPSTREAM_ERROR",
  "UPSTREAM_HEADERS_TIMEOUT",
  "UPSTREAM_HEADERS_TOO_LARGE",
  "UPSTREAM_IDLE_TIMEOUT",
  "UPSTREAM_RESPONSE_ERROR",
  "UPSTREAM_TOOL_SEARCH_ERROR",
  "UPSTREAM_TOTAL_TIMEOUT",
]);

const NON_PUBLIC_IPV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  NON_PUBLIC_IPV4.addSubnet(network, prefix, "ipv4");
}

const NON_PUBLIC_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, "ipv6");
}

export class ResponsesProxyError extends Error {
  constructor(message, { statusCode = 502, code = "UPSTREAM_ERROR", cause } = {}) {
    super(message, { cause });
    this.name = "ResponsesProxyError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function positiveInteger(value, fallback, name) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return candidate;
}

function normalizeLimits(options = {}) {
  const legacyUpstreamTimeout = options.upstreamTimeoutMs;
  return {
    requestBodyBytes: positiveInteger(
      options.requestBodyBytes,
      DEFAULT_LIMITS.requestBodyBytes,
      "requestBodyBytes",
    ),
    responseHeaderBytes: positiveInteger(
      options.responseHeaderBytes,
      DEFAULT_LIMITS.responseHeaderBytes,
      "responseHeaderBytes",
    ),
    upstreamHeadersTimeoutMs: positiveInteger(
      options.upstreamHeadersTimeoutMs ?? legacyUpstreamTimeout,
      DEFAULT_LIMITS.upstreamHeadersTimeoutMs,
      "upstreamHeadersTimeoutMs",
    ),
    streamIdleTimeoutMs: positiveInteger(
      options.streamIdleTimeoutMs,
      DEFAULT_LIMITS.streamIdleTimeoutMs,
      "streamIdleTimeoutMs",
    ),
    upstreamTotalTimeoutMs: positiveInteger(
      options.upstreamTotalTimeoutMs ?? legacyUpstreamTimeout,
      DEFAULT_LIMITS.upstreamTotalTimeoutMs,
      "upstreamTotalTimeoutMs",
    ),
  };
}

function routeKind(route) {
  if (route?.kind === "native-openai" || route?.kind === "native") return "native";
  if (route?.kind === "external") return "external";
  throw new ResponsesProxyError("The selected model route is invalid", {
    statusCode: 500,
    code: "INVALID_ROUTE",
  });
}

function assertApiBaseUrl(value, { credential = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ResponsesProxyError("The selected model route is invalid", {
      statusCode: 500,
      code: "INVALID_ROUTE_URL",
      cause: error,
    });
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new ResponsesProxyError("The selected model route is invalid", {
      statusCode: 500,
      code: "INVALID_ROUTE_PROTOCOL",
    });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ResponsesProxyError("The selected model route is invalid", {
      statusCode: 500,
      code: "INVALID_ROUTE_URL",
    });
  }

  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (credential && url.protocol !== "https:" && !isLoopback) {
    throw new ResponsesProxyError("Credentials require a protected upstream", {
      statusCode: 500,
      code: "INSECURE_CREDENTIAL_ROUTE",
    });
  }
  return url;
}

function upstreamUrl(baseUrl, incomingPath) {
  const url = new URL(baseUrl.href);
  const suffix = incomingPath.slice("/v1".length);
  url.pathname = `${url.pathname.replace(/\/$/u, "")}${suffix}`;
  return url;
}

function mappedIpv4(address) {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address)?.[1];
  if (dotted && isIP(dotted) === 4) return dotted;
  const hexadecimal = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(address);
  if (!hexadecimal) return null;
  const high = Number.parseInt(hexadecimal[1], 16);
  const low = Number.parseInt(hexadecimal[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function isNonPublicAddress(address, family = isIP(address)) {
  const normalizedFamily = family === 4 || family === "IPv4" ? 4 : family === 6 || family === "IPv6" ? 6 : 0;
  if (normalizedFamily === 4) return NON_PUBLIC_IPV4.check(address, "ipv4");
  if (normalizedFamily === 6) {
    const mapped = mappedIpv4(address);
    return mapped
      ? NON_PUBLIC_IPV4.check(mapped, "ipv4")
      : NON_PUBLIC_IPV6.check(address, "ipv6");
  }
  return true;
}

function createPublicOnlyLookup(lookupImpl) {
  return (hostname, options, callback) => {
    const lookupOptions = {
      family: options?.family,
      hints: options?.hints,
      all: true,
      verbatim: true,
    };
    lookupImpl(hostname, lookupOptions, (error, results) => {
      if (error) {
        callback(error);
        return;
      }
      const addresses = (Array.isArray(results) ? results : [results]).filter(
        (entry) =>
          entry &&
          typeof entry.address === "string" &&
          !isNonPublicAddress(entry.address, entry.family),
      );
      if (addresses.length === 0) {
        const blocked = new Error("Upstream address is outside the permitted network class");
        blocked.code = "ERR_BRIDGE_ADDRESS_NOT_ALLOWED";
        callback(blocked);
        return;
      }
      if (options?.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    });
  };
}

function mergeLmStudioSystemMessages(input) {
  const systemContent = [];
  const conversation = [];
  for (const item of input) {
    if (
      item !== null &&
      !Array.isArray(item) &&
      typeof item === "object" &&
      (item.type === "message" || item.type === undefined) &&
      (item.role === "system" || item.role === "developer")
    ) {
      if (!Array.isArray(item.content) && typeof item.content !== "string") {
        throw new ResponsesProxyError("The request context schema is unsupported", {
          statusCode: 400,
          code: "INVALID_BODY",
        });
      }
      if (systemContent.length > 0) {
        systemContent.push({ type: "input_text", text: "\n\n" });
      }
      if (Array.isArray(item.content)) systemContent.push(...item.content);
      else if (typeof item.content === "string") {
        systemContent.push({ type: "input_text", text: item.content });
      }
      continue;
    }
    conversation.push(item);
  }
  if (systemContent.length === 0) return conversation;
  return [
    { type: "message", role: "system", content: systemContent },
    ...conversation,
  ];
}

function hasContextKindPrefix(kind, prefixes) {
  return prefixes.some((prefix) => kind.startsWith(prefix));
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function hasExactInputTextShape(part) {
  return (
    part !== null &&
    !Array.isArray(part) &&
    typeof part === "object" &&
    part.type === "input_text" &&
    typeof part.text === "string" &&
    hasOnlyKeys(part, LM_STUDIO_TEXT_ONLY_INPUT_TEXT_KEYS)
  );
}

function hasExactContextEnvelope(part, markers) {
  if (!hasExactInputTextShape(part) || !Array.isArray(markers)) {
    return false;
  }
  const text = part.text.trim();
  const [opening, closing] = markers;
  if (!text.startsWith(opening)) return false;
  const firstClosing = text.indexOf(closing, opening.length);
  return (
    firstClosing === text.length - closing.length &&
    text.indexOf(opening, opening.length) === -1
  );
}

function lmStudioTextOnlyContextDisposition(kind, role, part, contentLength) {
  const omittedContext = LM_STUDIO_TEXT_ONLY_OMITTED_CONTEXT.get(kind);
  if (omittedContext) {
    if (
      !omittedContext.roles.has(role) ||
      (omittedContext.standalone && contentLength !== 1) ||
      !hasExactInputTextShape(part)
    ) {
      return "unknown";
    }
    if (typeof omittedContext.verify === "function") {
      const verification = omittedContext.verify(part);
      if (verification === "match") return "omit";
      return verification === "mismatch" ? "retain" : "unknown";
    }
    if (omittedContext.annotatedText === true) return "omit";
    return hasExactContextEnvelope(part, omittedContext.markers)
      ? "omit"
      : "unknown";
  }
  if (hasContextKindPrefix(kind, LM_STUDIO_TEXT_ONLY_RETAINED_CONTEXT_PREFIXES)) {
    return "retain";
  }
  if (
    kind.startsWith("user.") ||
    kind.startsWith("images.") ||
    kind.startsWith("shell.")
  ) {
    return "conversation";
  }
  return "unknown";
}

/**
 * Remove only annotated, text-only-irrelevant bootstrap fragments before the
 * first real conversation item. Missing, malformed, mixed-user, and future
 * annotations retain the original item and end compaction conservatively.
 */
function compactLmStudioTextOnlyInput(input) {
  const compacted = [];
  const stats = {
    sourceItems: input.length,
    sourceParts: input.reduce((total, item) => {
      if (Array.isArray(item?.content)) return total + item.content.length;
      return total + 1;
    }, 0),
    omittedParts: 0,
    omittedBytes: 0,
    retainedBootstrapParts: 0,
    retainedBootstrapBytes: 0,
    stopped: false,
    stopReason: "none",
  };
  let compactingBootstrap = true;
  const stopCompacting = (reason) => {
    compactingBootstrap = false;
    if (!stats.stopped) {
      stats.stopped = true;
      stats.stopReason = reason;
    }
  };
  for (const item of input) {
    if (
      !compactingBootstrap ||
      item === null ||
      Array.isArray(item) ||
      typeof item !== "object" ||
      item.type !== "message" ||
      !LM_STUDIO_TEXT_ONLY_BOOTSTRAP_ROLES.has(item.role)
    ) {
      if (compactingBootstrap) {
        const validConversationItem =
          item !== null &&
          !Array.isArray(item) &&
          typeof item === "object" &&
          typeof item.type === "string";
        stopCompacting(validConversationItem ? "conversation" : "ambiguous");
      }
      compacted.push(item);
      continue;
    }

    const kinds = item.internal_chat_message_metadata_passthrough
      ?.content_item_kinds;
    const internalMetadata = item.internal_chat_message_metadata_passthrough;
    const internalMetadataIsObject =
      internalMetadata !== null &&
      !Array.isArray(internalMetadata) &&
      typeof internalMetadata === "object";
    if (
      !hasOnlyKeys(item, LM_STUDIO_TEXT_ONLY_MESSAGE_KEYS) ||
      (item.id !== undefined && typeof item.id !== "string") ||
      (internalMetadataIsObject &&
        (!hasOnlyKeys(internalMetadata, LM_STUDIO_TEXT_ONLY_METADATA_KEYS) ||
          (internalMetadata.create_time !== undefined &&
            (typeof internalMetadata.create_time !== "number" ||
              !Number.isFinite(internalMetadata.create_time))) ||
          (internalMetadata.turn_id !== undefined &&
            typeof internalMetadata.turn_id !== "string")))
    ) {
      throw new ResponsesProxyError("The request context schema is unsupported", {
        statusCode: 400,
        code: "INVALID_BODY",
      });
    }
    if (
      !internalMetadataIsObject ||
      !Array.isArray(item.content) ||
      !Array.isArray(kinds) ||
      kinds.length !== item.content.length ||
      kinds.length === 0 ||
      kinds.some((kind) => typeof kind !== "string" || !kind)
    ) {
      stopCompacting("ambiguous");
      compacted.push(item);
      continue;
    }
    if (
      kinds.some((kind, index) => {
        const part = item.content[index];
        return (
          LM_STUDIO_TEXT_ONLY_OMITTED_CONTEXT.has(kind) &&
          part !== null &&
          !Array.isArray(part) &&
          typeof part === "object" &&
          !hasOnlyKeys(part, LM_STUDIO_TEXT_ONLY_INPUT_TEXT_KEYS)
        );
      })
    ) {
      throw new ResponsesProxyError("The request context schema is unsupported", {
        statusCode: 400,
        code: "INVALID_BODY",
      });
    }

    const dispositions = kinds.map((kind, index) =>
      lmStudioTextOnlyContextDisposition(
        kind,
        item.role,
        item.content[index],
        item.content.length,
      ),
    );
    if (
      dispositions.includes("conversation") ||
      dispositions.includes("unknown")
    ) {
      stopCompacting(
        dispositions.includes("unknown") ? "ambiguous" : "conversation",
      );
      compacted.push(item);
      continue;
    }

    const content = item.content.filter((part, index) => {
      if (dispositions[index] !== "omit") {
        stats.retainedBootstrapParts += 1;
        stats.retainedBootstrapBytes += jsonByteLength(part);
        return true;
      }
      stats.omittedParts += 1;
      stats.omittedBytes += jsonByteLength(part);
      return false;
    });
    if (content.length > 0) {
      compacted.push(
        content.length === item.content.length ? item : { ...item, content },
      );
    }
  }
  if (compacted.length === 0 && input.length > 0) {
    throw new ResponsesProxyError("The request has no conversation content", {
      statusCode: 400,
      code: "INVALID_BODY",
    });
  }
  return { input: compacted, stats };
}

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function emitTextOnlyCompaction(
  callback,
  stats,
  sourceInput,
  forwardedInput,
  sourceRequest,
  forwardedRequestBytes,
) {
  if (typeof callback !== "function") return;
  const changed = stats.omittedParts > 0;
  const event = Object.freeze({
    event: "lmstudio_text_only_compaction",
    schemaVersion: 1,
    outcome: changed ? "compacted" : "unchanged",
    stopReason: stats.stopReason,
    changed,
    stopped: stats.stopped,
    sourceItems: stats.sourceItems,
    forwardedItems: forwardedInput.length,
    sourceParts: stats.sourceParts,
    retainedParts: stats.sourceParts - stats.omittedParts,
    retainedBootstrapParts: stats.retainedBootstrapParts,
    retainedBootstrapBytes: stats.retainedBootstrapBytes,
    omittedParts: stats.omittedParts,
    sourceBytes: jsonByteLength(sourceInput),
    forwardedBytes: jsonByteLength(forwardedInput),
    sourceRequestBytes: jsonByteLength(sourceRequest),
    forwardedRequestBytes,
    omittedBytes: stats.omittedBytes,
  });
  try {
    Promise.resolve(callback(event)).catch(() => {});
  } catch {
    // Diagnostics must never affect request routing or response delivery.
  }
}

function lmStudioReasoningSelection(requested, route) {
  const supported = new Set(
    Array.isArray(route.reasoningEfforts) && route.reasoningEfforts.length > 0
      ? route.reasoningEfforts
      : [route.reasoningEffort ?? "low"],
  );
  const fallback = supported.has(route.reasoningEffort)
    ? route.reasoningEffort
    : [...supported][0];
  const upstreamFor = (effort) => {
    const configured = route.reasoningEffortMap?.[effort] ?? effort;
    // Older live registries used the REST capability aliases on the Responses
    // wire. Normalize them here so a stale route can never reintroduce `on/off`.
    const normalized = LEGACY_LM_STUDIO_REASONING_ALIASES[configured] ?? configured;
    if (!LM_STUDIO_RESPONSES_REASONING_EFFORTS.has(normalized)) {
      throw new ResponsesProxyError("The selected model route is invalid", {
        statusCode: 500,
        code: "INVALID_REASONING_EFFORT",
      });
    }
    return normalized;
  };
  if (requested === undefined) {
    return { selected: fallback, upstream: upstreamFor(fallback) };
  }
  let selected = supported.has(requested) ? requested : fallback;

  if (!supported.has(requested)) {
    const candidates =
      requested === "none"
        ? ["none", "low", "medium", "xhigh"]
        : requested === "minimal"
          ? ["low", "medium", "xhigh", "none"]
          : ["xhigh", "high", "medium", "low", "none"];
    selected = candidates.find((effort) => supported.has(effort)) ?? fallback;
  }
  return { selected, upstream: upstreamFor(selected) };
}

function hasFunctionHistory(input) {
  return (
    Array.isArray(input) &&
    input.some(
      (item) =>
        item !== null &&
        !Array.isArray(item) &&
        typeof item === "object" &&
        (
          item.type === "function_call" ||
          item.type === "function_call_output" ||
          item.type === "tool_search_call" ||
          item.type === "tool_search_output" ||
          (typeof item.type === "string" && item.type.startsWith("tool_search"))
        ),
    )
  );
}

function hasToolSearchDefinition(tools) {
  return (
    Array.isArray(tools) &&
    tools.some(
      (tool) =>
        tool !== null &&
        !Array.isArray(tool) &&
        typeof tool === "object" &&
        typeof tool.type === "string" &&
        tool.type.startsWith("tool_search"),
    )
  );
}

function hasToolSearchHistory(input) {
  return (
    Array.isArray(input) &&
    input.some(
      (item) =>
        item !== null &&
        !Array.isArray(item) &&
        typeof item === "object" &&
        typeof item.type === "string" &&
        item.type.startsWith("tool_search"),
    )
  );
}

function hasAdditionalToolsInventory(input) {
  return (
    Array.isArray(input) &&
    input.some(
      (item) =>
        item !== null &&
        !Array.isArray(item) &&
        typeof item === "object" &&
        item.type === "additional_tools",
    )
  );
}

function enforceTextOnlyRequest(rewritten, source) {
  if (hasAdditionalToolsInventory(source.input)) {
    throw new ResponsesProxyError(
      "Text-only routes do not accept secondary tool inventories",
      { statusCode: 400, code: "UNSUPPORTED_TOOL_TYPE" },
    );
  }
  const choice = source.tool_choice;
  if (
    (choice !== undefined && choice !== "auto" && choice !== "none") ||
    hasFunctionHistory(source.input)
  ) {
    throw new ResponsesProxyError(
      "The selected model is not certified for tool use",
      { statusCode: 400, code: "UNSUPPORTED_TOOL_CHOICE" },
    );
  }
  delete rewritten.tools;
  delete rewritten.tool_choice;
  delete rewritten.parallel_tool_calls;
}

function externalBody(body, route, maxBytes, {
  certificationRequest = false,
  compactRequest = false,
  localCompactionSummary = false,
  onTextOnlyCompaction,
} = {}) {
  if (typeof route.upstreamModel !== "string" || !route.upstreamModel) {
    throw new ResponsesProxyError("The selected model route is invalid", {
      statusCode: 500,
      code: "INVALID_UPSTREAM_MODEL",
    });
  }
  if (
    route.reasoningEffort !== undefined &&
    (typeof route.reasoningEffort !== "string" || !route.reasoningEffort)
  ) {
    throw new ResponsesProxyError("The selected model route is invalid", {
      statusCode: 500,
      code: "INVALID_REASONING_EFFORT",
    });
  }
  if (
    route.reasoningEfforts !== undefined &&
    (!Array.isArray(route.reasoningEfforts) ||
      route.reasoningEfforts.length === 0 ||
      route.reasoningEfforts.some((effort) => typeof effort !== "string" || !effort))
  ) {
    throw new ResponsesProxyError("The selected model route is invalid", {
      statusCode: 500,
      code: "INVALID_REASONING_EFFORT",
    });
  }
  if (
    route.reasoningEffortMap !== undefined &&
    (route.reasoningEffortMap === null ||
      Array.isArray(route.reasoningEffortMap) ||
      typeof route.reasoningEffortMap !== "object" ||
      Object.entries(route.reasoningEffortMap).some(
        ([effort, upstream]) =>
          !route.reasoningEfforts?.includes(effort) ||
          typeof upstream !== "string" ||
          !upstream,
      ))
  ) {
    throw new ResponsesProxyError("The selected model route is invalid", {
      statusCode: 500,
      code: "INVALID_REASONING_EFFORT",
    });
  }
  if (
    route.reasoningOmitEfforts !== undefined &&
    (!Array.isArray(route.reasoningOmitEfforts) ||
      route.providerKind !== "lmstudio-responses" ||
      new Set(route.reasoningOmitEfforts).size !==
        route.reasoningOmitEfforts.length ||
      route.reasoningOmitEfforts.some(
        (effort) => !route.reasoningEfforts?.includes(effort),
      ))
  ) {
    throw new ResponsesProxyError("The selected model route is invalid", {
      statusCode: 500,
      code: "INVALID_REASONING_POLICY",
    });
  }

  const toolsEnabled = route.toolsEnabled === true || certificationRequest;
  const rewritten = { ...body, model: route.upstreamModel };
  delete rewritten.client_metadata;
  if (
    route.providerKind === "lmstudio-responses" &&
    body.instructions !== undefined &&
    body.instructions !== null &&
    typeof body.instructions !== "string"
  ) {
    throw new ResponsesProxyError("The request instructions must be text or null", {
      statusCode: 400,
      code: "INVALID_BODY",
    });
  }
  if (localCompactionSummary && route.providerKind === "lmstudio-responses") {
    // Codex keeps current base instructions outside compacted history and
    // supplies them again on the next ordinary request. Omit only this field
    // before merging; historical system/developer messages must stay intact.
    delete rewritten.instructions;
  }
  let textOnlyCompaction;
  if (Array.isArray(body.input)) {
    if (route.providerKind === "lmstudio-responses" && !toolsEnabled) {
      textOnlyCompaction = compactLmStudioTextOnlyInput(body.input);
    }
    const sourceInput = textOnlyCompaction?.input ?? body.input;
    const sanitizedInput = sourceInput.map((item) => {
      if (item === null || Array.isArray(item) || typeof item !== "object") return item;
      const sanitized = { ...item };
      delete sanitized.internal_chat_message_metadata_passthrough;
      if (sanitized.type === "function_call") {
        delete sanitized.encrypted_function_args;
        if (
          route.providerKind === "lmstudio-responses" &&
          sanitized.namespace === "functions"
        ) {
          delete sanitized.namespace;
        }
      }
      return sanitized;
    });
    rewritten.input = route.providerKind === "lmstudio-responses"
      ? mergeLmStudioSystemMessages(sanitizedInput)
      : sanitizedInput;
    if (
      route.providerKind === "lmstudio-responses" &&
      typeof rewritten.instructions === "string" &&
      rewritten.input[0]?.type === "message" &&
      rewritten.input[0]?.role === "system"
    ) {
      // LM Studio turns `instructions` into another system message. Qwen's
      // template (including through LM Link) accepts only one leading block.
      rewritten.input[0].content.unshift(
        { type: "input_text", text: rewritten.instructions },
        { type: "input_text", text: "\n\n" },
      );
      delete rewritten.instructions;
    }
  }

  let toolCodec;
  let compactionInput;
  if (!toolsEnabled) {
    enforceTextOnlyRequest(rewritten, body);
    toolCodec = createTextOnlyToolResponseCodec();
  }
  if (route.providerKind === "lmstudio-responses") {
    if (Object.hasOwn(body, "tools") && !Array.isArray(body.tools)) {
      throw new ResponsesProxyError(
        "LM Studio tools must be a JSON array",
        { statusCode: 400, code: "INVALID_TOOL_SEARCH" },
      );
    }
    if (hasAdditionalToolsInventory(body.input)) {
      throw new ResponsesProxyError(
        "LM Studio routes do not accept secondary tool inventories",
        { statusCode: 400, code: "UNSUPPORTED_TOOL_TYPE" },
      );
    }
    delete rewritten.prompt_cache_key;
    if (Array.isArray(body.include)) {
      const include = body.include.filter(
        (value) => value !== "reasoning.encrypted_content",
      );
      if (include.length === 0) delete rewritten.include;
      else rewritten.include = include;
    }
    if (toolsEnabled) {
      const toolSearchDefinition = hasToolSearchDefinition(body.tools);
      const toolSearchHistory = hasToolSearchHistory(body.input);
      const efficientFidelityAuthorized =
        route.clientToolSearchEnabled === true || certificationRequest;
      const validatedToolSearchProjection = toolSearchDefinition
        ? projectClientToolSearch(body.tools, {
          parallelToolCalls: body.parallel_tool_calls,
          // Codex's compact schema omits tool_choice. A supplied field must
          // not turn an authorized but malformed search into Direct mode.
          toolChoice: compactRequest && body.tool_choice === undefined
            ? "auto"
            : body.tool_choice,
        })
        : undefined;
      const efficientFidelityProjection = efficientFidelityAuthorized
        ? validatedToolSearchProjection
        : undefined;
      const efficientFidelityEnabled = efficientFidelityProjection !== undefined;
      if (toolSearchHistory && !efficientFidelityEnabled) {
        throw new ResponsesProxyError(
          "Tool Search history requires an Efficient Fidelity route",
          { statusCode: 400, code: "INVALID_TOOL_SEARCH" },
        );
      }

      let normalizationSource = body;
      let efficientFidelityCodec;
      if (efficientFidelityEnabled) {
        if (Object.hasOwn(body, "previous_response_id")) {
          throw new ResponsesProxyError(
            "Efficient Fidelity requires stateless full replay",
            { statusCode: 400, code: "INVALID_TOOL_SEARCH" },
          );
        }
        const projection = efficientFidelityProjection;
        const searchInput = Array.isArray(rewritten.input)
          ? rewriteClientToolSearchInput(rewritten.input, projection.codec)
          : { input: rewritten.input, loadedTools: [] };
        rewritten.input = searchInput.input;
        rewritten.tools = [...projection.tools, ...searchInput.loadedTools];
        normalizationSource = {
          ...body,
          input: rewritten.input,
          tools: rewritten.tools,
        };
        efficientFidelityCodec = projection.codec;
      }
      // Keep validated public call identities in a compaction transcript. With
      // schemas omitted, opaque wire hashes would erase the tools' meaning.
      if (compactRequest) compactionInput = rewritten.input;
      const namespaceCodec = normalizeLmStudioToolRequest(
        rewritten,
        normalizationSource,
        {
          // Codex may trim selected schemas from older tool_search_output
          // items before remote compaction while retaining the namespaced
          // calls. Map those history names only; never advertise a schema or
          // make the historical tool callable again.
          allowHistoryOnlyNamespaces:
            compactRequest && efficientFidelityCodec !== undefined,
        },
      );
      toolCodec = efficientFidelityCodec
        ? Object.freeze({ namespaceCodec, efficientFidelityCodec })
        : namespaceCodec;
    }
  }

  if (
    route.reasoningEffort !== undefined ||
    route.reasoningEfforts !== undefined
  ) {
    const reasoning =
      body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)
        ? { ...body.reasoning }
        : {};
    const requested = reasoning.effort;
    if (route.providerKind === "lmstudio-responses") {
      const selection = lmStudioReasoningSelection(requested, route);
      if (route.reasoningOmitEfforts?.includes(selection.selected)) {
        // Intrinsic/toggle-only reasoning has no custom effort KVs. Remove the
        // complete object (including summary) so LM Studio uses its loaded
        // model default for the synthetic positive picker setting.
        delete rewritten.reasoning;
      } else {
        reasoning.effort = selection.upstream;
        rewritten.reasoning = reasoning;
      }
    } else {
      reasoning.effort =
        Array.isArray(route.reasoningEfforts) &&
        route.reasoningEfforts.includes(requested)
          ? requested
          : route.reasoningEffort;
      rewritten.reasoning = reasoning;
    }
  }

  if (compactRequest) {
    // Tool schemas in a compaction request describe transcript history. They
    // never grant the compactor authority to create a new executable call.
    toolCodec = createTextOnlyToolResponseCodec();
  }

  const encoded = Buffer.from(JSON.stringify(rewritten), "utf8");
  if (encoded.length > maxBytes) {
    throw new BodyCodecError("Request body is too large", {
      statusCode: 413,
      code: "BODY_TOO_LARGE",
    });
  }
  if (textOnlyCompaction) {
    emitTextOnlyCompaction(
      onTextOnlyCompaction,
      textOnlyCompaction.stats,
      body.input,
      rewritten.input,
      body,
      encoded.length,
    );
  }
  return { encoded, toolCodec, compactionInput };
}

function statusForError(error) {
  const value = Number(error?.statusCode);
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 500;
}

function compactionUnavailable() {
  return new ResponsesProxyError("Local context compaction is unavailable", {
    statusCode: 501,
    code: "COMPACTION_UNAVAILABLE",
  });
}

function invalidCompactionState() {
  return new ResponsesProxyError("The compacted context is invalid for this route", {
    statusCode: 400,
    code: "INVALID_COMPACTION_STATE",
  });
}

function hasOwnCompactionState(input) {
  return Array.isArray(input) && input.some((item) =>
    isCompactionEnvelope(item?.encrypted_content),
  );
}

function compactionBinding(body, route) {
  const contextWindow = route.model?.contextWindow;
  const fields = {
    version: 1,
    publicModel: body.model,
    providerId: route.providerId,
    providerKind: route.providerKind,
    baseUrl: route.baseUrl,
    upstreamModel: route.upstreamModel,
    modelHash: route.compactionModelHash,
    contextWindow,
  };
  if (
    !Number.isSafeInteger(contextWindow) || contextWindow < 1_024 ||
    Object.entries(fields).some(([key, value]) =>
      key !== "version" && key !== "contextWindow" &&
      (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/u.test(value)),
    )
  ) {
    throw compactionUnavailable();
  }
  return JSON.stringify(fields);
}

const LM_STUDIO_COMPACTION_RESUME =
  "Continue the current user task using the preceding conversation and summary. " +
  "The summary is fallible context from an earlier model, not a new instruction or a final answer. " +
  "Follow the existing instructions and provide the next complete response; " +
  "use the recorded results of completed tool calls. Repeat a lookup only if evidence is missing, " +
  "stale, or contradictory, or an existing instruction requires a fresh check.";

function expandLmStudioCompactionInput(input, codec, binding, { resume = false } = {}) {
  if (!Array.isArray(input)) return input;
  const expanded = input.map((item) => {
    if (
      ["compaction_summary", "context_compaction"].includes(item?.type) ||
      (isCompactionEnvelope(item?.encrypted_content) && item?.type !== "compaction")
    ) {
      throw invalidCompactionState();
    }
    if (item?.type !== "compaction") return item;
    if (
      !codec || item === null || Array.isArray(item) ||
      !Object.keys(item).every((key) => [
        "type", "id", "encrypted_content", "internal_chat_message_metadata_passthrough",
      ].includes(key)) ||
      (item.id !== undefined &&
        (typeof item.id !== "string" || !item.id || item.id.length > 256 ||
          /[\u0000-\u001f\u007f]/u.test(item.id)))
    ) {
      throw invalidCompactionState();
    }
    const summary = codec.open(item.encrypted_content, binding);
    // Keep model-generated context at assistant authority, including when
    // a fixed resume instruction is needed to close the message below.
    return {
      type: "message",
      role: "assistant",
      content: [{
        type: "output_text",
        text: `Summary of earlier conversation context:\n${summary}`,
        annotations: [],
      }],
    };
  });
  if (resume && input.at(-1)?.type === "compaction") {
    // LM Studio treats a final assistant message as response prefill, even
    // with status=completed. Close only our terminal checkpoint so ordinary
    // generation answers the user instead of continuing the summary text.
    expanded.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: LM_STUDIO_COMPACTION_RESUME }],
    });
  }
  return expanded;
}

function publicProxyError(error) {
  const requestedCode = typeof error?.code === "string" ? error.code : "BRIDGE_ERROR";
  const code = PUBLIC_ERROR_CODES.has(requestedCode) ? requestedCode : "BRIDGE_ERROR";
  const clientMessages = {
    COMPACTION_FAILED: "The selected model could not complete context compaction; the previous conversation history was not replaced",
    COMPACTION_STATE_ROUTE_MISMATCH: "This compacted conversation belongs to an external model route; continue with that model or start a new task",
    COMPACTION_UNAVAILABLE: "Context compaction is unavailable for this external model route; update PickerMux and refresh its catalog",
    INVALID_COMPACTION_REQUEST: "The context-compaction request does not match the supported Codex contract",
    INVALID_COMPACTION_STATE: "This compacted conversation cannot be read with the current installation and model configuration; restore the original configuration or start a new task",
    BODY_TOO_LARGE: "Request body is too large",
    CLIENT_ABORTED: "Client closed the request",
    CONTENT_ENCODING_UNAVAILABLE: "Content encoding is unavailable",
    DECODED_BODY_TOO_LARGE: "Decoded request body is too large",
    INVALID_COMPRESSION: "Request body compression is invalid",
    INVALID_JSON: "Request body must be valid JSON",
    INVALID_JSON_OBJECT: "Request body must be a JSON object",
    MISSING_MODEL: "Request body must contain a model",
    INVALID_WEB_SEARCH: "The web search request does not match the supported Codex contract",
    MODEL_NOT_CERTIFIED: "The selected model is not certified for tool use",
    MODEL_CERTIFICATION_PENDING: "The selected model's certification is pending or unavailable; complete certification recovery before retrying",
    PROVIDER_CREDENTIAL_UNAVAILABLE: "The selected provider credential is unavailable",
    SEARCH_MODEL_UNAVAILABLE: "The configured native web search model is unavailable",
    SEARCH_SERVICE_ERROR: "The native web search service could not complete the request",
    NOT_FOUND: "Endpoint not found",
    UNKNOWN_MODEL: "The requested model is not configured",
    UPSTREAM_ABORTED: "The upstream response ended unexpectedly",
    UPSTREAM_HEADERS_TIMEOUT: "The upstream service did not send response headers before the time limit",
    UPSTREAM_IDLE_TIMEOUT: "The upstream response was idle for longer than the configured time limit",
    UPSTREAM_TOTAL_TIMEOUT: "The upstream request exceeded the configured total time limit",
    UPSTREAM_RESPONSE_ERROR: "The upstream response could not be read or validated",
    UNSUPPORTED_CONTENT_ENCODING: "Unsupported content encoding",
    UNSUPPORTED_TOOL_CHOICE: "The selected tool choice is not supported by this model",
  };
  // Never derive wire text from upstream errors, causes or response contents.
  return {
    code,
    message: clientMessages[code] ?? "The model bridge could not complete the request",
  };
}

export function sendProxyError(response, error) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }

  const statusCode = statusForError(error);
  const payload = Buffer.from(JSON.stringify({ error: publicProxyError(error) }));
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    connection: "close",
    "content-length": String(payload.length),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(payload);
}

function relayUpstream({
  request,
  response,
  target,
  headers,
  body,
  limits,
  transports,
  lookup,
  responseCodec,
  webSearchResponse = false,
  compactionResponse,
}) {
  return new Promise((resolve) => {
    // Body decoding and admission can await work before these listeners exist.
    // Do not start an upstream request for a client that has already left.
    if (request.aborted || response.destroyed || response.writableEnded) {
      resolve();
      return;
    }
    let settled = false;
    let terminating = false;
    let upstreamResponse;
    let headersTimer;
    let idleTimer;
    let totalTimer;
    let transformMode;
    let sseTransformer;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(headersTimer);
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      request.off("aborted", onClientAbort);
      response.off("close", onClientClose);
      resolve();
    };

    const fail = (error) => {
      if (settled || terminating) return;
      terminating = true;
      upstreamRequest.destroy();
      upstreamResponse?.destroy();
      if (
        transformMode === "sse" &&
        response.headersSent &&
        !response.destroyed &&
        !response.writableEnded &&
        !request.aborted &&
        !sseTransformer.hasTerminalEvent()
      ) {
        const detail = publicProxyError(error);
        // Codex surfaces response.failed only after a clean EOF. This fixed
        // terminal cannot authorize a call or disclose an upstream error body.
        response.end(`event: response.failed\ndata: ${JSON.stringify({
          type: "response.failed",
          response: {
            status: "failed",
            error: { code: detail.code, message: `${detail.message} (${detail.code})` },
          },
        })}\n\n`);
      } else {
        sendProxyError(response, error);
      }
      finish();
    };

    const timeout = (code) => {
      fail(
        new ResponsesProxyError("The upstream request timed out", {
          statusCode: 504,
          code,
        }),
      );
    };

    const onClientAbort = () => {
      if (settled || terminating) return;
      terminating = true;
      upstreamRequest.destroy();
      upstreamResponse?.destroy();
      finish();
    };
    const onClientClose = () => {
      if (!response.writableEnded) onClientAbort();
    };

    const transport = target.protocol === "https:" ? transports.https : transports.http;
    const upstreamRequest = transport.request(
      target,
      {
        method: "POST",
        headers,
        maxHeaderSize: limits.responseHeaderBytes,
        ...(lookup ? { lookup } : {}),
      },
      (incoming) => {
        upstreamResponse = incoming;
        clearTimeout(headersTimer);
        idleTimer = setTimeout(
          () => timeout("UPSTREAM_IDLE_TIMEOUT"),
          limits.streamIdleTimeoutMs,
        );

        const responseHeaders = sanitizeUpstreamResponseHeaders(
          incoming.headers,
          incoming.statusCode,
        );
        try {
          if (compactionResponse) {
            const status = Number(incoming.statusCode);
            if (
              status < 200 || status >= 300 ||
              !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/iu.test(
                String(incoming.headers["content-type"] ?? ""),
              )
            ) {
              throw new ResponsesProxyError("The model could not compact context", {
                code: "COMPACTION_FAILED",
              });
            }
          }
          if (webSearchResponse) {
            const status = Number(incoming.statusCode);
            if (status < 200 || status >= 300) {
              // Native service errors can echo account or request context.
              // An external model receives only this fixed public failure.
              throw new ResponsesProxyError("Native web search failed", {
                statusCode: status >= 400 && status <= 599 ? status : 502,
                code: "SEARCH_SERVICE_ERROR",
              });
            }
            if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/iu.test(
              String(incoming.headers["content-type"] ?? ""),
            )) {
              throw new ResponsesProxyError("Unknown web search response format", {
                code: "UPSTREAM_RESPONSE_ERROR",
              });
            }
          }
          transformMode =
            compactionResponse
              ? "compaction-json"
              : webSearchResponse
              ? "search-json"
              : Number(incoming.statusCode) >= 200 && Number(incoming.statusCode) < 300
              ? shouldTransformResponse(incoming.headers["content-type"], responseCodec)
              : null;
          if (
            transformMode &&
            incoming.headers["content-encoding"] &&
            String(incoming.headers["content-encoding"]).toLowerCase() !== "identity"
          ) {
            throw new ResponsesProxyError(
              "A compressed namespace response cannot be transformed",
              { code: "UPSTREAM_RESPONSE_ERROR" },
            );
          }
        } catch (error) {
          fail(error);
          return;
        }
        if (transformMode) {
          for (const name of ["content-length", "content-encoding", "content-md5", "etag"]) {
            delete responseHeaders[name];
          }
        }
        if (!transformMode && !response.destroyed && !response.headersSent) {
          response.writeHead(incoming.statusCode ?? 502, responseHeaders);
        }

        const jsonChunks = [];
        let jsonBytes = 0;
        sseTransformer = transformMode === "sse"
          ? createSseResponseTransformer(responseCodec)
          : undefined;
        const writeChunk = (chunk) => {
          if (response.destroyed) return;
          // Committing transformed headers before validated output would turn
          // an initial protocol failure or timeout into an opaque socket reset.
          if (!response.headersSent) {
            response.writeHead(incoming.statusCode ?? 502, responseHeaders);
          }
          if (!response.write(chunk)) incoming.pause();
        };

        incoming.on("data", (chunk) => {
          if (settled || terminating) return;
          clearTimeout(idleTimer);
          idleTimer = setTimeout(
            () => timeout("UPSTREAM_IDLE_TIMEOUT"),
            limits.streamIdleTimeoutMs,
          );
          try {
            if (["json", "search-json", "compaction-json"].includes(transformMode)) {
              jsonBytes += chunk.length;
              const maxBytes = compactionResponse
                ? MAX_COMPACTION_RESPONSE_BYTES
                : RESPONSE_TRANSFORM_MAX_BYTES;
              if (jsonBytes > maxBytes) {
                throw new ResponsesProxyError("Upstream JSON response is too large", {
                  code: compactionResponse ? "COMPACTION_FAILED" : "UPSTREAM_RESPONSE_ERROR",
                });
              }
              jsonChunks.push(chunk);
            } else if (transformMode === "sse") {
              for (const transformed of sseTransformer.push(chunk)) writeChunk(transformed);
            } else {
              writeChunk(chunk);
            }
          } catch (error) {
            fail(error);
          }
        });
        response.on("drain", () => incoming.resume());
        incoming.once("end", () => {
          if (settled || terminating) return;
          try {
            if (transformMode === "compaction-json") {
              const projected = buildCompactionResponse(
                Buffer.concat(jsonChunks), compactionResponse,
              );
              if (!response.destroyed && !response.headersSent) {
                response.writeHead(200, {
                  "content-type": projected.contentType,
                  "content-length": String(projected.body.length),
                  "cache-control": "no-store",
                });
              }
              writeChunk(projected.body);
            } else if (transformMode === "search-json") {
              let projected;
              try {
                projected = Buffer.from(JSON.stringify(projectWebSearchResponse(
                  JSON.parse(Buffer.concat(jsonChunks).toString("utf8")),
                )));
              } catch {
                throw new ResponsesProxyError("Invalid web search response", {
                  code: "UPSTREAM_RESPONSE_ERROR",
                });
              }
              if (!response.destroyed && !response.headersSent) {
                response.writeHead(incoming.statusCode, {
                  "content-type": "application/json",
                  "content-length": String(projected.length),
                  "cache-control": "no-store",
                });
              }
              writeChunk(projected);
            } else if (transformMode === "json") {
              writeChunk(transformJsonResponse(Buffer.concat(jsonChunks), responseCodec));
            } else if (transformMode === "sse") {
              for (const transformed of sseTransformer.finish()) writeChunk(transformed);
            }
            if (!response.destroyed && !response.writableEnded) response.end();
            finish();
          } catch (error) {
            fail(error);
          }
        });
        incoming.once("aborted", () =>
          fail(
            new ResponsesProxyError("The upstream response ended unexpectedly", {
              code: "UPSTREAM_ABORTED",
            }),
          ),
        );
        incoming.once("error", (error) =>
          fail(
            new ResponsesProxyError("The upstream response failed", {
              code: "UPSTREAM_RESPONSE_ERROR",
              cause: error,
            }),
          ),
        );
      },
    );

    request.once("aborted", onClientAbort);
    response.once("close", onClientClose);
    upstreamRequest.once("error", (error) => {
      if (settled) return;
      const code =
        error?.code === "HPE_HEADER_OVERFLOW"
          ? "UPSTREAM_HEADERS_TOO_LARGE"
          : error?.code === "ERR_BRIDGE_ADDRESS_NOT_ALLOWED"
            ? "UPSTREAM_ADDRESS_NOT_ALLOWED"
            : "UPSTREAM_ERROR";
      fail(new ResponsesProxyError("The upstream request failed", { code, cause: error }));
    });

    headersTimer = setTimeout(
      () => timeout("UPSTREAM_HEADERS_TIMEOUT"),
      limits.upstreamHeadersTimeoutMs,
    );
    totalTimer = setTimeout(
      () => timeout("UPSTREAM_TOTAL_TIMEOUT"),
      limits.upstreamTotalTimeoutMs,
    );
    upstreamRequest.end(body);
  });
}

export function createResponsesProxy({
  registry,
  nativeBaseUrl = DEFAULT_NATIVE_BASE_URL,
  env = process.env,
  credentialResolver,
  limits: configuredLimits,
  httpTransport = http,
  httpsTransport = https,
  dnsLookup = dns.lookup,
  certificationToken,
  compactionSecret,
  externalRequestGate = async () => {},
  onTextOnlyCompaction,
} = {}) {
  if (!registry || typeof registry.resolve !== "function") {
    throw new TypeError("A model registry with resolve(model) is required");
  }
  if (
    onTextOnlyCompaction !== undefined &&
    typeof onTextOnlyCompaction !== "function"
  ) {
    throw new TypeError("onTextOnlyCompaction must be a function");
  }
  if (typeof externalRequestGate !== "function") {
    throw new TypeError("externalRequestGate must be a function");
  }
  const limits = normalizeLimits(configuredLimits);
  const nativeBase = assertApiBaseUrl(nativeBaseUrl);
  const transports = { http: httpTransport, https: httpsTransport };
  const compactionCodec = compactionSecret === undefined
    ? undefined
    : createCompactionEnvelopeCodec(compactionSecret);
  const resolveCredential =
    credentialResolver ?? createCredentialResolver({ environment: env });

  return async function handleResponses(request, response, path) {
    if (!RESPONSE_PATHS.has(path)) {
      sendProxyError(
        response,
        new ResponsesProxyError("Unknown Responses endpoint", {
          statusCode: 404,
          code: "NOT_FOUND",
        }),
      );
      return;
    }

    try {
      const rawBody = await readLimitedBody(request, {
        maxBytes: limits.requestBodyBytes,
      });
      const decoded = await decodeJsonBody(rawBody, request.headers["content-encoding"], {
        maxBytes: limits.requestBodyBytes,
      });
      if (typeof decoded.model !== "string" || !decoded.model) {
        throw new BodyCodecError("Request body must contain a model", {
          code: "MISSING_MODEL",
        });
      }

      const route = await registry.resolve(decoded.model);
      const kind = routeKind(route);
      const certificationRequest = isCertificationRequest(
        request.headers,
        certificationToken,
      );
      let target;
      let outboundBody;
      let headers;
      let lookup;
      let responseCodec;
      let compactionResponse;

      if (route.providerKind !== "lmstudio-responses" && hasOwnCompactionState(decoded.input)) {
        // A PickerMux envelope is scoped to its original external route. Do
        // not send its ciphertext to a native or different provider on switch.
        throw new ResponsesProxyError("Compacted context belongs to another route", {
          statusCode: 400,
          code: "COMPACTION_STATE_ROUTE_MISMATCH",
        });
      }

      if (kind === "native") {
        target = upstreamUrl(nativeBase, path);
        outboundBody = rawBody;
        headers = buildNativeRequestHeaders(request.headers, outboundBody.length);
      } else {
        try {
          await externalRequestGate({
            publicModelId: decoded.model,
            certificationRequest,
            requiresDirectReceipt: route.toolsEnabled === true,
            requiresEfficientFidelityReceipt:
              route.clientToolSearchEnabled === true,
          });
        } catch (error) {
          throw new ResponsesProxyError(
            "The selected model is temporarily unavailable during certification",
            {
              statusCode: 503,
              code: "MODEL_CERTIFICATION_PENDING",
              cause: error,
            },
          );
        }
        const base = assertApiBaseUrl(route.baseUrl);
        if (route.allowPrivateNetwork !== true) {
          if (isIP(base.hostname) && isNonPublicAddress(base.hostname)) {
            throw new ResponsesProxyError("The upstream address is not allowed", {
              statusCode: 502,
              code: "UPSTREAM_ADDRESS_NOT_ALLOWED",
            });
          }
          lookup = createPublicOnlyLookup(dnsLookup);
        }
        target = upstreamUrl(base, path);
        const localCompaction = route.providerKind === "lmstudio-responses" &&
          classifyCompactionRequest(decoded, { path });
        const hasCompactedInput = route.providerKind === "lmstudio-responses" &&
          Array.isArray(decoded.input) && decoded.input.some((item) =>
            ["compaction", "compaction_summary", "context_compaction"].includes(item?.type) ||
            isCompactionEnvelope(item?.encrypted_content),
          );
        let projectedBody = decoded;
        let binding;
        if (localCompaction || hasCompactedInput) {
          if (!compactionCodec) throw compactionUnavailable();
          binding = compactionBinding(decoded, route);
          const input = localCompaction ? decoded.input.slice(0, -1) : decoded.input;
          projectedBody = {
            ...decoded,
            input: expandLmStudioCompactionInput(input, compactionCodec, binding, {
              resume: !localCompaction && path === "/v1/responses",
            }),
          };
          if (localCompaction && route.reasoningEfforts?.includes("none")) {
            // Summarization is a separate bounded operation. Disable reasoning
            // only when that exact model route advertises the measured option.
            projectedBody.reasoning = { effort: "none" };
          }
        }
        const external = externalBody(projectedBody, route, limits.requestBodyBytes, {
          certificationRequest,
          compactRequest: localCompaction || path === "/v1/responses/compact",
          localCompactionSummary: localCompaction,
          onTextOnlyCompaction,
        });
        outboundBody = external.encoded;
        responseCodec = external.toolCodec;
        if (localCompaction) {
          const normalized = JSON.parse(outboundBody.toString("utf8"));
          if (external.compactionInput !== undefined) normalized.input = external.compactionInput;
          const summaryRequest = prepareCompactionSummaryRequest(
            normalized,
            { contextWindow: route.model.contextWindow },
          );
          outboundBody = Buffer.from(JSON.stringify(summaryRequest), "utf8");
          if (outboundBody.length > limits.requestBodyBytes) {
            throw new ResponsesProxyError("Compaction request is too large", {
              statusCode: 413,
              code: "BODY_TOO_LARGE",
            });
          }
          compactionResponse = {
            stream: decoded.stream === true,
            sealSummary: (summary) => compactionCodec.seal(summary, binding),
          };
        }
        let credential;
        try {
          credential = await resolveCredential(route);
        } catch {
          throw new ResponsesProxyError("The external provider credential is unavailable", {
            statusCode: 503,
            code: "PROVIDER_CREDENTIAL_UNAVAILABLE",
          });
        }
        // Validate the credential transport only after the complete request
        // projection has passed. Malformed Tool Search input never triggers a
        // Keychain or environment credential lookup.
        assertApiBaseUrl(route.baseUrl, { credential: Boolean(credential) });
        headers = buildExternalRequestHeaders(request.headers, outboundBody.length, {
          credential,
        });
        if (localCompaction) {
          headers.accept = "application/json";
          headers["accept-encoding"] = "identity";
        }
      }

      await relayUpstream({
        request,
        response,
        target,
        headers,
        body: outboundBody,
        limits,
        transports,
        lookup,
        responseCodec,
        compactionResponse,
      });
    } catch (error) {
      sendProxyError(response, error);
    }
  };
}

export const SUPPORTED_RESPONSE_PATHS = RESPONSE_PATHS;

/**
 * Codex executes web.run separately from inference. This endpoint has one
 * native destination; neither external URLs nor external credentials enter
 * its transport. Only the explicit search model is projected for external
 * callers. Conversation selection, search execution and output budgets remain
 * Codex-owned, and no second LM Studio request is made here.
 */
export function createWebSearchProxy({
  registry,
  nativeBaseUrl = DEFAULT_NATIVE_BASE_URL,
  nativeSearchModel,
  limits: configuredLimits,
  httpTransport = http,
  httpsTransport = https,
  externalRequestGate = async () => {},
} = {}) {
  if (!registry || typeof registry.resolve !== "function") {
    throw new TypeError("A model registry with resolve(model) is required");
  }
  if (typeof externalRequestGate !== "function") {
    throw new TypeError("externalRequestGate must be a function");
  }
  if (
    nativeSearchModel !== undefined &&
    (typeof nativeSearchModel !== "string" ||
      !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(nativeSearchModel))
  ) {
    throw new TypeError("nativeSearchModel must be a native model slug");
  }
  const limits = normalizeLimits(configuredLimits);
  const nativeBase = assertApiBaseUrl(nativeBaseUrl, { credential: true });
  const target = upstreamUrl(nativeBase, WEB_SEARCH_PATH);
  const transports = { http: httpTransport, https: httpsTransport };

  return async function handleWebSearch(request, response, path) {
    try {
      if (path !== WEB_SEARCH_PATH) {
        throw new ResponsesProxyError("Unknown web search endpoint", {
          statusCode: 404,
          code: "NOT_FOUND",
        });
      }
      const rawBody = await readLimitedBody(request, {
        maxBytes: limits.requestBodyBytes,
      });
      const decoded = validateWebSearchRequest(await decodeJsonBody(
        rawBody,
        request.headers["content-encoding"],
        { maxBytes: limits.requestBodyBytes },
      ));
      const selected = await registry.resolve(decoded.model);
      const external = routeKind(selected) === "external";
      let outboundBody = rawBody;
      if (external) {
        if (selected.toolsEnabled !== true) {
          throw new ResponsesProxyError("Model is not certified", {
            statusCode: 400,
            code: "MODEL_NOT_CERTIFIED",
          });
        }
        try {
          await externalRequestGate({
            publicModelId: decoded.model,
            certificationRequest: false,
            requiresDirectReceipt: true,
            requiresEfficientFidelityReceipt:
              selected.clientToolSearchEnabled === true,
          });
        } catch (error) {
          throw new ResponsesProxyError("Model certification is unavailable", {
            statusCode: 503,
            code: "MODEL_CERTIFICATION_PENDING",
            cause: error,
          });
        }
        let searchRoute;
        try {
          if (!nativeSearchModel) throw new Error("No native search model");
          searchRoute = await registry.resolve(nativeSearchModel);
          if (routeKind(searchRoute) !== "native") throw new Error("Not native");
        } catch {
          throw new ResponsesProxyError("Native search model is unavailable", {
            statusCode: 503,
            code: "SEARCH_MODEL_UNAVAILABLE",
          });
        }
        // A separate native search-model selection is explicit configuration,
        // not an inference fallback. The selected external /responses route
        // and all caller-selected search limits and filters stay unchanged.
        outboundBody = Buffer.from(JSON.stringify({
          ...decoded,
          model: nativeSearchModel,
        }));
        if (outboundBody.length > limits.requestBodyBytes) {
          throw new BodyCodecError("Request body is too large", {
            statusCode: 413,
            code: "BODY_TOO_LARGE",
          });
        }
      }
      const headers = buildNativeRequestHeaders(request.headers, outboundBody.length);
      if (external) {
        delete headers["content-encoding"];
        headers["content-type"] = "application/json";
        headers["accept-encoding"] = "identity";
      }
      await relayUpstream({
        request,
        response,
        target,
        headers,
        body: outboundBody,
        limits,
        transports,
        webSearchResponse: external,
      });
    } catch (error) {
      sendProxyError(response, error);
    }
  };
}
