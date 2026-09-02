import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  confirmFullRefresh,
  executeFullRefreshWorker,
  reactivatePickerMuxAfterFullRefresh,
  runCli,
  scheduleFullRefresh,
  suspendPickerMuxForFullRefresh,
} from "../src/cli.mjs";
import { runFullRefreshWorkflow } from "../src/full-refresh.mjs";

const SOURCE_ROOT = "/private/pickermux/versions/0.5.4";
const CODEX_PATH = "/Applications/Test Codex.app/Contents/Resources/codex";
const CAPABILITY = "a".repeat(32);

function fixturePaths() {
  const codexHome = "/private/tmp/pickermux-full-refresh/codex-home";
  const installDirectory = path.join(codexHome, "model-bridge");
  return {
    codexHome,
    installDirectory,
    configPath: path.join(codexHome, "config.toml"),
    statePath: path.join(installDirectory, "state.json"),
    catalogPath: path.join(installDirectory, "models.json"),
    backupDirectory: path.join(installDirectory, "backups"),
    runtimePath: path.join(installDirectory, "runtime.json"),
    serviceConfigPath: path.join(installDirectory, "service-config.json"),
    serviceDirectory: path.join(installDirectory, "runtime-app"),
    logPath: path.join(installDirectory, "bridge.log"),
    launchAgentPath:
      "/private/tmp/pickermux-full-refresh/com.local.codex-model-bridge.plist",
    launchAgentLabel: "com.local.codex-model-bridge",
  };
}

function fixtureDistributionPaths() {
  return {
    applicationDirectory: "/private/pickermux",
    receiptPath: "/private/pickermux/install-receipt.json",
    lockPath: "/private/pickermux/.setup.lock",
  };
}

function fixtureFullRefreshPaths() {
  const installDirectory = "/private/pickermux";
  const operationDirectory = path.join(installDirectory, "full-refresh");
  const launchAgentLabel = "com.local.pickermux-full-refresh";
  return {
    installDirectory,
    operationDirectory,
    checkpointPath: path.join(operationDirectory, "full-refresh-state.json"),
    launchAgentPath: path.join(
      operationDirectory,
      `${launchAgentLabel}.plist`,
    ),
    logPath: path.join(operationDirectory, "full-refresh.log"),
    launchAgentLabel,
    receiptPath: "/private/pickermux/install-receipt.json",
  };
}

function fixtureConfig() {
  return {
    schemaVersion: 2,
    bridge: {
      host: "127.0.0.1",
      port: 42_10,
      providerId: "model_bridge_test",
      defaultModel: "lmstudio/test",
      reasoningEffort: "low",
      limits: { streamIdleTimeoutMs: 30_000 },
    },
    providers: [],
  };
}

function fixtureRuntime(paths = fixturePaths()) {
  return {
    version: 1,
    instanceId: "full-refresh-test-instance",
    capability: CAPABILITY,
    configPath: paths.serviceConfigPath,
    createdAt: "2026-09-02T08:00:00.000Z",
  };
}

function activeStatus(config, paths, runtime) {
  return {
    installed: true,
    healthy: true,
    status: "installed",
    provider: config.bridge.providerId,
    providerName: "OpenAI",
    catalog: paths.catalogPath,
    baseUrl:
      `http://${config.bridge.host}:${config.bridge.port}` +
      `/c/${runtime.capability}/v1`,
  };
}

function suspendedStatus() {
  return {
    installed: false,
    healthy: true,
    status: "not-installed",
  };
}

function distributionSnapshot(marker = "stable") {
  return {
    installed: true,
    activeDirectory: SOURCE_ROOT,
    raw: Buffer.from(`receipt:${marker}`),
  };
}

async function withImmediateLock(_paths, operation) {
  return operation();
}

async function captureStdout(operation) {
  const output = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    output.push(String(chunk));
    return true;
  };
  try {
    return { result: await operation(), output };
  } finally {
    process.stdout.write = originalWrite;
  }
}

