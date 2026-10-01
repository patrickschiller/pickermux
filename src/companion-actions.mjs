import path from "node:path";

import { CompanionControlError, parseCompanionRequest } from "./companion-control.mjs";

const READ_ONLY = new Set(["diagnose", "update-check", "configuration-preview"]);
const STOPPED_DESKTOP = new Set(["refresh", "certify", "update", "configuration-apply"]);

function unavailable(snapshot) {
  if (snapshot.recovery.status === "pending") return "RECOVERY_PENDING";
  if (snapshot.desktop.status === "running") return "CODEX_RUNNING";
  if (["modified", "inconsistent", "invalid-state", "unreadable-config", "orphaned-managed-block", "suspension-conflict", "integration-conflict"].includes(snapshot.managedConfig.status) || snapshot.integration.status === "conflict") return "CONFIGURATION_CONFLICT";
  if (snapshot.accountCache.status === "refresh-required") return "ACCOUNT_CACHE_REFRESH_REQUIRED";
  if (snapshot.compatibility.status === "update-required") return "UPDATE_REQUIRED";
  return "ACTION_FAILED";
}

/** The status is authoritative at execution time, never supplied by the GUI. */
export async function executeCompanionAction(request, {
  statusImpl,
  validateDistributionImpl,
  sourceRoot,
  distributionPaths,
  withLockImpl,
  handlers,
  onProgress = () => {},
} = {}) {
  const parsed = parseCompanionRequest(typeof request === "string" ? request : JSON.stringify(request));
  const { action } = parsed;
  if (typeof handlers?.[action] !== "function" || typeof statusImpl !== "function") throw new CompanionControlError("INVALID_REQUEST");
  const invoke = async () => {
    const snapshot = await statusImpl();
    if (!snapshot.actions.includes(action)) throw new CompanionControlError(unavailable(snapshot));
    if (STOPPED_DESKTOP.has(action) && snapshot.desktop.status !== "stopped") throw new CompanionControlError("CODEX_RUNNING");
    // Bundled bootstrap may set up a distribution, but cannot control another
    // installed CLI's service or launch a recovery worker on its behalf.
    if (!READ_ONLY.has(action) && action !== "configuration-apply") {
      const distribution = await validateDistributionImpl({ paths: distributionPaths });
      if (distribution?.installed !== true || typeof distribution.activeDirectory !== "string" || typeof sourceRoot !== "string" || path.resolve(distribution.activeDirectory) !== path.resolve(sourceRoot)) {
        throw new CompanionControlError("DISTRIBUTION_INVALID");
      }
    }
    onProgress({ phase: "started" });
    const result = await handlers[action](parsed, { onProgress, snapshot });
    onProgress({ phase: "complete" });
    return result;
  };
  // setup/update and recovery already own their complete installation lock.
  // Acquiring it here would deadlock their existing transactional entry points.
  if (READ_ONLY.has(action) || ["update", "configuration-apply", "recover"].includes(action)) return invoke();
  if (typeof withLockImpl !== "function") throw new CompanionControlError("INVALID_REQUEST");
  return withLockImpl(distributionPaths, invoke);
}
