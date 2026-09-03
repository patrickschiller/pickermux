import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EFFICIENT_FIDELITY_CERTIFICATION_GATE,
  MODEL_CERTIFICATION_CONTRACT_VERSION,
  REQUIRED_CERTIFICATION_GATES,
  assertModelCertificationRequestAllowed,
  assertNoPendingModelCertification,
  clearModelCertificationDeactivation,
  commitModelCertificationDeactivation,
  computeCertificationFingerprint,
  createCertificationSubject,
  evaluateEfficientFidelityCertification,
  evaluateModelCertification,
  getModelCertificationStatus,
  invalidateModelCertification,
  readCertificationStore,
  recordPassedEfficientFidelityCertification,
  recordPassedCertification,
  stageModelCertificationDeactivation,
  validateCertificationStore,
} from "../src/model-certification.mjs";

function subject(overrides = {}) {
  return {
    providerId: "lmstudio",
    providerKind: "lmstudio-responses",
    baseUrl: "http://127.0.0.1:1234/v1",
    publicModelId: "lmstudio/qwen/qwen3.8-27b",
    upstreamModelId: "qwen/qwen3.8-27b",
    contextWindow: 32_768,
    reasoning: {
      defaultEffort: "low",
      supportedEfforts: ["none", "low", "medium"],
      effortMap: { medium: "medium", low: "low", none: null },
    },
    capabilities: {
      text: true,
      stream: true,
      tools: ["function", "namespace"],
    },
    codexClientVersion: "0.116.0-alpha.11",
    ...overrides,
  };
}

function allGates(overrides = {}) {
  return {
    text: true,
    stream: true,
    function: true,
    parameterless: true,
    namespaceJson: true,
    namespaceStream: true,
    toolResult: true,
    longContext: true,
    ...overrides,
  };
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "model-certification-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    storePath: path.join(directory, "private", "certifications.json"),
  };
}

