import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createResponsesProxy } from "../src/responses-proxy.mjs";

const PUBLIC_MODEL = "lmstudio/example/efficient-model";
const UPSTREAM_MODEL = "example/efficient-model";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function requestProxy({
  port,
  body,
  accept = "application/json",
  path = "/v1/responses",
}) {
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          accept,
          "content-length": String(encoded.length),
          "content-type": "application/json",
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("end", () => {
          resolve({
            body: Buffer.concat(chunks),
            headers: response.headers,
            statusCode: response.statusCode,
          });
        });
      },
    );
    request.once("error", reject);
    request.end(encoded);
  });
}

function requestAbortedStream({ port, body }) {
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/responses",
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-length": String(encoded.length),
          "content-type": "application/json",
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("aborted", () => finish({
          aborted: true,
          body: Buffer.concat(chunks),
          statusCode: response.statusCode,
        }));
        response.once("error", () => finish({
          aborted: true,
          body: Buffer.concat(chunks),
          statusCode: response.statusCode,
        }));
        response.once("end", () => finish({
          aborted: false,
          body: Buffer.concat(chunks),
          statusCode: response.statusCode,
        }));
      },
    );
    request.once("error", () => finish({ aborted: true, body: Buffer.alloc(0) }));
    request.end(encoded);
  });
}

async function createHarness(t, {
  clientToolSearchEnabled = true,
  credentialResolver,
  respond,
  toolsEnabled = true,
} = {}) {
  const requests = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.once("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ body, headers: request.headers, path: request.url });
      if (respond) {
        respond({ body, index: requests.length - 1, request, response });
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"output":[]}');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const handle = createResponsesProxy({
    registry: {
      resolve(model) {
        assert.equal(model, PUBLIC_MODEL);
        return {
          kind: "external",
          providerKind: "lmstudio-responses",
          providerId: "lmstudio",
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          allowPrivateNetwork: true,
          upstreamModel: UPSTREAM_MODEL,
          toolsEnabled,
          clientToolSearchEnabled,
        };
      },
    },
    credentialResolver: credentialResolver ?? (async () => undefined),
  });
  const proxy = http.createServer((request, response) => {
    void handle(request, response, new URL(request.url, "http://proxy.local").pathname);
  });
  const port = await listen(proxy);
  t.after(() => close(proxy));
  return { port, requests };
}

function searchTool(overrides = {}) {
  return {
    type: "tool_search",
    execution: "client",
    description: "Find only the tool needed for this turn.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    ...overrides,
  };
}

function deferredFunction(name) {
  return {
    type: "function",
    name,
    description: `Deferred ${name} schema`,
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

function deferredNamespace() {
  return {
    type: "namespace",
    name: "workspace",
    description: "Workspace tools",
    tools: [
      deferredFunction("read_file"),
      deferredFunction("write_file"),
    ],
  };
}

function fullHarnessInput() {
  return [
    {
      type: "message",
      role: "developer",
      content: [
        { type: "input_text", text: "developer-harness-canary" },
        { type: "input_text", text: "sandbox-and-approval-canary" },
      ],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "user-task-canary" }],
    },
  ];
}

function efficientRequest(overrides = {}) {
  return {
    model: PUBLIC_MODEL,
    instructions: "complete-codex-instructions-canary",
    input: fullHarnessInput(),
    tools: [deferredNamespace(), searchTool()],
    tool_choice: "auto",
    parallel_tool_calls: false,
    ...overrides,
  };
}

function jsonResponse(response, value) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function parseSse(buffer) {
  return buffer
    .toString("utf8")
    .split(/\r?\n\r?\n/u)
    .filter(Boolean)
    .map((event) => {
      const data = event
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /u, ""))
        .join("\n");
      return data;
    })
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

