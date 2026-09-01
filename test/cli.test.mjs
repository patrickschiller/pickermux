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
  assertPersistentCredentialSupport,
  assertSelectedCatalogModel,
  restoreRefreshState,
} from "../src/cli.mjs";

const execFileAsync = promisify(execFile);

test("release metadata and both CLI entry points identify PickerMux", async () => {
  const projectDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const packageMetadata = JSON.parse(
    await readFile(path.join(projectDirectory, "package.json"), "utf8"),
  );
  assert.equal(packageMetadata.name, "pickermux");
  assert.equal(packageMetadata.version, "0.5.0");
  assert.equal(packageMetadata.license, "MIT");

  for (const entryPoint of ["pickermux.mjs", "lmstudio-picker.mjs"]) {
    for (const helpArgument of ["help", "--help", "-h"]) {
      const { stdout } = await execFileAsync(
        process.execPath,
        [path.join(projectDirectory, "bin", entryPoint), helpArgument],
        { encoding: "utf8" },
      );
      assert.match(stdout, /PickerMux/u);
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
      assert.equal(stdout, "pickermux 0.5.0\n");
    }
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
    restorePackageImpl: async (options) => {
      restoredPackage = options;
    },
    restartImpl: async (options) => {
      restartOptions = options;
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