test("full-refresh suspension stops the service before restoring native config", async () => {
  const paths = fixturePaths();
  const config = fixtureConfig();
  const runtime = fixtureRuntime(paths);
  const ownershipReceipt = Object.freeze({ kind: "config-ownership" });
  const events = [];
  let statusRead = 0;
  let stopOptions;

  const result = await suspendPickerMuxForFullRefresh({
    config,
    paths,
    sourceRoot: SOURCE_ROOT,
    configStatusImpl: async () => {
      events.push(statusRead === 0 ? "config-status-active" : "config-status-native");
      statusRead += 1;
      return statusRead === 1
        ? activeStatus(config, paths, runtime)
        : suspendedStatus();
    },
    runtimeImpl: async (runtimePath) => {
      assert.equal(runtimePath, paths.runtimePath);
      events.push("runtime-read");
      return runtime;
    },
    validateLaunchAgentImpl: async (options) => {
      assert.equal(options.launchAgentPath, paths.launchAgentPath);
      assert.equal(options.binPath, path.join(paths.serviceDirectory, "bin", "lmstudio-picker.mjs"));
      events.push("launch-agent-validated");
      return { present: true, nodePath: "/opt/homebrew/bin/node" };
    },
    inventoryRuntimeImpl: async ({ serviceDirectory, sourceRoot }) => {
      assert.equal(serviceDirectory, paths.serviceDirectory);
      assert.equal(sourceRoot, SOURCE_ROOT);
      events.push("runtime-inventoried");
      return { exists: true };
    },
    inventoryConfigImpl: async () => {
      events.push("config-inventoried");
      return ownershipReceipt;
    },
    stopServiceImpl: async (options) => {
      stopOptions = options;
      events.push("service-stopped");
      return { stopped: true };
    },
    revalidateConfigImpl: async (receipt) => {
      assert.equal(receipt, ownershipReceipt);
      events.push("config-revalidated");
    },
    uninstallConfigImpl: async ({ ownershipReceipt: receipt }) => {
      assert.equal(receipt, ownershipReceipt);
      events.push("config-restored");
      return { changed: true, installed: false };
    },
  });

  assert.equal(stopOptions.removeRuntime, true);
  assert.equal(stopOptions.runtimePath, paths.runtimePath);
  assert.equal(stopOptions.launchAgentPath, paths.launchAgentPath);
  assert.deepEqual(events, [
    "config-status-active",
    "runtime-read",
    "launch-agent-validated",
    "runtime-inventoried",
    "config-inventoried",
    "service-stopped",
    "runtime-inventoried",
    "config-revalidated",
    "config-restored",
    "config-status-native",
  ]);
  assert.deepEqual(result, {
    suspended: true,
    alreadySuspended: false,
    removedConfig: { changed: true, installed: false },
    service: { stopped: true },
  });
});

test("full-refresh suspension is idempotent once native config is restored", async () => {
  const paths = fixturePaths();
  let stopOptions;
  let forbiddenCalls = 0;
  const result = await suspendPickerMuxForFullRefresh({
    config: fixtureConfig(),
    paths,
    sourceRoot: SOURCE_ROOT,
    configStatusImpl: async () => suspendedStatus(),
    runtimeImpl: async () => {
      forbiddenCalls += 1;
    },
    inventoryConfigImpl: async () => {
      forbiddenCalls += 1;
    },
    uninstallConfigImpl: async () => {
      forbiddenCalls += 1;
    },
    stopServiceImpl: async (options) => {
      stopOptions = options;
      return { stopped: false, alreadyStopped: true };
    },
  });

  assert.equal(forbiddenCalls, 0);
  assert.equal(stopOptions.removeRuntime, true);
  assert.equal(result.alreadySuspended, true);
  assert.equal(result.removedConfig.changed, false);
});

test("full-refresh suspension restores the service after config removal fails", async () => {
  const paths = fixturePaths();
  const config = fixtureConfig();
  const runtime = fixtureRuntime(paths);
  const events = [];
  let statusRead = 0;
  let startOptions;

  await assert.rejects(
    suspendPickerMuxForFullRefresh({
      config,
      paths,
      sourceRoot: SOURCE_ROOT,
      configStatusImpl: async () => {
        statusRead += 1;
        events.push(statusRead === 1 ? "status-active" : "status-rollback");
        return activeStatus(config, paths, runtime);
      },
      runtimeImpl: async () => runtime,
      validateLaunchAgentImpl: async () => ({
        present: true,
        nodePath: "/opt/homebrew/bin/node",
      }),
      inventoryRuntimeImpl: async () => {
        events.push("runtime-inventoried");
        return { exists: true };
      },
      inventoryConfigImpl: async () => ({ kind: "config-ownership" }),
      revalidateConfigImpl: async () => {
        events.push("config-revalidated");
      },
      stopServiceImpl: async (options) => {
        assert.equal(options.removeRuntime, true);
        events.push("service-stopped");
        return { stopped: true };
      },
      uninstallConfigImpl: async () => {
        events.push("config-remove-failed");
        throw new Error("simulated config failure");
      },
      serviceStatusImpl: async () => {
        events.push("rollback-service-status");
        return { loaded: false, healthy: false, status: "not-loaded" };
      },
      startServiceImpl: async (options) => {
        startOptions = options;
        events.push("service-restored");
        return { healthy: true };
      },
    }),
    /suspension failed; the managed bridge service was restored.*simulated config failure/iu,
  );

  assert.equal(startOptions.config, config);
  assert.equal(startOptions.runtime, runtime);
  assert.equal(startOptions.nodePath, "/opt/homebrew/bin/node");
  assert.equal(startOptions.configPath, paths.serviceConfigPath);
  assert.deepEqual(events, [
    "status-active",
    "runtime-inventoried",
    "service-stopped",
    "runtime-inventoried",
    "config-revalidated",
    "config-remove-failed",
    "status-rollback",
    "runtime-inventoried",
    "rollback-service-status",
    "service-restored",
  ]);
});

