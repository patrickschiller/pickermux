import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { readInventoriedPickerMuxBackup } from "./purge-data.mjs";

const STATE_VERSION = 1;
const PRIVATE_READ_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const ownershipReceiptDetails = new WeakMap();
const integrationSwitchReceiptDetails = new WeakMap();
const reactivationReceiptDetails = new WeakMap();
const nativeRestorationReceiptDetails = new WeakMap();
const CONFIG_LAYOUT = "explicit-provider-v1";
const MANAGED_KEYS = [
  "model",
  "model_provider",
  "model_catalog_json",
  "model_reasoning_effort",
];
const INTEGRATION_KEYS = [...MANAGED_KEYS, "openai_base_url"];
const PICKER_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export const CONFIG_MARKERS = Object.freeze({
  rootBegin: "# >>> lm-studio-model-router:p2 root >>>",
  rootEnd: "# <<< lm-studio-model-router:p2 root <<<",
  providerBegin: "# >>> lm-studio-model-router:p2 provider >>>",
  providerEnd: "# <<< lm-studio-model-router:p2 provider <<<",
  webSearchBegin: "# >>> pickermux:standalone-web-search >>>",
  webSearchEnd: "# <<< pickermux:standalone-web-search <<<",
});

const HISTORICAL_MODEL_BRIDGE_PROVIDER_ID = "model_bridge";
const HISTORICAL_MODEL_BRIDGE_MARKER_NAMESPACE =
  "pickermux:historical-model-bridge";
const HISTORICAL_MODEL_BRIDGE_MARKERS = Object.freeze({
  begin: "# >>> pickermux:historical-model-bridge >>>",
  end: "# <<< pickermux:historical-model-bridge <<<",
});
const HISTORICAL_MODEL_BRIDGE_CONFIG_EXISTED_PREFIX =
  "# pickermux:historical-model-bridge-config-existed=";

const LEGACY_P1_MARKERS = Object.freeze([
  "# >>> lm-studio-model-router:p1 root >>>",
  "# <<< lm-studio-model-router:p1 root <<<",
  "# >>> lm-studio-model-router:p1 provider >>>",
  "# <<< lm-studio-model-router:p1 provider <<<",
]);

