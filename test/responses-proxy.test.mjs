import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import test from "node:test";

import {
  assertRuntimeCompressionSupport,
  decodeJsonBody,
  runtimeSupportsZstd,
} from "../src/body-codec.mjs";
import { createResponsesProxy } from "../src/responses-proxy.mjs";

async function readContextFixture(name) {
  return (await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).trim();
}

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
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function httpRequest({ port, path = "/v1/responses", headers = {}, body = Buffer.alloc(0) }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "content-length": String(body.length), ...headers },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

async function createProxyHarness({
  registry,
  nativeBaseUrl,
  env,
  limits,
  credentialResolver,
  certificationToken,
}) {
  const handle = createResponsesProxy({
    registry,
    nativeBaseUrl,
    env,
    limits,
    credentialResolver,
    certificationToken,
  });
  const server = http.createServer((request, response) => {
    void handle(request, response, new URL(request.url, "http://proxy.local").pathname);
  });
  const port = await listen(server);
  return { server, port };
}

test("body decoder supports gzip, deflate, Brotli and zstd when the runtime provides it", async (t) => {
  const source = Buffer.from(JSON.stringify({ model: "native", input: "Hello 🌍" }));
  const codecs = [
    ["gzip", zlib.gzip],
    ["deflate", zlib.deflate],
    ["br", zlib.brotliCompress],
  ];
  if (typeof zlib.zstdCompress === "function") codecs.push(["zstd", zlib.zstdCompress]);

  for (const [encoding, operation] of codecs) {
    await t.test(encoding, async () => {
      const encoded = await promisify(operation)(source);
      assert.deepEqual(await decodeJsonBody(encoded, encoding, { maxBytes: 1024 }), {
        model: "native",
        input: "Hello 🌍",
      });
    });
  }
});

test("runtime compression gate reflects native zstd availability", () => {
  assert.equal(runtimeSupportsZstd(), typeof zlib.zstdDecompress === "function");
  if (runtimeSupportsZstd()) assert.doesNotThrow(() => assertRuntimeCompressionSupport());
});

test("native route relays compressed request bytes, approved headers and SSE bytes unchanged", async (t) => {
  let observed;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.once("end", () => {
      observed = { path: request.url, headers: request.headers, body: Buffer.concat(chunks) };
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "set-cookie": "native-secret=1",
        "x-upstream-id": "safe",
      });
      response.write("event: response.output_text.delta\ndata: {\"delta\":\"hi\"}\n\n");
      response.end("event: response.completed\ndata: {}\n\n");
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const registry = {
    resolve(model) {
      assert.equal(model, "gpt-5.6-sol");
      return { kind: "native-openai", slug: model, upstreamModel: model };
    },
  };
  const proxy = await createProxyHarness({
    registry,
    nativeBaseUrl: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
  });
  t.after(() => close(proxy.server));

  const plain = Buffer.from(
    JSON.stringify({
      model: "gpt-5.6-sol",
      reasoning: { effort: "ultra" },
      prompt_cache_key: "native-cache-key-must-remain",
      client_metadata: {
        thread_id: "native-thread-id-must-remain-byte-exact",
      },
      include: ["reasoning.encrypted_content"],
      tools: [
        { type: "web_search" },
        { type: "namespace", name: "functions", tools: [] },
      ],
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "native-developer-stays" }],
        },
        {
          type: "function_call",
          name: "native_canary",
          encrypted_function_args: "native-must-remain-byte-exact",
          internal_chat_message_metadata_passthrough: { native: true },
        },
      ],
    }),
  );
  const encoded = await promisify(zlib.gzip)(plain);
  const result = await httpRequest({
    port: proxy.port,
    headers: {
      accept: "text/event-stream",
      authorization: "Bearer native-token",
      "chatgpt-account-id": "account",
      "content-encoding": "gzip",
      "content-type": "application/json",
      cookie: "must-not-cross",
      "proxy-authorization": "must-not-cross",
      "x-codex-routing-hint": "native",
      "x-openai-fedramp": "1",
    },
    body: encoded,
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["content-type"], "text/event-stream");
  assert.equal(result.headers["x-upstream-id"], "safe");
  assert.equal(result.headers["set-cookie"], undefined);
  assert.match(result.body.toString(), /response\.completed/u);
  assert.equal(observed.path, "/backend-api/codex/responses");
  assert.deepEqual(observed.body, encoded);
  assert.equal(observed.headers.authorization, "Bearer native-token");
  assert.equal(observed.headers["chatgpt-account-id"], "account");
  assert.equal(observed.headers["x-codex-routing-hint"], "native");
  assert.equal(observed.headers.cookie, undefined);
  assert.equal(observed.headers["proxy-authorization"], undefined);
});

test("external route rewrites model and effort while replacing all caller credentials", async (t) => {
  let observed;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.once("end", () => {
      observed = {
        path: request.url,
        headers: request.headers,
        json: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const registry = {
    resolve(model) {
      assert.equal(model, "lmstudio/qwen/qwen3.8-27b");
      return {
        kind: "external",
        providerId: "lmstudio",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        allowPrivateNetwork: true,
        upstreamModel: "qwen/qwen3.8-27b",
        toolsEnabled: true,
        reasoningEffort: "low",
        credentialEnv: "TEST_PROVIDER_TOKEN",
      };
    },
  };
  const proxy = await createProxyHarness({
    registry,
    env: { TEST_PROVIDER_TOKEN: "external-token" },
  });
  t.after(() => close(proxy.server));

  const body = await promisify(zlib.brotliCompress)(
    Buffer.from(
      JSON.stringify({
        model: "lmstudio/qwen/qwen3.8-27b",
        reasoning: { effort: "ultra", summary: "auto" },
        input: "test",
        client_metadata: {
          installation_id: "external-installation-canary",
          thread_id: "external-thread-canary",
        },
        metadata: { caller_value: "preserved" },
      }),
    ),
  );
  const result = await httpRequest({
    port: proxy.port,
    path: "/v1/responses/compact",
    headers: {
      accept: "application/json",
      authorization: "Bearer chatgpt-token",
      "chatgpt-account-id": "account",
      "content-encoding": "br",
      cookie: "chatgpt-cookie",
      "x-codex-routing-hint": "native",
      "x-oai-attestation": "attestation",
    },
    body,
  });

  assert.equal(result.statusCode, 200);
  assert.equal(observed.path, "/v1/responses/compact");
  assert.equal(observed.json.model, "qwen/qwen3.8-27b");
  assert.deepEqual(observed.json.reasoning, { effort: "low", summary: "auto" });
  assert.equal(observed.json.client_metadata, undefined);
  assert.deepEqual(observed.json.metadata, { caller_value: "preserved" });
  assert.equal(observed.headers.authorization, "Bearer external-token");
  assert.equal(observed.headers["content-encoding"], undefined);
  assert.equal(observed.headers["chatgpt-account-id"], undefined);
  assert.equal(observed.headers.cookie, undefined);
  assert.equal(observed.headers["x-codex-routing-hint"], undefined);
  assert.equal(observed.headers["x-oai-attestation"], undefined);
  assert.doesNotMatch(JSON.stringify(observed), /chatgpt-token|chatgpt-cookie|attestation/u);
  assert.doesNotMatch(
    JSON.stringify(observed),
    /external-installation-canary|external-thread-canary/u,
  );
});

test("generic external route preserves caller reasoning and annotated context", async (t) => {
  let observed;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      observed = JSON.parse(Buffer.concat(chunks).toString());
      response.end("ok");
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await createProxyHarness({
    registry: {
      resolve: () => ({
        kind: "external",
        providerKind: "openai-responses",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        allowPrivateNetwork: true,
        upstreamModel: "vendor-model",
      }),
    },
  });
  t.after(() => close(proxy.server));

  const body = Buffer.from(
    JSON.stringify({
      model: "vendor/public",
      reasoning: { effort: "medium" },
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<skills_instructions>generic-provider-context-stays</skills_instructions>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["host_skills.instructions"],
          },
        },
      ],
    }),
  );
  const result = await httpRequest({ port: proxy.port, body });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(observed.reasoning, { effort: "medium" });
  assert.match(JSON.stringify(observed.input), /generic-provider-context-stays/u);
  assert.doesNotMatch(
    JSON.stringify(observed.input),
    /internal_chat_message_metadata_passthrough/u,
  );
});

