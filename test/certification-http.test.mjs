import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { certificationFetch } from "../src/certification-http.mjs";
import { CERTIFICATION_HEADER } from "../src/certification-transport.mjs";

const CAPABILITY = "certification_test_capability_0123456789";
const CERTIFICATION_TOKEN = "certification-runtime-instance-0123456789";
const PRIVATE_CANARY = "private-certification-error-canary";
const RESPONSE_PATH = `/c/${CAPABILITY}/v1/responses`;

async function localServer(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return server;
}

async function rawServer(t, bytes) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.once("data", () => socket.end(bytes));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  }));
  return server;
}

function target(server) {
  return `http://127.0.0.1:${server.address().port}${RESPONSE_PATH}`;
}

function requestOptions(overrides = {}) {
  return {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      [CERTIFICATION_HEADER]: CERTIFICATION_TOKEN,
    },
    body: JSON.stringify({ input: "A short UTF-8 probe: Grüße" }),
    signal: AbortSignal.timeout(2000),
    ...overrides,
  };
}

async function responseText(response) {
  assert.ok(response.body instanceof ReadableStream);
  const reader = response.body.getReader();
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks).toString("utf8");
      assert.ok(value instanceof Uint8Array);
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

function safeFailure(code) {
  return (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.code, code);
    assert.equal(Object.hasOwn(error, "cause"), false);
    const rendered = `${String(error)} ${JSON.stringify(error)} ${error.stack}`;
    for (const secret of [CAPABILITY, CERTIFICATION_TOKEN, PRIVATE_CANARY]) {
      assert.equal(rendered.includes(secret), false);
    }
    assert.equal(rendered.includes("http://"), false);
    return true;
  };
}

function closedConnection() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

test("certification HTTP preserves delayed JSON bytes and allowlisted headers", async (t) => {
  let received;
  const body = '{ "output": "Grüße from a local probe" }';
  const server = await localServer(t, (incoming, outgoing) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      received = {
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
        bytes: Buffer.concat(chunks),
      };
      const timer = setTimeout(() => {
        outgoing.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "identity",
        });
        outgoing.write(body.slice(0, 12));
        const bodyTimer = setTimeout(() => outgoing.end(body.slice(12)), 20);
        t.after(() => clearTimeout(bodyTimer));
      }, 20);
      t.after(() => clearTimeout(timer));
    });
  });
  const options = requestOptions();
  const response = await certificationFetch(target(server), options);
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.ok(response.headers instanceof Headers);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(await responseText(response), body);
  assert.equal(received.method, "POST");
  assert.equal(received.path, RESPONSE_PATH);
  assert.deepEqual(received.bytes, Buffer.from(options.body, "utf8"));
  assert.equal(received.headers.accept, "application/json");
  assert.equal(received.headers["content-type"], "application/json");
  assert.equal(received.headers[CERTIFICATION_HEADER], CERTIFICATION_TOKEN);
  assert.equal(received.headers["content-length"], String(Buffer.byteLength(options.body)));
  assert.equal(received.headers["accept-encoding"], "identity");
  assert.deepEqual(
    Object.keys(received.headers).filter((name) => !["host", "connection"].includes(name)).sort(),
    ["accept", "accept-encoding", "content-length", "content-type", CERTIFICATION_HEADER].sort(),
  );
});

test("certification HTTP exposes SSE headers before the response completes", async (t) => {
  let finish;
  const server = await localServer(t, (incoming, outgoing) => {
    incoming.resume();
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.flushHeaders();
    finish = () => outgoing.end("event: response.completed\ndata: {}\n\n");
  });
  const options = requestOptions();
  options.headers.accept = "text/event-stream";
  const response = await certificationFetch(target(server), options);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  finish();
  assert.equal(await responseText(response), "event: response.completed\ndata: {}\n\n");
});

