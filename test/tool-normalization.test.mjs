import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_NAMESPACE_WIRE_PREFIX,
  normalizeLmStudioToolRequest,
  rewriteResponseFunctionCalls,
} from "../src/tool-normalization.mjs";

function functionTool(name, parameters) {
  return {
    type: "function",
    name,
    description: name,
    ...(parameters === undefined ? {} : { parameters }),
  };
}

test("normalizes parameterless functions and a named choice to LM Studio's wire shape", () => {
  const source = {
    tools: [functionTool("alpha"), functionTool("beta", { type: "object" })],
    tool_choice: { type: "function", name: "beta" },
    parallel_tool_calls: true,
  };
  const rewritten = { ...source };
  const codec = normalizeLmStudioToolRequest(rewritten, source);

  assert.equal(codec.reverse.size, 0);
  assert.deepEqual(rewritten.tools, [
    functionTool("beta", { type: "object", properties: {} }),
  ]);
  assert.equal(rewritten.tool_choice, "required");
  assert.equal(rewritten.parallel_tool_calls, false);
});

test("maps arbitrary namespaces bijectively and rewrites function history", () => {
  const source = {
    tools: [
      {
        type: "namespace",
        name: "workspace",
        tools: [functionTool("read", {})],
      },
      {
        type: "namespace",
        name: "calendar",
        tools: [
          functionTool("read", {
            type: "object",
            properties: { day: { type: "string" } },
          }),
        ],
      },
    ],
    input: [
      {
        type: "function_call",
        namespace: "workspace",
        name: "read",
        call_id: "call_1",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ],
    tool_choice: {
      type: "namespace",
      name: "calendar",
      function: { name: "read" },
    },
  };
  const rewritten = {
    ...source,
    input: source.input.map((item) => ({ ...item })),
  };
  const codec = normalizeLmStudioToolRequest(rewritten, source);
  const workspace = codec.forward.get("workspace\0read");
  const calendar = codec.forward.get("calendar\0read");

  assert.match(
    workspace.wireName,
    new RegExp(`^${TOOL_NAMESPACE_WIRE_PREFIX}[0-9a-f]{56}$`, "u"),
  );
  assert.notEqual(workspace.wireName, calendar.wireName);
  assert.deepEqual(rewritten.tools.map((tool) => tool.name), [calendar.wireName]);
  assert.equal(rewritten.input[0].name, workspace.wireName);
  assert.equal(Object.hasOwn(rewritten.input[0], "namespace"), false);
  assert.deepEqual(rewritten.input[1], source.input[1]);

  const response = {
    type: "response.completed",
    response: {
      output: [
        {
          type: "function_call",
          name: calendar.wireName,
          call_id: "call_2",
          arguments: "{}",
        },
      ],
    },
  };
  rewriteResponseFunctionCalls(response, codec);
  assert.deepEqual(response.response.output[0], {
    type: "function_call",
    namespace: "calendar",
    name: "read",
    call_id: "call_2",
    arguments: "{}",
  });
});

test("default namespace is promoted without inventing a response namespace", () => {
  const source = {
    tools: [
      { type: "namespace", name: "functions", tools: [functionTool("echo")] },
    ],
    input: [
      {
        type: "function_call",
        namespace: "functions",
        name: "echo",
        arguments: "{}",
      },
    ],
  };
  const rewritten = {
    ...source,
    input: source.input.map((item) => ({ ...item })),
  };
  const codec = normalizeLmStudioToolRequest(rewritten, source);
  assert.equal(codec.reverse.size, 0);
  assert.equal(rewritten.tools[0].name, "echo");
  assert.equal(Object.hasOwn(rewritten.input[0], "namespace"), false);
});

test("drops optional unsupported built-ins but rejects explicit unsupported choices", () => {
  const optional = {
    tools: [
      { type: "web_search" },
      { type: "tool_search" },
      { type: "custom", name: "freeform" },
    ],
  };
  const rewritten = { ...optional };
  const codec = normalizeLmStudioToolRequest(rewritten, optional);
  assert.equal(Object.hasOwn(rewritten, "tools"), false);
  assert.deepEqual(codec.droppedTypes, ["custom", "tool_search", "web_search"]);

  const selected = {
    tools: [{ type: "web_search" }],
    tool_choice: { type: "web_search" },
  };
  assert.throws(
    () => normalizeLmStudioToolRequest({ ...selected }, selected),
    (error) => error.code === "UNSUPPORTED_TOOL_TYPE" && error.statusCode === 400,
  );
});

test("rejects wire collisions and unknown namespace history", () => {
  const duplicate = {
    tools: [
      functionTool("same"),
      {
        type: "namespace",
        name: "functions",
        tools: [functionTool("same")],
      },
    ],
  };
  assert.throws(
    () => normalizeLmStudioToolRequest({ ...duplicate }, duplicate),
    /Duplicate wire function/u,
  );

  const history = {
    tools: [
      { type: "namespace", name: "known", tools: [functionTool("one")] },
    ],
    input: [{ type: "function_call", namespace: "missing", name: "one" }],
  };
  assert.throws(
    () =>
      normalizeLmStudioToolRequest(
        { ...history, input: [...history.input] },
        history,
      ),
    /unknown namespace tool/u,
  );
});