export class ConfigManagerError extends Error {
  constructor(code, message, details = undefined) {
    super(message, details?.cause === undefined ? undefined : { cause: details.cause });
    this.name = "ConfigManagerError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Install the managed Codex provider configuration in a reversible,
 * conflict-aware way.
 *
 * Required options:
 *   configPath, statePath, model, modelProvider, modelCatalogJson,
 *   provider: { name, baseUrl }
 */
export async function installConfig(options) {
  const settings = normalizeInstallOptions(options);
  const { configPath, statePath } = settings;

  const reactivation = reactivationReceiptDetails.get(options.reactivationReceipt);
  if (options.reactivationReceipt !== undefined &&
    (!reactivation || reactivation.settings.configPath !== configPath || reactivation.settings.statePath !== statePath || reactivation.settings.backupDirectory !== settings.backupDirectory)) {
    throw failure("REACTIVATION_RECEIPT_REQUIRED", "A verified suspended configuration receipt is required.");
  }
  if (reactivation) {
    await revalidateManagedConfigOwnership(reactivation.ownership);
    await readOwnershipBackup(reactivation.ownership);
    if (reactivation.state.suspension.kind === "integration-toggle-v1" && reactivation.state.providerBaseUrl !== settings.provider.baseUrl) {
      throw failure("STATE_PROVIDER_MISMATCH", "Intentional reactivation must preserve its private runtime identity.");
    }
    if (reactivation.state.providerId !== settings.provider.id) {
      throw failure("STATE_PROVIDER_MISMATCH", "Full-refresh reactivation must preserve the installed provider identity.");
    }
  } else if (await pathExists(statePath)) {
    throw failure(
      "ALREADY_INSTALLED",
      `State file already exists: ${statePath}`,
    );
  }

  const current = await readConfigFile(configPath);
  if (reactivation) assertSuspendedConfiguration(current, reactivation.state);
  const integration = inspectRootIntegration(current.text);
  const integrationSwitchReceipt = integrationSwitchReceiptDetails.get(options.integrationSwitchReceipt);
  if (integration.foreign) {
    if (!integrationSwitchReceipt || integrationSwitchReceipt.configPath !== configPath || integrationSwitchReceipt.statePath !== statePath) {
      throw failure("INTEGRATION_CONFLICT", "Another picker integration is active. Preview and explicitly confirm its replacement before installing PickerMux.");
    }
    if (integrationSwitchReceipt.previewToken !== integrationPreviewToken(current, configPath, statePath)) {
      throw failure("INTEGRATION_PREVIEW_CHANGED", "Codex configuration changed after the integration switch was confirmed.");
    }
  } else if (options.integrationSwitchReceipt !== undefined) {
    throw failure("INTEGRATION_PREVIEW_CHANGED", "The confirmed picker integration is no longer active.");
  }
  const priorConfig = reactivation?.state.suspension.kind === "integration-toggle-v1"
    ? removeDeactivatedHistoricalCompatibility(current.text, reactivation.state)
    : removeHistoricalModelBridgeCompatibility(current.text, settings.provider.id);
  const sourceBytes = priorConfig.removed
    ? Buffer.from(priorConfig.text, "utf8")
    : current.bytes;
  const configExisted = reactivation
    ? reactivation.state.configExisted
    : priorConfig.configExisted ?? current.exists;
  assertNoManagedMarkers(current.text);

  const analysis = analyzeConfig(priorConfig.text, settings.provider.id, {
    includeGateway: integration.foreign,
  });
  assertNoHistoricalModelBridgeMarkerComments(priorConfig.text);
  const eol = analysis.eol;
  const rootBlock = renderRootBlock(settings, eol);
  const providerBlock = renderProviderBlock(settings.provider, eol);
  const baseText = installBlocks(
    analysis,
    rootBlock,
    providerBlock,
    eol,
  );
  const webSearch = settings.provider.supportsStandaloneWebSearch
    ? addStandaloneWebSearchFeature(baseText)
    : { text: baseText };
  const installedText = webSearch.text;

  const backupPath = reactivation
    ? reactivation.state.backupPath
    : await allocateBackupPath(configPath, settings.backupDirectory, settings.now);
  if (!reactivation) await writeExactBackup(backupPath, sourceBytes, current.mode);

  const state = {
    version: STATE_VERSION,
    installedAt: settings.now.toISOString(),
    configPath,
    configExisted,
    configMode: reactivation ? reactivation.state.configMode : current.mode,
    backupPath,
    providerId: settings.provider.id,
    providerName: settings.provider.name,
    providerBaseUrl: settings.provider.baseUrl,
    model: settings.model,
    modelReasoningEffort: settings.modelReasoningEffort,
    catalog: settings.modelCatalogJson,
    sourceSha256: reactivation ? reactivation.state.sourceSha256 : sha256(sourceBytes),
    installedSha256: sha256(installedText),
    metadataPreservation: {
      mode: true,
      extendedAttributes: false,
    },
    priorAssignments: reactivation ? reactivation.state.priorAssignments :
      analysis.assignments.map(({ key, raw, eol: lineEol }) => ({ key, raw, eol: lineEol })),
    blocks: {
      root: {
        begin: CONFIG_MARKERS.rootBegin,
        end: CONFIG_MARKERS.rootEnd,
        sha256: sha256(rootBlock),
      },
      provider: {
        begin: CONFIG_MARKERS.providerBegin,
        end: CONFIG_MARKERS.providerEnd,
        sha256: sha256(providerBlock),
      },
      ...(webSearch.block ? { webSearch: webSearch.block } : {}),
    },
  };
  if (reactivation && !reactivation.state.suspension.pristine) {
    delete state.installedSha256;
  }
  const expectedState = reactivation
    ? { exists: true, sha256: reactivation.stateFile.sha256 }
    : { exists: false, sha256: sha256("") };
  const nextStateBytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);

  let configWritten = false;
  try {
    await atomicWrite(configPath, installedText, current.mode, {
      expectedSource: snapshotOf(current),
      beforeCommit: async () => {
        if (settings.beforeConfigCommit) await settings.beforeConfigCommit();
        if (reactivation) await revalidateManagedConfigOwnership(reactivation.ownership);
        await assertSourceUnchanged(statePath, expectedState);
      },
    });
    configWritten = true;
    await ensurePrivateDirectory(dirname(statePath));
    await atomicWrite(statePath, nextStateBytes, 0o600, {
      expectedSource: expectedState,
    });
    await chmod(statePath, 0o600);
  } catch (error) {
    if (configWritten) {
      try {
        await atomicWrite(configPath, current.bytes, current.mode, {
          expectedSource: {
            exists: true,
            sha256: sha256(installedText),
          },
        });
      } catch {
        // Preserve the original failure. The exact backup path is included below.
      }
    }
    if (error?.code === "CONFIG_CHANGED_CONCURRENTLY") {
      error.details = { ...(error.details ?? {}), backupPath };
      throw error;
    }
    throw failure(
      "INSTALL_FAILED",
      `Could not install managed Codex configuration. Exact backup: ${backupPath}`,
      { cause: error, backupPath },
    );
  }

  let reactivationActive = true;
  return {
    changed: true,
    installed: true,
    configPath,
    statePath,
    backupPath,
    model: settings.model,
    provider: settings.provider.id,
    catalog: settings.modelCatalogJson,
    providerId: settings.provider.id,
    metadataPreservation: state.metadataPreservation,
    warnings: [
      "File mode is preserved; extended attributes are not preserved by the dependency-free atomic writer.",
    ],
    ...(reactivation ? {
      async rollback() {
        if (!reactivationActive) return;
        const rollbackOwnership = await inventoryManagedConfigOwnership(settings);
        await readOwnershipBackup(rollbackOwnership);
        await writeManagedConfigPair(settings, current.mode, {
          config: Buffer.from(installedText),
          state: nextStateBytes,
        }, {
          config: current.bytes,
          state: reactivation.stateFile.contents,
        }, async () => {
          await revalidateManagedConfigOwnership(rollbackOwnership);
          await readOwnershipBackup(reactivation.ownership, { cache: false });
        }, "CONFIG_REACTIVATION_ROLLBACK_FAILED");
        reactivationActive = false;
      },
    } : {}),
  };
}

/**
 * Change only the two picker-owned mutable values inside an otherwise healthy
 * managed installation. Expected values provide a second CAS guard for a
 * picker change that happens after the caller inspected the configuration.
 */
export async function setManagedPickerSelection(options = {}) {
  const {
    configPath,
    statePath,
    beforeConfigCommit,
  } = normalizePathOptions(options);
  const model = options.model;
  const modelReasoningEffort = options.modelReasoningEffort;
  requireNonEmptyString(model, "model");
  if (!PICKER_REASONING_EFFORTS.has(modelReasoningEffort)) {
    throw failure(
      "INVALID_REASONING_EFFORT",
      "modelReasoningEffort must be one of: none, minimal, low, medium, high, xhigh, max, or ultra.",
    );
  }

  const expectedPairProvided =
    options.expectedModel !== undefined ||
    options.expectedModelReasoningEffort !== undefined;
  if (
    expectedPairProvided &&
    (typeof options.expectedModel !== "string" ||
      typeof options.expectedModelReasoningEffort !== "string")
  ) {
    throw failure(
      "INVALID_ARGUMENT",
      "expectedModel and expectedModelReasoningEffort must be supplied together.",
    );
  }

  const state = await readState(statePath, { allowMissing: true });
  if (!state) {
    throw failure(
      "STATE_MISSING",
      `Managed picker state does not exist: ${statePath}`,
    );
  }
  assertStateMatchesConfig(state, configPath);
  if (
    options.expectedInstallModel !== undefined &&
    state.model !== options.expectedInstallModel
  ) {
    throw failure(
      "INSTALL_DEFAULT_MISMATCH",
      `Managed install default model differs from ${options.expectedInstallModel}.`,
    );
  }
  if (
    options.expectedInstallModelReasoningEffort !== undefined &&
    state.modelReasoningEffort !== options.expectedInstallModelReasoningEffort
  ) {
    throw failure(
      "INSTALL_DEFAULT_MISMATCH",
      `Managed install default reasoning effort differs from ${options.expectedInstallModelReasoningEffort}.`,
    );
  }

  const current = await readConfigFile(configPath, { mustExist: true });
  const located = locateOwnedBlocks(current.text, state);
  const pickerRoot = inspectPickerMutableRoot(located.root, state, current.text);
  const modified = [];
  if (!pickerRoot.safe) modified.push("root");
  if (sha256(located.provider.text) !== state.blocks.provider.sha256) {
    modified.push("provider");
  }
  if (located.webSearch && sha256(located.webSearch.text) !== state.blocks.webSearch.sha256) {
    modified.push("webSearch");
  }
  if (!hasSafeProviderScopeTail(current.text, located.provider.end)) {
    modified.push("provider-scope-tail");
  }
  if (modified.length > 0) {
    throw failure(
      "MANAGED_BLOCK_MODIFIED",
      `Refusing picker update because managed block(s) were edited: ${modified.join(", ")}`,
      { modified },
    );
  }
  if (
    expectedPairProvided &&
    (pickerRoot.model !== options.expectedModel ||
      pickerRoot.modelReasoningEffort !== options.expectedModelReasoningEffort)
  ) {
    throw failure(
      "SELECTION_CHANGED_CONCURRENTLY",
      "Refusing to replace a picker selection that changed after inspection.",
      {
        expected: {
          model: options.expectedModel,
          modelReasoningEffort: options.expectedModelReasoningEffort,
        },
        actual: {
          model: pickerRoot.model,
          modelReasoningEffort: pickerRoot.modelReasoningEffort,
        },
      },
    );
  }
  if (
    pickerRoot.model === model &&
    pickerRoot.modelReasoningEffort === modelReasoningEffort
  ) {
    return {
      changed: false,
      configPath,
      statePath,
      model,
      modelReasoningEffort,
      previousModel: model,
      previousModelReasoningEffort: modelReasoningEffort,
    };
  }

  const replacement = renderPickerSelectionRoot(
    located.root,
    model,
    modelReasoningEffort,
  );
  const updatedText =
    current.text.slice(0, located.root.start) +
    replacement +
    current.text.slice(located.root.end);
  await atomicWrite(configPath, updatedText, current.mode, {
    expectedSource: snapshotOf(current),
    beforeCommit: beforeConfigCommit,
  });
  return {
    changed: true,
    configPath,
    statePath,
    model,
    modelReasoningEffort,
    previousModel: pickerRoot.model,
    previousModelReasoningEffort: pickerRoot.modelReasoningEffort,
  };
}

/** Restore the immutable defaults recorded when the managed picker was installed. */
export async function restoreManagedPickerDefaults(options = {}) {
  requireNonEmptyString(options.defaultModel, "defaultModel");
  if (!PICKER_REASONING_EFFORTS.has(options.defaultModelReasoningEffort)) {
    throw failure(
      "INVALID_REASONING_EFFORT",
      "defaultModelReasoningEffort is not a supported picker effort.",
    );
  }
  return setManagedPickerSelection({
    ...options,
    model: options.defaultModel,
    modelReasoningEffort: options.defaultModelReasoningEffort,
    expectedInstallModel: options.defaultModel,
    expectedInstallModelReasoningEffort: options.defaultModelReasoningEffort,
  });
}

/** Read-only, redacted preview. A token binds confirmation to the inspected bytes. */
export async function previewConfigIntegration(options = {}) {
  const settings = normalizePathOptions(options);
  try {
    const current = await readConfigFile(settings.configPath);
    const stateFile = await readOwnedRegularFile(settings.statePath, {
      allowMissing: true,
      requirePrivate: true,
      label: "PickerMux configuration state",
    });
    const previewToken = integrationPreviewToken(
      current,
      settings.configPath,
      settings.statePath,
      stateFile?.contents,
    );
    if (stateFile) {
      const state = parseState(stateFile.contents, settings.statePath);
      assertStateMatchesConfig(state, settings.configPath);
      if (state.suspension) {
        assertSuspendedConfiguration(current, state);
        if (state.suspension.kind !== "integration-toggle-v1") return integrationPreview("conflict", false, false, [], previewToken);
        return integrationPreview("none", true, true, ["reactivate-integration", "retain-explicit-provider", "preserve-historical-chats"], previewToken);
      }
      const located = locateHealthyManagedBlocks(current.text, state);
      const canonical = canonicalProviderBlock(located.provider, state);
      // A second gateway alongside an active owned provider has ambiguous
      // ownership. Migration cannot adopt or remove that user-owned setting.
      if (inspectRootIntegration(current.text).gateway) {
        return integrationPreview("conflict", false, false, [], previewToken);
      }
      const changes = canonical !== located.provider.text || located.provider.recoveredEnd
        ? ["normalize-owned-blocks", "retain-explicit-provider"]
        : [];
      return integrationPreview("pickermux", true, false, changes, previewToken);
    }
    if (containsAnyManagedMarker(current.text)) {
      return integrationPreview("conflict", false, false, [], previewToken);
    }
    const integration = inspectRootIntegration(current.text);
    const providerId = options.modelProvider ?? HISTORICAL_MODEL_BRIDGE_PROVIDER_ID;
    requireNonEmptyString(providerId, "modelProvider");
    const historical = removeHistoricalModelBridgeCompatibility(current.text, providerId);
    analyzeConfig(historical.text, providerId, { includeGateway: integration.foreign });
    assertNoHistoricalModelBridgeMarkerComments(historical.text);
    const changes = [
      "replace-integration",
      "preserve-user-settings",
      "create-backup",
      "restore-on-failure",
      "retain-explicit-provider",
      ...(historical.removed ? ["preserve-historical-chats"] : []),
    ];
    return integrationPreview(
      integration.foreign ? integration.ollama ? "ollama" : "foreign" : "none",
      true,
      integration.foreign,
      changes,
      previewToken,
    );
  } catch {
    // Diagnostics may contain private paths or config values. GUI callers
    // receive only the conflict projection and can separately run doctor.
    return integrationPreview("conflict", false, false, [], sha256("unavailable-integration-preview"));
  }
}

/** Issued only after confirmation; never accept a deserialized or forged receipt. */
export async function inventoryConfigIntegrationSwitch(options = {}) {
  const settings = normalizePathOptions(options);
  requirePreviewToken(options.expectedPreviewToken);
  const preview = await previewConfigIntegration(options);
  if (!preview.canApply || !["ollama", "foreign"].includes(preview.status)) {
    throw failure("INTEGRATION_CONFLICT", "The active picker integration cannot be safely replaced.");
  }
  if (preview.previewToken !== options.expectedPreviewToken) {
    throw failure("INTEGRATION_PREVIEW_CHANGED", "Codex configuration changed after the integration preview.");
  }
  const receipt = Object.freeze({});
  integrationSwitchReceiptDetails.set(receipt, {
    configPath: settings.configPath,
    statePath: settings.statePath,
    previewToken: preview.previewToken,
  });
  return receipt;
}

/** Keep the original ownership receipt while exposing a native-only root. */
export async function suspendManagedConfiguration(options = {}) {
  return suspendConfiguration(options, "full-refresh-v1");
}

/** Pause without discarding setup or the exact historical provider identity. */
export async function deactivateManagedConfiguration(options = {}) {
  return suspendConfiguration(options, "integration-toggle-v1");
}

async function suspendConfiguration(options, kind) {
  const settings = normalizeOwnershipOptions(options);
  const ownership = options.ownershipReceipt ?? await inventoryManagedConfigOwnership(settings);
  const details = ownershipDetails(ownership, settings);
  await revalidateManagedConfigOwnership(ownership);
  if (!details.stateFile) throw failure("STATE_MISSING", "Full-refresh suspension requires an installed configuration.");
  const state = parseState(details.stateFile.contents, settings.statePath);
  assertStateMatchesConfig(state, settings.configPath);
  const current = await readConfigFile(settings.configPath, { mustExist: true });
  if (state.suspension) {
    assertSuspendedConfiguration(current, state);
    if (state.suspension.kind !== kind) throw failure("CONFIGURATION_SUSPENDED", "The integration is suspended by another lifecycle operation.");
    return { changed: false, suspended: true };
  }
  if (kind === "integration-toggle-v1" && state.providerId !== HISTORICAL_MODEL_BRIDGE_PROVIDER_ID) {
    throw failure("INTEGRATION_CONFLICT", "Deactivation requires the exact historical model_bridge provider identity.");
  }
  const located = locateHealthyManagedBlocks(current.text, state);
  if (inspectRootIntegration(current.text).gateway !== undefined) {
    throw failure("INTEGRATION_CONFLICT", "Full refresh cannot suspend a user-owned OpenAI gateway alongside PickerMux.");
  }
  await readOwnershipBackup(ownership);
  const pickerRoot = inspectPickerMutableRoot(located.root, state, current.text);
  const replacements = ownedBlockNames(state)
    .map((name) => ({ ...located[name], replacement: name === "root" ? pickerRoot.retainedText : "" }))
    .sort((left, right) => right.start - left.start);
  let suspendedText = current.text;
  for (const block of replacements) {
    suspendedText = suspendedText.slice(0, block.start) + block.replacement + suspendedText.slice(block.end);
  }
  const native = inspectRootIntegration(suspendedText);
  if (native.foreign || containsAnyManagedMarker(suspendedText)) {
    throw failure("INTEGRATION_CONFLICT", "Full refresh could not prove a native-only configuration root.");
  }
  if (kind === "integration-toggle-v1") {
    if (hasProviderDefinition(suspendedText, HISTORICAL_MODEL_BRIDGE_PROVIDER_ID)) throw failure("HISTORICAL_PROVIDER_CONFLICT", "A historical provider already exists outside the owned block.");
    assertNoHistoricalModelBridgeMarkerComments(suspendedText);
    suspendedText = appendHistoricalModelBridgeCompatibility(suspendedText, state.configExisted);
  }
  const pristineCandidate = located.provider.recoveredEnd
    ? current.text.slice(0, located.provider.start) + located.provider.text + current.text.slice(located.provider.end)
    : current.bytes;
  const updated = {
    ...state,
    suspension: {
      kind,
      configSha256: sha256(suspendedText),
      pristine: sha256(pristineCandidate) === state.installedSha256,
    },
  };
  const before = { config: current.bytes, state: details.stateFile.contents };
  const after = {
    config: Buffer.from(suspendedText),
    state: Buffer.from(`${JSON.stringify(updated, null, 2)}\n`),
  };
  await writeManagedConfigPair(settings, current.mode, before, after, async () => {
    if (settings.beforeConfigCommit) await settings.beforeConfigCommit();
    await revalidateManagedConfigOwnership(ownership);
  }, "CONFIG_SUSPENSION_ROLLBACK_FAILED");
  let active = true;
  return {
    changed: true,
    suspended: true,
    async rollback() {
      if (!active) return;
      await writeManagedConfigPair(settings, current.mode, after, before, undefined, "CONFIG_SUSPENSION_ROLLBACK_FAILED");
      active = false;
    },
  };
}

/** Resume only a private, unchanged native suspension created by this module. */
export async function inventoryManagedConfigReactivation(options = {}) {
  return inventoryConfigurationReactivation(options, "full-refresh-v1");
}

export async function inventoryDeactivatedConfigReactivation(options = {}) {
  return inventoryConfigurationReactivation(options, "integration-toggle-v1");
}

async function inventoryConfigurationReactivation(options, kind) {
  const settings = normalizeOwnershipOptions(options);
  const ownership = await inventoryManagedConfigOwnership(settings);
  await revalidateManagedConfigOwnership(ownership);
  const stateFile = ownershipDetails(ownership, settings).stateFile;
  if (!stateFile) throw failure("STATE_MISSING", "Full-refresh reactivation requires its retained configuration receipt.");
  const state = parseState(stateFile.contents, settings.statePath);
  const current = await readConfigFile(settings.configPath, { mustExist: true });
  assertSuspendedConfiguration(current, state);
  if (state.suspension.kind !== kind) throw failure("CONFIGURATION_SUSPENDED", "The integration is suspended by another lifecycle operation.");
  if (options.expectedPreviewToken !== undefined) {
    requirePreviewToken(options.expectedPreviewToken);
    if (options.expectedPreviewToken !== integrationPreviewToken(current, settings.configPath, settings.statePath, stateFile.contents)) {
      throw failure("INTEGRATION_PREVIEW_CHANGED", "Codex configuration changed after the reactivation preview.");
    }
  }
  await readOwnershipBackup(ownership);
  const receipt = Object.freeze({});
  reactivationReceiptDetails.set(receipt, { settings, ownership, state, stateFile });
  return receipt;
}

/** Canonicalize an unchanged receipt-owned provider without replacing the backup. */
export async function migrateManagedConfiguration(options = {}) {
  const settings = normalizeOwnershipOptions(options);
  if (options.expectedPreviewToken !== undefined) requirePreviewToken(options.expectedPreviewToken);
  const ownership = await inventoryManagedConfigOwnership(settings);
  await revalidateManagedConfigOwnership(ownership);
  const stateFile = ownershipDetails(ownership, settings).stateFile;
  if (!stateFile) throw failure("STATE_MISSING", "Configuration migration requires an installed PickerMux configuration.");
  const state = parseState(stateFile.contents, settings.statePath);
  assertStateMatchesConfig(state, settings.configPath);
  if (state.suspension) throw failure("CONFIGURATION_SUSPENDED", "Resume full refresh before migrating managed configuration.");
  const current = await readConfigFile(settings.configPath, { mustExist: true });
  if (options.expectedPreviewToken !== undefined &&
    options.expectedPreviewToken !== integrationPreviewToken(current, settings.configPath, settings.statePath, stateFile.contents)) {
    throw failure("INTEGRATION_PREVIEW_CHANGED", "Codex configuration changed after the migration preview.");
  }
  const located = locateHealthyManagedBlocks(current.text, state);
  if (inspectRootIntegration(current.text).gateway) {
    throw failure("INTEGRATION_CONFLICT", "A user-owned OpenAI gateway conflicts with the managed provider. Review the configuration before migrating.");
  }
  const providerText = canonicalProviderBlock(located.provider, state);
  const updatedText = current.text.slice(0, located.provider.start) + providerText + current.text.slice(located.provider.end);
  if (updatedText === current.text) return { changed: false, layout: CONFIG_LAYOUT };
  const updated = {
    ...state,
    blocks: {
      ...state.blocks,
      provider: { ...state.blocks.provider, sha256: sha256(providerText) },
    },
  };
  const pristineCandidate = located.provider.recoveredEnd
    ? current.text.slice(0, located.provider.start) + located.provider.text + current.text.slice(located.provider.end)
    : current.bytes;
  if (sha256(pristineCandidate) === state.installedSha256) {
    updated.installedSha256 = sha256(updatedText);
  } else {
    delete updated.installedSha256;
  }
  const before = { config: current.bytes, state: stateFile.contents };
  const after = {
    config: Buffer.from(updatedText),
    state: Buffer.from(`${JSON.stringify(updated, null, 2)}\n`),
  };
  await writeManagedConfigPair(settings, current.mode, before, after, async () => {
    if (settings.beforeConfigCommit) await settings.beforeConfigCommit();
    await revalidateManagedConfigOwnership(ownership);
  }, "CONFIG_MIGRATION_ROLLBACK_FAILED");
  let active = true;
  return {
    changed: true,
    layout: CONFIG_LAYOUT,
    async rollback() {
      if (!active) return;
      await writeManagedConfigPair(settings, current.mode, after, before, undefined, "CONFIG_MIGRATION_ROLLBACK_FAILED");
      active = false;
    },
  };
}

/** Upgrade only receipt-owned search settings, retaining the original backup. */
export async function enableManagedStandaloneWebSearch(options = {}) {
  const settings = normalizeOwnershipOptions(options);
  const ownership = await inventoryManagedConfigOwnership(settings);
  await revalidateManagedConfigOwnership(ownership);
  const stateFile = ownershipDetails(ownership, settings).stateFile;
  if (!stateFile) throw failure("STATE_MISSING", "Managed search settings require an installed configuration.");
  const state = parseState(stateFile.contents, settings.statePath);
  assertStateMatchesConfig(state, settings.configPath);
  const current = await readConfigFile(settings.configPath, { mustExist: true });
  const located = locateOwnedBlocks(current.text, state);
  const pickerRoot = inspectPickerMutableRoot(located.root, state, current.text);
  for (const name of ownedBlockNames(state)) {
    if (sha256(located[name].text) !== state.blocks[name].sha256 && !(name === "root" && pickerRoot.safe)) {
      throw failure("MANAGED_BLOCK_MODIFIED", "Refusing to change modified managed search settings.");
    }
  }
  if (!hasSafeProviderScopeTail(current.text, located.provider.end)) {
    throw failure("MANAGED_BLOCK_MODIFIED", "Managed provider table scope changed.");
  }
  const matching = [...located.provider.text.matchAll(/^supports_standalone_web_search = (?:true|false)\r?$/gmu)];
  if (matching.length !== 1) {
    throw failure("WEB_SEARCH_CONFIG_CONFLICT", "Managed provider search capability is missing or ambiguous.");
  }
  const providerText = located.provider.text.replace(
    /^supports_standalone_web_search = false(?=\r?$)/gmu,
    "supports_standalone_web_search = true",
  );
  const projected = current.text.slice(0, located.provider.start) + providerText + current.text.slice(located.provider.end);
  const webSearch = addStandaloneWebSearchFeature(projected);
  if (webSearch.text === current.text) {
    return { changed: false, enabled: webSearch.enabled };
  }
  const updated = {
    ...state,
    blocks: {
      ...state.blocks,
      provider: { ...state.blocks.provider, sha256: sha256(providerText) },
      ...(webSearch.block ? { webSearch: webSearch.block } : {}),
    },
  };
  // A pre-existing user edit must never become a new pristine baseline, since
  // uninstall would then replace it with the original installation backup.
  const originalWithRecoveredMarker = located.provider.recoveredEnd
    ? current.text.slice(0, located.provider.start) + located.provider.text + current.text.slice(located.provider.end)
    : current.bytes;
  if (sha256(originalWithRecoveredMarker) === state.installedSha256) {
    updated.installedSha256 = sha256(webSearch.text);
  } else {
    delete updated.installedSha256;
  }
  const nextState = Buffer.from(`${JSON.stringify(updated, null, 2)}\n`);
  const before = { config: current.bytes, state: stateFile.contents };
  const after = { config: Buffer.from(webSearch.text), state: nextState };
  await writeManagedConfigPair(settings, current.mode, before, after, async () => {
    if (settings.beforeConfigCommit) await settings.beforeConfigCommit();
    await revalidateManagedConfigOwnership(ownership);
  });
  let active = true;
  return {
    changed: true,
    enabled: webSearch.enabled,
    async rollback() {
      if (!active) return;
      await writeManagedConfigPair(settings, current.mode, after, before);
      active = false;
    },
  };
}

async function writeManagedConfigPair(settings, configMode, before, after, beforeCommit, rollbackCode = "WEB_SEARCH_CONFIG_ROLLBACK_FAILED") {
  const previousConfig = { exists: true, sha256: sha256(before.config) };
  const previousState = { exists: true, sha256: sha256(before.state) };
  const nextConfig = { exists: true, sha256: sha256(after.config) };
  await atomicWrite(settings.configPath, after.config, configMode, {
    expectedSource: previousConfig,
    beforeCommit: async () => {
      if (beforeCommit) await beforeCommit();
      await assertSourceUnchanged(settings.statePath, previousState);
    },
  });
  try {
    await atomicWrite(settings.statePath, after.state, 0o600, {
      expectedSource: previousState,
      beforeCommit: () => assertSourceUnchanged(settings.configPath, nextConfig),
    });
  } catch (error) {
    try {
      await atomicWrite(settings.configPath, before.config, configMode, { expectedSource: nextConfig });
    } catch (rollbackError) {
      throw failure(rollbackCode, "Managed settings could not be rolled back after a concurrent change.", {
        cause: new AggregateError([error, rollbackError]),
      });
    }
    throw error;
  }
}

/**
 * Capture the exact managed state file that authorizes a later uninstall.
 * The opaque receipt is bound to the state inode/hash and, when supplied, to
 * the backup inventory already issued by purge-data.mjs.
 */
export async function inventoryManagedConfigOwnership(options = {}) {
  const settings = normalizeOwnershipOptions(options);
  const stateFile = await readOwnedRegularFile(settings.statePath, {
    allowMissing: true,
    requirePrivate: true,
    label: "PickerMux configuration state",
  });
  let state = null;
  if (stateFile) {
    state = parseState(stateFile.contents, settings.statePath);
    assertStateMatchesConfig(state, settings.configPath);
    assertManagedBackupPath(state.backupPath, settings);
  }

  const receipt = Object.freeze({
    configPath: settings.configPath,
    statePath: settings.statePath,
    backupDirectory: settings.backupDirectory,
    exists: stateFile !== null,
  });
  ownershipReceiptDetails.set(receipt, {
    settings,
    state,
    stateFile,
    backupFile: null,
    backupDirectoryInventory: options.backupDirectoryInventory,
    readBackupImpl: options.readBackupImpl,
  });
  if (stateFile && options.backupDirectoryInventory) {
    await readOwnershipBackup(receipt);
  }
  return receipt;
}

export async function revalidateManagedConfigOwnership(
  receipt,
  { readBackupImpl = undefined } = {},
) {
  const details = ownershipDetails(receipt);
  if (readBackupImpl !== undefined) {
    if (typeof readBackupImpl !== "function") {
      throw new TypeError("readBackupImpl must be a function");
    }
    details.readBackupImpl = readBackupImpl;
  }
  if (details.stateFile === null) {
    if (await lstatOptional(details.settings.statePath)) {
      throw failure(
        "STATE_CHANGED_CONCURRENTLY",
        "Managed configuration state appeared after ownership inventory.",
      );
    }
    return receipt;
  }
  const currentState = await readOwnedRegularFile(details.settings.statePath, {
    allowMissing: true,
    requirePrivate: true,
    label: "PickerMux configuration state",
    expectedSnapshot: details.stateFile.snapshot,
  });
  if (
    currentState === null ||
    !sameFileSnapshot(details.stateFile.snapshot, currentState.snapshot) ||
    details.stateFile.sha256 !== currentState.sha256
  ) {
    throw failure(
      "STATE_CHANGED_CONCURRENTLY",
      "Managed configuration state changed after ownership inventory.",
    );
  }
  if (details.backupFile) {
    const currentBackup = await readOwnershipBackup(receipt, {
      cache: false,
    });
    if (
      !sameFileSnapshot(
        details.backupFile.snapshot,
        currentBackup.snapshot,
      ) ||
      details.backupFile.sha256 !== currentBackup.sha256
    ) {
      throw failure(
        "BACKUP_CHANGED_CONCURRENTLY",
        "Managed configuration backup changed after ownership inventory.",
      );
    }
  }
  return receipt;
}

/**
 * Remove only the blocks owned by this manager and restore prior root
 * assignments. A second uninstall is a safe no-op when no managed markers are
 * left. Pass force=true only to remove blocks whose contents were edited while
 * both boundary markers remain intact.
 */
export async function uninstallConfig(options) {
  if (options.restoreNative !== undefined && typeof options.restoreNative !== "boolean") {
    throw new TypeError("restoreNative must be a boolean");
  }
  if (options.restoreNative === true) return uninstallNativeConfig(options);
  const {
    configPath,
    statePath,
    backupDirectory,
    force = false,
    beforeConfigCommit,
  } = normalizeOwnershipOptions(options);
  if (
    options.preserveHistoricalModelBridge !== undefined &&
    typeof options.preserveHistoricalModelBridge !== "boolean"
  ) {
    throw new TypeError("preserveHistoricalModelBridge must be a boolean");
  }
  const ownershipReceipt = options.ownershipReceipt ??
    await inventoryManagedConfigOwnership({
      configPath,
      statePath,
      backupDirectory,
      backupDirectoryInventory: options.backupDirectoryInventory,
      readBackupImpl: options.readBackupImpl,
    });
  const ownership = ownershipDetails(ownershipReceipt, {
    configPath,
    statePath,
    backupDirectory,
  });
  await revalidateManagedConfigOwnership(ownershipReceipt, {
    readBackupImpl: options.readBackupImpl,
  });
  const stateResult = ownership.state;

  if (!stateResult) {
    const current = await readConfigFile(configPath);
    if (containsAnyManagedMarker(current.text)) {
      throw failure(
        "ORPHANED_MANAGED_BLOCK",
        "Managed markers exist, but the installation state file is missing.",
      );
    }
    if (options.preserveHistoricalModelBridge === true) {
      const historical = removeHistoricalModelBridgeCompatibility(
        current.text,
        HISTORICAL_MODEL_BRIDGE_PROVIDER_ID,
      );
      if (
        hasProviderDefinition(
          historical.text,
          HISTORICAL_MODEL_BRIDGE_PROVIDER_ID,
        )
      ) {
        throw failure(
          "HISTORICAL_PROVIDER_CONFLICT",
          "Refusing to replace an existing model_bridge provider while preserving historical chat compatibility.",
        );
      }
      assertNoHistoricalModelBridgeMarkerComments(historical.text);
      if (historical.removed) {
        return {
          changed: false,
          installed: false,
          configPath,
          statePath,
          historicalCompatibility: true,
        };
      }
      const finalContents = Buffer.from(
        appendHistoricalModelBridgeCompatibility(
          current.text,
          current.exists,
        ),
        "utf8",
      );
      await atomicWrite(configPath, finalContents, current.mode, {
        expectedSource: snapshotOf(current),
        beforeCommit: ownershipCommitGuard(
          ownershipReceipt,
          beforeConfigCommit,
        ),
      });
      return {
        changed: true,
        installed: false,
        configPath,
        statePath,
        historicalCompatibility: true,
      };
    }
    return { changed: false, installed: false, configPath, statePath };
  }

  const state = stateResult;
  assertStateMatchesConfig(state, configPath);
  const current = await readConfigFile(configPath, { mustExist: true });
  if (state.suspension) {
    assertSuspendedConfiguration(current, state);
    await readOwnershipBackup(ownershipReceipt);
  }
  const restorationText = state.suspension?.kind === "integration-toggle-v1"
    ? removeDeactivatedHistoricalCompatibility(current.text, state).text
    : current.text;
  const located = state.suspension
    ? locateSuspendedRestorationBoundary(restorationText)
    : locateOwnedBlocks(current.text, state);
  const pickerRoot = state.suspension ? { safe: true, retainedText: "" } : inspectPickerMutableRoot(located.root, state, current.text);

  if (state.priorAssignments.some(({ key }) => key === "openai_base_url") &&
    inspectRootIntegration(current.text).gateway !== undefined) {
    throw failure("INTEGRATION_CONFLICT", "A user-owned OpenAI gateway was added after installation. Review it before restoring the previous picker integration.");
  }

  const modified = [];
  for (const name of state.suspension ? [] : ownedBlockNames(state)) {
    if (
      sha256(located[name].text) !== state.blocks[name].sha256 &&
      !(name === "root" && pickerRoot.safe)
    ) {
      modified.push(name);
    }
  }
  if (!hasSafeProviderScopeTail(current.text, located.provider.end)) {
    modified.push("provider-scope-tail");
  }
  if (modified.length > 0 && !force) {
    throw failure(
      "MANAGED_BLOCK_MODIFIED",
      `Refusing uninstall because managed block(s) were edited: ${modified.join(", ")}. ` +
        "The integration has not been removed. Run 'pickermux doctor' and review config.toml; " +
        "use 'pickermux uninstall --force' only after privately saving intentional edits and choosing to remove the recorded managed blocks.",
      { modified },
    );
  }

  const pristineCandidate = located.provider.recoveredEnd
    ? Buffer.from(
        current.text.slice(0, located.provider.start) +
          located.provider.text +
          current.text.slice(located.provider.end),
        "utf8",
      )
    : current.bytes;
  const pristineInstall = state.suspension
    ? state.suspension.pristine
    : typeof state.installedSha256 === "string" && sha256(pristineCandidate) === state.installedSha256;
  let restoredContents;

  if (pristineInstall && state.configExisted !== false) {
    try {
      restoredContents = Buffer.from(
        (await readOwnershipBackup(ownershipReceipt)).contents,
      );
    } catch (error) {
      if (!force) {
        throw failure(
          "BACKUP_UNREADABLE",
          `Exact backup cannot be read: ${state.backupPath}`,
          { cause: error },
        );
      }
    }
    if (
      restoredContents &&
      sha256(restoredContents) !== state.sourceSha256
    ) {
      if (!force) {
        throw failure(
          "BACKUP_MISMATCH",
          `Exact backup checksum does not match installation state: ${state.backupPath}`,
        );
      }
      restoredContents = undefined;
    }
  }

  if (!restoredContents && !(pristineInstall && state.configExisted === false)) {
    const prior = state.priorAssignments
      .map((assignment) => `${assignment.raw}${assignment.eol ?? located.root.eol}`)
      .join("");
    const replacements = [
      { ...located.root, replacement: prior + (pickerRoot.safe ? pickerRoot.retainedText : "") },
      { ...located.provider, replacement: "" },
      ...(located.webSearch ? [{ ...located.webSearch, replacement: "" }] : []),
    ].sort((left, right) => right.start - left.start);

    let restoredText = restorationText;
    for (const block of replacements) {
      restoredText =
        restoredText.slice(0, block.start) +
        block.replacement +
        restoredText.slice(block.end);
    }
    restoredContents = restoredText;
  }

  const preserveHistoricalModelBridge =
    options.preserveHistoricalModelBridge === true &&
    state.providerId === HISTORICAL_MODEL_BRIDGE_PROVIDER_ID;
  let finalRestoredContents = restoredContents;
  if (preserveHistoricalModelBridge) {
    const restoredText = restoredContents?.toString("utf8") ?? "";
    if (
      hasProviderDefinition(
        restoredText,
        HISTORICAL_MODEL_BRIDGE_PROVIDER_ID,
      )
    ) {
      throw failure(
        "HISTORICAL_PROVIDER_CONFLICT",
        "Refusing to replace an existing model_bridge provider while preserving historical chat compatibility.",
      );
    }
    assertNoHistoricalModelBridgeMarkerComments(restoredText);
    const historicalConfigExisted =
      state.configExisted !== false || restoredText !== "";
    finalRestoredContents = Buffer.from(
      appendHistoricalModelBridgeCompatibility(
        restoredText,
        historicalConfigExisted,
      ),
      "utf8",
    );
  }
  const configWasRemoved =
    pristineInstall &&
    state.configExisted === false &&
    !preserveHistoricalModelBridge;

  if (configWasRemoved) {
    await atomicRemove(configPath, {
      expectedSource: snapshotOf(current),
      beforeCommit: ownershipCommitGuard(
        ownershipReceipt,
        beforeConfigCommit,
      ),
    });
  } else {
    await atomicWrite(
      configPath,
      finalRestoredContents,
      pristineInstall ? (state.configMode ?? current.mode) : current.mode,
      {
        expectedSource: snapshotOf(current),
        beforeCommit: ownershipCommitGuard(
          ownershipReceipt,
          beforeConfigCommit,
        ),
      },
    );
  }
  try {
    await removeOwnedStateFile(ownershipReceipt);
  } catch (error) {
    let rollbackError;
    try {
      await rollbackConfigAfterStateRemovalFailure({
        configPath,
        installedConfig: current,
        restoredContents: finalRestoredContents,
        configWasRemoved,
      });
    } catch (caught) {
      rollbackError = caught;
    }
    throw failure(
      "STATE_REMOVE_FAILED",
      rollbackError
        ? `Configuration state removal and config rollback both failed: ${statePath}`
        : `Configuration state could not be removed; the installed config was restored: ${statePath}`,
      { cause: error, rollbackCause: rollbackError },
    );
  }

  return {
    changed: true,
    installed: false,
    configPath,
    statePath,
    backupPath: state.backupPath,
    model: state.model,
    provider: state.providerId,
    catalog: state.catalog,
    metadataPreservation: state.metadataPreservation,
    restoredAssignments: state.priorAssignments.map(({ key }) => key),
    historicalCompatibility: preserveHistoricalModelBridge,
  };
}

function assertNativeDefaultRoot(source) {
  // Foreign overrides added outside our recorded blocks are never deletion
  // authority, even when full removal was explicitly confirmed.
  inspectRootIntegration(source);
  for (const line of scanTomlLexicalLines(source).lines) {
    const code = line.code.trim();
    if (isTableHeader(code)) break;
    const key = parseTomlDottedKey(code);
    if (key && INTEGRATION_KEYS.includes(key.path[0])) {
      throw failure("UNINSTALL_CONFLICT", "Native restoration refuses an unowned picker root assignment.");
    }
  }
}

function nativeRestorationToken(settings, current, ownership, backup) {
  return sha256(JSON.stringify([
    "pickermux-native-uninstall-v1", settings.configPath, settings.statePath,
    current.mode, sha256(current.bytes), current.identity?.dev, current.identity?.ino,
    ownership.stateFile.sha256, ownership.stateFile.snapshot.dev, ownership.stateFile.snapshot.ino,
    backup.sha256, backup.snapshot.dev, backup.snapshot.ino,
    // The restoration intent is fixed rather than supplied as arbitrary fields.
    INTEGRATION_KEYS, "preserve-historical-model-bridge",
  ]));
}

/** Read-only proof of the exact native configuration resulting from removal. */
export async function inventoryNativeConfigRestoration(options = {}) {
  if (options.force) throw failure("UNINSTALL_CONFLICT", "Native restoration does not permit forced removal.");
  const settings = normalizeOwnershipOptions(options);
  const ownershipReceipt = options.ownershipReceipt ?? await inventoryManagedConfigOwnership(options);
  const ownership = ownershipDetails(ownershipReceipt, settings);
  await revalidateManagedConfigOwnership(ownershipReceipt, { readBackupImpl: options.readBackupImpl });
  const state = ownership.state;
  if (!state || state.providerId !== HISTORICAL_MODEL_BRIDGE_PROVIDER_ID) {
    throw failure("UNINSTALL_CONFLICT", "Native restoration requires the recorded PickerMux integration.");
  }
  const current = await readConfigFile(settings.configPath, { mustExist: true });
  const backup = await readOwnershipBackup(ownershipReceipt);
  let candidate = current.text;
  if (state.suspension) {
    if (state.suspension.kind !== "integration-toggle-v1") {
      throw failure("UNINSTALL_CONFLICT", "An interrupted recovery must finish before full removal.");
    }
    assertSuspendedConfiguration(current, state);
    candidate = removeDeactivatedHistoricalCompatibility(candidate, state).text;
  } else {
    const located = locateHealthyManagedBlocks(current.text, state);
    const pickerRoot = inspectPickerMutableRoot(located.root, state, current.text);
    for (const block of ownedBlockNames(state).map((name) => located[name]).sort((left, right) => right.start - left.start)) {
      candidate = candidate.slice(0, block.start) + (block === located.root ? pickerRoot.retainedText : "") + candidate.slice(block.end);
    }
  }
  assertNativeDefaultRoot(candidate);
  assertNoManagedMarkers(candidate);
  assertNoHistoricalModelBridgeMarkerComments(candidate);
  if (hasProviderDefinition(candidate, HISTORICAL_MODEL_BRIDGE_PROVIDER_ID)) {
    throw failure("UNINSTALL_CONFLICT", "Native restoration refuses an unowned historical provider.");
  }
  const previewToken = nativeRestorationToken(settings, current, ownership, backup);
  if (options.expectedPreviewToken !== undefined && options.expectedPreviewToken !== previewToken) {
    throw failure("UNINSTALL_CONFLICT", "The reviewed native restoration changed.");
  }
  const receipt = Object.freeze({ previewToken });
  nativeRestorationReceiptDetails.set(receipt, {
    settings, ownershipReceipt, current,
    finalContents: Buffer.from(appendHistoricalModelBridgeCompatibility(candidate, state.configExisted !== false || candidate !== "")),
  });
  return receipt;
}

/** Recheck the proof before irreversible credential deletion and config CAS. */
export async function revalidateNativeConfigRestoration(receipt, { readBackupImpl } = {}) {
  const details = nativeRestorationReceiptDetails.get(receipt);
  if (!details) throw failure("UNINSTALL_CONFLICT", "A verified native restoration receipt is required.");
  await revalidateManagedConfigOwnership(details.ownershipReceipt, { readBackupImpl });
  const ownership = ownershipDetails(details.ownershipReceipt);
  const current = await readConfigFile(details.settings.configPath, { mustExist: true });
  const backup = await readOwnershipBackup(details.ownershipReceipt, { cache: false });
  if (nativeRestorationToken(details.settings, current, ownership, backup) !== receipt.previewToken) {
    throw failure("UNINSTALL_CONFLICT", "The reviewed native restoration changed.");
  }
  return receipt;
}

async function uninstallNativeConfig(options) {
  const settings = normalizeOwnershipOptions(options);
  const receipt = options.nativeRestorationReceipt ?? await inventoryNativeConfigRestoration(options);
  const details = nativeRestorationReceiptDetails.get(receipt);
  if (!details || details.settings.configPath !== settings.configPath || details.settings.statePath !== settings.statePath ||
    details.settings.backupDirectory !== settings.backupDirectory || options.force) {
    throw failure("UNINSTALL_CONFLICT", "A matching native restoration receipt is required.");
  }
  await revalidateNativeConfigRestoration(receipt, { readBackupImpl: options.readBackupImpl });
  await atomicWrite(settings.configPath, details.finalContents, details.current.mode, {
    expectedSource: snapshotOf(details.current),
    beforeCommit: async () => {
      if (settings.beforeConfigCommit) await settings.beforeConfigCommit();
      await revalidateNativeConfigRestoration(receipt, { readBackupImpl: options.readBackupImpl });
    },
  });
  try {
    await removeOwnedStateFile(details.ownershipReceipt);
  } catch (cause) {
    let rollbackCause;
    try {
      await rollbackConfigAfterStateRemovalFailure({
        configPath: settings.configPath, installedConfig: details.current,
        restoredContents: details.finalContents, configWasRemoved: false,
      });
    } catch (error) { rollbackCause = error; }
    throw failure("STATE_REMOVE_FAILED", rollbackCause
      ? "Native restoration state removal and configuration rollback both failed."
      : "Native restoration could not remove its ownership state; prior configuration was restored.", { cause, rollbackCause });
  }
  return {
    changed: true, installed: false, nativeRestored: true,
    historicalCompatibility: true, restoredAssignments: [],
  };
}

/** Restore parser compatibility for old chats only after the integration is gone. */
export async function repairHistoricalChatsConfig(options = {}) {
  const settings = normalizeOwnershipOptions(options);
  const ownershipReceipt = await inventoryManagedConfigOwnership(settings);
  if (ownershipReceipt.exists) {
    throw failure(
      "INTEGRATION_INSTALLED",
      "Historical chat repair requires PickerMux to be uninstalled; review the managed integration before changing it.",
    );
  }
  const result = await uninstallConfig({
    ...settings,
    ownershipReceipt,
    preserveHistoricalModelBridge: true,
  });
  return {
    changed: result.changed,
    historicalCompatibility: result.historicalCompatibility,
    provider: HISTORICAL_MODEL_BRIDGE_PROVIDER_ID,
  };
}

/**
 * Materialize the one receipt-recovered provider end marker so an older
 * installed CLI can complete recovery after a newer setup preflight stops.
 */
export async function restoreRecoveredProviderEndMarker(options = {}) {
  const settings = normalizeOwnershipOptions(options);
  const ownershipReceipt = options.ownershipReceipt ??
    await inventoryManagedConfigOwnership(settings);
  const ownership = ownershipDetails(ownershipReceipt, settings);
  await revalidateManagedConfigOwnership(ownershipReceipt);
  if (!ownership.state) {
    throw failure(
      "STATE_MISSING",
      "Managed configuration state does not exist.",
    );
  }

  const current = await readConfigFile(settings.configPath, { mustExist: true });
  const located = locateOwnedBlocks(current.text, ownership.state);
  const pickerRoot = inspectPickerMutableRoot(located.root, ownership.state, current.text);
  const modified = [];
  if (
    sha256(located.root.text) !== ownership.state.blocks.root.sha256 &&
    !pickerRoot.safe
  ) {
    modified.push("root");
  }
  if (sha256(located.provider.text) !== ownership.state.blocks.provider.sha256) {
    modified.push("provider");
  }
  if (located.webSearch && sha256(located.webSearch.text) !== ownership.state.blocks.webSearch.sha256) {
    modified.push("webSearch");
  }
  if (!hasSafeProviderScopeTail(current.text, located.provider.end)) {
    modified.push("provider-scope-tail");
  }
  if (modified.length > 0) {
    throw failure(
      "MANAGED_BLOCK_MODIFIED",
      `Refusing marker restoration because managed block(s) were edited: ${modified.join(", ")}`,
      { modified },
    );
  }
  if (!located.provider.recoveredEnd) {
    return {
      changed: false,
      configPath: settings.configPath,
      statePath: settings.statePath,
      marker: null,
    };
  }

  const restoredText =
    current.text.slice(0, located.provider.start) +
    located.provider.text +
    current.text.slice(located.provider.end);
  await atomicWrite(settings.configPath, restoredText, current.mode, {
    expectedSource: snapshotOf(current),
    beforeCommit: ownershipCommitGuard(
      ownershipReceipt,
      settings.beforeConfigCommit,
    ),
  });
  return {
    changed: true,
    configPath: settings.configPath,
    statePath: settings.statePath,
    marker: "provider-end",
  };
}

/** Return a non-mutating installation/health snapshot. */
export async function getConfigStatus(options) {
  const { configPath, statePath } = normalizePathOptions(options);
  let current;
  try {
    current = await readConfigFile(configPath);
  } catch (error) {
    return {
      installed: false,
      healthy: false,
      status: "unreadable-config",
      configPath,
      statePath,
      error,
    };
  }

  let state;
  try {
    state = await readState(statePath, { allowMissing: true });
  } catch (error) {
    return {
      installed: containsAnyManagedMarker(current.text),
      healthy: false,
      status: "invalid-state",
      configPath,
      statePath,
      error,
    };
  }

  if (!state) {
    const orphaned = containsAnyManagedMarker(current.text);
    try {
      inspectRootIntegration(current.text);
    } catch (error) {
      return {
        installed: orphaned,
        healthy: false,
        status: orphaned ? "orphaned-managed-block" : "integration-conflict",
        configPath,
        statePath,
        error,
      };
    }
    return {
      installed: orphaned,
      healthy: !orphaned,
      status: orphaned ? "orphaned-managed-block" : "not-installed",
      configPath,
      statePath,
    };
  }

  try {
    assertStateMatchesConfig(state, configPath);
    inspectRootIntegration(current.text);
    if (state.suspension) {
      try {
        assertSuspendedConfiguration(current, state);
        return {
          installed: false,
          healthy: true,
          status: state.suspension.kind === "integration-toggle-v1" ? "deactivated" : "suspended",
          configPath,
          statePath,
          providerId: state.providerId,
          recoveryRequired: state.suspension.kind !== "integration-toggle-v1",
        };
      } catch (error) {
        return {
          installed: false,
          healthy: false,
          status: "suspension-conflict",
          configPath,
          statePath,
          recoveryRequired: true,
          error,
        };
      }
    }
    const located = locateOwnedBlocks(current.text, state);
    const pickerRoot = inspectPickerMutableRoot(located.root, state, current.text);
    const modifiedBlocks = ownedBlockNames(state).filter((name) => {
      if (sha256(located[name].text) === state.blocks[name].sha256) return false;
      return !(name === "root" && pickerRoot.safe);
    });
    if (!hasSafeProviderScopeTail(current.text, located.provider.end)) {
      modifiedBlocks.push("provider-scope-tail");
    }
    const healthy = modifiedBlocks.length === 0;
    const recoveredMarkers = located.recoveredMarkers;
    return {
      installed: true,
      healthy,
      status: healthy
        ? recoveredMarkers.length > 0
          ? "installed-marker-recovered"
          : "installed"
        : "modified",
      configPath,
      statePath,
      backupPath: state.backupPath,
      model: pickerRoot.model ?? state.model,
      provider: state.providerId,
      providerName: state.providerName,
      catalog: state.catalog,
      baseUrl: state.providerBaseUrl,
      modelReasoningEffort:
        pickerRoot.modelReasoningEffort ?? state.modelReasoningEffort,
      providerId: state.providerId,
      metadataPreservation: state.metadataPreservation,
      modifiedBlocks,
      recoveredMarkers,
    };
  } catch (error) {
    return {
      installed: true,
      healthy: false,
      status: "inconsistent",
      configPath,
      statePath,
      error,
    };
  }
}

function normalizeInstallOptions(options = {}) {
  const paths = normalizePathOptions(options);
  const providerInput = options.provider ?? {};
  const id = options.modelProvider ?? providerInput.id;
  const modelCatalogJson = options.modelCatalogJson ?? options.catalogPath;
  const modelReasoningEffort = options.modelReasoningEffort ?? "low";

  requireNonEmptyString(options.model, "model");
  requireNonEmptyString(id, "modelProvider/provider.id");
  requireNonEmptyString(modelCatalogJson, "modelCatalogJson");
  requireNonEmptyString(providerInput.name, "provider.name");
  requireNonEmptyString(providerInput.baseUrl, "provider.baseUrl");
  if (providerInput.supportsStandaloneWebSearch !== undefined &&
    typeof providerInput.supportsStandaloneWebSearch !== "boolean") {
    throw failure("INVALID_ARGUMENT", "provider.supportsStandaloneWebSearch must be a boolean.");
  }
  if (!PICKER_REASONING_EFFORTS.has(modelReasoningEffort)) {
    throw failure(
      "INVALID_REASONING_EFFORT",
      "modelReasoningEffort must be one of: none, minimal, low, medium, high, xhigh, max, or ultra.",
    );
  }

  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw failure(
      "INVALID_PROVIDER_ID",
      "Provider ID may contain only letters, digits, underscores, and hyphens.",
    );
  }
  if (providerInput.id && options.modelProvider && providerInput.id !== options.modelProvider) {
    throw failure(
      "PROVIDER_ID_MISMATCH",
      "modelProvider and provider.id must match when both are supplied.",
    );
  }