test("certification HTTP preserves error status and bytes for the runner", async (t) => {
  const server = await localServer(t, (incoming, outgoing) => {
    incoming.resume();
    outgoing.writeHead(503, { "content-type": "application/json" });
    outgoing.end('{"error":{"code":"MODEL_CERTIFICATION_PENDING"}}');
  });
  const response = await certificationFetch(target(server), requestOptions());
  assert.equal(response.ok, false);
  assert.equal(response.status, 503);
  assert.equal(await responseText(response), '{"error":{"code":"MODEL_CERTIFICATION_PENDING"}}');
});

test("certification HTTP rejects noncanonical targets before local I/O", async (t) => {
  let requests = 0;
  let connections = 0;
  const server = await localServer(t, (incoming, outgoing) => {
    requests += 1;
    incoming.resume();
    outgoing.end("{}");
  });
  server.on("connection", () => { connections += 1; });
  const port = server.address().port;
  const url = target(server);
  const invalid = [
    undefined,
    null,
    123,
    "",
    `https://127.0.0.1:${port}${RESPONSE_PATH}`,
    `http://localhost:${port}${RESPONSE_PATH}`,
    `http://[::1]:${port}${RESPONSE_PATH}`,
    `http://127.1:${port}${RESPONSE_PATH}`,
    `http://2130706433:${port}${RESPONSE_PATH}`,
    `http://127.0.0.2:${port}${RESPONSE_PATH}`,
    `http://user:${PRIVATE_CANARY}@127.0.0.1:${port}${RESPONSE_PATH}`,
    `http://127.0.0.1${RESPONSE_PATH}`,
    `http://127.0.0.1:0${RESPONSE_PATH}`,
    `http://127.0.0.1:65536${RESPONSE_PATH}`,
    `http://127.0.0.1:0${port}${RESPONSE_PATH}`,
    `${url}?secret=${PRIVATE_CANARY}`,
    `${url}#${PRIVATE_CANARY}`,
    `${url}?`,
    `${url}#`,
    `${url}/`,
    ` ${url}`,
    `${url}\n`,
    `http://127.0.0.1:${port}/c/short/v1/responses`,
    `http://127.0.0.1:${port}/c/${"a".repeat(257)}/v1/responses`,
    `http://127.0.0.1:${port}/c/${CAPABILITY}/v1/../v1/responses`,
    `http://127.0.0.1:${port}/c/${CAPABILITY}/v1/%2e%2e/v1/responses`,
    `http://127.0.0.1:${port}/c/${CAPABILITY}/v1/%72esponses`,
    `http://127.0.0.1:${port}/c/${CAPABILITY}/v1/responses/../responses`,
    `http://127.0.0.1:${port}/c/${CAPABILITY}\\v1\\responses`,
  ];
  for (const value of invalid) {
    await assert.rejects(certificationFetch(value, requestOptions()), safeFailure("CERTIFICATION_INVALID_TARGET"));
  }
  assert.equal(requests, 0);
  assert.equal(connections, 0);
});

test("certification HTTP rejects ambiguous request options and headers before I/O", async (t) => {
  let requests = 0;
  let connections = 0;
  const server = await localServer(t, (incoming, outgoing) => {
    requests += 1;
    incoming.resume();
    outgoing.end("{}");
  });
  server.on("connection", () => { connections += 1; });
  const options = requestOptions();
  const variants = [
    undefined,
    null,
    {},
    { ...options, method: "GET" },
    { ...options, method: "post" },
    { ...options, credentials: "include" },
    { ...options, [Symbol("unknown-option")]: PRIVATE_CANARY },
    { ...options, redirect: "follow" },
    { ...options, redirect: "manual" },
    { ...options, body: null },
    { ...options, body: Buffer.from("{}") },
    { ...options, signal: undefined },
    { ...options, signal: { aborted: false } },
    { ...options, headers: undefined },
    { ...options, headers: [] },
    { ...options, headers: new Headers(options.headers) },
    { ...options, headers: { ...options.headers, [Symbol("unknown-header")]: PRIVATE_CANARY } },
    { ...options, headers: { ...options.headers, accept: "*/*" } },
    { ...options, headers: { ...options.headers, "content-type": "text/plain" } },
    { ...options, headers: { ...options.headers, [CERTIFICATION_HEADER]: "" } },
    { ...options, headers: { ...options.headers, [CERTIFICATION_HEADER]: `${PRIVATE_CANARY}\r\nInjected: yes` } },
    { ...options, headers: { ...options.headers, [CERTIFICATION_HEADER]: [CERTIFICATION_TOKEN] } },
  ];
  for (const name of ["authorization", "cookie", "host", "content-length", "accept-encoding", "x-private", "Accept"]) {
    variants.push({ ...options, headers: { ...options.headers, [name]: PRIVATE_CANARY } });
  }
  for (const value of variants) {
    await assert.rejects(certificationFetch(target(server), value), safeFailure("CERTIFICATION_INVALID_REQUEST"));
  }
  assert.equal(requests, 0);
  assert.equal(connections, 0);
});

