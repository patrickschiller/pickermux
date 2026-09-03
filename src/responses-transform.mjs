import { TextDecoder } from "node:util";

import {
  createClientToolSearchSseRewriter,
  createFunctionCallSseRewriter,
  rewriteClientToolSearchResponse,
  rewriteFunctionCallResponse,
} from "./efficient-fidelity.mjs";
import { rewriteResponseFunctionCalls } from "./tool-normalization.mjs";

const DEFAULT_MAX_TRANSFORM_BYTES = 32 * 1024 * 1024;
const CONTENT_TYPE_PATTERN =
  /^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\/([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[\t\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\t\x20-\x7e])*"))*\s*$/u;
const STRUCTURED_JSON_SUBTYPE_PATTERN =
  /^[!#$%&'.^_`|~0-9a-z-]+\+json$/u;
const MAX_SSE_EVENT_NAME_BYTES = 256;

export class ResponseTransformError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "ResponseTransformError";
    this.statusCode = 502;
    this.code = "UPSTREAM_RESPONSE_ERROR";
  }
}

function responseCodecs(codec) {
  if (codec?.efficientFidelityCodec) {
    return {
      efficientFidelityCodec: codec.efficientFidelityCodec,
      namespaceCodec: codec.namespaceCodec,
    };
  }
  return { efficientFidelityCodec: undefined, namespaceCodec: codec };
}

function namespaceResponsePolicyActive(namespaceCodec) {
  return (
    namespaceCodec?.allowedWireNames instanceof Set ||
    (namespaceCodec?.reverse?.size ?? 0) > 0 ||
    (namespaceCodec?.historyOnlyWireNames?.size ?? 0) > 0
  );
}

function parseJsonText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ResponseTransformError("Upstream response is not valid JSON", error);
  }
  return parsed;
}

function transformParsedResponse(parsed, codec, {
  includeEfficientFidelity = true,
  includeFunctionAuthority = true,
  responseMode = "json",
} = {}) {
  const { efficientFidelityCodec, namespaceCodec } = responseCodecs(codec);
  try {
    rewriteResponseFunctionCalls(parsed, namespaceCodec, { mode: responseMode });
    if (includeEfficientFidelity && efficientFidelityCodec) {
      return rewriteClientToolSearchResponse(parsed, efficientFidelityCodec).value;
    }
    return includeFunctionAuthority && namespaceResponsePolicyActive(namespaceCodec)
      ? rewriteFunctionCallResponse(parsed, {
        allowedWireNames: namespaceCodec.allowedWireNames,
        maxAuthorizedCalls: namespaceCodec.maxAuthorizedCalls,
        reservedCallIds: namespaceCodec.reservedCallIds,
        reservedItemIds: namespaceCodec.reservedItemIds,
      })
      : parsed;
  } catch (error) {
    throw new ResponseTransformError("Upstream function call could not be normalized", error);
  }
}

function transformJsonText(text, codec) {
  return JSON.stringify(transformParsedResponse(parseJsonText(text), codec));
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ResponseTransformError(`${label} is not valid UTF-8`, error);
  }
}

export function transformJsonResponse(buffer, codec) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("JSON response must be a Buffer");
  }
  return Buffer.from(
    transformJsonText(decodeUtf8(buffer, "Upstream JSON response"), codec),
    "utf8",
  );
}

function splitEventLines(source) {
  return source.split(/\r?\n/u);
}

function renderEvent(retained, insertAt, value) {
  const lines = [...retained];
  const eventLine = lines.findIndex((line) => line.startsWith("event:"));
  if (eventLine >= 0 && typeof value?.type === "string") {
    lines[eventLine] = `event: ${value.type}`;
  }
  lines.splice(insertAt, 0, `data: ${JSON.stringify(value)}`);
  return lines.join("\n");
}

function eventFrame(retained, insertAt) {
  const lines = Object.freeze([...retained]);
  return Object.freeze({
    framingBytes: Buffer.byteLength(lines.join("\n"), "utf8"),
    insertAt,
    retained: lines,
  });
}

function sseEventName(retained) {
  const values = [];
  for (const line of retained) {
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    if (field !== "event") continue;
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    values.push(value);
  }
  if (values.length > 1) {
    throw new ResponseTransformError(
      "Upstream SSE frame contains duplicate event fields",
    );
  }
  const [value] = values;
  if (
    value !== undefined &&
    (value.length === 0 ||
      Buffer.byteLength(value, "utf8") > MAX_SSE_EVENT_NAME_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(value))
  ) {
    throw new ResponseTransformError("Upstream SSE frame has an invalid event field");
  }
  return value;
}

function renderStreamResult(result, fallbackFrame) {
  const entries = result.streamEntries ?? result.events.map((event) => ({
    kind: "event",
    event,
    frame: fallbackFrame,
  }));
  return entries.map((entry) => {
    if (entry.kind === "raw") return entry.raw;
    const frame = entry.frame ?? fallbackFrame;
    return renderEvent(frame.retained, frame.insertAt, entry.event);
  });
}

