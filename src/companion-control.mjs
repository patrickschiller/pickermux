import { execFile as execFileCallback } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify, TextDecoder } from "node:util";

import { inspectCodexAccountCache } from "./account-cache.mjs";
import { loadCompanionServiceConfig, readCompanionPrivateFile } from "./companion-config.mjs";
import { getBridgeServiceStatus } from "./bridge-runtime.mjs";
import { loadBundledCatalog, loadCodexClientVersion } from "./catalog.mjs";
import { checkCurrentCompatibility } from "./compatibility-manifest.mjs";
import { getConfigStatus, previewConfigIntegration } from "./config-manager.mjs";
import { isCodexDesktopRunning } from "./codex-desktop-state.mjs";
import { validateDistributionInstallation } from "./distribution-installer.mjs";
import { FULL_REFRESH_PHASES, readFullRefreshCheckpoint } from "./full-refresh.mjs";
import { readPickerMuxMetadata } from "./version.mjs";
import { isTokenUsageResetTime, projectTokenPerformanceSnapshot, projectTokenUsageSnapshot } from "./token-usage.mjs";
import { createUsageStore } from "./usage-store.mjs";

const execFile = promisify(execFileCallback);
const executeReadOnlyProbe = (file, argumentsList, options = {}) => execFile(file, argumentsList, { ...options, timeout: 4_000 });

export const COMPANION_SCHEMA_VERSION = 1;
export const COMPANION_MAX_REQUEST_BYTES = 4_096;
export const COMPANION_ACTIONS = Object.freeze([
  "refresh",
  "open",
  "recover",
  "certify",
  "diagnose",
  "update-check",
  "update",
  "configuration-preview",
  "configuration-apply",
  "integration-deactivate",
  "uninstall-preview",
  "uninstall",
  "usage-reset",
]);
export const COMPANION_UNINSTALL_CHANGES = Object.freeze([
  "restore-native-codex", "remove-integration", "remove-runtime", "remove-cli",
  "remove-certifications", "delete-backups", "delete-provider-credentials",
  "preserve-historical-chats", "preserve-user-settings",
]);
export const COMPANION_CONFIGURATION_CHANGES = Object.freeze([
  "replace-integration",
  "preserve-user-settings",
  "preserve-historical-chats",
  "create-backup",
  "restore-on-failure",
  "retain-explicit-provider",
  "normalize-owned-blocks",
  "reactivate-integration",
]);

// Root-only configuration inherits transport defaults that cannot express the
// bridge's zero-retry, HTTP/SSE-only contract. Existing model-bound search/tool/
// compaction gates cannot qualify a transport that already fails that boundary.
export const BUILTIN_PROVIDER_QUALIFICATION = Object.freeze({
  schemaVersion: 1,
  supportedMode: "explicit-provider",
  compactMode: "blocked",
  decision: "transport-controls-required",
  requirements: Object.freeze([
    Object.freeze({ code: "http-sse-only", outcome: "unproven" }),
    Object.freeze({ code: "request-retries-zero", outcome: "mismatch" }),
    Object.freeze({ code: "stream-retries-zero", outcome: "mismatch" }),
    Object.freeze({ code: "stream-idle-timeout", outcome: "unproven" }),
    Object.freeze({ code: "route-credential-isolation", outcome: "required" }),
    Object.freeze({ code: "native-byte-preservation", outcome: "required" }),
    Object.freeze({ code: "standalone-search", outcome: "required" }),
    Object.freeze({ code: "direct-tools", outcome: "required" }),
    Object.freeze({ code: "efficient-fidelity", outcome: "required" }),
    Object.freeze({ code: "encrypted-compaction-replay", outcome: "required" }),
    Object.freeze({ code: "historical-provider-identity", outcome: "required" }),
  ]),
});

