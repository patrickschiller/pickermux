import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONFIG_MARKERS,
  deactivateManagedConfiguration,
  inventoryDeactivatedConfigReactivation,
  enableManagedStandaloneWebSearch,
  getConfigStatus,
  installConfig,
  inventoryManagedConfigOwnership,
  inventoryNativeConfigRestoration,
  inventoryConfigIntegrationSwitch,
  inventoryManagedConfigReactivation,
  migrateManagedConfiguration,
  previewConfigIntegration,
  repairHistoricalChatsConfig,
  revalidateManagedConfigOwnership,
  revalidateNativeConfigRestoration,
  restoreManagedPickerDefaults,
  restoreRecoveredProviderEndMarker,
  setManagedPickerSelection,
  suspendManagedConfiguration,
  uninstallConfig,
} from "../src/config-manager.mjs";

const FIXED_NOW = new Date("2026-08-28T12:34:56.789Z");

test("canonical provider migration retains explicit transport controls and is a read-only no-op", async (t) => {
  const fixture = await makeFixture(t);
  const options = fixture.options();
  Object.assign(options.provider, {
    requiresOpenAiAuth: true,
    requestMaxRetries: 0,
    streamMaxRetries: 0,
    streamIdleTimeoutMs: 300000,
  });
  await installConfig(options);
  const beforeConfig = await snapshotFile(fixture.configPath);
  const beforeState = await snapshotFile(fixture.statePath);
  const preview = await previewConfigIntegration(fixture.paths());
  assert.equal(preview.status, "pickermux");
  assert.equal(preview.canApply, true);
  assert.equal(preview.requiresConfirmation, false);
  assert.deepEqual(preview.changes, []);
  assert.match(preview.previewToken, /^[a-f0-9]{64}$/u);
  assert.deepEqual(await migrateManagedConfiguration({ ...fixture.paths(), expectedPreviewToken: preview.previewToken }), {
    changed: false,
    layout: "explicit-provider-v1",
  });
  assert.deepEqual(await snapshotFile(fixture.configPath), beforeConfig);
  assert.deepEqual(await snapshotFile(fixture.statePath), beforeState);
  const text = beforeConfig.contents.toString("utf8");
  for (const control of [
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "supports_websockets = false",
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "stream_idle_timeout_ms = 300000",
  ]) assert.ok(text.includes(control));
});

test("legacy receipt-owned provider layout canonicalizes transactionally with its exact backup and rollback", async (t) => {
  for (const eol of ["\n", "\r\n"]) {
    await t.test(JSON.stringify(eol), async (subtest) => {
      const fixture = await makeFixture(subtest);
      const original = ['model = "gpt-5.6-sol"', "[features]", "other = true", ""].join(eol);
      await writeFile(fixture.configPath, original);
      await installConfig(fixture.options());
      await reorderReceiptedProvider(fixture, eol);
      const beforeConfig = await readFile(fixture.configPath);
      const beforeState = await readFile(fixture.statePath);
      const oldState = JSON.parse(beforeState);
      const preview = await previewConfigIntegration(fixture.paths());
      assert.deepEqual(preview.changes, ["normalize-owned-blocks", "retain-explicit-provider"]);
      const update = await migrateManagedConfiguration({ ...fixture.paths(), expectedPreviewToken: preview.previewToken });
      assert.equal(update.changed, true);
      assert.equal((await getConfigStatus(fixture.paths())).healthy, true);
      const nextState = JSON.parse(await readFile(fixture.statePath, "utf8"));
      assert.equal(nextState.version, 1);
      assert.equal(nextState.backupPath, oldState.backupPath);
      assert.equal(nextState.sourceSha256, oldState.sourceSha256);
      assert.equal(nextState.providerBaseUrl, oldState.providerBaseUrl);
      assert.equal(await readFile(oldState.backupPath, "utf8"), original);
      assert.deepEqual(await migrateManagedConfiguration(fixture.paths()), { changed: false, layout: "explicit-provider-v1" });
      const migrated = await readFile(fixture.configPath, "utf8");
      if (eol === "\r\n") assert.equal(migrated.replaceAll("\r\n", "").includes("\n"), false);
      await update.rollback();
      assert.deepEqual(await readFile(fixture.configPath), beforeConfig);
      assert.deepEqual(await readFile(fixture.statePath), beforeState);
      await update.rollback();
      await migrateManagedConfiguration(fixture.paths());
      await uninstallConfig(fixture.paths());
      assert.equal(await readFile(fixture.configPath, "utf8"), original);
    });
  }
});

test("canonical migration preserves picker selection, contributor edits and historical aliases", async (t) => {
  const fixture = await makeFixture(t);
  const original = '[model_providers.older_bridge]\nname = "Historical alias"\n';
  await writeFile(fixture.configPath, original);
  await installConfig(fixture.options());
  await reorderReceiptedProvider(fixture, "\n");
  await setManagedPickerSelection({ ...fixture.paths(), model: "lmstudio/changed", modelReasoningEffort: "high" });
  const selected = await readFile(fixture.configPath, "utf8");
  await writeFile(fixture.configPath, `${selected}user_added = true\n`);
  await migrateManagedConfiguration(fixture.paths());
  const status = await getConfigStatus(fixture.paths());
  assert.equal(status.model, "lmstudio/changed");
  assert.equal(status.modelReasoningEffort, "high");
  const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
  assert.equal(state.model, "lmstudio/qwen3.8-27b");
  assert.equal(state.installedSha256, undefined);
  await uninstallConfig(fixture.paths());
  assert.equal(await readFile(fixture.configPath, "utf8"), `${original}user_added = true\n`);
});

test("canonical migration materializes only a uniquely receipt-recovered provider marker", async (t) => {
  const fixture = await makeFixture(t);
  await installConfig(fixture.options());
  const installed = await readFile(fixture.configPath, "utf8");
  await writeFile(fixture.configPath, removeProviderEndMarker(installed, "\n"));
  assert.equal((await getConfigStatus(fixture.paths())).status, "installed-marker-recovered");
  assert.equal((await migrateManagedConfiguration(fixture.paths())).changed, true);
  assert.equal(await readFile(fixture.configPath, "utf8"), installed);
  await uninstallConfig(fixture.paths());
  await assert.rejects(readFile(fixture.configPath), { code: "ENOENT" });
});

test("canonical migration rejects managed edits, unknown controls and ambiguous provider schemas without changing bytes", async (t) => {
  for (const change of [
    { label: "unreceipted edit", replace: (source) => source.replace('wire_api = "responses"', 'wire_api = "chat"'), code: "MANAGED_BLOCK_MODIFIED" },
    { label: "unknown setting", replace: (source) => source.replace(CONFIG_MARKERS.providerEnd, `new_control = true\n${CONFIG_MARKERS.providerEnd}`), reseal: true },
    { label: "duplicate control", replace: (source) => source.replace(CONFIG_MARKERS.providerEnd, `supports_websockets = true\n${CONFIG_MARKERS.providerEnd}`), reseal: true },
    { label: "unknown transport", replace: (source) => source.replace('wire_api = "responses"', 'wire_api = "chat"'), reseal: true },
    { label: "invalid integer", replace: (source) => source.replace(CONFIG_MARKERS.providerEnd, `request_max_retries = -1\n${CONFIG_MARKERS.providerEnd}`), reseal: true },
    { label: "missing control", replace: (source) => source.replace("supports_websockets = false\n", ""), reseal: true },
  ]) {
    await t.test(change.label, async (subtest) => {
      const fixture = await makeFixture(subtest);
      await installConfig(fixture.options());
      await rewriteReceiptedProvider(fixture, change.replace, change.reseal === true);
      const config = await readFile(fixture.configPath);
      const state = await readFile(fixture.statePath);
      await assert.rejects(migrateManagedConfiguration(fixture.paths()), { code: change.code ?? "MANAGED_PROVIDER_SCHEMA_CONFLICT" });
      const preview = await previewConfigIntegration(fixture.paths());
      assert.equal(preview.status, "conflict");
      assert.equal(preview.canApply, false);
      assert.deepEqual(await readFile(fixture.configPath), config);
      assert.deepEqual(await readFile(fixture.statePath), state);
    });
  }
});

test("canonical migration preview, commit and rollback reject concurrent changes", async (t) => {
  for (const target of ["configPath", "statePath"]) {
    await t.test(target, async (subtest) => {
      const fixture = await makeFixture(subtest);
      await installConfig(fixture.options());
      await reorderReceiptedProvider(fixture, "\n");
      const beforeConfig = await readFile(fixture.configPath);
      const beforeState = await readFile(fixture.statePath);
      const concurrent = target === "configPath" ? Buffer.from(`${beforeConfig}# concurrent edit\n`) : Buffer.from(`${beforeState} `);
      await assert.rejects(migrateManagedConfiguration({
        ...fixture.paths(),
        beforeConfigCommit: () => writeFile(fixture[target], concurrent),
      }), (error) => ["CONFIG_CHANGED_CONCURRENTLY", "MANAGED_FILE_CHANGED"].includes(error.code));
      assert.deepEqual(await readFile(fixture[target]), concurrent);
      assert.deepEqual(await readFile(target === "configPath" ? fixture.statePath : fixture.configPath), target === "configPath" ? beforeState : beforeConfig);
    });
  }
  const fixture = await makeFixture(t);
  await installConfig(fixture.options());
  await reorderReceiptedProvider(fixture, "\n");
  const preview = await previewConfigIntegration(fixture.paths());
  const source = await readFile(fixture.configPath, "utf8");
  await writeFile(fixture.configPath, `${source}# selection changed after preview\n`);
  await assert.rejects(migrateManagedConfiguration({ ...fixture.paths(), expectedPreviewToken: preview.previewToken }), { code: "INTEGRATION_PREVIEW_CHANGED" });
  const update = await migrateManagedConfiguration(fixture.paths());
  const migrated = await readFile(fixture.configPath, "utf8");
  const concurrent = `${migrated}# changed after migration\n`;
  await writeFile(fixture.configPath, concurrent);
  await assert.rejects(update.rollback(), { code: "CONFIG_CHANGED_CONCURRENTLY" });
  assert.equal(await readFile(fixture.configPath, "utf8"), concurrent);
});

test("Ollama preview is redacted, read-only and requires an exact approved switch receipt", async (t) => {
  const fixture = await makeFixture(t);
  const original = [
    'model = "private-ollama-model"',
    'model_catalog_json = "/private/user/ollama-launch-models.json"',
    'openai_base_url = "http://127.0.0.1:11434/api/codex/v1" # user gateway',
    'desktop.enabled-reasoning-efforts = ["none", "max"]',
    "[features]",
    'openai_base_url = "table-scoped-untouched"',
    "",
  ].join("\r\n");
  await writeFile(fixture.configPath, original);
  await symlink(join(fixture.directory, "missing-auth-target"), join(fixture.directory, "codex", "auth.json"));
  const before = await snapshotFile(fixture.configPath);
  const preview = await previewConfigIntegration(fixture.paths());
  assert.equal(preview.schemaVersion, 1);
  assert.equal(preview.status, "ollama");
  assert.equal(preview.canApply, true);
  assert.equal(preview.requiresConfirmation, true);
  assert.match(preview.previewToken, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(preview), /private-ollama-model|private\/user|127\.0\.0\.1|11434|api\/codex|auth/u);
  assert.deepEqual(await snapshotFile(fixture.configPath), before);
  await assert.rejects(installConfig(fixture.options()), { code: "INTEGRATION_CONFLICT" });
  await assert.rejects(installConfig(fixture.options({ integrationSwitchReceipt: {} })), { code: "INTEGRATION_CONFLICT" });
  await assert.rejects(readFile(fixture.statePath), { code: "ENOENT" });
  const receipt = await inventoryConfigIntegrationSwitch({ ...fixture.paths(), expectedPreviewToken: preview.previewToken });
  const installed = await installConfig(fixture.options({ integrationSwitchReceipt: receipt }));
  assert.equal(await readFile(installed.backupPath, "utf8"), original);
  const config = await readFile(fixture.configPath, "utf8");
  assert.doesNotMatch(config, /11434/u);
  assert.match(config, /openai_base_url = "table-scoped-untouched"/u);
  assert.match(config, /desktop.enabled-reasoning-efforts = \["none", "max"\]/u);
  const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
  assert.equal(state.priorAssignments.find(({ key }) => key === "openai_base_url").raw.endsWith("# user gateway"), true);
  await writeFile(fixture.configPath, `${config}user_added = true\r\n`);
  await uninstallConfig(fixture.paths());
  const restored = await readFile(fixture.configPath, "utf8");
  assert.match(restored, /11434\/api\/codex\/v1/u);
  assert.match(restored, /# user gateway/u);
  assert.match(restored, /user_added = true/u);
});

test("foreign integration switch fails closed when preview, source, or state changes", async (t) => {
  const fixture = await makeFixture(t);
  const original = 'openai_base_url = "http://127.0.0.1:4567/private-gateway/v1"\n';
  await writeFile(fixture.configPath, original);
  const preview = await previewConfigIntegration(fixture.paths());
  assert.equal(preview.status, "foreign");
  const changed = `${original}# contributor change\n`;
  await writeFile(fixture.configPath, changed);
  await assert.rejects(inventoryConfigIntegrationSwitch({ ...fixture.paths(), expectedPreviewToken: preview.previewToken }), { code: "INTEGRATION_PREVIEW_CHANGED" });
  const fresh = await previewConfigIntegration(fixture.paths());
  const receipt = await inventoryConfigIntegrationSwitch({ ...fixture.paths(), expectedPreviewToken: fresh.previewToken });
  await writeFile(fixture.configPath, original);
  await assert.rejects(installConfig(fixture.options({ integrationSwitchReceipt: receipt })), { code: "INTEGRATION_PREVIEW_CHANGED" });
  const initial = await previewConfigIntegration(fixture.paths());
  const currentReceipt = await inventoryConfigIntegrationSwitch({ ...fixture.paths(), expectedPreviewToken: initial.previewToken });
  await assert.rejects(installConfig(fixture.options({
    integrationSwitchReceipt: currentReceipt,
    beforeConfigCommit: () => writeFile(fixture.configPath, changed),
  })), { code: "CONFIG_CHANGED_CONCURRENTLY" });
  assert.equal(await readFile(fixture.configPath, "utf8"), changed);
  await assert.rejects(readFile(fixture.statePath), { code: "ENOENT" });
  const finalPreview = await previewConfigIntegration(fixture.paths());
  const finalReceipt = await inventoryConfigIntegrationSwitch({ ...fixture.paths(), expectedPreviewToken: finalPreview.previewToken });
  await assert.rejects(installConfig(fixture.options({
    integrationSwitchReceipt: finalReceipt,
    beforeConfigCommit: async () => {
      await mkdir(join(fixture.directory, "state"), { recursive: true, mode: 0o700 });
      await writeFile(fixture.statePath, "concurrent-owner", { mode: 0o600 });
    },
  })), { code: "CONFIG_CHANGED_CONCURRENTLY" });
  assert.equal(await readFile(fixture.configPath, "utf8"), changed);
  assert.equal(await readFile(fixture.statePath, "utf8"), "concurrent-owner");
});

test("switch restoration refuses a new user-owned root gateway even with force", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(fixture.configPath, 'openai_base_url = "http://127.0.0.1:4567/previous/v1"\n');
  const preview = await previewConfigIntegration(fixture.paths());
  const receipt = await inventoryConfigIntegrationSwitch({ ...fixture.paths(), expectedPreviewToken: preview.previewToken });
  await installConfig(fixture.options({ integrationSwitchReceipt: receipt }));
  const installed = await readFile(fixture.configPath, "utf8");
  const changed = `openai_base_url = "http://127.0.0.1:6789/contributor/v1"\n${installed}`;
  await writeFile(fixture.configPath, changed);
  const state = await readFile(fixture.statePath);
  for (const force of [false, true]) {
    await assert.rejects(uninstallConfig({ ...fixture.paths(), force }), { code: "INTEGRATION_CONFLICT" });
  }
  assert.equal((await previewConfigIntegration(fixture.paths())).status, "conflict");
  await assert.rejects(migrateManagedConfiguration(fixture.paths()), { code: "INTEGRATION_CONFLICT" });
  assert.equal(await readFile(fixture.configPath, "utf8"), changed);
  assert.deepEqual(await readFile(fixture.statePath), state);
});

test("integration previews reject malformed gateways and ignore comments or multiline string contents", async (t) => {
  for (const source of [
    'openai_base_url = "http://127.0.0.1:11434/api/codex/v1"\nopenai_base_url = "duplicate"\n',
    '"openai_base_url" = ["wrong-type"]\n',
    'openai_base_url.extra = "ambiguous"\n',
    'openai_base_url = """\nprivate-gateway\n"""\n',
  ]) {
    await t.test(source.split("\n")[0], async (subtest) => {
      const fixture = await makeFixture(subtest);
      await writeFile(fixture.configPath, source);
      const preview = await previewConfigIntegration(fixture.paths());
      assert.equal(preview.status, "conflict");
      assert.equal(preview.canApply, false);
      assert.equal(await readFile(fixture.configPath, "utf8"), source);
    });
  }
  const fixture = await makeFixture(t);
  const source = '# openai_base_url = "comment"\nprompt = """\nopenai_base_url = "private-content"\nmodel_provider = "private-provider"\n"""\n[features]\nopenai_base_url = "table-scoped"\n';
  await writeFile(fixture.configPath, source);
  const preview = await previewConfigIntegration(fixture.paths());
  assert.equal(preview.status, "none");
  assert.equal(preview.requiresConfirmation, false);
  assert.equal(await readFile(fixture.configPath, "utf8"), source);
});

test("active root profiles fail closed across inspection, install, migration and suspension without changing profile bytes", async (t) => {
  for (const eol of ["\n", "\r\n"]) {
    for (const key of ["profile", '"profile"', "'profile'", '"profi\\u006ce"']) {
      await t.test(`${JSON.stringify(eol)} ${key}`, async (subtest) => {
        const fixture = await makeFixture(subtest);
        const profile = `${key} = "private-selected-profile"${eol}`;
        await writeFile(fixture.configPath, profile);
        const initial = await snapshotFile(fixture.configPath);
        const preview = await previewConfigIntegration(fixture.paths());
        assert.equal(preview.status, "conflict");
        assert.equal(preview.canApply, false);
        assert.doesNotMatch(JSON.stringify(preview), /private-selected-profile/u);
        assert.deepEqual(pickStatus(await getConfigStatus(fixture.paths())), { installed: false, healthy: false, status: "integration-conflict" });
        await assert.rejects(installConfig(fixture.options()), { code: "INTEGRATION_CONFLICT" });
        assert.deepEqual(await snapshotFile(fixture.configPath), initial);
        await assert.rejects(readFile(fixture.statePath), { code: "ENOENT" });

        await writeFile(fixture.configPath, `[profiles.inactive]${eol}model = "user-model"${eol}`);
        await installConfig(fixture.options());
        const installed = await readFile(fixture.configPath, "utf8");
        await writeFile(fixture.configPath, `${profile}${installed}`);
        const changed = await snapshotFile(fixture.configPath);
        const state = await snapshotFile(fixture.statePath);
        const status = await getConfigStatus(fixture.paths());
        assert.equal(status.healthy, false);
        assert.equal(status.error.code, "INTEGRATION_CONFLICT");
        await assert.rejects(migrateManagedConfiguration(fixture.paths()), { code: "INTEGRATION_CONFLICT" });
        await assert.rejects(suspendManagedConfiguration(fixture.paths()), { code: "INTEGRATION_CONFLICT" });
        assert.deepEqual(await snapshotFile(fixture.configPath), changed);
        assert.deepEqual(await snapshotFile(fixture.statePath), state);
      });
    }
  }
});

