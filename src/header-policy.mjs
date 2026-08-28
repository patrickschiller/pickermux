import { timingSafeEqual } from "node:crypto";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Keep this list intentionally narrow. These are the authentication, account,
// routing and tracing headers used by Codex's native Responses transport.
const NATIVE_EXACT_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "authorization",
  "baggage",
  "chatgpt-account-id",
  "content-encoding",
  "content-length",
  "content-type",
  "openai-beta",
  "originator",
  "session-id",
  "session_id",
  "thread-id",
  "traceparent",
  "tracestate",
  "x-client-request-id",
  "x-oai-attestation",
  "x-openai-fedramp",
  "x-openai-internal-codex-residency",
  "x-openai-internal-codex-responses-lite",
  "x-openai-memgen-request",
  "x-openai-subagent",
  "x-openai-subagent-source",
  "x-stainless-retry-count",
  "x-stainless-timeout",
]);

const NATIVE_PREFIXES = ["x-codex-"];
const EXTERNAL_CALLER_HEADERS = new Set(["accept", "content-type"]);

function lowerName(name) {
  return String(name).toLowerCase();
}

function copyHeaderValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }
  return value === undefined ? undefined : String(value);
}

function hasUnsafeHeaderValue(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.some((entry) => /[\r\n]/u.test(String(entry)));
}

export function isHopByHopHeader(name) {
  return HOP_BY_HOP_HEADERS.has(lowerName(name));
}

export function isNativeForwardHeader(name) {
  const normalized = lowerName(name);
  return (
    !HOP_BY_HOP_HEADERS.has(normalized) &&
    (NATIVE_EXACT_HEADERS.has(normalized) ||
      NATIVE_PREFIXES.some((prefix) => normalized.startsWith(prefix)))
  );
}

export function buildNativeRequestHeaders(incomingHeaders, bodyLength) {
  const result = Object.create(null);

  for (const [name, value] of Object.entries(incomingHeaders ?? {})) {
    const normalized = lowerName(name);
    if (!isNativeForwardHeader(normalized) || value === undefined) continue;
    if (hasUnsafeHeaderValue(value)) continue;
    result[normalized] = copyHeaderValue(value);
  }

  // Never trust a caller-supplied length after buffering the request.
  result["content-length"] = String(bodyLength);
  if (!result["content-type"]) result["content-type"] = "application/json";
  return result;
}

export function buildExternalRequestHeaders(
  incomingHeaders,
  bodyLength,
  { credential } = {},
) {
  const result = Object.create(null);

  for (const [name, value] of Object.entries(incomingHeaders ?? {})) {
    const normalized = lowerName(name);
    if (!EXTERNAL_CALLER_HEADERS.has(normalized) || value === undefined) continue;
    if (hasUnsafeHeaderValue(value)) continue;
    result[normalized] = copyHeaderValue(value);
  }

  // External requests are re-encoded as plain JSON, so caller credentials,
  // cookies, proxy headers, Codex headers and compression metadata never cross
  // the trust boundary.
  result["content-type"] = "application/json";
  result["accept-encoding"] = "identity";
  result["content-length"] = String(bodyLength);
  if (credential) {
    if (hasUnsafeHeaderValue(credential)) {
      throw new TypeError("Provider credential contains an invalid header value");
    }
    result.authorization = `Bearer ${credential}`;
  }
  return result;
}

export function sanitizeUpstreamResponseHeaders(headers, statusCode) {
  const result = Object.create(null);
  const connectionTokens = String(headers?.connection ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  for (const [name, value] of Object.entries(headers ?? {})) {
    const normalized = lowerName(name);
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(normalized) ||
      connectionTokens.includes(normalized) ||
      normalized === "set-cookie" ||
      normalized === "set-cookie2" ||
      normalized === "location"
    ) {
      continue;
    }
    if (hasUnsafeHeaderValue(value)) continue;
    result[normalized] = copyHeaderValue(value);
  }

  // A redirect is relayed as data and is never followed. Its Location header is
  // deliberately hidden above so private upstream topology cannot escape.
  if (Number(statusCode) >= 300 && Number(statusCode) < 400) {
    result["cache-control"] = "no-store";
  }
  return result;
}

export function expectedLoopbackHost(port) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65_535) {
    throw new TypeError("A valid loopback port is required");
  }
  return `127.0.0.1:${Number(port)}`;
}

export function isExpectedHost(hostHeader, port) {
  if (typeof hostHeader !== "string") return false;
  const expected = Buffer.from(expectedLoopbackHost(port));
  const actual = Buffer.from(hostHeader.trim().toLowerCase());
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hasDisallowedOrigin(headers) {
  return Object.hasOwn(headers ?? {}, "origin") || Object.hasOwn(headers ?? {}, "Origin");
}
