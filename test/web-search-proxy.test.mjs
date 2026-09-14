import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { listenBridgeServer } from "../src/bridge-server.mjs";
import { createWebSearchProxy } from "../src/responses-proxy.mjs";
import { RESPONSE_TRANSFORM_MAX_BYTES } from "../src/responses-transform.mjs";

const CAPABILITY = "web_search_test_capability_0123456789_ABCD";
const PREFIX = `/c/${CAPABILITY}`;
const SEARCH = `${PREFIX}/v1/alpha/search`;
const NATIVE_MODEL = "gpt-5.6-sol";
const EXTERNAL_MODEL = "lmstudio/example-model";
const CANARY = "private-search-account-and-credential-canary";

function searchBody(model = EXTERNAL_MODEL) {
  return {
    id: "test-search-session",
    model,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Find a public source" }] }],
    commands: { search_query: [{ q: "public example", domains: ["example.com"] }], response_length: "short" },
    settings: { allowed_callers: ["direct"], external_web_access: true, search_context_size: "low" },
    max_output_tokens: 1200,
  };
}

function request(port, { path = SEARCH, method = "POST", headers = {}, body = searchBody() } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: "127.0.0.1", port, path, method,
      headers: { "content-type": "application/json", ...headers },
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("error", reject);
      incoming.on("end", () => resolve({
        status: incoming.statusCode,
        headers: incoming.headers,
        bytes: Buffer.concat(chunks),
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.on("error", reject);
    outgoing.end(bytes);
  });
}

async function localServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return server;
}

async function fixture(t, { nativeHandler, registryOverride, ...options } = {}) {
  const nativeRequests = [];
  let modelRequests = 0;
  let credentialReads = 0;
  const modelServer = await localServer(t, (incoming, outgoing) => {
    modelRequests += 1;
    incoming.resume();
    outgoing.end("{}");
  });
  const nativeServer = await localServer(t, (incoming, outgoing) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      const captured = { path: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks) };
      nativeRequests.push(captured);
      if (nativeHandler) return nativeHandler(incoming, outgoing, captured);
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({
        output: "A compact source result [Example](https://example.com/)",
        encrypted_output: "opaque-native-search-state",
        results: [{ type: "text_result", ref_id: "turn0search0", url: "https://example.com/" }],
      }));
    });
  });
  const registry = registryOverride ?? {
    listModels: () => [],
    resolve(model) {
      if (model === NATIVE_MODEL) return { kind: "native-openai" };
      if ([EXTERNAL_MODEL, "vendor/second-model", "lmstudio/text-only"].includes(model)) {
        return {
          kind: "external", providerKind: "lmstudio-responses",
          baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
          allowPrivateNetwork: true,
          upstreamModel: "example-model",
          toolsEnabled: model !== "lmstudio/text-only",
        };
      }
      throw Object.assign(new Error(CANARY), { code: "UNKNOWN_MODEL", statusCode: 400 });
    },
  };
  const bridge = await listenBridgeServer({
    registry,
    capabilityToken: CAPABILITY,
    nativeBaseUrl: `http://127.0.0.1:${nativeServer.address().port}/native`,
    nativeSearchModel: NATIVE_MODEL,
    credentialResolver: () => { credentialReads += 1; return CANARY; },
    ...options,
  });
  t.after(() => new Promise((resolve) => {
    bridge.closeAllConnections();
    bridge.close(resolve);
  }));
  return {
    port: bridge.address().port,
    nativeRequests,
    modelRequests: () => modelRequests,
    credentialReads: () => credentialReads,
  };
}

test("native standalone search preserves compressed request and response bytes", async (t) => {
  const responseBytes = gzipSync(Buffer.from('{ "output": "a source", "results": [] }'));
  const f = await fixture(t, {
    nativeHandler: (_incoming, outgoing) => {
      outgoing.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "set-cookie": "never-forward" });
      outgoing.end(responseBytes);
    },
  });
  const body = gzipSync(Buffer.from(JSON.stringify(searchBody(NATIVE_MODEL), null, 2)));
  const result = await request(f.port, {
    body, headers: { "content-encoding": "gzip", authorization: `Bearer ${CANARY}`, cookie: CANARY, "x-unknown-secret": CANARY },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.bytes, responseBytes);
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(f.nativeRequests[0].path, "/native/alpha/search");
  assert.deepEqual(f.nativeRequests[0].body, body);
  assert.equal(f.nativeRequests[0].headers.authorization, `Bearer ${CANARY}`);
  assert.equal(f.nativeRequests[0].headers.cookie, undefined);
  assert.equal(f.nativeRequests[0].headers["x-unknown-secret"], undefined);
});

