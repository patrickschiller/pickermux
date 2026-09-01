import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createRuntimeRecord,
  renderLaunchAgent,
  stopBridgeService,
  writeRuntime,
} from "../src/bridge-runtime.mjs";
import { installConfig } from "../src/config-manager.mjs";
import {
  credentialCommand,
  purgePickerMux,
  runCli,
  uninstallIntegration,
} from "../src/cli.mjs";
import {
  removeManagedDistribution,
  setupManagedDistribution,
  validateDistributionInstallation,
} from "../src/distribution-installer.mjs";
import {
  deleteProviderCredential,
  listRegisteredKeychainProviderIds,
  purgeKeychainProviderRegistry,
  registerKeychainProvider,
} from "../src/keychain-credentials.mjs";
import {
  resolveDistributionPaths,
  resolveInstallPaths,
} from "../src/paths.mjs";
import {
  inventoryPickerMuxBackups,
  purgePickerMuxBackups,
} from "../src/purge-data.mjs";
import { stageServicePackage } from "../src/service-package.mjs";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function fixturePaths() {
  const codexHome = "/private/tmp/pickermux-uninstall/codex-home";
  const installDirectory = path.join(codexHome, "model-bridge");
  return {
    codexHome,
    installDirectory,
    configPath: path.join(codexHome, "config.toml"),
    statePath: path.join(installDirectory, "state.json"),
    catalogPath: path.join(installDirectory, "models.json"),
    backupDirectory: path.join(installDirectory, "backups"),
    keychainRegistryPath: path.join(installDirectory, "keychain-state.json"),
    runtimePath: path.join(installDirectory, "runtime.json"),
    serviceConfigPath: path.join(installDirectory, "service-config.json"),
    compatibilityPath: path.join(installDirectory, "compatibility.json"),
    certificationPath: path.join(installDirectory, "certifications.json"),
    serviceDirectory: path.join(installDirectory, "runtime-app"),
    logPath: path.join(installDirectory, "bridge.log"),
    launchAgentPath: "/private/tmp/pickermux-uninstall/bridge.plist",
    launchAgentLabel: "com.local.codex-model-bridge",
  };
}

function distributionSnapshot(marker = "stable") {
  return {
    installed: true,
    activeDirectory: "/private/pickermux/versions/0.4.2",
    raw: Buffer.from(`receipt:${marker}`),
  };
}

function mockConfigOwnership(events) {
  const receipt = Object.freeze({ kind: "config-ownership-receipt" });
  return {
    inventoryConfigImpl: async () => {
      events?.push("config-inventoried");
      return receipt;
    },
    revalidateConfigImpl: async (actual) => {
      assert.equal(actual, receipt);
      events?.push("config-revalidated");
    },
  };
}

async function realLifecycleFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "pickermux-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = {
    HOME: path.join(root, "home"),
    CODEX_HOME: path.join(root, "codex-home"),
  };
  const distributionPaths = resolveDistributionPaths(environment);
  const paths = resolveInstallPaths(environment);
  await mkdir(paths.codexHome, { recursive: true, mode: 0o700 });
  await setupManagedDistribution({
    sourceRoot: PROJECT_ROOT,
    paths: distributionPaths,
    activate: async () => ({ action: "test-install" }),
  });
  return { root, paths, distributionPaths };
}

function realPurgeOptions(fixture, overrides = {}) {
  return {
    paths: fixture.paths,
    distributionPaths: fixture.distributionPaths,
    desktopRunningImpl: async () => false,
    validateLaunchAgentImpl: async () => ({ present: false }),
    inventoryInstallImpl: async () => ({ kind: "test-install-inventory" }),
    revalidateInstallImpl: async () => undefined,
    inventoryRuntimeImpl: async () => ({ kind: "test-runtime-inventory" }),
    revalidateRuntimeImpl: async () => undefined,
    uninstallIntegrationImpl: async () => ({
      removedConfig: { changed: false },
      artifacts: {},
    }),
    ...overrides,
  };
}

async function assertCliRejectsWithoutStdout(operation, validate) {
  const stdout = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    stdout.push(String(chunk));
    return true;
  };
  try {
    await assert.rejects(operation, validate);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.deepEqual(stdout, []);
}

test("full uninstall revalidates ownership and stages registry and backups before credential deletion", async () => {
  const events = [];
  const paths = fixturePaths();
  const distributionPaths = { receiptPath: "/private/receipt.json" };
  const distribution = distributionSnapshot();
  const installInventory = { exists: true, kind: "install-receipt" };
  const backupInventory = { exists: true, kind: "backup-receipt" };
  let providerReads = 0;
  const result = await purgePickerMux({
    paths,
    distributionPaths,
    desktopRunningImpl: async () => {
      events.push("desktop-closed");
      return false;
    },
    validateDistributionImpl: async ({ paths: actual }) => {
      events.push("distribution-validated");
      assert.equal(actual, distributionPaths);
      return distribution;
    },
    validateLaunchAgentImpl: async () => {
      events.push("launch-agent-validated");
      return { present: true };
    },
    inventoryInstallImpl: async () => {
      events.push("install-inventoried");
      return installInventory;
    },
    inventoryBackupsImpl: async () => {
      events.push("backups-inventoried");
      return backupInventory;
    },
    ...mockConfigOwnership(events),
    revalidateInstallImpl: async (inventory) => {
      assert.equal(inventory, installInventory);
      events.push("install-revalidated");
    },
    revalidateBackupsImpl: async (inventory) => {
      assert.equal(inventory, backupInventory);
      events.push("backups-revalidated");
    },
    revalidateRuntimeImpl: async (inventory) => {
      assert.deepEqual(inventory, { exists: true });
      events.push("runtime-revalidated");
    },
    inventoryRuntimeImpl: async () => {
      events.push("runtime-inventoried");
      return { exists: true };
    },
    listProviderIdsImpl: async () => {
      providerReads += 1;
      events.push("registry-inventoried");
      return ["alpha", "vendor_z"];
    },
    removeDistributionImpl: async ({
      paths: actual,
      beforeRemove,
      requireExclusiveApplicationDirectory,
    }) => {
      events.push("cli-staged");
      assert.equal(actual, distributionPaths);
      assert.equal(requireExclusiveApplicationDirectory, true);
      const beforeResult = await beforeRemove(distribution);
      events.push("cli-committed");
      return {
        beforeResult,
        removed: {
          cleanupPendingPath: null,
          versionsDirectoryRemoved: true,
          applicationDirectoryRemoved: true,
        },
      };
    },
    uninstallIntegrationImpl: async (options) => {
      assert.equal(options.installDirectoryInventory, installInventory);
      assert.equal(options.backupDirectoryInventory, backupInventory);
      assert.equal(options.runtimePreflightCompleted, true);
      assert.equal(options.configOwnershipReceipt?.kind, "config-ownership-receipt");
      events.push("integration-removed");
      return { removedConfig: { changed: true }, artifacts: {} };
    },
    deleteCredentialImpl: async (providerId) => {
      events.push(`credential-deleted:${providerId}`);
      return providerId === "alpha";
    },
    purgeBackupsImpl: async ({ beforeCommit, inventory }) => {
      assert.equal(inventory, backupInventory);
      events.push("backups-staged");
      await beforeCommit();
      events.push("backups-committed");
      return { changed: true, cleanupPendingPath: null };
    },
    purgeRegistryImpl: async ({ expectedProviderIds, beforeCommit }) => {
      events.push("registry-staged");
      assert.deepEqual(expectedProviderIds, ["alpha", "vendor_z"]);
      await beforeCommit();
      events.push("registry-committed");
      return { changed: true, cleanupPendingPath: null };
    },
    rmdirImpl: async () => {
      events.push("install-directory-removed");
    },
  });

  assert.equal(providerReads, 2);
  assert.deepEqual(result.beforeResult.credentials, [
    { providerId: "alpha", deleted: true },
    { providerId: "vendor_z", deleted: false },
  ]);
  assert.deepEqual(events, [
    "desktop-closed",
    "distribution-validated",
    "launch-agent-validated",
    "install-inventoried",
    "backups-inventoried",
    "config-inventoried",
    "runtime-inventoried",
    "registry-inventoried",
    "cli-staged",
    "desktop-closed",
    "launch-agent-validated",
    "install-revalidated",
    "backups-revalidated",
    "runtime-revalidated",
    "config-revalidated",
    "registry-inventoried",
    "registry-staged",
    "backups-staged",
    "credential-deleted:alpha",
    "credential-deleted:vendor_z",
    "integration-removed",
    "backups-committed",
    "registry-committed",
    "install-directory-removed",
    "cli-committed",
  ]);
});