test("external route strips internal metadata canaries without changing other input fields", async (t) => {
  let observed;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      observed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await createProxyHarness({
    registry: {
      resolve: () => ({
        kind: "external",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        allowPrivateNetwork: true,
        upstreamModel: "qwen/qwen3.8-27b",
        toolsEnabled: true,
      }),
    },
  });
  t.after(() => close(proxy.server));

  const body = Buffer.from(
    JSON.stringify({
      model: "lmstudio/qwen/qwen3.8-27b",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "canary-message" }],
          internal_chat_message_metadata_passthrough: {
            canary: "must-not-reach-external-upstream",
          },
          preserved_message_field: "message-stays",
        },
        {
          type: "function_call",
          call_id: "call-canary-1",
          name: "canary_tool",
          arguments: '{"safe":true}',
          encrypted_function_args: "encrypted-canary-must-not-reach-upstream",
          internal_chat_message_metadata_passthrough: "metadata-canary",
          preserved_function_field: { nested: [1, 2, 3] },
        },
        {
          type: "function_call_output",
          call_id: "call-canary-1",
          output: "unchanged-output",
          encrypted_function_args: "not-a-function-call-so-this-field-stays",
          preserved_output_field: true,
        },
        "primitive-input-stays",
      ],
      metadata: { topLevel: "unchanged" },
    }),
  );
  const result = await httpRequest({ port: proxy.port, body });

  assert.equal(result.statusCode, 200);
  assert.equal(observed.model, "qwen/qwen3.8-27b");
  assert.deepEqual(observed.metadata, { topLevel: "unchanged" });
  assert.deepEqual(observed.input, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "canary-message" }],
      preserved_message_field: "message-stays",
    },
    {
      type: "function_call",
      call_id: "call-canary-1",
      name: "canary_tool",
      arguments: '{"safe":true}',
      preserved_function_field: { nested: [1, 2, 3] },
    },
    {
      type: "function_call_output",
      call_id: "call-canary-1",
      output: "unchanged-output",
      encrypted_function_args: "not-a-function-call-so-this-field-stays",
      preserved_output_field: true,
    },
    "primitive-input-stays",
  ]);
  assert.equal(
    JSON.stringify(observed).includes("must-not-reach-external-upstream"),
    false,
  );
  assert.equal(JSON.stringify(observed).includes("encrypted-canary"), false);
});

test("LM Studio route removes unsupported Codex fields without touching supported request data", async (t) => {
  let observed;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      observed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await createProxyHarness({
    registry: {
      resolve: () => ({
        kind: "external",
        providerKind: "lmstudio-responses",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        allowPrivateNetwork: true,
        upstreamModel: "qwen/qwen3.8-27b",
        reasoningEffort: "xhigh",
        reasoningEfforts: ["none", "low", "medium", "xhigh"],
        toolsEnabled: true,
      }),
    },
  });
  t.after(() => close(proxy.server));

  const result = await httpRequest({
    port: proxy.port,
    body: Buffer.from(JSON.stringify({
      model: "lmstudio/qwen/qwen3.8-27b",
      prompt_cache_key: "must-not-reach-lm-studio",
      include: ["reasoning.encrypted_content", "message.input_image.image_url"],
      reasoning: { effort: "max", summary: "auto" },
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "developer-canary" }],
        },
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "second-developer-canary" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "user-stays" }],
        },
        {
          type: "function_call",
          namespace: "functions",
          name: "nested_tool",
          call_id: "call-history",
          arguments: "{}",
        },
      ],
      tools: [
        { type: "web_search", external_web_access: true },
        {
          type: "namespace",
          name: "functions",
          description: "Codex namespace",
          tools: [{ type: "function", name: "nested_tool", parameters: {} }],
        },
        {
          type: "function",
          name: "direct_tool",
          description: "supported",
          parameters: { type: "object", properties: {} },
        },
      ],
      tool_choice: {
        type: "namespace",
        name: "functions",
        function: { name: "nested_tool" },
      },
      parallel_tool_calls: true,
      metadata: { preserved: true },
    })),
  });

  assert.equal(result.statusCode, 200);
  assert.equal(observed.model, "qwen/qwen3.8-27b");
  assert.equal(observed.prompt_cache_key, undefined);
  assert.deepEqual(observed.include, ["message.input_image.image_url"]);
  assert.deepEqual(observed.reasoning, { effort: "xhigh", summary: "auto" });
  assert.equal(observed.input[0].role, "system");
  assert.deepEqual(
    observed.input[0].content.map((part) => part.text),
    ["developer-canary", "\n\n", "second-developer-canary"],
  );
  assert.equal(observed.input[1].role, "user");
  assert.equal(observed.input[2].namespace, undefined);
  assert.deepEqual(observed.tools.map((tool) => tool.type), ["function"]);
  assert.deepEqual(observed.tools.map((tool) => tool.name), ["nested_tool"]);
  assert.equal(observed.tool_choice, "required");
  assert.equal(observed.parallel_tool_calls, false);
  assert.deepEqual(observed.metadata, { preserved: true });
});

test("LM Studio namespace calls are mapped on request and restored in JSON responses", async (t) => {
  let observed;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      observed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const call = {
        type: "function_call",
        name: observed.tools[0].name,
        call_id: "call_namespace_1",
        arguments: "{}",
      };
      const payload = JSON.stringify({ id: "resp_namespace", output: [call] });
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload)),
        etag: "must-be-removed-after-transform",
      });
      response.end(payload);
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await createProxyHarness({
    registry: {
      resolve: () => ({
        kind: "external",
        providerKind: "lmstudio-responses",
        providerId: "lmstudio",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        allowPrivateNetwork: true,
        upstreamModel: "qwen/local",
        toolsEnabled: true,
      }),
    },
  });
  t.after(() => close(proxy.server));

  const result = await httpRequest({
    port: proxy.port,
    body: Buffer.from(
      JSON.stringify({
        model: "lmstudio/qwen/local",
        input: "Use the tool",
        tools: [
          {
            type: "namespace",
            name: "workspace",
            tools: [{ type: "function", name: "inspect", parameters: {} }],
          },
        ],
        tool_choice: {
          type: "namespace",
          name: "workspace",
          function: { name: "inspect" },
        },
      }),
    ),
  });

  assert.equal(result.statusCode, 200);
  assert.match(observed.tools[0].name, /^mbns_[0-9a-f]{56}$/u);
  assert.deepEqual(observed.tools[0].parameters, {
    type: "object",
    properties: {},
  });
  assert.equal(observed.tool_choice, "required");
  assert.equal(observed.parallel_tool_calls, false);
  const payload = JSON.parse(result.body);
  assert.deepEqual(payload.output[0], {
    type: "function_call",
    namespace: "workspace",
    name: "inspect",
    call_id: "call_namespace_1",
    arguments: "{}",
  });
  assert.equal(result.headers.etag, undefined);
});

