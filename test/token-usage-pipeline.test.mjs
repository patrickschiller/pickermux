import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { listenBridgeServer } from "../src/bridge-server.mjs";
import { CERTIFICATION_HEADER } from "../src/certification-transport.mjs";
import { createResponsesProxy } from "../src/responses-proxy.mjs";
import { createUsageStore } from "../src/usage-store.mjs";

const CAPABILITY = "offline_usage_capability_0123456789_ABCDEFGHIJKLMN";
const INSTANCE = "offline-usage-instance-0123456789";
const usage = { input_tokens: 123, output_tokens: 17, total_tokens: 140 };
const counts = { inputTokens: 123, outputTokens: 17, totalTokens: 140 };

function modelResponse() {
  return {
    id: "private-response-canary", object: "response", status: "completed", usage,
    output: [{
      id: "private-message-canary", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "private-answer-canary", annotations: [] }],
    }],
  };
}

function streamBody(response = modelResponse()) {
  return Buffer.from(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await server.flushTokenUsage?.();
}

function send({ port, path, body, headers = {}, onData }) {
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve) => {
    let settled = false;
    let status;
    let responseHeaders;
    const chunks = [];
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks) });
    };
    const request = http.request({
      hostname: "127.0.0.1", port, path,
      method: bytes ? "POST" : "GET",
      headers: bytes ? { "content-type": "application/json", "content-length": bytes.length, ...headers } : headers,
    }, (response) => {
      status = response.statusCode;
      responseHeaders = response.headers;
      response.on("data", (chunk) => { chunks.push(chunk); onData?.(request); });
      response.once("end", finish);
      response.once("error", finish);
      response.once("aborted", finish);
    });
    request.once("error", finish);
    request.end(bytes);
  });
}