test("full uninstall refuses registry drift before any integration or credential mutation", async () => {
  const distribution = distributionSnapshot();
  let providerReads = 0;
  let mutationCalls = 0;
  await assert.rejects(
    purgePickerMux({
      paths: fixturePaths(),
      distributionPaths: {},
      desktopRunningImpl: async () => false,
      validateDistributionImpl: async () => distribution,
      validateLaunchAgentImpl: async () => ({ present: true }),
      inventoryInstallImpl: async () => ({ exists: true }),
      inventoryBackupsImpl: async () => ({ exists: true }),
      ...mockConfigOwnership(),
      revalidateInstallImpl: async () => undefined,
      revalidateBackupsImpl: async () => undefined,
      revalidateRuntimeImpl: async () => undefined,
      inventoryRuntimeImpl: async () => ({ exists: true }),
      listProviderIdsImpl: async () => {
        providerReads += 1;
        return providerReads === 1 ? ["alpha"] : ["alpha", "beta"];
      },
      removeDistributionImpl: async ({ beforeRemove }) =>
        beforeRemove(distribution),
      uninstallIntegrationImpl: async () => {
        mutationCalls += 1;
      },
      deleteCredentialImpl: async () => {
        mutationCalls += 1;
      },
    }),
    /registry changed during full uninstall/iu,
  );
  assert.equal(mutationCalls, 0);
});

test("full uninstall refuses a running desktop before ownership checks", async () => {
  let validationCalls = 0;
  await assert.rejects(
    purgePickerMux({
      desktopRunningImpl: async () => true,
      validateDistributionImpl: async () => {
        validationCalls += 1;
      },
    }),
    /fully quit.*Command-Q/iu,
  );
  assert.equal(validationCalls, 0);
});

test("full uninstall retains the CLI when private cleanup remains pending", async () => {
  const events = [];
  const distribution = distributionSnapshot();
  await assert.rejects(
    purgePickerMux({
      paths: fixturePaths(),
      distributionPaths: {},
      desktopRunningImpl: async () => false,
      validateDistributionImpl: async () => distribution,
      validateLaunchAgentImpl: async () => ({ present: false }),
      inventoryInstallImpl: async () => ({ exists: true }),
      inventoryBackupsImpl: async () => ({ exists: true }),
      ...mockConfigOwnership(),
      revalidateInstallImpl: async () => undefined,
      revalidateBackupsImpl: async () => undefined,
      revalidateRuntimeImpl: async () => undefined,
      inventoryRuntimeImpl: async () => ({ exists: true }),
      listProviderIdsImpl: async () => [],
      removeDistributionImpl: async ({ beforeRemove }) => {
        events.push("cli-staged");
        try {
          await beforeRemove(distribution);
        } catch (error) {
          events.push("cli-restored");
          throw error;
        }
        events.push("cli-committed");
      },
      uninstallIntegrationImpl: async () => ({ removed: true }),
      purgeBackupsImpl: async ({ beforeCommit }) => {
        await beforeCommit();
        return {
          changed: true,
          cleanupPendingPath: "/private/model-bridge/.backups.pending",
        };
      },
      purgeRegistryImpl: async ({ beforeCommit }) => {
        await beforeCommit();
        return { changed: true, cleanupPendingPath: null };
      },
    }),
    /cleanup pending.*CLI will be retained/iu,
  );
  assert.deepEqual(events, ["cli-staged", "cli-restored"]);
});

