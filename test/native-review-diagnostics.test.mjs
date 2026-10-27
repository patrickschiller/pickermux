import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { createCompactionEnvelopeCodec } from "../src/compaction-envelope.mjs";
import { createResponsesProxy } from "../src/responses-proxy.mjs";

const CANARY = "private-native-review-canary";
const SECRET = "offline-review-diagnostics-secret-0123456789_ABCDEFG";
const NATIVE_MODEL = "native-reviewer";
const SOURCE = Object.freeze({
  kind: "external",
  slug: "lmstudio/example/review-source",
  providerId: "lmstudio",
  providerKind: "lmstudio-responses",
  baseUrl: "http://127.0.0.1:1234/v1",
  upstreamModel: "example/review-source",
  compactionModelHash: "model-bridge-p6-synthetic-diagnostics",
  model: { contextWindow: 32_768 },
  toolsEnabled: true,
});
const binding = JSON.stringify({
  version: 1,
  publicModel: SOURCE.slug,
  providerId: SOURCE.providerId,
  providerKind: SOURCE.providerKind,
  baseUrl: SOURCE.baseUrl,
  upstreamModel: SOURCE.upstreamModel,
  modelHash: SOURCE.compactionModelHash,
  contextWindow: SOURCE.model.contextWindow,
});
const checkpoint = {
  type: "compaction",
  encrypted_content: createCompactionEnvelopeCodec(SECRET).seal(CANARY, binding),
};
const terminal = Buffer.from('data: {"type":"response.completed","response":{"id":"synthetic-review"}}\n\n');

// Exercise the real route, checkpoint authentication and relay with injected
// streams. No network, service, credential store or installed runtime is used.
async function simulate(t, {
  headers = { "content-type": "text/event-stream" },
  status = 200,
  chunks = [terminal],
  failure,
  projected = true,
} = {}) {
  const outgoingChunks = [];
  const upstreamRequests = [];
  const admissions = [];
  let credentialReads = 0;
  let upstreamDestroyed = false;
  const request = new PassThrough({ autoDestroy: false });
  request.headers = {
    "content-type": "application/json",
    "x-openai-subagent": "guardian",
    authorization: "Bearer native-only-credential-canary",
  };
  const response = new Writable({
    autoDestroy: false,
    write(chunk, _encoding, done) { outgoingChunks.push(Buffer.from(chunk)); done(); },
  });
  response.headersSent = false;
  response.writeHead = (value, fields) => {
    response.statusCode = value;
    response.headers = fields;
    response.headersSent = true;
    return response;
  };
  t.after(() => { request.destroy(); response.destroy(); });

  const transport = {
    request(target, options, receive) {
      const upstreamRequest = new EventEmitter();
      upstreamRequest.destroy = () => { upstreamDestroyed = true; };
      upstreamRequest.end = (bytes) => {
        upstreamRequests.push({ target, headers: options.headers, body: JSON.parse(bytes) });
        queueMicrotask(() => {
          const incoming = new EventEmitter();
          incoming.statusCode = status;
          incoming.headers = { ...headers, "x-native-private": CANARY };
          incoming.destroy = () => { incoming.destroyed = true; };
          incoming.pause = () => {};
          incoming.resume = () => {};
          receive(incoming);
          for (const chunk of chunks) {
            if (incoming.destroyed) break;
            incoming.emit("data", chunk);
          }
          if (incoming.destroyed) return;
          if (failure === "error") {
            incoming.emit("error", Object.assign(new Error(CANARY), {
              code: CANARY, diagnostic: CANARY, cause: new Error(CANARY),
            }));
          } else if (failure === "aborted") {
            incoming.emit("aborted");
          } else {
            incoming.emit("end");
          }
        });
      };
      return upstreamRequest;
    },
  };
  const proxy = createResponsesProxy({
    registry: {
      externalModels: [{ id: SOURCE.slug }],
      resolve: (id) => id === SOURCE.slug ? SOURCE : { kind: "native", slug: NATIVE_MODEL },
    },
    compactionSecret: SECRET,
    httpsTransport: transport,
    credentialResolver: async () => { credentialReads += 1; return "external-credential-canary"; },
    externalRequestGate: async (admission) => { admissions.push(admission); },
  });
  const handled = proxy(request, response, "/v1/responses");
  request.end(JSON.stringify({
    model: NATIVE_MODEL,
    stream: true,
    client_metadata: { "x-openai-subagent": "guardian" },
    input: projected ? [checkpoint] : [{ role: "user", content: "synthetic action review" }],
  }));
  await handled;
  assert.equal(upstreamRequests.length, 1);
  assert.equal(credentialReads, 0);
  assert.equal(upstreamRequests[0].headers.authorization, "Bearer native-only-credential-canary");
  assert.equal(admissions.length, projected ? 1 : 0);
  if (projected) {
    assert.equal(admissions[0].publicModelId, SOURCE.slug);
    assert.equal(admissions[0].requiresDirectReceipt, true);
    assert.equal(upstreamRequests[0].headers["accept-encoding"], "identity");
    assert.equal(upstreamRequests[0].body.input[0].role, "assistant");
    assert.ok(upstreamRequests[0].body.input[0].content[0].text.endsWith(CANARY));
    assert.doesNotMatch(JSON.stringify(upstreamRequests[0].body), /pickermux\.compaction\./u);
  }
  return {
    status: response.statusCode,
    headers: response.headers,
    body: Buffer.concat(outgoingChunks),
    upstreamDestroyed,
  };
}

