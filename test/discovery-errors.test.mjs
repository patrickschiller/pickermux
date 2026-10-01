import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateBridgeConfig } from "../src/bridge-config.mjs";
import { discoverBridgeModels } from "../src/bridge-discovery.mjs";
import { setupPickerMux } from "../src/cli.mjs";
import { companionFailure } from "../src/companion-control.mjs";
import { classifyDiscoveryFailure, discoverLmStudio, DiscoveryError } from "../src/discovery.mjs";
import { resolveDistributionPaths, resolveInstallPaths } from "../src/paths.mjs";

const PRIVATE = "PRIVATE_ENDPOINT_MODEL_PAYLOAD_CREDENTIAL_CANARY";
const loadedConfig = () => validateBridgeConfig({ schemaVersion: 2, bridge: {}, providers: [{
  id: "lmstudio", kind: "lmstudio-responses", baseUrl: "http://127.0.0.1:1234/v1", allowPrivateNetwork: true,
  discovery: { mode: "loaded", maxModels: 4 }, models: [],
}] });
const genericConfig = () => validateBridgeConfig({ schemaVersion: 2, bridge: {}, providers: [{
  id: "generic", kind: "openai-responses", baseUrl: "https://provider.example/v1", allowPrivateNetwork: false,
  models: [{ id: "example/model", slug: "generic/example/model", displayName: "Fixture", type: "llm", contextWindow: 32768 }],
}] });
const wrapped = (code) => new TypeError(PRIVATE, { cause: Object.assign(new Error(PRIVATE), { code }) });

async function setupFixture(t, config = loadedConfig()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pickermux-discovery-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = { HOME: directory, CODEX_HOME: path.join(directory, "codex") };
  const paths = resolveInstallPaths(environment);
  return { paths, options: {
    paths, distributionPaths: resolveDistributionPaths(environment), sourceRoot: path.join(directory, "source"), codexPath: "/fixture/codex",
    desktopRunningImpl: async () => false, accountCacheImpl: async () => ({ status: "ready" }),
    loadConfigImpl: async () => config,
    setupImpl: async () => assert.fail("Failed discovery must not activate or install"),
  } };
}

test("discovery classification uses only bounded consistent structured causes", () => {
  for (const [code, expected] of [
    ["ECONNREFUSED", "PROVIDER_UNAVAILABLE"], ["ENETUNREACH", "PROVIDER_UNAVAILABLE"], ["EHOSTUNREACH", "PROVIDER_UNAVAILABLE"],
    ["ENOTFOUND", "PROVIDER_UNAVAILABLE"], ["EAI_AGAIN", "PROVIDER_UNAVAILABLE"],
    ["ETIMEDOUT", "PROVIDER_TIMEOUT"], ["UND_ERR_CONNECT_TIMEOUT", "PROVIDER_TIMEOUT"], ["UND_ERR_HEADERS_TIMEOUT", "PROVIDER_TIMEOUT"], ["UND_ERR_BODY_TIMEOUT", "PROVIDER_TIMEOUT"],
    ["EACCES", "PROVIDER_PERMISSION_DENIED"], ["EPERM", "PROVIDER_PERMISSION_DENIED"],
    ["ECONNRESET", null], [PRIVATE, null],
  ]) assert.equal(classifyDiscoveryFailure(wrapped(code)), expected);
  assert.equal(classifyDiscoveryFailure(new Error("ECONNREFUSED EPERM timeout HTTP 401 invalid JSON")), null);
  assert.equal(classifyDiscoveryFailure(new AggregateError([wrapped("ECONNREFUSED"), wrapped("EACCES")])), null);
  assert.equal(classifyDiscoveryFailure(new AggregateError([wrapped("ECONNREFUSED"), new Error(PRIVATE)])), null);
  assert.equal(classifyDiscoveryFailure(new AggregateError([wrapped("EACCES"), wrapped("EPERM")])), "PROVIDER_PERMISSION_DENIED");
  assert.equal(classifyDiscoveryFailure(new AggregateError(Array.from({ length: 33 }, () => wrapped("EPERM")))), null);
  const circular = new Error(PRIVATE); circular.cause = circular;
  assert.equal(classifyDiscoveryFailure(circular), null);
  let deep = wrapped("EPERM");
  for (let index = 0; index < 8; index += 1) deep = new Error(PRIVATE, { cause: deep });
  assert.equal(classifyDiscoveryFailure(deep), null);
});