async function harness(t, { limits, gate = async () => {}, onTokenUsage, tokenUsageStore } = {}) {
  const fixtures = [];
  const upstreamRequests = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.once("end", () => {
      upstreamRequests.push({ body: JSON.parse(Buffer.concat(chunks)), headers: request.headers });
      const fixture = fixtures.shift();
      if (typeof fixture === "function") return fixture(response);
      response.writeHead(fixture?.status ?? 200, fixture?.headers ?? { "content-type": "application/json" });
      response.end(fixture?.body ?? JSON.stringify(modelResponse()));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const baseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
  const route = {
    kind: "external", providerId: "lmstudio", providerKind: "lmstudio-responses",
    slug: "lmstudio/example-model", upstreamModel: "example-model", baseUrl,
    allowPrivateNetwork: true, toolsEnabled: false, model: { contextWindow: 32_768 },
    compactionModelHash: "offline-model-hash-0123456789",
  };
  const registry = {
    listModels: () => [],
    resolve(model) {
      if (model === "native-example") return { kind: "native-openai", slug: model };
      if (model === "lmstudio/example-model") return route;
      if (model === "remote/example-model") return { ...route, slug: model, providerId: "remote", providerKind: "openai-responses", toolsEnabled: true };
      throw Object.assign(new Error("unknown"), { code: "UNKNOWN_MODEL", statusCode: 400 });
    },
  };
  const options = { registry, nativeBaseUrl: baseUrl, nativeSearchModel: "native-example", credentialResolver: async () => "provider-secret-canary", externalRequestGate: gate, limits };
  let server;
  let base;
  if (onTokenUsage) {
    const proxy = createResponsesProxy({ ...options, onTokenUsage });
    server = http.createServer((request, response) => void proxy(request, response, request.url));
    await listen(server);
    base = "";
  } else {
    server = await listenBridgeServer({ ...options, capabilityToken: CAPABILITY, instanceId: INSTANCE, tokenUsageStore });
    base = `/c/${CAPABILITY}`;
  }
  t.after(() => close(server));
  const port = server.address().port;
  return {
    fixtures, upstreamRequests,
    close: () => close(server),
    send: (body = {}, options = {}) => send({ port, path: `${base}/v1/responses`, body: { model: "lmstudio/example-model", input: "Hello", ...body }, ...options }),
    health: async () => JSON.parse((await send({ port, path: `${base}/health` })).body).tokenUsage,
    search: (body) => send({ port, path: `${base}/v1/alpha/search`, body }),
  };
}

test("installed usage survives real server replacement and explicit reset retains last", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pickermux-usage-pipeline-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const parent = path.join(temporary, "PickerMux");
  await mkdir(parent, { mode: 0o700 });
  const directory = path.join(parent, "usage");
  const first = await harness(t, { tokenUsageStore: createUsageStore({ directory }) });
  await first.send();
  first.fixtures.push({ headers: { "content-type": "text/event-stream" }, body: streamBody() });
  await first.send({ stream: true });
  await first.send({}, { headers: { [CERTIFICATION_HEADER]: INSTANCE } });
  await first.send({ model: "native-example" });
  const before = await first.health();
  assert.equal(before.schemaVersion, 2);
  assert.equal(before.providers[0].requests, 2);
  assert.deepEqual(before.providers[0].totals, { inputTokens: 246, outputTokens: 34, totalTokens: 280 });
  await first.close();
  const second = await harness(t, { tokenUsageStore: createUsageStore({ directory }) });
  assert.deepEqual(await second.health(), before);
  const reset = await createUsageStore({ directory }).resetCumulative();
  assert.deepEqual(reset.providers[0].last, before.providers[0].last);
  assert.equal(reset.providers[0].requests, 0);
  assert.deepEqual(reset.providers[0].totals, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.deepEqual(await second.health(), reset);
  await second.send();
  const after = await second.health();
  assert.equal(after.providers[0].requests, 1);
  assert.deepEqual(after.providers[0].totals, counts);
  const saved = await readFile(path.join(directory, "token-usage.json"), "utf8");
  assert.doesNotMatch(saved, /canary|example-model|https?:|capability|input_text/u);
});

test("failed persistence leaves inference bytes untouched and health unavailable", async (t) => {
  let observations = 0;
  const tokenUsageStore = {
    record() { observations += 1; return Promise.reject(new Error("private-store-canary")); },
    readSnapshot() { return Promise.reject(new Error("private-store-canary")); },
    flush() {},
  };
  const proxy = await harness(t, { tokenUsageStore });
  const raw = Buffer.from(JSON.stringify(modelResponse(), null, 2));
  proxy.fixtures.push({ body: raw });
  const result = await proxy.send({ model: "remote/example-model" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, raw);
  assert.equal(observations, 1);
  assert.deepEqual(await proxy.health(), { schemaVersion: 2, status: "unavailable", resetAt: null, providers: [] });
});

test("health shows isolated JSON/SSE totals and one genuine compaction request", async (t) => {
  const proxy = await harness(t);
  assert.deepEqual(await proxy.health(), { schemaVersion: 1, status: "available", providers: [] });
  await proxy.send({}, { headers: { authorization: "Bearer native-secret-canary", cookie: "native-cookie-canary" } });
  proxy.fixtures.push({ headers: { "content-type": "text/event-stream" }, body: streamBody() });
  assert.equal((await proxy.send({ stream: true })).status, 200);
  const raw = Buffer.from(JSON.stringify(modelResponse(), null, 2));
  proxy.fixtures.push({ body: raw });
  const remote = await proxy.send({ model: "remote/example-model" });
  assert.deepEqual(remote.body, raw);
  proxy.fixtures.push({ body: JSON.stringify(modelResponse()) });
  const compact = await proxy.send({ stream: true, input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Summarize history" }] },
    { type: "compaction_trigger" },
  ] });
  assert.equal(compact.status, 200);
  assert.match(compact.body.toString(), /response\.completed/u);
  const snapshot = await proxy.health();
  assert.deepEqual(snapshot.providers, [
    { providerId: "lmstudio", requests: 3, unavailableRequests: 0, last: { status: "available", ...counts }, totals: { inputTokens: 369, outputTokens: 51, totalTokens: 420 } },
    { providerId: "remote", requests: 1, unavailableRequests: 0, last: { status: "available", ...counts }, totals: counts },
  ]);
  assert.equal(proxy.upstreamRequests.length, 4);
  assert.equal(proxy.upstreamRequests[3].body.stream, false);
  assert.equal(proxy.upstreamRequests[0].headers.authorization, "Bearer provider-secret-canary");
  assert.equal(proxy.upstreamRequests[0].headers.cookie, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot), /canary|example-model|https?:|compaction|capability/u);
});

test("missing and compressed generic usage are unavailable without changing passthrough bytes", async (t) => {
  const proxy = await harness(t);
  const bodies = [Buffer.from('{ "status": "completed", "output": [] }'), gzipSync(JSON.stringify(modelResponse()))];
  for (const [index, body] of bodies.entries()) {
    proxy.fixtures.push({ body, headers: { "content-type": "application/json", ...(index ? { "content-encoding": "gzip" } : {}) } });
    const result = await proxy.send({ model: "remote/example-model" });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, body);
  }
  assert.deepEqual((await proxy.health()).providers[0], {
    providerId: "remote", requests: 2, unavailableRequests: 2,
    last: { status: "unavailable" }, totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  });
});

