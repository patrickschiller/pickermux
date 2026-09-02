import path from "node:path";
import { randomUUID } from "node:crypto";
import { readdir, rmdir, unlink } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { inspectCodexAccountCache } from "./account-cache.mjs";
import { assertRuntimeCompressionSupport } from "./body-codec.mjs";
import { loadBridgeConfig } from "./bridge-config.mjs";
import { discoverBridgeModels } from "./bridge-discovery.mjs";
import { runBridgeDoctor } from "./bridge-doctor.mjs";
import {
  checkCurrentCompatibility,
  createCompatibilityManifest,
  writeCompatibilityManifest,
} from "./compatibility-manifest.mjs";
import {
  certificationSubjectForModel,
  resolveCertificationStatuses,
  resolveCertifiedModelSlugs,
  runModelCertification,
} from "./certification-runner.mjs";
import {
  assertManagedLaunchAgent,
  bridgeBaseUrl,
  createRuntimeRecord,
  getBridgeServiceStatus,
  readRuntime,
  resolveLaunchAgentNodePath,
  restartBridgeService,
  startBridgeService,
  stopBridgeService,
} from "./bridge-runtime.mjs";
import { listenBridgeServer } from "./bridge-server.mjs";
import {
  buildMixedCodexCatalog,
  loadBundledCatalog,
  loadCodexClientVersion,
  loadNativeCatalog,
  readCodexCatalog,
  writeCatalogAtomic,
} from "./catalog.mjs";
import { isCodexDesktopRunning } from "./codex-desktop-state.mjs";
import {
  createCatalogSynchronizer,
  hasLoadedModelDiscovery,
} from "./catalog-sync.mjs";
import {
  assertCatalogSlugs,
  debugModels,
  providerOverrides,
} from "./codex.mjs";
import {
  getConfigStatus,
  inventoryManagedConfigOwnership,
  installConfig,
  revalidateManagedConfigOwnership,
  restoreRecoveredProviderEndMarker,
  uninstallConfig,
} from "./config-manager.mjs";
import {
  createCredentialResolver,
  deleteProviderCredential,
  listRegisteredKeychainProviderIds,
  providerCredentialStatus,
  purgeKeychainProviderRegistry,
  registerKeychainProvider,
  setProviderCredential,
  unregisterKeychainProvider,
} from "./keychain-credentials.mjs";
import {
  invalidateModelCertification,
  recordPassedCertification,
} from "./model-certification.mjs";
import {
  removeManagedDistribution,
  setupManagedDistribution,
  validateDistributionInstallation,
  withInstallationLock,
} from "./distribution-installer.mjs";
import {
  armFullRefreshLaunchAgent,
  cleanupFullRefreshArtifacts,
  prepareFullRefreshCheckpoint,
  readFullRefreshCheckpoint,
  runFullRefreshWorkflow,
} from "./full-refresh.mjs";
import {
  projectRoot,
  resolveCodexBinary,
  resolveDistributionPaths,
  resolveFullRefreshPaths,
  resolveInstallPaths,
  resolveProjectConfig,
} from "./paths.mjs";
import {
  buildProviderRegistry,
  createReloadableProviderRegistry,
} from "./provider-registry.mjs";
import { createRuntimeCompatibilityGate } from "./runtime-compatibility.mjs";
import {
  inventoryPickerMuxBackups,
  inventoryPickerMuxInstallDirectory,
  purgePickerMuxBackups,
  removeInventoriedRuntimeMetadata,
  revalidateInventoriedRuntimeMetadata,
  revalidatePickerMuxBackupInventory,
  revalidatePickerMuxInstallDirectoryInventory,
} from "./purge-data.mjs";
import {
  inventoryManagedServicePackage,
  revalidateManagedServicePackageInventory,
  removeInventoriedServicePackage,
} from "./runtime-purge.mjs";
import {
  assertCatalogSelection,
  reconcileSelectedCatalogModel,
} from "./selection-reconcile.mjs";
import {
  readOptionalPrivateFile,
  restorePrivateFile,
  restoreServicePackage,
  stageServicePackage,
  cleanupManagedArtifacts,
  finalizeServicePackage,
} from "./service-package.mjs";
import { readPickerMuxMetadata } from "./version.mjs";

const COMMANDS = new Set([
  "build",
  "certify",
  "credential-delete",
  "credential-set",
  "credential-status",
  "discover",
  "doctor",
  "help",
  "install",
  "refresh",
  "serve",
  "setup",
  "status",
  "uninstall",
  "version",
]);

function usage() {
  return `PickerMux — Codex + LM Studio, one model picker

Usage:
  pickermux discover [--config PATH] [--json]
  pickermux build [--config PATH] [--output PATH] [--json]
  pickermux certify (--model SLUG | --all) [--config PATH] [--json]
  pickermux credential-set PROVIDER [--config PATH]
  pickermux credential-status PROVIDER [--config PATH] [--json]
  pickermux credential-delete PROVIDER [--config PATH]
  pickermux setup [--config PATH]
  pickermux install [--config PATH] [--json]
  pickermux refresh [--config PATH] [--json]
  pickermux refresh --full
  pickermux doctor [--config PATH] [--live] [--json]
  pickermux status [--config PATH] [--json]
  pickermux uninstall [--force] [--remove-cli | --purge] [--json]
  pickermux version | pickermux --version

The bridge binds only to 127.0.0.1. Native ChatGPT authentication is never
stored and is stripped before every external request. Full purge removes only
verified PickerMux-owned data and registered provider credentials; it never
reads or removes ~/.codex/auth.json.`;
}