test("loaded LM Studio discovery emits distinct typed HTTP, JSON, schema and permission errors with no fallback", async () => {
  for (const [fetchImpl, expected] of [
    [async () => new Response(PRIVATE, { status: 401 }), "PROVIDER_AUTH_REQUIRED"],
    [async () => new Response(PRIVATE, { status: 403 }), "PROVIDER_AUTH_REQUIRED"],
    [async () => new Response(PRIVATE, { status: 500 }), null],
    [async () => new Response(PRIVATE, { status: 200 }), "PROVIDER_RESPONSE_INVALID"],
    [async () => Response.json({ response: PRIVATE }), "PROVIDER_RESPONSE_INVALID"],
    [async () => { throw wrapped("EACCES"); }, "PROVIDER_PERMISSION_DENIED"],
    [async () => { throw wrapped("EPERM"); }, "PROVIDER_PERMISSION_DENIED"],
    [async () => { throw wrapped("ETIMEDOUT"); }, "PROVIDER_TIMEOUT"],
    [async () => { throw wrapped("ENETUNREACH"); }, "PROVIDER_UNAVAILABLE"],
    [async () => { throw new Error(PRIVATE); }, null],
  ]) {
    let requests = 0;
    await assert.rejects(discoverLmStudio({
      baseUrl: "http://127.0.0.1:1234/v1", discovery: { mode: "loaded" }, allowlist: [], apiToken: PRIVATE,
      fetchImpl: async (...args) => { requests += 1; return fetchImpl(...args); },
    }), (error) => {
      assert.equal(classifyDiscoveryFailure(error), expected);
      assert.equal(error.message.includes(PRIVATE), false);
      return true;
    });
    assert.equal(requests, 1);
  }
});

test("owned request deadline distinguishes fetch and response-body timeouts", async () => {
  for (const body of [false, true]) {
    let requests = 0;
    await assert.rejects(discoverLmStudio({
      baseUrl: "http://127.0.0.1:1234", discovery: { mode: "loaded" }, timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => {
        requests += 1;
        const wait = () => new Promise((_, reject) => {
          const keepAlive = setTimeout(() => reject(new Error(PRIVATE)), 1000);
          signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(new Error(PRIVATE)); }, { once: true });
        });
        if (body) return { ok: true, status: 200, json: wait };
        return wait();
      },
    }), (error) => error instanceof DiscoveryError && classifyDiscoveryFailure(error) === "PROVIDER_TIMEOUT" && !error.message.includes(PRIVATE));
    assert.equal(requests, 1);
  }
});

test("generic provider transport/response classification shares the same credential-isolated boundary", async () => {
  for (const [fetchImpl, expected] of [
    [async () => new Response(PRIVATE, { status: 403 }), "PROVIDER_AUTH_REQUIRED"],
    [async () => new Response(PRIVATE), "PROVIDER_RESPONSE_INVALID"],
    [async () => Response.json({ data: PRIVATE }), "PROVIDER_RESPONSE_INVALID"],
    [async () => { throw wrapped("EPERM"); }, "PROVIDER_PERMISSION_DENIED"],
  ]) {
    let requests = 0;
    await assert.rejects(discoverBridgeModels({
      config: genericConfig(), credentialResolver: async () => PRIVATE,
      fetchImpl: async (url, options) => {
        requests += 1;
        assert.equal(url, "https://provider.example/v1/models");
        assert.deepEqual(options.headers, { accept: "application/json", authorization: `Bearer ${PRIVATE}` });
        assert.equal(options.redirect, "error");
        return fetchImpl(url, options);
      },
    }), (error) => classifyDiscoveryFailure(error) === expected && !error.message.includes(PRIVATE));
    assert.equal(requests, 1);
  }
});