function assertFailure(result, diagnostic, code = "UPSTREAM_RESPONSE_ERROR", status = 502) {
  assert.equal(result.status, status);
  assert.deepEqual(JSON.parse(result.body), { error: {
    code,
    message: (code === "UPSTREAM_ABORTED"
      ? "The upstream response ended unexpectedly"
      : code === "REVIEW_SERVICE_ERROR"
      ? "The native approval review could not be completed"
      : "The upstream response could not be read or validated") + ` (${diagnostic})`,
  } });
  assert.equal(result.headers["x-native-private"], undefined);
  assert.doesNotMatch(result.body.toString(), /canary|synthetic-review|response\.completed/u);
  assert.doesNotMatch(JSON.stringify(result.headers), /canary/u);
  assert.equal(result.upstreamDestroyed, true);
}

test("projected reviews distinguish rejected media types, encoding and HTTP status without echoing headers", async (t) => {
  for (const [name, options, diagnostic, code, status] of [
    ["missing content type", { headers: {} }, "REVIEW_CONTENT_TYPE"],
    ["private content type", { headers: { "content-type": CANARY } }, "REVIEW_CONTENT_TYPE"],
    ["compressed response", { headers: { "content-type": "text/event-stream", "content-encoding": "gzip" } }, "REVIEW_CONTENT_ENCODING"],
    ["private encoding", { headers: { "content-type": "application/json", "content-encoding": CANARY } }, "REVIEW_CONTENT_ENCODING"],
    ["native HTTP failure", { status: 503, chunks: [Buffer.from(CANARY)] }, "REVIEW_HTTP_STATUS", "REVIEW_SERVICE_ERROR", 503],
  ]) await t.test(name, async (subtest) => {
    assertFailure(await simulate(subtest, options), diagnostic, code, status);
  });
});

test("projected review response size diagnostics preserve the 32 MiB bound", async (t) => {
  const chunks = [Buffer.alloc(32 * 1024 * 1024, " "), Buffer.from(CANARY)];
  assertFailure(await simulate(t, { chunks }), "REVIEW_BODY_TOO_LARGE");
});

test("projected review read failures and aborts identify validated completion without releasing an answer", async (t) => {
  for (const failure of ["error", "aborted"]) {
    for (const completed of [false, true]) {
      await t.test(`${failure}, completed=${completed}`, async (subtest) => {
        const chunks = completed ? [terminal] : [Buffer.from('data: {"type":"response.created"}\n\n')];
        const code = failure === "aborted" ? "UPSTREAM_ABORTED" : "UPSTREAM_RESPONSE_ERROR";
        const diagnostic = (failure === "aborted" ? "REVIEW_STREAM_ABORTED" : "REVIEW_STREAM_READ") +
          (completed ? "_AFTER_COMPLETION" : "");
        assertFailure(await simulate(subtest, { chunks, failure }), diagnostic, code);
      });
    }
  }
});

test("invalid trailing bytes cannot claim completion in transport diagnostics", async (t) => {
  const chunks = [terminal, Buffer.from(`data: ${CANARY}\n\n`)];
  assertFailure(await simulate(t, { chunks, failure: "error" }), "REVIEW_STREAM_READ");
});

test("projected successful allow and deny reviews retain their exact bytes", async (t) => {
  for (const decision of ["allow", "deny"]) {
    await t.test(decision, async (subtest) => {
      const output = Buffer.from(`data: {"type":"response.output_text.delta","delta":"${decision}"}\n\n`);
      const chunks = [output, terminal];
      const result = await simulate(subtest, { chunks });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, Buffer.concat(chunks));
      assert.equal(result.upstreamDestroyed, false);
    });
  }
});

test("native requests without a checkpoint retain their original response and error payload", async (t) => {
  const body = Buffer.from(JSON.stringify({ error: { message: "ordinary-native-error" } }));
  const result = await simulate(t, {
    projected: false,
    status: 502,
    headers: { "content-type": "application/json" },
    chunks: [body],
  });
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, body);
  assert.doesNotMatch(result.body.toString(), /REVIEW_/u);
  assert.equal(result.upstreamDestroyed, false);
});