test("full-refresh lifecycle helpers fail closed on inconsistent state", async (t) => {
  const paths = fixturePaths();
  const config = fixtureConfig();
  let mutations = 0;

  await t.test("suspension rejects an unhealthy ownership state", async () => {
    await assert.rejects(
      suspendPickerMuxForFullRefresh({
        config,
        paths,
        sourceRoot: SOURCE_ROOT,
        configStatusImpl: async () => ({
          installed: true,
          healthy: false,
          status: "provider-conflict",
        }),
        stopServiceImpl: async () => {
          mutations += 1;
        },
      }),
      /refuses inconsistent integration state.*provider-conflict/iu,
    );
  });

  await t.test("suspension rejects a missing managed service", async () => {
    const runtime = fixtureRuntime(paths);
    await assert.rejects(
      suspendPickerMuxForFullRefresh({
        config,
        paths,
        sourceRoot: SOURCE_ROOT,
        configStatusImpl: async () => activeStatus(config, paths, runtime),
        runtimeImpl: async () => runtime,
        validateLaunchAgentImpl: async () => ({ present: false }),
        stopServiceImpl: async () => {
          mutations += 1;
        },
      }),
      /requires its managed bridge service/iu,
    );
  });

  await t.test("reactivation rejects an unhealthy ownership state", async () => {
    await assert.rejects(
      reactivatePickerMuxAfterFullRefresh({
        config,
        paths,
        sourceRoot: SOURCE_ROOT,
        configStatusImpl: async () => ({
          installed: false,
          healthy: false,
          status: "unmanaged-edit",
        }),
        installImpl: async () => {
          mutations += 1;
        },
      }),
      /refuses inconsistent integration state.*unmanaged-edit/iu,
    );
  });

  assert.equal(mutations, 0);
});

test("full-refresh reactivation installs from the receipt-active source root", async () => {
  const paths = fixturePaths();
  const config = fixtureConfig();
  let installOptions;
  const installed = { installed: true, restartRequired: true };
  const result = await reactivatePickerMuxAfterFullRefresh({
    config,
    paths,
    codexPath: CODEX_PATH,
    sourceRoot: SOURCE_ROOT,
    configStatusImpl: async () => suspendedStatus(),
    installImpl: async (options) => {
      installOptions = options;
      return installed;
    },
  });

  assert.equal(result, installed);
  assert.deepEqual(installOptions, {
    config,
    configPath: paths.serviceConfigPath,
    paths,
    codexPath: CODEX_PATH,
    sourceRoot: SOURCE_ROOT,
  });
});

test("full-refresh reactivation is idempotent only after doctor passes", async () => {
  const paths = fixturePaths();
  const config = fixtureConfig();
  let installs = 0;
  const doctor = { ok: true, checks: [] };
  const result = await reactivatePickerMuxAfterFullRefresh({
    config,
    paths,
    codexPath: CODEX_PATH,
    sourceRoot: SOURCE_ROOT,
    configStatusImpl: async () => activeStatus(config, paths, fixtureRuntime(paths)),
    installImpl: async () => {
      installs += 1;
    },
    doctorImpl: async ({ config: actualConfig, paths: actualPaths, codexPath }) => {
      assert.equal(actualConfig, config);
      assert.equal(actualPaths, paths);
      assert.equal(codexPath, CODEX_PATH);
      return doctor;
    },
  });

  assert.equal(installs, 0);
  assert.deepEqual(result, {
    installed: true,
    alreadyActive: true,
    doctor,
    restartRequired: true,
  });

  await assert.rejects(
    reactivatePickerMuxAfterFullRefresh({
      config,
      paths,
      codexPath: CODEX_PATH,
      sourceRoot: SOURCE_ROOT,
      configStatusImpl: async () => activeStatus(config, paths, fixtureRuntime(paths)),
      doctorImpl: async () => ({
        ok: false,
        checks: [
          { name: "service", status: "fail", detail: "bridge unhealthy" },
        ],
      }),
    }),
    /service: bridge unhealthy/iu,
  );
});

