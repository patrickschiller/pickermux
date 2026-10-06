import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateBridgeConfig } from "../src/bridge-config.mjs";
import { discoverBridgeModels } from "../src/bridge-discovery.mjs";
import { MLX_TOOL_MODEL_INSTRUCTIONS, TEXT_ONLY_MODEL_INSTRUCTIONS, buildMixedCodexCatalog } from "../src/catalog.mjs";
import { normalizeMlxCapabilities, supportsMlxTools } from "../src/mlx-capabilities.mjs";
import { buildProviderRegistry } from "../src/provider-registry.mjs";
import {
  REQUIRED_CERTIFICATION_GATES,
  computeCertificationFingerprint,
  evaluateEfficientFidelityCertification,
  evaluateModelCertification,
  recordPassedCertification,
  recordPassedEfficientFidelityCertification,
  readCertificationStore,
} from "../src/model-certification.mjs";

const modelId = "kolibri-1-mlx-4bit";
const publicModelId = `kolibri/${modelId}`;

function config() {
  return {
    schemaVersion: 2,
    bridge: {},
    providers: [{
      id: "kolibri",
      kind: "mlx-chat-completions",
      baseUrl: "http://127.0.0.1:8080/v1",
      allowPrivateNetwork: true,
      models: [{
        id: modelId,
        slug: publicModelId,
        displayName: "Kolibri 1 MLX 4-bit",
        type: "llm",
        contextWindow: 8_192,
      }],
    }],
  };
}

function discoveredModel() {
  return {
    id: publicModelId,
    upstreamId: modelId,
    providerId: "kolibri",
    providerKind: "mlx-chat-completions",
    displayName: "Kolibri 1 MLX 4-bit",
    type: "llm",
    contextWindow: 8_192,
    source: "mlx-chat-completions",
    capabilities: {},
    reasoningEffort: "none",
    reasoningEfforts: ["none"],
  };
}

function nativeCatalog() {
  return { models: [{
    slug: "gpt-5.6-sol",
    display_name: "Native",
    default_reasoning_level: "ultra",
    supported_reasoning_levels: [{ effort: "ultra" }],
    tool_mode: "direct",
    shell_type: "unified_exec",
    context_window: 200_000,
    max_context_window: 200_000,
    model_messages: {
      instructions_template: "Native agent instructions",
      tools: { developer_instructions: "Native tools" },
    },
    base_instructions: "Native agent instructions",
    truncation_policy: { mode: "tokens", limit: 10_000 },
  }] };
}

test("local MLX config permits only its reviewed model and no reasoning", () => {
  const normalized = validateBridgeConfig(config());
  const model = normalized.providers[0].models[0];
  assert.equal(model.id, modelId);
  assert.equal(model.contextWindow, 8_192);
  assert.equal(model.reasoningEffort, "none");
  assert.deepEqual(model.reasoningEfforts, ["none"]);
  const explicit = config();
  explicit.providers[0].models[0].reasoningEffort = "none";
  explicit.providers[0].models[0].reasoningEfforts = ["none"];
  assert.deepEqual(validateBridgeConfig(explicit), normalized);
});

test("local MLX config rejects remote, ambiguous and credential-bearing endpoints", () => {
  for (const baseUrl of [
    "http://localhost:8080/v1", "http://[::1]:8080/v1",
    "http://127.0.0.2:8080/v1", "http://192.168.1.2:8080/v1",
    "https://api.vendor.example/v1", "https://127.0.0.1:8080/v1",
    "http://127.0.0.1:8080/", "http://127.0.0.1:8080/v1/responses",
    "http://127.0.0.1:8080/v1?key=value", "http://token@127.0.0.1:8080/v1",
  ]) {
    const input = config();
    input.providers[0].baseUrl = baseUrl;
    assert.throws(() => validateBridgeConfig(input), /127\.0\.0\.1|query|credentials/u);
  }
  for (const change of [
    { allowPrivateNetwork: false },
    { credentialEnv: "MLX_TOKEN" },
    { credentialKeychain: true },
    { discovery: { mode: "loaded" } },
  ]) {
    const input = config();
    Object.assign(input.providers[0], change);
    assert.throws(() => validateBridgeConfig(input), /private network|credentials|only for/u);
  }
});

