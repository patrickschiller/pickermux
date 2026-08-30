import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED,
  CodexAccountCacheRefreshRequiredError,
  inspectCodexAccountCache,
} from "../src/account-cache.mjs";

const ACCOUNT_CATALOG = {
  models: [{ slug: "gpt-5.6-sol" }],
};

test("account cache inspection binds the cache to the observed Codex client", async () => {
  const calls = [];
  const result = await inspectCodexAccountCache({
    codexHome: "/private/codex-home",
    codexPath: "/Applications/Test Codex.app/codex",
    clientVersionImpl: async (options) => {
      calls.push(["client", options]);
      return "0.151.0";
    },
    cacheImpl: async (options) => {
      calls.push(["cache", options]);
      return {
        catalog: ACCOUNT_CATALOG,
        source: "codex-account-cache",
        clientVersion: "0.151.0",
        fetchedAt: "2026-08-30T10:00:00.000Z",
        warning: "cache is old",
      };
    },
  });

  assert.deepEqual(calls, [
    ["client", { codexPath: "/Applications/Test Codex.app/codex" }],
    [
      "cache",
      {
        codexHome: "/private/codex-home",
        expectedClientVersion: "0.151.0",
      },
    ],
  ]);
  assert.deepEqual(result, {
    ready: true,
    status: "ready",
    codexClientVersion: "0.151.0",
    cacheClientVersion: "0.151.0",
    fetchedAt: "2026-08-30T10:00:00.000Z",
    warning: "cache is old",
    source: "codex-account-cache",
    catalog: ACCOUNT_CATALOG,
  });
});

test("account cache inspection reuses an injected client version", async () => {
  let clientVersionRead = false;
  const result = await inspectCodexAccountCache({
    codexHome: "/private/codex-home",
    codexPath: "/Applications/Test Codex.app/codex",
    codexClientVersion: "0.151.0",
    clientVersionImpl: async () => {
      clientVersionRead = true;
      return "unexpected";
    },
    cacheImpl: async ({ expectedClientVersion }) => ({
      catalog: ACCOUNT_CATALOG,
      source: "codex-account-cache",
      clientVersion: expectedClientVersion,
      fetchedAt: "2026-08-30T10:00:00.000Z",
    }),
  });

  assert.equal(clientVersionRead, false);
  assert.equal(result.codexClientVersion, "0.151.0");
  assert.equal(result.warning, null);
});

test("invalid account caches use a stable refresh-required error", async () => {
  const cause = new Error(
    "Codex account model cache version 0.150.1 does not match client 0.151.0",
  );

  await assert.rejects(
    inspectCodexAccountCache({
      codexHome: "/private/codex-home",
      codexClientVersion: "0.151.0",
      cacheImpl: async () => {
        throw cause;
      },
    }),
    (error) => {
      assert.equal(error instanceof CodexAccountCacheRefreshRequiredError, true);
      assert.equal(error.name, "CodexAccountCacheRefreshRequiredError");
      assert.equal(error.code, CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED);
      assert.equal(error.codexClientVersion, "0.151.0");
      assert.equal(error.cause, cause);
      assert.equal(
        error.message,
        "Codex account model cache refresh is required for client 0.151.0",
      );
      assert.doesNotMatch(error.message, /0\.150\.1/u);
      return true;
    },
  );
});

test("Codex client inspection failures remain operational errors", async () => {
  const cause = new Error("Codex binary is unavailable");
  await assert.rejects(
    inspectCodexAccountCache({
      codexHome: "/private/codex-home",
      codexPath: "/missing/codex",
      clientVersionImpl: async () => {
        throw cause;
      },
    }),
    (error) => {
      assert.equal(error, cause);
      assert.equal(error.code, undefined);
      return true;
    },
  );
});