test("Efficient Fidelity hides deferred schemas while preserving the complete Codex harness", async (t) => {
  let syntheticName;
  const harness = await createHarness(t, {
    respond({ body, response }) {
      syntheticName = body.tools.find((tool) => tool.name?.startsWith("mbts_"))?.name;
      jsonResponse(response, {
        id: "resp-search-1",
        output: [
          {
            id: "item-search-1",
            type: "function_call",
            name: syntheticName,
            call_id: "call-search-1",
            status: "completed",
            arguments: '{"query":"workspace read","limit":1}',
          },
        ],
      });
    },
  });

  const result = await requestProxy({
    port: harness.port,
    body: efficientRequest(),
  });

  assert.equal(result.statusCode, 200);
  assert.equal(harness.requests.length, 1);
  const upstream = harness.requests[0].body;
  assert.equal(upstream.model, UPSTREAM_MODEL);
  assert.equal(upstream.instructions, "complete-codex-instructions-canary");
  assert.deepEqual(upstream.input, [
    {
      type: "message",
      role: "system",
      content: [
        { type: "input_text", text: "developer-harness-canary" },
        { type: "input_text", text: "sandbox-and-approval-canary" },
      ],
    },
    fullHarnessInput()[1],
  ]);
  assert.ok(syntheticName);
  assert.deepEqual(upstream.tools.map((tool) => tool.name), [syntheticName]);
  assert.doesNotMatch(JSON.stringify(upstream), /read_file|write_file|defer_loading/u);

  assert.deepEqual(JSON.parse(result.body), {
    id: "resp-search-1",
    output: [
      {
        id: "item-search-1",
        type: "tool_search_call",
        execution: "client",
        call_id: "call-search-1",
        status: "completed",
        arguments: { query: "workspace read", limit: 1 },
      },
    ],
  });
});

test("Efficient Fidelity accepts Codex-sized search source descriptions", async (t) => {
  const harness = await createHarness(t);
  const description = `# Tool discovery\n${"source context ".repeat(1_024)}`;
  const result = await requestProxy({
    port: harness.port,
    body: efficientRequest({
      tools: [deferredNamespace(), searchTool({ description })],
    }),
  });

  assert.equal(result.statusCode, 200);
  assert.equal(harness.requests.length, 1);
  const projectedSearch = harness.requests[0].body.tools.find(
    (tool) => tool.name?.startsWith("mbts_"),
  );
  assert.equal(projectedSearch.description, description);
});

test("Efficient Fidelity full replay injects only the selected namespace tool and restores its identity", async (t) => {
  let searchWireName;
  let namespaceWireName;
  const harness = await createHarness(t, {
    respond({ body, index, response }) {
      if (index === 0) {
        searchWireName = body.tools.find((tool) => tool.name?.startsWith("mbts_"))?.name;
        jsonResponse(response, {
          output: [{
            id: "item-search-2",
            type: "function_call",
            name: searchWireName,
            call_id: "call-search-2",
            status: "completed",
            arguments: '{"query":"read a workspace file","limit":1}',
          }],
        });
        return;
      }
      namespaceWireName = body.tools.find((tool) => tool.name?.startsWith("mbns_"))?.name;
      jsonResponse(response, {
        output: [{
          id: "item-read-2",
          type: "function_call",
          name: namespaceWireName,
          call_id: "call-read-2",
          status: "completed",
          arguments: '{"path":"README.md"}',
        }],
      });
    },
  });

  const initial = await requestProxy({ port: harness.port, body: efficientRequest() });
  assert.equal(initial.statusCode, 200);
  const [searchCall] = JSON.parse(initial.body).output;
  const selectedTool = {
    type: "namespace",
    name: "workspace",
    description: "Workspace tools",
    tools: [deferredFunction("read_file")],
  };
  const replay = efficientRequest({
    input: [
      ...fullHarnessInput(),
      searchCall,
      {
        type: "tool_search_output",
        execution: "client",
        call_id: searchCall.call_id,
        status: "completed",
        tools: [selectedTool],
      },
    ],
  });
  const result = await requestProxy({ port: harness.port, body: replay });

  assert.equal(result.statusCode, 200);
  assert.equal(harness.requests.length, 2);
  const upstream = harness.requests[1].body;
  assert.equal(Object.hasOwn(upstream, "previous_response_id"), false);
  assert.equal(upstream.instructions, "complete-codex-instructions-canary");
  assert.match(JSON.stringify(upstream.input), /developer-harness-canary/u);
  assert.match(JSON.stringify(upstream.input), /sandbox-and-approval-canary/u);
  assert.match(JSON.stringify(upstream.input), /user-task-canary/u);
  assert.ok(searchWireName);
  assert.ok(namespaceWireName);
  assert.deepEqual(
    upstream.tools.map((tool) => tool.name).sort(),
    [namespaceWireName, searchWireName].sort(),
  );
  assert.doesNotMatch(JSON.stringify(upstream), /write_file|defer_loading/u);
  assert.equal(
    upstream.tools.find((tool) => tool.name === namespaceWireName).description,
    "Deferred read_file schema",
  );
  assert.deepEqual(upstream.input.slice(-2), [
    {
      id: "item-search-2",
      type: "function_call",
      name: searchWireName,
      call_id: "call-search-2",
      arguments: '{"query":"read a workspace file","limit":1}',
      status: "completed",
    },
    {
      type: "function_call_output",
      call_id: "call-search-2",
      output: "Selected tools are now available.",
    },
  ]);
  assert.deepEqual(JSON.parse(result.body).output, [
    {
      id: "item-read-2",
      type: "function_call",
      name: "read_file",
      namespace: "workspace",
      call_id: "call-read-2",
      status: "completed",
      arguments: '{"path":"README.md"}',
    },
  ]);
});

