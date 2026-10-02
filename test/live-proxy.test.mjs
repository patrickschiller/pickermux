import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { listenBridgeServer } from "../src/bridge-server.mjs";
import { createLiveProxy } from "../src/responses-proxy.mjs";
import { LIVE_MULTIPART_CONTENT_TYPE } from "../src/live-wire.mjs";

const CAPABILITY = "live_test_capability_0123456789_ABCDEFGHIJ";
const PREFIX = `/c/${CAPABILITY}`;
const LIVE = `${PREFIX}/v1/live`;
const BOUNDARY = "codex-realtime-call-boundary";
const EXTERNAL_MODEL = "lmstudio/example-model";
const CANARY = "private-live-account-credential-and-prompt-canary";
const PROVIDER_CREDENTIAL = "external-provider-only-canary";
const SDP = [
  "v=0",
  "o=- 1 1 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=mid:0",
  "a=ice-ufrag:synthetic",
  "a=ice-pwd:synthetic-password-for-tests",
  `a=fingerprint:sha-256 ${Array(32).fill("00").join(":")}`,
  "a=setup:actpass",
  "a=sendrecv",
  "a=rtcp-mux",
  "a=rtpmap:111 opus/48000/2",
  "",
].join("\r\n");

function session(fields = {}) {
  return {
    instructions: "Help with the current task.",
    audio: { output: { voice: "marin" } },
    delegation: { type: "client" },
    ...fields,
  };
}

function multipart(value = session(), sdp = SDP, sessionJson = JSON.stringify(value)) {
  return Buffer.from(
    `--${BOUNDARY}\r\n` +
    'Content-Disposition: form-data; name="sdp"\r\n' +
    "Content-Type: application/sdp\r\n\r\n" +
    `${sdp}\r\n` +
    `--${BOUNDARY}\r\n` +
    'Content-Disposition: form-data; name="session"\r\n' +
    "Content-Type: application/json\r\n\r\n" +
    `${sessionJson}\r\n` +
    `--${BOUNDARY}--\r\n`,
  );
}

function liveHeaders(fields = {}) {
  const headers = {
    "content-type": LIVE_MULTIPART_CONTENT_TYPE,
    "openai-alpha": "quicksilver=v2",
    ...fields,
  };
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
}

function request(port, { path = LIVE, method = "POST", headers = {}, body = multipart() } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: "127.0.0.1", port, path, method,
      headers: liveHeaders(headers),
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
  const externalRequests = [];
  let registryReads = 0;
  let credentialReads = 0;
  const modelServer = await localServer(t, (incoming, outgoing) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      externalRequests.push({ path: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks) });
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end('{"output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}');
    });
  });
  const nativeServer = await localServer(t, (incoming, outgoing) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      const captured = { path: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks) };
      nativeRequests.push(captured);
      if (nativeHandler) return nativeHandler(incoming, outgoing, captured);
      outgoing.writeHead(201, {
        "content-type": "application/sdp",
        location: `https://${CANARY}.example/backend-api/codex/realtime/calls/rtc_example?private=${CANARY}`,
        "set-cookie": CANARY,
        "x-private-upstream": CANARY,
      });
      outgoing.end(SDP);
    });
  });
  const registry = registryOverride ?? {
    listModels: () => [],
    resolve(model) {
      registryReads += 1;
      if (model === EXTERNAL_MODEL) return {
        kind: "external", providerKind: "lmstudio-responses",
        baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
        allowPrivateNetwork: true,
        upstreamModel: "example-model",
        toolsEnabled: false,
      };
      throw Object.assign(new Error(CANARY), { code: "UNKNOWN_MODEL", statusCode: 400 });
    },
  };
  const bridge = await listenBridgeServer({
    registry,
    capabilityToken: CAPABILITY,
    nativeBaseUrl: `http://127.0.0.1:${nativeServer.address().port}/native`,
    credentialResolver: () => { credentialReads += 1; return PROVIDER_CREDENTIAL; },
    ...options,
  });
  t.after(() => new Promise((resolve) => {
    bridge.closeAllConnections();
    bridge.close(resolve);
  }));
  return {
    port: bridge.address().port,
    nativeRequests,
    externalRequests,
    registryReads: () => registryReads,
    credentialReads: () => credentialReads,
  };
}

