import assert from "node:assert/strict";
import test from "node:test";

import {
  MlxChatRequestError,
  MLX_REQUEST_MAX_BYTES,
  createMlxChatRequest,
  createMlxChatSseTransformer,
  projectMlxInferenceError,
  transformMlxChatJson,
} from "../src/mlx-chat.mjs";
import { ResponseTransformError } from "../src/responses-transform.mjs";
import { normalizeLmStudioToolRequest } from "../src/tool-normalization.mjs";
import { projectClientToolSearch } from "../src/efficient-fidelity.mjs";

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

test("MLX request default accepts the exact 8 MiB UTF-8 boundary and rejects larger bodies", () => {
  const maximum = MLX_REQUEST_MAX_BYTES;
  assert.equal(maximum, 8 * 1024 * 1024);
  const overhead = createMlxChatRequest({ input: "" }, route).length;
  const available = maximum - overhead;
  const input = "ä".repeat(Math.floor(available / 2)) + (available % 2 === 1 ? "x" : "");
  assert.equal(createMlxChatRequest({ input }, route).length, maximum);
  assert.equal(createMlxChatRequest({ input }, route, { maxBytes: 2 * maximum }).length, maximum);
  assert.throws(() => createMlxChatRequest({ input: `${input}x` }, route), MlxChatRequestError);
  assert.throws(() => createMlxChatRequest({ input: `${input}x` }, route, { maxBytes: 2 * maximum }), MlxChatRequestError);
});