test("overlapping search results expose one unchanged tool schema", async (t) => {
  const harness = await createHarness(t);
  const selected = {
    type: "namespace",
    name: "workspace",
    description: "Workspace tools",
    tools: [deferredFunction("read_file")],
  };
  const searchPair = (suffix, tool) => [
    {
      type: "tool_search_call",
      execution: "client",
      call_id: `call_overlap_${suffix}`,
      status: "completed",
      arguments: { query: "workspace read" },
    },
    {
      type: "tool_search_output",
      execution: "client",
      call_id: `call_overlap_${suffix}`,
      status: "completed",
      tools: [tool],
    },
  ];
  const result = await requestProxy({
    port: harness.port,
    body: efficientRequest({
      input: [
        ...fullHarnessInput(),
        ...searchPair("one", selected),
        ...searchPair("two", structuredClone(selected)),
      ],
    }),
  });

  assert.equal(result.statusCode, 200);
  const upstreamTools = harness.requests[0].body.tools;
  assert.equal(
    upstreamTools.filter((tool) => tool.name?.startsWith("mbts_")).length,
    1,
  );
  assert.equal(
    upstreamTools.filter((tool) => tool.name?.startsWith("mbns_")).length,
    1,
  );
  assert.equal(upstreamTools.length, 2);
});

test("a direct-certified route without the additive grant keeps the direct fallback", async (t) => {
  const harness = await createHarness(t, { clientToolSearchEnabled: false });
  const result = await requestProxy({
    port: harness.port,
    body: efficientRequest(),
  });

  assert.equal(result.statusCode, 200);
  assert.equal(harness.requests.length, 1);
  const upstream = harness.requests[0].body;
  assert.equal(upstream.tool_choice, "auto");
  assert.equal(upstream.tools.length, 2);
  assert.ok(upstream.tools.every((tool) => tool.type === "function"));
  assert.ok(upstream.tools.every((tool) => tool.name.startsWith("mbns_")));
  assert.deepEqual(
    upstream.tools.map((tool) => tool.description).sort(),
    ["Deferred read_file schema", "Deferred write_file schema"],
  );
  assert.doesNotMatch(JSON.stringify(upstream), /mbts_|defer_loading/u);
});