test("GPT-Live translates Codex's multipart request only to the fixed native voice service", async (t) => {
  const f = await fixture(t);
  const value = session({ model: "gpt-live-example", delegation: { type: "client", ack_filler: true } });
  const result = await request(f.port, {
    body: multipart(value),
    headers: {
      authorization: `Bearer ${CANARY}`,
      "chatgpt-account-id": CANARY,
      "x-session-id": "example-realtime-session",
      "x-oai-attestation": CANARY,
      "x-codex-routing-hint": "native",
      cookie: CANARY,
      "proxy-authorization": CANARY,
      "x-unknown-secret": CANARY,
    },
  });
  assert.equal(result.status, 201);
  assert.equal(f.nativeRequests.length, 1);
  const captured = f.nativeRequests[0];
  assert.equal(captured.path, "/native/realtime/calls?intent=quicksilver&architecture=avas");
  assert.deepEqual(JSON.parse(captured.body), { sdp: SDP, session: value });
  assert.equal(captured.headers["content-type"], "application/json");
  assert.equal(captured.headers["content-length"], String(captured.body.length));
  assert.equal(captured.headers.authorization, `Bearer ${CANARY}`);
  assert.equal(captured.headers["chatgpt-account-id"], CANARY);
  assert.equal(captured.headers["x-oai-attestation"], CANARY);
  assert.equal(captured.headers["x-session-id"], "example-realtime-session");
  assert.equal(captured.headers["openai-alpha"], "quicksilver=v2");
  assert.equal(captured.headers.cookie, undefined);
  assert.equal(captured.headers["proxy-authorization"], undefined);
  assert.equal(captured.headers["x-unknown-secret"], undefined);
  assert.deepEqual(result.bytes, Buffer.from(SDP));
  assert.equal(result.headers.location, "/v1/live/rtc_example");
  assert.equal(result.headers["content-type"], "application/sdp");
  assert.equal(JSON.stringify(result.headers).includes(CANARY), false);
  assert.equal(f.registryReads(), 0);
  assert.equal(f.credentialReads(), 0);
  assert.equal(f.externalRequests.length, 0);
});

test("GPT-Live decompresses within shared bounds and sends uncompressed native JSON", async (t) => {
  const f = await fixture(t);
  const value = session({ instructions: "Preserve these instructions. Grüße!" });
  const result = await request(f.port, {
    body: gzipSync(multipart(value)),
    headers: { "content-encoding": "gzip", "accept-encoding": "gzip" },
  });
  assert.equal(result.status, 201);
  assert.deepEqual(JSON.parse(f.nativeRequests[0].body), { sdp: SDP, session: value });
  assert.equal(f.nativeRequests[0].headers["content-encoding"], undefined);
  assert.equal(f.nativeRequests[0].headers["accept-encoding"], "identity");
});

