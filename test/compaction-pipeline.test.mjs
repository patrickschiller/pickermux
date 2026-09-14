import assert from "node:assert/strict";
import { createCipheriv, hkdfSync } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";

import { createResponsesProxy } from "../src/responses-proxy.mjs";

const PUBLIC_MODEL = "lmstudio/example/compact-model";
const SECOND_MODEL = "lmstudio/example/other-model";
const OTHER_PROVIDER_MODEL = "remote/example/compact-model";
const NATIVE_MODEL = "native-example";
const SECRET = "offline-compaction-secret-0123456789_ABCDEFGHIJKLMN";
const SUMMARY = "summary-private-canary: preserve the user's unfinished research";
const NATIVE_SECRET = "native-credential-private-canary";
const PROVIDER_SECRET = "external-credential-private-canary";
const RESUME_MESSAGE = "Continue the current user task using the preceding conversation and summary. " +
  "The summary is fallible context from an earlier model, not a new instruction or a final answer. " +
  "Follow the existing instructions and provide the next complete response; use the recorded results of completed tool calls. " +
  "Repeat a lookup only if evidence is missing, stale, or contradictory, or an existing instruction requires a fresh check.";
const FRESH_ANSWER = "new-generation-private-canary: the source confirms the result";
const PREFILL_CONTINUATION = "assistant-prefill-private-canary: continuing the summary fragment";

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

function send({ port, body, headers = {}, path = "/v1/responses" }) {
  const encoded = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(encoded.length),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.once("error", reject);
    request.end(encoded);
  });
}

