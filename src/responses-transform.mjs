import { StringDecoder } from "node:string_decoder";

import { rewriteResponseFunctionCalls } from "./tool-normalization.mjs";

const DEFAULT_MAX_TRANSFORM_BYTES = 32 * 1024 * 1024;

export class ResponseTransformError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "ResponseTransformError";
    this.statusCode = 502;
    this.code = "UPSTREAM_RESPONSE_ERROR";
  }
}

function transformJsonText(text, codec) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ResponseTransformError("Upstream response is not valid JSON", error);
  }
  try {
    rewriteResponseFunctionCalls(parsed, codec);
  } catch (error) {
    throw new ResponseTransformError("Upstream function call could not be normalized", error);
  }
  return JSON.stringify(parsed);
}

export function transformJsonResponse(buffer, codec) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("JSON response must be a Buffer");
  }
  return Buffer.from(transformJsonText(buffer.toString("utf8"), codec), "utf8");
}

function splitEventLines(source) {
  return source.split(/\r?\n/u);
}

function transformEvent(event, codec) {
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
  if (data.length === 0) return event;
  const joined = data.join("\n");
  if (joined === "[DONE]") return event;
  const transformed = `data: ${transformJsonText(joined, codec)}`;
  retained.splice(insertAt, 0, transformed);
  return retained.join("\n");
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
  const decoder = new StringDecoder("utf8");
  const push = (chunk) => {
    buffered += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
    if (Buffer.byteLength(buffered) > maxBufferedBytes) {
      throw new ResponseTransformError("Upstream SSE event is too large");
    }
    const output = [];
    while (true) {
      const match = /\r?\n\r?\n/u.exec(buffered);
      if (!match) break;
      const event = buffered.slice(0, match.index);
      buffered = buffered.slice(match.index + match[0].length);
      output.push(Buffer.from(`${transformEvent(event, codec)}\n\n`, "utf8"));
    }
    return output;
  };
  const finish = () => {
    buffered += decoder.end();
    if (buffered.length === 0) return [];
    const final = Buffer.from(transformEvent(buffered, codec), "utf8");
    buffered = "";
    return [final];
  };
  return Object.freeze({ push, finish });
}

export function shouldTransformResponse(contentType, codec) {
  if (!codec?.reverse || codec.reverse.size === 0) return null;
  const normalized = String(contentType ?? "").toLowerCase();
  if (normalized.includes("text/event-stream")) return "sse";
  if (normalized.includes("application/json") || normalized.includes("+json")) {
    return "json";
  }
  throw new ResponseTransformError("Upstream namespace response has an unsupported content type");
}

export const RESPONSE_TRANSFORM_MAX_BYTES = DEFAULT_MAX_TRANSFORM_BYTES;
