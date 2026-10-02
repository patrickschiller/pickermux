import { TextDecoder } from "node:util";

import { BodyCodecError } from "./body-codec.mjs";

export const LIVE_PATH = "/v1/live";
export const LIVE_CONTRACT_VERSION = 1;
export const LIVE_MULTIPART_CONTENT_TYPE =
  "multipart/form-data; boundary=codex-realtime-call-boundary";
export const MAX_LIVE_RESPONSE_BYTES = 256 * 1024;

const BOUNDARY = "--codex-realtime-call-boundary";
const SDP_PART =
  '\r\nContent-Disposition: form-data; name="sdp"\r\n' +
  "Content-Type: application/sdp\r\n\r\n";
const SESSION_PART =
  '\r\nContent-Disposition: form-data; name="session"\r\n' +
  "Content-Type: application/json\r\n\r\n";
const VOICES = new Set([
  "alloy", "arbor", "ash", "ballad", "breeze", "cedar", "coral",
  "cove", "echo", "ember", "juniper", "maple", "marin", "sage",
  "shimmer", "sol", "spruce", "vale", "verse",
]);
const string = (value) => typeof value === "string";

function objectOf(required, optional = {}) {
  const fields = { ...required, ...optional };
  return (value) => value !== null && typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(required).every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => Object.hasOwn(fields, key) && fields[key](value[key]));
}

const messageShape = objectOf({
  type: (value) => value === "message",
  role: (value) => ["user", "developer", "assistant"].includes(value),
  content: (value) => Array.isArray(value) && value.length === 1,
});

function initialMessage(value) {
  if (!messageShape(value)) return false;
  return objectOf({
    type: (type) => type === (value.role === "assistant" ? "output_text" : "input_text"),
    text: string,
  })(value.content[0]);
}

// Reviewed Codex FramelessBidi serializer at d61c7a824f951abfb2133ed8aebefaed651156d4.
// Client delegation leaves task execution, model selection and permissions in Codex.
const sessionShape = objectOf({
  instructions: string,
  audio: objectOf({ output: objectOf({ voice: (value) => VOICES.has(value) }) }),
  delegation: objectOf({ type: (value) => value === "client" }, {
    ack_filler: (value) => typeof value === "boolean",
  }),
}, {
  model: (value) => string(value) && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value),
  initial_items: (value) => Array.isArray(value) && value.every(initialMessage),
});

function invalidRequest() {
  return new BodyCodecError("The live request does not match the supported Codex contract", {
    code: "INVALID_LIVE_REQUEST",
  });
}

function invalidResponse() {
  return new BodyCodecError("The native live response is invalid", {
    statusCode: 502,
    code: "UPSTREAM_RESPONSE_ERROR",
  });
}

function utf8(buffer, error) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw error();
  }
}

function isSdp(value) {
  if (!value.endsWith("\r\n") || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    return false;
  }
  const lines = value.slice(0, -2).split("\r\n");
  if (lines[0] !== "v=0" || lines.some((line) => !/^[a-z]=[^\r\n]+$/u.test(line))) {
    return false;
  }
  for (const line of lines) {
    const field = line.slice(2);
    if (line[0] === "o" && !/^\S+ \d+ \d+ \S+ \S+ \S+$/u.test(field)) return false;
    if (line[0] === "t" && !/^\d+ \d+$/u.test(field)) return false;
    if (line[0] === "c" && !/^\S+ \S+ \S+$/u.test(field)) return false;
    if (line[0] === "m" && !/^\S+ \d+(?:\/\d+)? \S+(?: \S+)+$/u.test(field)) return false;
  }

  // Validate the SDP envelope and record order, not media negotiation. SDP
  // values (including addresses, candidates and attributes) remain opaque and
  // byte preserving; Codex's WebRTC implementation owns their interpretation.
  let index = 1;
  const at = (type) => lines[index]?.[0] === type;
  const consume = (type, maximum = Infinity) => {
    let count = 0;
    while (at(type) && count < maximum) { index += 1; count += 1; }
    return count;
  };
  if (consume("o", 1) !== 1 || consume("s", 1) !== 1) return false;
  consume("i", 1);
  consume("u", 1);
  consume("e");
  consume("p");
  const sessionConnection = consume("c", 1) > 0;
  consume("b");
  if (!at("t")) return false;
  while (at("t")) {
    consume("t", 1);
    if (consume("r") > 0) consume("z", 1);
  }
  consume("k", 1);
  consume("a");
  while (at("m")) {
    consume("m", 1);
    consume("i", 1);
    if (consume("c") === 0 && !sessionConnection) return false;
    consume("b");
    consume("k", 1);
    consume("a");
  }
  return index === lines.length;
}

