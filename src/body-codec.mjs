import * as zlib from "node:zlib";
import { promisify } from "node:util";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export function runtimeSupportsZstd() {
  return typeof zlib.zstdDecompress === "function";
}

export function assertRuntimeCompressionSupport() {
  if (!runtimeSupportsZstd()) {
    throw new Error(
      "This bridge requires a Node.js runtime with zlib.zstdDecompress (Node.js 22.15 or newer)",
    );
  }
}

export class BodyCodecError extends Error {
  constructor(message, { statusCode = 400, code = "INVALID_BODY", cause } = {}) {
    super(message, { cause });
    this.name = "BodyCodecError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function assertLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("Body byte limit must be a positive safe integer");
  }
}

export async function readLimitedBody(stream, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  assertLimit(maxBytes);
  const chunks = [];
  let size = 0;

  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        throw new BodyCodecError("Request body is too large", {
          statusCode: 413,
          code: "BODY_TOO_LARGE",
        });
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof BodyCodecError) throw error;
    if (stream.aborted || error?.code === "ECONNRESET") {
      throw new BodyCodecError("Client closed the request", {
        statusCode: 499,
        code: "CLIENT_ABORTED",
      });
    }
    throw new BodyCodecError("Could not read request body", { cause: error });
  }

  return Buffer.concat(chunks, size);
}

export function parseContentEncodings(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value ?? "");
  if (!raw.trim()) return [];
  const encodings = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry && entry !== "identity");

  const supported = new Set(["gzip", "x-gzip", "deflate", "br", "zstd"]);
  for (const encoding of encodings) {
    if (!supported.has(encoding)) {
      throw new BodyCodecError("Unsupported content encoding", {
        statusCode: 415,
        code: "UNSUPPORTED_CONTENT_ENCODING",
      });
    }
  }
  return encodings;
}

async function decompressOne(buffer, encoding, maxBytes) {
  const options = { maxOutputLength: maxBytes };
  let operation;
  if (encoding === "gzip" || encoding === "x-gzip") operation = zlib.gunzip;
  if (encoding === "deflate") operation = zlib.inflate;
  if (encoding === "br") operation = zlib.brotliDecompress;
  if (encoding === "zstd") operation = zlib.zstdDecompress;

  if (typeof operation !== "function") {
    throw new BodyCodecError("Content encoding is unavailable in this Node.js runtime", {
      statusCode: 415,
      code: "CONTENT_ENCODING_UNAVAILABLE",
    });
  }

  try {
    return await promisify(operation)(buffer, options);
  } catch (error) {
    if (
      error?.code === "ERR_BUFFER_TOO_LARGE" ||
      error?.code === "ERR_OUT_OF_RANGE" ||
      /larger than|output length|maxOutputLength/iu.test(String(error?.message ?? ""))
    ) {
      throw new BodyCodecError("Decoded request body is too large", {
        statusCode: 413,
        code: "DECODED_BODY_TOO_LARGE",
      });
    }
    throw new BodyCodecError("Request body compression is invalid", {
      code: "INVALID_COMPRESSION",
      cause: error,
    });
  }
}

export async function decodeBody(
  rawBody,
  contentEncoding,
  { maxBytes = DEFAULT_MAX_BYTES } = {},
) {
  assertLimit(maxBytes);
  let decoded = Buffer.from(rawBody);
  const encodings = parseContentEncodings(contentEncoding);

  // HTTP content codings are applied in listed order and removed in reverse.
  for (const encoding of encodings.toReversed()) {
    decoded = await decompressOne(decoded, encoding, maxBytes);
    if (decoded.length > maxBytes) {
      throw new BodyCodecError("Decoded request body is too large", {
        statusCode: 413,
        code: "DECODED_BODY_TOO_LARGE",
      });
    }
  }
  return decoded;
}

export function parseJsonObject(buffer) {
  let value;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new BodyCodecError("Request body must be valid JSON", {
      code: "INVALID_JSON",
      cause: error,
    });
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new BodyCodecError("Request body must be a JSON object", {
      code: "INVALID_JSON_OBJECT",
    });
  }
  return value;
}

export async function decodeJsonBody(rawBody, contentEncoding, options) {
  return parseJsonObject(await decodeBody(rawBody, contentEncoding, options));
}
