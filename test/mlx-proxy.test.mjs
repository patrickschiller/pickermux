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
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(bytes);
  });
}

async function harness(t, { routeChanges = {}, reply, gate = async () => {}, limits, httpTransport, onProxyFinished } = {}) {
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
  } }, nativeBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
  credentialResolver: async () => { credentialReads += 1; return "private-provider-secret"; },
  certificationToken: "private-certification-marker", externalRequestGate: gate,
  limits, httpTransport,
  onTokenUsage: (providerId, value) => usage.push({ providerId, ...value }),
  });
  const port = await listen(t, async (request, response) => {
    await proxy(request, response, request.url);
    onProxyFinished?.();
  });
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

const inferenceErrors = [
  ["The model invoked an unadvertised function.", "MLX_UNADVERTISED_FUNCTION"],
  ["An incomplete or disabled function call cannot execute.", "MLX_INCOMPLETE_FUNCTION_CALL"],
  ["The model returned malformed function arguments.", "MLX_INVALID_FUNCTION_ARGUMENTS"],
  ["The model returned an unsupported function envelope.", "MLX_INVALID_FUNCTION_ENVELOPE"],
  ["The model returned unsupported control output.", "MLX_UNSUPPORTED_CONTROL_OUTPUT"],
  ["The model did not satisfy the selected function contract.", "MLX_UNSATISFIED_FUNCTION_CONTRACT"],
  ["Kolibri returned invalid token counts.", "MLX_INVALID_TOKEN_COUNTS"],
  ["The model returned an unsupported completion.", "MLX_INVALID_COMPLETION"],
  ["Kolibri returned unsupported or incomplete output.", "MLX_INVALID_COMPLETION"],
  ["Function arguments exceed the supported bounds.", "MLX_FUNCTION_ARGUMENT_LIMIT_EXCEEDED"],
  ["Kolibri output exceeded the response limit.", "MLX_OUTPUT_LIMIT_EXCEEDED"],
];
const reviewedRoute = { toolsEnabled: true, mlxCapabilities: toolCapabilities };
const knownInferenceMessage = inferenceErrors[0][0];
const knownInferenceCode = inferenceErrors[0][1];

function inferenceErrorBody(message = knownInferenceMessage, code = "MODEL_OUTPUT_INVALID") {
  return JSON.stringify({ error: { code, message } });
}

function assertInferenceFailure(result, code = "UPSTREAM_RESPONSE_ERROR", status = 502) {
  assert.equal(result.status, status);
  const payload = JSON.parse(result.body);
  assert.deepEqual(Object.keys(payload), ["error"]);
  assert.deepEqual(Object.keys(payload.error).sort(), ["code", "message"]);
  assert.equal(payload.error.code, code);
  assert.equal(typeof payload.error.message, "string");
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["content-length"], String(Buffer.byteLength(result.body)));
  assert.doesNotMatch(result.body, /MODEL_OUTPUT_INVALID|private-prompt-canary|private-provider-path|private-provider-response/u);
}

test("MLX certified failures expose only reviewed fixed codes for JSON and streamed requests", async (t) => {
  for (const stream of [false, true]) {
    for (const [message, code] of inferenceErrors) {
      await t.test(`${code}: stream=${stream}: ${message}`, async (t) => {
        const h = await harness(t, { routeChanges: reviewedRoute, reply(response) {
          response.writeHead(502, { "content-type": "application/json; charset=utf-8", "content-encoding": "identity",
            "x-provider-diagnostic": "private-provider-path", "set-cookie": "private-prompt-canary=1" });
          response.end(inferenceErrorBody(message));
        } });
        const result = await post(h.port, { stream }, { authorization: "Bearer private-prompt-canary" });
        assertInferenceFailure(result, code);
        assert.equal(result.headers["x-provider-diagnostic"], undefined);
        assert.equal(result.headers["set-cookie"], undefined);
        assert.doesNotMatch(result.body, /response.completed|response.failed|function_call/u);
        assert.equal(h.requests.length, 1);
        assert.equal(h.credentialReads(), 0);
        assert.deepEqual(h.usage, [{ providerId: "kolibri", status: "unavailable" }]);
      });
    }
  }
});

