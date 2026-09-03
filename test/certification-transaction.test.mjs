import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateBridgeConfig } from "../src/bridge-config.mjs";
import { certificationSubjectForModel } from "../src/certification-runner.mjs";
import { runCertificationTransaction } from "../src/cli.mjs";
import {
  EFFICIENT_FIDELITY_CERTIFICATION_GATE,
  REQUIRED_CERTIFICATION_GATES,
  clearModelCertificationDeactivation,
  commitModelCertificationDeactivation,
  getModelCertificationStatus,
  recordPassedCertification,
  recordPassedEfficientFidelityCertification,
  stageModelCertificationDeactivation,
} from "../src/model-certification.mjs";

const CODEX_VERSION = "0.116.0";

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
        models: [],
      },
    ],
  });
}

function discoveredModel({
  upstreamId = "publisher/model-a",
  contextWindow = 32_768,
} = {}) {
  return {
    id: "lmstudio/publisher/model",
    upstreamId,
    providerId: "lmstudio",
    displayName: "Publisher Model – LM Studio",
    type: "llm",
    contextWindow,
    source: "lmstudio-rest",
    capabilities: {},
    reasoningEffort: "low",
    reasoningEfforts: ["low"],
    reasoningEffortMap: { low: "low" },
    reasoningOmitEfforts: [],
  };
}

function allDirectGates() {
  return Object.fromEntries(
    REQUIRED_CERTIFICATION_GATES.map((gate) => [gate, true]),
  );
}

function conservativeCatalog(model) {
  return {
    models: [
      {
        slug: model.id,
        tool_mode: null,
        shell_type: "disabled",
        supports_search_tool: false,
      },
    ],
  };
}

async function fixture(t) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "certification-transaction-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    config: config(),
    paths: {
      certificationPath: path.join(directory, "certifications.json"),
      catalogPath: path.join(directory, "models.json"),
    },
    codexPath: "/private/test/codex",
    runtime: {
      version: 1,
      instanceId: "test-certification-instance",
      capability: "a".repeat(32),
      configPath: path.join(directory, "config.json"),
    },
    credentialResolver: async () => undefined,
  };
}

function subject(inputConfig, model) {
  return certificationSubjectForModel({
    config: inputConfig,
    model,
    codexClientVersion: CODEX_VERSION,
  });
}

test("deactivation refresh failure sends no probe and keeps the pending barrier", async (t) => {
  const setup = await fixture(t);
  const original = discoveredModel();
  await recordPassedCertification(
    setup.paths.certificationPath,
    subject(setup.config, original),
    allDirectGates(),
  );
  const events = [];
  let refreshCalls = 0;

  await assert.rejects(
    runCertificationTransaction(
      {
        ...setup,
        targetModelIds: [original.id],
      },
      {
        stageDeactivationImpl: async (...args) => {
          events.push("stage");
          return stageModelCertificationDeactivation(...args);
        },
        refreshImpl: async () => {
          refreshCalls += 1;
          if (refreshCalls === 1) {
            events.push("refresh-authority");
            return {
              externalModels: [original],
              certificationPendingGateVersion: 1,
            };
          }
          events.push("refresh-failed");
          assert.equal(
            (
              await getModelCertificationStatus(
                setup.paths.certificationPath,
                subject(setup.config, original),
              )
            ).status,
            "pending",
          );
          throw new Error("simulated restart failure");
        },
        clearDeactivationImpl: async (...args) => {
          events.push("clear");
          return clearModelCertificationDeactivation(...args);
        },
        commitDeactivationImpl: async () => {
          events.push("commit");
        },
        runModelCertificationImpl: async () => {
          events.push("probe");
        },
        recordPassedCertificationImpl: async () => {
          events.push("receipt");
        },
      },
    ),
    /certification remains blocked pending recovery; retry the same certify command/u,
  );

  assert.deepEqual(events, ["refresh-authority", "stage", "refresh-failed"]);
  const status = await getModelCertificationStatus(
    setup.paths.certificationPath,
    subject(setup.config, original),
  );
  assert.equal(status.status, "pending");
  assert.ok(status.receipt, "the last valid receipt remains available for retry");
});