test("partial credential deletion restores receipts and leaves the integration active for retry", async () => {
  const events = [];
  const distribution = distributionSnapshot();
  let integrationMutations = 0;
  let installDirectoryMutations = 0;

  await assert.rejects(
    purgePickerMux({
      paths: fixturePaths(),
      distributionPaths: {},
      desktopRunningImpl: async () => false,
      validateDistributionImpl: async () => distribution,
      validateLaunchAgentImpl: async () => ({ present: true }),
      inventoryInstallImpl: async () => ({ exists: true }),
      inventoryBackupsImpl: async () => ({ exists: true }),
      ...mockConfigOwnership(events),
      inventoryRuntimeImpl: async () => ({ exists: true }),
      revalidateInstallImpl: async () => {
        events.push("install-revalidated");
      },
      revalidateBackupsImpl: async () => {
        events.push("backups-revalidated");
      },
      revalidateRuntimeImpl: async () => {
        events.push("runtime-revalidated");
      },
      listProviderIdsImpl: async () => ["alpha", "beta"],
      removeDistributionImpl: async ({ beforeRemove }) => {
        events.push("cli-staged");
        try {
          await beforeRemove(distribution);
        } catch (error) {
          events.push("cli-restored");
          throw error;
        }
        events.push("cli-committed");
      },
      purgeRegistryImpl: async ({ beforeCommit }) => {
        events.push("registry-staged");
        try {
          await beforeCommit();
        } catch (error) {
          events.push("registry-restored");
          throw error;
        }
        events.push("registry-committed");
        return { changed: true, cleanupPendingPath: null };
      },
      purgeBackupsImpl: async ({ beforeCommit }) => {
        events.push("backups-staged");
        try {
          await beforeCommit();
        } catch (error) {
          events.push("backups-restored");
          throw error;
        }
        events.push("backups-committed");
        return { changed: true, cleanupPendingPath: null };
      },
      deleteCredentialImpl: async (providerId) => {
        events.push(`credential-delete:${providerId}`);
        if (providerId === "beta") {
          throw new Error("simulated Keychain refusal");
        }
        return true;
      },
      uninstallIntegrationImpl: async () => {
        integrationMutations += 1;
      },
      rmdirImpl: async () => {
        installDirectoryMutations += 1;
      },
    }),
    (error) => {
      const credentialError = error.code ===
          "PICKERMUX_CREDENTIAL_PURGE_INCOMPLETE"
        ? error
        : error.cause;
      assert.match(error.message, /credential.*may already be absent/iu);
      assert.match(error.message, /integration remains active/iu);
      assert.match(error.message, /idempotent retry/iu);
      assert.equal(
        credentialError?.code,
        "PICKERMUX_CREDENTIAL_PURGE_INCOMPLETE",
      );
      assert.equal(credentialError?.providerId, "beta");
      assert.deepEqual(credentialError?.completedProviderIds, ["alpha"]);
      return true;
    },
  );

  assert.equal(integrationMutations, 0);
  assert.equal(installDirectoryMutations, 0);
  assert.deepEqual(events, [
    "config-inventoried",
    "cli-staged",
    "install-revalidated",
    "backups-revalidated",
    "runtime-revalidated",
    "config-revalidated",
    "registry-staged",
    "backups-staged",
    "credential-delete:alpha",
    "credential-delete:beta",
    "backups-restored",
    "registry-restored",
    "cli-restored",
  ]);
});

