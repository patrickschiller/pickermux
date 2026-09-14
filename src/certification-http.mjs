import http from "node:http";

import {
  CERTIFICATION_HEADER,
  requireCertificationToken,
} from "./certification-transport.mjs";

export const MAX_CERTIFICATION_RESPONSE_HEADER_BYTES = 64 * 1024;

const TARGET_PATTERN = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/c\/[A-Za-z0-9_-]{32,256}\/v1\/responses$/u;
const OPTION_KEYS = new Set(["method", "redirect", "headers", "body", "signal"]);
const HEADER_KEYS = new Set(["accept", "content-type", CERTIFICATION_HEADER]);
const UNIQUE_RESPONSE_HEADERS = new Set(["content-type", "content-length", "content-encoding"]);
const TRANSPORT_CODES = new Set([
  "CERTIFICATION_INVALID_TARGET",
  "CERTIFICATION_INVALID_REQUEST",
  "CERTIFICATION_REDIRECT",
  "CERTIFICATION_RESPONSE_HEADERS",
  "CERTIFICATION_RESPONSE_ENCODING",
  "CERTIFICATION_TIMEOUT",
  "CERTIFICATION_ABORTED",
  "CERTIFICATION_CONNECTION_FAILED",
  "CERTIFICATION_BODY_FAILED",
  "CERTIFICATION_TRANSPORT_FAILED",
]);

function transportError(code) {
  const error = new Error(`Certification transport failed (${code})`);
  error.code = code;
  return error;
}

/** Project only fixed error classifications; transport causes may contain URLs. */
export function certificationTransportErrorCode(error) {
  for (const candidate of [error, error?.cause]) {
    if (TRANSPORT_CODES.has(candidate?.code)) return candidate.code;
    if (
      candidate?.name === "TimeoutError" ||
      ["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT"].includes(candidate?.code)
    ) return "CERTIFICATION_TIMEOUT";
    if (candidate?.name === "AbortError" || candidate?.code === "ABORT_ERR") {
      return "CERTIFICATION_ABORTED";
    }
    if (candidate?.code === "HPE_HEADER_OVERFLOW") return "CERTIFICATION_RESPONSE_HEADERS";
    if (["ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOTFOUND", "UND_ERR_SOCKET"].includes(candidate?.code)) {
      return "CERTIFICATION_CONNECTION_FAILED";
    }
  }
  return "CERTIFICATION_TRANSPORT_FAILED";
}

function hasOnlyKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every((key) => keys.has(key));
}

function validateRequest(url, options) {
  const match = typeof url === "string" ? TARGET_PATTERN.exec(url) : null;
  if (!match || Number(match[1]) > 65_535) {
    throw transportError("CERTIFICATION_INVALID_TARGET");
  }
  if (
    !hasOnlyKeys(options, OPTION_KEYS) ||
    options.method !== "POST" ||
    options.redirect !== "error" ||
    typeof options.body !== "string" ||
    !(options.signal instanceof AbortSignal) ||
    !hasOnlyKeys(options.headers, HEADER_KEYS) ||
    !["application/json", "text/event-stream"].includes(options.headers.accept) ||
    options.headers["content-type"] !== "application/json"
  ) {
    throw transportError("CERTIFICATION_INVALID_REQUEST");
  }
  try {
    requireCertificationToken(options.headers[CERTIFICATION_HEADER]);
  } catch {
    throw transportError("CERTIFICATION_INVALID_REQUEST");
  }
  return new URL(url);
}

/**
 * The private certification marker is sent only to the exact local bridge.
 * A caller-owned signal bounds headers and the entire body together. Using
 * node:http avoids fetch's separate, shorter implicit header/body deadlines.
 */