test("shared external search uses configured native search model with zero LM Studio inference or credential reads", async (t) => {
  const gates = [];
  const f = await fixture(t, { externalRequestGate: async (value) => gates.push(value) });
  for (const model of [EXTERNAL_MODEL, "vendor/second-model"]) {
    const body = searchBody(model);
    const result = await request(f.port, {
      body: gzipSync(Buffer.from(JSON.stringify(body))),
      headers: { "content-encoding": "gzip", authorization: `Bearer ${CANARY}`, "chatgpt-account-id": CANARY, cookie: CANARY },
    });
    assert.equal(result.status, 200);
    const captured = f.nativeRequests.at(-1);
    assert.deepEqual(JSON.parse(captured.body), { ...body, model: NATIVE_MODEL });
    assert.equal(captured.headers["content-encoding"], undefined);
    assert.equal(captured.headers["accept-encoding"], "identity");
    assert.equal(captured.headers.authorization, `Bearer ${CANARY}`);
    assert.equal(captured.headers.cookie, undefined);
    assert.equal(captured.headers["chatgpt-account-id"], CANARY);
    assert.equal(result.headers["chatgpt-account-id"], undefined);
    assert.equal(JSON.parse(result.text).output.includes("compact source"), true);
    assert.equal(gates.at(-1).publicModelId, model);
    assert.equal(gates.at(-1).certificationRequest, false);
    assert.equal(gates.at(-1).requiresDirectReceipt, true);
  }
  assert.equal(f.modelRequests(), 0);
  assert.equal(f.credentialReads(), 0);
});

test("search keeps explicit budgets, disabled live access, reference IDs and context", async (t) => {
  const f = await fixture(t);
  const body = {
    ...searchBody(),
    commands: { open: [{ ref_id: "turn0search0", lineno: 20 }], response_length: "long" },
    settings: { external_web_access: false, filters: { allowed_domains: ["example.com"] } },
    max_output_tokens: 4321,
  };
  assert.equal((await request(f.port, { body })).status, 200);
  assert.deepEqual(JSON.parse(f.nativeRequests[0].body), { ...body, model: NATIVE_MODEL });
});

test("search retains capability, host, origin, method and exact-path boundaries", async (t) => {
  const f = await fixture(t);
  for (const [options, expected] of [
    [{ path: "/v1/alpha/search" }, 404],
    [{ path: `${SEARCH}/extra` }, 404],
    [{ path: `${SEARCH}?model=${NATIVE_MODEL}` }, 404],
    [{ path: `${PREFIX}/v1/alpha/%73earch` }, 404],
    [{ path: `${PREFIX}/v1/search` }, 404],
    [{ method: "GET" }, 405],
    [{ method: "PUT" }, 405],
    [{ headers: { origin: "https://example.com" } }, 403],
    [{ headers: { host: "localhost:1234" } }, 421],
  ]) {
    assert.equal((await request(f.port, options)).status, expected);
  }
  assert.equal(f.nativeRequests.length, 0);
});

test("search rejects unknown, prefix-only, text-only and pending external models before any upstream I/O", async (t) => {
  const f = await fixture(t, { externalRequestGate: async () => { throw new Error(CANARY); } });
  for (const [model, status, code] of [
    ["lmstudio/", 400, "UNKNOWN_MODEL"],
    ["lmstudio/not-registered", 400, "UNKNOWN_MODEL"],
    ["lmstudio/text-only", 400, "MODEL_NOT_CERTIFIED"],
    [EXTERNAL_MODEL, 503, "MODEL_CERTIFICATION_PENDING"],
  ]) {
    const result = await request(f.port, { body: searchBody(model), headers: { "x-model-bridge-certification": "fake-bypass" } });
    assert.equal(result.status, status);
    assert.equal(JSON.parse(result.text).error.code, code);
    assert.equal(result.text.includes(CANARY), false);
  }
  assert.equal(f.nativeRequests.length, 0);
  assert.equal(f.modelRequests(), 0);
  assert.equal(f.credentialReads(), 0);
});

test("external search requires an available exact native search model", async (t) => {
  for (const nativeSearchModel of [undefined, "not-in-catalog"]) {
    const f = await fixture(t, { nativeSearchModel });
    const result = await request(f.port);
    assert.equal(result.status, 503);
    assert.equal(JSON.parse(result.text).error.code, "SEARCH_MODEL_UNAVAILABLE");
    assert.equal(f.nativeRequests.length, 0);
  }
  assert.throws(() => createWebSearchProxy({ registry: { resolve() {} }, nativeSearchModel: EXTERNAL_MODEL }), /native model slug/u);
  assert.throws(() => createWebSearchProxy({ registry: { resolve() {} }, nativeBaseUrl: "http://public.example/v1" }), /protected upstream/u);
});

