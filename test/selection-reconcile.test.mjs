import assert from "node:assert/strict";
import test from "node:test";

import { validateBridgeConfig } from "../src/bridge-config.mjs";
import { reconcileSelectedCatalogModel } from "../src/selection-reconcile.mjs";

const config = validateBridgeConfig({
  schemaVersion: 2,
  bridge: {},
  providers: [
    {
      id: "lmstudio",
      kind: "lmstudio-responses",
      baseUrl: "http://127.0.0.1:1234/v1",
      allowPrivateNetwork: true,
      discovery: { mode: "loaded", maxModels: 8 },
      models: [],
    },
  ],
});

function model(slug, efforts) {
  return {
    slug,
    supported_reasoning_levels: efforts.map((effort) => ({ effort })),
  };
}

const native = model("gpt-5.6-sol", ["xhigh", "ultra"]);
const external = model("lmstudio/qwen/local", ["none", "low", "xhigh"]);

test("removed selected external model resets to native defaults and exposes a CAS rollback", async () => {
  const calls = [];
  const result = await reconcileSelectedCatalogModel({
    config,
    currentCatalog: { models: [native, external] },
    nextCatalog: { models: [native] },
    configPath: "/codex/config.toml",
    statePath: "/codex/model-bridge/state.json",
    statusImpl: async () => ({
      installed: true,
      healthy: true,
      status: "installed",
      model: external.slug,
      modelReasoningEffort: "low",
    }),
    restoreImpl: async (options) => {
      calls.push(["restore", options]);
      return {
        changed: true,
        model: options.defaultModel,
        modelReasoningEffort: options.defaultModelReasoningEffort,
        previousModel: external.slug,
        previousModelReasoningEffort: "low",
      };
    },
    setSelectionImpl: async (options) => {
      calls.push(["rollback", options]);
    },
  });
  assert.equal(result.changed, true);
  assert.equal(calls[0][1].defaultModel, "gpt-5.6-sol");
  assert.equal(calls[0][1].defaultModelReasoningEffort, "ultra");
  await result.rollback();
  assert.deepEqual(calls[1][1], {
    configPath: "/codex/config.toml",
    statePath: "/codex/model-bridge/state.json",
    model: external.slug,
    modelReasoningEffort: "low",
    expectedModel: "gpt-5.6-sol",
    expectedModelReasoningEffort: "ultra",
  });
});

test("a still-valid external or native selection is never rewritten", async () => {
  for (const [selectedModel, effort] of [
    [external.slug, "low"],
    [native.slug, "ultra"],
  ]) {
    let restoreCalls = 0;
    const result = await reconcileSelectedCatalogModel({
      config,
      currentCatalog: { models: [native, external] },
      nextCatalog: { models: [native, external] },
      configPath: "/codex/config.toml",
      statePath: "/codex/model-bridge/state.json",
      statusImpl: async () => ({
        installed: true,
        healthy: true,
        status: "installed",
        model: selectedModel,
        modelReasoningEffort: effort,
      }),
      restoreImpl: async () => {
        restoreCalls += 1;
      },
    });
    assert.equal(result.changed, false);
    assert.equal(restoreCalls, 0);
  }
});

test("an external model that loses the selected effort also resets to defaults", async () => {
  let restoreCalls = 0;
  const result = await reconcileSelectedCatalogModel({
    config,
    currentCatalog: { models: [native, external] },
    nextCatalog: {
      models: [native, model(external.slug, ["none", "xhigh"])],
    },
    configPath: "/codex/config.toml",
    statePath: "/codex/model-bridge/state.json",
    statusImpl: async () => ({
      installed: true,
      healthy: true,
      status: "installed",
      model: external.slug,
      modelReasoningEffort: "low",
    }),
    restoreImpl: async (options) => {
      restoreCalls += 1;
      return {
        changed: true,
        model: options.defaultModel,
        modelReasoningEffort: options.defaultModelReasoningEffort,
        previousModel: external.slug,
        previousModelReasoningEffort: "low",
      };
    },
  });
  assert.equal(result.changed, true);
  assert.equal(restoreCalls, 1);
  assert.match(result.reason, /does not support reasoning effort low/u);
});

test("a revoked native entitlement resets to Sol Ultra when the fallback remains", async () => {
  const alternateNative = model("gpt-5.5", ["high", "xhigh"]);
  let restored;
  const result = await reconcileSelectedCatalogModel({
    config,
    currentCatalog: { models: [native, alternateNative, external] },
    nextCatalog: { models: [native, external] },
    configPath: "/codex/config.toml",
    statePath: "/codex/model-bridge/state.json",
    statusImpl: async () => ({
      installed: true,
      healthy: true,
      status: "installed",
      model: alternateNative.slug,
      modelReasoningEffort: "xhigh",
    }),
    restoreImpl: async (options) => {
      restored = options;
      return {
        changed: true,
        model: options.defaultModel,
        modelReasoningEffort: options.defaultModelReasoningEffort,
        previousModel: alternateNative.slug,
        previousModelReasoningEffort: "xhigh",
      };
    },
  });
  assert.equal(result.changed, true);
  assert.equal(restored.defaultModel, "gpt-5.6-sol");
  assert.equal(restored.defaultModelReasoningEffort, "ultra");
});

test("a missing native selection fails closed when Sol Ultra is also unavailable", async () => {
  let restoreCalls = 0;
  await assert.rejects(
    reconcileSelectedCatalogModel({
      config,
      currentCatalog: { models: [native, external] },
      nextCatalog: { models: [external] },
      configPath: "/codex/config.toml",
      statePath: "/codex/model-bridge/state.json",
      statusImpl: async () => ({
        installed: true,
        healthy: true,
        status: "installed",
        model: native.slug,
        modelReasoningEffort: "ultra",
      }),
      restoreImpl: async () => {
        restoreCalls += 1;
      },
    }),
    /missing selected model gpt-5\.6-sol/u,
  );
  assert.equal(restoreCalls, 0);
});
