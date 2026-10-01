import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { bridgeBaseUrl, readRuntime, writeRuntime } from "../src/bridge-runtime.mjs";
import {
  deactivatePickerMuxIntegration,
  resolveIntegrationReactivationRuntime,
  assertRetainedIntegrationRuntime,
  reactivatePickerMuxAfterFullRefresh,
  setupPickerMux,
  suspendPickerMuxForFullRefresh,
} from "../src/cli.mjs";
import { createCompactionEnvelopeCodec } from "../src/compaction-envelope.mjs";
import { CompanionControlError, companionFailure } from "../src/companion-control.mjs";
import {
  CONFIG_MARKERS,
  getConfigStatus,
  installConfig,
  inventoryConfigIntegrationSwitch,
  inventoryDeactivatedConfigReactivation,
  previewConfigIntegration,
  restoreRecoveredProviderEndMarker,
  uninstallConfig,
} from "../src/config-manager.mjs";
import { resolveDistributionPaths } from "../src/paths.mjs";

test("companion lifecycle switches an Ollama picker, suspends natively, resumes the opaque receipt and restores the original integration", async (t) => {
  const fixture = await makeFixture(t);
  await installForeignPicker(fixture);
  const originalState = JSON.parse(await readFile(fixture.paths.statePath, "utf8"));
  const events = [];
  const suspended = await suspendPickerMuxForFullRefresh({
    ...fixture.lifecycle(),
    stopServiceImpl: async () => {
      events.push("service-stopped");
      assert.equal((await getConfigStatus(fixture.configPaths())).installed, true);
      return { stopped: true };
    },
  });
  assert.equal(suspended.suspended, true);
  const nativeConfig = await readFile(fixture.paths.configPath, "utf8");
  assert.doesNotMatch(nativeConfig, /openai_base_url|model_catalog_json|model_provider =|private-model|lm-studio-model-router:p2/u);
  assert.match(nativeConfig, /desktop.enabled-reasoning-efforts/u);
  assert.match(nativeConfig, /model_providers.historical_alias/u);
  assert.equal((await getConfigStatus(fixture.configPaths())).status, "suspended");

  const nextRuntime = { ...fixture.runtime, capability: "b".repeat(32) };
  const resumed = await reactivatePickerMuxAfterFullRefresh({
    ...fixture.lifecycle(),
    installImpl: async (options) => {
      events.push("integration-reactivated");
      assert.equal(options.paths, fixture.paths);
      assert.equal(options.sourceRoot, fixture.sourceRoot);
      assert.ok(options.reactivationReceipt);
      assert.deepEqual(Object.keys(options.reactivationReceipt), []);
      const installed = await installConfig(fixture.installOptions({
        reactivationReceipt: options.reactivationReceipt,
        runtime: nextRuntime,
      }));
      return { installed, restartRequired: true };
    },
  });
  assert.equal(resumed.restartRequired, true);
  const active = await getConfigStatus(fixture.configPaths());
  assert.equal(active.healthy, true);
  assert.equal(active.baseUrl, bridgeBaseUrl(fixture.config, nextRuntime));
  const state = JSON.parse(await readFile(fixture.paths.statePath, "utf8"));
  assert.equal(state.backupPath, originalState.backupPath);
  assert.equal(state.sourceSha256, originalState.sourceSha256);
  assert.deepEqual(state.priorAssignments, originalState.priorAssignments);
  assert.equal(state.suspension, undefined);
  await uninstallConfig(fixture.configPaths());
  assert.equal(await readFile(fixture.paths.configPath, "utf8"), fixture.original);
  assert.deepEqual(events, ["service-stopped", "integration-reactivated"]);
});

