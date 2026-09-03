import assert from "node:assert/strict";
import test from "node:test";

import {
  ResponseTransformError,
  createSseResponseTransformer,
  shouldTransformResponse,
  transformJsonResponse,
} from "../src/responses-transform.mjs";
import { projectClientToolSearch } from "../src/efficient-fidelity.mjs";
import { normalizeLmStudioToolRequest } from "../src/tool-normalization.mjs";

function namespaceCodec() {
  const source = {
    tools: [
      {
        type: "namespace",
        name: "calendar",
        tools: [{ type: "function", name: "lookup", parameters: {} }],
      },
    ],
  };
  return normalizeLmStudioToolRequest({ ...source }, source);
}

test("rewrites JSON function calls recursively", () => {
  const codec = namespaceCodec();
  const wireName = codec.forward.get("calendar\0lookup").wireName;
  const source = Buffer.from(
    JSON.stringify({
      id: "resp_1",
      output: [{
        type: "function_call",
        id: "item_1",
        name: wireName,
        call_id: "call_1",
        arguments: "{}",
        status: "completed",
      }],
    }),
  );
  const transformed = JSON.parse(transformJsonResponse(source, codec));
  assert.deepEqual(transformed.output[0], {
    type: "function_call",
    id: "item_1",
    namespace: "calendar",
    name: "lookup",
    call_id: "call_1",
    arguments: "{}",
    status: "completed",
  });
  assert.equal(
    shouldTransformResponse("application/json; charset=utf-8", codec),
    "json",
  );
});

test("rewrites fragmented CRLF SSE added, done and completed events", () => {
  const codec = namespaceCodec();
  const wireName = codec.forward.get("calendar\0lookup").wireName;
  const items = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "item_namespace",
        name: wireName,
        call_id: "call_namespace",
        arguments: "",
        status: "in_progress",
      },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "item_namespace",
        name: wireName,
        call_id: "call_namespace",
        arguments: "{}",
        status: "completed",
      },
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [{
          type: "function_call",
          id: "item_namespace",
          name: wireName,
          call_id: "call_namespace",
          arguments: "{}",
          status: "completed",
        }],
      },
    },
  ];
  const wire =
    items
      .map(
        (item) =>
          `event: ${item.type}\r\ndata: ${JSON.stringify(item)}\r\n\r\n`,
      )
      .join("") + "data: [DONE]\r\n\r\n";
  const transformer = createSseResponseTransformer(codec);
  const bytes = Buffer.from(wire);
  const chunks = [];
  for (let index = 0; index < bytes.length; index += 7) {
    chunks.push(...transformer.push(bytes.subarray(index, index + 7)));
  }
  chunks.push(...transformer.finish());
  const output = Buffer.concat(chunks).toString("utf8");
  const data = output
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  assert.equal(data.length, 3);
  for (const item of data) {
    const call = item.item ?? item.response.output[0];
    assert.equal(call.name, "lookup");
    assert.equal(call.namespace, "calendar");
  }
  assert.match(output, /data: \[DONE\]/u);
  assert.equal(shouldTransformResponse("text/event-stream", codec), "sse");
});

test("holds and correlates Direct/Namespace function completion lifecycle", () => {
  const codec = namespaceCodec();
  const wireName = codec.forward.get("calendar\0lookup").wireName;
  const transformer = createSseResponseTransformer(codec);
  const frame = (value) => Buffer.from(
    `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`,
  );
  const added = {
    type: "response.output_item.added",
    output_index: 0,
    item_id: "item_general",
    item: {
      type: "function_call",
      id: "item_general",
      name: wireName,
      call_id: "call_general",
      arguments: "",
      status: "in_progress",
    },
  };
  const doneItem = {
    type: "function_call",
    id: "item_general",
    name: wireName,
    call_id: "call_general",
    arguments: "{}",
    status: "completed",
  };

  assert.equal(transformer.push(frame(added)).length, 0);
  assert.equal(transformer.push(frame({
    type: "response.function_call_arguments.delta",
    output_index: 0,
    item_id: "item_general",
    delta: "{}",
  })).length, 0);
  assert.deepEqual(transformer.push(frame({
    type: "response.function_call_arguments.done",
    output_index: 0,
    item_id: "item_general",
    call_id: "call_general",
    name: wireName,
    arguments: "{}",
  })), []);
  assert.deepEqual(transformer.push(frame({
    type: "response.output_item.done",
    output_index: 0,
    item_id: "item_general",
    item: doneItem,
  })), []);
  const committed = transformer.push(frame({
    type: "response.completed",
    response: {
      status: "completed",
      output: [doneItem],
    },
  })).map((chunk) => chunk.toString());
  assert.equal(committed.length, 5);
  assert.match(committed[0], /response\.output_item\.added/u);
  assert.match(committed[1], /response\.function_call_arguments\.delta/u);
  assert.match(committed[2], /response\.function_call_arguments\.done/u);
  assert.match(committed[3], /response\.output_item\.done/u);
  assert.match(committed[4], /response\.completed/u);
});

