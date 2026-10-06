import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateBridgeConfig } from "../src/bridge-config.mjs";
import { discoverBridgeModels } from "../src/bridge-discovery.mjs";
import { buildBridgeStartupRegistry } from "../src/bridge-startup.mjs";
import { listenBridgeServer } from "../src/bridge-server.mjs";
import { buildMixedCodexCatalog } from "../src/catalog.mjs";
import { certificationSubjectForModel } from "../src/certification-runner.mjs";
import { CERTIFICATION_HEADER } from "../src/certification-transport.mjs";
import {
  REQUIRED_CERTIFICATION_GATES,
  assertModelCertificationRequestAllowed,
  commitModelCertificationDeactivation,
  recordPassedCertification,
  recordPassedEfficientFidelityCertification,
  stageModelCertificationDeactivation,
} from "../src/model-certification.mjs";
import { buildProviderRegistry } from "../src/provider-registry.mjs";

const SLUG = "kolibri/kolibri-1-mlx-4bit";
const MODEL = "kolibri-1-mlx-4bit-262k";
const CLIENT_VERSION = "0.160.0";
const PROFILE = "sha256:" + "c".repeat(64);
const TOOL_CAPABILITIES = {
  mlxToolProtocol: "pickermux-mlx-tools-v1",
  modelFingerprint: "sha256:" + "a".repeat(64),
  runtimeFingerprint: "sha256:" + "b".repeat(64),
  mlxProfileDigest: PROFILE,
  mlxMaxOutputTokens: 1024,
};

function nativeCatalog() {
  return { models: [{
    slug: "gpt-5.6-sol",
    display_name: "Native",
    supported_in_api: true,
    default_reasoning_level: "ultra",
    supported_reasoning_levels: [{ effort: "ultra" }],
    tool_mode: "direct",
    shell_type: "unified_exec",
    supports_search_tool: true,
    context_window: 200_000,
    max_context_window: 200_000,
    model_messages: { instructions_template: "Native instructions", instructions_variables: null },
    base_instructions: "Native instructions",
    truncation_policy: { mode: "tokens", limit: 10_000 },
  }] };
}

function modelFor(config, capabilities = TOOL_CAPABILITIES) {
  const provider = config.providers.find((entry) => entry.id === "kolibri");
  const model = provider.models[0];
  return {
    id: model.slug,
    upstreamId: model.id,
    providerId: provider.id,
    providerKind: provider.kind,
    displayName: model.displayName,
    type: "llm",
    contextWindow: model.contextWindow,
    source: "mlx-chat-completions",
    reasoningEffort: "none",
    reasoningEfforts: ["none"],
    capabilities,
  };
}

async function fixture(t, {
  port = 8082,
  legacy = false,
  vendor = false,
  catalogTools = false,
  catalogEfficient = false,
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "bridge-startup-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const providers = [{
    id: "kolibri",
    kind: "mlx-chat-completions",
    baseUrl: "http://127.0.0.1:" + port + "/v1",
    allowPrivateNetwork: true,
    models: [{
      id: legacy ? "kolibri-1-mlx-4bit" : MODEL,
      slug: SLUG,
      displayName: "Kolibri test",
      type: "llm",
      contextWindow: legacy ? 8192 : 262144,
      ...(legacy ? {} : { mlxProfileDigest: PROFILE }),
    }],
  }];
  if (vendor) providers.push({
    id: "vendor",
    kind: "openai-responses",
    baseUrl: "https://provider.example/v1",
    allowPrivateNetwork: false,
    credentialEnv: "TEST_PROVIDER_TOKEN",
    models: [{ id: "text-model", slug: "vendor/text-model", displayName: "Vendor", type: "llm", contextWindow: 32768 }],
  });
  const config = validateBridgeConfig({ schemaVersion: 2, bridge: {}, providers });
  const model = modelFor(config);
  const discoveredModels = [model];
  if (vendor) discoveredModels.push({
    id: "vendor/text-model", upstreamId: "text-model", providerId: "vendor",
    displayName: "Vendor", type: "llm", contextWindow: 32768,
    source: "openai-compatible-models", capabilities: {},
    reasoningEffort: "none", reasoningEfforts: ["none"],
  });
  const mixedCatalog = buildMixedCodexCatalog({
    bundledCatalog: nativeCatalog(),
    discoveredModels,
    certifiedModelSlugs: catalogTools ? [SLUG] : [],
    efficientFidelityModelSlugs: catalogEfficient ? [SLUG] : [],
  });
  return {
    config, model, mixedCatalog,
    certificationPath: path.join(directory, "certifications.json"),
    codexClientVersion: CLIENT_VERSION,
    credentialResolver: () => { throw new Error("No credentials may be resolved"); },
  };
}