test("real full-purge composition removes only receipt-owned state", async (t) => {
  const fixture = await realLifecycleFixture(t);
  const distribution = await validateDistributionInstallation({
    paths: fixture.distributionPaths,
  });
  const originalConfig = Buffer.from([
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "ultra"',
    "operator_setting = true",
    "",
  ].join("\n"));
  const authPath = path.join(fixture.paths.codexHome, "auth.json");
  const authContents = Buffer.from('{"tokens":"native-auth-sentinel"}\n');
  const foreignPaths = [
    path.join(fixture.paths.codexHome, "operator-state.json"),
    path.join(fixture.root, "home", ".local", "bin", "operator-tool"),
    path.join(
      fixture.root,
      "home",
      "Library",
      "Application Support",
      "OtherApp",
      "state.json",
    ),
    path.join(
      fixture.root,
      "home",
      "Library",
      "LaunchAgents",
      "com.example.operator.plist",
    ),
  ];
  const foreignContents = foreignPaths.map((_, index) =>
    Buffer.from(`foreign-${index}\n`)
  );

  await writeFile(fixture.paths.configPath, originalConfig, { mode: 0o600 });
  await writeFile(authPath, authContents, { mode: 0o600 });
  for (let index = 0; index < foreignPaths.length; index += 1) {
    await mkdir(path.dirname(foreignPaths[index]), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(foreignPaths[index], foreignContents[index], {
      mode: 0o600,
    });
  }

  await stageServicePackage({
    sourceRoot: distribution.activeDirectory,
    installDirectory: fixture.paths.installDirectory,
    config: { schemaVersion: 2 },
  });
  const installedConfig = await installConfig({
    configPath: fixture.paths.configPath,
    statePath: fixture.paths.statePath,
    backupDirectory: fixture.paths.backupDirectory,
    model: "lmstudio/qwen/local",
    modelProvider: "model_bridge_fixture",
    modelCatalogJson: fixture.paths.catalogPath,
    modelReasoningEffort: "low",
    provider: {
      id: "model_bridge_fixture",
      name: "Model Bridge Fixture",
      baseUrl: "http://127.0.0.1:23456/v1/",
      wireApi: "responses",
      requiresOpenAiAuth: false,
      supportsWebsockets: false,
      supportsStandaloneWebSearch: false,
    },
    now: new Date("2026-09-01T12:00:00.000Z"),
  });
  await writeRuntime(
    fixture.paths.runtimePath,
    createRuntimeRecord({ configPath: fixture.paths.serviceConfigPath }),
  );
  for (const [target, contents] of [
    [fixture.paths.catalogPath, '{"models":[]}\n'],
    [fixture.paths.compatibilityPath, '{"schemaVersion":1}\n'],
    [fixture.paths.certificationPath, '{"schemaVersion":1}\n'],
    [fixture.paths.logPath, "bridge-log-sentinel\n"],
  ]) {
    await writeFile(target, contents, { mode: 0o600 });
  }

  const providerIds = ["alpha", "vendor_z"];
  for (const providerId of providerIds) {
    await registerKeychainProvider(providerId, {
      registryPath: fixture.paths.keychainRegistryPath,
    });
  }
  await mkdir(path.dirname(fixture.paths.launchAgentPath), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    fixture.paths.launchAgentPath,
    renderLaunchAgent({
      label: fixture.paths.launchAgentLabel,
      nodePath: process.execPath,
      binPath: path.join(
        fixture.paths.serviceDirectory,
        "bin",
        "lmstudio-picker.mjs",
      ),
      configPath: fixture.paths.serviceConfigPath,
      runtimePath: fixture.paths.runtimePath,
      workingDirectory: fixture.paths.serviceDirectory,
      logPath: fixture.paths.logPath,
    }),
    { mode: 0o600 },
  );

  const snapshotFile = async (target) => {
    const [contents, metadata] = await Promise.all([
      readFile(target),
      stat(target),
    ]);
    return {
      contents,
      metadata: Object.fromEntries(
        ["dev", "ino", "mode", "nlink", "size", "mtimeMs"].map(
          (key) => [key, metadata[key]],
        ),
      ),
    };
  };
  const authBefore = await snapshotFile(authPath);
  const foreignBefore = await Promise.all(foreignPaths.map(snapshotFile));

  const launchctlCalls = [];
  const launchctlExec = async (file, args, options) => {
    assert.equal(file, "/bin/launchctl");
    assert.equal(options.encoding, "utf8");
    launchctlCalls.push([...args]);
    if (args[0] === "print") return { stdout: "loaded\n", stderr: "" };
    assert.equal(args[0], "bootout");
    return { stdout: "", stderr: "" };
  };
  const keychainItems = new Set(providerIds);
  const keychainCalls = [];
  const keychainExec = async (file, args, options) => {
    assert.equal(file, "/usr/bin/security");
    assert.deepEqual(options, { stdio: "inherit" });
    assert.equal(args[0], "delete-generic-password");
    const service = args[args.indexOf("-s") + 1];
    const providerId = args[args.indexOf("-a") + 1];
    assert.equal(
      service,
      `com.local.codex-model-bridge.provider.${providerId}`,
    );
    keychainCalls.push({ providerId, service });
    assert.equal(keychainItems.delete(providerId), true);
    return {};
  };

  const result = await purgePickerMux({
    paths: fixture.paths,
    distributionPaths: fixture.distributionPaths,
    desktopRunningImpl: async () => false,
    deleteCredentialImpl: async (providerId) =>
      deleteProviderCredential(providerId, { execFileImpl: keychainExec }),
    uninstallIntegrationImpl: async (options) => uninstallIntegration({
      ...options,
      stopServiceImpl: async (stopOptions) => stopBridgeService({
        ...stopOptions,
        execFileImpl: launchctlExec,
      }),
    }),
  });

  assert.equal(result.beforeResult.integration.removedConfig.changed, true);
  assert.equal(result.beforeResult.backups.changed, true);
  assert.equal(result.beforeResult.backups.cleanupPendingPath, null);
  assert.deepEqual(result.beforeResult.backups.backups, [
    path.basename(installedConfig.backupPath),
  ]);
  assert.equal(result.beforeResult.registry.changed, true);
  assert.equal(result.beforeResult.registry.cleanupPendingPath, null);
  assert.deepEqual(result.beforeResult.registry.providerIds, providerIds);
  assert.equal(result.beforeResult.installDirectoryRemoved, true);
  assert.equal(result.removed.versionsDirectoryRemoved, true);
  assert.equal(result.removed.applicationDirectoryRemoved, true);
  assert.equal(result.beforeResult.integration.service.stopped, true);
  assert.deepEqual(
    [...result.beforeResult.integration.artifacts.removedFiles].sort(),
    [
      fixture.paths.certificationPath,
      fixture.paths.compatibilityPath,
      fixture.paths.catalogPath,
      fixture.paths.logPath,
      fixture.paths.runtimePath,
      fixture.paths.serviceConfigPath,
    ].sort(),
  );
  assert.deepEqual(
    result.beforeResult.integration.artifacts.removedRuntimeDirectories,
    [fixture.paths.serviceDirectory],
  );
  assert.deepEqual(result.beforeResult.credentials, providerIds.map(
    (providerId) => ({ providerId, deleted: true }),
  ));
  assert.deepEqual([...keychainItems], []);
  assert.deepEqual(
    keychainCalls.map(({ providerId }) => providerId),
    providerIds,
  );
  assert.deepEqual(launchctlCalls, [
    [
      "print",
      `gui/${process.getuid()}/${fixture.paths.launchAgentLabel}`,
    ],
    [
      "bootout",
      `gui/${process.getuid()}/${fixture.paths.launchAgentLabel}`,
    ],
  ]);

  assert.deepEqual(await readFile(fixture.paths.configPath), originalConfig);
  for (const removedPath of [
    fixture.paths.installDirectory,
    fixture.paths.launchAgentPath,
    fixture.distributionPaths.applicationDirectory,
    fixture.distributionPaths.launcherPath,
  ]) {
    await assert.rejects(stat(removedPath), { code: "ENOENT" });
  }
  assert.deepEqual(await snapshotFile(authPath), authBefore);
  for (let index = 0; index < foreignPaths.length; index += 1) {
    assert.deepEqual(
      await snapshotFile(foreignPaths[index]),
      foreignBefore[index],
    );
  }
});

test("real full-purge composition retries after a partial credential deletion", async (t) => {
  const fixture = await realLifecycleFixture(t);
  await registerKeychainProvider("alpha", {
    registryPath: fixture.paths.keychainRegistryPath,
  });
  await registerKeychainProvider("beta", {
    registryPath: fixture.paths.keychainRegistryPath,
  });
  const available = new Map([
    ["alpha", true],
    ["beta", true],
  ]);
  let failBeta = true;
  let integrationCalls = 0;
  const purgeOptions = realPurgeOptions(fixture, {
    deleteCredentialImpl: async (providerId) => {
      if (providerId === "beta" && failBeta) {
        failBeta = false;
        throw new Error("simulated Keychain refusal");
      }
      const deleted = available.get(providerId) === true;
      available.set(providerId, false);
      return deleted;
    },
    uninstallIntegrationImpl: async () => {
      integrationCalls += 1;
      return {
        removedConfig: { changed: false },
        artifacts: {},
      };
    },
  });
  const stdout = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    stdout.push(String(chunk));
    return true;
  };
  try {
    await assert.rejects(
      runCli(["uninstall", "--purge"], {
        purgeImpl: async () => purgePickerMux(purgeOptions),
      }),
      (error) => {
        assert.equal(error.code, "PICKERMUX_CREDENTIAL_PURGE_INCOMPLETE");
        assert.equal(error.providerId, "beta");
        assert.deepEqual(error.completedProviderIds, ["alpha"]);
        assert.match(
          error.message,
          /PICKERMUX_CREDENTIAL_PURGE_INCOMPLETE/u,
        );
        return true;
      },
    );
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.deepEqual(stdout, []);
  assert.equal(integrationCalls, 0);
  assert.equal(available.get("alpha"), false);
  assert.equal(available.get("beta"), true);
  assert.deepEqual(
    await listRegisteredKeychainProviderIds({
      registryPath: fixture.paths.keychainRegistryPath,
    }),
    ["alpha", "beta"],
  );
  assert.equal(
    (await validateDistributionInstallation({
      paths: fixture.distributionPaths,
    })).installed,
    true,
  );

  const retry = await purgePickerMux(purgeOptions);
  assert.equal(integrationCalls, 1);
  assert.deepEqual(retry.beforeResult.credentials, [
    { providerId: "alpha", deleted: false },
    { providerId: "beta", deleted: true },
  ]);
  assert.equal(retry.removed.versionsDirectoryRemoved, true);
  assert.equal(retry.removed.applicationDirectoryRemoved, true);
  assert.deepEqual(
    await listRegisteredKeychainProviderIds({
      registryPath: fixture.paths.keychainRegistryPath,
    }),
    [],
  );
});

test("real full-purge CLI preserves commit failure after an empty Keychain phase", async (t) => {
  const fixture = await realLifecycleFixture(t);

  await assertCliRejectsWithoutStdout(
    () => runCli(["uninstall", "--purge"], {
      purgeImpl: async () => purgePickerMux(realPurgeOptions(fixture, {
        uninstallIntegrationImpl: async () => {
          throw new Error("simulated integration refusal");
        },
      })),
    }),
    (error) => {
      assert.equal(error.code, "PICKERMUX_PURGE_COMMIT_INCOMPLETE");
      assert.deepEqual(error.completedProviderIds, []);
      assert.match(error.message, /PICKERMUX_PURGE_COMMIT_INCOMPLETE/u);
      assert.match(error.message, /irreversible Keychain phase/iu);
      return true;
    },
  );

  assert.equal(
    (await validateDistributionInstallation({
      paths: fixture.distributionPaths,
    })).installed,
    true,
  );
});

test("real full-purge CLI preserves incomplete cleanup failures", async (t) => {
  const cases = [
    {
      name: "backup cleanup after CLI rollback",
      async prepare(fixture) {
        await writeFile(fixture.paths.configPath, 'model = "gpt-5.6-sol"\n', {
          mode: 0o600,
        });
        await installConfig({
          configPath: fixture.paths.configPath,
          statePath: fixture.paths.statePath,
          backupDirectory: fixture.paths.backupDirectory,
          model: "lmstudio/qwen/local",
          modelProvider: "model_bridge_fixture",
          modelCatalogJson: fixture.paths.catalogPath,
          provider: {
            id: "model_bridge_fixture",
            name: "Model Bridge Fixture",
            baseUrl: "http://127.0.0.1:23456/v1/",
          },
          now: new Date("2026-09-01T12:00:00.000Z"),
        });
      },
      overrides: {
        purgeBackupsImpl: async (options) => purgePickerMuxBackups({
          ...options,
          unlinkImpl: async () => {
            throw new Error("simulated backup cleanup refusal");
          },
        }),
      },
      distributionRestored: true,
    },
    {
      name: "registry cleanup after CLI rollback",
      async prepare(fixture) {
        await registerKeychainProvider("alpha", {
          registryPath: fixture.paths.keychainRegistryPath,
        });
      },
      overrides: {
        deleteCredentialImpl: async () => true,
        purgeRegistryImpl: async (options) => purgeKeychainProviderRegistry({
          ...options,
          unlinkImpl: async () => {
            throw new Error("simulated registry cleanup refusal");
          },
        }),
      },
      distributionRestored: true,
    },
    {
      name: "distribution cleanup after integration commit",
      async prepare() {},
      overrides: {
        removeDistributionImpl: async (options) => removeManagedDistribution({
          ...options,
          unlinkImpl: async () => {
            throw new Error("simulated distribution cleanup refusal");
          },
        }),
      },
      distributionRestored: false,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const fixture = await realLifecycleFixture(subtest);
      await scenario.prepare(fixture);

      await assertCliRejectsWithoutStdout(
        () => runCli(["uninstall", "--purge"], {
          purgeImpl: async () => purgePickerMux(realPurgeOptions(
            fixture,
            scenario.overrides,
          )),
        }),
        (error) => {
          assert.equal(error.code, "PICKERMUX_PURGE_INCOMPLETE");
          assert.match(error.message, /cleanup|full uninstall is incomplete/iu);
          assert.equal(
            typeof error.cleanupPendingPath === "string" ||
              error.cleanupPendingPaths?.length > 0,
            true,
          );
          return true;
        },
      );

      if (scenario.distributionRestored) {
        assert.equal(
          (await validateDistributionInstallation({
            paths: fixture.distributionPaths,
          })).installed,
          true,
        );
      } else {
        await assert.rejects(
          stat(fixture.distributionPaths.applicationDirectory),
          { code: "ENOENT" },
        );
        await assert.rejects(
          stat(fixture.distributionPaths.launcherPath),
          { code: "ENOENT" },
        );
      }
    });
  }
});