test("unauthorized and malformed tool search fails before credentials and upstream", async (t) => {
  let credentialResolutions = 0;
  const harness = await createHarness(t, {
    credentialResolver: async () => {
      credentialResolutions += 1;
      return undefined;
    },
  });
  const cases = [
    {
      label: "stateful continuation",
      body: efficientRequest({ previous_response_id: "resp-private-state" }),
      code: "INVALID_TOOL_SEARCH",
    },
    {
      label: "non-automatic none choice",
      body: efficientRequest({ tool_choice: "none" }),
      code: "UNSUPPORTED_TOOL_CHOICE",
    },
    {
      label: "non-automatic required choice",
      body: efficientRequest({ tool_choice: "required" }),
      code: "UNSUPPORTED_TOOL_CHOICE",
    },
    {
      label: "hosted execution",
      body: efficientRequest({
        tools: [deferredNamespace(), searchTool({ execution: "server" })],
      }),
      code: "UNSUPPORTED_TOOL_SEARCH_EXECUTION",
    },
    {
      label: "unknown hosted field",
      body: efficientRequest({
        tools: [deferredNamespace(), searchTool({ hosted_only: true })],
      }),
      code: "INVALID_TOOL_SEARCH",
    },
    {
      label: "unknown search type",
      body: efficientRequest({
        tools: [deferredNamespace(), searchTool({ type: "tool_search_v2" })],
      }),
      code: "INVALID_TOOL_SEARCH",
    },
    {
      label: "malformed parameters",
      body: efficientRequest({
        tools: [deferredNamespace(), searchTool({ parameters: [] })],
      }),
      code: "INVALID_TOOL_SEARCH",
    },
    {
      label: "unadvertised invocation history",
      body: efficientRequest({
        input: [
          ...fullHarnessInput(),
          {
            type: "mcp_call",
            call_id: "call_unadvertised_history",
            name: "remote_tool",
            arguments: "{}",
          },
        ],
      }),
      code: "UNSUPPORTED_TOOL_TYPE",
    },
    {
      label: "changed overlapping tool schema",
      body: efficientRequest({
        input: [
          ...fullHarnessInput(),
          {
            type: "tool_search_call",
            execution: "client",
            call_id: "call_schema_one",
            status: "completed",
            arguments: { query: "workspace read" },
          },
          {
            type: "tool_search_output",
            execution: "client",
            call_id: "call_schema_one",
            status: "completed",
            tools: [deferredFunction("read_file")],
          },
          {
            type: "tool_search_call",
            execution: "client",
            call_id: "call_schema_two",
            status: "completed",
            arguments: { query: "workspace read" },
          },
          {
            type: "tool_search_output",
            execution: "client",
            call_id: "call_schema_two",
            status: "completed",
            tools: [{
              ...deferredFunction("read_file"),
              description: "Changed schema for the same identity.",
            }],
          },
        ],
      }),
      code: "INVALID_TOOL_SEARCH",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.label, async () => {
      const result = await requestProxy({ port: harness.port, body: entry.body });
      assert.equal(result.statusCode, 400);
      assert.equal(JSON.parse(result.body).error.code, entry.code);
    });
  }
  assert.equal(credentialResolutions, 0);
  assert.equal(harness.requests.length, 0);
});

test("secondary input tool inventories fail on both Efficient Fidelity and text-only routes", async (t) => {
  for (const toolsEnabled of [true, false]) {
    await t.test(toolsEnabled ? "efficient" : "text-only", async (t) => {
      let credentialResolutions = 0;
      const harness = await createHarness(t, {
        toolsEnabled,
        credentialResolver: async () => {
          credentialResolutions += 1;
          return undefined;
        },
      });
      const result = await requestProxy({
        port: harness.port,
        body: efficientRequest({
          input: [
            ...fullHarnessInput(),
            {
              type: "additional_tools",
              tools: [deferredFunction("secondary_inventory")],
            },
          ],
        }),
      });
      assert.equal(result.statusCode, 400);
      assert.equal(JSON.parse(result.body).error.code, "UNSUPPORTED_TOOL_TYPE");
      assert.equal(credentialResolutions, 0);
      assert.equal(harness.requests.length, 0);
    });
  }
});

test("tool-search history without an Efficient Fidelity grant fails before credentials", async (t) => {
  let credentialResolutions = 0;
  const harness = await createHarness(t, {
    clientToolSearchEnabled: false,
    credentialResolver: async () => {
      credentialResolutions += 1;
      return undefined;
    },
  });
  const result = await requestProxy({
    port: harness.port,
    body: efficientRequest({
      input: [
        ...fullHarnessInput(),
        {
          type: "tool_search_call",
          execution: "client",
          call_id: "call-unauthorized",
          status: "completed",
          arguments: { query: "workspace" },
        },
        {
          type: "tool_search_output",
          execution: "client",
          call_id: "call-unauthorized",
          status: "completed",
          tools: [],
        },
      ],
    }),
  });

  assert.equal(result.statusCode, 400);
  assert.equal(JSON.parse(result.body).error.code, "INVALID_TOOL_SEARCH");
  assert.equal(credentialResolutions, 0);
  assert.equal(harness.requests.length, 0);
});