test("MLX error classification bounds bytes and rejects ambiguous or sensitive envelopes", async (t) => {
  const known = inferenceErrorBody();
  const cases = [
    ["unknown message", inferenceErrorBody("Unknown private-prompt-canary")],
    ["known message with sensitive suffix", inferenceErrorBody(`${knownInferenceMessage} private-provider-path`)],
    ["wrong runtime error code", inferenceErrorBody(knownInferenceMessage, "MODEL_UNAVAILABLE")],
    ["extra outer field", JSON.stringify({ error: { code: "MODEL_OUTPUT_INVALID", message: knownInferenceMessage },
      prompt: "private-prompt-canary" })],
    ["extra error field", JSON.stringify({ error: { code: "MODEL_OUTPUT_INVALID", message: knownInferenceMessage,
      path: "private-provider-path" } })],
    ["duplicate envelope", `{"error":{"code":"MODEL_OUTPUT_INVALID","message":"private-prompt-canary"},"error":${JSON.stringify({ code: "MODEL_OUTPUT_INVALID", message: knownInferenceMessage })}}`],
    ["duplicate code", `{"error":{"code":"private-prompt-canary","code":"MODEL_OUTPUT_INVALID","message":${JSON.stringify(knownInferenceMessage)}}}`],
    ["duplicate escaped message", `{"error":{"code":"MODEL_OUTPUT_INVALID","message":"private-prompt-canary","messa\\u0067e":${JSON.stringify(knownInferenceMessage)}}}`],
    ["oversized valid JSON", known + " ".repeat(4097 - Buffer.byteLength(known))],
    ["oversized sensitive output", "private-prompt-canary".repeat(300)],
    ["invalid UTF8", Buffer.concat([Buffer.from(known), Buffer.from([0xff])])],
    ["malformed JSON", `${known} private-prompt-canary`],
    ["empty body", ""],
  ];
  for (const [label, body] of cases) {
    await t.test(label, async (t) => {
      const h = await harness(t, { routeChanges: reviewedRoute, reply(response) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(body);
      } });
      const result = await post(h.port, {});
      assertInferenceFailure(result);
      assert.equal(h.requests.length, 1);
      assert.deepEqual(h.usage, [{ providerId: "kolibri", status: "unavailable" }]);
    });
  }
});

test("MLX error classification accepts a clean chunked EOF and the exact byte bound", async (t) => {
  for (const padding of [0, 4096 - Buffer.byteLength(inferenceErrorBody())]) {
    await t.test(`padding=${padding}`, async (t) => {
      const h = await harness(t, { routeChanges: reviewedRoute, reply(response) {
        response.writeHead(502, { "content-type": "application/json" });
        const body = inferenceErrorBody() + " ".repeat(padding);
        response.write(body.slice(0, 13));
        setImmediate(() => response.end(body.slice(13)));
      } });
      const result = await post(h.port, {});
      assertInferenceFailure(result, knownInferenceCode);
      assert.equal(h.requests.length, 1);
    });
  }
});

test("MLX error classification never commits a complete JSON body without clean EOF", async (t) => {
  const h = await harness(t, { routeChanges: reviewedRoute, reply(response) {
    response.writeHead(502, { "content-type": "application/json" });
    response.write(inferenceErrorBody());
    setTimeout(() => response.destroy(), 20);
  } });
  const result = await post(h.port, {});
  assert.equal(result.status, 502);
  assert.ok(["UPSTREAM_ABORTED", "UPSTREAM_RESPONSE_ERROR"].includes(JSON.parse(result.body).error.code));
  assertInferenceFailure(result, JSON.parse(result.body).error.code);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.usage, [{ providerId: "kolibri", status: "unavailable" }]);
});

test("MLX client abort closes an unfinished error-body read without publishing a classification", { timeout: 2000 }, async (t) => {
  let signalBodyObserved;
  let signalUpstreamClosed;
  let signalProxyFinished;
  const bodyObserved = new Promise((resolve) => { signalBodyObserved = resolve; });
  const upstreamClosed = new Promise((resolve) => { signalUpstreamClosed = resolve; });
  const proxyFinished = new Promise((resolve) => { signalProxyFinished = resolve; });
  let upstreamCloseCount = 0;
  let proxyFinishCount = 0;
  const h = await harness(t, {
    routeChanges: reviewedRoute,
    httpTransport: { request(target, options, callback) {
      return http.request(target, options, (incoming) => {
        incoming.once("data", signalBodyObserved);
        callback(incoming);
      });
    } },
    reply(response) {
      response.once("close", () => {
        upstreamCloseCount += 1;
        signalUpstreamClosed();
      });
      response.writeHead(502, { "content-type": "application/json" });
      // A valid reviewed JSON body without HTTP EOF must remain uncommitted.
      response.write(inferenceErrorBody());
    },
    onProxyFinished() {
      proxyFinishCount += 1;
      signalProxyFinished();
    },
  });
  const bytes = Buffer.from(JSON.stringify({ model: SLUG, input: "Public test" }));
  const client = http.request({ hostname: "127.0.0.1", port: h.port, path: "/v1/responses", method: "POST",
    headers: { "content-type": "application/json", "content-length": String(bytes.length) },
  });
  t.after(() => client.destroy());
  let clientResponseCount = 0;
  client.on("response", (response) => {
    clientResponseCount += 1;
    response.resume();
  });
  client.on("error", () => {});
  const clientClosed = new Promise((resolve) => client.once("close", resolve));
  client.end(bytes);
  await bodyObserved;
  assert.equal(clientResponseCount, 0);
  client.destroy();
  await Promise.all([clientClosed, upstreamClosed, proxyFinished]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clientResponseCount, 0);
  assert.equal(upstreamCloseCount, 1);
  assert.equal(proxyFinishCount, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.credentialReads(), 0);
  assert.deepEqual(h.usage, [{ providerId: "kolibri", status: "unavailable" }]);
});