test("full purge rejects foreign application state before lifecycle mutation", async (t) => {
  const fixture = await realLifecycleFixture(t);
  const foreign = path.join(
    fixture.distributionPaths.applicationDirectory,
    "operator-notes.txt",
  );
  await writeFile(foreign, "preserve\n", { mode: 0o600 });
  let credentialMutations = 0;
  let integrationMutations = 0;

  await assert.rejects(
    purgePickerMux(realPurgeOptions(fixture, {
      deleteCredentialImpl: async () => {
        credentialMutations += 1;
      },
      uninstallIntegrationImpl: async () => {
        integrationMutations += 1;
      },
    })),
    /full removal refuses unowned application state.*operator-notes\.txt/iu,
  );

  assert.equal(credentialMutations, 0);
  assert.equal(integrationMutations, 0);
  assert.equal(await readFile(foreign, "utf8"), "preserve\n");
  assert.equal(
    (await validateDistributionInstallation({
      paths: fixture.distributionPaths,
    })).installed,
    true,
  );
});

test("full purge reports late application paths as incomplete and preserves them", async (t) => {
  const fixture = await realLifecycleFixture(t);
  const foreignVersion = path.join(
    fixture.distributionPaths.versionsDirectory,
    "foreign.txt",
  );
  const foreignApplication = path.join(
    fixture.distributionPaths.applicationDirectory,
    "concurrent.txt",
  );

  await assert.rejects(
    purgePickerMux(realPurgeOptions(fixture, {
      uninstallIntegrationImpl: async () => {
        await mkdir(fixture.distributionPaths.versionsDirectory, {
          mode: 0o700,
        });
        await writeFile(foreignVersion, "preserve version\n", { mode: 0o600 });
        await writeFile(foreignApplication, "preserve application\n", {
          mode: 0o600,
        });
        return { removedConfig: { changed: false }, artifacts: {} };
      },
    })),
    (error) => {
      assert.equal(error.code, "PICKERMUX_PURGE_INCOMPLETE");
      assert.equal(error.installDirectoryRemoved, true);
      assert.equal(error.versionsDirectoryRemoved, false);
      assert.equal(error.applicationDirectoryRemoved, false);
      assert.match(error.message, /versions path remains/iu);
      assert.match(error.message, /application directory remains/iu);
      return true;
    },
  );

  assert.equal(await readFile(foreignVersion, "utf8"), "preserve version\n");
  assert.equal(
    await readFile(foreignApplication, "utf8"),
    "preserve application\n",
  );
});

test("full uninstall fails when CLI quarantine cleanup remains pending", async () => {
  const distribution = distributionSnapshot();
  const pendingPath = "/private/pickermux/.cli-removal.pending";

  await assert.rejects(
    purgePickerMux({
      paths: fixturePaths(),
      distributionPaths: {},
      desktopRunningImpl: async () => false,
      validateDistributionImpl: async () => distribution,
      validateLaunchAgentImpl: async () => ({ present: true }),
      inventoryInstallImpl: async () => ({ exists: true }),
      inventoryBackupsImpl: async () => ({ exists: false }),
      ...mockConfigOwnership(),
      inventoryRuntimeImpl: async () => ({ exists: true }),
      revalidateInstallImpl: async () => undefined,
      revalidateBackupsImpl: async () => undefined,
      revalidateRuntimeImpl: async () => undefined,
      listProviderIdsImpl: async () => [],
      removeDistributionImpl: async ({ beforeRemove }) => ({
        beforeResult: await beforeRemove(distribution),
        removed: { cleanupPendingPath: pendingPath },
      }),
      uninstallIntegrationImpl: async () => ({ artifacts: {} }),
      purgeBackupsImpl: async ({ beforeCommit }) => {
        await beforeCommit();
        return { changed: false, cleanupPendingPath: null };
      },
      purgeRegistryImpl: async ({ beforeCommit }) => {
        await beforeCommit();
        return { changed: false, cleanupPendingPath: null };
      },
      rmdirImpl: async () => undefined,
    }),
    (error) => {
      assert.equal(error.code, "PICKERMUX_PURGE_INCOMPLETE");
      assert.deepEqual(error.cleanupPendingPaths, [pendingPath]);
      assert.match(error.message, /full uninstall is incomplete/iu);
      return true;
    },
  );
});