test("native and provider credentials stay isolated across sequential model switches", async (t) => {
  const observed = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      observed.push({
        path: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"output":[]}');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const routes = new Map([
    [
      "gpt-5.6-sol",
      { kind: "native-openai", slug: "gpt-5.6-sol", upstreamModel: "gpt-5.6-sol" },
    ],
    [
      "vendor-a/model",
      {
        kind: "external",
        providerId: "vendor-a",
        providerKind: "openai-responses",
        credentialKeychain: true,
        baseUrl: `http://127.0.0.1:${upstreamPort}/external-a/v1`,
        allowPrivateNetwork: true,
        upstreamModel: "model-a",
      },
    ],
    [
      "vendor-b/model",
      {
        kind: "external",
        providerId: "vendor-b",
        providerKind: "openai-responses",
        credentialKeychain: true,
        baseUrl: `http://127.0.0.1:${upstreamPort}/external-b/v1`,
        allowPrivateNetwork: true,
        upstreamModel: "model-b",
      },
    ],
  ]);
  const proxy = await createProxyHarness({
    registry: { resolve: (model) => routes.get(model) },
    nativeBaseUrl: `http://127.0.0.1:${upstreamPort}/native`,
    credentialResolver: async (route) =>
      route.providerId ? `secret-${route.providerId}` : undefined,
  });
  t.after(() => close(proxy.server));

  for (const model of [
    "gpt-5.6-sol",
    "vendor-a/model",
    "vendor-b/model",
    "gpt-5.6-sol",
  ]) {
    const response = await httpRequest({
      port: proxy.port,
      headers: { authorization: "Bearer native-secret" },
      body: Buffer.from(JSON.stringify({ model, input: "switch" })),
    });
    assert.equal(response.statusCode, 200);
  }

  assert.deepEqual(
    observed.map(({ path, authorization, body }) => ({
      path,
      authorization,
      model: body.model,
    })),
    [
      {
        path: "/native/responses",
        authorization: "Bearer native-secret",
        model: "gpt-5.6-sol",
      },
      {
        path: "/external-a/v1/responses",
        authorization: "Bearer secret-vendor-a",
        model: "model-a",
      },
      {
        path: "/external-b/v1/responses",
        authorization: "Bearer secret-vendor-b",
        model: "model-b",
      },
      {
        path: "/native/responses",
        authorization: "Bearer native-secret",
        model: "gpt-5.6-sol",
      },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(observed.filter((entry) => entry.path.includes("external"))),
    /native-secret/u,
  );
});

test("LM Studio route drops an empty unsupported tool set and maps every Codex effort", async (t) => {
  const observed = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      observed.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const route = {
    kind: "external",
    providerKind: "lmstudio-responses",
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    allowPrivateNetwork: true,
    upstreamModel: "qwen/qwen3.8-27b",
    reasoningEffort: "xhigh",
    reasoningEfforts: ["none", "low", "medium", "xhigh"],
  };
  const proxy = await createProxyHarness({ registry: { resolve: () => route } });
  t.after(() => close(proxy.server));

  const expectations = new Map([
    ["none", "none"],
    ["minimal", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "xhigh"],
    ["xhigh", "xhigh"],
    ["max", "xhigh"],
    ["ultra", "xhigh"],
  ]);
  for (const effort of expectations.keys()) {
    const result = await httpRequest({
      port: proxy.port,
      body: Buffer.from(JSON.stringify({
        model: "lmstudio/qwen/qwen3.8-27b",
        reasoning: { effort },
        include: ["reasoning.encrypted_content"],
        tools: [
          { type: "web_search" },
          { type: "namespace", name: "functions", tools: [] },
        ],
        tool_choice: "auto",
        parallel_tool_calls: true,
      })),
    });
    assert.equal(result.statusCode, 200);
  }
  assert.deepEqual(
    observed.map((body) => body.reasoning.effort),
    [...expectations.values()],
  );
  for (const body of observed) {
    assert.equal(body.include, undefined);
    assert.equal(body.tools, undefined);
    assert.equal(body.tool_choice, undefined);
    assert.equal(body.parallel_tool_calls, undefined);
  }
});

test("text-only routes strip large optional tool catalogs before forwarding", async (t) => {
  let observed;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      observed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await createProxyHarness({
    registry: {
      resolve: () => ({
        kind: "external",
        providerKind: "lmstudio-responses",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        allowPrivateNetwork: true,
        upstreamModel: "microsoft/phi-4-mini-reasoning",
        toolsEnabled: false,
      }),
    },
  });
  t.after(() => close(proxy.server));

  const tools = Array.from({ length: 226 }, (_unused, index) => ({
    type: "function",
    name: `tool_${index}`,
    description: "A deliberately verbose tool schema that must not reach a text-only model",
    parameters: { type: "object", properties: {} },
  }));
  const result = await httpRequest({
    port: proxy.port,
    body: Buffer.from(JSON.stringify({
      model: "lmstudio/microsoft/phi-4-mini-reasoning",
      input: "Reply with a short greeting.",
      tools,
      tool_choice: "auto",
      parallel_tool_calls: true,
    })),
  });

  assert.equal(result.statusCode, 200);
  assert.equal(observed.tools, undefined);
  assert.equal(observed.tool_choice, undefined);
  assert.equal(observed.parallel_tool_calls, undefined);
  assert.equal(observed.input, "Reply with a short greeting.");
});

