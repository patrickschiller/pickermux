import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createResponsesProxy } from "../src/responses-proxy.mjs";
import { MLX_REQUEST_MAX_BYTES, createMlxChatRequest } from "../src/mlx-chat.mjs";

const SLUG = "kolibri/kolibri-1-mlx-4bit";
const MODEL = "kolibri-1-mlx-4bit";

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}

function post(port, body, headers = {}, endpoint = "/v1/responses") {
  const bytes = Buffer.from(JSON.stringify({ model: SLUG, input: "Hallo", ...body }));
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: endpoint, method: "POST", headers: {
      "content-type": "application/json", "content-length": bytes.length, ...headers,
    } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(bytes);
  });
}

async function harness(t, { routeChanges = {}, reply, gate = async () => {}, limits } = {}) {
  const requests = [];
  const usage = [];
  let credentialReads = 0;
  const upstreamPort = await listen(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks)) });
    if (reply) return reply(response, requests.at(-1));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "private-upstream-id", object: "chat.completion", model: MODEL, created: 1,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Hallo zurück!" } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }));
  });
  const route = { kind: "external", providerId: "kolibri", providerKind: "mlx-chat-completions", slug: SLUG,
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, allowPrivateNetwork: true, upstreamModel: MODEL,
    toolsEnabled: false, reasoningEffort: "none", reasoningEfforts: ["none"], model: { contextWindow: 8192 }, ...routeChanges,
  };
  const proxy = createResponsesProxy({ registry: { resolve(model) {
    if (model !== SLUG) throw Object.assign(new Error("unknown"), { code: "UNKNOWN_MODEL", statusCode: 404 });
    return route;
  } }, credentialResolver: async () => { credentialReads += 1; return "private-provider-secret"; },
  certificationToken: "private-certification-marker", externalRequestGate: gate,
  limits,
  onTokenUsage: (providerId, value) => usage.push({ providerId, ...value }),
  });
  const port = await listen(t, (request, response) => proxy(request, response, request.url));
  return { port, requests, usage, credentialReads: () => credentialReads };
}

test("MLX JSON translation isolates credentials and builds only the reviewed Chat request", async (t) => {
  const h = await harness(t);
  const result = await post(h.port, { instructions: "Be concise", store: false, client_metadata: { account: "private-account" },
    metadata: { private: "provider-metadata" }, tools: [{ type: "function", name: "exec", parameters: { type: "object" } }],
    tool_choice: "auto", parallel_tool_calls: true,
  }, { authorization: "Bearer native-canary", cookie: "native-cookie", "chatgpt-account-id": "native-account" });
  assert.equal(result.status, 200);
  const response = JSON.parse(result.body);
  assert.equal(response.object, "response");
  assert.equal(response.model, SLUG);
  assert.equal(response.output[0].content[0].text, "Hallo zurück!");
  assert.doesNotMatch(result.body, /private-upstream/u);
  assert.equal(h.requests[0].path, "/v1/chat/completions");
  assert.equal(h.requests[0].body.model, MODEL);
  assert.deepEqual(h.requests[0].body.chat_template_kwargs, { reasoning_effort: "none" });
  assert.doesNotMatch(JSON.stringify(h.requests), /native-canary|native-cookie|native-account|private-account|provider-metadata|"tools"/u);
  assert.equal(h.credentialReads(), 0);
  assert.equal(h.usage.length, 1);
});

test("MLX proxy cannot override the exact upstream request ceiling with a larger global limit", async (t) => {
  const h = await harness(t, { limits: { requestBodyBytes: 2 * MLX_REQUEST_MAX_BYTES } });
  const overhead = createMlxChatRequest({ input: "" }, { upstreamModel: MODEL }).length;
  const available = MLX_REQUEST_MAX_BYTES - overhead;
  const input = "ä".repeat(Math.floor(available / 2)) + (available % 2 === 1 ? "x" : "");
  assert.equal((await post(h.port, { input })).status, 200);
  assert.equal(h.requests.length, 1);
  assert.equal(Buffer.byteLength(JSON.stringify(h.requests[0].body)), MLX_REQUEST_MAX_BYTES);
  assert.equal(h.requests[0].body.messages[0].content, input);
  const rejected = await post(h.port, { input: `${input}x` });
  assert.equal(rejected.status, 400);
  assert.equal(JSON.parse(rejected.body).error.code, "MLX_REQUEST_UNSUPPORTED");
  assert.equal(h.requests.length, 1);
  assert.equal(h.credentialReads(), 0);
});

test("MLX proxy retains a smaller configured request limit before provider I/O", async (t) => {
  const h = await harness(t, { limits: { requestBodyBytes: 2048 } });
  const rejected = await post(h.port, { input: "ä".repeat(2048) });
  assert.equal(rejected.status, 413);
  assert.equal(h.requests.length, 0);
  assert.equal(h.credentialReads(), 0);
});

