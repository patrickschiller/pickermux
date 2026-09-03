import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateBridgeConfig } from "../src/bridge-config.mjs";
import {
  MODEL_DEFAULT_REASONING_DESCRIPTION,
  buildMixedCodexCatalog,
} from "../src/catalog.mjs";
import {
  DESKTOP_STATE_POLL_INTERVAL_MS,
  LOADED_MODEL_POLL_INTERVAL_MS,
  createCatalogSynchronizer,
  syncBridgeCatalog,
} from "../src/catalog-sync.mjs";
import {
  buildProviderRegistry,
  createReloadableProviderRegistry,
} from "../src/provider-registry.mjs";
import {
  certificationSubjectForModel,
  resolveModelCapabilitySlugs,
} from "../src/certification-runner.mjs";
import {
  REQUIRED_CERTIFICATION_GATES,
  assertNoPendingModelCertification,
  recordPassedCertification,
  stageModelCertificationDeactivation,
} from "../src/model-certification.mjs";

const donor = {
  slug: "gpt-5.4-mini",
  display_name: "GPT-5.4 mini",
  description: "Native donor",
  visibility: "list",
  supported_in_api: true,
  priority: 1,
  context_window: 272_000,
  max_context_window: 272_000,
  effective_context_window_percent: 95,
  default_reasoning_level: "medium",
  supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
  model_messages: {
    instructions_template: "{{ personality }}",
    instructions_variables: { personality_default: "" },
  },
};

function config() {
  return validateBridgeConfig({
    schemaVersion: 2,
    bridge: {},
    providers: [
      {
        id: "lmstudio",
        kind: "lmstudio-responses",
        baseUrl: "http://127.0.0.1:1234/v1",
        allowPrivateNetwork: true,
        discovery: { mode: "loaded", maxModels: 32 },
        models: [
          {
            id: "qwen/local",
            slug: "lmstudio/qwen/local",
            displayName: "Qwen Override",
            reasoningEffort: "xhigh",
            reasoningEfforts: ["none", "xhigh"],
          },
        ],
      },
    ],
  });
}

function discovered(slug, upstreamId, displayName, contextWindow, extra = {}) {
  return {
    id: slug,
    upstreamId,
    providerId: "lmstudio",
    displayName,
    type: "llm",
    contextWindow,
    source: "lmstudio-rest",
    capabilities: {},
    ...extra,
  };
}

test("state-aware polling uses cheap two-second state checks and ten-second discovery", () => {
  assert.equal(DESKTOP_STATE_POLL_INTERVAL_MS, 2_000);
  assert.equal(LOADED_MODEL_POLL_INTERVAL_MS, 10_000);
});

test("synchronizer pauses discovery while Codex runs and polls only while closed", async () => {
  let desktopRunning = true;
  let now = 100_000;
  const syncCalls = [];
  const stateChanges = [];
  const initialCatalog = { models: [] };
  const synchronizer = createCatalogSynchronizer({
    config: config(),
    initialCatalog,
    catalogPath: "/private/test/models.json",
    registryController: { replace() {} },
    desktopRunningImpl: async () => desktopRunning,
    nowImpl: () => now,
    syncImpl: async () => {
      syncCalls.push(now);
      return {
        changed: false,
        catalog: initialCatalog,
        discovery: { models: [] },
        registry: { nativeModels: [], externalModels: [] },
      };
    },
    onDesktopStateChange: (running) => stateChanges.push(running),
  });

  assert.deepEqual(await synchronizer.tick(), {
    skipped: true,
    reason: "codex-desktop-running",
  });
  now += 30_000;
  assert.deepEqual(await synchronizer.tick(), {
    skipped: true,
    reason: "codex-desktop-running",
  });
  assert.deepEqual(syncCalls, []);

  desktopRunning = false;
  now += 500;
  assert.equal((await synchronizer.tick()).changed, false);
  assert.deepEqual(syncCalls, [130_500]);

  now += 9_999;
  assert.deepEqual(await synchronizer.tick(), {
    skipped: true,
    reason: "poll-interval",
  });
  now += 1;
  assert.equal((await synchronizer.tick()).changed, false);
  assert.deepEqual(syncCalls, [130_500, 140_500]);

  desktopRunning = true;
  now += 20_000;
  assert.deepEqual(await synchronizer.tick(), {
    skipped: true,
    reason: "codex-desktop-running",
  });
  desktopRunning = false;
  now += 1;
  assert.equal((await synchronizer.tick()).changed, false);
  assert.deepEqual(syncCalls, [130_500, 140_500, 160_501]);
  assert.deepEqual(stateChanges, [true, false, true, false]);
});