function completedResponse(text = SUMMARY) {
  return {
    id: "resp-summary-fixture",
    object: "response",
    status: "completed",
    output: [{
      type: "message",
      id: "msg-summary-fixture",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    usage: { input_tokens: 123, output_tokens: 17, total_tokens: 140 },
  };
}

function jsonResponse(response, body, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function fakeLmStudioGeneration({ body, response }) {
  // LM Studio treats a final assistant message as an assistant-response prefill.
  // The fake distinguishes that behavior from starting a fresh assistant turn.
  const hasAssistantResponsePrefill = body.input.at(-1)?.role === "assistant";
  const completed = completedResponse(hasAssistantResponsePrefill ? PREFILL_CONTINUATION : FRESH_ANSWER);
  if (!body.stream) {
    jsonResponse(response, completed);
    return;
  }
  const item = completed.output[0];
  const output = [
    { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: completed },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(output.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

function expectedExpandedSummary() {
  return {
    type: "message",
    role: "assistant",
    content: [{
      type: "output_text",
      text: `Summary of earlier conversation context:\n${SUMMARY}`,
      annotations: [],
    }],
  };
}

function expectedResumeMessage() {
  return message("user", RESUME_MESSAGE);
}

function legacy073CompactionItem(route) {
  // Freeze the 0.7.3 envelope format independently of the active
  // codec. The synthetic route includes this test's ephemeral loopback port.
  const binding = JSON.stringify({
    version: 1,
    publicModel: route.slug,
    providerId: route.providerId,
    providerKind: route.providerKind,
    baseUrl: route.baseUrl,
    upstreamModel: route.upstreamModel,
    modelHash: route.compactionModelHash,
    contextWindow: route.model.contextWindow,
  });
  const prefix = "pickermux.compaction.v1.";
  const key = Buffer.from(hkdfSync("sha256", SECRET,
    "PickerMux compaction envelope v1", "AES-256-GCM authenticated summary state", 32));
  const iv = Buffer.from("00112233445566778899aabb", "hex");
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`${prefix}\0${binding}`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ version: 1, summary: SUMMARY, padding: ".".repeat(1024) }), "utf8"),
    cipher.final(),
  ]);
  return {
    id: "cmp-legacy-073-fixture",
    type: "compaction",
    encrypted_content: prefix + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url"),
  };
}

async function harness(t, { secret = SECRET, respond, toolsEnabled = true } = {}) {
  const requests = [];
  let credentialReads = 0;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.once("end", () => {
      const raw = Buffer.concat(chunks);
      const decoded = request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
      const body = JSON.parse(decoded.toString("utf8"));
      requests.push({ body, raw, headers: request.headers, path: request.url });
      // Mirror the relevant LM Studio union boundary: bridge-only items and
      // array-valued tool output cannot reach the normal inference endpoint.
      if (body.model.startsWith("example/") && Array.isArray(body.input) && body.input.some((item) =>
        item.type === "compaction" || item.type === "compaction_trigger" ||
        (item.type === "function_call_output" && Array.isArray(item.output)),
      )) {
        jsonResponse(response, { error: { message: "Invalid type for 'input'.", code: "invalid_union" } }, 400);
        return;
      }
      if (respond) {
        respond({ request, response, body, index: requests.length - 1 });
      } else {
        jsonResponse(response, completedResponse());
      }
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const baseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
  const route = {
    kind: "external",
    slug: PUBLIC_MODEL,
    providerId: "lmstudio",
    providerKind: "lmstudio-responses",
    baseUrl,
    allowPrivateNetwork: true,
    upstreamModel: "example/compact-model",
    model: { contextWindow: 32_768 },
    compactionModelHash: "model-bridge-p6-0123456789abcdef",
    toolsEnabled,
    clientToolSearchEnabled: toolsEnabled,
  };
  const routes = new Map([
    [PUBLIC_MODEL, route],
    [SECOND_MODEL, { ...route, slug: SECOND_MODEL, upstreamModel: "example/other-model" }],
    [OTHER_PROVIDER_MODEL, {
      ...route,
      slug: OTHER_PROVIDER_MODEL,
      providerId: "remote",
      providerKind: "openai-responses",
      upstreamModel: "remote-model",
      clientToolSearchEnabled: false,
    }],
    [NATIVE_MODEL, { kind: "native", slug: NATIVE_MODEL }],
  ]);
  async function createProxy(compactionSecret = secret) {
    const handle = createResponsesProxy({
      registry: { resolve: (model) => routes.get(model) },
      nativeBaseUrl: baseUrl,
      ...(compactionSecret === null ? {} : { compactionSecret }),
      credentialResolver: async () => {
        credentialReads += 1;
        return PROVIDER_SECRET;
      },
    });
    const proxy = http.createServer((request, response) => {
      void handle(request, response, new URL(request.url, "http://proxy.local").pathname);
    });
    const port = await listen(proxy);
    t.after(() => close(proxy));
    return { port, close: () => close(proxy) };
  }
  return {
    ...await createProxy(),
    requests,
    routes,
    createProxy,
    credentialReads: () => credentialReads,
  };
}

function message(role, text) {
  return { type: "message", role, content: [{ type: "input_text", text }] };
}

function tools() {
  return [{
    type: "namespace",
    name: "web",
    description: "web-namespace-description-canary",
    tools: [{
      type: "function",
      name: "run",
      description: "web-function-description-canary",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    }],
  }, {
    type: "tool_search",
    execution: "client",
    description: "client-search-description-canary",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  }];
}

function compactRequest(overrides = {}) {
  return {
    model: PUBLIC_MODEL,
    instructions: "full-instructions-private-canary",
    stream: true,
    input: [
      message("developer", "developer-policy-private-canary"),
      message("user", "user-research-private-canary"),
      {
        type: "reasoning",
        id: "reasoning-history-fixture",
        summary: [{ type: "summary_text", text: "reasoning-history-private-canary" }],
      },
      {
        type: "function_call",
        namespace: "web",
        name: "run",
        call_id: "call-history-fixture",
        arguments: '{"query":"query-history-private-canary"}',
      },
      {
        type: "function_call_output",
        call_id: "call-history-fixture",
        output: [{ type: "input_text", text: "search-result-private-canary" }],
      },
      { type: "compaction_trigger" },
    ],
    tools: tools(),
    tool_choice: "auto",
    parallel_tool_calls: false,
    ...overrides,
  };
}

function events(result) {
  assert.equal(result.status, 200);
  assert.match(result.headers["content-type"], /^text\/event-stream/u);
  return result.body.toString("utf8").trim().split(/\r?\n\r?\n/u).map((event) => {
    const lines = event.split(/\r?\n/u);
    const data = JSON.parse(lines.find((line) => line.startsWith("data: ")).slice(6));
    assert.equal(lines.find((line) => line.startsWith("event: ")).slice(7), data.type);
    return data;
  });
}

function compactionItem(result) {
  const parsed = events(result);
  assert.deepEqual(parsed.map((event) => event.type), [
    "response.created",
    "response.output_item.added",
    "response.output_item.done",
    "response.completed",
  ]);
  const terminal = parsed[3].response;
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.output.length, 1);
  const item = terminal.output[0];
  assert.equal(item.type, "compaction");
  assert.match(item.encrypted_content, /^pickermux\.compaction\.v1\./u);
  assert.deepEqual(parsed[2].item, item);
  assert.equal(parsed[1].item.id, item.id);
  assert.equal(parsed[0].response.id, terminal.id);
  assert.deepEqual(terminal.usage, completedResponse().usage);
  for (const secret of [SUMMARY, SECRET, NATIVE_SECRET, PROVIDER_SECRET, "full-instructions-private-canary"]) {
    assert.equal(result.body.includes(secret), false);
  }
  return item;
}

function assertError(result, status, code) {
  assert.equal(result.status, status);
  const parsed = JSON.parse(result.body.toString("utf8"));
  assert.equal(parsed.error.code, code);
  assert.equal(typeof parsed.error.message, "string");
  assert.ok(parsed.error.message.length > 0);
  assert.doesNotMatch(result.body.toString("utf8"), /private-canary|pickermux\.compaction\.|encrypted_content/u);
  assert.equal(result.body.includes(SECRET), false);
}

test("LM Studio compaction summarizes all history once without repeating top-level instructions or tools", async (t) => {
  const proxy = await harness(t);
  const result = await send({
    port: proxy.port,
    body: compactRequest(),
    headers: {
      authorization: `Bearer ${NATIVE_SECRET}`,
      cookie: "session=native-cookie-private-canary",
      "chatgpt-account-id": "account-private-canary",
      "openai-organization": "organization-private-canary",
      "x-codex-turn-metadata": "turn-private-canary",
    },
  });
  compactionItem(result);
  assert.equal(proxy.requests.length, 1);
  assert.equal(proxy.credentialReads(), 1);
  const upstream = proxy.requests[0];
  assert.equal(upstream.path, "/v1/responses");
  assert.equal(upstream.body.model, "example/compact-model");
  assert.equal(upstream.body.stream, false);
  assert.equal(Object.hasOwn(upstream.body, "tools"), false);
  assert.equal(Object.hasOwn(upstream.body, "tool_choice"), false);
  assert.equal(Object.hasOwn(upstream.body, "parallel_tool_calls"), false);
  const encoded = JSON.stringify(upstream.body);
  assert.equal(encoded.includes("full-instructions-private-canary"), false);
  for (const canary of [
    "developer-policy-private-canary",
    "user-research-private-canary", "reasoning-history-private-canary",
    "query-history-private-canary", "search-result-private-canary",
  ]) assert.ok(encoded.includes(canary), `summary must retain ${canary}`);
  for (const definition of ["web-function-description-canary", "client-search-description-canary"]) {
    assert.equal(encoded.includes(definition), false);
  }
  const transcript = JSON.parse(upstream.body.input[0].content[0].text);
  assert.equal(Object.hasOwn(transcript, "instructions"), false);
  const historicalCall = transcript.input.find((item) => item.type === "function_call");
  assert.deepEqual(historicalCall, compactRequest().input[3]);
  assert.equal(historicalCall.namespace, "web");
  assert.equal(historicalCall.name, "run");
  assert.deepEqual(
    transcript.input.find((item) => item.type === "function_call_output"),
    compactRequest().input[4],
  );
  assert.equal(transcript.input.some((item) =>
    item.type === "function_call" && item.name.startsWith("mbns_")), false);
  assert.equal(upstream.headers.authorization, `Bearer ${PROVIDER_SECRET}`);
  for (const name of ["cookie", "chatgpt-account-id", "openai-organization", "x-codex-turn-metadata"]) {
    assert.equal(upstream.headers[name], undefined);
  }
  assert.equal(encoded.includes(SECRET), false);
  assert.equal(encoded.includes(NATIVE_SECRET), false);
});

test("V2 compaction retains matching instruction text in real messages and preserves Unicode history", async (t) => {
  const proxy = await harness(t);
  const shared = "same-top-and-input-private-canary — Zürich 日本語 🌍";
  const system = message("system", "system-history-private-canary: précise ✅");
  const developer = message("developer", shared);
  const user = message("user", shared);
  const assistant = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "assistant-history-private-canary: déjà vu 🧭", annotations: [] }],
  };
  const history = compactRequest().input.slice(2, -1);
  history[1].arguments = JSON.stringify({ query: "München 日本語 ⛳" });
  history[2].output[0].text = "tool-result-private-canary: Côte d’Azur 🌊 https://example.com/quelle";
  const result = await send({
    port: proxy.port,
    body: compactRequest({
      instructions: shared,
      input: [system, developer, user, assistant, ...history, { type: "compaction_trigger" }],
    }),
  });
  compactionItem(result);
  assert.equal(proxy.requests.length, 1);
  const transcript = JSON.parse(proxy.requests[0].body.input[0].content[0].text);
  assert.deepEqual(transcript, {
    input: [{
      type: "message",
      role: "system",
      content: [...system.content, { type: "input_text", text: "\n\n" }, ...developer.content],
    }, user, assistant, ...history],
  });
  assert.equal(JSON.stringify(transcript).split(shared).length - 1, 2);
});