const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z]{1,32}(?:[.-][0-9A-Za-z]{1,32}){0,4})?$/u;
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PREVIEW_TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const STATUS_ENUMS = Object.freeze({
  desktop: ["running", "stopped", "unknown"],
  installation: ["installed", "not-installed", "invalid", "unknown"],
  managedConfig: ["installed", "installed-marker-recovered", "not-installed", "deactivated", "suspended", "suspension-conflict", "integration-conflict", "modified", "inconsistent", "invalid-state", "unreadable-config", "orphaned-managed-block", "unknown"],
  service: ["running", "stopped", "not-installed", "runtime-missing", "unhealthy", "unreachable", "update-required", "unavailable", "unknown"],
  compatibility: ["not-installed", "compatible", "update-required", "unavailable", "unknown"],
  accountCache: ["ready", "refresh-required", "unavailable", "unknown"],
  recovery: ["idle", "pending", "completed", "unavailable", "unknown"],
  integration: ["pickermux", "ollama", "foreign", "none", "conflict", "unknown"],
});
const ISSUE_MESSAGES = Object.freeze({
  "metadata-unavailable": "The PickerMux version could not be verified.",
  "desktop-unavailable": "Codex Desktop state could not be verified.",
  "installation-unavailable": "The installed PickerMux distribution could not be verified.",
  "managedConfig-unavailable": "Managed configuration could not be verified.",
  "service-unavailable": "The PickerMux service could not be verified.",
  "compatibility-unavailable": "Codex compatibility could not be verified.",
  "accountCache-unavailable": "The Codex account cache could not be verified.",
  "recovery-unavailable": "Recovery state could not be verified.",
  "integration-unavailable": "The active integration could not be verified.",
  "configuration-conflict": "Configuration ownership requires review before changes.",
  "update-required": "Codex changed; check compatibility and account-cache recovery.",
  "account-cache-refresh-required": "The Codex account cache must be refreshed.",
  "recovery-pending": "An interrupted recovery requires explicit confirmation to resume.",
});
const ERROR_MESSAGES = Object.freeze({
  INVALID_REQUEST: "The companion request is not supported.",
  UNSUPPORTED_SCHEMA: "This companion protocol version is not supported.",
  CONFIRMATION_REQUIRED: "This action requires its explicit confirmation.",
  REQUEST_TOO_LARGE: "The companion request exceeds its size limit.",
  REQUEST_TIMEOUT: "The companion request did not finish in time.",
  BUSY: "Another PickerMux operation is already in progress.",
  CODEX_RUNNING: "Fully quit Codex Desktop before continuing.",
  ACCOUNT_CACHE_REFRESH_REQUIRED: "The Codex account cache requires recovery.",
  UPDATE_REQUIRED: "PickerMux compatibility must be updated before continuing.",
  CONFIGURATION_CONFLICT: "Configuration ownership requires review before changes.",
  RECOVERY_PENDING: "An interrupted recovery must be resumed before this action.",
  DISTRIBUTION_INVALID: "The installed PickerMux distribution could not be verified.",
  UPDATE_INVALID: "The update failed integrity or distribution validation.",
  UPDATE_UNAVAILABLE: "The update service could not be reached. Try again later.",
  UPDATE_UNSUPPORTED: "No supported update package is available for this system.",
  DOWNLOAD_REQUIRED: "Download the latest PickerMux DMG, replace the app, then update its installed backend from Settings.",
  CERTIFICATION_INCOMPLETE: "Certification did not complete. Unverified models remain conservative.",
  PROVIDER_UNAVAILABLE: "The configured external provider could not be reached. Check its server and loaded models, then retry activation.",
  PROVIDER_TIMEOUT: "Model discovery timed out. Check the external provider and retry activation.",
  PROVIDER_PERMISSION_DENIED: "macOS denied access during model discovery. Check PickerMux Companion permissions and retry activation.",
  PROVIDER_AUTH_REQUIRED: "The external provider rejected authentication. Review its configured credential and retry activation.",
  PROVIDER_RESPONSE_INVALID: "The external provider returned an unsupported model-discovery response. Check compatibility before retrying activation.",
  NO_LOADED_MODELS: "No usable external model is loaded. Load a model in the configured provider, then retry activation.",
  DEACTIVATION_FAILED: "Deactivation failed. The previous integration was retained or restored.",
  DEACTIVATION_ROLLBACK_FAILED: "Deactivation could not safely restore the previous integration. Keep Codex closed and inspect status before retrying.",
  UNINSTALL_CONFLICT: "The reviewed removal changed or configuration ownership needs review. Check status and review removal again.",
  UNINSTALL_PREFLIGHT_FAILED: "PickerMux removal ownership could not be verified. Keep Codex closed and review the installation.",
  PURGE_INCOMPLETE: "Full removal did not complete. Some provider credentials may already be absent. Keep Codex closed and review recovery before retrying.",
  UNINSTALL_FAILED: "PickerMux could not complete removal. Keep Codex closed and review the installation before retrying.",
  ACTION_FAILED: "The PickerMux action could not complete. Inspect companion status.",
});