test("native voice startup leaves delegated inference on the selected external route with isolated credentials", async (t) => {
  const f = await fixture(t);
  const headers = {
    authorization: `Bearer ${CANARY}`,
    "chatgpt-account-id": CANARY,
    "x-oai-attestation": CANARY,
    "x-session-id": CANARY,
    "x-codex-routing-hint": CANARY,
    cookie: CANARY,
    "x-unknown-secret": CANARY,
  };
  assert.equal((await request(f.port, { headers })).status, 201);
  assert.equal(f.credentialReads(), 0);
  const inference = await request(f.port, {
    path: `${PREFIX}/v1/responses`,
    headers: { ...headers, "content-type": "application/json" },
    body: {
      model: EXTERNAL_MODEL,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue the delegated task." }] }],
      client_metadata: { account: CANARY },
    },
  });
  assert.equal(inference.status, 200);
  assert.equal(f.nativeRequests.length, 1);
  assert.equal(f.externalRequests.length, 1);
  assert.equal(f.registryReads(), 1);
  assert.equal(f.credentialReads(), 1);
  const captured = f.externalRequests[0];
  assert.equal(captured.path, "/v1/responses");
  assert.equal(JSON.parse(captured.body).model, "example-model");
  assert.equal(captured.headers.authorization, `Bearer ${PROVIDER_CREDENTIAL}`);
  assert.equal(JSON.parse(captured.body).client_metadata, undefined);
  assert.equal(captured.body.includes(CANARY), false);
  assert.equal(JSON.stringify(captured.headers).includes(CANARY), false);
  assert.equal(captured.headers["openai-alpha"], undefined);
  assert.equal(captured.headers["x-session-id"], undefined);
});

test("GPT-Live retains exact capability, path, host, origin and method boundaries", async (t) => {
  const f = await fixture(t);
  for (const [options, status] of [
    [{ path: "/v1/live" }, 404],
    [{ path: `/c/${"z".repeat(40)}/v1/live` }, 404],
    [{ path: `${LIVE}/extra` }, 404],
    [{ path: `${LIVE}?model=other` }, 404],
    [{ path: `${LIVE}#fragment` }, 404],
    [{ path: `${PREFIX}/v1/%6cive` }, 404],
    [{ path: `${PREFIX}/v1/./live` }, 404],
    [{ path: `${PREFIX}/v1/other/../live` }, 404],
    [{ path: `${PREFIX}/v1/realtime/calls` }, 404],
    [{ method: "GET" }, 405],
    [{ method: "PUT" }, 405],
    [{ headers: { origin: "null" } }, 403],
    [{ headers: { host: "localhost:1234" } }, 421],
  ]) {
    const result = await request(f.port, options);
    assert.equal(result.status, status);
    assert.equal(result.text.includes(CANARY), false);
  }
  assert.equal(f.nativeRequests.length, 0);
  assert.equal(f.externalRequests.length, 0);
  assert.equal(f.registryReads(), 0);
  assert.equal(f.credentialReads(), 0);
});

test("GPT-Live rejects an unsupported version header or request shape before native I/O", async (t) => {
  const f = await fixture(t);
  for (const options of [
    { headers: { "openai-alpha": undefined } },
    { headers: { "openai-alpha": "quicksilver=v1" } },
    { headers: { "openai-alpha": `quicksilver=v2,${CANARY}` } },
    { headers: { "content-type": "application/json" }, body: { sdp: SDP, session: session() } },
    { body: multipart(session({ endpoint: `https://${CANARY}.example/` })) },
    { body: multipart(session({ model: EXTERNAL_MODEL })) },
    { body: Buffer.from(CANARY) },
  ]) {
    const result = await request(f.port, options);
    assert.equal(result.status, 400);
    assert.equal(JSON.parse(result.text).error.code, "INVALID_LIVE_REQUEST");
    assert.equal(result.text.includes(CANARY), false);
  }
  assert.equal(f.nativeRequests.length, 0);
  assert.equal(f.registryReads(), 0);
  assert.equal(f.credentialReads(), 0);
});