test("external search refuses a configured search model that resolves to a nonnative route", async (t) => {
  for (const kind of ["external", "unknown-route-kind"]) {
    const f = await fixture(t, { registryOverride: {
      listModels: () => [],
      resolve: (model) => model === NATIVE_MODEL
        ? { kind, toolsEnabled: true }
        : { kind: "external", toolsEnabled: true },
    } });
    const result = await request(f.port);
    assert.equal(result.status, 503);
    assert.equal(JSON.parse(result.text).error.code, "SEARCH_MODEL_UNAVAILABLE");
    assert.equal(f.nativeRequests.length, 0);
    assert.equal(f.modelRequests(), 0);
    assert.equal(f.credentialReads(), 0);
  }
});

test("search refuses incompatible Codex state before parsing or upstream access", async (t) => {
  const f = await fixture(t, { compatibilityGate: {
    snapshot: () => ({ status: "update-required" }),
    assertReady: async () => { throw Object.assign(new Error(CANARY), { code: "DESKTOP_COMPATIBILITY_UPDATE_REQUIRED" }); },
  } });
  const result = await request(f.port);
  assert.equal(result.status, 503);
  assert.equal(JSON.parse(result.text).error.code, "DESKTOP_COMPATIBILITY_UPDATE_REQUIRED");
  assert.equal(f.nativeRequests.length, 0);
});

test("search validates schema and compressed size before upstream I/O", async (t) => {
  const f = await fixture(t, { limits: { requestBodyBytes: 1024 } });
  for (const body of [
    { ...searchBody(), base_url: `https://${CANARY}.example/` },
    { ...searchBody(), commands: { execute: CANARY } },
    { ...searchBody(), settings: { external_web_access: "anything" } },
    { ...searchBody(), id: null },
  ]) {
    const result = await request(f.port, { body });
    assert.equal(result.status, 400);
    assert.equal(JSON.parse(result.text).error.code, "INVALID_WEB_SEARCH");
    assert.equal(result.text.includes(CANARY), false);
  }
  const result = await request(f.port, {
    body: gzipSync(Buffer.from(JSON.stringify({ ...searchBody(), input: "x".repeat(5000) }))),
    headers: { "content-encoding": "gzip" },
  });
  assert.equal(result.status, 413);
  assert.equal(f.nativeRequests.length, 0);
});

test("external search errors and redirects never disclose native account or request details", async (t) => {
  for (const status of [401, 403, 429, 500, 302]) {
    const f = await fixture(t, { nativeHandler: (_incoming, outgoing) => {
      outgoing.writeHead(status, { "content-type": "application/json", location: `https://${CANARY}.example/` });
      outgoing.end(JSON.stringify({ error: CANARY }));
    } });
    const result = await request(f.port);
    assert.equal(result.status, status === 302 ? 502 : status);
    assert.equal(JSON.parse(result.text).error.code, "SEARCH_SERVICE_ERROR");
    assert.equal(result.text.includes(CANARY), false);
    assert.equal(result.headers.location, undefined);
    assert.equal(f.nativeRequests.length, 1);
    assert.equal(f.modelRequests(), 0);
  }
});

test("external search validates bounded successful envelopes before returning them", async (t) => {
  for (const [contentType, contentEncoding, body] of [
    ["text/html", undefined, CANARY],
    ["application/json", undefined, JSON.stringify({ output: CANARY, account: CANARY })],
    ["application/json", undefined, JSON.stringify({ results: [] })],
    ["application/json", undefined, "{"],
    ["application/json", "gzip", gzipSync(Buffer.from('{"output":"source"}'))],
    ["application/json", undefined, JSON.stringify({ output: "x".repeat(RESPONSE_TRANSFORM_MAX_BYTES) })],
  ]) {
    const f = await fixture(t, { nativeHandler: (_incoming, outgoing) => {
      outgoing.writeHead(200, { "content-type": contentType, ...(contentEncoding ? { "content-encoding": contentEncoding } : {}) });
      outgoing.end(body);
    } });
    const result = await request(f.port);
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.text).error.code, "UPSTREAM_RESPONSE_ERROR");
    assert.equal(result.text.includes(CANARY), false);
  }
});

test("external search success discards native account, credential and private response headers", async (t) => {
  const f = await fixture(t, { nativeHandler: (_incoming, outgoing) => {
    outgoing.writeHead(200, {
      "content-type": "application/json",
      authorization: `Bearer ${CANARY}`,
      "chatgpt-account-id": CANARY,
      "x-codex-private": CANARY,
      "x-upstream-private": CANARY,
      "www-authenticate": CANARY,
      "set-cookie": CANARY,
    });
    outgoing.end(JSON.stringify({ output: "A public source" }));
  } });
  const result = await request(f.port);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.text), { output: "A public source" });
  assert.equal(JSON.stringify(result.headers).includes(CANARY), false);
  assert.equal(result.headers["cache-control"], "no-store");
});