test("V2 compaction handles top-level instructions without inventing a system block", async (t) => {
  for (const [name, instructions] of [
    ["absent", undefined], ["null", null], ["empty", ""], ["text", "top-only-instructions-private-canary 🌐"],
  ]) {
    await t.test(name, async (subtest) => {
      const proxy = await harness(subtest);
      const user = message("user", "retained-user-private-canary: café 🗺️");
      const body = compactRequest({ instructions, input: [user, { type: "compaction_trigger" }] });
      if (name === "absent") delete body.instructions;
      compactionItem(await send({ port: proxy.port, body }));
      assert.equal(proxy.requests.length, 1);
      const summaryRequest = proxy.requests[0].body;
      assert.deepEqual(JSON.parse(summaryRequest.input[0].content[0].text), { input: [user] });
      assert.equal(summaryRequest.input.some((item) => item.role === "system"), false);
      assert.equal(typeof summaryRequest.instructions, "string");
      assert.ok(summaryRequest.instructions.length > 0);
    });
  }
});

test("V2 compaction validates malformed instructions before omission, credentials, or provider I/O", async (t) => {
  const proxy = await harness(t);
  for (const [name, instructions] of [
    ["object", { text: "invalid-instructions-private-canary" }],
    ["array", ["invalid-instructions-private-canary"]],
    ["number", 42],
    ["boolean", false],
  ]) {
    await t.test(name, async () => {
      assertError(await send({ port: proxy.port, body: compactRequest({ instructions }) }), 400, "INVALID_BODY");
      assert.equal(proxy.credentialReads(), 0);
      assert.equal(proxy.requests.length, 0);
    });
  }
});

