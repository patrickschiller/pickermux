import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { validateBridgeConfig } from "../src/bridge-config.mjs";
import {
  assertBridgeStartupCompatibility,
  assertBridgeWebSearchCompatibility,
  assertPersistentCredentialSupport,
  assertSelectedCatalogModel,
  buildCatalog,
  repairHistoricalChats,
  restoreRefreshState,
} from "../src/cli.mjs";

const execFileAsync = promisify(execFile);

test("managed web search publication requires the running service contract", () => {
  assert.doesNotThrow(() => assertBridgeWebSearchCompatibility({ webSearchContractVersion: 1 }));
  for (const health of [undefined, {}, { webSearchContractVersion: 0 }, { webSearchContractVersion: "1" }]) {
    assert.throws(() => assertBridgeWebSearchCompatibility(health), /standalone web search contract/u);
  }
});

test("release metadata and both CLI entry points identify PickerMux", async () => {
  const projectDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const packageMetadata = JSON.parse(
    await readFile(path.join(projectDirectory, "package.json"), "utf8"),
  );
  assert.equal(packageMetadata.name, "pickermux");
  assert.equal(packageMetadata.version, "0.9.1");
  assert.equal(packageMetadata.license, "MIT");

  for (const entryPoint of ["pickermux.mjs", "lmstudio-picker.mjs"]) {
    for (const helpArgument of ["help", "--help", "-h"]) {
      const { stdout } = await execFileAsync(
        process.execPath,
        [path.join(projectDirectory, "bin", entryPoint), helpArgument],
        { encoding: "utf8" },
      );
      assert.match(stdout, /PickerMux/u);
      assert.match(stdout, /CODEX_BINARY overrides discovery for this command/u);
      assert.match(stdout, /Setup and install automatically certify discovered models/u);
      assert.match(stdout, /several minutes per model/u);
      assert.match(stdout, /refresh --full \(also --FULL\)/u);
      assert.match(stdout, /pickermux companion status/u);
      assert.match(stdout, /pickermux companion run/u);
      assert.match(stdout, /After uninstall, fully restart Codex/u);
      assert.doesNotMatch(
        stdout,
        new RegExp(["Smart", "Routing"].join(" "), "iu"),
      );
      assert.equal(stdout.includes(["pickermux", "auto"].join("/")), false);
      assert.doesNotMatch(stdout, /Model Bridge P\d+\b/u);
    }
    for (const versionArgument of ["version", "--version", "-v"]) {
      const { stdout } = await execFileAsync(
        process.execPath,
        [path.join(projectDirectory, "bin", entryPoint), versionArgument],
        { encoding: "utf8" },
      );
      assert.equal(stdout, "pickermux 0.9.1\n");
    }
  }
});

test("managed catalog build rejects invalid account caches before provider discovery or publication", async (t) => {
  for (const cache of [undefined, "{not-json", JSON.stringify({
    client_version: "0.159.0",
    fetched_at: "2026-09-29T10:00:00.000Z",
    models: [{ slug: "private-account-model", context_window: 32_768, max_context_window: 32_768 }],
  })]) {
    await t.test(cache === undefined ? "missing" : cache.startsWith("{not") ? "malformed" : "patch update", async (subtest) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "pickermux-build-cache-"));
      subtest.after(() => rm(directory, { recursive: true, force: true }));
      const outputPath = path.join(directory, "models.json");
      const previousCatalog = "previous catalog must remain unchanged\n";
      await writeFile(outputPath, previousCatalog, { mode: 0o600 });
      if (cache !== undefined) {
        await writeFile(path.join(directory, "models_cache.json"), cache, { mode: 0o600 });
      }
      let externalCalls = 0;
      await assert.rejects(buildCatalog({
        config: { providers: [] },
        codexHome: directory,
        outputPath,
        allowBundledFallback: false,
        bundledCatalogImpl: async () => ({ models: [] }),
        clientVersionImpl: async () => "0.159.2",
        discoverImpl: async ({ credentialResolver }) => {
          externalCalls += 1;
          await credentialResolver();
          throw new Error("provider unavailable must not obscure cache recovery");
        },
        credentialResolver: async () => { externalCalls += 1; },
      }), (error) => {
        assert.match(error.message, /valid account-scoped Codex model cache is required/u);
        assert.match(error.message, /pickermux refresh --full/u);
        assert.match(error.message, /pickermux doctor/u);
        assert.doesNotMatch(error.message, /private-account-model/u);
        return true;
      });
      assert.equal(externalCalls, 0);
      assert.equal(await readFile(outputPath, "utf8"), previousCatalog);
      if (cache !== undefined) {
        assert.equal(await readFile(path.join(directory, "models_cache.json"), "utf8"), cache);
      }
    });
  }
});

