import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  BUILTIN_PROVIDER_QUALIFICATION,
  COMPANION_ACTIONS,
  COMPANION_MAX_REQUEST_BYTES,
  COMPANION_UNINSTALL_CHANGES,
  CompanionControlError,
  collectCompanionStatus,
  companionFailure,
  companionSuccess,
  createCompanionProgress,
  createCompanionReadOnlyProbes,
  parseCompanionRequest,
  readCompanionRequest,
} from "../src/companion-control.mjs";

const OPERATION_ID = "1804ad9d-4eb2-43f4-95e5-a3b5a1f4b9da";
const SECRET = "PRIVATE_PROMPT_ACCOUNT_CAPABILITY_TOKEN";
const consent = { quitCodexTwice: true, interruptTasks: true, invalidateCompaction: true };
const request = (action, additional = {}) => JSON.stringify({ schemaVersion: 1, action, ...additional });

test("usage reset accepts only exact consent and projects a proven reset result", () => {
  const confirmation = { resetAccumulatedUsage: true };
  assert.equal(parseCompanionRequest(request("usage-reset", { confirmation })).action, "usage-reset");
  for (const value of [undefined, {}, { resetAccumulatedUsage: false }, { resetAccumulatedUsage: "true" },
    { ...confirmation, providerId: "lmstudio" }]) {
    assert.throws(() => parseCompanionRequest(request("usage-reset", { confirmation: value })), { code: "CONFIRMATION_REQUIRED" });
  }
  assert.throws(() => parseCompanionRequest(request("usage-reset", { confirmation, previewToken: "a".repeat(64) })), { code: "INVALID_REQUEST" });
  const result = { status: "reset", resetAt: "2026-10-02T18:00:00.000Z", lastRequestPreserved: true };
  assert.deepEqual(companionSuccess("usage-reset", { ...result, prompt: SECRET }),
    { schemaVersion: 1, ok: true, code: "COMPLETE", action: "usage-reset", ...result });
  for (const invalid of [{ ...result, lastRequestPreserved: false }, { ...result, status: "pending" }, { ...result, resetAt: SECRET }]) {
    assert.throws(() => companionSuccess("usage-reset", invalid), { code: "ACTION_FAILED" });
  }
});

test("durable status remains visible while OFF and reset does not require quitting Codex", async () => {
  const usage = { schemaVersion: 2, status: "available", resetAt: null, providers: [] };
  for (const off of [false, true]) {
    const result = await collectCompanionStatus({ probes: probes({
      desktop: async () => true,
      service: async () => ({ status: off ? "not-installed" : "running", healthy: !off }),
      tokenUsage: async () => ({ ...usage, private: SECRET }),
      ...(off ? { managedConfig: async () => ({ status: "deactivated" }), integration: async () => ({ status: "none" }) } : {}),
    }) });
    assert.deepEqual(result.tokenUsage, usage);
    assert.ok(result.capabilities.includes("token-usage-v2"));
    assert.ok(result.capabilities.includes("token-usage-reset-v1"));
    assert.ok(result.actions.includes("usage-reset"));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/u);
  }
  for (const override of [
    { installation: async () => ({ installed: false }) },
    { recovery: async () => ({ phase: "prepared", operationId: OPERATION_ID }) },
    { tokenUsage: async () => ({ ...usage, status: "unavailable" }) },
  ]) {
    const result = await collectCompanionStatus({ probes: probes({ tokenUsage: async () => usage, ...override }) });
    assert.equal(result.actions.includes("usage-reset"), false);
  }
  const legacy = await collectCompanionStatus({ probes: probes({
    service: async () => ({ status: "running", healthy: true, health: { tokenUsage: { schemaVersion: 1, status: "available", providers: [] } } }),
    tokenUsage: async () => usage,
  }) });
  assert.equal(legacy.tokenUsage.schemaVersion, 1);
  assert.equal(legacy.actions.includes("usage-reset"), false);
  const overflow = await collectCompanionStatus({ probes: probes({
    service: async () => ({ status: "running", healthy: true, health: {
      tokenUsage: { ...usage, status: "unavailable" },
    } }),
    tokenUsage: async () => ({ snapshot: usage, canReset: true }),
  }) });
  assert.equal(overflow.tokenUsage.status, "unavailable");
  assert.ok(overflow.actions.includes("usage-reset"));
});

function probes(overrides = {}) {
  return {
    metadata: async () => ({ version: "0.8.3", packagePath: SECRET }),
    desktop: async () => false,
    installation: async () => ({ installed: true, receipt: { account: SECRET } }),
    managedConfig: async () => ({ status: "installed", model: SECRET, baseUrl: SECRET }),
    service: async () => ({ status: "running", runtime: { capability: SECRET }, health: { prompt: SECRET } }),
    compatibility: async () => ({ status: "compatible", expected: SECRET }),
    accountCache: async () => ({ status: "ready", catalog: SECRET }),
    recovery: async () => null,
    integration: async () => ({ status: "pickermux", provider: SECRET }),
    ...overrides,
  };
}