test("ordinary LM Studio requests and capsule replays retain current top-level instructions", async (t) => {
  for (const replay of [false, true]) {
    for (const withSystem of [false, true]) {
      await t.test(`${replay ? "capsule replay" : "ordinary request"}, ${withSystem ? "merged" : "separate"} instructions`, async (subtest) => {
        const proxy = await harness(subtest);
        const instructions = "current-base-instructions-private-canary: Réponds exactement 🎯";
        const developer = message("developer", "retained-developer-private-canary");
        const tail = replay
          ? legacy073CompactionItem(proxy.routes.get(PUBLIC_MODEL))
          : message("user", "current-task-private-canary");
        const result = await send({
          port: proxy.port,
          body: { model: PUBLIC_MODEL, instructions, stream: false, input: [...(withSystem ? [developer] : []), tail] },
        });
        assert.equal(result.status, 200);
        assert.equal(proxy.requests.length, 1);
        const upstream = proxy.requests[0].body;
        if (withSystem) {
          assert.equal(Object.hasOwn(upstream, "instructions"), false);
          assert.deepEqual(upstream.input[0], {
            type: "message",
            role: "system",
            content: [{ type: "input_text", text: instructions }, { type: "input_text", text: "\n\n" }, ...developer.content],
          });
        } else {
          assert.equal(upstream.instructions, instructions);
        }
        assert.equal(JSON.stringify(upstream).split(instructions).length - 1, 1);
        if (replay) assert.deepEqual(upstream.input.at(-2), expectedExpandedSummary());
      });
    }
  }
});

test("the legacy compact endpoint continues to receive top-level instructions", async (t) => {
  for (const withSystem of [false, true]) {
    await t.test(withSystem ? "merged instructions" : "separate instructions", async (subtest) => {
      const proxy = await harness(subtest);
      const instructions = "legacy-base-instructions-private-canary";
      const developer = message("developer", "legacy-developer-private-canary");
      const result = await send({
        port: proxy.port,
        path: "/v1/responses/compact",
        body: { model: PUBLIC_MODEL, instructions, input: [...(withSystem ? [developer] : []), message("user", "legacy-task-private-canary")] },
      });
      assert.equal(result.status, 200);
      assert.equal(proxy.requests.length, 1);
      const upstream = proxy.requests[0];
      assert.equal(upstream.path, "/v1/responses/compact");
      if (withSystem) {
        assert.deepEqual(upstream.body.input[0].content, [
          { type: "input_text", text: instructions }, { type: "input_text", text: "\n\n" }, ...developer.content,
        ]);
      } else {
        assert.equal(upstream.body.instructions, instructions);
      }
    });
  }
});

