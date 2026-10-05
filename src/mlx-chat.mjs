import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";

import { ResponseTransformError } from "./responses-transform.mjs";

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const REQUEST_KEYS = new Set([
  "model", "input", "instructions", "stream", "max_output_tokens", "reasoning",
  "tools", "tool_choice", "parallel_tool_calls", "store", "include", "metadata",
  "client_metadata", "text", "prompt_cache_key", "previous_response_id",
  "truncation", "service_tier", "background",
]);
const MESSAGE_KEYS = new Set([
  "type", "role", "content", "id", "status",
  "internal_chat_message_metadata_passthrough", "phase",
]);
const PART_KEYS = new Set(["type", "text", "annotations"]);
const RESPONSE_KEYS = new Set([
  "id", "object", "created", "model", "choices", "usage", "system_fingerprint",
]);

export class MlxChatRequestError extends Error {
  constructor() {
    super("The MLX route supports plain text requests without tools or stored continuation state");
    this.name = "MlxChatRequestError";
    this.statusCode = 400;
    this.code = "MLX_REQUEST_UNSUPPORTED";
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value, allowed) {
  return isObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function requestAssert(condition) {
  if (!condition) throw new MlxChatRequestError();
}

function responseAssert(condition) {
  if (!condition) {
    throw new ResponseTransformError("The MLX response does not match the supported text contract");
  }
}

function byteLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) {
    throw new TypeError("maxBytes must be an integer of at least 1024");
  }
  return maxBytes;
}

function safeString(value, maxLength = 1024) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
}

function textContent(content, role) {
  if (typeof content === "string") return content;
  requestAssert(Array.isArray(content) && content.length > 0);
  return content.map((part) => {
    requestAssert(onlyKeys(part, PART_KEYS) && typeof part.text === "string" &&
      (part.type === "input_text" || (role === "assistant" && part.type === "output_text")) &&
      (part.annotations === undefined || Array.isArray(part.annotations)));
    return part.text;
  }).join("");
}

/** Project the reviewed Responses text contract into the pinned MLX-LM API. */
export function createMlxChatRequest(body, route, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  byteLimit(maxBytes);
  requestAssert(onlyKeys(body, REQUEST_KEYS) && safeString(route?.upstreamModel));
  requestAssert(body.instructions === undefined || body.instructions === null ||
    typeof body.instructions === "string");
  requestAssert(body.stream === undefined || typeof body.stream === "boolean");
  requestAssert(body.previous_response_id === undefined || body.previous_response_id === null);
  requestAssert(body.truncation === undefined || body.truncation === "disabled");
  requestAssert(body.background === undefined || body.background === false);
  requestAssert(body.tools === undefined || (Array.isArray(body.tools) && body.tools.length === 0));
  requestAssert(body.tool_choice === undefined || body.tool_choice === "none" ||
    body.tool_choice === "auto");
  requestAssert(body.parallel_tool_calls === undefined || typeof body.parallel_tool_calls === "boolean");
  requestAssert(body.store === undefined || typeof body.store === "boolean");
  requestAssert(body.include === undefined || (Array.isArray(body.include) &&
    body.include.every((entry) => typeof entry === "string")));
  if (body.reasoning !== undefined && body.reasoning !== null) {
    requestAssert(onlyKeys(body.reasoning, new Set(["effort", "summary"])) &&
      (body.reasoning.effort === undefined || body.reasoning.effort === "none") &&
      (body.reasoning.summary === undefined || body.reasoning.summary === null ||
        body.reasoning.summary === "none"));
  }
  if (body.text !== undefined) {
    requestAssert(onlyKeys(body.text, new Set(["format", "verbosity"])) &&
      (body.text.format === undefined ||
        (onlyKeys(body.text.format, new Set(["type"])) && body.text.format.type === "text")) &&
      (body.text.verbosity === undefined || ["low", "medium", "high"].includes(body.text.verbosity)));
  }
  requestAssert(body.max_output_tokens === undefined ||
    (Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0));

  const system = [];
  if (typeof body.instructions === "string") system.push(body.instructions);
  const messages = [];
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else {
    requestAssert(Array.isArray(body.input) && body.input.length > 0);
    for (const item of body.input) {
      requestAssert(onlyKeys(item, MESSAGE_KEYS) &&
        (item.type === undefined || item.type === "message") &&
        ["system", "developer", "user", "assistant"].includes(item.role) &&
        (item.id === undefined || safeString(item.id, 256)) &&
        (item.status === undefined || item.status === "completed") &&
        (item.phase === undefined || ["commentary", "final_answer"].includes(item.phase)));
      const content = textContent(item.content, item.role);
      if (item.role === "system" || item.role === "developer") system.push(content);
      else messages.push({ role: item.role, content });
    }
  }
  // Kolibri's chat template accepts one system message. Keep every instruction
  // fragment in its original relative order without granting new authority.
  if (system.length > 0) messages.unshift({ role: "system", content: system.join("\n\n") });
  requestAssert(messages.some((message) => message.role === "user"));
  const projected = {
    model: route.upstreamModel,
    messages,
    stream: body.stream === true,
    chat_template_kwargs: { reasoning_effort: "none" },
  };
  if (body.max_output_tokens !== undefined) projected.max_tokens = body.max_output_tokens;
  if (projected.stream) projected.stream_options = { include_usage: true };
  const encoded = Buffer.from(JSON.stringify(projected), "utf8");
  requestAssert(encoded.length <= maxBytes);
  return encoded;
}

