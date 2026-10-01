import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadCompanionServiceConfig, readCompanionPrivateFile } from "../src/companion-config.mjs";
import { getConfigStatus, installConfig } from "../src/config-manager.mjs";
import { createCompanionReadOnlyProbes } from "../src/companion-control.mjs";

const CONFIG = {
  schemaVersion: 2,
  bridge: { host: "127.0.0.1", port: 4210, providerId: "model_bridge", defaultModel: "gpt-5.6-sol", reasoningEffort: "ultra" },
  providers: [],
};
const PRIVATE = "PRIVATE_AUTH_TOKEN_DO_NOT_RETURN";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pickermux-private-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const codexHome = path.join(directory, "codex");
  const installDirectory = path.join(codexHome, "model-bridge");
  await mkdir(installDirectory, { recursive: true, mode: 0o700 });
  await chmod(codexHome, 0o755);
  const paths = {
    codexHome, installDirectory,
    serviceConfigPath: path.join(installDirectory, "service-config.json"),
    compatibilityPath: path.join(installDirectory, "compatibility.json"),
  };
  await writeFile(paths.serviceConfigPath, JSON.stringify(CONFIG), { mode: 0o600 });
  await writeFile(paths.compatibilityPath, "{}", { mode: 0o600 });
  return { directory, paths };
}

test("installed config reader permits a protected native home and preserves private file bytes", async (t) => {
  const { paths } = await fixture(t);
  const before = await readFile(paths.serviceConfigPath);
  const result = await loadCompanionServiceConfig({ paths });
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.bridge.host, "127.0.0.1");
  assert.deepEqual(result.providers, []);
  assert.deepEqual(await readFile(paths.serviceConfigPath), before);
  assert.deepEqual(await readCompanionPrivateFile({ paths, kind: "compatibility" }), Buffer.from("{}"));
});

test("service and compatibility auth aliases are rejected before accepting contents", async (t) => {
  for (const kind of ["service-config", "compatibility"]) {
    for (const makeAlias of [symlink, link]) {
      const { paths } = await fixture(t);
      const target = kind === "service-config" ? paths.serviceConfigPath : paths.compatibilityPath;
      const auth = path.join(paths.codexHome, "auth.json");
      // A valid-shaped payload makes following this alias an observable pass.
      await writeFile(auth, JSON.stringify(CONFIG), { mode: 0o600 });
      await rm(target);
      await makeAlias(auth, target);
      await assert.rejects(readCompanionPrivateFile({ paths, kind, allowMissing: true }), { code: "COMPANION_CONFIG_INVALID" });
      if (kind === "service-config") await assert.rejects(loadCompanionServiceConfig({ paths }), { code: "COMPANION_CONFIG_INVALID" });
    }
  }
});

test("reader rejects nonprivate managed files and directories or writable native homes", async (t) => {
  for (const [target, mode] of [["file", 0o644], ["file", 0o622], ["install", 0o755], ["install", 0o720], ["home", 0o777], ["home", 0o770]]) {
    const { paths } = await fixture(t);
    await chmod(target === "file" ? paths.serviceConfigPath : target === "install" ? paths.installDirectory : paths.codexHome, mode);
    await assert.rejects(loadCompanionServiceConfig({ paths, allowMissing: true }), { code: "COMPANION_CONFIG_INVALID" });
  }
});

test("symlinked parents cannot redirect the installed read", async (t) => {
  const { paths } = await fixture(t);
  const moved = path.join(paths.codexHome, "moved-bridge");
  await rename(paths.installDirectory, moved);
  await symlink(moved, paths.installDirectory);
  await assert.rejects(loadCompanionServiceConfig({ paths }), { code: "COMPANION_CONFIG_INVALID" });
  const other = await fixture(t);
  const movedHome = path.join(other.directory, "moved-home");
  await rename(other.paths.codexHome, movedHome);
  await symlink(movedHome, other.paths.codexHome);
  await assert.rejects(loadCompanionServiceConfig({ paths: other.paths }), { code: "COMPANION_CONFIG_INVALID" });
});

