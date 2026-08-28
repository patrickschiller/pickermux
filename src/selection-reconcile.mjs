import {
  getConfigStatus,
  restoreManagedPickerDefaults,
  setManagedPickerSelection,
} from "./config-manager.mjs";
import { splitMixedCatalog } from "./provider-registry.mjs";

export function assertCatalogSelection(catalog, model, reasoningEffort) {
  const selected = catalog.models.find((entry) => entry.slug === model);
  if (!selected) {
    throw new Error(`Generated catalog is missing selected model ${model}`);
  }
  const supported = new Set(
    Array.isArray(selected.supported_reasoning_levels)
      ? selected.supported_reasoning_levels.map((level) => level?.effort)
      : [],
  );
  if (reasoningEffort && supported.size > 0 && !supported.has(reasoningEffort)) {
    throw new Error(
      `Selected model ${model} does not support reasoning effort ${reasoningEffort}`,
    );
  }
  return true;
}

/**
 * Keep any healthy selection untouched. If a successful external snapshot or
 * an account-catalog refresh removes the selected model (or its effort),
 * restore the immutable install defaults before the new catalog is published.
 */
export async function reconcileSelectedCatalogModel({
  config,
  currentCatalog,
  nextCatalog,
  configPath,
  statePath,
  statusImpl = getConfigStatus,
  restoreImpl = restoreManagedPickerDefaults,
  setSelectionImpl = setManagedPickerSelection,
} = {}) {
  const status = await statusImpl({ configPath, statePath });
  if (!status.installed || !status.healthy) {
    throw new Error(
      `Managed picker must be healthily installed before catalog selection reconciliation (${status.status})`,
    );
  }

  try {
    assertCatalogSelection(
      nextCatalog,
      status.model,
      status.modelReasoningEffort,
    );
    return {
      changed: false,
      model: status.model,
      modelReasoningEffort: status.modelReasoningEffort,
    };
  } catch (selectionError) {
    // Validate the old catalog classification before changing a native or
    // external selection. Unclaimed namespaced entries still fail closed.
    splitMixedCatalog(currentCatalog, config);

    assertCatalogSelection(
      nextCatalog,
      config.bridge.defaultModel,
      config.bridge.reasoningEffort,
    );
    const update = await restoreImpl({
      configPath,
      statePath,
      defaultModel: config.bridge.defaultModel,
      defaultModelReasoningEffort: config.bridge.reasoningEffort,
      expectedModel: status.model,
      expectedModelReasoningEffort: status.modelReasoningEffort,
    });
    return {
      ...update,
      reason: selectionError.message,
      rollback:
        update.changed
          ? () =>
              setSelectionImpl({
                configPath,
                statePath,
                model: update.previousModel,
                modelReasoningEffort:
                  update.previousModelReasoningEffort,
                expectedModel: update.model,
                expectedModelReasoningEffort: update.modelReasoningEffort,
              })
          : undefined,
    };
  }
}