const toolCapabilities = {
  mlxToolProtocol: "pickermux-mlx-tools-v1",
  modelFingerprint: `sha256:${"a".repeat(64)}`,
  runtimeFingerprint: `sha256:${"b".repeat(64)}`,
  mlxMaxOutputTokens: 1024,
};

function namespaceTool() {
  return { type: "namespace", name: "research", tools: [{
    type: "function", name: "lookup", parameters: { type: "object", properties: { query: { type: "string" } } },
  }] };
}

function toolCompletion(name, { stream = false, metrics = true } = {}) {
  const call = { id: "private-provider-call", type: "function", function: { name, arguments: '{"query":"Example"}' } };
  if (stream) call.index = 0;
  return { id: "private-provider-response", object: stream ? "chat.completion.chunk" : "chat.completion", model: MODEL, created: 1,
    choices: [{ index: 0, finish_reason: "tool_calls", [stream ? "delta" : "message"]: {
      ...(stream ? {} : { role: "assistant", content: "" }), tool_calls: [call],
    } }],
    ...(stream ? {} : { usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      ...(metrics ? { pickermux_metrics: { generation_duration_ms: 200 } } : {}),
    }),
  };
}

test("MLX certified function routing preserves local authority, credentials and full replay", async (t) => {
  const h = await harness(t, { routeChanges: { toolsEnabled: true, mlxCapabilities: toolCapabilities }, reply(response, request) {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.body.messages.some((message) => message.role === "tool")) {
      response.end(JSON.stringify({ id: "private-provider-response", object: "chat.completion", model: MODEL, created: 1,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Source verified" } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }));
    } else response.end(JSON.stringify(toolCompletion(request.body.tools[0].function.name)));
  } });
  const initial = await post(h.port, { tools: [namespaceTool()], tool_choice: "required", parallel_tool_calls: true,
    metadata: { account: "native-private-metadata" },
  }, { authorization: "Bearer native-private-token", cookie: "native-private-cookie" });
  assert.equal(initial.status, 200);
  const output = JSON.parse(initial.body).output;
  const call = output.find((item) => item.type === "function_call");
  assert.equal(call.namespace, "research");
  assert.equal(call.name, "lookup");
  assert.equal(h.requests[0].body.parallel_tool_calls, false);
  assert.equal(h.requests[0].body.tool_choice, "required");
  assert.equal(h.requests[0].headers.authorization, undefined);
  assert.doesNotMatch(JSON.stringify(h.requests), /native-private/u);
  assert.doesNotMatch(initial.body, /private-provider|generation_duration/u);
  assert.equal(h.usage[0].generationDurationMs, 200);
  const continuation = await post(h.port, { tools: [namespaceTool()], tool_choice: "none", input: [
    { role: "user", content: "Find source" }, ...output,
    { type: "function_call_output", call_id: call.call_id, output: "Public source found" },
  ] });
  assert.equal(continuation.status, 200);
  assert.equal(JSON.parse(continuation.body).output[0].content[0].text, "Source verified");
  assert.equal(h.requests[1].body.messages.at(-1).tool_call_id, call.call_id);
  assert.equal(h.credentialReads(), 0);
});

test("MLX certified streaming functions commit only validated calls and decode duration", async (t) => {
  const h = await harness(t, { routeChanges: { toolsEnabled: true, mlxCapabilities: toolCapabilities }, reply(response, request) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const terminal = toolCompletion(request.body.tools[0].function.name, { stream: true });
    const first = { ...terminal, choices: [{ index: 0, finish_reason: null, delta: { role: "assistant" } }] };
    const usage = { ...terminal, object: "chat.completion", choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }, pickermux_metrics: { generation_duration_ms: 200 },
    };
    for (const packet of [first, terminal, usage]) response.write(`data: ${JSON.stringify(packet)}\n\n`);
    response.end("data: [DONE]\n\n");
  } });
  const result = await post(h.port, { stream: true, tools: [namespaceTool()], tool_choice: "required" });
  assert.equal(result.status, 200);
  assert.match(result.body, /response.completed/u);
  assert.match(result.body, /"namespace":"research"/u);
  assert.match(result.body, /"name":"lookup"/u);
  assert.doesNotMatch(result.body, /private-provider|generation_duration/u);
  assert.equal(h.usage.length, 1);
  assert.equal(h.usage[0].generationDurationMs, 200);
});