test("certification HTTP rejects an already aborted request without connecting", async (t) => {
  let connections = 0;
  const server = await localServer(t, (incoming, outgoing) => {
    incoming.resume();
    outgoing.end("{}");
  });
  server.on("connection", () => { connections += 1; });
  const controller = new AbortController();
  controller.abort(new Error(PRIVATE_CANARY));
  await assert.rejects(
    certificationFetch(target(server), requestOptions({ signal: controller.signal })),
    safeFailure("CERTIFICATION_ABORTED"),
  );
  assert.equal(connections, 0);
});

test("certification HTTP rejects an already expired timeout without connecting", async (t) => {
  let connections = 0;
  const server = await localServer(t, (incoming, outgoing) => {
    incoming.resume();
    outgoing.end("{}");
  });
  server.on("connection", () => { connections += 1; });
  const controller = new AbortController();
  controller.abort(new DOMException(PRIVATE_CANARY, "TimeoutError"));
  await assert.rejects(
    certificationFetch(target(server), requestOptions({ signal: controller.signal })),
    safeFailure("CERTIFICATION_TIMEOUT"),
  );
  assert.equal(connections, 0);
});

test("certification HTTP timeout covers delayed headers and closes the connection", async (t) => {
  const closed = closedConnection();
  const controller = new AbortController();
  const server = await localServer(t, (incoming, outgoing) => {
    incoming.resume();
    outgoing.on("close", closed.resolve);
    controller.abort(new DOMException(PRIVATE_CANARY, "TimeoutError"));
  });
  await assert.rejects(
    certificationFetch(target(server), requestOptions({ signal: controller.signal })),
    safeFailure("CERTIFICATION_TIMEOUT"),
  );
  await closed.promise;
});

test("certification HTTP abort during delayed headers closes the connection", async (t) => {
  const closed = closedConnection();
  const controller = new AbortController();
  const server = await localServer(t, (incoming, outgoing) => {
    incoming.resume();
    outgoing.on("close", closed.resolve);
    controller.abort(new Error(PRIVATE_CANARY));
  });
  await assert.rejects(
    certificationFetch(target(server), requestOptions({ signal: controller.signal })),
    safeFailure("CERTIFICATION_ABORTED"),
  );
  await closed.promise;
});

for (const [reason, code] of [
  [new DOMException(PRIVATE_CANARY, "TimeoutError"), "CERTIFICATION_TIMEOUT"],
  [new Error(PRIVATE_CANARY), "CERTIFICATION_ABORTED"],
]) {
  test(`certification HTTP ${code} remains active after response headers`, async (t) => {
    const closed = closedConnection();
    const controller = new AbortController();
    const server = await localServer(t, (incoming, outgoing) => {
      incoming.resume();
      outgoing.on("close", closed.resolve);
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.write('{"output":');
    });
    const response = await certificationFetch(target(server), requestOptions({ signal: controller.signal }));
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    const rejectedRead = assert.rejects(reader.read(), safeFailure(code));
    controller.abort(reason);
    await rejectedRead;
    reader.releaseLock();
    await closed.promise;
  });
}