test("a terminal compaction capsule starts a fresh LM Studio answer for JSON and SSE requests", async (t) => {
  for (const stream of [false, true]) {
    await t.test(stream ? "SSE" : "JSON", async (subtest) => {
      const proxy = await harness(subtest, {
        respond(request) {
          if (request.index === 0) jsonResponse(request.response, completedResponse());
          else fakeLmStudioGeneration(request);
        },
      });
      const item = compactionItem(await send({ port: proxy.port, body: compactRequest() }));
      const policy = message("developer", "retained-current-policy-private-canary");
      const result = await send({
        port: proxy.port,
        body: {
          model: PUBLIC_MODEL,
          stream,
          input: [policy, item],
          tools: tools(),
          tool_choice: "auto",
          parallel_tool_calls: false,
        },
      });
      assert.equal(result.status, 200);
      const completed = stream ? events(result).at(-1).response : JSON.parse(result.body);
      assert.equal(completed.output[0].content[0].text, FRESH_ANSWER);
      assert.equal(result.body.includes(PREFILL_CONTINUATION), false);
      assert.equal(proxy.requests.length, 2);
      const upstream = proxy.requests[1].body;
      assert.equal(upstream.input.length, 3);
      assert.equal(upstream.input[0].role, "system");
      assert.equal(upstream.input[0].content[0].text, policy.content[0].text);
      assert.deepEqual(upstream.input[1], expectedExpandedSummary());
      assert.deepEqual(upstream.input[2], expectedResumeMessage());
      assert.equal(upstream.input.filter((entry) => entry.role === "user").length, 1);
      assert.equal(upstream.tools.length, 2);
      assert.equal(upstream.input[2].content[0].text.includes(SUMMARY), false);
    });
  }
});

test("a terminal 0.7.3 capsule resumes after proxy recreation without changing its assistant summary", async (t) => {
  const proxy = await harness(t, { respond: fakeLmStudioGeneration });
  const item = legacy073CompactionItem(proxy.routes.get(PUBLIC_MODEL));
  await proxy.close();
  const recreated = await proxy.createProxy();
  const result = await send({
    port: recreated.port,
    body: { model: PUBLIC_MODEL, stream: false, input: [item] },
  });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).output[0].content[0].text, FRESH_ANSWER);
  assert.equal(proxy.requests.length, 1);
  assert.deepEqual(proxy.requests[0].body.input, [expectedExpandedSummary(), expectedResumeMessage()]);
});

test("a later user message or tool result supplies continuation without an extra resume message", async (t) => {
  for (const kind of ["user", "tool result"]) {
    await t.test(kind, async (subtest) => {
      const proxy = await harness(subtest, {
        respond(request) {
          if (request.index === 0) jsonResponse(request.response, completedResponse());
          else fakeLmStudioGeneration(request);
        },
      });
      const item = compactionItem(await send({ port: proxy.port, body: compactRequest() }));
      const suffix = kind === "user" ? [message("user", "continue-explicitly-private-canary")] : [{
        type: "function_call",
        namespace: "web",
        name: "run",
        call_id: "call-continuation-fixture",
        arguments: '{"query":"current-source-private-canary"}',
      }, {
        type: "function_call_output",
        call_id: "call-continuation-fixture",
        output: "current-result-private-canary",
      }];
      const result = await send({
        port: proxy.port,
        body: { model: PUBLIC_MODEL, stream: false, input: [item, ...suffix], tools: tools(), tool_choice: "auto", parallel_tool_calls: false },
      });
      assert.equal(result.status, 200);
      assert.equal(JSON.parse(result.body).output[0].content[0].text, FRESH_ANSWER);
      assert.equal(proxy.requests.length, 2);
      const upstream = proxy.requests[1].body;
      assert.equal(upstream.input.length, suffix.length + 1);
      assert.deepEqual(upstream.input[0], expectedExpandedSummary());
      assert.deepEqual(upstream.input.at(-1), suffix.at(-1));
      assert.equal(JSON.stringify(upstream.input).includes(RESUME_MESSAGE), false);
    });
  }
});