test("managed catalog build publishes an old exact-version account cache after discovery", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pickermux-build-valid-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const models = [{ slug: "account-native", context_window: 32_768, max_context_window: 32_768 }];
  await writeFile(path.join(directory, "models_cache.json"), JSON.stringify({
    client_version: "0.159.2",
    fetched_at: "2026-01-01T00:00:00.000Z",
    models,
  }), { mode: 0o600 });
  let discoveries = 0;
  const outputPath = path.join(directory, "models.json");
  const result = await buildCatalog({
    config: { providers: [] },
    codexHome: directory,
    outputPath,
    allowBundledFallback: false,
    bundledCatalogImpl: async () => ({ models: [{ ...models[0], slug: "bundle-only" }] }),
    clientVersionImpl: async () => "0.159.2",
    discoverImpl: async () => {
      discoveries += 1;
      return { models: [] };
    },
  });
  assert.equal(discoveries, 1);
  assert.equal(result.nativeCatalog.source, "codex-account-cache");
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), { models });
});

test("setup keeps JSON stdout clean and returns a failing exit code for incomplete certification", async () => {
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const incomplete of [false, true]) {
    const script = `
      import { runCli } from "./src/cli.mjs";
      await runCli(["setup", "--json"], {
        assertNoPendingFullRefreshImpl: async () => {},
        setupImpl: async ({ onProgress }) => {
          onProgress({ phase: "start" });
          onProgress({ phase: ${incomplete} ? "failed" : "complete" });
          return {
            version: "0.8.0",
            activation: { action: "install" },
            certification: { status: ${incomplete} ? "incomplete" : "complete" },
          };
        },
      });
    `;
    const output = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], { cwd })
      .then((result) => ({ ...result, code: 0 }), (error) => error);
    assert.equal(output.code, incomplete ? 1 : 0);
    assert.equal(JSON.parse(output.stdout).certification.status, incomplete ? "incomplete" : "complete");
    assert.match(output.stderr, /several minutes per model/u);
    if (incomplete) {
      assert.match(output.stderr, /Installation retained/u);
      assert.doesNotMatch(output.stderr, /publication complete/u);
    }
  }
});

test("repair-chats reaches recovery before loading bridge configuration", async () => {
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const script = `
    import { runCli } from "./src/cli.mjs";
    await runCli(["repair-chats", "--json"], {
      assertNoPendingFullRefreshImpl: async () => {},
      repairHistoricalChatsImpl: async ({ paths, distributionPaths }) => ({
        changed: true,
        configPath: paths.configPath,
        lockPath: distributionPaths.lockPath,
      }),
    });
  `;
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd,
      env: {
        ...process.env,
        CODEX_BINARY: "/definitely/missing/codex",
        PICKERMUX_CONFIG_PATH: "/definitely/missing/bridge-config.json",
      },
    },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.changed, true);
  assert.match(result.configPath, /config\.toml$/u);
  assert.match(result.lockPath, /\.setup\.lock$/u);
  assert.equal(stderr, "");
});