test("companion request grammar accepts only named actions with their exact consent", () => {
  for (const action of COMPANION_ACTIONS) {
    const additional = action === "recover" ? { confirmation: consent } : action === "configuration-apply"
      ? { confirmation: { replaceIntegration: true }, previewToken: "f".repeat(64) } : action === "integration-deactivate" ? { confirmation: { deactivateIntegration: true } } : action === "uninstall"
        ? { confirmation: { removePickerMux: true, restoreNativeCodex: true, deleteProviderCredentials: true, deleteBackups: true }, previewToken: "f".repeat(64) } : action === "usage-reset"
          ? { confirmation: { resetAccumulatedUsage: true } } : {};
    assert.deepEqual(parseCompanionRequest(request(action, additional)), { schemaVersion: 1, action, ...additional });
  }
  assert.deepEqual(parseCompanionRequest(Buffer.from(request("refresh"))), { schemaVersion: 1, action: "refresh" });
});

test("native uninstall requires every exact consent field and a lowercase preview token", () => {
  const confirmation = { removePickerMux: true, restoreNativeCodex: true, deleteProviderCredentials: true, deleteBackups: true };
  for (const key of Object.keys(confirmation)) {
    for (const value of [false, "true", undefined]) assert.throws(() => parseCompanionRequest(request("uninstall", {
      confirmation: { ...confirmation, [key]: value }, previewToken: "a".repeat(64),
    })), { code: "CONFIRMATION_REQUIRED" });
  }
  for (const previewToken of [undefined, "A".repeat(64), "a".repeat(63), "/private/config"]) {
    assert.throws(() => parseCompanionRequest(request("uninstall", { confirmation, previewToken })), { code: "INVALID_REQUEST" });
  }
  assert.throws(() => parseCompanionRequest(request("uninstall", { confirmation: { ...confirmation, force: true }, previewToken: "a".repeat(64) })), { code: "CONFIRMATION_REQUIRED" });
  assert.throws(() => parseCompanionRequest(request("uninstall-preview", { previewToken: "a".repeat(64) })), { code: "INVALID_REQUEST" });
  assert.throws(() => parseCompanionRequest('{"schemaVersion":1,"action":"uninstall","previewToken":"' + "a".repeat(64) + '","confirmation":{"removePickerMux":true,"restoreNativeCodex":true,"deleteProviderCredentials":true,"deleteBackups":true,"deleteBackups":false}}'), { code: "INVALID_REQUEST" });
});

test("native removal status allows valid active/OFF installations despite stale caches and compatibility", async () => {
  for (const off of [false, true]) {
    const result = await collectCompanionStatus({ probes: probes({
      ...(off ? { managedConfig: async () => ({ status: "deactivated" }), integration: async () => ({ status: "none" }) } : {}),
      accountCache: async () => ({ status: "refresh-required" }), compatibility: async () => ({ status: "update-required" }),
    }) });
    assert.ok(result.actions.includes("uninstall-preview"));
    assert.ok(result.actions.includes("uninstall"));
  }
  for (const override of [
    { desktop: async () => true }, { desktop: async () => ({ status: "unknown" }) },
    { installation: async () => ({ installed: false }) }, { managedConfig: async () => ({ status: "modified" }) },
    { managedConfig: async () => ({ status: "suspension-conflict" }) }, { recovery: async () => ({ phase: "prepared", operationId: OPERATION_ID }) },
    { recovery: async () => ({ status: "unknown" }) }, { integration: async () => ({ status: "foreign" }) },
  ]) {
    const result = await collectCompanionStatus({ probes: probes(override) });
    assert.equal(result.actions.includes("uninstall"), false);
    assert.equal(result.actions.includes("uninstall-preview"), false);
  }
});

test("native removal projections require complete proof and redact private inventories", () => {
  const preview = companionSuccess("uninstall-preview", { status: "ready", canApply: true, previewToken: "a".repeat(64), changes: [...COMPANION_UNINSTALL_CHANGES], paths: SECRET, model: SECRET });
  assert.deepEqual(preview, { schemaVersion: 1, ok: true, code: "COMPLETE", action: "uninstall-preview", status: "ready", canApply: true, previewToken: "a".repeat(64), changes: [...COMPANION_UNINSTALL_CHANGES] });
  const data = { status: "removed", removed: true, nativeRestored: true, historicalChatsPreserved: true, restartRequired: true };
  assert.deepEqual(companionSuccess("uninstall", { ...data, private: SECRET }), { schemaVersion: 1, ok: true, code: "COMPLETE", action: "uninstall", restartRequired: true, status: "removed", removed: true, nativeRestored: true, historicalChatsPreserved: true });
  for (const key of ["removed", "nativeRestored", "historicalChatsPreserved", "restartRequired"]) {
    assert.throws(() => companionSuccess("uninstall", { ...data, [key]: false }), { code: "PURGE_INCOMPLETE" });
  }
  assert.throws(() => companionSuccess("uninstall-preview", { ...preview, changes: [SECRET] }), { code: "UNINSTALL_PREFLIGHT_FAILED" });
  for (const code of ["UNINSTALL_CONFLICT", "UNINSTALL_PREFLIGHT_FAILED", "PURGE_INCOMPLETE", "UNINSTALL_FAILED", "PICKERMUX_CREDENTIAL_PURGE_INCOMPLETE"]) {
    const failure = companionFailure(Object.assign(new Error(SECRET), { code }));
    assert.equal(failure.ok, false);
    assert.equal(failure.code, code.startsWith("PICKERMUX_") ? "PURGE_INCOMPLETE" : code);
    assert.equal(JSON.stringify(failure).includes(SECRET), false);
  }
});