  const nowValue = options.now instanceof Date
    ? options.now
    : typeof options.now === "function"
      ? options.now()
      : new Date();
  if (!(nowValue instanceof Date) || Number.isNaN(nowValue.valueOf())) {
    throw failure("INVALID_DATE", "now must resolve to a valid Date.");
  }

  return {
    ...paths,
    model: options.model,
    modelProvider: id,
    modelCatalogJson,
    modelReasoningEffort,
    backupDirectory: options.backupDirectory
      ? resolve(options.backupDirectory)
      : dirname(paths.statePath),
    beforeConfigCommit: paths.beforeConfigCommit,
    now: nowValue,
    provider: {
      id,
      name: providerInput.name,
      baseUrl: providerInput.baseUrl.replace(/\/+$/, ""),
      wireApi: providerInput.wireApi ?? "responses",
      envKey: providerInput.envKey,
      envKeyInstructions: providerInput.envKeyInstructions,
      requiresOpenAIAuth:
        providerInput.requiresOpenAiAuth ?? providerInput.requiresOpenAIAuth ?? false,
      supportsWebsockets: providerInput.supportsWebsockets ?? false,
      supportsStandaloneWebSearch:
        providerInput.supportsStandaloneWebSearch ?? false,
      requestMaxRetries: providerInput.requestMaxRetries,
      streamMaxRetries: providerInput.streamMaxRetries,
      streamIdleTimeoutMs: providerInput.streamIdleTimeoutMs,
    },
  };
}