test("an old service without the request gate is refreshed before pending is staged", async (t) => {
  const setup = await fixture(t);
  const original = discoveredModel();
  await recordPassedCertification(
    setup.paths.certificationPath,
    subject(setup.config, original),
    allDirectGates(),
  );
  const events = [];

  await assert.rejects(
    runCertificationTransaction(
      {
        ...setup,
        targetModelIds: [original.id],
      },
      {
        refreshImpl: async () => {
          events.push("authority-refresh-without-gate");
          return { externalModels: [original] };
        },
        stageDeactivationImpl: async () => {
          events.push("stage");
        },
        runModelCertificationImpl: async () => {
          events.push("probe");
        },
      },
    ),
    /authority refresh did not confirm the certification request gate/u,
  );

  assert.deepEqual(events, ["authority-refresh-without-gate"]);
  assert.equal(
    (
      await getModelCertificationStatus(
        setup.paths.certificationPath,
        subject(setup.config, original),
      )
    ).status,
    "valid",
  );
});

test("disappeared pending models recover only after conservative absence is confirmed", async (t) => {
  for (const committed of [false, true]) {
    await t.test(committed ? "receipt already removed" : "rollback receipt retained", async (t) => {
      const setup = await fixture(t);
      const disappeared = discoveredModel();
      await recordPassedCertification(
        setup.paths.certificationPath,
        subject(setup.config, disappeared),
        allDirectGates(),
      );
      await stageModelCertificationDeactivation(
        setup.paths.certificationPath,
        [disappeared.id],
      );
      if (committed) {
        await commitModelCertificationDeactivation(
          setup.paths.certificationPath,
          [disappeared.id],
        );
      }
      let probeCalls = 0;

      const result = await runCertificationTransaction(
        {
          ...setup,
          targetModelIds: [],
          recoveryModelIds: [disappeared.id],
        },
        {
          refreshImpl: async () => ({
            externalModels: [],
            certificationPendingGateVersion: 1,
          }),
          readCatalogImpl: async () => ({ models: [] }),
          runModelCertificationImpl: async () => {
            probeCalls += 1;
          },
        },
      );

      assert.deepEqual(result.recoveredPending, [disappeared.id]);
      assert.deepEqual(result.certified, []);
      assert.equal(probeCalls, 0);
      assert.equal(
        (
          await getModelCertificationStatus(
            setup.paths.certificationPath,
            subject(setup.config, disappeared),
          )
        ).status,
        committed ? "missing" : "valid",
      );
    });
  }
});

test("pending recovery refuses to clear a route still present in the catalog", async (t) => {
  const setup = await fixture(t);
  const pendingModel = discoveredModel();
  await stageModelCertificationDeactivation(
    setup.paths.certificationPath,
    [pendingModel.id],
  );
  let clearCalls = 0;

  await assert.rejects(
    runCertificationTransaction(
      {
        ...setup,
        targetModelIds: [],
        recoveryModelIds: [pendingModel.id],
      },
      {
        refreshImpl: async () => ({
          externalModels: [],
          certificationPendingGateVersion: 1,
        }),
        readCatalogImpl: async () => conservativeCatalog(pendingModel),
        clearDeactivationImpl: async () => {
          clearCalls += 1;
        },
      },
    ),
    /is available again; retry certification/u,
  );

  assert.equal(clearCalls, 0);
  assert.equal(
    (
      await getModelCertificationStatus(
        setup.paths.certificationPath,
        subject(setup.config, pendingModel),
      )
    ).status,
    "pending",
  );
});