test("MLX error-body reads retain idle and total deadlines without classifying partial output", async (t) => {
  for (const [code, limits] of [
    ["UPSTREAM_IDLE_TIMEOUT", { streamIdleTimeoutMs: 40, upstreamTotalTimeoutMs: 500 }],
    ["UPSTREAM_TOTAL_TIMEOUT", { streamIdleTimeoutMs: 500, upstreamTotalTimeoutMs: 40 }],
  ]) {
    await t.test(code, async (t) => {
      const h = await harness(t, { routeChanges: reviewedRoute, limits, reply(response) {
        response.writeHead(502, { "content-type": "application/json" });
        response.write(inferenceErrorBody());
      } });
      const result = await post(h.port, {});
      assertInferenceFailure(result, code, 504);
      assert.equal(h.requests.length, 1);
      assert.deepEqual(h.usage, [{ providerId: "kolibri", status: "unavailable" }]);
    });
  }
});

test("MLX fixed failures require exact HTTP status and reviewed JSON identity transport", async (t) => {
  for (const [label, status, headers] of [
    ["400", 400, { "content-type": "application/json" }],
    ["503", 503, { "content-type": "application/json" }],
    ["200", 200, { "content-type": "application/json" }],
    ["unknown JSON MIME", 502, { "content-type": "application/problem+json" }],
    ["text MIME", 502, { "content-type": "text/plain" }],
    ["missing MIME", 502, {}],
    ["gzip encoding", 502, { "content-type": "application/json", "content-encoding": "gzip" }],
  ]) {
    await t.test(label, async (t) => {
      const h = await harness(t, { routeChanges: reviewedRoute, reply(response) {
        response.writeHead(status, headers);
        response.end(inferenceErrorBody());
      } });
      assertInferenceFailure(await post(h.port, {}), "UPSTREAM_RESPONSE_ERROR", status === 200 ? 502 : status);
      assert.equal(h.requests.length, 1);
    });
  }
});

test("MLX error classification does not grant authority to text-only routes or private probes", async (t) => {
  for (const [label, routeChanges, headers] of [
    ["uncertified reviewed protocol", { toolsEnabled: false, mlxCapabilities: toolCapabilities }, {}],
    ["catalog grant without reviewed protocol", { toolsEnabled: true }, {}],
    ["private probe without ordinary receipt", { toolsEnabled: false, mlxCapabilities: toolCapabilities },
      { "x-pickermux-certification": "private-certification-marker" }],
  ]) {
    await t.test(label, async (t) => {
      const h = await harness(t, { routeChanges, reply(response) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(inferenceErrorBody());
      } });
      assertInferenceFailure(await post(h.port, {}, headers));
      assert.equal(h.requests.length, 1);
      assert.equal(h.credentialReads(), 0);
    });
  }
});

test("MLX error projection leaves native and adjacent Responses provider failures byte preserving", async (t) => {
  for (const providerKind of ["lmstudio-responses", "openai-responses", "native-openai"]) {
    await t.test(providerKind, async (t) => {
      const bytes = `${inferenceErrorBody()}\n`;
      const h = await harness(t, { routeChanges: { ...reviewedRoute, providerKind,
        ...(providerKind === "native-openai" ? { kind: "native-openai" } : {}),
      }, reply(response) {
        response.writeHead(502, { "content-type": "application/json", "content-length": String(Buffer.byteLength(bytes)) });
        response.end(bytes);
      } });
      const result = await post(h.port, {}, { authorization: "Bearer native-canary" });
      assert.equal(result.status, 502);
      assert.equal(result.body, bytes);
      assert.equal(h.requests.length, 1);
      assert.equal(h.requests[0].path, "/v1/responses");
      assert.equal(h.requests[0].headers.authorization,
        providerKind === "native-openai" ? "Bearer native-canary" : "Bearer private-provider-secret");
      assert.equal(h.credentialReads(), providerKind === "native-openai" ? 0 : 1);
    });
  }
});