test("GPT-Live rejects duplicate session authority and malformed SDP before native I/O", async (t) => {
  const f = await fixture(t);
  const value = session({
    initial_items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
  });
  const source = JSON.stringify(value);
  const invalidBodies = [
    multipart(value, SDP, source.replace('"instructions":', `"instructions":"${CANARY}","instructions":`)),
    multipart(value, SDP, source.replace('"type":"client"', '"type":"server","type":"client"')),
    multipart(value, SDP, source.replace('"voice":', '"voice":"marin","\\u0076oice":')),
    multipart(value, SDP, source.replace('"text":', `"text":"${CANARY}","\\u0074ext":`)),
    multipart(value, SDP, source.replace('"type":"client"', `${"[".repeat(256)}null${"]".repeat(256)}`)),
    multipart(value, "v=0\r\n"),
    multipart(value, SDP.replace("t=0 0\r\n", "")),
    multipart(value, SDP.replace("a=sendrecv", `not-a-record ${CANARY}`)),
    multipart(value, SDP.replace("s=-\r\n", "s=-\n")),
    multipart(value, SDP.slice(0, -2)),
  ];
  for (const body of invalidBodies) {
    const result = await request(f.port, { body });
    assert.equal(result.status, 400);
    assert.equal(JSON.parse(result.text).error.code, "INVALID_LIVE_REQUEST");
    assert.equal(result.text.includes(CANARY), false);
  }
  assert.equal(f.nativeRequests.length, 0);
  assert.equal(f.externalRequests.length, 0);
  assert.equal(f.registryReads(), 0);
  assert.equal(f.credentialReads(), 0);
});

test("GPT-Live fails the compatibility gate before body adaptation or upstream access", async (t) => {
  for (const code of ["DESKTOP_COMPATIBILITY_UPDATE_REQUIRED", undefined]) {
    const f = await fixture(t, { compatibilityGate: {
      snapshot: () => ({ status: "update-required" }),
      assertReady: async () => { throw Object.assign(new Error(CANARY), { code }); },
    } });
    const result = await request(f.port, { body: Buffer.from(CANARY) });
    assert.equal(result.status, 503);
    assert.equal(JSON.parse(result.text).error.code, code ?? "DESKTOP_COMPATIBILITY_UNAVAILABLE");
    assert.equal(result.text.includes(CANARY), false);
    assert.equal(f.nativeRequests.length, 0);
    assert.equal(f.credentialReads(), 0);
  }
});

test("GPT-Live bounds compressed and uncompressed bodies and rejects invalid compression before native I/O", async (t) => {
  const f = await fixture(t, { limits: { requestBodyBytes: 1024 } });
  const oversized = multipart(session({ instructions: "x".repeat(5000) }));
  for (const [options, status, code] of [
    [{ body: oversized }, 413, "BODY_TOO_LARGE"],
    [{ body: gzipSync(oversized), headers: { "content-encoding": "gzip" } }, 413, "DECODED_BODY_TOO_LARGE"],
    [{ body: Buffer.from(CANARY), headers: { "content-encoding": "gzip" } }, 400, "INVALID_COMPRESSION"],
    [{ headers: { "content-encoding": "unknown" } }, 415, "UNSUPPORTED_CONTENT_ENCODING"],
  ]) {
    const result = await request(f.port, options);
    assert.equal(result.status, status);
    assert.equal(JSON.parse(result.text).error.code, code);
    assert.equal(result.text.includes(CANARY), false);
  }
  assert.equal(f.nativeRequests.length, 0);
  assert.equal(f.credentialReads(), 0);
});

test("GPT-Live also bounds the expanded native JSON before opening a connection", async (t) => {
  const limit = 2048;
  const f = await fixture(t, { limits: { requestBodyBytes: limit } });
  const sdp = `${SDP}${"a=x\r\n".repeat(250)}`;
  const value = session();
  const body = multipart(value, sdp);
  assert.ok(body.length <= limit);
  assert.ok(Buffer.byteLength(JSON.stringify({ sdp, session: value })) > limit);
  const result = await request(f.port, { body });
  assert.equal(result.status, 413);
  assert.equal(JSON.parse(result.text).error.code, "BODY_TOO_LARGE");
  assert.equal(f.nativeRequests.length, 0);
  assert.equal(f.registryReads(), 0);
  assert.equal(f.credentialReads(), 0);
});

