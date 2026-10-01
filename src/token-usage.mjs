import { TextDecoder } from "node:util";

import { isValidProviderId } from "./provider-id.mjs";

export const TOKEN_USAGE_MAX_PROVIDERS = 128;
export const TOKEN_USAGE_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const TOKEN_USAGE_MAX_SSE_FRAME_BYTES = 1024 * 1024;
const TERMINAL_STATUSES = new Set(["completed", "incomplete", "failed"]);
const TOKEN_FIELDS = ["inputTokens", "outputTokens", "totalTokens"];
const CONTENT_TYPE_PATTERN =
  /^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\/([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[\t\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\t\x20-\x7e])*"))*\s*$/u;
const STRUCTURED_JSON_SUBTYPE_PATTERN = /^[!#$%&'.^_`|~0-9a-z-]+\+json$/u;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function counter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function tokenCounts(inputTokens, outputTokens, totalTokens) {
  if (!counter(inputTokens) || !counter(outputTokens)) return null;
  const sum = inputTokens + outputTokens;
  if (!counter(sum) || (totalTokens !== undefined && totalTokens !== sum)) return null;
  return { inputTokens, outputTokens, totalTokens: sum };
}

function projectUsage(response) {
  if (!record(response) || !TERMINAL_STATUSES.has(response.status) || !record(response.usage)) {
    return null;
  }
  return tokenCounts(response.usage.input_tokens, response.usage.output_tokens, response.usage.total_tokens);
}

/** Reconstruct the finite public schema without carrying provider metadata. */
export function projectTokenUsageSnapshot(value) {
  if (!record(value) || value.schemaVersion !== 1 ||
      !["available", "unavailable"].includes(value.status) ||
      !Array.isArray(value.providers) || value.providers.length > TOKEN_USAGE_MAX_PROVIDERS ||
      (value.status === "unavailable" && value.providers.length !== 0)) return null;
  const seen = new Set();
  const providers = [];
  for (const provider of value.providers) {
    if (!record(provider) || !isValidProviderId(provider.providerId) || seen.has(provider.providerId) ||
        !counter(provider.requests) || provider.requests < 1 || !counter(provider.unavailableRequests) ||
        provider.unavailableRequests > provider.requests || !record(provider.last) ||
        !["available", "unavailable"].includes(provider.last.status)) return null;
    seen.add(provider.providerId);
    const availableRequests = provider.requests - provider.unavailableRequests;
    let last = { status: "unavailable" };
    if (provider.last.status === "available") {
      const counts = tokenCounts(provider.last.inputTokens, provider.last.outputTokens, provider.last.totalTokens);
      if (!counts || provider.last.totalTokens === undefined || availableRequests === 0) return null;
      last = { status: "available", ...counts };
    } else if (provider.requests > 0 && provider.unavailableRequests === 0) {
      return null;
    }
    let totals = null;
    if (provider.totals !== null) {
      if (!record(provider.totals) || provider.totals.totalTokens === undefined) return null;
      totals = tokenCounts(provider.totals.inputTokens, provider.totals.outputTokens, provider.totals.totalTokens);
      if (!totals || (availableRequests === 0 && totals.totalTokens !== 0) ||
          (last.status === "available" && TOKEN_FIELDS.some((key) => totals[key] < last[key])) ||
          (availableRequests === 1 && last.status === "available" &&
            TOKEN_FIELDS.some((key) => totals[key] !== last[key]))) return null;
    } else if (availableRequests < 2) {
      return null;
    }
    providers.push({
      providerId: provider.providerId,
      requests: provider.requests,
      unavailableRequests: provider.unavailableRequests,
      last,
      totals,
    });
  }
  return { schemaVersion: 1, status: value.status, providers };
}

/** Bridge-local counters contain only route-selected IDs and projected integers. */
export function createTokenUsageTelemetry() {
  const providers = new Map();
  let unavailable = false;
  return Object.freeze({
    record(providerId, value) {
      if (unavailable || !isValidProviderId(providerId)) return false;
      let provider = providers.get(providerId);
      if (!provider) {
        if (providers.size >= TOKEN_USAGE_MAX_PROVIDERS) {
          unavailable = true;
          providers.clear();
          return false;
        }
        provider = {
          providerId,
          requests: 0,
          unavailableRequests: 0,
          last: { status: "unavailable" },
          totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
        providers.set(providerId, provider);
      }
      if (provider.requests === Number.MAX_SAFE_INTEGER) return false;
      provider.requests += 1;
      const counts = record(value) && value.status === "available"
        ? tokenCounts(value.inputTokens, value.outputTokens, value.totalTokens)
        : null;
      if (!counts) {
        provider.unavailableRequests += 1;
        provider.last = { status: "unavailable" };
        return true;
      }
      provider.last = { status: "available", ...counts };
      if (provider.totals !== null) {
        const input = provider.totals.inputTokens + counts.inputTokens;
        const output = provider.totals.outputTokens + counts.outputTokens;
        // Overflow never becomes a rounded or saturated value presented as exact.
        provider.totals = tokenCounts(input, output);
      }
      return true;
    },
    snapshot() {
      if (unavailable) return { schemaVersion: 1, status: "unavailable", providers: [] };
      return projectTokenUsageSnapshot({
        schemaVersion: 1,
        status: "available",
        providers: [...providers.values()],
      });
    },
  });
}

/** Bounded side observation never rewrites, decompresses, or persists relay bytes. */
export function createTokenUsageObserver({
  onUsage,
  maxBufferedBytes = TOKEN_USAGE_MAX_RESPONSE_BYTES,
} = {}) {
  if (typeof onUsage !== "function" || !Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1) {
    throw new TypeError("Token usage observation requires a sink and positive byte limit");
  }
  let mode;
  let invalid = false;
  let finished = false;
  let buffered = "";
  let chunks = [];
  let jsonBytes = 0;
  let terminalSeen = false;
  let doneSeen = false;
  let candidate = null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const maxSseFrameBytes = Math.min(maxBufferedBytes, TOKEN_USAGE_MAX_SSE_FRAME_BYTES);
  const discard = () => {
    invalid = true;
    buffered = "";
    chunks = [];
    candidate = null;
  };
  const frame = (source) => {
    if (Buffer.byteLength(source) > maxSseFrameBytes) throw new Error();
    const data = [];
    const events = [];
    for (const line of source.split(/\r?\n/u)) {
      if (line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const key = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? "" : line.slice(separator + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (key === "data") data.push(value);
      if (key === "event") events.push(value);
    }
    if (events.length > 1 || (events.length > 0 && data.length === 0)) throw new Error();
    if (data.length === 0) return;
    const text = data.join("\n");
    if (text === "[DONE]") {
      if (events.length > 0 || !terminalSeen || doneSeen) throw new Error();
      doneSeen = true;
      return;
    }
    if (terminalSeen || doneSeen) throw new Error();
    const parsed = JSON.parse(text);
    if (!record(parsed) || typeof parsed.type !== "string" ||
        (events.length > 0 && events[0] !== parsed.type)) throw new Error();
    const status = parsed.type.startsWith("response.") ? parsed.type.slice(9) : undefined;
    if (TERMINAL_STATUSES.has(status)) {
      if (!record(parsed.response) || parsed.response.status !== status) throw new Error();
      terminalSeen = true;
      candidate = projectUsage(parsed.response);
    }
  };
  const drainFrames = () => {
    while (true) {
      const match = /\r?\n\r?\n/u.exec(buffered);
      if (!match) break;
      const source = buffered.slice(0, match.index);
      buffered = buffered.slice(match.index + match[0].length);
      frame(source);
    }
  };
  return Object.freeze({
    headers(statusCode, headers) {
      if (finished || invalid) return;
      const encoding = headers?.["content-encoding"];
      const contentType = String(headers?.["content-type"] ?? "");
      const parsedType = CONTENT_TYPE_PATTERN.exec(contentType);
      const type = parsedType?.[1].toLowerCase();
      const subtype = parsedType?.[2].toLowerCase();
      if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300 ||
          (encoding !== undefined && String(encoding).toLowerCase() !== "identity")) {
        discard();
      } else if (type === "text" && subtype === "event-stream") {
        mode = "sse";
      } else if (type === "application" &&
          (subtype === "json" || STRUCTURED_JSON_SUBTYPE_PATTERN.test(subtype ?? ""))) {
        mode = "json";
      } else {
        discard();
      }
    },
    push(chunk) {
      if (finished || invalid) return;
      try {
        if (!Buffer.isBuffer(chunk)) throw new Error();
        if (mode === "json") {
          jsonBytes += chunk.length;
          if (jsonBytes > maxBufferedBytes) throw new Error();
          chunks.push(chunk);
        } else if (mode === "sse") {
          // Limit each frame before decoding; a huge transport chunk must not
          // create an unbounded string even when it contains many tiny frames.
          for (let offset = 0; offset < chunk.length; offset += 4096) {
            buffered += decoder.decode(chunk.subarray(offset, offset + 4096), { stream: true });
            drainFrames();
            if (Buffer.byteLength(buffered) > maxSseFrameBytes) throw new Error();
          }
        } else {
          throw new Error();
        }
      } catch {
        discard();
      }
    },
    finish(success = false) {
      if (finished) return;
      finished = true;
      try {
        if (success && !invalid) {
          if (mode === "json") {
            candidate = projectUsage(JSON.parse(decoder.decode(Buffer.concat(chunks))));
          } else if (mode === "sse") {
            buffered += decoder.decode();
            // An unframed terminal may have been truncated. Only comments or
            // whitespace may trail a fully delimited terminal event.
            if (buffered.split(/\r?\n/u).some((line) => line.trim() !== "" && !line.startsWith(":"))) {
              candidate = null;
            }
            if (!terminalSeen) candidate = null;
          }
        } else {
          candidate = null;
        }
      } catch {
        candidate = null;
      }
      const projected = candidate ? { status: "available", ...candidate } : { status: "unavailable" };
      buffered = "";
      chunks = [];
      candidate = null;
      try {
        Promise.resolve(onUsage(projected)).catch(() => {});
      } catch { /* Observation cannot affect inference. */ }
    },
  });
}