test("real injected discovery failures retain precise setup codes and never reveal private causes", async (t) => {
  for (const [fetchImpl, expected] of [
    [async () => { throw wrapped("ECONNREFUSED"); }, "PROVIDER_UNAVAILABLE"],
    [async () => { throw wrapped("EHOSTUNREACH"); }, "PROVIDER_UNAVAILABLE"],
    [async () => { throw wrapped("ETIMEDOUT"); }, "PROVIDER_TIMEOUT"],
    [async () => { throw wrapped("EACCES"); }, "PROVIDER_PERMISSION_DENIED"],
    [async () => { throw wrapped("EPERM"); }, "PROVIDER_PERMISSION_DENIED"],
    [async () => new Response(PRIVATE, { status: 401 }), "PROVIDER_AUTH_REQUIRED"],
    [async () => new Response(PRIVATE, { status: 403 }), "PROVIDER_AUTH_REQUIRED"],
    [async () => new Response(PRIVATE), "PROVIDER_RESPONSE_INVALID"],
    [async () => Response.json({ models: PRIVATE }), "PROVIDER_RESPONSE_INVALID"],
    [async () => { throw new Error(`ECONNREFUSED ${PRIVATE}`); }, "ACTION_FAILED"],
    [async () => new Response(PRIVATE, { status: 500 }), "ACTION_FAILED"],
    [async () => Response.json({ models: [] }), "NO_LOADED_MODELS"],
  ]) {
    const fixture = await setupFixture(t);
    let requests = 0;
    await assert.rejects(setupPickerMux({
      ...fixture.options,
      discoverImpl: ({ config }) => discoverBridgeModels({ config, credentialResolver: async () => PRIVATE, fetchImpl: async (...args) => { requests += 1; return fetchImpl(...args); } }),
    }), (error) => {
      const projected = companionFailure(error);
      assert.equal(projected.code, expected);
      assert.equal(JSON.stringify(projected).includes(PRIVATE), false);
      assert.equal(JSON.stringify(projected).includes(fixture.paths.codexHome), false);
      return true;
    });
    assert.equal(requests, 1);
    for (const target of [fixture.paths.configPath, fixture.paths.statePath, fixture.paths.runtimePath, fixture.paths.launchAgentPath]) await assert.rejects(readFile(target), { code: "ENOENT" });
  }
});

test("real loaded LM Studio response advances to setup sentinel without configuration, runtime or service mutation", async (t) => {
  const fixture = await setupFixture(t);
  const sentinel = new Error("isolated setup sentinel");
  let setupReached = false;
  let requests = 0;
  await assert.rejects(setupPickerMux({
    ...fixture.options,
    discoverImpl: async ({ config }) => {
      const discovery = await discoverBridgeModels({
        config, credentialResolver: async () => null,
        fetchImpl: async (url) => {
          requests += 1;
          assert.equal(url, "http://127.0.0.1:1234/api/v1/models");
          return Response.json({ models: [{
            key: "fixture/loaded-model", type: "llm", loaded_instances: [{ config: { context_length: 32768 } }],
            capabilities: { reasoning: { allowed_options: ["off", "on"] } },
          }] });
        },
      });
      assert.equal(discovery.models.length, 1);
      assert.equal(discovery.models[0].id, "lmstudio/fixture/loaded-model");
      return discovery;
    },
    setupImpl: async () => { setupReached = true; throw sentinel; },
  }), (error) => error === sentinel);
  assert.equal(setupReached, true);
  assert.equal(requests, 1);
  for (const target of [fixture.paths.configPath, fixture.paths.statePath, fixture.paths.runtimePath, fixture.paths.launchAgentPath]) await assert.rejects(readFile(target), { code: "ENOENT" });
});


test("generic deadline still starts before credential resolution and reaches fetch with its existing abort signal", async () => {
  for (const delayed of [false, true]) {
    let calls = 0;
    let lookupComplete = false;
    const operation = discoverBridgeModels({
      config: genericConfig(), timeoutMs: delayed ? 5 : 1000,
      credentialResolver: async () => {
        if (delayed) await new Promise((resolve) => setTimeout(resolve, 15));
        lookupComplete = true;
        return PRIVATE;
      },
      fetchImpl: async (_url, options) => {
        calls += 1;
        assert.equal(lookupComplete, true);
        assert.equal(options.signal.aborted, delayed);
        assert.equal(options.redirect, "error");
        assert.equal(options.headers.authorization, `Bearer ${PRIVATE}`);
        if (options.signal.aborted) throw new DOMException(PRIVATE, "AbortError");
        return Response.json({ data: [{ id: "example/model" }] });
      },
    });
    if (delayed) await assert.rejects(operation, (error) => classifyDiscoveryFailure(error) === "PROVIDER_TIMEOUT" && !error.message.includes(PRIVATE));
    else assert.equal((await operation).models.length, 1);
    assert.equal(calls, 1);
  }
});
