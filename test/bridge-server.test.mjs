import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import {
  bridgeProviderBaseUrl,
  capabilityBasePath,
  createBridgeServer,
  listenBridgeServer,
} from "../src/bridge-server.mjs";

const CAPABILITY = "test_capability_0123456789_ABCDEFGHIJKLMN";

const registry = {
  resolve(model) {
    throw Object.assign(new Error(`Unknown model: ${model}`), {
      code: "UNKNOWN_MODEL",
      statusCode: 400,
    });
  },
  listModels() {
    return [
      { id: "gpt-5.6-sol", object: "model", owned_by: "openai", kind: "native-openai" },
      {
        id: "lmstudio/qwen/qwen3.8-27b",
        owned_by: "lmstudio",
        kind: "external",
        display_name: "Qwen",
        baseUrl: "http://must-not-leak.invalid/v1",
        upstreamModel: "must-not-leak",
        credentialEnv: "MUST_NOT_LEAK",
      },
    ];
  },
};

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function listenLocal(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server.address().port;
}

function request({ port, path, method = "GET", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers,
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({
            statusCode: incoming.statusCode,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function rawUpgrade(port, path) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks = [];
    socket.on("connect", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

test("capability token must be a high-entropy URL-safe path segment", () => {
  assert.equal(capabilityBasePath(CAPABILITY), `/c/${CAPABILITY}`);
  assert.throws(() => capabilityBasePath("short"), /32-256/u);
  assert.throws(() => capabilityBasePath(`${"a".repeat(32)}/escape`), /URL-safe/u);
});

test("server cannot be bound outside IPv4 loopback", async () => {
  const server = createBridgeServer({ registry, capabilityToken: CAPABILITY });
  assert.throws(() => server.listen(0, "0.0.0.0"), /127\.0\.0\.1/u);
  assert.throws(() => server.listen({ port: 0, host: "::" }), /127\.0\.0\.1/u);
  assert.throws(() => server.listen("/tmp/model-bridge.sock"), /numeric loopback port/u);
  await close(server);
});

test("capability-scoped health and model catalog expose only safe diagnostics", async (t) => {
  const server = await listenBridgeServer({
    registry,
    capabilityToken: CAPABILITY,
    instanceId: "instance-test-1",
  });
  t.after(() => close(server));
  const port = server.address().port;
  const base = `/c/${CAPABILITY}`;

  assert.equal(server.capabilityPath, base);
  assert.equal(server.providerBaseUrl, `http://127.0.0.1:${port}${base}/v1`);
  assert.equal(bridgeProviderBaseUrl(server, CAPABILITY), server.providerBaseUrl);
  assert.equal(server.address().address, "127.0.0.1");
  assert.ok(server.keepAliveTimeout >= 120_000);
  assert.ok(server.headersTimeout >= 125_000);

  const health = await request({ port, path: `${base}/health` });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true, instanceId: "instance-test-1" });
  assert.equal(health.headers["cache-control"], "no-store");

  const models = await request({ port, path: `${base}/v1/models` });
  assert.equal(models.statusCode, 200);
  const payload = JSON.parse(models.body);
  assert.equal(payload.object, "list");
  assert.equal(payload.data.length, 2);
  assert.deepEqual(payload.data[1], {
    id: "lmstudio/qwen/qwen3.8-27b",
    object: "model",
    owned_by: "lmstudio",
    kind: "external",
    display_name: "Qwen",
  });
  assert.doesNotMatch(models.body, /must-not-leak|credentialEnv|baseUrl|upstreamModel/u);
});

test("health exposes only aggregate text-only context counters", async (t) => {
  const privateCanary = "/Users/private/thread-secret-qwen";
  const observedEvents = [];
  const upstream = http.createServer((incoming, outgoing) => {
    incoming.resume();
    incoming.once("end", () => {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end('{"ok":true}');
    });
  });
  const upstreamPort = await listenLocal(upstream);
  t.after(() => close(upstream));
  const telemetryRegistry = {
    listModels: () => [],
    resolve: () => ({
      kind: "external",
      providerKind: "lmstudio-responses",
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      allowPrivateNetwork: true,
      upstreamModel: "private-upstream-model",
      toolsEnabled: false,
    }),
  };
  const server = await listenBridgeServer({
    registry: telemetryRegistry,
    capabilityToken: CAPABILITY,
    onTextOnlyCompaction: (event) => observedEvents.push(event),
  });
  t.after(() => close(server));
  const port = server.address().port;
  const base = `/c/${CAPABILITY}`;
  const response = await request({
    port,
    path: `${base}/v1/responses`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "lmstudio/private-model",
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: privateCanary }],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["memories.instructions"],
          },
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["user.text"],
          },
        },
      ],
    }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(observedEvents.length, 1);

  const health = await request({ port, path: `${base}/health` });
  const payload = JSON.parse(health.body);
  assert.equal(payload.textOnlyContext.schemaVersion, 1);
  assert.equal(payload.textOnlyContext.requests, 1);
  assert.equal(payload.textOnlyContext.last.outcome, "compacted");
  assert.equal(payload.textOnlyContext.last.stopReason, "conversation");
  assert.equal(payload.textOnlyContext.last.omittedParts, 1);
  assert.deepEqual(
    payload.textOnlyContext.totals,
    Object.fromEntries(
      Object.entries(payload.textOnlyContext.last)
        .filter(([, value]) => Number.isSafeInteger(value))
        .map(([name, value]) => [name, value]),
    ),
  );
  assert.doesNotMatch(
    health.body,
    /Users|thread-secret|qwen|private-model|upstream-model|memories\.instructions/u,
  );
});