test("companion suspension rolls back a committed config transaction before restoring the bridge if its final status check fails", async (t) => {
  const fixture = await makeFixture(t);
  await installForeignPicker(fixture);
  const beforeConfig = await readFile(fixture.paths.configPath);
  const beforeState = await readFile(fixture.paths.statePath);
  const events = [];
  let statusRead = 0;
  await assert.rejects(suspendPickerMuxForFullRefresh({
    ...fixture.lifecycle(),
    configStatusImpl: async (options) => {
      const status = await getConfigStatus(options);
      statusRead += 1;
      if (statusRead === 2) {
        assert.equal(status.status, "suspended");
        events.push("postcommit-check-failed");
        return { ...status, healthy: false };
      }
      return status;
    },
    stopServiceImpl: async () => {
      events.push("service-stopped");
      return { stopped: true };
    },
    serviceStatusImpl: async () => ({ loaded: false, healthy: false }),
    startServiceImpl: async ({ runtime }) => {
      events.push("service-restored");
      assert.equal(runtime, fixture.runtime);
      assert.deepEqual(await readFile(fixture.paths.configPath), beforeConfig);
      assert.deepEqual(await readFile(fixture.paths.statePath), beforeState);
      return { healthy: true };
    },
  }), /suspension failed; the managed bridge service was restored/u);
  assert.deepEqual(await readFile(fixture.paths.configPath), beforeConfig);
  assert.deepEqual(await readFile(fixture.paths.statePath), beforeState);
  assert.equal((await getConfigStatus(fixture.configPaths())).healthy, true);
  assert.deepEqual(events, ["service-stopped", "postcommit-check-failed", "service-restored"]);
});

test("companion suspension leaves the service stopped when a contributor edit prevents postcommit rollback", async (t) => {
  const fixture = await makeFixture(t);
  await installForeignPicker(fixture);
  let statusRead = 0;
  let starts = 0;
  let changed;
  await assert.rejects(suspendPickerMuxForFullRefresh({
    ...fixture.lifecycle(),
    configStatusImpl: async (options) => {
      const status = await getConfigStatus(options);
      statusRead += 1;
      if (statusRead === 2) {
        changed = `${await readFile(fixture.paths.configPath, "utf8")}# contributor native edit\n`;
        await writeFile(fixture.paths.configPath, changed);
        return { ...status, healthy: false };
      }
      return status;
    },
    stopServiceImpl: async () => ({ stopped: true }),
    startServiceImpl: async () => { starts += 1; },
  }), /service rollback was incomplete/u);
  assert.equal(starts, 0);
  assert.equal(await readFile(fixture.paths.configPath, "utf8"), changed);
  assert.equal((await getConfigStatus(fixture.configPaths())).status, "suspension-conflict");
});

test("companion reactivation refuses an edited native suspension before calling installation", async (t) => {
  const fixture = await makeFixture(t);
  await installForeignPicker(fixture);
  await suspendPickerMuxForFullRefresh(fixture.lifecycle());
  const native = await readFile(fixture.paths.configPath, "utf8");
  await writeFile(fixture.paths.configPath, `${native}# contributor edit\n`);
  let installs = 0;
  await assert.rejects(reactivatePickerMuxAfterFullRefresh({
    ...fixture.lifecycle(),
    installImpl: async () => { installs += 1; },
  }), /refuses inconsistent integration state.*suspension-conflict/u);
  assert.equal(installs, 0);
});

test("companion reactivation can retry after the installed configuration is rolled back following failed validation", async (t) => {
  const fixture = await makeFixture(t);
  await installForeignPicker(fixture);
  await suspendPickerMuxForFullRefresh(fixture.lifecycle());
  const nativeConfig = await readFile(fixture.paths.configPath);
  const nativeState = await readFile(fixture.paths.statePath);
  await assert.rejects(reactivatePickerMuxAfterFullRefresh({
    ...fixture.lifecycle(),
    installImpl: async ({ reactivationReceipt }) => {
      const installed = await installConfig(fixture.installOptions({ reactivationReceipt }));
      await installed.rollback();
      throw new Error("injected post-install validation failure");
    },
  }), /injected post-install validation failure/u);
  assert.deepEqual(await readFile(fixture.paths.configPath), nativeConfig);
  assert.deepEqual(await readFile(fixture.paths.statePath), nativeState);
  await reactivatePickerMuxAfterFullRefresh({
    ...fixture.lifecycle(),
    installImpl: ({ reactivationReceipt }) => installConfig(fixture.installOptions({ reactivationReceipt })),
  });
  assert.equal((await getConfigStatus(fixture.configPaths())).installed, true);
});