function parseJson(buffer) {
  responseAssert(Buffer.isBuffer(buffer));
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch {
    throw new ResponseTransformError("The MLX response is not valid UTF-8 JSON");
  }
}

function usageProjection(usage) {
  responseAssert(onlyKeys(usage, new Set([
    "prompt_tokens", "completion_tokens", "total_tokens", "prompt_tokens_details",
  ])));
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  responseAssert([input, output, usage.total_tokens].every((value) =>
    Number.isSafeInteger(value) && value >= 0) && Number.isSafeInteger(input + output) &&
    usage.total_tokens === input + output);
  let cached = 0;
  if (usage.prompt_tokens_details !== undefined) {
    responseAssert(onlyKeys(usage.prompt_tokens_details, new Set(["cached_tokens"])));
    cached = usage.prompt_tokens_details.cached_tokens;
    responseAssert(Number.isSafeInteger(cached) && cached >= 0 && cached <= input);
  }
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output,
  };
}

function validateEnvelope(value, expectedObject) {
  responseAssert(onlyKeys(value, RESPONSE_KEYS) && safeString(value.id, 256) &&
    safeString(value.model) && value.object === expectedObject &&
    Number.isSafeInteger(value.created) && value.created >= 0 && Array.isArray(value.choices) &&
    (value.system_fingerprint === undefined || typeof value.system_fingerprint === "string"));
}

function validateChoice(choice, messageKey, {
  terminalRequired = false,
  allowOmittedRole = false,
} = {}) {
  responseAssert(onlyKeys(choice, new Set(["index", "finish_reason", messageKey])) &&
    choice.index === 0 && [null, "stop", "length"].includes(choice.finish_reason) &&
    (!terminalRequired || choice.finish_reason !== null));
  const message = choice[messageKey];
  responseAssert(onlyKeys(message, new Set(["role", "content", "reasoning"])) &&
    (message.role === "assistant" || (allowOmittedRole && message.role === undefined)) &&
    (message.content === undefined || message.content === null || typeof message.content === "string") &&
    (message.reasoning === undefined || message.reasoning === null || message.reasoning === ""));
  if (messageKey === "message") responseAssert(Object.hasOwn(message, "content"));
  return { text: message.content ?? "", finishReason: choice.finish_reason };
}

function responseState(model) {
  if (!safeString(model)) throw new TypeError("model must be a public model slug");
  return {
    id: `resp_${randomUUID().replaceAll("-", "")}`,
    itemId: `msg_${randomUUID().replaceAll("-", "")}`,
    model,
    created: Math.floor(Date.now() / 1000),
  };
}

function outputMessage(state, text, status = "completed") {
  return {
    id: state.itemId,
    type: "message",
    status,
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
  };
}

function responseEnvelope(state, text, finishReason, usage, { initial = false } = {}) {
  return {
    id: state.id,
    object: "response",
    created_at: state.created,
    status: initial ? "in_progress" : finishReason === "stop" ? "completed" : "incomplete",
    error: null,
    incomplete_details: finishReason === "length" ? { reason: "max_output_tokens" } : null,
    model: state.model,
    output: initial ? [] : [outputMessage(state, text, finishReason === "stop" ? "completed" : "incomplete")],
    parallel_tool_calls: false,
    tool_choice: "none",
    tools: [],
    reasoning: { effort: "none", summary: null },
    text: { format: { type: "text" } },
    store: false,
    usage: usage ?? null,
  };
}