function transformEvent(event, codec, toolSearchStream) {
  const lines = splitEventLines(event);
  const data = [];
  const retained = [];
  let insertAt = -1;
  for (const line of lines) {
    if (line === "data" || line.startsWith("data:")) {
      if (insertAt < 0) insertAt = retained.length;
      const raw = line === "data" ? "" : line.slice(5).replace(/^ /u, "");
      data.push(raw);
    } else {
      retained.push(line);
    }
  }
  const frame = eventFrame(retained, insertAt);
  const eventName = sseEventName(retained);
  if (data.length === 0) {
    if (eventName !== undefined) {
      throw new ResponseTransformError(
        "Upstream SSE named event has no data payload",
      );
    }
    if (!toolSearchStream) return [event];
    try {
      return renderStreamResult(toolSearchStream.pushRawFrame(event), frame);
    } catch (error) {
      throw new ResponseTransformError(
        "Upstream Tool Search stream could not be normalized",
        error,
      );
    }
  }
  const joined = data.join("\n");
  if (joined === "[DONE]") {
    if (eventName !== undefined) {
      throw new ResponseTransformError(
        "Upstream SSE event field does not match its data type",
      );
    }
    if (toolSearchStream) {
      try {
        toolSearchStream.acceptDoneMarker();
      } catch (error) {
        throw new ResponseTransformError(
          "Upstream Tool Search stream ended inconsistently",
          error,
        );
      }
    }
    return [event];
  }
  const parsed = transformParsedResponse(parseJsonText(joined), codec, {
    includeEfficientFidelity: false,
    includeFunctionAuthority: false,
    responseMode: "sse",
  });
  if (eventName !== undefined && eventName !== parsed?.type) {
    throw new ResponseTransformError(
      "Upstream SSE event field does not match its data type",
    );
  }
  if (!toolSearchStream) return [renderEvent(retained, insertAt, parsed)];
  let transformed;
  try {
    transformed = toolSearchStream.push(parsed, frame);
  } catch (error) {
    throw new ResponseTransformError(
      "Upstream Tool Search stream could not be normalized",
      error,
    );
  }
  return renderStreamResult(transformed, frame);
}

/** Incremental SSE event rewriter that tolerates arbitrary TCP chunking. */
export function createSseResponseTransformer(
  codec,
  { maxBufferedBytes = DEFAULT_MAX_TRANSFORM_BYTES } = {},
) {
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1024) {
    throw new TypeError("maxBufferedBytes must be an integer of at least 1024");
  }
  let buffered = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const { efficientFidelityCodec, namespaceCodec } = responseCodecs(codec);
  const toolSearchStream = efficientFidelityCodec
    ? createClientToolSearchSseRewriter(efficientFidelityCodec)
    : namespaceResponsePolicyActive(namespaceCodec)
      ? createFunctionCallSseRewriter({
        allowedWireNames: namespaceCodec.allowedWireNames,
        maxAuthorizedCalls: namespaceCodec.maxAuthorizedCalls,
        reservedCallIds: namespaceCodec.reservedCallIds,
        reservedItemIds: namespaceCodec.reservedItemIds,
      })
      : undefined;
  const push = (chunk) => {
    try {
      buffered += Buffer.isBuffer(chunk)
        ? decoder.decode(chunk, { stream: true })
        : String(chunk);
    } catch (error) {
      throw new ResponseTransformError("Upstream SSE is not valid UTF-8", error);
    }
    if (Buffer.byteLength(buffered) > maxBufferedBytes) {
      throw new ResponseTransformError("Upstream SSE event is too large");
    }
    const output = [];
    while (true) {
      const match = /\r?\n\r?\n/u.exec(buffered);
      if (!match) break;
      const event = buffered.slice(0, match.index);
      buffered = buffered.slice(match.index + match[0].length);
      for (const transformed of transformEvent(event, codec, toolSearchStream)) {
        output.push(Buffer.from(`${transformed}\n\n`, "utf8"));
      }
    }
    return output;
  };
  const finish = () => {
    try {
      buffered += decoder.decode();
    } catch (error) {
      throw new ResponseTransformError("Upstream SSE is not valid UTF-8", error);
    }
    const output = [];
    if (buffered.length > 0) {
      for (const transformed of transformEvent(buffered, codec, toolSearchStream)) {
        output.push(Buffer.from(`${transformed}\n\n`, "utf8"));
      }
      buffered = "";
    }
    if (toolSearchStream) {
      try {
        toolSearchStream.finish();
      } catch (error) {
        throw new ResponseTransformError(
          "Upstream Tool Search stream ended inconsistently",
          error,
        );
      }
    }
    return output;
  };
  return Object.freeze({ push, finish });
}

export function shouldTransformResponse(contentType, codec) {
  const { efficientFidelityCodec, namespaceCodec } = responseCodecs(codec);
  if (
    !efficientFidelityCodec &&
    !namespaceResponsePolicyActive(namespaceCodec)
  ) {
    return null;
  }
  if (typeof contentType !== "string") {
    throw new ResponseTransformError(
      "Upstream namespace response has an unsupported content type",
    );
  }
  const match = CONTENT_TYPE_PATTERN.exec(contentType);
  if (!match) {
    throw new ResponseTransformError(
      "Upstream namespace response has an unsupported content type",
    );
  }
  const type = match[1].toLowerCase();
  const subtype = match[2].toLowerCase();
  if (type === "text" && subtype === "event-stream") return "sse";
  if (
    type === "application" &&
    (subtype === "json" || STRUCTURED_JSON_SUBTYPE_PATTERN.test(subtype))
  ) {
    return "json";
  }
  throw new ResponseTransformError("Upstream namespace response has an unsupported content type");
}

export const RESPONSE_TRANSFORM_MAX_BYTES = DEFAULT_MAX_TRANSFORM_BYTES;