test("companion rejects unknown versions, extra authority and duplicate JSON keys", () => {
  const rejected = [
    '{"schemaVersion":1,"schemaVersion":1,"action":"refresh"}',
    '{"schemaVersion":1,"action":"recover","action":"refresh"}',
    '{"schemaVersion":1,"action":"refresh","\\u0061ction":"open"}',
    request("refresh", { force: true }),
    request("refresh", { configPath: "/private/config" }),
    request("refresh", { executable: "/bin/sh" }),
    request("refresh", { provider: "native" }),
    request("refresh", { confirmation: { replaceIntegration: true } }),
    request("refresh", { previewToken: "a".repeat(64) }),
    request("not-supported"),
    request("refresh", { __proto__: { force: true }, unknown: [] }),
    request("refresh") + request("open"),
    "[]", "null", "{\"schemaVersion\":1,\"action\":\"refresh\",}",
  ];
  for (const raw of rejected) assert.throws(() => parseCompanionRequest(raw), { code: "INVALID_REQUEST" });
  assert.throws(() => parseCompanionRequest('{"schemaVersion":2,"action":"refresh"}'), { code: "UNSUPPORTED_SCHEMA" });
});

test("recovery refuses partial or altered confirmations without creating authority", () => {
  for (const confirmation of [undefined, null, {}, { ...consent, interruptTasks: false }, { ...consent, forceQuit: true }, { ...consent, quitCodexTwice: "true" }]) {
    assert.throws(() => parseCompanionRequest(request("recover", { confirmation })), { code: "CONFIRMATION_REQUIRED" });
  }
  assert.throws(() => parseCompanionRequest('{"schemaVersion":1,"action":"recover","confirmation":{"quitCodexTwice":true,"interruptTasks":true,"invalidateCompaction":true,"interruptTasks":false}}'), { code: "INVALID_REQUEST" });
});

test("configuration apply requires exact preview identity and replacement consent", () => {
  assert.throws(() => parseCompanionRequest(request("configuration-apply")), { code: "CONFIRMATION_REQUIRED" });
  for (const previewToken of [undefined, "A".repeat(64), "a".repeat(63), SECRET, "/private/config"]) {
    assert.throws(() => parseCompanionRequest(request("configuration-apply", { confirmation: { replaceIntegration: true }, previewToken })), { code: "INVALID_REQUEST" });
  }
  assert.throws(() => parseCompanionRequest(request("configuration-apply", { confirmation: { ...consent, replaceIntegration: true }, previewToken: "a".repeat(64) })), { code: "CONFIRMATION_REQUIRED" });
});

test("requests are bounded by bytes and require valid UTF-8", () => {
  assert.throws(() => parseCompanionRequest(" ".repeat(COMPANION_MAX_REQUEST_BYTES + 1)), { code: "REQUEST_TOO_LARGE" });
  assert.throws(() => parseCompanionRequest("é".repeat(COMPANION_MAX_REQUEST_BYTES)), { code: "REQUEST_TOO_LARGE" });
  assert.throws(() => parseCompanionRequest(Buffer.from([0xff, 0xfe])), { code: "INVALID_REQUEST" });
  assert.throws(() => parseCompanionRequest({ schemaVersion: 1, action: "refresh" }), { code: "INVALID_REQUEST" });
});

test("stdin reader handles chunk boundaries and rejects oversize or stalled input", async () => {
  const raw = request("refresh");
  assert.deepEqual(await readCompanionRequest(Readable.from([Buffer.from(raw.slice(0, 17)), Buffer.from(raw.slice(17))])), { schemaVersion: 1, action: "refresh" });
  await assert.rejects(readCompanionRequest(Readable.from([Buffer.alloc(4_000), Buffer.alloc(97)])), { code: "REQUEST_TOO_LARGE" });
  let cleanup = false;
  const stalled = {
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise(() => {}),
    return() { cleanup = true; return Promise.resolve({ done: true }); },
  };
  await assert.rejects(readCompanionRequest(stalled, { timeoutMs: 10 }), { code: "REQUEST_TIMEOUT" });
  assert.equal(cleanup, true);
  const stream = new Readable({ read() {} });
  await assert.rejects(readCompanionRequest(stream, { timeoutMs: 10 }), { code: "REQUEST_TIMEOUT" });
  assert.equal(stream.destroyed, true);
});

