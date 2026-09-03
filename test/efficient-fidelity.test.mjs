import assert from "node:assert/strict";
import test from "node:test";

import {
  EFFICIENT_FIDELITY_WIRE_PREFIX,
  EFFICIENT_FIDELITY_SEARCH_RESULT_OUTPUT,
  EfficientFidelityError,
  createClientToolSearchSseRewriter,
  projectClientToolSearch,
  rewriteClientToolSearchInput,
  rewriteClientToolSearchResponse,
} from "../src/efficient-fidelity.mjs";

function searchTool(overrides = {}) {
  return {
    type: "tool_search",
    execution: "client",
    description: "Find only the tools needed for the current task.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    ...overrides,
  };
}

function loadedFunction(name = "workspace_read") {
  return {
    type: "function",
    name,
    description: "Read one workspace file.",
    defer_loading: true,
    strict: true,
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  };
}

function projectedCodec(extraTools = [], options) {
  return projectClientToolSearch([...extraTools, searchTool()], {
    toolChoice: "auto",
    ...options,
  });
}

function assertEfficientError(operation, { code, statusCode }) {
  assert.throws(
    operation,
    (error) =>
      error instanceof EfficientFidelityError &&
      error.code === code &&
      error.statusCode === statusCode,
  );
}

test("projects exactly one client tool_search into one deterministic LM function", () => {
  const direct = {
    type: "function",
    name: "already_loaded",
    parameters: { type: "object", properties: {} },
  };
  const sourceSearch = searchTool();
  const source = [direct, sourceSearch];
  const first = projectClientToolSearch(source, { toolChoice: "auto" });
  const second = projectClientToolSearch([direct, {
    parameters: sourceSearch.parameters,
    description: sourceSearch.description,
    execution: "client",
    type: "tool_search",
  }], { toolChoice: "auto" });

  assert.equal(first.tools.length, 2);
  assert.strictEqual(first.tools[0], direct);
  assert.deepEqual(first.tools[1], {
    type: "function",
    name: first.codec.wireName,
    description: sourceSearch.description,
    parameters: sourceSearch.parameters,
  });
  assert.match(
    first.codec.wireName,
    new RegExp(`^${EFFICIENT_FIDELITY_WIRE_PREFIX}[0-9a-f]{56}$`, "u"),
  );
  assert.equal(first.codec.wireName, second.codec.wireName);
  assert.deepEqual(source, [direct, sourceSearch]);
});

test("allocates around a real function collision without confusing its calls", () => {
  const initial = projectedCodec();
  const colliding = {
    type: "function",
    name: initial.codec.wireName,
    parameters: { type: "object", properties: {} },
  };
  const projected = projectedCodec([colliding]);
  assert.notEqual(projected.codec.wireName, colliding.name);
  assert.equal(projected.tools[0].name, colliding.name);

  const ordinary = {
    output: [{
      type: "function_call",
      name: colliding.name,
      call_id: "call_real",
      arguments: "{}",
    }],
  };
  assert.deepEqual(
    rewriteClientToolSearchResponse(ordinary, projected.codec).value,
    ordinary,
  );
});

test("keeps immediate functions and defers all defer_loading definitions", () => {
  const immediate = {
    type: "function",
    name: "immediate",
    defer_loading: false,
    parameters: {},
  };
  const projected = projectClientToolSearch([
    immediate,
    loadedFunction("direct_deferred"),
    {
      type: "namespace",
      name: "mixed",
      tools: [
        { type: "function", name: "ready", parameters: {} },
        loadedFunction("later"),
      ],
    },
    {
      type: "namespace",
      name: "all_deferred",
      tools: [loadedFunction("only_later")],
    },
    searchTool(),
  ], { toolChoice: "auto" });

  assert.deepEqual(projected.tools.slice(0, -1), [
    { type: "function", name: "immediate", parameters: {} },
    {
      type: "namespace",
      name: "mixed",
      tools: [{ type: "function", name: "ready", parameters: {} }],
    },
  ]);
  assert.equal(projected.tools.at(-1).name, projected.codec.wireName);
});

test("requires the explicit auto tool choice and rejects malformed defer flags", () => {
  assert.throws(
    () => projectClientToolSearch([searchTool()]),
    /projection options are required/u,
  );
  for (const toolChoice of [undefined, "required", "none", {
    type: "tool_search",
  }]) {
    assertEfficientError(
      () => projectClientToolSearch([searchTool()], { toolChoice }),
      { code: "UNSUPPORTED_TOOL_CHOICE", statusCode: 400 },
    );
  }
  assertEfficientError(
    () => projectClientToolSearch([{
      type: "function",
      name: "bad_defer",
      defer_loading: "true",
      parameters: {},
    }, searchTool()], { toolChoice: "auto" }),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );

  const fallback = projectClientToolSearch([
    searchTool({ description: undefined }),
  ], { toolChoice: "auto" });
  assert.match(fallback.tools[0].description, /^Search for only/u);

  assertEfficientError(
    () => projectClientToolSearch([searchTool()], {
      toolChoice: "auto",
      parallelToolCalls: "false",
    }),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );
});

test("rejects absent, duplicate, hosted, malformed, and unknown tool-search definitions", () => {
  const direct = [{ type: "function", name: "only", parameters: {} }];
  assertEfficientError(
    () => projectClientToolSearch(direct, { toolChoice: "auto" }),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );
  assertEfficientError(
    () => projectClientToolSearch(
      [searchTool(), searchTool()],
      { toolChoice: "auto" },
    ),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );
  for (const tool of [
    searchTool({ execution: "server" }),
    searchTool({ execution: undefined }),
  ]) {
    assertEfficientError(
      () => projectClientToolSearch([tool], { toolChoice: "auto" }),
      { code: "UNSUPPORTED_TOOL_SEARCH_EXECUTION", statusCode: 400 },
    );
  }
  assertEfficientError(
    () => projectClientToolSearch(
      [searchTool({ hosted_only: true })],
      { toolChoice: "auto" },
    ),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );
  assertEfficientError(
    () => projectClientToolSearch(
      [{ type: "tool_search_v2" }],
      { toolChoice: "auto" },
    ),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );
  assertEfficientError(
    () => projectClientToolSearch(
      [searchTool({ parameters: [] })],
      { toolChoice: "auto" },
    ),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );
});

