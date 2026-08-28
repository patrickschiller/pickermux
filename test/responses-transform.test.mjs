import assert from "node:assert/strict";
import test from "node:test";

import {
  createSseResponseTransformer,
  shouldTransformResponse,
  transformJsonResponse,
} from "../src/responses-transform.mjs";
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
      output: [{ type: "function_call", name: wireName, arguments: "{}" }],
    }),
  );
  const transformed = JSON.parse(transformJsonResponse(source, codec));
  assert.deepEqual(transformed.output[0], {
    type: "function_call",
    namespace: "calendar",
    name: "lookup",
    arguments: "{}",
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
      item: { type: "function_call", name: wireName },
    },
    {
      type: "response.output_item.done",
      item: { type: "function_call", name: wireName },
    },
    {
      type: "response.completed",
      response: {
        output: [{ type: "function_call", name: wireName }],
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

test("passes responses through when no reverse mapping exists", () => {
  const codec = { reverse: new Map() };
  assert.equal(shouldTransformResponse("application/json", codec), null);
});