function normalizePathOptions(options = {}) {
  requireNonEmptyString(options.configPath, "configPath");
  requireNonEmptyString(options.statePath, "statePath");
  return {
    configPath: resolve(options.configPath),
    statePath: resolve(options.statePath),
    force: options.force === true,
    beforeConfigCommit:
      typeof options.beforeConfigCommit === "function"
        ? options.beforeConfigCommit
        : undefined,
  };
}

function normalizeOwnershipOptions(options = {}) {
  const paths = normalizePathOptions(options);
  const backupDirectory = resolve(
    options.backupDirectory ?? join(dirname(paths.statePath), "backups"),
  );
  if (
    backupDirectory === resolve(backupDirectory, "..") ||
    backupDirectory === dirname(backupDirectory)
  ) {
    throw failure(
      "INVALID_BACKUP_DIRECTORY",
      "backupDirectory must identify a non-root directory.",
    );
  }
  return {
    ...paths,
    backupDirectory,
  };
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw failure("INVALID_ARGUMENT", `${label} must be a non-empty string.`);
  }
}

async function readConfigFile(path, { mustExist = false } = {}) {
  let handle;
  let pathObserved = false;
  try {
    const initialPathStats = await lstat(path);
    pathObserved = true;
    if (initialPathStats.isSymbolicLink()) {
      throw failure("CONFIG_SYMLINK", `Refusing symbolic-link Codex config: ${path}`);
    }
    if (!initialPathStats.isFile() || initialPathStats.nlink !== 1) {
      throw failure(
        "CONFIG_NOT_REGULAR",
        `Codex config is not a single-link regular file: ${path}`,
      );
    }
    assertCurrentUserOwner(initialPathStats, path, "Codex config");
    const initialSnapshot = fileSnapshot(initialPathStats);

    handle = await open(path, PRIVATE_READ_FLAGS);
    const [stats, pathStats] = await Promise.all([
      handle.stat(),
      lstat(path),
    ]);
    if (
      !stats.isFile() ||
      pathStats.isSymbolicLink() ||
      !pathStats.isFile() ||
      stats.dev !== pathStats.dev ||
      stats.ino !== pathStats.ino ||
      stats.nlink !== 1 ||
      pathStats.nlink !== 1 ||
      !sameFileSnapshot(initialSnapshot, fileSnapshot(stats)) ||
      !sameFileSnapshot(initialSnapshot, fileSnapshot(pathStats))
    ) {
      throw failure(
        "CONFIG_CHANGED_CONCURRENTLY",
        `Codex config changed after ownership validation: ${path}`,
      );
    }
    assertCurrentUserOwner(stats, path, "Codex config");
    assertCurrentUserOwner(pathStats, path, "Codex config");

    const bytes = await handle.readFile();
    const [confirmed, confirmedPath] = await Promise.all([
      handle.stat(),
      lstat(path),
    ]);
    if (
      !sameFileSnapshot(initialSnapshot, fileSnapshot(confirmed)) ||
      !sameFileSnapshot(initialSnapshot, fileSnapshot(confirmedPath)) ||
      bytes.length !== confirmed.size
    ) {
      throw failure(
        "CONFIG_CHANGED_CONCURRENTLY",
        `Codex config changed while it was read: ${path}`,
      );
    }
    return {
      exists: true,
      bytes,
      text: bytes.toString("utf8"),
      mode: confirmed.mode & 0o777,
      identity: initialSnapshot,
    };
  } catch (error) {
    if (
      error?.code === "ENOENT" &&
      !mustExist &&
      !pathObserved &&
      !handle
    ) {
      return { exists: false, bytes: Buffer.alloc(0), text: "", mode: 0o600 };
    }
    if (error?.code === "ENOENT") {
      throw failure("CONFIG_MISSING", `Codex config does not exist: ${path}`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readState(path, { allowMissing = false } = {}) {
  const captured = await readOwnedRegularFile(path, {
    allowMissing,
    requirePrivate: true,
    label: "PickerMux configuration state",
  });
  if (!captured) return null;
  return parseState(captured.contents, path);
}

function parseState(contents, path) {
  let state;
  try {
    state = JSON.parse(contents.toString("utf8"));
  } catch (error) {
    throw failure("INVALID_STATE", `State file is not valid JSON: ${path}`, {
      cause: error,
    });
  }
  if (
    state?.version !== STATE_VERSION ||
    typeof state.configPath !== "string" ||
    !Array.isArray(state.priorAssignments) ||
    typeof state.blocks?.root?.sha256 !== "string" ||
    typeof state.blocks?.provider?.sha256 !== "string"
  ) {
    throw failure("INVALID_STATE", `Unsupported or incomplete state file: ${path}`);
  }
  if (state.blocks.webSearch && (
    state.blocks.webSearch.begin !== CONFIG_MARKERS.webSearchBegin ||
    state.blocks.webSearch.end !== CONFIG_MARKERS.webSearchEnd ||
    !["root", "features"].includes(state.blocks.webSearch.scope) ||
    !/^[a-f0-9]{64}$/u.test(state.blocks.webSearch.sha256)
  )) {
    throw failure("INVALID_STATE", "Invalid managed web search feature receipt.");
  }
  if (state.suspension && (
    typeof state.suspension !== "object" || Array.isArray(state.suspension) ||
    Object.keys(state.suspension).some((key) => !["kind", "configSha256", "pristine"].includes(key)) ||
    !["full-refresh-v1", "integration-toggle-v1"].includes(state.suspension.kind) ||
    !/^[a-f0-9]{64}$/u.test(state.suspension.configSha256) ||
    typeof state.suspension.pristine !== "boolean"
  )) {
    throw failure("INVALID_STATE", "Invalid managed configuration suspension receipt.");
  }
  return state;
}

function standaloneWebSearchPlan(source) {
  let scope = [];
  let featureTable;
  const explicit = [];
  for (const line of scanTomlLexicalLines(source).lines) {
    const code = line.code.trim();
    if (!code) continue;
    if (isTableHeader(code)) {
      scope = parseTomlTablePath(code);
      if (scope?.[0] === "features") {
        if (scope.length !== 1 || code.startsWith("[[") || featureTable) {
          throw failure("WEB_SEARCH_CONFIG_CONFLICT", "The features table is ambiguous.");
        }
        featureTable = line;
      }
      continue;
    }
    if (!scope) continue;
    const key = parseTomlDottedKey(code);
    if (!key || code[key.end] !== "=") continue;
    const fullPath = [...scope, ...key.path];
    if (fullPath[0] !== "features") continue;
    if (fullPath.length === 1) {
      // Inline tables are sealed in TOML. Respect a proven explicit boolean,
      // but never expand or rewrite unrelated inline feature settings.
      const value = code.slice(key.end + 1).trim();
      const entries = splitInlineFeatureEntries(value);
      let found = false;
      for (const entry of entries) {
        const inlineKey = parseTomlDottedKey(entry);
        if (!inlineKey || entry[inlineKey.end] !== "=") {
          throw failure("WEB_SEARCH_CONFIG_CONFLICT", "The inline features table is malformed.");
        }
        if (inlineKey.path.length === 1 && inlineKey.path[0] === "standalone_web_search") {
          explicit.push(parseFeatureBoolean(entry.slice(inlineKey.end + 1)));
          found = true;
        }
      }
      if (!found) {
        throw failure("WEB_SEARCH_CONFIG_CONFLICT", "Set standalone_web_search explicitly in the inline features table before refreshing.");
      }
    } else if (fullPath[1] === "standalone_web_search") {
      if (fullPath.length !== 2) {
        throw failure("WEB_SEARCH_CONFIG_CONFLICT", "The standalone web search feature must be a boolean.");
      }
      explicit.push(parseFeatureBoolean(code.slice(key.end + 1)));
    }
  }
  if (explicit.length > 1) {
    throw failure("WEB_SEARCH_CONFIG_CONFLICT", "The standalone web search feature is defined more than once.");
  }
  if (explicit.length) return { existing: true, enabled: explicit[0] };
  return { existing: false, featureTable };
}

function parseFeatureBoolean(value) {
  const text = value.trim();
  if (text !== "true" && text !== "false") {
    throw failure("WEB_SEARCH_CONFIG_CONFLICT", "The standalone web search feature must be true or false.");
  }
  return text === "true";
}

function splitInlineFeatureEntries(value) {
  if (!value.startsWith("{") || !value.endsWith("}")) {
    throw failure("WEB_SEARCH_CONFIG_CONFLICT", "The features setting must be a supported TOML table.");
  }
  const body = value.slice(1, -1);
  const entries = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '"') {
      index = skipTomlBasicString(body, index) - 1;
    } else if (body[index] === "'") {
      index = skipTomlLiteralString(body, index) - 1;
    } else if (body[index] === "[" || body[index] === "{") {
      depth += 1;
    } else if (body[index] === "]" || body[index] === "}") {
      depth -= 1;
    } else if (body[index] === "," && depth === 0) {
      entries.push(body.slice(start, index).trim());
      start = index + 1;
    }
    if (depth < 0) throw failure("WEB_SEARCH_CONFIG_CONFLICT", "The inline features table is malformed.");
  }
  if (depth !== 0) throw failure("WEB_SEARCH_CONFIG_CONFLICT", "The inline features table is malformed.");
  const last = body.slice(start).trim();
  if (last) entries.push(last);
  return entries;
}

function addStandaloneWebSearchFeature(source) {
  const plan = standaloneWebSearchPlan(source);
  if (plan.existing) return { text: source, enabled: plan.enabled };
  const eol = detectEol(splitLines(source));
  const scope = plan.featureTable ? "features" : "root";
  const key = scope === "root" ? "features.standalone_web_search" : "standalone_web_search";
  const blockText = [CONFIG_MARKERS.webSearchBegin, `${key} = true`, CONFIG_MARKERS.webSearchEnd, ""].join(eol);
  const insertion = plan.featureTable?.end ?? source.indexOf(CONFIG_MARKERS.rootBegin);
  if (insertion < 0) throw failure("WEB_SEARCH_CONFIG_CONFLICT", "Managed root block is missing.");
  const prefix = insertion > 0 && !endsWithNewline(source.slice(0, insertion)) ? eol : "";
  return {
    text: source.slice(0, insertion) + prefix + blockText + source.slice(insertion),
    enabled: true,
    block: {
      begin: CONFIG_MARKERS.webSearchBegin,
      end: CONFIG_MARKERS.webSearchEnd,
      sha256: sha256(blockText),
      scope,
    },
  };
}

function integrationPreview(status, canApply, requiresConfirmation, changes, previewToken) {
  return { schemaVersion: 1, status, canApply, requiresConfirmation, changes, previewToken };
}

function assertSuspendedConfiguration(current, state) {
  if (!state.suspension) {
    throw failure("CONFIGURATION_NOT_SUSPENDED", "The managed configuration has no full-refresh suspension receipt.");
  }
  if (state.suspension.kind === "integration-toggle-v1" &&
    (state.providerId !== HISTORICAL_MODEL_BRIDGE_PROVIDER_ID || !removeDeactivatedHistoricalCompatibility(current.text, state).removed)) {
    throw failure("CONFIGURATION_SUSPENSION_CONFLICT", "The exact historical provider alias could not be verified.");
  }
  if (!current.exists || sha256(current.bytes) !== state.suspension.configSha256 ||
    containsAnyManagedMarker(current.text) || inspectRootIntegration(current.text).foreign) {
    throw failure("CONFIGURATION_SUSPENSION_CONFLICT", "Native configuration changed after full-refresh suspension. Review it before resuming.");
  }
}

function locateSuspendedRestorationBoundary(source) {
  // A retained full-file suspension digest authorizes restoration at exactly
  // the native root/table boundary; no managed marker is inferred or repaired.
  const lines = scanTomlLexicalLines(source).lines;
  const start = lines.find((line) => isTableHeader(line.code.trim()))?.start ?? source.length;
  const boundary = { start, end: start, text: "", eol: detectEol(lines), recoveredEnd: false };
  return { root: boundary, provider: boundary, recoveredMarkers: [] };
}

function integrationPreviewToken(current, configPath, statePath, stateContents) {
  return sha256(JSON.stringify([
    "pickermux-integration-preview-v1",
    configPath,
    statePath,
    current.exists,
    current.mode,
    sha256(current.bytes),
    stateContents ? sha256(stateContents) : null,
  ]));
}

function requirePreviewToken(token) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token)) {
    throw failure("INVALID_ARGUMENT", "An exact integration preview token is required.");
  }
}