test("MLX tool authority rejects malformed capabilities and unsatisfied forced choice", async (t) => {
  const invalid = await harness(t, { routeChanges: { toolsEnabled: true, mlxCapabilities: { ...toolCapabilities, unreviewed: true } } });
  assert.equal((await post(invalid.port, { tools: [namespaceTool()], tool_choice: "required" })).status, 400);
  assert.equal(invalid.requests.length, 0);
  const h = await harness(t, { routeChanges: { toolsEnabled: true, mlxCapabilities: toolCapabilities } });
  const result = await post(h.port, { tools: [namespaceTool()], tool_choice: "required" });
  assert.equal(result.status, 502);
  assert.deepEqual(h.usage, [{ providerId: "kolibri", status: "unavailable" }]);
});

test("MLX stream reconstruction retains text and usage with a Responses terminal", async (t) => {
  const h = await harness(t, { reply(response) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish = null) => ({ id: "upstream", object: "chat.completion.chunk", model: MODEL, created: 1,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    for (const item of [chunk({ role: "assistant", content: "Grüße" }), chunk({ role: "assistant", content: "!" }, "stop"),
      { id: "upstream", object: "chat.completion", model: MODEL, created: 1, choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
    ]) response.write(`data: ${JSON.stringify(item)}\n\n`);
    response.end("data: [DONE]\n\n");
  } });
  const result = await post(h.port, { stream: true });
  assert.equal(result.status, 200);
  assert.match(result.body, /response.output_text.delta/u);
  assert.match(result.body, /response.completed/u);
  assert.match(result.body, /Grüße/u);
  assert.doesNotMatch(result.body, /upstream/u);
  assert.equal(h.usage.length, 1);
});

test("MLX native summary settings do not reject a fresh Codex text turn or reach the provider", async (t) => {
  const h = await harness(t);
  const result = await post(h.port, {
    reasoning: { effort: "ultra", summary: "auto" },
    stream_options: { reasoning_summary_delivery: "sequential_cutoff" },
    client_metadata: { secret: "native-private-account" },
  });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).output[0].content[0].text, "Hallo zurück!");
  assert.deepEqual(h.requests[0].body.chat_template_kwargs, { reasoning_effort: "none" });
  assert.equal(Object.hasOwn(h.requests[0].body, "reasoning"), false);
  assert.equal(Object.hasOwn(h.requests[0].body, "stream_options"), false);
  assert.doesNotMatch(JSON.stringify(h.requests), /native-private-account|sequential_cutoff/u);
  assert.equal(h.credentialReads(), 0);
});

test("MLX rejects forced tools, history, attachments, compaction and certification before I/O", async (t) => {
  const h = await harness(t, { routeChanges: { toolsEnabled: true } });
  for (const [body, headers, endpoint] of [
    [{ tool_choice: "required" }, {}, undefined],
    [{ input: [{ type: "function_call", call_id: "call", name: "exec", arguments: "{}" }] }, {}, undefined],
    [{ input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.invalid/image" }] }] }, {}, undefined],
    [{ previous_response_id: "previous" }, {}, undefined],
    [{ reasoning: { summary: "unknown" } }, {}, undefined],
    [{ stream_options: { include_usage: true } }, {}, undefined],
    [{}, { "x-pickermux-certification": "private-certification-marker" }, undefined],
    [{}, {}, "/v1/responses/compact"],
  ]) {
    const result = await post(h.port, body, headers, endpoint);
    assert.equal(result.status, 400, JSON.stringify({ body, result }));
  }
  assert.equal(h.requests.length, 0);
  assert.equal(h.credentialReads(), 0);
});

test("MLX invalid route and pending certification fail before any credential or provider access", async (t) => {
  for (const options of [{ routeChanges: { baseUrl: "http://192.168.1.2:8080/v1" } },
    { routeChanges: { credentialKeychain: true } },
    { gate: async () => { throw new Error("private-canary"); } },
  ]) {
    const h = await harness(t, options);
    const result = await post(h.port, {});
    assert.ok([400, 503].includes(result.status));
    assert.doesNotMatch(result.body, /private-canary/u);
    assert.equal(h.requests.length, 0);
    assert.equal(h.credentialReads(), 0);
  }
});

test("MLX upstream errors and unsolicited tool calls never escape as successful provider output", async (t) => {
  for (const kind of ["error", "tool", "bad-json"]) {
    const h = await harness(t, { reply(response) {
      response.writeHead(kind === "error" ? 400 : 200, { "content-type": "application/json" });
      response.end(kind === "error" ? JSON.stringify({ error: "private-prompt-canary" }) : kind === "bad-json" ? "not json private-prompt-canary" :
        JSON.stringify({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
          tool_calls: [{ id: "call", function: { name: "exec", arguments: "{}" } }],
        } }] }));
    } });
    const result = await post(h.port, {});
    assert.ok(result.status >= 400);
    assert.doesNotMatch(result.body, /private-prompt-canary|"tool_calls"|"exec"/u);
  }
});
