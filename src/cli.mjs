import { supportsMlxTools } from "./mlx-capabilities.mjs";
import { MLX_COMMANDS, runMlxCli } from "./mlx-cli.mjs";

import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readdir, rmdir, unlink } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { inspectCodexAccountCache } from "./account-cache.mjs";
import { assertRuntimeCompressionSupport } from "./body-codec.mjs";
import { loadBridgeConfig } from "./bridge-config.mjs";
import { discoverBridgeModels } from "./bridge-discovery.mjs";
import { classifyDiscoveryFailure } from "./discovery.mjs";
import { runBridgeDoctor } from "./bridge-doctor.mjs";
import {
  checkCurrentCompatibility,
  createCompatibilityManifest,
  writeCompatibilityManifest,
} from "./compatibility-manifest.mjs";
import {
  certificationSubjectForModel,
  resolveModelCapabilitySlugs,
  resolveCertificationStatuses,
  runEfficientFidelityCertification,
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
import {
  CERTIFICATION_PENDING_GATE_VERSION,
  listenBridgeServer,
} from "./bridge-server.mjs";
import {
  buildMixedCodexCatalog,
  loadBundledCatalog,
  loadCodexClientVersion,
  loadNativeCatalog,
  readCodexCatalog,
  writeCatalogAtomic,
} from "./catalog.mjs";
import { isCodexDesktopRunning, openCodexDesktop } from "./codex-desktop-state.mjs";
import { executeCompanionAction } from "./companion-actions.mjs";
import { runCompanionCli } from "./companion-cli.mjs";
import { loadCompanionServiceConfig } from "./companion-config.mjs";
import { CompanionControlError, COMPANION_UNINSTALL_CHANGES, collectCompanionStatus, createCompanionReadOnlyProbes } from "./companion-control.mjs";
import { applyCompanionUpdate, checkForCompanionUpdate } from "./companion-update.mjs";
import { createUsageStore, inventoryUsageStore, revalidateUsageStoreInventory, removeUsageStoreInventory } from "./usage-store.mjs";
import { WEB_SEARCH_CONTRACT_VERSION } from "./web-search-wire.mjs";
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
  deactivateManagedConfiguration,
  enableManagedStandaloneWebSearch,
  getConfigStatus,
  inventoryManagedConfigOwnership,
  inventoryNativeConfigRestoration,
  inventoryConfigIntegrationSwitch,
  inventoryManagedConfigReactivation,
  inventoryDeactivatedConfigReactivation,
  installConfig,
  migrateManagedConfiguration,
  previewConfigIntegration,
  repairHistoricalChatsConfig,
  revalidateManagedConfigOwnership,
  revalidateNativeConfigRestoration,
  restoreRecoveredProviderEndMarker,
  suspendManagedConfiguration,
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
  assertModelCertificationRequestAllowed,
  assertNoPendingModelCertification,
  clearModelCertificationDeactivation,
  commitModelCertificationDeactivation,
  computeCertificationFingerprint,
  listPendingModelCertificationIds,
  recordPassedCertification,
  recordPassedEfficientFidelityCertification,
  stageModelCertificationDeactivation,
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
import {
  createCertificationProgress,
  emitCertificationProgress,
} from "./certification-progress.mjs";

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
  "repair-chats",
  "refresh",
  "serve",
  "setup",
  "status",
  "uninstall",
  "version",
]);

const HISTORICAL_CHAT_RECOVERY_DOC =
  "https://github.com/patrickschiller/pickermux/blob/main/docs/TROUBLESHOOTING.md#reconnecting-in-an-old-chat-after-deactivation-or-uninstall";