function discovery(capabilities = TOOL_CAPABILITIES, transform = (entry) => entry) {
  return (options) => discoverBridgeModels({
    ...options,
    fetchImpl: async (url, request) => {
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/v1\/models$/u);
      assert.deepEqual(request.headers, { accept: "application/json" });
      assert.equal(request.redirect, "error");
      const configured = options.config.providers[0].models[0];
      return new Response(JSON.stringify({ data: [transform({
        id: configured.id,
        object: "model",
        context_window: configured.contextWindow,
        capabilities,
      })] }));
    },
  });
}

async function receipts(f, { efficient = false } = {}) {
  const subject = certificationSubjectForModel({
    config: f.config, model: f.model, codexClientVersion: CLIENT_VERSION,
  });
  await recordPassedCertification(f.certificationPath, subject,
    Object.fromEntries(REQUIRED_CERTIFICATION_GATES.map((gate) => [gate, true])));
  if (efficient) await recordPassedEfficientFidelityCertification(
    f.certificationPath, subject, { toolSearch: true });
}

test("startup without MLX preserves native and existing provider routes without discovery or receipts", async () => {
  const config = validateBridgeConfig({
    schemaVersion: 2, bridge: {},
    providers: [{
      id: "vendor", kind: "openai-responses", baseUrl: "https://provider.example/v1",
      allowPrivateNetwork: false,
      models: [{ id: "text-model", slug: "vendor/text-model", displayName: "Vendor", type: "llm", contextWindow: 32768 }],
    }],
  });
  const mixedCatalog = { models: [...nativeCatalog().models, {
    slug: "vendor/text-model", display_name: "Vendor",
    tool_mode: "direct", shell_type: "unified_exec", supports_search_tool: false,
    context_window: 32768,
  }] };
  const before = JSON.stringify(mixedCatalog);
  const expected = buildProviderRegistry({ config, mixedCatalog });
  const registry = await buildBridgeStartupRegistry({
    config, mixedCatalog, certificationPath: "must-not-read", codexClientVersion: CLIENT_VERSION,
  }, {
    discoverImpl: () => { throw new Error("Discovery must not run"); },
    resolveCapabilitiesImpl: () => { throw new Error("Receipts must not be read"); },
  });
  assert.deepEqual(registry.resolve("gpt-5.6-sol"), expected.resolve("gpt-5.6-sol"));
  assert.deepEqual(registry.resolve("vendor/text-model"), expected.resolve("vendor/text-model"));
  assert.equal(JSON.stringify(mixedCatalog), before);
});

test("startup discovers only MLX providers and preserves native and unrelated routes", async (t) => {
  const f = await fixture(t, { vendor: true });
  const expected = buildProviderRegistry({ config: f.config, mixedCatalog: f.mixedCatalog });
  const before = JSON.stringify(f.mixedCatalog);
  const registry = await buildBridgeStartupRegistry(f, {
    discoverImpl: async (options) => {
      assert.deepEqual(options.config.providers.map((provider) => provider.id), ["kolibri"]);
      assert.equal(options.credentialResolver, f.credentialResolver);
      return discovery()(options);
    },
  });
  assert.deepEqual(registry.resolve("gpt-5.6-sol"), expected.resolve("gpt-5.6-sol"));
  assert.deepEqual(registry.resolve("vendor/text-model"), expected.resolve("vendor/text-model"));
  assert.equal(JSON.stringify(f.mixedCatalog), before);
  assert.deepEqual(registry.resolve(SLUG).mlxCapabilities, TOOL_CAPABILITIES);
  assert.equal(registry.resolve(SLUG).toolsEnabled, false);
});

test("startup missing receipts strips stale MLX catalog grants while preserving the live protocol", async (t) => {
  const f = await fixture(t, { catalogTools: true, catalogEfficient: true });
  const before = JSON.stringify(f.mixedCatalog);
  const registry = await buildBridgeStartupRegistry(f, { discoverImpl: discovery() });
  assert.deepEqual(registry.resolve(SLUG).mlxCapabilities, TOOL_CAPABILITIES);
  assert.equal(registry.resolve(SLUG).toolsEnabled, false);
  assert.equal(registry.resolve(SLUG).clientToolSearchEnabled, false);
  assert.equal(JSON.stringify(f.mixedCatalog), before);
});

