import assert from "node:assert/strict";
import test from "node:test";

import {
  TOKEN_USAGE_MAX_PROVIDERS,
  TOKEN_USAGE_MAX_SSE_FRAME_BYTES,
  TOKEN_GENERATION_MAX_DURATION_MS,
  createTokenPerformanceTelemetry,
  createTokenUsageObserver,
  createTokenUsageTelemetry,
  projectTokenUsageSnapshot,
  projectTokenPerformanceSnapshot,
} from "../src/token-usage.mjs";

const counts = { inputTokens: 12, outputTokens: 3, totalTokens: 15 };
const usage = { input_tokens: 12, output_tokens: 3, total_tokens: 15 };
const completed = (overrides = {}) => ({ status: "completed", usage, ...overrides });
const event = (response, type = `response.${response.status}`) =>
  `event: ${type}\r\ndata: ${JSON.stringify({ type, response })}\r\n\r\n`;

test("actual generation time is optional and admitted only with finalized verified counts", () => {
  const check = ({ durations = [1500], success = true, body = JSON.stringify(completed()) } = {}) => {
    const events = [];
    const observer = createTokenUsageObserver({ onUsage: (value) => events.push(value) });
    observer.headers(200, { "content-type": "application/json" });
    for (const duration of durations) observer.generationDuration(duration);
    observer.push(Buffer.from(body));
    assert.equal(events.length, 0);
    observer.finish(success);
    observer.generationDuration(999);
    observer.finish(success);
    return events;
  };
  assert.deepEqual(check(), [{ status: "available", ...counts, generationDurationMs: 1500 }]);
  for (const duration of [1, TOKEN_GENERATION_MAX_DURATION_MS]) {
    assert.equal(check({ durations: [duration] })[0].generationDurationMs, duration);
  }
  for (const durations of [[], [0], [-1], [1.5], [true], ["1500"], [null], [Infinity],
    [TOKEN_GENERATION_MAX_DURATION_MS + 1], [100, 100], [0, 100]]) {
    assert.deepEqual(check({ durations }), [{ status: "available", ...counts }]);
  }
  assert.deepEqual(check({ success: false }), [{ status: "unavailable" }]);
  assert.deepEqual(check({ body: JSON.stringify(completed({ usage: {} })) }), [{ status: "unavailable" }]);
});

test("generation metrics wait for clean SSE EOF and cannot salvage an invalid terminal", () => {
  for (const trailing of ["", event(completed())]) {
    const events = [];
    const observer = createTokenUsageObserver({ onUsage: (value) => events.push(value) });
    observer.headers(200, { "content-type": "text/event-stream" });
    observer.generationDuration(500);
    observer.push(Buffer.from(event(completed()) + trailing));
    assert.deepEqual(events, []);
    observer.finish(true);
    assert.deepEqual(events, trailing === "" ?
      [{ status: "available", ...counts, generationDurationMs: 500 }] : [{ status: "unavailable" }]);
  }
});

test("volatile performance replaces the latest measurement and never changes saved usage shapes", () => {
  const performance = createTokenPerformanceTelemetry();
  const usageTelemetry = createTokenUsageTelemetry();
  const measured = { status: "available", ...counts, generationDurationMs: 1500, prompt: "private-canary" };
  performance.record("kolibri", measured);
  usageTelemetry.record("kolibri", measured);
  assert.deepEqual(performance.snapshot(), { schemaVersion: 1, status: "available", providers: [
    { providerId: "kolibri", status: "available", ...counts, generationDurationMs: 1500 },
  ] });
  assert.deepEqual(usageTelemetry.snapshot().providers[0].last, { status: "available", ...counts });
  const changed = performance.snapshot();
  changed.providers[0].generationDurationMs = 9;
  assert.equal(performance.snapshot().providers[0].generationDurationMs, 1500);
  for (const value of [{ status: "available", ...counts }, { status: "unavailable" },
    { ...measured, totalTokens: 999 }, { ...measured, generationDurationMs: 0 }]) {
    performance.record("kolibri", value);
    assert.deepEqual(performance.snapshot().providers, [{ providerId: "kolibri", status: "unavailable" }]);
  }
  assert.equal(performance.record("unsafe/provider", measured), false);
  assert.deepEqual(createTokenPerformanceTelemetry().snapshot().providers, []);
});

