import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { executeCompanionAction } from "../src/companion-actions.mjs";
import { runCompanionCli } from "../src/companion-cli.mjs";
import { COMPANION_ACTIONS } from "../src/companion-control.mjs";

const request = (action, additional = {}) => ({ schemaVersion: 1, action, ...additional });
const consent = { quitCodexTwice: true, interruptTasks: true, invalidateCompaction: true };
const secret = "PRIVATE_CAPABILITY_ACCOUNT_PROMPT";

function fixture(overrides = {}) {
  const calls = [];
  const snapshot = {
    actions: [...COMPANION_ACTIONS],
    desktop: { status: "stopped" }, installation: { status: "installed" },
    managedConfig: { status: "installed" }, recovery: { status: "idle" },
    integration: { status: "pickermux" }, accountCache: { status: "ready" },
    compatibility: { status: "compatible" },
    ...overrides.snapshot,
  };
  return { calls, snapshot, options: {
    sourceRoot: "/verified/versions/0.9.0", distributionPaths: { private: secret },
    statusImpl: async () => { calls.push("status"); return snapshot; },
    validateDistributionImpl: async () => { calls.push("distribution"); return { installed: true, activeDirectory: "/verified/versions/0.9.0" }; },
    withLockImpl: async (_paths, operation) => { calls.push("lock"); return operation(); },
    handlers: Object.fromEntries(COMPANION_ACTIONS.map((action) => [action, async (parsed) => { calls.push(action); return { ...parsed, secret }; }])),
    ...overrides.options,
  } };
}

test("companion actions revalidate authority under the shared installation lock", async () => {
  for (const action of ["refresh", "open", "certify"]) {
    const { calls, options } = fixture();
    await executeCompanionAction(request(action), options);
    assert.deepEqual(calls, ["lock", "status", "distribution", action]);
  }
});

test("read-only, setup and independent recovery use their own transactional entry points", async () => {
  for (const action of ["diagnose", "update-check", "configuration-preview", "update", "configuration-apply", "recover"]) {
    const { calls, options } = fixture();
    const additional = action === "recover" ? { confirmation: consent } : action === "configuration-apply"
      ? { confirmation: { replaceIntegration: true }, previewToken: "a".repeat(64) } : {};
    await executeCompanionAction(request(action, additional), options);
    assert.equal(calls.includes("lock"), false);
    assert.equal(calls.includes("distribution"), ["update", "recover"].includes(action));
    assert.equal(calls.at(-1), action);
  }
});

test("no mutation may use a bundled or different receipt-active distribution", async () => {
  for (const distribution of [{ installed: false }, { installed: true, activeDirectory: "/foreign/runtime" }, { installed: true, activeDirectory: secret }]) {
    const { calls, options } = fixture({ options: { validateDistributionImpl: async () => distribution } });
    await assert.rejects(executeCompanionAction(request("refresh"), options), { code: "DISTRIBUTION_INVALID" });
    assert.equal(calls.includes("refresh"), false);
  }
});

test("stale GUI state cannot authorize refresh or certification while Codex is running", async () => {
  for (const action of ["refresh", "certify", "update", "configuration-apply"]) {
    const { calls, options } = fixture({ snapshot: { desktop: { status: "running" } } });
    const additional = action === "configuration-apply" ? { confirmation: { replaceIntegration: true }, previewToken: "a".repeat(64) } : {};
    await assert.rejects(executeCompanionAction(request(action, additional), options), { code: "CODEX_RUNNING" });
    assert.equal(calls.includes(action), false);
  }
});

test("pending recovery, configuration edits and unknown state block unavailable actions", async () => {
  for (const [snapshot, code] of [
    [{ recovery: { status: "pending" } }, "RECOVERY_PENDING"],
    [{ managedConfig: { status: "modified" } }, "CONFIGURATION_CONFLICT"],
    [{ accountCache: { status: "refresh-required" } }, "ACCOUNT_CACHE_REFRESH_REQUIRED"],
    [{ compatibility: { status: "update-required" } }, "UPDATE_REQUIRED"],
    [{ desktop: { status: "unknown" } }, "ACTION_FAILED"],
  ]) {
    const { calls, options } = fixture({ snapshot: { ...snapshot, actions: ["diagnose"] } });
    await assert.rejects(executeCompanionAction(request("refresh"), options), { code });
    assert.equal(calls.includes("refresh"), false);
  }
});