test("full-refresh scheduling binds the worker and runtime to the active receipt", async () => {
  const paths = fixturePaths();
  const distributionPaths = fixtureDistributionPaths();
  const fullRefreshPaths = fixtureFullRefreshPaths();
  const config = fixtureConfig();
  const runtime = fixtureRuntime(paths);
  const events = [];
  let armOptions;

  const result = await scheduleFullRefresh({
    paths,
    distributionPaths,
    fullRefreshPaths,
    codexPath: CODEX_PATH,
    sourceRoot: SOURCE_ROOT,
    nodePath: "/opt/homebrew/bin/node",
    withLockImpl: withImmediateLock,
    validateDistributionImpl: async ({ paths: actualPaths }) => {
      assert.equal(actualPaths, distributionPaths);
      events.push("distribution-validated");
      return distributionSnapshot();
    },
    loadConfigImpl: async (configPath) => {
      assert.equal(configPath, paths.serviceConfigPath);
      events.push("config-loaded");
      return config;
    },
    configStatusImpl: async () => {
      events.push("config-status");
      return activeStatus(config, paths, runtime);
    },
    inventoryRuntimeImpl: async ({ serviceDirectory, sourceRoot }) => {
      assert.equal(serviceDirectory, paths.serviceDirectory);
      assert.equal(sourceRoot, SOURCE_ROOT);
      events.push("runtime-inventoried");
      return { exists: true };
    },
    prepareCheckpointImpl: async (options) => {
      assert.equal(options.installDirectory, fullRefreshPaths.installDirectory);
      assert.equal(options.checkpointPath, fullRefreshPaths.checkpointPath);
      assert.equal(options.codexHome, paths.codexHome);
      assert.equal(options.codexPath, CODEX_PATH);
      events.push("checkpoint-prepared");
      return {
        resumed: false,
        checkpoint: { operationId: "operation_1234567890" },
      };
    },
    runtimeImpl: async (runtimePath) => {
      assert.equal(runtimePath, paths.runtimePath);
      events.push("runtime-read");
      return runtime;
    },
    validateLaunchAgentImpl: async () => {
      events.push("launch-agent-validated");
      return { present: true };
    },
    armImpl: async (options) => {
      armOptions = options;
      events.push("worker-armed");
      return { workerPath: options.workerPath };
    },
    cleanupImpl: async () => {
      assert.fail("successful scheduling must not clean the armed worker");
    },
  });

  const expectedWorker = path.join(SOURCE_ROOT, "bin", "pickermux.mjs");
  assert.deepEqual(events, [
    "distribution-validated",
    "config-loaded",
    "config-status",
    "runtime-inventoried",
    "checkpoint-prepared",
    "runtime-read",
    "launch-agent-validated",
    "worker-armed",
  ]);
  assert.equal(armOptions.workerPath, expectedWorker);
  assert.equal(armOptions.receiptPath, fullRefreshPaths.receiptPath);
  assert.equal(armOptions.nodePath, "/opt/homebrew/bin/node");
  assert.deepEqual(result, {
    started: true,
    resumed: false,
    operationId: "operation_1234567890",
    workerPath: expectedWorker,
  });
});

test("full-refresh scheduling resumes a checkpoint without revalidating active config", async () => {
  const paths = fixturePaths();
  const fullRefreshPaths = fixtureFullRefreshPaths();
  let forbiddenCalls = 0;
  let armCalls = 0;
  const result = await scheduleFullRefresh({
    paths,
    distributionPaths: fixtureDistributionPaths(),
    fullRefreshPaths,
    codexPath: CODEX_PATH,
    sourceRoot: SOURCE_ROOT,
    withLockImpl: withImmediateLock,
    validateDistributionImpl: async () => distributionSnapshot(),
    loadConfigImpl: async () => fixtureConfig(),
    configStatusImpl: async () => suspendedStatus(),
    inventoryRuntimeImpl: async () => ({ exists: true }),
    prepareCheckpointImpl: async () => ({
      resumed: true,
      checkpoint: {
        operationId: "operation_1234567890",
        phase: "suspended",
      },
    }),
    runtimeImpl: async () => {
      forbiddenCalls += 1;
    },
    validateLaunchAgentImpl: async () => {
      forbiddenCalls += 1;
    },
    cleanupImpl: async () => {
      forbiddenCalls += 1;
    },
    armImpl: async (options) => {
      armCalls += 1;
      return { workerPath: options.workerPath };
    },
  });

  assert.equal(forbiddenCalls, 0);
  assert.equal(armCalls, 1);
  assert.equal(result.resumed, true);
});

test("full-refresh scheduling cleans newly prepared state when dispatch fails", async () => {
  const paths = fixturePaths();
  const config = fixtureConfig();
  const runtime = fixtureRuntime(paths);
  const fullRefreshPaths = fixtureFullRefreshPaths();
  let cleanupOptions;

  await assert.rejects(
    scheduleFullRefresh({
      paths,
      distributionPaths: fixtureDistributionPaths(),
      fullRefreshPaths,
      sourceRoot: SOURCE_ROOT,
      withLockImpl: withImmediateLock,
      validateDistributionImpl: async () => distributionSnapshot(),
      loadConfigImpl: async () => config,
      configStatusImpl: async () => activeStatus(config, paths, runtime),
      inventoryRuntimeImpl: async () => ({ exists: true }),
      prepareCheckpointImpl: async () => ({
        resumed: false,
        checkpoint: { operationId: "operation_1234567890" },
      }),
      runtimeImpl: async () => runtime,
      validateLaunchAgentImpl: async () => ({ present: true }),
      armImpl: async () => {
        throw new Error("simulated launch failure");
      },
      cleanupImpl: async (options) => {
        cleanupOptions = options;
      },
    }),
    /simulated launch failure/iu,
  );

  assert.equal(cleanupOptions.successful, true);
  assert.equal(cleanupOptions.checkpointPath, fullRefreshPaths.checkpointPath);
});