test("full uninstall restores the CLI when the managed directory stays non-empty", async () => {
  const events = [];
  const distribution = distributionSnapshot();

  await assert.rejects(
    purgePickerMux({
      paths: fixturePaths(),
      distributionPaths: {},
      desktopRunningImpl: async () => false,
      validateDistributionImpl: async () => distribution,
      validateLaunchAgentImpl: async () => ({ present: true }),
      inventoryInstallImpl: async () => ({ exists: true }),
      inventoryBackupsImpl: async () => ({ exists: false }),
      ...mockConfigOwnership(),
      inventoryRuntimeImpl: async () => ({ exists: true }),
      revalidateInstallImpl: async () => undefined,
      revalidateBackupsImpl: async () => undefined,
      revalidateRuntimeImpl: async () => undefined,
      listProviderIdsImpl: async () => [],
      removeDistributionImpl: async ({ beforeRemove }) => {
        events.push("cli-staged");
        try {
          await beforeRemove(distribution);
        } catch (error) {
          events.push("cli-restored");
          throw error;
        }
        events.push("cli-committed");
      },
      uninstallIntegrationImpl: async () => ({ artifacts: {} }),
      purgeBackupsImpl: async ({ beforeCommit }) => {
        await beforeCommit();
        return { changed: false, cleanupPendingPath: null };
      },
      purgeRegistryImpl: async ({ beforeCommit }) => {
        await beforeCommit();
        return { changed: false, cleanupPendingPath: null };
      },
      rmdirImpl: async () => {
        const error = new Error("simulated non-empty directory");
        error.code = "ENOTEMPTY";
        throw error;
      },
    }),
    /full uninstall is incomplete.*not empty/iu,
  );
  assert.deepEqual(events, ["cli-staged", "cli-restored"]);
});

test("full uninstall binds integration removal to the receipt confirmed under lock", async () => {
  const preflight = distributionSnapshot("preflight");
  const changed = distributionSnapshot("changed");
  let integrationMutations = 0;

  await assert.rejects(
    purgePickerMux({
      paths: fixturePaths(),
      distributionPaths: {},
      desktopRunningImpl: async () => false,
      validateDistributionImpl: async () => preflight,
      validateLaunchAgentImpl: async () => ({ present: false }),
      inventoryInstallImpl: async () => ({ exists: true }),
      inventoryBackupsImpl: async () => ({ exists: false }),
      ...mockConfigOwnership(),
      revalidateInstallImpl: async () => undefined,
      revalidateBackupsImpl: async () => undefined,
      inventoryRuntimeImpl: async () => ({ exists: false }),
      listProviderIdsImpl: async () => [],
      removeDistributionImpl: async ({ beforeRemove }) =>
        beforeRemove(changed),
      uninstallIntegrationImpl: async () => {
        integrationMutations += 1;
      },
    }),
    /CLI ownership state changed before integration removal/iu,
  );
  assert.equal(integrationMutations, 0);
});

test("runtime drift is revalidated before uninstall mutates integration state", async () => {
  let mutationCalls = 0;
  await assert.rejects(
    uninstallIntegration({
      paths: fixturePaths(),
      force: false,
      servicePackageInventory: { exists: true },
      revalidateRuntimeImpl: async () => {
        throw new Error("runtime changed after inventory");
      },
      uninstallConfigImpl: async () => {
        mutationCalls += 1;
      },
      stopServiceImpl: async () => {
        mutationCalls += 1;
      },
      removeMetadataImpl: async () => {
        mutationCalls += 1;
      },
      removeRuntimeImpl: async () => {
        mutationCalls += 1;
      },
    }),
    /runtime changed after inventory/iu,
  );
  assert.equal(mutationCalls, 0);
});

test("integration uninstall preserves runtime metadata until exact receipt removal", async () => {
  const paths = fixturePaths();
  const runtimeInventory = { exists: true, kind: "runtime" };
  const installInventory = { exists: true, kind: "metadata" };
  const backupInventory = { exists: true, kind: "backups" };
  const events = [];
  let stopOptions;
  const result = await uninstallIntegration({
    paths,
    force: false,
    servicePackageInventory: runtimeInventory,
    installDirectoryInventory: installInventory,
    backupDirectoryInventory: backupInventory,
    revalidateRuntimeImpl: async (inventory) => {
      assert.equal(inventory, runtimeInventory);
      events.push("runtime-revalidated");
    },
    revalidateMetadataImpl: async (inventory) => {
      assert.equal(inventory, installInventory);
      events.push("metadata-revalidated");
    },
    uninstallConfigImpl: async () => {
      events.push("config-restored");
      return { changed: true };
    },
    stopServiceImpl: async (options) => {
      stopOptions = options;
      events.push("service-stopped");
      return { stopped: true };
    },
    removeMetadataImpl: async ({ inventory }) => {
      assert.equal(inventory, installInventory);
      events.push("metadata-removed");
      return {
        changed: true,
        removedFiles: [paths.runtimePath],
        cleanupPendingPath: null,
      };
    },
    removeRuntimeImpl: async ({
      inventory,
      allowReceiptBoundParentTransitions,
    }) => {
      assert.equal(inventory, runtimeInventory);
      assert.equal(allowReceiptBoundParentTransitions, true);
      events.push("runtime-removed");
      return { changed: true, cleanupPendingPath: null };
    },
  });

  assert.equal(stopOptions.removeRuntime, false);
  assert.deepEqual(events, [
    "runtime-revalidated",
    "metadata-revalidated",
    "config-restored",
    "service-stopped",
    "metadata-removed",
    "runtime-removed",
  ]);
  assert.equal(result.artifacts.metadataCleanupPendingPath, null);
  assert.deepEqual(result.artifacts.removedRuntimeDirectories, [
    paths.serviceDirectory,
  ]);
});