function usage() {
  return `PickerMux — Codex + external providers, one model picker

Use local or remote models through LM Studio or an explicitly configured
compatible Responses provider. LM Studio adds loaded-model discovery;
other providers require a model allowlist. The local mlx-chat-completions provider
loads pinned HF snapshots without LM Studio; reviewed Kolibri tools require certification.
Other Chat Completions servers are not supported by this adapter.

Usage:
  pickermux mlx-load REPOSITORY --alias NAME --python PATH [--revision REF] [--model-dir PATH] [--port N]
  pickermux mlx-prepare REPOSITORY --alias NAME --python PATH [--revision REF]
  pickermux mlx-start --model NAME [--port N]
  pickermux mlx-status [--json]
  pickermux mlx-stop --model NAME
  pickermux discover [--config PATH] [--json]
  pickermux build [--config PATH] [--output PATH] [--json]
  pickermux certify (--model SLUG | --all) [--config PATH] [--json]
  pickermux credential-set PROVIDER [--config PATH]
  pickermux credential-status PROVIDER [--config PATH] [--json]
  pickermux credential-delete PROVIDER [--config PATH]
  pickermux setup [--config PATH] [--json]
  pickermux install [--config PATH] [--json]
  pickermux repair-chats [--json]
  pickermux refresh [--config PATH] [--json]
  pickermux refresh --full
  pickermux doctor [--config PATH] [--live] [--json]
  pickermux status [--config PATH] [--json]
  pickermux companion status
  pickermux companion run  (one versioned JSON request on stdin)
  pickermux uninstall [--force] [--remove-cli | --purge [--restore-native]] [--json]

uninstall --purge --restore-native removes the owned installation and restores
native Codex defaults without reinstating a previous picker gateway or catalog.
The inert historical provider alias and unrelated Codex settings remain.
  pickermux version | pickermux --version

Companion schema 1 advertises integration-toggle-v1. configuration-apply requires
its previewToken and replaceIntegration:true; integration-deactivate requires
deactivateIntegration:true. Deactivation retains setup, historical aliases and
private runtime identity for confirmed reactivation without full-refresh purge.
Companion status advertises token-usage-v2: per-provider input, output and
total tokens for the last model request and private saved totals since reset.
Settings resets accumulated counts through usage-reset with exact
resetAccumulatedUsage:true consent; the last model request is retained.
Legacy token-usage-v1 backends still show counts since bridge start.
Missing usage remains unavailable; native and certification requests are excluded.
Companion update-check recognizes the DMG release channel. An update request
for a DMG returns DOWNLOAD_REQUIRED; replace the app, then explicitly review
Update installed backend in Settings. No downloaded DMG is executed by the CLI.
repair-chats restores only the inert model_bridge table used to open historical
chats after uninstall. Saved chat providers are unchanged.
refresh --full (also --FULL) recovers an account cache after a Codex update.
It requires interactive confirmation and unchanged managed configuration.
One valid, unowned root service_tier setting inside the managed block is
preserved; duplicate or malformed settings and routing edits still block changes.
After uninstall, fully restart Codex. Changing the selected model may leave
an existing chat on model_bridge. Native provider recovery:
${HISTORICAL_CHAT_RECOVERY_DOC}
The bundled Codex executable is detected in the current or legacy Desktop layout.
CODEX_BINARY overrides discovery for this command; it is not saved to the service.

Install and refresh enable shared Codex web search unless explicitly disabled.
External models still require tool certification; search uses the native Codex backend.
GPT-Live WebRTC bootstrap uses the native ChatGPT service; delegated tasks retain
their selected model. Voice audio and startup context go to OpenAI. This requires
account voice availability and a compatible Codex client; unknown schemas fail closed.
Setup and install automatically certify tool-capable providers without a valid receipt.
Legacy MLX servers remain text-only. Reviewed MLX tool protocols use the full certification matrix.
mlx-load requires the isolated, pinned mlx-lm environment and prints an allowlisted
provider stanza for your configuration; it never edits the active Codex configuration.
--context-window N (1024–8192) and --max-output-tokens N (1–2048) bind the profile.
Snapshots resolve to immutable HF revisions. Unreviewed repository Python is rejected.
token-performance-v1 shows measured output generation tokens/s after a finalized
MLX turn, excluding prefill/network time; timing is volatile and unavailable after restart.
Live tests can take several minutes per model. Keep configured models available and Codex fully closed.
Progress is written to stderr; --json keeps stdout machine-readable.
LM Studio context compaction uses one bounded summary request without tool schemas.
V2 summaries omit separately supplied base instructions, retaining all conversation messages.
Restored terminal summaries receive a short continuation instruction for a new answer.

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
    restoreNative: false,
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
    else if (argument === "--restore-native") options.restoreNative = true;
    else if (argument === "--full" || argument === "--FULL") options.full = true;
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
  if (options.configPath && command === "repair-chats") {
    throw new Error("repair-chats always repairs the active Codex config.toml");
  }
  if (options.removeCli && command !== "uninstall") throw new Error("--remove-cli is supported only by uninstall");
  if (options.purge && command !== "uninstall") throw new Error("--purge is supported only by uninstall");
  if (options.purge && options.removeCli) {
    throw new Error("--purge already includes --remove-cli");
  }
  if (options.restoreNative && (command !== "uninstall" || !options.purge || options.force)) {
    throw new Error("--restore-native requires uninstall --purge and cannot be combined with --force");
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

export async function buildCatalog({
  config,
  codexPath,
  codexHome,
  outputPath,
  certificationPath,
  credentialResolver,
  allowBundledFallback = true,
  discoverImpl = discoverBridgeModels,
  bundledCatalogImpl = loadBundledCatalog,
  clientVersionImpl = loadCodexClientVersion,
}) {
  const [bundledCatalog, codexClientVersion] = await Promise.all([
    bundledCatalogImpl({ codexPath }),
    clientVersionImpl({ codexPath }),
  ]);
  // An invalid account snapshot must stop publication before external provider
  // discovery or credential resolution can obscure the required recovery.
  const nativeCatalog = await loadNativeCatalog({
    codexHome,
    bundledCatalog,
    expectedClientVersion: codexClientVersion,
    allowBundledFallback,
  });
  const discovery = await discoverImpl({ config, credentialResolver });
  const capabilities = certificationPath
    ? await resolveModelCapabilitySlugs({
        storePath: certificationPath,
        config,
        models: discovery.models,
        codexClientVersion,
      })
    : { certifiedModelSlugs: [], efficientFidelityModelSlugs: [] };
  const { certifiedModelSlugs, efficientFidelityModelSlugs } = capabilities;
  const catalog = buildMixedCodexCatalog({
    discoveredModels: discovery.models,
    bundledCatalog,
    nativeCatalog: nativeCatalog.catalog,
    certifiedModelSlugs,
    efficientFidelityModelSlugs,
  });
  const writtenPath = await writeCatalogAtomic(outputPath, catalog);
  return {
    discovery,
    bundledCatalog,
    nativeCatalog,
    codexClientVersion,
    certifiedModelSlugs,
    efficientFidelityModelSlugs,
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
      supportsStandaloneWebSearch: true,
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
    supportsStandaloneWebSearch: true,
  });
  const parsed = await debugModels({ codexPath, overrides });
  assertCatalogSlugs(parsed, catalog.models.map((model) => model.slug));
  return parsed;
}

async function rollbackInstallation({
  paths,
  configInstalled,
  configRollback,
  serviceStarted,
  catalogPromoted,
  previousCatalog,
  compatibilityPromoted,
  previousCompatibility = null,
  servicePackage,
  previousRuntime,
  cause,
}) {
  const failures = [];
  if (configInstalled) {
    try {
      if (typeof configRollback === "function") await configRollback();
      else await uninstallConfig({
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
        removeRuntime: !previousRuntime,
        ...(previousRuntime ? { expectedLaunchAgent: expectedManagedLaunchAgent(paths) } : {}),
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (previousRuntime) {
    try { await assertRetainedIntegrationRuntime({ paths, runtime: previousRuntime }); } catch (error) { failures.push(error); }
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

export async function resolveIntegrationReactivationRuntime({ paths, status, reactivationReceipt, runtimeImpl = readRuntime } = {}) {
  if (status?.status !== "deactivated") return createRuntimeRecord({ configPath: paths.serviceConfigPath });
  if (!reactivationReceipt) throw new CompanionControlError("CONFIGURATION_CONFLICT");
  const runtime = await runtimeImpl(paths.runtimePath);
  if (path.resolve(runtime.configPath) !== path.resolve(paths.serviceConfigPath)) throw new CompanionControlError("CONFIGURATION_CONFLICT");
  return runtime;
}

export async function assertRetainedIntegrationRuntime({ paths, runtime, runtimeImpl = readRuntime } = {}) {
  const current = await runtimeImpl(paths.runtimePath);
  if (current.capability !== runtime.capability || current.instanceId !== runtime.instanceId || current.configPath !== runtime.configPath) {
    throw new CompanionControlError("CONFIGURATION_CONFLICT");
  }
}

async function install({
  config,
  configPath,
  paths,
  codexPath,
  sourceRoot = projectRoot,
  integrationSwitchReceipt,
  reactivationReceipt,
  beforeConfigCommit = async () => {},
}) {
  assertRuntimeCompressionSupport();
  assertPersistentCredentialSupport(config);
  const existing = await getConfigStatus({ configPath: paths.configPath, statePath: paths.statePath });
  if (existing.installed) throw new Error(`PickerMux is already installed (${existing.status})`);
  if (!reactivationReceipt) {
    const preview = await previewConfigIntegration({ configPath: paths.configPath, statePath: paths.statePath });
    if (!preview.canApply || (["ollama", "foreign"].includes(preview.status) && !integrationSwitchReceipt)) throw new CompanionControlError("CONFIGURATION_CONFLICT");
  }

  const stagingPath = path.join(
    paths.installDirectory,
    `.models.install-${process.pid}-${randomUUID()}.json`,
  );
  const runtime = await resolveIntegrationReactivationRuntime({ paths, status: existing, reactivationReceipt });
  const previousRuntime = existing.status === "deactivated" ? runtime : undefined;
  let serviceStarted = false;
  let configInstalled = false;
  let configRollback;
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
    const started = await startBridgeService({
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
      preserveRuntime: existing.status === "deactivated",
      beforeBootstrap: beforeConfigCommit,
    });
    serviceStarted = true;
    assertBridgeWebSearchCompatibility(started.health);
    const installed = await installConfig({ ...installationOptions({ config, paths, runtime }), integrationSwitchReceipt, reactivationReceipt, beforeConfigCommit });
    configInstalled = true;
    configRollback = installed.rollback;

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
        configRollback,
        serviceStarted,
        catalogPromoted,
        previousCatalog,
        compatibilityPromoted,
        previousCompatibility,
        servicePackage,
        previousRuntime,
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
  managedConfigUpdate,
  restoreImpl = restorePrivateFile,
  restorePackageImpl = restoreServicePackage,
  restartImpl = restartBridgeService,
}) {
  const failures = [];
  if (managedConfigUpdate?.changed && typeof managedConfigUpdate.rollback === "function") {
    try {
      await managedConfigUpdate.rollback();
    } catch (error) {
      failures.push(error);
    }
  }
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
    rollbackConfig = await loadCompanionServiceConfig({ paths });
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
    let managedConfigUpdate;
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
      const restarted = await restartBridgeService({
        config,
        runtimePath: paths.runtimePath,
        launchAgentLabel: paths.launchAgentLabel,
      });
      if (
        restarted.health?.certificationPendingGateVersion !==
        CERTIFICATION_PENDING_GATE_VERSION
      ) {
        throw new Error(
          "The restarted bridge did not confirm its certification request gate",
        );
      }
      assertBridgeWebSearchCompatibility(restarted.health);
      managedConfigUpdate = await enableManagedStandaloneWebSearch({
        configPath: paths.configPath,
        statePath: paths.statePath,
        backupDirectory: paths.backupDirectory,
      });
      const layoutUpdate = await migrateManagedConfiguration({
        configPath: paths.configPath,
        statePath: paths.statePath,
        backupDirectory: paths.backupDirectory,
      });
      const searchUpdate = managedConfigUpdate;
      managedConfigUpdate = {
        changed: searchUpdate.changed || layoutUpdate.changed,
        async rollback() {
          const failures = [];
          for (const update of [layoutUpdate, searchUpdate]) {
            if (!update.changed || typeof update.rollback !== "function") continue;
            try { await update.rollback(); } catch (error) { failures.push(error); }
          }
          if (failures.length) throw new AggregateError(failures, "Managed configuration rollback was incomplete");
        },
      };
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
          managedConfigUpdate,
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
      certificationPendingGateVersion: CERTIFICATION_PENDING_GATE_VERSION,
      selectionReset: selection.changed,
      restartRequired: true,
    };
  } finally {
    await unlink(stagingPath).catch(() => {});
  }
}

export function assertBridgeWebSearchCompatibility(health) {
  if (health?.webSearchContractVersion !== WEB_SEARCH_CONTRACT_VERSION) {
    throw new Error("The running bridge did not confirm its standalone web search contract");
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
          return resolveModelCapabilitySlugs({
            storePath: certificationPath,
            config,
            models,
            codexClientVersion,
          });
        },
        async assertPublishAllowed() {
          await compatibilityGate.assertReady();
          await assertNoPendingModelCertification(certificationPath);
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
    nativeSearchModel: config.bridge.webSearchModel ?? config.bridge.defaultModel,
    instanceId: runtime.instanceId,
    limits: config.bridge.limits,
    credentialResolver,
    port: config.bridge.port,
    compatibilityGate,
    tokenUsageStore: createUsageStore({
      directory: path.join(resolveDistributionPaths().applicationDirectory, "usage"),
    }),
    externalRequestGate({
      publicModelId,
      certificationRequest,
      requiresDirectReceipt,
      requiresEfficientFidelityReceipt,
    }) {
      return assertModelCertificationRequestAllowed(
        certificationPath,
        publicModelId,
        {
          certificationRequest,
          requiresDirectReceipt,
          requiresEfficientFidelityReceipt,
        },
      );
    },
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
        server.close((error) => {
          if (error) reject(error);
          else Promise.resolve(server.flushTokenUsage()).then(resolve, reject);
        });
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

function selectCertificationModels(models, targetModelIds, {
  exactSet = false,
  label = "Certification discovery",
} = {}) {
  if (!Array.isArray(models)) {
    throw new Error(`${label} returned no model array`);
  }
  const byId = new Map();
  for (const candidate of models) {
    if (typeof candidate?.id !== "string" || !candidate.id || byId.has(candidate.id)) {
      throw new Error(`${label} returned invalid or duplicate model ids`);
    }
    byId.set(candidate.id, candidate);
  }
  const requested = new Set(targetModelIds);
  if (
    exactSet &&
    (byId.size !== requested.size || [...byId.keys()].some((id) => !requested.has(id)))
  ) {
    throw new Error(
      "The discovered model set changed during certification deactivation; retry certification",
    );
  }
  return targetModelIds.map((id) => {
    const candidate = byId.get(id);
    if (!candidate) {
      throw new Error(
        `External model ${id} changed or disappeared during certification deactivation`,
      );
    }
    return candidate;
  });
}

function certificationSubjects({ config, models, codexClientVersion }) {
  return models.map((candidate) => ({
    candidate,
    subject: certificationSubjectForModel({
      config,
      model: candidate,
      codexClientVersion,
    }),
  }));
}

function assertMatchingCertificationSubjects(expected, current) {
  const currentById = new Map(
    current.map((entry) => [entry.subject.publicModelId, entry.subject]),
  );
  for (const entry of expected) {
    const currentSubject = currentById.get(entry.subject.publicModelId);
    if (
      !currentSubject ||
      computeCertificationFingerprint(currentSubject) !==
        computeCertificationFingerprint(entry.subject)
    ) {
      throw new Error(
        `External model ${entry.subject.publicModelId} changed during certification; no receipt was published`,
      );
    }
  }
}

function assertCertificationModelsDeactivated(catalog, targetModelIds) {
  for (const modelId of targetModelIds) {
    const catalogModel = catalog.models.find((entry) => entry.slug === modelId);
    if (!catalogModel) {
      throw new Error(
        `The conservative catalog is missing certification model ${modelId}`,
      );
    }
    if (
      catalogModel.tool_mode !== null ||
      catalogModel.shell_type !== "disabled" ||
      catalogModel.supports_search_tool !== false
    ) {
      throw new Error(
        `Certification model ${modelId} was not published conservatively`,
      );
    }
  }
}

function assertCertificationModelsAbsent(catalog, externalModels, modelIds) {
  for (const modelId of modelIds) {
    if (
      externalModels.some((entry) => entry.id === modelId) ||
      catalog.models.some((entry) => entry.slug === modelId)
    ) {
      throw new Error(
        `Pending certification model ${modelId} is available again; retry certification so it can be probed`,
      );
    }
  }
}

function assertCertificationPendingGate(refreshResult, label) {
  if (
    refreshResult?.certificationPendingGateVersion !==
    CERTIFICATION_PENDING_GATE_VERSION
  ) {
    throw new Error(
      `${label} did not confirm the certification request gate`,
    );
  }
  return refreshResult;
}

async function currentCertificationSubjects({
  config,
  codexPath,
  credentialResolver,
  targetModelIds,
  exactSet,
  discoverImpl,
  clientVersionImpl,
}) {
  const [discovery, codexClientVersion] = await Promise.all([
    discoverImpl({ config, credentialResolver }),
    clientVersionImpl({ codexPath }),
  ]);
  const models = selectCertificationModels(discovery.models, targetModelIds, {
    exactSet,
    label: "Certification revalidation",
  });
  return certificationSubjects({ config, models, codexClientVersion });
}

export async function runCertificationTransaction({
  config,
  paths,
  codexPath,
  runtime,
  credentialResolver,
  targetModelIds,
  recoveryModelIds = [],
  exactModelSet = false,
  sourceRoot = projectRoot,
  onProgress,
}, {
  refreshImpl = refresh,
  discoverImpl = discoverBridgeModels,
  clientVersionImpl = loadCodexClientVersion,
  readCatalogImpl = readCodexCatalog,
  stageDeactivationImpl = stageModelCertificationDeactivation,
  commitDeactivationImpl = commitModelCertificationDeactivation,
  clearDeactivationImpl = clearModelCertificationDeactivation,
  listPendingImpl = listPendingModelCertificationIds,
  runModelCertificationImpl = runModelCertification,
  runEfficientFidelityCertificationImpl = runEfficientFidelityCertification,
  recordPassedCertificationImpl = recordPassedCertification,
  recordPassedEfficientFidelityCertificationImpl =
    recordPassedEfficientFidelityCertification,
} = {}) {
  if (!Array.isArray(targetModelIds) || !Array.isArray(recoveryModelIds)) {
    throw new TypeError("Certification and recovery model ids must be arrays");
  }
  const allIds = [...targetModelIds, ...recoveryModelIds];
  if (
    allIds.some((modelId) => typeof modelId !== "string" || !modelId) ||
    new Set(allIds).size !== allIds.length
  ) {
    throw new Error("Certification and recovery model ids must be unique strings");
  }
  if (allIds.length === 0) {
    throw new Error("Certification requires a model or pending recovery target");
  }
  const recoveryAttempted = recoveryModelIds.length > 0;
  let recoveryCleared = recoveryModelIds.length === 0;
  let targetPendingAtStart = false;
  let deactivationAttempted = false;
  let deactivationStaged = false;
  let conservativePublicationConfirmed = false;
  let deactivationCleared = false;
  let currentModelId;
  try {
    emitCertificationProgress(onProgress, { phase: "prepare" });
    const pendingAtStart = await listPendingImpl(paths.certificationPath);
    targetPendingAtStart = targetModelIds.some((modelId) =>
      pendingAtStart.includes(modelId),
    );
    const authorityRefresh = assertCertificationPendingGate(
      await refreshImpl({ config, paths, codexPath, sourceRoot }),
      "Certification authority refresh",
    );
    if (targetModelIds.length > 0) {
      selectCertificationModels(authorityRefresh.externalModels, targetModelIds, {
        exactSet: exactModelSet,
        label: "Certification authority refresh",
      });
    }
    if (recoveryModelIds.length > 0) {
      const authorityCatalog = await readCatalogImpl(paths.catalogPath);
      assertCertificationModelsAbsent(
        authorityCatalog,
        authorityRefresh.externalModels,
        recoveryModelIds,
      );
      await clearDeactivationImpl(
        paths.certificationPath,
        recoveryModelIds,
      );
      recoveryCleared = true;
    }
    if (targetModelIds.length === 0) {
      return {
        certified: [],
        recoveredPending: [...recoveryModelIds],
        refreshed: authorityRefresh,
        restartRequired: true,
      };
    }

    deactivationAttempted = true;
    await stageDeactivationImpl(paths.certificationPath, targetModelIds);
    deactivationStaged = true;

    const deactivated = assertCertificationPendingGate(
      await refreshImpl({ config, paths, codexPath, sourceRoot }),
      "Conservative certification refresh",
    );
    const reboundModels = selectCertificationModels(
      deactivated.externalModels,
      targetModelIds,
      {
        exactSet: exactModelSet,
        label: "Conservative certification refresh",
      },
    );
    const [codexClientVersion, conservativeCatalog] = await Promise.all([
      clientVersionImpl({ codexPath }),
      readCatalogImpl(paths.catalogPath),
    ]);
    assertCertificationModelsDeactivated(conservativeCatalog, targetModelIds);
    const rebound = certificationSubjects({
      config,
      models: reboundModels,
      codexClientVersion,
    });
    conservativePublicationConfirmed = true;

    const currentBeforeInvalidation = await currentCertificationSubjects({
      config,
      codexPath,
      credentialResolver,
      targetModelIds,
      exactSet: exactModelSet,
      discoverImpl,
      clientVersionImpl,
    });
    assertMatchingCertificationSubjects(rebound, currentBeforeInvalidation);
    await commitDeactivationImpl(paths.certificationPath, targetModelIds);

    const completed = [];
    for (const entry of rebound) {
      const { candidate, subject } = entry;
      currentModelId = candidate.id;
      emitCertificationProgress(onProgress, {
        phase: "model",
        index: completed.length + 1,
        total: rebound.length,
        probeCount: subject.providerKind === "lmstudio-responses" ||
          (subject.providerKind === "mlx-chat-completions" && supportsMlxTools(subject.capabilities)) ? 9 : 7,
      });
      assertMatchingCertificationSubjects(
        [entry],
        await currentCertificationSubjects({
          config,
          codexPath,
          credentialResolver,
          targetModelIds: [candidate.id],
          exactSet: false,
          discoverImpl,
          clientVersionImpl,
        }),
      );

      const gates = await runModelCertificationImpl({
        baseUrl: bridgeBaseUrl(config, runtime),
        model: candidate,
        certificationToken: runtime.instanceId,
        onProgress,
      });
      assertMatchingCertificationSubjects(
        [entry],
        await currentCertificationSubjects({
          config,
          codexPath,
          credentialResolver,
          targetModelIds: [candidate.id],
          exactSet: false,
          discoverImpl,
          clientVersionImpl,
        }),
      );
      const receipt = await recordPassedCertificationImpl(
        paths.certificationPath,
        subject,
        gates,
      );

      const supportsEfficientFidelity =
        subject.providerKind === "lmstudio-responses" ||
        (subject.providerKind === "mlx-chat-completions" && supportsMlxTools(subject.capabilities));
      let efficientFidelity = supportsEfficientFidelity
        ? "direct-fallback"
        : "not-applicable";
      let efficientFidelityFailure;
      let efficientFidelityPassedAt;
      let efficientFidelityGates;
      if (supportsEfficientFidelity) {
        assertMatchingCertificationSubjects(
          [entry],
          await currentCertificationSubjects({
            config,
            codexPath,
            credentialResolver,
            targetModelIds: [candidate.id],
            exactSet: false,
            discoverImpl,
            clientVersionImpl,
          }),
        );
        try {
          efficientFidelityGates =
            await runEfficientFidelityCertificationImpl({
              baseUrl: bridgeBaseUrl(config, runtime),
              model: candidate,
              certificationToken: runtime.instanceId,
              onProgress,
            });
        } catch {
          // Efficient Fidelity is additive. The independently revalidated
          // Direct receipt remains the safe fallback. Expose only a stable
          // diagnostic code; provider errors can contain prompt fragments.
          efficientFidelityFailure = "additive-probe-failed";
        }
      }
      if (efficientFidelityGates) {
        assertMatchingCertificationSubjects(
          [entry],
          await currentCertificationSubjects({
            config,
            codexPath,
            credentialResolver,
            targetModelIds: [candidate.id],
            exactSet: false,
            discoverImpl,
            clientVersionImpl,
          }),
        );
        const efficientReceipt =
          await recordPassedEfficientFidelityCertificationImpl(
            paths.certificationPath,
            subject,
            efficientFidelityGates,
          );
        efficientFidelity = "enabled";
        efficientFidelityPassedAt = efficientReceipt.passedAt;
      }
      completed.push({
        model: candidate.id,
        status: "valid",
        passedAt: receipt.passedAt,
        efficientFidelity,
        ...(efficientFidelityFailure
          ? { efficientFidelityFailure }
          : {}),
        ...(efficientFidelityPassedAt
          ? { efficientFidelityPassedAt }
          : {}),
      });
      emitCertificationProgress(onProgress, {
        phase: "model-passed",
        mode: efficientFidelity === "enabled" ? "efficient" : "direct",
      });
    }

    assertMatchingCertificationSubjects(
      rebound,
      await currentCertificationSubjects({
        config,
        codexPath,
        credentialResolver,
        targetModelIds,
        exactSet: exactModelSet,
        discoverImpl,
        clientVersionImpl,
      }),
    );
    await clearDeactivationImpl(paths.certificationPath, targetModelIds);
    deactivationCleared = true;
    emitCertificationProgress(onProgress, { phase: "publishing" });
    const refreshed = assertCertificationPendingGate(
      await refreshImpl({ config, paths, codexPath, sourceRoot }),
      "Certified catalog refresh",
    );
    const finalModels = selectCertificationModels(
      refreshed.externalModels,
      targetModelIds,
      {
        exactSet: exactModelSet,
        label: "Certified catalog refresh",
      },
    );
    const finalVersion = await clientVersionImpl({ codexPath });
    assertMatchingCertificationSubjects(
      rebound,
      certificationSubjects({
        config,
        models: finalModels,
        codexClientVersion: finalVersion,
      }),
    );
    return {
      certified: completed,
      recoveredPending: [...recoveryModelIds],
      refreshed,
      restartRequired: true,
    };
  } catch (error) {
    const recoveryErrors = [];
    if (
      deactivationStaged &&
      conservativePublicationConfirmed &&
      !deactivationCleared
    ) {
      try {
        assertCertificationPendingGate(
          await refreshImpl({ config, paths, codexPath, sourceRoot }),
          "Conservative recovery refresh",
        );
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError);
      }
      if (recoveryErrors.length === 0) {
        try {
          await clearDeactivationImpl(paths.certificationPath, targetModelIds);
          deactivationCleared = true;
        } catch (recoveryError) {
          recoveryErrors.push(recoveryError);
        }
      }
    }
    const baseMessage = currentModelId
      ? `Certification failed for ${currentModelId}: ${error.message}`
      : `Certification deactivation failed: ${error.message}`;
    const pendingHint =
      (deactivationAttempted && !deactivationCleared) ||
      (recoveryAttempted && !recoveryCleared) ||
      (targetPendingAtStart && !deactivationCleared)
        ? "; certification remains blocked pending recovery; retry the same certify command"
        : "";
    const message = `${baseMessage}${pendingHint}`;
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        `${message}; conservative recovery was incomplete`,
      );
    }
    throw new Error(message, { cause: error });
  }
}

export async function certify({
  config, paths, codexPath, model, all,
  onlyUncertified = false,
  sourceRoot = projectRoot,
  onProgress,
}, {
  configStatusImpl = getConfigStatus,
  serviceStatusImpl = getBridgeServiceStatus,
  runtimeImpl = readRuntime,
  discoverImpl = discoverBridgeModels,
  listPendingImpl = listPendingModelCertificationIds,
  clientVersionImpl = loadCodexClientVersion,
  resolveStatusesImpl = resolveCertificationStatuses,
  transactionImpl = runCertificationTransaction,
  credentialResolver = createCredentialResolver(),
} = {}) {
  const textOnlyProviders = new Set((config.providers ?? [])
    .filter((provider) => provider.kind === "mlx-chat-completions")
    .map((provider) => provider.id));
  const [managedConfig, service, runtime] = await Promise.all([
    configStatusImpl({ configPath: paths.configPath, statePath: paths.statePath }),
    serviceStatusImpl({
      config,
      runtimePath: paths.runtimePath,
      launchAgentLabel: paths.launchAgentLabel,
    }),
    runtimeImpl(paths.runtimePath),
  ]);
  if (!managedConfig.installed || !managedConfig.healthy || !service.healthy) {
    throw new Error("PickerMux model certification requires a healthy installed bridge");
  }

  const [discovery, pendingModelIds] = await Promise.all([
    discoverImpl({ config, credentialResolver }),
    listPendingImpl(paths.certificationPath),
  ]);
  const isTextOnly = (entry) => textOnlyProviders.has(entry.providerId) && !supportsMlxTools(entry.capabilities);
  const textOnly = discovery.models.filter(isTextOnly);
  if (!all && textOnly.some((entry) => entry.id === model)) {
    throw new Error("The local MLX model has no reviewed tool protocol; upgrade its server before certification");
  }
  const supported = discovery.models.filter((entry) => !isTextOnly(entry));
  const supportedIds = new Set(discovery.models.map((entry) => entry.id));
  let candidates = all
    ? supported
    : supported.filter((entry) => entry.id === model);
  let reused = 0;
  if (onlyUncertified) {
    const statuses = await resolveStatusesImpl({
      storePath: paths.certificationPath,
      config,
      models: candidates,
      codexClientVersion: await clientVersionImpl({ codexPath }),
    });
    const validIds = new Set(statuses
      .filter((entry) => entry.certification.status === "valid")
      .map((entry) => entry.model.id));
    const required = candidates.filter((entry) =>
      !validIds.has(entry.id) || pendingModelIds.includes(entry.id),
    );
    reused = candidates.length - required.length;
    candidates = required;
  }
  const recoveryModelIds = all
    ? pendingModelIds.filter((modelId) => !supportedIds.has(modelId))
    : pendingModelIds.includes(model) && candidates.length === 0
      ? [model]
      : [];
  if (candidates.length === 0 && recoveryModelIds.length === 0) {
    if (onlyUncertified) {
      return { certified: [], recoveredPending: [], reused, textOnly: textOnly.length, restartRequired: true };
    }
    throw new Error(
      all
        ? "No external model with a reviewed tool protocol is available for certification"
        : `External model ${model} was not discovered`,
    );
  }

  const result = await transactionImpl({
    config,
    paths,
    codexPath,
    runtime,
    credentialResolver,
    targetModelIds: candidates.map((candidate) => candidate.id),
    recoveryModelIds,
    exactModelSet: all && !onlyUncertified && textOnly.length === 0,
    sourceRoot,
    onProgress,
  });
  return onlyUncertified ? { ...result, reused } : result;
}

export async function certifyForInstallation({
  config, paths, codexPath, sourceRoot, onProgress,
}, {
  certifyImpl = certify,
  desktopRunningImpl = isCodexDesktopRunning,
} = {}) {
  emitCertificationProgress(onProgress, { phase: "start" });
  try {
    await assertCodexDesktopClosed(desktopRunningImpl);
    const result = await certifyImpl({
      config, paths, codexPath, sourceRoot, onProgress,
      all: true,
      onlyUncertified: true,
    });
    emitCertificationProgress(onProgress, {
      phase: result.certified.length > 0 || result.recoveredPending.length > 0
        ? "complete"
        : result.reused > 0 ? "reused" : "no-models",
    });
    return { ...result, status: "complete" };
  } catch {
    // The installation is already committed. Certification owns its pending
    // barrier and conservative recovery; never roll back only the CLI here or
    // echo an arbitrary provider/service error into installer output.
    emitCertificationProgress(onProgress, { phase: "failed" });
    return { status: "incomplete", retryCommand: "pickermux certify --all" };
  }
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
  preserveRuntime = false,
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
    preserveRuntime,
  });
}

/**
 * Restore native Codex configuration without deleting the installed catalog,
 * service package, service configuration, certifications, or CLI receipt.
 * The service is stopped first so a configuration failure can restore it
 * without ever exposing native Codex traffic to a half-removed bridge.
 */
export async function suspendPickerMuxForFullRefresh(options = {}) {
  return suspendPickerMuxIntegration(options, false);
}

/** Deliberate pause has no purge/checkpoint and never quits Codex on its behalf. */
export async function deactivatePickerMuxIntegration({
  desktopRunningImpl = isCodexDesktopRunning,
  assertNoPendingFullRefreshImpl = () => assertNoPendingFullRefresh({ fullRefreshPaths: resolveFullRefreshPaths() }),
  ...options
} = {}) {
  const guard = async () => {
    await assertNoPendingFullRefreshImpl();
    if (await desktopRunningImpl()) throw new CompanionControlError("CODEX_RUNNING");
  };
  await guard();
  return suspendPickerMuxIntegration({ ...options, beforeSuspensionCommit: guard, uninstallConfigImpl: options.uninstallConfigImpl ?? deactivateManagedConfiguration }, true);
}

async function suspendPickerMuxIntegration({
  config,
  paths,
  sourceRoot,
  configStatusImpl = getConfigStatus,
  runtimeImpl = readRuntime,
  validateLaunchAgentImpl = assertManagedLaunchAgent,
  inventoryRuntimeImpl = inventoryManagedServicePackage,
  inventoryConfigImpl = inventoryManagedConfigOwnership,
  revalidateConfigImpl = revalidateManagedConfigOwnership,
  uninstallConfigImpl = suspendManagedConfiguration,
  stopServiceImpl = stopBridgeService,
  serviceStatusImpl = getBridgeServiceStatus,
  startServiceImpl = startBridgeService,
  beforeSuspensionCommit = async () => {},
}, deactivation) {
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

  if (deactivation && (!status.installed || !["installed", "installed-marker-recovered"].includes(status.status))) throw new CompanionControlError("CONFIGURATION_CONFLICT");
  if (!deactivation && status.status === "deactivated") throw new CompanionControlError("CONFIGURATION_CONFLICT");
  if (!status.installed) {
    const service = await stopServiceImpl({
      runtimePath: paths.runtimePath,
      launchAgentPath: paths.launchAgentPath,
      launchAgentLabel: paths.launchAgentLabel,
      expectedLaunchAgent: expectedManagedLaunchAgent(paths),
      removeRuntime: !deactivation,
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
  let removedConfig;
  try {
    await beforeSuspensionCommit();
    // bootout may commit before plist removal fails. Any stop attempt requires
    // ownership-safe restoration, even when the stop function rejects.
    if (deactivation) serviceStopped = true;
    const service = await stopServiceImpl({
      runtimePath: paths.runtimePath,
      launchAgentPath: paths.launchAgentPath,
      launchAgentLabel: paths.launchAgentLabel,
      expectedLaunchAgent: expectedManagedLaunchAgent(paths),
      removeRuntime: !deactivation,
    });
    serviceStopped = true;
    await inventoryRuntimeImpl({
      serviceDirectory: paths.serviceDirectory,
      sourceRoot,
    });
    await revalidateConfigImpl(configOwnership);
    removedConfig = await uninstallConfigImpl({
      configPath: paths.configPath,
      statePath: paths.statePath,
      backupDirectory: paths.backupDirectory,
      ownershipReceipt: configOwnership,
      beforeConfigCommit: beforeSuspensionCommit,
    });
    const suspendedStatus = await configStatusImpl({
      configPath: paths.configPath,
      statePath: paths.statePath,
    });
    if (suspendedStatus.installed || suspendedStatus.healthy !== true || (deactivation && suspendedStatus.status !== "deactivated")) {
      throw new Error("Native Codex configuration was not restored cleanly");
    }
    return {
      ...(deactivation ? { deactivated: true, status: "deactivated", restartRequired: true } : {}),
      suspended: true,
      alreadySuspended: false,
      removedConfig,
      service,
    };
  } catch (cause) {
    if (!serviceStopped) {
      if (deactivation) throw new CompanionControlError("DEACTIVATION_FAILED");
      throw cause;
    }
    try {
      if (removedConfig?.changed && typeof removedConfig.rollback === "function") await removedConfig.rollback();
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
      if (deactivation) {
        const preservedRuntime = await runtimeImpl(paths.runtimePath);
        if (preservedRuntime.capability !== runtime.capability || preservedRuntime.instanceId !== runtime.instanceId || preservedRuntime.configPath !== runtime.configPath) {
          throw new CompanionControlError("CONFIGURATION_CONFLICT");
        }
        const currentAgent = await validateLaunchAgentImpl(managedLaunchAgentOptions(paths));
        if (currentAgent.present && (currentAgent.nodePath !== launchAgent.nodePath ||
          (launchAgent.device !== undefined && currentAgent.device !== launchAgent.device) ||
          (launchAgent.inode !== undefined && currentAgent.inode !== launchAgent.inode))) {
          throw new CompanionControlError("CONFIGURATION_CONFLICT");
        }
      }
      await restoreFullRefreshBridgeService({
        config,
        paths,
        runtime,
        nodePath: launchAgent.nodePath,
        preserveRuntime: deactivation,
        serviceStatusImpl,
        startServiceImpl,
      });
    } catch (rollbackError) {
      if (deactivation) throw new CompanionControlError("DEACTIVATION_ROLLBACK_FAILED");
      throw new Error(
        `PickerMux full refresh suspension failed and service rollback was incomplete. Original: ${cause.message}; rollback: ${rollbackError.message}`,
        { cause: new AggregateError([cause, rollbackError]) },
      );
    }
    if (deactivation) {
      if (cause instanceof CompanionControlError) throw cause;
      throw new CompanionControlError("DEACTIVATION_FAILED");
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
  reactivationImpl = inventoryManagedConfigReactivation,
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
  if (status.status === "deactivated") throw new CompanionControlError("CONFIGURATION_CONFLICT");
  if (!status.installed) {
    const reactivationReceipt = status.status === "suspended"
      ? await reactivationImpl({ configPath: paths.configPath, statePath: paths.statePath, backupDirectory: paths.backupDirectory })
      : undefined;
    return installImpl({
      config,
      configPath: paths.serviceConfigPath,
      paths,
      codexPath,
      sourceRoot,
      ...(reactivationReceipt ? { reactivationReceipt } : {}),
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
  restoreNative = false,
  nativeRestorationReceipt,
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
    restoreNative,
    nativeRestorationReceipt,
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
    const error = new Error(
      "PickerMux uninstall requires Codex Desktop to be fully quit with Command-Q",
    );
    error.code = "CODEX_RUNNING";
    throw error;
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

function nativeUninstallPreviewToken({ distribution, nativeRestorationReceipt, installInventory, backupInventory, providerIds }) {
  const identity = (entry) => [entry.snapshot?.dev, entry.snapshot?.ino, entry.snapshot?.mode, entry.snapshot?.size];
  const entries = [...(installInventory.entries ?? [])].sort((left, right) => left.name.localeCompare(right.name));
  if (entries.some((entry) => entry.name.startsWith("runtime-app.previous-"))) {
    throw new CompanionControlError("UNINSTALL_PREFLIGHT_FAILED");
  }
  return createHash("sha256").update(JSON.stringify([
    "pickermux-native-uninstall-preview-v1", nativeRestorationReceipt.previewToken,
    createHash("sha256").update(distribution.raw).digest("hex"),
    // Live service logs/catalogs may change during the consent window. Bind
    // their fixed removal scope here; purge separately inventories and checks
    // their exact current hashes and identities under the lifecycle lock.
    entries.map((entry) => [entry.name, entry.type]),
    (backupInventory.backups ?? []).map((entry) => [entry.name, entry.sha256, identity(entry)]),
    providerIds, COMPANION_UNINSTALL_CHANGES,
  ])).digest("hex");
}

function nativeUninstallFailure(error, fallback = "UNINSTALL_FAILED") {
  const seen = new Set();
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 8 && !seen.has(current); current = current.cause, depth += 1) {
    seen.add(current);
    if (/^PICKERMUX_(?:PURGE|CREDENTIAL_PURGE)_/u.test(current.code ?? "")) return new CompanionControlError("PURGE_INCOMPLETE");
    // Competing rollback causes cannot imply that a simpler guard recovered.
    if (current instanceof AggregateError || /ROLLBACK_FAILED$/u.test(current.code ?? "")) break;
    if (current instanceof CompanionControlError) return current;
    if (["CODEX_RUNNING", "RECOVERY_PENDING"].includes(current.code)) return new CompanionControlError(current.code);
    if (current.code === "PICKERMUX_INSTALLATION_LOCK_BUSY") return new CompanionControlError("BUSY");
    if (current.name === "ConfigManagerError") return new CompanionControlError("UNINSTALL_CONFLICT");
  }
  return new CompanionControlError(fallback);
}

/** Full read-only removal preflight; private inventories never cross the GUI. */
export async function previewPickerMuxUninstall({
  paths = resolveInstallPaths(), distributionPaths = resolveDistributionPaths(), sourceRoot,
  desktopRunningImpl = isCodexDesktopRunning,
  assertNoPendingFullRefreshImpl = async () => null,
  validateDistributionImpl = validateDistributionInstallation,
  validateLaunchAgentImpl = assertManagedLaunchAgent,
  inventoryInstallImpl = inventoryPickerMuxInstallDirectory,
  inventoryBackupsImpl = inventoryPickerMuxBackups,
  inventoryRuntimeImpl = inventoryManagedServicePackage,
  inventoryConfigImpl = inventoryManagedConfigOwnership,
  inventoryNativeConfigImpl = inventoryNativeConfigRestoration,
  listProviderIdsImpl = listRegisteredKeychainProviderIds,
  inventoryUsageImpl = inventoryUsageStore,
} = {}) {
  try {
    await assertNoPendingFullRefreshImpl();
    if (await desktopRunningImpl()) throw new CompanionControlError("CODEX_RUNNING");
    const distribution = await validateDistributionImpl({ paths: distributionPaths });
    if (!distribution.installed || (sourceRoot !== undefined && path.resolve(sourceRoot) !== path.resolve(distribution.activeDirectory))) {
      throw new CompanionControlError("DISTRIBUTION_INVALID");
    }
    await validateLaunchAgentImpl(managedLaunchAgentOptions(paths));
    const installInventory = await inventoryInstallImpl({ installDirectory: paths.installDirectory });
    const backupInventory = await inventoryBackupsImpl({ backupDirectory: paths.backupDirectory, configPath: paths.configPath });
    await inventoryRuntimeImpl({ serviceDirectory: paths.serviceDirectory, sourceRoot: distribution.activeDirectory });
    await inventoryUsageImpl({ directory: path.join(distributionPaths.applicationDirectory, "usage") });
    const configOwnership = await inventoryConfigImpl({
      configPath: paths.configPath, statePath: paths.statePath,
      backupDirectory: paths.backupDirectory, backupDirectoryInventory: backupInventory,
    });
    const nativeRestorationReceipt = await inventoryNativeConfigImpl({
      configPath: paths.configPath, statePath: paths.statePath,
      backupDirectory: paths.backupDirectory, ownershipReceipt: configOwnership,
    });
    const providerIds = await listProviderIdsImpl({ registryPath: paths.keychainRegistryPath });
    return {
      status: "ready", canApply: true,
      previewToken: nativeUninstallPreviewToken({ distribution, nativeRestorationReceipt, installInventory, backupInventory, providerIds }),
      changes: [...COMPANION_UNINSTALL_CHANGES],
    };
  } catch (error) {
    throw nativeUninstallFailure(error, "UNINSTALL_PREFLIGHT_FAILED");
  }
}

export async function purgePickerMux({
  paths = resolveInstallPaths(),
  distributionPaths = resolveDistributionPaths(),
  force = false,
  restoreNative = false,
  expectedPreviewToken,
  sourceRoot,
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
  inventoryNativeConfigImpl = inventoryNativeConfigRestoration,
  revalidateNativeConfigImpl = revalidateNativeConfigRestoration,
  inventoryUsageImpl = inventoryUsageStore,
  revalidateUsageImpl = revalidateUsageStoreInventory,
  removeUsageImpl = removeUsageStoreInventory,
  listProviderIdsImpl = listRegisteredKeychainProviderIds,
  removeDistributionImpl = removeManagedDistribution,
  uninstallIntegrationImpl = uninstallIntegration,
  deleteCredentialImpl = deleteProviderCredential,
  purgeBackupsImpl = purgePickerMuxBackups,
  purgeRegistryImpl = purgeKeychainProviderRegistry,
  rmdirImpl = rmdir,
  assertNoPendingFullRefreshImpl = async () => null,
} = {}) {
  if (typeof restoreNative !== "boolean" || (restoreNative && force) ||
    (expectedPreviewToken !== undefined && (!restoreNative || !/^[a-f0-9]{64}$/u.test(expectedPreviewToken)))) {
    throw new CompanionControlError("UNINSTALL_CONFLICT");
  }
  await assertCodexDesktopClosed(desktopRunningImpl);
  const distribution = await validateDistributionImpl({
    paths: distributionPaths,
  });
  if (!distribution.installed) {
    throw new Error(
      "PickerMux full uninstall requires a receipt-validated CLI installation",
    );
  }
  if (sourceRoot !== undefined && path.resolve(sourceRoot) !== path.resolve(distribution.activeDirectory)) {
    throw new CompanionControlError("DISTRIBUTION_INVALID");
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
  const usageStoreInventory = await inventoryUsageImpl({
    directory: path.join(distributionPaths.applicationDirectory, "usage"),
  });
  const providerIds = await listProviderIdsImpl({
    registryPath: paths.keychainRegistryPath,
  });
  const nativeRestorationReceipt = restoreNative
    ? await inventoryNativeConfigImpl({
      configPath: paths.configPath, statePath: paths.statePath,
      backupDirectory: paths.backupDirectory, ownershipReceipt: configOwnership,
    })
    : undefined;
  if (restoreNative && expectedPreviewToken !== undefined && expectedPreviewToken !== nativeUninstallPreviewToken({
    distribution, nativeRestorationReceipt, installInventory, backupInventory, providerIds,
  })) throw new CompanionControlError("UNINSTALL_CONFLICT");
  if (restoreNative && expectedPreviewToken === undefined) nativeUninstallPreviewToken({
    distribution, nativeRestorationReceipt, installInventory, backupInventory, providerIds,
  });

  const result = await removeDistributionImpl({
    paths: distributionPaths,
    requireExclusiveApplicationDirectory: true,
    usageStoreInventory,
    async beforeRemove(confirmedDistribution) {
      await assertNoPendingFullRefreshImpl();
      assertSameDistributionOwnership(distribution, confirmedDistribution);
      await assertCodexDesktopClosed(desktopRunningImpl);
      await validateLaunchAgentImpl(managedLaunchAgentOptions(paths));
      await revalidateInstallImpl(installInventory);
      await revalidateBackupsImpl(backupInventory);
      await revalidateRuntimeImpl(runtimeInventory);
      await revalidateConfigImpl(configOwnership);
      await revalidateUsageImpl(usageStoreInventory, {
        directory: path.join(distributionPaths.applicationDirectory, "usage"),
      });
      if (restoreNative) await revalidateNativeConfigImpl(nativeRestorationReceipt);
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
              // Prove the exact native candidate again before the irreversible
              // Keychain phase, including when backups have been quarantined.
              if (restoreNative) {
                await assertNoPendingFullRefreshImpl();
                await assertCodexDesktopClosed(desktopRunningImpl);
                await revalidateNativeConfigImpl(nativeRestorationReceipt, { readBackupImpl: readBackup });
              }
              await revalidateUsageImpl(usageStoreInventory, {
                directory: path.join(distributionPaths.applicationDirectory, "usage"),
              });
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
                  restoreNative,
                  nativeRestorationReceipt,
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

      let usage;
      try {
        // Service shutdown has completed and flushed queued observations. The
        // original exact proof still owns cleanup; a late change needs review.
        usage = await removeUsageImpl(usageStoreInventory);
      } catch (cause) {
        const error = new Error(
          "PickerMux full uninstall could not verify usage cleanup; the CLI will be retained for recovery",
          { cause },
        );
        error.code = "PICKERMUX_PURGE_INCOMPLETE";
        throw error;
      }
      if (usage.cleanupPendingPath) {
        const error = new Error(
          `PickerMux full uninstall stopped with private cleanup pending at ${usage.cleanupPendingPath}; the CLI will be retained for recovery`,
        );
        error.code = "PICKERMUX_PURGE_INCOMPLETE";
        error.cleanupPendingPath = usage.cleanupPendingPath;
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
        usage,
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
    const error = new Error(
      `PickerMux full refresh is incomplete at ${checkpoint.phase}; rerun pickermux refresh --full to resume before another lifecycle change`,
    );
    error.code = "RECOVERY_PENDING";
    throw error;
  }
  return null;
}

export async function repairHistoricalChats({
  paths = resolveInstallPaths(),
  distributionPaths = resolveDistributionPaths(),
  withLockImpl = withInstallationLock,
  assertNoPendingFullRefreshImpl = assertNoPendingFullRefresh,
  desktopRunningImpl = isCodexDesktopRunning,
  repairConfigImpl = repairHistoricalChatsConfig,
} = {}) {
  return withLockImpl(distributionPaths, async () => {
    await assertNoPendingFullRefreshImpl();
    if (await desktopRunningImpl()) {
      throw new Error(
        "PickerMux chat repair requires Codex Desktop to be fully quit with Command-Q",
      );
    }
    return repairConfigImpl({
      configPath: paths.configPath,
      statePath: paths.statePath,
      backupDirectory: paths.backupDirectory,
    });
  });
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
  loadConfigImpl = () => loadCompanionServiceConfig({ paths }),
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
  loadConfigImpl = () => loadCompanionServiceConfig({ paths }),
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
  loadConfigImpl = (configPath) => path.resolve(configPath) === path.resolve(paths.serviceConfigPath)
    ? loadCompanionServiceConfig({ paths })
    : loadBridgeConfig(configPath),
  configStatusImpl = getConfigStatus,
  desktopRunningImpl = isCodexDesktopRunning,
  accountCacheImpl = inspectCodexAccountCache,
  repairConfigImpl = restoreRecoveredProviderEndMarker,
  discoverImpl = discoverBridgeModels,
  installImpl = install,
  refreshImpl = refresh,
  certifyInstallationImpl = certifyForInstallation,
  reactivationImpl = inventoryDeactivatedConfigReactivation,
  onProgress,
  integrationSwitchReceipt,
  configurationPreflightImpl = async () => {},
  assertNoPendingFullRefreshImpl = async () => null,
} = {}) {
  const initialStatus = await configStatusImpl({
    configPath: paths.configPath,
    statePath: paths.statePath,
  });
  if (initialStatus.healthy !== true) {
    const recovery = initialStatus.status === "modified"
      ? " Fully quit Codex, review ~/.codex/config.toml, privately save intentional edits, then use the receipt-active CLI to run 'pickermux uninstall --force' only if PickerMux's recorded configuration should be removed. Open Codex once without PickerMux to refresh its signed-in model cache, quit it with Command-Q, and rerun the latest PickerMux release installer."
      : " Run 'pickermux status' and 'pickermux doctor', then follow the state-specific recovery in docs/TROUBLESHOOTING.md before retrying setup.";
    throw new Error(
      `PickerMux setup refuses inconsistent integration state (${initialStatus.status ?? "unknown"}).${recovery}`,
    );
  }
  if (await desktopRunningImpl()) {
    throw new Error(
      "PickerMux setup requires Codex Desktop to be fully quit with Command-Q",
    );
  }
  if (!initialStatus.installed) {
    const preview = await previewConfigIntegration({ configPath: paths.configPath, statePath: paths.statePath });
    if (!preview.canApply || (["ollama", "foreign"].includes(preview.status) && !integrationSwitchReceipt)) throw new CompanionControlError("CONFIGURATION_CONFLICT");
  }
  await configurationPreflightImpl();
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
            await configurationPreflightImpl();
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
      const failure = new Error(
        `PickerMux setup stopped before activation because Codex ${error.codexClientVersion ?? "Desktop"} has no matching account model cache. ${stateResult} ${recovery}`,
        { cause: error },
      );
      failure.code = "CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED";
      throw failure;
    }
  };
  await assertAccountCacheReady({ allowMarkerRepair: true });
  const reactivationReceipt = initialStatus.status === "deactivated"
    ? await reactivationImpl({ configPath: paths.configPath, statePath: paths.statePath, backupDirectory: paths.backupDirectory })
    : undefined;
  const effectiveConfigPath = setupConfigPath
    ? path.resolve(setupConfigPath)
    : initialStatus.installed || initialStatus.status === "deactivated"
      ? paths.serviceConfigPath
      : path.join(path.resolve(sourceRoot), "lmstudio-picker.config.json");
  const preflightConfig = await loadConfigImpl(effectiveConfigPath);
  let discovery;
  try {
    discovery = await discoverImpl({ config: preflightConfig });
  } catch (error) {
    throw new CompanionControlError(classifyDiscoveryFailure(error) ?? "ACTION_FAILED");
  }
  if (!Array.isArray(discovery?.models) || discovery.models.length === 0) {
    throw new CompanionControlError(discovery?.providers?.some((provider) => provider.unavailableReason === "connection-refused")
      ? "PROVIDER_UNAVAILABLE" : "NO_LOADED_MODELS");
  }

  const assertActivationAllowed = async () => {
    await assertNoPendingFullRefreshImpl();
    await configurationPreflightImpl();
    const status = await configStatusImpl({ configPath: paths.configPath, statePath: paths.statePath });
    if (status.healthy !== true || status.installed !== initialStatus.installed || status.status !== initialStatus.status) throw new CompanionControlError("CONFIGURATION_CONFLICT");
    await assertAccountCacheReady();
    await assertNoPendingFullRefreshImpl();
    if (await desktopRunningImpl()) throw new CompanionControlError("CODEX_RUNNING");
  };
  let certification;
  let activatedConfig;
  const result = await setupImpl({
    sourceRoot,
    paths: distributionPaths,
    async beforeControlCommit() {
      await assertNoPendingFullRefreshImpl();
      await configurationPreflightImpl();
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
      await configurationPreflightImpl();
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
      activatedConfig = config;
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
        integrationSwitchReceipt,
        ...(reactivationReceipt ? { reactivationReceipt } : {}),
        beforeConfigCommit: assertActivationAllowed,
      });
      return { action: "install", integration: result };
    },
    async afterActivate({ distributionRoot }) {
      certification = await certifyInstallationImpl({
        config: activatedConfig,
        paths,
        codexPath,
        sourceRoot: distributionRoot,
        onProgress,
      }, { desktopRunningImpl });
    },
  });
  return { ...result, certification };
}

async function withCertificationProgress(operation) {
  const progress = createCertificationProgress();
  try {
    return await operation(progress.onProgress);
  } finally {
    progress.stop();
  }
}

export async function runPickerMuxCompanion(argv, {
  paths = resolveInstallPaths(),
  distributionPaths = resolveDistributionPaths(),
  fullRefreshPaths = resolveFullRefreshPaths(),
  codexPath = resolveCodexBinary(),
  sourceRoot = projectRoot,
  input = process.stdin,
  output = process.stdout,
  progressOutput = process.stderr,
  statusImpl = () => collectCompanionStatus({ probes: createCompanionReadOnlyProbes({ paths, distributionPaths, fullRefreshPaths, codexPath }) }),
  validateDistributionImpl = validateDistributionInstallation,
  withLockImpl = withInstallationLock,
  desktopRunningImpl = isCodexDesktopRunning,
  assertNoPendingFullRefreshImpl = () => assertNoPendingFullRefresh({ fullRefreshPaths }),
  previewUninstallImpl = previewPickerMuxUninstall,
  purgeUninstallImpl = purgePickerMux,
  handlers,
} = {}) {
  const configurationPaths = { configPath: paths.configPath, statePath: paths.statePath, backupDirectory: paths.backupDirectory };
  const noRecovery = assertNoPendingFullRefreshImpl;
  const closed = async () => {
    if (await desktopRunningImpl()) throw new CompanionControlError("CODEX_RUNNING");
  };
  const installedConfig = () => loadCompanionServiceConfig({ paths });
  const certificationProgress = (onProgress) => (event) => onProgress({ phase: "certifying", current: event.index, total: event.total, elapsedMs: event.elapsedMs });
  const defaults = {
    async refresh() {
      await noRecovery();
      await closed();
      const result = await refresh({ config: await installedConfig(), paths, codexPath, sourceRoot });
      return { restartRequired: result.restartRequired };
    },
    async open() {
      await noRecovery();
      return openCodexDesktop();
    },
    recover() {
      return scheduleFullRefresh({ paths, distributionPaths, fullRefreshPaths, codexPath, sourceRoot });
    },
    async certify(_request, { onProgress }) {
      await noRecovery();
      await closed();
      return certify({ config: await installedConfig(), paths, codexPath, sourceRoot, all: true, onProgress: certificationProgress(onProgress) });
    },
    async diagnose() {
      const config = await loadCompanionServiceConfig({ paths, allowMissing: true }) ?? await loadBridgeConfig(path.join(sourceRoot, "lmstudio-picker.config.json"));
      const result = await runBridgeDoctor({ config, paths, codexPath });
      if (!result.ok) throw new CompanionControlError("ACTION_FAILED");
      return {};
    },
    async "update-check"() {
      const metadata = await readPickerMuxMetadata(sourceRoot);
      const result = await checkForCompanionUpdate({ currentVersion: metadata.version });
      return { ...result, updateAvailable: result.status === "available" };
    },
    async update(_request, { onProgress }) {
      await noRecovery();
      await closed();
      const metadata = await readPickerMuxMetadata(sourceRoot);
      return applyCompanionUpdate({ currentVersion: metadata.version, onProgress });
    },
    async "integration-deactivate"() {
      await noRecovery();
      await closed();
      return deactivatePickerMuxIntegration({
        config: await installedConfig(), paths, sourceRoot,
        assertNoPendingFullRefreshImpl: noRecovery,
      });
    },
    async "usage-reset"() {
      const usage = await createUsageStore({
        directory: path.join(distributionPaths.applicationDirectory, "usage"),
      }).resetCumulative();
      if (usage.status !== "available" || !usage.resetAt) throw new CompanionControlError("ACTION_FAILED");
      return { status: "reset", resetAt: usage.resetAt, lastRequestPreserved: true };
    },
    "uninstall-preview"() {
      return previewUninstallImpl({ paths, distributionPaths, sourceRoot, desktopRunningImpl, assertNoPendingFullRefreshImpl: noRecovery });
    },
    async uninstall(request) {
      try {
        await noRecovery();
        await closed();
        const result = await purgeUninstallImpl({
          paths, distributionPaths, sourceRoot, restoreNative: true,
          desktopRunningImpl,
          expectedPreviewToken: request.previewToken, assertNoPendingFullRefreshImpl: noRecovery,
        });
        assertFullPurgeCompleted(result, paths.installDirectory, distributionPaths);
        if (result.beforeResult?.integration?.removedConfig?.nativeRestored !== true ||
          result.beforeResult?.integration?.removedConfig?.historicalCompatibility !== true) {
          throw new CompanionControlError("PURGE_INCOMPLETE");
        }
        return { status: "removed", removed: true, nativeRestored: true, historicalChatsPreserved: true, restartRequired: true };
      } catch (error) {
        throw nativeUninstallFailure(error);
      }
    },
    "configuration-preview"() {
      return previewConfigIntegration(configurationPaths);
    },
    async "configuration-apply"(request, { onProgress }) {
      const assertPreview = async () => {
        const preview = await previewConfigIntegration(configurationPaths);
        if (!preview.canApply || preview.previewToken !== request.previewToken) throw new CompanionControlError("CONFIGURATION_CONFLICT");
        return preview;
      };
      const preview = await assertPreview();
      const integrationSwitchReceipt = ["ollama", "foreign"].includes(preview.status)
        ? await inventoryConfigIntegrationSwitch({ ...configurationPaths, expectedPreviewToken: request.previewToken })
        : undefined;
      const result = await setupPickerMux({
        sourceRoot, paths, distributionPaths, codexPath,
        integrationSwitchReceipt,
        configurationPreflightImpl: assertPreview,
        assertNoPendingFullRefreshImpl: noRecovery,
        onProgress: certificationProgress(onProgress),
      });
      return { status: "applied", version: result.version, updated: true, restartRequired: true, certificationIncomplete: result.certification?.status === "incomplete" };
    },
  };
  return runCompanionCli(argv, {
    input, output, progressOutput, statusImpl,
    executeImpl: (request, { onProgress }) => executeCompanionAction(request, {
      statusImpl, validateDistributionImpl, sourceRoot, distributionPaths,
      withLockImpl, handlers: handlers ?? defaults, onProgress,
    }),
  });
}

export async function runCli(argv, {
  purgeImpl = purgePickerMux,
  repairHistoricalChatsImpl = repairHistoricalChats,
  scheduleFullRefreshImpl = scheduleFullRefresh,
  executeFullRefreshWorkerImpl = executeFullRefreshWorker,
  confirmFullRefreshImpl = confirmFullRefresh,
  assertNoPendingFullRefreshImpl = assertNoPendingFullRefresh,
  setupImpl = setupPickerMux,
  companionImpl = runPickerMuxCompanion,
  mlxImpl = runMlxCli,
} = {}) {
  if (argv[0] === "companion") return companionImpl(argv.slice(1));
  if (MLX_COMMANDS.has(argv[0])) return mlxImpl(argv);
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
      "repair-chats",
      "refresh",
      "setup",
      "uninstall",
    ]).has(options.command)
  ) {
    await assertNoPendingFullRefreshLocked();
  }
  if (options.command === "setup") {
    const result = await withCertificationProgress((onProgress) => setupImpl({
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
      onProgress,
    }));
    const certificationIncomplete = result.certification?.status === "incomplete";
    if (certificationIncomplete) process.exitCode = 1;
    if (options.json) printJson(result);
    else {
      process.stdout.write(
        certificationIncomplete
          ? `PickerMux ${result.version} installed (${result.activation.action}); model certification incomplete. Retry pickermux certify --all.\n`
          : `PickerMux ${result.version} setup completed (${result.activation.action}).\n`,
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
  if (options.command === "repair-chats") {
    const result = await repairHistoricalChatsImpl({
      paths,
      distributionPaths,
      assertNoPendingFullRefreshImpl: assertNoPendingFullRefreshLocked,
    });
    if (options.json) printJson(result);
    else {
      process.stdout.write(
        result.changed
          ? "Historical model_bridge chats can be reopened. Saved chat providers are unchanged.\n"
          : "Historical model_bridge chat compatibility is already present. Saved chat providers are unchanged.\n",
      );
      process.stdout.write(
        `This restores parsing compatibility only. Native provider recovery: ${HISTORICAL_CHAT_RECOVERY_DOC}\n`,
      );
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
        restoreNative: options.restoreNative,
        ...(options.restoreNative ? { sourceRoot: projectRoot } : {}),
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
            preserveHistoricalModelBridge: true,
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
            preserveHistoricalModelBridge: true,
            servicePackageInventory,
            sourceRoot: projectRoot,
          });
        },
      );
    }
    if (options.json) printJson(result);
    else {
      const historicalCompatibility = options.purge
        ? result.beforeResult?.integration?.removedConfig?.historicalCompatibility
        : options.removeCli
          ? result.beforeResult?.removedConfig?.historicalCompatibility
          : result.removedConfig?.historicalCompatibility;
      process.stdout.write(
        options.purge
          ? options.restoreNative
            ? "PickerMux runtime, receipt-validated CLI, verified backups, and registered provider credentials were removed. Codex uses native defaults; historical chats remain readable.\n"
            : historicalCompatibility
              ? "PickerMux integration, receipt-validated CLI, verified backups, and registered provider Keychain credentials were removed. An inert model_bridge compatibility table remains only so historical chats parse; new turns through it fail locally.\n"
              : "PickerMux integration, receipt-validated CLI, verified backups, and registered provider Keychain credentials were removed.\n"
          : options.removeCli
            ? "PickerMux routing and receipt-validated CLI removed; backups and Keychain credentials were preserved.\n"
            : result.removedConfig.changed
              ? "PickerMux routing removed; previous Codex configuration restored and managed runtime cleaned.\n"
              : "Managed bridge service and runtime artifacts were removed.\n",
      );
      if (!options.purge && historicalCompatibility) {
        process.stdout.write(
          "An inert model_bridge table remains so historical chats open; it cannot serve new turns.\n",
        );
      }
      process.stdout.write(
        `Fully quit and reopen Codex Desktop after removal. Changing the selected model may leave an existing chat on model_bridge.\nNative provider recovery: ${HISTORICAL_CHAT_RECOVERY_DOC}\n`,
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
    const result = await withCertificationProgress((onProgress) => withInstallationLock(
      distributionPaths,
      async () => {
        await assertNoPendingFullRefreshLocked();
        await assertCodexDesktopClosed(isCodexDesktopRunning);
        const installed = await install({ config, configPath, paths, codexPath });
        const certification = await certifyForInstallation({
          config, paths, codexPath, sourceRoot: projectRoot, onProgress,
        });
        const doctor = await runBridgeDoctor({ config, paths, codexPath });
        return { ...installed, certification, doctor };
      },
    ));
    if (result.certification.status === "incomplete" || !result.doctor.ok) process.exitCode = 1;
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
    const result = await withCertificationProgress((onProgress) => withInstallationLock(
      distributionPaths,
      async () => {
        await assertNoPendingFullRefreshLocked();
        return certify({
          config,
          paths,
          codexPath,
          model: options.model,
          all: options.all,
          onProgress,
        });
      },
    ));
    if (options.json) printJson(result);
    else {
      for (const modelId of result.recoveredPending ?? []) {
        process.stdout.write(
          `RECOVERED  pending certification: ${modelId}\n`,
        );
      }
      for (const entry of result.certified) {
        process.stdout.write(`PASS  certification: ${entry.model}\n`);
        if (entry.efficientFidelity !== "not-applicable") {
          process.stdout.write(
            entry.efficientFidelity === "enabled"
              ? `PASS  Efficient Fidelity: ${entry.model}\n`
              : `FALLBACK  Efficient Fidelity probe failed; Direct tools retained: ${entry.model}\n`,
          );
        }
      }
      process.stdout.write(
        result.certified.length > 0
          ? "Certified catalog published. Fully quit and reopen Codex Desktop.\n"
          : "Certification recovery completed. Fully quit and reopen Codex Desktop.\n",
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