test("inactive profile tables and profile-looking comments or multiline content do not block ownership", async (t) => {
  const fixture = await makeFixture(t);
  const original = '# profile = "comment"\nprompt = """\nprofile = "prompt-content"\n"""\n[profiles.inactive]\nmodel = "user-model"\n';
  await writeFile(fixture.configPath, original);
  assert.equal((await previewConfigIntegration(fixture.paths())).status, "none");
  await installConfig(fixture.options());
  assert.equal((await getConfigStatus(fixture.paths())).healthy, true);
  await uninstallConfig(fixture.paths());
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
});

test("full-refresh suspension and reactivation retain the prior integration while opening a native-only root", async (t) => {
  for (const eol of ["\n", "\r\n"]) {
    await t.test(JSON.stringify(eol), async (subtest) => {
      const fixture = await makeFixture(subtest);
      const original = [
        'model = "private-ollama-model"',
        'model_catalog_json = "/private/user/ollama-launch-models.json"',
        'openai_base_url = "http://127.0.0.1:11434/api/codex/v1"',
        'desktop.enabled-reasoning-efforts = ["none", "max"]',
        "[model_providers.historical_alias]",
        'name = "Historical alias"',
        "",
      ].join(eol);
      await writeFile(fixture.configPath, original, { mode: 0o640 });
      const preview = await previewConfigIntegration(fixture.paths());
      const switchReceipt = await inventoryConfigIntegrationSwitch({ ...fixture.paths(), expectedPreviewToken: preview.previewToken });
      const installed = await installConfig(fixture.options({ integrationSwitchReceipt: switchReceipt }));
      const before = JSON.parse(await readFile(fixture.statePath, "utf8"));
      const suspended = await suspendManagedConfiguration(fixture.paths());
      assert.equal(suspended.changed, true);
      assert.deepEqual(await suspendManagedConfiguration(fixture.paths()), { changed: false, suspended: true });
      const native = await readFile(fixture.configPath, "utf8");
      assert.doesNotMatch(native, /private-ollama-model|model_catalog_json|openai_base_url|model_provider =|model_reasoning_effort|lm-studio-model-router:p2/u);
      assert.match(native, /desktop.enabled-reasoning-efforts/u);
      assert.match(native, /model_providers.historical_alias/u);
      const status = await getConfigStatus(fixture.paths());
      assert.deepEqual(pickStatus(status), { installed: false, healthy: true, status: "suspended" });
      assert.equal(status.recoveryRequired, true);
      assert.equal((await previewConfigIntegration(fixture.paths())).canApply, false);
      const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
      assert.deepEqual(Object.keys(state.suspension).sort(), ["configSha256", "kind", "pristine"]);
      assert.equal(state.sourceSha256, before.sourceSha256);
      assert.equal(state.backupPath, installed.backupPath);
      assert.equal(state.suspension.pristine, true);
      const reactivationReceipt = await inventoryManagedConfigReactivation(fixture.paths());
      const options = fixture.options({ reactivationReceipt });
      options.provider.baseUrl = "http://127.0.0.1:4210/replacement-capability/v1";
      const resumed = await installConfig(options);
      assert.equal(resumed.backupPath, installed.backupPath);
      const active = JSON.parse(await readFile(fixture.statePath, "utf8"));
      assert.equal(active.suspension, undefined);
      assert.equal(active.sourceSha256, before.sourceSha256);
      assert.deepEqual(active.priorAssignments, before.priorAssignments);
      assert.equal((await getConfigStatus(fixture.paths())).healthy, true);
      assert.equal((await stat(fixture.configPath)).mode & 0o777, 0o640);
      assert.equal(await readFile(installed.backupPath, "utf8"), original);
      await uninstallConfig(fixture.paths());
      assert.equal(await readFile(fixture.configPath, "utf8"), original);
    });
  }
});

test("suspension and reactivation preserve contributor edits and absent-config provenance", async (t) => {
  const fixture = await makeFixture(t);
  const original = 'model = "gpt-5.6-sol"\n[features]\nother = true\n';
  await writeFile(fixture.configPath, original);
  await installConfig(fixture.options());
  await setManagedPickerSelection({ ...fixture.paths(), model: "lmstudio/changed", modelReasoningEffort: "high" });
  const installed = await readFile(fixture.configPath, "utf8");
  await writeFile(fixture.configPath, `${installed}user_added = true\n`);
  await suspendManagedConfiguration(fixture.paths());
  const receipt = await inventoryManagedConfigReactivation(fixture.paths());
  await installConfig(fixture.options({ reactivationReceipt: receipt }));
  const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
  assert.equal(state.installedSha256, undefined);
  await uninstallConfig(fixture.paths());
  assert.equal(await readFile(fixture.configPath, "utf8"), `${original}user_added = true\n`);

  const absent = await makeFixture(t);
  await installConfig(absent.options());
  await suspendManagedConfiguration(absent.paths());
  assert.equal(await readFile(absent.configPath, "utf8"), "");
  const absentReceipt = await inventoryManagedConfigReactivation(absent.paths());
  await installConfig(absent.options({ reactivationReceipt: absentReceipt }));
  await uninstallConfig(absent.paths());
  await assert.rejects(readFile(absent.configPath), { code: "ENOENT" });
});

test("full-refresh config suspension rolls back exactly and rejects later concurrent rollback", async (t) => {
  const fixture = await makeFixture(t);
  await installConfig(fixture.options());
  const config = await readFile(fixture.configPath);
  const state = await readFile(fixture.statePath);
  const update = await suspendManagedConfiguration(fixture.paths());
  await update.rollback();
  await update.rollback();
  assert.deepEqual(await readFile(fixture.configPath), config);
  assert.deepEqual(await readFile(fixture.statePath), state);
  const changed = await suspendManagedConfiguration(fixture.paths());
  const native = await readFile(fixture.configPath, "utf8");
  const concurrent = `${native}# contributor native edit\n`;
  await writeFile(fixture.configPath, concurrent);
  await assert.rejects(changed.rollback(), { code: "CONFIG_CHANGED_CONCURRENTLY" });
  assert.equal(await readFile(fixture.configPath, "utf8"), concurrent);
  assert.deepEqual(pickStatus(await getConfigStatus(fixture.paths())), { installed: false, healthy: false, status: "suspension-conflict" });
});

test("uninstall cancels an unchanged suspension and restores the prior integration with contributor edits", async (t) => {
  for (const edited of [false, true]) {
    await t.test(edited ? "contributor edit" : "pristine", async (subtest) => {
      const fixture = await makeFixture(subtest);
      const original = 'openai_base_url = "http://127.0.0.1:4567/previous/v1"\n[features]\nother = true\n';
      await writeFile(fixture.configPath, original);
      const preview = await previewConfigIntegration(fixture.paths());
      const switchReceipt = await inventoryConfigIntegrationSwitch({ ...fixture.paths(), expectedPreviewToken: preview.previewToken });
      await installConfig(fixture.options({ integrationSwitchReceipt: switchReceipt }));
      if (edited) {
        const active = await readFile(fixture.configPath, "utf8");
        await writeFile(fixture.configPath, `${active}user_added = true\n`);
      }
      await suspendManagedConfiguration(fixture.paths());
      const receipt = await inventoryManagedConfigReactivation(fixture.paths());
      const removed = await uninstallConfig(fixture.paths());
      assert.equal(removed.installed, false);
      assert.equal(await readFile(fixture.configPath, "utf8"), edited ? `${original}user_added = true\n` : original);
      await assert.rejects(readFile(fixture.statePath), { code: "ENOENT" });
      await assert.rejects(installConfig(fixture.options({ reactivationReceipt: receipt })), (error) => ["MANAGED_FILE_CHANGED", "STATE_CHANGED_CONCURRENTLY"].includes(error.code));
    });
  }
  const fixture = await makeFixture(t);
  await installConfig(fixture.options());
  await suspendManagedConfiguration(fixture.paths());
  await uninstallConfig(fixture.paths());
  await assert.rejects(readFile(fixture.configPath), { code: "ENOENT" });
});

test("cancelling a suspended canonical integration preserves the inert historical provider", async (t) => {
  const fixture = await makeFixture(t);
  const options = fixture.options();
  options.modelProvider = "model_bridge";
  options.provider.id = "model_bridge";
  await installConfig(options);
  await suspendManagedConfiguration(fixture.paths());
  await uninstallConfig({ ...fixture.paths(), preserveHistoricalModelBridge: true });
  const restored = await readFile(fixture.configPath, "utf8");
  assert.match(restored, /model_providers.model_bridge/u);
  assert.match(restored, /base_url = "http:\/\/127\.0\.0\.1:0\/v1"/u);
  assert.match(restored, /request_max_retries = 0/u);
  assert.doesNotMatch(restored, /model_provider =|model_catalog_json =/u);
});

test("reactivation rejects forged, stale, mismatched and modified-backup receipts", async (t) => {
  const fixture = await makeFixture(t);
  const installed = await installConfig(fixture.options());
  await suspendManagedConfiguration(fixture.paths());
  const config = await readFile(fixture.configPath);
  const state = await readFile(fixture.statePath);
  await assert.rejects(installConfig(fixture.options({ reactivationReceipt: {} })), { code: "REACTIVATION_RECEIPT_REQUIRED" });
  await assert.rejects(migrateManagedConfiguration(fixture.paths()), { code: "CONFIGURATION_SUSPENDED" });
  const receipt = await inventoryManagedConfigReactivation(fixture.paths());
  await assert.rejects(installConfig(fixture.options({ reactivationReceipt: receipt, modelProvider: "different_bridge", provider: { id: "different_bridge", name: "Model Bridge Fixture", baseUrl: "http://127.0.0.1:1234/v1" } })), { code: "STATE_PROVIDER_MISMATCH" });
  assert.deepEqual(await readFile(fixture.configPath), config);
  assert.deepEqual(await readFile(fixture.statePath), state);
  await writeFile(fixture.configPath, `${config}# changed while native\n`);
  await assert.rejects(installConfig(fixture.options({ reactivationReceipt: receipt })), { code: "CONFIGURATION_SUSPENSION_CONFLICT" });
  await assert.rejects(inventoryManagedConfigReactivation(fixture.paths()), { code: "CONFIGURATION_SUSPENSION_CONFLICT" });
  await writeFile(fixture.configPath, config);
  await writeFile(installed.backupPath, "modified backup");
  await assert.rejects(inventoryManagedConfigReactivation(fixture.paths()), { code: "BACKUP_MISMATCH" });
  assert.deepEqual(await readFile(fixture.statePath), state);
});

test("reactivation rollback retains the exact native suspended checkpoint after later lifecycle failure", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(fixture.configPath, 'openai_base_url = "http://127.0.0.1:4567/previous/v1"\n');
  const preview = await previewConfigIntegration(fixture.paths());
  const switchReceipt = await inventoryConfigIntegrationSwitch({ ...fixture.paths(), expectedPreviewToken: preview.previewToken });
  await installConfig(fixture.options({ integrationSwitchReceipt: switchReceipt }));
  await suspendManagedConfiguration(fixture.paths());
  const nativeConfig = await readFile(fixture.configPath);
  const suspensionState = await readFile(fixture.statePath);
  const receipt = await inventoryManagedConfigReactivation(fixture.paths());
  const active = await installConfig(fixture.options({ reactivationReceipt: receipt }));
  assert.equal((await getConfigStatus(fixture.paths())).installed, true);
  await active.rollback();
  await active.rollback();
  assert.deepEqual(await readFile(fixture.configPath), nativeConfig);
  assert.deepEqual(await readFile(fixture.statePath), suspensionState);
  assert.deepEqual(pickStatus(await getConfigStatus(fixture.paths())), { installed: false, healthy: true, status: "suspended" });
  const retryReceipt = await inventoryManagedConfigReactivation(fixture.paths());
  await installConfig(fixture.options({ reactivationReceipt: retryReceipt }));
  await uninstallConfig(fixture.paths());
  assert.match(await readFile(fixture.configPath, "utf8"), /4567\/previous/u);
});

test("reactivation rollback refuses contributor changes to config, state, or the original backup", async (t) => {
  for (const target of ["configPath", "statePath", "backupPath"]) {
    await t.test(target, async (subtest) => {
      const fixture = await makeFixture(subtest);
      const installed = await installConfig(fixture.options());
      await suspendManagedConfiguration(fixture.paths());
      const receipt = await inventoryManagedConfigReactivation(fixture.paths());
      const active = await installConfig(fixture.options({ reactivationReceipt: receipt }));
      const config = await readFile(fixture.configPath);
      const state = await readFile(fixture.statePath);
      const path = target === "backupPath" ? installed.backupPath : fixture[target];
      const previous = await readFile(path);
      const concurrent = Buffer.from(`${previous} `);
      await writeFile(path, concurrent);
      await assert.rejects(active.rollback(), (error) => ["CONFIG_CHANGED_CONCURRENTLY", "BACKUP_MISMATCH"].includes(error.code));
      assert.deepEqual(await readFile(path), concurrent);
      if (target !== "configPath") assert.deepEqual(await readFile(fixture.configPath), config);
      if (target !== "statePath") assert.deepEqual(await readFile(fixture.statePath), state);
    });
  }
});

test("suspension and reactivation commits reject concurrent config and state changes", async (t) => {
  for (const action of ["suspend", "reactivate"]) {
    for (const target of ["configPath", "statePath"]) {
      await t.test(`${action}: ${target}`, async (subtest) => {
        const fixture = await makeFixture(subtest);
        await installConfig(fixture.options());
        let receipt;
        if (action === "reactivate") {
          await suspendManagedConfiguration(fixture.paths());
          receipt = await inventoryManagedConfigReactivation(fixture.paths());
        }
        const beforeConfig = await readFile(fixture.configPath);
        const beforeState = await readFile(fixture.statePath);
        const concurrent = target === "configPath" ? Buffer.from(`${beforeConfig}# concurrent\n`) : Buffer.from(`${beforeState} `);
        const beforeConfigCommit = () => writeFile(fixture[target], concurrent);
        await assert.rejects(action === "suspend"
          ? suspendManagedConfiguration({ ...fixture.paths(), beforeConfigCommit })
          : installConfig(fixture.options({ reactivationReceipt: receipt, beforeConfigCommit })),
        (error) => ["CONFIG_CHANGED_CONCURRENTLY", "MANAGED_FILE_CHANGED", "INSTALL_FAILED"].includes(error.code));
        assert.deepEqual(await readFile(fixture[target]), concurrent);
        assert.deepEqual(await readFile(target === "configPath" ? fixture.statePath : fixture.configPath), target === "configPath" ? beforeState : beforeConfig);
      });
    }
  }
});

test("suspension metadata rejects unknown keys, invalid digests and missing private backup ownership", async (t) => {
  for (const suspension of [
    { kind: "full-refresh-v1", configSha256: "bad", pristine: true },
    { kind: "full-refresh-v1", configSha256: "a".repeat(64), pristine: "true" },
    { kind: "full-refresh-v1", configSha256: "a".repeat(64), pristine: true, unexpected: "private-data" },
  ]) {
    await t.test(Object.keys(suspension).join(","), async (subtest) => {
      const fixture = await makeFixture(subtest);
      await installConfig(fixture.options());
      await suspendManagedConfiguration(fixture.paths());
      const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
      state.suspension = suspension;
      await writeFile(fixture.statePath, JSON.stringify(state));
      assert.equal((await getConfigStatus(fixture.paths())).healthy, false);
      await assert.rejects(inventoryManagedConfigReactivation(fixture.paths()), { code: "INVALID_STATE" });
    });
  }
  const fixture = await makeFixture(t);
  const installed = await installConfig(fixture.options());
  const before = await readFile(fixture.configPath);
  await unlink(installed.backupPath);
  await assert.rejects(suspendManagedConfiguration(fixture.paths()), { code: "UNSAFE_MANAGED_FILE" });
  assert.deepEqual(await readFile(fixture.configPath), before);
});

test("search-enabled installation owns only its new feature setting", async (t) => {
  for (const original of [
    'model = "gpt-5.6-sol"\n',
    '[features]\nother = true\n[tools.web_search]\ncontext_size = "low"\n',
    '["features"]\r\nother = true\r\n',
    'features.other = true\nweb_search = "disabled"\n',
  ]) {
    await t.test(original.split(/\r?\n/u)[0], async (subtest) => {
      const fixture = await makeFixture(subtest);
      await writeFile(fixture.configPath, original);
      const options = fixture.options();
      options.provider.supportsStandaloneWebSearch = true;
      await installConfig(options);
      const installed = await readFile(fixture.configPath, "utf8");
      assert.match(installed, /supports_standalone_web_search = true/u);
      assert.match(installed, /standalone_web_search = true/u);
      assert.equal(installed.split(CONFIG_MARKERS.webSearchBegin).length, 2);
      assert.equal((await getConfigStatus(fixture.paths())).healthy, true);
      await uninstallConfig(fixture.paths());
      assert.equal(await readFile(fixture.configPath, "utf8"), original);
    });
  }
});

test("existing explicit search features are preserved, including false and inline tables", async (t) => {
  for (const original of [
    "features.standalone_web_search = false\n",
    '["features"]\n"standalone_web_search" = false # user choice\n',
    '[features]\nstandalone_web_search = true\n',
    'features = { other = ["a,b", "standalone_web_search=true"], standalone_web_search = false }\n',
  ]) {
    await t.test(original.split("\n")[0], async (subtest) => {
      const fixture = await makeFixture(subtest);
      await writeFile(fixture.configPath, original);
      await installConfig(fixture.options());
      const update = await enableManagedStandaloneWebSearch(fixture.paths());
      assert.equal(update.changed, true);
      assert.equal(update.enabled, original.includes("standalone_web_search = true"));
      const installed = await readFile(fixture.configPath, "utf8");
      assert.equal(installed.includes(CONFIG_MARKERS.webSearchBegin), false);
      assert.ok(installed.includes(original));
      assert.equal((await getConfigStatus(fixture.paths())).healthy, true);
      await uninstallConfig(fixture.paths());
      assert.equal(await readFile(fixture.configPath, "utf8"), original);
    });
  }
});

test("managed search migration preserves the original receipt backup and rolls back byte-for-byte", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(fixture.configPath, '[features]\nother = true\n');
  await installConfig(fixture.options());
  const beforeConfig = await readFile(fixture.configPath);
  const beforeState = await readFile(fixture.statePath);
  const oldState = JSON.parse(beforeState);
  const update = await enableManagedStandaloneWebSearch(fixture.paths());
  assert.equal(update.changed, true);
  assert.equal(update.enabled, true);
  const migratedState = JSON.parse(await readFile(fixture.statePath, "utf8"));
  assert.equal(migratedState.backupPath, oldState.backupPath);
  assert.equal(migratedState.sourceSha256, oldState.sourceSha256);
  assert.equal(migratedState.blocks.webSearch.scope, "features");
  assert.equal((await getConfigStatus(fixture.paths())).healthy, true);
  assert.deepEqual(await enableManagedStandaloneWebSearch(fixture.paths()), { changed: false, enabled: true });
  await update.rollback();
  assert.deepEqual(await readFile(fixture.configPath), beforeConfig);
  assert.deepEqual(await readFile(fixture.statePath), beforeState);
  await update.rollback();
});

