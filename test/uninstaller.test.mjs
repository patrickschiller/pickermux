import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  credentialCommand,
  purgePickerMux,
  runCli,
  uninstallIntegration,
} from "../src/cli.mjs";

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
    activeDirectory: "/private/pickermux/versions/0.5.1",
    raw: Buffer.from(`receipt:${marker}`),
  };
}

test("full uninstall revalidates ownership and stages registry and backups before credential deletion", async () => {
  const events = [];
  const paths = fixturePaths();
  const distributionPaths = { receiptPath: "/private/receipt.json" };
  const distribution = distributionSnapshot();
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
      return { exists: true };
    },
    inventoryBackupsImpl: async () => {
      events.push("backups-inventoried");
      return { exists: true };
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
    removeDistributionImpl: async ({ paths: actual, beforeRemove }) => {
      events.push("cli-staged");
      assert.equal(actual, distributionPaths);
      const beforeResult = await beforeRemove(distribution);
      events.push("cli-committed");
      return {
        beforeResult,
        removed: { cleanupPendingPath: null },
      };
    },
    uninstallIntegrationImpl: async () => {
      events.push("integration-removed");
      return { removedConfig: { changed: true } };
    },
    deleteCredentialImpl: async (providerId) => {
      events.push(`credential-deleted:${providerId}`);
      return providerId === "alpha";
    },
    purgeBackupsImpl: async ({ beforeCommit }) => {
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
    "runtime-inventoried",
    "registry-inventoried",
    "cli-staged",
    "desktop-closed",
    "launch-agent-validated",
    "install-inventoried",
    "backups-inventoried",
    "registry-inventoried",
    "registry-staged",
    "integration-removed",
    "backups-staged",
    "credential-deleted:alpha",
    "credential-deleted:vendor_z",
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
      cleanupArtifactsImpl: async () => {
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
    removed: { cleanupPendingPath: null },
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
