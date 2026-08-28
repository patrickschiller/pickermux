import assert from "node:assert/strict";
import test from "node:test";

import { discoverBridgeModels } from "../src/bridge-discovery.mjs";
import { validateBridgeConfig } from "../src/bridge-config.mjs";

function configFor(providers) {
  return validateBridgeConfig({ schemaVersion: 2, bridge: {}, providers });
}

test("maps LM Studio upstream ids to public namespaced picker slugs", async () => {
  const config = configFor([
    {
      id: "lmstudio",
      kind: "lmstudio-responses",
      baseUrl: "http://127.0.0.1:1234/v1",
      allowPrivateNetwork: true,
      models: [
        {
          id: "qwen/upstream",
          slug: "lmstudio/qwen/upstream",
          displayName: "Qwen Local",
          reasoningEffort: "xhigh",
          reasoningEfforts: ["none", "low", "medium", "xhigh"],
        },
      ],
    },
  ]);
  const result = await discoverBridgeModels({
    config,
    fetchImpl: async (url) => {
      assert.equal(url, "http://127.0.0.1:1234/api/v1/models");
      return new Response(
        JSON.stringify({
          models: [
            {
              key: "qwen/upstream",
              type: "llm",
              loaded_instances: [{ config: { context_length: 32_768 } }],
              capabilities: {
                reasoning: {
                  allowed_options: ["off", "low", "medium", "xhigh", "on"],
                },
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  assert.deepEqual(
    {
      id: result.models[0].id,
      upstreamId: result.models[0].upstreamId,
      providerId: result.models[0].providerId,
      contextWindow: result.models[0].contextWindow,
      reasoningEffort: result.models[0].reasoningEffort,
      reasoningEfforts: result.models[0].reasoningEfforts,
    },
    {
      id: "lmstudio/qwen/upstream",
      upstreamId: "qwen/upstream",
      providerId: "lmstudio",
      contextWindow: 32_768,
      reasoningEffort: "xhigh",
      reasoningEfforts: ["none", "low", "medium", "xhigh"],
    },
  );
  assert.deepEqual(result.models[0].reasoningEffortMap, {
    none: "none",
    low: "low",
    medium: "medium",
    xhigh: "xhigh",
  });
  assert.deepEqual(result.models[0].reasoningOmitEfforts, []);
});

test("loaded LM Studio models get stable public metadata and safe reasoning maps", async () => {
  const config = configFor([
    {
      id: "lmstudio",
      kind: "lmstudio-responses",
      baseUrl: "http://127.0.0.1:1234/v1",
      allowPrivateNetwork: true,
      discovery: { mode: "loaded", maxModels: 8 },
      models: [
        {
          id: "qwen/upstream",
          slug: "lmstudio/qwen/custom",
          displayName: "Curated Qwen",
          reasoningEffort: "xhigh",
          reasoningEfforts: ["none", "low", "medium", "xhigh"],
        },
      ],
    },
  ]);
  const result = await discoverBridgeModels({
    config,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              key: "phi/reasoning",
              type: "llm",
              display_name: "Phi Reasoning",
              loaded_instances: [{ config: { context_length: 8_192 } }],
              capabilities: {
                reasoning: { allowed_options: ["on"], default: "on" },
              },
            },
            {
              key: "qwen/upstream",
              type: "llm",
              display_name: "Native Qwen",
              loaded_instances: [{ config: { context_length: 42_496 } }],
              capabilities: {
                reasoning: {
                  allowed_options: ["off", "low", "medium", "xhigh", "on"],
                  default: "xhigh",
                },
              },
            },
            {
              key: "gemma/reasoning",
              type: "llm",
              display_name: "Gemma Reasoning",
              loaded_instances: [{ config: { context_length: 25_856 } }],
              capabilities: {
                reasoning: {
                  allowed_options: ["off", "on"],
                  default_option: "on",
                },
              },
            },
            {
              key: "zeta/plain",
              type: "llm",
              display_name: "Plain Model",
              loaded_instances: [{ config: { context_length: 16_384 } }],
              capabilities: {},
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  assert.deepEqual(
    result.models.map((model) => model.id),
    [
      "lmstudio/qwen/custom",
      "lmstudio/gemma/reasoning",
      "lmstudio/phi/reasoning",
      "lmstudio/zeta/plain",
    ],
  );
  assert.equal(result.models[0].displayName, "Curated Qwen");
  assert.deepEqual(result.models[0].reasoningEffortMap, {
    none: "none",
    low: "low",
    medium: "medium",
    xhigh: "xhigh",
  });

  const gemma = result.models[1];
  assert.equal(gemma.displayName, "Gemma Reasoning – LM Studio");
  assert.equal(gemma.reasoningEffort, "xhigh");
  assert.deepEqual(gemma.reasoningEfforts, ["none", "xhigh"]);
  assert.deepEqual(gemma.reasoningEffortMap, {
    none: "none",
    xhigh: "xhigh",
  });
  assert.deepEqual(gemma.reasoningOmitEfforts, ["xhigh"]);

  const phi = result.models[2];
  assert.equal(phi.reasoningEffort, "xhigh");
  assert.deepEqual(phi.reasoningEfforts, ["xhigh"]);
  assert.deepEqual(phi.reasoningEffortMap, { xhigh: "xhigh" });
  assert.deepEqual(phi.reasoningOmitEfforts, ["xhigh"]);

  const plain = result.models[3];
  assert.equal(plain.reasoningEffort, "none");
  assert.deepEqual(plain.reasoningEfforts, ["none"]);
  assert.deepEqual(plain.reasoningEffortMap, { none: "none" });
  assert.deepEqual(plain.reasoningOmitEfforts, []);
});

test("keeps synthetic on explicit when a toggle model defaults to off", async () => {
  const config = configFor([
    {
      id: "lmstudio",
      kind: "lmstudio-responses",
      baseUrl: "http://127.0.0.1:1234/v1",
      allowPrivateNetwork: true,
      discovery: { mode: "loaded", maxModels: 4 },
      models: [],
    },
  ]);
  const result = await discoverBridgeModels({
    config,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              key: "toggle/default-off",
              type: "llm",
              loaded_instances: [{ config: { context_length: 32_768 } }],
              capabilities: {
                reasoning: {
                  allowed_options: ["off", "on"],
                  default: "off",
                },
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  assert.equal(result.models[0].reasoningEffort, "none");
  assert.deepEqual(result.models[0].reasoningEfforts, ["none", "xhigh"]);
  assert.deepEqual(result.models[0].reasoningOmitEfforts, []);
});

test("loaded discovery maps a refused LM Studio connection to an empty offline snapshot", async () => {
  const loadedConfig = configFor([
    {
      id: "lmstudio",
      kind: "lmstudio-responses",
      baseUrl: "http://127.0.0.1:1234/v1",
      allowPrivateNetwork: true,
      discovery: { mode: "loaded", maxModels: 4 },
      models: [],
    },
  ]);
  const refusedFetch = async () => {
    const refused = new Error("connect refused");
    refused.code = "ECONNREFUSED";
    throw new TypeError("fetch failed", { cause: refused });
  };
  const result = await discoverBridgeModels({
    config: loadedConfig,
    fetchImpl: refusedFetch,
  });
  assert.deepEqual(result.models, []);
  assert.deepEqual(result.providers, [
    {
      id: "lmstudio",
      source: "lmstudio-unavailable",
      models: [],
      skipped: [],
      unavailableReason: "connection-refused",
    },
  ]);

  const allowlistConfig = configFor([
    {
      id: "lmstudio",
      kind: "lmstudio-responses",
      baseUrl: "http://127.0.0.1:1234/v1",
      allowPrivateNetwork: true,
      models: [
        {
          id: "qwen/local",
          slug: "lmstudio/qwen/local",
          displayName: "Qwen Local",
        },
      ],
    },
  ]);
  await assert.rejects(
    discoverBridgeModels({
      config: allowlistConfig,
      fetchImpl: refusedFetch,
    }),
    /unavailable/u,
  );
});

test("generic discovery uses only the named environment credential and explicit metadata", async () => {
  const config = configFor([
    {
      id: "vendor",
      kind: "openai-responses",
      baseUrl: "https://api.vendor.example/v1",
      allowPrivateNetwork: false,
      credentialEnv: "VENDOR_TOKEN",
      models: [
        {
          id: "reasoner",
          slug: "vendor/reasoner",
          displayName: "Vendor Reasoner",
          type: "llm",
          contextWindow: 65_536,
        },
      ],
    },
  ]);
  const result = await discoverBridgeModels({
    config,
    environment: { VENDOR_TOKEN: "provider-secret" },
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.vendor.example/v1/models");
      assert.equal(options.headers.authorization, "Bearer provider-secret");
      return new Response(JSON.stringify({ data: [{ id: "reasoner" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(result.models[0], {
    id: "vendor/reasoner",
    upstreamId: "reasoner",
    providerId: "vendor",
    displayName: "Vendor Reasoner",
    type: "llm",
    contextWindow: 65_536,
    source: "openai-compatible-models",
    capabilities: {},
  });
});

test("generic discovery awaits an injected Keychain credential resolver", async () => {
  const config = configFor([
    {
      id: "vendor",
      kind: "openai-responses",
      baseUrl: "https://api.vendor.example/v1",
      allowPrivateNetwork: false,
      credentialKeychain: true,
      models: [
        {
          id: "reasoner",
          slug: "vendor/reasoner",
          displayName: "Vendor Reasoner",
          type: "llm",
          contextWindow: 65_536,
        },
      ],
    },
  ]);
  let resolvedProvider;
  await discoverBridgeModels({
    config,
    credentialResolver: async (provider) => {
      resolvedProvider = provider;
      return "keychain-secret";
    },
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.authorization, "Bearer keychain-secret");
      return new Response(JSON.stringify({ data: [{ id: "reasoner" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(resolvedProvider.id, "vendor");
  assert.equal(resolvedProvider.credentialKeychain, true);
});

test("missing generic credential errors identify only the environment variable", async () => {
  const config = configFor([
    {
      id: "vendor",
      kind: "openai-responses",
      baseUrl: "https://api.vendor.example/v1",
      allowPrivateNetwork: false,
      credentialEnv: "VENDOR_TOKEN",
      models: [
        {
          id: "reasoner",
          slug: "vendor/reasoner",
          displayName: "Vendor Reasoner",
          type: "llm",
          contextWindow: 8_192,
        },
      ],
    },
  ]);
  await assert.rejects(
    discoverBridgeModels({ config, environment: {}, fetchImpl: async () => assert.fail() }),
    /VENDOR_TOKEN/u,
  );
});