function parseSimpleTomlString(value) {
  if (value.startsWith("'")) {
    return /^'[^'\r\n]*'$/u.test(value) ? value.slice(1, -1) : undefined;
  }
  if (!value.startsWith('"')) return undefined;
  const parsed = parseTomlBasicKeySegment(value, 0);
  return parsed?.end === value.length ? parsed.value : undefined;
}

function inspectRootIntegration(source) {
  const values = new Map();
  for (const line of scanTomlLexicalLines(source).lines) {
    const code = line.code.trim();
    if (!code) continue;
    if (isTableHeader(code)) break;
    const key = parseTomlDottedKey(code);
    if (key?.path[0] === "profile") {
      throw failure("INTEGRATION_CONFLICT", "An active Codex profile requires manual review before changing the picker integration.");
    }
    if (!key || !INTEGRATION_KEYS.includes(key.path[0])) continue;
    if (values.has(key.path[0])) {
      throw failure("DUPLICATE_MANAGED_KEY", "Picker integration root assignments are duplicated.");
    }
    if (key.path.length !== 1 || code[key.end] !== "=") {
      throw failure("MALFORMED_MANAGED_KEY", "Picker integration root assignments are malformed.");
    }
    const value = parseSimpleTomlString(code.slice(key.end + 1).trim());
    if (value === undefined || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw failure("MALFORMED_MANAGED_KEY", "Picker integration root assignments must be unambiguous strings.");
    }
    values.set(key.path[0], value);
  }
  const gateway = values.get("openai_base_url");
  const provider = values.get("model_provider");
  const catalog = values.get("model_catalog_json");
  const foreign = gateway !== undefined || catalog !== undefined || (provider !== undefined && provider !== "openai");
  let ollama = false;
  if (gateway && catalog && (provider === undefined || provider === "openai")) {
    try {
      const url = new URL(gateway);
      ollama = ["http:", "https:"].includes(url.protocol) &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        !url.username && !url.password && !url.search && !url.hash &&
        url.pathname.replace(/\/+$/u, "").endsWith("/api/codex/v1") &&
        basename(catalog) === "ollama-launch-models.json";
    } catch {
      // A malformed user-owned URL is still a foreign setting, never authority
      // to contact a provider or to infer an Ollama ownership claim.
    }
  }
  return { gateway, foreign, ollama };
}

