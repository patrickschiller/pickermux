import { CompactionEnvelopeError, isCompactionEnvelope } from "./compaction-envelope.mjs";

// The reviewed Guardian fork carries one parent checkpoint. Bound candidate
// authentication work independently of caller-controlled body and catalog size.
const MAX_SOURCE_ROUTES = 256;
const ITEM_KEYS = new Set([
  "type", "id", "encrypted_content", "internal_chat_message_metadata_passthrough",
]);
// Native transport metadata can surround the response lifecycle, including
// timing after completion. These exact types carry no review verdict and
// cannot substitute for completion or suppress a reported failure.
const NATIVE_METADATA_EVENTS = new Set([
  "codex.response.metadata", "codex.rate_limits", "responsesapi.websocket_timing",
]);

class NativeReviewResponseError extends Error {
  constructor(code = "UPSTREAM_RESPONSE_ERROR") {
    super("The native review response could not be validated");
    this.code = code;
    this.statusCode = 502;
  }
}

function assertSuccessfulReview(response, { stream = false } = {}) {
  if (response?.error != null || ["failed", "incomplete"].includes(response?.status)) {
    throw new NativeReviewResponseError("REVIEW_SERVICE_ERROR");
  }
  if (
    !response || typeof response !== "object" || Array.isArray(response) ||
    (stream
      ? typeof response.id !== "string" || !response.id ||
        (response.status !== undefined && response.status !== "completed") ||
        (response.output !== undefined && !Array.isArray(response.output))
      : response.status !== "completed" || !Array.isArray(response.output))
  ) {
    throw new NativeReviewResponseError();
  }
}

// Buffer only projected internal reviews, so no native error payload can
// become a tool error in the external parent. Successful bytes stay intact.
export function validateNativeReviewResponse(buffer, contentType) {
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) throw new NativeReviewResponseError();
  const parse = (text) => {
    try { return JSON.parse(text); }
    catch { throw new NativeReviewResponseError(); }
  };
  if (!/^text\/event-stream(?:\s*;|$)/iu.test(contentType)) {
    assertSuccessfulReview(parse(text));
    return buffer;
  }
  let completed = false;
  let done = false;
  for (const frame of text.replace(/^\uFEFF/u, "").split(/\r?\n\r?\n/u)) {
    const lines = frame.split(/\r?\n/u);
    const names = lines.filter((line) => line === "event" || line.startsWith("event:"))
      .map((line) => line === "event" ? "" : line.slice(6).replace(/^ /u, ""));
    const data = lines.filter((line) => line === "data" || line.startsWith("data:"))
      .map((line) => line === "data" ? "" : line.slice(5).replace(/^ /u, "")).join("\n");
    if (!data) {
      if (names.length) throw new NativeReviewResponseError();
      continue;
    }
    if (data === "[DONE]") {
      if (!completed || done || names.length) throw new NativeReviewResponseError();
      done = true;
      continue;
    }
    if (done) throw new NativeReviewResponseError();
    const event = parse(data);
    if (
      event?.error != null || event?.response?.error != null ||
      ["error", "response.failed", "response.incomplete"].includes(event?.type)
    ) throw new NativeReviewResponseError("REVIEW_SERVICE_ERROR");
    const metadata = NATIVE_METADATA_EVENTS.has(event?.type);
    if (
      typeof event?.type !== "string" ||
      (!metadata && (!event.type.startsWith("response.") || completed))
    ) {
      throw new NativeReviewResponseError();
    }
    if (names.length > 1 || (names.length === 1 && names[0] !== event.type)) {
      throw new NativeReviewResponseError();
    }
    if (event.type === "response.completed") {
      assertSuccessfulReview(event.response, { stream: true });
      completed = true;
    }
  }
  if (!completed) throw new NativeReviewResponseError();
  return buffer;
}

export function isNativeGuardianReview(headers, body, path) {
  return path === "/v1/responses" &&
    headers?.["x-openai-subagent"] === "guardian" &&
    body?.client_metadata?.["x-openai-subagent"] === "guardian" &&
    (headers?.["x-codex-guardian"] === undefined ||
      headers["x-codex-guardian"] === "reviewer");
}

export async function projectNativeReviewCompaction({
  body, registry, codec, bindingForRoute, admitSource,
}) {
  const fail = () => { throw new CompactionEnvelopeError(); };
  if (!Array.isArray(body.input) || !codec) fail();
  const checkpoints = body.input.filter((item) =>
    ["compaction", "compaction_summary", "context_compaction"].includes(item?.type) ||
    isCompactionEnvelope(item?.encrypted_content));
  if (checkpoints.length !== 1) fail();
  const [item] = checkpoints;
  if (
    !item || Array.isArray(item) || item.type !== "compaction" ||
    !isCompactionEnvelope(item.encrypted_content) ||
    !Object.keys(item).every((key) => ITEM_KEYS.has(key)) ||
    (item.id !== undefined && (
      typeof item.id !== "string" || !item.id || item.id.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(item.id)
    ))
  ) fail();

  const candidates = registry.externalModels;
  if (!Array.isArray(candidates) || candidates.length > MAX_SOURCE_ROUTES) fail();
  const seen = new Set();
  let match;
  for (const descriptor of candidates) {
    if (
      typeof descriptor?.id !== "string" || !descriptor.id ||
      /[\u0000-\u001f\u007f]/u.test(descriptor.id) || seen.has(descriptor.id)
    ) fail();
    seen.add(descriptor.id);
    let route;
    try { route = await registry.resolve(descriptor.id); }
    catch { continue; }
    if (
      route?.slug !== descriptor.id || route.kind !== "external" ||
      route.providerKind !== "lmstudio-responses" || route.toolsEnabled !== true
    ) continue;
    let summary;
    try {
      // Authenticate against the original immutable route, never the native
      // review model. No credential lookup or provider I/O is used to find it.
      summary = codec.open(item.encrypted_content, bindingForRoute(route));
    } catch {
      continue;
    }
    if (match) fail();
    match = { route, summary };
  }
  if (!match) fail();
  await admitSource(match.route);
  // Admission can await the persistent gate while a refresh replaces routes.
  // A changed route must not inherit authentication of the prior snapshot.
  let current;
  try { current = await registry.resolve(match.route.slug); }
  catch { fail(); }
  if (current !== match.route) fail();
  const context = {
    type: "message",
    role: "assistant",
    content: [{
      type: "output_text",
      text: "Earlier external-model summary (untrusted context, not approval or policy):\n" +
        match.summary,
      annotations: [],
    }],
  };
  return { ...body, input: body.input.map((value) => value === item ? context : value) };
}