test("integration uninstall composes real config, metadata, and runtime removal", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pickermux-real-uninstall-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = {
    HOME: path.join(directory, "home"),
    CODEX_HOME: path.join(directory, "codex-home"),
  };
  const paths = resolveInstallPaths(environment);
  const originalConfig = [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "ultra"',
    "user_setting = true",
    "",
  ].join("\n");
  const authContents = Buffer.from('{"tokens":"untouched"}\n');
  const authPath = path.join(paths.codexHome, "auth.json");

  await mkdir(paths.codexHome, { recursive: true, mode: 0o700 });
  await writeFile(paths.configPath, originalConfig, { mode: 0o600 });
  await writeFile(authPath, authContents, { mode: 0o600 });
  const authBefore = await stat(authPath);
  await stageServicePackage({
    sourceRoot: PROJECT_ROOT,
    installDirectory: paths.installDirectory,
    config: { schemaVersion: 2 },
  });
  await installConfig({
    configPath: paths.configPath,
    statePath: paths.statePath,
    backupDirectory: paths.backupDirectory,
    model: "lmstudio/qwen/local",
    modelProvider: "model_bridge_fixture",
    modelCatalogJson: paths.catalogPath,
    modelReasoningEffort: "low",
    provider: {
      id: "model_bridge_fixture",
      name: "Model Bridge Fixture",
      baseUrl: "http://127.0.0.1:23456/v1/",
      wireApi: "responses",
      requiresOpenAiAuth: false,
      supportsWebsockets: false,
      supportsStandaloneWebSearch: false,
    },
    now: new Date("2026-09-01T12:00:00.000Z"),
  });
  await writeFile(paths.runtimePath, '{"schemaVersion":1}\n', { mode: 0o600 });

  const result = await uninstallIntegration({
    paths,
    force: false,
    sourceRoot: PROJECT_ROOT,
    // Keep the filesystem composition real while isolating the launchctl
    // process boundary from this deterministic test.
    stopServiceImpl: async () => ({
      stopped: false,
      launchAgentRemoved: true,
      runtimeRemoved: false,
    }),
  });

  assert.equal(result.removedConfig.changed, true);
  assert.deepEqual(result.artifacts.removedRuntimeDirectories, [
    paths.serviceDirectory,
  ]);
  assert.equal(await readFile(paths.configPath, "utf8"), originalConfig);
  for (const removedPath of [
    paths.statePath,
    paths.runtimePath,
    paths.serviceConfigPath,
    paths.serviceDirectory,
  ]) {
    await assert.rejects(stat(removedPath), { code: "ENOENT" });
  }
  assert.deepEqual(await readFile(authPath), authContents);
  const authAfter = await stat(authPath);
  for (const key of ["dev", "ino", "mode", "size", "mtimeMs"]) {
    assert.equal(authAfter[key], authBefore[key]);
  }
});

test("integration uninstall reads its exact config backup while backup purge is staged", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pickermux-staged-backup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const codexHome = path.join(directory, "codex-home");
  const installDirectory = path.join(codexHome, "model-bridge");
  const backupDirectory = path.join(installDirectory, "backups");
  const configPath = path.join(codexHome, "config.toml");
  const statePath = path.join(installDirectory, "state.json");
  const paths = {
    ...fixturePaths(),
    codexHome,
    installDirectory,
    backupDirectory,
    configPath,
    statePath,
    serviceDirectory: path.join(installDirectory, "runtime-app"),
    runtimePath: path.join(installDirectory, "runtime.json"),
    launchAgentPath: path.join(directory, "bridge.plist"),
    logPath: path.join(installDirectory, "bridge.log"),
  };
  const original = [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "ultra"',
    "user_setting = true",
    "",
  ].join("\n");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await writeFile(configPath, original, { mode: 0o600 });
  await installConfig({
    configPath,
    statePath,
    backupDirectory,
    model: "lmstudio/qwen/local",
    modelProvider: "model_bridge_fixture",
    modelCatalogJson: path.join(installDirectory, "models.json"),
    modelReasoningEffort: "low",
    provider: {
      id: "model_bridge_fixture",
      name: "Model Bridge Fixture",
      baseUrl: "http://127.0.0.1:23456/v1/",
      wireApi: "responses",
      requiresOpenAiAuth: false,
      supportsWebsockets: false,
      supportsStandaloneWebSearch: false,
    },
    now: new Date("2026-09-01T12:00:00.000Z"),
  });
  const backupInventory = await inventoryPickerMuxBackups({
    backupDirectory,
    configPath,
  });
  let integration;
  const backups = await purgePickerMuxBackups({
    backupDirectory,
    configPath,
    inventory: backupInventory,
    async beforeCommit({ readBackup }) {
      assert.equal(typeof readBackup, "function");
      integration = await uninstallIntegration({
        paths,
        force: false,
        servicePackageInventory: { exists: false },
        installDirectoryInventory: { exists: true },
        backupDirectoryInventory: backupInventory,
        readBackupImpl: readBackup,
        revalidateRuntimeImpl: async () => undefined,
        revalidateMetadataImpl: async () => undefined,
        stopServiceImpl: async () => ({
          stopped: false,
          launchAgentRemoved: true,
          runtimeRemoved: false,
        }),
        removeMetadataImpl: async () => ({
          changed: false,
          removedFiles: [],
          cleanupPendingPath: null,
        }),
        removeRuntimeImpl: async () => ({
          changed: false,
          cleanupPendingPath: null,
        }),
      });
    },
  });

  assert.equal(integration.removedConfig.changed, true);
  assert.equal(await readFile(configPath, "utf8"), original);
  await assert.rejects(readFile(statePath), { code: "ENOENT" });
  assert.equal(backups.changed, true);
  assert.equal(backups.cleanupPendingPath, null);
  await assert.rejects(readFile(backupDirectory), { code: "ENOENT" });
});

test("credential lifecycle records ownership before set and unregisters after delete", async () => {
  const config = {
    providers: [{ id: "vendor", credentialKeychain: true }],
  };
  const setEvents = [];
  await assert.rejects(
    credentialCommand({
      command: "credential-set",
      config,
      providerId: "vendor",
      registryPath: "/private/model-bridge/keychain-state.json",
      registerImpl: async () => {
        setEvents.push("registered");
        return { providerId: "vendor", added: true };
      },
      setCredentialImpl: async () => {
        setEvents.push("set-attempted");
        throw new Error("simulated failure");
      },
    }),
    /simulated failure/u,
  );
  assert.deepEqual(setEvents, ["registered", "set-attempted"]);

  const deleteEvents = [];
  const result = await credentialCommand({
    command: "credential-delete",
    config,
    providerId: "vendor",
    registryPath: "/private/model-bridge/keychain-state.json",
    deleteCredentialImpl: async () => {
      deleteEvents.push("deleted");
      return false;
    },
    unregisterImpl: async () => {
      deleteEvents.push("unregistered");
    },
  });
  assert.deepEqual(deleteEvents, ["deleted", "unregistered"]);
  assert.deepEqual(result, {
    providerId: "vendor",
    source: "keychain",
    deleted: false,
  });
});