test("startup preserves exact fresh Direct and Efficient Fidelity grants", async (t) => {
  const f = await fixture(t, { catalogTools: true, catalogEfficient: true });
  await receipts(f, { efficient: true });
  const registry = await buildBridgeStartupRegistry(f, { discoverImpl: discovery() });
  assert.equal(registry.resolve(SLUG).toolsEnabled, true);
  assert.equal(registry.resolve(SLUG).clientToolSearchEnabled, true);
  assert.deepEqual(registry.resolve(SLUG).mlxCapabilities, TOOL_CAPABILITIES);
});

test("startup retains Direct but removes catalog search grants without Efficient Fidelity", async (t) => {
  const f = await fixture(t, { catalogTools: true, catalogEfficient: true });
  await receipts(f);
  const registry = await buildBridgeStartupRegistry(f, { discoverImpl: discovery() });
  assert.equal(registry.resolve(SLUG).toolsEnabled, true);
  assert.equal(registry.resolve(SLUG).clientToolSearchEnabled, false);
});

test("startup cannot reuse catalog tool authority after runtime fingerprint or client changes", async (t) => {
  const f = await fixture(t, { catalogTools: true, catalogEfficient: true });
  await receipts(f, { efficient: true });
  const changed = { ...TOOL_CAPABILITIES, runtimeFingerprint: "sha256:" + "d".repeat(64) };
  const registry = await buildBridgeStartupRegistry(f, { discoverImpl: discovery(changed) });
  assert.deepEqual(registry.resolve(SLUG).mlxCapabilities, changed);
  assert.equal(registry.resolve(SLUG).toolsEnabled, false);
  assert.equal(registry.resolve(SLUG).clientToolSearchEnabled, false);
  const newerClient = await buildBridgeStartupRegistry({
    ...f, codexClientVersion: "0.161.0",
  }, { discoverImpl: discovery() });
  assert.equal(newerClient.resolve(SLUG).toolsEnabled, false);
  assert.equal(newerClient.resolve(SLUG).clientToolSearchEnabled, false);
});

test("startup pending deactivation suppresses existing grants", async (t) => {
  const f = await fixture(t, { catalogTools: true, catalogEfficient: true });
  await receipts(f, { efficient: true });
  await stageModelCertificationDeactivation(f.certificationPath, [SLUG]);
  const registry = await buildBridgeStartupRegistry(f, { discoverImpl: discovery() });
  assert.equal(registry.resolve(SLUG).toolsEnabled, false);
  assert.equal(registry.resolve(SLUG).clientToolSearchEnabled, false);
});

test("startup legacy MLX remains text-only despite forged tool catalog flags", async (t) => {
  const f = await fixture(t, { legacy: true, catalogTools: true, catalogEfficient: true });
  const registry = await buildBridgeStartupRegistry(f, { discoverImpl: discovery({}) });
  assert.deepEqual(registry.resolve(SLUG).mlxCapabilities, {});
  assert.equal(registry.resolve(SLUG).toolsEnabled, false);
  assert.equal(registry.resolve(SLUG).clientToolSearchEnabled, false);
});

test("startup rejects missing models, foreign identities, context drift and unknown protocols", async (t) => {
  const f = await fixture(t);
  await assert.rejects(buildBridgeStartupRegistry(f, {
    discoverImpl: async () => ({ models: [], providers: [] }),
  }));
  for (const transform of [
    (entry) => ({ ...entry, id: "foreign-model" }),
    (entry) => ({ ...entry, context_window: 8192 }),
    (entry) => ({ ...entry, capabilities: { ...TOOL_CAPABILITIES, mlxProfileDigest: "sha256:" + "f".repeat(64) } }),
    (entry) => ({ ...entry, capabilities: { ...TOOL_CAPABILITIES, mlxToolProtocol: "unreviewed-v2" } }),
    (entry) => ({ ...entry, capabilities: { ...TOOL_CAPABILITIES, arbitraryAuthority: true } }),
  ]) {
    await assert.rejects(buildBridgeStartupRegistry(f, { discoverImpl: discovery(TOOL_CAPABILITIES, transform) }));
  }
});

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

