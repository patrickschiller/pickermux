import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { executeCompanionAction } from "../src/companion-actions.mjs";
import { runCompanionCli } from "../src/companion-cli.mjs";
import { COMPANION_ACTIONS } from "../src/companion-control.mjs";
import { runPickerMuxCompanion } from "../src/cli.mjs";
import { ConfigManagerError } from "../src/config-manager.mjs";
import { BUNDLED_LMSTUDIO_SETUP_CHANGES } from "../src/native-only-setup.mjs";
import { createUsageStore } from "../src/usage-store.mjs";

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

test("usage reset runs only against the installed backend and allows a running Desktop", async () => {
  const consent = { confirmation: { resetAccumulatedUsage: true } };
  const valid = fixture({ snapshot: { desktop: { status: "running" } } });
  await executeCompanionAction(request("usage-reset", consent), valid.options);
  assert.deepEqual(valid.calls, ["lock", "status", "distribution", "usage-reset"]);
  for (const override of [
    { snapshot: { actions: ["diagnose"] } },
    { options: { validateDistributionImpl: async () => ({ installed: false }) } },
    { options: { validateDistributionImpl: async () => ({ installed: true, activeDirectory: "/different/source" }) } },
  ]) {
    const invalid = fixture(override);
    await assert.rejects(executeCompanionAction(request("usage-reset", consent), invalid.options));
    assert.equal(invalid.calls.includes("usage-reset"), false);
  }
});

test("installed reset handler commits exact saved counts without touching lifecycle state", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pickermux-companion-usage-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const applicationDirectory = path.join(temporary, "PickerMux");
  await mkdir(applicationDirectory, { mode: 0o700 });
  const store = createUsageStore({ directory: path.join(applicationDirectory, "usage") });
  const last = { status: "available", inputTokens: 10, outputTokens: 3, totalTokens: 13 };
  await store.record("lmstudio", last);
  let output = "";
  const run = () => runPickerMuxCompanion(["run"], {
    distributionPaths: { applicationDirectory }, sourceRoot: "/verified/versions/0.21.0",
    statusImpl: async () => fixture({ snapshot: { desktop: { status: "running" } } }).snapshot,
    validateDistributionImpl: async () => ({ installed: true, activeDirectory: "/verified/versions/0.21.0" }),
    withLockImpl: async (_paths, operation) => operation(),
    desktopRunningImpl: async () => assert.fail("Reset must not quit or inspect Codex"),
    input: Readable.from([JSON.stringify(request("usage-reset", { confirmation: { resetAccumulatedUsage: true } }))]),
    output: { write: (value) => { output += value; } }, progressOutput: { write() {} },
  });
  const result = await run();
  assert.equal(result.ok, true);
  assert.equal(result.data.lastRequestPreserved, true);
  const after = await store.readSnapshot();
  assert.deepEqual(after.providers[0].last, last);
  assert.equal(after.providers[0].requests, 0);
  assert.equal(after.providers[0].totals.totalTokens, 0);
  await writeFile(path.join(applicationDirectory, "usage", "token-usage.json"), secret, { mode: 0o600 });
  output = "";
  const failed = await run();
  assert.equal(failed.ok, false);
  assert.equal(output.includes(secret), false);
});

const uninstallConsent = { removePickerMux: true, restoreNativeCodex: true, deleteProviderCredentials: true, deleteBackups: true };

test("uninstall actions require stopped Desktop and the receipt-active source without nested locks", async () => {
  for (const action of ["uninstall-preview", "uninstall"]) {
    const additional = action === "uninstall" ? { confirmation: uninstallConsent, previewToken: "a".repeat(64) } : {};
    const valid = fixture();
    await executeCompanionAction(request(action, additional), valid.options);
    assert.deepEqual(valid.calls, ["status", "distribution", action]);
    for (const override of [
      { snapshot: { desktop: { status: "running" } } },
      { options: { validateDistributionImpl: async () => ({ installed: false }) } },
      { options: { validateDistributionImpl: async () => ({ installed: true, activeDirectory: "/different/source" }) } },
    ]) {
      const blocked = fixture(override);
      await assert.rejects(executeCompanionAction(request(action, additional), blocked.options));
      assert.equal(blocked.calls.includes(action), false);
    }
  }
});