test("certification HTTP enforces the overall signal deadline while body data arrives", async (t) => {
  const closed = closedConnection();
  let chunksWritten = 0;
  const server = await localServer(t, (incoming, outgoing) => {
    incoming.resume();
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.write("data: {}\n\n");
    const interval = setInterval(() => {
      chunksWritten += 1;
      outgoing.write("data: {}\n\n");
    }, 10);
    t.after(() => clearInterval(interval));
    outgoing.on("close", () => {
      clearInterval(interval);
      closed.resolve();
    });
  });
  const options = requestOptions({ signal: AbortSignal.timeout(150) });
  options.headers.accept = "text/event-stream";
  const response = await certificationFetch(target(server), options);
  await assert.rejects(responseText(response), safeFailure("CERTIFICATION_TIMEOUT"));
  await closed.promise;
  assert.ok(chunksWritten > 0);
});

test("certification HTTP body cancellation closes the connection without leaking its reason", async (t) => {
  const closed = closedConnection();
  const server = await localServer(t, (incoming, outgoing) => {
    incoming.resume();
    outgoing.on("close", closed.resolve);
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.flushHeaders();
  });
  const response = await certificationFetch(target(server), requestOptions());
  await response.body.cancel(new Error(PRIVATE_CANARY));
  await closed.promise;
});

test("certification HTTP does not follow redirects or send the private marker to their target", async (t) => {
  let redirectedRequests = 0;
  let redirectedConnections = 0;
  const destination = await localServer(t, (incoming, outgoing) => {
    redirectedRequests += 1;
    incoming.resume();
    outgoing.end("{}");
  });
  destination.on("connection", () => { redirectedConnections += 1; });
  let redirects = 0;
  const server = await localServer(t, (incoming, outgoing) => {
    redirects += 1;
    incoming.resume();
    outgoing.writeHead(307, { location: `${target(destination)}?private=${PRIVATE_CANARY}` });
    outgoing.end(PRIVATE_CANARY);
  });
  await assert.rejects(
    certificationFetch(target(server), requestOptions()),
    safeFailure("CERTIFICATION_REDIRECT"),
  );
  assert.equal(redirects, 1);
  assert.equal(redirectedRequests, 0);
  assert.equal(redirectedConnections, 0);
});

test("certification HTTP rejects every redirect status even without a Location header", async (t) => {
  let status = 300;
  const server = await localServer(t, (incoming, outgoing) => {
    incoming.resume();
    outgoing.writeHead(status);
    outgoing.end();
  });
  for (const nextStatus of [300, 301, 302, 303, 304, 305, 307, 308, 399]) {
    status = nextStatus;
    await assert.rejects(
      certificationFetch(target(server), requestOptions()),
      safeFailure("CERTIFICATION_REDIRECT"),
    );
  }
});

for (const [status, headers, code] of [
  [307, { location: "/never-follow" }, "CERTIFICATION_REDIRECT"],
  [200, { "content-encoding": "gzip" }, "CERTIFICATION_RESPONSE_ENCODING"],
]) {
  test(`certification HTTP ${code} safely closes a still-streaming response`, async (t) => {
    const closed = closedConnection();
    const server = await localServer(t, (incoming, outgoing) => {
      incoming.resume();
      outgoing.writeHead(status, {
        "content-type": "application/json",
        "content-length": 1024 * 1024,
        ...headers,
      });
      outgoing.write(`${PRIVATE_CANARY}${"x".repeat(64 * 1024)}`);
      const interval = setInterval(() => outgoing.write(PRIVATE_CANARY), 10);
      t.after(() => clearInterval(interval));
      outgoing.on("close", () => {
        clearInterval(interval);
        closed.resolve();
      });
    });
    await assert.rejects(
      certificationFetch(target(server), requestOptions()),
      safeFailure(code),
    );
    await closed.promise;
  });
}

test("certification HTTP rejects response headers above 64 KiB", async (t) => {
  const server = await localServer(t, (incoming, outgoing) => {
    incoming.resume();
    outgoing.writeHead(200, {
      "content-type": "application/json",
      "x-private": `${PRIVATE_CANARY}${"a".repeat(70 * 1024)}`,
    });
    outgoing.end("{}");
  });
  await assert.rejects(
    certificationFetch(target(server), requestOptions()),
    safeFailure("CERTIFICATION_RESPONSE_HEADERS"),
  );
});