test("Efficient Fidelity preserves Codex remote compaction after a tool search", async (t) => {
  const compacted = {
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "compact-summary-canary" }],
      },
      {
        type: "compaction",
        encrypted_content: "opaque-compaction-canary",
      },
    ],
  };
  const harness = await createHarness(t, {
    respond({ response }) {
      jsonResponse(response, compacted);
    },
  });
  const body = efficientRequest({
    input: [
      ...fullHarnessInput(),
      {
        id: "item-compact-search",
        type: "tool_search_call",
        execution: "client",
        call_id: "call-compact-search",
        status: "completed",
        arguments: { query: "workspace" },
      },
      {
        type: "tool_search_output",
        execution: "client",
        call_id: "call-compact-search",
        status: "completed",
        tools: [],
      },
      {
        type: "function_call",
        namespace: "workspace",
        name: "read_file",
        call_id: "call-compact-read",
        status: "completed",
        arguments: '{"path":"README.md"}',
      },
      {
        type: "function_call_output",
        call_id: "call-compact-read",
        output: "historical-read-result",
      },
    ],
  });
  delete body.tool_choice;

  const result = await requestProxy({
    port: harness.port,
    path: "/v1/responses/compact",
    body,
  });

  assert.equal(result.statusCode, 200);
  assert.equal(harness.requests.length, 1);
  const upstream = harness.requests[0];
  assert.equal(upstream.path, "/v1/responses/compact");
  assert.equal(Object.hasOwn(upstream.body, "tool_choice"), false);
  assert.equal(Object.hasOwn(upstream.body, "previous_response_id"), false);
  assert.equal(upstream.body.instructions, "complete-codex-instructions-canary");
  assert.equal(upstream.body.tools.length, 1);
  assert.match(upstream.body.tools[0].name, /^mbts_[0-9a-f]{56}$/u);
  const compactHistory = upstream.body.input.slice(-4);
  assert.deepEqual(compactHistory.slice(0, 2), [
    {
      id: "item-compact-search",
      type: "function_call",
      name: upstream.body.tools[0].name,
      call_id: "call-compact-search",
      arguments: '{"query":"workspace"}',
      status: "completed",
    },
    {
      type: "function_call_output",
      call_id: "call-compact-search",
      output: "Selected tools are now available.",
    },
  ]);
  assert.match(compactHistory[2].name, /^mbns_[0-9a-f]{56}$/u);
  assert.equal(Object.hasOwn(compactHistory[2], "namespace"), false);
  assert.deepEqual(
    { ...compactHistory[2], name: "<history-only-wire-name>" },
    {
      type: "function_call",
      name: "<history-only-wire-name>",
      call_id: "call-compact-read",
      status: "completed",
      arguments: '{"path":"README.md"}',
    },
  );
  assert.deepEqual(compactHistory[3], {
    type: "function_call_output",
    call_id: "call-compact-read",
    output: "historical-read-result",
  });
  assert.doesNotMatch(JSON.stringify(upstream.body.tools), /read_file/u);
  assert.deepEqual(JSON.parse(result.body), compacted);
});

test("malformed compact Tool Search history fails before credentials", async (t) => {
  let credentialResolutions = 0;
  const harness = await createHarness(t, {
    credentialResolver: async () => {
      credentialResolutions += 1;
      return undefined;
    },
  });
  const body = efficientRequest({
    input: [
      ...fullHarnessInput(),
      {
        type: "tool_search_output",
        execution: "client",
        call_id: "call-compact-unknown",
        status: "completed",
        tools: [],
      },
    ],
  });
  delete body.tool_choice;

  const result = await requestProxy({
    port: harness.port,
    path: "/v1/responses/compact",
    body,
  });
  assert.equal(result.statusCode, 400);
  assert.equal(JSON.parse(result.body).error.code, "UNKNOWN_TOOL_SEARCH_CALL");
  assert.equal(credentialResolutions, 0);
  assert.equal(harness.requests.length, 0);
});

test("Efficient Fidelity suppresses synthetic SSE fragments and emits only client tool search", async (t) => {
  let syntheticName;
  const harness = await createHarness(t, {
    respond({ body, response }) {
      syntheticName = body.tools.find((tool) => tool.name?.startsWith("mbts_"))?.name;
      const item = {
        id: "item-stream-search",
        type: "function_call",
        name: syntheticName,
        call_id: "call-stream-search",
        status: "completed",
        arguments: '{"query":"workspace","limit":1}',
      };
      const events = [
        {
          type: "response.created",
          response: { id: "resp-stream-search", output: [] },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", arguments: "" },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: item.id,
          output_index: 0,
          delta: item.arguments,
        },
        {
          type: "response.function_call_arguments.done",
          item_id: item.id,
          output_index: 0,
          arguments: item.arguments,
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item,
        },
        {
          type: "response.completed",
          response: {
            id: "resp-stream-search",
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
            },
          },
        },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) {
        const encoded = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        const middle = Math.floor(encoded.length / 2);
        response.write(encoded.slice(0, middle));
        response.write(encoded.slice(middle));
      }
      response.write("data: [DONE]\n\n");
      response.end();
    },
  });

  const result = await requestProxy({
    port: harness.port,
    body: efficientRequest({ stream: true }),
    accept: "text/event-stream",
  });

  assert.equal(result.statusCode, 200);
  assert.ok(syntheticName);
  const serialized = result.body.toString("utf8");
  assert.match(serialized, /data: \[DONE\]/u);
  assert.doesNotMatch(serialized, /mbts_|response\.function_call_arguments/u);
  assert.doesNotMatch(serialized, /response\.output_item\.added/u);
  const events = parseSse(result.body);
  assert.deepEqual(events.map((event) => event.type), [
    "response.created",
    "response.output_item.done",
    "response.completed",
  ]);
  assert.deepEqual(events[1].item, {
    id: "item-stream-search",
    type: "tool_search_call",
    execution: "client",
    call_id: "call-stream-search",
    status: "completed",
    arguments: { query: "workspace", limit: 1 },
  });
  assert.equal(Object.hasOwn(events[2].response, "output"), false);
});

