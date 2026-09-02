import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_COMPATIBILITY_POLL_INTERVAL_MS,
  RuntimeCompatibilityError,
  createRuntimeCompatibilityGate,
  observeRuntimeCompatibility,
  resolveCodexExecutablePath,
  sameCodexBinaryIdentity,
} from "../src/runtime-compatibility.mjs";

test("runtime compatibility uses a two-second proactive poll", () => {
  assert.equal(RUNTIME_COMPATIBILITY_POLL_INTERVAL_MS, 2_000);
});

function identity(ino, extra = {}) {
  return {
    dev: 1,
    ino,
    size: 10_000 + ino,
    mtimeMs: 1_000 + ino,
    ctimeMs: 2_000 + ino,
    ...extra,
  };
}

function observation(currentIdentity, {
  compatible = true,
  reasons = [],
  version = "0.152.0",
} = {}) {
  return {
    compatibility: {
      status: compatible ? "compatible" : "update-required",
      compatible,
      reasons,
    },
    bundledCatalog: { models: [{ slug: "gpt-test" }] },
    codexClientVersion: version,
    identity: currentIdentity,
  };
}

test("runtime compatibility observation rejects a binary replaced during inspection", async () => {
  const identities = [identity(1), identity(2)];
  let compatibilityCalls = 0;
  await assert.rejects(
    observeRuntimeCompatibility({
      manifestPath: "/private/compatibility.json",
      codexPath: "/Applications/Test.app/codex",
      resolveExecutableImpl: async (value) => value,
      identityImpl: async () => identities.shift(),
      bundledCatalogImpl: async () => ({ models: [{ slug: "gpt-test" }] }),
      clientVersionImpl: async () => "0.152.0",
      compatibilityImpl: async () => {
        compatibilityCalls += 1;
        return { compatible: true, status: "compatible", reasons: [] };
      },
    }),
    (error) => error?.code === "CODEX_IDENTITY_CHANGED",
  );
  assert.equal(compatibilityCalls, 0);
  assert.equal(sameCodexBinaryIdentity(identity(1), identity(1)), true);
  assert.equal(sameCodexBinaryIdentity(identity(1), identity(2)), false);
});

test("runtime compatibility observation binds the exact binary, version and catalog", async () => {
  const currentIdentity = identity(7);
  const bundledCatalog = { models: [{ slug: "gpt-test" }] };
  let compatibilityInput;
  const result = await observeRuntimeCompatibility({
    manifestPath: "/private/compatibility.json",
    codexPath: "/Applications/Test.app/codex",
    resolveExecutableImpl: async (value) => value,
    identityImpl: async () => currentIdentity,
    bundledCatalogImpl: async ({ codexPath }) => {
      assert.equal(codexPath, "/Applications/Test.app/codex");
      return bundledCatalog;
    },
    clientVersionImpl: async () => "0.152.0",
    compatibilityImpl: async (input) => {
      compatibilityInput = input;
      return { compatible: true, status: "compatible", reasons: [] };
    },
  });
  assert.deepEqual(compatibilityInput, {
    manifestPath: "/private/compatibility.json",
    bundledCatalog,
    codexClientVersion: "0.152.0",
  });
  assert.equal(result.identity, currentIdentity);
  assert.equal(result.codexClientVersion, "0.152.0");
});

test("bare Codex commands resolve deterministically through executable PATH entries", async () => {
  const calls = [];
  const resolved = await resolveCodexExecutablePath("codex", {
    environment: { PATH: "/not-executable:/supported/bin" },
    accessImpl: async (candidate, mode) => {
      calls.push({ candidate, mode });
      if (candidate !== "/supported/bin/codex") {
        throw Object.assign(new Error("not executable"), { code: "EACCES" });
      }
    },
  });
  assert.equal(resolved, "/supported/bin/codex");
  assert.deepEqual(calls.map((entry) => entry.candidate), [
    "/not-executable/codex",
    "/supported/bin/codex",
  ]);
  assert.equal(calls.every((entry) => Number.isInteger(entry.mode)), true);

  await assert.rejects(
    resolveCodexExecutablePath("codex", {
      environment: { PATH: "/private/one:/private/two" },
      accessImpl: async () => {
        throw new Error("/private/path-must-not-leak");
      },
    }),
    (error) =>
      error.message === "Codex executable is unavailable" &&
      !error.message.includes("private"),
  );
});