test("frames every held lifecycle event released by an EOF terminal", () => {
  const codec = namespaceCodec();
  const wireName = codec.forward.get("calendar\0lookup").wireName;
  const transformer = createSseResponseTransformer(codec);
  const framed = (value) => Buffer.from(`data: ${JSON.stringify(value)}\n\n`);
  const item = {
    type: "function_call",
    id: "item_eof_terminal",
    name: wireName,
    call_id: "call_eof_terminal",
    arguments: "{}",
    status: "completed",
  };
  for (const event of [
    {
      type: "response.output_item.added",
      output_index: 0,
      item_id: item.id,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: "{}",
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: item.id,
      arguments: "{}",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item_id: item.id,
      item,
    },
  ]) {
    assert.deepEqual(transformer.push(framed(event)), []);
  }
  assert.deepEqual(transformer.push(Buffer.from(`data: ${JSON.stringify({
    type: "response.completed",
    response: { status: "completed", output: [item] },
  })}`)), []);

  const output = transformer.finish().map((chunk) => chunk.toString("utf8"));
  assert.equal(output.length, 5);
  assert.ok(output.every((frame) => frame.endsWith("\n\n")));
  assert.deepEqual(
    output.map((frame) => JSON.parse(frame.slice(6).trim()).type),
    [
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ],
  );
});

test("rejects contradictory Direct/Namespace lifecycle before completion leaks", () => {
  const codec = namespaceCodec();
  const wireName = codec.forward.get("calendar\0lookup").wireName;
  const frame = (value) => Buffer.from(`data: ${JSON.stringify(value)}\n\n`);
  const transformer = createSseResponseTransformer(codec);
  transformer.push(frame({
    type: "response.output_item.added",
    output_index: 0,
    item_id: "item_drift",
    item: {
      type: "function_call",
      id: "item_drift",
      name: wireName,
      call_id: "call_drift",
      arguments: "",
      status: "in_progress",
    },
  }));
  assert.deepEqual(transformer.push(frame({
    type: "response.function_call_arguments.done",
    output_index: 0,
    item_id: "item_drift",
    arguments: '{"unsafe":true}',
  })), []);
  assert.throws(
    () => transformer.push(frame({
      type: "response.output_item.done",
      output_index: 0,
      item_id: "item_drift",
      item: {
        type: "function_call",
        id: "item_drift",
        name: wireName,
        call_id: "call_drift",
        arguments: "{}",
        status: "completed",
      },
    })),
    /could not be normalized/u,
  );

  const orphan = createSseResponseTransformer(codec);
  assert.throws(
    () => orphan.push(frame({
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: "item_orphan",
      arguments: "{}",
    })),
    /could not be normalized/u,
  );

  const duplicate = createSseResponseTransformer(codec);
  duplicate.push(frame({
    type: "response.output_item.added",
    output_index: 0,
    item_id: "item_duplicate",
    item: {
      type: "function_call",
      id: "item_duplicate",
      name: wireName,
      call_id: "call_duplicate",
      arguments: "",
      status: "in_progress",
    },
  }));
  assert.throws(
    () => duplicate.push(frame({
      type: "response.output_item.added",
      output_index: 0,
      item_id: "item_duplicate",
      item: {
        type: "function_call",
        id: "item_duplicate",
        name: wireName,
        call_id: "call_duplicate",
        arguments: "",
        status: "in_progress",
      },
    })),
    /could not be normalized/u,
  );

  const failed = createSseResponseTransformer(codec);
  assert.deepEqual(failed.push(frame({
    type: "response.output_item.added",
    output_index: 0,
    item_id: "item_failed_general",
    item: {
      type: "function_call",
      id: "item_failed_general",
      name: wireName,
      call_id: "call_failed_general",
      arguments: "",
      status: "in_progress",
    },
  })), []);
  assert.deepEqual(failed.push(frame({
    type: "response.function_call_arguments.delta",
    output_index: 0,
    item_id: "item_failed_general",
    delta: "{}",
  })), []);
  const failureOutput = failed.push(frame({
    type: "response.failed",
    response: {
      status: "failed",
      output: [{
        type: "function_call",
        id: "item_failed_general",
        name: wireName,
        call_id: "call_failed_general",
        arguments: "{}",
      }],
    },
  })).map((chunk) => chunk.toString()).join("");
  assert.doesNotMatch(failureOutput, /function_call/u);
  assert.match(failureOutput, /response\.failed/u);
});

