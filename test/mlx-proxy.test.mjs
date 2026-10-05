import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createResponsesProxy } from "../src/responses-proxy.mjs";

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

async function harness(t, { routeChanges = {}, reply, gate = async () => {} } = {}) {
  const requests = [];
  const usage = [];
  let credentialReads = 0;
  const upstreamPort = await listen(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks)) });
    if (reply) return reply(response);
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

test("MLX rejects forced tools, history, attachments, compaction and certification before I/O", async (t) => {
  const h = await harness(t, { routeChanges: { toolsEnabled: true } });
  for (const [body, headers, endpoint] of [
    [{ tool_choice: "required" }, {}, undefined],
    [{ input: [{ type: "function_call", call_id: "call", name: "exec", arguments: "{}" }] }, {}, undefined],
    [{ input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.invalid/image" }] }] }, {}, undefined],
    [{ previous_response_id: "previous" }, {}, undefined],
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