function locateHealthyManagedBlocks(source, state) {
  const located = locateOwnedBlocks(source, state);
  const pickerRoot = inspectPickerMutableRoot(located.root, state, source);
  for (const name of ownedBlockNames(state)) {
    if (sha256(located[name].text) !== state.blocks[name].sha256 && !(name === "root" && pickerRoot.safe)) {
      throw failure("MANAGED_BLOCK_MODIFIED", "Refusing to migrate edited managed configuration.");
    }
  }
  if (!hasSafeProviderScopeTail(source, located.provider.end)) {
    throw failure("MANAGED_BLOCK_MODIFIED", "Managed provider table scope changed.");
  }
  return located;
}

function canonicalProviderBlock(block, state) {
  const stringFields = new Map([
    ["name", "name"],
    ["base_url", "baseUrl"],
    ["wire_api", "wireApi"],
    ["env_key", "envKey"],
    ["env_key_instructions", "envKeyInstructions"],
  ]);
  const booleanFields = new Map([
    ["requires_openai_auth", "requiresOpenAIAuth"],
    ["supports_websockets", "supportsWebsockets"],
    ["supports_standalone_web_search", "supportsStandaloneWebSearch"],
  ]);
  const integerFields = new Map([
    ["request_max_retries", "requestMaxRetries"],
    ["stream_max_retries", "streamMaxRetries"],
    ["stream_idle_timeout_ms", "streamIdleTimeoutMs"],
  ]);
  if (typeof state.providerId !== "string" || !/^[A-Za-z0-9_-]+$/u.test(state.providerId)) {
    throw failure("MANAGED_PROVIDER_SCHEMA_CONFLICT", "The managed provider identity is unsupported.");
  }
  const provider = { id: state.providerId };
  const found = new Set();
  let tableFound = false;
  for (const line of scanTomlLexicalLines(block.text).lines) {
    const code = line.code.trim();
    if (!code) continue;
    if (isTableHeader(code)) {
      if (tableFound || code !== `[model_providers.${state.providerId}]`) {
        throw failure("MANAGED_PROVIDER_SCHEMA_CONFLICT", "The managed provider table is unsupported.");
      }
      tableFound = true;
      continue;
    }
    const key = parseTomlDottedKey(code);
    const field = key?.path[0];
    if (!tableFound || key?.path.length !== 1 || code[key.end] !== "=" || found.has(field)) {
      throw failure("MANAGED_PROVIDER_SCHEMA_CONFLICT", "The managed provider contains an ambiguous assignment.");
    }
    found.add(field);
    const value = code.slice(key.end + 1).trim();
    if (stringFields.has(field)) {
      const parsed = parseSimpleTomlString(value);
      if (parsed === undefined || parsed.length === 0) {
        throw failure("MANAGED_PROVIDER_SCHEMA_CONFLICT", "The managed provider contains an unsupported string.");
      }
      provider[stringFields.get(field)] = parsed;
    } else if (booleanFields.has(field)) {
      if (value !== "true" && value !== "false") {
        throw failure("MANAGED_PROVIDER_SCHEMA_CONFLICT", "The managed provider contains an unsupported boolean.");
      }
      provider[booleanFields.get(field)] = value === "true";
    } else if (integerFields.has(field)) {
      const parsed = Number(value);
      if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(parsed)) {
        throw failure("MANAGED_PROVIDER_SCHEMA_CONFLICT", "The managed provider contains an unsupported integer.");
      }
      provider[integerFields.get(field)] = parsed;
    } else {
      throw failure("MANAGED_PROVIDER_SCHEMA_CONFLICT", "The managed provider contains an unknown setting.");
    }
  }
  for (const required of ["name", "base_url", "wire_api", ...booleanFields.keys()]) {
    if (!found.has(required)) {
      throw failure("MANAGED_PROVIDER_SCHEMA_CONFLICT", "The managed provider is missing a required control.");
    }
  }
  if (provider.name !== state.providerName || provider.baseUrl !== state.providerBaseUrl || provider.wireApi !== "responses") {
    throw failure("MANAGED_PROVIDER_SCHEMA_CONFLICT", "The managed provider does not match its recorded identity and transport.");
  }
  return renderProviderBlock(provider, block.eol);
}

function analyzeConfig(source, providerId, { includeGateway = false } = {}) {
  const lines = splitLines(source);
  const lexicalLines = scanTomlLexicalLines(source).lines;
  const eol = detectEol(lines);
  const tableStarts = new Set(
    lexicalLines
      .filter((line) => isTableHeader(line.code))
      .map((line) => line.start),
  );
  const firstTable = lines.findIndex((line) => tableStarts.has(line.start));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const assignments = [];

  for (let index = 0; index < rootEnd; index += 1) {
    const line = lines[index];
    const parsed = parseManagedRootLine(lexicalLines[index].code, { includeGateway });
    if (!parsed) continue;
    if (parsed.malformed) {
      throw failure(
        "MALFORMED_MANAGED_KEY",
        `Malformed top-level ${parsed.key} assignment on line ${index + 1}.`,
        { key: parsed.key, line: index + 1 },
      );
    }
    assignments.push({
      key: parsed.key,
      raw: line.raw,
      eol: line.eol,
      index,
      start: line.start,
      end: line.end,
    });
  }

  for (const key of includeGateway ? INTEGRATION_KEYS : MANAGED_KEYS) {
    const matches = assignments.filter((assignment) => assignment.key === key);
    if (matches.length > 1) {
      throw failure(
        "DUPLICATE_MANAGED_KEY",
        `Duplicate top-level ${key} assignments found.`,
        { key, lines: matches.map(({ index }) => index + 1) },
      );
    }
  }

  if (hasProviderDefinition(source, providerId)) {
    throw failure(
      "PROVIDER_TABLE_CONFLICT",
      `Provider table already exists: [model_providers.${providerId}]`,
      { providerId },
    );
  }

  return { lines, eol, firstTable, assignments, tableStarts };
}

function parseManagedRootLine(raw, { includeGateway = false } = {}) {
  const code = stripTomlComment(raw).trim();
  if (code === "") return null;

  const keyPattern = `(?:${(includeGateway ? INTEGRATION_KEYS : MANAGED_KEYS).join("|")})`;
  const candidate = code.match(
    new RegExp(String.raw`^(?:"(${keyPattern})"|'(${keyPattern})'|(${keyPattern}))(?=\s|=|$)`),
  );
  if (!candidate) return null;

  const key = candidate[1] ?? candidate[2] ?? candidate[3];
  const assignment = code.match(
    new RegExp(
      String.raw`^(?:"${key}"|'${key}'|${key})\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*$`,
    ),
  );
  return assignment ? { key, malformed: false } : { key, malformed: true };
}

function stripTomlComment(raw) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = null;
    } else if (quote === "'") {
      if (character === "'") quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return raw.slice(0, index);
    }
  }
  return raw;
}

function isTableHeader(raw) {
  const code = stripTomlComment(raw).trim();
  return /^\[\[?.+?\]\]?$/.test(code);
}

function hasProviderDefinition(source, providerId) {
  const { lines } = scanTomlLexicalLines(source);
  let tablePath = [];
  for (const line of lines) {
    const code = line.code.trim();
    if (code === "") continue;
    if (isTableHeader(code)) {
      tablePath = parseTomlTablePath(code);
      if (
        isProviderPath(tablePath, providerId) ||
        isProviderRootArrayHeader(code, tablePath)
      ) {
        return true;
      }
      continue;
    }
    if (!tablePath) continue;
    const assignmentPath = parseTomlAssignmentKeyPath(code);
    if (!assignmentPath) continue;
    const fullPath = [...tablePath, ...assignmentPath];
    if (
      isProviderPath(fullPath, providerId) ||
      (fullPath.length === 1 && fullPath[0] === "model_providers")
    ) {
      return true;
    }
  }
  return false;
}

function isProviderPath(path, providerId) {
  return (
    path?.length >= 2 &&
    path[0] === "model_providers" &&
    path[1] === providerId
  );
}

function isProviderRootArrayHeader(header, path) {
  return (
    header.startsWith("[[") &&
    path?.length === 1 &&
    path[0] === "model_providers"
  );
}

function parseTomlTablePath(header) {
  const array = header.startsWith("[[");
  const closing = array ? "]]" : "]";
  if (!header.startsWith(array ? "[[" : "[") || !header.endsWith(closing)) {
    return null;
  }
  const contents = header.slice(array ? 2 : 1, -closing.length);
  const parsed = parseTomlDottedKey(contents);
  return parsed?.end === contents.length ? parsed.path : null;
}

function parseTomlAssignmentKeyPath(code) {
  const parsed = parseTomlDottedKey(code);
  return parsed && code[parsed.end] === "=" ? parsed.path : null;
}

function parseTomlDottedKey(source) {
  const path = [];
  let index = 0;
  while (/\s/u.test(source[index] ?? "")) index += 1;
  while (index < source.length) {
    const segment = parseTomlKeySegment(source, index);
    if (!segment) return null;
    path.push(segment.value);
    index = segment.end;
    while (/\s/u.test(source[index] ?? "")) index += 1;
    if (source[index] !== ".") return { path, end: index };
    index += 1;
    while (/\s/u.test(source[index] ?? "")) index += 1;
  }
  return null;
}

function parseTomlKeySegment(source, start) {
  const character = source[start];
  if (character === "'") {
    const end = source.indexOf("'", start + 1);
    if (end === -1) return null;
    return { value: source.slice(start + 1, end), end: end + 1 };
  }
  if (character === '"') return parseTomlBasicKeySegment(source, start);
  const match = source.slice(start).match(/^[A-Za-z0-9_-]+/u);
  return match
    ? { value: match[0], end: start + match[0].length }
    : null;
}