test("passes responses through when no reverse mapping exists", () => {
  const codec = { reverse: new Map() };
  assert.equal(shouldTransformResponse("application/json", codec), null);
});

test("enforces a present empty advertised-function allowlist", () => {
  const codec = {
    allowedWireNames: new Set(),
    reverse: new Map(),
  };

  assert.equal(shouldTransformResponse("application/json", codec), "json");
  assert.throws(
    () => transformJsonResponse(Buffer.from(JSON.stringify({
      output: [{
        type: "function_call",
        name: "invented",
        call_id: "call_invented",
        arguments: "{}",
      }],
    })), codec),
    (error) =>
      error instanceof ResponseTransformError &&
      /was not advertised/u.test(error.cause?.message),
  );
});

test("binds Direct/Namespace JSON calls to strict request-local authority", () => {
  const source = {
    tools: [{ type: "function", name: "known", parameters: {} }],
    parallel_tool_calls: false,
    input: [{
      type: "function_call",
      id: "item_historical",
      name: "known",
      call_id: "call_historical",
      arguments: "{}",
    }, {
      type: "function_call_output",
      call_id: "call_historical",
      output: "done",
    }],
  };
  const rewritten = {
    ...source,
    input: source.input.map((item) => ({ ...item })),
  };
  const codec = normalizeLmStudioToolRequest(rewritten, source);
  const call = (suffix, overrides = {}) => ({
    type: "function_call",
    id: `item_${suffix}`,
    name: "known",
    call_id: `call_${suffix}`,
    arguments: "{}",
    status: "completed",
    ...overrides,
  });

  for (const output of [
    [call("one"), call("two")],
    [call("duplicate_a"), call("duplicate_b", { call_id: "call_duplicate_a" })],
    [call("bad_args", { arguments: {} })],
    [call("invalid_json", { arguments: "not-json" })],
    [call("bad_status", { status: "in_progress" })],
    [call("unknown_field", { unexpected: true })],
    [call("reserved_call", { call_id: "call_historical" })],
    [call("reserved_item", { id: "item_historical" })],
    [{ type: "mcp_approval_request", id: "approval_unadvertised" }],
  ]) {
    assert.throws(
      () => transformJsonResponse(
        Buffer.from(JSON.stringify({ status: "completed", output })),
        codec,
      ),
      /could not be normalized/u,
    );
  }
});

test("rejects function-call objects outside canonical response paths", () => {
  const codec = namespaceCodec();
  const wireName = codec.forward.get("calendar\0lookup").wireName;
  const hiddenCall = {
    type: "function_call",
    id: "item_hidden",
    name: wireName,
    call_id: "call_hidden",
    arguments: "{}",
    status: "completed",
  };
  assert.throws(
    () => transformJsonResponse(Buffer.from(JSON.stringify({
      status: "completed",
      output: [],
      metadata: { hiddenCall },
    })), codec),
    (error) =>
      error instanceof ResponseTransformError &&
      /outside a canonical response output path/u.test(error.cause?.message),
  );

  const transformer = createSseResponseTransformer(codec);
  for (const event of [
    {
      type: "response.created",
      response: { output: [hiddenCall] },
    },
    {
      type: "response.completed",
      output: [hiddenCall],
      response: { status: "completed", output: [] },
    },
    {
      type: "error",
      output: [hiddenCall],
      error: { message: "failed" },
    },
  ]) {
    assert.throws(
      () => transformer.push(Buffer.from(
        `data: ${JSON.stringify(event)}\n\n`,
      )),
      (error) =>
        error instanceof ResponseTransformError &&
        /outside a canonical response output path/u.test(error.cause?.message),
    );
  }
});

test("classifies only exact, singular transformable response media types", () => {
  const codec = namespaceCodec();
  assert.equal(
    shouldTransformResponse("application/problem+json; charset=utf-8", codec),
    "json",
  );
  assert.equal(
    shouldTransformResponse('application/json; profile="safe,local"', codec),
    "json",
  );
  for (const contentType of [
    "application/jsonp",
    "application/+json",
    "text/problem+json",
    "text/plain;note=text/event-stream",
    "application/json, text/event-stream",
    "application/json; charset=utf-8, text/event-stream",
    "application/json; malformed",
    ["application/json"],
    undefined,
  ]) {
    assert.throws(
      () => shouldTransformResponse(contentType, codec),
      /unsupported content type/u,
    );
  }
});

