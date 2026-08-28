import assert from "node:assert/strict";
import test from "node:test";

import { MODEL_DEFAULT_REASONING_DESCRIPTION } from "../src/catalog.mjs";

import {
  NATIVE_CODEX_BASE_URL,
  UnknownModelError,
  buildProviderRegistry,
  createReloadableProviderRegistry,
} from "../src/provider-registry.mjs";

function config() {
  return {
    schemaVersion: 2,
    bridge: { port: 4210 },
    providers: [
      {
        id: "lmstudio",
        kind: "lmstudio-responses",
        baseUrl: "http://127.0.0.1:1234/v1",
        allowPrivateNetwork: true,
        models: [
          {
            id: "qwen/qwen3.8-27b",
            slug: "lmstudio/qwen/qwen3.8-27b",
            displayName: "Qwen 3.8 27B",
            type: "llm",
            contextWindow: 42_496,
            reasoningEffort: "xhigh",
            reasoningEfforts: ["none", "low", "medium", "xhigh"],
          },
        ],
      },
      {
        id: "vendor",
        kind: "openai-responses",
        baseUrl: "https://api.vendor.example/v1",
        allowPrivateNetwork: false,
        credentialEnv: "VENDOR_TOKEN",
        models: [
          {
            id: "internal-model-id",
            slug: "vendor/public-slug",
            displayName: "Vendor Public Model",
          },
        ],
      },
    ],
  };
}

function bundledCatalog() {
  return {
    models: [
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6 Sol",
        supported_reasoning_levels: [{ effort: "ultra" }],
      },
      { slug: "gpt-5.4-mini", display_name: "GPT-5.4 mini" },
    ],
  };
}

test("routes every exact bundled slug to the fixed native Codex backend", () => {
  const source = bundledCatalog();
  const before = JSON.stringify(source);
  const registry = buildProviderRegistry({ bundledCatalog: source, config: config() });

  assert.deepEqual(registry.resolve("gpt-5.6-sol"), {
    kind: "native-openai",
    slug: "gpt-5.6-sol",
    upstreamModel: "gpt-5.6-sol",
    baseUrl: NATIVE_CODEX_BASE_URL,
    model: source.models[0],
  });
  assert.equal(NATIVE_CODEX_BASE_URL, "https://chatgpt.com/backend-api/codex");
  assert.equal(JSON.stringify(source), before);
  assert.equal(Object.isFrozen(registry.resolve("gpt-5.6-sol")), true);
});

test("keeps the external picker slug separate from the upstream model id", () => {
  const registry = buildProviderRegistry({
    bundledCatalog: bundledCatalog(),
    config: config(),
  });
  assert.deepEqual(registry.resolve("lmstudio/qwen/qwen3.8-27b"), {
    kind: "external",
    slug: "lmstudio/qwen/qwen3.8-27b",
    upstreamModel: "qwen/qwen3.8-27b",
    providerId: "lmstudio",
    providerKind: "lmstudio-responses",
    baseUrl: "http://127.0.0.1:1234/v1",
    allowPrivateNetwork: true,
    reasoningEffort: "xhigh",
    reasoningEfforts: ["none", "low", "medium", "xhigh"],
    model: {
      id: "qwen/qwen3.8-27b",
      slug: "lmstudio/qwen/qwen3.8-27b",
      displayName: "Qwen 3.8 27B",
      type: "llm",
      contextWindow: 42_496,
      reasoningEffort: "xhigh",
      reasoningEfforts: ["none", "low", "medium", "xhigh"],
    },
  });

  const vendor = registry.resolve("vendor/public-slug");
  assert.equal(vendor.upstreamModel, "internal-model-id");
  assert.equal(vendor.credentialEnv, "VENDOR_TOKEN");
});

test("routes carry only a Keychain credential reference", () => {
  const input = config();
  delete input.providers[1].credentialEnv;
  input.providers[1].credentialKeychain = true;
  const registry = buildProviderRegistry({
    bundledCatalog: bundledCatalog(),
    config: input,
  });
  const route = registry.resolve("vendor/public-slug");
  assert.equal(route.credentialKeychain, true);
  assert.equal(route.credentialEnv, undefined);
  assert.equal(JSON.stringify(route).includes("security"), false);

  const mixed = bundledCatalog();
  mixed.models.push(
    { slug: "lmstudio/qwen/qwen3.8-27b", display_name: "Qwen 3.8 27B" },
    { slug: "vendor/public-slug", display_name: "Vendor Public Model" },
  );
  assert.equal(
    buildProviderRegistry({ mixedCatalog: mixed, config: input })
      .resolve("vendor/public-slug").credentialKeychain,
    true,
  );
});

