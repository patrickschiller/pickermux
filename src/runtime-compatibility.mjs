import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import {
  loadBundledCatalog,
  loadCodexClientVersion,
} from "./catalog.mjs";
import { checkCurrentCompatibility } from "./compatibility-manifest.mjs";

export const RUNTIME_COMPATIBILITY_POLL_INTERVAL_MS = 2_000;

const SAFE_COMPATIBILITY_REASONS = new Set([
  "bridge-contract",
  "bundled-catalog",
  "codex-client-version",
  "manifest-invalid",
  "manifest-missing",
]);

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function identityValue(stats, name) {
  const value = stats?.[name];
  if (!Number.isFinite(value)) {
    throw new Error("Codex binary identity is unavailable");
  }
  return value;
}

function normalizeIdentity(stats) {
  if (typeof stats?.isFile === "function" && !stats.isFile()) {
    throw new Error("Codex binary identity is unavailable");
  }
  return Object.freeze({
    dev: identityValue(stats, "dev"),
    ino: identityValue(stats, "ino"),
    size: identityValue(stats, "size"),
    mtimeMs: identityValue(stats, "mtimeMs"),
    ctimeMs: identityValue(stats, "ctimeMs"),
  });
}

export async function resolveCodexExecutablePath(
  codexPath,
  {
    accessImpl = access,
    environment = process.env,
  } = {},
) {
  const command = requireNonEmptyString(codexPath, "Codex binary path");
  if (command.includes(path.sep)) {
    const resolved = path.resolve(command);
    try {
      await accessImpl(resolved, fsConstants.X_OK);
      return resolved;
    } catch {
      throw new Error("Codex executable is unavailable");
    }
  }

  const searchPath = typeof environment?.PATH === "string"
    ? environment.PATH
    : "/usr/bin:/bin";
  for (const directory of searchPath.split(path.delimiter)) {
    const candidate = path.resolve(directory || process.cwd(), command);
    try {
      await accessImpl(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Match exec-file PATH lookup without exposing a rejected local path.
    }
  }
  throw new Error("Codex executable is unavailable");
}

export async function readCodexBinaryIdentity(
  codexPath,
  {
    statImpl = stat,
    resolveImpl = resolveCodexExecutablePath,
  } = {},
) {
  const resolved = await resolveImpl(codexPath);
  return normalizeIdentity(await statImpl(resolved));
}

export function sameCodexBinaryIdentity(left, right) {
  return (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object" &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function safeCompatibilityReasons(reasons) {
  const safe = Array.isArray(reasons)
    ? reasons.filter((reason) => SAFE_COMPATIBILITY_REASONS.has(reason))
    : [];
  return Object.freeze([...new Set(safe)]);
}

/**
 * Observe the executable before and after asking Codex for its current
 * version/catalog contract. A concurrently replaced app can therefore never
 * produce a mixed observation that is admitted by the running bridge.
 */
export async function observeRuntimeCompatibility({
  manifestPath,
  codexPath,
  identityImpl = readCodexBinaryIdentity,
  resolveExecutableImpl = resolveCodexExecutablePath,
  bundledCatalogImpl = loadBundledCatalog,
  clientVersionImpl = loadCodexClientVersion,
  compatibilityImpl = checkCurrentCompatibility,
} = {}) {
  requireNonEmptyString(manifestPath, "Compatibility manifest path");
  requireNonEmptyString(codexPath, "Codex binary path");
  const executablePath = await resolveExecutableImpl(codexPath);
  const before = await identityImpl(executablePath);
  const [bundledCatalog, codexClientVersion] = await Promise.all([
    bundledCatalogImpl({ codexPath: executablePath }),
    clientVersionImpl({ codexPath: executablePath }),
  ]);
  const after = await identityImpl(executablePath);
  if (!sameCodexBinaryIdentity(before, after)) {
    const error = new Error("Codex binary changed during compatibility inspection");
    error.code = "CODEX_IDENTITY_CHANGED";
    throw error;
  }
  const compatibility = await compatibilityImpl({
    manifestPath,
    bundledCatalog,
    codexClientVersion,
  });
  return Object.freeze({
    compatibility,
    bundledCatalog,
    codexClientVersion,
    identity: after,
  });
}

export class RuntimeCompatibilityError extends Error {
  constructor(status, reasons = []) {
    const updateRequired = status === "update-required";
    super(
      updateRequired
        ? "The running bridge is not compatible with the current Codex Desktop"
        : "The running bridge could not verify Codex Desktop compatibility",
    );
    this.name = "RuntimeCompatibilityError";
    this.code = updateRequired
      ? "DESKTOP_COMPATIBILITY_UPDATE_REQUIRED"
      : "DESKTOP_COMPATIBILITY_UNAVAILABLE";
    this.status = status;
    this.statusCode = 503;
    this.reasons = safeCompatibilityReasons(reasons);
  }
}

function publicState(status, reasons = []) {
  return Object.freeze({
    status,
    compatible: status === "compatible",
    reasons: safeCompatibilityReasons(reasons),
  });
}

/**
 * Maintain a fail-closed compatibility gate for an already-running service.
 * The cheap executable identity check runs before every admitted model request;
 * expensive Codex subprocess probes are coalesced and run only after drift or
 * while retrying an operational check failure.
 */
export function createRuntimeCompatibilityGate({
  manifestPath,
  codexPath,
  intervalMs = RUNTIME_COMPATIBILITY_POLL_INTERVAL_MS,
  identityImpl = readCodexBinaryIdentity,
  observeImpl = observeRuntimeCompatibility,
  onBlocked = () => {},
} = {}) {
  requireNonEmptyString(manifestPath, "Compatibility manifest path");
  requireNonEmptyString(codexPath, "Codex binary path");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250) {
    throw new TypeError("Runtime compatibility interval must be at least 250ms");
  }
  if (
    typeof identityImpl !== "function" ||
    typeof observeImpl !== "function" ||
    typeof onBlocked !== "function"
  ) {
    throw new TypeError("Runtime compatibility dependencies must be functions");
  }

  let state = publicState("checking");
  let observation;
  let pending;
  let timer;
  let stopped = false;
  let updateRequiredLatched = false;
  let lastNotifiedBlockedStatus;

  const notifyBlocked = () => {
    if (lastNotifiedBlockedStatus === state.status) return;
    lastNotifiedBlockedStatus = state.status;
    try {
      onBlocked(state);
    } catch {
      // An observer must never reopen or crash a fail-closed gate.
    }
  };

  const setBlocked = (status, reasons) => {
    state = publicState(status, reasons);
    notifyBlocked();
  };

  const inspect = async ({ force = false } = {}) => {
    if (updateRequiredLatched) return observation;
    if (pending) return pending;
    pending = (async () => {
      if (!force && state.status === "compatible" && observation) {
        try {
          const currentIdentity = await identityImpl(codexPath);
          if (sameCodexBinaryIdentity(currentIdentity, observation.identity)) {
            return observation;
          }
          setBlocked("checking");
        } catch {
          setBlocked("check-failed");
          return undefined;
        }
      } else if (state.status !== "checking") {
        setBlocked("checking");
      }

      try {
        const next = await observeImpl({
          manifestPath,
          codexPath,
          identityImpl,
        });
        if (next?.compatibility?.compatible !== true) {
          observation = next;
          updateRequiredLatched = true;
          setBlocked(
            "update-required",
            next?.compatibility?.reasons,
          );
          return observation;
        }
        observation = next;
        state = publicState("compatible");
        lastNotifiedBlockedStatus = undefined;
        return observation;
      } catch {
        setBlocked("check-failed");
        return undefined;
      }
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };

  const assertReady = async () => {
    if (stopped) {
      throw new RuntimeCompatibilityError("check-failed");
    }
    await inspect();
    if (state.status !== "compatible") {
      throw new RuntimeCompatibilityError(state.status, state.reasons);
    }
    return observation;
  };

  return Object.freeze({
    async initialize() {
      if (stopped) throw new RuntimeCompatibilityError("check-failed");
      await inspect({ force: true });
      if (state.status !== "compatible") {
        throw new RuntimeCompatibilityError(state.status, state.reasons);
      }
      return observation;
    },
    assertReady,
    snapshot() {
      return state;
    },
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => {
        assertReady().catch(() => {});
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  });
}