test("companion setup rejects a stale preview before repairing a recovered marker after the account-cache check", async (t) => {
  const fixture = await makeFixture(t);
  await installForeignPicker(fixture);
  const installed = await readFile(fixture.paths.configPath, "utf8");
  const damaged = installed.replace(CONFIG_MARKERS.providerEnd, "");
  assert.notEqual(damaged, installed);
  await writeFile(fixture.paths.configPath, damaged);
  const state = await readFile(fixture.paths.statePath);
  const preview = await previewConfigIntegration(fixture.configPaths());
  assert.equal(preview.canApply, true);
  assert.equal((await getConfigStatus(fixture.configPaths())).status, "installed-marker-recovered");
  const distributionPaths = resolveDistributionPaths({ HOME: path.dirname(fixture.paths.codexHome), CODEX_HOME: fixture.paths.codexHome });
  const concurrent = `${damaged}# contributor edit during account-cache check\n`;
  let preflights = 0;
  let repairs = 0;

  await assert.rejects(setupPickerMux({
    paths: fixture.paths,
    distributionPaths,
    sourceRoot: fixture.sourceRoot,
    codexPath: "/fixture/codex",
    desktopRunningImpl: async () => false,
    accountCacheImpl: async () => {
      await writeFile(fixture.paths.configPath, concurrent);
      assert.equal((await getConfigStatus(fixture.configPaths())).status, "installed-marker-recovered");
      const error = new Error("The account cache must be refreshed");
      error.code = "CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED";
      throw error;
    },
    configurationPreflightImpl: async () => {
      preflights += 1;
      if (preflights === 2) assert.equal(await readFile(distributionPaths.lockPath, "utf8"), `${process.pid}\n`);
      const current = await previewConfigIntegration(fixture.configPaths());
      if (!current.canApply || current.previewToken !== preview.previewToken) throw new CompanionControlError("CONFIGURATION_CONFLICT");
    },
    repairConfigImpl: async (options) => {
      repairs += 1;
      return restoreRecoveredProviderEndMarker(options);
    },
    setupImpl: async () => assert.fail("A stale preview must stop before distribution setup"),
  }), { code: "CONFIGURATION_CONFLICT" });
  assert.equal(preflights, 2);
  assert.equal(repairs, 0);
  assert.equal(await readFile(fixture.paths.configPath, "utf8"), concurrent);
  assert.deepEqual(await readFile(fixture.paths.statePath), state);
  assert.equal((await getConfigStatus(fixture.configPaths())).status, "installed-marker-recovered");
  await assert.rejects(readFile(distributionPaths.lockPath), { code: "ENOENT" });
});