test("external search buffers partial responses until completion or a fixed timeout error", async (t) => {
  for (const [limits, code] of [
    [{ streamIdleTimeoutMs: 30, upstreamTotalTimeoutMs: 1000 }, "UPSTREAM_IDLE_TIMEOUT"],
    [{ streamIdleTimeoutMs: 1000, upstreamTotalTimeoutMs: 30 }, "UPSTREAM_TOTAL_TIMEOUT"],
  ]) {
    const f = await fixture(t, {
      limits,
      nativeHandler: (_incoming, outgoing) => {
        outgoing.writeHead(200, { "content-type": "application/json", "x-upstream-private": CANARY });
        outgoing.write(`{"output":"${CANARY}`);
      },
    });
    const result = await request(f.port);
    assert.equal(result.status, 504);
    assert.equal(JSON.parse(result.text).error.code, code);
    assert.equal(result.text.includes(CANARY), false);
    assert.equal(JSON.stringify(result.headers).includes(CANARY), false);
    assert.equal(f.nativeRequests.length, 1);
  }
});

test("external search never returns a partially received response after upstream abort", async (t) => {
  const f = await fixture(t, { nativeHandler: (_incoming, outgoing) => {
    outgoing.writeHead(200, { "content-type": "application/json", "x-upstream-private": CANARY });
    outgoing.write(`{"output":"${CANARY}`, () => {
      setImmediate(() => outgoing.destroy());
    });
  } });
  const result = await request(f.port);
  assert.equal(result.status, 502);
  assert.equal(JSON.parse(result.text).error.code, "UPSTREAM_ABORTED");
  assert.equal(result.text.includes(CANARY), false);
  assert.equal(JSON.stringify(result.headers).includes(CANARY), false);
});

test("search skips upstream I/O when the client ends while the certification gate is pending", async (t) => {
  for (const cancellation of ["request-aborted", "response-destroyed", "response-ended"]) {
    let releaseGate;
    const gatePending = new Promise((resolve) => { releaseGate = resolve; });
    let enterGate;
    const gateEntered = new Promise((resolve) => { enterGate = resolve; });
    let upstreamCalls = 0;
    const transport = { request() {
      upstreamCalls += 1;
      throw new Error("A closed client must not open an upstream request");
    } };
    const proxy = createWebSearchProxy({
      registry: { resolve: (model) => model === NATIVE_MODEL
        ? { kind: "native-openai" }
        : { kind: "external", toolsEnabled: true } },
      nativeSearchModel: NATIVE_MODEL,
      httpsTransport: transport,
      externalRequestGate: async () => { enterGate(); await gatePending; },
    });
    const incoming = new PassThrough();
    incoming.headers = {};
    const outgoing = new Writable({ write(_chunk, _encoding, done) { done(); } });
    outgoing.writeHead = () => assert.fail("A closed client must not receive a response");
    t.after(() => { releaseGate(); incoming.destroy(); outgoing.destroy(); });
    const handled = proxy(incoming, outgoing, "/v1/alpha/search");
    incoming.end(JSON.stringify(searchBody()));
    await gateEntered;
    if (cancellation === "request-aborted") {
      incoming.aborted = true;
      incoming.emit("aborted");
    } else if (cancellation === "response-destroyed") {
      const closed = once(outgoing, "close");
      outgoing.destroy();
      await closed;
    } else {
      const finished = once(outgoing, "finish");
      outgoing.end();
      await finished;
    }
    releaseGate();
    await handled;
    assert.equal(upstreamCalls, 0, cancellation);
  }
});

test("search reports fixed timeout errors and cancels upstream when the caller aborts", async (t) => {
  const f = await fixture(t, {
    nativeHandler: () => {},
    limits: { upstreamHeadersTimeoutMs: 30, upstreamTotalTimeoutMs: 1000 },
  });
  const timedOut = await request(f.port);
  assert.equal(timedOut.status, 504);
  assert.equal(JSON.parse(timedOut.text).error.code, "UPSTREAM_HEADERS_TIMEOUT");
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let signalClosed;
  const closed = new Promise((resolve) => { signalClosed = resolve; });
  const abortFixture = await fixture(t, {
    nativeHandler: (_incoming, outgoing) => {
      outgoing.once("close", signalClosed);
      signalStarted();
    },
  });
  const caller = http.request({ hostname: "127.0.0.1", port: abortFixture.port, path: SEARCH, method: "POST" });
  caller.on("error", () => {});
  caller.end(JSON.stringify(searchBody()));
  await started;
  caller.destroy();
  await closed;
});