test("local MLX config requires exact llm identity, bounded context and text-only settings", () => {
  for (const change of [
    { id: "other-model" }, { type: undefined }, { type: "embedding" },
    { contextWindow: undefined }, { contextWindow: 0 }, { contextWindow: 1_023 },
    { contextWindow: 262_145 }, { contextWindow: 1.5 },
    { reasoningEffort: "high" }, { reasoningEfforts: ["none", "low"] },
    { toolsEnabled: true }, { slug: "kolibri/" },
  ]) {
    const input = config();
    Object.assign(input.providers[0].models[0], change);
    assert.throws(() => validateBridgeConfig(input));
  }
  const extra = config();
  extra.providers[0].models.push({ ...extra.providers[0].models[0], slug: "kolibri/alias" });
  assert.throws(() => validateBridgeConfig(extra), /Duplicate upstream model/u);
});

test("MLX discovery binds the sole alias to its confirmed context without resolving credentials", async () => {
  const result = await discoverBridgeModels({
    config: validateBridgeConfig(config()),
    credentialResolver: () => { throw new Error("Credential resolution is forbidden"); },
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:8080/v1/models");
      assert.deepEqual(options.headers, { accept: "application/json" });
      assert.equal(options.redirect, "error");
      return new Response(JSON.stringify({ data: [{
        id: modelId, object: "model", context_window: 8_192,
      }] }));
    },
  });
  assert.deepEqual(result.models, [discoveredModel()]);
  assert.equal(result.providers[0].source, "mlx-chat-completions");
});

test("MLX discovery rejects stale context, missing metadata and extra or foreign aliases", async () => {
  for (const data of [
    [], [{ id: modelId }],
    [{ id: modelId, object: "model", context_window: 4_096 }],
    [{ id: modelId, object: "model", context_window: 16_384 }],
    [{ id: modelId, object: "model", context_window: "8192" }],
    [{ id: "other-model", object: "model", context_window: 8_192 }],
    [{ id: modelId, object: "model", context_window: 8_192 }, { id: "extra" }],
    [{ id: modelId, object: "model", context_window: 8_192 }, { id: modelId }],
  ]) {
    await assert.rejects(discoverBridgeModels({
      config: validateBridgeConfig(config()),
      credentialResolver: () => { throw new Error("Must not resolve credentials"); },
      fetchImpl: async () => new Response(JSON.stringify({ data })),
    }), (error) => error.code === "PROVIDER_RESPONSE_INVALID");
  }
});

test("MLX publishes 262144 only from an exact discovery match and leaves tools conservative", async () => {
  const input = config();
  input.providers[0].models[0].contextWindow = 262_144;
  const normalized = validateBridgeConfig(input);
  const discover = (context) => discoverBridgeModels({
    config: normalized,
    credentialResolver: () => { throw new Error("Must not resolve credentials"); },
    fetchImpl: async () => new Response(JSON.stringify({ data: [{
      id: modelId, object: "model", context_window: context,
    }] })),
  });
  for (const context of [8_192, 262_143, 262_145]) {
    await assert.rejects(discover(context), { code: "PROVIDER_RESPONSE_INVALID" });
  }
  const discovery = await discover(262_144);
  const native = nativeCatalog();
  const mixed = buildMixedCodexCatalog({ bundledCatalog: native, discoveredModels: discovery.models, donorSlug: "gpt-5.6-sol" });
  assert.deepEqual(mixed.models[0], native.models[0]);
  const model = mixed.models.find((entry) => entry.slug === publicModelId);
  assert.equal(model.context_window, 262_144);
  assert.equal(model.max_context_window, 262_144);
  assert.doesNotMatch(model.display_name, /⚠/u);
  assert.equal(model.tool_mode, null);
  const registry = buildProviderRegistry({ config: normalized, mixedCatalog: mixed, discoveredModels: discovery.models });
  assert.equal(registry.resolve(publicModelId).model.contextWindow, 262_144);
  assert.equal(registry.resolve(publicModelId).toolsEnabled, false);
});