test("companion setup repairs the confirmed recovered marker under its lock and aborts for the missing account cache", async (t) => {
  const fixture = await makeFixture(t);
  await installForeignPicker(fixture);
  const installed = await readFile(fixture.paths.configPath, "utf8");
  const damaged = installed.replace(CONFIG_MARKERS.providerEnd, "");
  assert.notEqual(damaged, installed);
  await writeFile(fixture.paths.configPath, damaged);
  const state = await readFile(fixture.paths.statePath);
  const preview = await previewConfigIntegration(fixture.configPaths());
  assert.equal(preview.canApply, true);
  const distributionPaths = resolveDistributionPaths({ HOME: path.dirname(fixture.paths.codexHome), CODEX_HOME: fixture.paths.codexHome });
  let preflights = 0;
  let repairs = 0;

  await assert.rejects(setupPickerMux({
    paths: fixture.paths,
    distributionPaths,
    sourceRoot: fixture.sourceRoot,
    codexPath: "/fixture/codex",
    desktopRunningImpl: async () => false,
    accountCacheImpl: async () => {
      const error = new Error("The account cache must be refreshed");
      error.code = "CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED";
      throw error;
    },
    configurationPreflightImpl: async () => {
      preflights += 1;
      if (preflights === 2) assert.equal(await readFile(distributionPaths.lockPath, "utf8"), `${process.pid}\n`);
      const current = await previewConfigIntegration(fixture.configPaths());
      if (!current.canApply || current.previewToken !== preview.previewToken) throw new CompanionControlError("CONFIGURATION_CONFLICT");
    },
    repairConfigImpl: async (options) => {
      repairs += 1;
      assert.equal(preflights, 2);
      assert.equal(await readFile(distributionPaths.lockPath, "utf8"), `${process.pid}\n`);
      return restoreRecoveredProviderEndMarker(options);
    },
    setupImpl: async () => assert.fail("The missing account cache must stop before distribution setup"),
  }), /receipt-verified missing provider end marker was restored.*installed PickerMux CLI can uninstall safely/iu);
  assert.equal(preflights, 2);
  assert.equal(repairs, 1);
  const repaired = await readFile(fixture.paths.configPath, "utf8");
  assert.equal(repaired.replace(`${CONFIG_MARKERS.providerEnd}\n`, ""), damaged);
  assert.deepEqual(await readFile(fixture.paths.statePath), state);
  assert.equal((await getConfigStatus(fixture.configPaths())).status, "installed");
  await assert.rejects(readFile(distributionPaths.lockPath), { code: "ENOENT" });
});

async function installForeignPicker(fixture) {
  await writeFile(fixture.paths.configPath, fixture.original);
  const preview = await previewConfigIntegration(fixture.configPaths());
  assert.equal(preview.status, "ollama");
  const integrationSwitchReceipt = await inventoryConfigIntegrationSwitch({
    ...fixture.configPaths(),
    expectedPreviewToken: preview.previewToken,
  });
  return installConfig(fixture.installOptions({ integrationSwitchReceipt }));
}

async function makeFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "pickermux-companion-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const codexHome = path.join(directory, "codex");
  const installDirectory = path.join(codexHome, "model-bridge");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const paths = {
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
    launchAgentPath: path.join(directory, "bridge.plist"),
    launchAgentLabel: "com.local.pickermux-companion-fixture",
  };
  const config = {
    schemaVersion: 2,
    bridge: {
      host: "127.0.0.1",
      port: 4210,
      providerId: "model_bridge",
      defaultModel: "gpt-5.6-sol",
      reasoningEffort: "low",
      limits: { streamIdleTimeoutMs: 300000 },
    },
    providers: [],
  };
  const runtime = {
    version: 1,
    instanceId: "companion-test-instance",
    capability: "a".repeat(32),
    configPath: paths.serviceConfigPath,
  };
  const sourceRoot = path.join(directory, "source");
  const original = [
    'model = "private-model"',
    'model_catalog_json = "/private/fixture/ollama-launch-models.json"',
    'openai_base_url = "http://127.0.0.1:11434/api/codex/v1"',
    'desktop.enabled-reasoning-efforts = ["none", "max"]',
    "[model_providers.historical_alias]",
    'name = "Historical alias"',
    "",
  ].join("\n");
  return {
    config,
    paths,
    runtime,
    sourceRoot,
    original,
    configPaths: () => ({ configPath: paths.configPath, statePath: paths.statePath, backupDirectory: paths.backupDirectory }),
    installOptions: ({ runtime: selectedRuntime = runtime, ...overrides } = {}) => ({
      configPath: paths.configPath,
      statePath: paths.statePath,
      backupDirectory: paths.backupDirectory,
      model: config.bridge.defaultModel,
      modelReasoningEffort: config.bridge.reasoningEffort,
      modelProvider: config.bridge.providerId,
      modelCatalogJson: paths.catalogPath,
      provider: {
        id: config.bridge.providerId,
        name: "OpenAI",
        baseUrl: bridgeBaseUrl(config, selectedRuntime),
        wireApi: "responses",
        requiresOpenAiAuth: true,
        supportsWebsockets: false,
        supportsStandaloneWebSearch: true,
        requestMaxRetries: 0,
        streamMaxRetries: 0,
        streamIdleTimeoutMs: config.bridge.limits.streamIdleTimeoutMs,
      },
      now: new Date("2026-10-01T08:00:00.000Z"),
      ...overrides,
    }),
    lifecycle: () => ({
      config,
      paths,
      sourceRoot,
      runtimeImpl: async () => runtime,
      validateLaunchAgentImpl: async () => ({ present: true, nodePath: "/fixture/node" }),
      inventoryRuntimeImpl: async () => ({ exists: true }),
      stopServiceImpl: async () => ({ stopped: true }),
      serviceStatusImpl: async () => ({ loaded: false, healthy: false }),
      startServiceImpl: async () => ({ healthy: true }),
    }),
  };
}