test("overlapping state ticks never start a second discovery", async () => {
  let releaseStateCheck;
  let syncCalls = 0;
  const waitingForState = new Promise((resolve) => {
    releaseStateCheck = resolve;
  });
  const synchronizer = createCatalogSynchronizer({
    config: config(),
    initialCatalog: { models: [] },
    catalogPath: "/private/test/models.json",
    registryController: { replace() {} },
    desktopRunningImpl: async () => {
      await waitingForState;
      return false;
    },
    syncImpl: async ({ currentCatalog }) => {
      syncCalls += 1;
      return {
        changed: false,
        catalog: currentCatalog,
        discovery: { models: [] },
        registry: { nativeModels: [], externalModels: [] },
      };
    },
  });

  const first = synchronizer.tick();
  assert.deepEqual(await synchronizer.tick(), {
    skipped: true,
    reason: "state-check-busy",
  });
  releaseStateCheck();
  assert.equal((await first).changed, false);
  assert.equal(syncCalls, 1);
});

test("invalid desktop state fails closed without endpoint discovery", async () => {
  let syncCalls = 0;
  const errors = [];
  const synchronizer = createCatalogSynchronizer({
    config: config(),
    initialCatalog: { models: [] },
    catalogPath: "/private/test/models.json",
    registryController: { replace() {} },
    desktopRunningImpl: async () => undefined,
    syncImpl: async () => {
      syncCalls += 1;
    },
    onError: (error) => errors.push(error),
  });

  const result = await synchronizer.tick();
  assert.match(result.error.message, /state must be boolean/u);
  assert.equal(syncCalls, 0);
  assert.equal(errors.length, 1);
});

test("desktop state observers cannot suppress a permitted sync", async () => {
  let syncCalls = 0;
  const observerErrors = [];
  const catalog = { models: [] };
  const synchronizer = createCatalogSynchronizer({
    config: config(),
    initialCatalog: catalog,
    catalogPath: "/private/test/models.json",
    registryController: { replace() {} },
    desktopRunningImpl: async () => false,
    syncImpl: async () => {
      syncCalls += 1;
      return {
        changed: false,
        catalog,
        discovery: { models: [] },
        registry: { nativeModels: [], externalModels: [] },
      };
    },
    onDesktopStateChange: () => {
      throw new Error("observer failed");
    },
    onError: (error) => observerErrors.push(error.message),
  });

  assert.equal((await synchronizer.tick()).changed, false);
  assert.equal(syncCalls, 1);
  assert.deepEqual(observerErrors, ["observer failed"]);
});

test("stopping during a desktop state check prevents later discovery", async () => {
  let releaseStateCheck;
  let syncCalls = 0;
  const waitingForState = new Promise((resolve) => {
    releaseStateCheck = resolve;
  });
  const synchronizer = createCatalogSynchronizer({
    config: config(),
    initialCatalog: { models: [] },
    catalogPath: "/private/test/models.json",
    registryController: { replace() {} },
    desktopRunningImpl: async () => {
      await waitingForState;
      return false;
    },
    syncImpl: async () => {
      syncCalls += 1;
    },
  });

  const pendingTick = synchronizer.tick();
  synchronizer.stop();
  releaseStateCheck();
  assert.deepEqual(await pendingTick, { skipped: true, reason: "stopped" });
  assert.equal(syncCalls, 0);
});

