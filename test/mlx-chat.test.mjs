import assert from "node:assert/strict";
import test from "node:test";

import {
  MlxChatRequestError,
  createMlxChatRequest,
  createMlxChatSseTransformer,
  transformMlxChatJson,
} from "../src/mlx-chat.mjs";
import { ResponseTransformError } from "../src/responses-transform.mjs";

const route = { upstreamModel: "kolibri-1-mlx-4bit" };
const publicModel = "kolibri/kolibri-1-mlx-4bit";

function chatResponse({ text = "Guten Tag!", finish = "stop", ...overrides } = {}) {
  return {
    id: "chatcmpl-private-upstream-id",
    object: "chat.completion",
    created: 1700000000,
    model: "private-upstream-model",
    system_fingerprint: "private-fingerprint",
    choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: text } }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 3 },
    },
    ...overrides,
  };
}

function chatChunk(text, finish = null) {
  const value = chatResponse();
  value.object = "chat.completion.chunk";
  value.choices = [{ index: 0, finish_reason: finish, delta: { role: "assistant" } }];
  if (text !== undefined) value.choices[0].delta.content = text;
  delete value.usage;
  return value;
}

function usageChunk() {
  return chatResponse({ choices: [] });
}

function frame(value) {
  return Buffer.from(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`, "utf8");
}

function events(buffers) {
  return Buffer.concat(buffers).toString("utf8").split("\n\n").filter(Boolean).map((block) => {
    const lines = block.split("\n");
    const value = JSON.parse(lines[1].slice(6));
    assert.equal(lines[0], `event: ${value.type}`);
    return value;
  });
}

function transform(value) {
  return JSON.parse(transformMlxChatJson(Buffer.from(JSON.stringify(value)), { model: publicModel }));
}

test("MLX request preserves text chronology and projects only reviewed provider fields", () => {
  const body = {
    model: publicModel,
    instructions: "Base instruction",
    input: [
      { type: "message", role: "developer", content: "Repository instructions" },
      { role: "system", content: [{ type: "input_text", text: "Environment" }] },
      { role: "user", content: [{ type: "input_text", text: "Hello " }, { type: "input_text", text: "Kolibri" }] },
      { type: "message", role: "assistant", id: "message-history", status: "completed", phase: "final_answer",
        content: [{ type: "output_text", text: "Previous answer", annotations: [] }] },
      { role: "user", content: "Continue" },
    ],
    stream: true,
    max_output_tokens: 512,
    reasoning: { effort: "none" },
    tools: [],
    tool_choice: "none",
    parallel_tool_calls: false,
    store: true,
    metadata: { secret: "native-private-metadata" },
    client_metadata: { secret: "native-private-client" },
    prompt_cache_key: "private-session",
    include: ["reasoning.encrypted_content"],
    text: { format: { type: "text" }, verbosity: "medium" },
  };
  const projected = JSON.parse(createMlxChatRequest(body, route));
  assert.deepEqual(projected, {
    model: route.upstreamModel,
    messages: [
      { role: "system", content: "Base instruction\n\nRepository instructions\n\nEnvironment" },
      { role: "user", content: "Hello Kolibri" },
      { role: "assistant", content: "Previous answer" },
      { role: "user", content: "Continue" },
    ],
    stream: true,
    chat_template_kwargs: { reasoning_effort: "none" },
    max_tokens: 512,
    stream_options: { include_usage: true },
  });
  assert.equal(JSON.stringify(projected).includes("native-private"), false);
  assert.equal(JSON.stringify(projected).includes("private-session"), false);
});

test("MLX accepts a simple nonstreaming text query", () => {
  assert.deepEqual(JSON.parse(createMlxChatRequest({ input: "Hallo" }, route)), {
    model: route.upstreamModel,
    messages: [{ role: "user", content: "Hallo" }],
    stream: false,
    chat_template_kwargs: { reasoning_effort: "none" },
  });
});

test("MLX discards reviewed native summary presentation preferences without enabling reasoning", () => {
  for (const summary of ["none", "auto", "concise", "detailed", null]) {
    const projected = JSON.parse(createMlxChatRequest({
      input: "Hello", stream: true, reasoning: { effort: "none", summary },
      stream_options: { reasoning_summary_delivery: "sequential_cutoff" },
    }, route));
    assert.deepEqual(projected.messages, [{ role: "user", content: "Hello" }]);
    assert.deepEqual(projected.chat_template_kwargs, { reasoning_effort: "none" });
    assert.deepEqual(projected.stream_options, { include_usage: true });
    assert.equal(Object.hasOwn(projected, "reasoning"), false);
  }
});

test("MLX can replay its own completed text output without forwarding probability metadata", () => {
  const answer = transform(chatResponse({ text: "Hallo!" }));
  const projected = JSON.parse(createMlxChatRequest({ input: [
    { role: "user", content: "Hello" }, ...answer.output,
    { role: "user", content: "Continue" },
  ] }, route));
  assert.deepEqual(projected.messages, [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hallo!" },
    { role: "user", content: "Continue" },
  ]);
  assert.equal(JSON.stringify(projected).includes("logprobs"), false);
  assert.equal(JSON.stringify(projected).includes("annotations"), false);
});

test("MLX rejects tools, forced choice, stored continuation, compaction, media, and unknown history", () => {
  const invalid = [
    { tools: [{ type: "function", name: "read_file" }] },
    { tool_choice: "required" },
    { tool_choice: { type: "function", name: "read_file" } },
    { previous_response_id: "resp_previous" },
    { truncation: "auto" },
    { background: true },
    { instructions: {} },
    { reasoning: { effort: "high" } },
    { reasoning: { effort: "none", summary: "unknown" } },
    { reasoning: { effort: "none", summary: {} } },
    { stream_options: { reasoning_summary_delivery: "unknown" } },
    { stream_options: { include_usage: true } },
    { stream_options: { reasoning_summary_delivery: "sequential_cutoff", unknown: true } },
    { stream_options: [] },
    { text: { format: { type: "json_object" } } },
    { max_output_tokens: 0 },
    { stream: "true" },
    { unknown: "private-value" },
    { input: [{ type: "function_call", name: "read_file", arguments: "{}" }] },
    { input: [{ type: "function_call_output", call_id: "call_1", output: "private-result" }] },
    { input: [{ type: "reasoning", summary: [] }] },
    { input: [{ type: "compaction", encrypted_content: "private-summary" }] },
    { input: [{ type: "compaction_trigger" }] },
    { input: [{ role: "tool", content: "private-result" }] },
    { input: [{ role: "user", content: [{ type: "input_image", image_url: "private-url" }] }] },
    { input: [{ role: "user", content: "Text", unknown: "private-value" }] },
    { input: [{ role: "user", content: [{ type: "input_text", text: "Text", unknown: "private-value" }] }] },
    { input: [{ role: "assistant", status: "incomplete", content: "truncated" }] },
    { input: [{ role: "assistant", content: [{ type: "output_text", text: "Text", logprobs: [{ token: "private-token" }] }] }] },
    { input: [{ role: "assistant", content: [{ type: "output_text", text: "Text", logprobs: {} }] }] },
    { input: [{ role: "user", content: [{ type: "input_text", text: "Text", logprobs: [] }] }] },
  ];
  for (const overrides of invalid) {
    assert.throws(() => createMlxChatRequest({ input: "Hello", ...overrides }, route), (error) =>
      error instanceof MlxChatRequestError && error.statusCode === 400 &&
      !error.message.includes("private-value"));
  }
});

test("MLX request encoding has a byte bound", () => {
  assert.throws(() => createMlxChatRequest({ input: "ü".repeat(1024) }, route, { maxBytes: 1024 }), MlxChatRequestError);
  assert.throws(() => createMlxChatRequest({ input: "Hello" }, route, { maxBytes: 0 }), TypeError);
});

test("MLX JSON translation produces Responses text and isolated IDs with token usage", () => {
  const response = transform(chatResponse());
  assert.equal(response.object, "response");
  assert.equal(response.status, "completed");
  assert.equal(response.model, publicModel);
  assert.match(response.id, /^resp_[a-f0-9]{32}$/u);
  assert.match(response.output[0].id, /^msg_[a-f0-9]{32}$/u);
  assert.equal(response.output[0].role, "assistant");
  assert.equal(response.output[0].content[0].text, "Guten Tag!");
  assert.deepEqual(response.usage, {
    input_tokens: 12, input_tokens_details: { cached_tokens: 3 },
    output_tokens: 4, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 16,
  });
  assert.equal(JSON.stringify(response).includes("private-"), false);
  assert.notEqual(transform(chatResponse()).id, response.id);
});

test("MLX JSON represents length exhaustion as incomplete", () => {
  const response = transform(chatResponse({ finish: "length", text: "Partial" }));
  assert.equal(response.status, "incomplete");
  assert.equal(response.output[0].status, "incomplete");
  assert.deepEqual(response.incomplete_details, { reason: "max_output_tokens" });
  assert.equal(response.output[0].content[0].text, "Partial");
});

test("MLX JSON supports an empty text response without inventing output", () => {
  assert.equal(transform(chatResponse({ text: null })).output[0].content[0].text, "");
});

test("MLX JSON rejects unknown schemas, tools, reasoning and malformed usage", () => {
  const invalid = [
    { error: "private-upstream-error" },
    { choices: [chatResponse().choices[0], chatResponse().choices[0]] },
    { choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null } }] },
    { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "", tool_calls: [] } }] },
    { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "", reasoning: "private-thought" } }] },
    { choices: [{ index: 0, finish_reason: null, message: { role: "assistant", content: "partial" } }] },
    { choices: [{ index: 1, finish_reason: "stop", message: { role: "assistant", content: "wrong choice" } }] },
    { choices: [{ index: 0, finish_reason: "stop", message: { role: "user", content: "wrong role" } }] },
    { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: [{ type: "text" }] } }] },
    { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant" } }] },
    { usage: { prompt_tokens: -1, completion_tokens: 4, total_tokens: 3 } },
    { usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 17 } },
    { usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, prompt_tokens_details: { cached_tokens: 13 } } },
    { object: "text_completion" },
    { id: "invalid\nid" },
    { created: -1 },
    { unknown: "private-field" },
  ];
  for (const overrides of invalid) {
    assert.throws(() => transform(chatResponse(overrides)), (error) =>
      error instanceof ResponseTransformError && !error.message.includes("private-"));
  }
});

test("MLX JSON rejects malformed UTF-8, JSON, and oversized buffers", () => {
  for (const buffer of [Buffer.from("{"), Buffer.from([0xff])]) {
    assert.throws(() => transformMlxChatJson(buffer, { model: publicModel }), ResponseTransformError);
  }
  assert.throws(() => transformMlxChatJson(Buffer.alloc(1025), { model: publicModel, maxBytes: 1024 }), ResponseTransformError);
});

test("MLX streaming survives byte fragmentation and emits a complete Responses text lifecycle", () => {
  const observed = [];
  const transformer = createMlxChatSseTransformer({ model: publicModel, onTerminalEvent: (value) => observed.push(value) });
  const input = Buffer.concat([
    Buffer.from(": keepalive 1/2\r\n\r\n"),
    frame(chatChunk("Grüße ")), frame(chatChunk("🐦")), frame(chatChunk(undefined, "stop")),
    frame(usageChunk()), frame("[DONE]"),
  ]);
  const output = [];
  for (let index = 0; index < input.length; index += 1) output.push(...transformer.push(input.subarray(index, index + 1)));
  output.push(...transformer.finish());
  const values = events(output);
  assert.deepEqual(values.map((value) => value.type), [
    "response.created", "response.in_progress", "response.output_item.added", "response.content_part.added",
    "response.output_text.delta", "response.output_text.delta", "response.output_text.done",
    "response.content_part.done", "response.output_item.done", "response.completed",
  ]);
  assert.deepEqual(values.map((value) => value.sequence_number), values.map((_, index) => index));
  const response = values.at(-1).response;
  assert.equal(response.output[0].content[0].text, "Grüße 🐦");
  assert.equal(response.usage.total_tokens, 16);
  assert.equal(values[0].response.id, response.id);
  assert.equal(values[2].item.id, response.output[0].id);
  assert.equal(JSON.stringify(values).includes("private-"), false);
  assert.equal(transformer.hasTerminalEvent(), true);
  assert.deepEqual(observed, [response]);
});

test("MLX stream accepts the Kolibri launcher's role-only header and role-less continuation chunks", () => {
  const initial = chatChunk(undefined);
  const content = chatChunk("Kolibri antwortet.");
  delete content.choices[0].delta.role;
  const terminal = chatChunk(undefined, "stop");
  delete terminal.choices[0].delta.role;
  const usage = usageChunk();
  for (const value of [initial, content, terminal, usage]) {
    value.model = route.upstreamModel;
    delete value.system_fingerprint;
  }
  const transformer = createMlxChatSseTransformer({ model: publicModel });
  const output = transformer.push(Buffer.concat([
    frame(initial), frame(content), frame(terminal), frame(usage), frame("[DONE]"),
  ]));
  const values = events([...output, ...transformer.finish()]);
  assert.equal(values.at(-1).type, "response.completed");
  assert.equal(values.at(-1).response.output[0].content[0].text, "Kolibri antwortet.");
  assert.equal(values.at(-1).response.usage.total_tokens, 16);
});

test("MLX stream requires an initial assistant role and rejects conflicting later roles", () => {
  const missing = chatChunk("No role");
  delete missing.choices[0].delta.role;
  const wrongInitial = chatChunk("Wrong role");
  wrongInitial.choices[0].delta.role = "user";
  const wrongLater = chatChunk("Wrong later role");
  wrongLater.choices[0].delta.role = "user";
  for (const input of [
    frame(missing), frame(wrongInitial),
    Buffer.concat([frame(chatChunk(undefined)), frame(wrongLater)]),
  ]) {
    const transformer = createMlxChatSseTransformer({ model: publicModel });
    assert.throws(() => transformer.push(input), ResponseTransformError);
    assert.equal(transformer.hasTerminalEvent(), false);
  }
});

test("MLX stream does not claim completion before a consistent terminal and DONE", () => {
  const transformer = createMlxChatSseTransformer({ model: publicModel });
  transformer.push(frame(chatChunk("Hello")));
  assert.equal(transformer.hasTerminalEvent(), false);
  assert.deepEqual(transformer.push(frame(chatChunk(undefined, "stop"))), []);
  assert.equal(transformer.hasTerminalEvent(), false);
  assert.deepEqual(transformer.push(frame(usageChunk())), []);
  assert.deepEqual(transformer.push(frame("[DONE]")), []);
  assert.equal(transformer.hasTerminalEvent(), false);
  const values = events(transformer.finish());
  assert.equal(values.at(-1).type, "response.completed");
  assert.equal(transformer.hasTerminalEvent(), true);
});

test("MLX stream preserves incomplete terminal state for length exhaustion", () => {
  const transformer = createMlxChatSseTransformer({ model: publicModel });
  const output = transformer.push(Buffer.concat([
    frame(chatChunk("Partial", "length")), frame(usageChunk()), frame("[DONE]"),
  ]));
  const values = events([...output, ...transformer.finish()]);
  assert.equal(values.at(-1).type, "response.incomplete");
  assert.equal(values.at(-1).response.status, "incomplete");
  assert.equal(values.some((value) => value.type === "response.completed"), false);
});

test("MLX withholds terminal events until EOF and rejects a malformed later chunk", () => {
  const observed = [];
  const transformer = createMlxChatSseTransformer({ model: publicModel, onTerminalEvent: (value) => observed.push(value) });
  const values = events(transformer.push(Buffer.concat([
    frame(chatChunk("Hello", "stop")), frame(usageChunk()), frame("[DONE]"),
  ])));
  assert.equal(values.some((value) => value.type === "response.completed"), false);
  assert.equal(values.some((value) => value.type === "response.output_item.done"), false);
  assert.equal(transformer.hasTerminalEvent(), false);
  assert.throws(() => transformer.push(frame(chatChunk("trailer"))), ResponseTransformError);
  assert.equal(transformer.hasTerminalEvent(), false);
  assert.deepEqual(observed, []);
});

test("MLX stream rejects missing, duplicated or reordered terminal state", () => {
  const streams = [
    [frame("[DONE]")],
    [frame(chatChunk("Partial"))],
    [frame(chatChunk("Partial", "stop")), frame("[DONE]")],
    [frame(chatChunk("Text")), frame(usageChunk())],
    [frame(chatChunk("Text", "stop")), frame(chatChunk("extra"))],
    [frame(chatChunk("Text", "stop")), frame(usageChunk()), frame(usageChunk())],
    [frame(chatChunk("Text", "stop")), frame(usageChunk()), frame("[DONE]"), frame("[DONE]")],
    [frame(chatChunk("Text", "stop")), frame(usageChunk()), frame("[DONE]"), frame(chatChunk("extra"))],
  ];
  for (const stream of streams) {
    const transformer = createMlxChatSseTransformer({ model: publicModel });
    assert.throws(() => {
      transformer.push(Buffer.concat(stream));
      transformer.finish();
    }, ResponseTransformError);
    assert.equal(transformer.hasTerminalEvent(), false);
  }
});

test("MLX stream rejects tools, reasoning, unknown SSE fields, identity drift and corrupt usage", () => {
  const tool = chatChunk("");
  tool.choices[0].delta.tool_calls = [{ id: "private-call" }];
  const reasoning = chatChunk("");
  reasoning.choices[0].delta.reasoning = "private-thought";
  const choices = chatChunk("Text");
  choices.choices.push(choices.choices[0]);
  const badUsage = usageChunk();
  badUsage.usage.total_tokens = 99;
  const different = chatChunk("Text");
  different.id = "different-id";
  const streams = [
    frame(tool), frame(reasoning), frame(choices), frame("{invalid-json"),
    Buffer.from(`event: unknown\ndata: ${JSON.stringify(chatChunk("Text"))}\n\n`),
    Buffer.from(`id: private-id\ndata: ${JSON.stringify(chatChunk("Text"))}\n\n`),
    Buffer.concat([frame(chatChunk("Text")), frame(different)]),
    Buffer.concat([frame(chatChunk("Text", "stop")), frame(badUsage)]),
  ];
  for (const input of streams) {
    const transformer = createMlxChatSseTransformer({ model: publicModel });
    assert.throws(() => transformer.push(input), (error) =>
      error instanceof ResponseTransformError && !error.message.includes("private-"));
    assert.equal(transformer.hasTerminalEvent(), false);
  }
});

test("MLX stream rejects invalid or truncated UTF-8 and enforces a total byte bound", () => {
  const invalid = createMlxChatSseTransformer({ model: publicModel });
  assert.throws(() => invalid.push(Buffer.from([0xff])), ResponseTransformError);
  const truncated = createMlxChatSseTransformer({ model: publicModel });
  truncated.push(Buffer.from([0xc3]));
  assert.throws(() => truncated.finish(), ResponseTransformError);
  const oversized = createMlxChatSseTransformer({ model: publicModel, maxBytes: 1024 });
  assert.throws(() => oversized.push(Buffer.alloc(1025)), ResponseTransformError);
});