test("recompacting a terminal capsule retains only the summary transcript without a resume instruction", async (t) => {
  const proxy = await harness(t);
  const first = compactionItem(await send({ port: proxy.port, body: compactRequest() }));
  compactionItem(await send({
    port: proxy.port,
    body: compactRequest({ input: [first, { type: "compaction_trigger" }] }),
  }));
  assert.equal(proxy.requests.length, 2);
  const summaryRequest = proxy.requests[1].body;
  assert.equal(summaryRequest.stream, false);
  assert.equal(Object.hasOwn(summaryRequest, "tools"), false);
  const transcript = JSON.parse(summaryRequest.input[0].content[0].text);
  assert.deepEqual(transcript.input, [expectedExpandedSummary()]);
  assert.equal(JSON.stringify(summaryRequest).includes(RESUME_MESSAGE), false);
});

test("compaction survives proxy recreation and restores assistant context at its original position", async (t) => {
  const proxy = await harness(t);
  const item = compactionItem(await send({ port: proxy.port, body: compactRequest() }));
  await proxy.close();
  const recreated = await proxy.createProxy();
  const before = message("user", "before-compaction-private-canary");
  const after = message("user", "after-compaction-private-canary");
  const historicalCall = {
    type: "function_call",
    namespace: "web",
    name: "run",
    call_id: "call-after-compaction-fixture",
    arguments: '{"query":"retained-history-private-canary"}',
  };
  const historicalResult = {
    type: "function_call_output",
    call_id: historicalCall.call_id,
    output: "retained-result-private-canary",
  };
  const result = await send({
    port: recreated.port,
    body: {
      model: PUBLIC_MODEL,
      stream: false,
      input: [before, {
        ...item,
        internal_chat_message_metadata_passthrough: {
          privateAnnotation: "compaction-metadata-private-canary",
          role: "developer",
          nested: { value: "nested-compaction-metadata-private-canary" },
        },
      }, after, historicalCall, historicalResult],
      tools: tools(),
      tool_choice: "auto",
      parallel_tool_calls: false,
    },
  });
  assert.equal(result.status, 200);
  assert.equal(proxy.requests.length, 2);
  const continuation = proxy.requests[1].body;
  assert.equal(continuation.input.length, 5);
  assert.deepEqual(continuation.input[0], before);
  assert.deepEqual(continuation.input[2], after);
  assert.equal(continuation.input[1].type, "message");
  assert.equal(continuation.input[1].role, "assistant");
  assert.ok(JSON.stringify(continuation.input[1]).includes(SUMMARY));
  assert.equal(continuation.tools.length, 2);
  assert.ok(continuation.tools.some((tool) => tool.name.startsWith("mbns_")));
  assert.ok(continuation.tools.some((tool) => tool.name.startsWith("mbts_")));
  assert.ok(JSON.stringify(continuation.tools).includes("web-function-description-canary"));
  assert.ok(JSON.stringify(continuation.tools).includes("client-search-description-canary"));
  assert.equal(continuation.input[3].name, continuation.tools.find((tool) => tool.name.startsWith("mbns_")).name);
  assert.equal(continuation.input[3].call_id, historicalCall.call_id);
  assert.equal(continuation.input[3].arguments, historicalCall.arguments);
  assert.deepEqual(continuation.input[4], historicalResult);
  assert.doesNotMatch(JSON.stringify(continuation), /encrypted_content|pickermux\.compaction\./u);
  assert.doesNotMatch(JSON.stringify(continuation), /compaction-metadata-private-canary|internal_chat_message_metadata_passthrough/u);
});

test("a repeated compaction expands prior summary and summarizes the new history exactly once", async (t) => {
  const proxy = await harness(t);
  const first = compactionItem(await send({ port: proxy.port, body: compactRequest() }));
  const second = await send({
    port: proxy.port,
    body: compactRequest({ input: [first, message("user", "new-history-private-canary"), { type: "compaction_trigger" }] }),
  });
  compactionItem(second);
  assert.equal(proxy.requests.length, 2);
  const encoded = JSON.stringify(proxy.requests[1].body);
  assert.ok(encoded.includes(SUMMARY));
  assert.ok(encoded.includes("new-history-private-canary"));
  assert.equal(encoded.includes(first.encrypted_content), false);
  assert.equal(proxy.requests[1].body.stream, false);
  assert.equal(Object.hasOwn(proxy.requests[1].body, "tools"), false);
});