test("accepts only the canonical semantic tool-search parameter schema", () => {
  const numericLimit = projectClientToolSearch([searchTool({
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query for deferred tools.",
        },
        limit: {
          type: "number",
          description: "Maximum number of tools to return.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  })], { toolChoice: "auto" });
  assert.equal(numericLimit.tools[0].parameters.properties.limit.type, "number");

  for (const parameters of [
    {},
    {
      type: "array",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {},
      required: ["query"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { query: { type: "number" } },
      required: ["query"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { query: { type: "string" } },
      required: [],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: true,
    },
    {
      type: "object",
      properties: {
        query: { type: "string" },
        extra: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 0 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  ]) {
    assertEfficientError(
      () => projectClientToolSearch(
        [searchTool({ parameters })],
        { toolChoice: "auto" },
      ),
      { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
    );
  }
});

test("accepts Codex-sized public search descriptions without relaxing loaded tools", () => {
  const searchDescription = "s".repeat(512 * 1024);
  const projection = projectClientToolSearch([
    searchTool({ description: searchDescription }),
  ], { toolChoice: "auto" });
  assert.equal(projection.tools[0].description, searchDescription);

  assertEfficientError(
    () => projectClientToolSearch([
      searchTool({ description: "s".repeat(514 * 1024) }),
    ], { toolChoice: "auto" }),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );

  assertEfficientError(
    () => rewriteClientToolSearchInput([{
      type: "tool_search_call",
      execution: "client",
      call_id: "call_large_loaded_description",
      arguments: { query: "large description" },
    }, {
      type: "tool_search_output",
      execution: "client",
      call_id: "call_large_loaded_description",
      status: "completed",
      tools: [{
        ...loadedFunction("large_description"),
        description: "d".repeat(9 * 1024),
      }],
    }], projection.codec),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );
});

test("maps a complete synthetic JSON function call to a client tool_search_call", () => {
  const { codec } = projectedCodec();
  const source = {
    id: "resp_1",
    output: [
      {
        id: "item_1",
        type: "function_call",
        name: codec.wireName,
        call_id: "call_search_1",
        status: "completed",
        arguments: '{"query":"shipping ETA"}',
      },
      {
        type: "function_call",
        name: "ordinary_tool",
        call_id: "call_ordinary",
        arguments: "{}",
      },
    ],
  };
  const rewritten = rewriteClientToolSearchResponse(source, codec);

  assert.deepEqual(rewritten.callIds, ["call_search_1"]);
  assert.deepEqual(rewritten.value.output[0], {
    id: "item_1",
    type: "tool_search_call",
    execution: "client",
    call_id: "call_search_1",
    status: "completed",
    arguments: { query: "shipping ETA" },
  });
  assert.deepEqual(rewritten.value.output[1], source.output[1]);
  assert.equal(source.output[0].type, "function_call");
});

test("rejects non-completed JSON responses and completed-call items", () => {
  const { codec } = projectedCodec();
  const synthetic = {
    type: "function_call",
    name: codec.wireName,
    call_id: "call_response_status",
    arguments: '{"query":"status"}',
  };
  for (const status of ["failed", "incomplete", "in_progress"]) {
    assertEfficientError(
      () => rewriteClientToolSearchResponse({
        status,
        output: [synthetic],
      }, codec),
      { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
    );
    assertEfficientError(
      () => rewriteClientToolSearchResponse({
        status: "completed",
        output: [{
          type: "function_call",
          name: "ordinary_tool",
          call_id: `call_item_${status}`,
          status,
          arguments: "{}",
        }],
      }, codec),
      { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
    );
  }
});

test("rejects successful JSON responses carrying error or incomplete details", () => {
  const { codec } = projectedCodec();
  const synthetic = {
    type: "function_call",
    name: codec.wireName,
    call_id: "call_inconsistent_envelope",
    status: "completed",
    arguments: '{"query":"envelope"}',
  };
  for (const [field, value] of [
    ["error", { code: "upstream_error", message: "not successful" }],
    ["incomplete_details", { reason: "max_output_tokens" }],
  ]) {
    assertEfficientError(
      () => rewriteClientToolSearchResponse({
        status: "completed",
        [field]: value,
        output: [synthetic],
      }, codec),
      { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
    );
  }

  assert.doesNotThrow(() => rewriteClientToolSearchResponse({
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [synthetic],
  }, codec));
});

test("rejects every unadvertised invocation item in JSON responses", () => {
  const { codec } = projectedCodec();
  for (const type of [
    "computer_call",
    "custom_tool_call",
    "mcp_approval_request",
    "mcp_call",
    "shell_call",
    "web_search_call",
  ]) {
    assertEfficientError(
      () => rewriteClientToolSearchResponse({
        status: "completed",
        output: [{ type, call_id: `call_${type}` }],
      }, codec),
      { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
    );
  }
});

test("validates ordinary JSON and SSE function-call arguments and fields", () => {
  const { codec } = projectedCodec([], {
    limits: { maxArgumentBytes: 8 },
  });
  const ordinary = {
    id: "item_ordinary_shape",
    type: "function_call",
    namespace: "workspace",
    name: "read",
    call_id: "call_ordinary_shape",
    status: "completed",
    arguments: "{}",
  };
  const malformed = [
    { ...ordinary, arguments: {} },
    { ...ordinary, arguments: "not-json" },
    { ...ordinary, arguments: '"scalar"' },
    { ...ordinary, arguments: "x".repeat(9) },
    { ...ordinary, unexpected: true },
  ];
  for (const item of malformed) {
    assertEfficientError(
      () => rewriteClientToolSearchResponse({ output: [item] }, codec),
      { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
    );
    const stream = createClientToolSearchSseRewriter(codec);
    assertEfficientError(
      () => stream.push({
        type: "response.output_item.done",
        output_index: 0,
        item,
      }),
      { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
    );
  }
});

test("requires unique function item ids in JSON and SSE responses", () => {
  const { codec } = projectedCodec();
  const ordinary = (suffix) => ({
    id: "item_reused",
    type: "function_call",
    name: `ordinary_${suffix}`,
    call_id: `call_${suffix}`,
    status: "completed",
    arguments: "{}",
  });
  assertEfficientError(
    () => rewriteClientToolSearchResponse({
      output: [ordinary("first"), ordinary("second")],
    }, codec),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const stream = createClientToolSearchSseRewriter(codec);
  stream.push({
    type: "response.output_item.done",
    output_index: 0,
    item: ordinary("stream_first"),
  });
  assertEfficientError(
    () => stream.push({
      type: "response.output_item.done",
      output_index: 1,
      item: ordinary("stream_second"),
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );
});

test("accepts only bounded query and optional limit search arguments", () => {
  const { codec } = projectedCodec();
  const response = (argumentsValue) => ({
    output: [{
      type: "function_call",
      name: codec.wireName,
      call_id: "call_args",
      arguments: argumentsValue,
    }],
  });
  for (const argumentsValue of [
    "{}",
    '{"query":""}',
    '{"query":"   "}',
    '{"query":"reader","limit":0}',
    '{"query":"reader","limit":1.5}',
    '{"query":"reader","extra":true}',
  ]) {
    assertEfficientError(
      () => rewriteClientToolSearchResponse(response(argumentsValue), codec),
      { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
    );
  }

  const invalidCall = (argumentsValue) => [{
    type: "tool_search_call",
    execution: "client",
    call_id: "call_args",
    arguments: argumentsValue,
  }, {
    type: "tool_search_output",
    execution: "client",
    call_id: "call_args",
    status: "completed",
    tools: [],
  }];
  for (const argumentsValue of [
    {},
    { query: "" },
    { query: "reader", limit: 0 },
    { query: "reader", extra: true },
  ]) {
    assertEfficientError(
      () => rewriteClientToolSearchInput(invalidCall(argumentsValue), codec),
      { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
    );
  }
});

test("binds search argument limits to the request-local advertised schema", () => {
  const queryOnly = projectClientToolSearch([searchTool({
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  })], { toolChoice: "auto" });
  assertEfficientError(
    () => rewriteClientToolSearchResponse({
      output: [{
        type: "function_call",
        name: queryOnly.codec.wireName,
        call_id: "call_unadvertised_limit_upstream",
        arguments: '{"query":"reader","limit":1}',
      }],
    }, queryOnly.codec),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );
  assertEfficientError(
    () => rewriteClientToolSearchInput([{
      type: "tool_search_call",
      execution: "client",
      call_id: "call_unadvertised_limit_history",
      arguments: { query: "reader", limit: 1 },
    }, {
      type: "tool_search_output",
      execution: "client",
      call_id: "call_unadvertised_limit_history",
      status: "completed",
      tools: [],
    }], queryOnly.codec),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );

  const { codec } = projectClientToolSearch([searchTool({
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  })], { toolChoice: "auto" });

  assertEfficientError(
    () => rewriteClientToolSearchResponse({
      output: [{
        type: "function_call",
        name: codec.wireName,
        call_id: "call_schema_bound_upstream",
        arguments: '{"query":"reader","limit":2}',
      }],
    }, codec),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );
  assertEfficientError(
    () => rewriteClientToolSearchInput([{
      type: "tool_search_call",
      execution: "client",
      call_id: "call_schema_bound_history",
      arguments: { query: "reader", limit: 2 },
    }, {
      type: "tool_search_output",
      execution: "client",
      call_id: "call_schema_bound_history",
      status: "completed",
      tools: [],
    }], codec),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );
});

test("allows at most one completed call when parallel tool calls are disabled", () => {
  const { codec } = projectClientToolSearch([searchTool()], {
    toolChoice: "auto",
    parallelToolCalls: false,
  });
  const call = (index) => ({
    type: "function_call",
    name: `ordinary_${index}`,
    call_id: `call_serial_${index}`,
    arguments: "{}",
  });

  assertEfficientError(
    () => rewriteClientToolSearchResponse({ output: [call(0), call(1)] }, codec),
    { code: "TOOL_SEARCH_LIMIT_EXCEEDED", statusCode: 502 },
  );

  const stream = createClientToolSearchSseRewriter(codec);
  assert.deepEqual(stream.push({
    type: "response.output_item.done",
    output_index: 0,
    item: call(0),
  }).events, []);
  assertEfficientError(
    () => stream.push({
      type: "response.output_item.done",
      output_index: 1,
      item: call(1),
    }),
    { code: "TOOL_SEARCH_LIMIT_EXCEEDED", statusCode: 502 },
  );
});

test("reserves replayed call ids against new JSON and SSE invocations", () => {
  const { codec } = projectedCodec();
  rewriteClientToolSearchInput([{
    type: "tool_search_call",
    execution: "client",
    call_id: "call_historical_search",
    arguments: { query: "reader" },
  }, {
    type: "tool_search_output",
    execution: "client",
    call_id: "call_historical_search",
    status: "completed",
    tools: [],
  }, {
    type: "function_call",
    id: "item_historical_ordinary",
    name: "ordinary",
    call_id: "call_historical_ordinary",
    arguments: "{}",
  }, {
    type: "function_call_output",
    call_id: "call_historical_ordinary",
    output: "done",
  }], codec);

  assertEfficientError(
    () => rewriteClientToolSearchResponse({
      output: [{
        type: "function_call",
        name: codec.wireName,
        call_id: "call_historical_search",
        arguments: '{"query":"reader"}',
      }],
    }, codec),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const stream = createClientToolSearchSseRewriter(codec);
  assertEfficientError(
    () => stream.push({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "item_new_ordinary",
        name: "ordinary",
        call_id: "call_historical_ordinary",
        arguments: "{}",
      },
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  assertEfficientError(
    () => rewriteClientToolSearchResponse({
      output: [{
        type: "function_call",
        id: "item_historical_ordinary",
        name: "ordinary",
        call_id: "call_new_ordinary",
        arguments: "{}",
      }],
    }, codec),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const addedReuse = createClientToolSearchSseRewriter(codec);
  assertEfficientError(
    () => addedReuse.push({
      type: "response.output_item.added",
      output_index: 0,
      item_id: "item_historical_ordinary",
      item: {
        type: "function_call",
        name: "ordinary",
        call_id: "call_new_added",
        arguments: "",
        status: "in_progress",
      },
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const doneReuse = createClientToolSearchSseRewriter(codec);
  assertEfficientError(
    () => doneReuse.push({
      type: "response.output_item.done",
      output_index: 0,
      item_id: "item_historical_ordinary",
      item: {
        type: "function_call",
        name: "ordinary",
        call_id: "call_new_done",
        arguments: "{}",
      },
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const conflictingIds = createClientToolSearchSseRewriter(codec);
  assertEfficientError(
    () => conflictingIds.push({
      type: "response.output_item.done",
      output_index: 0,
      item_id: "item_event",
      item: {
        type: "function_call",
        id: "item_embedded",
        name: "ordinary",
        call_id: "call_new_conflict",
        arguments: "{}",
      },
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );
});

test("rewrites only the exact JSON response output path", () => {
  const { codec } = projectedCodec();
  const shadow = {
    type: "function_call",
    name: codec.wireName,
    call_id: "call_metadata",
    arguments: '{"query":"metadata"}',
  };
  const source = {
    output: [],
    metadata: { nested: shadow },
  };
  const rewritten = rewriteClientToolSearchResponse(source, codec);
  assert.deepEqual(rewritten.callIds, []);
  assert.deepEqual(rewritten.value.metadata.nested, shadow);
  assert.notStrictEqual(rewritten.value.metadata.nested, shadow);
});

test("releases a mapped search done item only with a matching completed terminal", () => {
  const { codec } = projectedCodec();
  const event = {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "function_call",
      name: codec.wireName,
      call_id: "call_stream_1",
      arguments: '{"query":"calendar"}',
    },
  };
  const stream = createClientToolSearchSseRewriter(codec);
  const held = stream.push(event);
  assert.deepEqual(held.events, []);
  assert.deepEqual(held.callIds, []);
  const terminal = stream.push({
    type: "response.completed",
    response: { id: "resp_stream_1", output: [event.item] },
  });
  assert.equal(terminal.events[0].type, "response.output_item.done");
  assert.deepEqual(terminal.events[0].item, {
    type: "tool_search_call",
    execution: "client",
    call_id: "call_stream_1",
    status: "completed",
    arguments: { query: "calendar" },
  });
  assert.equal(terminal.events[1].type, "response.completed");
  assert.deepEqual(terminal.callIds, ["call_stream_1"]);
  assert.deepEqual(stream.finish().events, []);
});

test("buffers the complete SSE tail in order and accepts a minimal completed terminal", () => {
  const { codec } = projectedCodec();
  const stream = createClientToolSearchSseRewriter(codec);
  const item = {
    type: "function_call",
    name: codec.wireName,
    call_id: "call_ordered_tail",
    arguments: '{"query":"ordered"}',
  };
  assert.deepEqual(stream.push({
    type: "response.output_item.done",
    sequence_number: 2,
    output_index: 0,
    item,
  }).events, []);
  assert.deepEqual(stream.push({
    type: "response.output_text.delta",
    sequence_number: 3,
    output_index: 1,
    delta: "later output",
  }).events, []);

  const terminal = stream.push({
    type: "response.completed",
    sequence_number: 4,
    response: {
      id: "resp_ordered_tail",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
    },
  });
  assert.deepEqual(
    terminal.events.map((event) => [event.type, event.sequence_number]),
    [
      ["response.output_item.done", 2],
      ["response.output_text.delta", 3],
      ["response.completed", 4],
    ],
  );
  assert.deepEqual(terminal.callIds, ["call_ordered_tail"]);
  assert.equal(Object.hasOwn(terminal.events[2].response, "output"), false);
  assert.deepEqual(stream.finish().events, []);
});

test("passes a well-formed ordinary streaming function call through", () => {
  const { codec } = projectedCodec();
  const stream = createClientToolSearchSseRewriter(codec);
  const added = stream.push({
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: "item_ordinary",
      type: "function_call",
      name: "ordinary_tool",
      call_id: "call_ordinary",
      status: "in_progress",
      arguments: "",
    },
  });
  const delta = stream.push({
    type: "response.function_call_arguments.delta",
    item_id: "item_ordinary",
    output_index: 0,
    delta: "{}",
  });
  const item = {
    id: "item_ordinary",
    type: "function_call",
    name: "ordinary_tool",
    call_id: "call_ordinary",
    status: "completed",
    arguments: "{}",
  };
  const done = stream.push({
    type: "response.output_item.done",
    output_index: 0,
    item,
  });
  assert.equal(added.events.length, 0);
  assert.equal(delta.events.length, 0);
  assert.deepEqual(done.events, []);
  const terminal = stream.push({
    type: "response.completed",
    response: { id: "resp_ordinary", output: [item] },
  });
  assert.equal(terminal.events[0].type, "response.output_item.added");
  assert.equal(terminal.events[1].type, "response.function_call_arguments.delta");
  assert.deepEqual(terminal.events[2].item, item);
  assert.equal(terminal.events[3].type, "response.completed");
  assert.deepEqual(stream.finish().events, []);
});

test("holds the complete ordinary function lifecycle until the terminal commits", () => {
  const { codec } = projectedCodec();
  const stream = createClientToolSearchSseRewriter(codec);
  const added = {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: "item_ordinary_arguments",
      type: "function_call",
      name: "ordinary_tool",
      call_id: "call_ordinary_arguments",
      status: "in_progress",
      arguments: "",
    },
  };
  const delta = {
    type: "response.function_call_arguments.delta",
    item_id: "item_ordinary_arguments",
    output_index: 0,
    delta: "{}",
  };
  const argumentsDone = {
    type: "response.function_call_arguments.done",
    item_id: "item_ordinary_arguments",
    output_index: 0,
    arguments: "{}",
  };
  const itemDone = {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      ...added.item,
      status: "completed",
      arguments: "{}",
    },
  };
  assert.deepEqual(stream.push(added).events, []);
  assert.deepEqual(stream.push(delta).events, []);
  assert.deepEqual(stream.push(argumentsDone).events, []);
  assert.deepEqual(stream.push(itemDone).events, []);
  const committed = stream.push({
    type: "response.completed",
    response: { status: "completed", output: [itemDone.item] },
  });
  assert.deepEqual(
    committed.events.map((event) => event.type),
    [
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ],
  );

  for (const terminalType of ["response.failed", "response.incomplete"]) {
    const failed = createClientToolSearchSseRewriter(codec);
    assert.deepEqual(failed.push(added).events, []);
    assert.deepEqual(failed.push(delta).events, []);
    assert.deepEqual(failed.push(argumentsDone).events, []);
    assert.deepEqual(failed.push(itemDone).events, []);
    const terminal = {
      type: terminalType,
      response: { id: `resp_${terminalType}`, output: [itemDone.item] },
    };
    assert.deepEqual(failed.push(terminal).events, [{
      ...terminal,
      response: { id: `resp_${terminalType}` },
    }]);
  }
});

test("rejects malformed or drifting ordinary SSE argument lifecycle", () => {
  const { codec } = projectedCodec([], {
    limits: { maxArgumentBytes: 8 },
  });
  const added = (suffix, overrides = {}) => ({
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: `item_arguments_${suffix}`,
      type: "function_call",
      name: "ordinary_tool",
      call_id: `call_arguments_${suffix}`,
      status: "in_progress",
      arguments: "",
      ...overrides,
    },
  });
  const delta = (suffix, value) => ({
    type: "response.function_call_arguments.delta",
    item_id: `item_arguments_${suffix}`,
    output_index: 0,
    delta: value,
  });
  const done = (suffix, value) => ({
    type: "response.function_call_arguments.done",
    item_id: `item_arguments_${suffix}`,
    output_index: 0,
    arguments: value,
  });

  for (const overrides of [
    { status: "completed" },
    { arguments: {} },
    { arguments: "x".repeat(9) },
  ]) {
    const stream = createClientToolSearchSseRewriter(codec);
    assertEfficientError(
      () => stream.push(added("bad_added", overrides)),
      { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
    );
  }

  const nonStringDelta = createClientToolSearchSseRewriter(codec);
  nonStringDelta.push(added("non_string_delta"));
  assertEfficientError(
    () => nonStringDelta.push(delta("non_string_delta", {})),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const oversizedDelta = createClientToolSearchSseRewriter(codec);
  oversizedDelta.push(added("oversized_delta"));
  assertEfficientError(
    () => oversizedDelta.push(delta("oversized_delta", "x".repeat(9))),
    { code: "TOOL_SEARCH_LIMIT_EXCEEDED", statusCode: 502 },
  );

  const nonStringDone = createClientToolSearchSseRewriter(codec);
  nonStringDone.push(added("non_string_done"));
  assertEfficientError(
    () => nonStringDone.push(done("non_string_done", {})),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const driftedDone = createClientToolSearchSseRewriter(codec);
  driftedDone.push(added("drifted_done"));
  driftedDone.push(delta("drifted_done", "{}"));
  assertEfficientError(
    () => driftedDone.push(done("drifted_done", '{"x":1}')),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const duplicateDone = createClientToolSearchSseRewriter(codec);
  duplicateDone.push(added("duplicate_done"));
  duplicateDone.push(done("duplicate_done", "{}"));
  assertEfficientError(
    () => duplicateDone.push(done("duplicate_done", "{}")),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const driftedItem = createClientToolSearchSseRewriter(codec);
  const driftedItemAdded = added("drifted_item");
  driftedItem.push(driftedItemAdded);
  driftedItem.push(done("drifted_item", "{}"));
  assertEfficientError(
    () => driftedItem.push({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        ...driftedItemAdded.item,
        status: "completed",
        arguments: '{"x":1}',
      },
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  for (const authorityFields of [
    { call_id: "call_wrong" },
    { name: "wrong_tool" },
    { namespace: "injected" },
  ]) {
    const stream = createClientToolSearchSseRewriter(codec);
    stream.push(added("authority_fields"));
    assertEfficientError(
      () => stream.push({
        ...delta("authority_fields", "{}"),
        ...authorityFields,
      }),
      { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
    );
  }

  const matchedAuthority = createClientToolSearchSseRewriter(codec);
  matchedAuthority.push(added("matched_authority"));
  assert.deepEqual(matchedAuthority.push({
    ...done("matched_authority", "{}"),
    call_id: "call_arguments_matched_authority",
    name: "ordinary_tool",
    sequence_number: 2,
  }).events, []);
});

test("rejects an ordinary function call changed by the SSE terminal", () => {
  const { codec } = projectedCodec();
  const stream = createClientToolSearchSseRewriter(codec);
  const item = {
    id: "item_ordinary_changed",
    type: "function_call",
    name: "ordinary_tool",
    call_id: "call_ordinary_changed",
    status: "completed",
    arguments: '{"value":"original"}',
  };
  stream.push({
    type: "response.output_item.done",
    output_index: 0,
    item,
  });
  assertEfficientError(
    () => stream.push({
      type: "response.completed",
      response: {
        id: "resp_ordinary_changed",
        output: [{ ...item, arguments: '{"value":"changed"}' }],
      },
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );
});

test("rejects reordered terminal calls and inconsistent SSE output indices", () => {
  const { codec } = projectedCodec();
  const first = {
    type: "function_call",
    name: "first_tool",
    call_id: "call_order_first",
    status: "completed",
    arguments: "{}",
  };
  const second = {
    type: "function_call",
    name: "second_tool",
    call_id: "call_order_second",
    status: "completed",
    arguments: "{}",
  };

  const reordered = createClientToolSearchSseRewriter(codec);
  reordered.push({
    type: "response.output_item.done",
    output_index: 0,
    item: first,
  });
  reordered.push({
    type: "response.output_item.done",
    output_index: 1,
    item: second,
  });
  assertEfficientError(
    () => reordered.push({
      type: "response.completed",
      response: { output: [second, first] },
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const wrongIndex = createClientToolSearchSseRewriter(codec);
  wrongIndex.push({
    type: "response.output_item.done",
    output_index: 1,
    item: first,
  });
  assertEfficientError(
    () => wrongIndex.push({
      type: "response.completed",
      response: { output: [first] },
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const duplicateIndex = createClientToolSearchSseRewriter(codec);
  duplicateIndex.push({
    type: "response.output_item.done",
    output_index: 0,
    item: first,
  });
  assertEfficientError(
    () => duplicateIndex.push({
      type: "response.output_item.done",
      output_index: 0,
      item: second,
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );
});

test("does not let a function call reuse a non-function SSE output index", () => {
  const { codec } = projectedCodec();
  const stream = createClientToolSearchSseRewriter(codec);
  assert.equal(stream.push({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: "message_index_owner",
      type: "message",
      status: "completed",
      content: [],
    },
  }).events.length, 1);
  assertEfficientError(
    () => stream.push({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "item_index_collision",
        type: "function_call",
        name: "ordinary_tool",
        call_id: "call_index_collision",
        status: "completed",
        arguments: "{}",
      },
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const reverse = createClientToolSearchSseRewriter(codec);
  assert.deepEqual(reverse.push({
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: "item_index_owner",
      type: "function_call",
      name: "ordinary_tool",
      call_id: "call_index_owner",
      status: "in_progress",
      arguments: "",
    },
  }).events, []);
  assertEfficientError(
    () => reverse.push({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "message_index_collision",
        type: "message",
        status: "completed",
        content: [],
      },
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const deltaIndex = createClientToolSearchSseRewriter(codec);
  assert.equal(deltaIndex.push({
    type: "response.output_text.delta",
    output_index: 0,
    item_id: "message_delta_index_owner",
    delta: "text",
  }).events.length, 1);
  assertEfficientError(
    () => deltaIndex.push({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "item_delta_index_collision",
        type: "function_call",
        name: "ordinary_tool",
        call_id: "call_delta_index_collision",
        status: "completed",
        arguments: "{}",
      },
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const itemId = createClientToolSearchSseRewriter(codec);
  assert.equal(itemId.push({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: "shared_non_function_item_id",
      type: "message",
      status: "completed",
      content: [],
    },
  }).events.length, 1);
  assertEfficientError(
    () => itemId.push({
      type: "response.output_item.done",
      output_index: 1,
      item: {
        id: "shared_non_function_item_id",
        type: "function_call",
        name: "ordinary_tool",
        call_id: "call_item_id_collision",
        status: "completed",
        arguments: "{}",
      },
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );
});

test("buffers synthetic SSE events until a matching completed terminal", () => {
  const { codec } = projectedCodec();
  const stream = createClientToolSearchSseRewriter(codec);
  const added = stream.push({
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: "item_stream_2",
      type: "function_call",
      name: codec.wireName,
      call_id: "call_stream_2",
      status: "in_progress",
      arguments: "",
    },
  });
  const delta = stream.push({
    type: "response.function_call_arguments.delta",
    item_id: "item_stream_2",
    output_index: 0,
    delta: '{"query":"workspace",',
  });
  const finalDelta = stream.push({
    type: "response.function_call_arguments.delta",
    item_id: "item_stream_2",
    output_index: 0,
    delta: '"limit":3}',
  });
  const argumentsDone = stream.push({
    type: "response.function_call_arguments.done",
    item_id: "item_stream_2",
    output_index: 0,
    arguments: '{"query":"workspace","limit":3}',
  });
  for (const result of [added, delta, finalDelta, argumentsDone]) {
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.callIds, []);
  }

  const done = stream.push({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: "item_stream_2",
      type: "function_call",
      name: codec.wireName,
      call_id: "call_stream_2",
      status: "completed",
      arguments: '{"query":"workspace","limit":3}',
    },
  });
  assert.deepEqual(done.callIds, []);
  assert.deepEqual(done.events, []);
  const terminal = stream.push({
    type: "response.completed",
    response: {
      id: "resp_stream_2",
      output: [{
        id: "item_stream_2",
        type: "function_call",
        name: codec.wireName,
        call_id: "call_stream_2",
        status: "completed",
        arguments: '{"query":"workspace","limit":3}',
      }],
    },
  });
  assert.deepEqual(terminal.callIds, ["call_stream_2"]);
  assert.deepEqual(terminal.events[0].item, {
    id: "item_stream_2",
    type: "tool_search_call",
    execution: "client",
    call_id: "call_stream_2",
    status: "completed",
    arguments: { query: "workspace", limit: 3 },
  });
  assert.equal(terminal.events[1].type, "response.completed");
  assert.deepEqual(stream.finish().events, []);
});

test("accepts terminal SSE output only after matching done items", () => {
  const { codec } = projectedCodec();
  const item = {
    id: "item_terminal",
    type: "function_call",
    name: codec.wireName,
    call_id: "call_terminal",
    status: "completed",
    arguments: '{"query":"terminal"}',
  };
  const completed = {
    type: "response.completed",
    response: { id: "resp_terminal", output: [item] },
  };

  const stream = createClientToolSearchSseRewriter(codec);
  stream.push({
    type: "response.output_item.done",
    output_index: 0,
    item,
  });
  const terminal = stream.push(completed);
  assert.deepEqual(terminal.callIds, ["call_terminal"]);
  assert.equal(
    terminal.events[1].response.output[0].type,
    "tool_search_call",
  );
  assertEfficientError(
    () => stream.push({ type: "response.in_progress" }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );
  assert.deepEqual(stream.finish().events, []);

  const missingDone = createClientToolSearchSseRewriter(codec);
  assertEfficientError(
    () => missingDone.push(completed),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const changed = createClientToolSearchSseRewriter(codec);
  changed.push({
    type: "response.output_item.done",
    output_index: 0,
    item,
  });
  assertEfficientError(
    () => changed.push({
      ...completed,
      response: {
        ...completed.response,
        output: [{ ...item, arguments: '{"query":"changed"}' }],
      },
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );
});

test("accepts one SSE done marker only after a validated terminal", () => {
  const { codec } = projectedCodec();
  const premature = createClientToolSearchSseRewriter(codec);
  assertEfficientError(
    () => premature.acceptDoneMarker(),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const complete = createClientToolSearchSseRewriter(codec);
  complete.push({
    type: "response.completed",
    response: { id: "resp_done_marker", output: [] },
  });
  complete.acceptDoneMarker();
  assertEfficientError(
    () => complete.acceptDoneMarker(),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );
  assert.deepEqual(complete.finish().events, []);
});

test("fails closed on mismatched, incomplete, and duplicate synthetic SSE calls", () => {
  const { codec } = projectedCodec();
  const addedEvent = (callId = "call_stream_bad") => ({
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: "item_stream_bad",
      type: "function_call",
      name: codec.wireName,
      call_id: callId,
      status: "in_progress",
      arguments: "",
    },
  });
  const incomplete = createClientToolSearchSseRewriter(codec);
  incomplete.push(addedEvent());
  assertEfficientError(
    () => incomplete.finish(),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const missingTerminal = createClientToolSearchSseRewriter(codec);
  missingTerminal.push({
    type: "response.created",
    response: { id: "resp_missing_terminal", output: [] },
  });
  assertEfficientError(
    () => missingTerminal.finish(),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const mismatch = createClientToolSearchSseRewriter(codec);
  mismatch.push(addedEvent());
  mismatch.push({
    type: "response.function_call_arguments.delta",
    item_id: "item_stream_bad",
    output_index: 0,
    delta: "{}",
  });
  assertEfficientError(
    () => mismatch.push({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "item_stream_bad",
        type: "function_call",
        name: codec.wireName,
        call_id: "call_stream_bad",
        arguments: '{"query":"different"}',
      },
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const changedLocator = createClientToolSearchSseRewriter(codec);
  changedLocator.push(addedEvent());
  assertEfficientError(
    () => changedLocator.push({
      type: "response.function_call_arguments.delta",
      item_id: "item_stream_bad",
      output_index: 1,
      delta: '{"query":"reader"}',
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const duplicate = createClientToolSearchSseRewriter(codec);
  const done = {
    type: "response.output_item.done",
    output_index: 1,
    item: {
      id: "item_done",
      type: "function_call",
      name: codec.wireName,
      call_id: "call_duplicate",
      arguments: '{"query":"duplicate"}',
    },
  };
  duplicate.push(done);
  assertEfficientError(
    () => duplicate.push({ ...done, output_index: 2 }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );
});

test("discards uncommitted calls and forwards failed or incomplete terminals", () => {
  const { codec } = projectedCodec();
  const item = {
    id: "item_failed",
    type: "function_call",
    name: codec.wireName,
    call_id: "call_failed",
    status: "completed",
    arguments: '{"query":"failure context"}',
  };
  const failed = createClientToolSearchSseRewriter(codec);
  failed.push({
    type: "response.output_item.done",
    output_index: 0,
    item,
  });
  assert.deepEqual(failed.push({
    type: "response.output_text.delta",
    delta: "must not overtake the uncommitted call",
  }).events, []);
  const failedTerminal = failed.push({
    type: "response.failed",
    response: {
      id: "resp_failed",
      error: { code: "upstream_failed", message: "failed" },
      output: [item],
    },
  });
  assert.deepEqual(failedTerminal.callIds, []);
  assert.deepEqual(failedTerminal.events, [{
    type: "response.failed",
    response: {
      id: "resp_failed",
      error: { code: "upstream_failed", message: "failed" },
    },
  }]);
  assert.deepEqual(failed.finish().events, []);

  const incomplete = createClientToolSearchSseRewriter(codec);
  incomplete.push({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...item, status: "in_progress", arguments: "" },
  });
  const incompleteTerminal = incomplete.push({
    type: "response.incomplete",
    response: {
      id: "resp_incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [item],
    },
  });
  assert.deepEqual(incompleteTerminal.callIds, []);
  assert.deepEqual(incompleteTerminal.events, [{
    type: "response.incomplete",
    response: {
      id: "resp_incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    },
  }]);
  assert.deepEqual(incomplete.finish().events, []);
});

test("treats an SSE error event as an irreversible failure", () => {
  const { codec } = projectedCodec();
  const errorEvent = {
    type: "error",
    code: "upstream_error",
    message: "generation failed",
  };
  const held = createClientToolSearchSseRewriter(codec);
  held.push({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "function_call",
      name: codec.wireName,
      call_id: "call_before_error",
      status: "completed",
      arguments: '{"query":"failure"}',
    },
  });
  const failed = held.push(errorEvent);
  assert.deepEqual(failed.callIds, []);
  assert.deepEqual(failed.events, [errorEvent]);
  assertEfficientError(
    () => held.push({
      type: "response.completed",
      response: { status: "completed" },
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );
  assert.deepEqual(held.finish().events, []);

  for (const [label, item] of [
    ["synthetic", {
      type: "function_call",
      name: codec.wireName,
      call_id: "call_synthetic_after_error",
      status: "completed",
      arguments: '{"query":"late"}',
    }],
    ["ordinary", {
      type: "function_call",
      name: "ordinary_tool",
      call_id: "call_ordinary_after_error",
      status: "completed",
      arguments: "{}",
    }],
  ]) {
    const stream = createClientToolSearchSseRewriter(codec);
    assert.deepEqual(stream.push(errorEvent).events, [errorEvent], label);
    assertEfficientError(
      () => stream.push({
        type: "response.output_item.done",
        output_index: 0,
        item,
      }),
      { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
    );
  }
});

test("rejects non-completed function-call items in SSE done events", () => {
  const { codec } = projectedCodec();
  for (const status of ["in_progress", "failed"]) {
    const stream = createClientToolSearchSseRewriter(codec);
    assertEfficientError(
      () => stream.push({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          name: "ordinary_tool",
          call_id: `call_sse_${status}`,
          status,
          arguments: "{}",
        },
      }),
      { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
    );
  }
});

test("rejects unadvertised SSE invocation items and event families", () => {
  const { codec } = projectedCodec();
  for (const type of [
    "computer_call",
    "custom_tool_call",
    "mcp_approval_request",
    "mcp_call",
    "shell_call",
  ]) {
    for (const eventType of [
      "response.output_item.added",
      "response.output_item.done",
    ]) {
      const stream = createClientToolSearchSseRewriter(codec);
      assertEfficientError(
        () => stream.push({
          type: eventType,
          output_index: 0,
          item: { type, call_id: `call_${type}` },
        }),
        { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
      );
    }
    const terminal = createClientToolSearchSseRewriter(codec);
    assertEfficientError(
      () => terminal.push({
        type: "response.completed",
        response: {
          status: "completed",
          output: [{ type, call_id: `call_terminal_${type}` }],
        },
      }),
      { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
    );
  }

  for (const type of [
    "response.computer_call.in_progress",
    "response.custom_tool_call_input.delta",
    "response.mcp_call_arguments.delta",
    "response.shell_call_output.delta",
  ]) {
    const stream = createClientToolSearchSseRewriter(codec);
    assertEfficientError(
      () => stream.push({ type, delta: "unadvertised" }),
      { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
    );
  }
});

test("rejects SSE call-id collisions, identity changes, and orphan arguments", () => {
  const { codec } = projectedCodec();
  const searchItem = {
    id: "item_identity",
    type: "function_call",
    name: codec.wireName,
    call_id: "call_identity",
    status: "completed",
    arguments: '{"query":"identity"}',
  };

  const changedIdentity = createClientToolSearchSseRewriter(codec);
  changedIdentity.push({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...searchItem, status: "in_progress", arguments: "" },
  });
  assertEfficientError(
    () => changedIdentity.push({
      type: "response.output_item.done",
      output_index: 0,
      item: { ...searchItem, name: "ordinary_tool", arguments: "{}" },
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const duplicateId = createClientToolSearchSseRewriter(codec);
  duplicateId.push({
    type: "response.output_item.done",
    output_index: 0,
    item: searchItem,
  });
  assertEfficientError(
    () => duplicateId.push({
      type: "response.output_item.done",
      output_index: 1,
      item: {
        id: "item_ordinary_duplicate",
        type: "function_call",
        name: "ordinary_tool",
        call_id: searchItem.call_id,
        status: "completed",
        arguments: "{}",
      },
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const orphanArguments = createClientToolSearchSseRewriter(codec);
  assertEfficientError(
    () => orphanArguments.push({
      type: "response.function_call_arguments.delta",
      item_id: "item_orphan",
      output_index: 0,
      delta: "{}",
    }),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );
});

test("bounds all JSON and SSE function-call correlation state", () => {
  const { codec } = projectedCodec([], {
    limits: { maxResponseFunctionCalls: 1 },
  });
  const ordinary = (suffix) => ({
    id: `item_${suffix}`,
    type: "function_call",
    name: `ordinary_${suffix}`,
    call_id: `call_${suffix}`,
    status: "completed",
    arguments: "{}",
  });
  assertEfficientError(
    () => rewriteClientToolSearchResponse({
      output: [ordinary("one"), ordinary("two")],
    }, codec),
    { code: "TOOL_SEARCH_LIMIT_EXCEEDED", statusCode: 502 },
  );

  const stream = createClientToolSearchSseRewriter(codec);
  stream.push({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...ordinary("one"), status: "in_progress", arguments: "" },
  });
  assertEfficientError(
    () => stream.push({
      type: "response.output_item.added",
      output_index: 1,
      item: { ...ordinary("two"), status: "in_progress", arguments: "" },
    }),
    { code: "TOOL_SEARCH_LIMIT_EXCEEDED", statusCode: 502 },
  );
});

test("bounds the aggregate SSE tail held for terminal validation", () => {
  const { codec } = projectedCodec([], {
    limits: { maxJsonBytes: 1_024 },
  });
  const stream = createClientToolSearchSseRewriter(codec);
  stream.push({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "function_call",
      name: codec.wireName,
      call_id: "call_bounded_tail",
      arguments: '{"query":"bounded"}',
    },
  });
  stream.push({
    type: "response.output_text.delta",
    delta: "x".repeat(400),
  });
  assertEfficientError(
    () => stream.push({
      type: "response.output_text.delta",
      delta: "y".repeat(400),
    }),
    { code: "TOOL_SEARCH_LIMIT_EXCEEDED", statusCode: 502 },
  );
});

test("bounds total SSE frames and non-function locator state before call release", () => {
  const { codec } = projectedCodec([], {
    limits: { maxSseEvents: 4 },
  });
  const added = {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: "item_bounded_frames",
      type: "function_call",
      name: "ordinary_tool",
      call_id: "call_bounded_frames",
      status: "in_progress",
      arguments: "",
    },
  };

  const rawFrames = createClientToolSearchSseRewriter(codec);
  assert.deepEqual(rawFrames.push(added).events, []);
  for (const raw of ["", ": keepalive", ""]) {
    assert.deepEqual(rawFrames.pushRawFrame(raw).events, []);
  }
  assertEfficientError(
    () => rawFrames.pushRawFrame(": overflow"),
    { code: "TOOL_SEARCH_LIMIT_EXCEEDED", statusCode: 502 },
  );

  const locators = createClientToolSearchSseRewriter(codec);
  assert.deepEqual(locators.push(added).events, []);
  for (let index = 1; index < 4; index += 1) {
    assert.deepEqual(locators.push({
      type: "response.output_text.delta",
      output_index: index,
      item_id: `message_bounded_locator_${index}`,
      delta: "x",
    }).events, []);
  }
  assertEfficientError(
    () => locators.push({
      type: "response.output_text.delta",
      output_index: 4,
      item_id: "message_bounded_locator_4",
      delta: "x",
    }),
    { code: "TOOL_SEARCH_LIMIT_EXCEEDED", statusCode: 502 },
  );
});

test("charges empty held SSE frames for their framing overhead", () => {
  const { codec } = projectedCodec([], {
    limits: {
      maxJsonBytes: 1_024,
      maxSseEvents: 1_024,
    },
  });
  const stream = createClientToolSearchSseRewriter(codec);
  assert.deepEqual(stream.push({
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: "item_empty_frames",
      type: "function_call",
      name: "ordinary_tool",
      call_id: "call_empty_frames",
      status: "in_progress",
      arguments: "",
    },
  }).events, []);

  let overflow;
  for (let index = 0; index < 600; index += 1) {
    try {
      assert.deepEqual(stream.pushRawFrame("").events, []);
    } catch (error) {
      overflow = error;
      break;
    }
  }
  assert.ok(overflow instanceof EfficientFidelityError);
  assert.equal(overflow.code, "TOOL_SEARCH_LIMIT_EXCEEDED");
  assert.equal(overflow.statusCode, 502);
});

test("rejects malformed, incomplete, native, and unknown synthetic upstream calls", () => {
  const { codec } = projectedCodec();
  const response = (item) => ({ output: [item] });
  for (const item of [
    {
      type: "function_call",
      name: codec.wireName,
      call_id: "call_1",
      arguments: "not-json",
    },
    {
      type: "function_call",
      name: codec.wireName,
      call_id: "call_1",
      arguments: "[]",
    },
    {
      type: "function_call",
      name: codec.wireName,
      call_id: "call_1",
      arguments: "{}",
      status: "in_progress",
    },
    {
      type: "function_call",
      name: codec.wireName,
      call_id: "",
      arguments: "{}",
    },
  ]) {
    assertEfficientError(
      () => rewriteClientToolSearchResponse(response(item), codec),
      { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
    );
  }
  assertEfficientError(
    () => rewriteClientToolSearchResponse({
      output: [{
        type: "tool_search_call",
        execution: "server",
        call_id: null,
      }],
    }, codec),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );
  const duplicateCall = {
    type: "function_call",
    name: codec.wireName,
    call_id: "call_repeated",
    arguments: '{"query":"duplicate"}',
  };
  assertEfficientError(
    () => rewriteClientToolSearchResponse({
      output: [duplicateCall, { ...duplicateCall, id: "item_second" }],
    }, codec),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );
  assertEfficientError(
    () => rewriteClientToolSearchResponse({
      output: [
        duplicateCall,
        {
          type: "function_call",
          name: "ordinary_tool",
          call_id: duplicateCall.call_id,
          arguments: "{}",
        },
      ],
    }, codec),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );
  assertEfficientError(
    () => rewriteClientToolSearchResponse({
      output: [{
        type: "function_call",
        name: `${EFFICIENT_FIDELITY_WIRE_PREFIX}${"f".repeat(56)}`,
        call_id: "call_unknown",
        arguments: '{"query":"unknown"}',
      }],
    }, codec),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );
});

test("round-trips full client search history into function call/output history", () => {
  const { codec } = projectedCodec();
  const tool = loadedFunction();
  const source = [
    { type: "message", role: "user", content: "Find a reader." },
    {
      id: "item_search",
      type: "tool_search_call",
      execution: "client",
      call_id: "call_search_2",
      arguments: { query: "workspace reader" },
    },
    {
      type: "tool_search_output",
      execution: "client",
      call_id: "call_search_2",
      status: "completed",
      tools: [tool],
    },
  ];
  const rewritten = rewriteClientToolSearchInput(source, codec);

  assert.strictEqual(rewritten.input[0], source[0]);
  assert.deepEqual(rewritten.input[1], {
    id: "item_search",
    type: "function_call",
    name: codec.wireName,
    call_id: "call_search_2",
    arguments: '{"query":"workspace reader"}',
    status: "completed",
  });
  assert.deepEqual(rewritten.input[2], {
    type: "function_call_output",
    call_id: "call_search_2",
    output: EFFICIENT_FIDELITY_SEARCH_RESULT_OUTPUT,
  });
  const activatedTool = { ...tool };
  delete activatedTool.defer_loading;
  assert.deepEqual(rewritten.loadedTools, [activatedTool]);
  assert.equal(source[1].type, "tool_search_call");
  assert.equal(source[2].type, "tool_search_output");
});

test("rejects output-only continuations without cross-request authorization state", () => {
  const { codec } = projectedCodec();
  const output = {
    type: "tool_search_output",
    execution: "client",
    call_id: "call_parent",
    status: "completed",
    tools: [loadedFunction()],
  };
  assertEfficientError(
    () => rewriteClientToolSearchInput([output], codec),
    { code: "UNKNOWN_TOOL_SEARCH_CALL", statusCode: 400 },
  );
});

test("rejects hosted, dangling, repeated, unknown, and private input forms", () => {
  const { codec } = projectedCodec();
  const call = {
    type: "tool_search_call",
    execution: "client",
    call_id: "call_3",
    status: "completed",
    arguments: { query: "tool" },
  };
  const output = {
    type: "tool_search_output",
    execution: "client",
    call_id: "call_3",
    status: "completed",
    tools: [],
  };
  for (const type of [
    "custom_tool_call",
    "custom_tool_call_output",
    "mcp_approval_request",
    "mcp_call",
    "mcp_list_tools",
    "web_search_call",
  ]) {
    assertEfficientError(
      () => rewriteClientToolSearchInput([{
        type,
        call_id: `call_history_${type}`,
      }], codec),
      { code: "UNSUPPORTED_TOOL_TYPE", statusCode: 400 },
    );
  }
  assertEfficientError(
    () => rewriteClientToolSearchInput([{ ...call, execution: "server" }], codec),
    { code: "UNSUPPORTED_TOOL_SEARCH_EXECUTION", statusCode: 400 },
  );
  assertEfficientError(
    () => rewriteClientToolSearchInput([
      call,
      { ...output, execution: "server" },
    ], codec),
    { code: "UNSUPPORTED_TOOL_SEARCH_EXECUTION", statusCode: 400 },
  );
  assertEfficientError(
    () => rewriteClientToolSearchInput([call], codec),
    { code: "MISSING_TOOL_SEARCH_OUTPUT", statusCode: 400 },
  );
  assertEfficientError(
    () => rewriteClientToolSearchInput([call, output, output], codec),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );
  assertEfficientError(
    () => rewriteClientToolSearchInput([call, call, output], codec),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );
  assertEfficientError(
    () => rewriteClientToolSearchInput([{
      type: "function_call",
      name: "ordinary",
      call_id: "call_3",
      arguments: "{}",
    }, call, output], codec),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );
  assertEfficientError(
    () => rewriteClientToolSearchInput([{ ...output, call_id: "call_unknown" }], codec),
    { code: "UNKNOWN_TOOL_SEARCH_CALL", statusCode: 400 },
  );
  assertEfficientError(
    () => rewriteClientToolSearchInput([{ type: "tool_search_future" }], codec),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );
  assertEfficientError(
    () => rewriteClientToolSearchInput([{
      type: "additional_tools",
      tools: [loadedFunction("secondary_inventory")],
    }], codec),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );
  assertEfficientError(
    () => rewriteClientToolSearchInput([{
      type: "function_call",
      name: `${EFFICIENT_FIDELITY_WIRE_PREFIX}${"0".repeat(56)}`,
      call_id: "call_private",
      arguments: "{}",
    }], codec),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );
});

test("keeps loaded namespaces inside the synthetic function result", () => {
  const projection = projectedCodec();
  const namespace = {
    type: "namespace",
    name: "workspace",
    description: "Workspace inspection tools.",
    tools: [loadedFunction("read")],
  };
  const rewritten = rewriteClientToolSearchInput([{
    type: "tool_search_call",
    execution: "client",
    call_id: "call_namespace",
    arguments: { query: "read a file", limit: 1 },
  }, {
    type: "tool_search_output",
    execution: "client",
    call_id: "call_namespace",
    status: "completed",
    tools: [namespace],
  }], projection.codec);

  assert.equal(projection.tools.length, 1);
  assert.equal(projection.tools[0].name, projection.codec.wireName);
  assert.equal(
    rewritten.input[1].output,
    EFFICIENT_FIDELITY_SEARCH_RESULT_OUTPUT,
  );
  const activatedNamespace = structuredClone(namespace);
  delete activatedNamespace.tools[0].defer_loading;
  assert.deepEqual(rewritten.loadedTools, [activatedNamespace]);
});

test("rejects loaded tools LM Studio cannot safely expose", () => {
  const { codec } = projectedCodec();
  const output = (tools) => [{
    type: "tool_search_output",
    execution: "client",
    call_id: "call_loaded",
    status: "completed",
    tools,
  }];
  for (const tools of [
    [{ type: "web_search" }],
    [{ type: "mcp", server_label: "remote" }],
    [{ type: "namespace", name: "bad", tools: [{ type: "web_search" }] }],
    [{ ...loadedFunction(), unknown: true }],
  ]) {
    assert.throws(
      () => rewriteClientToolSearchInput([{
        type: "tool_search_call",
        execution: "client",
        call_id: "call_loaded",
        arguments: { query: "loaded tool" },
      }, ...output(tools)], codec),
      EfficientFidelityError,
    );
  }
  const searchPair = (callId, tool) => [{
    type: "tool_search_call",
    execution: "client",
    call_id: callId,
    arguments: { query: "reader" },
  }, {
    type: "tool_search_output",
    execution: "client",
    call_id: callId,
    status: "completed",
    tools: [tool],
  }];
  const same = loadedFunction("same");
  const repeated = rewriteClientToolSearchInput([
    ...searchPair("call_duplicate_tools_1", same),
    ...searchPair("call_duplicate_tools_2", structuredClone(same)),
  ], codec);
  const activatedSame = { ...same };
  delete activatedSame.defer_loading;
  assert.deepEqual(repeated.loadedTools, [activatedSame]);

  assertEfficientError(
    () => rewriteClientToolSearchInput([
      ...searchPair("call_changed_tools_1", same),
      ...searchPair("call_changed_tools_2", {
        ...same,
        description: "Changed schema for the same identity.",
      }),
    ], codec),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );
});

test("rejects aggregate loaded-tool overflow and immediate name conflicts", () => {
  const compactTool = (name) => ({
    type: "function",
    name,
    parameters: {},
  });
  const bounded = projectedCodec([], {
    limits: { maxLoadedToolsBytes: 99 },
  });
  const searchPair = (callId, tool) => [{
    type: "tool_search_call",
    execution: "client",
    call_id: callId,
    arguments: { query: tool.name },
  }, {
    type: "tool_search_output",
    execution: "client",
    call_id: callId,
    status: "completed",
    tools: [tool],
  }];
  assertEfficientError(
    () => rewriteClientToolSearchInput([
      ...searchPair("call_aggregate_1", compactTool("one")),
      ...searchPair("call_aggregate_2", compactTool("two")),
    ], bounded.codec),
    { code: "TOOL_SEARCH_LIMIT_EXCEEDED", statusCode: 400 },
  );

  const immediate = compactTool("already_loaded");
  const projection = projectedCodec([immediate]);
  assertEfficientError(
    () => rewriteClientToolSearchInput(
      searchPair("call_conflict", compactTool("already_loaded")),
      projection.codec,
    ),
    { code: "INVALID_TOOL_SEARCH", statusCode: 400 },
  );
});

test("enforces argument, loaded-tool, input, and response structure bounds", () => {
  const smallArguments = projectedCodec([], {
    limits: { maxArgumentBytes: 16 },
  });
  assertEfficientError(
    () => rewriteClientToolSearchResponse({
      output: [{
        type: "function_call",
        name: smallArguments.codec.wireName,
        call_id: "call_large",
        arguments: JSON.stringify({ query: "x".repeat(32) }),
      }],
    }, smallArguments.codec),
    { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 },
  );

  const oneTool = projectedCodec([], {
    limits: { maxLoadedTools: 1 },
  });
  assertEfficientError(
    () => rewriteClientToolSearchInput([{
      type: "tool_search_call",
      execution: "client",
      call_id: "call_many",
      arguments: { query: "many tools" },
    }, {
      type: "tool_search_output",
      execution: "client",
      call_id: "call_many",
      status: "completed",
      tools: [loadedFunction("one"), loadedFunction("two")],
    }], oneTool.codec),
    { code: "TOOL_SEARCH_LIMIT_EXCEEDED", statusCode: 400 },
  );

  const oneItem = projectedCodec([], {
    limits: { maxInputItems: 1 },
  });
  assertEfficientError(
    () => rewriteClientToolSearchInput([{}, {}], oneItem.codec),
    { code: "TOOL_SEARCH_LIMIT_EXCEEDED", statusCode: 400 },
  );

  const shallow = projectedCodec([], {
    limits: { maxJsonDepth: 8 },
  });
  assertEfficientError(
    () => rewriteClientToolSearchResponse(
      { output: [], metadata: [[[[[[[[[true]]]]]]]]] },
      shallow.codec,
    ),
    { code: "TOOL_SEARCH_LIMIT_EXCEEDED", statusCode: 502 },
  );
});

test("requires an authentic request-local codec", () => {
  assert.throws(
    () => rewriteClientToolSearchResponse({}, { wireName: "fake" }),
    /efficient fidelity codec/u,
  );
  assert.throws(
    () => rewriteClientToolSearchInput([], null),
    /efficient fidelity codec/u,
  );
});