test("full-refresh scheduling fails closed outside the receipt-active CLI", async () => {
  let reads = 0;
  await assert.rejects(
    scheduleFullRefresh({
      paths: fixturePaths(),
      distributionPaths: fixtureDistributionPaths(),
      fullRefreshPaths: fixtureFullRefreshPaths(),
      sourceRoot: "/private/unmanaged/checkout",
      withLockImpl: withImmediateLock,
      validateDistributionImpl: async () => distributionSnapshot(),
      loadConfigImpl: async () => {
        reads += 1;
      },
    }),
    /receipt-active installed PickerMux CLI/iu,
  );
  assert.equal(reads, 0);
});

test("full-refresh scheduling does not touch shared artifacts while the lifecycle lock is busy", async () => {
  const busy = new Error("another lifecycle operation is active");
  busy.code = "PICKERMUX_INSTALLATION_LOCK_BUSY";
  let validationCalls = 0;

  await assert.rejects(
    scheduleFullRefresh({
      distributionPaths: fixtureDistributionPaths(),
      withLockImpl: async () => {
        throw busy;
      },
      validateDistributionImpl: async () => {
        validationCalls += 1;
      },
    }),
    (error) => error === busy,
  );

  assert.equal(validationCalls, 0);
});

test("full-refresh confirmation requires the exact token and an interactive terminal", async () => {
  let prompt;
  assert.equal(
    await confirmFullRefresh({
      questionImpl: async (question) => {
        prompt = question;
        return "  FULL  ";
      },
    }),
    true,
  );
  assert.match(prompt, /gracefully quit Codex twice/iu);
  assert.match(prompt, /Type FULL to continue/iu);
  assert.equal(
    await confirmFullRefresh({ questionImpl: async () => "full" }),
    false,
  );
  await assert.rejects(
    confirmFullRefresh({ input: { isTTY: false }, output: { isTTY: true } }),
    /requires an interactive terminal confirmation/iu,
  );
});

test("refresh --full cancellation does not schedule a worker", async () => {
  let schedules = 0;
  const { result, output } = await captureStdout(() =>
    runCli(["refresh", "--full"], {
      confirmFullRefreshImpl: async () => false,
      scheduleFullRefreshImpl: async () => {
        schedules += 1;
      },
    }));

  assert.deepEqual(result, { started: false, cancelled: true });
  assert.equal(schedules, 0);
  assert.match(output.join(""), /cancelled; no state was changed/iu);
});

test("refresh --full confirms before dispatching the detached worker", async () => {
  const events = [];
  const scheduled = {
    started: true,
    resumed: false,
    operationId: "operation_1234567890",
  };
  const { result, output } = await captureStdout(() =>
    runCli(["refresh", "--full"], {
      confirmFullRefreshImpl: async () => {
        events.push("confirmed");
        return true;
      },
      scheduleFullRefreshImpl: async ({ paths, distributionPaths, fullRefreshPaths }) => {
        assert.ok(path.isAbsolute(paths.installDirectory));
        assert.ok(path.isAbsolute(distributionPaths.applicationDirectory));
        assert.ok(path.isAbsolute(fullRefreshPaths.checkpointPath));
        events.push("scheduled");
        return scheduled;
      },
    }));

  assert.equal(result, scheduled);
  assert.deepEqual(events, ["confirmed", "scheduled"]);
  assert.match(output.join(""), /worker armed/iu);
});

test("refresh --full rejects JSON before confirmation or dispatch", async () => {
  let calls = 0;
  await assert.rejects(
    runCli(["refresh", "--full", "--json"], {
      confirmFullRefreshImpl: async () => {
        calls += 1;
        return true;
      },
      scheduleFullRefreshImpl: async () => {
        calls += 1;
      },
    }),
    /does not support --json/iu,
  );
  await assert.rejects(
    runCli([
      "refresh",
      "--full-worker",
      "--checkpoint",
      fixtureFullRefreshPaths().checkpointPath,
      "--json",
    ]),
    /does not support --json/iu,
  );
  assert.equal(calls, 0);
});