test("GPT-Live redacts native error bodies and never follows redirects or returns their topology", async (t) => {
  for (const status of [401, 403, 429, 500, 302, 307]) {
    const f = await fixture(t, { nativeHandler: (_incoming, outgoing) => {
      outgoing.writeHead(status, {
        "content-type": "application/json",
        location: `https://${CANARY}.example/rtc_secret`,
        authorization: CANARY,
        "www-authenticate": CANARY,
        "chatgpt-account-id": CANARY,
        "set-cookie": CANARY,
      });
      outgoing.end(JSON.stringify({ error: CANARY }));
    } });
    const result = await request(f.port);
    assert.equal(result.status, status < 400 ? 502 : status);
    assert.equal(JSON.parse(result.text).error.code, "LIVE_SERVICE_ERROR");
    assert.equal(result.text.includes(CANARY), false);
    assert.equal(JSON.stringify(result.headers).includes(CANARY), false);
    assert.equal(result.headers.location, undefined);
    assert.equal(f.nativeRequests.length, 1);
    assert.equal(f.externalRequests.length, 0);
    assert.equal(f.credentialReads(), 0);
  }
});

test("GPT-Live validates the complete bounded SDP answer and call ID before returning native data", async (t) => {
  for (const [contentType, contentEncoding, location, body] of [
    ["application/json", undefined, "/v1/realtime/calls/rtc_example", JSON.stringify({ account: CANARY })],
    ["application/sdp", undefined, undefined, SDP],
    ["application/sdp", undefined, `/v1/realtime/calls/${CANARY}`, SDP],
    ["application/sdp", undefined, "/v1/realtime/calls/rtc_example", CANARY],
    ["application/sdp", undefined, "/v1/realtime/calls/rtc_example", "v=0\r\n"],
    ["application/sdp", undefined, "/v1/realtime/calls/rtc_example", SDP.replace("t=0 0\r\n", "")],
    ["application/sdp", undefined, "/v1/realtime/calls/rtc_example", SDP.replace("a=sendrecv", `not-a-record ${CANARY}`)],
    ["application/sdp", undefined, "/v1/realtime/calls/rtc_example", SDP.replace("s=-\r\n", "s=-\n")],
    ["application/sdp", undefined, "/v1/realtime/calls/rtc_example", SDP.slice(0, -2)],
    ["application/sdp", undefined, "/v1/realtime/calls/rtc_example", Buffer.concat([Buffer.from(SDP), Buffer.from([0xc0, 0x80])])],
    ["application/sdp", "gzip", "/v1/realtime/calls/rtc_example", gzipSync(Buffer.from(SDP))],
    ["application/sdp", undefined, "/v1/realtime/calls/rtc_example", `${SDP}${"a".repeat(256 * 1024)}`],
  ]) {
    const f = await fixture(t, { nativeHandler: (_incoming, outgoing) => {
      outgoing.writeHead(201, {
        "content-type": contentType,
        "x-private-upstream": CANARY,
        ...(location === undefined ? {} : { location }),
        ...(contentEncoding === undefined ? {} : { "content-encoding": contentEncoding }),
      });
      outgoing.end(body);
    } });
    const result = await request(f.port);
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.text).error.code, "UPSTREAM_RESPONSE_ERROR");
    assert.equal(result.text.includes(CANARY), false);
    assert.equal(JSON.stringify(result.headers).includes(CANARY), false);
    assert.equal(f.nativeRequests.length, 1);
  }
});

test("GPT-Live reports fixed header, idle and total timeouts without returning a partial answer", async (t) => {
  for (const [stage, limits, code] of [
    ["headers", { upstreamHeadersTimeoutMs: 40, upstreamTotalTimeoutMs: 1000 }, "UPSTREAM_HEADERS_TIMEOUT"],
    ["idle", { streamIdleTimeoutMs: 40, upstreamTotalTimeoutMs: 1000 }, "UPSTREAM_IDLE_TIMEOUT"],
    ["total", { streamIdleTimeoutMs: 1000, upstreamTotalTimeoutMs: 40 }, "UPSTREAM_TOTAL_TIMEOUT"],
  ]) {
    const f = await fixture(t, {
      limits,
      nativeHandler: (_incoming, outgoing) => {
        if (stage === "headers") return;
        outgoing.writeHead(201, {
          "content-type": "application/sdp",
          location: "/v1/realtime/calls/rtc_example",
          "x-private-upstream": CANARY,
        });
        outgoing.write(`${SDP}a=${CANARY}`);
      },
    });
    const result = await request(f.port);
    assert.equal(result.status, 504);
    assert.equal(JSON.parse(result.text).error.code, code);
    assert.equal(result.text.includes(CANARY), false);
    assert.equal(JSON.stringify(result.headers).includes(CANARY), false);
  }
});