test("certification, native and native search never enter external token counts", async (t) => {
  const proxy = await harness(t);
  await proxy.send({}, { headers: { [CERTIFICATION_HEADER]: INSTANCE } });
  const raw = Buffer.from(JSON.stringify(modelResponse(), null, 2));
  proxy.fixtures.push({ body: raw });
  assert.deepEqual((await proxy.send({ model: "native-example" })).body, raw);
  proxy.fixtures.push({ body: raw });
  assert.equal((await proxy.search({ id: "offline-search-id", model: "native-example", input: [], commands: {} })).status, 200);
  proxy.fixtures.push({ body: '{"output":"source text"}' });
  assert.equal((await proxy.search({ id: "offline-search-id", model: "remote/example-model", input: [], commands: {} })).status, 200);
  assert.equal(proxy.upstreamRequests.length, 4);
  assert.deepEqual(await proxy.health(), { schemaVersion: 1, status: "available", providers: [] });
});

test("rejected external admission and unknown routes are not recorded", async (t) => {
  const proxy = await harness(t, { gate: async () => { throw new Error("private-gate-canary"); } });
  assert.equal((await proxy.send()).status, 503);
  assert.equal((await proxy.send({ model: "unknown" })).status, 400);
  assert.equal(proxy.upstreamRequests.length, 0);
  assert.equal((await proxy.health()).providers.length, 0);
});

test("upstream error, timeout and client abort finalize unavailable exactly once", async (t) => {
  const proxy = await harness(t, { limits: { streamIdleTimeoutMs: 25, upstreamTotalTimeoutMs: 1000 } });
  proxy.fixtures.push({ status: 500, body: JSON.stringify(modelResponse()) });
  await proxy.send();
  proxy.fixtures.push((response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(': waiting\n\n');
  });
  await proxy.send({ model: "remote/example-model", stream: true });
  proxy.fixtures.push((response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(': abort-client\n\n');
  });
  await proxy.send({ model: "remote/example-model", stream: true }, { onData: (request) => request.destroy() });
  proxy.fixtures.push((response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(streamBody(), () => response.destroy());
  });
  await proxy.send({ model: "remote/example-model", stream: true });
  const snapshot = await proxy.health();
  assert.deepEqual(snapshot.providers.map((provider) => [provider.providerId, provider.requests, provider.unavailableRequests]),
    [["lmstudio", 1, 1], ["remote", 3, 3]]);
});

test("later rejected LM Studio frames cannot publish earlier terminal counts", async (t) => {
  const proxy = await harness(t);
  proxy.fixtures.push({ headers: { "content-type": "text/event-stream" }, body: Buffer.concat([streamBody(), Buffer.from('data: invalid\n\n')]) });
  await proxy.send({ stream: true });
  const provider = (await proxy.health()).providers[0];
  assert.equal(provider.requests, 1);
  assert.equal(provider.unavailableRequests, 1);
  assert.deepEqual(provider.last, { status: "unavailable" });
});

test("telemetry sink exceptions cannot change successful provider traffic", async (t) => {
  for (const onTokenUsage of [
    () => { throw new Error("private-observer-canary"); },
    async () => { throw new Error("private-observer-canary"); },
  ]) {
    const proxy = await harness(t, { onTokenUsage });
    const result = await proxy.send();
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), modelResponse());
  }
});