test("companion uninstall reports success only after completed purge and native history proofs", async () => {
  const snapshot = fixture().snapshot;
  const result = {
    beforeResult: { installDirectoryRemoved: true, integration: { removedConfig: { nativeRestored: true, historicalCompatibility: true } } },
    removed: { versionsDirectoryRemoved: true, applicationDirectoryRemoved: true },
  };
  for (const invalid of [false, "cleanup", "native", "history"]) {
    let output = "";
    let purges = 0;
    const projected = await runPickerMuxCompanion(["run"], {
      paths: { installDirectory: "/private/tmp/fixture/model-bridge" }, distributionPaths: { applicationDirectory: "/private/tmp/fixture/distribution", versionsDirectory: "/private/tmp/fixture/distribution/versions" },
      sourceRoot: "/verified/versions/0.9.0", statusImpl: async () => snapshot,
      validateDistributionImpl: async () => ({ installed: true, activeDirectory: "/verified/versions/0.9.0" }),
      desktopRunningImpl: async () => false, assertNoPendingFullRefreshImpl: async () => null,
      input: Readable.from([JSON.stringify(request("uninstall", { confirmation: uninstallConsent, previewToken: "a".repeat(64) }))]),
      output: { write: (value) => { output += value; } }, progressOutput: { write: () => {} },
      withLockImpl: async () => assert.fail("purge owns its complete lifecycle lock"),
      purgeUninstallImpl: async (options) => {
        purges += 1;
        assert.equal(options.restoreNative, true);
        assert.equal(options.expectedPreviewToken, "a".repeat(64));
        assert.equal(options.sourceRoot, "/verified/versions/0.9.0");
        if (invalid === "cleanup") return { ...result, removed: { ...result.removed, cleanupPendingPath: secret } };
        if (invalid === "native" || invalid === "history") return { ...result, beforeResult: { ...result.beforeResult, integration: { removedConfig: { nativeRestored: invalid !== "native", historicalCompatibility: invalid !== "history" } } } };
        return result;
      },
    });
    assert.equal(purges, 1);
    assert.deepEqual(JSON.parse(output), projected);
    assert.equal(output.includes(secret), false);
    assert.equal(projected.ok, invalid === false);
    if (invalid) assert.equal(projected.code, "PURGE_INCOMPLETE");
    else assert.deepEqual(projected.data, { action: "uninstall", restartRequired: true, status: "removed", removed: true, nativeRestored: true, historicalChatsPreserved: true });
  }
});