test("performance projection strips private fields and rejects unsafe bounds or identity", () => {
  const clean = { schemaVersion: 1, status: "available", providers: [
    { providerId: "kolibri", status: "available", ...counts, generationDurationMs: 1500 },
  ] };
  const noisy = structuredClone(clean);
  noisy.prompt = "private-canary";
  noisy.providers[0].endpoint = "http://private.invalid";
  assert.deepEqual(projectTokenPerformanceSnapshot(noisy), clean);
  for (const mutate of [
    (v) => { v.schemaVersion = 2; }, (v) => { v.status = "unavailable"; },
    (v) => { v.providers.push(v.providers[0]); }, (v) => { v.providers[0].providerId = "private/model"; },
    (v) => { v.providers[0].status = "unknown"; }, (v) => { v.providers[0].inputTokens = 1.5; },
    (v) => { v.providers[0].totalTokens = undefined; }, (v) => { v.providers[0].totalTokens = 999; },
    (v) => { v.providers[0].generationDurationMs = "1500"; }, (v) => { v.providers[0].generationDurationMs = 0; },
    (v) => { v.providers[0].generationDurationMs = TOKEN_GENERATION_MAX_DURATION_MS + 1; },
  ]) {
    const invalid = structuredClone(clean);
    mutate(invalid);
    assert.equal(projectTokenPerformanceSnapshot(invalid), null);
  }
  const bounded = createTokenPerformanceTelemetry();
  for (let index = 0; index < TOKEN_USAGE_MAX_PROVIDERS; index += 1) bounded.record(`provider-${index}`, { status: "unavailable" });
  assert.equal(bounded.snapshot().providers.length, TOKEN_USAGE_MAX_PROVIDERS);
  assert.equal(bounded.record("extra", { status: "unavailable" }), false);
  assert.deepEqual(bounded.snapshot(), { schemaVersion: 1, status: "unavailable", providers: [] });
  assert.equal(projectTokenPerformanceSnapshot({ ...clean, providers: Array(TOKEN_USAGE_MAX_PROVIDERS + 1).fill(clean.providers[0]) }), null);
});

function observe(body, { type = "application/json", headers = {}, success = true, limit, chunks = 1 } = {}) {
  const events = [];
  const observer = createTokenUsageObserver({
    onUsage: (value) => events.push(value),
    ...(limit === undefined ? {} : { maxBufferedBytes: limit }),
  });
  observer.headers(200, { "content-type": type, ...headers });
  const bytes = Buffer.from(body);
  for (let index = 0; index < bytes.length; index += chunks) observer.push(bytes.subarray(index, index + chunks));
  observer.finish(success);
  observer.finish(success);
  return events;
}

test("observes exact JSON counts and projects only usage integers", () => {
  const body = JSON.stringify(completed({
    id: "private-response-canary",
    output: [{ text: "private-prompt-canary" }],
    usage: {
      ...usage,
      private_metadata: "private-metadata-canary",
      input_tokens_details: { cached_tokens: 10 },
      output_tokens_details: { reasoning_tokens: 2 },
    },
  }));
  assert.deepEqual(observe(body), [{ status: "available", ...counts }]);
  assert.deepEqual(observe(JSON.stringify(completed({ usage: { input_tokens: 0, output_tokens: 0 } }))),
    [{ status: "available", inputTokens: 0, outputTokens: 0, totalTokens: 0 }]);
});

test("unknown and invalid usage remains unavailable without rounding or fabrication", () => {
  for (const bad of [undefined, null, {}, { ...usage, input_tokens: -1 }, { ...usage, output_tokens: 1.5 },
    { ...usage, input_tokens: "12" }, { ...usage, output_tokens: true }, { ...usage, total_tokens: 16 },
    { ...usage, total_tokens: null }, { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0 }]) {
    assert.deepEqual(observe(JSON.stringify(completed({ usage: bad }))), [{ status: "unavailable" }]);
  }
  for (const body of ["invalid", "null", "[]", JSON.stringify(completed({ status: "in_progress" }))]) {
    assert.deepEqual(observe(body), [{ status: "unavailable" }]);
  }
});

test("observes terminal SSE usage after arbitrary UTF-8 chunks and multiline data", () => {
  const terminal = event(completed({ output: [{ text: "Grüße" }] }));
  for (const chunks of [1, 2, 7, 4096]) {
    assert.deepEqual(observe(`: keepalive\r\n\r\n${terminal}data: [DONE]\r\n\r\n: tail\r\n\r\n`, {
      type: "text/event-stream; charset=utf-8", chunks,
    }), [{ status: "available", ...counts }]);
  }
  const multiline = 'data: {"type":"response.completed",\ndata: "response":{"status":"completed","usage":{"input_tokens":12,"output_tokens":3}}}\n\n';
  assert.deepEqual(observe(multiline, { type: "text/event-stream" }), [{ status: "available", ...counts }]);
  for (const status of ["incomplete", "failed"]) {
    assert.deepEqual(observe(event(completed({ status })), { type: "text/event-stream" }),
      [{ status: "available", ...counts }]);
  }
});

