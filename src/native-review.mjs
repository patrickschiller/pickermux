import { CompactionEnvelopeError, isCompactionEnvelope } from "./compaction-envelope.mjs";

// The reviewed Guardian fork carries one parent checkpoint. Bound candidate
// authentication work independently of caller-controlled body and catalog size.
const MAX_SOURCE_ROUTES = 256;
const ITEM_KEYS = new Set([
  "type", "id", "encrypted_content", "internal_chat_message_metadata_passthrough",
]);

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