test("recovery never acquires authority without all native confirmation fields", async () => {
  const { calls, options } = fixture();
  await assert.rejects(executeCompanionAction(request("recover", { confirmation: { ...consent, interruptTasks: false } }), options), { code: "CONFIRMATION_REQUIRED" });
  assert.deepEqual(calls, []);
  await assert.rejects(executeCompanionAction('{"schemaVersion":1,"action":"recover","action":"refresh"}', options), { code: "INVALID_REQUEST" });
  assert.deepEqual(calls, []);
});

test("busy installation lock blocks action before status or lifecycle invocation", async () => {
  const { calls, options } = fixture({ options: { withLockImpl: async () => { const error = new Error(secret); error.code = "PICKERMUX_INSTALLATION_LOCK_BUSY"; throw error; } } });
  await assert.rejects(executeCompanionAction(request("refresh"), options), { code: "PICKERMUX_INSTALLATION_LOCK_BUSY" });
  assert.deepEqual(calls, []);
});

async function cli(argv, raw, overrides = {}) {
  let stdout = "";
  let stderr = "";
  const result = await runCompanionCli(argv, {
    input: Readable.from([raw ?? ""]),
    output: { write: (value) => { stdout += value; } },
    progressOutput: { write: (value) => { stderr += value; } },
    statusImpl: async () => ({ schemaVersion: 1, state: "ready" }),
    executeImpl: async () => ({}),
    ...overrides,
  });
  assert.equal(stdout.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(stdout), result);
  assert.equal((stdout + stderr).includes(secret), false);
  return { result, stderr };
}

test("companion CLI rejects options, oversized stdin and unknown schemas safely", async () => {
  for (const [argv, raw, code] of [
    [["status", "--config", secret], "", "INVALID_REQUEST"],
    [["refresh"], "", "INVALID_REQUEST"],
    [["run"], "x".repeat(4097), "REQUEST_TOO_LARGE"],
    [["run"], '{"schemaVersion":2,"action":"refresh"}', "UNSUPPORTED_SCHEMA"],
  ]) {
    const { result } = await cli(argv, raw, { executeImpl: async () => assert.fail("must not execute") });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
  }
});

test("CLI action/progress envelopes discard private results and error text", async () => {
  const { result, stderr } = await cli(["run"], JSON.stringify(request("recover", { confirmation: consent })), {
    executeImpl: async (_request, { onProgress }) => {
      onProgress({ phase: "suspended", total: 3, prompt: secret });
      return { started: true, operationId: "1804ad9d-4eb2-43f4-95e5-a3b5a1f4b9da", privatePath: secret };
    },
  });
  assert.deepEqual(Object.keys(result), ["schemaVersion", "ok", "code", "data"]);
  assert.equal(result.data.started, true);
  assert.deepEqual(JSON.parse(stderr), { schemaVersion: 1, type: "progress", phase: "suspended", total: 3 });
  const failed = await cli(["run"], JSON.stringify(request("refresh")), { executeImpl: async () => { throw new Error(secret); } });
  assert.equal(failed.result.code, "ACTION_FAILED");
});

test("configuration preview exposes exact CAS token in the shared envelope", async () => {
  const { result } = await cli(["run"], JSON.stringify(request("configuration-preview")), {
    executeImpl: async () => ({ status: "ollama", canApply: true, requiresConfirmation: true, changes: ["create-backup", secret], previewToken: "f".repeat(64), config: secret }),
  });
  assert.deepEqual(result.data, { action: "configuration-preview", status: "ollama", canApply: true, requiresConfirmation: true, changes: ["create-backup"], previewToken: "f".repeat(64) });
});
