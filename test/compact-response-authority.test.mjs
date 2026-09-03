import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createResponsesProxy } from "../src/responses-proxy.mjs";

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

function requestUntilClose({ port, body }) {
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
        path: "/v1/responses/compact",
        method: "POST",
        headers: { "content-length": String(body.length) },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("end", () => finish({
          aborted: false,
          body: Buffer.concat(chunks),
          statusCode: response.statusCode,
        }));
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
      },
    );
    request.once("error", () => finish({
      aborted: true,
      body: Buffer.alloc(0),
      statusCode: null,
    }));
    request.end(body);
  });
}

async function createHarness(t, respond) {
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.once("end", () => respond(response));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const handle = createResponsesProxy({
    registry: {
      resolve: () => ({
        kind: "external",
        providerKind: "lmstudio-responses",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        allowPrivateNetwork: true,
        upstreamModel: "local/model",
        toolsEnabled: true,
      }),
    },
  });
  const proxy = http.createServer((request, response) => {
    void handle(request, response, new URL(request.url, "http://proxy.local").pathname);
  });
  const port = await listen(proxy);
  t.after(() => close(proxy));
  return port;
}

function compactRequestBody() {
  return Buffer.from(JSON.stringify({
    model: "lmstudio/local/model",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "compact this transcript" }],
    }],
    tools: [{
      type: "function",
      name: "read_file",
      description: "Read one file",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    }],
  }));
}

test("external compact JSON responses cannot create executable calls", async (t) => {
  const port = await createHarness(t, (response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp-compact",
      status: "completed",
      output: [{
        type: "function_call",
        name: "read_file",
        call_id: "call-compact",
        arguments: "{}",
      }],
    }));
  });

  const result = await requestUntilClose({ port, body: compactRequestBody() });

  assert.equal(result.aborted, true);
  assert.doesNotMatch(result.body.toString("utf8"), /function_call|read_file/u);
});

test("external compact SSE responses cannot create executable calls", async (t) => {
  const port = await createHarness(t, (response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      "event: response.output_item.added",
      "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"item-compact\",\"call_id\":\"call-compact\",\"name\":\"read_file\",\"arguments\":\"{}\"}}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-compact\",\"status\":\"completed\",\"output\":[]}}",
      "",
      "",
    ].join("\n"));
  });

  const result = await requestUntilClose({ port, body: compactRequestBody() });

  assert.equal(result.aborted, true);
  assert.doesNotMatch(result.body.toString("utf8"), /function_call|read_file/u);
});

test("external compact responses still relay ordinary compacted text", async (t) => {
  const port = await createHarness(t, (response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp-compact",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "compact summary" }],
      }],
    }));
  });

  const result = await requestUntilClose({ port, body: compactRequestBody() });

  assert.equal(result.aborted, false);
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body.toString("utf8")).output[0].type, "message");
});
