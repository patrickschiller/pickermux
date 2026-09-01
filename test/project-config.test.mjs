import assert from "node:assert/strict";
import test from "node:test";

import {
  isLoopbackEndpoint,
  validateProjectConfig,
} from "../src/project-config.mjs";

const valid = {
  endpoint: "http://127.0.0.1:1234/v1",
  providerId: "lmstudio_remote",
  providerName: "LM Studio Local",
  donorSlug: "gpt-5.4-mini",
  models: [{ id: "qwen/example", displayName: "Qwen Example" }],
};

test("accepts the explicit legacy loopback configuration", () => {
  assert.deepEqual(validateProjectConfig(valid), valid);
});

test("legacy provider ids use the same canonical 127-character bound", () => {
  const acceptedId = `a${"b".repeat(126)}`;
  assert.equal(
    validateProjectConfig({ ...valid, providerId: acceptedId }).providerId,
    acceptedId,
  );
  for (const providerId of [`a${"b".repeat(127)}`, "_leading", "trailing_"]) {
    assert.throws(
      () => validateProjectConfig({ ...valid, providerId }),
      /at most 127 characters/iu,
    );
  }
});

test("recognizes only unauthenticated HTTP loopback endpoints", () => {
  assert.equal(isLoopbackEndpoint("http://127.0.0.1:1234/v1"), true);
  assert.equal(isLoopbackEndpoint("http://localhost:1234/v1"), true);
  assert.equal(isLoopbackEndpoint("http://[::1]:1234/v1"), true);
  assert.equal(isLoopbackEndpoint("https://127.0.0.1:1234/v1"), false);
  assert.equal(isLoopbackEndpoint("http://192.168.1.20:1234/v1"), false);
  assert.equal(isLoopbackEndpoint("http://token@127.0.0.1:1234/v1"), false);
});

test("rejects reserved providers and non-loopback legacy endpoints", () => {
  assert.throws(
    () => validateProjectConfig({ ...valid, providerId: "lmstudio" }),
    /reserved/u,
  );
  assert.throws(
    () =>
      validateProjectConfig({
        ...valid,
        endpoint: "http://macmini.example.ts.net:1234/v1",
      }),
    /loopback/u,
  );
});

test("rejects duplicate or malformed allowlist entries", () => {
  assert.throws(
    () =>
      validateProjectConfig({
        ...valid,
        models: [{ id: "same" }, { id: "same" }],
      }),
    /Duplicate/u,
  );
  assert.throws(
    () =>
      validateProjectConfig({
        ...valid,
        models: [{ id: "qwen/example", contextWindow: 0 }],
      }),
    /positive integer/u,
  );
});