export class CompanionControlError extends Error {
  constructor(code) {
    const supportedCode = Object.hasOwn(ERROR_MESSAGES, code) ? code : "ACTION_FAILED";
    super(ERROR_MESSAGES[supportedCode]);
    this.name = "CompanionControlError";
    this.code = supportedCode;
  }
}

function requestError(code = "INVALID_REQUEST") {
  return new CompanionControlError(code);
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, allowed, required = []) {
  return isPlainRecord(value) && Object.keys(value).every((key) => allowed.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key));
}

// JSON.parse discards duplicate keys. Parse the narrow object/primitive grammar
// first, so a repeated consent or action cannot acquire meaning from key order.
function parseUniqueJson(text) {
  let offset = 0;
  function whitespace() {
    while (/[\t\n\r ]/u.test(text[offset] ?? "\0")) offset += 1;
  }
  function string() {
    const start = offset;
    if (text[offset++] !== '"') throw requestError();
    while (offset < text.length) {
      const character = text[offset++];
      if (character === "\\") {
        offset += 1;
      } else if (character === '"') {
        try { return JSON.parse(text.slice(start, offset)); } catch { throw requestError(); }
      }
    }
    throw requestError();
  }
  function value(depth) {
    if (depth > 3) throw requestError();
    whitespace();
    if (text[offset] === '"') return string();
    if (text[offset] === "{") {
      offset += 1;
      whitespace();
      const record = Object.create(null);
      if (text[offset] === "}") { offset += 1; return record; }
      while (offset < text.length) {
        const key = string();
        if (Object.hasOwn(record, key)) throw requestError();
        whitespace();
        if (text[offset++] !== ":") throw requestError();
        record[key] = value(depth + 1);
        whitespace();
        const delimiter = text[offset++];
        if (delimiter === "}") return record;
        if (delimiter !== ",") throw requestError();
        whitespace();
      }
      throw requestError();
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(offset));
    if (!token) throw requestError();
    offset += token[0].length;
    return JSON.parse(token[0]);
  }
  const parsed = value(0);
  whitespace();
  if (offset !== text.length) throw requestError();
  return parsed;
}

export function parseCompanionRequest(input) {
  let bytes;
  if (typeof input === "string") {
    bytes = Buffer.from(input, "utf8");
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    throw requestError();
  }
  if (bytes.byteLength > COMPANION_MAX_REQUEST_BYTES) throw requestError("REQUEST_TOO_LARGE");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw requestError(); }
  const request = parseUniqueJson(text);
  if (!exactKeys(request, ["schemaVersion", "action", "confirmation", "previewToken"], ["schemaVersion", "action"])) throw requestError();
  if (request.schemaVersion !== COMPANION_SCHEMA_VERSION) throw requestError("UNSUPPORTED_SCHEMA");
  if (!COMPANION_ACTIONS.includes(request.action)) throw requestError();
  if (request.action === "recover") {
    const keys = ["quitCodexTwice", "interruptTasks", "invalidateCompaction"];
    if (!exactKeys(request.confirmation, keys, keys) || keys.some((key) => request.confirmation[key] !== true)) {
      throw requestError("CONFIRMATION_REQUIRED");
    }
  } else if (request.action === "configuration-apply") {
    if (!exactKeys(request.confirmation, ["replaceIntegration"], ["replaceIntegration"]) || request.confirmation.replaceIntegration !== true) {
      throw requestError("CONFIRMATION_REQUIRED");
    }
    if (typeof request.previewToken !== "string" || !PREVIEW_TOKEN_PATTERN.test(request.previewToken)) throw requestError();
  } else if (request.action === "integration-deactivate") {
    if (!exactKeys(request.confirmation, ["deactivateIntegration"], ["deactivateIntegration"]) || request.confirmation.deactivateIntegration !== true) {
      throw requestError("CONFIRMATION_REQUIRED");
    }
  } else if (request.action === "usage-reset") {
    if (!exactKeys(request.confirmation, ["resetAccumulatedUsage"], ["resetAccumulatedUsage"]) ||
        request.confirmation.resetAccumulatedUsage !== true) throw requestError("CONFIRMATION_REQUIRED");
  } else if (request.action === "uninstall") {
    const keys = ["removePickerMux", "restoreNativeCodex", "deleteProviderCredentials", "deleteBackups"];
    if (!exactKeys(request.confirmation, keys, keys) || keys.some((key) => request.confirmation[key] !== true)) {
      throw requestError("CONFIRMATION_REQUIRED");
    }
    if (typeof request.previewToken !== "string" || !PREVIEW_TOKEN_PATTERN.test(request.previewToken)) throw requestError();
  } else if (Object.hasOwn(request, "confirmation")) {
    throw requestError();
  }
  if (!["configuration-apply", "uninstall"].includes(request.action) && Object.hasOwn(request, "previewToken")) throw requestError();
  return {
    schemaVersion: COMPANION_SCHEMA_VERSION,
    action: request.action,
    ...(request.confirmation === undefined ? {} : { confirmation: { ...request.confirmation } }),
    ...(request.previewToken === undefined ? {} : { previewToken: request.previewToken }),
  };
}