test("search migration and surgical uninstall retain pre-existing contributor edits", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(fixture.configPath, '[features]\nother = true\n');
  await installConfig(fixture.options());
  await setManagedPickerSelection({ ...fixture.paths(), model: "lmstudio/changed", modelReasoningEffort: "high" });
  const installed = await readFile(fixture.configPath, "utf8");
  await writeFile(fixture.configPath, `${installed}user_added = true\n`);
  await enableManagedStandaloneWebSearch(fixture.paths());
  assert.equal((await getConfigStatus(fixture.paths())).model, "lmstudio/changed");
  const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
  assert.equal(state.installedSha256, undefined);
  await uninstallConfig(fixture.paths());
  assert.equal(await readFile(fixture.configPath, "utf8"), '[features]\nother = true\nuser_added = true\n');
});

test("search migration retains absent config provenance and safe marker recovery", async (t) => {
  for (const missingMarker of [false, true]) {
    await t.test(missingMarker ? "recovered provider" : "intact provider", async (subtest) => {
      const fixture = await makeFixture(subtest);
      await installConfig(fixture.options());
      if (missingMarker) {
        const installed = await readFile(fixture.configPath, "utf8");
        await writeFile(fixture.configPath, installed.replace(`${CONFIG_MARKERS.providerEnd}\n`, ""));
      }
      await enableManagedStandaloneWebSearch(fixture.paths());
      assert.equal((await getConfigStatus(fixture.paths())).healthy, true);
      await uninstallConfig(fixture.paths());
      await assert.rejects(readFile(fixture.configPath), { code: "ENOENT" });
    });
  }
});

test("search configuration rejects ambiguous or unsupported state before writing", async (t) => {
  for (const original of [
    '[features]\nstandalone_web_search = "false"\n',
    '[features]\nstandalone_web_search = false\nstandalone_web_search = true\n',
    'features = { other = true }\n',
    '[[features]]\nother = true\n',
    '[features.standalone_web_search]\nvalue = true\n',
  ]) {
    await t.test(original.split("\n")[0], async (subtest) => {
      const fixture = await makeFixture(subtest);
      await writeFile(fixture.configPath, original);
      await installConfig(fixture.options());
      const beforeConfig = await readFile(fixture.configPath);
      const beforeState = await readFile(fixture.statePath);
      await assert.rejects(enableManagedStandaloneWebSearch(fixture.paths()), { code: "WEB_SEARCH_CONFIG_CONFLICT" });
      assert.deepEqual(await readFile(fixture.configPath), beforeConfig);
      assert.deepEqual(await readFile(fixture.statePath), beforeState);
    });
  }
});

test("search provider capability must be a boolean before configuration is written", async (t) => {
  const fixture = await makeFixture(t);
  const options = fixture.options();
  options.provider.supportsStandaloneWebSearch = "false";
  await assert.rejects(installConfig(options), { code: "INVALID_ARGUMENT" });
  await assert.rejects(readFile(fixture.configPath), { code: "ENOENT" });
  await assert.rejects(readFile(fixture.statePath), { code: "ENOENT" });
});

test("managed search upgrades and rollback fail closed on concurrent edits", async (t) => {
  for (const target of ["configPath", "statePath"]) {
    await t.test(target, async (subtest) => {
      const fixture = await makeFixture(subtest);
      await writeFile(fixture.configPath, '[features]\nother = true\n');
      await installConfig(fixture.options());
      const previous = await readFile(fixture[target], "utf8");
      const edited = `${previous}\n`;
      await assert.rejects(enableManagedStandaloneWebSearch({
        ...fixture.paths(),
        beforeConfigCommit: () => writeFile(fixture[target], edited),
      }), { code: target === "statePath" ? "MANAGED_FILE_CHANGED" : "CONFIG_CHANGED_CONCURRENTLY" });
      assert.equal(await readFile(fixture[target], "utf8"), edited);
      await writeFile(fixture[target], previous);
      const update = await enableManagedStandaloneWebSearch(fixture.paths());
      const after = await readFile(fixture[target], "utf8");
      await writeFile(fixture[target], `${after}\n`);
      await assert.rejects(update.rollback(), { code: "CONFIG_CHANGED_CONCURRENTLY" });
      assert.equal(await readFile(fixture[target], "utf8"), `${after}\n`);
    });
  }
});

test("new web search ownership rejects edits and table-scope relocation", async (t) => {
  for (const edit of [
    (text) => text.replace("\nstandalone_web_search = true\n", "\nstandalone_web_search = false\n"),
    (text) => text.replace("[features]", "[unrelated]"),
  ]) {
    await t.test("modified ownership", async (subtest) => {
      const fixture = await makeFixture(subtest);
      await writeFile(fixture.configPath, '[features]\nother = true\n');
      await installConfig(fixture.options());
      await enableManagedStandaloneWebSearch(fixture.paths());
      const changed = edit(await readFile(fixture.configPath, "utf8"));
      await writeFile(fixture.configPath, changed);
      assert.equal((await getConfigStatus(fixture.paths())).healthy, false);
      await assert.rejects(enableManagedStandaloneWebSearch(fixture.paths()));
      await assert.rejects(uninstallConfig(fixture.paths()));
      assert.equal(await readFile(fixture.configPath, "utf8"), changed);
    });
  }
});

test("legacy receipts without feature markers migrate, while orphaned markers fail closed", async (t) => {
  await t.test("legacy receipt without markers", async (subtest) => {
    const fixture = await makeFixture(subtest);
    await writeFile(fixture.configPath, '[features]\nother = true\n');
    await installConfig(fixture.options());
    const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
    assert.equal(state.blocks.webSearch, undefined);
    assert.equal((await getConfigStatus(fixture.paths())).healthy, true);
    assert.equal((await enableManagedStandaloneWebSearch(fixture.paths())).changed, true);
    assert.equal((await getConfigStatus(fixture.paths())).healthy, true);
  });
  for (const markerText of [
    `${CONFIG_MARKERS.webSearchBegin}\nstandalone_web_search = true\n${CONFIG_MARKERS.webSearchEnd}\n`,
    `${CONFIG_MARKERS.webSearchBegin}\n`,
    `${CONFIG_MARKERS.webSearchEnd}\n`,
  ]) {
    await t.test("orphaned feature ownership", async (subtest) => {
      const fixture = await makeFixture(subtest);
      await writeFile(fixture.configPath, '[features]\nother = true\n');
      await installConfig(fixture.options());
      const installed = await readFile(fixture.configPath, "utf8");
      const orphaned = installed.replace("[features]\n", `[features]\n${markerText}`);
      await writeFile(fixture.configPath, orphaned);
      const previousState = await readFile(fixture.statePath);
      const status = await getConfigStatus(fixture.paths());
      assert.equal(status.healthy, false);
      assert.equal(status.error.code, "ORPHANED_MANAGED_BLOCK");
      await assert.rejects(enableManagedStandaloneWebSearch(fixture.paths()), { code: "ORPHANED_MANAGED_BLOCK" });
      await assert.rejects(uninstallConfig(fixture.paths()), { code: "ORPHANED_MANAGED_BLOCK" });
      assert.equal(await readFile(fixture.configPath, "utf8"), orphaned);
      assert.deepEqual(await readFile(fixture.statePath), previousState);
    });
  }
});

test("owned web search boundaries must remain comments rather than multiline string content", async (t) => {
  for (const quote of ['"""', "'''"]) {
    await t.test(quote, async (subtest) => {
      const fixture = await makeFixture(subtest);
      const options = fixture.options();
      options.provider.supportsStandaloneWebSearch = true;
      await installConfig(options);
      const installed = await readFile(fixture.configPath, "utf8");
      const modified = installed
        .replace(CONFIG_MARKERS.webSearchBegin, `note = ${quote}\n${CONFIG_MARKERS.webSearchBegin}`)
        .replace(`${CONFIG_MARKERS.webSearchEnd}\n`, `${CONFIG_MARKERS.webSearchEnd}\n${quote}\n`);
      await writeFile(fixture.configPath, modified);
      const previousState = await readFile(fixture.statePath);
      const status = await getConfigStatus(fixture.paths());
      assert.equal(status.healthy, false);
      assert.equal(status.error.code, "MANAGED_BLOCK_BOUNDARY_INVALID");
      await assert.rejects(enableManagedStandaloneWebSearch(fixture.paths()), { code: "MANAGED_BLOCK_BOUNDARY_INVALID" });
      await assert.rejects(uninstallConfig(fixture.paths()), { code: "MANAGED_BLOCK_BOUNDARY_INVALID" });
      assert.equal(await readFile(fixture.configPath, "utf8"), modified);
      assert.deepEqual(await readFile(fixture.statePath), previousState);
    });
  }
});

test("install preserves comments/table scope, creates exact backup, and uninstall restores prior values", async (t) => {
  const fixture = await makeFixture(t);
  const original = [
    "# user-owned heading",
    'model = "gpt-5.6-sol" # keep this raw comment',
    'model_reasoning_effort = "ultra"',
    "project_doc_max_bytes = 12345",
    "",
    "[features]",
    "web_search = true",
    'model = "table-scoped-and-untouched"',
    'model_provider = "also-table-scoped"',
    "",
  ].join("\n");
  await writeFile(fixture.configPath, original, { mode: 0o640 });
  await chmod(fixture.configPath, 0o640);

  const result = await installConfig(fixture.options());

  assert.equal(result.changed, true);
  assert.equal(result.installed, true);
  assert.equal(result.model, "lmstudio/qwen3.8-27b");
  assert.equal(result.provider, "model_bridge_fixture");
  assert.equal(result.catalog, fixture.catalogPath);
  assert.equal(result.configPath, fixture.configPath);
  assert.equal(result.statePath, fixture.statePath);
  assert.match(result.backupPath, /backups\/config\.toml\.lm-studio-model-router\./);

  const installed = await readFile(fixture.configPath, "utf8");
  const rootStart = installed.indexOf(CONFIG_MARKERS.rootBegin);
  const firstTable = installed.indexOf("[features]");
  const providerStart = installed.indexOf(CONFIG_MARKERS.providerBegin);
  assert.ok(rootStart >= 0 && rootStart < firstTable, "managed root block is before the first table");
  assert.ok(
    providerStart > rootStart && providerStart < firstTable,
    "provider block is contiguous with the root block and before the first user table",
  );
  assert.equal(
    installed.slice(0, firstTable).includes("[model_providers.model_bridge_fixture]"),
    true,
  );
  assert.match(installed, /model = "lmstudio\/qwen3\.8-27b"/);
  assert.match(installed, /model_provider = "model_bridge_fixture"/);
  assert.match(installed, /model_reasoning_effort = "low"/);
  assert.match(installed, /model = "table-scoped-and-untouched"/);
  assert.match(installed, /model_provider = "also-table-scoped"/);
  assert.doesNotMatch(installed, /gpt-5\.6-sol/);
  assert.doesNotMatch(installed, /reasoning_effort = "ultra"/);
  assert.equal(await readFile(result.backupPath, "utf8"), original);

  const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
  assert.deepEqual(
    state.priorAssignments.map(({ key, raw }) => ({ key, raw })),
    [
      {
        key: "model",
        raw: 'model = "gpt-5.6-sol" # keep this raw comment',
      },
      {
        key: "model_reasoning_effort",
        raw: 'model_reasoning_effort = "ultra"',
      },
    ],
  );
  assert.equal((await stat(fixture.configPath)).mode & 0o777, 0o640);
  assert.equal((await stat(result.backupPath)).mode & 0o777, 0o640);
  assert.equal((await stat(fixture.statePath)).mode & 0o777, 0o600);
  assert.equal((await stat(fixture.backupDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(fixture.directory, "state"))).mode & 0o777, 0o700);
  assert.deepEqual(result.metadataPreservation, {
    mode: true,
    extendedAttributes: false,
  });
  assert.match(result.warnings[0], /extended attributes are not preserved/i);

  // Simulate a later user edit outside both owned blocks.
  await writeFile(fixture.configPath, `${installed}user_added_after_install = true\n`);
  const uninstalled = await uninstallConfig(fixture.paths());
  const restored = await readFile(fixture.configPath, "utf8");

  assert.equal(uninstalled.changed, true);
  assert.equal(uninstalled.installed, false);
  assert.equal(uninstalled.model, "lmstudio/qwen3.8-27b");
  assert.equal(uninstalled.provider, "model_bridge_fixture");
  assert.equal(uninstalled.catalog, fixture.catalogPath);
  assert.match(restored, /model = "gpt-5\.6-sol" # keep this raw comment/);
  assert.match(restored, /model_reasoning_effort = "ultra"/);
  assert.match(restored, /user_added_after_install = true/);
  assert.match(restored, /model = "table-scoped-and-untouched"/);
  assert.doesNotMatch(restored, /lm-studio-model-router:p1/);
  assert.doesNotMatch(restored, /\[model_providers\.model_bridge_fixture\]/);
  assert.equal((await stat(fixture.configPath)).mode & 0o777, 0o640);
});

test("an untouched installation uninstalls byte-for-byte from the verified backup", async (t) => {
  const fixture = await makeFixture(t);
  const original = [
    'model_reasoning_effort = "ultra"',
    "# retain position and spacing",
    "",
    'model = "gpt-5.6-sol"',
    "[features]",
    "web_search = true",
    "",
  ].join("\n");
  await writeFile(fixture.configPath, original, { mode: 0o600 });

  const installed = await installConfig(fixture.options());
  const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
  assert.equal(typeof state.installedSha256, "string");
  assert.equal(await readFile(installed.backupPath, "utf8"), original);

  await uninstallConfig(fixture.paths());
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
});

test("status reports installed, modified, and not-installed states", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(fixture.configPath, 'model = "gpt-5.6-sol"\n');

  assert.deepEqual(
    pickStatus(await getConfigStatus(fixture.paths())),
    { installed: false, healthy: true, status: "not-installed" },
  );

  await installConfig(fixture.options());
  const healthy = await getConfigStatus(fixture.paths());
  assert.deepEqual(pickStatus(healthy), {
    installed: true,
    healthy: true,
    status: "installed",
  });
  assert.equal(healthy.model, "lmstudio/qwen3.8-27b");
  assert.equal(healthy.provider, "model_bridge_fixture");
  assert.equal(healthy.catalog, fixture.catalogPath);

  const installed = await readFile(fixture.configPath, "utf8");
  await writeFile(
    fixture.configPath,
    installed.replace("Model Bridge Fixture", "Model Bridge locally edited"),
  );
  assert.deepEqual(
    pickStatus(await getConfigStatus(fixture.paths())),
    { installed: true, healthy: false, status: "modified" },
  );
});

test("an exact missing provider end marker is recovered without rewriting config", async (t) => {
  const fixture = await makeFixture(t);
  const original = [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "ultra"',
    "[features]",
    "web_search = true",
    "",
  ].join("\n");
  await writeFile(fixture.configPath, original, { mode: 0o640 });
  await chmod(fixture.configPath, 0o640);
  await installConfig(fixture.options());

  const installed = await readFile(fixture.configPath, "utf8");
  const missingEnd = removeProviderEndMarker(installed, "\n");
  await writeFile(fixture.configPath, missingEnd);

  const status = await getConfigStatus(fixture.paths());
  assert.deepEqual(pickStatus(status), {
    installed: true,
    healthy: true,
    status: "installed-marker-recovered",
  });
  assert.deepEqual(status.recoveredMarkers, ["provider-end"]);
  assert.deepEqual(status.modifiedBlocks, []);
  assert.equal(await readFile(fixture.configPath, "utf8"), missingEnd);
  assert.equal((await stat(fixture.configPath)).mode & 0o777, 0o640);

  await setManagedPickerSelection({
    ...fixture.paths(),
    model: "gpt-5.5",
    modelReasoningEffort: "max",
    expectedModel: "lmstudio/qwen3.8-27b",
    expectedModelReasoningEffort: "low",
  });
  const selected = await readFile(fixture.configPath, "utf8");
  assert.equal(selected.includes(CONFIG_MARKERS.providerEnd), false);
  assert.match(selected, /model = "gpt-5\.5"/u);
  assert.equal((await getConfigStatus(fixture.paths())).status, "installed-marker-recovered");

  const userEdit = `${selected}user_setting = true\n`;
  await writeFile(fixture.configPath, userEdit);
  await uninstallConfig(fixture.paths());
  assert.equal(
    await readFile(fixture.configPath, "utf8"),
    `${original}user_setting = true\n`,
  );
});

test("missing provider end recovery finds a unique receipted boundary before preserved whitespace", async (t) => {
  const fixture = await makeFixture(t);
  const original = [
    'model = "gpt-5.6-sol"',
    "[features]",
    "web_search = true",
    "",
  ].join("\n");
  await writeFile(fixture.configPath, original);
  await installConfig(fixture.options());

  const installed = await readFile(fixture.configPath, "utf8");
  const markerPlaceholder = installed.replace(CONFIG_MARKERS.providerEnd, "");
  assert.notEqual(markerPlaceholder, installed);
  await writeFile(fixture.configPath, markerPlaceholder);

  const status = await getConfigStatus(fixture.paths());
  assert.deepEqual(pickStatus(status), {
    installed: true,
    healthy: true,
    status: "installed-marker-recovered",
  });
  assert.deepEqual(status.recoveredMarkers, ["provider-end"]);
  assert.equal(await readFile(fixture.configPath, "utf8"), markerPlaceholder);

  await uninstallConfig(fixture.paths());
  assert.equal(
    await readFile(fixture.configPath, "utf8"),
    original.replace("[features]", "\n[features]"),
  );
});

test("receipt-recovered provider end markers can be materialized atomically for an older CLI", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(
    fixture.configPath,
    'model = "gpt-5.6-sol"\n[features]\nweb_search = true\n',
  );
  await installConfig(fixture.options());
  const installed = await readFile(fixture.configPath, "utf8");
  const damaged = installed.replace(CONFIG_MARKERS.providerEnd, "");
  await writeFile(fixture.configPath, damaged);

  const restored = await restoreRecoveredProviderEndMarker(fixture.paths());
  assert.deepEqual(
    { changed: restored.changed, marker: restored.marker },
    { changed: true, marker: "provider-end" },
  );
  const materialized = await readFile(fixture.configPath, "utf8");
  assert.equal(
    materialized.replace(`${CONFIG_MARKERS.providerEnd}\n`, ""),
    damaged,
  );
  assert.deepEqual(pickStatus(await getConfigStatus(fixture.paths())), {
    installed: true,
    healthy: true,
    status: "installed",
  });

  const repeated = await restoreRecoveredProviderEndMarker(fixture.paths());
  assert.deepEqual(
    { changed: repeated.changed, marker: repeated.marker },
    { changed: false, marker: null },
  );
});

test("marker materialization fails closed on provider drift and concurrent config changes", async (t) => {
  await t.test("provider drift", async (t) => {
    const fixture = await makeFixture(t);
    await writeFile(fixture.configPath, 'model = "gpt-5.6-sol"\n');
    await installConfig(fixture.options());
    const installed = await readFile(fixture.configPath, "utf8");
    const damaged = installed
      .replace(CONFIG_MARKERS.providerEnd, "")
      .replace("http://127.0.0.1:1234/v1", "http://127.0.0.1:9999/v1");
    await writeFile(fixture.configPath, damaged);

    await assert.rejects(
      restoreRecoveredProviderEndMarker(fixture.paths()),
      (error) => error.code === "MANAGED_BLOCK_BOUNDARY_INVALID",
    );
    assert.equal(await readFile(fixture.configPath, "utf8"), damaged);
  });

  await t.test("concurrent edit", async (t) => {
    const fixture = await makeFixture(t);
    await writeFile(fixture.configPath, 'model = "gpt-5.6-sol"\n');
    await installConfig(fixture.options());
    const installed = await readFile(fixture.configPath, "utf8");
    const damaged = installed.replace(CONFIG_MARKERS.providerEnd, "");
    const concurrent = `${damaged}user_setting = true\n`;
    await writeFile(fixture.configPath, damaged);

    await assert.rejects(
      restoreRecoveredProviderEndMarker({
        ...fixture.paths(),
        beforeConfigCommit: () => writeFile(fixture.configPath, concurrent),
      }),
      (error) => error.code === "CONFIG_CHANGED_CONCURRENTLY",
    );
    assert.equal(await readFile(fixture.configPath, "utf8"), concurrent);
  });
});