test("LM Studio text-only routes compact only annotated bootstrap context", async (t) => {
  let observed;
  let observedBytes;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      observedBytes = Buffer.concat(chunks);
      observed = JSON.parse(observedBytes.toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await createProxyHarness({
    registry: {
      resolve: () => ({
        kind: "external",
        providerKind: "lmstudio-responses",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        allowPrivateNetwork: true,
        upstreamModel: "qwen/qwen3.8-27b",
        toolsEnabled: false,
        reasoningEffort: "low",
        reasoningEfforts: ["none", "low", "medium", "xhigh"],
      }),
    },
  });
  t.after(() => close(proxy.server));

  const large = "bootstrap-overhead-".repeat(4_000);
  const appContext = await readContextFixture(
    "codex-desktop-app-context-0.151.txt",
  );
  const threadCoordination = await readContextFixture(
    "codex-thread-coordination-0.151-1492.txt",
  );
  const appContextWithoutSidebar = await readContextFixture(
    "codex-desktop-app-context-0.151-4593.txt",
  );
  const rootMultiAgentUsageHint = await readContextFixture(
    "codex-root-multi-agent-usage-hint-0.151.txt",
  );
  const subagentMultiAgentUsageHint = await readContextFixture(
    "codex-subagent-multi-agent-usage-hint-0.151.txt",
  );
  const memoryBootstrap = (await readContextFixture(
    "codex-memory-read-path-0.151.md",
  ))
    .replaceAll("{{ base_path }}", "/Users/example/.codex/memories")
    .replace("{{ memory_summary }}", large);
  const tools = Array.from({ length: 226 }, (_unused, index) => ({
    type: "function",
    name: `tool_${index}`,
    description: `tool-overhead-${index}-${"x".repeat(400)}`,
    parameters: { type: "object", properties: {} },
  }));
  const source = {
    model: "lmstudio/qwen/qwen3.8-27b",
    instructions: "compact-text-only-instructions-stay",
    input: [
      {
        type: "message",
        id: "msg-bootstrap",
        role: "developer",
        content: [
          {
            type: "input_text",
            text: appContext,
          },
          { type: "input_text", text: threadCoordination },
          { type: "input_text", text: memoryBootstrap },
          {
            type: "input_text",
            text: "managed-config-instructions-stay",
          },
          {
            type: "input_text",
            text: `<apps_instructions>\n${large}\n</apps_instructions>`,
          },
          {
            type: "input_text",
            text: `<plugins_instructions>\n${large}\n</plugins_instructions>`,
          },
          {
            type: "input_text",
            text: `<environments_instructions>\n${large}\n</environments_instructions>`,
          },
          {
            type: "input_text",
            text: `<skills_instructions>\n${large}\n</skills_instructions>`,
          },
          {
            type: "input_text",
            text: `<skills_instructions>\n${large}\n</skills_instructions>`,
          },
          {
            type: "input_text",
            text: `<skills_instructions>\n${large}\n</skills_instructions>`,
          },
          {
            type: "input_text",
            text: `<skills_instructions>\n${large}\n</skills_instructions>`,
          },
          {
            type: "input_text",
            text: `<permissions instructions>\n${large}\n</permissions instructions>`,
          },
          {
            type: "input_text",
            text: `<collaboration_mode>\n${large}\n</collaboration_mode>`,
          },
          {
            type: "input_text",
            text: `<multi_agent_mode>\n${large}\n</multi_agent_mode>`,
          },
          {
            type: "input_text",
            text: `<tools>\n${large}\n</tools>`,
          },
        ],
        internal_chat_message_metadata_passthrough: {
          create_time: 1_788_268_519.125,
          turn_id: "turn-bootstrap",
          content_item_kinds: [
            "generic.developer_instructions",
            "generic.developer_instructions",
            "memories.instructions",
            "managed_config.developer_instructions",
            "apps.instructions",
            "plugins.usage_instructions",
            "environments.instructions",
            "host_skills.instructions",
            "skills.catalog",
            "skills.instructions",
            "orchestrator_skills.instructions",
            "permissions.instructions",
            "collaboration_mode.instructions",
            "multi_agent.mode_instructions",
            "tools.deferred_namespaces",
          ],
        },
      },
      {
        type: "message",
        id: "msg-app-context-without-sidebar",
        role: "developer",
        content: [{ type: "input_text", text: appContextWithoutSidebar }],
        internal_chat_message_metadata_passthrough: {
          create_time: 1_788_268_519.1875,
          turn_id: "turn-bootstrap",
          content_item_kinds: ["generic.developer_instructions"],
        },
      },
      {
        type: "message",
        id: "msg-multi-agent-hint",
        role: "developer",
        content: [{ type: "input_text", text: rootMultiAgentUsageHint }],
        internal_chat_message_metadata_passthrough: {
          create_time: 1_788_268_519.25,
          turn_id: "turn-bootstrap",
          content_item_kinds: ["multi_agent.usage_hint"],
        },
      },
      {
        type: "message",
        id: "msg-subagent-multi-agent-hint",
        role: "developer",
        content: [{ type: "input_text", text: subagentMultiAgentUsageHint }],
        internal_chat_message_metadata_passthrough: {
          create_time: 1_788_268_519.3125,
          turn_id: "turn-bootstrap",
          content_item_kinds: ["multi_agent.role_instructions"],
        },
      },
      {
        type: "message",
        id: "msg-user-bootstrap",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `<recommended_plugins>\n${large}\n</recommended_plugins>`,
          },
          {
            type: "input_text",
            text: "<environment_context>\n  <cwd>/workspace</cwd>\n</environment_context>",
          },
          {
            type: "input_text",
            text: "# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>\nproject-instructions-stay\n</INSTRUCTIONS>",
          },
          {
            type: "input_text",
            text: "selected-skill-instructions-stay",
          },
        ],
        internal_chat_message_metadata_passthrough: {
          create_time: 1_788_268_519.375,
          turn_id: "turn-bootstrap",
          content_item_kinds: [
            "plugins.recommendations",
            "environments.environment_context",
            "agents_md.instructions",
            "skills.selected_skill_instructions",
          ],
        },
      },
      {
        type: "message",
        id: "msg-user-question",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Explain these literal tags: <skills_instructions>user text</skills_instructions> <app-context>user app text</app-context>",
          },
          { type: "input_image", image_url: "data:image/png;base64,dXNlci1pbWFnZQ==" },
          { type: "input_audio", audio_url: "data:audio/wav;base64,dXNlci1hdWRpbw==" },
        ],
        internal_chat_message_metadata_passthrough: {
          create_time: 1_788_268_519.5,
          turn_id: "turn-bootstrap",
          content_item_kinds: ["user.text", "user.image", "user.audio"],
        },
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Earlier answer stays" }],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "late-permissions-stay" }],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ["permissions.instructions"],
        },
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "What did I ask before?" }],
      },
    ],
    tools,
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "low", summary: "detailed" },
    client_metadata: {
      installation_id: "installation-id-must-not-reach-upstream",
      thread_id: "thread-id-must-not-reach-upstream",
      turn_id: "turn-id-must-not-reach-upstream",
    },
    metadata: { caller_value: "preserved" },
  };
  const sourceBytes = Buffer.from(JSON.stringify(source));
  const result = await httpRequest({ port: proxy.port, body: sourceBytes });

  assert.equal(result.statusCode, 200);
  assert.equal(observed.instructions, "compact-text-only-instructions-stay");
  assert.deepEqual(observed.reasoning, { effort: "low", summary: "detailed" });
  assert.deepEqual(observed.metadata, { caller_value: "preserved" });
  assert.equal(observed.client_metadata, undefined);
  assert.equal(observed.tools, undefined);
  assert.equal(observed.tool_choice, undefined);
  assert.equal(observed.parallel_tool_calls, undefined);
  assert.equal(observed.input[0].role, "system");
  assert.deepEqual(
    observed.input[0].content.map((part) => part.text),
    ["managed-config-instructions-stay", "\n\n", "late-permissions-stay"],
  );
  assert.equal(observed.input[1].role, "user");
  assert.match(observed.input[1].content[0].text, /<environment_context>/u);
  assert.match(observed.input[1].content[1].text, /project-instructions-stay/u);
  assert.match(
    observed.input[1].content[2].text,
    /selected-skill-instructions-stay/u,
  );
  assert.equal(observed.input[2].role, "user");
  assert.match(observed.input[2].content[0].text, /literal tag/u);
  assert.equal(observed.input[2].content[1].type, "input_image");
  assert.equal(observed.input[2].content[2].type, "input_audio");
  assert.equal(observed.input[3].role, "assistant");
  assert.equal(observed.input[4].content[0].text, "What did I ask before?");
  assert.equal(
    observed.input.some((item) => item.internal_chat_message_metadata_passthrough),
    false,
  );
  assert.doesNotMatch(
    observedBytes.toString("utf8"),
    /bootstrap-overhead|Codex desktop context|Thread coordination:|MEMORY_SUMMARY|primary agent in a team|collaborating to complete a task|installation-id-must-not-reach|thread-id-must-not-reach|turn-id-must-not-reach|tool_225/u,
  );
  const sourceInputBytes = Buffer.byteLength(JSON.stringify(source.input));
  const observedInputBytes = Buffer.byteLength(JSON.stringify(observed.input));
  assert.ok(observedInputBytes < sourceInputBytes / 20);
});