test("native uninstall maps bounded causes without exposing errors or flattening rollback aggregates", async () => {
  const conflict = Object.assign(new Error(secret), { name: "ConfigManagerError", code: "UNINSTALL_CONFLICT" });
  for (const [error, code] of [
    [new Error(secret, { cause: conflict }), "UNINSTALL_CONFLICT"],
    [new Error(secret, { cause: Object.assign(new Error(secret), { code: "PICKERMUX_CREDENTIAL_PURGE_INCOMPLETE" }) }), "PURGE_INCOMPLETE"],
    [Object.assign(new Error(secret, { cause: conflict }), { code: "PICKERMUX_PURGE_COMMIT_INCOMPLETE" }), "PURGE_INCOMPLETE"],
    [Object.assign(new Error(secret), { code: "CODEX_RUNNING" }), "CODEX_RUNNING"],
    [Object.assign(new Error(secret), { code: "RECOVERY_PENDING" }), "RECOVERY_PENDING"],
    [new Error(secret, { cause: new AggregateError([conflict, new Error(secret)], secret) }), "UNINSTALL_FAILED"],
    [Object.assign(new Error(secret, { cause: conflict }), { code: "PRIVATE_ROLLBACK_FAILED" }), "UNINSTALL_FAILED"],
    [new ConfigManagerError("CONFIG_SUSPENSION_ROLLBACK_FAILED", secret, { cause: conflict }), "UNINSTALL_FAILED"],
    [Object.assign(new AggregateError([conflict, new Error(secret)], secret), { code: "CODEX_RUNNING" }), "UNINSTALL_FAILED"],
    [Object.assign(new AggregateError([conflict, new Error(secret)], secret), { code: "PICKERMUX_CREDENTIAL_PURGE_INCOMPLETE" }), "PURGE_INCOMPLETE"],
  ]) {
    let output = "";
    const result = await runPickerMuxCompanion(["run"], {
      sourceRoot: "/verified/versions/0.9.0", statusImpl: async () => fixture().snapshot,
      validateDistributionImpl: async () => ({ installed: true, activeDirectory: "/verified/versions/0.9.0" }),
      desktopRunningImpl: async () => false, assertNoPendingFullRefreshImpl: async () => null,
      input: Readable.from([JSON.stringify(request("uninstall", { confirmation: uninstallConsent, previewToken: "a".repeat(64) }))]),
      output: { write: (value) => { output += value; } }, progressOutput: { write: () => {} },
      purgeUninstallImpl: async () => { throw error; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(output.includes(secret), false);
  }
});

test("read-only, setup and independent recovery use their own transactional entry points", async () => {
  for (const action of ["diagnose", "update-check", "configuration-preview", "lmstudio-default-preview", "update", "configuration-apply", "lmstudio-default-apply", "full-refresh", "recover"]) {
    const { calls, options } = fixture();
    const additional = ["full-refresh", "recover"].includes(action) ? { confirmation: consent } : action === "configuration-apply"
      ? { confirmation: { replaceIntegration: true }, previewToken: "a".repeat(64) } : action === "lmstudio-default-apply"
        ? { confirmation: { enableBundledLmStudio: true }, previewToken: "a".repeat(64) } : {};
    await executeCompanionAction(request(action, additional), options);
    assert.equal(calls.includes("lock"), false);
    assert.equal(calls.includes("distribution"), ["lmstudio-default-preview", "lmstudio-default-apply", "update", "full-refresh", "recover"].includes(action));
    assert.equal(calls.at(-1), action);
  }
});

test("full refresh may schedule its graceful worker while Codex is running", async () => {
  const { calls, options } = fixture({ snapshot: { desktop: { status: "running" } } });
  await executeCompanionAction(request("full-refresh", { confirmation: consent }), options);
  assert.deepEqual(calls, ["status", "distribution", "full-refresh"]);
});

test("stale full-refresh UI state cannot bypass current ownership or recovery guards", async () => {
  for (const [snapshot, code] of [
    [{ recovery: { status: "pending" } }, "RECOVERY_PENDING"],
    [{ managedConfig: { status: "modified" }, desktop: { status: "running" } }, "CONFIGURATION_CONFLICT"],
    [{ accountCache: { status: "refresh-required" } }, "ACCOUNT_CACHE_REFRESH_REQUIRED"],
    [{ compatibility: { status: "update-required" } }, "UPDATE_REQUIRED"],
  ]) {
    const { calls, options } = fixture({ snapshot: { ...snapshot, actions: ["diagnose"] } });
    await assert.rejects(
      executeCompanionAction(request("full-refresh", { confirmation: consent }), options),
      { code },
    );
    assert.equal(calls.includes("distribution"), false);
    assert.equal(calls.includes("full-refresh"), false);
  }
});

test("companion full refresh delegates to the receipt-bound scheduler without an outer lock", async () => {
  const paths = { installDirectory: "/private/codex/model-bridge" };
  const distributionPaths = { applicationDirectory: "/private/pickermux" };
  const fullRefreshPaths = { checkpointPath: "/private/pickermux/full-refresh/state.json" };
  const codexPath = "/Applications/Codex.app/Contents/MacOS/Codex";
  const sourceRoot = "/verified/versions/0.9.0";
  const operationId = "1804ad9d-4eb2-43f4-95e5-a3b5a1f4b9da";
  let scheduled;
  let output = "";
  const result = await runPickerMuxCompanion(["run"], {
    paths,
    distributionPaths,
    fullRefreshPaths,
    codexPath,
    sourceRoot,
    input: Readable.from([JSON.stringify(request("full-refresh", { confirmation: consent }))]),
    output: { write: (value) => { output += value; } },
    progressOutput: { write: () => {} },
    statusImpl: async () => fixture({ snapshot: { desktop: { status: "running" } } }).snapshot,
    validateDistributionImpl: async ({ paths: actualPaths }) => {
      assert.equal(actualPaths, distributionPaths);
      return { installed: true, activeDirectory: sourceRoot };
    },
    withLockImpl: async () => assert.fail("the scheduler owns the complete lifecycle lock"),
    scheduleFullRefreshImpl: async (options) => {
      scheduled = options;
      return { started: true, resumed: false, operationId };
    },
  });
  assert.deepEqual(scheduled, { paths, distributionPaths, fullRefreshPaths, codexPath, sourceRoot });
  assert.deepEqual(JSON.parse(output), result);
  assert.deepEqual(result.data, { action: "full-refresh", started: true, resumed: false, operationId });
});

test("bundled LM Studio apply passes only the preview-bound target into transactional setup", async () => {
  const paths = { configPath: "/private/codex/config.toml", serviceConfigPath: "/private/codex/model-bridge/config.json" };
  const distributionPaths = { applicationDirectory: "/private/pickermux" };
  const sourceRoot = "/verified/versions/0.24.6";
  const previewToken = "a".repeat(64);
  const targetConfig = {
    schemaVersion: 2,
    bridge: { port: 5127, defaultModel: "gpt-5.6-sol", reasoningEffort: "high" },
    providers: [{ id: "lmstudio", kind: "lmstudio-responses" }],
  };
  let previewCalls = 0;
  let setupCalls = 0;
  let output = "";
  const result = await runPickerMuxCompanion(["run"], {
    paths,
    distributionPaths,
    sourceRoot,
    input: Readable.from([JSON.stringify(request("lmstudio-default-apply", {
      confirmation: { enableBundledLmStudio: true }, previewToken,
    }))]),
    output: { write: (value) => { output += value; } },
    progressOutput: { write: () => {} },
    statusImpl: async () => fixture().snapshot,
    validateDistributionImpl: async ({ paths: actualPaths }) => {
      assert.equal(actualPaths, distributionPaths);
      return { installed: true, activeDirectory: sourceRoot };
    },
    withLockImpl: async () => assert.fail("transactional setup owns the lifecycle lock"),
    lmStudioDefaultPreviewImpl: async (options) => {
      previewCalls += 1;
      assert.deepEqual(options, { paths, sourceRoot });
      return {
        status: "native-only", canApply: true, requiresConfirmation: true,
        changes: [...BUNDLED_LMSTUDIO_SETUP_CHANGES], previewToken,
        bundledConfigPath: path.join(sourceRoot, "lmstudio-picker.config.json"),
        installedConfigBytes: Buffer.from("native-only-config\n"),
        targetConfig,
      };
    },
    setupImpl: async (options) => {
      setupCalls += 1;
      assert.equal(options.sourceRoot, sourceRoot);
      assert.equal(options.paths, paths);
      assert.equal(options.distributionPaths, distributionPaths);
      assert.equal(Object.hasOwn(options, "setupConfigPath"), false);
      assert.equal(options.setupConfig, targetConfig);
      assert.deepEqual(options.expectedServiceConfig, Buffer.from("native-only-config\n"));
      assert.equal(options.setupConfig.bridge.port, 5127);
      await options.configurationPreflightImpl();
      return { version: "0.24.6", certification: { status: "complete" } };
    },
  });
  assert.equal(previewCalls, 2);
  assert.equal(setupCalls, 1);
  assert.deepEqual(JSON.parse(output), result);
  assert.deepEqual(result.data, {
    action: "lmstudio-default-apply", updated: true, restartRequired: true,
    certificationIncomplete: false, version: "0.24.6", status: "applied",
  });
  assert.equal(output.includes("lmstudio"), true);
  assert.equal(output.includes("providers"), false);
  assert.equal(output.includes("5127"), false);
});

test("bundled LM Studio apply rejects stale previews and concurrent installed-config drift", async () => {
  const sourceRoot = "/verified/versions/0.24.6";
  const requestedToken = "a".repeat(64);
  const changedToken = "b".repeat(64);
  const base = {
    sourceRoot,
    statusImpl: async () => fixture().snapshot,
    validateDistributionImpl: async () => ({ installed: true, activeDirectory: sourceRoot }),
    input: Readable.from([JSON.stringify(request("lmstudio-default-apply", {
      confirmation: { enableBundledLmStudio: true }, previewToken: requestedToken,
    }))]),
    output: { write: () => {} },
    progressOutput: { write: () => {} },
  };
  for (const concurrent of [false, true]) {
    let previewCalls = 0;
    let setupCalls = 0;
    const result = await runPickerMuxCompanion(["run"], {
      ...base,
      input: Readable.from([JSON.stringify(request("lmstudio-default-apply", {
        confirmation: { enableBundledLmStudio: true }, previewToken: requestedToken,
      }))]),
      lmStudioDefaultPreviewImpl: async () => {
        previewCalls += 1;
        return {
          status: "native-only", canApply: true, requiresConfirmation: true,
          changes: [...BUNDLED_LMSTUDIO_SETUP_CHANGES],
          previewToken: concurrent && previewCalls === 1 ? requestedToken : changedToken,
          bundledConfigPath: path.join(sourceRoot, "lmstudio-picker.config.json"),
          installedConfigBytes: Buffer.from("native-only-config\n"),
          targetConfig: { schemaVersion: 2, bridge: {}, providers: [] },
        };
      },
      setupImpl: async ({ configurationPreflightImpl }) => {
        setupCalls += 1;
        await configurationPreflightImpl();
        assert.fail("configuration drift must stop setup before mutation");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "CONFIGURATION_CONFLICT");
    assert.equal(setupCalls, concurrent ? 1 : 0);
    assert.equal(previewCalls, concurrent ? 2 : 1);
  }
});

test("no mutation may use a bundled or different receipt-active distribution", async () => {
  for (const distribution of [{ installed: false }, { installed: true, activeDirectory: "/foreign/runtime" }, { installed: true, activeDirectory: secret }]) {
    for (const [action, additional] of [
      ["refresh", {}],
      ["lmstudio-default-preview", {}],
      ["lmstudio-default-apply", { confirmation: { enableBundledLmStudio: true }, previewToken: "a".repeat(64) }],
    ]) {
      const { calls, options } = fixture({ options: { validateDistributionImpl: async () => distribution } });
      await assert.rejects(executeCompanionAction(request(action, additional), options), { code: "DISTRIBUTION_INVALID" });
      assert.equal(calls.includes(action), false);
    }
  }
});

test("stale GUI state cannot authorize refresh, provider setup or certification while Codex is running", async () => {
  for (const action of ["refresh", "certify", "update", "configuration-apply", "lmstudio-default-preview", "lmstudio-default-apply"]) {
    const { calls, options } = fixture({ snapshot: { desktop: { status: "running" } } });
    const additional = action === "configuration-apply" ? { confirmation: { replaceIntegration: true }, previewToken: "a".repeat(64) } :
      action === "lmstudio-default-apply" ? { confirmation: { enableBundledLmStudio: true }, previewToken: "a".repeat(64) } : {};
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

test("full refresh and recovery never acquire authority without all native confirmation fields", async () => {
  for (const action of ["full-refresh", "recover"]) {
    const { calls, options } = fixture();
    await assert.rejects(executeCompanionAction(request(action, { confirmation: { ...consent, interruptTasks: false } }), options), { code: "CONFIRMATION_REQUIRED" });
    assert.deepEqual(calls, []);
  }
  const { calls, options } = fixture();
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


test("OFF validates exact consent, current state, stopped Desktop and receipt-active distribution under lock", async () => {
  const parsed = request("integration-deactivate", { confirmation: { deactivateIntegration: true } });
  const { calls, options } = fixture();
  await executeCompanionAction(parsed, options);
  assert.deepEqual(calls, ["lock", "status", "distribution", "integration-deactivate"]);
  for (const overrides of [
    { snapshot: { desktop: { status: "running" } } },
    { options: { validateDistributionImpl: async () => ({ installed: true, activeDirectory: "/bundled/source" }) } },
    { snapshot: { actions: ["diagnose"], recovery: { status: "pending" } } },
  ]) {
    const blocked = fixture(overrides);
    await assert.rejects(executeCompanionAction(parsed, blocked.options));
    assert.equal(blocked.calls.includes("integration-deactivate"), false);
  }
  const rejected = fixture();
  await assert.rejects(executeCompanionAction(request("integration-deactivate"), rejected.options), { code: "CONFIRMATION_REQUIRED" });
  assert.deepEqual(rejected.calls, []);
});