test("missing provider end recovery supports CRLF at end of file", async (t) => {
  const fixture = await makeFixture(t);
  const original =
    'model = "gpt-5.6-sol"\r\nmodel_reasoning_effort = "ultra"\r\n';
  await writeFile(fixture.configPath, original);
  await installConfig(fixture.options());

  const installed = await readFile(fixture.configPath, "utf8");
  const missingEnd = removeProviderEndMarker(installed, "\r\n");
  await writeFile(fixture.configPath, missingEnd);
  const status = await getConfigStatus(fixture.paths());

  assert.equal(status.healthy, true);
  assert.equal(status.status, "installed-marker-recovered");
  assert.deepEqual(status.recoveredMarkers, ["provider-end"]);
  assert.equal(await readFile(fixture.configPath, "utf8"), missingEnd);
  await uninstallConfig(fixture.paths());
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
});

test("marker recovery restores an otherwise pristine existing config byte-for-byte", async (t) => {
  const fixture = await makeFixture(t);
  const original = [
    'model_reasoning_effort = "ultra"',
    "# retain assignment position and spacing",
    "",
    'model = "gpt-5.6-sol"',
    "project_doc_max_bytes = 12345",
    "[features]",
    "web_search = true",
    "",
  ].join("\n");
  await writeFile(fixture.configPath, original, { mode: 0o640 });
  await chmod(fixture.configPath, 0o640);
  await installConfig(fixture.options());

  const installed = await readFile(fixture.configPath, "utf8");
  await writeFile(
    fixture.configPath,
    removeProviderEndMarker(installed, "\n"),
  );
  assert.equal(
    (await getConfigStatus(fixture.paths())).status,
    "installed-marker-recovered",
  );

  await uninstallConfig(fixture.paths());
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
  assert.equal((await stat(fixture.configPath)).mode & 0o777, 0o640);
});

test("marker recovery removes a config that did not exist before install", async (t) => {
  const fixture = await makeFixture(t);
  await installConfig(fixture.options());
  const installed = await readFile(fixture.configPath, "utf8");
  await writeFile(
    fixture.configPath,
    removeProviderEndMarker(installed, "\n"),
  );
  assert.equal(
    (await getConfigStatus(fixture.paths())).status,
    "installed-marker-recovered",
  );

  const result = await uninstallConfig(fixture.paths());
  assert.equal(result.changed, true);
  await assert.rejects(stat(fixture.configPath), (error) => error.code === "ENOENT");
});

test("missing provider end recovery rejects every unreceipted boundary", async (t) => {
  const cases = [
    {
      name: "edited provider value",
      mutate(source) {
        return removeProviderEndMarker(source, "\n").replace(
          "http://127.0.0.1:1234/v1",
          "http://127.0.0.1:9999/v1",
        );
      },
    },
    {
      name: "additional provider-scoped field",
      mutate(source) {
        return removeProviderEndMarker(source, "\n").replace(
          "[features]",
          "request_max_retries = 99\n[features]",
        );
      },
    },
    {
      name: "changed end-marker comment",
      mutate(source) {
        return source.replace(
          CONFIG_MARKERS.providerEnd,
          `${CONFIG_MARKERS.providerEnd} changed`,
        );
      },
    },
    {
      name: "duplicate begin marker",
      mutate(source) {
        return removeProviderEndMarker(source, "\n").replace(
          CONFIG_MARKERS.providerBegin,
          `${CONFIG_MARKERS.providerBegin}\n${CONFIG_MARKERS.providerBegin}`,
        );
      },
    },
    {
      name: "missing root end marker",
      mutate(source) {
        return removeProviderEndMarker(source, "\n").replace(
          `${CONFIG_MARKERS.rootEnd}\n`,
          "",
        );
      },
    },
    {
      name: "unmatched state hash",
      mutate(source) {
        return removeProviderEndMarker(source, "\n");
      },
      async mutateState(fixture) {
        const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
        state.blocks.provider.sha256 = "0".repeat(64);
        await writeFile(
          fixture.statePath,
          `${JSON.stringify(state, null, 2)}\n`,
        );
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      const fixture = await makeFixture(t);
      const original = [
        'model = "gpt-5.6-sol"',
        "[features]",
        "web_search = true",
        "",
      ].join("\n");
      await writeFile(fixture.configPath, original);
      await installConfig(fixture.options());
      const installed = await readFile(fixture.configPath, "utf8");
      const drifted = entry.mutate(installed);
      await writeFile(fixture.configPath, drifted);
      await entry.mutateState?.(fixture);

      const status = await getConfigStatus(fixture.paths());
      assert.equal(status.installed, true);
      assert.equal(status.healthy, false);
      assert.equal(status.status, "inconsistent");
      assert.equal(await readFile(fixture.configPath, "utf8"), drifted);
      await assert.rejects(
        uninstallConfig(fixture.paths()),
        (error) => error.code === "MANAGED_BLOCK_BOUNDARY_INVALID",
      );
      assert.equal(await readFile(fixture.configPath, "utf8"), drifted);
    });
  }
});

test("recovered provider boundary retains picker compare-and-swap protection", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(
    fixture.configPath,
    'model = "gpt-5.6-sol"\n[features]\nweb_search = true\n',
  );
  await installConfig(fixture.options());
  const installed = await readFile(fixture.configPath, "utf8");
  const missingEnd = removeProviderEndMarker(installed, "\n");
  await writeFile(fixture.configPath, missingEnd);
  const concurrent = `${missingEnd}[user_after_install]\nvalue = true\n`;

  await assert.rejects(
    setManagedPickerSelection({
      ...fixture.paths(),
      model: "gpt-5.5",
      modelReasoningEffort: "max",
      beforeConfigCommit: () => writeFile(fixture.configPath, concurrent),
    }),
    (error) => error.code === "CONFIG_CHANGED_CONCURRENTLY",
  );
  assert.equal(await readFile(fixture.configPath, "utf8"), concurrent);
});

test("picker model and reasoning changes stay healthy while bridge identity remains protected", async (t) => {
  const fixture = await makeFixture(t);
  const original = 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "ultra"\n';
  await writeFile(fixture.configPath, original);
  await installConfig(fixture.options());

  const installed = await readFile(fixture.configPath, "utf8");
  const selected = installed
    .replace('model = "lmstudio/qwen3.8-27b"', 'model = "gpt-5.5"')
    .replace('model_reasoning_effort = "low"', 'model_reasoning_effort = "max"');
  await writeFile(fixture.configPath, selected);

  const status = await getConfigStatus(fixture.paths());
  assert.deepEqual(pickStatus(status), {
    installed: true,
    healthy: true,
    status: "installed",
  });
  assert.equal(status.model, "gpt-5.5");
  assert.equal(status.modelReasoningEffort, "max");
  assert.deepEqual(status.modifiedBlocks, []);

  await uninstallConfig(fixture.paths());
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
});

test("picker service tier changes retain healthy read-only status and preview", async (t) => {
  for (const eol of ["\n", "\r\n"]) {
    for (const assignment of [
      'service_tier = "priority"',
      "  service_tier = 'auto' # retained picker choice",
      'service_tier = "priority#choice" # comment',
    ]) {
      await t.test(`${JSON.stringify(eol)} ${assignment}`, async (subtest) => {
        const fixture = await makeFixture(subtest);
        await writeFile(fixture.configPath, ['model = "gpt-5.6-sol"', "[features]", "other = true", ""].join(eol));
        await installConfig(fixture.options());
        const installed = await readFile(fixture.configPath, "utf8");
        const selected = installed
          .replace('model = "lmstudio/qwen3.8-27b"', 'model = "gpt-5.5"')
          .replace('model_reasoning_effort = "low"', 'model_reasoning_effort = "max"')
          .replace(CONFIG_MARKERS.rootEnd, `${assignment}${eol}${CONFIG_MARKERS.rootEnd}`);
        await writeFile(fixture.configPath, selected);
        const beforeConfig = await snapshotFile(fixture.configPath);
        const beforeState = await snapshotFile(fixture.statePath);
        const status = await getConfigStatus(fixture.paths());
        assert.deepEqual(pickStatus(status), { installed: true, healthy: true, status: "installed" });
        assert.equal(status.model, "gpt-5.5");
        assert.equal(status.modelReasoningEffort, "max");
        assert.deepEqual(status.modifiedBlocks, []);
        const preview = await previewConfigIntegration(fixture.paths());
        assert.equal(preview.status, "pickermux");
        assert.equal(preview.canApply, true);
        assert.deepEqual(preview.changes, []);
        assert.deepEqual(await snapshotFile(fixture.configPath), beforeConfig);
        assert.deepEqual(await snapshotFile(fixture.statePath), beforeState);
      });
    }
  }
});

test("managed picker updates preserve the exact user service tier line and immutable receipt", async (t) => {
  for (const eol of ["\n", "\r\n"]) {
    await t.test(JSON.stringify(eol), async (subtest) => {
      const fixture = await makeFixture(subtest);
      await writeFile(fixture.configPath, `user_setting = true${eol}`, { mode: 0o640 });
      await installConfig(fixture.options());
      const tierLine = `\tservice_tier  =  'priority'  # user preference${eol}`;
      const installed = await readFile(fixture.configPath, "utf8");
      const selected = installed.replace(CONFIG_MARKERS.rootEnd, `${tierLine}${CONFIG_MARKERS.rootEnd}`);
      await writeFile(fixture.configPath, selected);
      const beforeState = await readFile(fixture.statePath);
      const beforeProvider = selected.slice(selected.indexOf(CONFIG_MARKERS.providerBegin));
      const update = await setManagedPickerSelection({
        ...fixture.paths(),
        model: "lmstudio/changed",
        modelReasoningEffort: "high",
        expectedModel: "lmstudio/qwen3.8-27b",
        expectedModelReasoningEffort: "low",
      });
      assert.equal(update.changed, true);
      await restoreManagedPickerDefaults({ ...fixture.paths(), defaultModel: "lmstudio/qwen3.8-27b", defaultModelReasoningEffort: "low" });
      const restored = await readFile(fixture.configPath, "utf8");
      assert.equal(restored.split(tierLine).length - 1, 1);
      assert.equal(restored.slice(restored.indexOf(CONFIG_MARKERS.providerBegin)), beforeProvider);
      assert.deepEqual(await readFile(fixture.statePath), beforeState);
      assert.equal((await stat(fixture.configPath)).mode & 0o777, 0o640);
      assert.equal((await getConfigStatus(fixture.paths())).healthy, true);
    });
  }
});

test("provider and search migrations preserve service tier bytes through rollback and uninstall", async (t) => {
  for (const migration of ["provider", "search"]) {
    for (const eol of ["\n", "\r\n"]) {
      await t.test(`${migration} ${JSON.stringify(eol)}`, async (subtest) => {
        const fixture = await makeFixture(subtest);
        const original = ['model = "gpt-5.6-sol"', "[features]", "other = true", ""].join(eol);
        await writeFile(fixture.configPath, original);
        await installConfig(fixture.options());
        if (migration === "provider") await reorderReceiptedProvider(fixture, eol);
        const tierLine = `service_tier = "priority" # retained on migration${eol}`;
        const installed = await readFile(fixture.configPath, "utf8");
        await writeFile(fixture.configPath, installed.replace(CONFIG_MARKERS.rootEnd, `${tierLine}${CONFIG_MARKERS.rootEnd}`));
        const beforeConfig = await readFile(fixture.configPath);
        const beforeState = await readFile(fixture.statePath);
        const migrate = migration === "provider" ? migrateManagedConfiguration : enableManagedStandaloneWebSearch;
        const update = await migrate(fixture.paths());
        assert.equal(update.changed, true);
        assert.equal((await readFile(fixture.configPath, "utf8")).split(tierLine).length - 1, 1);
        assert.equal((await getConfigStatus(fixture.paths())).healthy, true);
        const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
        assert.equal(state.blocks.root.sha256, JSON.parse(beforeState).blocks.root.sha256);
        assert.equal(state.installedSha256, undefined);
        await update.rollback();
        assert.deepEqual(await readFile(fixture.configPath), beforeConfig);
        assert.deepEqual(await readFile(fixture.statePath), beforeState);
        await migrate(fixture.paths());
        await uninstallConfig(fixture.paths());
        const removed = await readFile(fixture.configPath, "utf8");
        assert.equal(removed.split(tierLine).length - 1, 1);
        assert.ok(removed.includes(`[features]${eol}other = true${eol}`));
        assert.doesNotMatch(removed, /lm-studio-model-router:p2|pickermux:standalone-web-search/u);
        if (eol === "\r\n") assert.doesNotMatch(removed, /(?<!\r)\n/u);
      });
    }
  }
});

test("service tier survives normal removal, native removal, suspension and deactivation", async (t) => {
  for (const action of ["uninstall", "native", "suspend", "deactivate"]) {
    for (const eol of ["\n", "\r\n"]) {
      await t.test(`${action} ${JSON.stringify(eol)}`, async (subtest) => {
        const fixture = await makeFixture(subtest);
        await writeFile(fixture.configPath, ['model = "gpt-5.6-sol"', "user_setting = true", "[features]", "other = true", ""].join(eol));
        const options = fixture.options();
        options.modelProvider = options.provider.id = "model_bridge";
        await installConfig(options);
        const tierLine = `  service_tier = 'priority' # preserve exact bytes${eol}`;
        const installed = await readFile(fixture.configPath, "utf8");
        await writeFile(fixture.configPath, installed.replace(CONFIG_MARKERS.rootEnd, `${tierLine}${CONFIG_MARKERS.rootEnd}`));
        const beforeConfig = await readFile(fixture.configPath);
        const beforeState = await readFile(fixture.statePath);
        if (action === "suspend" || action === "deactivate") {
          const suspend = action === "suspend" ? suspendManagedConfiguration : deactivateManagedConfiguration;
          const update = await suspend(fixture.paths());
          const native = await readFile(fixture.configPath, "utf8");
          assert.equal(native.split(tierLine).length - 1, 1);
          assert.doesNotMatch(native, /model_provider =|model_catalog_json =|model_reasoning_effort =/u);
          await update.rollback();
          assert.deepEqual(await readFile(fixture.configPath), beforeConfig);
          assert.deepEqual(await readFile(fixture.statePath), beforeState);
          await suspend(fixture.paths());
          const receipt = action === "suspend"
            ? await inventoryManagedConfigReactivation(fixture.paths())
            : await inventoryDeactivatedConfigReactivation(fixture.paths());
          await installConfig({ ...options, reactivationReceipt: receipt });
          assert.equal((await getConfigStatus(fixture.paths())).healthy, true);
          assert.equal((await readFile(fixture.configPath, "utf8")).split(tierLine).length - 1, 1);
        }
        await uninstallConfig({ ...fixture.paths(), restoreNative: action === "native" });
        const removed = await readFile(fixture.configPath, "utf8");
        assert.equal(removed.split(tierLine).length - 1, 1);
        assert.ok(removed.includes(`user_setting = true${eol}`));
        assert.ok(removed.includes(`[features]${eol}other = true${eol}`));
        assert.doesNotMatch(removed, /lm-studio-model-router:p2|model_provider =|model_catalog_json =/u);
        if (action === "native") assert.doesNotMatch(removed, /^model\s*=/mu);
        else assert.ok(removed.includes(`model = "gpt-5.6-sol"${eol}`));
        if (eol === "\r\n") assert.doesNotMatch(removed, /(?<!\r)\n/u);
      });
    }
  }
});

test("a pre-existing service tier outside the managed root stays user-owned", async (t) => {
  const fixture = await makeFixture(t);
  const tierLine = "service_tier = 'flex' # pre-existing user setting\r\n";
  const original = `${tierLine}model = "gpt-5.6-sol"\r\n[features]\r\nother = true\r\n`;
  await writeFile(fixture.configPath, original);
  await installConfig(fixture.options());
  await setManagedPickerSelection({ ...fixture.paths(), model: "gpt-5.5", modelReasoningEffort: "max" });
  await enableManagedStandaloneWebSearch(fixture.paths());
  assert.equal((await getConfigStatus(fixture.paths())).healthy, true);
  const installed = await readFile(fixture.configPath, "utf8");
  assert.equal(installed.split(tierLine).length - 1, 1);
  const root = installed.slice(installed.indexOf(CONFIG_MARKERS.rootBegin), installed.indexOf(CONFIG_MARKERS.rootEnd));
  assert.equal(root.includes("service_tier"), false);
  await uninstallConfig(fixture.paths());
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
});

test("service tier scanning respects multiline string contents, comments and unrelated table scopes", async (t) => {
  for (const delimiter of ['"""', "'''"]) {
    await t.test(delimiter, async (subtest) => {
      const fixture = await makeFixture(subtest);
      const original = [
        `prompt = ${delimiter}`,
        'service_tier = "quoted-data"',
        '[service_tier]',
        delimiter,
        '# service_tier = "comment-only"',
        "[features]",
        'service_tier = "table-scoped-data"',
        "[profiles.operator]",
        'service_tier = "profile-scoped-data"',
        "",
      ].join("\n");
      await writeFile(fixture.configPath, original);
      await installConfig(fixture.options());
      const tierLine = 'service_tier = "priority" # actual root setting\n';
      const installed = await readFile(fixture.configPath, "utf8");
      await writeFile(fixture.configPath, installed.replace(CONFIG_MARKERS.rootEnd, `${tierLine}${CONFIG_MARKERS.rootEnd}`));
      assert.equal((await getConfigStatus(fixture.paths())).healthy, true);
      assert.equal((await previewConfigIntegration(fixture.paths())).canApply, true);
      await setManagedPickerSelection({ ...fixture.paths(), model: "gpt-5.5", modelReasoningEffort: "max" });
      await uninstallConfig(fixture.paths());
      const restored = await readFile(fixture.configPath, "utf8");
      assert.ok(restored.includes(original.slice(0, original.indexOf("[features]"))));
      assert.ok(restored.includes('[features]\nservice_tier = "table-scoped-data"\n'));
      assert.ok(restored.includes('[profiles.operator]\nservice_tier = "profile-scoped-data"\n'));
      assert.equal(restored.split(tierLine).length - 1, 1);
    });
  }
});

test("direct removal of a suspended or deactivated integration preserves service tier", async (t) => {
  for (const action of ["suspended", "deactivated", "deactivated-native"]) {
    for (const eol of ["\n", "\r\n"]) {
      await t.test(`${action} ${JSON.stringify(eol)}`, async (subtest) => {
        const fixture = await makeFixture(subtest);
        await writeFile(fixture.configPath, `model = "gpt-5.6-sol"${eol}user_setting = true${eol}`);
        const options = fixture.options();
        options.modelProvider = options.provider.id = "model_bridge";
        await installConfig(options);
        const tierLine = `service_tier = 'priority' # retained after OFF${eol}`;
        const installed = await readFile(fixture.configPath, "utf8");
        await writeFile(fixture.configPath, installed.replace(CONFIG_MARKERS.rootEnd, `${tierLine}${CONFIG_MARKERS.rootEnd}`));
        if (action === "suspended") await suspendManagedConfiguration(fixture.paths());
        else await deactivateManagedConfiguration(fixture.paths());
        await uninstallConfig({ ...fixture.paths(), restoreNative: action === "deactivated-native" });
        const restored = await readFile(fixture.configPath, "utf8");
        assert.equal(restored.split(tierLine).length - 1, 1);
        assert.ok(restored.includes(`user_setting = true${eol}`));
        if (action === "deactivated-native") assert.doesNotMatch(restored, /^model\s*=/mu);
        else assert.ok(restored.includes(`model = "gpt-5.6-sol"${eol}`));
        if (eol === "\r\n") assert.doesNotMatch(restored, /(?<!\r)\n/u);
      });
    }
  }
});

