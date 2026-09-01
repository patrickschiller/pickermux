import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED,
  CodexAccountCacheRefreshRequiredError,
  inspectCodexAccountCache,
} from "../src/account-cache.mjs";
import { loadCachedNativeCatalog } from "../src/catalog.mjs";

const ACCOUNT_CATALOG = {
  models: [{
    slug: "gpt-5.6-sol",
    context_window: 200_000,
    max_context_window: 200_000,
  }],
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

test("account cache loading reads only models_cache.json", async () => {
  const codexHome = "/private/isolated-codex-home";
  const reads = [];
  await loadCachedNativeCatalog({
    codexHome,
    expectedClientVersion: "0.151.0",
    now: Date.parse("2026-08-30T10:01:00.000Z"),
    readFileImpl: async (...args) => {
      reads.push(args);
      return JSON.stringify({
        fetched_at: "2026-08-30T10:00:00.000Z",
        client_version: "0.151.0",
        models: ACCOUNT_CATALOG.models,
      });
    },
  });

  assert.deepEqual(reads, [
    [path.join(codexHome, "models_cache.json"), "utf8"],
  ]);
});

test("default account cache reader accepts one exact private cache file", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pickermux-cache-valid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const codexHome = path.join(directory, ".codex");
  await mkdir(codexHome, { mode: 0o700 });
  await writeFile(
    path.join(codexHome, "models_cache.json"),
    `${JSON.stringify({
      fetched_at: "2026-08-30T10:00:00.000Z",
      client_version: "0.151.0",
      models: ACCOUNT_CATALOG.models,
    })}\n`,
    { mode: 0o600 },
  );

  const result = await loadCachedNativeCatalog({
    codexHome,
    expectedClientVersion: "0.151.0",
    now: Date.parse("2026-08-30T10:01:00.000Z"),
  });
  assert.equal(result.source, "codex-account-cache");
  assert.equal(result.clientVersion, "0.151.0");
  assert.deepEqual(result.catalog.models, ACCOUNT_CATALOG.models);
});

test("account cache loading refuses auth.json symlinks and hardlinks", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pickermux-cache-file-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const codexHome = path.join(directory, ".codex");
  const authPath = path.join(codexHome, "auth.json");
  const cachePath = path.join(codexHome, "models_cache.json");
  const authBytes = Buffer.from('{"tokens":"must-not-be-read"}\n');
  await mkdir(codexHome, { mode: 0o700 });
  await writeFile(authPath, authBytes, { mode: 0o600 });
  const authBefore = await stat(authPath);

  await symlink(authPath, cachePath);
  await assert.rejects(
    loadCachedNativeCatalog({
      codexHome,
      expectedClientVersion: "0.151.0",
    }),
    (error) => {
      assert.match(error.message, /Failed to read Codex account model cache/iu);
      assert.match(error.cause?.message ?? "", /symbolic link/iu);
      return true;
    },
  );
  await rm(cachePath);

  await link(authPath, cachePath);
  await assert.rejects(
    loadCachedNativeCatalog({
      codexHome,
      expectedClientVersion: "0.151.0",
    }),
    (error) => {
      assert.match(error.message, /Failed to read Codex account model cache/iu);
      assert.match(error.cause?.message ?? "", /one filesystem link/iu);
      return true;
    },
  );

  assert.deepEqual(await readFile(authPath), authBytes);
  const authAfter = await stat(authPath);
  assert.equal(authAfter.dev, authBefore.dev);
  assert.equal(authAfter.ino, authBefore.ino);
  assert.equal(authAfter.mode, authBefore.mode);
  assert.equal(authAfter.size, authBefore.size);
});