test("GPT-Live discards partial native answers after upstream abort", async (t) => {
  const f = await fixture(t, { nativeHandler: (_incoming, outgoing) => {
    outgoing.writeHead(201, { "content-type": "application/sdp", location: "/v1/realtime/calls/rtc_example" });
    outgoing.write(`${SDP}a=${CANARY}`, () => setImmediate(() => outgoing.destroy()));
  } });
  const result = await request(f.port);
  assert.equal(result.status, 502);
  assert.equal(JSON.parse(result.text).error.code, "UPSTREAM_ABORTED");
  assert.equal(result.text.includes(CANARY), false);
  assert.equal(result.headers.location, undefined);
});

test("GPT-Live cancels native startup when the caller disconnects", async (t) => {
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let signalClosed;
  const closed = new Promise((resolve) => { signalClosed = resolve; });
  const f = await fixture(t, { nativeHandler: (_incoming, outgoing) => {
    outgoing.once("close", signalClosed);
    signalStarted();
  } });
  const caller = http.request({ hostname: "127.0.0.1", port: f.port, path: LIVE, method: "POST", headers: liveHeaders() });
  caller.on("error", () => {});
  caller.end(multipart());
  await started;
  caller.destroy();
  await closed;
  assert.equal(f.nativeRequests.length, 1);
  assert.equal(f.externalRequests.length, 0);
});

test("GPT-Live skips native I/O for a caller that has already ended", async (t) => {
  for (const cancellation of ["request-aborted", "response-destroyed", "response-ended"]) {
    let upstreamCalls = 0;
    const transport = { request() {
      upstreamCalls += 1;
      throw new Error("Closed callers must not open a native request");
    } };
    const proxy = createLiveProxy({ httpsTransport: transport });
    const incoming = new PassThrough();
    incoming.headers = liveHeaders();
    const outgoing = new Writable({ write(_chunk, _encoding, done) { done(); } });
    outgoing.writeHead = () => assert.fail("Closed callers must not receive a response");
    t.after(() => { incoming.destroy(); outgoing.destroy(); });
    if (cancellation === "request-aborted") incoming.aborted = true;
    if (cancellation === "response-destroyed") {
      const closed = once(outgoing, "close");
      outgoing.destroy();
      await closed;
    }
    if (cancellation === "response-ended") {
      const finished = once(outgoing, "finish");
      outgoing.end();
      await finished;
    }
    const handled = proxy(incoming, outgoing, "/v1/live");
    incoming.end(multipart());
    await handled;
    assert.equal(upstreamCalls, 0, cancellation);
  }
});

test("GPT-Live retains the protected native destination requirement", () => {
  for (const nativeBaseUrl of [
    "http://public.example/native",
    "file:///native",
    "https://user:password@example.com/native",
    "https://example.com/native?destination=other",
  ]) {
    assert.throws(() => createLiveProxy({ nativeBaseUrl }));
  }
});

test("GPT-Live does not accept unreviewed local WebSocket upgrade traffic", async (t) => {
  const f = await fixture(t);
  const result = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: f.port });
    const chunks = [];
    socket.on("connect", () => socket.write(
      `GET ${LIVE} HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
    ));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString()));
    socket.on("error", reject);
  });
  assert.match(result, /^HTTP\/1\.1 426 Upgrade Required\r\n/u);
  assert.equal(f.nativeRequests.length, 0);
  assert.equal(f.externalRequests.length, 0);
});