test("runCli dispatches --purge to the full-uninstall implementation", async () => {
  let received;
  const expected = {
    beforeResult: {
      backups: { cleanupPendingPath: null },
      registry: { cleanupPendingPath: null },
      installDirectoryRemoved: true,
    },
    removed: {
      cleanupPendingPath: null,
      versionsDirectoryRemoved: true,
      applicationDirectoryRemoved: true,
    },
  };
  const result = await runCli(["uninstall", "--purge", "--force"], {
    purgeImpl: async (options) => {
      received = options;
      return expected;
    },
  });
  assert.equal(result, expected);
  assert.equal(received.force, true);
  assert.equal(path.basename(received.paths.keychainRegistryPath), "keychain-state.json");
  assert.equal(typeof received.distributionPaths.receiptPath, "string");
});

test("runCli rejects incomplete full purge results before its success path", async () => {
  const base = {
    beforeResult: {
      integration: { artifacts: {} },
      backups: { cleanupPendingPath: null },
      registry: { cleanupPendingPath: null },
      installDirectoryRemoved: true,
    },
    removed: {
      cleanupPendingPath: null,
      versionsDirectoryRemoved: true,
      applicationDirectoryRemoved: true,
    },
  };

  await assert.rejects(
    runCli(["uninstall", "--purge"], {
      purgeImpl: async () => ({
        ...base,
        removed: { cleanupPendingPath: "/private/.pickermux-cli.pending" },
      }),
    }),
    (error) => error.code === "PICKERMUX_PURGE_INCOMPLETE",
  );
  await assert.rejects(
    runCli(["uninstall", "--purge"], {
      purgeImpl: async () => ({
        ...base,
        beforeResult: {
          ...base.beforeResult,
          installDirectoryRemoved: false,
        },
      }),
    }),
    (error) => error.code === "PICKERMUX_PURGE_INCOMPLETE",
  );
});

test("runCli rejects combining --purge with --remove-cli", async () => {
  await assert.rejects(
    runCli(["uninstall", "--purge", "--remove-cli"]),
    /--purge already includes --remove-cli/u,
  );
});

test("full uninstall rejects a forged auth.json backupPath before any mutation", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pickermux-forged-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const codexHome = path.join(directory, ".codex");
  const installDirectory = path.join(codexHome, "model-bridge");
  const paths = {
    ...fixturePaths(),
    codexHome,
    installDirectory,
    configPath: path.join(codexHome, "config.toml"),
    statePath: path.join(installDirectory, "state.json"),
    backupDirectory: path.join(installDirectory, "backups"),
  };
  const original = 'model = "gpt-5.6-sol"\n';
  const authPath = path.join(codexHome, "auth.json");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await writeFile(paths.configPath, original, { mode: 0o600 });
  await writeFile(authPath, original, { mode: 0o600 });
  await installConfig({
    configPath: paths.configPath,
    statePath: paths.statePath,
    backupDirectory: paths.backupDirectory,
    model: "lmstudio/qwen/local",
    modelProvider: "model_bridge_fixture",
    modelCatalogJson: path.join(installDirectory, "models.json"),
    provider: {
      id: "model_bridge_fixture",
      name: "Model Bridge Fixture",
      baseUrl: "http://127.0.0.1:23456/v1/",
    },
    now: new Date("2026-09-01T12:00:00.000Z"),
  });
  const state = JSON.parse(await readFile(paths.statePath, "utf8"));
  state.backupPath = authPath;
  await writeFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
  const authBytes = await readFile(authPath);
  const authStats = await stat(authPath);
  let mutationCalls = 0;
  let providerReads = 0;

  await assert.rejects(
    purgePickerMux({
      paths,
      distributionPaths: {},
      desktopRunningImpl: async () => false,
      validateDistributionImpl: async () => distributionSnapshot(),
      validateLaunchAgentImpl: async () => ({ present: true }),
      inventoryInstallImpl: async () => ({ exists: true }),
      inventoryRuntimeImpl: async () => {
        mutationCalls += 1;
        return { exists: false };
      },
      listProviderIdsImpl: async () => {
        providerReads += 1;
        return [];
      },
      removeDistributionImpl: async () => {
        mutationCalls += 1;
      },
    }),
    (error) => error.code === "UNSAFE_BACKUP_PATH",
  );

  assert.equal(mutationCalls, 0);
  assert.equal(providerReads, 0);
  assert.deepEqual(await readFile(authPath), authBytes);
  const authAfter = await stat(authPath);
  for (const key of ["dev", "ino", "mode", "size", "mtimeMs"]) {
    assert.equal(authAfter[key], authStats[key]);
  }
});

test("late integration failure retains recovery receipts after credential commit", async () => {
  const events = [];
  const distribution = distributionSnapshot();
  let installDirectoryMutations = 0;

  await assert.rejects(
    purgePickerMux({
      paths: fixturePaths(),
      distributionPaths: {},
      desktopRunningImpl: async () => false,
      validateDistributionImpl: async () => distribution,
      validateLaunchAgentImpl: async () => ({ present: true }),
      inventoryInstallImpl: async () => ({ exists: true }),
      inventoryBackupsImpl: async () => ({ exists: true }),
      inventoryRuntimeImpl: async () => ({ exists: true }),
      ...mockConfigOwnership(),
      revalidateInstallImpl: async () => undefined,
      revalidateBackupsImpl: async () => undefined,
      revalidateRuntimeImpl: async () => undefined,
      listProviderIdsImpl: async () => ["alpha"],
      removeDistributionImpl: async ({ beforeRemove }) => {
        events.push("cli-staged");
        try {
          await beforeRemove(distribution);
        } catch (error) {
          events.push("cli-restored");
          throw error;
        }
      },
      purgeRegistryImpl: async ({ beforeCommit }) => {
        events.push("registry-staged");
        try {
          await beforeCommit();
        } catch (error) {
          events.push("registry-restored");
          throw error;
        }
      },
      purgeBackupsImpl: async ({ beforeCommit }) => {
        events.push("backups-staged");
        try {
          await beforeCommit();
        } catch (error) {
          events.push("backups-restored");
          throw error;
        }
      },
      deleteCredentialImpl: async (providerId) => {
        events.push(`credential-delete:${providerId}`);
        return true;
      },
      uninstallIntegrationImpl: async () => {
        events.push("integration-removal-attempted");
        throw new Error("simulated late integration failure");
      },
      rmdirImpl: async () => {
        installDirectoryMutations += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "PICKERMUX_PURGE_COMMIT_INCOMPLETE");
      assert.deepEqual(error.completedProviderIds, ["alpha"]);
      assert.match(error.message, /irreversible Keychain phase/iu);
      assert.match(error.message, /retained for recovery/iu);
      assert.match(error.cause?.message ?? "", /late integration failure/iu);
      return true;
    },
  );

  assert.equal(installDirectoryMutations, 0);
  assert.deepEqual(events, [
    "cli-staged",
    "registry-staged",
    "backups-staged",
    "credential-delete:alpha",
    "integration-removal-attempted",
    "backups-restored",
    "registry-restored",
    "cli-restored",
  ]);
});