test("full-refresh worker rejects any checkpoint outside the managed path", async () => {
  let validations = 0;
  await assert.rejects(
    executeFullRefreshWorker({
      checkpointPath: "/private/unmanaged/full-refresh-state.json",
      paths: fixturePaths(),
      distributionPaths: fixtureDistributionPaths(),
      fullRefreshPaths: fixtureFullRefreshPaths(),
      sourceRoot: SOURCE_ROOT,
      validateDistributionImpl: async () => {
        validations += 1;
        return distributionSnapshot();
      },
    }),
    /checkpoint path is not the managed path/iu,
  );
  assert.equal(validations, 0);
});

test("full-refresh worker runs the complete sequence and cleans successful state", async () => {
  const paths = fixturePaths();
  const distributionPaths = fixtureDistributionPaths();
  const fullRefreshPaths = fixtureFullRefreshPaths();
  const config = fixtureConfig();
  const events = [];
  const reports = [];
  let checkpoint = null;
  let distributionReads = 0;
  let cacheReads = 0;
  let cleanupOptions;

  const result = await executeFullRefreshWorker({
    checkpointPath: fullRefreshPaths.checkpointPath,
    paths,
    distributionPaths,
    fullRefreshPaths,
    codexPath: CODEX_PATH,
    sourceRoot: SOURCE_ROOT,
    validateDistributionImpl: async ({ paths: actualPaths }) => {
      assert.equal(actualPaths, distributionPaths);
      distributionReads += 1;
      return distributionSnapshot();
    },
    loadConfigImpl: async (configPath) => {
      assert.equal(configPath, paths.serviceConfigPath);
      return config;
    },
    desktopRunningImpl: async () => false,
    suspendImpl: async ({ config: actualConfig, paths: actualPaths, sourceRoot }) => {
      assert.equal(actualConfig, config);
      assert.equal(actualPaths, paths);
      assert.equal(sourceRoot, SOURCE_ROOT);
      events.push("suspend");
      return { suspended: true };
    },
    reactivateImpl: async ({
      config: actualConfig,
      paths: actualPaths,
      codexPath,
      sourceRoot,
    }) => {
      assert.equal(actualConfig, config);
      assert.equal(actualPaths, paths);
      assert.equal(codexPath, CODEX_PATH);
      assert.equal(sourceRoot, SOURCE_ROOT);
      events.push("reactivate");
      return { installed: true };
    },
    workflowImpl: async (options) => runFullRefreshWorkflow({
      ...options,
      operationId: "operation_1234567890",
      quitCodexImpl: async ({ stage }) => {
        events.push(`quit:${stage}`);
      },
      openNativeCodexImpl: async () => {
        events.push("open-native");
      },
      inspectAccountCacheImpl: async (input) => {
        cacheReads += 1;
        events.push(cacheReads === 1 ? "cache-baseline" : "cache-refreshed");
        if (cacheReads === 2) {
          assert.equal(input.codexClientVersion, "0.151.0");
        }
        return {
          ready: true,
          status: "ready",
          source: "codex-account-cache",
          codexClientVersion: "0.151.0",
          cacheClientVersion: "0.151.0",
          fetchedAt:
            cacheReads === 1
              ? "2026-09-02T08:00:00.000Z"
              : "2026-09-02T08:01:00.000Z",
          catalog: { models: [{ slug: "gpt-test" }] },
        };
      },
      finalOpenImpl: async () => {
        events.push("open-final");
      },
      nowImpl: () => new Date("2026-09-02T08:02:00.000Z"),
      sleepImpl: async () => {
        assert.fail("the refreshed cache should be accepted without polling delay");
      },
      readCheckpointImpl: async ({ checkpointPath }) => {
        assert.equal(checkpointPath, fullRefreshPaths.checkpointPath);
        return checkpoint;
      },
      writeCheckpointImpl: async ({ checkpoint: next }) => {
        checkpoint = next;
        return next;
      },
      removeCheckpointImpl: async () => {
        assert.fail("successful workflow must leave cleanup ownership intact");
      },
    }),
    withLockImpl: async (actualPaths, operation) => {
      assert.equal(actualPaths, distributionPaths);
      events.push("lock-enter");
      const lockedResult = await operation();
      events.push("lock-exit");
      return lockedResult;
    },
    cleanupImpl: async (options) => {
      cleanupOptions = options;
      assert.equal(checkpoint.phase, "completed");
      checkpoint = null;
      events.push("artifacts-cleaned");
    },
    reportImpl: (message) => {
      reports.push(message);
    },
  });

  assert.equal(distributionReads, 4);
  assert.equal(cacheReads, 2);
  assert.equal(checkpoint, null);
  assert.deepEqual(events, [
    "lock-enter",
    "cache-baseline",
    "quit:before-suspend",
    "suspend",
    "open-native",
    "cache-refreshed",
    "quit:before-reactivation",
    "reactivate",
    "open-final",
    "artifacts-cleaned",
    "lock-exit",
  ]);
  assert.equal(result.completed, true);
  assert.equal(result.clientVersion, "0.151.0");
  assert.equal(result.refreshedCacheFetchedAt, "2026-09-02T08:01:00.000Z");
  assert.equal(cleanupOptions.successful, true);
  assert.equal(cleanupOptions.checkpointPath, fullRefreshPaths.checkpointPath);
  assert.deepEqual(reports.slice(0, -1), [
    "PickerMux full refresh: first-quit-complete",
    "PickerMux full refresh: suspended",
    "PickerMux full refresh: native-opened",
    "PickerMux full refresh: cache-refreshed",
    "PickerMux full refresh: second-quit-complete",
    "PickerMux full refresh: reactivated",
    "PickerMux full refresh: completed",
  ]);
  assert.match(reports.at(-1), /completed.*Codex reopened with PickerMux active/iu);
});

