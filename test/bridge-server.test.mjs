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

test("HTTP Upgrade is rejected with 426", async (t) => {
  const server = await listenBridgeServer({ registry, capabilityToken: CAPABILITY });
  t.after(() => close(server));
  const response = await rawUpgrade(server.address().port, `/c/${CAPABILITY}/v1/responses`);
  assert.match(response, /^HTTP\/1\.1 426 Upgrade Required\r\n/u);
  assert.match(response, /WebSocket transport is not supported/u);
});
