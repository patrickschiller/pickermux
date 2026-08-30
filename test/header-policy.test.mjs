import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExternalRequestHeaders,
  buildNativeRequestHeaders,
  hasDisallowedOrigin,
  isExpectedHost,
  sanitizeUpstreamResponseHeaders,
} from "../src/header-policy.mjs";

test("native policy forwards only Codex's explicit auth, routing, trace and body headers", () => {
  const headers = buildNativeRequestHeaders(
    {
      accept: "text/event-stream",
      authorization: "Bearer chatgpt-secret",
      "chatgpt-account-id": "account-id",
      "content-encoding": "gzip",
      "content-length": "999999",
      "content-type": "application/json",
      cookie: "must-not-cross",
      host: "attacker.invalid",
      origin: "https://attacker.invalid",
      "proxy-authorization": "must-not-cross",
      traceparent: "00-abc-def-01",
      "x-codex-routing-hint": "native",
      "x-codex-inference-call-id": "call-id",
      "x-oai-attestation": "attestation",
      "x-openai-fedramp": "1",
      "x-openai-internal-codex-responses-lite": "1",
      "x-openai-internal-codex-residency": "eu",
      "x-openai-memgen-request": "1",
      "x-openai-subagent": "review",
      "x-random-secret": "must-not-cross",
    },
    42,
  );

  assert.deepEqual({ ...headers }, {
    accept: "text/event-stream",
    authorization: "Bearer chatgpt-secret",
    "chatgpt-account-id": "account-id",
    "content-encoding": "gzip",
    "content-length": "42",
    "content-type": "application/json",
    traceparent: "00-abc-def-01",
    "x-codex-routing-hint": "native",
    "x-codex-inference-call-id": "call-id",
    "x-oai-attestation": "attestation",
    "x-openai-fedramp": "1",
    "x-openai-internal-codex-responses-lite": "1",
    "x-openai-internal-codex-residency": "eu",
    "x-openai-memgen-request": "1",
    "x-openai-subagent": "review",
  });
});

test("re-encoded native policy removes request compression and sets exact JSON metadata", () => {
  const headers = buildNativeRequestHeaders(
    {
      accept: "application/json",
      authorization: "Bearer native-secret",
      "chatgpt-account-id": "account-id",
      "content-encoding": "gzip",
      "content-length": "999",
      "content-type": "application/cbor",
      cookie: "must-not-cross",
      "x-codex-routing-hint": "native",
      "x-random-secret": "must-not-cross",
    },
    73,
    { reencoded: true },
  );

  assert.deepEqual({ ...headers }, {
    accept: "application/json",
    authorization: "Bearer native-secret",
    "chatgpt-account-id": "account-id",
    "content-length": "73",
    "content-type": "application/json",
    "x-codex-routing-hint": "native",
  });
  assert.equal(headers["content-encoding"], undefined);
});

test("external policy discards every caller credential and adds only the route credential", () => {
  const headers = buildExternalRequestHeaders(
    {
      accept: "text/event-stream",
      authorization: "Bearer chatgpt-secret",
      "chatgpt-account-id": "account-id",
      "content-encoding": "br",
      "content-type": "application/problem+json",
      cookie: "cookie-secret",
      "proxy-authorization": "proxy-secret",
      "x-codex-routing-hint": "native",
      "x-oai-attestation": "attestation-secret",
      "x-openai-fedramp": "1",
    },
    123,
    { credential: "provider-secret" },
  );

  assert.deepEqual({ ...headers }, {
    accept: "text/event-stream",
    "accept-encoding": "identity",
    authorization: "Bearer provider-secret",
    "content-length": "123",
    "content-type": "application/json",
  });
  assert.doesNotMatch(JSON.stringify(headers), /chatgpt-secret|cookie-secret|attestation-secret/u);
});

test("invalid allowed header values stay excluded on re-encoded native and external paths", () => {
  const native = buildNativeRequestHeaders(
    {
      accept: "application/json\r\nx-injected: true",
      authorization: "Bearer native\nsecret",
      traceparent: ["safe", "unsafe\rvalue"],
    },
    17,
    { reencoded: true },
  );
  assert.deepEqual({ ...native }, {
    "content-length": "17",
    "content-type": "application/json",
  });

  const external = buildExternalRequestHeaders(
    { accept: "text/event-stream\r\nx-injected: true" },
    23,
    { credential: "provider-secret" },
  );
  assert.deepEqual({ ...external }, {
    "accept-encoding": "identity",
    authorization: "Bearer provider-secret",
    "content-length": "23",
    "content-type": "application/json",
  });
});

test("response policy strips hop-by-hop, cookie and redirect topology headers", () => {
  const headers = sanitizeUpstreamResponseHeaders(
    {
      connection: "keep-alive, x-private-hop",
      "content-type": "text/event-stream",
      location: "http://private-upstream.invalid/secret",
      "set-cookie": ["session=secret"],
      "transfer-encoding": "chunked",
      "x-private-hop": "private",
      "x-request-id": "safe-id",
    },
    307,
  );

  assert.deepEqual({ ...headers }, {
    "cache-control": "no-store",
    "content-type": "text/event-stream",
    "x-request-id": "safe-id",
  });
});

test("host and Origin checks are strict", () => {
  assert.equal(isExpectedHost("127.0.0.1:4210", 4210), true);
  assert.equal(isExpectedHost("localhost:4210", 4210), false);
  assert.equal(isExpectedHost("127.0.0.1:4211", 4210), false);
  assert.equal(hasDisallowedOrigin({}), false);
  assert.equal(hasDisallowedOrigin({ origin: "null" }), true);
});
