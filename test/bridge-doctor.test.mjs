import assert from "node:assert/strict";
import { chmod, mkdtemp, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexAccountCacheRefreshRequiredError } from "../src/account-cache.mjs";
import { validateBridgeConfig } from "../src/bridge-config.mjs";
import {
  assertNativeCatalogSnapshot,
  readBridgeModelIds,
  runBridgeDoctor,
  runBridgeLiveCheck,
} from "../src/bridge-doctor.mjs";
import { bridgeBaseUrl, createRuntimeRecord, writeRuntime } from "../src/bridge-runtime.mjs";
import { splitMixedCatalog } from "../src/provider-registry.mjs";

const NATIVE_MODEL = {
  slug: "gpt-5.6-sol",
  comp_hash: "native-sol-component",
  visibility: "list",
  supported_in_api: true,
};
const EXTERNAL_MODEL = {
  slug: "lmstudio/qwen/upstream",
  visibility: "list",
  supported_in_api: true,
};
async function fixture(t, {
  discovery,
  catalogModels = [NATIVE_MODEL, EXTERNAL_MODEL],
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bridge-doctor-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const configInput = {
    schemaVersion: 2,
    bridge: {},
    providers: [
      {
        id: "lmstudio",
        kind: "lmstudio-responses",
        baseUrl: "http://127.0.0.1:1234/v1",
        allowPrivateNetwork: true,
        ...(discovery ? { discovery } : {}),
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
  };
  const config = validateBridgeConfig(configInput);
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
    models: catalogModels,
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
    serviceStatusImpl: async () => ({
      loaded: true,
      healthy: true,
      status: "running",
      health: {
        textOnlyContext: {
          schemaVersion: 1,
          requests: 2,
          last: {
            outcome: "compacted",
            stopReason: "conversation",
            sourceBytes: 12_000,
            forwardedBytes: 4_000,
            sourceRequestBytes: 12_500,
            forwardedRequestBytes: 4_250,
            omittedParts: 8,
            omittedBytes: 7_500,
            retainedBootstrapParts: 2,
            retainedBootstrapBytes: 1_000,
          },
        },
      },
    }),
    discoveryImpl: async () => ({
      models: [{ id: "lmstudio/qwen/upstream" }],
      providers: [],
    }),
    debugModelsImpl: async () => catalog,
    accountCacheImpl: async ({ codexClientVersion }) => ({
      ready: true,
      status: "ready",
      codexClientVersion,
      cacheClientVersion: codexClientVersion,
      catalog: { models: [catalog.models[0]] },
      fetchedAt: "2026-08-28T16:06:00Z",
      ageMs: 559 * 60_000,
      warning: null,
      source: "codex-account-cache",
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
    pendingModelIdsImpl: async () => ["lmstudio/disappeared"],
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
    "codex-account-cache",
    "bridge-service",
    "text-only-context",
    "managed-config",
    "external-discovery",
    "mixed-catalog-file",
    "native-account-catalog",
    "running-model-registry",
    "codex-model-catalog",
    "tool-certifications",
  ]);
  assert.deepEqual(
    result.checks.find((entry) => entry.name === "text-only-context"),
    {
      name: "text-only-context",
      status: "pass",
      detail:
        "2 request(s); input 12000 -> 4000 bytes; request 12500 -> 4250 bytes; omitted 8 part(s)/7500 bytes; retained bootstrap 2 part(s)/1000 bytes; stop=conversation",
    },
  );
  assert.match(
    result.checks.find((entry) => entry.name === "tool-certifications").detail,
    /1 certification recovery operation\(s\) pending/u,
  );
});

test("doctor inspects the Codex account cache without an installed bridge", async (t) => {
  const { config, paths } = await fixture(t);
  await Promise.all([
    unlink(paths.runtimePath),
    unlink(paths.catalogPath),
  ]);
  const calls = [];
  const result = await runBridgeDoctor({
    config,
    paths,
    codexPath: "/fake/codex",
    statusImpl: async () => ({
      installed: false,
      healthy: true,
      status: "not-installed",
    }),
    discoveryImpl: async () => ({ models: [], providers: [] }),
    accountCacheImpl: async (options) => {
      calls.push(options);
      return {
        ready: true,
        status: "ready",
        codexClientVersion: options.codexClientVersion,
        cacheClientVersion: "0.151.0",
        fetchedAt: "2026-08-30T10:00:00.000Z",
        ageMs: 559 * 60_000,
        warning: null,
        source: "codex-account-cache",
        catalog: { models: [NATIVE_MODEL] },
      };
    },
    runtimeSupportsZstdImpl: () => true,
    bundledCatalogImpl: async () => ({ models: [] }),
    clientVersionImpl: async () => "0.151.0",
    compatibilityImpl: async () => ({
      status: "update-required",
      compatible: false,
      reasons: ["manifest-missing"],
    }),
    certificationStatusesImpl: async () => [],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].codexHome, paths.codexHome);
  assert.equal(calls[0].codexPath, "/fake/codex");
  assert.equal(calls[0].codexClientVersion, "0.151.0");
  assert.deepEqual(
    result.checks.find((entry) => entry.name === "codex-account-cache"),
    {
      name: "codex-account-cache",
      status: "pass",
      detail: "0.151.0, 1 account model(s), fetched 2026-08-30T10:00:00.000Z, age 559 minute(s)",
    },
  );
  assert.equal(
    result.checks.some((entry) => entry.name === "native-account-catalog"),
    false,
  );
});

test("doctor reports a refresh-required account cache without managed artifacts", async (t) => {
  const { config, paths } = await fixture(t);
  await Promise.all([
    unlink(paths.runtimePath),
    unlink(paths.catalogPath),
  ]);
  const cause = new Error(
    "Codex account model cache version 0.150.1 does not match client 0.151.0",
  );
  const result = await runBridgeDoctor({
    config,
    paths,
    codexPath: "/fake/codex",
    statusImpl: async () => ({
      installed: false,
      healthy: true,
      status: "not-installed",
    }),
    discoveryImpl: async () => ({ models: [], providers: [] }),
    accountCacheImpl: async () => {
      throw new CodexAccountCacheRefreshRequiredError({
        codexClientVersion: "0.151.0",
        cause,
      });
    },
    runtimeSupportsZstdImpl: () => true,
    bundledCatalogImpl: async () => ({ models: [] }),
    clientVersionImpl: async () => "0.151.0",
    compatibilityImpl: async () => ({
      status: "update-required",
      compatible: false,
      reasons: ["manifest-missing"],
    }),
    certificationStatusesImpl: async () => [],
  });

  const cacheCheck = result.checks.find(
    (entry) => entry.name === "codex-account-cache",
  );
  assert.equal(cacheCheck.status, "fail");
  assert.equal(
    cacheCheck.detail,
    "Codex account model cache refresh is required for client 0.151.0",
  );
  assert.doesNotMatch(cacheCheck.detail, /0\.150\.1/u);
  assert.equal(
    result.checks.some((entry) => entry.name === "native-account-catalog"),
    false,
  );
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