test("rejects duplicate or malformed SSE terminal lifecycles", () => {
  const terminal = event(completed());
  for (const body of [
    terminal + terminal,
    terminal + "data: invalid\n\n",
    terminal.trimEnd(),
    terminal + 'data: {"type":"response.output_text.delta","delta":"late"}\n\n',
    terminal + "data: [DONE]\n\ndata: [DONE]\n\n",
    "data: [DONE]\n\n" + terminal,
    terminal.replace("event: response.completed", "event: response.created"),
    terminal.replace("event: response.completed", "event: response.completed\r\nevent: response.completed"),
    "event: response.completed\n\n" + terminal,
    event(completed(), "response.incomplete"),
    'data: {"type":"response.created","response":{"status":"in_progress"}}\n\n',
  ]) {
    assert.deepEqual(observe(body, { type: "text/event-stream" }), [{ status: "unavailable" }], body);
  }
  assert.deepEqual(observe(terminal, { type: "text/event-stream", success: false }), [{ status: "unavailable" }]);
});

test("bounded observation discards oversized, compressed and unsupported payloads", () => {
  const json = JSON.stringify(completed());
  assert.deepEqual(observe(json, { limit: 8 }), [{ status: "unavailable" }]);
  assert.deepEqual(observe(event(completed()), { type: "text/event-stream", limit: 8, chunks: 4096 }),
    [{ status: "unavailable" }]);
  for (const type of ["text/plain", "application/json-invalid", "application/json; garbage", 'text/event-stream; charset="unterminated']) {
    assert.deepEqual(observe(json, { type }), [{ status: "unavailable" }]);
  }
  assert.deepEqual(observe(json, { headers: { "content-encoding": "gzip" } }), [{ status: "unavailable" }]);
  assert.deepEqual(observe(Buffer.from([0xff])), [{ status: "unavailable" }]);
  assert.deepEqual(observe(Buffer.from([0xff]), { type: "text/event-stream" }), [{ status: "unavailable" }]);
  assert.doesNotThrow(() => {
    const observer = createTokenUsageObserver({ onUsage() { throw new Error("private sink canary"); } });
    observer.finish();
  });
});

test("SSE observation stops at its separate frame cap under fragmented input", () => {
  const oversized = event(completed({ output: [{ text: "x".repeat(TOKEN_USAGE_MAX_SSE_FRAME_BYTES) }] }));
  assert.deepEqual(observe(oversized, { type: "text/event-stream", chunks: 4096 }), [{ status: "unavailable" }]);
  // The JSON budget remains independent of the smaller streaming-frame cap.
  const json = JSON.stringify(completed({ output: [{ text: "x".repeat(TOKEN_USAGE_MAX_SSE_FRAME_BYTES) }] }));
  assert.deepEqual(observe(json, { chunks: 4096 }), [{ status: "available", ...counts }]);
});

test("provider counters isolate totals, replace last with unavailable and reset per instance", () => {
  const telemetry = createTokenUsageTelemetry();
  assert.deepEqual(telemetry.snapshot(), { schemaVersion: 1, status: "available", providers: [] });
  telemetry.record("lmstudio", { status: "available", ...counts });
  telemetry.record("lmstudio", { status: "available", ...counts });
  telemetry.record("remote", { status: "available", inputTokens: 2, outputTokens: 1 });
  telemetry.record("lmstudio", { status: "unavailable", private_metadata: "canary" });
  const snapshot = telemetry.snapshot();
  assert.deepEqual(snapshot.providers[0], {
    providerId: "lmstudio", requests: 3, unavailableRequests: 1,
    last: { status: "unavailable" }, totals: { inputTokens: 24, outputTokens: 6, totalTokens: 30 },
  });
  assert.deepEqual(snapshot.providers[1].totals, { inputTokens: 2, outputTokens: 1, totalTokens: 3 });
  snapshot.providers[0].totals.inputTokens = 999;
  assert.equal(telemetry.snapshot().providers[0].totals.inputTokens, 24);
  assert.equal(createTokenUsageTelemetry().snapshot().providers.length, 0);
  assert.equal(telemetry.record("unsafe/provider", { status: "available", ...counts }), false);
});

test("totals become unavailable permanently on checked integer overflow", () => {
  const telemetry = createTokenUsageTelemetry();
  telemetry.record("lmstudio", { status: "available", inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 });
  telemetry.record("lmstudio", { status: "available", inputTokens: 0, outputTokens: 1 });
  telemetry.record("lmstudio", { status: "available", ...counts });
  assert.equal(telemetry.snapshot().providers[0].totals, null);
  assert.deepEqual(telemetry.snapshot().providers[0].last, { status: "available", ...counts });
});