test("full-refresh worker retains a resumable checkpoint after mutation", async () => {
  const fullRefreshPaths = fixtureFullRefreshPaths();
  const cleanupCalls = [];
  const reports = [];

  await assert.rejects(
    executeFullRefreshWorker({
      checkpointPath: fullRefreshPaths.checkpointPath,
      paths: fixturePaths(),
      distributionPaths: fixtureDistributionPaths(),
      fullRefreshPaths,
      sourceRoot: SOURCE_ROOT,
      validateDistributionImpl: async () => distributionSnapshot(),
      workflowImpl: async () => {
        throw new Error("simulated post-suspension failure");
      },
      withLockImpl: async (_paths, operation) => operation(),
      readCheckpointImpl: async () => ({ phase: "suspended" }),
      cleanupImpl: async (options) => {
        cleanupCalls.push(options);
      },
      reportImpl: (message) => reports.push(message),
    }),
    /simulated post-suspension failure/iu,
  );

  assert.equal(cleanupCalls.length, 1);
  assert.equal(cleanupCalls[0].successful, false);
  assert.match(reports.at(-1), /paused at suspended.*rerun.*to resume/iu);
});

test("terminal helper cleanup failure is not reclassified as a workflow failure", async () => {
  const fullRefreshPaths = fixtureFullRefreshPaths();
  const reports = [];
  const events = [];
  let checkpointReads = 0;
  let cleanupCalls = 0;
  const cleanupError = new Error("simulated receipt-bound cleanup failure");

  await assert.rejects(
    executeFullRefreshWorker({
      checkpointPath: fullRefreshPaths.checkpointPath,
      paths: fixturePaths(),
      distributionPaths: fixtureDistributionPaths(),
      fullRefreshPaths,
      sourceRoot: SOURCE_ROOT,
      validateDistributionImpl: async () => distributionSnapshot(),
      workflowImpl: async () => {
        events.push("workflow-completed");
        return { completed: true };
      },
      withLockImpl: async (_paths, operation) => {
        events.push("lock-enter");
        try {
          return await operation();
        } finally {
          events.push("lock-exit");
        }
      },
      readCheckpointImpl: async () => {
        checkpointReads += 1;
      },
      cleanupImpl: async ({ successful }) => {
        cleanupCalls += 1;
        assert.equal(successful, true);
        events.push("cleanup");
        throw cleanupError;
      },
      reportImpl: (message) => reports.push(message),
    }),
    (error) => {
      assert.match(error.message, /completed but helper cleanup was incomplete/iu);
      assert.equal(error.cause, cleanupError);
      return true;
    },
  );

  assert.equal(checkpointReads, 0);
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(events, [
    "lock-enter",
    "workflow-completed",
    "cleanup",
    "lock-exit",
  ]);
  assert.match(reports.at(-2), /full refresh completed.*Codex reopened/iu);
  assert.match(reports.at(-1), /completed.*helper cleanup is incomplete/iu);
});

test("full-refresh worker waits boundedly for the scheduler lock handoff", async () => {
  const fullRefreshPaths = fixtureFullRefreshPaths();
  const sleeps = [];
  const events = [];
  let lockAttempts = 0;
  const result = await executeFullRefreshWorker({
    checkpointPath: fullRefreshPaths.checkpointPath,
    paths: fixturePaths(),
    distributionPaths: fixtureDistributionPaths(),
    fullRefreshPaths,
    sourceRoot: SOURCE_ROOT,
    validateDistributionImpl: async () => distributionSnapshot(),
    workflowImpl: async () => {
      events.push("workflow");
      return { completed: true };
    },
    withLockImpl: async (_paths, operation) => {
      lockAttempts += 1;
      if (lockAttempts === 1) {
        const vanished = new Error("scheduler lock disappeared during handoff");
        vanished.code = "ENOENT";
        throw vanished;
      }
      if (lockAttempts === 2) {
        const stillBusy = new Error("scheduler still owns the lock");
        stillBusy.code = "PICKERMUX_INSTALLATION_LOCK_BUSY";
        throw stillBusy;
      }
      events.push("lock-enter");
      const lockedResult = await operation();
      events.push("lock-exit");
      return lockedResult;
    },
    lockSleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    cleanupImpl: async ({ successful }) => {
      assert.equal(successful, true);
      events.push("cleanup");
    },
    reportImpl: () => {},
  });

  assert.deepEqual(result, { completed: true });
  assert.equal(lockAttempts, 3);
  assert.deepEqual(sleeps, [100, 100]);
  assert.deepEqual(events, ["lock-enter", "workflow", "cleanup", "lock-exit"]);
});