test("does not forward an Efficient Fidelity done marker before a terminal", () => {
  const projection = projectClientToolSearch([{
    type: "tool_search",
    execution: "client",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  }], { toolChoice: "auto" });
  const transformer = createSseResponseTransformer({
    efficientFidelityCodec: projection.codec,
    namespaceCodec: { reverse: new Map() },
  });

  assert.throws(
    () => transformer.push(Buffer.from("data: [DONE]\n\n")),
    /stream ended inconsistently/u,
  );
});

test("preserves per-event SSE framing while committing the complete held tail", () => {
  const projection = projectClientToolSearch([{
    type: "tool_search",
    execution: "client",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  }], { toolChoice: "auto" });
  const transformer = createSseResponseTransformer({
    efficientFidelityCodec: projection.codec,
    namespaceCodec: { reverse: new Map() },
  });
  const item = {
    type: "function_call",
    name: projection.codec.wireName,
    call_id: "call_framed_tail",
    arguments: '{"query":"framing"}',
  };
  const event = (id, value, extra = "") => Buffer.from(
    `id: ${id}\n${extra}event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`,
  );

  assert.deepEqual(transformer.push(event("done-id", {
    type: "response.output_item.done",
    sequence_number: 2,
    output_index: 0,
    item,
  }, "retry: 1234\n")), []);
  assert.deepEqual(transformer.push(Buffer.from(": held-heartbeat\n\n")), []);
  assert.deepEqual(transformer.push(event("text-id", {
    type: "response.output_text.delta",
    sequence_number: 3,
    delta: "later",
  })), []);

  const output = transformer.push(event("terminal-id", {
    type: "response.completed",
    sequence_number: 4,
    response: { id: "resp_framed_tail" },
  })).map((chunk) => chunk.toString("utf8"));
  assert.equal(output.length, 4);
  assert.match(output[0], /^id: done-id\nretry: 1234\nevent: response\.output_item\.done\n/u);
  assert.equal(output[1], ": held-heartbeat\n\n");
  assert.match(output[2], /^id: text-id\nevent: response\.output_text\.delta\n/u);
  assert.match(output[3], /^id: terminal-id\nevent: response\.completed\n/u);
  assert.deepEqual(transformer.finish(), []);
});

test("rejects ambiguous or mismatched SSE event metadata before forwarding", () => {
  const projection = projectClientToolSearch([{
    type: "tool_search",
    execution: "client",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  }], { toolChoice: "auto" });
  const transformer = createSseResponseTransformer({
    efficientFidelityCodec: projection.codec,
    namespaceCodec: {
      allowedWireNames: new Set(["allowed"]),
      reverse: new Map(),
    },
  });
  const disguisedCall = {
    type: "response.output_text.delta",
    delta: "safe-looking",
    item: {
      type: "function_call",
      name: "allowed",
      call_id: "call_disguised",
      arguments: "{}",
    },
  };

  assert.throws(
    () => transformer.push(Buffer.from(
      `event: response.output_text.delta\nevent: response.output_item.done\ndata: ${JSON.stringify(disguisedCall)}\n\n`,
    )),
    /duplicate event fields/u,
  );
  assert.throws(
    () => createSseResponseTransformer({
      efficientFidelityCodec: projection.codec,
      namespaceCodec: { reverse: new Map() },
    }).push(Buffer.from(
      `event: response.output_item.done\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: "mismatch",
      })}\n\n`,
    )),
    /does not match/u,
  );
  assert.throws(
    () => createSseResponseTransformer({
      efficientFidelityCodec: projection.codec,
      namespaceCodec: { reverse: new Map() },
    }).push(Buffer.from("event: response.output_item.done\n\n")),
    /has no data payload/u,
  );

  const keepalive = createSseResponseTransformer({
    efficientFidelityCodec: projection.codec,
    namespaceCodec: { reverse: new Map() },
  });
  assert.deepEqual(
    keepalive.push(Buffer.from(": keepalive\n\n")).map((chunk) => chunk.toString()),
    [": keepalive\n\n"],
  );
});

test("rejects malformed UTF-8 before transformed JSON or SSE is forwarded", () => {
  const codec = namespaceCodec();
  const malformedJson = Buffer.concat([
    Buffer.from('{"output":[],"text":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]);
  assert.throws(
    () => transformJsonResponse(malformedJson, codec),
    /JSON response is not valid UTF-8/u,
  );

  const transformer = createSseResponseTransformer(codec);
  assert.deepEqual(
    transformer.push(Buffer.from('data: {"type":"response.output_text.delta","delta":"')),
    [],
  );
  assert.throws(
    () => transformer.push(Buffer.from([0xff])),
    /SSE is not valid UTF-8/u,
  );

  const truncated = createSseResponseTransformer(codec);
  assert.deepEqual(truncated.push(Buffer.from([0xe2, 0x82])), []);
  assert.throws(() => truncated.finish(), /SSE is not valid UTF-8/u);
});