test("chat repair keeps its pending, desktop, and config checks inside the lifecycle lock", async () => {
  const paths = {
    configPath: "/fixture/codex/config.toml",
    statePath: "/fixture/codex/model-bridge/state.json",
    backupDirectory: "/fixture/codex/model-bridge/backups",
  };
  const distributionPaths = { lockPath: "/fixture/pickermux/.setup.lock" };
  const events = [];
  let locked = false;
  const result = await repairHistoricalChats({
    paths,
    distributionPaths,
    withLockImpl: async (received, operation) => {
      assert.equal(received, distributionPaths);
      locked = true;
      events.push("lock");
      try {
        return await operation();
      } finally {
        locked = false;
        events.push("unlock");
      }
    },
    assertNoPendingFullRefreshImpl: async () => {
      assert.equal(locked, true);
      events.push("pending-check");
    },
    desktopRunningImpl: async () => {
      assert.equal(locked, true);
      events.push("desktop-check");
      return false;
    },
    repairConfigImpl: async (received) => {
      assert.equal(locked, true);
      assert.equal(received.configPath, paths.configPath);
      assert.equal(received.statePath, paths.statePath);
      assert.equal(received.backupDirectory, paths.backupDirectory);
      events.push("repair");
      return { changed: true };
    },
  });
  assert.equal(result.changed, true);
  assert.equal(events[0], "lock");
  assert.equal(events.at(-1), "unlock");
  assert.ok(events.indexOf("pending-check") < events.indexOf("repair"));
  assert.ok(events.indexOf("desktop-check") < events.indexOf("repair"));
});

test("chat repair refuses a running desktop or pending full refresh", async () => {
  const paths = {
    configPath: "/fixture/codex/config.toml",
    statePath: "/fixture/codex/model-bridge/state.json",
    backupDirectory: "/fixture/codex/model-bridge/backups",
  };
  const distributionPaths = { lockPath: "/fixture/pickermux/.setup.lock" };
  for (const blocker of ["desktop", "pending"]) {
    let repaired = false;
    await assert.rejects(
      repairHistoricalChats({
        paths,
        distributionPaths,
        withLockImpl: async (_received, operation) => operation(),
        assertNoPendingFullRefreshImpl: async () => {
          if (blocker === "pending") throw new Error("full refresh pending");
        },
        desktopRunningImpl: async () => blocker === "desktop",
        repairConfigImpl: async () => {
          repaired = true;
          return { changed: true };
        },
      }),
    );
    assert.equal(repaired, false, `${blocker} guard must prevent configuration write`);
  }
});

test("selected picker model and effort must survive a refreshed catalog", () => {
  const catalog = {
    models: [
      {
        slug: "gpt-5.5",
        supported_reasoning_levels: [{ effort: "xhigh" }, { effort: "ultra" }],
      },
    ],
  };
  assert.equal(
    assertSelectedCatalogModel(catalog, "gpt-5.5", "ultra"),
    true,
  );
  assert.throws(
    () => assertSelectedCatalogModel(catalog, "gpt-5.3-codex-spark", "xhigh"),
    /missing selected model/u,
  );
  assert.throws(
    () => assertSelectedCatalogModel(catalog, "gpt-5.5", "medium"),
    /does not support reasoning effort/u,
  );
});

test("persistent launch-agent install fails closed for environment credentials", () => {
  const protectedConfig = validateBridgeConfig({
    schemaVersion: 2,
    bridge: {},
    providers: [
      {
        id: "vendor",
        kind: "openai-responses",
        baseUrl: "https://api.vendor.example/v1",
        allowPrivateNetwork: false,
        credentialEnv: "VENDOR_TOKEN",
        models: [
          {
            id: "reasoner",
            slug: "vendor/reasoner",
            displayName: "Vendor Reasoner",
            type: "llm",
            contextWindow: 8_192,
          },
        ],
      },
    ],
  });
  assert.throws(
    () => assertPersistentCredentialSupport(protectedConfig),
    /Keychain.*vendor/u,
  );

  const keylessConfig = validateBridgeConfig({
    schemaVersion: 2,
    bridge: {},
    providers: [
      {
        id: "lmstudio",
        kind: "lmstudio-responses",
        baseUrl: "http://127.0.0.1:1234/v1",
        allowPrivateNetwork: true,
        models: [
          {
            id: "qwen/local",
            slug: "lmstudio/qwen/local",
            displayName: "Qwen Local",
          },
        ],
      },
    ],
  });
  assert.doesNotThrow(() => assertPersistentCredentialSupport(keylessConfig));
});