test("service tier tolerance rejects ambiguous values, duplicate aliases and every other managed edit", async (t) => {
  const tierLine = 'service_tier = "private-tier-fixture"\n';
  const cases = [
    { name: "duplicate inside root", mutate: (source) => source.replace(CONFIG_MARKERS.rootEnd, `${tierLine}${CONFIG_MARKERS.rootEnd}`) },
    { name: "duplicate outside root", mutate: (source) => `${tierLine}${source}` },
    { name: "quoted duplicate outside root", mutate: (source) => `"service_tier" = "auto"\n${source}` },
    { name: "literal-key duplicate outside root", mutate: (source) => `'service_tier' = 'auto'\n${source}` },
    { name: "dotted duplicate outside root", mutate: (source) => `service_tier.value = "auto"\n${source}` },
    { name: "escaped-key duplicate outside root", mutate: (source) => `"service_\\u0074ier" = "auto"\n${source}` },
    { name: "table collision outside root", mutate: (source) => `${source}[service_tier]\nvalue = "auto"\n` },
    { name: "array-table collision outside root", mutate: (source) => `${source}[[service_tier]]\nvalue = "auto"\n` },
    { name: "quoted table collision outside root", mutate: (source) => `${source}["service_tier"]\nvalue = "auto"\n` },
    { name: "table-scope relocation", mutate: (source) => `[features]\n${source}` },
    { name: "multiline context relocation", mutate: (source) => `prompt = """\n${source}"""\n` },
    { name: "quoted managed key", mutate: (source) => source.replace(tierLine, '"service_tier" = "priority"\n') },
    { name: "dotted managed key", mutate: (source) => source.replace(tierLine, 'service_tier.value = "priority"\n') },
    { name: "boolean value", mutate: (source) => source.replace(tierLine, "service_tier = true\n") },
    { name: "array value", mutate: (source) => source.replace(tierLine, 'service_tier = ["priority"]\n') },
    { name: "empty string", mutate: (source) => source.replace(tierLine, 'service_tier = ""\n') },
    { name: "whitespace-only string", mutate: (source) => source.replace(tierLine, 'service_tier = " "\n') },
    { name: "unclosed string", mutate: (source) => source.replace(tierLine, 'service_tier = "priority\n') },
    { name: "multiline string", mutate: (source) => source.replace(tierLine, 'service_tier = """priority"""\n') },
    { name: "invalid escape", mutate: (source) => source.replace(tierLine, 'service_tier = "prior\\qity"\n') },
    { name: "control escape", mutate: (source) => source.replace(tierLine, 'service_tier = "prior\\nity"\n') },
    { name: "surrogate escape", mutate: (source) => source.replace(tierLine, 'service_tier = "\\uD800"\n') },
    { name: "long surrogate escape", mutate: (source) => source.replace(tierLine, 'service_tier = "\\U0000DFFF"\n') },
    { name: "paired surrogate escapes", mutate: (source) => source.replace(tierLine, 'service_tier = "\\uD83D\\uDE00"\n') },
    { name: "unknown root setting", mutate: (source) => source.replace(CONFIG_MARKERS.rootEnd, `user_added = true\n${CONFIG_MARKERS.rootEnd}`) },
    { name: "root comment edit", mutate: (source) => source.replace(CONFIG_MARKERS.rootEnd, `# edited managed bytes\n${CONFIG_MARKERS.rootEnd}`) },
    { name: "provider identity edit", mutate: (source) => source.replace('model_provider = "model_bridge"', 'model_provider = "foreign"') },
    { name: "catalog edit", mutate: (source) => source.replace(/^model_catalog_json = .*$/mu, 'model_catalog_json = "/unowned/catalog.json"') },
    { name: "provider transport edit", mutate: (source) => source.replace('wire_api = "responses"', 'wire_api = "chat"') },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const fixture = await makeFixture(subtest);
      const options = fixture.options();
      options.modelProvider = options.provider.id = "model_bridge";
      await installConfig(options);
      const installed = await readFile(fixture.configPath, "utf8");
      const withTier = installed.replace(CONFIG_MARKERS.rootEnd, `${tierLine}${CONFIG_MARKERS.rootEnd}`);
      await writeFile(fixture.configPath, entry.mutate(withTier));
      const beforeConfig = await readFile(fixture.configPath);
      const beforeState = await readFile(fixture.statePath);
      assert.equal((await getConfigStatus(fixture.paths())).healthy, false);
      assert.equal((await previewConfigIntegration(fixture.paths())).canApply, false);
      const redactedFailure = (error) => {
        assert.doesNotMatch(`${error.message}${JSON.stringify(error.details)}`, /private-tier-fixture|\/unowned\/catalog\.json/u);
        return true;
      };
      await assert.rejects(setManagedPickerSelection({ ...fixture.paths(), model: "lmstudio/changed", modelReasoningEffort: "high" }), redactedFailure);
      await assert.rejects(migrateManagedConfiguration(fixture.paths()), redactedFailure);
      await assert.rejects(enableManagedStandaloneWebSearch(fixture.paths()), redactedFailure);
      await assert.rejects(suspendManagedConfiguration(fixture.paths()), redactedFailure);
      await assert.rejects(deactivateManagedConfiguration(fixture.paths()), redactedFailure);
      await assert.rejects(uninstallConfig(fixture.paths()), redactedFailure);
      await assert.rejects(uninstallConfig({ ...fixture.paths(), restoreNative: true }), redactedFailure);
      assert.deepEqual(await readFile(fixture.configPath), beforeConfig);
      assert.deepEqual(await readFile(fixture.statePath), beforeState);
    });
  }
});

test("service tier selection changes remain protected by compare-and-swap", async (t) => {
  const fixture = await makeFixture(t);
  await installConfig(fixture.options());
  const installed = await readFile(fixture.configPath, "utf8");
  const selected = installed.replace(CONFIG_MARKERS.rootEnd, `service_tier = "priority"\n${CONFIG_MARKERS.rootEnd}`);
  await writeFile(fixture.configPath, selected);
  const beforeState = await readFile(fixture.statePath);
  const concurrent = selected.replace('service_tier = "priority"', 'service_tier = "auto"');
  await assert.rejects(setManagedPickerSelection({
    ...fixture.paths(),
    model: "lmstudio/changed",
    modelReasoningEffort: "high",
    beforeConfigCommit: () => writeFile(fixture.configPath, concurrent),
  }), { code: "CONFIG_CHANGED_CONCURRENTLY" });
  assert.equal(await readFile(fixture.configPath, "utf8"), concurrent);
  await assert.rejects(setManagedPickerSelection({
    ...fixture.paths(),
    model: "lmstudio/changed",
    modelReasoningEffort: "high",
    expectedModel: "gpt-5.5",
    expectedModelReasoningEffort: "max",
  }), { code: "SELECTION_CHANGED_CONCURRENTLY" });
  assert.equal(await readFile(fixture.configPath, "utf8"), concurrent);
  assert.deepEqual(await readFile(fixture.statePath), beforeState);
});

test("managed picker defaults are restored without changing provider, state, or unrelated config", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(
    fixture.configPath,
    'model = "gpt-5.5"\nuser_setting = true\n',
    { mode: 0o640 },
  );
  await chmod(fixture.configPath, 0o640);
  await installConfig(
    fixture.options({
      model: "gpt-5.6-sol",
      modelReasoningEffort: "ultra",
    }),
  );
  const stateBefore = await readFile(fixture.statePath);
  const providerBefore = (await readFile(fixture.configPath, "utf8")).slice(
    (await readFile(fixture.configPath, "utf8")).indexOf(CONFIG_MARKERS.providerBegin),
  );

  await setManagedPickerSelection({
    ...fixture.paths(),
    model: "lmstudio/qwen/local",
    modelReasoningEffort: "low",
    expectedModel: "gpt-5.6-sol",
    expectedModelReasoningEffort: "ultra",
  });
  const restored = await restoreManagedPickerDefaults({
    ...fixture.paths(),
    defaultModel: "gpt-5.6-sol",
    defaultModelReasoningEffort: "ultra",
    expectedModel: "lmstudio/qwen/local",
    expectedModelReasoningEffort: "low",
  });
  assert.equal(restored.changed, true);
  assert.equal(restored.previousModel, "lmstudio/qwen/local");
  assert.equal(restored.previousModelReasoningEffort, "low");

  const source = await readFile(fixture.configPath, "utf8");
  assert.match(source, /model = "gpt-5\.6-sol"/u);
  assert.match(source, /model_reasoning_effort = "ultra"/u);
  assert.match(source, /user_setting = true/u);
  assert.equal(source.slice(source.indexOf(CONFIG_MARKERS.providerBegin)), providerBefore);
  assert.deepEqual(await readFile(fixture.statePath), stateBefore);
  assert.equal((await stat(fixture.configPath)).mode & 0o777, 0o640);
  assert.equal((await getConfigStatus(fixture.paths())).healthy, true);
});

test("managed picker reset fails closed on concurrent config changes", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(fixture.configPath, 'model = "gpt-5.6-sol"\n');
  await installConfig(
    fixture.options({
      model: "gpt-5.6-sol",
      modelReasoningEffort: "ultra",
    }),
  );
  await setManagedPickerSelection({
    ...fixture.paths(),
    model: "lmstudio/qwen/local",
    modelReasoningEffort: "low",
  });
  const before = await readFile(fixture.configPath, "utf8");
  const concurrent = `${before}concurrent_user_edit = true\n`;
  await assert.rejects(
    restoreManagedPickerDefaults({
      ...fixture.paths(),
      defaultModel: "gpt-5.6-sol",
      defaultModelReasoningEffort: "ultra",
      expectedModel: "lmstudio/qwen/local",
      expectedModelReasoningEffort: "low",
      beforeConfigCommit: () => writeFile(fixture.configPath, concurrent),
    }),
    (error) => error.code === "CONFIG_CHANGED_CONCURRENTLY",
  );
  assert.equal(await readFile(fixture.configPath, "utf8"), concurrent);
});

test("edited owned blocks require explicit force to uninstall", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(
    fixture.configPath,
    'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "ultra"\n',
  );
  await installConfig(fixture.options());
  const installed = await readFile(fixture.configPath, "utf8");
  await writeFile(
    fixture.configPath,
    installed.replace("http://127.0.0.1:1234/v1", "http://127.0.0.1:9999/v1"),
  );

  await assert.rejects(
    uninstallConfig(fixture.paths()),
    (error) => error.code === "MANAGED_BLOCK_MODIFIED",
  );
  assert.equal((await getConfigStatus(fixture.paths())).status, "modified");

  const result = await uninstallConfig({ ...fixture.paths(), force: true });
  assert.equal(result.changed, true);
  const restored = await readFile(fixture.configPath, "utf8");
  assert.match(restored, /model = "gpt-5\.6-sol"/);
  assert.match(restored, /model_reasoning_effort = "ultra"/);
  assert.doesNotMatch(restored, /127\.0\.0\.1:9999/);
});

test("double install is refused and double uninstall is a no-op", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(fixture.configPath, 'model = "gpt-5.6-sol"\n');
  await installConfig(fixture.options());

  await assert.rejects(
    installConfig(fixture.options()),
    (error) => error.code === "ALREADY_INSTALLED",
  );

  assert.equal((await uninstallConfig(fixture.paths())).changed, true);
  const second = await uninstallConfig(fixture.paths());
  assert.deepEqual(
    { changed: second.changed, installed: second.installed },
    { changed: false, installed: false },
  );
});

test("provider table conflicts are rejected without changing config", async (t) => {
  const fixture = await makeFixture(t);
  const source = [
    'model = "gpt-5.6-sol"',
    "[model_providers.model_bridge_fixture] # existing user table",
    'name = "Do not overwrite"',
    "",
  ].join("\n");
  await writeFile(fixture.configPath, source);

  await assert.rejects(
    installConfig(fixture.options()),
    (error) => error.code === "PROVIDER_TABLE_CONFLICT",
  );
  assert.equal(await readFile(fixture.configPath, "utf8"), source);
});

test("quoted TOML provider table paths fail closed without matching single keys", async (t) => {
  const headers = [
    '["model_providers".model_bridge_fixture]',
    '[model_providers."model_bridge_fixture"]',
    "['model_providers'.'model_bridge_fixture']",
    '["model\\u005fproviders"."model\\u005fbridge\\u005ffixture"]',
  ];
  for (const header of headers) {
    await t.test(header, async (t) => {
      const fixture = await makeFixture(t);
      const source = `${header}\nname = "Do not overwrite"\n`;
      await writeFile(fixture.configPath, source);
      await assert.rejects(
        installConfig(fixture.options()),
        (error) => error.code === "PROVIDER_TABLE_CONFLICT",
      );
      assert.equal(await readFile(fixture.configPath, "utf8"), source);
    });
  }

  const fixture = await makeFixture(t);
  const unrelated = '["model_providers.model_bridge_fixture"]\nname = "Unrelated single key"\n';
  await writeFile(fixture.configPath, unrelated);
  await installConfig(fixture.options());
  assert.match(await readFile(fixture.configPath, "utf8"), /Unrelated single key/u);
});

test("inline and dotted TOML provider definitions fail closed in install and state-absent purge", async (t) => {
  const sourcesFor = (providerId) => {
    const escapedProviderId = providerId.replaceAll("_", "\\u005f");
    return [
      [
        "inline provider in parent table",
        `[model_providers]\n${providerId} = { name = "Foreign" }\n`,
      ],
      [
        "root dotted provider",
        `model_providers.${providerId} = { name = "Foreign" }\n`,
      ],
      [
        "quoted dotted provider",
        `"model_providers"."${providerId}" = { name = "Foreign" }\n`,
      ],
      [
        "escaped quoted dotted provider",
        `"model\\u005fproviders"."${escapedProviderId}" = { name = "Foreign" }\n`,
      ],
      [
        "sealed root inline table",
        'model_providers = { other = { name = "Foreign" } }\n',
      ],
      [
        "array-of-tables provider root",
        '[[model_providers]]\nname = "Foreign"\n',
      ],
      [
        "escaped array-of-tables provider root",
        '[["model\\u005fproviders"]]\nname = "Foreign"\n',
      ],
      [
        "root target subtree",
        `model_providers.${providerId}.options.retries = 1\n`,
      ],
      [
        "parent-table target subtree",
        `[model_providers]\n${providerId}.options = { retries = 1 }\n`,
      ],
      [
        "target subtable",
        `[model_providers.${providerId}.options]\nretries = 1\n`,
      ],
    ];
  };
  const provider = {
    id: "model_bridge",
    name: "Model Bridge Fixture",
    baseUrl: "http://127.0.0.1:1234/v1/",
    wireApi: "responses",
    requiresOpenAiAuth: false,
    supportsWebsockets: false,
    supportsStandaloneWebSearch: false,
  };

  for (const [name, source] of sourcesFor("model_bridge_fixture")) {
    await t.test(`install: ${name}`, async (t) => {
      const fixture = await makeFixture(t);
      await writeFile(fixture.configPath, source);
      await assert.rejects(
        installConfig(fixture.options()),
        (error) => error.code === "PROVIDER_TABLE_CONFLICT",
      );
      assert.equal(await readFile(fixture.configPath, "utf8"), source);
      await assert.rejects(stat(fixture.statePath), { code: "ENOENT" });
    });
  }

  for (const [name, source] of sourcesFor("model_bridge")) {
    await t.test(`state-absent purge: ${name}`, async (t) => {
      const fixture = await makeFixture(t);
      await writeFile(fixture.configPath, source);
      await assert.rejects(
        uninstallConfig({
          ...fixture.paths(),
          preserveHistoricalModelBridge: true,
        }),
        (error) => error.code === "HISTORICAL_PROVIDER_CONFLICT",
      );
      assert.equal(await readFile(fixture.configPath, "utf8"), source);
    });
  }

  await t.test("parent table alone remains available", async (t) => {
    const fixture = await makeFixture(t);
    const source = "[model_providers]\n";
    await writeFile(fixture.configPath, source);
    const installed = await installConfig(fixture.options());
    assert.equal(installed.changed, true);
  });

  await t.test("single quoted dotted key remains unrelated", async (t) => {
    const fixture = await makeFixture(t);
    const source = [
      '"model_providers.model_bridge" = { name = "Unrelated" }',
      "",
    ].join("\n");
    await writeFile(fixture.configPath, source);
    const preserved = await uninstallConfig({
      ...fixture.paths(),
      preserveHistoricalModelBridge: true,
    });
    assert.equal(preserved.historicalCompatibility, true);
    assert.match(
      await readFile(fixture.configPath, "utf8"),
      /"model_providers\.model_bridge"/u,
    );
  });
});

test("install removes only the exact end-bounded historical model_bridge compatibility table", async (t) => {
  const fixture = await makeFixture(t);
  const original = 'model = "gpt-5.6-sol"\n';
  const compatibility = [
    "# >>> pickermux:historical-model-bridge >>>",
    "# Preserves historical chat parsing after PickerMux is removed.",
    "# pickermux:historical-model-bridge-config-existed=true",
    "[model_providers.model_bridge]",
    'name = "PickerMux (uninstalled)"',
    'base_url = "http://127.0.0.1:0/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "supports_standalone_web_search = false",
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "# <<< pickermux:historical-model-bridge <<<",
    "",
  ].join("\n");
  const provider = {
    id: "model_bridge",
    name: "Model Bridge Fixture",
    baseUrl: "http://127.0.0.1:1234/v1/",
    wireApi: "responses",
    requiresOpenAiAuth: false,
    supportsWebsockets: false,
    supportsStandaloneWebSearch: false,
  };

  await writeFile(fixture.configPath, `${original}\n${compatibility}`);
  const installed = await installConfig(fixture.options({
    modelProvider: "model_bridge",
    provider,
  }));
  assert.equal(await readFile(installed.backupPath, "utf8"), original);
  assert.doesNotMatch(
    await readFile(fixture.configPath, "utf8"),
    /historical-model-bridge/u,
  );

  const modified = `${original}\n${compatibility}# user-owned trailing note\n`;
  await writeFile(fixture.configPath, modified);
  await unlink(fixture.statePath);
  await assert.rejects(
    installConfig(fixture.options({
      modelProvider: "model_bridge",
      provider,
    })),
    (error) => error.code === "PROVIDER_TABLE_CONFLICT",
  );
  assert.equal(await readFile(fixture.configPath, "utf8"), modified);

  const falseProvenanceWithUserContent = `${original}\n${compatibility.replace(
    "historical-model-bridge-config-existed=true",
    "historical-model-bridge-config-existed=false",
  )}`;
  await writeFile(fixture.configPath, falseProvenanceWithUserContent);
  await assert.rejects(
    installConfig(fixture.options({
      modelProvider: "model_bridge",
      provider,
    })),
    (error) => error.code === "PROVIDER_TABLE_CONFLICT",
  );
  assert.equal(
    await readFile(fixture.configPath, "utf8"),
    falseProvenanceWithUserContent,
  );
});