test("a pending retry probes and receipts only the conservatively rebound route", async (t) => {
  const setup = await fixture(t);
  const original = discoveredModel();
  const rebound = discoveredModel({
    upstreamId: "publisher/model-b",
    contextWindow: 65_536,
  });
  await recordPassedCertification(
    setup.paths.certificationPath,
    subject(setup.config, original),
    allDirectGates(),
  );
  await stageModelCertificationDeactivation(
    setup.paths.certificationPath,
    [original.id],
  );
  const events = [];
  let refreshCalls = 0;
  let pending = false;

  const result = await runCertificationTransaction(
    {
      ...setup,
      targetModelIds: [original.id],
    },
    {
      stageDeactivationImpl: async (...args) => {
        events.push("stage");
        const staged = await stageModelCertificationDeactivation(...args);
        pending = true;
        return staged;
      },
      refreshImpl: async () => {
        refreshCalls += 1;
        events.push(
          refreshCalls === 1
            ? "refresh-authority"
            : refreshCalls === 2
              ? "refresh-text-only"
              : "refresh-certified",
        );
        const certification = await getModelCertificationStatus(
          setup.paths.certificationPath,
          subject(setup.config, rebound),
        );
        assert.equal(
          certification.status,
          refreshCalls === 1
            ? "pending"
            : refreshCalls === 2
              ? "pending"
              : "valid",
        );
        return {
          externalModels: [rebound],
          certificationPendingGateVersion: 1,
        };
      },
      clientVersionImpl: async () => CODEX_VERSION,
      readCatalogImpl: async () => {
        events.push("catalog-text-only-confirmed");
        assert.equal(refreshCalls, 2);
        return conservativeCatalog(rebound);
      },
      discoverImpl: async () => ({ models: [rebound], providers: [] }),
      commitDeactivationImpl: async (...args) => {
        events.push("commit");
        return commitModelCertificationDeactivation(...args);
      },
      clearDeactivationImpl: async (...args) => {
        events.push("clear");
        const remaining = await clearModelCertificationDeactivation(...args);
        pending = false;
        return remaining;
      },
      runModelCertificationImpl: async ({ model }) => {
        events.push("direct-probe");
        assert.equal(pending, true);
        assert.equal(model.upstreamId, rebound.upstreamId);
        assert.equal(model.contextWindow, rebound.contextWindow);
        assert.equal(
          (
            await getModelCertificationStatus(
              setup.paths.certificationPath,
              subject(setup.config, rebound),
            )
          ).status,
          "pending",
        );
        return allDirectGates();
      },
      recordPassedCertificationImpl: async (storePath, receiptSubject, gates) => {
        events.push("direct-receipt");
        assert.equal(pending, true);
        assert.equal(receiptSubject.upstreamModelId, rebound.upstreamId);
        assert.equal(receiptSubject.contextWindow, rebound.contextWindow);
        const receipt = await recordPassedCertification(
          storePath,
          receiptSubject,
          gates,
        );
        assert.equal(
          (await getModelCertificationStatus(storePath, receiptSubject)).status,
          "pending",
        );
        return receipt;
      },
      runEfficientFidelityCertificationImpl: async ({ model }) => {
        events.push("efficient-probe");
        assert.equal(pending, true);
        assert.equal(model.upstreamId, rebound.upstreamId);
        return { [EFFICIENT_FIDELITY_CERTIFICATION_GATE]: true };
      },
      recordPassedEfficientFidelityCertificationImpl: async (
        storePath,
        receiptSubject,
        gates,
      ) => {
        events.push("efficient-receipt");
        assert.equal(pending, true);
        assert.equal(receiptSubject.upstreamModelId, rebound.upstreamId);
        return recordPassedEfficientFidelityCertification(
          storePath,
          receiptSubject,
          gates,
        );
      },
    },
  );

  assert.equal(refreshCalls, 3);
  assert.equal(result.certified[0].efficientFidelity, "enabled");
  assert.equal(
    events.indexOf("catalog-text-only-confirmed") < events.indexOf("direct-probe"),
    true,
  );
  assert.equal(events.indexOf("commit") < events.indexOf("direct-probe"), true);
  assert.equal(events.indexOf("efficient-receipt") < events.indexOf("clear"), true);
  assert.equal(events.indexOf("clear") < events.indexOf("refresh-certified"), true);
  assert.equal(
    (
      await getModelCertificationStatus(
        setup.paths.certificationPath,
        subject(setup.config, rebound),
      )
    ).status,
    "valid",
  );
  assert.equal(
    (
      await getModelCertificationStatus(
        setup.paths.certificationPath,
        subject(setup.config, original),
      )
    ).status,
    "stale",
  );
});