function deactivationOptions(fixture, overrides = {}) {
  return { ...fixture.lifecycle(), desktopRunningImpl: async () => false, assertNoPendingFullRefreshImpl: async () => null, ...overrides };
}

test("OFF retains service settings, runtime capability and compaction key across confirmed setup reactivation", async (t) => {
  const fixture = await makeFixture(t);
  await installForeignPicker(fixture);
  await writeRuntime(fixture.paths.runtimePath, fixture.runtime);
  await writeFile(fixture.paths.serviceConfigPath, JSON.stringify(fixture.config), { mode: 0o600 });
  const runtimeBytes = await readFile(fixture.paths.runtimePath);
  const configBytes = await readFile(fixture.paths.serviceConfigPath);
  const baseline = JSON.parse(await readFile(fixture.paths.statePath));
  const binding = JSON.stringify({ provider: "fixture", model: "example/model", context: 32768 });
  const summary = "A test-only preserved decision.";
  const envelope = createCompactionEnvelopeCodec(fixture.runtime.capability).seal(summary, binding);
  let stops = 0;
  const result = await deactivatePickerMuxIntegration(deactivationOptions(fixture, {
    stopServiceImpl: async (options) => { stops += 1; assert.equal(options.removeRuntime, false); return { stopped: true }; },
  }));
  assert.equal(result.deactivated, true);
  assert.equal(result.status, "deactivated");
  assert.equal(stops, 1);
  assert.deepEqual(await readFile(fixture.paths.runtimePath), runtimeBytes);
  assert.deepEqual(await readFile(fixture.paths.serviceConfigPath), configBytes);
  let sourceConfig;
  let installs = 0;
  await setupPickerMux({
    ...fixture.lifecycle(), codexPath: "/fixture/codex", distributionPaths: {},
    desktopRunningImpl: async () => false, accountCacheImpl: async () => ({ status: "ready" }),
    loadConfigImpl: async (selected) => { sourceConfig = selected; return fixture.config; },
    discoverImpl: async () => ({ models: [{ id: "fixture/model" }] }),
    setupImpl: async ({ beforeControlCommit, activate }) => { await beforeControlCommit(); await activate({ distributionRoot: fixture.sourceRoot, version: "0.9.0" }); return { version: "0.9.0" }; },
    installImpl: async ({ reactivationReceipt }) => {
      installs += 1;
      const runtime = await resolveIntegrationReactivationRuntime({ paths: fixture.paths, status: await getConfigStatus(fixture.configPaths()), reactivationReceipt });
      assert.equal(runtime.capability, fixture.runtime.capability);
      assert.equal(createCompactionEnvelopeCodec(runtime.capability).open(envelope, binding), summary);
      return installConfig(fixture.installOptions({ reactivationReceipt, runtime }));
    },
  });
  assert.equal(sourceConfig, fixture.paths.serviceConfigPath);
  assert.equal(installs, 1);
  const state = JSON.parse(await readFile(fixture.paths.statePath));
  assert.equal(state.backupPath, baseline.backupPath);
  assert.deepEqual(state.priorAssignments, baseline.priorAssignments);
  assert.deepEqual(await readFile(fixture.paths.runtimePath), runtimeBytes);
  await uninstallConfig(fixture.configPaths());
  assert.equal(await readFile(fixture.paths.configPath, "utf8"), fixture.original);
});