test("bridge startup compatibility checks the current binary and bundle", async () => {
  const bundledCatalog = { models: [{ slug: "gpt-test" }] };
  let compatibilityInput;
  const result = await assertBridgeStartupCompatibility({
    manifestPath: "/private/managed/compatibility.json",
    codexPath: "/Applications/Test.app/codex",
    bundledCatalogImpl: async ({ codexPath }) => {
      assert.equal(codexPath, "/Applications/Test.app/codex");
      return bundledCatalog;
    },
    clientVersionImpl: async ({ codexPath }) => {
      assert.equal(codexPath, "/Applications/Test.app/codex");
      return "0.151.0";
    },
    compatibilityImpl: async (input) => {
      compatibilityInput = input;
      return { status: "compatible", compatible: true, reasons: [] };
    },
  });

  assert.deepEqual(compatibilityInput, {
    manifestPath: "/private/managed/compatibility.json",
    bundledCatalog,
    codexClientVersion: "0.151.0",
  });
  assert.equal(result.codexClientVersion, "0.151.0");
  assert.equal(result.bundledCatalog, bundledCatalog);
  assert.equal(result.compatibility.status, "compatible");
});

test("bridge startup fails closed when the desktop contract requires an update", async () => {
  await assert.rejects(
    assertBridgeStartupCompatibility({
      manifestPath: "/private/managed/compatibility.json",
      codexPath: "/Applications/Test.app/codex",
      bundledCatalogImpl: async () => ({ models: [{ slug: "gpt-test" }] }),
      clientVersionImpl: async () => "0.152.0",
      compatibilityImpl: async () => ({
        status: "update-required",
        compatible: false,
        reasons: ["codex-client-version", "bundled-catalog"],
      }),
    }),
    /startup blocked.*update-required.*codex-client-version, bundled-catalog/iu,
  );
});

test("refresh rollback restores catalog and service config before restarting", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bridge-cli-refresh-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = {
    catalogPath: path.join(directory, "models.json"),
    serviceConfigPath: path.join(directory, "service-config.json"),
    runtimePath: path.join(directory, "runtime.json"),
    launchAgentLabel: "test.bridge",
  };
  await writeFile(paths.catalogPath, "new catalog\n");
  await writeFile(paths.serviceConfigPath, "new config\n");
  const rollbackConfig = { schemaVersion: 2 };
  let restartOptions;
  let restoredPackage;
  let searchConfigRestored = false;
  const servicePackage = {
    serviceDirectory: path.join(directory, "runtime-app"),
    previousPath: path.join(directory, "runtime-app.previous"),
    serviceConfigPath: paths.serviceConfigPath,
    previousServiceConfig: Buffer.from("old config\n"),
  };

  await restoreRefreshState({
    paths,
    previousCatalog: Buffer.from("old catalog\n"),
    previousServiceConfig: Buffer.from("old config\n"),
    rollbackConfig,
    servicePackage,
    managedConfigUpdate: {
      changed: true,
      async rollback() { searchConfigRestored = true; },
    },
    restorePackageImpl: async (options) => {
      restoredPackage = options;
    },
    restartImpl: async (options) => {
      restartOptions = options;
      assert.equal(searchConfigRestored, true);
      assert.equal(await readFile(paths.catalogPath, "utf8"), "old catalog\n");
      assert.equal(await readFile(paths.serviceConfigPath, "utf8"), "old config\n");
    },
  });

  assert.deepEqual(restartOptions, {
    config: rollbackConfig,
    runtimePath: paths.runtimePath,
    launchAgentLabel: paths.launchAgentLabel,
  });
  assert.deepEqual(restoredPackage, servicePackage);
});

test("search config rollback failure preserves recovery attempts and reports incomplete rollback", async () => {
  const calls = [];
  await assert.rejects(restoreRefreshState({
    paths: { catalogPath: "catalog", serviceConfigPath: "service", runtimePath: "runtime" },
    previousCatalog: Buffer.from("old catalog"),
    previousServiceConfig: Buffer.from("old service"),
    rollbackConfig: {},
    managedConfigUpdate: {
      changed: true,
      async rollback() {
        calls.push("search");
        throw new Error("concurrent user edit");
      },
    },
    restoreImpl: async (target) => { calls.push(target); },
    restartImpl: async () => { calls.push("restart"); },
  }), AggregateError);
  assert.deepEqual(calls, ["search", "catalog", "service", "restart"]);
});