test("LM Studio text-only compaction retains verifier drift and fails closed on malformed context", async (t) => {
  const observed = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      observed.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await createProxyHarness({
    registry: {
      resolve: () => ({
        kind: "external",
        providerKind: "lmstudio-responses",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        allowPrivateNetwork: true,
        upstreamModel: "qwen/qwen3.8-27b",
        toolsEnabled: false,
      }),
    },
  });
  t.after(() => close(proxy.server));

  const rootMultiAgentUsageHint = await readContextFixture(
    "codex-root-multi-agent-usage-hint-0.151.txt",
  );
  const subagentMultiAgentUsageHint = await readContextFixture(
    "codex-subagent-multi-agent-usage-hint-0.151.txt",
  );
  const memoryTemplate = await readContextFixture(
    "codex-memory-read-path-0.151.md",
  );
  const appContext = await readContextFixture(
    "codex-desktop-app-context-0.151.txt",
  );
  const threadCoordination = await readContextFixture(
    "codex-thread-coordination-0.151-1492.txt",
  );
  const memoryBootstrap = memoryTemplate
    .replaceAll("{{ base_path }}", "/Users/example/.codex/memories")
    .replace("{{ memory_summary }}", "exact-memory-summary");
  const mutatedAppContext = appContext.replace(
    "# Codex desktop context",
    "# changed-app-context-stays",
  );
  const mutatedMemoryBootstrap = memoryBootstrap.replace(
    "Use it whenever it is likely to help.",
    "modified-memory-scaffold-stays",
  );
  const mutatedThreadCoordination = threadCoordination.replace(
    "Thread ownership:",
    "Thread ownership drift stays:",
  );
  const cases = [
    {
      path: "/v1/responses",
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            { type: "input_text", text: "future-context-stays" },
            {
              type: "input_text",
              text: "<skills_instructions>later-known-skills-remove</skills_instructions>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: [
              "future.context",
              "host_skills.instructions",
            ],
          },
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<skills_instructions>later-skills-remove</skills_instructions>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["host_skills.instructions"],
          },
        },
      ],
      canaries: [
        "future-context-stays",
        "later-known-skills-remove",
        "later-skills-remove",
      ],
      absentCanaries: [],
    },
    {
      path: "/v1/responses/compact",
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            { type: "input_text", text: "misaligned-one-stays" },
            { type: "input_text", text: "misaligned-two-stays" },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["host_skills.instructions"],
          },
        },
      ],
      canaries: ["misaligned-one-stays", "misaligned-two-stays"],
      absentCanaries: [],
    },
    {
      path: "/v1/responses",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "mixed-permissions-stay" },
            { type: "input_text", text: "mixed-user-text-stays" },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["permissions.instructions", "user.text"],
          },
        },
      ],
      canaries: ["mixed-permissions-stay", "mixed-user-text-stays"],
      absentCanaries: [],
    },
    {
      path: "/v1/responses",
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<skills_instructions>mismatched-envelope-stays",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["host_skills.instructions"],
          },
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<skills_instructions>after-envelope-mismatch-stays</skills_instructions>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["host_skills.instructions"],
          },
        },
      ],
      canaries: [
        "mismatched-envelope-stays",
        "after-envelope-mismatch-stays",
      ],
      absentCanaries: [],
    },
    {
      path: "/v1/responses",
      statusCode: 400,
      input: [
        {
          type: "message",
          role: "developer",
          future_message_field: "future-message-field-stays",
          content: [
            {
              type: "input_text",
              text: "<tools>message-shape-context-stays</tools>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["tools.deferred_namespaces"],
          },
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<apps_instructions>after-message-shape-stays</apps_instructions>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["apps.instructions"],
          },
        },
      ],
      canaries: [
        "future-message-field-stays",
        "message-shape-context-stays",
        "after-message-shape-stays",
      ],
      absentCanaries: [],
    },
    {
      path: "/v1/responses",
      statusCode: 400,
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<tools>metadata-shape-context-stays</tools>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["tools.deferred_namespaces"],
            future_metadata_field: true,
          },
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<apps_instructions>after-metadata-shape-stays</apps_instructions>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["apps.instructions"],
          },
        },
      ],
      canaries: [
        "metadata-shape-context-stays",
        "after-metadata-shape-stays",
      ],
      absentCanaries: [],
    },
    {
      path: "/v1/responses",
      statusCode: 400,
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<tools>content-shape-context-stays</tools>",
              future_content_field: "future-content-field-stays",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["tools.deferred_namespaces"],
          },
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<apps_instructions>after-content-shape-stays</apps_instructions>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["apps.instructions"],
          },
        },
      ],
      canaries: [
        "content-shape-context-stays",
        "future-content-field-stays",
        "after-content-shape-stays",
      ],
      absentCanaries: [],
    },
    {
      path: "/v1/responses",
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: rootMultiAgentUsageHint.replace(
                "primary agent",
                "custom-primary-agent-stays",
              ),
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["multi_agent.usage_hint"],
          },
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<tools>after-custom-usage-hint-stays</tools>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["tools.deferred_namespaces"],
          },
        },
      ],
      canaries: [
        "custom-primary-agent-stays",
      ],
      absentCanaries: ["after-custom-usage-hint-stays"],
    },
    {
      path: "/v1/responses",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: rootMultiAgentUsageHint }],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["multi_agent.usage_hint"],
          },
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<tools>after-wrong-role-usage-hint-stays</tools>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["tools.deferred_namespaces"],
          },
        },
      ],
      canaries: [
        "primary agent in a team",
        "after-wrong-role-usage-hint-stays",
      ],
      absentCanaries: [],
    },
    {
      path: "/v1/responses",
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            { type: "input_text", text: subagentMultiAgentUsageHint },
            {
              type: "input_text",
              text: "role-instructions-companion-stays",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: [
              "multi_agent.role_instructions",
              "managed_config.developer_instructions",
            ],
          },
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<tools>after-nonstandalone-role-instructions-stays</tools>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["tools.deferred_namespaces"],
          },
        },
      ],
      canaries: [
        "collaborating to complete a task",
        "role-instructions-companion-stays",
        "after-nonstandalone-role-instructions-stays",
      ],
      absentCanaries: [],
    },
    {
      path: "/v1/responses",
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<app-context>exact-custom-app-context-stays</app-context>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["generic.developer_instructions"],
          },
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<tools>after-custom-app-context-stays</tools>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["tools.deferred_namespaces"],
          },
        },
      ],
      canaries: [
        "exact-custom-app-context-stays",
      ],
      absentCanaries: ["after-custom-app-context-stays"],
    },
    {
      path: "/v1/responses",
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: mutatedAppContext,
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["generic.developer_instructions"],
          },
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<tools>after-mutated-app-context-remove</tools>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["tools.deferred_namespaces"],
          },
        },
      ],
      canaries: ["changed-app-context-stays"],
      absentCanaries: ["after-mutated-app-context-remove"],
    },
    {
      path: "/v1/responses",
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: mutatedThreadCoordination,
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["generic.developer_instructions"],
          },
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<tools>after-mutated-thread-coordination-stays</tools>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["tools.deferred_namespaces"],
          },
        },
      ],
      canaries: [
        "Thread ownership drift stays",
        "after-mutated-thread-coordination-stays",
      ],
      absentCanaries: [],
    },
    {
      path: "/v1/responses",
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: memoryBootstrap.replace(
                "exact-memory-summary",
                "duplicate-memory-marker-stays\n" +
                  "========= MEMORY_SUMMARY BEGINS =========",
              ),
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["memories.instructions"],
          },
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<tools>after-duplicate-memory-marker-stays</tools>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["tools.deferred_namespaces"],
          },
        },
      ],
      canaries: [
        "duplicate-memory-marker-stays",
        "after-duplicate-memory-marker-stays",
      ],
      absentCanaries: [],
    },
    {
      path: "/v1/responses",
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: mutatedMemoryBootstrap,
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["memories.instructions"],
          },
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<tools>after-modified-memory-scaffold-stays</tools>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["tools.deferred_namespaces"],
          },
        },
      ],
      canaries: [
        "modified-memory-scaffold-stays",
      ],
      absentCanaries: ["after-modified-memory-scaffold-stays"],
    },
    {
      path: "/v1/responses",
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "outside-app-context-stays<app-context>app-context-stays</app-context>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["generic.developer_instructions"],
          },
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<tools>after-malformed-app-context-stays</tools>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["tools.deferred_namespaces"],
          },
        },
      ],
      canaries: [
        "outside-app-context-stays",
        "app-context-stays",
        "after-malformed-app-context-stays",
      ],
      absentCanaries: [],
    },
    {
      path: "/v1/responses",
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "## Memory\nmalformed-memory-stays\n========= MEMORY_SUMMARY BEGINS =========\nsummary-without-closing-marker\nWhen memory is likely relevant, start with the quick memory pass above before\ndeep repo exploration.",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["memories.instructions"],
          },
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<apps_instructions>after-malformed-memory-stays</apps_instructions>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["apps.instructions"],
          },
        },
      ],
      canaries: [
        "malformed-memory-stays",
        "summary-without-closing-marker",
        "after-malformed-memory-stays",
      ],
      absentCanaries: [],
    },
    {
      path: "/v1/responses",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<skills_instructions>wrong-role-stays</skills_instructions>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["host_skills.instructions"],
          },
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<permissions instructions>after-wrong-role-stays</permissions instructions>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["permissions.instructions"],
          },
        },
      ],
      canaries: ["wrong-role-stays", "after-wrong-role-stays"],
      absentCanaries: [],
    },
    {
      path: "/v1/responses",
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<skills_instructions>first-stays</skills_instructions>outside-stays<skills_instructions>second-stays</skills_instructions>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["host_skills.instructions"],
          },
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<permissions instructions>after-concatenated-envelope-stays</permissions instructions>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["permissions.instructions"],
          },
        },
      ],
      canaries: [
        "first-stays",
        "outside-stays",
        "second-stays",
        "after-concatenated-envelope-stays",
      ],
      absentCanaries: [],
    },
  ];

  const forwardedCases = [];
  for (const value of cases) {
    const result = await httpRequest({
      port: proxy.port,
      path: value.path,
      body: Buffer.from(JSON.stringify({
        model: "lmstudio/qwen/qwen3.8-27b",
        input: value.input,
      })),
    });
    const expectedStatusCode = value.statusCode ?? 200;
    assert.equal(result.statusCode, expectedStatusCode);
    if (expectedStatusCode === 200) forwardedCases.push(value);
    else assert.equal(JSON.parse(result.body).error.code, "INVALID_BODY");
  }

  assert.equal(observed.length, forwardedCases.length);
  forwardedCases.forEach((value, index) => {
    const serialized = JSON.stringify(observed[index]);
    value.canaries.forEach((canary) => assert.match(serialized, new RegExp(canary, "u")));
    value.absentCanaries.forEach((canary) =>
      assert.doesNotMatch(serialized, new RegExp(canary, "u")),
    );
    assert.doesNotMatch(serialized, /internal_chat_message_metadata_passthrough/u);
  });
});