test("fingerprint is canonical and bound to every routed model contract field", () => {
  const baseline = subject();
  const fingerprint = computeCertificationFingerprint(baseline);
  assert.match(fingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(
    computeCertificationFingerprint({
      ...baseline,
      baseUrl: "http://127.0.0.1:1234/v1/",
      reasoning: {
        supportedEfforts: ["none", "low", "medium"],
        effortMap: { none: null, low: "low", medium: "medium" },
        defaultEffort: "low",
      },
      capabilities: {
        tools: ["function", "namespace"],
        stream: true,
        text: true,
      },
    }),
    fingerprint,
  );

  const changes = [
    { providerId: "other-provider" },
    { providerKind: "openai-responses" },
    { baseUrl: "http://127.0.0.1:1235/v1" },
    { publicModelId: "lmstudio/another-model" },
    { upstreamModelId: "another-model" },
    { contextWindow: 65_536 },
    { reasoning: { ...baseline.reasoning, defaultEffort: "medium" } },
    { capabilities: { ...baseline.capabilities, stream: false } },
    { codexClientVersion: "0.117.0" },
  ];
  for (const change of changes) {
    assert.notEqual(
      computeCertificationFingerprint(subject(change)),
      fingerprint,
      `fingerprint changes for ${Object.keys(change)[0]}`,
    );
  }
});

test("subject validation rejects unsafe or incomplete fingerprint inputs", () => {
  assert.throws(
    () => createCertificationSubject(subject({ contextWindow: 0 })),
    /contextWindow must be a positive integer/u,
  );
  assert.throws(
    () => createCertificationSubject(subject({ baseUrl: "file:///tmp/provider" })),
    /HTTP or HTTPS/u,
  );
  assert.throws(
    () =>
      createCertificationSubject(
        subject({ baseUrl: "https://secret@example.test/v1" }),
      ),
    /must not contain credentials/u,
  );
  assert.throws(
    () => createCertificationSubject(subject({ reasoning: null })),
    /reasoning must be a JSON object/u,
  );
  assert.throws(
    () => createCertificationSubject({ ...subject(), prompt: "must-not-enter" }),
    /unsupported property prompt/u,
  );
  const circular = {};
  circular.self = circular;
  assert.throws(
    () => createCertificationSubject(subject({ capabilities: circular })),
    /circular references/u,
  );
});

test("status is missing, valid, or stale for the requested public model", async (t) => {
  const { storePath } = await fixture(t);
  assert.equal(
    (await getModelCertificationStatus(storePath, subject())).status,
    "missing",
  );

  const passedAt = new Date("2026-08-28T20:00:00.000Z");
  const receipt = await recordPassedCertification(
    storePath,
    subject(),
    allGates(),
    { now: passedAt },
  );
  assert.equal(receipt.passedAt, passedAt.toISOString());

  const valid = await getModelCertificationStatus(storePath, subject());
  assert.equal(valid.status, "valid");
  assert.equal(valid.receipt.fingerprint, valid.expectedFingerprint);

  const stale = await getModelCertificationStatus(
    storePath,
    subject({ contextWindow: 65_536 }),
  );
  assert.equal(stale.status, "stale");
  assert.notEqual(stale.receipt.fingerprint, stale.expectedFingerprint);

  const missing = await getModelCertificationStatus(
    storePath,
    subject({ publicModelId: "lmstudio/missing", upstreamModelId: "missing" }),
  );
  assert.equal(missing.status, "missing");
  assert.equal("receipt" in missing, false);
});

test("a pass receipt requires exactly all P3 gates", async (t) => {
  const { storePath } = await fixture(t);
  assert.deepEqual(Object.keys(allGates()), [...REQUIRED_CERTIFICATION_GATES]);

  const missing = allGates();
  delete missing.namespaceStream;
  await assert.rejects(
    recordPassedCertification(storePath, subject(), missing),
    /must contain exactly the direct gates/u,
  );
  await assert.rejects(
    recordPassedCertification(storePath, subject(), allGates({ toolResult: false })),
    /toolResult must be true/u,
  );
  await assert.rejects(
    recordPassedCertification(
      storePath,
      subject(),
      { ...allGates(), unexpected: true },
    ),
    /must contain exactly the direct gates/u,
  );
  await assert.rejects(access(storePath), (error) => error?.code === "ENOENT");
});

test("Efficient Fidelity extends a valid legacy direct receipt additively", async (t) => {
  const { storePath } = await fixture(t);
  const efficientGates = {
    ...allGates(),
    [EFFICIENT_FIDELITY_CERTIFICATION_GATE]: true,
  };
  const additiveGates = {
    [EFFICIENT_FIDELITY_CERTIFICATION_GATE]: true,
  };
  await assert.rejects(
    recordPassedEfficientFidelityCertification(
      storePath,
      subject(),
      additiveGates,
    ),
    /requires a valid direct certification receipt/u,
  );
  await recordPassedCertification(storePath, subject(), allGates());
  assert.equal(
    (await getModelCertificationStatus(storePath, subject())).status,
    "valid",
  );
  assert.equal(
    evaluateEfficientFidelityCertification(
      await readCertificationStore(storePath),
      subject(),
    ).status,
    "missing",
  );
  await assert.rejects(
    recordPassedCertification(storePath, subject(), efficientGates),
    /only after a valid direct certification/u,
  );
  await assert.rejects(
    recordPassedEfficientFidelityCertification(storePath, subject(), {}),
    /must contain exactly toolSearch=true/u,
  );
  await recordPassedEfficientFidelityCertification(
    storePath,
    subject(),
    additiveGates,
  );
  const store = await readCertificationStore(storePath);
  assert.equal(
    evaluateModelCertification(store, subject()).status,
    "valid",
  );
  assert.equal(
    evaluateEfficientFidelityCertification(store, subject()).status,
    "valid",
  );
  assert.deepEqual(store.receipts[subject().publicModelId].gates, efficientGates);

  const vendor = subject({
    providerId: "vendor",
    providerKind: "openai-responses",
    baseUrl: "https://api.vendor.example/v1",
    publicModelId: "vendor/model",
    upstreamModelId: "model",
  });
  await recordPassedCertification(storePath, vendor, allGates());
  await assert.rejects(
    recordPassedEfficientFidelityCertification(
      storePath,
      vendor,
      additiveGates,
    ),
    /only for LM Studio routes/u,
  );
  assert.equal(
    evaluateEfficientFidelityCertification(
      await readCertificationStore(storePath),
      vendor,
    ).status,
    "missing",
  );
});

test("invalidation removes an old pass before a new live run", async (t) => {
  const { storePath } = await fixture(t);
  await recordPassedCertification(storePath, subject(), allGates());
  assert.equal(
    (await getModelCertificationStatus(storePath, subject())).status,
    "valid",
  );

  assert.equal(await invalidateModelCertification(storePath, subject()), true);
  assert.equal(
    (await getModelCertificationStatus(storePath, subject())).status,
    "missing",
  );
  assert.equal(await invalidateModelCertification(storePath, subject()), false);
});

test("pending deactivation atomically suppresses legacy receipts until commit", async (t) => {
  const { storePath } = await fixture(t);
  await recordPassedCertification(storePath, subject(), allGates());
  const legacyStore = await readCertificationStore(storePath);
  assert.equal("pendingDeactivations" in legacyStore, false);
  assert.equal(evaluateModelCertification(legacyStore, subject()).status, "valid");
  await assert.doesNotReject(
    assertModelCertificationRequestAllowed(
      storePath,
      subject().publicModelId,
    ),
  );
  await assert.rejects(
    assertModelCertificationRequestAllowed(
      storePath,
      subject().publicModelId,
      { certificationRequest: true },
    ),
    /blocked outside an authorized conservative publication window/u,
  );

  await stageModelCertificationDeactivation(storePath, [
    subject().publicModelId,
  ]);
  let store = await readCertificationStore(storePath);
  assert.deepEqual(store.pendingDeactivations, [subject().publicModelId]);
  assert.equal(
    Object.hasOwn(store.receipts, subject().publicModelId),
    true,
    "staging keeps the rollback receipt",
  );
  assert.equal(evaluateModelCertification(store, subject()).status, "pending");
  assert.equal(
    evaluateEfficientFidelityCertification(store, subject()).status,
    "pending",
  );
  await assert.rejects(
    assertNoPendingModelCertification(storePath),
    /synchronization is paused/u,
  );
  await assert.rejects(
    assertModelCertificationRequestAllowed(
      storePath,
      subject().publicModelId,
    ),
    /unavailable while certification recovery is pending/u,
  );
  await assert.rejects(
    assertModelCertificationRequestAllowed(
      storePath,
      subject().publicModelId,
      { certificationRequest: true },
    ),
    /blocked outside an authorized conservative publication window/u,
  );
  assert.equal((await stat(storePath)).mode & 0o777, 0o600);
  assert.deepEqual(
    (await readdir(path.dirname(storePath))).filter((name) => name.endsWith(".tmp")),
    [],
  );

  await commitModelCertificationDeactivation(storePath, [
    subject().publicModelId,
  ]);
  store = await readCertificationStore(storePath);
  assert.deepEqual(store.pendingDeactivations, [subject().publicModelId]);
  assert.deepEqual(store.probeAuthorizations, [subject().publicModelId]);
  assert.equal(
    Object.hasOwn(store.receipts, subject().publicModelId),
    false,
    "commit revokes only after conservative publication is confirmed",
  );
  assert.equal(evaluateModelCertification(store, subject()).status, "pending");
  await assert.rejects(
    assertModelCertificationRequestAllowed(
      storePath,
      subject().publicModelId,
    ),
    /unavailable while certification recovery is pending/u,
  );
  await assert.doesNotReject(
    assertModelCertificationRequestAllowed(
      storePath,
      subject().publicModelId,
      { certificationRequest: true },
    ),
  );

  await recordPassedCertification(storePath, subject(), allGates());
  await recordPassedEfficientFidelityCertification(
    storePath,
    subject(),
    { [EFFICIENT_FIDELITY_CERTIFICATION_GATE]: true },
  );
  store = await readCertificationStore(storePath);
  assert.equal(evaluateModelCertification(store, subject()).status, "pending");
  assert.equal(
    evaluateEfficientFidelityCertification(store, subject()).status,
    "pending",
  );

  await clearModelCertificationDeactivation(storePath, [
    subject().publicModelId,
  ]);
  store = await readCertificationStore(storePath);
  assert.equal("pendingDeactivations" in store, false);
  assert.equal("probeAuthorizations" in store, false);
  assert.equal(evaluateModelCertification(store, subject()).status, "valid");
  assert.equal(
    evaluateEfficientFidelityCertification(store, subject()).status,
    "valid",
  );
  await assert.doesNotReject(assertNoPendingModelCertification(storePath));
  await assert.doesNotReject(
    assertModelCertificationRequestAllowed(
      storePath,
      subject().publicModelId,
    ),
  );
  await assert.rejects(
    assertModelCertificationRequestAllowed(
      storePath,
      subject().publicModelId,
      { certificationRequest: true },
    ),
    /blocked outside an authorized conservative publication window/u,
  );
});

test("request authority requires the receipt claimed by the active route", async (t) => {
  const { storePath } = await fixture(t);
  const publicModelId = subject().publicModelId;

  await assert.doesNotReject(
    assertModelCertificationRequestAllowed(storePath, publicModelId),
  );
  await assert.rejects(
    assertModelCertificationRequestAllowed(storePath, publicModelId, {
      requiresDirectReceipt: true,
    }),
    /no active direct certification receipt/u,
  );
  await assert.rejects(
    assertModelCertificationRequestAllowed(storePath, publicModelId, {
      requiresEfficientFidelityReceipt: true,
    }),
    /requires requiresDirectReceipt/u,
  );

  await recordPassedCertification(storePath, subject(), allGates());
  await assert.doesNotReject(
    assertModelCertificationRequestAllowed(storePath, publicModelId, {
      requiresDirectReceipt: true,
    }),
  );
  await assert.rejects(
    assertModelCertificationRequestAllowed(storePath, publicModelId, {
      requiresDirectReceipt: true,
      requiresEfficientFidelityReceipt: true,
    }),
    /no active Efficient Fidelity certification receipt/u,
  );

  await recordPassedEfficientFidelityCertification(
    storePath,
    subject(),
    { [EFFICIENT_FIDELITY_CERTIFICATION_GATE]: true },
  );
  await assert.doesNotReject(
    assertModelCertificationRequestAllowed(storePath, publicModelId, {
      requiresDirectReceipt: true,
      requiresEfficientFidelityReceipt: true,
    }),
  );

  await rm(storePath);
  await assert.doesNotReject(
    assertModelCertificationRequestAllowed(storePath, publicModelId),
  );
  await assert.rejects(
    assertModelCertificationRequestAllowed(storePath, publicModelId, {
      requiresDirectReceipt: true,
    }),
    /no active direct certification receipt/u,
  );
});

test("pending deactivation validation is strict and commit requires staging", async (t) => {
  const { storePath } = await fixture(t);
  assert.deepEqual(
    validateCertificationStore({ contractVersion: 1, receipts: {} }),
    { contractVersion: 1, receipts: {} },
    "the pre-pending schema remains readable without migration",
  );
  assert.throws(
    () =>
      validateCertificationStore({
        contractVersion: 1,
        pendingDeactivations: ["lmstudio/model", "lmstudio/model"],
        receipts: {},
      }),
    /must not contain duplicates/u,
  );
  assert.throws(
    () =>
      validateCertificationStore({
        contractVersion: 1,
        pendingDeactivations: "lmstudio/model",
        receipts: {},
      }),
    /must be an array/u,
  );
  assert.throws(
    () =>
      validateCertificationStore({
        contractVersion: 1,
        probeAuthorizations: ["lmstudio/model"],
        receipts: {},
      }),
    /must be pending deactivations/u,
  );
  await assert.rejects(
    commitModelCertificationDeactivation(storePath, [subject().publicModelId]),
    /was not staged/u,
  );
  await assert.rejects(access(storePath), (error) => error?.code === "ENOENT");
});

test("store publication is atomic, private, and contains no probe material", async (t) => {
  const { directory, storePath } = await fixture(t);
  const promptCanary = "DO_NOT_STORE_PROMPT_CANARY";
  const responseCanary = "DO_NOT_STORE_RESPONSE_CANARY";
  const secretCanary = "DO_NOT_STORE_SECRET_CANARY";
  const privateSubject = subject({
    reasoning: { profile: promptCanary },
    capabilities: { responseProfile: responseCanary, credentialProfile: secretCanary },
  });

  await recordPassedCertification(storePath, privateSubject, allGates());
  const serialized = await readFile(storePath, "utf8");
  const store = JSON.parse(serialized);
  assert.equal(store.contractVersion, MODEL_CERTIFICATION_CONTRACT_VERSION);
  assert.equal(serialized.endsWith("\n"), true);
  assert.equal(serialized.includes(promptCanary), false);
  assert.equal(serialized.includes(responseCanary), false);
  assert.equal(serialized.includes(secretCanary), false);
  assert.deepEqual(Object.keys(store.receipts[privateSubject.publicModelId]), [
    "fingerprint",
    "passedAt",
    "gates",
  ]);
  assert.equal((await stat(storePath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(storePath))).mode & 0o777, 0o700);
  assert.deepEqual(
    (await readdir(path.dirname(storePath))).filter((name) => name.endsWith(".tmp")),
    [],
  );

  await chmod(storePath, 0o644);
  await recordPassedCertification(storePath, subject(), allGates());
  assert.equal((await stat(storePath)).mode & 0o777, 0o600);
  assert.equal((await readdir(directory)).includes("private"), true);
});

test("store validation fails closed for corrupt or unsupported receipts", async (t) => {
  const { storePath } = await fixture(t);
  await recordPassedCertification(storePath, subject(), allGates());

  const store = await readCertificationStore(storePath);
  assert.equal(evaluateModelCertification(store, subject()).status, "valid");
  assert.throws(
    () => validateCertificationStore({ contractVersion: 2, receipts: {} }),
    /contractVersion must be 1/u,
  );
  assert.throws(
    () =>
      validateCertificationStore({
        contractVersion: 1,
        receipts: {
          "lmstudio/model": {
            fingerprint: "sha256:nope",
            passedAt: new Date().toISOString(),
            gates: allGates(),
          },
        },
      }),
    /invalid fingerprint/u,
  );

  await writeFile(storePath, "{not-json\n", { mode: 0o600 });
  await assert.rejects(readCertificationStore(storePath), /Failed to parse/u);
});