test("Host, Origin, capability, query and method checks fail closed", async (t) => {
  const server = await listenBridgeServer({ registry, capabilityToken: CAPABILITY });
  t.after(() => close(server));
  const port = server.address().port;
  const base = `/c/${CAPABILITY}`;

  const forgedHost = await request({
    port,
    path: `${base}/health`,
    headers: { host: `localhost:${port}` },
  });
  assert.equal(forgedHost.statusCode, 421);

  const browser = await request({
    port,
    path: `${base}/health`,
    headers: { origin: "null" },
  });
  assert.equal(browser.statusCode, 403);

  const wrongCapability = await request({
    port,
    path: `/c/${"z".repeat(40)}/health`,
  });
  assert.equal(wrongCapability.statusCode, 404);
  assert.doesNotMatch(wrongCapability.body, new RegExp(CAPABILITY, "u"));

  const query = await request({ port, path: `${base}/health?probe=1` });
  assert.equal(query.statusCode, 404);

  const method = await request({ port, path: `${base}/v1/responses`, method: "GET" });
  assert.equal(method.statusCode, 405);
});

test("runtime compatibility blocks model traffic before registry or body handling", async (t) => {
  let registryCalls = 0;
  let gateCalls = 0;
  const privateCanary = "/Users/private/thread-secret";
  const compatibilityGate = {
    snapshot() {
      return {
        status: "update-required",
        reasons: ["codex-client-version", privateCanary],
      };
    },
    async assertReady() {
      gateCalls += 1;
      throw Object.assign(new Error(privateCanary), {
        code: "DESKTOP_COMPATIBILITY_UPDATE_REQUIRED",
      });
    },
  };
  const blockedRegistry = {
    resolve() {
      registryCalls += 1;
      throw new Error("registry must not be consulted");
    },
    listModels() {
      registryCalls += 1;
      throw new Error("registry must not be consulted");
    },
  };
  const server = await listenBridgeServer({
    registry: blockedRegistry,
    capabilityToken: CAPABILITY,
    compatibilityGate,
  });
  t.after(() => close(server));
  const port = server.address().port;
  const base = `/c/${CAPABILITY}`;

  const health = await request({ port, path: `${base}/health` });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body), {
    ok: false,
    instanceId: null,
    compatibility: {
      status: "update-required",
      reasons: ["codex-client-version"],
    },
  });

  const models = await request({ port, path: `${base}/v1/models` });
  assert.equal(models.statusCode, 503);
  assert.equal(
    JSON.parse(models.body).error.code,
    "DESKTOP_COMPATIBILITY_UPDATE_REQUIRED",
  );

  for (const endpoint of ["/v1/responses", "/v1/responses/compact"]) {
    const result = await request({
      port,
      path: `${base}${endpoint}`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "private-model", prompt: privateCanary }),
    });
    assert.equal(result.statusCode, 503);
    assert.equal(
      JSON.parse(result.body).error.code,
      "DESKTOP_COMPATIBILITY_UPDATE_REQUIRED",
    );
    assert.doesNotMatch(result.body, /Users|thread-secret|private-model/u);
  }

  assert.equal(gateCalls, 3);
  assert.equal(registryCalls, 0);
});

test("runtime compatibility check failures use a stable unavailable error", async (t) => {
  const server = await listenBridgeServer({
    registry,
    capabilityToken: CAPABILITY,
    compatibilityGate: {
      snapshot: () => {
        throw new Error("private snapshot failure");
      },
      assertReady: async () => {
        throw new Error("private request failure");
      },
    },
  });
  t.after(() => close(server));
  const port = server.address().port;
  const base = `/c/${CAPABILITY}`;

  const health = await request({ port, path: `${base}/health` });
  assert.deepEqual(JSON.parse(health.body).compatibility, {
    status: "check-failed",
    reasons: [],
  });
  const models = await request({ port, path: `${base}/v1/models` });
  assert.equal(models.statusCode, 503);
  assert.equal(
    JSON.parse(models.body).error.code,
    "DESKTOP_COMPATIBILITY_UNAVAILABLE",
  );
  assert.doesNotMatch(models.body, /private|snapshot|request failure/u);
});

test("HTTP Upgrade is rejected with 426", async (t) => {
  const server = await listenBridgeServer({ registry, capabilityToken: CAPABILITY });
  t.after(() => close(server));
  const response = await rawUpgrade(server.address().port, `/c/${CAPABILITY}/v1/responses`);
  assert.match(response, /^HTTP\/1\.1 426 Upgrade Required\r\n/u);
  assert.match(response, /WebSocket transport is not supported/u);
});
