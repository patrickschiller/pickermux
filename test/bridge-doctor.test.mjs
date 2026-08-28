import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateBridgeConfig } from "../src/bridge-config.mjs";
import {
  assertNativeCatalogSnapshot,
  readBridgeModelIds,
  runBridgeDoctor,
  runBridgeLiveCheck,
} from "../src/bridge-doctor.mjs";
import { bridgeBaseUrl, createRuntimeRecord, writeRuntime } from "../src/bridge-runtime.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bridge-doctor-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const config = validateBridgeConfig({
    schemaVersion: 2,
    bridge: {},
    providers: [
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
            reasoningEffort: "low",
          },
        ],
      },
    ],
  });
  const paths = {
    codexHome: directory,
    configPath: path.join(directory, "config.toml"),
    statePath: path.join(directory, "state.json"),
    runtimePath: path.join(directory, "runtime.json"),
    catalogPath: path.join(directory, "models.json"),
    launchAgentLabel: "test.bridge",
  };
  const runtime = createRuntimeRecord({
    configPath: path.join(directory, "service-config.json"),
    capability: "doctor_capability_00000000000000000000000000000000",
    instanceId: "doctor-instance",
  });
  await writeRuntime(paths.runtimePath, runtime);
  const catalog = {
    models: [
      { slug: "gpt-5.6-sol", visibility: "list", supported_in_api: true },
      { slug: "lmstudio/qwen/upstream", visibility: "list", supported_in_api: true },
    ],
  };
  await writeFile(paths.catalogPath, `${JSON.stringify(catalog)}\n`, { mode: 0o600 });
  await chmod(paths.catalogPath, 0o600);
  return { config, paths, runtime, catalog };
}

test("mixed doctor verifies service, config, discovery, file and Codex catalog", async (t) => {
  const { config, paths, runtime, catalog } = await fixture(t);
  const baseUrl = bridgeBaseUrl(config, runtime);
  const result = await runBridgeDoctor({
    config,
    paths,
    codexPath: "/fake/codex",
    statusImpl: async () => ({
      installed: true,
      healthy: true,
      status: "installed",
      model: "gpt-5.6-sol",
      provider: "model_bridge",
      providerName: "OpenAI",
      catalog: paths.catalogPath,
      baseUrl,
      modelReasoningEffort: "ultra",
    }),
    serviceStatusImpl: async () => ({ loaded: true, healthy: true, status: "running" }),
    discoveryImpl: async () => ({
      models: [{ id: "lmstudio/qwen/upstream" }],
      providers: [],
    }),
    debugModelsImpl: async () => catalog,
    nativeCatalogImpl: async () => ({
      catalog: { models: [catalog.models[0]] },
      fetchedAt: "2026-08-28T16:06:00Z",
    }),
    runtimeSupportsZstdImpl: () => true,
    bundledCatalogImpl: async () => ({ models: [] }),
    clientVersionImpl: async () => "0.150.0",
    compatibilityImpl: async () => ({
      status: "compatible",
      compatible: true,
      reasons: [],
    }),
    certificationStatusesImpl: async () => [],
    fetchImpl: async (url, options) => {
      assert.equal(url, `${baseUrl}/models`);
      assert.equal(options.method, "GET");
      return new Response(
        JSON.stringify({
          object: "list",
          data: catalog.models.map((model) => ({ id: model.slug, object: "model" })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((entry) => entry.name), [
    "node-runtime",
    "desktop-compatibility",
    "bridge-service",
    "managed-config",
    "external-discovery",
    "mixed-catalog-file",
    "native-account-catalog",
    "running-model-registry",
    "codex-model-catalog",
    "tool-certifications",
  ]);
});

test("native account snapshot comparison catches hidden picker models", () => {
  const nativeCatalog = {
    models: [
      {
        slug: "gpt-5.5",
        visibility: "list",
        supported_in_api: true,
        supported_reasoning_levels: [{ effort: "ultra" }],
      },
    ],
  };
  assert.equal(
    assertNativeCatalogSnapshot({
      nativeCatalog,
      mixedCatalog: {
        models: [
          nativeCatalog.models[0],
          { slug: "lmstudio/qwen/upstream", visibility: "list" },
        ],
      },
      externalSlugs: ["lmstudio/qwen/upstream"],
    }),
    1,
  );
  assert.throws(
    () =>
      assertNativeCatalogSnapshot({
        nativeCatalog,
        mixedCatalog: {
          models: [{ ...nativeCatalog.models[0], visibility: "hide" }],
        },
      }),
    /picker contract differs/u,
  );
});

test("bridge registry reader rejects duplicate model IDs", async () => {
  await assert.rejects(
    readBridgeModelIds({
      baseUrl: "http://127.0.0.1:4210/c/private/v1",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "same" }, { id: "same" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    }),
    /duplicate model IDs/u,
  );
});

test("live bridge check sends the namespaced model with ultra and verifies marker", async () => {
  let request;
  const result = await runBridgeLiveCheck({
    baseUrl: "http://127.0.0.1:4210/c/private/v1",
    model: "lmstudio/qwen/upstream",
    fetchImpl: async (url, options) => {
      request = { url, options, json: JSON.parse(options.body) };
      return new Response(
        JSON.stringify({
          id: "response-test",
          output: [{ content: [{ type: "output_text", text: "P4_DOCTOR_OK" }] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  assert.equal(request.url, "http://127.0.0.1:4210/c/private/v1/responses");
  assert.equal(request.json.model, "lmstudio/qwen/upstream");
  assert.equal(request.json.reasoning.effort, "ultra");
  assert.deepEqual(result, { responseId: "response-test", text: "P4_DOCTOR_OK" });
});
