import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateBridgeConfig } from "../src/bridge-config.mjs";
import {
  certificationSubjectForModel,
  resolveModelCapabilitySlugs,
} from "../src/certification-runner.mjs";
import { certify, certifyForInstallation } from "../src/cli.mjs";
import {
  recordPassedCertification,
  recordPassedEfficientFidelityCertification,
  REQUIRED_CERTIFICATION_GATES,
  stageModelCertificationDeactivation,
} from "../src/model-certification.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "installation-certification-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = validateBridgeConfig({
    schemaVersion: 2,
    bridge: {},
    providers: [{
      id: "lmstudio",
      kind: "lmstudio-responses",
      baseUrl: "http://127.0.0.1:1234/v1",
      allowPrivateNetwork: true,
      discovery: { mode: "loaded", maxModels: 32 },
      models: [],
    }],
  });
  const models = ["direct", "efficient", "missing", "stale", "pending"].map((name) => ({
    id: `lmstudio/publisher/${name}`,
    upstreamId: `publisher/${name}`,
    providerId: "lmstudio",
    type: "llm",
    contextWindow: 32_768,
    capabilities: {},
  }));
  const paths = { certificationPath: path.join(directory, "certifications.json") };
  const subject = (model) => certificationSubjectForModel({
    config, model, codexClientVersion: "0.158.0",
  });
  const gates = Object.fromEntries(REQUIRED_CERTIFICATION_GATES.map((gate) => [gate, true]));
  for (const model of models.filter((entry) => !entry.id.endsWith("missing"))) {
    await recordPassedCertification(paths.certificationPath, subject(model), gates);
  }
  await recordPassedEfficientFidelityCertification(
    paths.certificationPath, subject(models[1]), { toolSearch: true },
  );
  models[3].contextWindow = 65_536;
  await stageModelCertificationDeactivation(paths.certificationPath, [models[4].id]);
  const transactions = [];
  return {
    input: { config, paths, codexPath: "/test/codex", all: true, onlyUncertified: true },
    models,
    transactions,
    dependencies: {
      credentialResolver: async () => undefined,
      configStatusImpl: async () => ({ installed: true, healthy: true }),
      serviceStatusImpl: async () => ({ healthy: true }),
      runtimeImpl: async () => ({ instanceId: "test-instance" }),
      discoverImpl: async () => ({ models }),
      clientVersionImpl: async () => "0.158.0",
      transactionImpl: async (input) => {
        transactions.push(input);
        return {
          certified: input.targetModelIds.map((model) => ({ model, status: "valid" })),
          recoveredPending: input.recoveryModelIds,
          restartRequired: true,
        };
      },
    },
  };
}

test("installation preserves valid Direct and Efficient receipts and selects missing, stale and pending models", async (t) => {
  const { input, dependencies, models, transactions } = await fixture(t);
  const before = await readFile(input.paths.certificationPath);
  const onProgress = () => {};
  const result = await certify({
    ...input, sourceRoot: "/managed/version", onProgress,
  }, dependencies);
  assert.equal(result.reused, 2);
  assert.deepEqual(transactions[0].targetModelIds, models.slice(2).map((entry) => entry.id));
  assert.equal(transactions[0].exactModelSet, false);
  assert.equal(transactions[0].sourceRoot, "/managed/version");
  assert.equal(transactions[0].onProgress, onProgress);
  assert.deepEqual(await readFile(input.paths.certificationPath), before);
});

test("valid receipts skip inference while explicit certify still rechecks all models", async (t) => {
  const { input, dependencies, models, transactions } = await fixture(t);
  dependencies.discoverImpl = async () => ({ models: models.slice(0, 2) });
  dependencies.listPendingImpl = async () => [];
  const result = await certify(input, dependencies);
  assert.equal(result.reused, 2);
  assert.deepEqual(result.certified, []);
  assert.equal(transactions.length, 0);
  await certify({ ...input, onlyUncertified: false }, dependencies);
  assert.deepEqual(transactions[0].targetModelIds, models.slice(0, 2).map((entry) => entry.id));
  assert.equal(transactions[0].exactModelSet, true);
});

test("a loaded-model replacement never reuses the previous model receipt", async (t) => {
  for (const changedBinding of [false, true]) {
    await t.test(changedBinding ? "same public slug, changed upstream binding" : "new public slug", async (subtest) => {
      const { input, dependencies, models, transactions } = await fixture(subtest);
      const previous = models[0];
      const replacement = {
        ...previous,
        id: changedBinding ? previous.id : "lmstudio/publisher/replacement",
        upstreamId: "publisher/replacement",
      };
      const capabilities = await resolveModelCapabilitySlugs({
        storePath: input.paths.certificationPath,
        config: input.config,
        models: [replacement],
        codexClientVersion: "0.158.0",
      });
      assert.deepEqual(capabilities, {
        certifiedModelSlugs: [],
        efficientFidelityModelSlugs: [],
      });

      dependencies.discoverImpl = async () => ({ models: [replacement] });
      dependencies.listPendingImpl = async () => [];
      const result = await certify(input, dependencies);
      assert.equal(result.reused, 0);
      assert.deepEqual(transactions[0].targetModelIds, [replacement.id]);
      assert.equal(transactions[0].exactModelSet, false);
    });
  }
});

test("absent pending models enter the existing recovery transaction during installation", async (t) => {
  const { input, dependencies, models, transactions } = await fixture(t);
  dependencies.discoverImpl = async () => ({ models: models.slice(0, 2) });
  await certify(input, dependencies);
  assert.deepEqual(transactions[0].targetModelIds, []);
  assert.deepEqual(transactions[0].recoveryModelIds, [models[4].id]);
});