function parseTomlBasicKeySegment(source, start) {
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') return { value, end: index + 1 };
    if (character !== "\\") {
      if (character === "\n" || character === "\r") return null;
      value += character;
      continue;
    }
    const escaped = source[index + 1];
    const mapped = {
      b: "\b",
      t: "\t",
      n: "\n",
      f: "\f",
      r: "\r",
      '"': '"',
      "\\": "\\",
    }[escaped];
    if (mapped !== undefined) {
      value += mapped;
      index += 1;
      continue;
    }
    const width = escaped === "u" ? 4 : escaped === "U" ? 8 : 0;
    if (width === 0) return null;
    const hex = source.slice(index + 2, index + 2 + width);
    if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`, "u").test(hex)) return null;
    const codePoint = Number.parseInt(hex, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
    value += String.fromCodePoint(codePoint);
    index += width + 1;
  }
  return null;
}

function scanTomlLexicalLines(source) {
  let multilineQuote = null;
  const comments = [];
  const lines = splitLines(source).map((line) => {
    const code = line.raw.split("");
    let commentStart = null;
    let index = 0;
    while (index < line.raw.length) {
      if (multilineQuote) {
        const closing = findTomlMultilineStringEnd(
          line.raw,
          index,
          multilineQuote,
        );
        if (!closing) {
          maskCharacters(code, index, line.raw.length);
          index = line.raw.length;
          continue;
        }
        maskCharacters(code, index, closing.end);
        index = closing.end;
        multilineQuote = null;
        continue;
      }

      const character = line.raw[index];
      if (character === "#") {
        commentStart = index;
        comments.push(line.raw.slice(index + 1));
        maskCharacters(code, index, line.raw.length);
        break;
      }
      if (
        (character === '"' || character === "'") &&
        line.raw.startsWith(character.repeat(3), index)
      ) {
        maskCharacters(code, index, index + 3);
        multilineQuote = character;
        index += 3;
        continue;
      }
      if (character === '"') {
        index = skipTomlBasicString(line.raw, index);
        continue;
      }
      if (character === "'") {
        index = skipTomlLiteralString(line.raw, index);
        continue;
      }
      index += 1;
    }
    return { ...line, code: code.join(""), commentStart };
  });
  if (multilineQuote) {
    throw failure(
      "MALFORMED_TOML_MULTILINE_STRING",
      "Codex config contains an unterminated multiline TOML string.",
    );
  }
  return { lines, comments };
}

function findTomlMultilineStringEnd(source, start, quote) {
  for (let index = start; index < source.length; index += 1) {
    if (!source.startsWith(quote.repeat(3), index)) continue;
    if (quote === '"' && isEscapedTomlQuote(source, index)) continue;
    let end = index + 3;
    while (source[end] === quote) end += 1;
    return { end };
  }
  return null;
}

function isEscapedTomlQuote(source, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function skipTomlBasicString(source, start) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === '"') return index + 1;
  }
  return source.length;
}

function skipTomlLiteralString(source, start) {
  const end = source.indexOf("'", start + 1);
  return end === -1 ? source.length : end + 1;
}

function maskCharacters(characters, start, end) {
  for (let index = start; index < end; index += 1) {
    characters[index] = " ";
  }
}

function installBlocks(analysis, rootBlock, providerBlock, eol) {
  const assignmentIndexes = new Set(
    analysis.assignments.map((assignment) => assignment.index),
  );
  const filteredLines = analysis.lines.filter(
    (_line, index) => !assignmentIndexes.has(index),
  );

  let insertionIndex;
  insertionIndex = filteredLines.findIndex((line) =>
    analysis.tableStarts.has(line.start),
  );
  if (insertionIndex === -1) insertionIndex = filteredLines.length;

  const before = joinLines(filteredLines.slice(0, insertionIndex));
  const after = joinLines(filteredLines.slice(insertionIndex));
  const rootPrefix = before !== "" && !endsWithNewline(before) ? eol : "";
  const managed = `${rootBlock}${providerBlock}`;
  return `${before}${rootPrefix}${managed}${after}`;
}

function renderRootBlock(settings, eol) {
  return [
    CONFIG_MARKERS.rootBegin,
    `model = ${tomlString(settings.model)}`,
    `model_provider = ${tomlString(settings.modelProvider)}`,
    `model_catalog_json = ${tomlString(settings.modelCatalogJson)}`,
    `model_reasoning_effort = ${tomlString(settings.modelReasoningEffort)}`,
    CONFIG_MARKERS.rootEnd,
    "",
  ].join(eol);
}

function renderProviderBlock(provider, eol) {
  const lines = [
    CONFIG_MARKERS.providerBegin,
    `[model_providers.${provider.id}]`,
    `name = ${tomlString(provider.name)}`,
    `base_url = ${tomlString(provider.baseUrl)}`,
    `wire_api = ${tomlString(provider.wireApi)}`,
    `requires_openai_auth = ${provider.requiresOpenAIAuth}`,
    `supports_websockets = ${provider.supportsWebsockets}`,
    `supports_standalone_web_search = ${provider.supportsStandaloneWebSearch}`,
  ];
  if (provider.envKey) lines.push(`env_key = ${tomlString(provider.envKey)}`);
  if (provider.envKeyInstructions) {
    lines.push(`env_key_instructions = ${tomlString(provider.envKeyInstructions)}`);
  }
  appendInteger(lines, "request_max_retries", provider.requestMaxRetries);
  appendInteger(lines, "stream_max_retries", provider.streamMaxRetries);
  appendInteger(lines, "stream_idle_timeout_ms", provider.streamIdleTimeoutMs);
  lines.push(CONFIG_MARKERS.providerEnd, "");
  return lines.join(eol);
}

function renderHistoricalModelBridgeCompatibility(eol, configExisted) {
  return [
    HISTORICAL_MODEL_BRIDGE_MARKERS.begin,
    "# Preserves historical chat parsing after PickerMux is removed.",
    `${HISTORICAL_MODEL_BRIDGE_CONFIG_EXISTED_PREFIX}${configExisted ? "true" : "false"}`,
    `[model_providers.${HISTORICAL_MODEL_BRIDGE_PROVIDER_ID}]`,
    'name = "PickerMux (uninstalled)"',
    'base_url = "http://127.0.0.1:0/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "supports_standalone_web_search = false",
    "request_max_retries = 0",
    "stream_max_retries = 0",
    HISTORICAL_MODEL_BRIDGE_MARKERS.end,
    "",
  ].join(eol);
}

function appendHistoricalModelBridgeCompatibility(source, configExisted) {
  const eol = detectEol(splitLines(source));
  const compatibility = renderHistoricalModelBridgeCompatibility(
    eol,
    configExisted,
  );
  return source === "" ? compatibility : `${source}${eol}${compatibility}`;
}

function removeHistoricalModelBridgeCompatibility(source, providerId) {
  if (providerId !== HISTORICAL_MODEL_BRIDGE_PROVIDER_ID) {
    return { text: source, removed: false };
  }
  const eol = detectEol(splitLines(source));
  for (const configExisted of [true, false]) {
    const block = renderHistoricalModelBridgeCompatibility(eol, configExisted);
    const suffix = `${eol}${block}`;
    if (source === block) {
      return { text: "", removed: true, configExisted };
    }
    if (configExisted && source.endsWith(suffix)) {
      return {
        text: source.slice(0, -suffix.length),
        removed: true,
        configExisted,
      };
    }
  }
  return { text: source, removed: false };
}

function removeDeactivatedHistoricalCompatibility(source, state) {
  const historical = removeHistoricalModelBridgeCompatibility(source, state.providerId);
  if (historical.removed || state.configExisted !== false) return historical;
  // The opaque retained receipt proves absent-config provenance even when
  // preserved user tables now precede the exact inert suffix.
  const eol = detectEol(splitLines(source));
  const suffix = `${eol}${renderHistoricalModelBridgeCompatibility(eol, false)}`;
  return source.endsWith(suffix)
    ? { text: source.slice(0, -suffix.length), removed: true, configExisted: false }
    : historical;
}

function assertNoHistoricalModelBridgeMarkerComments(source) {
  if (
    scanTomlLexicalLines(source).comments.some((comment) =>
      comment.includes(HISTORICAL_MODEL_BRIDGE_MARKER_NAMESPACE),
    )
  ) {
    throw failure(
      "HISTORICAL_MARKER_CONFLICT",
      "Historical model_bridge compatibility markers are present but do not match the exact removable end-of-file block.",
    );
  }
}

function appendInteger(lines, key, value) {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw failure("INVALID_ARGUMENT", `${key} must be a non-negative integer.`);
  }
  lines.push(`${key} = ${value}`);
}

function tomlString(value) {
  requireNonEmptyString(value, "TOML string value");
  return JSON.stringify(value)
    .replace(/\\b/g, "\\u0008")
    .replace(/\\f/g, "\\u000c");
}

function inspectUnownedPickerServiceTier(block, source) {
  const assignments = [];
  let rootScope = true;
  let tableConflict = false;
  for (const line of scanTomlLexicalLines(source).lines) {
    const code = line.code.trim();
    if (isTableHeader(code)) {
      if (parseTomlTablePath(code)?.[0] === "service_tier") tableConflict = true;
      rootScope = false;
      continue;
    }
    if (rootScope && parseTomlAssignmentKeyPath(code)?.[0] === "service_tier") {
      assignments.push(line);
    }
  }
  const inserted = assignments.filter((line) => line.start >= block.start && line.end <= block.end);
  if (inserted.length === 0) return { safe: true, retainedText: "", starts: new Set() };
  const line = inserted[0];
  const match = /^\s*service_tier\s*=\s*(.+?)\s*$/u.exec(line.code);
  const value = match ? parseSimpleTomlString(match[1]) : undefined;
  const safe = !tableConflict && assignments.length === 1 && inserted.length === 1 &&
    typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
  return {
    safe,
    retainedText: safe ? `${line.raw}${line.eol}` : "",
    starts: new Set(safe ? [line.start] : []),
  };
}

function inspectPickerMutableRoot(block, state, source) {
  const lines = splitLines(block.text);
  // Codex may insert its unowned tier preference between our root markers.
  // Exclude only that proven root assignment; every other byte must still
  // reproduce the original receipt, and lifecycle removal must retain it.
  const serviceTier = inspectUnownedPickerServiceTier(block, source);
  let model;
  let modelReasoningEffort;
  let modelCount = 0;
  let reasoningCount = 0;
  const normalized = lines.filter((line) => !serviceTier.starts.has(block.start + line.start)).map((line) => {
    const modelMatch = /^model\s*=\s*("(?:[^"\\]|\\.)*")\s*$/u.exec(line.raw);
    if (modelMatch) {
      modelCount += 1;
      try {
        model = JSON.parse(modelMatch[1]);
      } catch {
        return line;
      }
      return { ...line, raw: `model = ${tomlString(state.model)}` };
    }

    const reasoningMatch = /^model_reasoning_effort\s*=\s*("(?:[^"\\]|\\.)*")\s*$/u.exec(
      line.raw,
    );
    if (reasoningMatch) {
      reasoningCount += 1;
      try {
        modelReasoningEffort = JSON.parse(reasoningMatch[1]);
      } catch {
        return line;
      }
      return {
        ...line,
        raw: `model_reasoning_effort = ${tomlString(state.modelReasoningEffort)}`,
      };
    }
    return line;
  });

  const valuesAreSafe =
    modelCount === 1 &&
    reasoningCount === 1 &&
    typeof model === "string" &&
    model.length > 0 &&
    !/[\u0000-\u001f\u007f]/u.test(model) &&
    PICKER_REASONING_EFFORTS.has(modelReasoningEffort);
  return {
    safe:
      valuesAreSafe &&
      serviceTier.safe &&
      sha256(joinLines(normalized)) === state.blocks.root.sha256,
    model: valuesAreSafe ? model : undefined,
    modelReasoningEffort: valuesAreSafe ? modelReasoningEffort : undefined,
    retainedText: serviceTier.retainedText,
  };
}

function renderPickerSelectionRoot(block, model, modelReasoningEffort) {
  let modelCount = 0;
  let reasoningCount = 0;
  const replaced = splitLines(block.text).map((line) => {
    if (/^model\s*=\s*"(?:[^"\\]|\\.)*"\s*$/u.test(line.raw)) {
      modelCount += 1;
      return { ...line, raw: `model = ${tomlString(model)}` };
    }
    if (
      /^model_reasoning_effort\s*=\s*"(?:[^"\\]|\\.)*"\s*$/u.test(
        line.raw,
      )
    ) {
      reasoningCount += 1;
      return {
        ...line,
        raw: `model_reasoning_effort = ${tomlString(modelReasoningEffort)}`,
      };
    }
    return line;
  });
  if (modelCount !== 1 || reasoningCount !== 1) {
    throw failure(
      "MANAGED_BLOCK_MODIFIED",
      "Managed picker root does not contain exactly one mutable selection pair.",
    );
  }
  return joinLines(replaced);
}

function locateOwnedBlocks(source, state) {
  if (!state.blocks.webSearch &&
    [CONFIG_MARKERS.webSearchBegin, CONFIG_MARKERS.webSearchEnd].some((marker) => source.includes(marker))) {
    throw failure("ORPHANED_MANAGED_BLOCK", "Managed web search markers have no ownership receipt.");
  }
  const provider = locateBlock(
    source,
    state.blocks.provider,
    "provider",
    {
      recoverMissingProviderEnd: true,
      providerId: state.providerId,
    },
  );
  const webSearch = state.blocks.webSearch
    ? locateBlock(source, state.blocks.webSearch, "webSearch")
    : undefined;
  if (webSearch) {
    const lexicalLines = scanTomlLexicalLines(source).lines;
    const markerLines = lexicalLines.filter((line) =>
      line.start === webSearch.start || line.end === webSearch.end);
    if (markerLines.length !== 2 || markerLines.some((line) => line.commentStart !== 0)) {
      throw failure("MANAGED_BLOCK_BOUNDARY_INVALID", "Managed web search boundaries must be TOML comments.");
    }
    let scope = [];
    for (const line of lexicalLines) {
      if (line.start >= webSearch.start) break;
      if (isTableHeader(line.code.trim())) {
        scope = parseTomlTablePath(line.code.trim());
      }
    }
    const expected = state.blocks.webSearch.scope === "root" ? [] : ["features"];
    if (JSON.stringify(scope) !== JSON.stringify(expected)) {
      throw failure("MANAGED_BLOCK_BOUNDARY_INVALID", "Managed web search feature changed table scope.");
    }
  }
  return {
    root: locateBlock(source, state.blocks.root, "root"),
    provider,
    ...(webSearch ? { webSearch } : {}),
    recoveredMarkers: provider.recoveredEnd ? ["provider-end"] : [],
  };
}

function ownedBlockNames(state) {
  return ["root", "provider", ...(state.blocks.webSearch ? ["webSearch"] : [])];
}

function hasSafeProviderScopeTail(source, providerEnd) {
  const tail = source.slice(providerEnd);
  for (const line of splitLines(tail)) {
    const code = stripTomlComment(line.raw).trim();
    if (code === "") continue;
    return isTableHeader(line.raw);
  }
  return true;
}

function locateBlock(
  source,
  definition,
  name,
  {
    recoverMissingProviderEnd = false,
    providerId = undefined,
  } = {},
) {
  const lines = splitLines(source);
  const begins = lines.filter((line) => line.raw === definition.begin);
  const ends = lines.filter((line) => line.raw === definition.end);
  if (
    begins.length === 1 &&
    ends.length === 1 &&
    begins[0].start < ends[0].start
  ) {
    const start = begins[0].start;
    const end = ends[0].end;
    return {
      start,
      end,
      text: source.slice(start, end),
      eol: begins[0].eol || detectEol(lines),
      recoveredEnd: false,
    };
  }
  if (
    recoverMissingProviderEnd &&
    begins.length === 1 &&
    ends.length === 0
  ) {
    const recovered = recoverMissingProviderEndBlock({
      source,
      lines,
      begin: begins[0],
      definition,
      providerId,
    });
    if (recovered) return recovered;
  }
  throw failure(
    "MANAGED_BLOCK_BOUNDARY_INVALID",
    `Managed ${name} block boundaries are missing, duplicated, or out of order.`,
    { name, begins: begins.length, ends: ends.length },
  );
}

function recoverMissingProviderEndBlock({
  source,
  lines,
  begin,
  definition,
  providerId,
}) {
  if (
    definition.begin !== CONFIG_MARKERS.providerBegin ||
    definition.end !== CONFIG_MARKERS.providerEnd ||
    typeof definition.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(definition.sha256) ||
    typeof providerId !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(providerId)
  ) {
    return null;
  }

  const beginIndex = lines.indexOf(begin);
  let providerHeaderIndex = -1;
  for (let index = beginIndex + 1; index < lines.length; index += 1) {
    const code = stripTomlComment(lines[index].raw).trim();
    if (code === "") continue;
    providerHeaderIndex = index;
    break;
  }
  if (
    providerHeaderIndex === -1 ||
    stripTomlComment(lines[providerHeaderIndex].raw).trim() !==
      `[model_providers.${providerId}]`
  ) {
    return null;
  }

  const nextTableIndex = lines.findIndex(
    (line, index) =>
      index > providerHeaderIndex && isTableHeader(line.raw),
  );
  const boundaryIndex = nextTableIndex === -1 ? lines.length : nextTableIndex;
  const boundary = lines[boundaryIndex]?.start ?? source.length;
  const start = begin.start;
  const eol = begin.eol || detectEol(lines);
  const candidates = [];
  // An editor can erase only the marker text and leave its empty line. Do not
  // guess which whitespace belongs to the block: accept only the one safe line
  // boundary whose virtual block is bound by the private receipt digest.
  for (
    let index = providerHeaderIndex + 1;
    index <= boundaryIndex;
    index += 1
  ) {
    const end = lines[index]?.start ?? source.length;
    if (!hasSafeProviderScopeTail(source, end)) continue;
    if (containsAnyManagedMarker(source.slice(end, boundary))) continue;
    const actualText = source.slice(start, end);
    const markerPrefix = endsWithNewline(actualText) ? "" : eol;
    const recoveredText =
      `${actualText}${markerPrefix}${definition.end}${eol}`;
    if (sha256(recoveredText) === definition.sha256) {
      candidates.push({ end, recoveredText });
    }
  }
  if (candidates.length !== 1) return null;
  const [{ end, recoveredText }] = candidates;

  return {
    start,
    end,
    text: recoveredText,
    eol,
    recoveredEnd: true,
  };
}

function assertNoManagedMarkers(source) {
  if (containsAnyManagedMarker(source)) {
    throw failure(
      "EXISTING_MANAGED_MARKER",
      "A managed model-router marker already exists; refusing to overwrite it.",
    );
  }
}

function containsAnyManagedMarker(source) {
  return [...Object.values(CONFIG_MARKERS), ...LEGACY_P1_MARKERS].some((marker) =>
    source.includes(marker),
  );
}

function assertStateMatchesConfig(state, configPath) {
  if (resolve(state.configPath) !== configPath) {
    throw failure(
      "STATE_CONFIG_MISMATCH",
      `State belongs to another config: ${state.configPath}`,
    );
  }
}

function assertManagedBackupPath(backupPath, settings) {
  if (typeof backupPath !== "string" || !backupPath.trim()) {
    throw failure(
      "INVALID_STATE",
      "Managed configuration state does not contain a backup path.",
    );
  }
  const resolvedBackupPath = resolve(backupPath);
  const stamp = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z`;
  const backupNamePattern = new RegExp(
    `^${escapeRegex(basename(settings.configPath))}\\.lm-studio-model-router\\.${stamp}\\.bak(?:\\.[1-9]\\d{0,3})?$`,
    "u",
  );
  if (
    backupPath !== resolvedBackupPath ||
    dirname(resolvedBackupPath) !== settings.backupDirectory ||
    !backupNamePattern.test(basename(resolvedBackupPath))
  ) {
    throw failure(
      "UNSAFE_BACKUP_PATH",
      "Managed configuration state references a path outside the exact PickerMux backup directory.",
    );
  }
  return resolvedBackupPath;
}