test("MLX large context projection retains complete text and correlated function history", () => {
  const source = `BEGIN SOURCE\n${"Größe 🙂\n".repeat(150_000)}END SOURCE`;
  const body = {
    instructions: "Keep the complete source.",
    tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
    input: [
      { role: "user", content: "Read source" },
      { type: "function_call", call_id: "call_prior", name: "lookup", arguments: '{"query":"source"}' },
      { type: "function_call_output", call_id: "call_prior", output: source },
      { role: "user", content: "Continue using the entire source" },
    ],
    max_output_tokens: 1024,
  };
  const encoded = createMlxChatRequest(body, { ...route, contextWindow: 262_144 }, { allowTools: true });
  assert.ok(encoded.length > 1024 * 1024 && encoded.length < 8 * 1024 * 1024);
  assert.deepEqual(JSON.parse(encoded).messages, [
    { role: "system", content: body.instructions },
    { role: "user", content: "Read source" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_prior", type: "function", function: { name: "lookup", arguments: '{"query":"source"}' } }] },
    { role: "tool", content: source, tool_call_id: "call_prior" },
    { role: "user", content: "Continue using the entire source" },
  ]);
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

function toolFixture() {
  const body = { input: "Run the lookup", tools: [{ type: "namespace", name: "research", tools: [{
    type: "function", name: "lookup", parameters: { type: "object", properties: { query: { type: "string" } } },
  }] }], tool_choice: "auto", parallel_tool_calls: true };
  const normalized = structuredClone(body);
  const codec = normalizeLmStudioToolRequest(normalized, body);
  return { normalized, codec, name: normalized.tools[0].name };
}

function toolReply(name, { streaming = false, ...overrides } = {}) {
  const call = { id: "private-call-id", type: "function", function: { name, arguments: '{"query":"Example"}' } };
  if (streaming) call.index = 0;
  const value = streaming ? chatChunk(undefined, "tool_calls") : chatResponse({ text: "", finish: "tool_calls" });
  value.choices[0][streaming ? "delta" : "message"].tool_calls = [call];
  return { ...value, ...overrides };
}

test("MLX certified requests translate function definitions and a correlated full replay", () => {
  const { normalized, name } = toolFixture();
  normalized.input = [
    { role: "user", content: "Find a source" },
    { type: "function_call", id: "fc_prior", call_id: "call_prior", name, arguments: '{"query":"Example"}' },
    { type: "function_call_output", call_id: "call_prior", output: [{ type: "input_text", text: "Found source" }] },
  ];
  const result = JSON.parse(createMlxChatRequest(normalized, route, { allowTools: true }));
  assert.equal(result.parallel_tool_calls, false);
  assert.equal(result.tools[0].function.name, name);
  assert.deepEqual(result.messages, [
    { role: "user", content: "Find a source" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_prior", type: "function", function: { name, arguments: '{"query":"Example"}' } }] },
    { role: "tool", content: "Found source", tool_call_id: "call_prior" },
  ]);
  normalized.tool_choice = { type: "function", name };
  assert.equal(JSON.parse(createMlxChatRequest(normalized, route, { allowTools: true })).tool_choice, "required");
});

test("MLX function history rejects missing results, reused IDs, unknown names and malformed JSON", () => {
  const { normalized, name } = toolFixture();
  const call = { type: "function_call", call_id: "call_prior", name, arguments: "{}" };
  const output = { type: "function_call_output", call_id: "call_prior", output: "result" };
  for (const history of [
    [call], [output], [call, output, output], [call, output, call, output],
    [{ ...call, name: "unknown" }, output], [{ ...call, arguments: "{" }, output],
    [{ ...call, arguments: "[]" }, output], [call, { ...output, call_id: "different" }],
    [{ ...call, arguments: '{"query":"first","query":"second"}' }, output],
    [{ ...call, arguments: '{"a":[{"query":1,"qu\\u0065ry":2}]}' }, output],
    [{ ...call, arguments: '{"a":1e999}' }, output],
  ]) {
    assert.throws(() => createMlxChatRequest({ ...normalized, input: [{ role: "user", content: "Request" }, ...history] }, route, { allowTools: true }), MlxChatRequestError);
  }
  assert.throws(() => createMlxChatRequest({ ...normalized, tool_choice: { type: "function", name: "unknown" } }, route, { allowTools: true }), MlxChatRequestError);
  assert.throws(() => createMlxChatRequest({ ...normalized, previous_response_id: "old" }, route, { allowTools: true }), MlxChatRequestError);
});

test("MLX arguments preserve nested JSON and reject ambiguous provider fields", () => {
  const { normalized, codec, name } = toolFixture();
  const source = '{ "query": "Escaped \\\" and \\\\ string", "data": [{"a": [null, true, 1.5]}, {}] }';
  const result = createMlxChatRequest({ ...normalized, input: [
    { role: "user", content: "Request" },
    { type: "function_call", call_id: "call_prior", name, arguments: source },
    { type: "function_call_output", call_id: "call_prior", output: "Result" },
  ] }, route, { allowTools: true });
  assert.equal(JSON.parse(result).messages[1].tool_calls[0].function.arguments, source);
  for (const args of ['{"a":1,"a":2}', '{"a":[{"b":1,"b":2}]}', '{"a":1e999}']) {
    const reply = toolReply(name);
    reply.choices[0].message.tool_calls[0].function.arguments = args;
    assert.throws(() => transformMlxChatJson(Buffer.from(JSON.stringify(reply)), { model: publicModel, toolCodec: codec }), ResponseTransformError);
  }
  const response = JSON.stringify(chatResponse()).replace('"object":"chat.completion"', '"object":"private","object":"chat.completion"');
  assert.throws(() => transformMlxChatJson(Buffer.from(response), { model: publicModel }), ResponseTransformError);
});

test("MLX JSON function calls restore exact namespaces and isolate provider IDs", () => {
  const { codec, name } = toolFixture();
  const value = JSON.parse(transformMlxChatJson(Buffer.from(JSON.stringify(toolReply(name))), {
    model: publicModel, toolCodec: codec, requireToolCall: true,
  }));
  const call = value.output.find((item) => item.type === "function_call");
  assert.equal(value.status, "completed");
  assert.equal(call.namespace, "research");
  assert.equal(call.name, "lookup");
  assert.deepEqual(JSON.parse(call.arguments), { query: "Example" });
  assert.match(call.id, /^fc_[a-f0-9]{32}$/u);
  assert.match(call.call_id, /^call_[a-f0-9]{32}$/u);
  assert.equal(JSON.stringify(value).includes("private-call-id"), false);
});

test("MLX tools fail closed without request-local authority, on extra calls, malformed arguments, or unsatisfied choice", () => {
  const { codec, name } = toolFixture();
  const base = toolReply(name);
  const unknown = toolReply("unadvertised");
  const multiple = structuredClone(base);
  multiple.choices[0].message.tool_calls.push(multiple.choices[0].message.tool_calls[0]);
  const malformed = structuredClone(base);
  malformed.choices[0].message.tool_calls[0].function.arguments = "[1]";
  const reused = { ...codec, reservedCallIds: new Set(["private-call-id"]) };
  for (const [reply, authority] of [[base, undefined], [unknown, codec], [multiple, codec], [malformed, codec], [base, reused]]) {
    assert.throws(() => transformMlxChatJson(Buffer.from(JSON.stringify(reply)), { model: publicModel, toolCodec: authority }), ResponseTransformError);
  }
  assert.throws(() => transformMlxChatJson(Buffer.from(JSON.stringify(chatResponse())), {
    model: publicModel, toolCodec: codec, requireToolCall: true,
  }), ResponseTransformError);
});

test("MLX streamed function calls are released only at clean EOF with matching completion", () => {
  const { codec, name } = toolFixture();
  const transformer = createMlxChatSseTransformer({ model: publicModel, toolCodec: codec, requireToolCall: true });
  const beforeEof = transformer.push(Buffer.concat([
    frame(chatChunk(undefined)), frame(toolReply(name, { streaming: true })), frame(usageChunk()), frame("[DONE]"),
  ]));
  assert.equal(events(beforeEof).some((value) => value.item?.type === "function_call"), false);
  const values = events(transformer.finish());
  const call = values.find((value) => value.type === "response.output_item.done" && value.item.type === "function_call").item;
  assert.equal(call.namespace, "research");
  assert.equal(call.name, "lookup");
  assert.equal(values.at(-1).type, "response.completed");
  assert.deepEqual(values.at(-1).response.output.find((item) => item.type === "function_call"), call);
});

test("MLX streaming tools reject partial envelopes and never release calls or metrics after late corruption", () => {
  const { codec, name } = toolFixture();
  const terminal = toolReply(name, { streaming: true });
  const partial = structuredClone(terminal);
  partial.choices[0].finish_reason = null;
  const multiple = structuredClone(terminal);
  multiple.choices[0].delta.tool_calls.push(structuredClone(multiple.choices[0].delta.tool_calls[0]));
  const invalidMetric = { ...usageChunk(), pickermux_metrics: { generation_duration_ms: 0 } };
  const usage = { ...usageChunk(), pickermux_metrics: { generation_duration_ms: 200 } };
  for (const packets of [
    [chatChunk(undefined), partial],
    [chatChunk(undefined), multiple],
    [chatChunk(undefined), terminal, invalidMetric],
    [chatChunk(undefined), terminal, usage, "[DONE]", chatChunk("late")],
  ]) {
    const durations = [];
    const transformer = createMlxChatSseTransformer({ model: publicModel, toolCodec: codec, onGenerationDuration: (value) => durations.push(value) });
    assert.throws(() => transformer.push(Buffer.concat(packets.map(frame))), ResponseTransformError);
    assert.equal(transformer.hasTerminalEvent(), false);
    assert.deepEqual(durations, []);
    assert.throws(() => transformer.finish(), ResponseTransformError);
  }
});

test("MLX restores certified compact client tool selection in JSON and SSE", () => {
  const projection = projectClientToolSearch([{
    type: "tool_search", execution: "client", description: "Find useful tools.",
    parameters: {
      type: "object", properties: { query: { type: "string" } },
      required: ["query"], additionalProperties: false,
    },
  }], { toolChoice: "auto", parallelToolCalls: false });
  const source = { tools: projection.tools, tool_choice: "auto", input: "Find source" };
  const normalized = structuredClone(source);
  const namespaceCodec = normalizeLmStudioToolRequest(normalized, source);
  const name = normalized.tools[0].name;
  const toolCodec = { namespaceCodec, efficientFidelityCodec: projection.codec };
  const transformed = JSON.parse(transformMlxChatJson(Buffer.from(JSON.stringify(toolReply(name))), {
    model: publicModel, toolCodec,
  }));
  const call = transformed.output.find((item) => item.type === "tool_search_call");
  assert.equal(call.execution, "client");
  assert.deepEqual(call.arguments, { query: "Example" });
  assert.equal(Object.hasOwn(call, "name"), false);
  const transformer = createMlxChatSseTransformer({ model: publicModel, toolCodec });
  const values = events([
    ...transformer.push(Buffer.concat([frame(chatChunk(undefined)), frame(toolReply(name, { streaming: true })), frame(usageChunk()), frame("[DONE]")])),
    ...transformer.finish(),
  ]);
  const streamed = values.at(-1).response.output.find((item) => item.type === "tool_search_call");
  assert.equal(streamed.execution, "client");
  assert.deepEqual(streamed.arguments, { query: "Example" });
  assert.equal(values.some((value) => value.type === "response.output_item.done" && value.item.type === "tool_search_call"), true);
});

test("MLX generation metrics are bounded, excluded from output, and observed only after success", () => {
  const durations = [];
  const value = chatResponse({ pickermux_metrics: { generation_duration_ms: 25 } });
  const result = transformMlxChatJson(Buffer.from(JSON.stringify(value)), { model: publicModel, onGenerationDuration: (duration) => durations.push(duration) });
  assert.deepEqual(durations, [25]);
  assert.equal(result.toString().includes("generation_duration"), false);
  for (const metric of [null, {}, { generation_duration_ms: 0 }, { generation_duration_ms: 3_600_001 }, { generation_duration_ms: 2.5 }, { generation_duration_ms: 1, private: "no" }]) {
    assert.throws(() => transformMlxChatJson(Buffer.from(JSON.stringify(chatResponse({ pickermux_metrics: metric }))), {
      model: publicModel, onGenerationDuration: (duration) => durations.push(duration),
    }), ResponseTransformError);
  }
  assert.deepEqual(durations, [25]);
  const transformer = createMlxChatSseTransformer({ model: publicModel, onGenerationDuration: (duration) => durations.push(duration) });
  transformer.push(Buffer.concat([frame(chatChunk("Hi", "stop")), frame({ ...usageChunk(), pickermux_metrics: { generation_duration_ms: 50 } }), frame("[DONE]")]));
  assert.deepEqual(durations, [25]);
  transformer.finish();
  assert.deepEqual(durations, [25, 50]);
});

test("MLX inference failures project only exact known runtime messages to fixed public classifications", () => {
  for (const [source, publicCode, message] of [
    ["The model invoked an unadvertised function.", "MLX_UNADVERTISED_FUNCTION", "The local MLX model selected an unadvertised function."],
    ["An incomplete or disabled function call cannot execute.", "MLX_INCOMPLETE_FUNCTION_CALL", "The local MLX model returned an incomplete or disabled function call."],
    ["The model returned malformed function arguments.", "MLX_INVALID_FUNCTION_ARGUMENTS", "The local MLX model returned malformed function arguments."],
    ["The model returned an unsupported function envelope.", "MLX_INVALID_FUNCTION_ENVELOPE", "The local MLX model returned an unsupported function envelope."],
    ["The model returned unsupported control output.", "MLX_UNSUPPORTED_CONTROL_OUTPUT", "The local MLX model returned unsupported control output."],
    ["The model did not satisfy the selected function contract.", "MLX_UNSATISFIED_FUNCTION_CONTRACT", "The local MLX model did not satisfy the selected function contract."],
    ["Kolibri returned invalid token counts.", "MLX_INVALID_TOKEN_COUNTS", "The local MLX model returned invalid token counts."],
    ["The model returned an unsupported completion.", "MLX_INVALID_COMPLETION", "The local MLX model returned an unsupported or incomplete completion."],
    ["Kolibri returned unsupported or incomplete output.", "MLX_INVALID_COMPLETION", "The local MLX model returned an unsupported or incomplete completion."],
    ["Function arguments exceed the supported bounds.", "MLX_FUNCTION_ARGUMENT_LIMIT_EXCEEDED", "The local MLX model exceeded the function argument limit."],
    ["Kolibri output exceeded the response limit.", "MLX_OUTPUT_LIMIT_EXCEEDED", "The local MLX model exceeded the response output limit."],
  ]) {
    const input = Buffer.from(JSON.stringify({ error: { code: "MODEL_OUTPUT_INVALID", message: source } }));
    const projected = projectMlxInferenceError(input);
    assert.deepEqual(projected, { publicCode, message });
    assert.deepEqual(Object.keys(projected).sort(), ["message", "publicCode"]);
    projected.message = "caller mutation";
    assert.deepEqual(projectMlxInferenceError(input), { publicCode, message });
  }
});

test("MLX inference error projection uses an exact 4096-byte UTF-8 JSON boundary", () => {
  const body = JSON.stringify({ error: { code: "MODEL_OUTPUT_INVALID", message: "The model invoked an unadvertised function." } });
  const exact = Buffer.from(body + " ".repeat(4096 - Buffer.byteLength(body)));
  assert.equal(exact.length, 4096);
  assert.equal(projectMlxInferenceError(exact).publicCode, "MLX_UNADVERTISED_FUNCTION");
  for (const input of [undefined, body, new Uint8Array(Buffer.from(body)), Buffer.alloc(0), Buffer.concat([exact, Buffer.from(" ")]),
    Buffer.from([0xff]), Buffer.concat([Buffer.from(body), Buffer.from([0xc3])]),
  ]) {
    assert.equal(projectMlxInferenceError(input), undefined);
  }
});

test("MLX inference error projection discards ambiguous, unknown, malformed and sensitive provider bodies", () => {
  const message = "The model invoked an unadvertised function.";
  const error = { code: "MODEL_OUTPUT_INVALID", message };
  const sensitive = "PRIVATE_PROMPT_CANARY /private/fixture Bearer synthetic-secret";
  for (const body of [
    {}, { error: null }, { error: [] }, { error: message }, { error: { code: "MODEL_OUTPUT_INVALID" } },
    { error: { message } }, { error: { ...error, code: "MODEL_UNAVAILABLE" } },
    { error: { ...error, code: "mlx_unadvertised_function" } },
    { error: { ...error, message: `${message} ${sensitive}` } },
    { error: { ...error, message: ` ${message}` } },
    { error: { ...error, message: `${message}\n` } },
    { error: { ...error, message: sensitive } },
    { error: { ...error, message: { detail: sensitive } } },
    { error, detail: sensitive }, { error: { ...error, detail: sensitive } },
    { error: { ...error, __proto__: null, constructor: sensitive } },
  ]) {
    assert.equal(projectMlxInferenceError(Buffer.from(JSON.stringify(body))), undefined);
  }
  for (const source of [
    `{"error":{"code":"MODEL_OUTPUT_INVALID","code":"MODEL_OUTPUT_INVALID","message":${JSON.stringify(message)}}}`,
    `{"error":{"code":"MODEL_OUTPUT_INVALID","message":${JSON.stringify(message)},"mess\\u0061ge":${JSON.stringify(message)}}}`,
    `{"error":{"code":"MODEL_OUTPUT_INVALID","message":${JSON.stringify(message)}},"error":{"code":"MODEL_OUTPUT_INVALID","message":${JSON.stringify(message)}}}`,
    `{"error":{"code":"MODEL_OUTPUT_INVALID","message":${JSON.stringify(message)},"private":{"same":1,"same":2}}}`,
    `{"error":{"code":"MODEL_OUTPUT_INVALID","message":${JSON.stringify(message)}}} trailing`,
    `{"error":{"code":"MODEL_OUTPUT_INVALID","message":NaN}}`,
    `{"error":{"code":"MODEL_OUTPUT_INVALID","message":1e999}}`,
    `{"error":{"code":"MODEL_OUTPUT_INVALID","message":${"[".repeat(129)}0${"]".repeat(129)}}}`,
    "not JSON " + sensitive,
  ]) {
    assert.equal(projectMlxInferenceError(Buffer.from(source)), undefined);
  }
});