export async function certificationFetch(url, options) {
  const target = validateRequest(url, options);
  const { signal } = options;
  const abortError = () => transportError(
    signal.reason?.name === "TimeoutError"
      ? "CERTIFICATION_TIMEOUT"
      : "CERTIFICATION_ABORTED",
  );
  if (signal.aborted) throw abortError();

  return new Promise((resolve, reject) => {
    let outgoing;
    let incoming;
    let controller;
    let responseStarted = false;
    let finished = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const fail = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      controller?.error(error);
      outgoing?.destroy();
      incoming?.destroy();
      if (!responseStarted) reject(error);
    };
    const onAbort = () => fail(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      outgoing = http.request(target, {
        method: "POST",
        agent: false,
        maxHeaderSize: MAX_CERTIFICATION_RESPONSE_HEADER_BYTES,
        headers: {
          accept: options.headers.accept,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(options.body)),
          "accept-encoding": "identity",
          [CERTIFICATION_HEADER]: options.headers[CERTIFICATION_HEADER],
        },
      }, (response) => {
        incoming = response;
        // These listeners must exist before any header-based rejection destroys
        // the response; a later socket reset must never become unhandled.
        incoming.once("aborted", () => fail(transportError("CERTIFICATION_BODY_FAILED")));
        incoming.once("error", () => fail(transportError("CERTIFICATION_BODY_FAILED")));
        incoming.once("close", () => {
          if (!incoming.complete) fail(transportError("CERTIFICATION_BODY_FAILED"));
        });
        if (finished) {
          incoming.destroy();
          return;
        }
        const status = incoming.statusCode;
        if (status >= 300 && status < 400) {
          fail(transportError("CERTIFICATION_REDIRECT"));
          return;
        }
        if (!Number.isInteger(status) || status < 200 || status > 599) {
          fail(transportError("CERTIFICATION_RESPONSE_HEADERS"));
          return;
        }
        const seenHeaders = new Set();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index].toLowerCase();
          if (!UNIQUE_RESPONSE_HEADERS.has(name)) continue;
          if (seenHeaders.has(name)) {
            fail(transportError("CERTIFICATION_RESPONSE_HEADERS"));
            return;
          }
          seenHeaders.add(name);
        }
        if (
          incoming.headers["content-encoding"] !== undefined &&
          String(incoming.headers["content-encoding"]).trim().toLowerCase() !== "identity"
        ) {
          fail(transportError("CERTIFICATION_RESPONSE_ENCODING"));
          return;
        }
        const headers = new Headers();
        try {
          for (const name of ["content-type", "content-length"]) {
            if (incoming.headers[name] !== undefined) headers.set(name, incoming.headers[name]);
          }
        } catch {
          fail(transportError("CERTIFICATION_RESPONSE_HEADERS"));
          return;
        }
        const body = new ReadableStream({
          start(streamController) {
            controller = streamController;
            incoming.on("data", (chunk) => {
              if (finished) return;
              controller.enqueue(chunk);
              if (controller.desiredSize <= 0) incoming.pause();
            });
            incoming.once("end", () => {
              if (finished) return;
              finished = true;
              cleanup();
              controller.close();
            });
          },
          pull() {
            incoming.resume();
          },
          cancel() {
            if (finished) return;
            finished = true;
            cleanup();
            incoming.destroy();
            outgoing.destroy();
          },
        }, { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength });
        responseStarted = true;
        resolve({ ok: status >= 200 && status < 300, status, headers, body });
      });
      outgoing.once("error", (error) => fail(transportError(
        responseStarted
          ? "CERTIFICATION_BODY_FAILED"
          : /^HPE_/u.test(error?.code ?? "")
            ? "CERTIFICATION_RESPONSE_HEADERS"
            : "CERTIFICATION_CONNECTION_FAILED",
      )));
      outgoing.once("upgrade", (_response, socket) => {
        socket.destroy();
        fail(transportError("CERTIFICATION_RESPONSE_HEADERS"));
      });
      outgoing.end(options.body);
    } catch {
      fail(transportError("CERTIFICATION_CONNECTION_FAILED"));
    }
  });
}