test("MLX catalog ignores all certification claims and publishes only compact text instructions", () => {
  const native = nativeCatalog();
  const before = JSON.stringify(native);
  const mixed = buildMixedCodexCatalog({
    discoveredModels: [discoveredModel()],
    bundledCatalog: native,
    donorSlug: "gpt-5.6-sol",
    certifiedModelSlugs: [publicModelId],
    efficientFidelityModelSlugs: [publicModelId],
  });
  const model = mixed.models[1];
  assert.equal(JSON.stringify(native), before);
  assert.deepEqual(mixed.models[0], native.models[0]);
  assert.equal(model.tool_mode, null);
  assert.equal(model.shell_type, "disabled");
  assert.equal(model.supports_search_tool, false);
  assert.equal(model.apply_patch_tool_type, null);
  assert.equal(model.multi_agent_version, null);
  assert.equal(model.context_window, 8_192);
  assert.equal(model.default_reasoning_level, "none");
  assert.equal(model.supports_reasoning_effort_updates, false);
  assert.equal(model.supports_reasoning_summary_parameter, false);
  assert.deepEqual(model.input_modalities, ["text"]);
  assert.equal(model.base_instructions, TEXT_ONLY_MODEL_INSTRUCTIONS);
  assert.deepEqual(model.model_messages, {
    instructions_template: TEXT_ONLY_MODEL_INSTRUCTIONS,
    instructions_variables: null,
  });
});

test("MLX catalog blocks donor reasoning control claims while preserving native and LM Studio descriptors", () => {
  const native = nativeCatalog();
  Object.assign(native.models[0], {
    supports_reasoning_effort_updates: true,
    supports_reasoning_summary_parameter: true,
  });
  const before = structuredClone(native);
  const mixed = buildMixedCodexCatalog({
    discoveredModels: [
      { ...discoveredModel(), supports_reasoning_effort_updates: true,
        supports_reasoning_summary_parameter: true },
      { id: "lmstudio/example", displayName: "LM Studio example", type: "llm",
        contextWindow: 32_768, providerKind: "lmstudio-responses", source: "lmstudio-v1" },
    ],
    bundledCatalog: native,
    donorSlug: "gpt-5.6-sol",
  });
  const mlx = mixed.models.find((model) => model.slug === publicModelId);
  assert.equal(mlx.supports_reasoning_effort_updates, false);
  assert.equal(mlx.supports_reasoning_summary_parameter, false);
  assert.equal(mlx.default_reasoning_level, "none");
  assert.deepEqual(mlx.supported_reasoning_levels.map(({ effort }) => effort), ["none"]);
  assert.deepEqual(mixed.models[0], before.models[0]);
  assert.deepEqual(native, before);
  const lmstudio = mixed.models.find((model) => model.slug === "lmstudio/example");
  assert.equal(lmstudio.supports_reasoning_effort_updates, true);
  assert.equal(lmstudio.supports_reasoning_summary_parameter, true);
});

