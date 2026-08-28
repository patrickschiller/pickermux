import path from "node:path";
import { randomUUID } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";

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
  installConfig,
  uninstallConfig,
} from "./config-manager.mjs";
import {
  createCredentialResolver,
  deleteProviderCredential,
  providerCredentialStatus,
  setProviderCredential,
} from "./keychain-credentials.mjs";
import {
  invalidateModelCertification,
  recordPassedCertification,
} from "./model-certification.mjs";
import {
  projectRoot,
  resolveCodexBinary,
  resolveInstallPaths,
  resolveProjectConfig,
} from "./paths.mjs";
import {
  buildProviderRegistry,
  createReloadableProviderRegistry,
} from "./provider-registry.mjs";
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
  "status",
  "uninstall",
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
  pickermux install [--config PATH] [--json]
  pickermux refresh [--config PATH] [--json]
  pickermux doctor [--config PATH] [--live] [--json]
  pickermux status [--config PATH] [--json]
  pickermux uninstall [--force] [--json]

The bridge binds only to 127.0.0.1. Native ChatGPT authentication is never
stored and is stripped before every external request.`;
}

function parseArguments(argv) {
  const command = new Set(["--help", "-h"]).has(argv[0])
    ? "help"
    : (argv[0] ?? "help");
  if (!COMMANDS.has(command)) {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
  const options = {
    command,
    configPath: undefined,
    outputPath: undefined,
    runtimePath: undefined,
    force: false,
    json: false,
    live: false,
    all: false,
    model: undefined,
    providerId: undefined,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") options.force = true;
    else if (argument === "--all") options.all = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--live") options.live = true;
    else if (["--config", "--output", "--runtime", "--model"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path`);
      index += 1;
      if (argument === "--config") options.configPath = value;
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
      await uninstallConfig({ configPath: paths.configPath, statePath: paths.statePath });
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

async function install({ config, configPath, paths, codexPath }) {
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
  try {
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
      sourceRoot: projectRoot,
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

async function refresh({ config, paths, codexPath }) {
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
    try {
      servicePackage = await stageServicePackage({
        sourceRoot: projectRoot,
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
      await cleanupLegacyRuntimePackages(paths, servicePackage);
      await finalizeServicePackage(servicePackage);
    } catch (error) {
      let selectionRollbackError;
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
        selectionRollbackError = rollbackError;
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

async function serve({ config, configPath, runtimePath }) {
  assertRuntimeCompressionSupport();
  const runtime = await readRuntime(runtimePath);
  if (path.resolve(runtime.configPath) !== path.resolve(configPath)) {
    throw new Error("Bridge runtime belongs to another project config");
  }
  const catalogPath = path.join(path.dirname(runtimePath), "models.json");
  const installDirectory = path.dirname(runtimePath);
  const certificationPath = path.join(installDirectory, "certifications.json");
  const startupCompatibility = await assertBridgeStartupCompatibility({
    manifestPath: path.join(installDirectory, "compatibility.json"),
  });
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
  const synchronizer = hasLoadedModelDiscovery(config)
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
  });
  process.stdout.write(
    `model bridge ready on 127.0.0.1:${config.bridge.port}; ${registry.nativeModels.length} native and ${registry.externalModels.length} external route(s)\n`,
  );
  synchronizer?.start();
  await new Promise((resolve, reject) => {
    const shutdown = () => {
      synchronizer?.stop();
      server.close((error) => (error ? reject(error) : resolve()));
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    server.once("error", reject);
  });
}

function configuredProvider(config, providerId) {
  const provider = config.providers.find((entry) => entry.id === providerId);
  if (!provider) throw new Error(`Unknown configured provider: ${providerId}`);
  return provider;
}

async function credentialCommand({ command, config, providerId }) {
  const provider = configuredProvider(config, providerId);
  if (provider.credentialKeychain !== true) {
    throw new Error(`Provider ${providerId} is not configured with credentialKeychain=true`);
  }
  if (command === "credential-set") {
    await setProviderCredential(provider);
    return { providerId, source: "keychain", updated: true };
  }
  if (command === "credential-delete") {
    const deleted = await deleteProviderCredential(provider);
    return { providerId, source: "keychain", deleted };
  }
  return providerCredentialStatus(provider);
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

export async function runCli(argv) {
  const options = parseArguments(argv);
  if (options.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const paths = resolveInstallPaths();
  if (options.command === "uninstall") {
    const removedConfig = await uninstallConfig({
      configPath: paths.configPath,
      statePath: paths.statePath,
      force: options.force,
    });
    const service = await stopBridgeService({
      runtimePath: paths.runtimePath,
      launchAgentPath: paths.launchAgentPath,
      launchAgentLabel: paths.launchAgentLabel,
    });
    const artifacts = await cleanupManagedArtifacts({
      managedFiles: [
        paths.runtimePath,
        paths.catalogPath,
        paths.serviceConfigPath,
        paths.compatibilityPath,
        paths.certificationPath,
        paths.logPath,
      ],
      runtimeDirectories: await managedRuntimeDirectories(paths),
    });
    const result = { removedConfig, service, artifacts };
    if (options.json) printJson(result);
    else process.stdout.write(
      removedConfig.changed
        ? "Model bridge removed; previous Codex configuration restored and managed runtime cleaned.\n"
        : "Managed bridge service and runtime artifacts were removed.\n",
    );
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
    const result = await credentialCommand({
      command: options.command,
      config,
      providerId: options.providerId,
    });
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
    return serve({ config, configPath, runtimePath: path.resolve(options.runtimePath) });
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
    const result = await install({ config, configPath, paths, codexPath });
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
    const result = await refresh({ config, paths, codexPath });
    if (options.json) printJson(result);
    else {
      printNativeCatalogWarning(result);
      process.stdout.write(`Refreshed mixed catalog: ${result.catalogPath}\nFully quit and reopen Codex Desktop.\n`);
    }
    return result;
  }
  if (options.command === "certify") {
    const result = await certify({
      config,
      paths,
      codexPath,
      model: options.model,
      all: options.all,
    });
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
    const [managedConfig, service, bundledCatalog, codexClientVersion] = await Promise.all([
      getConfigStatus({ configPath: paths.configPath, statePath: paths.statePath }),
      getBridgeServiceStatus({
        config,
        runtimePath: paths.runtimePath,
        launchAgentLabel: paths.launchAgentLabel,
      }),
      loadBundledCatalog({ codexPath }),
      loadCodexClientVersion({ codexPath }),
    ]);
    const compatibility = await checkCurrentCompatibility({
      manifestPath: paths.compatibilityPath,
      bundledCatalog,
      codexClientVersion,
    });
    const result = { managedConfig, service, compatibility };
    if (options.json) printJson(result);
    else process.stdout.write(
      `config=${managedConfig.status} bridge=${service.status} compatibility=${compatibility.status}\n`,
    );
    return result;
  }
  throw new Error(`Unhandled command: ${options.command}`);
}