test("unchanged runtime identity admits requests without another full probe", async () => {
  const currentIdentity = identity(10);
  let observeCalls = 0;
  let identityCalls = 0;
  const gate = createRuntimeCompatibilityGate({
    manifestPath: "/private/compatibility.json",
    codexPath: "/Applications/Test.app/codex",
    identityImpl: async () => {
      identityCalls += 1;
      return currentIdentity;
    },
    observeImpl: async () => {
      observeCalls += 1;
      return observation(currentIdentity);
    },
  });

  assert.equal((await gate.initialize()).codexClientVersion, "0.152.0");
  await gate.assertReady();
  await gate.assertReady();
  assert.equal(observeCalls, 1);
  assert.equal(identityCalls, 2);
  assert.deepEqual(gate.snapshot(), {
    status: "compatible",
    compatible: true,
    reasons: [],
  });
  gate.stop();
});

test("identity drift blocks immediately, coalesces probes and latches update-required", async () => {
  let currentIdentity = identity(20);
  let observeCalls = 0;
  let releaseProbe;
  let markProbeStarted;
  const probeStarted = new Promise((resolve) => {
    markProbeStarted = resolve;
  });
  const blocked = [];
  const gate = createRuntimeCompatibilityGate({
    manifestPath: "/private/compatibility.json",
    codexPath: "/Applications/Test.app/codex",
    identityImpl: async () => currentIdentity,
    observeImpl: async () => {
      observeCalls += 1;
      if (observeCalls === 1) return observation(currentIdentity);
      markProbeStarted();
      await new Promise((resolve) => {
        releaseProbe = resolve;
      });
      return observation(currentIdentity, {
        compatible: false,
        reasons: [
          "codex-client-version",
          "private/path/must-not-leak",
        ],
      });
    },
    onBlocked: (state) => blocked.push(state.status),
  });
  await gate.initialize();

  currentIdentity = identity(21);
  const first = gate.assertReady();
  await probeStarted;
  assert.equal(gate.snapshot().status, "checking");
  const second = gate.assertReady();
  assert.equal(observeCalls, 2);
  releaseProbe();
  await assert.rejects(first, (error) =>
    error instanceof RuntimeCompatibilityError &&
    error.code === "DESKTOP_COMPATIBILITY_UPDATE_REQUIRED");
  await assert.rejects(second, (error) =>
    error?.code === "DESKTOP_COMPATIBILITY_UPDATE_REQUIRED");
  assert.deepEqual(gate.snapshot(), {
    status: "update-required",
    compatible: false,
    reasons: ["codex-client-version"],
  });
  assert.deepEqual(blocked, ["checking", "update-required"]);
  assert.doesNotMatch(JSON.stringify(gate.snapshot()), /private|path|Test\.app/u);

  currentIdentity = identity(22);
  await assert.rejects(gate.assertReady(), (error) =>
    error?.code === "DESKTOP_COMPATIBILITY_UPDATE_REQUIRED");
  assert.equal(observeCalls, 2);
  gate.stop();
});

test("operational compatibility failures remain fail-closed and retryable", async () => {
  const currentIdentity = identity(30);
  let observeCalls = 0;
  let identityFailure = false;
  const gate = createRuntimeCompatibilityGate({
    manifestPath: "/private/compatibility.json",
    codexPath: "/Applications/Test.app/codex",
    identityImpl: async () => {
      if (identityFailure) {
        identityFailure = false;
        throw new Error("secret path and token must not escape");
      }
      return currentIdentity;
    },
    observeImpl: async () => {
      observeCalls += 1;
      return observation(currentIdentity);
    },
  });
  await gate.initialize();

  identityFailure = true;
  await assert.rejects(gate.assertReady(), (error) =>
    error?.code === "DESKTOP_COMPATIBILITY_UNAVAILABLE");
  assert.deepEqual(gate.snapshot(), {
    status: "check-failed",
    compatible: false,
    reasons: [],
  });
  assert.doesNotMatch(JSON.stringify(gate.snapshot()), /secret|token|path/u);

  await gate.assertReady();
  assert.equal(observeCalls, 2);
  assert.equal(gate.snapshot().status, "compatible");
  gate.stop();
  await assert.rejects(gate.assertReady(), (error) =>
    error?.code === "DESKTOP_COMPATIBILITY_UNAVAILABLE");
});