test("failed OFF rolls back configuration before restoring the same runtime and service", async (t) => {
  const fixture = await makeFixture(t);
  await installForeignPicker(fixture);
  const original = await readFile(fixture.paths.configPath);
  let reads = 0;
  let starts = 0;
  await assert.rejects(deactivatePickerMuxIntegration(deactivationOptions(fixture, {
    configStatusImpl: async (options) => {
      const status = await getConfigStatus(options);
      reads += 1;
      return reads === 2 ? { ...status, healthy: false } : status;
    },
    startServiceImpl: async ({ runtime }) => { starts += 1; assert.equal(runtime, fixture.runtime); assert.deepEqual(await readFile(fixture.paths.configPath), original); return { healthy: true }; },
  })), { code: "DEACTIVATION_FAILED" });
  assert.equal(starts, 1);
  assert.equal((await getConfigStatus(fixture.configPaths())).installed, true);
});

test("OFF rollback never overwrites contributor edits or starts an unproven configuration", async (t) => {
  const fixture = await makeFixture(t);
  await installForeignPicker(fixture);
  let reads = 0;
  let starts = 0;
  let changed;
  await assert.rejects(deactivatePickerMuxIntegration(deactivationOptions(fixture, {
    configStatusImpl: async (options) => {
      const status = await getConfigStatus(options);
      reads += 1;
      if (reads === 2) { changed = `${await readFile(fixture.paths.configPath, "utf8")}# concurrent edit\n`; await writeFile(fixture.paths.configPath, changed); return { ...status, healthy: false }; }
      return status;
    },
    startServiceImpl: async () => { starts += 1; },
  })), { code: "DEACTIVATION_ROLLBACK_FAILED" });
  assert.equal(starts, 0);
  assert.equal(await readFile(fixture.paths.configPath, "utf8"), changed);
});

test("OFF refuses running Desktop, pending recovery and suspension collisions before stopping service", async (t) => {
  const fixture = await makeFixture(t);
  await installForeignPicker(fixture);
  for (const override of [
    { desktopRunningImpl: async () => true },
    { assertNoPendingFullRefreshImpl: async () => { throw new CompanionControlError("RECOVERY_PENDING"); } },
  ]) {
    let stops = 0;
    await assert.rejects(deactivatePickerMuxIntegration(deactivationOptions(fixture, { ...override, stopServiceImpl: async () => { stops += 1; } })));
    assert.equal(stops, 0);
  }
  await suspendPickerMuxForFullRefresh(fixture.lifecycle());
  let stops = 0;
  await assert.rejects(deactivatePickerMuxIntegration(deactivationOptions(fixture, { stopServiceImpl: async () => { stops += 1; } })), { code: "CONFIGURATION_CONFLICT" });
  assert.equal(stops, 0);
});

test("OFF repeats stopped-Desktop and recovery checks before its configuration CAS commit", async (t) => {
  for (const collision of ["desktop", "recovery"]) {
    const fixture = await makeFixture(t);
    await installForeignPicker(fixture);
    const before = await readFile(fixture.paths.configPath);
    let checks = 0;
    let starts = 0;
    await assert.rejects(deactivatePickerMuxIntegration(deactivationOptions(fixture, {
      assertNoPendingFullRefreshImpl: async () => { if (collision === "recovery" && ++checks === 3) throw new CompanionControlError("RECOVERY_PENDING"); },
      desktopRunningImpl: async () => collision === "desktop" && ++checks === 3,
      startServiceImpl: async () => { starts += 1; return { healthy: true }; },
    })), { code: collision === "desktop" ? "CODEX_RUNNING" : "RECOVERY_PENDING" });
    assert.equal(starts, 1);
    assert.deepEqual(await readFile(fixture.paths.configPath), before);
  }
});