test("LM Studio text-only routes reject bootstrap-only input", async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((_request, response) => {
    upstreamRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await createProxyHarness({
    registry: {
      resolve: () => ({
        kind: "external",
        providerKind: "lmstudio-responses",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        allowPrivateNetwork: true,
        upstreamModel: "qwen/qwen3.8-27b",
        toolsEnabled: false,
      }),
    },
  });
  t.after(() => close(proxy.server));

  const memoryBootstrap = (await readContextFixture(
    "codex-memory-read-path-0.151.md",
  ))
    .replaceAll("{{ base_path }}", "/Users/example/.codex/memories")
    .replace("{{ memory_summary }}", "bootstrap-only-memory-canary");
  const result = await httpRequest({
    port: proxy.port,
    body: Buffer.from(JSON.stringify({
      model: "lmstudio/qwen/qwen3.8-27b",
      input: [
        {
          type: "message",
          id: "msg-bootstrap-only",
          role: "developer",
          content: [{ type: "input_text", text: memoryBootstrap }],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["memories.instructions"],
            create_time: 1_788_268_519.625,
            turn_id: "turn-bootstrap-only",
          },
        },
      ],
    })),
  });

  assert.equal(result.statusCode, 400);
  assert.equal(JSON.parse(result.body).error.code, "INVALID_BODY");
  assert.equal(upstreamRequests, 0);
});