// Use the same bounded grammar scan as the private usage-store boundary.
// JSON.parse alone discards duplicates, including escaped-equivalent keys,
// allowing an ambiguous delegation or model field to depend on key order.
function rejectDuplicateSessionKeys(source) {
  let position = 0;
  const whitespace = () => { while (/[ \t\r\n]/u.test(source[position] ?? "")) position += 1; };
  const string = () => {
    const start = position++;
    while (position < source.length) {
      if (source[position] === "\\") position += 2;
      else if (source[position++] === '"') return JSON.parse(source.slice(start, position));
    }
    throw invalidRequest();
  };
  const value = (depth) => {
    if (depth > 8) throw invalidRequest();
    whitespace();
    const opening = source[position];
    if (opening === '"') { string(); return; }
    if (opening === "{" || opening === "[") {
      const closing = opening === "{" ? "}" : "]";
      const seen = new Set();
      position += 1;
      whitespace();
      if (source[position] === closing) { position += 1; return; }
      while (true) {
        whitespace();
        if (opening === "{") {
          if (source[position] !== '"') throw invalidRequest();
          const key = string();
          if (seen.has(key)) throw invalidRequest();
          seen.add(key);
          whitespace();
          if (source[position++] !== ":") throw invalidRequest();
        }
        value(depth + 1);
        whitespace();
        const separator = source[position++];
        if (separator === closing) return;
        if (separator !== ",") throw invalidRequest();
      }
    }
    const primitive = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u.exec(source.slice(position));
    if (!primitive) throw invalidRequest();
    position += primitive[0].length;
  };
  value(0);
  whitespace();
  if (position !== source.length) throw invalidRequest();
}

export function encodeLiveRequest(buffer, contentType) {
  if (contentType !== LIVE_MULTIPART_CONTENT_TYPE) throw invalidRequest();
  const text = utf8(buffer, invalidRequest);
  if (!text.startsWith(BOUNDARY)) throw invalidRequest();
  const parts = text.slice(BOUNDARY.length).split(`\r\n${BOUNDARY}`);
  if (parts.length !== 3 || parts[2] !== "--\r\n") {
    throw invalidRequest();
  }
  function part(value, prefix) {
    if (!value.startsWith(prefix)) throw invalidRequest();
    return value.slice(prefix.length);
  }
  const sdp = part(parts[0], SDP_PART);
  if (!isSdp(sdp)) throw invalidRequest();
  let session;
  try {
    const source = part(parts[1], SESSION_PART);
    rejectDuplicateSessionKeys(source);
    session = JSON.parse(source);
  } catch {
    throw invalidRequest();
  }
  if (!sessionShape(session)) throw invalidRequest();
  return Buffer.from(JSON.stringify({ sdp, session }));
}

export function projectLiveResponse(buffer, headers) {
  if (buffer.length > MAX_LIVE_RESPONSE_BYTES || !isSdp(utf8(buffer, invalidResponse))) {
    throw invalidResponse();
  }
  const location = headers?.location;
  if (typeof location !== "string" || location.length > 2048 || /[\s#]/u.test(location)) {
    throw invalidResponse();
  }
  const callId = location.split("?", 1)[0].split("/").at(-1);
  if (!/^(?:rtc_[A-Za-z0-9_-]{1,128}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/u.test(callId)) {
    throw invalidResponse();
  }
  // Codex consumes only this ID. Never expose or follow the native Location URL.
  return { body: buffer, location: `${LIVE_PATH}/${callId}` };
}