test("historical compatibility marker remnants fail closed before install or state-absent purge", async (t) => {
  const provider = {
    id: "model_bridge",
    name: "Model Bridge Fixture",
    baseUrl: "http://127.0.0.1:1234/v1/",
    wireApi: "responses",
    requiresOpenAiAuth: false,
    supportsWebsockets: false,
    supportsStandaloneWebSearch: false,
  };
  const remnants = [
    [
      "provider header removed",
      [
        "# >>> pickermux:historical-model-bridge >>> modified",
        "# pickermux:historical-model-bridge-config-existed=true",
        'name = "PickerMux (uninstalled)"',
        "# <<< pickermux:historical-model-bridge <<<",
        "",
      ].join("\n"),
    ],
    [
      "provider header renamed",
      [
        "# >>> pickermux:historical-model-bridge >>>",
        "# pickermux:historical-model-bridge-config-existed=true",
        "[model_providers.model_bridge_old]",
        'name = "PickerMux (uninstalled)"',
        "# <<< pickermux:historical-model-bridge <<<",
        "",
      ].join("\n"),
    ],
  ];

  for (const [name, source] of remnants) {
    await t.test(`install: ${name}`, async (t) => {
      const fixture = await makeFixture(t);
      await writeFile(fixture.configPath, source);
      await assert.rejects(
        installConfig(fixture.options({
          modelProvider: "model_bridge",
          provider,
        })),
        (error) => error.code === "HISTORICAL_MARKER_CONFLICT",
      );
      assert.equal(await readFile(fixture.configPath, "utf8"), source);
      await assert.rejects(stat(fixture.statePath), { code: "ENOENT" });
    });

    await t.test(`state-absent purge: ${name}`, async (t) => {
      const fixture = await makeFixture(t);
      await writeFile(fixture.configPath, source);
      await assert.rejects(
        uninstallConfig({
          ...fixture.paths(),
          preserveHistoricalModelBridge: true,
        }),
        (error) => error.code === "HISTORICAL_MARKER_CONFLICT",
      );
      assert.equal(await readFile(fixture.configPath, "utf8"), source);
      assert.equal(
        source.match(/pickermux:historical-model-bridge/gu)?.length,
        (await readFile(fixture.configPath, "utf8"))
          .match(/pickermux:historical-model-bridge/gu)?.length,
      );
    });
  }

  const quotedFixture = await makeFixture(t);
  await writeFile(
    quotedFixture.configPath,
    'user_note = "pickermux:historical-model-bridge"\n',
  );
  const installed = await installConfig(quotedFixture.options({
    modelProvider: "model_bridge",
    provider,
  }));
  assert.equal(installed.changed, true);
});

test("historical marker comments are distinguished from multiline string content", async (t) => {
  const provider = {
    id: "model_bridge",
    name: "Model Bridge Fixture",
    baseUrl: "http://127.0.0.1:1234/v1/",
    wireApi: "responses",
    requiresOpenAiAuth: false,
    supportsWebsockets: false,
    supportsStandaloneWebSearch: false,
  };

  for (const [name, delimiter] of [
    ["basic", '\"\"\"'],
    ["literal", "'''"],
  ]) {
    const stringSource = [
      `user_note = ${delimiter}`,
      "# pickermux:historical-model-bridge is string content",
      'model = "not a root assignment"',
      "[model_providers.model_bridge]",
      'model_providers.model_bridge = { name = "also string content" }',
      delimiter,
      "",
    ].join("\n");

    await t.test(`${name} multiline content is not a conflict`, async (t) => {
      const installFixture = await makeFixture(t);
      await writeFile(installFixture.configPath, stringSource);
      const installed = await installConfig(installFixture.options({
        modelProvider: "model_bridge",
        provider,
      }));
      assert.equal(installed.changed, true);
      assert.equal(
        await readFile(installed.backupPath, "utf8"),
        stringSource,
      );
      await uninstallConfig(installFixture.paths());
      assert.equal(
        await readFile(installFixture.configPath, "utf8"),
        stringSource,
      );

      const purgeFixture = await makeFixture(t);
      await writeFile(purgeFixture.configPath, stringSource);
      const preserved = await uninstallConfig({
        ...purgeFixture.paths(),
        preserveHistoricalModelBridge: true,
      });
      assert.equal(preserved.historicalCompatibility, true);
      assert.ok(
        (await readFile(purgeFixture.configPath, "utf8"))
          .startsWith(stringSource),
      );
    });

    const commentSource = [
      `user_note = ${delimiter}`,
      "ordinary string content",
      `${delimiter} # pickermux:historical-model-bridge-orphaned`,
      "",
    ].join("\n");

    await t.test(`${name} trailing marker comment is a conflict`, async (t) => {
      const installFixture = await makeFixture(t);
      await writeFile(installFixture.configPath, commentSource);
      await assert.rejects(
        installConfig(installFixture.options({
          modelProvider: "model_bridge",
          provider,
        })),
        (error) => error.code === "HISTORICAL_MARKER_CONFLICT",
      );
      assert.equal(
        await readFile(installFixture.configPath, "utf8"),
        commentSource,
      );

      const purgeFixture = await makeFixture(t);
      await writeFile(purgeFixture.configPath, commentSource);
      await assert.rejects(
        uninstallConfig({
          ...purgeFixture.paths(),
          preserveHistoricalModelBridge: true,
        }),
        (error) => error.code === "HISTORICAL_MARKER_CONFLICT",
      );
      assert.equal(
        await readFile(purgeFixture.configPath, "utf8"),
        commentSource,
      );
    });
  }
});

test("unterminated multiline strings fail closed before install or state-absent purge", async (t) => {
  const provider = {
    id: "model_bridge",
    name: "Model Bridge Fixture",
    baseUrl: "http://127.0.0.1:1234/v1/",
    wireApi: "responses",
    requiresOpenAiAuth: false,
    supportsWebsockets: false,
    supportsStandaloneWebSearch: false,
  };

  for (const [name, delimiter] of [
    ["basic", '\"\"\"'],
    ["literal", "'''"],
  ]) {
    const source = [
      `user_note = ${delimiter}`,
      "# pickermux:historical-model-bridge-orphaned",
      "",
    ].join("\n");

    await t.test(`install: ${name}`, async (t) => {
      const fixture = await makeFixture(t);
      await writeFile(fixture.configPath, source);
      await assert.rejects(
        installConfig(fixture.options({
          modelProvider: "model_bridge",
          provider,
        })),
        (error) => error.code === "MALFORMED_TOML_MULTILINE_STRING",
      );
      assert.equal(await readFile(fixture.configPath, "utf8"), source);
      await assert.rejects(stat(fixture.statePath), { code: "ENOENT" });
    });

    await t.test(`state-absent purge: ${name}`, async (t) => {
      const fixture = await makeFixture(t);
      await writeFile(fixture.configPath, source);
      await assert.rejects(
        uninstallConfig({
          ...fixture.paths(),
          preserveHistoricalModelBridge: true,
        }),
        (error) => error.code === "MALFORMED_TOML_MULTILINE_STRING",
      );
      assert.equal(await readFile(fixture.configPath, "utf8"), source);
    });
  }
});

test("state-absent purge compatibility restores the ordinary-uninstall sequence", async (t) => {
  const fixture = await makeFixture(t);
  const original = 'model = "gpt-5.6-sol"\n';
  const provider = {
    id: "model_bridge",
    name: "Model Bridge Fixture",
    baseUrl: "http://127.0.0.1:1234/v1/",
    wireApi: "responses",
    requiresOpenAiAuth: false,
    supportsWebsockets: false,
    supportsStandaloneWebSearch: false,
  };
  const options = fixture.options({ modelProvider: "model_bridge", provider });
  await writeFile(fixture.configPath, original);
  await installConfig(options);
  await uninstallConfig(fixture.paths());
  await assert.rejects(stat(fixture.statePath), { code: "ENOENT" });

  const preserved = await uninstallConfig({
    ...fixture.paths(),
    preserveHistoricalModelBridge: true,
  });
  assert.equal(preserved.changed, true);
  assert.match(
    await readFile(fixture.configPath, "utf8"),
    /historical-model-bridge-config-existed=true/u,
  );
  const retained = await uninstallConfig({
    ...fixture.paths(),
    preserveHistoricalModelBridge: true,
  });
  assert.deepEqual(
    { changed: retained.changed, historicalCompatibility: retained.historicalCompatibility },
    { changed: false, historicalCompatibility: true },
  );

  const reinstalled = await installConfig(options);
  assert.deepEqual(await readFile(reinstalled.backupPath), Buffer.from(original));
  await uninstallConfig(fixture.paths());
  assert.deepEqual(await readFile(fixture.configPath), Buffer.from(original));

  await t.test("originally absent config remains absent after reinstall and ordinary uninstall", async (t) => {
    const absentFixture = await makeFixture(t);
    const absentOptions = absentFixture.options({
      modelProvider: "model_bridge",
      provider,
    });
    await installConfig(absentOptions);
    await uninstallConfig(absentFixture.paths());
    await assert.rejects(stat(absentFixture.configPath), { code: "ENOENT" });

    await uninstallConfig({
      ...absentFixture.paths(),
      preserveHistoricalModelBridge: true,
    });
    assert.match(
      await readFile(absentFixture.configPath, "utf8"),
      /historical-model-bridge-config-existed=false/u,
    );
    await installConfig(absentOptions);
    await uninstallConfig(absentFixture.paths());
    await assert.rejects(stat(absentFixture.configPath), { code: "ENOENT" });
  });
});

test("chat repair restores an inert provider after ordinary uninstall and is idempotent", async (t) => {
  const fixture = await makeFixture(t);
  const original = 'model = "gpt-5.6-sol"\n[features]\nother = true\n';
  const provider = {
    id: "model_bridge",
    name: "Model Bridge Fixture",
    baseUrl: "http://127.0.0.1:1234/v1/",
    wireApi: "responses",
    requiresOpenAiAuth: false,
    supportsWebsockets: false,
    supportsStandaloneWebSearch: false,
  };
  const installOptions = fixture.options({ modelProvider: "model_bridge", provider });
  await writeFile(fixture.configPath, original, { mode: 0o600 });
  await installConfig(installOptions);
  await uninstallConfig(fixture.paths());
  assert.equal(await readFile(fixture.configPath, "utf8"), original);

  const repaired = await repairHistoricalChatsConfig(fixture.paths());
  assert.equal(repaired.changed, true);
  assert.equal(repaired.historicalCompatibility, true);
  assert.equal(repaired.provider, "model_bridge");
  const restored = await readFile(fixture.configPath, "utf8");
  assert.ok(restored.startsWith(original));
  assert.equal((restored.match(/^\[model_providers\.model_bridge\]$/gmu) ?? []).length, 1);
  assert.match(restored, /base_url = "http:\/\/127\.0\.0\.1:0\/v1"/u);
  assert.match(restored, /requires_openai_auth = false/u);
  assert.match(restored, /request_max_retries = 0/u);
  assert.match(restored, /stream_max_retries = 0/u);
  assert.equal((await stat(fixture.configPath)).mode & 0o777, 0o600);
  await assert.rejects(stat(fixture.statePath), { code: "ENOENT" });

  const repeated = await repairHistoricalChatsConfig(fixture.paths());
  assert.equal(repeated.changed, false);
  assert.equal(repeated.historicalCompatibility, true);
  assert.equal(await readFile(fixture.configPath, "utf8"), restored);

  const reinstalled = await installConfig(installOptions);
  assert.deepEqual(await readFile(reinstalled.backupPath), Buffer.from(original));
  await uninstallConfig(fixture.paths());
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
});

test("chat repair refuses active state without changing managed configuration", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(fixture.configPath, 'model = "gpt-5.6-sol"\n');
  await installConfig(fixture.options());
  const beforeConfig = await readFile(fixture.configPath);
  const beforeState = await readFile(fixture.statePath);

  await assert.rejects(
    repairHistoricalChatsConfig(fixture.paths()),
    (error) => error.code === "INTEGRATION_INSTALLED",
  );
  assert.deepEqual(await readFile(fixture.configPath), beforeConfig);
  assert.deepEqual(await readFile(fixture.statePath), beforeState);
});

test("chat repair refuses a state file appearing before configuration commit", async (t) => {
  const fixture = await makeFixture(t);
  const original = 'model = "gpt-5.6-sol"\n';
  await writeFile(fixture.configPath, original);

  await assert.rejects(
    repairHistoricalChatsConfig({
      ...fixture.paths(),
      beforeConfigCommit: async () => {
        await mkdir(join(fixture.directory, "state"), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(fixture.statePath, "{}\n", { mode: 0o600 });
      },
    }),
    (error) => error.code === "STATE_CHANGED_CONCURRENTLY",
  );
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
});

test("chat repair preserves foreign provider and orphaned marker conflicts", async (t) => {
  for (const [name, source, code] of [
    [
      "foreign provider",
      '["model_providers"."model_bridge"]\nname = "foreign"\n',
      "HISTORICAL_PROVIDER_CONFLICT",
    ],
    [
      "orphaned managed marker",
      `${CONFIG_MARKERS.providerBegin}\n`,
      "ORPHANED_MANAGED_BLOCK",
    ],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await makeFixture(subtest);
      await writeFile(fixture.configPath, source);
      await assert.rejects(
        repairHistoricalChatsConfig(fixture.paths()),
        (error) => error.code === code,
      );
      assert.equal(await readFile(fixture.configPath, "utf8"), source);
      await assert.rejects(stat(fixture.statePath), { code: "ENOENT" });
    });
  }
});

test("state-absent purge compatibility fails closed on concurrent state or quoted provider conflicts", async (t) => {
  await t.test("concurrent state", async (t) => {
    const fixture = await makeFixture(t);
    const original = 'model = "gpt-5.6-sol"\n';
    await writeFile(fixture.configPath, original);
    await assert.rejects(
      uninstallConfig({
        ...fixture.paths(),
        preserveHistoricalModelBridge: true,
        beforeConfigCommit: async () => {
          await mkdir(join(fixture.directory, "state"), {
            recursive: true,
            mode: 0o700,
          });
          await writeFile(fixture.statePath, "{}\n", { mode: 0o600 });
        },
      }),
      (error) => error.code === "STATE_CHANGED_CONCURRENTLY",
    );
    assert.equal(await readFile(fixture.configPath, "utf8"), original);
  });

  await t.test("quoted provider", async (t) => {
    const fixture = await makeFixture(t);
    const source = '["model_providers"."model_bridge"]\nname = "foreign"\n';
    await writeFile(fixture.configPath, source);
    await assert.rejects(
      uninstallConfig({
        ...fixture.paths(),
        preserveHistoricalModelBridge: true,
      }),
      (error) => error.code === "HISTORICAL_PROVIDER_CONFLICT",
    );
    assert.equal(await readFile(fixture.configPath, "utf8"), source);
  });
});

test("state-absent purge validates the prefix of an exact terminal tombstone", async (t) => {
  const compatibility = [
    "# >>> pickermux:historical-model-bridge >>>",
    "# Preserves historical chat parsing after PickerMux is removed.",
    "# pickermux:historical-model-bridge-config-existed=true",
    "[model_providers.model_bridge]",
    'name = "PickerMux (uninstalled)"',
    'base_url = "http://127.0.0.1:0/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "supports_standalone_web_search = false",
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "# <<< pickermux:historical-model-bridge <<<",
    "",
  ].join("\n");
  const cases = [
    {
      name: "foreign provider table",
      prefix: '[model_providers.model_bridge]\nname = "foreign"',
      code: "HISTORICAL_PROVIDER_CONFLICT",
    },
    {
      name: "stale ownership marker",
      prefix: [
        "# pickermux:historical-model-bridge-orphaned",
        "[features]",
        "web_search = true",
      ].join("\n"),
      code: "HISTORICAL_MARKER_CONFLICT",
    },
  ];

  for (const { name, prefix, code } of cases) {
    await t.test(name, async (t) => {
      const fixture = await makeFixture(t);
      const source = `${prefix}\n${compatibility}`;
      await writeFile(fixture.configPath, source);
      await assert.rejects(
        uninstallConfig({
          ...fixture.paths(),
          preserveHistoricalModelBridge: true,
        }),
        (error) => error.code === code,
      );
      assert.equal(await readFile(fixture.configPath, "utf8"), source);
    });
  }
});

test("purge compatibility reinstalls preserve native config bytes across newline boundaries", async (t) => {
  const provider = {
    id: "model_bridge",
    name: "Model Bridge Fixture",
    baseUrl: "http://127.0.0.1:1234/v1/",
    wireApi: "responses",
    requiresOpenAiAuth: false,
    supportsWebsockets: false,
    supportsStandaloneWebSearch: false,
  };
  for (const [name, original] of [
    ["LF", 'model = "gpt-5.6-sol"\noperator_setting = true\n'],
    ["CRLF", 'model = "gpt-5.6-sol"\r\noperator_setting = true\r\n'],
    ["no final newline", 'model = "gpt-5.6-sol"\noperator_setting = true'],
  ]) {
    await t.test(name, async (t) => {
      const fixture = await makeFixture(t);
      const options = fixture.options({
        modelProvider: "model_bridge",
        provider,
      });
      await writeFile(fixture.configPath, original);
      await installConfig(options);
      await uninstallConfig({
        ...fixture.paths(),
        preserveHistoricalModelBridge: true,
      });

      const reinstalled = await installConfig(options);
      assert.deepEqual(await readFile(reinstalled.backupPath), Buffer.from(original));
      await uninstallConfig(fixture.paths());
      assert.deepEqual(await readFile(fixture.configPath), Buffer.from(original));
    });
  }
});

test("purge-only historical compatibility restore refuses a concurrent config change", async (t) => {
  const fixture = await makeFixture(t);
  const original = 'model = "gpt-5.6-sol"\n';
  const provider = {
    id: "model_bridge",
    name: "Model Bridge Fixture",
    baseUrl: "http://127.0.0.1:1234/v1/",
    wireApi: "responses",
    requiresOpenAiAuth: false,
    supportsWebsockets: false,
    supportsStandaloneWebSearch: false,
  };
  await writeFile(fixture.configPath, original);
  await installConfig(fixture.options({
    modelProvider: "model_bridge",
    provider,
  }));
  const installed = await readFile(fixture.configPath, "utf8");
  const concurrent = `${installed}user_setting = true\n`;

  await assert.rejects(
    uninstallConfig({
      ...fixture.paths(),
      preserveHistoricalModelBridge: true,
      beforeConfigCommit: () => writeFile(fixture.configPath, concurrent),
    }),
    (error) => error.code === "CONFIG_CHANGED_CONCURRENTLY",
  );
  assert.equal(await readFile(fixture.configPath, "utf8"), concurrent);
  assert.doesNotMatch(
    await readFile(fixture.configPath, "utf8"),
    /historical-model-bridge/u,
  );
  assert.equal((await getConfigStatus(fixture.paths())).installed, true);
});

test("ordinary canonical uninstall does not write historical compatibility", async (t) => {
  const fixture = await makeFixture(t);
  const original = 'model = "gpt-5.6-sol"\n';
  const provider = {
    id: "model_bridge",
    name: "Model Bridge Fixture",
    baseUrl: "http://127.0.0.1:1234/v1/",
    wireApi: "responses",
    requiresOpenAiAuth: false,
    supportsWebsockets: false,
    supportsStandaloneWebSearch: false,
  };
  await writeFile(fixture.configPath, original);
  await installConfig(fixture.options({
    modelProvider: "model_bridge",
    provider,
  }));

  const result = await uninstallConfig(fixture.paths());
  assert.equal(result.historicalCompatibility, false);
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
});