test("untrusted config values and malformed UTF-8 never enter errors", async (t) => {
  for (const bytes of [Buffer.from(PRIVATE), Buffer.from([0xff]), Buffer.from(JSON.stringify({ ...CONFIG, token: PRIVATE }))]) {
    const { paths } = await fixture(t);
    await writeFile(paths.serviceConfigPath, bytes);
    await assert.rejects(loadCompanionServiceConfig({ paths }), (error) => {
      assert.equal(error.code, "COMPANION_CONFIG_INVALID");
      assert.equal(error.message.includes(PRIVATE), false);
      assert.equal(error.message.includes(paths.codexHome), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("oversized or nonregular files fail closed before parsing", async (t) => {
  const { paths } = await fixture(t);
  await writeFile(paths.serviceConfigPath, Buffer.alloc(1024 * 1024 + 1, 32));
  await assert.rejects(loadCompanionServiceConfig({ paths }), { code: "COMPANION_CONFIG_INVALID" });
  await rm(paths.serviceConfigPath);
  await mkdir(paths.serviceConfigPath, { mode: 0o700 });
  await assert.rejects(loadCompanionServiceConfig({ paths }), { code: "COMPANION_CONFIG_INVALID" });
});

test("allowMissing means exact ENOENT and never relaxed ownership checks", async (t) => {
  const { paths } = await fixture(t);
  await rm(paths.serviceConfigPath);
  assert.equal(await loadCompanionServiceConfig({ paths, allowMissing: true }), null);
  await assert.rejects(loadCompanionServiceConfig({ paths }), { code: "ENOENT" });
  await symlink(path.join(paths.codexHome, "missing-auth.json"), paths.serviceConfigPath);
  await assert.rejects(loadCompanionServiceConfig({ paths, allowMissing: true }), { code: "COMPANION_CONFIG_INVALID" });
});

test("only fixed installed artifact paths are eligible", async (t) => {
  const { paths } = await fixture(t);
  const auth = path.join(paths.codexHome, "auth.json");
  await writeFile(auth, JSON.stringify(CONFIG), { mode: 0o600 });
  for (const changed of [
    { ...paths, serviceConfigPath: auth },
    { ...paths, installDirectory: paths.codexHome, serviceConfigPath: path.join(paths.codexHome, "service-config.json") },
    { ...paths, serviceConfigPath: `${paths.installDirectory}/../model-bridge/service-config.json` },
  ]) await assert.rejects(loadCompanionServiceConfig({ paths: changed }), { code: "COMPANION_CONFIG_INVALID" });
  await assert.rejects(readCompanionPrivateFile({ paths, kind: "auth" }), { code: "COMPANION_CONFIG_INVALID" });
  await assert.rejects(readCompanionPrivateFile({ paths: { ...paths, compatibilityPath: auth }, kind: "compatibility" }), { code: "COMPANION_CONFIG_INVALID" });
});

test("new companion service probe rejects private aliases before LaunchServices or provider I/O", async (t) => {
  for (const makeAlias of [symlink, link]) {
    const { paths } = await fixture(t);
    Object.assign(paths, {
      configPath: path.join(paths.codexHome, "config.toml"),
      statePath: path.join(paths.installDirectory, "state.json"),
      backupDirectory: path.join(paths.installDirectory, "backups"),
      catalogPath: path.join(paths.installDirectory, "models.json"),
    });
    await installConfig({
      configPath: paths.configPath, statePath: paths.statePath, backupDirectory: paths.backupDirectory,
      model: CONFIG.bridge.defaultModel, modelProvider: CONFIG.bridge.providerId, modelCatalogJson: paths.catalogPath,
      provider: { id: CONFIG.bridge.providerId, name: "OpenAI", baseUrl: "http://127.0.0.1:4210/c/test-only-capability/v1", wireApi: "responses", requiresOpenAiAuth: true, supportsWebsockets: false },
    });
    assert.equal((await getConfigStatus(paths)).status, "installed");
    const auth = path.join(paths.codexHome, "auth.json");
    await writeFile(auth, JSON.stringify(CONFIG), { mode: 0o600 });
    const before = await readFile(auth);
    await rm(paths.serviceConfigPath);
    await makeAlias(auth, paths.serviceConfigPath);
    await assert.rejects(createCompanionReadOnlyProbes({ paths }).service(), { code: "COMPANION_CONFIG_INVALID" });
    assert.deepEqual(await readFile(auth), before);
  }
});
