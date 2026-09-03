import { discoverBridgeModels } from "./bridge-discovery.mjs";
import {
  buildMixedCodexCatalog,
  replaceCatalogAtomicIfCurrent,
  writeCatalogAtomicWithReceipt,
} from "./catalog.mjs";
import {
  buildProviderRegistry,
  splitMixedCatalog,
} from "./provider-registry.mjs";
import { isCodexDesktopRunning } from "./codex-desktop-state.mjs";

export const LOADED_MODEL_POLL_INTERVAL_MS = 10_000;
export const DESKTOP_STATE_POLL_INTERVAL_MS = 2_000;

export function hasLoadedModelDiscovery(config) {
  return config.providers.some(
    (provider) =>
      provider.kind === "lmstudio-responses" &&
      provider.discovery?.mode === "loaded",
  );
}

function assertMatchingRegistry(catalog, registry) {
  const catalogSlugs = catalog.models.map((model) => model.slug);
  const routeSlugs = registry.listModels().map((model) => model.id);
  if (JSON.stringify(routeSlugs) !== JSON.stringify(catalogSlugs)) {
    throw new Error(
      `Catalog and route registry differ: catalog=${catalogSlugs.join(", ")}; routes=${routeSlugs.join(", ")}`,
    );
  }
}

function normalizeCertificationCapabilities(value) {
  if (Array.isArray(value)) {
    return {
      certifiedModelSlugs: value,
      efficientFidelityModelSlugs: [],
    };
  }
  if (
    value === null ||
    typeof value !== "object" ||
    !Array.isArray(value.certifiedModelSlugs) ||
    !Array.isArray(value.efficientFidelityModelSlugs)
  ) {
    throw new Error("Certification resolver returned an invalid capability set");
  }
  return value;
}

/**
 * Build and validate the complete next catalog/registry pair before publishing
 * either of them. The current mixed catalog is the last-known-good native base.
 */