test("fresh setup emits actionable provider, loaded-model and account-cache failures without activation", async (t) => {
  for (const [discoverImpl, code] of [
    [async () => { throw new Error("PRIVATE_ENDPOINT_CANARY"); }, "PROVIDER_UNAVAILABLE"],
    [async () => ({ models: [], providers: [{ unavailableReason: "connection-refused" }] }), "PROVIDER_UNAVAILABLE"],
    [async () => ({ models: [] }), "NO_LOADED_MODELS"],
  ]) {
    const fixture = await makeFixture(t);
    await assert.rejects(setupPickerMux({
      ...fixture.lifecycle(), codexPath: "/fixture/codex", distributionPaths: {},
      desktopRunningImpl: async () => false, accountCacheImpl: async () => ({ status: "ready" }),
      loadConfigImpl: async () => fixture.config, discoverImpl,
      setupImpl: async () => assert.fail("Provider preflight must precede activation"),
    }), (error) => error.code === code && !error.message.includes("PRIVATE_ENDPOINT_CANARY"));
    await assert.rejects(readFile(fixture.paths.statePath), { code: "ENOENT" });
  }
  const fixture = await makeFixture(t);
  await assert.rejects(setupPickerMux({
    ...fixture.lifecycle(), desktopRunningImpl: async () => false,
    accountCacheImpl: async () => { throw Object.assign(new Error("PRIVATE_CACHE_CANARY"), { code: "CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED" }); },
    setupImpl: async () => assert.fail("Cache preflight must precede activation"),
  }), { code: "CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED" });
});

test("runtime reactivation and rollback reject missing, redirected or concurrently replaced identity without recreating state", async (t) => {
  const fixture = await makeFixture(t);
  await installForeignPicker(fixture);
  await deactivatePickerMuxIntegration(deactivationOptions(fixture));
  const receipt = await inventoryDeactivatedConfigReactivation(fixture.configPaths());
  const status = await getConfigStatus(fixture.configPaths());
  await assert.rejects(resolveIntegrationReactivationRuntime({ paths: fixture.paths, status }), { code: "CONFIGURATION_CONFLICT" });
  await assert.rejects(resolveIntegrationReactivationRuntime({ paths: fixture.paths, status, reactivationReceipt: receipt, runtimeImpl: async () => ({ ...fixture.runtime, configPath: "/foreign/config" }) }), { code: "CONFIGURATION_CONFLICT" });
  await assert.rejects(resolveIntegrationReactivationRuntime({ paths: fixture.paths, status, reactivationReceipt: receipt }));
  await assert.rejects(assertRetainedIntegrationRuntime({ paths: fixture.paths, runtime: fixture.runtime }));
  await assert.rejects(readFile(fixture.paths.runtimePath), { code: "ENOENT" });
  await writeRuntime(fixture.paths.runtimePath, fixture.runtime);
  assert.equal((await readRuntime(fixture.paths.runtimePath)).capability, fixture.runtime.capability);
  const before = await readFile(fixture.paths.runtimePath);
  await assertRetainedIntegrationRuntime({ paths: fixture.paths, runtime: fixture.runtime });
  assert.deepEqual(await readFile(fixture.paths.runtimePath), before);
  await writeRuntime(fixture.paths.runtimePath, { ...fixture.runtime, capability: "b".repeat(32) });
  const changed = await readFile(fixture.paths.runtimePath);
  await assert.rejects(assertRetainedIntegrationRuntime({ paths: fixture.paths, runtime: fixture.runtime }), { code: "CONFIGURATION_CONFLICT" });
  assert.deepEqual(await readFile(fixture.paths.runtimePath), changed);
});


