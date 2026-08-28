import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCatalogModels,
  debugModels,
  providerOverrides,
} from "../src/codex.mjs";

test("builds explicit provider overrides without a shell", () => {
  assert.deepEqual(
    providerOverrides({
      model: "qwen/example",
      providerId: "lmstudio_remote",
      providerName: "LM Studio Local",
      baseUrl: "http://127.0.0.1:1234/v1",
      catalogPath: "/tmp/models.json",
    }),
    [
      'model="qwen/example"',
      'model_reasoning_effort="low"',
      'model_provider="lmstudio_remote"',
      'model_catalog_json="/tmp/models.json"',
      'model_providers.lmstudio_remote.name="LM Studio Local"',
      'model_providers.lmstudio_remote.base_url="http://127.0.0.1:1234/v1"',
      'model_providers.lmstudio_remote.wire_api="responses"',
      "model_providers.lmstudio_remote.requires_openai_auth=false",
      "model_providers.lmstudio_remote.supports_websockets=false",
      "model_providers.lmstudio_remote.supports_standalone_web_search=false",
    ],
  );
});

test("builds the authenticated mixed-bridge provider override", () => {
  const overrides = providerOverrides({
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    providerId: "model_bridge",
    providerName: "OpenAI",
    baseUrl: "http://127.0.0.1:4210/capability/v1",
    catalogPath: "/tmp/mixed.json",
    requiresOpenAiAuth: true,
  });
  assert.ok(overrides.includes('model_reasoning_effort="ultra"'));
  assert.ok(overrides.includes("model_providers.model_bridge.requires_openai_auth=true"));
  assert.ok(overrides.includes("model_providers.model_bridge.supports_websockets=false"));
});

test("parses debug models output", async () => {
  const calls = [];
  const result = await debugModels({
    codexPath: "/fake/codex",
    overrides: ['model="qwen/example"'],
    execFileImpl: async (...args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({
          models: [
            {
              slug: "qwen/example",
              visibility: "list",
              supported_in_api: true,
            },
          ],
        }),
      };
    },
  });
  assert.equal(calls[0][0], "/fake/codex");
  assert.deepEqual(calls[0][1], [
    "debug",
    "models",
    "-c",
    'model="qwen/example"',
  ]);
  assertCatalogModels(result, ["qwen/example"]);
});

test("rejects a catalog with unexpected or hidden models", () => {
  assert.throws(
    () =>
      assertCatalogModels(
        {
          models: [
            {
              slug: "wrong",
              visibility: "list",
              supported_in_api: true,
            },
          ],
        },
        ["expected"],
      ),
    /Unexpected/u,
  );
  assert.throws(
    () =>
      assertCatalogModels(
        {
          models: [
            {
              slug: "expected",
              visibility: "none",
              supported_in_api: true,
            },
          ],
        },
        ["expected"],
      ),
    /not visible/u,
  );
});