export async function readCompanionRequest(input, { timeoutMs = 10_000 } = {}) {
  if (!input || typeof input[Symbol.asyncIterator] !== "function" ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw requestError();
  const iterator = input[Symbol.asyncIterator]();
  const chunks = [];
  let size = 0;
  let timer;
  let complete = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(requestError("REQUEST_TIMEOUT")), timeoutMs);
  });
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), deadline]);
      if (next.done) break;
      const chunk = typeof next.value === "string" ? Buffer.from(next.value, "utf8") : next.value;
      if (!(chunk instanceof Uint8Array)) throw requestError();
      size += chunk.byteLength;
      if (size > COMPANION_MAX_REQUEST_BYTES) throw requestError("REQUEST_TOO_LARGE");
      chunks.push(Buffer.from(chunk));
    }
    const parsed = parseCompanionRequest(Buffer.concat(chunks));
    complete = true;
    return parsed;
  } finally {
    clearTimeout(timer);
    // An unfinished stdin pipe must not keep the one-request process alive
    // after a timeout or rejection. Only this input stream is closed.
    if (!complete && typeof input.destroy === "function") {
      try { input.destroy(); } catch { /* Cleanup cannot change the safe result. */ }
    }
    // Do not await return(): a stalled input may also stall its cleanup.
    if (typeof iterator.return === "function") {
      try { Promise.resolve(iterator.return()).catch(() => {}); } catch { /* Input cleanup has no authority. */ }
    }
  }
}

function safeStatus(name, value) {
  const candidate = typeof value === "string" ? value : value?.status;
  return STATUS_ENUMS[name].includes(candidate) ? candidate : "unknown";
}

function safeVersion(value) {
  return typeof value === "string" && VERSION_PATTERN.test(value) ? value : undefined;
}

function safeOperationId(value) {
  return typeof value === "string" && OPERATION_ID_PATTERN.test(value) ? value : undefined;
}