test("tool-enabled LM Studio routes preserve annotated bootstrap context", async (t) => {
  let observed;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      observed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await createProxyHarness({
    registry: {
      resolve: () => ({
        kind: "external",
        providerKind: "lmstudio-responses",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        allowPrivateNetwork: true,
        upstreamModel: "qwen/qwen3.8-27b",
        toolsEnabled: true,
      }),
    },
  });
  t.after(() => close(proxy.server));

  const memory = [
    "## Memory",
    "tool-enabled-memory-stays",
    "========= MEMORY_SUMMARY BEGINS =========",
    "tool-enabled-summary-stays",
    "========= MEMORY_SUMMARY ENDS =========",
    "When memory is likely relevant, start with the quick memory pass above before",
    "deep repo exploration.",
  ].join("\n");
  const result = await httpRequest({
    port: proxy.port,
    body: Buffer.from(JSON.stringify({
      model: "lmstudio/qwen/qwen3.8-27b",
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<app-context>tool-enabled-app-context-stays</app-context>",
            },
            { type: "input_text", text: memory },
            {
              type: "input_text",
              text: "<skills_instructions>tool-enabled-skills-stay</skills_instructions>",
            },
            {
              type: "input_text",
              text: "<collaboration_mode>tool-enabled-mode-stays</collaboration_mode>",
            },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: [
              "generic.developer_instructions",
              "memories.instructions",
              "skills.catalog",
              "collaboration_mode.instructions",
            ],
          },
        },
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<recommended_plugins>tool-enabled-plugins-stay</recommended_plugins>",
            },
            { type: "input_text", text: "tool-enabled-user-stays" },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["plugins.recommendations", "user.text"],
          },
        },
      ],
    })),
  });

  assert.equal(result.statusCode, 200);
  const serialized = JSON.stringify(observed);
  for (const canary of [
    "tool-enabled-app-context-stays",
    "tool-enabled-memory-stays",
    "tool-enabled-summary-stays",
    "tool-enabled-skills-stay",
    "tool-enabled-mode-stays",
    "tool-enabled-plugins-stay",
    "tool-enabled-user-stays",
  ]) {
    assert.match(serialized, new RegExp(canary, "u"));
  }
  assert.doesNotMatch(serialized, /internal_chat_message_metadata_passthrough/u);
});