test("snapshot projection strips metadata and rejects malformed essential schemas", () => {
  const telemetry = createTokenUsageTelemetry();
  telemetry.record("lmstudio", { status: "available", ...counts });
  const clean = telemetry.snapshot();
  const noisy = structuredClone(clean);
  noisy.private_metadata = "private-account-canary";
  noisy.providers[0].baseUrl = "https://private-endpoint.invalid";
  noisy.providers[0].last.responseId = "private-id-canary";
  noisy.providers[0].totals.metadata = "private-prompt-canary";
  assert.deepEqual(projectTokenUsageSnapshot(noisy), clean);
  assert.deepEqual(projectTokenUsageSnapshot({ schemaVersion: 1, status: "unavailable", providers: [] }),
    { schemaVersion: 1, status: "unavailable", providers: [] });
  for (const mutate of [
    (v) => { v.schemaVersion = 2; },
    (v) => { v.status = "unknown"; },
    (v) => { v.status = "unavailable"; },
    (v) => { v.providers.push(v.providers[0]); },
    (v) => { v.providers[0].providerId = "unsafe/provider"; },
    (v) => { v.providers[0].requests = 0; },
    (v) => { v.providers[0].unavailableRequests = 2; },
    (v) => { v.providers[0].last.status = "unavailable"; },
    (v) => { v.providers[0].last.totalTokens = 999; },
    (v) => { v.providers[0].last.outputTokens = "3"; },
    (v) => { delete v.providers[0].last.totalTokens; },
    (v) => { v.providers[0].totals = {}; },
    (v) => { v.providers[0].totals = null; },
    (v) => { v.providers[0].totals = { inputTokens: 24, outputTokens: 6, totalTokens: 30 }; },
    (v) => { v.providers[0].totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }; },
  ]) {
    const invalid = structuredClone(clean);
    mutate(invalid);
    assert.equal(projectTokenUsageSnapshot(invalid), null);
  }
});

test("provider storage and snapshot length are bounded", () => {
  const telemetry = createTokenUsageTelemetry();
  for (let index = 0; index < TOKEN_USAGE_MAX_PROVIDERS; index += 1) {
    assert.equal(telemetry.record(`provider-${index}`, { status: "unavailable" }), true);
  }
  assert.equal(telemetry.record("extra", { status: "available", ...counts }), false);
  const snapshot = telemetry.snapshot();
  assert.deepEqual(snapshot, { schemaVersion: 1, status: "unavailable", providers: [] });
  const bounded = createTokenUsageTelemetry();
  for (let index = 0; index < TOKEN_USAGE_MAX_PROVIDERS; index += 1) bounded.record(`provider-${index}`, { status: "unavailable" });
  const oversized = bounded.snapshot();
  oversized.providers.push({ ...oversized.providers[0], providerId: "extra" });
  assert.equal(projectTokenUsageSnapshot(oversized), null);
});

test("durable usage projects only safe counters and preserves last after reset", () => {
  const value = { schemaVersion: 2, status: "available", resetAt: "2026-10-02T18:00:00.000Z", providers: [{
    providerId: "lmstudio", requests: 0, unavailableRequests: 0,
    last: { status: "available", inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  }] };
  const noisy = structuredClone(value);
  noisy.generation = "private-canary";
  noisy.providers[0].prompt = "private-canary";
  assert.deepEqual(projectTokenUsageSnapshot(noisy), value);
  for (const mutate of [
    (v) => { delete v.resetAt; },
    (v) => { v.resetAt = "2026-02-30T18:00:00.000Z"; },
    (v) => { v.resetAt = "2026-10-02T18:00:00Z"; },
    (v) => { v.providers[0].totals.totalTokens = 1; },
    (v) => { v.providers[0].totals = null; },
    (v) => { v.providers[0].requests = 1; },
    (v) => { v.providers[0].unavailableRequests = 1; },
    (v) => { v.providers[0].last.totalTokens = 999; },
    (v) => { v.providers.push(v.providers[0]); },
    (v) => { v.providers[0].providerId = "private/path"; },
    (v) => { v.status = "unavailable"; },
  ]) {
    const invalid = structuredClone(value);
    mutate(invalid);
    assert.equal(projectTokenUsageSnapshot(invalid), null);
  }
  assert.deepEqual(projectTokenUsageSnapshot({ schemaVersion: 2, status: "available", resetAt: null, providers: [] }),
    { schemaVersion: 2, status: "available", resetAt: null, providers: [] });
});
