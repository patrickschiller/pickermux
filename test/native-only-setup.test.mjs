import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  BUNDLED_LMSTUDIO_SETUP_CHANGES,
  previewBundledLmStudioSetup,
  providerConfigurationStatus,
} from "../src/native-only-setup.mjs";

const sourceRoot = path.resolve("/private/verified/pickermux/versions/0.24.6");
const paths = {
  configPath: "/private/codex/config.toml",
  statePath: "/private/codex/model-bridge/state.json",
};
const integration = {
  status: "pickermux",
  canApply: true,
  previewToken: "a".repeat(64),
};

async function bundledDefault() {
  return JSON.parse(await readFile(new URL("../lmstudio-picker.config.json", import.meta.url), "utf8"));
}

async function preview(installed, overrides = {}) {
  return previewBundledLmStudioSetup({
    paths,
    sourceRoot,
    readInstalledImpl: async ({ kind }) => {
      assert.equal(kind, "service-config");
      return Buffer.from(typeof installed === "string" ? installed : JSON.stringify(installed));
    },
    loadBundledImpl: async (target) => {
      assert.equal(target, path.join(sourceRoot, "lmstudio-picker.config.json"));
      return bundledDefault();
    },
    integrationPreviewImpl: async (actual) => {
      assert.deepEqual(actual, { configPath: paths.configPath, statePath: paths.statePath });
      return integration;
    },
    ...overrides,
  });
}

test("native-only preview preserves installed bridge settings and takes only bundled LM Studio providers", async () => {
  const installed = await bundledDefault();
  installed.bridge.port = 5127;
  installed.bridge.defaultModel = "gpt-5.4-mini";
  installed.bridge.webSearchModel = "gpt-5.4-mini";
  installed.bridge.reasoningEffort = "high";
  installed.bridge.limits.requestBodyBytes = 4 * 1024 * 1024;
  installed.bridge.limits.streamIdleTimeoutMs = 7 * 60_000;
  installed.providers = [];
  const result = await preview(installed);
  assert.equal(result.status, "native-only");
  assert.equal(result.canApply, true);
  assert.equal(result.requiresConfirmation, true);
  assert.deepEqual(result.changes, BUNDLED_LMSTUDIO_SETUP_CHANGES);
  assert.match(result.previewToken, /^[a-f0-9]{64}$/u);
  assert.deepEqual(result.installedConfigBytes, Buffer.from(JSON.stringify(installed)));
  assert.deepEqual(result.targetConfig.bridge, installed.bridge);
  assert.deepEqual(result.targetConfig.providers.map(({ id, kind }) => ({ id, kind })), [
    { id: "lmstudio", kind: "lmstudio-responses" },
  ]);
});

test("preview token fails closed across receipt root, installed bytes, integration state and bundled target drift", async () => {
  const installed = await bundledDefault();
  installed.providers = [];
  const compact = JSON.stringify(installed);
  const baseline = await preview(compact);
  const reformatted = await preview(`${JSON.stringify(installed, null, 2)}\n`);
  assert.notEqual(reformatted.previewToken, baseline.previewToken);
  const changedIntegration = await preview(compact, {
    integrationPreviewImpl: async () => ({ ...integration, previewToken: "b".repeat(64) }),
  });
  assert.notEqual(changedIntegration.previewToken, baseline.previewToken);
  const changedReceipt = await preview(compact, {
    sourceRoot: path.resolve("/private/verified/pickermux/versions/0.24.7"),
    loadBundledImpl: async () => bundledDefault(),
  });
  assert.notEqual(changedReceipt.previewToken, baseline.previewToken);
  const changedBundled = await preview(compact, {
    loadBundledImpl: async () => {
      const config = await bundledDefault();
      config.providers[0].models[0].displayName = "Changed bundled default";
      return config;
    },
  });
  assert.notEqual(changedBundled.previewToken, baseline.previewToken);
});

test("existing external configuration and unsupported bundled defaults can never authorize replacement", async () => {
  const external = await bundledDefault();
  const blocked = await preview(external);
  assert.equal(blocked.status, "external");
  assert.equal(blocked.canApply, false);
  assert.equal(blocked.requiresConfirmation, false);
  assert.deepEqual(blocked.changes, []);
  assert.deepEqual(blocked.targetConfig, external);

  const nativeOnly = { ...external, providers: [] };
  for (const providers of [[], [
    { ...external.providers[0], id: "other" },
  ], [external.providers[0], external.providers[0]], [
    { ...external.providers[0], baseUrl: "https://private.invalid/v1", allowPrivateNetwork: false },
  ], [
    { ...external.providers[0], credentialEnv: "PRIVATE_TOKEN" },
  ]]) {
    await assert.rejects(preview(nativeOnly, {
      loadBundledImpl: async () => ({ ...external, providers }),
    }), /no supported bundled LM Studio default/u);
  }
});

test("unknown installed or bundled configuration fields fail closed", async () => {
  const nativeOnly = await bundledDefault();
  nativeOnly.providers = [];
  await assert.rejects(
    preview({ ...nativeOnly, privateEndpoint: "PRIVATE_ENDPOINT" }),
    { code: "COMPANION_CONFIG_INVALID" },
  );
  await assert.rejects(preview(nativeOnly, {
    loadBundledImpl: async () => ({
      ...(await bundledDefault()),
      providers: [{
        ...(await bundledDefault()).providers[0],
        privateEndpoint: "PRIVATE_ENDPOINT",
      }],
    }),
  }), /unsupported property privateEndpoint/u);
});

test("provider status projection exposes only native-only, external or unknown", async () => {
  const external = await bundledDefault();
  assert.deepEqual(providerConfigurationStatus({ providers: [] }), { status: "native-only" });
  assert.deepEqual(providerConfigurationStatus(external), { status: "external" });
  assert.deepEqual(providerConfigurationStatus({ endpoint: "PRIVATE_ENDPOINT" }), { status: "unknown" });
});