test("text-only routes reject forced tool choices and tool-call history", async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((_request, response) => {
    upstreamRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await createProxyHarness({
    registry: {
      resolve: () => ({
        kind: "external",
        providerKind: "lmstudio-responses",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        allowPrivateNetwork: true,
        upstreamModel: "microsoft/phi-4-mini-reasoning",
        toolsEnabled: false,
      }),
    },
  });
  t.after(() => close(proxy.server));

  for (const body of [
    {
      model: "lmstudio/microsoft/phi-4-mini-reasoning",
      input: "Use the tool",
      tools: [{ type: "function", name: "inspect", parameters: {} }],
      tool_choice: "required",
    },
    {
      model: "lmstudio/microsoft/phi-4-mini-reasoning",
      input: [{ type: "function_call_output", call_id: "call-1", output: "done" }],
      tool_choice: "none",
    },
  ]) {
    const result = await httpRequest({
      port: proxy.port,
      body: Buffer.from(JSON.stringify(body)),
    });
    assert.equal(result.statusCode, 400);
    assert.equal(JSON.parse(result.body).error.code, "UNSUPPORTED_TOOL_CHOICE");
  }
  assert.equal(upstreamRequests, 0);
});

test("only the private certification marker bypasses text-only tool stripping", async (t) => {
  const certificationToken = "runtime-instance-certification-0123456789";
  let observed;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      observed = {
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await createProxyHarness({
    certificationToken,
    registry: {
      resolve: () => ({
        kind: "external",
        providerKind: "lmstudio-responses",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        allowPrivateNetwork: true,
        upstreamModel: "microsoft/phi-4-mini-reasoning",
        toolsEnabled: false,
      }),
    },
  });
  t.after(() => close(proxy.server));
  const requestBody = Buffer.from(JSON.stringify({
    model: "lmstudio/microsoft/phi-4-mini-reasoning",
    instructions: "certification-instructions-stay",
    input: [
      {
        type: "message",
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "<skills_instructions>certification-context-stays</skills_instructions>",
          },
        ],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ["host_skills.instructions"],
        },
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Use the probe" }],
      },
    ],
    tools: [{ type: "function", name: "probe", parameters: {} }],
    tool_choice: { type: "function", name: "probe" },
  }));

  const rejected = await httpRequest({
    port: proxy.port,
    headers: { "x-pickermux-certification": `${certificationToken}-wrong` },
    body: requestBody,
  });
  assert.equal(rejected.statusCode, 400);

  const accepted = await httpRequest({
    port: proxy.port,
    headers: { "x-pickermux-certification": certificationToken },
    body: requestBody,
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(observed.body.tools[0].name, "probe");
  assert.equal(observed.body.tool_choice, "required");
  assert.equal(observed.body.instructions, "certification-instructions-stay");
  assert.match(JSON.stringify(observed.body.input), /certification-context-stays/u);
  assert.equal(observed.headers["x-pickermux-certification"], undefined);
});

test("LM Studio route normalizes legacy on/off maps to the Responses enum", async (t) => {
  const observed = [];
  const accepted = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      observed.push(body.reasoning.effort);
      if (!accepted.has(body.reasoning.effort)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"error":{"message":"invalid reasoning enum"}}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await createProxyHarness({
    registry: {
      resolve: () => ({
        kind: "external",
        providerKind: "lmstudio-responses",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        allowPrivateNetwork: true,
        upstreamModel: "microsoft/phi-reasoning",
        reasoningEffort: "xhigh",
        reasoningEfforts: ["none", "xhigh"],
        reasoningEffortMap: { none: "off", xhigh: "on" },
      }),
    },
  });
  t.after(() => close(proxy.server));

  for (const effort of ["xhigh", "none"]) {
    const result = await httpRequest({
      port: proxy.port,
      body: Buffer.from(JSON.stringify({
        model: "lmstudio/microsoft/phi-reasoning",
        reasoning: { effort },
      })),
    });
    assert.equal(result.statusCode, 200);
  }
  assert.deepEqual(observed, ["xhigh", "none"]);
});

test("LM Studio omits only synthetic positive reasoning efforts", async (t) => {
  const observed = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      observed.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const routes = {
    "lmstudio/microsoft/phi-reasoning": {
      upstreamModel: "microsoft/phi-reasoning",
      reasoningEffort: "xhigh",
      reasoningEfforts: ["xhigh"],
      reasoningEffortMap: { xhigh: "xhigh" },
      reasoningOmitEfforts: ["xhigh"],
    },
    "lmstudio/gemma/reasoning": {
      upstreamModel: "gemma/reasoning",
      reasoningEffort: "xhigh",
      reasoningEfforts: ["none", "xhigh"],
      reasoningEffortMap: { none: "none", xhigh: "xhigh" },
      reasoningOmitEfforts: ["xhigh"],
    },
  };
  const proxy = await createProxyHarness({
    registry: {
      resolve(model) {
        return {
          kind: "external",
          providerKind: "lmstudio-responses",
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          allowPrivateNetwork: true,
          ...routes[model],
        };
      },
    },
  });
  t.after(() => close(proxy.server));

  for (const body of [
    {
      model: "lmstudio/microsoft/phi-reasoning",
    },
    {
      model: "lmstudio/microsoft/phi-reasoning",
      reasoning: { effort: "ultra" },
    },
    {
      model: "lmstudio/microsoft/phi-reasoning",
      reasoning: { effort: "max" },
    },
    {
      model: "lmstudio/microsoft/phi-reasoning",
      reasoning: { effort: "none" },
    },
    {
      model: "lmstudio/microsoft/phi-reasoning",
      reasoning: { effort: "xhigh", summary: "auto" },
    },
    {
      model: "lmstudio/gemma/reasoning",
      reasoning: { effort: "xhigh", summary: "auto" },
    },
    {
      model: "lmstudio/gemma/reasoning",
      reasoning: { effort: "none" },
    },
  ]) {
    const result = await httpRequest({
      port: proxy.port,
      body: Buffer.from(JSON.stringify(body)),
    });
    assert.equal(result.statusCode, 200);
  }

  for (const body of observed.slice(0, -1)) {
    assert.equal(Object.hasOwn(body, "reasoning"), false);
  }
  assert.deepEqual(observed.at(-1).reasoning, { effort: "none" });
});

test("invalid reasoning omission policies fail closed with a stable code", async (t) => {
  let route;
  const proxy = await createProxyHarness({
    registry: { resolve: () => route },
  });
  t.after(() => close(proxy.server));
  const baseRoute = {
    kind: "external",
    providerKind: "lmstudio-responses",
    baseUrl: "http://127.0.0.1:9/v1",
    allowPrivateNetwork: true,
    upstreamModel: "reasoner",
    reasoningEffort: "xhigh",
    reasoningEfforts: ["none", "xhigh"],
  };
  const invalidRoutes = [
    { ...baseRoute, reasoningOmitEfforts: "xhigh" },
    { ...baseRoute, reasoningOmitEfforts: ["xhigh", "xhigh"] },
    { ...baseRoute, reasoningOmitEfforts: ["medium"] },
    {
      ...baseRoute,
      providerKind: "openai-responses",
      reasoningOmitEfforts: ["xhigh"],
    },
  ];

  for (route of invalidRoutes) {
    const result = await httpRequest({
      port: proxy.port,
      body: Buffer.from(JSON.stringify({
        model: "lmstudio/invalid",
        reasoning: { effort: "xhigh" },
      })),
    });
    assert.equal(result.statusCode, 500);
    assert.equal(
      JSON.parse(result.body).error.code,
      "INVALID_REASONING_POLICY",
    );
  }
});

test("LM Studio required choice fails closed when every tool is unsupported", async (t) => {
  const proxy = await createProxyHarness({
    registry: {
      resolve: () => ({
        kind: "external",
        providerKind: "lmstudio-responses",
        baseUrl: "http://127.0.0.1:9/v1",
        allowPrivateNetwork: true,
        upstreamModel: "qwen/qwen3.8-27b",
        reasoningEffort: "xhigh",
        reasoningEfforts: ["low", "xhigh"],
        toolsEnabled: true,
      }),
    },
  });
  t.after(() => close(proxy.server));
  const result = await httpRequest({
    port: proxy.port,
    body: Buffer.from(JSON.stringify({
      model: "lmstudio/qwen/qwen3.8-27b",
      tools: [{ type: "web_search" }],
      tool_choice: "required",
    })),
  });
  assert.equal(result.statusCode, 400);
  assert.equal(JSON.parse(result.body).error.code, "UNSUPPORTED_TOOL_CHOICE");
});

test("LM Studio specific removed tool choices fail closed", async (t) => {
  const proxy = await createProxyHarness({
    registry: {
      resolve: () => ({
        kind: "external",
        providerKind: "lmstudio-responses",
        baseUrl: "http://127.0.0.1:9/v1",
        allowPrivateNetwork: true,
        upstreamModel: "qwen/qwen3.8-27b",
        toolsEnabled: true,
      }),
    },
  });
  t.after(() => close(proxy.server));
  for (const [tool_choice, expectedCode] of [
    [{ type: "web_search" }, "UNSUPPORTED_TOOL_TYPE"],
    [
      { type: "namespace", name: "plugins", function: { name: "missing" } },
      "UNSUPPORTED_TOOL_CHOICE",
    ],
  ]) {
    const result = await httpRequest({
      port: proxy.port,
      body: Buffer.from(JSON.stringify({
        model: "lmstudio/qwen/qwen3.8-27b",
        tools: [{ type: "web_search" }],
        tool_choice,
      })),
    });
    assert.equal(result.statusCode, 400);
    assert.equal(JSON.parse(result.body).error.code, expectedCode);
  }

  const dangling = await httpRequest({
    port: proxy.port,
    body: Buffer.from(JSON.stringify({
      model: "lmstudio/qwen/qwen3.8-27b",
      tools: [
        {
          type: "namespace",
          name: "plugins",
          tools: [{ type: "function", name: "removed_nested", parameters: {} }],
        },
        { type: "function", name: "remaining", parameters: {} },
      ],
      tool_choice: { type: "function", name: "removed_nested" },
    })),
  });
  assert.equal(dangling.statusCode, 400);
  assert.equal(JSON.parse(dangling.body).error.code, "UNSUPPORTED_TOOL_CHOICE");
});

test("unknown models fail closed before any upstream request", async (t) => {
  const proxy = await createProxyHarness({
    registry: {
      resolve() {
        throw Object.assign(new Error("Unknown model"), {
          code: "UNKNOWN_MODEL",
          statusCode: 400,
        });
      },
    },
  });
  t.after(() => close(proxy.server));
  const body = Buffer.from(JSON.stringify({ model: "almost-but-not-exact" }));
  const result = await httpRequest({ port: proxy.port, body });
  assert.equal(result.statusCode, 400);
  assert.equal(JSON.parse(result.body).error.code, "UNKNOWN_MODEL");
});

test("request size and upstream-header timeouts produce bounded errors", async (t) => {
  await t.test("size", async (t) => {
    const proxy = await createProxyHarness({
      registry: { resolve: () => ({ kind: "native-openai" }) },
      nativeBaseUrl: "http://127.0.0.1:9/backend-api/codex",
      limits: { requestBodyBytes: 16 },
    });
    t.after(() => close(proxy.server));
    const result = await httpRequest({
      port: proxy.port,
      body: Buffer.from(JSON.stringify({ model: "native", padding: "large" })),
    });
    assert.equal(result.statusCode, 413);
    assert.equal(JSON.parse(result.body).error.code, "BODY_TOO_LARGE");
  });

  await t.test("headers timeout", async (t) => {
    const upstream = http.createServer(() => {});
    const upstreamPort = await listen(upstream);
    t.after(() => close(upstream));
    const proxy = await createProxyHarness({
      registry: { resolve: () => ({ kind: "native-openai" }) },
      nativeBaseUrl: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
      limits: {
        upstreamHeadersTimeoutMs: 30,
        streamIdleTimeoutMs: 1_000,
        upstreamTotalTimeoutMs: 1_000,
      },
    });
    t.after(() => close(proxy.server));
    const result = await httpRequest({
      port: proxy.port,
      body: Buffer.from(JSON.stringify({ model: "native" })),
    });
    assert.equal(result.statusCode, 504);
    assert.equal(JSON.parse(result.body).error.code, "UPSTREAM_HEADERS_TIMEOUT");
  });
});

test("redirects are never followed and cannot expose Location or cookies", async (t) => {
  let requests = 0;
  const upstream = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(307, {
      location: "http://127.0.0.1:1/private",
      "set-cookie": "secret=1",
    });
    response.end("redirect not followed");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await createProxyHarness({
    registry: { resolve: () => ({ kind: "native-openai" }) },
    nativeBaseUrl: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
  });
  t.after(() => close(proxy.server));

  const result = await httpRequest({
    port: proxy.port,
    body: Buffer.from(JSON.stringify({ model: "native" })),
  });
  assert.equal(result.statusCode, 307);
  assert.equal(result.headers.location, undefined);
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(requests, 1);
});