function parseArguments(argv) {
  const command = new Set(["--help", "-h"]).has(argv[0])
    ? "help"
    : new Set(["--version", "-v"]).has(argv[0])
      ? "version"
      : (argv[0] ?? "help");
  if (!COMMANDS.has(command)) {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
  const options = {
    command,
    configPath: undefined,
    outputPath: undefined,
    runtimePath: undefined,
    distributionRoot: undefined,
    force: false,
    removeCli: false,
    purge: false,
    full: false,
    fullWorker: false,
    json: false,
    live: false,
    all: false,
    model: undefined,
    providerId: undefined,
    checkpointPath: undefined,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") options.force = true;
    else if (argument === "--remove-cli") options.removeCli = true;
    else if (argument === "--purge") options.purge = true;
    else if (argument === "--full") options.full = true;
    else if (argument === "--full-worker") options.fullWorker = true;
    else if (argument === "--all") options.all = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--live") options.live = true;
    else if (["--checkpoint", "--config", "--distribution-root", "--output", "--runtime", "--model"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path`);
      index += 1;
      if (argument === "--checkpoint") options.checkpointPath = path.resolve(value);
      else if (argument === "--config") options.configPath = value;
      else if (argument === "--distribution-root") options.distributionRoot = value;
      else if (argument === "--output") options.outputPath = value;
      else if (argument === "--runtime") options.runtimePath = value;
      else options.model = value;
    } else if (
      new Set(["credential-set", "credential-status", "credential-delete"]).has(command) &&
      !argument.startsWith("--") &&
      options.providerId === undefined
    ) {
      options.providerId = argument;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.force && command !== "uninstall") throw new Error("--force is supported only by uninstall");
  if (options.removeCli && command !== "uninstall") throw new Error("--remove-cli is supported only by uninstall");
  if (options.purge && command !== "uninstall") throw new Error("--purge is supported only by uninstall");
  if (options.purge && options.removeCli) {
    throw new Error("--purge already includes --remove-cli");
  }
  if (options.full && command !== "refresh") {
    throw new Error("--full is supported only by refresh");
  }
  if (options.fullWorker && command !== "refresh") {
    throw new Error("--full-worker is supported only by refresh");
  }
  if (options.full && options.fullWorker) {
    throw new Error("--full and --full-worker cannot be combined");
  }
  if (options.fullWorker !== Boolean(options.checkpointPath)) {
    throw new Error("--full-worker and --checkpoint must be supplied together");
  }
  if ((options.full || options.fullWorker) && options.json) {
    throw new Error("Full refresh is interactive and does not support --json");
  }
  if ((options.full || options.fullWorker) && options.configPath) {
    throw new Error("Full refresh always reuses the installed service configuration");
  }
  if (options.distributionRoot && command !== "setup") {
    throw new Error("--distribution-root is supported only by setup");
  }
  if (options.live && command !== "doctor") throw new Error("--live is supported only by doctor");
  if (options.outputPath && command !== "build") throw new Error("--output is supported only by build");
  if (options.runtimePath && command !== "serve") throw new Error("--runtime is supported only by serve");
  if (options.all && command !== "certify") throw new Error("--all is supported only by certify");
  if (options.model && command !== "certify") throw new Error("--model is supported only by certify");
  if (command === "certify" && options.all === Boolean(options.model)) {
    throw new Error("certify requires exactly one of --model SLUG or --all");
  }
  if (
    new Set(["credential-set", "credential-status", "credential-delete"]).has(command) &&
    !options.providerId
  ) {
    throw new Error(`${command} requires a provider id`);
  }
  if (command === "serve" && !options.runtimePath) throw new Error("serve requires --runtime PATH");
  return options;
}

function printJson(value) {
  const serialized = JSON.stringify(
    value,
    (key, entry) => {
      if (key === "capability") return "[REDACTED_LOCAL_CAPABILITY]";
      if (typeof entry === "string") {
        return entry.replace(
          /\/c\/[A-Za-z0-9_-]{32,256}(?=\/|$)/gu,
          "/c/[REDACTED_LOCAL_CAPABILITY]",
        );
      }
      return entry;
    },
    2,
  );
  process.stdout.write(`${serialized}\n`);
}

function printChecks(result) {
  for (const entry of result.checks) {
    process.stdout.write(`${(entry.status === "pass" ? "PASS" : "FAIL").padEnd(5)} ${entry.name}: ${entry.detail}\n`);
  }
}

function printNativeCatalogWarning(result) {
  if (typeof result?.nativeCatalogWarning === "string" && result.nativeCatalogWarning) {
    process.stdout.write(`WARN  native-catalog: ${result.nativeCatalogWarning}\n`);
  }
}

export function assertPersistentCredentialSupport(config) {
  const protectedProviders = config.providers.filter((provider) => provider.credentialEnv);
  if (protectedProviders.length > 0) {
    throw new Error(
      `Persistent install refuses credentialEnv provider(s); configure credentialKeychain=true instead: ${protectedProviders.map((provider) => provider.id).join(", ")}`,
    );
  }
}

export async function assertBridgeStartupCompatibility({
  manifestPath,
  codexPath = resolveCodexBinary(),
  bundledCatalogImpl = loadBundledCatalog,
  clientVersionImpl = loadCodexClientVersion,
  compatibilityImpl = checkCurrentCompatibility,
} = {}) {
  const [bundledCatalog, codexClientVersion] = await Promise.all([
    bundledCatalogImpl({ codexPath }),
    clientVersionImpl({ codexPath }),
  ]);
  const compatibility = await compatibilityImpl({
    manifestPath,
    bundledCatalog,
    codexClientVersion,
  });
  if (compatibility?.compatible !== true) {
    const status = compatibility?.status ?? "update-required";
    const reasons = Array.isArray(compatibility?.reasons)
      ? compatibility.reasons.join(", ")
      : "compatibility check did not pass";
    throw new Error(
      `Bridge startup blocked: desktop compatibility is ${status} (${reasons})`,
    );
  }
  return { compatibility, bundledCatalog, codexClientVersion };
}

async function buildCatalog({
  config,
  codexPath,
  codexHome,
  outputPath,
  certificationPath,
  credentialResolver,
  allowBundledFallback = true,
}) {
  const [discovery, bundledCatalog, codexClientVersion] = await Promise.all([
    discoverBridgeModels({ config, credentialResolver }),
    loadBundledCatalog({ codexPath }),
    loadCodexClientVersion({ codexPath }),
  ]);
  const nativeCatalog = await loadNativeCatalog({
    codexHome,
    bundledCatalog,
    expectedClientVersion: codexClientVersion,
    allowBundledFallback,
  });
  const certifiedModelSlugs = certificationPath
    ? await resolveCertifiedModelSlugs({
        storePath: certificationPath,
        config,
        models: discovery.models,
        codexClientVersion,
      })
    : [];
  const catalog = buildMixedCodexCatalog({
    discoveredModels: discovery.models,
    bundledCatalog,
    nativeCatalog: nativeCatalog.catalog,
    certifiedModelSlugs,
  });
  const writtenPath = await writeCatalogAtomic(outputPath, catalog);
  return {
    discovery,
    bundledCatalog,
    nativeCatalog,
    codexClientVersion,
    certifiedModelSlugs,
    catalog,
    writtenPath,
  };
}

export function assertSelectedCatalogModel(catalog, model, reasoningEffort) {
  return assertCatalogSelection(catalog, model, reasoningEffort);
}

function installationOptions({ config, paths, runtime }) {
  return {
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
      baseUrl: bridgeBaseUrl(config, runtime),
      wireApi: "responses",
      requiresOpenAiAuth: true,
      supportsWebsockets: false,
      supportsStandaloneWebSearch: false,
      requestMaxRetries: 0,
      streamMaxRetries: 0,
      streamIdleTimeoutMs: config.bridge.limits.streamIdleTimeoutMs,
    },
  };
}

async function prevalidateCatalog({ config, runtime, catalog, catalogPath, codexPath }) {
  const overrides = providerOverrides({
    model: config.bridge.defaultModel,
    reasoningEffort: config.bridge.reasoningEffort,
    providerId: config.bridge.providerId,
    providerName: "OpenAI",
    baseUrl: bridgeBaseUrl(config, runtime),
    catalogPath,
    requiresOpenAiAuth: true,
    supportsWebsockets: false,
  });
  const parsed = await debugModels({ codexPath, overrides });
  assertCatalogSlugs(parsed, catalog.models.map((model) => model.slug));
  return parsed;
}

async function rollbackInstallation({
  paths,
  configInstalled,
  serviceStarted,
  catalogPromoted,
  previousCatalog,
  compatibilityPromoted,
  previousCompatibility = null,
  servicePackage,
  cause,
}) {
  const failures = [];
  if (configInstalled) {
    try {
      await uninstallConfig({
        configPath: paths.configPath,
        statePath: paths.statePath,
        backupDirectory: paths.backupDirectory,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (serviceStarted) {
    try {
      await stopBridgeService({
        runtimePath: paths.runtimePath,
        launchAgentPath: paths.launchAgentPath,
        launchAgentLabel: paths.launchAgentLabel,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (catalogPromoted) {
    try {
      await restorePrivateFile(paths.catalogPath, previousCatalog);
    } catch (error) {
      failures.push(error);
    }
  }
  if (compatibilityPromoted) {
    try {
      await restorePrivateFile(paths.compatibilityPath, previousCompatibility);
    } catch (error) {
      failures.push(error);
    }
  }
  if (servicePackage) {
    try {
      await restoreServicePackage({
        serviceDirectory: servicePackage.serviceDirectory,
        previousPath: servicePackage.previousPath,
        serviceConfigPath: servicePackage.serviceConfigPath,
        previousServiceConfig: servicePackage.previousServiceConfig,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `PickerMux installation failed and rollback was incomplete. Original: ${cause.message}; rollback: ${failures.map((error) => error.message).join("; ")}`,
      { cause: new AggregateError([cause, ...failures]) },
    );
  }
  throw new Error(`PickerMux installation failed; all managed changes were rolled back: ${cause.message}`, { cause });
}

async function install({
  config,
  configPath,
  paths,
  codexPath,
  sourceRoot = projectRoot,
}) {
  assertRuntimeCompressionSupport();
  assertPersistentCredentialSupport(config);
  const existing = await getConfigStatus({ configPath: paths.configPath, statePath: paths.statePath });
  if (existing.installed) throw new Error(`PickerMux is already installed (${existing.status})`);

  const stagingPath = path.join(
    paths.installDirectory,
    `.models.install-${process.pid}-${randomUUID()}.json`,
  );
  const runtime = createRuntimeRecord({ configPath: paths.serviceConfigPath });
  let serviceStarted = false;
  let configInstalled = false;
  let catalogPromoted = false;
  let compatibilityPromoted = false;
  let servicePackage;
  let previousCatalog;
  let previousCompatibility;
  let registeredProviderIds = [];
  try {
    registeredProviderIds = await registerConfiguredKeychainProviders({
      config,
      registryPath: paths.keychainRegistryPath,
    });
    const built = await buildCatalog({
      config,
      codexPath,
      codexHome: paths.codexHome,
      outputPath: stagingPath,
      certificationPath: paths.certificationPath,
      allowBundledFallback: false,
    });
    assertSelectedCatalogModel(
      built.catalog,
      config.bridge.defaultModel,
      config.bridge.reasoningEffort,
    );
    await prevalidateCatalog({
      config,
      runtime,
      catalog: built.catalog,
      catalogPath: stagingPath,
      codexPath,
    });

    [previousCatalog, previousCompatibility] = await Promise.all([
      readOptionalPrivateFile(paths.catalogPath),
      readOptionalPrivateFile(paths.compatibilityPath),
    ]);
    servicePackage = await stageServicePackage({
      sourceRoot,
      installDirectory: paths.installDirectory,
      config,
    });
    await writeCatalogAtomic(paths.catalogPath, built.catalog);
    catalogPromoted = true;
    await writeCompatibilityManifest(
      paths.compatibilityPath,
      createCompatibilityManifest({
        codexClientVersion: built.codexClientVersion,
        bundledCatalog: built.bundledCatalog,
      }),
    );
    compatibilityPromoted = true;
    await startBridgeService({
      config,
      configPath: servicePackage.serviceConfigPath,
      runtimePath: paths.runtimePath,
      launchAgentPath: paths.launchAgentPath,
      launchAgentLabel: paths.launchAgentLabel,
      logPath: paths.logPath,
      binPath: servicePackage.binPath,
      workingDirectory: servicePackage.serviceDirectory,
      nodePath: resolveLaunchAgentNodePath(),
      runtime,
    });
    serviceStarted = true;
    const installed = await installConfig(installationOptions({ config, paths, runtime }));
    configInstalled = true;

    const parsed = await debugModels({ codexPath });
    assertCatalogSlugs(parsed, built.catalog.models.map((model) => model.slug));
    const doctor = await runBridgeDoctor({ config, paths, codexPath });
    if (!doctor.ok) {
      throw new Error(
        doctor.checks
          .filter((entry) => entry.status === "fail")
          .map((entry) => `${entry.name}: ${entry.detail}`)
          .join("; "),
      );
    }
    await cleanupLegacyRuntimePackages(paths, servicePackage);
    await finalizeServicePackage(servicePackage);
    return {
      installed,
      service: "running",
      catalogPath: paths.catalogPath,
      nativeModels: built.nativeCatalog.catalog.models.length,
      nativeCatalogSource: built.nativeCatalog.source,
      nativeCatalogFetchedAt: built.nativeCatalog.fetchedAt ?? null,
      nativeCatalogWarning: built.nativeCatalog.warning ?? null,
      externalModels: built.discovery.models,
      doctor,
      restartRequired: true,
    };
  } catch (error) {
    let registryRollbackError;
    try {
      await rollbackKeychainProviderRegistrations(
        registeredProviderIds,
        paths.keychainRegistryPath,
      );
    } catch (rollbackError) {
      registryRollbackError = rollbackError;
    }
    try {
      await rollbackInstallation({
        paths,
        configInstalled,
        serviceStarted,
        catalogPromoted,
        previousCatalog,
        compatibilityPromoted,
        previousCompatibility,
        servicePackage,
        cause: error,
      });
    } catch (installationError) {
      if (!registryRollbackError) throw installationError;
      throw new Error(
        `${installationError.message}; Keychain provider registry rollback was incomplete: ${registryRollbackError.message}`,
        {
          cause: new AggregateError([
            installationError,
            registryRollbackError,
          ]),
        },
      );
    }
  } finally {
    await unlink(stagingPath).catch(() => {});
  }
}

export async function restoreRefreshState({
  paths,
  previousCatalog,
  previousServiceConfig,
  previousCompatibility = null,
  rollbackConfig,
  servicePackage,
  restoreImpl = restorePrivateFile,
  restorePackageImpl = restoreServicePackage,
  restartImpl = restartBridgeService,
}) {
  const failures = [];
  if (servicePackage) {
    try {
      await restorePackageImpl({
        serviceDirectory: servicePackage.serviceDirectory,
        previousPath: servicePackage.previousPath,
        serviceConfigPath: servicePackage.serviceConfigPath,
        previousServiceConfig: servicePackage.previousServiceConfig,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  const snapshots = [
    [paths.catalogPath, previousCatalog],
    [paths.serviceConfigPath, previousServiceConfig],
  ];
  if (paths.compatibilityPath) {
    snapshots.push([paths.compatibilityPath, previousCompatibility]);
  }
  for (const [target, snapshot] of snapshots) {
    try {
      await restoreImpl(target, snapshot);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await restartImpl({
      config: rollbackConfig,
      runtimePath: paths.runtimePath,
      launchAgentLabel: paths.launchAgentLabel,
    });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) throw new AggregateError(failures, "PickerMux refresh rollback failed");
}

async function refresh({ config, paths, codexPath, sourceRoot = projectRoot }) {
  assertRuntimeCompressionSupport();
  assertPersistentCredentialSupport(config);
  const status = await getConfigStatus({ configPath: paths.configPath, statePath: paths.statePath });
  if (!status.installed || !status.healthy) throw new Error("PickerMux must be healthily installed before refresh");
  const runtime = await readRuntime(paths.runtimePath);
  const expected = installationOptions({ config, paths, runtime });
  if (
    status.provider !== expected.modelProvider ||
    status.providerName !== expected.provider.name ||
    status.catalog !== expected.modelCatalogJson ||
    status.baseUrl !== expected.provider.baseUrl
  ) {
    throw new Error("Installed PickerMux configuration differs from the project config; uninstall and install again");
  }

  const currentCatalog = await readCodexCatalog(paths.catalogPath);
  const [previousCatalog, previousServiceConfig, previousCompatibility] = await Promise.all([
    readOptionalPrivateFile(paths.catalogPath),
    readOptionalPrivateFile(paths.serviceConfigPath),
    readOptionalPrivateFile(paths.compatibilityPath),
  ]);
  if (!previousCatalog || !previousServiceConfig) {
    throw new Error("PickerMux refresh requires an existing catalog and service configuration");
  }
  let rollbackConfig;
  try {
    rollbackConfig = await loadBridgeConfig(paths.serviceConfigPath);
  } catch (error) {
    throw new Error(`Installed PickerMux service configuration is invalid: ${error.message}`, {
      cause: error,
    });
  }
  const stagingPath = path.join(paths.installDirectory, `.models.refresh-${process.pid}-${randomUUID()}.json`);
  try {
    const built = await buildCatalog({
      config,
      codexPath,
      codexHome: paths.codexHome,
      outputPath: stagingPath,
      certificationPath: paths.certificationPath,
      allowBundledFallback: false,
    });
    await prevalidateCatalog({
      config,
      runtime,
      catalog: built.catalog,
      catalogPath: stagingPath,
      codexPath,
    });
    const selection = await reconcileSelectedCatalogModel({
      config,
      currentCatalog,
      nextCatalog: built.catalog,
      configPath: paths.configPath,
      statePath: paths.statePath,
    });
    let servicePackage;
    let registeredProviderIds = [];
    try {
      servicePackage = await stageServicePackage({
        sourceRoot,
        installDirectory: paths.installDirectory,
        config,
      });
      await writeCatalogAtomic(paths.catalogPath, built.catalog);
      await writeCompatibilityManifest(
        paths.compatibilityPath,
        createCompatibilityManifest({
          codexClientVersion: built.codexClientVersion,
          bundledCatalog: built.bundledCatalog,
        }),
      );
      await restartBridgeService({
        config,
        runtimePath: paths.runtimePath,
        launchAgentLabel: paths.launchAgentLabel,
      });
      const parsed = await debugModels({ codexPath });
      assertCatalogSlugs(parsed, built.catalog.models.map((model) => model.slug));
      const doctor = await runBridgeDoctor({ config, paths, codexPath });
      if (!doctor.ok) {
        throw new Error(
          doctor.checks
            .filter((entry) => entry.status === "fail")
            .map((entry) => `${entry.name}: ${entry.detail}`)
            .join("; "),
        );
      }
      registeredProviderIds = await registerConfiguredKeychainProviders({
        config,
        registryPath: paths.keychainRegistryPath,
      });
      await cleanupLegacyRuntimePackages(paths, servicePackage);
      await finalizeServicePackage(servicePackage);
    } catch (error) {
      let selectionRollbackError;
      try {
        await rollbackKeychainProviderRegistrations(
          registeredProviderIds,
          paths.keychainRegistryPath,
        );
      } catch (rollbackError) {
        selectionRollbackError = rollbackError;
      }
      try {
        await restoreRefreshState({
          paths,
          previousCatalog,
          previousServiceConfig,
          previousCompatibility,
          rollbackConfig,
          servicePackage,
        });
      } catch (rollbackError) {
        selectionRollbackError = selectionRollbackError
          ? new AggregateError(
              [selectionRollbackError, rollbackError],
              "Refresh registry and state rollback failed",
            )
          : rollbackError;
      }
      if (selection.changed && typeof selection.rollback === "function") {
        try {
          await selection.rollback();
        } catch (rollbackError) {
          selectionRollbackError = selectionRollbackError
            ? new AggregateError(
                [selectionRollbackError, rollbackError],
                "Refresh state and picker selection rollback failed",
              )
            : rollbackError;
        }
      }
      if (selectionRollbackError) {
        throw new Error(
          `PickerMux refresh failed and rollback was incomplete. Original: ${error.message}; rollback: ${selectionRollbackError.errors?.map((entry) => entry.message).join("; ") ?? selectionRollbackError.message}`,
          { cause: new AggregateError([error, selectionRollbackError]) },
        );
      }
      throw new Error(
        `PickerMux refresh failed; previous catalog and service configuration were restored: ${error.message}`,
        { cause: error },
      );
    }
    return {
      refreshed: true,
      catalogPath: paths.catalogPath,
      externalModels: built.discovery.models,
      nativeCatalogSource: built.nativeCatalog.source,
      nativeCatalogFetchedAt: built.nativeCatalog.fetchedAt ?? null,
      nativeCatalogWarning: built.nativeCatalog.warning ?? null,
      runtimeUpdated: true,
      selectionReset: selection.changed,
      restartRequired: true,
    };
  } finally {
    await unlink(stagingPath).catch(() => {});
  }
}

async function serve({
  config,
  configPath,
  runtimePath,
  codexPath = resolveCodexBinary(),
}) {
  assertRuntimeCompressionSupport();
  const runtime = await readRuntime(runtimePath);
  if (path.resolve(runtime.configPath) !== path.resolve(configPath)) {
    throw new Error("Bridge runtime belongs to another project config");
  }
  const catalogPath = path.join(path.dirname(runtimePath), "models.json");
  const installDirectory = path.dirname(runtimePath);
  const certificationPath = path.join(installDirectory, "certifications.json");
  let synchronizer;
  let lastCompatibilityStatus;
  const compatibilityGate = createRuntimeCompatibilityGate({
    manifestPath: path.join(installDirectory, "compatibility.json"),
    codexPath,
    onBlocked(state) {
      if (state?.status === "update-required") synchronizer?.stop();
      const safeStatus = state?.status === "update-required"
        ? "update-required"
        : "check-failed";
      if (safeStatus !== lastCompatibilityStatus) {
        process.stderr.write(
          `desktop compatibility blocked; bridge requests are disabled (${safeStatus})\n`,
        );
        lastCompatibilityStatus = safeStatus;
      }
    },
  });
  let startupCompatibility;
  try {
    startupCompatibility = await compatibilityGate.initialize();
  } catch (error) {
    const status = error?.status ?? "check-failed";
    const reasons = Array.isArray(error?.reasons) && error.reasons.length > 0
      ? error.reasons.join(", ")
      : "compatibility check did not pass";
    throw new Error(
      `Bridge startup blocked: desktop compatibility is ${status} (${reasons})`,
      { cause: error },
    );
  }
  const codexClientVersion = startupCompatibility.codexClientVersion;
  const credentialResolver = createCredentialResolver();
  const managedPickerPaths = {
    configPath: path.join(path.dirname(installDirectory), "config.toml"),
    statePath: path.join(installDirectory, "state.json"),
  };
  const mixedCatalog = await readCodexCatalog(catalogPath);
  const registry = createReloadableProviderRegistry(
    buildProviderRegistry({ mixedCatalog, config }),
  );
  let lastSyncError;
  synchronizer = hasLoadedModelDiscovery(config)
    ? createCatalogSynchronizer({
        config,
        initialCatalog: mixedCatalog,
        catalogPath,
        registryController: registry,
        discoverImpl(args) {
          return discoverBridgeModels({ ...args, credentialResolver });
        },
        certificationResolver(models) {
          return resolveCertifiedModelSlugs({
            storePath: certificationPath,
            config,
            models,
            codexClientVersion,
          });
        },
        assertPublishAllowed() {
          return compatibilityGate.assertReady();
        },
        reconcileSelectionImpl(args) {
          return reconcileSelectedCatalogModel({
            ...args,
            ...managedPickerPaths,
          });
        },
        onUpdate(result) {
          lastSyncError = undefined;
          process.stdout.write(
            `model catalog synchronized: ${result.registry.nativeModels.length} native and ${result.registry.externalModels.length} loaded external route(s)\n`,
          );
        },
        onError(error) {
          const message = String(error?.message ?? error);
          if (message !== lastSyncError) {
            process.stderr.write(
              `model catalog sync warning; keeping last known good routes: ${message}\n`,
            );
            lastSyncError = message;
          }
        },
        onDesktopStateChange(running) {
          process.stdout.write(
            running
              ? "model catalog discovery paused while Codex Desktop is running\n"
              : "model catalog discovery resumed while Codex Desktop is closed\n",
          );
        },
      })
    : undefined;
  if (synchronizer) {
    const initialSync = await synchronizer.tick();
    if (!initialSync.error) lastSyncError = undefined;
  }
  const server = await listenBridgeServer({
    registry,
    capabilityToken: runtime.capability,
    instanceId: runtime.instanceId,
    limits: config.bridge.limits,
    credentialResolver,
    port: config.bridge.port,
    compatibilityGate,
  });
  process.stdout.write(
    `model bridge ready on 127.0.0.1:${config.bridge.port}; ${registry.nativeModels.length} native and ${registry.externalModels.length} external route(s)\n`,
  );
  synchronizer?.start();
  compatibilityGate.start();
  try {
    await new Promise((resolve, reject) => {
      let shuttingDown = false;
      const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        synchronizer?.stop();
        compatibilityGate.stop();
        server.close((error) => (error ? reject(error) : resolve()));
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
      server.once("error", reject);
    });
  } finally {
    synchronizer?.stop();
    compatibilityGate.stop();
  }
}

function configuredProvider(config, providerId) {
  const provider = config.providers.find((entry) => entry.id === providerId);
  if (!provider) throw new Error(`Unknown configured provider: ${providerId}`);
  return provider;
}

async function rollbackKeychainProviderRegistrations(
  providerIds,
  registryPath,
  unregisterImpl = unregisterKeychainProvider,
) {
  const failures = [];
  for (const providerId of [...providerIds].reverse()) {
    try {
      await unregisterImpl(providerId, { registryPath });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "PickerMux Keychain provider registry rollback failed",
    );
  }
}

async function registerConfiguredKeychainProviders({
  config,
  registryPath,
  registerImpl = registerKeychainProvider,
  unregisterImpl = unregisterKeychainProvider,
}) {
  const addedProviderIds = [];
  try {
    for (const provider of config.providers.filter(
      (entry) => entry.credentialKeychain === true,
    )) {
      const result = await registerImpl(provider, { registryPath });
      if (result.added) addedProviderIds.push(result.providerId);
    }
  } catch (error) {
    try {
      await rollbackKeychainProviderRegistrations(
        addedProviderIds,
        registryPath,
        unregisterImpl,
      );
    } catch (rollbackError) {
      throw new Error(
        `PickerMux Keychain provider registry update failed and rollback was incomplete: ${rollbackError.message}`,
        { cause: new AggregateError([error, rollbackError]) },
      );
    }
    throw error;
  }
  return Object.freeze(addedProviderIds);
}

export async function credentialCommand({
  command,
  config,
  providerId,
  registryPath,
  registerImpl = registerKeychainProvider,
  unregisterImpl = unregisterKeychainProvider,
  setCredentialImpl = setProviderCredential,
  deleteCredentialImpl = deleteProviderCredential,
  credentialStatusImpl = providerCredentialStatus,
}) {
  const provider = configuredProvider(config, providerId);
  if (provider.credentialKeychain !== true) {
    throw new Error(`Provider ${providerId} is not configured with credentialKeychain=true`);
  }
  if (command === "credential-set") {
    await registerImpl(provider, { registryPath });
    await setCredentialImpl(provider);
    return { providerId, source: "keychain", updated: true };
  }
  if (command === "credential-delete") {
    const deleted = await deleteCredentialImpl(provider);
    await unregisterImpl(provider, { registryPath });
    return { providerId, source: "keychain", deleted };
  }
  return credentialStatusImpl(provider);
}

async function certify({ config, paths, codexPath, model, all }) {
  const [managedConfig, service, runtime, codexClientVersion] = await Promise.all([
    getConfigStatus({ configPath: paths.configPath, statePath: paths.statePath }),
    getBridgeServiceStatus({
      config,
      runtimePath: paths.runtimePath,
      launchAgentLabel: paths.launchAgentLabel,
    }),
    readRuntime(paths.runtimePath),
    loadCodexClientVersion({ codexPath }),
  ]);
  if (!managedConfig.installed || !managedConfig.healthy || !service.healthy) {
    throw new Error("PickerMux model certification requires a healthy installed bridge");
  }

  const credentialResolver = createCredentialResolver();
  const discovery = await discoverBridgeModels({ config, credentialResolver });
  const supported = discovery.models;
  const candidates = all
    ? supported
    : supported.filter((entry) => entry.id === model);
  if (candidates.length === 0) {
    throw new Error(
      all
        ? "No external model is available for certification"
        : `External model ${model} was not discovered`,
    );
  }

  const candidatesWithSubjects = candidates.map((candidate) => ({
    candidate,
    subject: certificationSubjectForModel({
      config,
      model: candidate,
      codexClientVersion,
    }),
  }));

  // Re-certification is fail-closed: remove every previous receipt first and
  // publish the conservative text-only catalog before sending a probe. If the
  // process is interrupted mid-matrix, no stale tool grant remains active.
  for (const { subject } of candidatesWithSubjects) {
    await invalidateModelCertification(paths.certificationPath, subject);
  }
  await refresh({ config, paths, codexPath });

  const completed = [];
  for (const { candidate, subject } of candidatesWithSubjects) {
    try {
      const gates = await runModelCertification({
        baseUrl: bridgeBaseUrl(config, runtime),
        model: candidate,
        certificationToken: runtime.instanceId,
      });
      const receipt = await recordPassedCertification(
        paths.certificationPath,
        subject,
        gates,
      );
      completed.push({
        model: candidate.id,
        status: "valid",
        passedAt: receipt.passedAt,
      });
    } catch (error) {
      let refreshError;
      try {
        await refresh({ config, paths, codexPath });
      } catch (candidateRefreshError) {
        refreshError = candidateRefreshError;
      }
      if (refreshError) {
        throw new AggregateError(
          [error, refreshError],
          `Certification failed for ${candidate.id}; deactivation refresh also failed`,
        );
      }
      throw new Error(`Certification failed for ${candidate.id}: ${error.message}`, {
        cause: error,
      });
    }
  }

  const refreshed = await refresh({ config, paths, codexPath });
  return { certified: completed, refreshed, restartRequired: true };
}

async function managedRuntimeDirectories(paths) {
  const names = await readdir(paths.installDirectory).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return names
    .filter(
      (name) =>
        name === "runtime-app" ||
        /^runtime-app\.previous-\d+-[0-9a-f]{8}$/u.test(name),
    )
    .map((name) => path.join(paths.installDirectory, name));
}

async function cleanupLegacyRuntimePackages(paths, activePackage) {
  const protectedPaths = new Set(
    [activePackage.serviceDirectory, activePackage.previousPath]
      .filter(Boolean)
      .map((entry) => path.resolve(entry)),
  );
  const legacy = (await managedRuntimeDirectories(paths)).filter(
    (entry) => !protectedPaths.has(path.resolve(entry)),
  );
  return cleanupManagedArtifacts({ runtimeDirectories: legacy });
}

function expectedManagedLaunchAgent(paths) {
  return {
    binPath: path.join(paths.serviceDirectory, "bin", "lmstudio-picker.mjs"),
    configPath: paths.serviceConfigPath,
    runtimePath: paths.runtimePath,
    workingDirectory: paths.serviceDirectory,
    logPath: paths.logPath,
  };
}

function managedLaunchAgentOptions(paths) {
  return {
    launchAgentPath: paths.launchAgentPath,
    launchAgentLabel: paths.launchAgentLabel,
    ...expectedManagedLaunchAgent(paths),
  };
}

async function restoreFullRefreshBridgeService({
  config,
  paths,
  runtime,
  nodePath,
  serviceStatusImpl = getBridgeServiceStatus,
  startServiceImpl = startBridgeService,
}) {
  const service = await serviceStatusImpl({
    config,
    runtimePath: paths.runtimePath,
    launchAgentLabel: paths.launchAgentLabel,
  });
  if (service.loaded && service.healthy) return service;
  if (service.loaded) {
    throw new Error(
      `Bridge service rollback found a loaded but unhealthy service (${service.status})`,
    );
  }
  return startServiceImpl({
    config,
    configPath: paths.serviceConfigPath,
    runtimePath: paths.runtimePath,
    launchAgentPath: paths.launchAgentPath,
    launchAgentLabel: paths.launchAgentLabel,
    logPath: paths.logPath,
    binPath: path.join(paths.serviceDirectory, "bin", "lmstudio-picker.mjs"),
    workingDirectory: paths.serviceDirectory,
    nodePath,
    runtime,
  });
}

/**
 * Restore native Codex configuration without deleting the installed catalog,
 * service package, service configuration, certifications, or CLI receipt.
 * The service is stopped first so a configuration failure can restore it
 * without ever exposing native Codex traffic to a half-removed bridge.
 */
export async function suspendPickerMuxForFullRefresh({
  config,
  paths,
  sourceRoot,
  configStatusImpl = getConfigStatus,
  runtimeImpl = readRuntime,
  validateLaunchAgentImpl = assertManagedLaunchAgent,
  inventoryRuntimeImpl = inventoryManagedServicePackage,
  inventoryConfigImpl = inventoryManagedConfigOwnership,
  revalidateConfigImpl = revalidateManagedConfigOwnership,
  uninstallConfigImpl = uninstallConfig,
  stopServiceImpl = stopBridgeService,
  serviceStatusImpl = getBridgeServiceStatus,
  startServiceImpl = startBridgeService,
} = {}) {
  if (!config || !paths || typeof sourceRoot !== "string") {
    throw new TypeError("Full refresh suspension requires config, paths, and sourceRoot");
  }
  const status = await configStatusImpl({
    configPath: paths.configPath,
    statePath: paths.statePath,
  });
  if (status.healthy !== true) {
    throw new Error(
      `PickerMux full refresh refuses inconsistent integration state (${status.status ?? "unknown"})`,
    );
  }

  if (!status.installed) {
    const service = await stopServiceImpl({
      runtimePath: paths.runtimePath,
      launchAgentPath: paths.launchAgentPath,
      launchAgentLabel: paths.launchAgentLabel,
      expectedLaunchAgent: expectedManagedLaunchAgent(paths),
      removeRuntime: true,
    });
    return {
      suspended: true,
      alreadySuspended: true,
      removedConfig: { changed: false, installed: false },
      service,
    };
  }

  const runtime = await runtimeImpl(paths.runtimePath);
  const expected = installationOptions({ config, paths, runtime });
  if (
    status.provider !== expected.modelProvider ||
    status.providerName !== expected.provider.name ||
    status.catalog !== expected.modelCatalogJson ||
    status.baseUrl !== expected.provider.baseUrl
  ) {
    throw new Error(
      "Installed PickerMux configuration differs from its preserved service configuration",
    );
  }

  const launchAgent = await validateLaunchAgentImpl(
    managedLaunchAgentOptions(paths),
  );
  if (!launchAgent.present || typeof launchAgent.nodePath !== "string") {
    throw new Error("PickerMux full refresh requires its managed bridge service");
  }
  await inventoryRuntimeImpl({
    serviceDirectory: paths.serviceDirectory,
    sourceRoot,
  });
  const configOwnership = await inventoryConfigImpl({
    configPath: paths.configPath,
    statePath: paths.statePath,
    backupDirectory: paths.backupDirectory,
  });

  let serviceStopped = false;
  try {
    const service = await stopServiceImpl({
      runtimePath: paths.runtimePath,
      launchAgentPath: paths.launchAgentPath,
      launchAgentLabel: paths.launchAgentLabel,
      expectedLaunchAgent: expectedManagedLaunchAgent(paths),
      removeRuntime: true,
    });
    serviceStopped = true;
    await inventoryRuntimeImpl({
      serviceDirectory: paths.serviceDirectory,
      sourceRoot,
    });
    await revalidateConfigImpl(configOwnership);
    const removedConfig = await uninstallConfigImpl({
      configPath: paths.configPath,
      statePath: paths.statePath,
      backupDirectory: paths.backupDirectory,
      ownershipReceipt: configOwnership,
    });
    const suspendedStatus = await configStatusImpl({
      configPath: paths.configPath,
      statePath: paths.statePath,
    });
    if (suspendedStatus.installed || suspendedStatus.healthy !== true) {
      throw new Error("Native Codex configuration was not restored cleanly");
    }
    return {
      suspended: true,
      alreadySuspended: false,
      removedConfig,
      service,
    };
  } catch (cause) {
    if (!serviceStopped) throw cause;
    try {
      const rollbackStatus = await configStatusImpl({
        configPath: paths.configPath,
        statePath: paths.statePath,
      });
      if (!rollbackStatus.installed || rollbackStatus.healthy !== true) {
        throw new Error(
          `Managed configuration could not be proven intact (${rollbackStatus.status ?? "unknown"})`,
        );
      }
      await inventoryRuntimeImpl({
        serviceDirectory: paths.serviceDirectory,
        sourceRoot,
      });
      await restoreFullRefreshBridgeService({
        config,
        paths,
        runtime,
        nodePath: launchAgent.nodePath,
        serviceStatusImpl,
        startServiceImpl,
      });
    } catch (rollbackError) {
      throw new Error(
        `PickerMux full refresh suspension failed and service rollback was incomplete. Original: ${cause.message}; rollback: ${rollbackError.message}`,
        { cause: new AggregateError([cause, rollbackError]) },
      );
    }
    throw new Error(
      `PickerMux full refresh suspension failed; the managed bridge service was restored: ${cause.message}`,
      { cause },
    );
  }
}

export async function reactivatePickerMuxAfterFullRefresh({
  config,
  paths,
  codexPath,
  sourceRoot,
  configStatusImpl = getConfigStatus,
  installImpl = install,
  doctorImpl = runBridgeDoctor,
} = {}) {
  if (!config || !paths || typeof sourceRoot !== "string") {
    throw new TypeError("Full refresh reactivation requires config, paths, and sourceRoot");
  }
  const status = await configStatusImpl({
    configPath: paths.configPath,
    statePath: paths.statePath,
  });
  if (status.healthy !== true) {
    throw new Error(
      `PickerMux full refresh refuses inconsistent integration state (${status.status ?? "unknown"})`,
    );
  }
  if (!status.installed) {
    return installImpl({
      config,
      configPath: paths.serviceConfigPath,
      paths,
      codexPath,
      sourceRoot,
    });
  }

  const doctor = await doctorImpl({ config, paths, codexPath });
  if (!doctor.ok) {
    throw new Error(
      doctor.checks
        .filter((entry) => entry.status === "fail")
        .map((entry) => `${entry.name}: ${entry.detail}`)
        .join("; "),
    );
  }
  return {
    installed: true,
    alreadyActive: true,
    doctor,
    restartRequired: true,
  };
}

export async function uninstallIntegration({
  paths,
  force,
  preserveHistoricalModelBridge = false,
  servicePackageInventory,
  runtimePreflightCompleted = false,
  installDirectoryInventory,
  backupDirectoryInventory,
  configOwnershipReceipt,
  readBackupImpl,
  sourceRoot = projectRoot,
  inventoryInstallImpl = inventoryPickerMuxInstallDirectory,
  inventoryBackupsImpl = inventoryPickerMuxBackups,
  inventoryConfigImpl = inventoryManagedConfigOwnership,
  revalidateConfigImpl = revalidateManagedConfigOwnership,
  revalidateRuntimeImpl = revalidateManagedServicePackageInventory,
  revalidateMetadataImpl = revalidateInventoriedRuntimeMetadata,
  uninstallConfigImpl = uninstallConfig,
  stopServiceImpl = stopBridgeService,
  removeMetadataImpl = removeInventoriedRuntimeMetadata,
  removeRuntimeImpl = removeInventoriedServicePackage,
}) {
  if (typeof runtimePreflightCompleted !== "boolean") {
    throw new TypeError("runtimePreflightCompleted must be a boolean");
  }
  if (typeof preserveHistoricalModelBridge !== "boolean") {
    throw new TypeError("preserveHistoricalModelBridge must be a boolean");
  }
  if (runtimePreflightCompleted && servicePackageInventory === undefined) {
    throw new TypeError(
      "runtimePreflightCompleted requires a supplied service package inventory",
    );
  }
  await assertManagedLaunchAgent(managedLaunchAgentOptions(paths));
  const runtimeDirectories = await managedRuntimeDirectories(paths);
  const unexpectedRuntimeDirectories = runtimeDirectories.filter(
    (entry) => path.resolve(entry) !== path.resolve(paths.serviceDirectory),
  );
  if (unexpectedRuntimeDirectories.length > 0) {
    throw new Error(
      "PickerMux uninstall refuses unreceipted previous runtime packages; review or refresh the installation first",
    );
  }
  const runtimeInventory = servicePackageInventory ??
    await inventoryManagedServicePackage({
      serviceDirectory: paths.serviceDirectory,
      sourceRoot,
    });
  const installInventory = installDirectoryInventory ??
    await inventoryInstallImpl({ installDirectory: paths.installDirectory });
  if (!runtimePreflightCompleted) {
    await revalidateRuntimeImpl(runtimeInventory);
  }
  await revalidateMetadataImpl(installInventory);
  const backupInventory = backupDirectoryInventory ??
    await inventoryBackupsImpl({
      backupDirectory: paths.backupDirectory,
      configPath: paths.configPath,
    });
  const configOwnership = configOwnershipReceipt ??
    await inventoryConfigImpl({
      configPath: paths.configPath,
      statePath: paths.statePath,
      backupDirectory: paths.backupDirectory,
      backupDirectoryInventory: backupInventory,
      readBackupImpl,
    });
  await revalidateConfigImpl(configOwnership, { readBackupImpl });
  const removedConfig = await uninstallConfigImpl({
    configPath: paths.configPath,
    statePath: paths.statePath,
    backupDirectory: paths.backupDirectory,
    backupDirectoryInventory: backupInventory,
    ownershipReceipt: configOwnership,
    readBackupImpl,
    force,
    preserveHistoricalModelBridge,
  });
  const service = await stopServiceImpl({
    runtimePath: paths.runtimePath,
    launchAgentPath: paths.launchAgentPath,
    launchAgentLabel: paths.launchAgentLabel,
    expectedLaunchAgent: expectedManagedLaunchAgent(paths),
    removeRuntime: false,
  });
  const artifacts = await removeMetadataImpl({
    inventory: installInventory,
  });
  if (artifacts.cleanupPendingPath) {
    const error = new Error(
      `PickerMux runtime metadata cleanup is pending at ${artifacts.cleanupPendingPath}`,
    );
    error.cleanupPendingPath = artifacts.cleanupPendingPath;
    throw error;
  }
  const runtimePackage = await removeRuntimeImpl({
    inventory: runtimeInventory,
    // Config and metadata cleanup above account for every permitted parent
    // transition; runtime-purge still rejects additions and identity changes.
    allowReceiptBoundParentTransitions: true,
  });
  if (runtimePackage.cleanupPendingPath) {
    const error = new Error(
      `PickerMux runtime package cleanup is pending at ${runtimePackage.cleanupPendingPath}`,
    );
    error.cleanupPendingPath = runtimePackage.cleanupPendingPath;
    throw error;
  }
  return {
    removedConfig,
    service,
    artifacts: {
      ...artifacts,
      removedRuntimeDirectories: runtimePackage.changed
        ? [paths.serviceDirectory]
        : [],
      runtimeCleanupPendingPath: runtimePackage.cleanupPendingPath,
      metadataCleanupPendingPath: artifacts.cleanupPendingPath,
    },
  };
}

function sameProviderIds(left, right) {
  return left.length === right.length && left.every(
    (providerId, index) => providerId === right[index],
  );
}

function assertSameDistributionOwnership(previous, confirmed) {
  if (
    previous?.installed !== true ||
    confirmed?.installed !== true ||
    typeof previous.activeDirectory !== "string" ||
    confirmed.activeDirectory !== previous.activeDirectory ||
    !Buffer.isBuffer(previous.raw) ||
    !Buffer.isBuffer(confirmed.raw) ||
    !confirmed.raw.equals(previous.raw)
  ) {
    throw new Error(
      "PickerMux CLI ownership state changed before integration removal",
    );
  }
}

async function assertCodexDesktopClosed(desktopRunningImpl) {
  if (await desktopRunningImpl()) {
    throw new Error(
      "PickerMux uninstall requires Codex Desktop to be fully quit with Command-Q",
    );
  }
}

function assertFullPurgeCompleted(
  result,
  installDirectory,
  distributionPaths = resolveDistributionPaths(),
) {
  const pendingPaths = [...new Set([
    result?.removed?.cleanupPendingPath,
    result?.beforeResult?.integration?.artifacts?.metadataCleanupPendingPath,
    result?.beforeResult?.integration?.artifacts?.runtimeCleanupPendingPath,
    result?.beforeResult?.backups?.cleanupPendingPath,
    result?.beforeResult?.registry?.cleanupPendingPath,
  ].filter((entry) => typeof entry === "string" && entry.length > 0))];
  const installDirectoryRemoved =
    result?.beforeResult?.installDirectoryRemoved === true;
  const versionsDirectoryRemoved =
    result?.removed?.versionsDirectoryRemoved === true;
  const applicationDirectoryRemoved =
    result?.removed?.applicationDirectoryRemoved === true;
  if (
    pendingPaths.length === 0 &&
    installDirectoryRemoved &&
    versionsDirectoryRemoved &&
    applicationDirectoryRemoved
  ) {
    return result;
  }

  const reasons = [];
  if (pendingPaths.length > 0) {
    reasons.push(`private cleanup remains pending at ${pendingPaths.join(", ")}`);
  }
  if (!installDirectoryRemoved) {
    reasons.push(`the managed installation directory remains at ${installDirectory}`);
  }
  if (!versionsDirectoryRemoved) {
    reasons.push(
      `the PickerMux versions path remains at ${distributionPaths.versionsDirectory}`,
    );
  }
  if (!applicationDirectoryRemoved) {
    reasons.push(
      `the PickerMux application directory remains at ${distributionPaths.applicationDirectory}`,
    );
  }
  const error = new Error(
    `PickerMux full uninstall is incomplete: ${reasons.join("; ")}`,
  );
  error.code = "PICKERMUX_PURGE_INCOMPLETE";
  error.cleanupPendingPaths = Object.freeze(pendingPaths);
  error.installDirectoryRemoved = installDirectoryRemoved;
  error.versionsDirectoryRemoved = versionsDirectoryRemoved;
  error.applicationDirectoryRemoved = applicationDirectoryRemoved;
  throw error;
}

export async function purgePickerMux({
  paths = resolveInstallPaths(),
  distributionPaths = resolveDistributionPaths(),
  force = false,
  desktopRunningImpl = isCodexDesktopRunning,
  validateDistributionImpl = validateDistributionInstallation,
  validateLaunchAgentImpl = assertManagedLaunchAgent,
  inventoryInstallImpl = inventoryPickerMuxInstallDirectory,
  inventoryBackupsImpl = inventoryPickerMuxBackups,
  inventoryRuntimeImpl = inventoryManagedServicePackage,
  inventoryConfigImpl = inventoryManagedConfigOwnership,
  revalidateInstallImpl = revalidatePickerMuxInstallDirectoryInventory,
  revalidateBackupsImpl = revalidatePickerMuxBackupInventory,
  revalidateRuntimeImpl = revalidateManagedServicePackageInventory,
  revalidateConfigImpl = revalidateManagedConfigOwnership,
  listProviderIdsImpl = listRegisteredKeychainProviderIds,
  removeDistributionImpl = removeManagedDistribution,
  uninstallIntegrationImpl = uninstallIntegration,
  deleteCredentialImpl = deleteProviderCredential,
  purgeBackupsImpl = purgePickerMuxBackups,
  purgeRegistryImpl = purgeKeychainProviderRegistry,
  rmdirImpl = rmdir,
  assertNoPendingFullRefreshImpl = async () => null,
} = {}) {
  await assertCodexDesktopClosed(desktopRunningImpl);
  const distribution = await validateDistributionImpl({
    paths: distributionPaths,
  });
  if (!distribution.installed) {
    throw new Error(
      "PickerMux full uninstall requires a receipt-validated CLI installation",
    );
  }
  await validateLaunchAgentImpl(managedLaunchAgentOptions(paths));
  const installInventory = await inventoryInstallImpl({
    installDirectory: paths.installDirectory,
  });
  const backupInventory = await inventoryBackupsImpl({
    backupDirectory: paths.backupDirectory,
    configPath: paths.configPath,
  });
  const configOwnership = await inventoryConfigImpl({
    configPath: paths.configPath,
    statePath: paths.statePath,
    backupDirectory: paths.backupDirectory,
    backupDirectoryInventory: backupInventory,
  });
  const runtimeInventory = await inventoryRuntimeImpl({
    serviceDirectory: paths.serviceDirectory,
    sourceRoot: distribution.activeDirectory,
  });
  const providerIds = await listProviderIdsImpl({
    registryPath: paths.keychainRegistryPath,
  });

  const result = await removeDistributionImpl({
    paths: distributionPaths,
    requireExclusiveApplicationDirectory: true,
    async beforeRemove(confirmedDistribution) {
      await assertNoPendingFullRefreshImpl();
      assertSameDistributionOwnership(distribution, confirmedDistribution);
      await assertCodexDesktopClosed(desktopRunningImpl);
      await validateLaunchAgentImpl(managedLaunchAgentOptions(paths));
      await revalidateInstallImpl(installInventory);
      await revalidateBackupsImpl(backupInventory);
      await revalidateRuntimeImpl(runtimeInventory);
      await revalidateConfigImpl(configOwnership);
      const confirmedProviderIds = await listProviderIdsImpl({
        registryPath: paths.keychainRegistryPath,
      });
      if (!sameProviderIds(providerIds, confirmedProviderIds)) {
        throw new Error(
          "PickerMux Keychain provider registry changed during full uninstall",
        );
      }

      let integration;
      let backups;
      const credentials = [];
      const registry = await purgeRegistryImpl({
        registryPath: paths.keychainRegistryPath,
        expectedProviderIds: providerIds,
        async beforeCommit() {
          backups = await purgeBackupsImpl({
            backupDirectory: paths.backupDirectory,
            configPath: paths.configPath,
            inventory: backupInventory,
            async beforeCommit({ readBackup } = {}) {
              // Keychain values are deliberately never read, so a successful
              // deletion cannot be recreated. Perform every receipt check and
              // reversible quarantine first. On a partial deletion failure,
              // the surrounding layers restore CLI, registry, and backups;
              // the integration remains active and a retry is idempotent.
              for (const providerId of providerIds) {
                try {
                  const deleted = await deleteCredentialImpl(providerId);
                  credentials.push(Object.freeze({ providerId, deleted }));
                } catch (cause) {
                  const error = new Error(
                    `PickerMux full uninstall could not delete every registered Keychain credential; one or more credentials may already be absent. The integration remains active and ownership receipts are retained for an idempotent retry (failed provider: ${providerId})`,
                    { cause },
                  );
                  error.code = "PICKERMUX_CREDENTIAL_PURGE_INCOMPLETE";
                  error.providerId = providerId;
                  error.completedProviderIds = Object.freeze(
                    credentials.map((entry) => entry.providerId),
                  );
                  throw error;
                }
              }
              try {
                integration = await uninstallIntegrationImpl({
                  paths,
                  force,
                  servicePackageInventory: runtimeInventory,
                  // The strict runtime preflight ran above before registry and
                  // backup quarantine changed receipt-owned sibling paths.
                  runtimePreflightCompleted: true,
                  installDirectoryInventory: installInventory,
                  backupDirectoryInventory: backupInventory,
                  configOwnershipReceipt: configOwnership,
                  readBackupImpl: readBackup,
                  sourceRoot: distribution.activeDirectory,
                  preserveHistoricalModelBridge: true,
                });
              } catch (cause) {
                const error = new Error(
                  "PickerMux integration removal failed after entering the irreversible Keychain phase; zero or more registered credentials may already be absent. CLI, registry, and backups are retained for recovery, and a retry treats already-absent credentials as complete",
                  { cause },
                );
                error.code = "PICKERMUX_PURGE_COMMIT_INCOMPLETE";
                error.completedProviderIds = Object.freeze(
                  credentials.map((entry) => entry.providerId),
                );
                throw error;
              }
            },
          });
        },
      });

      const cleanupPendingPath =
        integration.artifacts?.metadataCleanupPendingPath ??
        integration.artifacts?.runtimeCleanupPendingPath ??
        backups.cleanupPendingPath ??
        registry.cleanupPendingPath;
      if (cleanupPendingPath) {
        const error = new Error(
          `PickerMux full uninstall stopped with private cleanup pending at ${cleanupPendingPath}; the CLI will be retained for recovery`,
        );
        error.code = "PICKERMUX_PURGE_INCOMPLETE";
        error.cleanupPendingPath = cleanupPendingPath;
        throw error;
      }

      let installDirectoryRemoved = false;
      try {
        await rmdirImpl(paths.installDirectory);
        installDirectoryRemoved = true;
      } catch (error) {
        if (error?.code === "ENOENT") installDirectoryRemoved = true;
        else if (error?.code === "ENOTEMPTY") {
          const incomplete = new Error(
            `PickerMux full uninstall is incomplete because the managed installation directory is not empty: ${paths.installDirectory}`,
            { cause: error },
          );
          incomplete.code = "PICKERMUX_PURGE_INCOMPLETE";
          incomplete.installDirectoryRemoved = false;
          throw incomplete;
        } else throw error;
      }
      return {
        integration,
        credentials: Object.freeze(credentials),
        backups,
        registry,
        installDirectoryRemoved,
      };
    },
  });
  return assertFullPurgeCompleted(
    result,
    paths.installDirectory,
    distributionPaths,
  );
}

const FULL_REFRESH_CONFIRMATION = "FULL";

export async function assertNoPendingFullRefresh({
  fullRefreshPaths = resolveFullRefreshPaths(),
  readCheckpointImpl = readFullRefreshCheckpoint,
} = {}) {
  let checkpoint;
  try {
    checkpoint = await readCheckpointImpl({
      installDirectory: fullRefreshPaths.installDirectory,
      checkpointPath: fullRefreshPaths.checkpointPath,
      allowMissing: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (checkpoint !== null) {
    throw new Error(
      `PickerMux full refresh is incomplete at ${checkpoint.phase}; rerun pickermux refresh --full to resume before another lifecycle change`,
    );
  }
  return null;
}

export async function confirmFullRefresh({
  input = process.stdin,
  output = process.stderr,
  questionImpl,
} = {}) {
  const prompt = [
    "PickerMux full refresh will gracefully quit Codex twice.",
    "Active Codex tasks may be interrupted. PickerMux will be temporarily suspended,",
    "Codex will reopen natively to refresh the account model cache, and PickerMux",
    `will then be reactivated. Type ${FULL_REFRESH_CONFIRMATION} to continue: `,
  ].join("\n");
  if (questionImpl !== undefined) {
    if (typeof questionImpl !== "function") {
      throw new TypeError("questionImpl must be a function");
    }
    return (await questionImpl(prompt)).trim() === FULL_REFRESH_CONFIRMATION;
  }
  if (input?.isTTY !== true || output?.isTTY !== true) {
    throw new Error(
      "pickermux refresh --full requires an interactive terminal confirmation",
    );
  }
  const terminal = createInterface({ input, output });
  try {
    return (await terminal.question(prompt)).trim() === FULL_REFRESH_CONFIRMATION;
  } finally {
    terminal.close();
  }
}

function assertActiveFullRefreshDistribution(distribution, sourceRoot) {
  if (
    distribution?.installed !== true ||
    typeof distribution.activeDirectory !== "string"
  ) {
    throw new Error(
      "PickerMux full refresh requires a receipt-validated CLI installation",
    );
  }
  if (path.resolve(distribution.activeDirectory) !== path.resolve(sourceRoot)) {
    throw new Error(
      "Run pickermux refresh --full from the receipt-active installed PickerMux CLI",
    );
  }
  return distribution;
}

function fullRefreshArtifactOptions({ fullRefreshPaths, workerPath, nodePath }) {
  return {
    installDirectory: fullRefreshPaths.installDirectory,
    label: fullRefreshPaths.launchAgentLabel,
    nodePath,
    workerPath,
    checkpointPath: fullRefreshPaths.checkpointPath,
    launchAgentPath: fullRefreshPaths.launchAgentPath,
    logPath: fullRefreshPaths.logPath,
  };
}

async function scheduleFullRefreshLocked({
  paths = resolveInstallPaths(),
  distributionPaths = resolveDistributionPaths(),
  fullRefreshPaths = resolveFullRefreshPaths(),
  codexPath = resolveCodexBinary(),
  sourceRoot = projectRoot,
  validateDistributionImpl = validateDistributionInstallation,
  configStatusImpl = getConfigStatus,
  loadConfigImpl = loadBridgeConfig,
  runtimeImpl = readRuntime,
  validateLaunchAgentImpl = assertManagedLaunchAgent,
  inventoryRuntimeImpl = inventoryManagedServicePackage,
  prepareCheckpointImpl = prepareFullRefreshCheckpoint,
  armImpl = armFullRefreshLaunchAgent,
  cleanupImpl = cleanupFullRefreshArtifacts,
  nodePath = process.execPath,
} = {}) {
  const distribution = assertActiveFullRefreshDistribution(
    await validateDistributionImpl({ paths: distributionPaths }),
    sourceRoot,
  );
  const config = await loadConfigImpl(paths.serviceConfigPath);
  assertPersistentCredentialSupport(config);
  const status = await configStatusImpl({
    configPath: paths.configPath,
    statePath: paths.statePath,
  });
  if (status.healthy !== true) {
    throw new Error(
      `PickerMux full refresh refuses inconsistent integration state (${status.status ?? "unknown"})`,
    );
  }
  const runtimeInventory = await inventoryRuntimeImpl({
    serviceDirectory: paths.serviceDirectory,
    sourceRoot: distribution.activeDirectory,
  });
  if (runtimeInventory?.exists !== true) {
    throw new Error("PickerMux full refresh requires its receipt-bound runtime package");
  }

  const prepared = await prepareCheckpointImpl({
    installDirectory: fullRefreshPaths.installDirectory,
    checkpointPath: fullRefreshPaths.checkpointPath,
    codexHome: paths.codexHome,
    codexPath,
  });
  if (!prepared.resumed) {
    if (!status.installed) {
      await cleanupImpl({
        successful: true,
        ...fullRefreshArtifactOptions({
          fullRefreshPaths,
          workerPath: path.join(
            distribution.activeDirectory,
            "bin",
            "pickermux.mjs",
          ),
          nodePath,
        }),
      });
      throw new Error("PickerMux must be healthily installed before full refresh");
    }
    const runtime = await runtimeImpl(paths.runtimePath);
    const expected = installationOptions({ config, paths, runtime });
    if (
      status.provider !== expected.modelProvider ||
      status.providerName !== expected.provider.name ||
      status.catalog !== expected.modelCatalogJson ||
      status.baseUrl !== expected.provider.baseUrl
    ) {
      await cleanupImpl({
        successful: true,
        ...fullRefreshArtifactOptions({
          fullRefreshPaths,
          workerPath: path.join(
            distribution.activeDirectory,
            "bin",
            "pickermux.mjs",
          ),
          nodePath,
        }),
      });
      throw new Error(
        "Installed PickerMux configuration differs from its preserved service configuration",
      );
    }
    const launchAgent = await validateLaunchAgentImpl(
      managedLaunchAgentOptions(paths),
    );
    if (!launchAgent.present) {
      await cleanupImpl({
        successful: true,
        ...fullRefreshArtifactOptions({
          fullRefreshPaths,
          workerPath: path.join(
            distribution.activeDirectory,
            "bin",
            "pickermux.mjs",
          ),
          nodePath,
        }),
      });
      throw new Error("PickerMux full refresh requires its managed bridge service");
    }
  }

  const workerPath = path.join(
    distribution.activeDirectory,
    "bin",
    "pickermux.mjs",
  );
  try {
    const armed = await armImpl({
      ...fullRefreshArtifactOptions({ fullRefreshPaths, workerPath, nodePath }),
      receiptPath: fullRefreshPaths.receiptPath,
    });
    return Object.freeze({
      started: true,
      resumed: prepared.resumed,
      operationId: prepared.checkpoint.operationId,
      workerPath: armed.workerPath,
    });
  } catch (error) {
    if (!prepared.resumed) {
      try {
        await cleanupImpl({
          successful: true,
          ...fullRefreshArtifactOptions({
            fullRefreshPaths,
            workerPath,
            nodePath,
          }),
        });
      } catch (cleanupError) {
        throw new Error(
          `Full refresh could not start and prepared-state cleanup failed. Original: ${error.message}; cleanup: ${cleanupError.message}`,
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
    }
    throw error;
  }
}

export async function scheduleFullRefresh(options = {}) {
  const {
    distributionPaths = resolveDistributionPaths(),
    withLockImpl = withInstallationLock,
  } = options;
  if (typeof withLockImpl !== "function") {
    throw new TypeError("withLockImpl must be a function");
  }
  return withLockImpl(distributionPaths, () => scheduleFullRefreshLocked({
    ...options,
    distributionPaths,
  }));
}

const FULL_REFRESH_LOCK_RETRY_ATTEMPTS = 200;
const FULL_REFRESH_LOCK_RETRY_INTERVAL_MS = 100;
const FULL_REFRESH_RETRYABLE_LOCK_ERRORS = new Set([
  "ENOENT",
  "PICKERMUX_INSTALLATION_LOCK_BUSY",
]);

async function withFullRefreshWorkerLock({
  distributionPaths,
  operation,
  withLockImpl,
  lockSleepImpl,
}) {
  for (
    let attempt = 0;
    attempt < FULL_REFRESH_LOCK_RETRY_ATTEMPTS;
    attempt += 1
  ) {
    let operationStarted = false;
    try {
      return await withLockImpl(distributionPaths, async () => {
        operationStarted = true;
        return operation();
      });
    } catch (error) {
      if (
        operationStarted ||
        !FULL_REFRESH_RETRYABLE_LOCK_ERRORS.has(error?.code) ||
        attempt + 1 === FULL_REFRESH_LOCK_RETRY_ATTEMPTS
      ) {
        throw error;
      }
      await lockSleepImpl(FULL_REFRESH_LOCK_RETRY_INTERVAL_MS);
    }
  }
  throw new Error("Full-refresh worker lock retry limit was exhausted");
}

export async function executeFullRefreshWorker({
  checkpointPath,
  paths = resolveInstallPaths(),
  distributionPaths = resolveDistributionPaths(),
  fullRefreshPaths = resolveFullRefreshPaths(),
  codexPath = resolveCodexBinary(),
  sourceRoot = projectRoot,
  validateDistributionImpl = validateDistributionInstallation,
  loadConfigImpl = loadBridgeConfig,
  desktopRunningImpl = isCodexDesktopRunning,
  workflowImpl = runFullRefreshWorkflow,
  suspendImpl = suspendPickerMuxForFullRefresh,
  reactivateImpl = reactivatePickerMuxAfterFullRefresh,
  cleanupImpl = cleanupFullRefreshArtifacts,
  readCheckpointImpl = readFullRefreshCheckpoint,
  withLockImpl = withInstallationLock,
  lockSleepImpl = sleep,
  reportImpl = (message) => process.stdout.write(`${message}\n`),
} = {}) {
  if (path.resolve(checkpointPath ?? "") !== fullRefreshPaths.checkpointPath) {
    throw new Error("Full-refresh worker checkpoint path is not the managed path");
  }
  if (
    typeof reportImpl !== "function" ||
    typeof withLockImpl !== "function" ||
    typeof lockSleepImpl !== "function"
  ) {
    throw new TypeError("Full-refresh worker dependencies must be functions");
  }
  const initialDistribution = assertActiveFullRefreshDistribution(
    await validateDistributionImpl({ paths: distributionPaths }),
    sourceRoot,
  );
  const workerPath = path.join(
    initialDistribution.activeDirectory,
    "bin",
    "pickermux.mjs",
  );
  const artifactOptions = fullRefreshArtifactOptions({
    fullRefreshPaths,
    workerPath,
    nodePath: process.execPath,
  });
  return withFullRefreshWorkerLock({
    distributionPaths,
    withLockImpl,
    lockSleepImpl,
    operation: async () => {
      let workflowStarted = false;
      let result;
      try {
        const distribution = assertActiveFullRefreshDistribution(
          await validateDistributionImpl({ paths: distributionPaths }),
          sourceRoot,
        );
        assertSameDistributionOwnership(initialDistribution, distribution);
        workflowStarted = true;
        result = await workflowImpl({
          installDirectory: fullRefreshPaths.installDirectory,
          checkpointPath: fullRefreshPaths.checkpointPath,
          codexHome: paths.codexHome,
          codexPath,
          async temporarySuspendImpl() {
            if (await desktopRunningImpl()) {
              throw new Error(
                "Codex Desktop restarted before PickerMux suspension",
              );
            }
            const confirmed = await validateDistributionImpl({
              paths: distributionPaths,
            });
            assertSameDistributionOwnership(distribution, confirmed);
            const config = await loadConfigImpl(paths.serviceConfigPath);
            return suspendImpl({
              config,
              paths,
              sourceRoot: distribution.activeDirectory,
            });
          },
          async reactivateAndDoctorImpl() {
            if (await desktopRunningImpl()) {
              throw new Error(
                "Codex Desktop restarted before PickerMux reactivation",
              );
            }
            const confirmed = await validateDistributionImpl({
              paths: distributionPaths,
            });
            assertSameDistributionOwnership(distribution, confirmed);
            const config = await loadConfigImpl(paths.serviceConfigPath);
            return reactivateImpl({
              config,
              paths,
              codexPath,
              sourceRoot: distribution.activeDirectory,
            });
          },
          progressImpl(context) {
            reportImpl(`PickerMux full refresh: ${context.phase}`);
          },
        });
      } catch (error) {
        let checkpoint = null;
        if (workflowStarted) {
          try {
            checkpoint = await readCheckpointImpl({
              installDirectory: fullRefreshPaths.installDirectory,
              checkpointPath: fullRefreshPaths.checkpointPath,
              allowMissing: true,
            });
          } catch (checkpointError) {
            reportImpl(
              "PickerMux full refresh paused with unreadable recovery state; managed recovery artifacts were retained.",
            );
            const failures = [error, checkpointError];
            try {
              await cleanupImpl({ successful: false, ...artifactOptions });
            } catch (cleanupError) {
              failures.push(cleanupError);
            }
            throw new Error(
              `Full refresh failed and its recovery checkpoint could not be read. Original: ${error.message}; checkpoint: ${checkpointError.message}`,
              { cause: new AggregateError(failures) },
            );
          }
        }
        const resumable = checkpoint !== null;
        reportImpl(
          resumable
            ? `PickerMux full refresh paused at ${checkpoint.phase}; rerun pickermux refresh --full to resume.`
            : `PickerMux full refresh stopped before integration mutation: ${error.message}`,
        );
        try {
          await cleanupImpl({ successful: !resumable, ...artifactOptions });
        } catch (cleanupError) {
          throw new Error(
            `Full refresh failed and helper cleanup was incomplete. Original: ${error.message}; cleanup: ${cleanupError.message}`,
            { cause: new AggregateError([error, cleanupError]) },
          );
        }
        throw error;
      }
      reportImpl(
        "PickerMux full refresh completed; Codex reopened with PickerMux active.",
      );
      try {
        await cleanupImpl({ successful: true, ...artifactOptions });
      } catch (cleanupError) {
        reportImpl(
          "PickerMux full refresh completed, but receipt-bound helper cleanup is incomplete; rerun refresh --full to finish cleanup.",
        );
        throw new Error(
          `Full refresh completed but helper cleanup was incomplete: ${cleanupError.message}`,
          { cause: cleanupError },
        );
      }
      return result;
    },
  });
}

export async function setupPickerMux({
  sourceRoot = projectRoot,
  setupConfigPath,
  paths = resolveInstallPaths(),
  distributionPaths = resolveDistributionPaths(),
  codexPath = resolveCodexBinary(),
  setupImpl = setupManagedDistribution,
  loadConfigImpl = loadBridgeConfig,
  configStatusImpl = getConfigStatus,
  desktopRunningImpl = isCodexDesktopRunning,
  accountCacheImpl = inspectCodexAccountCache,
  repairConfigImpl = restoreRecoveredProviderEndMarker,
  discoverImpl = discoverBridgeModels,
  installImpl = install,
  refreshImpl = refresh,
  assertNoPendingFullRefreshImpl = async () => null,
} = {}) {
  const initialStatus = await configStatusImpl({
    configPath: paths.configPath,
    statePath: paths.statePath,
  });
  if (initialStatus.healthy !== true) {
    throw new Error(
      `PickerMux setup refuses inconsistent integration state (${initialStatus.status ?? "unknown"})`,
    );
  }
  if (await desktopRunningImpl()) {
    throw new Error(
      "PickerMux setup requires Codex Desktop to be fully quit with Command-Q",
    );
  }
  const assertAccountCacheReady = async ({ allowMarkerRepair = false } = {}) => {
    try {
      return await accountCacheImpl({
        codexHome: paths.codexHome,
        codexPath,
      });
    } catch (error) {
      if (error?.code !== "CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED") throw error;
      let markerRestored = false;
      if (
        allowMarkerRepair &&
        initialStatus.installed &&
        initialStatus.status === "installed-marker-recovered"
      ) {
        const repair = await withInstallationLock(
          distributionPaths,
          async () => {
            await assertNoPendingFullRefreshImpl();
            if (await desktopRunningImpl()) {
              throw new Error(
                "PickerMux setup requires Codex Desktop to remain fully quit with Command-Q",
              );
            }
            const currentStatus = await configStatusImpl({
              configPath: paths.configPath,
              statePath: paths.statePath,
            });
            if (
              currentStatus.installed !== true ||
              currentStatus.healthy !== true ||
              currentStatus.status !== "installed-marker-recovered"
            ) {
              throw new Error(
                "PickerMux integration state changed before marker recovery",
              );
            }
            return repairConfigImpl({
              configPath: paths.configPath,
              statePath: paths.statePath,
              backupDirectory: paths.backupDirectory,
            });
          },
        );
        markerRestored = repair.changed === true;
      }
      const recovery = initialStatus.installed
        ? "Run 'pickermux uninstall' to restore the native Codex configuration, open Codex while signed in until its native model picker loads, fully quit it with Command-Q, and rerun setup with the same config."
        : "Open Codex while signed in until its native model picker loads, fully quit it with Command-Q, and rerun setup.";
      const stateResult = markerRestored
        ? "The receipt-verified missing provider end marker was restored so the installed PickerMux CLI can uninstall safely; CLI and runtime state were not changed."
        : "No active PickerMux state was changed.";
      throw new Error(
        `PickerMux setup stopped before activation because Codex ${error.codexClientVersion ?? "Desktop"} has no matching account model cache. ${stateResult} ${recovery}`,
        { cause: error },
      );
    }
  };
  await assertAccountCacheReady({ allowMarkerRepair: true });
  const effectiveConfigPath = setupConfigPath
    ? path.resolve(setupConfigPath)
    : initialStatus.installed
      ? paths.serviceConfigPath
      : path.join(path.resolve(sourceRoot), "lmstudio-picker.config.json");
  const preflightConfig = await loadConfigImpl(effectiveConfigPath);
  const discovery = await discoverImpl({ config: preflightConfig });
  if (!Array.isArray(discovery?.models) || discovery.models.length === 0) {
    throw new Error(
      "PickerMux setup requires LM Studio to be running with at least one loaded external LLM",
    );
  }

  return setupImpl({
    sourceRoot,
    paths: distributionPaths,
    async beforeControlCommit() {
      await assertNoPendingFullRefreshImpl();
      const status = await configStatusImpl({
        configPath: paths.configPath,
        statePath: paths.statePath,
      });
      if (status.healthy !== true || status.installed !== initialStatus.installed) {
        throw new Error("PickerMux integration state changed concurrently during setup");
      }
      if (await desktopRunningImpl()) {
        throw new Error(
          "PickerMux setup requires Codex Desktop to remain fully quit with Command-Q",
        );
      }
      await assertAccountCacheReady();
    },
    async activate({ distributionRoot, previousVersion, version }) {
      const status = await configStatusImpl({
        configPath: paths.configPath,
        statePath: paths.statePath,
      });
      if (status.healthy !== true) {
        throw new Error(
          `PickerMux setup refuses inconsistent integration state (${status.status ?? "unknown"})`,
        );
      }
      if (status.installed !== initialStatus.installed) {
        throw new Error("PickerMux integration state changed concurrently during setup");
      }
      if (await desktopRunningImpl()) {
        throw new Error(
          "PickerMux setup requires Codex Desktop to remain fully quit with Command-Q",
        );
      }
      await assertAccountCacheReady();
      const config = await loadConfigImpl(effectiveConfigPath);
      if (status.installed) {
        const result = await refreshImpl({
          config,
          paths,
          codexPath,
          sourceRoot: distributionRoot,
        });
        return {
          action: previousVersion === version ? "refresh" : "upgrade",
          integration: result,
        };
      }
      const result = await installImpl({
        config,
        configPath: effectiveConfigPath,
        paths,
        codexPath,
        sourceRoot: distributionRoot,
      });
      return { action: "install", integration: result };
    },
  });
}

export async function runCli(argv, {
  purgeImpl = purgePickerMux,
  scheduleFullRefreshImpl = scheduleFullRefresh,
  executeFullRefreshWorkerImpl = executeFullRefreshWorker,
  confirmFullRefreshImpl = confirmFullRefresh,
  assertNoPendingFullRefreshImpl = assertNoPendingFullRefresh,
} = {}) {
  const options = parseArguments(argv);
  if (options.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.command === "version") {
    const metadata = await readPickerMuxMetadata(projectRoot);
    const result = { name: metadata.name, version: metadata.version };
    process.stdout.write(`pickermux ${metadata.version}\n`);
    return result;
  }
  const paths = resolveInstallPaths();
  const distributionPaths = resolveDistributionPaths();
  const fullRefreshPaths = resolveFullRefreshPaths();
  const assertNoPendingFullRefreshLocked = () =>
    assertNoPendingFullRefreshImpl({ fullRefreshPaths });
  if (options.command === "refresh" && options.fullWorker) {
    return executeFullRefreshWorkerImpl({
      checkpointPath: options.checkpointPath,
      paths,
      distributionPaths,
      fullRefreshPaths,
    });
  }
  if (options.command === "refresh" && options.full) {
    if (!(await confirmFullRefreshImpl())) {
      const result = { started: false, cancelled: true };
      process.stdout.write("PickerMux full refresh cancelled; no state was changed.\n");
      return result;
    }
    process.stdout.write(
      "Preparing PickerMux full refresh. Codex will quit momentarily; rerun this command if recovery output asks you to resume.\n",
    );
    const result = await scheduleFullRefreshImpl({
      paths,
      distributionPaths,
      fullRefreshPaths,
    });
    process.stdout.write(
      result.resumed
        ? "Resumable PickerMux full refresh worker armed.\n"
        : "PickerMux full refresh worker armed.\n",
    );
    return result;
  }
  if (
    new Set([
      "certify",
      "credential-delete",
      "credential-set",
      "install",
      "refresh",
      "setup",
      "uninstall",
    ]).has(options.command)
  ) {
    await assertNoPendingFullRefreshLocked();
  }
  if (options.command === "setup") {
    const result = await setupPickerMux({
      sourceRoot: options.distributionRoot
        ? path.resolve(options.distributionRoot)
        : projectRoot,
      setupConfigPath:
        options.configPath || process.env.PICKERMUX_CONFIG_PATH?.trim()
          ? resolveProjectConfig(options.configPath)
          : undefined,
      paths,
      distributionPaths,
      assertNoPendingFullRefreshImpl: assertNoPendingFullRefreshLocked,
    });
    if (options.json) printJson(result);
    else {
      process.stdout.write(
        `PickerMux ${result.version} setup completed (${result.activation.action}).\n`,
      );
      process.stdout.write(`Launcher installed at ${result.launcherPath}.\n`);
      process.stdout.write(
        "Fully quit and reopen Codex Desktop to reload the mixed model picker.\n",
      );
      const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
      if (!pathEntries.includes(distributionPaths.launcherDirectory)) {
        process.stdout.write(
          'Add PickerMux to this shell with: export PATH="$HOME/.local/bin:$PATH"\n',
        );
      }
    }
    return result;
  }
  if (options.command === "uninstall") {
    let result;
    if (options.purge) {
      result = await purgeImpl({
        paths,
        distributionPaths,
        force: options.force,
        assertNoPendingFullRefreshImpl: assertNoPendingFullRefreshLocked,
      });
      assertFullPurgeCompleted(
        result,
        paths.installDirectory,
        distributionPaths,
      );
    } else if (options.removeCli) {
      await assertCodexDesktopClosed(isCodexDesktopRunning);
      const distribution = await validateDistributionInstallation({
        paths: distributionPaths,
      });
      if (!distribution.installed) {
        throw new Error(
          "No receipt-validated PickerMux CLI installation was found",
        );
      }
      const servicePackageInventory = await inventoryManagedServicePackage({
        serviceDirectory: paths.serviceDirectory,
        sourceRoot: distribution.activeDirectory,
      });
      result = await removeManagedDistribution({
        paths: distributionPaths,
        beforeRemove: async (confirmedDistribution) => {
          await assertNoPendingFullRefreshLocked();
          assertSameDistributionOwnership(distribution, confirmedDistribution);
          await assertCodexDesktopClosed(isCodexDesktopRunning);
          return uninstallIntegration({
            paths,
            force: options.force,
            servicePackageInventory,
            sourceRoot: distribution.activeDirectory,
          });
        },
      });
    } else {
      result = await withInstallationLock(
        distributionPaths,
        async () => {
          await assertNoPendingFullRefreshLocked();
          await assertCodexDesktopClosed(isCodexDesktopRunning);
          const servicePackageInventory = await inventoryManagedServicePackage({
            serviceDirectory: paths.serviceDirectory,
            sourceRoot: projectRoot,
          });
          return uninstallIntegration({
            paths,
            force: options.force,
            servicePackageInventory,
            sourceRoot: projectRoot,
          });
        },
      );
    }
    if (options.json) printJson(result);
    else {
      process.stdout.write(
        options.purge
          ? result.beforeResult?.integration?.removedConfig?.historicalCompatibility
            ? "PickerMux integration, receipt-validated CLI, verified backups, and registered provider Keychain credentials were removed. An inert model_bridge compatibility table remains only so historical chats parse; new turns through it fail locally.\n"
            : "PickerMux integration, receipt-validated CLI, verified backups, and registered provider Keychain credentials were removed.\n"
          : options.removeCli
            ? "Model bridge and receipt-validated PickerMux CLI removed; backups and Keychain credentials were preserved.\n"
            : result.removedConfig.changed
              ? "Model bridge removed; previous Codex configuration restored and managed runtime cleaned.\n"
              : "Managed bridge service and runtime artifacts were removed.\n",
      );
      if (options.removeCli && result.removed.cleanupPendingPath) {
        process.stderr.write(
          `PickerMux warning: private removal quarantine still requires cleanup at ${result.removed.cleanupPendingPath}. A new installation is not blocked.\n`,
        );
      }
    }
    return result;
  }
  const codexPath = resolveCodexBinary();
  const configPath = resolveProjectConfig(options.configPath);
  const config = await loadBridgeConfig(configPath);

  if (
    new Set(["credential-set", "credential-status", "credential-delete"]).has(
      options.command,
    )
  ) {
    const executeCredentialCommand = () => credentialCommand({
      command: options.command,
      config,
      providerId: options.providerId,
      registryPath: paths.keychainRegistryPath,
    });
    const result = new Set(["credential-set", "credential-delete"]).has(
      options.command,
    )
      ? await withInstallationLock(distributionPaths, async () => {
          await assertNoPendingFullRefreshLocked();
          return executeCredentialCommand();
        })
      : await executeCredentialCommand();
    if (options.json) printJson(result);
    else if (options.command === "credential-status") {
      process.stdout.write(
        `provider=${result.providerId} source=${result.source} credential=${result.available ? "available" : "missing"}\n`,
      );
    } else {
      process.stdout.write(
        options.command === "credential-set"
          ? `Keychain credential updated for ${result.providerId}.\n`
          : `Keychain credential ${result.deleted ? "deleted" : "was already absent"} for ${result.providerId}.\n`,
      );
    }
    return result;
  }

  if (options.command === "serve") {
    return serve({
      config,
      configPath,
      runtimePath: path.resolve(options.runtimePath),
      codexPath,
    });
  }
  if (options.command === "discover") {
    const result = await discoverBridgeModels({ config });
    if (options.json) printJson(result);
    else for (const model of result.models) process.stdout.write(`${model.id}\t${model.contextWindow}\t${model.source}\n`);
    return result;
  }
  if (options.command === "build") {
    const outputPath = options.outputPath
      ? path.resolve(options.outputPath)
      : path.join(projectRoot, ".artifacts", "mixed-models.json");
    const result = await buildCatalog({
      config,
      codexPath,
      codexHome: paths.codexHome,
      outputPath,
      certificationPath: paths.certificationPath,
    });
    const runtime = createRuntimeRecord({
      configPath,
      capability: "preview_capability_00000000000000000000000000000000",
    });
    await prevalidateCatalog({
      config,
      runtime,
      catalog: result.catalog,
      catalogPath: result.writtenPath,
      codexPath,
    });
    const summary = {
      catalogPath: result.writtenPath,
      nativeModels: result.nativeCatalog.catalog.models.length,
      nativeCatalogSource: result.nativeCatalog.source,
      nativeCatalogFetchedAt: result.nativeCatalog.fetchedAt ?? null,
      nativeCatalogWarning: result.nativeCatalog.warning ?? null,
      externalModels: result.discovery.models,
      validated: true,
    };
    if (options.json) printJson(summary);
    else {
      printNativeCatalogWarning(summary);
      process.stdout.write(`Validated mixed catalog: ${result.writtenPath}\n`);
    }
    return summary;
  }
  if (options.command === "install") {
    const result = await withInstallationLock(
      distributionPaths,
      async () => {
        await assertNoPendingFullRefreshLocked();
        return install({ config, configPath, paths, codexPath });
      },
    );
    if (options.json) printJson(result);
    else {
      printNativeCatalogWarning(result);
      process.stdout.write(`Installed mixed catalog: ${result.catalogPath}\n`);
      printChecks(result.doctor);
      process.stdout.write("Fully quit and reopen Codex Desktop to reload the mixed model picker.\n");
    }
    return result;
  }
  if (options.command === "refresh") {
    const result = await withInstallationLock(
      distributionPaths,
      async () => {
        await assertNoPendingFullRefreshLocked();
        return refresh({ config, paths, codexPath });
      },
    );
    if (options.json) printJson(result);
    else {
      printNativeCatalogWarning(result);
      process.stdout.write(`Refreshed mixed catalog: ${result.catalogPath}\nFully quit and reopen Codex Desktop.\n`);
    }
    return result;
  }
  if (options.command === "certify") {
    const result = await withInstallationLock(
      distributionPaths,
      async () => {
        await assertNoPendingFullRefreshLocked();
        return certify({
          config,
          paths,
          codexPath,
          model: options.model,
          all: options.all,
        });
      },
    );
    if (options.json) printJson(result);
    else {
      for (const entry of result.certified) {
        process.stdout.write(`PASS  certification: ${entry.model}\n`);
      }
      process.stdout.write(
        "Tool-certified catalog published. Fully quit and reopen Codex Desktop.\n",
      );
    }
    return result;
  }
  if (options.command === "doctor") {
    const result = await runBridgeDoctor({ config, paths, codexPath, live: options.live });
    if (options.json) printJson(result);
    else printChecks(result);
    if (!result.ok) process.exitCode = 1;
    return result;
  }
  if (options.command === "status") {
    const [
      managedConfig,
      service,
      bundledCatalog,
      codexClientVersion,
      fullRefreshCheckpoint,
    ] = await Promise.all([
      getConfigStatus({ configPath: paths.configPath, statePath: paths.statePath }),
      getBridgeServiceStatus({
        config,
        runtimePath: paths.runtimePath,
        launchAgentLabel: paths.launchAgentLabel,
      }),
      loadBundledCatalog({ codexPath }),
      loadCodexClientVersion({ codexPath }),
      readFullRefreshCheckpoint({
        installDirectory: resolveFullRefreshPaths().installDirectory,
        checkpointPath: resolveFullRefreshPaths().checkpointPath,
        allowMissing: true,
      }),
    ]);
    const compatibility = await checkCurrentCompatibility({
      manifestPath: paths.compatibilityPath,
      bundledCatalog,
      codexClientVersion,
    });
    const fullRefresh = fullRefreshCheckpoint
      ? { status: "pending", phase: fullRefreshCheckpoint.phase }
      : { status: "idle", phase: null };
    const result = { managedConfig, service, compatibility, fullRefresh };
    if (options.json) printJson(result);
    else process.stdout.write(
      `config=${managedConfig.status} bridge=${service.status} compatibility=${compatibility.status} full-refresh=${fullRefresh.phase ?? fullRefresh.status}\n`,
    );
    return result;
  }
  throw new Error(`Unhandled command: ${options.command}`);
}