function ownershipDetails(receipt, expected = undefined) {
  const details = ownershipReceiptDetails.get(receipt);
  if (!details) {
    throw new TypeError(
      "A managed configuration ownership receipt issued by this module is required",
    );
  }
  if (
    expected &&
    (receipt.configPath !== expected.configPath ||
      receipt.statePath !== expected.statePath ||
      receipt.backupDirectory !== expected.backupDirectory)
  ) {
    throw failure(
      "OWNERSHIP_RECEIPT_MISMATCH",
      "Managed configuration ownership receipt does not match uninstall paths.",
    );
  }
  return details;
}

async function readOwnershipBackup(receipt, { cache = true } = {}) {
  const details = ownershipDetails(receipt);
  if (!details.state) {
    throw failure(
      "STATE_MISSING",
      "Managed configuration state does not exist.",
    );
  }
  const backupPath = assertManagedBackupPath(
    details.state.backupPath,
    details.settings,
  );
  let captured;
  if (details.backupDirectoryInventory) {
    captured = details.readBackupImpl
      ? await details.readBackupImpl(backupPath)
      : await readInventoriedPickerMuxBackup({
          inventory: details.backupDirectoryInventory,
          backupPath,
        });
  } else if (details.readBackupImpl) {
    captured = await details.readBackupImpl(backupPath);
  } else {
    captured = await readOwnedRegularFile(backupPath, {
      requirePrivate: false,
      label: "PickerMux configuration backup",
      expectedSnapshot: cache
        ? undefined
        : details.backupFile?.snapshot,
    });
    if (!captured) {
      throw failure(
        "BACKUP_UNREADABLE",
        "Exact managed configuration backup is missing.",
      );
    }
  }
  if (captured.sha256 !== details.state.sourceSha256) {
    throw failure(
      "BACKUP_MISMATCH",
      "Exact managed configuration backup checksum does not match installation state.",
    );
  }
  const result = Object.freeze({
    path: backupPath,
    contents: Buffer.from(captured.contents),
    sha256: captured.sha256,
    snapshot: captured.snapshot,
  });
  if (cache) details.backupFile = result;
  return result;
}

function ownershipCommitGuard(receipt, beforeConfigCommit) {
  return async () => {
    if (beforeConfigCommit) await beforeConfigCommit();
    await revalidateManagedConfigOwnership(receipt);
  };
}

async function removeOwnedStateFile(receipt) {
  const details = ownershipDetails(receipt);
  if (!details.stateFile) return;
  await revalidateManagedConfigOwnership(receipt);
  const statePath = details.settings.statePath;
  const quarantinePath = `${dirname(statePath)}/.${basename(statePath)}.uninstall-${process.pid}-${randomUUID()}`;
  if (await lstatOptional(quarantinePath)) {
    throw failure(
      "STATE_REMOVE_FAILED",
      "Managed configuration state quarantine already exists.",
    );
  }
  await rename(statePath, quarantinePath);
  try {
    const staged = await readOwnedRegularFile(quarantinePath, {
      requirePrivate: true,
      label: "PickerMux configuration state quarantine",
    });
    if (
      !staged ||
      !sameStableFileIdentity(
        details.stateFile.snapshot,
        staged.snapshot,
      ) ||
      details.stateFile.sha256 !== staged.sha256
    ) {
      throw failure(
        "STATE_CHANGED_CONCURRENTLY",
        "Managed configuration state changed during removal.",
      );
    }
    await unlink(quarantinePath);
    if (await lstatOptional(quarantinePath)) {
      throw failure(
        "STATE_REMOVE_FAILED",
        "Managed configuration state quarantine could not be removed.",
      );
    }
  } catch (error) {
    if (
      !(await lstatOptional(statePath)) &&
      (await lstatOptional(quarantinePath))
    ) {
      await rename(quarantinePath, statePath).catch(() => {});
    }
    throw error;
  }
}

async function rollbackConfigAfterStateRemovalFailure({
  configPath,
  installedConfig,
  restoredContents,
  configWasRemoved,
}) {
  const expectedSource = configWasRemoved
    ? { exists: false, sha256: sha256(Buffer.alloc(0)) }
    : {
        exists: true,
        sha256: sha256(restoredContents),
      };
  await atomicWrite(
    configPath,
    installedConfig.bytes,
    installedConfig.mode,
    { expectedSource },
  );
}

function fileSnapshot(stats) {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    uid: stats.uid,
    mode: stats.mode & 0o777,
    nlink: stats.nlink,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  });
}

function sameFileSnapshot(left, right) {
  return (
    sameStableFileIdentity(left, right) &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameStableFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function assertCurrentUserOwner(stats, target, label) {
  const uid = typeof process.getuid === "function"
    ? process.getuid()
    : undefined;
  if (uid !== undefined && stats.uid !== uid) {
    throw failure(
      "UNSAFE_MANAGED_FILE",
      `${label} is not owned by the current user: ${target}`,
    );
  }
}

async function readOwnedRegularFile(
  target,
  {
    allowMissing = false,
    requirePrivate,
    label,
    expectedSnapshot = undefined,
  },
) {
  let handle;
  let pathObserved = false;
  try {
    const [initialPathStats, parentStats] = await Promise.all([
      lstat(target),
      lstat(dirname(target)),
    ]);
    pathObserved = true;
    if (
      initialPathStats.isSymbolicLink() ||
      !initialPathStats.isFile() ||
      initialPathStats.nlink !== 1
    ) {
      throw failure(
        "UNSAFE_MANAGED_FILE",
        `${label} is not an exact regular file: ${target}`,
      );
    }
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
      throw failure(
        "UNSAFE_MANAGED_FILE",
        `${label} parent is not a real directory: ${dirname(target)}`,
      );
    }
    assertCurrentUserOwner(initialPathStats, target, label);
    assertCurrentUserOwner(parentStats, dirname(target), `${label} parent`);
    if (
      ((parentStats.mode & 0o077) !== 0 ||
        (requirePrivate && (initialPathStats.mode & 0o077) !== 0))
    ) {
      throw failure(
        "UNSAFE_MANAGED_FILE",
        `${label} permissions are not private: ${target}`,
      );
    }
    const initialSnapshot = fileSnapshot(initialPathStats);
    if (
      expectedSnapshot &&
      !sameFileSnapshot(expectedSnapshot, initialSnapshot)
    ) {
      throw failure(
        "MANAGED_FILE_CHANGED",
        `${label} changed after ownership inventory.`,
      );
    }
    handle = await open(target, PRIVATE_READ_FLAGS);
    const [stats, pathStats] = await Promise.all([
      handle.stat(),
      lstat(target),
    ]);
    if (
      !stats.isFile() ||
      pathStats.isSymbolicLink() ||
      !pathStats.isFile() ||
      stats.dev !== pathStats.dev ||
      stats.ino !== pathStats.ino ||
      stats.nlink !== 1 ||
      pathStats.nlink !== 1 ||
      !sameFileSnapshot(initialSnapshot, fileSnapshot(stats)) ||
      !sameFileSnapshot(initialSnapshot, fileSnapshot(pathStats))
    ) {
      throw failure(
        "MANAGED_FILE_CHANGED",
        `${label} changed after ownership validation.`,
      );
    }
    assertCurrentUserOwner(stats, target, label);
    assertCurrentUserOwner(pathStats, target, label);
    const contents = await handle.readFile();
    const [confirmed, confirmedPath] = await Promise.all([
      handle.stat(),
      lstat(target),
    ]);
    if (
      !sameFileSnapshot(initialSnapshot, fileSnapshot(confirmed)) ||
      !sameFileSnapshot(initialSnapshot, fileSnapshot(confirmedPath)) ||
      contents.length !== confirmed.size
    ) {
      throw failure(
        "MANAGED_FILE_CHANGED",
        `${label} changed while it was read: ${target}`,
      );
    }
    return Object.freeze({
      contents: Buffer.from(contents),
      sha256: sha256(contents),
      snapshot: fileSnapshot(confirmed),
    });
  } catch (error) {
    if (
      allowMissing &&
      error?.code === "ENOENT" &&
      !pathObserved &&
      !handle
    ) return null;
    if (error?.code === "ELOOP" || error?.code === "ENOENT") {
      throw failure(
        "UNSAFE_MANAGED_FILE",
        `${label} is missing or changed: ${target}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function lstatOptional(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function allocateBackupPath(configPath, backupDirectory, date) {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  const base = `${resolve(backupDirectory)}/${basename(configPath)}.lm-studio-model-router.${stamp}.bak`;
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}.${suffix}`;
    if (!(await pathExists(candidate))) return candidate;
  }
  throw failure("BACKUP_NAME_EXHAUSTED", "Could not allocate a backup filename.");
}

async function writeExactBackup(path, bytes, mode) {
  await ensurePrivateDirectory(dirname(path));
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, mode);
}

async function atomicWrite(
  path,
  contents,
  mode,
  { expectedSource = undefined, beforeCommit = undefined } = {},
) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${directory}/.${basename(path)}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await chmod(temporary, mode);
    if (beforeCommit) await beforeCommit();
    if (expectedSource) await assertSourceUnchanged(path, expectedSource);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function atomicRemove(
  path,
  { expectedSource = undefined, beforeCommit = undefined } = {},
) {
  if (beforeCommit) await beforeCommit();
  if (expectedSource) await assertSourceUnchanged(path, expectedSource);
  await unlink(path);
}

async function assertSourceUnchanged(path, expected) {
  let current;
  try {
    current = await readConfigFile(path);
  } catch (error) {
    throw failure(
      "CONFIG_CHANGED_CONCURRENTLY",
      `Refusing to replace concurrently changed config: ${path}`,
      { expected, cause: error },
    );
  }
  const actual = {
    exists: current.exists,
    sha256: sha256(current.bytes),
  };
  if (
    actual.exists !== expected.exists ||
    actual.sha256 !== expected.sha256
  ) {
    throw failure(
      "CONFIG_CHANGED_CONCURRENTLY",
      `Refusing to replace concurrently changed config: ${path}`,
      { expected, actual },
    );
  }
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function splitLines(source) {
  if (source === "") return [];
  const lines = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (match[0] === "") break;
    const start = match.index;
    lines.push({
      raw: match[1],
      eol: match[2],
      start,
      end: start + match[0].length,
    });
    if (match[2] === "") break;
  }
  return lines;
}

function joinLines(lines) {
  return lines.map((line) => `${line.raw}${line.eol}`).join("");
}

function detectEol(lines) {
  return lines.find((line) => line.eol)?.eol ?? "\n";
}

function endsWithNewline(value) {
  return /(?:\r\n|\n|\r)$/.test(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function snapshotOf(config) {
  return {
    exists: config.exists,
    sha256: sha256(config.bytes),
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function failure(code, message, details) {
  return new ConfigManagerError(code, message, details);
}