test("an additive probe failure reports a safe Direct fallback", async (t) => {
  const setup = await fixture(t);
  const model = discoveredModel();
  let refreshCalls = 0;
  let efficientReceiptCalls = 0;

  const result = await runCertificationTransaction(
    {
      ...setup,
      targetModelIds: [model.id],
    },
    {
      listPendingImpl: async () => [],
      refreshImpl: async () => {
        refreshCalls += 1;
        return {
          externalModels: [model],
          certificationPendingGateVersion: 1,
        };
      },
      stageDeactivationImpl: async () => {},
      commitDeactivationImpl: async () => {},
      clearDeactivationImpl: async () => {},
      clientVersionImpl: async () => CODEX_VERSION,
      readCatalogImpl: async () => conservativeCatalog(model),
      discoverImpl: async () => ({ models: [model], providers: [] }),
      runModelCertificationImpl: async () => allDirectGates(),
      recordPassedCertificationImpl: async () => ({
        passedAt: "2026-09-03T00:00:00.000Z",
      }),
      runEfficientFidelityCertificationImpl: async () => {
        throw new Error("private-provider-payload-must-not-surface");
      },
      recordPassedEfficientFidelityCertificationImpl: async () => {
        efficientReceiptCalls += 1;
      },
    },
  );

  assert.equal(refreshCalls, 3);
  assert.equal(efficientReceiptCalls, 0);
  assert.deepEqual(result.certified, [{
    model: model.id,
    status: "valid",
    passedAt: "2026-09-03T00:00:00.000Z",
    efficientFidelity: "direct-fallback",
    efficientFidelityFailure: "additive-probe-failed",
  }]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /private-provider-payload-must-not-surface/u,
  );
});

test("route drift after a probe publishes no receipt and recovers text-only", async (t) => {
  const setup = await fixture(t);
  const original = discoveredModel();
  const rebound = discoveredModel({
    upstreamId: "publisher/model-b",
    contextWindow: 65_536,
  });
  const drifted = discoveredModel({
    upstreamId: "publisher/model-c",
    contextWindow: 131_072,
  });
  await recordPassedCertification(
    setup.paths.certificationPath,
    subject(setup.config, original),
    allDirectGates(),
  );
  let discoveredRoute = rebound;
  let refreshCalls = 0;
  let receiptCalls = 0;
  const recoveryEvents = [];

  await assert.rejects(
    runCertificationTransaction(
      {
        ...setup,
        targetModelIds: [original.id],
      },
      {
        refreshImpl: async () => {
          refreshCalls += 1;
          if (refreshCalls === 3) {
            recoveryEvents.push("recovery-refresh");
            assert.equal(
              (
                await getModelCertificationStatus(
                  setup.paths.certificationPath,
                  subject(setup.config, drifted),
                )
              ).status,
              "pending",
            );
          }
          return {
            externalModels: [refreshCalls < 3 ? rebound : drifted],
            certificationPendingGateVersion: 1,
          };
        },
        clientVersionImpl: async () => CODEX_VERSION,
        readCatalogImpl: async () => conservativeCatalog(rebound),
        discoverImpl: async () => ({
          models: [discoveredRoute],
          providers: [],
        }),
        runModelCertificationImpl: async ({ model }) => {
          assert.equal(model.upstreamId, rebound.upstreamId);
          assert.equal(
            (
              await getModelCertificationStatus(
                setup.paths.certificationPath,
                subject(setup.config, rebound),
              )
            ).status,
            "pending",
          );
          discoveredRoute = drifted;
          return allDirectGates();
        },
        recordPassedCertificationImpl: async () => {
          receiptCalls += 1;
        },
        clearDeactivationImpl: async (...args) => {
          recoveryEvents.push("clear");
          return clearModelCertificationDeactivation(...args);
        },
      },
    ),
    /changed during certification; no receipt was published/u,
  );

  assert.equal(refreshCalls, 3, "failure performs a conservative recovery refresh");
  assert.deepEqual(recoveryEvents, ["recovery-refresh", "clear"]);
  assert.equal(receiptCalls, 0);
  assert.equal(
    (
      await getModelCertificationStatus(
        setup.paths.certificationPath,
        subject(setup.config, drifted),
      )
    ).status,
    "missing",
  );
});