test("no models causes no live request and an unhealthy bridge cannot certify", async (t) => {
  const { input, dependencies, transactions } = await fixture(t);
  dependencies.discoverImpl = async () => ({ models: [] });
  dependencies.listPendingImpl = async () => [];
  const result = await certify(input, dependencies);
  assert.equal(result.reused, 0);
  assert.deepEqual(result.certified, []);
  assert.equal(transactions.length, 0);
  dependencies.serviceStatusImpl = async () => ({ healthy: false });
  await assert.rejects(certify(input, dependencies), /healthy installed bridge/u);
  assert.equal(transactions.length, 0);
});

test("installation reports completed, reused and empty results without inventing tool grants", async (t) => {
  for (const [result, phase] of [
    [{ certified: [{ status: "valid", efficientFidelity: "direct-fallback" }], recoveredPending: [], reused: 0 }, "complete"],
    [{ certified: [], recoveredPending: [], reused: 2 }, "reused"],
    [{ certified: [], recoveredPending: [], reused: 0 }, "no-models"],
  ]) {
    await t.test(phase, async () => {
      const events = [];
      const output = await certifyForInstallation({
        config: {}, paths: {}, sourceRoot: "/managed/version",
        onProgress: (event) => events.push(event),
      }, {
        desktopRunningImpl: async () => false,
        certifyImpl: async (input) => {
          assert.deepEqual(events, [{ phase: "start" }]);
          assert.equal(input.all, true);
          assert.equal(input.onlyUncertified, true);
          assert.equal(input.sourceRoot, "/managed/version");
          return result;
        },
      });
      assert.equal(output.status, "complete");
      assert.equal(events.at(-1).phase, phase);
    });
  }
});

test("failed certification retains installation, redacts diagnostics, and does not claim success", async () => {
  const events = [];
  const result = await certifyForInstallation({
    onProgress: (event) => events.push(event),
  }, {
    desktopRunningImpl: async () => false,
    certifyImpl: async () => { throw new Error("private-provider-token-and-prompt"); },
  });
  assert.deepEqual(result, { status: "incomplete", retryCommand: "pickermux certify --all" });
  assert.deepEqual(events, [{ phase: "start" }, { phase: "failed" }]);
  assert.doesNotMatch(JSON.stringify({ result, events }), /private-provider/u);
});

test("reopened Codex blocks installer inference without undoing installation", async () => {
  let called = false;
  const result = await certifyForInstallation({}, {
    desktopRunningImpl: async () => true,
    certifyImpl: async () => { called = true; },
  });
  assert.equal(result.status, "incomplete");
  assert.equal(called, false);
});

test("MLX-only installation skips live tool probes and explicit certification fails safely", async (t) => {
  const { input, dependencies, transactions } = await fixture(t);
  input.config = {
    ...input.config,
    providers: [{ id: "kolibri", kind: "mlx-chat-completions", models: [{ slug: "kolibri/kolibri-1-mlx-4bit" }] }],
  };
  dependencies.discoverImpl = async () => ({ models: [{
    id: "kolibri/kolibri-1-mlx-4bit", providerId: "kolibri", type: "llm", contextWindow: 8192,
  }] });
  dependencies.listPendingImpl = async () => [];
  const result = await certify(input, dependencies);
  assert.equal(result.textOnly, 1);
  assert.deepEqual(result.certified, []);
  assert.equal(transactions.length, 0);
  await assert.rejects(certify({ ...input, all: false, model: "kolibri/kolibri-1-mlx-4bit" }, dependencies), /no reviewed tool protocol/u);
  await assert.rejects(certify({ ...input, onlyUncertified: false }, dependencies), /No external model with a reviewed tool protocol/u);
  assert.equal(transactions.length, 0);
});

test("mixed certification selects only tool-capable routes", async (t) => {
  const { input, dependencies, models, transactions } = await fixture(t);
  input.config = { ...input.config, providers: [...input.config.providers, { id: "kolibri", kind: "mlx-chat-completions", models: [] }] };
  dependencies.discoverImpl = async () => ({ models: [...models, {
    id: "kolibri/kolibri-1-mlx-4bit", providerId: "kolibri", type: "llm", contextWindow: 8192,
  }] });
  await certify(input, dependencies);
  assert.deepEqual(transactions[0].targetModelIds, models.slice(2).map((entry) => entry.id));
});

test("reviewed MLX protocols are eligible for the complete installation certification transaction", async (t) => {
  const { input, dependencies, transactions } = await fixture(t);
  input.config = { ...input.config, providers: [{ id: "kolibri", kind: "mlx-chat-completions", models: [] }] };
  const model = { id: "kolibri/kolibri-1-mlx-4bit", providerId: "kolibri", type: "llm", contextWindow: 8192,
    capabilities: { mlxToolProtocol: "pickermux-mlx-tools-v1",
      modelFingerprint: `sha256:${"a".repeat(64)}`, runtimeFingerprint: `sha256:${"b".repeat(64)}`, mlxMaxOutputTokens: 1024 },
  };
  dependencies.discoverImpl = async () => ({ models: [model] });
  dependencies.listPendingImpl = async () => [];
  await certify({ ...input, onlyUncertified: false }, dependencies);
  assert.deepEqual(transactions[0].targetModelIds, [model.id]);
});