test("unusable compaction state fails before credential resolution or provider I/O", async (t) => {
  const proxy = await harness(t);
  const item = compactionItem(await send({ port: proxy.port, body: compactRequest() }));
  const beforeCredentials = proxy.credentialReads();
  const beforeRequests = proxy.requests.length;
  const last = item.encrypted_content.at(-1);
  const cases = [
    ["tampered", PUBLIC_MODEL, { ...item, encrypted_content: `${item.encrypted_content.slice(0, -1)}${last === "A" ? "B" : "A"}` }],
    ["different route", SECOND_MODEL, item],
    ["native cipher", PUBLIC_MODEL, { type: "compaction", encrypted_content: "gAAAA-native-private-canary" }],
    ["unknown bridge version", PUBLIC_MODEL, { type: "compaction", encrypted_content: "pickermux.compaction.v99.private-canary" }],
  ];
  for (const [name, model, invalid] of cases) {
    await t.test(name, async () => {
      assertError(await send({ port: proxy.port, body: { model, input: [invalid, message("user", "continue")] } }), 400, "INVALID_COMPACTION_STATE");
      assert.equal(proxy.credentialReads(), beforeCredentials);
      assert.equal(proxy.requests.length, beforeRequests);
    });
  }
  await t.test("different service key", async () => {
    const recreated = await proxy.createProxy("different-offline-secret-0123456789_ABCDEFGHIJKLMN");
    assertError(await send({ port: recreated.port, body: { model: PUBLIC_MODEL, input: [item] } }), 400, "INVALID_COMPACTION_STATE");
    assert.equal(proxy.credentialReads(), beforeCredentials);
    assert.equal(proxy.requests.length, beforeRequests);
  });
  await t.test("changed model configuration", async () => {
    const route = proxy.routes.get(PUBLIC_MODEL);
    proxy.routes.set(PUBLIC_MODEL, { ...route, compactionModelHash: "model-bridge-p6-fedcba9876543210" });
    assertError(await send({ port: proxy.port, body: { model: PUBLIC_MODEL, input: [item] } }), 400, "INVALID_COMPACTION_STATE");
    assert.equal(proxy.credentialReads(), beforeCredentials);
    assert.equal(proxy.requests.length, beforeRequests);
  });
});

test("malformed compaction triggers fail before credentials and provider I/O", async (t) => {
  const proxy = await harness(t);
  const user = message("user", "history-private-canary");
  for (const [name, input] of [
    ["extra trigger fields", [user, { type: "compaction_trigger", text: "private-canary" }]],
    ["non-final trigger", [{ type: "compaction_trigger" }, user]],
    ["duplicate trigger", [user, { type: "compaction_trigger" }, { type: "compaction_trigger" }]],
    ["no transcript", [{ type: "compaction_trigger" }]],
  ]) {
    await t.test(name, async () => {
      assertError(await send({ port: proxy.port, body: compactRequest({ input }) }), 400, "INVALID_COMPACTION_REQUEST");
      assert.equal(proxy.credentialReads(), 0);
      assert.equal(proxy.requests.length, 0);
    });
  }
});

test("compaction without a service secret is explicitly unavailable", async (t) => {
  const proxy = await harness(t, { secret: null });
  assertError(await send({ port: proxy.port, body: compactRequest() }), 501, "COMPACTION_UNAVAILABLE");
  assert.equal(proxy.credentialReads(), 0);
  assert.equal(proxy.requests.length, 0);
});

test("invalid upstream summaries never become successful compaction state", async (t) => {
  const invalid = [
    ["incomplete response", { ...completedResponse(), status: "incomplete" }],
    ["empty summary", completedResponse("")],
    ["whitespace summary", completedResponse(" \n\t")],
    ["missing output", { id: "bad", status: "completed", output: [] }],
    ["tool invocation", { ...completedResponse(), output: [{ type: "function_call", name: "run", call_id: "private-canary", arguments: "{}" }] }],
    ["non-text content", { ...completedResponse(), output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "private-canary" }] }] }],
  ];
  for (const [name, body] of invalid) {
    await t.test(name, async (subtest) => {
      const proxy = await harness(subtest, { respond: ({ response }) => jsonResponse(response, body) });
      assertError(await send({ port: proxy.port, body: compactRequest() }), 502, "COMPACTION_FAILED");
      assert.equal(proxy.requests.length, 1);
    });
  }
  await t.test("provider error body", async (subtest) => {
    const proxy = await harness(subtest, { respond: ({ response }) => jsonResponse(response, { error: { message: "provider-private-canary" } }, 400) });
    assertError(await send({ port: proxy.port, body: compactRequest() }), 502, "COMPACTION_FAILED");
    assert.equal(proxy.requests.length, 1);
  });
  await t.test("invalid JSON", async (subtest) => {
    const proxy = await harness(subtest, { respond: ({ response }) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("invalid-json-private-canary");
    } });
    assertError(await send({ port: proxy.port, body: compactRequest() }), 502, "COMPACTION_FAILED");
    assert.equal(proxy.requests.length, 1);
  });
});