test("sync atomically publishes all loaded LLM routes while preserving native models", async () => {
  const inputConfig = config();
  const nativeCatalog = {
    models: [
      { ...donor, slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" },
      { ...donor, slug: "gpt-5.5", display_name: "GPT-5.5" },
      donor,
    ],
  };
  const currentCatalog = buildMixedCodexCatalog({
    bundledCatalog: nativeCatalog,
    nativeCatalog,
    discoveredModels: [
      discovered("lmstudio/qwen/local", "qwen/local", "Qwen Override", 32_768, {
        reasoningEffort: "xhigh",
        reasoningEfforts: ["none", "xhigh"],
      }),
    ],
  });
  const controller = createReloadableProviderRegistry(
    buildProviderRegistry({ mixedCatalog: currentCatalog, config: inputConfig }),
  );
  const nextModels = [
    discovered("lmstudio/qwen/local", "qwen/local", "Qwen Override", 32_768, {
      reasoningEffort: "xhigh",
      reasoningEfforts: ["none", "xhigh"],
      reasoningEffortMap: { none: "none", xhigh: "xhigh" },
    }),
    discovered(
      "lmstudio/microsoft/phi-reasoning",
      "microsoft/phi-reasoning",
      "Phi Reasoning – LM Studio",
      8_192,
      {
        reasoningEffort: "xhigh",
        reasoningEfforts: ["xhigh"],
        reasoningEffortMap: { xhigh: "xhigh" },
        reasoningOmitEfforts: ["xhigh"],
      },
    ),
  ];
  let written;
  const result = await syncBridgeCatalog({
    config: inputConfig,
    currentCatalog,
    catalogPath: "/private/test/models.json",
    registryController: controller,
    discoverImpl: async () => ({ models: nextModels, providers: [] }),
    writeImpl: async (target, catalog) => {
      written = { target, catalog };
    },
  });

  assert.equal(result.changed, true);
  assert.equal(written.target, "/private/test/models.json");
  assert.deepEqual(
    result.catalog.models.slice(0, 3),
    nativeCatalog.models,
  );
  assert.deepEqual(
    controller.listModels().map((model) => model.id),
    [
      "gpt-5.6-sol",
      "gpt-5.5",
      "gpt-5.4-mini",
      "lmstudio/qwen/local",
      "lmstudio/microsoft/phi-reasoning",
    ],
  );
  assert.equal(
    controller.resolve("lmstudio/microsoft/phi-reasoning").upstreamModel,
    "microsoft/phi-reasoning",
  );
  assert.deepEqual(
    controller.resolve("lmstudio/microsoft/phi-reasoning").reasoningEffortMap,
    { xhigh: "xhigh" },
  );
  assert.deepEqual(
    controller.resolve("lmstudio/microsoft/phi-reasoning")
      .reasoningOmitEfforts,
    ["xhigh"],
  );
  assert.equal(
    result.catalog.models
      .find((model) => model.slug === "lmstudio/microsoft/phi-reasoning")
      .supported_reasoning_levels[0].description,
    MODEL_DEFAULT_REASONING_DESCRIPTION,
  );
  const restartedRegistry = buildProviderRegistry({
    mixedCatalog: result.catalog,
    config: inputConfig,
  });
  assert.deepEqual(
    restartedRegistry.resolve("lmstudio/microsoft/phi-reasoning")
      .reasoningOmitEfforts,
    ["xhigh"],
  );
});

test("a catalog write failure keeps the last-known-good registry", async () => {
  const inputConfig = config();
  const nativeCatalog = { models: [donor] };
  const currentCatalog = buildMixedCodexCatalog({
    bundledCatalog: nativeCatalog,
    nativeCatalog,
    discoveredModels: [
      discovered("lmstudio/qwen/local", "qwen/local", "Qwen Override", 32_768),
    ],
  });
  const controller = createReloadableProviderRegistry(
    buildProviderRegistry({ mixedCatalog: currentCatalog, config: inputConfig }),
  );

  await assert.rejects(
    syncBridgeCatalog({
      config: inputConfig,
      currentCatalog,
      catalogPath: "/private/test/models.json",
      registryController: controller,
      discoverImpl: async () => ({
        models: [
          discovered("lmstudio/new", "new", "New – LM Studio", 16_384),
        ],
        providers: [],
      }),
      writeImpl: async () => {
        throw new Error("simulated write failure");
      },
    }),
    /simulated write failure/u,
  );
  assert.equal(controller.resolve("lmstudio/qwen/local").upstreamModel, "qwen/local");
  assert.throws(() => controller.resolve("lmstudio/new"), /No route is configured/u);
});

test("an empty successful loaded set produces a native-only catalog", async () => {
  const inputConfig = config();
  const nativeCatalog = { models: [donor] };
  const currentCatalog = buildMixedCodexCatalog({
    bundledCatalog: nativeCatalog,
    nativeCatalog,
    discoveredModels: [
      discovered("lmstudio/qwen/local", "qwen/local", "Qwen Override", 32_768),
    ],
  });
  const controller = createReloadableProviderRegistry(
    buildProviderRegistry({ mixedCatalog: currentCatalog, config: inputConfig }),
  );
  const result = await syncBridgeCatalog({
    config: inputConfig,
    currentCatalog,
    catalogPath: "/private/test/models.json",
    registryController: controller,
    discoverImpl: async () => ({ models: [], providers: [] }),
    writeImpl: async () => {},
  });
  assert.deepEqual(result.catalog.models.map((model) => model.slug), ["gpt-5.4-mini"]);
  assert.deepEqual(controller.listModels().map((model) => model.id), ["gpt-5.4-mini"]);
});

test("selection reconciliation completes before catalog and registry publication", async () => {
  const inputConfig = config();
  const nativeCatalog = { models: [donor] };
  const currentCatalog = buildMixedCodexCatalog({
    bundledCatalog: nativeCatalog,
    nativeCatalog,
    discoveredModels: [
      discovered("lmstudio/qwen/local", "qwen/local", "Qwen Override", 32_768),
    ],
  });
  const events = [];
  let publishedRegistry;
  const result = await syncBridgeCatalog({
    config: inputConfig,
    currentCatalog,
    catalogPath: "/private/test/models.json",
    registryController: {
      replace(registry) {
        events.push("registry");
        publishedRegistry = registry;
      },
    },
    discoverImpl: async () => ({ models: [], providers: [] }),
    reconcileSelectionImpl: async ({ nextCatalog }) => {
      assert.deepEqual(nextCatalog.models.map((entry) => entry.slug), [
        "gpt-5.4-mini",
      ]);
      events.push("selection");
      return { changed: true, rollback: async () => events.push("rollback") };
    },
    assertPublishAllowed: async () => events.push("guard"),
    writeImpl: async () => events.push("catalog"),
  });
  assert.deepEqual(events, [
    "guard",
    "selection",
    "guard",
    "catalog",
    "guard",
    "registry",
  ]);
  assert.deepEqual(publishedRegistry.listModels().map((entry) => entry.id), [
    "gpt-5.4-mini",
  ]);
  assert.equal(result.selection.changed, true);
});

test("catalog publication failure rolls back the picker and preserves the registry", async () => {
  const inputConfig = config();
  const nativeCatalog = { models: [donor] };
  const currentCatalog = buildMixedCodexCatalog({
    bundledCatalog: nativeCatalog,
    nativeCatalog,
    discoveredModels: [
      discovered("lmstudio/qwen/local", "qwen/local", "Qwen Override", 32_768),
    ],
  });
  const events = [];
  await assert.rejects(
    syncBridgeCatalog({
      config: inputConfig,
      currentCatalog,
      catalogPath: "/private/test/models.json",
      registryController: {
        replace() {
          events.push("registry");
        },
      },
      discoverImpl: async () => ({ models: [], providers: [] }),
      reconcileSelectionImpl: async () => ({
        changed: true,
        rollback: async () => events.push("rollback"),
      }),
      writeImpl: async () => {
        events.push("catalog");
        throw new Error("simulated catalog failure");
      },
    }),
    /simulated catalog failure/u,
  );
  assert.deepEqual(events, ["catalog", "rollback"]);
});

test("compatibility guard blocks publication before picker mutation", async () => {
  const inputConfig = config();
  const nativeCatalog = { models: [donor] };
  const currentCatalog = buildMixedCodexCatalog({
    bundledCatalog: nativeCatalog,
    nativeCatalog,
    discoveredModels: [
      discovered("lmstudio/qwen/local", "qwen/local", "Qwen Override", 32_768),
    ],
  });
  const events = [];
  await assert.rejects(
    syncBridgeCatalog({
      config: inputConfig,
      currentCatalog,
      catalogPath: "/private/test/models.json",
      registryController: {
        replace() {
          events.push("registry");
        },
      },
      discoverImpl: async () => ({ models: [], providers: [] }),
      assertPublishAllowed: async () => {
        events.push("guard");
        throw new Error("compatibility changed");
      },
      reconcileSelectionImpl: async () => {
        events.push("selection");
        return { changed: true };
      },
      writeImpl: async () => events.push("catalog"),
    }),
    /compatibility changed/u,
  );
  assert.deepEqual(events, ["guard"]);
});

test("pending certification blocks a loaded-sync snapshot resolved before staging", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "catalog-sync-certification-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, "certifications.json");
  const inputConfig = config();
  const nativeCatalog = { models: [donor] };
  const liveModel = discovered(
    "lmstudio/qwen/local",
    "qwen/local",
    "Qwen Override",
    32_768,
    {
      reasoningEffort: "xhigh",
      reasoningEfforts: ["none", "xhigh"],
    },
  );
  const currentCatalog = buildMixedCodexCatalog({
    bundledCatalog: nativeCatalog,
    nativeCatalog,
    discoveredModels: [liveModel],
  });
  const controller = createReloadableProviderRegistry(
    buildProviderRegistry({
      mixedCatalog: currentCatalog,
      config: inputConfig,
      discoveredModels: [liveModel],
    }),
  );
  const subject = certificationSubjectForModel({
    config: inputConfig,
    model: liveModel,
    codexClientVersion: "0.116.0",
  });
  await recordPassedCertification(
    storePath,
    subject,
    Object.fromEntries(REQUIRED_CERTIFICATION_GATES.map((gate) => [gate, true])),
  );

  let catalogWrites = 0;
  await assert.rejects(
    syncBridgeCatalog({
      config: inputConfig,
      currentCatalog,
      catalogPath: path.join(directory, "models.json"),
      registryController: controller,
      discoverImpl: async () => ({ models: [liveModel], providers: [] }),
      certificationResolver: async (models) => {
        const resolved = await resolveModelCapabilitySlugs({
          storePath,
          config: inputConfig,
          models,
          codexClientVersion: "0.116.0",
        });
        assert.deepEqual(resolved.certifiedModelSlugs, [liveModel.id]);
        await stageModelCertificationDeactivation(storePath, [liveModel.id]);
        return resolved;
      },
      assertPublishAllowed: () =>
        assertNoPendingModelCertification(storePath),
      writeImpl: async () => {
        catalogWrites += 1;
      },
    }),
    /synchronization is paused/u,
  );
  assert.equal(catalogWrites, 0);
  assert.equal(controller.resolve(liveModel.id).toolsEnabled, false);
  assert.equal(controller.resolve(liveModel.id).clientToolSearchEnabled, false);
});

