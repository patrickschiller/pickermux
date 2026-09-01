import { createHash } from "node:crypto";
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
  normalizeLmStudioToolRequest,
} from "./tool-normalization.mjs";
import { isCertificationRequest } from "./certification-transport.mjs";
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
// These hashes are compatibility contracts, not fuzzy classifiers. The memory
// template is from official Codex tag rust-v0.151.0-alpha.7.2 at
// f70e26c29ccb731e22d1104de550b1b9594d7070; app, thread-coordination, and
// multi-agent payloads are isolated 0.151 Desktop observations. Matching
// fixtures live under test/fixtures so a future update can add exact hashes.
const CODEX_0_151_PINNED_CONTEXT_HASHES = Object.freeze({
  appContextWithSidebar:
    "e45c36298b394ab28f8a6f697a59da8e04348584653565fbf49fa4ff4a4a56ae",
  appContextWithoutSidebar:
    "3d6d915dd2a63eea14584c23ef53bc44b24784c03eb661a7d462423fa3191827",
  threadCoordination:
    "b77b4dd2707147d804500a67f49a1dc3168fb6c0e6e4949c0a38173980cd7e2f",
  memoryTemplate:
    "62f16ea70e43a4c48ff1543e5bcb86dbf37eb400cf364db5f1507f1b6d45ec43",
  rootMultiAgentUsageHint:
    "af60719c7b64906bd05733aec72a96726712fe25d382a7bc9e05a6733cfd67dc",
  subagentMultiAgentUsageHint:
    "af4940bc6da67fab366fdbdb98c9979b37d10d05e703aaf3784a0a3f2cf6264f",
});
const CODEX_0_151_GENERIC_DEVELOPER_BOOTSTRAP_HASHES = new Set([
  CODEX_0_151_PINNED_CONTEXT_HASHES.appContextWithSidebar,
  CODEX_0_151_PINNED_CONTEXT_HASHES.appContextWithoutSidebar,
  CODEX_0_151_PINNED_CONTEXT_HASHES.threadCoordination,
]);
const CODEX_0_151_MULTI_AGENT_USAGE_HINT_HASHES = new Set([
  CODEX_0_151_PINNED_CONTEXT_HASHES.rootMultiAgentUsageHint,
  CODEX_0_151_PINNED_CONTEXT_HASHES.subagentMultiAgentUsageHint,
]);
const LM_STUDIO_TEXT_ONLY_OMITTED_CONTEXT = new Map([
  [
    "generic.developer_instructions",
    {
      roles: new Set(["developer"]),
      validate: (part) =>
        hasPinnedContextHash(
          part,
          CODEX_0_151_GENERIC_DEVELOPER_BOOTSTRAP_HASHES,
        ),
    },
  ],
  [
    "memories.instructions",
    {
      roles: new Set(["developer"]),
      validate: hasExactMemoryBootstrap,
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
      validate: (part) =>
        hasPinnedContextHash(part, CODEX_0_151_MULTI_AGENT_USAGE_HINT_HASHES),
    },
  ],
  [
    "multi_agent.role_instructions",
    {
      roles: new Set(["developer"]),
      standalone: true,
      validate: (part) =>
        hasPinnedContextHash(part, CODEX_0_151_MULTI_AGENT_USAGE_HINT_HASHES),
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
  "INVALID_UPSTREAM_MODEL",
  "MISSING_MODEL",
  "NOT_FOUND",
  "PROVIDER_CREDENTIAL_UNAVAILABLE",
  "UNKNOWN_MODEL",
  "UNSUPPORTED_CONTENT_ENCODING",
  "UNSUPPORTED_TOOL_CHOICE",
  "UNSUPPORTED_TOOL_TYPE",
  "UPSTREAM_ABORTED",
  "UPSTREAM_ADDRESS_NOT_ALLOWED",
  "UPSTREAM_ERROR",
  "UPSTREAM_HEADERS_TIMEOUT",
  "UPSTREAM_HEADERS_TOO_LARGE",
  "UPSTREAM_IDLE_TIMEOUT",
  "UPSTREAM_RESPONSE_ERROR",
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
      item?.type === "message" &&
      (item.role === "system" || item.role === "developer")
    ) {
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

function contextHash(text) {
  return createHash("sha256").update(text).digest("hex");
}

function hasPinnedContextHash(part, expectedHashOrHashes) {
  const actualHash = hasExactInputTextShape(part)
    ? contextHash(part.text.trim())
    : null;
  return (
    actualHash !== null &&
    (expectedHashOrHashes instanceof Set
      ? expectedHashOrHashes.has(actualHash)
      : actualHash === expectedHashOrHashes)
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

function hasExactMemoryBootstrap(part) {
  if (!hasExactInputTextShape(part)) return false;
  const text = part.text.trim();
  const summaryOpening = "========= MEMORY_SUMMARY BEGINS =========\n";
  const summaryClosing = "\n========= MEMORY_SUMMARY ENDS =========";
  const openingIndex = text.indexOf(summaryOpening);
  const summaryStart = openingIndex + summaryOpening.length;
  const closingIndex = text.indexOf(summaryClosing, summaryStart);
  if (
    openingIndex === -1 ||
    closingIndex <= summaryStart ||
    text.indexOf(summaryOpening, summaryStart) !== -1 ||
    text.indexOf(summaryClosing, closingIndex + summaryClosing.length) !== -1 ||
    text.slice(summaryStart, closingIndex).trim().length === 0
  ) {
    return false;
  }

  const basePathOpening = "Memory layout (general -> specific):\n\n- ";
  const basePathClosing =
    "/memory_summary.md (already provided below; do NOT open again)";
  const basePathStart = text.indexOf(basePathOpening) + basePathOpening.length;
  const basePathEnd = text.indexOf(basePathClosing, basePathStart);
  if (
    basePathStart < basePathOpening.length ||
    basePathEnd <= basePathStart ||
    basePathEnd >= openingIndex
  ) {
    return false;
  }
  const basePath = text.slice(basePathStart, basePathEnd);
  if (!basePath.startsWith("/") || basePath.includes("\n")) return false;

  const canonical = (
    text.slice(0, summaryStart) +
    "{{ memory_summary }}" +
    text.slice(closingIndex)
  ).replaceAll(basePath, "{{ base_path }}");
  return (
    contextHash(canonical) ===
    CODEX_0_151_PINNED_CONTEXT_HASHES.memoryTemplate
  );
}

function lmStudioTextOnlyContextDisposition(kind, role, part, contentLength) {
  const omittedContext = LM_STUDIO_TEXT_ONLY_OMITTED_CONTEXT.get(kind);
  if (omittedContext) {
    const validContent =
      typeof omittedContext.validate === "function"
        ? omittedContext.validate(part)
        : hasExactContextEnvelope(part, omittedContext.markers);
    return omittedContext.roles.has(role) &&
      (!omittedContext.standalone || contentLength === 1) &&
      validContent
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
  let compactingBootstrap = true;
  for (const item of input) {
    if (
      !compactingBootstrap ||
      item === null ||
      Array.isArray(item) ||
      typeof item !== "object" ||
      item.type !== "message" ||
      !LM_STUDIO_TEXT_ONLY_BOOTSTRAP_ROLES.has(item.role)
    ) {
      compactingBootstrap = false;
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
      compactingBootstrap = false;
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
      compactingBootstrap = false;
      compacted.push(item);
      continue;
    }

    const content = item.content.filter(
      (_part, index) => dispositions[index] !== "omit",
    );
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
  return compacted;
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
        (item.type === "function_call" || item.type === "function_call_output"),
    )
  );
}

function enforceTextOnlyRequest(rewritten, source) {
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

function externalBody(body, route, maxBytes, { certificationRequest = false } = {}) {
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
  if (Array.isArray(body.input)) {
    const sourceInput =
      route.providerKind === "lmstudio-responses" && !toolsEnabled
        ? compactLmStudioTextOnlyInput(body.input)
        : body.input;
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
  }

  let toolCodec;
  if (!toolsEnabled) enforceTextOnlyRequest(rewritten, body);
  if (route.providerKind === "lmstudio-responses") {
    delete rewritten.prompt_cache_key;
    if (Array.isArray(body.include)) {
      const include = body.include.filter(
        (value) => value !== "reasoning.encrypted_content",
      );
      if (include.length === 0) delete rewritten.include;
      else rewritten.include = include;
    }
    if (toolsEnabled) {
      toolCodec = normalizeLmStudioToolRequest(rewritten, body);
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

  const encoded = Buffer.from(JSON.stringify(rewritten), "utf8");
  if (encoded.length > maxBytes) {
    throw new BodyCodecError("Request body is too large", {
      statusCode: 413,
      code: "BODY_TOO_LARGE",
    });
  }
  return { encoded, toolCodec };
}

function statusForError(error) {
  const value = Number(error?.statusCode);
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 500;
}

export function sendProxyError(response, error) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }

  const statusCode = statusForError(error);
  const requestedCode = typeof error?.code === "string" ? error.code : "BRIDGE_ERROR";
  const code = PUBLIC_ERROR_CODES.has(requestedCode) ? requestedCode : "BRIDGE_ERROR";
  const clientMessages = {
    BODY_TOO_LARGE: "Request body is too large",
    CLIENT_ABORTED: "Client closed the request",
    CONTENT_ENCODING_UNAVAILABLE: "Content encoding is unavailable",
    DECODED_BODY_TOO_LARGE: "Decoded request body is too large",
    INVALID_COMPRESSION: "Request body compression is invalid",
    INVALID_JSON: "Request body must be valid JSON",
    INVALID_JSON_OBJECT: "Request body must be a JSON object",
    MISSING_MODEL: "Request body must contain a model",
    NOT_FOUND: "Endpoint not found",
    UNKNOWN_MODEL: "The requested model is not configured",
    UNSUPPORTED_CONTENT_ENCODING: "Unsupported content encoding",
    UNSUPPORTED_TOOL_CHOICE: "The selected tool choice is not supported by this model",
  };
  // No causes, target URLs, environment-variable names or header values are
  // included in the wire error. The stable code is sufficient for diagnosis.
  const payload = Buffer.from(
    JSON.stringify({
      error: {
        code,
        message: clientMessages[code] ?? "The model bridge could not complete the request",
      },
    }),
  );
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
}) {
  return new Promise((resolve) => {
    let settled = false;
    let terminating = false;
    let upstreamResponse;
    let headersTimer;
    let idleTimer;
    let totalTimer;

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
      sendProxyError(response, error);
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
        let transformMode;
        try {
          transformMode =
            Number(incoming.statusCode) >= 200 && Number(incoming.statusCode) < 300
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
        if (!response.destroyed && !response.headersSent) {
          response.writeHead(incoming.statusCode ?? 502, responseHeaders);
        }

        const jsonChunks = [];
        let jsonBytes = 0;
        const sseTransformer = transformMode === "sse"
          ? createSseResponseTransformer(responseCodec)
          : undefined;
        const writeChunk = (chunk) => {
          if (!response.destroyed && !response.write(chunk)) incoming.pause();
        };

        incoming.on("data", (chunk) => {
          if (settled || terminating) return;
          clearTimeout(idleTimer);
          idleTimer = setTimeout(
            () => timeout("UPSTREAM_IDLE_TIMEOUT"),
            limits.streamIdleTimeoutMs,
          );
          try {
            if (transformMode === "json") {
              jsonBytes += chunk.length;
              if (jsonBytes > RESPONSE_TRANSFORM_MAX_BYTES) {
                throw new ResponsesProxyError("Upstream JSON response is too large", {
                  code: "UPSTREAM_RESPONSE_ERROR",
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
            if (transformMode === "json") {
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
} = {}) {
  if (!registry || typeof registry.resolve !== "function") {
    throw new TypeError("A model registry with resolve(model) is required");
  }
  const limits = normalizeLimits(configuredLimits);
  const nativeBase = assertApiBaseUrl(nativeBaseUrl);
  const transports = { http: httpTransport, https: httpsTransport };
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
      let target;
      let outboundBody;
      let headers;
      let lookup;
      let responseCodec;

      if (kind === "native") {
        target = upstreamUrl(nativeBase, path);
        outboundBody = rawBody;
        headers = buildNativeRequestHeaders(request.headers, outboundBody.length);
      } else {
        let credential;
        try {
          credential = await resolveCredential(route);
        } catch {
          throw new ResponsesProxyError("The external provider credential is unavailable", {
            statusCode: 503,
            code: "PROVIDER_CREDENTIAL_UNAVAILABLE",
          });
        }
        const base = assertApiBaseUrl(route.baseUrl, { credential: Boolean(credential) });
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
        const external = externalBody(decoded, route, limits.requestBodyBytes, {
          certificationRequest: isCertificationRequest(
            request.headers,
            certificationToken,
          ),
        });
        outboundBody = external.encoded;
        responseCodec = external.toolCodec;
        headers = buildExternalRequestHeaders(request.headers, outboundBody.length, {
          credential,
        });
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
      });
    } catch (error) {
      sendProxyError(response, error);
    }
  };
}

export const SUPPORTED_RESPONSE_PATHS = RESPONSE_PATHS;