test("routes cache-only native models from the installed mixed catalog", () => {
  const source = bundledCatalog();
  source.models.push({
    slug: "gpt-5.3-codex-spark",
    display_name: "GPT-5.3-Codex-Spark",
  });
  source.models.push({
    slug: "lmstudio/qwen/qwen3.8-27b",
    display_name: "Qwen 3.8 27B",
  });
  source.models.push({
    slug: "vendor/public-slug",
    display_name: "Vendor Public Model",
  });
  const registry = buildProviderRegistry({ mixedCatalog: source, config: config() });
  assert.equal(registry.resolve("gpt-5.3-codex-spark").kind, "native-openai");
  const qwen = registry.resolve("lmstudio/qwen/qwen3.8-27b");
  assert.equal(qwen.upstreamModel, "qwen/qwen3.8-27b");
  assert.deepEqual(qwen.reasoningEffortMap, {
    none: "none",
    low: "low",
    medium: "medium",
    xhigh: "xhigh",
  });
  assert.deepEqual(
    registry.listModels().map((model) => model.id),
    [
      "gpt-5.6-sol",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
      "lmstudio/qwen/qwen3.8-27b",
      "vendor/public-slug",
    ],
  );
});

test("never reclassifies an unclaimed namespaced external slug as native", () => {
  const source = bundledCatalog();
  source.models.push(
    { slug: "lmstudio/old", display_name: "Stale external" },
    { slug: "lmstudio/qwen/qwen3.8-27b", display_name: "Current external" },
    { slug: "vendor/public-slug", display_name: "Vendor external" },
  );
  assert.throws(
    () => buildProviderRegistry({ mixedCatalog: source, config: config() }),
    /Refusing to classify unclaimed namespaced model as native/u,
  );
});

test("loaded discovery claims only its provider namespace and reconstructs exact routes", () => {
  const input = config();
  input.providers = [
    {
      ...input.providers[0],
      discovery: { mode: "loaded", maxModels: 32 },
    },
  ];
  const source = bundledCatalog();
  source.models.push(
    {
      slug: "lmstudio/microsoft/phi-reasoning",
      display_name: "Phi Reasoning – LM Studio",
      context_window: 8_192,
      comp_hash: "model-bridge-p2-0123456789abcdef",
      default_reasoning_level: "xhigh",
      supported_reasoning_levels: [
        {
          effort: "xhigh",
          description: MODEL_DEFAULT_REASONING_DESCRIPTION,
        },
      ],
    },
    {
      slug: "lmstudio/qwen/qwen3.8-27b",
      display_name: "Qwen 3.8 27B",
      context_window: 42_496,
      default_reasoning_level: "xhigh",
      supported_reasoning_levels: [
        { effort: "none" },
        { effort: "xhigh" },
      ],
    },
    {
      slug: "lmstudio/untrusted/exact-xhigh",
      display_name: "Untrusted Exact Xhigh",
      context_window: 32_768,
      comp_hash: "foreign-catalog-entry",
      default_reasoning_level: "xhigh",
      supported_reasoning_levels: [
        {
          effort: "xhigh",
          description: MODEL_DEFAULT_REASONING_DESCRIPTION,
        },
      ],
    },
  );
  const registry = buildProviderRegistry({
    mixedCatalog: source,
    config: input,
    discoveredModels: [
      {
        id: "lmstudio/microsoft/phi-reasoning",
        upstreamId: "microsoft/phi-reasoning",
        displayName: "Phi Reasoning – LM Studio",
        type: "llm",
        contextWindow: 8_192,
        reasoningEffort: "xhigh",
        reasoningEfforts: ["xhigh"],
        reasoningEffortMap: { xhigh: "xhigh" },
        reasoningOmitEfforts: ["xhigh"],
      },
    ],
  });
  const phi = registry.resolve("lmstudio/microsoft/phi-reasoning");
  assert.equal(phi.upstreamModel, "microsoft/phi-reasoning");
  assert.deepEqual(phi.reasoningEffortMap, { xhigh: "xhigh" });
  assert.deepEqual(phi.reasoningOmitEfforts, ["xhigh"]);
  assert.equal(Object.isFrozen(phi.reasoningOmitEfforts), true);
  const fallbackQwen = registry.resolve("lmstudio/qwen/qwen3.8-27b");
  assert.equal(fallbackQwen.upstreamModel, "qwen/qwen3.8-27b");
  assert.deepEqual(fallbackQwen.reasoningEffortMap, {
    none: "none",
    low: "low",
    medium: "medium",
    xhigh: "xhigh",
  });
  assert.deepEqual(fallbackQwen.reasoningOmitEfforts, []);

  const catalogOnlyRegistry = buildProviderRegistry({
    mixedCatalog: source,
    config: input,
  });
  assert.deepEqual(
    catalogOnlyRegistry.resolve("lmstudio/microsoft/phi-reasoning")
      .reasoningOmitEfforts,
    ["xhigh"],
  );
  assert.deepEqual(
    catalogOnlyRegistry.resolve("lmstudio/untrusted/exact-xhigh")
      .reasoningOmitEfforts,
    [],
  );

  source.models.push({ slug: "foreign/unsafe", display_name: "Foreign" });
  assert.throws(
    () => buildProviderRegistry({ mixedCatalog: source, config: input }),
    /unclaimed namespaced model/u,
  );
});