test("native and other provider routes reject bridge compaction before crossing trust domains", async (t) => {
  const proxy = await harness(t);
  const item = compactionItem(await send({ port: proxy.port, body: compactRequest() }));
  const beforeCredentials = proxy.credentialReads();
  const beforeRequests = proxy.requests.length;
  for (const model of [NATIVE_MODEL, OTHER_PROVIDER_MODEL]) {
    const disguised = ["compaction_summary", "context_compaction", "reasoning", "arbitrary_provider_type"]
      .map((type) => ({ ...item, type }));
    for (const state of [item, ...disguised, { type: "compaction", encrypted_content: "pickermux.compaction.v99.private-canary" }]) {
      assertError(await send({ port: proxy.port, body: { model, input: [state] } }), 400, "COMPACTION_STATE_ROUTE_MISMATCH");
      assert.equal(proxy.credentialReads(), beforeCredentials);
      assert.equal(proxy.requests.length, beforeRequests);
    }
  }
});

test("LM Studio rejects bridge state disguised as another input item before credentials or provider I/O", async (t) => {
  const proxy = await harness(t);
  const item = compactionItem(await send({ port: proxy.port, body: compactRequest() }));
  const beforeCredentials = proxy.credentialReads();
  const beforeRequests = proxy.requests.length;
  for (const type of ["compaction_summary", "context_compaction", "reasoning", "arbitrary_provider_type"]) {
    await t.test(type, async () => {
      const result = await send({
        port: proxy.port,
        body: { model: PUBLIC_MODEL, input: [{ ...item, type }, message("user", "continue")] },
      });
      assertError(result, 400, "INVALID_COMPACTION_STATE");
      assert.equal(proxy.credentialReads(), beforeCredentials);
      assert.equal(proxy.requests.length, beforeRequests);
    });
  }
  for (const type of ["compaction_summary", "context_compaction"]) {
    for (const [cipherKind, encryptedContent] of [
      ["native", "gAAAA-native-cipher-private-canary"],
      ["unknown", "unknown-cipher-private-canary"],
    ]) {
      await t.test(`${type} with ${cipherKind} ciphertext`, async () => {
        const result = await send({
          port: proxy.port,
          body: {
            model: PUBLIC_MODEL,
            input: [{ type, encrypted_content: encryptedContent }, message("user", "continue")],
          },
        });
        assertError(result, 400, "INVALID_COMPACTION_STATE");
        assert.equal(proxy.credentialReads(), beforeCredentials);
        assert.equal(proxy.requests.length, beforeRequests);
      });
    }
  }
});

test("native compaction ciphertext and compressed native request bytes remain unchanged", async (t) => {
  const proxy = await harness(t);
  const raw = Buffer.from(`{ "model": "${NATIVE_MODEL}", "instructions": "native-instructions-private-canary", "input": [ {"type":"compaction","encrypted_content":"native-opaque-fixture"}, {"type":"message","role":"user","content":"pickermux.compaction.v1. is ordinary user text"}, {"type":"compaction_trigger"} ], "stream": false }`);
  const compressed = gzipSync(raw);
  const result = await send({
    port: proxy.port,
    body: compressed,
    headers: { "content-encoding": "gzip", authorization: `Bearer ${NATIVE_SECRET}` },
  });
  assert.equal(result.status, 200);
  assert.equal(proxy.requests.length, 1);
  assert.deepEqual(proxy.requests[0].raw, compressed);
  assert.equal(proxy.requests[0].body.instructions, "native-instructions-private-canary");
  assert.equal(proxy.requests[0].headers.authorization, `Bearer ${NATIVE_SECRET}`);
  assert.equal(proxy.requests[0].headers["content-encoding"], "gzip");
  assert.equal(proxy.credentialReads(), 0);
});

test("other providers retain their own unknown input shapes and opaque compaction contract", async (t) => {
  const proxy = await harness(t);
  const input = [
    { type: "compaction", encrypted_content: "provider-opaque-fixture" },
    { type: "future_provider_input", arbitrary: "provider-specific-fixture" },
    { type: "compaction_trigger" },
  ];
  const instructions = "other-provider-instructions-private-canary";
  const result = await send({ port: proxy.port, body: { model: OTHER_PROVIDER_MODEL, instructions, input } });
  assert.equal(result.status, 200);
  assert.equal(proxy.requests.length, 1);
  assert.deepEqual(proxy.requests[0].body.input, input);
  assert.equal(proxy.requests[0].body.instructions, instructions);
});
