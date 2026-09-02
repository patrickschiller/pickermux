import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const LSAPPINFO_PATH = "/usr/bin/lsappinfo";
const CODEX_DESKTOP_BUNDLE_ID = "com.openai.codex";
const OSASCRIPT_PATH = "/usr/bin/osascript";
const OPEN_PATH = "/usr/bin/open";
const DEFAULT_STATE_TIMEOUT_MS = 30_000;
const DEFAULT_STATE_POLL_INTERVAL_MS = 250;
const DEFAULT_STABLE_OBSERVATIONS = 2;
const APP_ENVIRONMENT_KEYS = Object.freeze([
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "__CF_USER_TEXT_ENCODING",
]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireBoundedInteger(value, label, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be an integer of at least ${minimum}`);
  }
  return value;
}

/**
 * Pass only ordinary macOS session values to `open`. In particular, provider
 * credentials, Codex overrides and PickerMux capability state never become
 * part of the launched app's environment.
 */
export function sanitizeCodexDesktopLaunchEnvironment(
  environment = process.env,
) {
  if (environment === null || typeof environment !== "object") {
    throw new TypeError("An environment object is required");
  }
  const sanitized = {};
  for (const key of APP_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (
      typeof value === "string" &&
      value.length > 0 &&
      !value.includes("\0")
    ) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/** Query LaunchServices without inspecting or signaling any Codex process. */
export async function isCodexDesktopRunning({ execFileImpl = execFile } = {}) {
  if (typeof execFileImpl !== "function") {
    throw new TypeError("An execFile implementation is required");
  }
  let result;
  try {
    result = await execFileImpl(
      LSAPPINFO_PATH,
      ["find", `bundleID=${CODEX_DESKTOP_BUNDLE_ID}`],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    );
  } catch (error) {
    throw new Error("Failed to query Codex Desktop state from LaunchServices", {
      cause: error,
    });
  }
  const stdout = typeof result === "string" ? result : result?.stdout;
  if (typeof stdout !== "string") {
    throw new Error("LaunchServices returned an invalid Codex Desktop state");
  }
  return stdout.trim().length > 0;
}

/**
 * Require several consecutive LaunchServices observations so a transition is
 * not accepted while the app is still registering or unregistering itself.
 * The attempt count provides a deterministic upper bound even with an injected
 * clock or sleep implementation.
 */
export async function waitForCodexDesktopState({
  expectedRunning,
  timeoutMs = DEFAULT_STATE_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_STATE_POLL_INTERVAL_MS,
  stableObservations = DEFAULT_STABLE_OBSERVATIONS,
  isRunningImpl = isCodexDesktopRunning,
  sleepImpl = sleep,
} = {}) {
  if (typeof expectedRunning !== "boolean") {
    throw new TypeError("expectedRunning must be a boolean");
  }
  requireBoundedInteger(timeoutMs, "timeoutMs");
  requireBoundedInteger(pollIntervalMs, "pollIntervalMs", { minimum: 1 });
  requireBoundedInteger(stableObservations, "stableObservations", { minimum: 1 });
  if (typeof isRunningImpl !== "function" || typeof sleepImpl !== "function") {
    throw new TypeError("Codex Desktop state dependencies must be functions");
  }

  const maximumObservations = Math.floor(timeoutMs / pollIntervalMs) + 1;
  let matchingObservations = 0;
  for (let observation = 0; observation < maximumObservations; observation += 1) {
    const running = await isRunningImpl();
    if (typeof running !== "boolean") {
      throw new Error("Codex Desktop state detector returned a non-boolean value");
    }
    matchingObservations = running === expectedRunning
      ? matchingObservations + 1
      : 0;
    if (matchingObservations >= stableObservations) {
      return {
        running,
        observations: observation + 1,
      };
    }
    if (observation + 1 < maximumObservations) {
      await sleepImpl(Math.min(pollIntervalMs, timeoutMs));
    }
  }

  const target = expectedRunning ? "start" : "quit";
  throw new Error(`Codex Desktop did not ${target} within ${timeoutMs} ms`);
}

/** Ask Codex to quit through its normal Apple-event lifecycle. */
export async function requestCodexDesktopQuit({
  execFileImpl = execFile,
  isRunningImpl,
  waitForStateImpl = waitForCodexDesktopState,
  timeoutMs = DEFAULT_STATE_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_STATE_POLL_INTERVAL_MS,
  stableObservations = DEFAULT_STABLE_OBSERVATIONS,
  sleepImpl = sleep,
} = {}) {
  if (typeof execFileImpl !== "function" || typeof waitForStateImpl !== "function") {
    throw new TypeError("Codex Desktop quit dependencies must be functions");
  }
  const detect = isRunningImpl ?? (() => isCodexDesktopRunning({ execFileImpl }));
  if (typeof detect !== "function") {
    throw new TypeError("isRunningImpl must be a function");
  }
  const initiallyRunning = await detect();
  if (typeof initiallyRunning !== "boolean") {
    throw new Error("Codex Desktop state detector returned a non-boolean value");
  }
  if (!initiallyRunning) {
    return { requested: false, running: false, observations: 1 };
  }

  try {
    await execFileImpl(
      OSASCRIPT_PATH,
      ["-e", `tell application id "${CODEX_DESKTOP_BUNDLE_ID}" to quit`],
      { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 15_000 },
    );
  } catch (error) {
    throw new Error("Codex Desktop did not accept the graceful quit request", {
      cause: error,
    });
  }
  const state = await waitForStateImpl({
    expectedRunning: false,
    timeoutMs,
    pollIntervalMs,
    stableObservations,
    isRunningImpl: detect,
    sleepImpl,
  });
  return { requested: true, ...state };
}

/** Open Codex by its immutable bundle identifier and wait for registration. */
export async function openCodexDesktop({
  execFileImpl = execFile,
  environment = process.env,
  isRunningImpl,
  waitForStateImpl = waitForCodexDesktopState,
  timeoutMs = DEFAULT_STATE_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_STATE_POLL_INTERVAL_MS,
  stableObservations = DEFAULT_STABLE_OBSERVATIONS,
  sleepImpl = sleep,
} = {}) {
  if (typeof execFileImpl !== "function" || typeof waitForStateImpl !== "function") {
    throw new TypeError("Codex Desktop open dependencies must be functions");
  }
  const detect = isRunningImpl ?? (() => isCodexDesktopRunning({ execFileImpl }));
  if (typeof detect !== "function") {
    throw new TypeError("isRunningImpl must be a function");
  }
  try {
    await execFileImpl(
      OPEN_PATH,
      ["-b", CODEX_DESKTOP_BUNDLE_ID],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 15_000,
        env: sanitizeCodexDesktopLaunchEnvironment(environment),
      },
    );
  } catch (error) {
    throw new Error("Failed to open Codex Desktop", { cause: error });
  }
  const state = await waitForStateImpl({
    expectedRunning: true,
    timeoutMs,
    pollIntervalMs,
    stableObservations,
    isRunningImpl: detect,
    sleepImpl,
  });
  return { requested: true, ...state };
}