test("purge compatibility creates the only config table when no config existed before install", async (t) => {
  const fixture = await makeFixture(t);
  const provider = {
    id: "model_bridge",
    name: "Model Bridge Fixture",
    baseUrl: "http://127.0.0.1:1234/v1/",
    wireApi: "responses",
    requiresOpenAiAuth: false,
    supportsWebsockets: false,
    supportsStandaloneWebSearch: false,
  };
  const options = fixture.options({
    modelProvider: "model_bridge",
    provider,
  });

  await installConfig(options);
  const ordinary = await uninstallConfig(fixture.paths());
  assert.equal(ordinary.historicalCompatibility, false);
  await assert.rejects(stat(fixture.configPath), { code: "ENOENT" });

  await installConfig(options);
  const purged = await uninstallConfig({
    ...fixture.paths(),
    preserveHistoricalModelBridge: true,
  });
  const expected = [
    "# >>> pickermux:historical-model-bridge >>>",
    "# Preserves historical chat parsing after PickerMux is removed.",
    "# pickermux:historical-model-bridge-config-existed=false",
    "[model_providers.model_bridge]",
    'name = "PickerMux (uninstalled)"',
    'base_url = "http://127.0.0.1:0/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "supports_standalone_web_search = false",
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "# <<< pickermux:historical-model-bridge <<<",
    "",
  ].join("\n");
  assert.equal(purged.historicalCompatibility, true);
  assert.equal(await readFile(fixture.configPath, "utf8"), expected);
  assert.equal((await stat(fixture.configPath)).mode & 0o777, 0o600);
  await assert.rejects(stat(fixture.statePath), { code: "ENOENT" });
  assert.deepEqual(
    pickStatus(await getConfigStatus(fixture.paths())),
    { installed: false, healthy: true, status: "not-installed" },
  );

  const reinstalled = await installConfig(options);
  assert.deepEqual(await readFile(reinstalled.backupPath), Buffer.alloc(0));
  await uninstallConfig(fixture.paths());
  await assert.rejects(stat(fixture.configPath), { code: "ENOENT" });
});

test("tombstone provenance retains an originally empty config file", async (t) => {
  const fixture = await makeFixture(t);
  const provider = {
    id: "model_bridge",
    name: "Model Bridge Fixture",
    baseUrl: "http://127.0.0.1:1234/v1/",
    wireApi: "responses",
    requiresOpenAiAuth: false,
    supportsWebsockets: false,
    supportsStandaloneWebSearch: false,
  };
  const options = fixture.options({ modelProvider: "model_bridge", provider });
  await writeFile(fixture.configPath, "");
  await installConfig(options);
  await uninstallConfig({
    ...fixture.paths(),
    preserveHistoricalModelBridge: true,
  });
  assert.match(
    await readFile(fixture.configPath, "utf8"),
    /historical-model-bridge-config-existed=true/u,
  );

  const reinstalled = await installConfig(options);
  assert.deepEqual(await readFile(reinstalled.backupPath), Buffer.alloc(0));
  await uninstallConfig(fixture.paths());
  assert.equal(await readFile(fixture.configPath, "utf8"), "");
  assert.equal((await stat(fixture.configPath)).isFile(), true);
});

test("tombstone provenance retains user content added to an originally absent config", async (t) => {
  const fixture = await makeFixture(t);
  const provider = {
    id: "model_bridge",
    name: "Model Bridge Fixture",
    baseUrl: "http://127.0.0.1:1234/v1/",
    wireApi: "responses",
    requiresOpenAiAuth: false,
    supportsWebsockets: false,
    supportsStandaloneWebSearch: false,
  };
  const options = fixture.options({ modelProvider: "model_bridge", provider });
  await installConfig(options);
  const installed = await readFile(fixture.configPath, "utf8");
  const userContent = "[features]\nweb_search = true\n";
  await writeFile(fixture.configPath, `${installed}${userContent}`);

  await uninstallConfig({
    ...fixture.paths(),
    preserveHistoricalModelBridge: true,
  });
  const preserved = await readFile(fixture.configPath, "utf8");
  assert.match(preserved, /historical-model-bridge-config-existed=true/u);
  assert.ok(preserved.startsWith(userContent));

  const reinstalled = await installConfig(options);
  assert.deepEqual(
    await readFile(reinstalled.backupPath),
    Buffer.from(userContent),
  );
  await uninstallConfig(fixture.paths());
  assert.deepEqual(await readFile(fixture.configPath), Buffer.from(userContent));
});

test("duplicate and malformed managed root keys are rejected, while table-scoped keys are ignored", async (t) => {
  await t.test("duplicate", async (t) => {
    const fixture = await makeFixture(t);
    await writeFile(
      fixture.configPath,
      'model = "one"\n"model" = "two"\n[features]\nmodel = "scoped"\n',
    );
    await assert.rejects(
      installConfig(fixture.options()),
      (error) => error.code === "DUPLICATE_MANAGED_KEY",
    );
  });

  await t.test("malformed reasoning value", async (t) => {
    const fixture = await makeFixture(t);
    await writeFile(fixture.configPath, "model_reasoning_effort = ultra\n");
    await assert.rejects(
      installConfig(fixture.options()),
      (error) => error.code === "MALFORMED_MANAGED_KEY",
    );
  });

  await t.test("table scoped", async (t) => {
    const fixture = await makeFixture(t);
    await writeFile(
      fixture.configPath,
      '[features]\nmodel = "scoped"\nmodel_reasoning_effort = "ultra"\n',
    );
    await installConfig(fixture.options());
    const installed = await readFile(fixture.configPath, "utf8");
    assert.match(installed, /\[features\]\nmodel = "scoped"/);
    assert.match(installed, /\[features\][\s\S]*model_reasoning_effort = "ultra"/);
  });
});

test("orphaned or partial managed markers are never overwritten", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(fixture.configPath, `${CONFIG_MARKERS.rootBegin}\nmodel = "x"\n`);
  await assert.rejects(
    installConfig(fixture.options()),
    (error) => error.code === "EXISTING_MANAGED_MARKER",
  );
  const status = await getConfigStatus(fixture.paths());
  assert.equal(status.status, "orphaned-managed-block");
  await assert.rejects(
    uninstallConfig(fixture.paths()),
    (error) => error.code === "ORPHANED_MANAGED_BLOCK",
  );
});

test("mixed bridge accepts ultra so the native default remains Sol Ultra", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(fixture.configPath, 'model_reasoning_effort = "ultra"\n');
  await installConfig(fixture.options({ modelReasoningEffort: "ultra" }));
  assert.match(await readFile(fixture.configPath, "utf8"), /model_reasoning_effort = "ultra"/u);
  await uninstallConfig(fixture.paths());
  assert.equal(await readFile(fixture.configPath, "utf8"), 'model_reasoning_effort = "ultra"\n');
});

test("compare-and-swap refuses concurrent config changes during install and uninstall", async (t) => {
  await t.test("install", async (t) => {
    const fixture = await makeFixture(t);
    const original = 'model = "gpt-5.6-sol"\n';
    const concurrent = `${original}concurrent_user_edit = true\n`;
    await writeFile(fixture.configPath, original);

    await assert.rejects(
      installConfig(
        fixture.options({
          beforeConfigCommit: () => writeFile(fixture.configPath, concurrent),
        }),
      ),
      (error) => error.code === "CONFIG_CHANGED_CONCURRENTLY",
    );
    assert.equal(await readFile(fixture.configPath, "utf8"), concurrent);
    await assert.rejects(readFile(fixture.statePath), (error) => error.code === "ENOENT");
  });

  await t.test("uninstall", async (t) => {
    const fixture = await makeFixture(t);
    await writeFile(fixture.configPath, 'model = "gpt-5.6-sol"\n');
    await installConfig(fixture.options());
    const installed = await readFile(fixture.configPath, "utf8");
    const concurrent = `${installed}[user_after_install]\nconcurrent_user_edit = true\n`;

    await assert.rejects(
      uninstallConfig({
        ...fixture.paths(),
        beforeConfigCommit: () => writeFile(fixture.configPath, concurrent),
      }),
      (error) => error.code === "CONFIG_CHANGED_CONCURRENTLY",
    );
    assert.equal(await readFile(fixture.configPath, "utf8"), concurrent);
    assert.equal(JSON.parse(await readFile(fixture.statePath, "utf8")).version, 1);

    await uninstallConfig(fixture.paths());
    assert.match(await readFile(fixture.configPath, "utf8"), /concurrent_user_edit = true/);
  });

  await t.test("hard-link replacement", async (t) => {
    const fixture = await makeFixture(t);
    const original = 'model = "gpt-5.6-sol"\n';
    const authPath = join(fixture.directory, "codex", "auth.json");
    const authContents = Buffer.from('{"tokens":"must-not-be-read"}\n');
    await writeFile(fixture.configPath, original);
    await writeFile(authPath, authContents, { mode: 0o600 });
    const authBefore = await snapshotFile(authPath);
    await chmod(authPath, 0o000);

    try {
      await assert.rejects(
        installConfig(
          fixture.options({
            async beforeConfigCommit() {
              await unlink(fixture.configPath);
              await link(authPath, fixture.configPath);
            },
          }),
        ),
        (error) =>
          error.code === "CONFIG_CHANGED_CONCURRENTLY" &&
          error.details?.cause?.code === "CONFIG_NOT_REGULAR",
      );
    } finally {
      await chmod(authPath, 0o600);
    }
    assert.deepEqual(await readFile(fixture.configPath), authContents);
    assert.deepEqual(await snapshotFile(authPath), authBefore);
    await assert.rejects(readFile(fixture.statePath), { code: "ENOENT" });
  });
});

test("failed state removal rolls the config back exactly and permits a clean retry", async (t) => {
  const fixture = await makeFixture(t);
  const original = 'model = "gpt-5.6-sol"\nuser_setting = true\n';
  await writeFile(fixture.configPath, original, { mode: 0o640 });
  await chmod(fixture.configPath, 0o640);
  await installConfig(fixture.options());
  const installedConfig = await snapshotFile(fixture.configPath);
  const installedState = await snapshotFile(fixture.statePath);
  const stateDirectory = join(fixture.directory, "state");

  await assert.rejects(
    (async () => {
      try {
        await uninstallConfig({
          ...fixture.paths(),
          beforeConfigCommit: () => chmod(stateDirectory, 0o500),
        });
      } finally {
        await chmod(stateDirectory, 0o700);
      }
    })(),
    (error) =>
      error.code === "STATE_REMOVE_FAILED" &&
      error.details?.rollbackCause === undefined,
  );
  const rolledBackConfig = await snapshotFile(fixture.configPath);
  assert.deepEqual(rolledBackConfig.contents, installedConfig.contents);
  assert.equal(rolledBackConfig.mode, installedConfig.mode);
  assert.deepEqual(await snapshotFile(fixture.statePath), installedState);

  const retried = await uninstallConfig(fixture.paths());
  assert.equal(retried.changed, true);
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
  await assert.rejects(readFile(fixture.statePath), { code: "ENOENT" });
});

test("failed purge compatibility state removal restores managed config before retry", async (t) => {
  const fixture = await makeFixture(t);
  const provider = {
    id: "model_bridge",
    name: "Model Bridge Fixture",
    baseUrl: "http://127.0.0.1:1234/v1/",
    wireApi: "responses",
    requiresOpenAiAuth: false,
    supportsWebsockets: false,
    supportsStandaloneWebSearch: false,
  };
  await writeFile(fixture.configPath, 'model = "gpt-5.6-sol"\n', { mode: 0o640 });
  await chmod(fixture.configPath, 0o640);
  await installConfig(fixture.options({
    modelProvider: "model_bridge",
    provider,
  }));
  const installedConfig = await snapshotFile(fixture.configPath);
  const installedState = await snapshotFile(fixture.statePath);
  const stateDirectory = join(fixture.directory, "state");

  await assert.rejects(
    (async () => {
      try {
        await uninstallConfig({
          ...fixture.paths(),
          preserveHistoricalModelBridge: true,
          beforeConfigCommit: () => chmod(stateDirectory, 0o500),
        });
      } finally {
        await chmod(stateDirectory, 0o700);
      }
    })(),
    (error) =>
      error.code === "STATE_REMOVE_FAILED" &&
      error.details?.rollbackCause === undefined,
  );
  const rolledBackConfig = await snapshotFile(fixture.configPath);
  assert.deepEqual(rolledBackConfig.contents, installedConfig.contents);
  assert.equal(rolledBackConfig.mode, installedConfig.mode);
  assert.deepEqual(await snapshotFile(fixture.statePath), installedState);
  assert.doesNotMatch(
    await readFile(fixture.configPath, "utf8"),
    /historical-model-bridge/u,
  );

  const retried = await uninstallConfig({
    ...fixture.paths(),
    preserveHistoricalModelBridge: true,
  });
  assert.equal(retried.historicalCompatibility, true);
  assert.match(
    await readFile(fixture.configPath, "utf8"),
    /\[model_providers\.model_bridge\]/u,
  );
  await assert.rejects(readFile(fixture.statePath), { code: "ENOENT" });
});

test("provider-scoped content after the end marker is detected and protected", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(
    fixture.configPath,
    'model = "gpt-5.6-sol"\n[features]\nweb_search = true\n',
  );
  await installConfig(fixture.options());
  const installed = await readFile(fixture.configPath, "utf8");
  await writeFile(
    fixture.configPath,
    installed.replace(
      `${CONFIG_MARKERS.providerEnd}\n[features]`,
      `${CONFIG_MARKERS.providerEnd}\nrequest_max_retries = 99\n[features]`,
    ),
  );

  const status = await getConfigStatus(fixture.paths());
  assert.equal(status.status, "modified");
  assert.deepEqual(status.modifiedBlocks, ["provider-scope-tail"]);
  await assert.rejects(
    uninstallConfig(fixture.paths()),
    (error) =>
      error.code === "MANAGED_BLOCK_MODIFIED" &&
      error.details.modified.includes("provider-scope-tail"),
  );
});

test("uninstall removes a config file that did not exist before install", async (t) => {
  const fixture = await makeFixture(t);
  await installConfig(fixture.options());
  assert.equal((await stat(fixture.configPath)).isFile(), true);

  const result = await uninstallConfig(fixture.paths());
  assert.equal(result.changed, true);
  await assert.rejects(stat(fixture.configPath), (error) => error.code === "ENOENT");
});

test("symbolic-link configs are refused", async (t) => {
  const fixture = await makeFixture(t);
  const target = join(fixture.directory, "real-config.toml");
  await writeFile(target, 'model = "gpt-5.6-sol"\n');
  await symlink(target, fixture.configPath);

  await assert.rejects(
    installConfig(fixture.options()),
    (error) => error.code === "CONFIG_SYMLINK",
  );
  assert.equal(await readFile(target, "utf8"), 'model = "gpt-5.6-sol"\n');
});

test("hard-linked configs are refused without reading or changing auth.json", async (t) => {
  const fixture = await makeFixture(t);
  const authPath = join(fixture.directory, "codex", "auth.json");
  const authContents = Buffer.from('{"tokens":"must-not-be-read"}\n');
  await writeFile(authPath, authContents, { mode: 0o600 });
  await link(authPath, fixture.configPath);
  const authBefore = await snapshotFile(authPath);
  await chmod(authPath, 0o000);

  try {
    await assert.rejects(
      installConfig(fixture.options()),
      (error) => error.code === "CONFIG_NOT_REGULAR",
    );
  } finally {
    await chmod(authPath, 0o600);
  }
  assert.deepEqual(await snapshotFile(authPath), authBefore);
});

