import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_NAMESPACE_WIRE_PREFIX,
  createTextOnlyToolResponseCodec,
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
  assert.deepEqual([...codec.allowedWireNames], ["beta"]);
  assert.deepEqual(rewritten.tools, [
    functionTool("beta", { type: "object", properties: {} }),
  ]);
  assert.equal(rewritten.tool_choice, "required");
  assert.equal(rewritten.parallel_tool_calls, false);
});

test("binds response authority to tool choice and blocks every text-only call form", () => {
  const noneSource = {
    tools: [functionTool("known", {})],
    tool_choice: "none",
  };
  const noneRewritten = { ...noneSource };
  const noneCodec = normalizeLmStudioToolRequest(noneRewritten, noneSource);
  assert.equal(noneCodec.allowedWireNames.size, 0);
  assert.equal(noneCodec.maxAuthorizedCalls, 0);
  assert.throws(
    () => rewriteResponseFunctionCalls({
      output: [{
        type: "function_call",
        name: "known",
        call_id: "call_disallowed_choice",
        arguments: "{}",
      }],
    }, noneCodec),
    /was not advertised/u,
  );

  const textOnlyCodec = createTextOnlyToolResponseCodec();
  assert.equal(textOnlyCodec.maxAuthorizedCalls, 0);
  for (const value of [
    {
      output: [{
        type: "function_call",
        name: "shell",
        call_id: "call_text_only",
        arguments: "{}",
      }],
    },
    { output: [{ type: "custom_tool_call", call_id: "call_custom" }] },
    { output: [{ type: "mcp_approval_request", id: "approval_mcp" }] },
    {
      type: "response.function_call_arguments.done",
      item_id: "item_orphan",
      output_index: 0,
      arguments: "{}",
    },
    {
      type: "response.custom_tool_call_input.done",
      item_id: "item_custom",
      output_index: 0,
      input: "unsafe",
    },
    {
      type: "response.mcp_approval_request",
      item_id: "approval_mcp",
    },
  ]) {
    assert.throws(
      () => rewriteResponseFunctionCalls(value, textOnlyCodec),
      /Upstream (?:invoked|emitted)/u,
    );
  }
});

test("binds serial response cardinality and reserves replay identifiers", () => {
  const source = {
    tools: [functionTool("known", {})],
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
  const codec = normalizeLmStudioToolRequest({
    ...source,
    input: source.input.map((item) => ({ ...item })),
  }, source);

  assert.equal(codec.maxAuthorizedCalls, 1);
  assert.deepEqual([...codec.reservedCallIds], ["call_historical"]);
  assert.deepEqual([...codec.reservedItemIds], ["item_historical"]);
  assert.throws(
    () => normalizeLmStudioToolRequest(
      { tools: source.tools },
      { tools: source.tools, parallel_tool_calls: "false" },
    ),
    /parallel_tool_calls must be a boolean/u,
  );
});

test("keeps Codex defer_loading hints off the LM Studio wire", () => {
  const source = {
    tools: [
      {
        ...functionTool("deferred", {}),
        defer_loading: true,
      },
    ],
  };
  const rewritten = { ...source };
  normalizeLmStudioToolRequest(rewritten, source);

  assert.equal(Object.hasOwn(rewritten.tools[0], "defer_loading"), false);
  assert.equal(source.tools[0].defer_loading, true);
});

test("rejects malformed Codex defer_loading hints", () => {
  const source = {
    tools: [
      {
        ...functionTool("deferred", {}),
        defer_loading: "true",
      },
    ],
  };

  assert.throws(
    () => normalizeLmStudioToolRequest({ ...source }, source),
    /defer_loading must be a boolean/u,
  );
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
  assert.deepEqual([...codec.allowedWireNames], [calendar.wireName]);
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
  rewriteResponseFunctionCalls(response, codec, { mode: "sse" });
  assert.deepEqual(response.response.output[0], {
    type: "function_call",
    namespace: "calendar",
    name: "read",
    call_id: "call_2",
    arguments: "{}",
  });

  assert.throws(
    () => rewriteResponseFunctionCalls({
      output: [{
        type: "function_call",
        namespace: "workspace",
        name: "read",
        call_id: "call_injected_namespace",
        arguments: "{}",
      }],
    }, codec),
    /must not supply a namespace/u,
  );
  assert.throws(
    () => rewriteResponseFunctionCalls({
      output: [{
        type: "function_call",
        name: workspace.wireName,
        call_id: "call_unselected_namespace_tool",
        arguments: "{}",
      }],
    }, codec),
    /was not advertised/u,
  );
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

test("compact history can map a missing namespace without advertising a tool", () => {
  const source = {
    tools: [],
    input: [
      {
        type: "function_call",
        namespace: "workspace",
        name: "read",
        call_id: "call_old_1",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_old_1", output: "one" },
      {
        type: "function_call",
        namespace: "workspace",
        name: "read",
        call_id: "call_old_2",
        arguments: "{}",
      },
    ],
  };
  const rewritten = {
    ...source,
    input: source.input.map((item) => ({ ...item })),
  };
  const codec = normalizeLmStudioToolRequest(rewritten, source, {
    allowHistoryOnlyNamespaces: true,
  });

  assert.equal(Object.hasOwn(rewritten, "tools"), false);
  assert.match(rewritten.input[0].name, /^mbns_[0-9a-f]{56}$/u);
  assert.equal(rewritten.input[2].name, rewritten.input[0].name);
  assert.equal(Object.hasOwn(rewritten.input[0], "namespace"), false);
  assert.equal(codec.reverse.has(rewritten.input[0].name), false);
  assert.equal(codec.historyOnlyWireNames.has(rewritten.input[0].name), true);
  assert.throws(
    () => rewriteResponseFunctionCalls({
      output: [{
        type: "function_call",
        name: rewritten.input[0].name,
        call_id: "call_unauthorized_history_tool",
        arguments: "{}",
      }],
    }, codec),
    /history-only namespace tool/u,
  );
  assert.equal(source.input[0].namespace, "workspace");
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

  for (const type of [
    "custom_tool_call",
    "custom_tool_call_output",
    "mcp_approval_request",
    "mcp_call",
    "mcp_list_tools",
    "web_search_call",
  ]) {
    const withHistory = {
      tools: [functionTool("known", {})],
      input: [{ type, call_id: `call_history_${type}` }],
    };
    assert.throws(
      () => normalizeLmStudioToolRequest(
        { ...withHistory, input: withHistory.input.map((item) => ({ ...item })) },
        withHistory,
      ),
      /does not accept unadvertised invocation history/u,
    );
  }
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