test("MLX registry ignores forged catalog and discovery tool, identity, context and reasoning claims", () => {
  const mixed = nativeCatalog();
  mixed.models.push({
    slug: publicModelId, tool_mode: "direct", shell_type: "unified_exec",
    supports_search_tool: true, context_window: 999_999,
    comp_hash: "model-bridge-p6-0123456789abcdef",
    default_reasoning_level: "high", supported_reasoning_levels: [{ effort: "high" }],
  });
  const registry = buildProviderRegistry({
    mixedCatalog: mixed,
    config: config(),
    discoveredModels: [{ ...discoveredModel(), upstreamId: "foreign", contextWindow: 999_999,
      reasoningEffort: "high", reasoningEfforts: ["high"], reasoningEffortMap: { high: "high" } }],
  });
  const route = registry.resolve(publicModelId);
  assert.equal(route.toolsEnabled, false);
  assert.equal(route.clientToolSearchEnabled, false);
  assert.equal(route.upstreamModel, modelId);
  assert.equal(route.model.contextWindow, 8_192);
  assert.equal(route.reasoningEffort, "none");
  assert.deepEqual(route.reasoningEfforts, ["none"]);
  assert.equal(route.reasoningEffortMap, undefined);
  assert.equal(Object.isFrozen(route), true);
  for (const unknown of ["kolibri/", "kolibri/other", "KOLIBRI/kolibri-1-mlx-4bit"]) {
    assert.throws(() => registry.resolve(unknown), { code: "UNKNOWN_MODEL" });
  }
});

test("MLX certification ignores forged complete receipts and rejects recording a tool grant", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "mlx-certification-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const subject = {
    providerId: "kolibri", providerKind: "mlx-chat-completions",
    baseUrl: "http://127.0.0.1:8080/v1", publicModelId, upstreamModelId: modelId,
    contextWindow: 8_192, reasoning: { effort: "none", efforts: ["none"] },
    capabilities: {}, codexClientVersion: "0.116.0",
  };
  const gates = Object.fromEntries(REQUIRED_CERTIFICATION_GATES.map((gate) => [gate, true]));
  const store = { contractVersion: 1, receipts: { [publicModelId]: {
    fingerprint: computeCertificationFingerprint(subject),
    passedAt: "2026-10-05T00:00:00.000Z", gates: { ...gates, toolSearch: true },
  } } };
  assert.equal(evaluateModelCertification(store, subject).status, "missing");
  assert.equal(evaluateEfficientFidelityCertification(store, subject).status, "missing");
  store.pendingDeactivations = [publicModelId];
  assert.equal(evaluateModelCertification(store, subject).status, "pending");
  const storePath = path.join(directory, "certifications.json");
  await assert.rejects(recordPassedCertification(storePath, subject, gates), /no reviewed tool protocol/u);
  await assert.rejects(access(storePath), { code: "ENOENT" });
});

const toolCapabilities = {
  mlxToolProtocol: "pickermux-mlx-tools-v1",
  modelFingerprint: `sha256:${"a".repeat(64)}`,
  runtimeFingerprint: `sha256:${"b".repeat(64)}`,
  mlxMaxOutputTokens: 1024,
};

test("MLX protocol declarations are exact identities and never a generic tools claim", () => {
  assert.equal(supportsMlxTools(toolCapabilities), true);
  assert.deepEqual(normalizeMlxCapabilities(), {});
  for (const change of [
    { tools: true }, { mlxToolProtocol: "future" }, { modelFingerprint: "sha256:bad" },
    { runtimeFingerprint: undefined }, { mlxProfileDigest: "invalid" },
    { mlxMaxOutputTokens: 0 }, { mlxMaxOutputTokens: 2049 },
    { mlxMaxOutputTokens: undefined },
    { modelFingerprint: [`sha256:${"a".repeat(64)}`] },
  ]) {
    const value = { ...toolCapabilities, ...change };
    assert.throws(() => normalizeMlxCapabilities(value));
    assert.equal(supportsMlxTools(value), false);
  }
});