test("failed Efficient Fidelity SSE discards its uncommitted held tail", async (t) => {
  const harness = await createHarness(t, {
    respond({ body, response }) {
      const syntheticName = body.tools.find(
        (tool) => tool.name?.startsWith("mbts_"),
      ).name;
      const writeEvent = (event) => response.write(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
      response.writeHead(200, { "content-type": "text/event-stream" });
      writeEvent({
        type: "response.created",
        response: { id: "resp-stream-failed" },
      });
      writeEvent({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          name: syntheticName,
          call_id: "call-stream-failed",
          status: "completed",
          arguments: '{"query":"uncommitted"}',
        },
      });
      writeEvent({
        type: "response.output_text.delta",
        delta: "uncommitted-tail-canary",
      });
      writeEvent({
        type: "response.failed",
        response: {
          id: "resp-stream-failed",
          error: { code: "upstream_failed", message: "failed" },
        },
      });
      response.write("data: [DONE]\n\n");
      response.end();
    },
  });

  const result = await requestProxy({
    port: harness.port,
    body: efficientRequest({ stream: true }),
    accept: "text/event-stream",
  });
  assert.equal(result.statusCode, 200);
  const serialized = result.body.toString("utf8");
  assert.match(serialized, /data: \[DONE\]/u);
  assert.doesNotMatch(serialized, /tool_search_call|mbts_|uncommitted-tail-canary/u);
  assert.deepEqual(parseSse(result.body).map((event) => event.type), [
    "response.created",
    "response.failed",
  ]);
});

test("late invalid Efficient Fidelity streams abort safely and leave the bridge alive", async (t) => {
  const harness = await createHarness(t, {
    respond({ body, index, response }) {
      if (index === 3) {
        jsonResponse(response, { output: [] });
        return;
      }
      const writeEvent = (event) => response.write(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
      response.writeHead(200, { "content-type": "text/event-stream" });
      writeEvent({
        type: "response.created",
        response: { id: `resp_bad_${index}`, output: [] },
      });
      if (index < 2) {
        const syntheticName = body.tools.find(
          (tool) => tool.name?.startsWith("mbts_"),
        ).name;
        const item = {
          id: `item_bad_${index}`,
          type: "function_call",
          name: syntheticName,
          call_id: `call_bad_${index}`,
          status: "completed",
          arguments: '{"query":"workspace"}',
        };
        writeEvent({
          type: "response.output_item.done",
          output_index: 0,
          item,
        });
        if (index === 1) {
          writeEvent({
            type: "response.completed",
            response: {
              id: "resp_bad_1",
              output: [{ ...item, arguments: '{"query":"changed"}' }],
            },
          });
        }
      } else {
        writeEvent({
          type: "response.function_call_arguments.delta",
          item_id: "item_orphan",
          output_index: 0,
          delta: "{}",
        });
      }
      response.end();
    },
  });

  for (let index = 0; index < 3; index += 1) {
    const result = await requestAbortedStream({
      port: harness.port,
      body: efficientRequest({ stream: true }),
    });
    assert.ok(result.statusCode === undefined || result.statusCode === 200);
    assert.equal(result.aborted, true);
    assert.doesNotMatch(result.body.toString("utf8"), /tool_search_call|mbts_/u);
  }

  const healthy = await requestProxy({
    port: harness.port,
    body: efficientRequest(),
  });
  assert.equal(healthy.statusCode, 200);
  assert.deepEqual(JSON.parse(healthy.body), { output: [] });
  assert.equal(harness.requests.length, 4);
});