export function transformMlxChatJson(buffer, { model, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  byteLimit(maxBytes);
  responseAssert(Buffer.isBuffer(buffer) && buffer.length <= maxBytes);
  const value = parseJson(buffer);
  validateEnvelope(value, "chat.completion");
  responseAssert(value.choices.length === 1);
  const { text, finishReason } = validateChoice(value.choices[0], "message", { terminalRequired: true });
  return Buffer.from(JSON.stringify(responseEnvelope(
    responseState(model), text, finishReason, usageProjection(value.usage),
  )), "utf8");
}

/** Translate incremental MLX chunks; success requires finish, usage, and DONE. */
export function createMlxChatSseTransformer({
  model,
  maxBytes = DEFAULT_MAX_BYTES,
  onTerminalEvent,
} = {}) {
  byteLimit(maxBytes);
  const state = responseState(model);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  let receivedBytes = 0;
  let text = "";
  let finishReason;
  let usage;
  let identity;
  let started = false;
  let done = false;
  let terminalPublished = false;
  let ended = false;
  let failed = false;
  let sequence = 0;
  const event = (type, fields) => Buffer.from(
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`,
    "utf8",
  );
  const begin = () => {
    if (started) return [];
    started = true;
    const initial = responseEnvelope(state, "", undefined, undefined, { initial: true });
    return [
      event("response.created", { response: initial }),
      event("response.in_progress", { response: initial }),
      event("response.output_item.added", {
        output_index: 0,
        item: { id: state.itemId, type: "message", status: "in_progress", role: "assistant", content: [] },
      }),
      event("response.content_part.added", {
        item_id: state.itemId, output_index: 0, content_index: 0,
        part: { type: "output_text", text: "", annotations: [], logprobs: [] },
      }),
    ];
  };
  const complete = () => {
    const response = responseEnvelope(state, text, finishReason, usage);
    return [
      ...begin(),
      event("response.output_text.done", {
        item_id: state.itemId, output_index: 0, content_index: 0, text, logprobs: [],
      }),
      event("response.content_part.done", {
        item_id: state.itemId, output_index: 0, content_index: 0,
        part: { type: "output_text", text, annotations: [], logprobs: [] },
      }),
      event("response.output_item.done", { output_index: 0, item: response.output[0] }),
      event(finishReason === "stop" ? "response.completed" : "response.incomplete", { response }),
    ];
  };
  const frame = (source) => {
    responseAssert(!done);
    const data = [];
    for (const line of source.split(/\r?\n/u)) {
      if (line === "" || line.startsWith(":")) continue;
      responseAssert(line === "data" || line.startsWith("data:"));
      data.push(line === "data" ? "" : line.slice(5).replace(/^ /u, ""));
    }
    if (data.length === 0) return [];
    const payload = data.join("\n");
    if (payload === "[DONE]") {
      responseAssert(finishReason !== undefined && usage !== undefined);
      done = true;
      // EOF commits the completed response. A later malformed frame must not
      // turn an invalid stream into a response that Codex already accepted.
      return [];
    }
    const value = parseJson(Buffer.from(payload, "utf8"));
    const usageFrame = value?.choices?.length === 0;
    validateEnvelope(value, usageFrame ? "chat.completion" : "chat.completion.chunk");
    const currentIdentity = JSON.stringify([value.id, value.model, value.created, value.system_fingerprint]);
    if (identity === undefined) identity = currentIdentity;
    responseAssert(identity === currentIdentity);
    if (usageFrame) {
      responseAssert(finishReason !== undefined && usage === undefined);
      usage = usageProjection(value.usage);
      return [];
    }
    responseAssert(value.choices.length === 1 && finishReason === undefined && value.usage === undefined);
    const choice = validateChoice(value.choices[0], "delta", { allowOmittedRole: started });
    const output = begin();
    if (choice.text.length > 0) {
      text += choice.text;
      responseAssert(Buffer.byteLength(text, "utf8") <= maxBytes);
      output.push(event("response.output_text.delta", {
        item_id: state.itemId, output_index: 0, content_index: 0, delta: choice.text, logprobs: [],
      }));
    }
    if (choice.finishReason !== null) finishReason = choice.finishReason;
    return output;
  };
  const drain = ({ final = false } = {}) => {
    const output = [];
    while (true) {
      const separator = /\r?\n\r?\n/u.exec(buffered);
      if (!separator) break;
      const source = buffered.slice(0, separator.index);
      buffered = buffered.slice(separator.index + separator[0].length);
      output.push(...frame(source));
    }
    if (final && buffered.length > 0) {
      output.push(...frame(buffered));
      buffered = "";
    }
    return output;
  };
  const guarded = (operation) => {
    responseAssert(!failed && !ended);
    try {
      const output = operation();
      // Publish the terminal only when the complete input chunk was validated.
      if (done && ended && !terminalPublished) {
        terminalPublished = true;
        onTerminalEvent?.(responseEnvelope(state, text, finishReason, usage));
      }
      return output;
    } catch (error) {
      failed = true;
      if (error instanceof ResponseTransformError) throw error;
      throw new ResponseTransformError("The MLX stream could not be validated");
    }
  };
  const push = (chunk) => guarded(() => {
    responseAssert(Buffer.isBuffer(chunk));
    receivedBytes += chunk.length;
    responseAssert(receivedBytes <= maxBytes);
    buffered += decoder.decode(chunk, { stream: true });
    return drain();
  });
  const finish = () => guarded(() => {
    buffered += decoder.decode();
    const output = drain({ final: true });
    responseAssert(done);
    ended = true;
    return [...output, ...complete()];
  });
  return Object.freeze({ push, finish, hasTerminalEvent: () => terminalPublished });
}