test("managed HF model aliases require an exact profile digest during configuration and discovery", async () => {
  const input = config();
  const model = input.providers[0].models[0];
  model.id = "example-model";
  model.slug = "kolibri/example-model";
  model.mlxProfileDigest = `sha256:${"c".repeat(64)}`;
  const normalized = validateBridgeConfig(input);
  for (const digest of [model.mlxProfileDigest, `sha256:${"d".repeat(64)}`, undefined]) {
    const discovery = discoverBridgeModels({ config: normalized,
      credentialResolver: () => { throw new Error("Must not resolve credentials"); },
      fetchImpl: async () => new Response(JSON.stringify({ data: [{
        id: model.id, object: "model", context_window: model.contextWindow,
        capabilities: digest === undefined ? {} : { mlxProfileDigest: digest },
      }] })),
    });
    if (digest === model.mlxProfileDigest) {
      const result = await discovery;
      assert.equal(result.models[0].capabilities.mlxProfileDigest, digest);
    } else await assert.rejects(discovery, (error) => error.code === "PROVIDER_RESPONSE_INVALID");
  }
  const foreign = config();
  foreign.providers[0].kind = "openai-responses";
  foreign.providers[0].models[0].mlxProfileDigest = model.mlxProfileDigest;
  assert.throws(() => validateBridgeConfig(foreign), /only for local MLX/u);
});

test("MLX tools require both a reviewed live protocol and the certified catalog grant", () => {
  for (const certified of [false, true]) {
    for (const capabilities of [{}, toolCapabilities]) {
      const model = { ...discoveredModel(), capabilities };
      const mixedCatalog = buildMixedCodexCatalog({
        discoveredModels: [model], bundledCatalog: nativeCatalog(), donorSlug: "gpt-5.6-sol",
        certifiedModelSlugs: certified ? [publicModelId] : [],
        efficientFidelityModelSlugs: certified ? [publicModelId] : [],
      });
      const expected = certified && capabilities === toolCapabilities;
      const entry = mixedCatalog.models[1];
      assert.equal(entry.tool_mode, expected ? "direct" : null);
      assert.equal(entry.shell_type, expected ? "unified_exec" : "disabled");
      assert.equal(entry.supports_search_tool, expected);
      assert.equal(entry.base_instructions, expected ? MLX_TOOL_MODEL_INSTRUCTIONS : TEXT_ONLY_MODEL_INSTRUCTIONS);
      const route = buildProviderRegistry({ config: config(), mixedCatalog, discoveredModels: [model] }).resolve(publicModelId);
      assert.equal(route.toolsEnabled, expected);
      assert.equal(route.clientToolSearchEnabled, expected);
      assert.equal(route.upstreamModel, modelId);
      assert.equal(route.model.contextWindow, 8192);
    }
  }
});

test("MLX receipts bind model files, runtime parser and profile; Efficient Fidelity remains additive", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "mlx-tools-certification-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, "certifications.json");
  const subject = {
    providerId: "kolibri", providerKind: "mlx-chat-completions",
    baseUrl: "http://127.0.0.1:8080/v1", publicModelId, upstreamModelId: modelId,
    contextWindow: 8192, reasoning: { effort: "none", efforts: ["none"] },
    capabilities: toolCapabilities, codexClientVersion: "0.116.0",
  };
  const gates = Object.fromEntries(REQUIRED_CERTIFICATION_GATES.map((gate) => [gate, true]));
  await assert.rejects(recordPassedCertification(storePath, subject, { ...gates, toolResult: false }));
  await recordPassedCertification(storePath, subject, gates);
  let store = await readCertificationStore(storePath);
  assert.equal(evaluateModelCertification(store, subject).status, "valid");
  assert.equal(evaluateEfficientFidelityCertification(store, subject).status, "missing");
  await recordPassedEfficientFidelityCertification(storePath, subject, { toolSearch: true });
  store = await readCertificationStore(storePath);
  assert.equal(evaluateEfficientFidelityCertification(store, subject).status, "valid");
  for (const key of ["modelFingerprint", "runtimeFingerprint", "mlxProfileDigest", "mlxMaxOutputTokens"]) {
    const changed = { ...subject, capabilities: { ...toolCapabilities,
      [key]: key === "mlxMaxOutputTokens" ? 2048 : `sha256:${"e".repeat(64)}` } };
    assert.equal(evaluateModelCertification(store, changed).status, "stale");
    assert.equal(evaluateEfficientFidelityCertification(store, changed).status, "stale");
  }
});