test("uninstall refuses a forged backupPath before reading foreign Codex state", async (t) => {
  const fixture = await makeFixture(t);
  const original = 'model = "gpt-5.6-sol"\n';
  const authPath = join(fixture.directory, "codex", "auth.json");
  await writeFile(fixture.configPath, original);
  await writeFile(authPath, original, { mode: 0o600 });
  await installConfig(fixture.options());
  const installedConfig = await readFile(fixture.configPath);
  const authBefore = await snapshotFile(authPath);
  const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
  state.backupPath = authPath;
  await writeFile(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`);

  await assert.rejects(
    uninstallConfig(fixture.paths()),
    (error) => error.code === "UNSAFE_BACKUP_PATH",
  );
  assert.deepEqual(await readFile(fixture.configPath), installedConfig);
  assert.deepEqual(await snapshotFile(authPath), authBefore);
});

test("ownership revalidation does not open a state that appeared after an absent inventory", async (t) => {
  const fixture = await makeFixture(t);
  const receipt = await inventoryManagedConfigOwnership(fixture.paths());
  const foreignState = Buffer.from("foreign account state must not be read\n");
  await mkdir(join(fixture.directory, "state"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(fixture.statePath, foreignState, { mode: 0o000 });

  await assert.rejects(
    revalidateManagedConfigOwnership(receipt),
    (error) => error.code === "STATE_CHANGED_CONCURRENTLY",
  );
  await chmod(fixture.statePath, 0o600);
  assert.deepEqual(await readFile(fixture.statePath), foreignState);
});

test("ownership revalidation rejects a regular state replacement before opening it", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(fixture.configPath, 'model = "gpt-5.6-sol"\n');
  await installConfig(fixture.options());
  const receipt = await inventoryManagedConfigOwnership(fixture.paths());
  const foreignState = Buffer.from("foreign account state must not be read\n");
  await unlink(fixture.statePath);
  await writeFile(fixture.statePath, foreignState, { mode: 0o000 });

  await assert.rejects(
    revalidateManagedConfigOwnership(receipt),
    (error) => error.code === "MANAGED_FILE_CHANGED",
  );
  await chmod(fixture.statePath, 0o600);
  assert.deepEqual(await readFile(fixture.statePath), foreignState);
});

test("uninstall refuses a hard-linked configuration state", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(fixture.configPath, 'model = "gpt-5.6-sol"\n');
  await installConfig(fixture.options());
  const stateBytes = await readFile(fixture.statePath);
  const authPath = join(fixture.directory, "codex", "auth.json");
  await unlink(fixture.statePath);
  await writeFile(authPath, stateBytes, { mode: 0o600 });
  await link(authPath, fixture.statePath);
  const installedConfig = await readFile(fixture.configPath);

  await assert.rejects(
    uninstallConfig(fixture.paths()),
    (error) => error.code === "UNSAFE_MANAGED_FILE",
  );
  assert.deepEqual(await readFile(fixture.configPath), installedConfig);
  assert.deepEqual(await readFile(authPath), stateBytes);
});

test("uninstall refuses state.json replaced by a symlink after ownership inventory", async (t) => {
  const fixture = await makeFixture(t);
  const original = 'model = "gpt-5.6-sol"\n';
  await writeFile(fixture.configPath, original);
  await installConfig(fixture.options());
  const installedConfig = await readFile(fixture.configPath);
  const stateBytes = await readFile(fixture.statePath);
  const authPath = join(fixture.directory, "codex", "auth.json");
  await writeFile(authPath, stateBytes, { mode: 0o600 });
  const authBefore = await snapshotFile(authPath);

  await assert.rejects(
    uninstallConfig({
      ...fixture.paths(),
      async beforeConfigCommit() {
        await unlink(fixture.statePath);
        await symlink(authPath, fixture.statePath);
      },
    }),
    (error) => error.code === "UNSAFE_MANAGED_FILE",
  );
  assert.deepEqual(await readFile(fixture.configPath), installedConfig);
  assert.deepEqual(await snapshotFile(authPath), authBefore);
});

test("uninstall refuses a managed backup replaced by a symlink", async (t) => {
  const fixture = await makeFixture(t);
  const original = 'model = "gpt-5.6-sol"\n';
  await writeFile(fixture.configPath, original);
  const installed = await installConfig(fixture.options());
  const installedConfig = await readFile(fixture.configPath);
  const authPath = join(fixture.directory, "codex", "auth.json");
  await writeFile(authPath, original, { mode: 0o600 });
  const authBefore = await snapshotFile(authPath);
  await unlink(installed.backupPath);
  await symlink(authPath, installed.backupPath);

  await assert.rejects(
    uninstallConfig(fixture.paths()),
    (error) =>
      error.code === "BACKUP_UNREADABLE" &&
      error.details?.cause?.code === "UNSAFE_MANAGED_FILE",
  );
  assert.deepEqual(await readFile(fixture.configPath), installedConfig);
  assert.deepEqual(await snapshotFile(authPath), authBefore);
});

test("uninstall refuses a managed backup replaced by a hard link", async (t) => {
  const fixture = await makeFixture(t);
  const original = 'model = "gpt-5.6-sol"\n';
  await writeFile(fixture.configPath, original);
  const installed = await installConfig(fixture.options());
  const installedConfig = await readFile(fixture.configPath);
  const authPath = join(fixture.directory, "codex", "auth.json");
  await unlink(installed.backupPath);
  await writeFile(authPath, original, { mode: 0o600 });
  await link(authPath, installed.backupPath);

  await assert.rejects(
    uninstallConfig(fixture.paths()),
    (error) =>
      error.code === "BACKUP_UNREADABLE" &&
      error.details?.cause?.code === "UNSAFE_MANAGED_FILE",
  );
  assert.deepEqual(await readFile(fixture.configPath), installedConfig);
  assert.equal(await readFile(authPath, "utf8"), original);
});

test("uninstall requires a private backup directory while allowing a 0640 backup", async (t) => {
  const fixture = await makeFixture(t);
  const original = 'model = "gpt-5.6-sol"\n';
  await writeFile(fixture.configPath, original, { mode: 0o640 });
  const installed = await installConfig(fixture.options());
  const installedConfig = await readFile(fixture.configPath);
  assert.equal((await stat(installed.backupPath)).mode & 0o777, 0o640);
  await chmod(fixture.backupDirectory, 0o755);

  await assert.rejects(
    uninstallConfig(fixture.paths()),
    (error) =>
      error.code === "BACKUP_UNREADABLE" &&
      error.details?.cause?.code === "UNSAFE_MANAGED_FILE",
  );
  assert.deepEqual(await readFile(fixture.configPath), installedConfig);
});

test("uninstall defaults to model-bridge/backups beside state.json", async (t) => {
  const fixture = await makeFixture(t);
  const statePath = join(fixture.directory, "codex", "model-bridge", "state.json");
  const backupDirectory = join(fixture.directory, "codex", "model-bridge", "backups");
  const original = 'model = "gpt-5.6-sol"\n';
  await writeFile(fixture.configPath, original);
  await installConfig(fixture.options({ statePath, backupDirectory }));

  await uninstallConfig({ configPath: fixture.configPath, statePath });
  assert.equal(await readFile(fixture.configPath, "utf8"), original);
});

async function reorderReceiptedProvider(fixture, eol) {
  return rewriteReceiptedProvider(fixture, (source) => {
    const lines = source.split(eol);
    const controls = lines.slice(2, -2).reverse();
    return [lines[0], lines[1], ...controls, lines.at(-2), ""].join(eol);
  }, true);
}

async function rewriteReceiptedProvider(fixture, transform, reseal) {
  const source = await readFile(fixture.configPath, "utf8");
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const start = source.indexOf(CONFIG_MARKERS.providerBegin);
  const end = source.indexOf(`${CONFIG_MARKERS.providerEnd}${eol}`) + CONFIG_MARKERS.providerEnd.length + eol.length;
  assert.ok(start >= 0 && end > start);
  const replacement = transform(source.slice(start, end));
  const next = source.slice(0, start) + replacement + source.slice(end);
  await writeFile(fixture.configPath, next);
  if (reseal) {
    const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
    state.blocks.provider.sha256 = createHash("sha256").update(replacement).digest("hex");
    state.installedSha256 = createHash("sha256").update(next).digest("hex");
    await writeFile(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

function removeProviderEndMarker(source, eol) {
  const markerLine = `${CONFIG_MARKERS.providerEnd}${eol}`;
  assert.equal(
    source.split(markerLine).length - 1,
    1,
    "fixture must contain exactly one provider end marker line",
  );
  return source.replace(markerLine, "");
}

async function makeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "lmstudio-config-manager-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "codex", "config.toml");
  const statePath = join(directory, "state", "install-state.json");
  const backupDirectory = join(directory, "backups");
  const catalogPath = join(directory, "catalog", "models.json");
  await mkdir(join(directory, "codex"), { recursive: true });

  return {
    directory,
    configPath,
    statePath,
    backupDirectory,
    catalogPath,
    paths: () => ({ configPath, statePath, backupDirectory }),
    options: (overrides = {}) => ({
      configPath,
      statePath,
      backupDirectory,
      model: "lmstudio/qwen3.8-27b",
      modelProvider: "model_bridge_fixture",
      modelCatalogJson: catalogPath,
      modelReasoningEffort: "low",
      provider: {
        id: "model_bridge_fixture",
        name: "Model Bridge Fixture",
        baseUrl: "http://127.0.0.1:1234/v1/",
        wireApi: "responses",
        requiresOpenAiAuth: false,
        supportsWebsockets: false,
        supportsStandaloneWebSearch: false,
      },
      now: FIXED_NOW,
      ...overrides,
    }),
  };
}

function pickStatus(value) {
  return {
    installed: value.installed,
    healthy: value.healthy,
    status: value.status,
  };
}

async function snapshotFile(target) {
  const [contents, metadata] = await Promise.all([
    readFile(target),
    stat(target),
  ]);
  return {
    contents,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode & 0o777,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
  };
}


test("intentional deactivation retains baseline, inert history and CAS-bound reactivation", async (t) => {
  for (const original of [undefined, 'model = "gpt-5.6-sol"\n[features]\nother = true\n', 'openai_base_url = "http://127.0.0.1:11434/api/codex/v1"\n[features]\nother = true\n']) {
    await t.test(original === undefined ? "absent" : original.startsWith("openai") ? "Ollama" : "native", async (subtest) => {
      const fixture = await makeFixture(subtest);
      if (original !== undefined) await writeFile(fixture.configPath, original);
      const options = fixture.options();
      options.modelProvider = options.provider.id = "model_bridge";
      const preview = await previewConfigIntegration(fixture.paths());
      if (["ollama", "foreign"].includes(preview.status)) options.integrationSwitchReceipt = await inventoryConfigIntegrationSwitch({ ...fixture.paths(), expectedPreviewToken: preview.previewToken });
      await installConfig(options);
      const baseline = JSON.parse(await readFile(fixture.statePath));
      const backup = await readFile(baseline.backupPath);
      await deactivateManagedConfiguration(fixture.paths());
      assert.deepEqual(pickStatus(await getConfigStatus(fixture.paths())), { installed: false, healthy: true, status: "deactivated" });
      const paused = await readFile(fixture.configPath, "utf8");
      assert.match(paused, /model_providers.model_bridge/u);
      assert.match(paused, /127\.0\.0\.1:0\/v1/u);
      assert.doesNotMatch(paused, /openai_base_url|model_provider =|model_catalog_json|lm-studio-model-router:p2/u);
      assert.equal((await getConfigStatus(fixture.paths())).recoveryRequired, false);
      const pausedState = JSON.parse(await readFile(fixture.statePath));
      assert.equal(pausedState.suspension.kind, "integration-toggle-v1");
      assert.equal(pausedState.backupPath, baseline.backupPath);
      assert.equal(pausedState.sourceSha256, baseline.sourceSha256);
      assert.deepEqual(await readFile(baseline.backupPath), backup);
      const next = await previewConfigIntegration(fixture.paths());
      assert.equal(next.status, "none");
      assert.equal(next.canApply, true);
      assert.ok(next.changes.includes("reactivate-integration"));
      await assert.rejects(inventoryDeactivatedConfigReactivation({ ...fixture.paths(), expectedPreviewToken: "0".repeat(64) }), { code: "INTEGRATION_PREVIEW_CHANGED" });
      await assert.rejects(inventoryManagedConfigReactivation(fixture.paths()), { code: "CONFIGURATION_SUSPENDED" });
      await assert.rejects(suspendManagedConfiguration(fixture.paths()), { code: "CONFIGURATION_SUSPENDED" });
      const receipt = await inventoryDeactivatedConfigReactivation({ ...fixture.paths(), expectedPreviewToken: next.previewToken });
      const changedProvider = { ...options.provider, baseUrl: "http://127.0.0.1:1234/rotated/v1" };
      await assert.rejects(installConfig({ ...options, integrationSwitchReceipt: undefined, provider: changedProvider, reactivationReceipt: receipt }), { code: "STATE_PROVIDER_MISMATCH" });
      const installed = await installConfig({ ...options, integrationSwitchReceipt: undefined, reactivationReceipt: receipt });
      assert.equal((await getConfigStatus(fixture.paths())).installed, true);
      await installed.rollback();
      assert.equal(await readFile(fixture.configPath, "utf8"), paused);
      const retry = await inventoryDeactivatedConfigReactivation(fixture.paths());
      await installConfig({ ...options, integrationSwitchReceipt: undefined, reactivationReceipt: retry });
      await uninstallConfig(fixture.paths());
      if (original === undefined) await assert.rejects(readFile(fixture.configPath), { code: "ENOENT" });
      else assert.equal(await readFile(fixture.configPath, "utf8"), original);
    });
  }
});

test("deactivation preserves edits outside owned blocks during reactivation and direct uninstall", async (t) => {
  for (const reactivate of [false, true]) {
    const fixture = await makeFixture(t);
    const original = 'model = "gpt-5.6-sol"\n[features]\nother = true\n';
    await writeFile(fixture.configPath, original);
    const options = fixture.options();
    options.modelProvider = options.provider.id = "model_bridge";
    await installConfig(options);
    await writeFile(fixture.configPath, `${await readFile(fixture.configPath, "utf8")}user_added = true\n`);
    await deactivateManagedConfiguration(fixture.paths());
    if (reactivate) await installConfig({ ...options, reactivationReceipt: await inventoryDeactivatedConfigReactivation(fixture.paths()) });
    await uninstallConfig(fixture.paths());
    assert.equal(await readFile(fixture.configPath, "utf8"), `${original}user_added = true\n`);
  }
});

test("native uninstall resets recorded picker fields for active and OFF baselines without restoring Ollama", async (t) => {
  const baselines = [undefined, 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "ultra"\n', [
    'model = "previous-external-model"', 'model_provider = "openai"',
    'model_catalog_json = "/private/fixture/ollama-launch-models.json"',
    'openai_base_url = "http://127.0.0.1:11434/api/codex/v1"', 'model_reasoning_effort = "low"', "",
  ].join("\n")];
  for (const [index, baseline] of baselines.entries()) {
    for (const off of [false, true]) {
      await t.test(`baseline ${index}, ${off ? "OFF" : "active"}`, async (subtest) => {
        const fixture = await makeFixture(subtest);
        const preserved = 'user_setting = true\nprompt = """\nmodel_catalog_json = "string-only"\n"""\n[features]\nother = true\n';
        if (baseline !== undefined) await writeFile(fixture.configPath, baseline + preserved);
        const options = fixture.options();
        options.modelProvider = options.provider.id = "model_bridge";
        const preview = await previewConfigIntegration(fixture.paths());
        if (["ollama", "foreign"].includes(preview.status)) options.integrationSwitchReceipt = await inventoryConfigIntegrationSwitch({ ...fixture.paths(), expectedPreviewToken: preview.previewToken });
        await installConfig(options);
        await writeFile(fixture.configPath, `${await readFile(fixture.configPath, "utf8")}# contributor edit\n`);
        if (off) await deactivateManagedConfiguration(fixture.paths());
        const beforeConfig = await snapshotFile(fixture.configPath);
        const beforeState = await snapshotFile(fixture.statePath);
        const receipt = await inventoryNativeConfigRestoration(fixture.paths());
        assert.match(receipt.previewToken, /^[a-f0-9]{64}$/u);
        assert.deepEqual(await snapshotFile(fixture.configPath), beforeConfig);
        assert.deepEqual(await snapshotFile(fixture.statePath), beforeState);
        await revalidateNativeConfigRestoration(receipt);
        const result = await uninstallConfig({ ...fixture.paths(), restoreNative: true, nativeRestorationReceipt: receipt });
        assert.equal(result.nativeRestored, true);
        assert.equal(result.historicalCompatibility, true);
        const restored = await readFile(fixture.configPath, "utf8");
        assert.match(restored, /# contributor edit/u);
        if (baseline !== undefined) assert.ok(restored.includes(preserved));
        const outsidePrompt = restored.replace(/prompt = """[\s\S]*?"""\n/u, "");
        assert.doesNotMatch(outsidePrompt, /^\s*(?:model|model_provider|model_catalog_json|model_reasoning_effort|openai_base_url)\s*=/mu);
        assert.match(restored, /base_url = "http:\/\/127\.0\.0\.1:0\/v1"/u);
        await assert.rejects(readFile(fixture.statePath), { code: "ENOENT" });
      });
    }
  }
});

test("native uninstall preserves table scope, quoted data and CRLF user bytes", async (t) => {
  const fixture = await makeFixture(t);
  const user = ['# operator comment', '[model_providers.foreign]', 'name = "Operator"', 'model_catalog_json = "table-only"', ""].join("\r\n");
  await writeFile(fixture.configPath, `"model" = "gpt-5.6-sol"\r\n${user}`);
  const options = fixture.options();
  options.modelProvider = options.provider.id = "model_bridge";
  await installConfig(options);
  await uninstallConfig({ ...fixture.paths(), restoreNative: true });
  const restored = await readFile(fixture.configPath, "utf8");
  assert.ok(restored.includes(user));
  assert.doesNotMatch(restored, /(?<!\r)\n/u);
});

test("native uninstall refuses unowned profile and picker roots before changing configuration", async (t) => {
  for (const assignment of [
    'profile = "foreign"', '"profile" = "foreign"', 'model_catalog_json = "/foreign.json"',
    '"model_catalog_json" = "/foreign.json"', 'model_catalog_json.extra = "foreign"',
    'openai_base_url = "http://127.0.0.1:4567/v1"', 'model_provider = "foreign"',
    'model = "unowned-native-choice"', 'model_reasoning_effort = "high"',
  ]) {
    const fixture = await makeFixture(t);
    const options = fixture.options();
    options.modelProvider = options.provider.id = "model_bridge";
    await installConfig(options);
    const edited = (await readFile(fixture.configPath, "utf8")).replace(CONFIG_MARKERS.rootBegin, `${assignment}\n${CONFIG_MARKERS.rootBegin}`);
    await writeFile(fixture.configPath, edited);
    await assert.rejects(inventoryNativeConfigRestoration(fixture.paths()));
    await assert.rejects(uninstallConfig({ ...fixture.paths(), restoreNative: true }));
    assert.equal(await readFile(fixture.configPath, "utf8"), edited);
  }
});

test("native restoration rejects stale config, state and backup proofs without overwriting edits", async (t) => {
  for (const changed of ["config", "state", "backup"]) {
    const fixture = await makeFixture(t);
    const options = fixture.options();
    options.modelProvider = options.provider.id = "model_bridge";
    await installConfig(options);
    const receipt = await inventoryNativeConfigRestoration(fixture.paths());
    const state = JSON.parse(await readFile(fixture.statePath));
    const target = changed === "config" ? fixture.configPath : changed === "state" ? fixture.statePath : state.backupPath;
    await writeFile(target, `${await readFile(target, "utf8")}\n`);
    const before = await readFile(fixture.configPath);
    await assert.rejects(uninstallConfig({ ...fixture.paths(), restoreNative: true, nativeRestorationReceipt: receipt }));
    assert.deepEqual(await readFile(fixture.configPath), before);
  }
});

test("native restoration rejects forged receipts, wrong intent, recovery suspension and force", async (t) => {
  const fixture = await makeFixture(t);
  const options = fixture.options();
  options.modelProvider = options.provider.id = "model_bridge";
  await installConfig(options);
  const before = await readFile(fixture.configPath);
  await assert.rejects(uninstallConfig({ ...fixture.paths(), restoreNative: true, nativeRestorationReceipt: { previewToken: "a".repeat(64) } }), { code: "UNINSTALL_CONFLICT" });
  await assert.rejects(inventoryNativeConfigRestoration({ ...fixture.paths(), expectedPreviewToken: "0".repeat(64) }), { code: "UNINSTALL_CONFLICT" });
  await assert.rejects(uninstallConfig({ ...fixture.paths(), restoreNative: true, force: true }), { code: "UNINSTALL_CONFLICT" });
  assert.deepEqual(await readFile(fixture.configPath), before);
  await suspendManagedConfiguration(fixture.paths());
  await assert.rejects(inventoryNativeConfigRestoration(fixture.paths()), { code: "UNINSTALL_CONFLICT" });
});

test("native restoration rolls back exact active and OFF bytes when state removal fails", async (t) => {
  for (const off of [false, true]) {
    const fixture = await makeFixture(t);
    const options = fixture.options();
    options.modelProvider = options.provider.id = "model_bridge";
    await installConfig(options);
    if (off) await deactivateManagedConfiguration(fixture.paths());
    const before = await readFile(fixture.configPath);
    const stateDirectory = join(fixture.directory, "state");
    await assert.rejects((async () => {
      try {
        await uninstallConfig({ ...fixture.paths(), restoreNative: true, beforeConfigCommit: () => chmod(stateDirectory, 0o500) });
      } finally { await chmod(stateDirectory, 0o700); }
    })(), { code: "STATE_REMOVE_FAILED" });
    assert.deepEqual(await readFile(fixture.configPath), before);
    await uninstallConfig({ ...fixture.paths(), restoreNative: true });
  }
});

test("deactivation rejects full-refresh collision, custom historical identity and concurrent changes", async (t) => {
  const fixture = await makeFixture(t);
  const options = fixture.options();
  await installConfig(options);
  const active = await readFile(fixture.configPath);
  await assert.rejects(deactivateManagedConfiguration(fixture.paths()), { code: "INTEGRATION_CONFLICT" });
  assert.deepEqual(await readFile(fixture.configPath), active);
  await suspendManagedConfiguration(fixture.paths());
  await assert.rejects(deactivateManagedConfiguration(fixture.paths()), { code: "CONFIGURATION_SUSPENDED" });
  await assert.rejects(inventoryDeactivatedConfigReactivation(fixture.paths()), { code: "CONFIGURATION_SUSPENDED" });
  const canonical = await makeFixture(t);
  const settings = canonical.options();
  settings.modelProvider = settings.provider.id = "model_bridge";
  await installConfig(settings);
  const pause = await deactivateManagedConfiguration(canonical.paths());
  const changed = `${await readFile(canonical.configPath, "utf8")}# contributor edit\n`;
  await writeFile(canonical.configPath, changed);
  await assert.rejects(pause.rollback(), { code: "CONFIG_CHANGED_CONCURRENTLY" });
  await assert.rejects(inventoryDeactivatedConfigReactivation(canonical.paths()), { code: "CONFIGURATION_SUSPENSION_CONFLICT" });
  assert.equal((await previewConfigIntegration(canonical.paths())).canApply, false);
  assert.equal(await readFile(canonical.configPath, "utf8"), changed);
});