test("certification HTTP allows response headers within the explicit 64 KiB budget", async (t) => {
  const server = await localServer(t, (incoming, outgoing) => {
    incoming.resume();
    outgoing.writeHead(200, {
      "content-type": "application/json",
      "x-test-padding": "a".repeat(32 * 1024),
    });
    outgoing.end("{}");
  });
  const response = await certificationFetch(target(server), requestOptions());
  assert.equal(await responseText(response), "{}");
});

for (const [name, firstValue, secondValue] of [
  ["Content-Type", "application/json", "text/plain"],
  ["Content-Encoding", "identity", "identity"],
  ["Content-Length", "2", "2"],
]) {
  test(`certification HTTP rejects duplicate ${name} before header normalization`, async (t) => {
    const server = await rawServer(t, [
      "HTTP/1.1 200 OK",
      `${name}: ${firstValue}`,
      `${name.toLowerCase()}: ${secondValue}`,
      "Connection: close",
      "",
      "{}",
    ].join("\r\n"));
    await assert.rejects(
      certificationFetch(target(server), requestOptions()),
      safeFailure("CERTIFICATION_RESPONSE_HEADERS"),
    );
  });
}

test("certification HTTP redacts malformed raw response headers", async (t) => {
  const server = await rawServer(t, [
    "HTTP/1.1 200 OK",
    "Content-Type: application/json",
    `Invalid\u0000Header: ${PRIVATE_CANARY}`,
    "Connection: close",
    "",
    "{}",
  ].join("\r\n"));
  await assert.rejects(
    certificationFetch(target(server), requestOptions()),
    safeFailure("CERTIFICATION_RESPONSE_HEADERS"),
  );
});

test("certification HTTP rejects unexpected compression before exposing the body", async (t) => {
  let encoding;
  const server = await localServer(t, (incoming, outgoing) => {
    incoming.resume();
    outgoing.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": encoding,
    });
    outgoing.end(PRIVATE_CANARY);
  });
  for (const nextEncoding of ["gzip", "br", "deflate", "zstd", "identity, gzip", PRIVATE_CANARY]) {
    encoding = nextEncoding;
    await assert.rejects(
      certificationFetch(target(server), requestOptions()),
      safeFailure("CERTIFICATION_RESPONSE_ENCODING"),
    );
  }
});

test("certification HTTP redacts a refused local connection", async (t) => {
  const server = await localServer(t, (_incoming, outgoing) => outgoing.end("{}"));
  const url = target(server);
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(
    certificationFetch(url, requestOptions()),
    safeFailure("CERTIFICATION_CONNECTION_FAILED"),
  );
});

test("certification HTTP redacts a connection closed before headers", async (t) => {
  const server = await localServer(t, (incoming) => incoming.socket.destroy());
  await assert.rejects(
    certificationFetch(target(server), requestOptions()),
    safeFailure("CERTIFICATION_CONNECTION_FAILED"),
  );
});

test("certification HTTP rejects a truncated body with a safe transport code", async (t) => {
  let closeBody;
  const server = await localServer(t, (incoming, outgoing) => {
    incoming.resume();
    outgoing.writeHead(200, {
      "content-type": "application/json",
      "content-length": 200,
    });
    outgoing.write('{"output":');
    closeBody = () => outgoing.destroy();
  });
  const response = await certificationFetch(target(server), requestOptions());
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  const rejectedRead = assert.rejects(reader.read(), safeFailure("CERTIFICATION_BODY_FAILED"));
  closeBody();
  await rejectedRead;
  reader.releaseLock();
});

test("certification HTTP completion remains readable after a later abort", async (t) => {
  const controller = new AbortController();
  const server = await localServer(t, (incoming, outgoing) => {
    incoming.resume();
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end("{}");
  });
  const response = await certificationFetch(target(server), requestOptions({ signal: controller.signal }));
  assert.equal(await responseText(response), "{}");
  controller.abort(new Error(PRIVATE_CANARY));
  await delay(0);
});