async function boundedProbe(probe, timeoutMs) {
  if (typeof probe !== "function") throw requestError();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => probe()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(requestError("REQUEST_TIMEOUT")), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function collectCompanionStatus({ probes = {}, probeTimeoutMs = 5_000 } = {}) {
  if (!isPlainRecord(probes) || !Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs < 1 || probeTimeoutMs > 30_000) throw requestError();
  const names = ["metadata", ...Object.keys(STATUS_ENUMS),
    ...(typeof probes.tokenUsage === "function" ? ["tokenUsage"] : [])];
  const observed = await Promise.allSettled(names.map((name) => boundedProbe(probes[name], probeTimeoutMs)));
  const snapshot = {
    schemaVersion: COMPANION_SCHEMA_VERSION,
    capabilities: ["integration-toggle-v1", "native-uninstall-v1", "token-usage-v1"],
    version: "unknown",
    state: "degraded",
    tokenUsage: { schemaVersion: 1, status: "unavailable", providers: [] },
  };
  const issues = [];
  let attestedUsage = false;
  let durableResetAvailable = false;
  function issue(code) { issues.push({ code, message: ISSUE_MESSAGES[code] }); }
  names.forEach((name, index) => {
    const observation = observed[index];
    const raw = observation.status === "fulfilled" ? observation.value : undefined;
    if (name === "tokenUsage") {
      try {
        const usage = projectTokenUsageSnapshot(raw?.snapshot ?? raw);
        if (usage?.schemaVersion === 2) {
          if (!attestedUsage) snapshot.tokenUsage = usage;
          durableResetAvailable = raw?.canReset === true || (raw?.snapshot === undefined && usage.status === "available");
        }
      } catch { /* Persistent counters cannot grant lifecycle authority. */ }
      return;
    }
    if (name === "metadata") {
      const version = safeVersion(typeof raw === "string" ? raw : raw?.version);
      if (version) snapshot.version = version;
      else issue("metadata-unavailable");
      return;
    }
    let status = safeStatus(name, raw);
    if (name === "desktop" && typeof raw === "boolean") status = raw ? "running" : "stopped";
    if (name === "installation" && typeof raw?.installed === "boolean") status = raw.installed ? "installed" : "not-installed";
    if (name === "recovery" && observation.status === "fulfilled" && raw === null) status = "idle";
    if (name === "recovery" && raw?.phase !== undefined && FULL_REFRESH_PHASES.includes(raw.phase)) {
      status = raw.phase === "completed" ? "completed" : "pending";
    }
    if (observation.status === "rejected") {
      const code = observation.reason?.code;
      if (name === "accountCache" && code === "CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED") status = "refresh-required";
      else if (name === "compatibility" && code === "DESKTOP_COMPATIBILITY_UPDATE_REQUIRED") status = "update-required";
      else status = name === "installation" ? "invalid" : "unknown";
    }
    snapshot[name] = { status };
    if (name === "service" && status === "running" && raw?.healthy === true) {
      // Only the instance-attested health payload may supply usage. Rebuild
      // its numeric projection so capability coordinates and provider content
      // cannot enter the companion's observational status protocol.
      try {
        const usage = projectTokenUsageSnapshot(raw.health?.tokenUsage);
        if (usage) {
          snapshot.tokenUsage = usage;
          attestedUsage = true;
          const performance = projectTokenPerformanceSnapshot(raw.health?.tokenPerformance);
          if (performance) snapshot.tokenPerformance = performance;
        }
      } catch { /* Optional telemetry cannot change lifecycle permissions. */ }
    }
    if (name === "recovery") {
      snapshot.recovery.phase = FULL_REFRESH_PHASES.includes(raw?.phase) ? raw.phase : null;
      snapshot.recovery.operationId = safeOperationId(raw?.operationId) ?? null;
      if (status === "pending" && (!snapshot.recovery.phase || !snapshot.recovery.operationId)) snapshot.recovery.status = "unknown";
    }
    if (["unknown", "invalid", "unavailable"].includes(snapshot[name].status)) issue(`${name}-unavailable`);
  });
  const pendingRecovery = snapshot.recovery.status === "pending";
  const suspendedRecovery = pendingRecovery && snapshot.managedConfig.status === "suspended" && snapshot.recovery.phase !== "prepared";
  const legacySuspendedRecovery = pendingRecovery && snapshot.managedConfig.status === "not-installed" && snapshot.integration.status === "none" && snapshot.recovery.phase !== "prepared";
  const configurationConflict = ["suspension-conflict", "integration-conflict", "modified", "inconsistent", "invalid-state", "orphaned-managed-block"].includes(snapshot.managedConfig.status) ||
    (["ollama", "foreign", "conflict"].includes(snapshot.integration.status) && !(suspendedRecovery && snapshot.integration.status === "conflict"));
  const updateRequired = snapshot.compatibility.status === "update-required" || snapshot.service.status === "update-required";
  const refreshRequired = snapshot.accountCache.status === "refresh-required";
  if (configurationConflict) issue("configuration-conflict");
  if (updateRequired) issue("update-required");
  if (refreshRequired) issue("account-cache-refresh-required");
  if (pendingRecovery) issue("recovery-pending");
  const healthyConfig = ["installed", "installed-marker-recovered"].includes(snapshot.managedConfig.status);
  const installed = snapshot.installation.status === "installed";
  const knownDesktop = snapshot.desktop.status !== "unknown";
  const knownRecovery = ["idle", "completed"].includes(snapshot.recovery.status);
  const safeToMutate = installed && healthyConfig && knownDesktop && knownRecovery && !configurationConflict;
  const ready = safeToMutate && snapshot.service.status === "running" && snapshot.compatibility.status === "compatible" && snapshot.accountCache.status === "ready";
  const deactivated = installed && snapshot.managedConfig.status === "deactivated" && snapshot.integration.status === "none" && knownRecovery;
  const notInstalled = snapshot.installation.status === "not-installed" && snapshot.managedConfig.status === "not-installed";
  // A fresh native home has no account cache yet. Initialization still blocks
  // activation, but does not imply an installed bridge needs an update.
  snapshot.state = pendingRecovery ? "recovery-pending" : configurationConflict ? "configuration-conflict" : deactivated ? "inactive" :
    notInstalled ? "not-installed" : updateRequired || refreshRequired ? "update-required" : ready ? "ready" : "degraded";
  snapshot.actions = ["diagnose", "update-check", "configuration-preview"];
  if (safeToMutate && !updateRequired && !refreshRequired) {
    snapshot.actions.push("refresh");
    if (snapshot.desktop.status === "stopped") snapshot.actions.push("certify");
    if (ready) snapshot.actions.push("open");
  }
  if (installed && (healthyConfig || suspendedRecovery || legacySuspendedRecovery) && knownDesktop && !configurationConflict &&
    (pendingRecovery || (knownRecovery && (refreshRequired || updateRequired)))) snapshot.actions.push("recover");
  if (installed && healthyConfig && !configurationConflict && snapshot.desktop.status === "stopped" && knownRecovery) {
    snapshot.actions.push("update", "integration-deactivate");
  }
  if (snapshot.desktop.status === "stopped" && knownRecovery && snapshot.accountCache.status === "ready" &&
    ["installed", "not-installed"].includes(snapshot.installation.status) &&
    ["installed", "installed-marker-recovered", "not-installed", "deactivated"].includes(snapshot.managedConfig.status) &&
    ["pickermux", "ollama", "foreign", "none"].includes(snapshot.integration.status)) snapshot.actions.push("configuration-apply");
  if (installed && snapshot.desktop.status === "stopped" && knownRecovery && !configurationConflict &&
    ((healthyConfig && snapshot.integration.status === "pickermux") || deactivated)) {
    snapshot.actions.push("uninstall-preview", "uninstall");
  }
  snapshot.issues = issues;
  if (snapshot.tokenUsage.schemaVersion === 2) {
    snapshot.capabilities = ["integration-toggle-v1", "native-uninstall-v1", "token-usage-v2", "token-usage-reset-v1"];
    if (installed && knownRecovery && durableResetAvailable) snapshot.actions.push("usage-reset");
  }
  if (snapshot.tokenPerformance) snapshot.capabilities.push("token-performance-v1");
  return snapshot;
}

export function createCompanionReadOnlyProbes({ paths, distributionPaths, fullRefreshPaths, codexPath, config } = {}) {
  let configPromise;
  let clientPromise;
  let managedPromise;
  let installationPromise;
  const loadConfig = () => configPromise ??= config === undefined ? loadCompanionServiceConfig({ paths }) : Promise.resolve(config);
  const client = () => clientPromise ??= loadCodexClientVersion({ codexPath, execFileImpl: executeReadOnlyProbe });
  const managed = () => managedPromise ??= getConfigStatus({ configPath: paths.configPath, statePath: paths.statePath });
  const installation = () => installationPromise ??= (async () => {
    try { await lstat(distributionPaths.applicationDirectory); } catch (error) {
      if (error?.code === "ENOENT") return { installed: false };
      throw error;
    }
    return validateDistributionInstallation({ paths: distributionPaths });
  })();
  return {
    metadata: () => readPickerMuxMetadata(),
    desktop: () => isCodexDesktopRunning({ execFileImpl: executeReadOnlyProbe }),
    installation,
    tokenUsage: async () => {
      if ((await installation()).installed !== true) return null;
      const store = createUsageStore({ directory: path.join(distributionPaths.applicationDirectory, "usage") });
      const [snapshot, canReset] = await Promise.all([store.readSnapshot(), store.canReset()]);
      return { snapshot, canReset };
    },
    managedConfig: managed,
    service: async () => {
      const status = await managed();
      if (status.healthy === true && ["not-installed", "deactivated"].includes(status.status)) return { status: "not-installed" };
      return getBridgeServiceStatus({ config: await loadConfig(), runtimePath: paths.runtimePath, launchAgentLabel: paths.launchAgentLabel, execFileImpl: executeReadOnlyProbe });
    },
    compatibility: async () => {
      const status = await managed();
      if (status.healthy === true && ["not-installed", "deactivated"].includes(status.status)) return { status: "not-installed" };
      const [codexClientVersion, bundledCatalog] = await Promise.all([client(), loadBundledCatalog({ codexPath, execFileImpl: executeReadOnlyProbe })]);
      return checkCurrentCompatibility({
        manifestPath: paths.compatibilityPath,
        bundledCatalog,
        codexClientVersion,
        readFileImpl: (target) => {
          if (target !== paths.compatibilityPath) throw requestError();
          return readCompanionPrivateFile({ paths, kind: "compatibility" });
        },
      });
    },
    accountCache: async () => inspectCodexAccountCache({ codexHome: paths.codexHome, codexPath, codexClientVersion: await client() }),
    recovery: () => readFullRefreshCheckpoint({ installDirectory: fullRefreshPaths.installDirectory, checkpointPath: fullRefreshPaths.checkpointPath, allowMissing: true }),
    integration: async () => ({ status: (await previewConfigIntegration({ configPath: paths.configPath, statePath: paths.statePath })).status }),
  };
}

function companionErrorCode(error) {
  let code = "ACTION_FAILED";
  if (error instanceof CompanionControlError) code = error.code;
  else if (Object.hasOwn(ERROR_MESSAGES, error?.code)) code = error.code;
  else if (error?.code === "PICKERMUX_INSTALLATION_LOCK_BUSY") code = "BUSY";
  else if (error?.code === "CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED") code = "ACCOUNT_CACHE_REFRESH_REQUIRED";
  else if (error?.code === "CONFIGURATION_SUSPENDED") code = "RECOVERY_PENDING";
  else if (/^PICKERMUX_(?:PURGE|CREDENTIAL_PURGE)_/u.test(error?.code ?? "")) code = "PURGE_INCOMPLETE";
  else if (["DESKTOP_COMPATIBILITY_UPDATE_REQUIRED", "CODEX_IDENTITY_CHANGED"].includes(error?.code)) code = "UPDATE_REQUIRED";
  else if (["CONFIG_CHANGED_CONCURRENTLY", "CONFIG_MODIFIED", "MANAGED_CONFIG_MODIFIED", "STATE_CONFIG_MISMATCH", "WEB_SEARCH_CONFIG_CONFLICT", "INTEGRATION_CONFLICT", "INTEGRATION_PREVIEW_CHANGED", "INTEGRATION_SWITCH_CONFLICT", "FOREIGN_INTEGRATION_CONFLICT", "CONFIG_SUSPENSION_CONFLICT", "CONFIG_SUSPENSION_CHANGED", "CONFIG_SUSPENSION_INVALID", "CONFIG_SUSPENSION_RECEIPT_REQUIRED", "CONFIG_SUSPENSION_ROLLBACK_FAILED", "CONFIGURATION_NOT_SUSPENDED", "CONFIGURATION_SUSPENSION_CONFLICT", "REACTIVATION_RECEIPT_REQUIRED", "STATE_PROVIDER_MISMATCH", "HISTORICAL_PROVIDER_CONFLICT", "HISTORICAL_MARKER_CONFLICT"].includes(error?.code)) code = "CONFIGURATION_CONFLICT";
  return code;
}

export function companionFailure(error) {
  let code = "ACTION_FAILED";
  let current = error;
  const seen = new Set();
  for (let depth = 0; depth < 8 && current && typeof current === "object" && !seen.has(current); depth += 1) {
    seen.add(current);
    code = companionErrorCode(current);
    if (code !== "ACTION_FAILED") break;
    // Aggregate rollback failures contain multiple competing causes. Never
    // turn their original guard into a claim that restoration succeeded.
    if (current instanceof AggregateError || /ROLLBACK_FAILED$/u.test(current.code ?? "")) break;
    current = current.cause;
  }
  return { schemaVersion: COMPANION_SCHEMA_VERSION, ok: false, code, message: ERROR_MESSAGES[code] };
}

export function companionSuccess(action, result = {}) {
  if (!COMPANION_ACTIONS.includes(action)) throw requestError();
  const response = { schemaVersion: COMPANION_SCHEMA_VERSION, ok: true, code: "COMPLETE", action };
  for (const name of ["started", "resumed", "updated", "updateAvailable", "restartRequired", "certificationIncomplete", "deactivated"]) {
    if (typeof result?.[name] === "boolean") response[name] = result[name];
  }
  for (const name of ["version", "currentVersion", "latestVersion", "targetVersion"]) {
    const value = safeVersion(result?.[name]);
    if (value) response[name] = value;
  }
  const operationId = safeOperationId(result?.operationId);
  if (operationId) response.operationId = operationId;
  if (["configuration-preview", "configuration-apply"].includes(action)) {
    if (["pickermux", "ollama", "foreign", "none", "conflict", "applied"].includes(result?.status)) response.status = result.status;
    for (const name of ["canApply", "requiresConfirmation"]) {
      if (typeof result?.[name] === "boolean") response[name] = result[name];
    }
    if (Array.isArray(result?.changes)) response.changes = [...new Set(result.changes.filter((change) => COMPANION_CONFIGURATION_CHANGES.includes(change)))];
    if (action === "configuration-preview" && typeof result?.previewToken === "string" && PREVIEW_TOKEN_PATTERN.test(result.previewToken)) response.previewToken = result.previewToken;
  }
  if (action === "integration-deactivate" && result?.status === "deactivated") response.status = "deactivated";
  if (action === "usage-reset") {
    if (result?.status !== "reset" || !isTokenUsageResetTime(result.resetAt) || result.lastRequestPreserved !== true) {
      throw requestError("ACTION_FAILED");
    }
    response.status = "reset";
    response.resetAt = result.resetAt;
    response.lastRequestPreserved = true;
  }
  if (action === "uninstall-preview") {
    if (result?.status !== "ready" || result?.canApply !== true || !PREVIEW_TOKEN_PATTERN.test(result?.previewToken ?? "") ||
      !Array.isArray(result.changes) || result.changes.length !== COMPANION_UNINSTALL_CHANGES.length ||
      result.changes.some((change, index) => change !== COMPANION_UNINSTALL_CHANGES[index])) throw requestError("UNINSTALL_PREFLIGHT_FAILED");
    response.status = "ready";
    response.canApply = true;
    response.previewToken = result.previewToken;
    response.changes = [...COMPANION_UNINSTALL_CHANGES];
  }
  if (action === "uninstall") {
    if (result?.status !== "removed" || ["removed", "nativeRestored", "historicalChatsPreserved", "restartRequired"].some((key) => result[key] !== true)) {
      throw requestError("PURGE_INCOMPLETE");
    }
    response.status = "removed";
    for (const key of ["removed", "nativeRestored", "historicalChatsPreserved", "restartRequired"]) response[key] = true;
  }
  if (["update", "update-check"].includes(action) && ["current", "unavailable", "unsupported", "up-to-date", "available", "updated", "installed", "no-update", "update-available"].includes(result?.status)) response.status = result.status;
  if (["update", "update-check"].includes(action) && ["dmg", "cli-archive"].includes(result?.distribution)) response.distribution = result.distribution;
  return response;
}

export function createCompanionProgress(event = {}) {
  const response = { schemaVersion: COMPANION_SCHEMA_VERSION, type: "progress" };
  const phases = [...FULL_REFRESH_PHASES, "started", "checking", "downloading", "verifying", "activating", "certifying", "complete"];
  response.phase = phases.includes(event.phase) ? event.phase : "checking";
  const operationId = safeOperationId(event.operationId);
  if (operationId) response.operationId = operationId;
  for (const key of ["current", "total", "elapsedMs"]) {
    if (Number.isSafeInteger(event[key]) && event[key] >= 0 && event[key] <= 86_400_000) response[key] = event[key];
  }
  return response;
}