test("reloadable registry swaps complete immutable snapshots", () => {
  const first = buildProviderRegistry({ bundledCatalog: bundledCatalog(), config: config() });
  const controller = createReloadableProviderRegistry(first);
  const nextCatalog = bundledCatalog();
  nextCatalog.models.unshift({ slug: "gpt-5.5", display_name: "GPT-5.5" });
  const second = buildProviderRegistry({ bundledCatalog: nextCatalog, config: config() });

  assert.throws(() => controller.resolve("gpt-5.5"), UnknownModelError);
  controller.replace(second);
  assert.equal(controller.resolve("gpt-5.5").kind, "native-openai");
  assert.equal(controller.nativeModels.length, second.nativeModels.length);
});

test("fails closed for unknown, differently-cased and prefix-only model names", () => {
  const registry = buildProviderRegistry({
    bundledCatalog: bundledCatalog(),
    config: config(),
  });
  for (const model of [
    "gpt-5.6",
    "GPT-5.6-SOL",
    "lmstudio/",
    "lmstudio/unknown",
    " gpt-5.6-sol",
    null,
  ]) {
    assert.throws(
      () => registry.resolve(model),
      (error) =>
        error instanceof UnknownModelError &&
        error.code === "UNKNOWN_MODEL" &&
        error.statusCode === 400,
    );
  }
});

test("lists only safe picker-facing descriptors in deterministic order", () => {
  const registry = buildProviderRegistry({
    bundledCatalog: bundledCatalog(),
    config: config(),
  });
  const listed = registry.listModels();
  assert.deepEqual(
    listed.map(({ id, owned_by, kind }) => ({ id, owned_by, kind })),
    [
      { id: "gpt-5.6-sol", owned_by: "openai", kind: "native-openai" },
      { id: "gpt-5.4-mini", owned_by: "openai", kind: "native-openai" },
      {
        id: "lmstudio/qwen/qwen3.8-27b",
        owned_by: "lmstudio",
        kind: "external",
      },
      { id: "vendor/public-slug", owned_by: "vendor", kind: "external" },
    ],
  );
  assert.equal(JSON.stringify(listed).includes("VENDOR_TOKEN"), false);
  assert.equal(JSON.stringify(listed).includes("internal-model-id"), false);
  listed[0].id = "mutated";
  assert.equal(registry.listModels()[0].id, "gpt-5.6-sol");
});

test("rejects external collisions with native slugs", () => {
  const colliding = config();
  const native = bundledCatalog();
  native.models.push({ slug: "lmstudio/qwen/qwen3.8-27b" });
  assert.throws(
    () => buildProviderRegistry({ bundledCatalog: native, config: colliding }),
    /collides with existing slug/u,
  );
});

test("rejects duplicate or malformed native catalog slugs", () => {
  const duplicate = bundledCatalog();
  duplicate.models.push({ slug: "gpt-5.6-sol" });
  assert.throws(
    () => buildProviderRegistry({ bundledCatalog: duplicate, config: config() }),
    /Duplicate native model slug/u,
  );

  const malformed = bundledCatalog();
  malformed.models.push({ display_name: "Missing slug" });
  assert.throws(
    () => buildProviderRegistry({ bundledCatalog: malformed, config: config() }),
    /has no valid slug/u,
  );
});

test("does not permit config to override the native destination", () => {
  const input = config();
  input.native = { baseUrl: "https://attacker.example/v1" };
  assert.throws(
    () => buildProviderRegistry({ bundledCatalog: bundledCatalog(), config: input }),
    /unsupported property native/u,
  );
});