test("healthy status projects only bounded public values from private probes", async () => {
  const result = await collectCompanionStatus({ probes: probes() });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.version, "0.8.3");
  assert.equal(result.state, "ready");
  assert.deepEqual(result.recovery, { status: "idle", phase: null, operationId: null });
  assert.deepEqual(result.desktop, { status: "stopped" });
  assert.deepEqual(result.issues, []);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.ok(result.actions.includes("refresh"));
  assert.ok(result.actions.includes("open"));
  assert.ok(result.actions.includes("certify"));
  assert.equal(result.actions.includes("recover"), false);
  assert.ok(result.actions.includes("configuration-apply"));
  assert.deepEqual(result.tokenUsage, { schemaVersion: 1, status: "unavailable", providers: [] });
});

function tokenUsageSnapshot() {
  return {
    schemaVersion: 1,
    status: "available",
    providers: [{
      providerId: "lmstudio",
      requests: 3,
      unavailableRequests: 1,
      last: { status: "available", inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      totals: { inputTokens: 200, outputTokens: 40, totalTokens: 240 },
    }, {
      providerId: "remote-provider",
      requests: 1,
      unavailableRequests: 1,
      last: { status: "unavailable" },
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }],
  };
}

test("companion exposes only projected usage from an attested running bridge", async () => {
  const usage = tokenUsageSnapshot();
  const privateUsage = structuredClone(usage);
  privateUsage.capability = SECRET;
  privateUsage.providers[0].model = SECRET;
  privateUsage.providers[0].baseUrl = SECRET;
  privateUsage.providers[0].last.prompt = SECRET;
  privateUsage.providers[0].totals.credential = SECRET;
  const result = await collectCompanionStatus({ probes: probes({
    service: async () => ({ status: "running", healthy: true, health: {
      tokenUsage: privateUsage, capability: SECRET, prompt: SECRET,
    } }),
  }) });
  assert.deepEqual(result.tokenUsage, usage);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(result.state, "ready");
  assert.deepEqual(result.actions, (await collectCompanionStatus({ probes: probes() })).actions);
  assert.deepEqual(result.issues, []);
});

test("usage remains unavailable for old, unverified, stopped or unreachable bridges", async () => {
  for (const service of [
    { status: "running", healthy: true, health: {} },
    { status: "running", health: { tokenUsage: tokenUsageSnapshot() } },
    { status: "running", healthy: false, health: { tokenUsage: tokenUsageSnapshot() } },
    { status: "unhealthy", healthy: true, health: { tokenUsage: tokenUsageSnapshot() } },
    { status: "stopped", healthy: true, health: { tokenUsage: tokenUsageSnapshot() } },
    { status: "unreachable" },
  ]) {
    const result = await collectCompanionStatus({ probes: probes({ service: async () => service }) });
    assert.deepEqual(result.tokenUsage, { schemaVersion: 1, status: "unavailable", providers: [] });
  }
});

test("malformed usage cannot disclose payloads or alter companion permissions", async () => {
  const malformed = [null, [], {}, { ...tokenUsageSnapshot(), schemaVersion: 2 },
    { ...tokenUsageSnapshot(), status: SECRET }];
  const mutations = [
    (value) => { value.providers[0].providerId = SECRET; },
    (value) => { value.providers[0].providerId = "../private-provider"; },
    (value) => { value.providers[0].requests = -1; },
    (value) => { value.providers[0].requests = 0; },
    (value) => { value.providers[0].unavailableRequests = 4; },
    (value) => { value.providers[0].last.inputTokens = 1.5; },
    (value) => { value.providers[0].last.inputTokens = "100"; },
    (value) => { value.providers[0].last.totalTokens = 121; },
    (value) => { value.providers[0].totals.inputTokens = Number.MAX_SAFE_INTEGER + 1; },
    (value) => { value.providers[0].totals.totalTokens = 241; },
    (value) => { value.providers[0].last.inputTokens = 300; value.providers[0].last.totalTokens = 320; },
    (value) => { value.providers.push(structuredClone(value.providers[0])); },
    (value) => { value.status = "unavailable"; },
    (value) => { value.providers = Array.from({ length: 129 }, (_, index) => ({ ...value.providers[0], providerId: `provider-${index}` })); },
  ];
  for (const mutate of mutations) {
    const value = tokenUsageSnapshot();
    mutate(value);
    malformed.push(value);
  }
  const baseline = await collectCompanionStatus({ probes: probes() });
  for (const tokenUsage of malformed) {
    const result = await collectCompanionStatus({ probes: probes({
      service: async () => ({ status: "running", healthy: true, health: { tokenUsage } }),
    }) });
    assert.deepEqual(result.tokenUsage, { schemaVersion: 1, status: "unavailable", providers: [] });
    assert.equal(result.state, baseline.state);
    assert.deepEqual(result.actions, baseline.actions);
    assert.deepEqual(result.issues, baseline.issues);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
});

test("empty session usage and overflow totals retain their explicit meanings", async () => {
  for (const usage of [
    { schemaVersion: 1, status: "available", providers: [] },
    { ...tokenUsageSnapshot(), providers: [{ ...tokenUsageSnapshot().providers[0], totals: null }] },
  ]) {
    const result = await collectCompanionStatus({ probes: probes({
      service: async () => ({ status: "running", healthy: true, health: { tokenUsage: usage } }),
    }) });
    assert.deepEqual(result.tokenUsage, usage);
  }
});

test("status isolates failed probes and never serializes their raw errors", async () => {
  const result = await collectCompanionStatus({ probes: probes({
    metadata: async () => ({ version: SECRET }),
    service: async () => { throw new Error(SECRET); },
    desktop: async () => { throw Object.assign(new Error(SECRET), { code: SECRET }); },
  }) });
  assert.equal(result.state, "degraded");
  assert.equal(result.version, "unknown");
  assert.deepEqual(result.managedConfig, { status: "installed" });
  assert.deepEqual(result.desktop, { status: "unknown" });
  assert.deepEqual(result.service, { status: "unknown" });
  assert.equal(result.issues.length, 3);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  for (const action of ["refresh", "recover", "certify", "update", "configuration-apply"]) assert.equal(result.actions.includes(action), false);
});

test("status bounds stalled probes while retaining complete independent results", async () => {
  const result = await collectCompanionStatus({ probes: probes({ compatibility: () => new Promise(() => {}) }), probeTimeoutMs: 10 });
  assert.deepEqual(result.compatibility, { status: "unknown" });
  assert.equal(result.accountCache.status, "ready");
  assert.ok(result.issues.some((issue) => issue.code === "compatibility-unavailable"));
  assert.equal(result.actions.includes("open"), false);
});

test("recovery status exposes only an operation UUID and fixed workflow phase", async () => {
  const result = await collectCompanionStatus({ probes: probes({ recovery: async () => ({ phase: "suspended", operationId: OPERATION_ID, baselineFetchedAt: SECRET, clientVersion: SECRET }) }) });
  assert.equal(result.state, "recovery-pending");
  assert.deepEqual(result.recovery, { status: "pending", phase: "suspended", operationId: OPERATION_ID });
  assert.ok(result.actions.includes("recover"));
  for (const action of ["refresh", "certify", "update", "configuration-apply"]) assert.equal(result.actions.includes(action), false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("unknown recovery operation IDs fail closed and are never reflected", async () => {
  const result = await collectCompanionStatus({ probes: probes({ recovery: async () => ({ phase: "suspended", operationId: SECRET }) }) });
  assert.deepEqual(result.recovery, { status: "unknown", phase: "suspended", operationId: null });
  assert.equal(result.state, "degraded");
  assert.equal(result.actions.includes("recover"), false);
  assert.equal(result.actions.includes("refresh"), false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("receipt-proven suspension and legacy recovery advertise only confirmed resume", async () => {
  for (const [managedStatus, integrationStatus] of [["suspended", "conflict"], ["not-installed", "none"]]) {
    const result = await collectCompanionStatus({ probes: probes({
      managedConfig: async () => ({ status: managedStatus, installed: false, healthy: true }),
      integration: async () => ({ status: integrationStatus }),
      service: async () => ({ status: "not-installed" }),
      recovery: async () => ({ phase: "suspended", operationId: OPERATION_ID }),
    }) });
    assert.equal(result.state, "recovery-pending");
    assert.ok(result.actions.includes("recover"));
    for (const action of ["configuration-apply", "refresh", "update", "certify"]) assert.equal(result.actions.includes(action), false);
    assert.equal(result.issues.some((issue) => issue.code === "configuration-conflict"), false);
  }
  for (const override of [
    { managedConfig: async () => ({ status: "suspension-conflict", healthy: false }) },
    { managedConfig: async () => ({ status: "suspended", healthy: true }), recovery: async () => null },
    { managedConfig: async () => ({ status: "suspended", healthy: true }), recovery: async () => ({ phase: "prepared", operationId: OPERATION_ID }) },
    { managedConfig: async () => ({ status: "not-installed", healthy: true }), integration: async () => ({ status: "foreign" }) },
  ]) {
    const result = await collectCompanionStatus({ probes: probes({ integration: async () => ({ status: "conflict" }), recovery: async () => ({ phase: "suspended", operationId: OPERATION_ID }), ...override }) });
    assert.equal(result.actions.includes("recover"), false);
    assert.equal(result.actions.includes("configuration-apply"), false);
  }
});

test("account-cache mismatch offers confirmed recovery and ordinary age never does", async () => {
  const result = await collectCompanionStatus({ probes: probes({ accountCache: async () => { throw Object.assign(new Error(SECRET), { code: "CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED" }); } }) });
  assert.equal(result.accountCache.status, "refresh-required");
  assert.equal(result.state, "update-required");
  assert.ok(result.actions.includes("recover"));
  assert.equal(result.actions.includes("refresh"), false);
  const old = await collectCompanionStatus({ probes: probes({ accountCache: async () => ({ status: "ready", ageMs: 1e10, fetchedAt: SECRET }) }) });
  assert.equal(old.state, "ready");
  assert.equal(old.actions.includes("recover"), false);
});

test("a quarantined service or compatibility mismatch selects update recovery", async () => {
  for (const name of ["service", "compatibility"]) {
    const result = await collectCompanionStatus({ probes: probes({ [name]: async () => ({ status: "update-required", reasons: SECRET }) }) });
    assert.equal(result.state, "update-required");
    assert.ok(result.actions.includes("recover"));
    assert.equal(result.actions.includes("refresh"), false);
    assert.equal(result.actions.includes("open"), false);
  }
});

test("modified owned config and competing integrations cannot offer refresh or recovery", async () => {
  for (const override of [{ managedConfig: async () => ({ status: "modified" }) }, { managedConfig: async () => ({ status: "integration-conflict" }) }, { integration: async () => ({ status: "ollama" }) }, { integration: async () => ({ status: "foreign" }) }]) {
    const result = await collectCompanionStatus({ probes: probes(override) });
    assert.equal(result.state, "configuration-conflict");
    assert.equal(result.actions.includes("refresh"), false);
    assert.equal(result.actions.includes("recover"), false);
    assert.equal(result.actions.includes("certify"), false);
    assert.equal(result.actions.includes("update"), false);
    assert.ok(result.actions.includes("configuration-preview"));
  }
});

test("status preserves an absent installation and blocks certification while Codex runs", async () => {
  const missing = await collectCompanionStatus({ probes: probes({
    installation: async () => ({ installed: false }),
    managedConfig: async () => ({ status: "not-installed" }),
    service: async () => ({ status: "not-installed" }),
    integration: async () => ({ status: "none" }),
  }) });
  assert.equal(missing.state, "not-installed");
  assert.equal(missing.actions.includes("refresh"), false);
  assert.equal(missing.actions.includes("update"), false);
  assert.ok(missing.actions.includes("configuration-apply"));
  const running = await collectCompanionStatus({ probes: probes({ desktop: async () => true }) });
  assert.equal(running.desktop.status, "running");
  assert.equal(running.actions.includes("certify"), false);
  assert.equal(running.actions.includes("configuration-apply"), false);
});

test("fresh configuration activation requires a verified cache and consistent config", async () => {
  for (const override of [
    { accountCache: async () => ({ status: "unknown" }) },
    { accountCache: async () => ({ status: "refresh-required" }) },
    { managedConfig: async () => ({ status: "modified" }) },
    { integration: async () => ({ status: "conflict" }) },
  ]) {
    const result = await collectCompanionStatus({ probes: probes(override) });
    assert.equal(result.actions.includes("configuration-apply"), false);
  }
  const absentRuntime = await collectCompanionStatus({ probes: probes({
    installation: async () => ({ installed: false }),
    service: async () => { throw new Error(SECRET); },
    compatibility: async () => { throw new Error(SECRET); },
    managedConfig: async () => ({ status: "not-installed" }),
    integration: async () => ({ status: "ollama" }),
  }) });
  assert.ok(absentRuntime.actions.includes("configuration-apply"));
  assert.equal(absentRuntime.actions.includes("refresh"), false);
});

test("unverified or invalid distribution ownership prevents configuration activation", async () => {
  for (const installation of [
    async () => ({ status: "invalid" }),
    async () => ({ status: "unknown" }),
    async () => { throw new Error(SECRET); },
  ]) {
    const result = await collectCompanionStatus({ probes: probes({ installation }) });
    assert.equal(result.actions.includes("configuration-apply"), false);
    for (const action of ["diagnose", "configuration-preview", "update-check"]) assert.ok(result.actions.includes(action));
  }
});

test("safe errors and action envelopes never reflect exception text or unknown data", () => {
  const failure = companionFailure(Object.assign(new Error(SECRET), { code: "CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED", cause: SECRET }));
  assert.equal(failure.code, "ACCOUNT_CACHE_REFRESH_REQUIRED");
  assert.equal(JSON.stringify(failure).includes(SECRET), false);
  assert.equal(companionFailure(new Error(SECRET)).code, "ACTION_FAILED");
  assert.equal(companionFailure(new CompanionControlError("CODEX_RUNNING")).code, "CODEX_RUNNING");
  const complete = companionSuccess("recover", { started: true, resumed: false, operationId: OPERATION_ID, model: SECRET, message: SECRET, paths: SECRET });
  assert.deepEqual(complete, { schemaVersion: 1, ok: true, code: "COMPLETE", action: "recover", started: true, resumed: false, operationId: OPERATION_ID });
  assert.equal(companionSuccess("update", { targetVersion: "1.2.3", latestVersion: SECRET, operationId: SECRET }).targetVersion, "1.2.3");
});

test("progress reflects only bounded counters, known phases, and safe operation IDs", () => {
  assert.deepEqual(createCompanionProgress({ phase: "suspended", operationId: OPERATION_ID, current: 1, total: 2, elapsedMs: 10, model: SECRET }), { schemaVersion: 1, type: "progress", phase: "suspended", operationId: OPERATION_ID, current: 1, total: 2, elapsedMs: 10 });
  assert.deepEqual(createCompanionProgress({ phase: SECRET, current: -1, total: Infinity, elapsedMs: 1e20, operationId: SECRET }), { schemaVersion: 1, type: "progress", phase: "checking" });
});

test("configuration and update replies project safe preview decisions without raw config", () => {
  const projected = companionSuccess("configuration-preview", {
    status: "ollama", canApply: true, requiresConfirmation: true,
    previewToken: "c".repeat(64), changes: ["replace-integration", SECRET, "create-backup", "create-backup"],
    configPath: SECRET, text: SECRET,
  });
  assert.deepEqual(projected, {
    schemaVersion: 1, ok: true, code: "COMPLETE", action: "configuration-preview",
    status: "ollama", canApply: true, requiresConfirmation: true, previewToken: "c".repeat(64),
    changes: ["replace-integration", "create-backup"],
  });
  assert.equal(JSON.stringify(projected).includes(SECRET), false);
  assert.equal(Object.hasOwn(companionSuccess("configuration-apply", projected), "previewToken"), false);
  assert.equal(companionSuccess("update-check", { status: "available", targetVersion: "0.9.0" }).status, "available");
  assert.equal(Object.hasOwn(companionSuccess("update-check", { status: SECRET }), "status"), false);
  const update = companionSuccess("update-check", {
    status: "available", distribution: "dmg", currentVersion: "0.9.6", targetVersion: "0.10.0",
    assets: { secret: SECRET }, diskImageSha256: SECRET, downloadUrl: SECRET,
  });
  assert.deepEqual(update, {
    schemaVersion: 1, ok: true, code: "COMPLETE", action: "update-check",
    currentVersion: "0.9.6", targetVersion: "0.10.0", status: "available", distribution: "dmg",
  });
  assert.equal(JSON.stringify(update).includes(SECRET), false);
  assert.equal(Object.hasOwn(companionSuccess("update-check", { distribution: SECRET }), "distribution"), false);
  assert.equal(companionFailure({ code: "DOWNLOAD_REQUIRED", message: SECRET }).code, "DOWNLOAD_REQUIRED");
  assert.equal(JSON.stringify(companionFailure({ code: "DOWNLOAD_REQUIRED", message: SECRET })).includes(SECRET), false);
});

test("qualification keeps transport controls and all later trust boundaries explicit", () => {
  assert.equal(BUILTIN_PROVIDER_QUALIFICATION.supportedMode, "explicit-provider");
  assert.equal(BUILTIN_PROVIDER_QUALIFICATION.compactMode, "blocked");
  assert.equal(BUILTIN_PROVIDER_QUALIFICATION.requirements.find((entry) => entry.code === "request-retries-zero").outcome, "mismatch");
  assert.equal(BUILTIN_PROVIDER_QUALIFICATION.requirements.find((entry) => entry.code === "stream-retries-zero").outcome, "mismatch");
  assert.ok(BUILTIN_PROVIDER_QUALIFICATION.requirements.some((entry) => entry.code === "historical-provider-identity"));
});

test("default integration inspector uses exact bounded config files and never follows auth symlinks", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pickermux-companion-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = { configPath: path.join(directory, "config.toml"), statePath: path.join(directory, "state.json") };
  const readOnly = createCompanionReadOnlyProbes({ paths });
  await writeFile(paths.configPath, `openai_base_url = "http://127.0.0.1:11434/api/codex/v1"\nmodel_catalog_json = "/private/.ollama/ollama-launch-models.json"\n`, { mode: 0o600 });
  assert.deepEqual(await readOnly.integration(), { status: "ollama" });
  await writeFile(paths.configPath, "model_catalog_json = \"/private/other.json\"\n", { mode: 0o600 });
  assert.deepEqual(await createCompanionReadOnlyProbes({ paths }).integration(), { status: "foreign" });
  const original = await readFile(paths.configPath);
  assert.deepEqual(await readFile(paths.configPath), original);
  const linkedPaths = { configPath: path.join(directory, "linked.toml"), statePath: paths.statePath };
  await symlink("auth.json", linkedPaths.configPath);
  assert.deepEqual(await createCompanionReadOnlyProbes({ paths: linkedPaths }).integration(), { status: "conflict" });
  const absentDistribution = createCompanionReadOnlyProbes({ distributionPaths: { applicationDirectory: path.join(directory, "absent") } });
  assert.deepEqual(await absentDistribution.installation(), { installed: false });
});


test("toggle capability is server-owned and OFF remains possible without provider, cache or compatibility", async () => {
  const result = await collectCompanionStatus({ probes: probes({
    metadata: async () => ({ version: "0.9.0", capabilities: [SECRET] }),
    compatibility: async () => ({ status: "update-required" }),
    accountCache: async () => ({ status: "refresh-required" }),
    service: async () => ({ status: "stopped" }),
  }) });
  assert.deepEqual(result.capabilities, ["integration-toggle-v1", "native-uninstall-v1", "token-usage-v1"]);
  assert.ok(result.actions.includes("integration-deactivate"));
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  for (const override of [
    { desktop: async () => true },
    { installation: async () => ({ status: "invalid" }) },
    { managedConfig: async () => ({ status: "modified" }) },
    { recovery: async () => ({ phase: "prepared", operationId: OPERATION_ID }) },
  ]) assert.equal((await collectCompanionStatus({ probes: probes(override) })).actions.includes("integration-deactivate"), false);
});

test("intentional OFF is inactive and offers confirmed reactivation only", async () => {
  const result = await collectCompanionStatus({ probes: probes({
    managedConfig: async () => ({ status: "deactivated" }), integration: async () => ({ status: "none" }),
    service: async () => ({ status: "not-installed" }), compatibility: async () => ({ status: "not-installed" }),
  }) });
  assert.equal(result.state, "inactive");
  assert.ok(result.actions.includes("configuration-apply"));
  for (const action of ["recover", "refresh", "certify", "integration-deactivate", "update"]) assert.equal(result.actions.includes(action), false);
});

test("fresh configuration has no compatibility manifest obligation or service startup side effects", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pickermux-fresh-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = { configPath: path.join(directory, "config.toml"), statePath: path.join(directory, "state.json") };
  const inspectors = createCompanionReadOnlyProbes({ paths, codexPath: "/must-never-execute" });
  assert.deepEqual(await inspectors.compatibility(), { status: "not-installed" });
  assert.deepEqual(await inspectors.service(), { status: "not-installed" });
  await assert.rejects(readFile(paths.configPath), { code: "ENOENT" });
});

test("deactivation requires its own exact confirmation and never projects private result data", () => {
  for (const confirmation of [undefined, {}, { deactivateIntegration: false }, { replaceIntegration: true }, { deactivateIntegration: true, force: true }, { deactivateIntegration: "true" }]) {
    assert.throws(() => parseCompanionRequest(request("integration-deactivate", { confirmation })), { code: "CONFIRMATION_REQUIRED" });
  }
  assert.throws(() => parseCompanionRequest(request("integration-deactivate", { confirmation: { deactivateIntegration: true }, previewToken: "a".repeat(64) })), { code: "INVALID_REQUEST" });
  assert.deepEqual(companionSuccess("integration-deactivate", { deactivated: true, status: "deactivated", restartRequired: true, runtime: SECRET }), {
    schemaVersion: 1, ok: true, code: "COMPLETE", action: "integration-deactivate", restartRequired: true, deactivated: true, status: "deactivated",
  });
  for (const code of ["PROVIDER_UNAVAILABLE", "NO_LOADED_MODELS", "DEACTIVATION_FAILED", "DEACTIVATION_ROLLBACK_FAILED"]) {
    const result = companionFailure(Object.assign(new Error(SECRET), { code }));
    assert.equal(result.code, code);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
});


test("public failures preserve known guard codes through bounded successful rollback causes without private text", () => {
  for (const [sourceCode, expected] of [["CODEX_RUNNING", "CODEX_RUNNING"], ["CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED", "ACCOUNT_CACHE_REFRESH_REQUIRED"], ["CONFIGURATION_CONFLICT", "CONFIGURATION_CONFLICT"], ["RECOVERY_PENDING", "RECOVERY_PENDING"]]) {
    const leaf = Object.assign(new Error(SECRET), { code: sourceCode });
    const wrapped = new Error(SECRET, { cause: new Error(SECRET, { cause: Object.assign(new Error(SECRET, { cause: leaf }), { code: "INSTALL_FAILED" }) }) });
    const result = companionFailure(wrapped);
    assert.equal(result.code, expected);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal(companionFailure(new Error(SECRET, { cause: new AggregateError([leaf, new Error(SECRET)]) })).code, "ACTION_FAILED");
    assert.equal(companionFailure(Object.assign(new Error(SECRET, { cause: leaf }), { code: "INSTALL_ROLLBACK_FAILED" })).code, "ACTION_FAILED");
  }
  let deep = new CompanionControlError("CODEX_RUNNING");
  for (let index = 0; index < 8; index += 1) deep = new Error(SECRET, { cause: deep });
  assert.equal(companionFailure(deep).code, "ACTION_FAILED");
  const cycle = new Error(SECRET); cycle.cause = cycle;
  assert.equal(companionFailure(cycle).code, "ACTION_FAILED");
});


test("fresh HOME with no native account cache stays not-installed and cannot bypass initialization", async () => {
  const result = await collectCompanionStatus({ probes: probes({
    installation: async () => ({ installed: false }), managedConfig: async () => ({ status: "not-installed" }),
    integration: async () => ({ status: "none" }), service: async () => ({ status: "not-installed" }),
    compatibility: async () => ({ status: "not-installed" }),
    accountCache: async () => { throw Object.assign(new Error(SECRET), { code: "CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED" }); },
  }) });
  assert.equal(result.state, "not-installed");
  assert.equal(result.accountCache.status, "refresh-required");
  assert.ok(result.issues.some((issue) => issue.code === "account-cache-refresh-required"));
  assert.equal(result.issues.some((issue) => issue.code === "update-required"), false);
  assert.deepEqual(result.actions, ["diagnose", "update-check", "configuration-preview"]);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});
