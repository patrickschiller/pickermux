import assert from "node:assert/strict";
import test from "node:test";

import {
  isCodexDesktopRunning,
  openCodexDesktop,
  requestCodexDesktopQuit,
  sanitizeCodexDesktopLaunchEnvironment,
  waitForCodexDesktopState,
} from "../src/codex-desktop-state.mjs";

test("Codex Desktop state uses its exact LaunchServices bundle identifier", async () => {
  let invocation;
  const running = await isCodexDesktopRunning({
    execFileImpl: async (...args) => {
      invocation = args;
      return { stdout: 'ASN:0x0-0x12345-"ChatGPT":\n', stderr: "" };
    },
  });

  assert.equal(running, true);
  assert.deepEqual(invocation, [
    "/usr/bin/lsappinfo",
    ["find", "bundleID=com.openai.codex"],
    { encoding: "utf8", maxBuffer: 64 * 1024 },
  ]);
});

test("empty LaunchServices output means Codex Desktop is closed", async () => {
  assert.equal(
    await isCodexDesktopRunning({
      execFileImpl: async () => ({ stdout: "  \n", stderr: "" }),
    }),
    false,
  );
});

test("LaunchServices failures expose no command output in the public message", async () => {
  const secret = "private-launchservices-output";
  await assert.rejects(
    isCodexDesktopRunning({
      execFileImpl: async () => {
        throw new Error(secret);
      },
    }),
    (error) => {
      assert.equal(
        error.message,
        "Failed to query Codex Desktop state from LaunchServices",
      );
      assert.doesNotMatch(error.message, new RegExp(secret, "u"));
      return true;
    },
  );
});

test("invalid LaunchServices output fails closed instead of discovering", async () => {
  await assert.rejects(
    isCodexDesktopRunning({ execFileImpl: async () => ({}) }),
    /invalid Codex Desktop state/u,
  );
});

test("state transitions require consecutive stable LaunchServices observations", async () => {
  const states = [true, false, true, false, false];
  const sleeps = [];
  const result = await waitForCodexDesktopState({
    expectedRunning: false,
    timeoutMs: 40,
    pollIntervalMs: 10,
    stableObservations: 2,
    isRunningImpl: async () => states.shift(),
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
  });

  assert.deepEqual(result, { running: false, observations: 5 });
  assert.deepEqual(sleeps, [10, 10, 10, 10]);
});

test("state waits are deterministically bounded", async () => {
  let observations = 0;
  await assert.rejects(
    waitForCodexDesktopState({
      expectedRunning: false,
      timeoutMs: 20,
      pollIntervalMs: 10,
      stableObservations: 2,
      isRunningImpl: async () => {
        observations += 1;
        return true;
      },
      sleepImpl: async () => {},
    }),
    /did not quit within 20 ms/u,
  );
  assert.equal(observations, 3);
});

test("graceful quit uses only the fixed Apple event and waits for closure", async () => {
  const states = [true, false, false];
  const calls = [];
  const result = await requestCodexDesktopQuit({
    execFileImpl: async (...args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    },
    isRunningImpl: async () => states.shift(),
    timeoutMs: 10,
    pollIntervalMs: 5,
    sleepImpl: async () => {},
  });

  assert.deepEqual(result, { requested: true, running: false, observations: 2 });
  assert.deepEqual(calls, [[
    "/usr/bin/osascript",
    ["-e", 'tell application id "com.openai.codex" to quit'],
    { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 15_000 },
  ]]);
  assert.equal(calls.some(([command]) => /(?:kill|pkill)$/u.test(command)), false);
});

test("quit failures never fall back to signaling a process", async () => {
  const commands = [];
  await assert.rejects(
    requestCodexDesktopQuit({
      isRunningImpl: async () => true,
      execFileImpl: async (command) => {
        commands.push(command);
        throw new Error("private Apple-event output");
      },
    }),
    (error) => {
      assert.equal(
        error.message,
        "Codex Desktop did not accept the graceful quit request",
      );
      assert.doesNotMatch(error.message, /private Apple-event output/u);
      return true;
    },
  );
  assert.deepEqual(commands, ["/usr/bin/osascript"]);
});

test("an already closed Codex app needs no Apple event", async () => {
  let executed = false;
  assert.deepEqual(
    await requestCodexDesktopQuit({
      isRunningImpl: async () => false,
      execFileImpl: async () => {
        executed = true;
      },
    }),
    { requested: false, running: false, observations: 1 },
  );
  assert.equal(executed, false);
});

test("Codex open uses its bundle id with a narrow environment", async () => {
  let invocation;
  let waitOptions;
  const result = await openCodexDesktop({
    environment: {
      HOME: "/Users/tester",
      USER: "tester",
      LANG: "en_US.UTF-8",
      PATH: "/private/bin",
      CODEX_HOME: "/private/codex",
      PICKERMUX_PROVIDER_TOKEN: "must-not-be-forwarded",
    },
    execFileImpl: async (...args) => {
      invocation = args;
      return { stdout: "", stderr: "" };
    },
    isRunningImpl: async () => true,
    waitForStateImpl: async (options) => {
      waitOptions = options;
      return { running: true, observations: 2 };
    },
  });

  assert.deepEqual(result, { requested: true, running: true, observations: 2 });
  assert.equal(invocation[0], "/usr/bin/open");
  assert.deepEqual(invocation[1], ["-b", "com.openai.codex"]);
  assert.deepEqual(invocation[2].env, {
    HOME: "/Users/tester",
    USER: "tester",
    LANG: "en_US.UTF-8",
  });
  assert.equal(waitOptions.expectedRunning, true);
  assert.equal(typeof waitOptions.isRunningImpl, "function");
});

test("environment sanitizer drops invalid and sensitive values", () => {
  assert.deepEqual(
    sanitizeCodexDesktopLaunchEnvironment({
      HOME: "/Users/tester",
      TMPDIR: "/tmp/value\0suffix",
      LC_CTYPE: "UTF-8",
      API_KEY: "secret",
      CODEX_HOME: "/private/codex",
    }),
    { HOME: "/Users/tester", LC_CTYPE: "UTF-8" },
  );
});