function post(server, body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify({ model: SLUG, input: "Find the public source", ...body }));
  const url = new URL(server.providerBaseUrl + "/responses");
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": bytes.length, ...headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode, body: Buffer.concat(chunks).toString("utf8"),
      }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(bytes);
  });
}

test("a freshly started bridge accepts authorized MLX certification tools before any ordinary grant", async (t) => {
  const providerRequests = [];
  const provider = http.createServer(async (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{
        id: MODEL, object: "model", context_window: 262144, capabilities: TOOL_CAPABILITIES,
      }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    providerRequests.push({ path: request.url, headers: request.headers, body });
    if (!body.tools) {
      response.end(JSON.stringify({
        id: "provider-private-response", object: "chat.completion", model: MODEL, created: 1,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Public source available" } }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      }));
      return;
    }
    const name = body.tools[0].function.name;
    response.end(JSON.stringify({
      id: "provider-private-response", object: "chat.completion", model: MODEL, created: 1,
      choices: [{ index: 0, finish_reason: "tool_calls", message: {
        role: "assistant", content: "", tool_calls: [{
          id: "provider-private-call", type: "function",
          function: { name, arguments: "{\"query\":\"public source\"}" },
        }],
      } }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => close(provider));
  const f = await fixture(t, { port: provider.address().port });
  const registry = await buildBridgeStartupRegistry(f);
  assert.equal(registry.resolve(SLUG).toolsEnabled, false);
  assert.deepEqual(registry.resolve(SLUG).mlxCapabilities, TOOL_CAPABILITIES);
  const instanceId = "test-private-certification-instance-0123456789";
  const bridge = await listenBridgeServer({
    registry, capabilityToken: "test_capability_0123456789_ABCDEFGHIJKLMN", instanceId,
    credentialResolver: f.credentialResolver,
    externalRequestGate: ({ publicModelId, ...options }) =>
      assertModelCertificationRequestAllowed(f.certificationPath, publicModelId, options),
  });
  t.after(() => close(bridge));
  const request = {
    tools: [{ type: "namespace", name: "research", tools: [{
      type: "function", name: "lookup",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    }] }],
    tool_choice: "required",
    parallel_tool_calls: true,
  };
  const normal = await post(bridge, request);
  assert.equal(normal.status, 400);
  assert.equal(providerRequests.length, 0);
  const unauthorized = await post(bridge, request, { [CERTIFICATION_HEADER]: instanceId });
  assert.equal(unauthorized.status, 503);
  assert.equal(providerRequests.length, 0);
  await stageModelCertificationDeactivation(f.certificationPath, [SLUG]);
  await commitModelCertificationDeactivation(f.certificationPath, [SLUG]);
  const pendingNormal = await post(bridge, request);
  assert.equal(pendingNormal.status, 503);
  const wrongToken = await post(bridge, request, { [CERTIFICATION_HEADER]: instanceId + "-wrong" });
  assert.equal(wrongToken.status, 503);
  assert.equal(providerRequests.length, 0);
  const textProbe = await post(bridge, {}, { [CERTIFICATION_HEADER]: instanceId });
  assert.equal(textProbe.status, 200);
  assert.equal(JSON.parse(textProbe.body).output[0].content[0].text, "Public source available");
  const certifiedProbe = await post(bridge, request, {
    [CERTIFICATION_HEADER]: instanceId,
    authorization: "Bearer native-private-canary",
    cookie: "native-private-cookie",
    "chatgpt-account-id": "native-private-account",
  });
  assert.equal(certifiedProbe.status, 200);
  const call = JSON.parse(certifiedProbe.body).output.find((item) => item.type === "function_call");
  assert.equal(call.namespace, "research");
  assert.equal(call.name, "lookup");
  assert.deepEqual(JSON.parse(call.arguments), { query: "public source" });
  assert.equal(providerRequests.length, 2);
  assert.equal(providerRequests[1].path, "/v1/chat/completions");
  assert.equal(providerRequests[1].body.parallel_tool_calls, false);
  assert.equal(providerRequests[1].body.tool_choice, "required");
  assert.equal(providerRequests[1].headers.authorization, undefined);
  assert.equal(providerRequests[1].headers.cookie, undefined);
  assert.equal(providerRequests[1].headers[CERTIFICATION_HEADER], undefined);
  assert.doesNotMatch(JSON.stringify(providerRequests), /native-private|test-private-certification/u);
  assert.doesNotMatch(certifiedProbe.body, /provider-private/u);
});