export async function syncBridgeCatalog({
  config,
  currentCatalog,
  catalogPath,
  registryController,
  discoverImpl = discoverBridgeModels,
  writeImpl = writeCatalogAtomicWithReceipt,
  rollbackWriteImpl = replaceCatalogAtomicIfCurrent,
  reconcileSelectionImpl = async () => ({ changed: false }),
  certificationResolver = async () => [],
  assertPublishAllowed = async () => {},
} = {}) {
  if (!registryController || typeof registryController.replace !== "function") {
    throw new TypeError("A reloadable registry controller is required");
  }
  if (typeof assertPublishAllowed !== "function") {
    throw new TypeError("Catalog publication guard must be a function");
  }
  if (typeof writeImpl !== "function" || typeof rollbackWriteImpl !== "function") {
    throw new TypeError("Catalog publication dependencies must be functions");
  }
  const { nativeCatalog } = splitMixedCatalog(currentCatalog, config);
  const discovery = await discoverImpl({ config });
  const {
    certifiedModelSlugs,
    efficientFidelityModelSlugs,
  } = normalizeCertificationCapabilities(
    await certificationResolver(discovery.models),
  );
  const nextCatalog = buildMixedCodexCatalog({
    discoveredModels: discovery.models,
    bundledCatalog: nativeCatalog,
    nativeCatalog,
    certifiedModelSlugs,
    efficientFidelityModelSlugs,
  });
  const nextRegistry = buildProviderRegistry({
    mixedCatalog: nextCatalog,
    config,
    discoveredModels: discovery.models,
  });
  assertMatchingRegistry(nextCatalog, nextRegistry);

  const changed = JSON.stringify(nextCatalog) !== JSON.stringify(currentCatalog);
  let selection;
  let catalogPublished = false;
  let catalogReceipt;
  try {
    await assertPublishAllowed();
    selection = await reconcileSelectionImpl({
      config,
      currentCatalog,
      nextCatalog,
    });
    await assertPublishAllowed();
    if (changed) {
      catalogReceipt = await writeImpl(catalogPath, nextCatalog);
      catalogPublished = true;
    }
    await assertPublishAllowed();
    // No await is permitted between the final guard and registry publication.
    registryController.replace(nextRegistry);
  } catch (error) {
    const rollbackErrors = [];
    if (catalogPublished) {
      try {
        await rollbackWriteImpl(catalogPath, currentCatalog, {
          expectedCatalog: nextCatalog,
          expectedSnapshot: catalogReceipt?.snapshot,
        });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (selection?.changed && typeof selection.rollback === "function") {
      try {
        await selection.rollback();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Catalog publication failed and rollback also failed",
      );
    }
    throw error;
  }
  // A successful discovery can update non-catalog routing metadata such as a
  // wire-safe LM Studio reasoning profile even when the picker is unchanged.
  return {
    changed,
    catalog: nextCatalog,
    discovery,
    registry: nextRegistry,
    selection,
  };
}

/** Non-overlapping poller. Any failed cycle leaves both last-known-good states. */
export function createCatalogSynchronizer({
  config,
  initialCatalog,
  catalogPath,
  registryController,
  intervalMs = LOADED_MODEL_POLL_INTERVAL_MS,
  stateIntervalMs = DESKTOP_STATE_POLL_INTERVAL_MS,
  desktopRunningImpl = isCodexDesktopRunning,
  nowImpl = Date.now,
  syncImpl = syncBridgeCatalog,
  discoverImpl = discoverBridgeModels,
  reconcileSelectionImpl = async () => ({ changed: false }),
  certificationResolver = async () => [],
  assertPublishAllowed = async () => {},
  onUpdate = () => {},
  onError = () => {},
  onDesktopStateChange = () => {},
} = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250) {
    throw new TypeError("Catalog sync interval must be at least 250ms");
  }
  if (!Number.isSafeInteger(stateIntervalMs) || stateIntervalMs < 250) {
    throw new TypeError("Desktop state interval must be at least 250ms");
  }
  if (typeof desktopRunningImpl !== "function" || typeof nowImpl !== "function") {
    throw new TypeError("Desktop state and clock implementations are required");
  }
  let currentCatalog = initialCatalog;
  let running = false;
  let checkingState = false;
  let stopped = false;
  let lastDesktopRunning;
  let lastSyncAttemptAt;
  let timer;

  const sync = async () => {
    if (running || stopped) return { skipped: true };
    running = true;
    try {
      const result = await syncImpl({
        config,
        currentCatalog,
        catalogPath,
        registryController,
        reconcileSelectionImpl,
        certificationResolver,
        discoverImpl,
        assertPublishAllowed,
      });
      currentCatalog = result.catalog;
      if (result.changed) onUpdate(result);
      return result;
    } catch (error) {
      onError(error);
      return { error };
    } finally {
      running = false;
    }
  };

  const tick = async () => {
    if (stopped) return { skipped: true, reason: "stopped" };
    if (checkingState) return { skipped: true, reason: "state-check-busy" };
    checkingState = true;
    try {
      const previousDesktopRunning = lastDesktopRunning;
      const desktopRunning = await desktopRunningImpl();
      if (stopped) return { skipped: true, reason: "stopped" };
      if (typeof desktopRunning !== "boolean") {
        throw new Error("Codex Desktop state must be boolean");
      }
      if (desktopRunning !== previousDesktopRunning) {
        lastDesktopRunning = desktopRunning;
        try {
          onDesktopStateChange(desktopRunning);
        } catch (error) {
          // An observer must never change whether endpoint discovery is gated.
          onError(error);
        }
      }
      if (desktopRunning) {
        return { skipped: true, reason: "codex-desktop-running" };
      }

      const now = nowImpl();
      if (!Number.isFinite(now)) throw new Error("Catalog sync clock is invalid");
      const justStopped = previousDesktopRunning === true;
      if (
        !justStopped &&
        lastSyncAttemptAt !== undefined &&
        now - lastSyncAttemptAt < intervalMs
      ) {
        return { skipped: true, reason: "poll-interval" };
      }
      if (running) return { skipped: true, reason: "sync-busy" };
      lastSyncAttemptAt = now;
      return sync();
    } catch (error) {
      onError(error);
      return { error };
    } finally {
      checkingState = false;
    }
  };

  return Object.freeze({
    sync,
    tick,
    start() {
      if (timer || stopped) return;
      timer = setInterval(tick, stateIntervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  });
}
