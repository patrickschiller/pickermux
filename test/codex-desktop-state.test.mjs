import assert from "node:assert/strict";
import test from "node:test";

import { isCodexDesktopRunning } from "../src/codex-desktop-state.mjs";

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