test("partial OFF service-stop failure restores only proven owned service and runtime", async (t) => {
  for (const replacement of ["none", "foreign-agent", "new-runtime"]) {
    const fixture = await makeFixture(t);
    await installForeignPicker(fixture);
    const before = await readFile(fixture.paths.configPath);
    let starts = 0;
    let stopped = false;
    await assert.rejects(deactivatePickerMuxIntegration(deactivationOptions(fixture, {
      stopServiceImpl: async () => { stopped = true; throw new Error("injected post-bootout failure"); },
      runtimeImpl: async () => stopped && replacement === "new-runtime" ? { ...fixture.runtime, capability: "b".repeat(32) } : fixture.runtime,
      validateLaunchAgentImpl: async () => {
        if (stopped && replacement === "foreign-agent") throw new Error("foreign plist must be retained");
        return { present: true, nodePath: "/fixture/node", device: 1, inode: 2 };
      },
      startServiceImpl: async ({ runtime }) => { starts += 1; assert.equal(runtime, fixture.runtime); return { healthy: true }; },
    })), { code: replacement === "none" ? "DEACTIVATION_FAILED" : "DEACTIVATION_ROLLBACK_FAILED" });
    assert.equal(starts, replacement === "none" ? 1 : 0);
    assert.deepEqual(await readFile(fixture.paths.configPath), before);
    assert.equal((await getConfigStatus(fixture.configPaths())).installed, true);
  }
});


test("ON forwards stopped-Desktop/recovery guards to the final configuration CAS", async (t) => {
  for (const collision of ["desktop", "recovery"]) {
    const fixture = await makeFixture(t);
    await installForeignPicker(fixture);
    await deactivatePickerMuxIntegration(deactivationOptions(fixture));
    const beforeConfig = await readFile(fixture.paths.configPath);
    const beforeState = await readFile(fixture.paths.statePath);
    let installing = false;
    let bootstrap = false;
    await assert.rejects(setupPickerMux({
      ...fixture.lifecycle(), codexPath: "/fixture/codex", distributionPaths: {},
      desktopRunningImpl: async () => installing && collision === "desktop",
      assertNoPendingFullRefreshImpl: async () => { if (installing && collision === "recovery") throw new CompanionControlError("RECOVERY_PENDING"); },
      accountCacheImpl: async () => ({ status: "ready" }), loadConfigImpl: async () => fixture.config,
      discoverImpl: async () => ({ models: [{ id: "fixture/model" }] }),
      setupImpl: async ({ beforeControlCommit, activate }) => { await beforeControlCommit(); return activate({ distributionRoot: fixture.sourceRoot }); },
      installImpl: async ({ reactivationReceipt, beforeConfigCommit }) => {
        installing = true;
        await installConfig(fixture.installOptions({ reactivationReceipt, beforeConfigCommit }));
        bootstrap = true;
      },
    }), (error) => companionFailure(error).code === (collision === "desktop" ? "CODEX_RUNNING" : "RECOVERY_PENDING"));
    assert.equal(bootstrap, false);
    assert.deepEqual(await readFile(fixture.paths.configPath), beforeConfig);
    assert.deepEqual(await readFile(fixture.paths.statePath), beforeState);
  }
});


test("ON checks Desktop after the final awaited account-cache preflight", async (t) => {
  const fixture = await makeFixture(t);
  await installForeignPicker(fixture);
  await deactivatePickerMuxIntegration(deactivationOptions(fixture));
  const before = await readFile(fixture.paths.configPath);
  const state = await readFile(fixture.paths.statePath);
  let finalCommit = false;
  let desktopRunning = false;
  await assert.rejects(setupPickerMux({
    ...fixture.lifecycle(), distributionPaths: {}, codexPath: "/fixture/codex",
    desktopRunningImpl: async () => desktopRunning,
    accountCacheImpl: async () => { if (finalCommit) desktopRunning = true; return { status: "ready" }; },
    loadConfigImpl: async () => fixture.config, discoverImpl: async () => ({ models: [{ id: "fixture/model" }] }),
    setupImpl: async ({ beforeControlCommit, activate }) => { await beforeControlCommit(); return activate({ distributionRoot: fixture.sourceRoot }); },
    installImpl: async ({ reactivationReceipt, beforeConfigCommit }) => {
      finalCommit = true;
      return installConfig(fixture.installOptions({ reactivationReceipt, beforeConfigCommit }));
    },
  }), (error) => companionFailure(error).code === "CODEX_RUNNING");
  assert.deepEqual(await readFile(fixture.paths.configPath), before);
  assert.deepEqual(await readFile(fixture.paths.statePath), state);
});