test("compatibility guard rolls back a picker change before catalog write", async () => {
  const inputConfig = config();
  const nativeCatalog = { models: [donor] };
  const currentCatalog = buildMixedCodexCatalog({
    bundledCatalog: nativeCatalog,
    nativeCatalog,
    discoveredModels: [
      discovered("lmstudio/qwen/local", "qwen/local", "Qwen Override", 32_768),
    ],
  });
  const events = [];
  let guardCalls = 0;
  await assert.rejects(
    syncBridgeCatalog({
      config: inputConfig,
      currentCatalog,
      catalogPath: "/private/test/models.json",
      registryController: {
        replace() {
          events.push("registry");
        },
      },
      discoverImpl: async () => ({ models: [], providers: [] }),
      assertPublishAllowed: async () => {
        guardCalls += 1;
        events.push(`guard-${guardCalls}`);
        if (guardCalls === 2) throw new Error("compatibility changed");
      },
      reconcileSelectionImpl: async () => {
        events.push("selection");
        return { changed: true, rollback: async () => events.push("rollback") };
      },
      writeImpl: async () => events.push("catalog"),
    }),
    /compatibility changed/u,
  );
  assert.deepEqual(events, ["guard-1", "selection", "guard-2", "rollback"]);
});

test("compatibility guard restores a published catalog before preserving the registry", async () => {
  const inputConfig = config();
  const nativeCatalog = { models: [donor] };
  const currentCatalog = buildMixedCodexCatalog({
    bundledCatalog: nativeCatalog,
    nativeCatalog,
    discoveredModels: [
      discovered("lmstudio/qwen/local", "qwen/local", "Qwen Override", 32_768),
    ],
  });
  const events = [];
  let guardCalls = 0;
  await assert.rejects(
    syncBridgeCatalog({
      config: inputConfig,
      currentCatalog,
      catalogPath: "/private/test/models.json",
      registryController: {
        replace() {
          events.push("registry");
        },
      },
      discoverImpl: async () => ({ models: [], providers: [] }),
      assertPublishAllowed: async () => {
        guardCalls += 1;
        events.push(`guard-${guardCalls}`);
        if (guardCalls === 3) throw new Error("compatibility changed");
      },
      reconcileSelectionImpl: async () => {
        events.push("selection");
        return { changed: true, rollback: async () => events.push("selection-rollback") };
      },
      writeImpl: async () => {
        events.push("catalog-next");
        return { snapshot: { ino: 42 } };
      },
      rollbackWriteImpl: async (_target, catalog, expected) => {
        assert.equal(catalog, currentCatalog);
        assert.notEqual(expected.expectedCatalog, currentCatalog);
        assert.deepEqual(expected.expectedSnapshot, { ino: 42 });
        events.push("catalog-rollback");
      },
    }),
    /compatibility changed/u,
  );
  assert.deepEqual(events, [
    "guard-1",
    "selection",
    "guard-2",
    "catalog-next",
    "guard-3",
    "catalog-rollback",
    "selection-rollback",
  ]);
});