test("full-refresh worker lock timeout leaves recovery artifacts untouched", async () => {
  const fullRefreshPaths = fixtureFullRefreshPaths();
  let lockAttempts = 0;
  let workflowCalls = 0;
  let checkpointReads = 0;
  let cleanupCalls = 0;
  let sleepCalls = 0;

  await assert.rejects(
    executeFullRefreshWorker({
      checkpointPath: fullRefreshPaths.checkpointPath,
      paths: fixturePaths(),
      distributionPaths: fixtureDistributionPaths(),
      fullRefreshPaths,
      sourceRoot: SOURCE_ROOT,
      validateDistributionImpl: async () => distributionSnapshot(),
      workflowImpl: async () => {
        workflowCalls += 1;
      },
      withLockImpl: async () => {
        lockAttempts += 1;
        const busy = new Error("lifecycle lock remained busy");
        busy.code = "PICKERMUX_INSTALLATION_LOCK_BUSY";
        throw busy;
      },
      lockSleepImpl: async () => {
        sleepCalls += 1;
      },
      readCheckpointImpl: async () => {
        checkpointReads += 1;
      },
      cleanupImpl: async () => {
        cleanupCalls += 1;
      },
      reportImpl: () => {},
    }),
    (error) => error?.code === "PICKERMUX_INSTALLATION_LOCK_BUSY",
  );

  assert.equal(lockAttempts, 200);
  assert.equal(sleepCalls, 199);
  assert.equal(workflowCalls, 0);
  assert.equal(checkpointReads, 0);
  assert.equal(cleanupCalls, 0);
});

test("unreadable worker checkpoint is retained and never classified as pre-mutation absence", async () => {
  const fullRefreshPaths = fixtureFullRefreshPaths();
  const cleanupCalls = [];
  const reports = [];
  const workflowError = new Error("simulated post-mutation failure");
  const checkpointError = new Error("transient checkpoint read failure");

  await assert.rejects(
    executeFullRefreshWorker({
      checkpointPath: fullRefreshPaths.checkpointPath,
      paths: fixturePaths(),
      distributionPaths: fixtureDistributionPaths(),
      fullRefreshPaths,
      sourceRoot: SOURCE_ROOT,
      validateDistributionImpl: async () => distributionSnapshot(),
      workflowImpl: async () => {
        throw workflowError;
      },
      withLockImpl: withImmediateLock,
      readCheckpointImpl: async () => {
        throw checkpointError;
      },
      cleanupImpl: async (options) => {
        cleanupCalls.push(options);
      },
      reportImpl: (message) => reports.push(message),
    }),
    (error) => {
      assert.match(error.message, /recovery checkpoint could not be read/iu);
      assert.ok(error.cause instanceof AggregateError);
      assert.deepEqual(error.cause.errors, [workflowError, checkpointError]);
      return true;
    },
  );

  assert.equal(cleanupCalls.length, 1);
  assert.equal(cleanupCalls[0].successful, false);
  assert.match(reports.at(-1), /unreadable recovery state.*retained/iu);
});

test("full-refresh worker cleans helper artifacts when ownership drifts before mutation", async () => {
  const fullRefreshPaths = fixtureFullRefreshPaths();
  let distributionRead = 0;
  let workflowCalls = 0;
  let checkpointReads = 0;
  let cleanupOptions;
  const reports = [];

  await assert.rejects(
    executeFullRefreshWorker({
      checkpointPath: fullRefreshPaths.checkpointPath,
      paths: fixturePaths(),
      distributionPaths: fixtureDistributionPaths(),
      fullRefreshPaths,
      sourceRoot: SOURCE_ROOT,
      validateDistributionImpl: async () => {
        distributionRead += 1;
        return distributionRead === 1
          ? distributionSnapshot("stable")
          : distributionSnapshot("changed");
      },
      workflowImpl: async () => {
        workflowCalls += 1;
      },
      withLockImpl: async (_paths, operation) => operation(),
      readCheckpointImpl: async () => {
        checkpointReads += 1;
        return { phase: "prepared" };
      },
      cleanupImpl: async (options) => {
        cleanupOptions = options;
      },
      reportImpl: (message) => reports.push(message),
    }),
    /CLI ownership state changed before integration removal/iu,
  );

  assert.equal(workflowCalls, 0);
  assert.equal(checkpointReads, 0);
  assert.equal(cleanupOptions.successful, true);
  assert.match(reports.at(-1), /stopped before integration mutation/iu);
});
