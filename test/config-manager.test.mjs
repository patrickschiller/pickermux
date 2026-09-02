import assert from "node:assert/strict";
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
  getConfigStatus,
  installConfig,
  inventoryManagedConfigOwnership,
  revalidateManagedConfigOwnership,
  restoreManagedPickerDefaults,
  restoreRecoveredProviderEndMarker,
  setManagedPickerSelection,
  uninstallConfig,
} from "../src/config-manager.mjs";

const FIXED_NOW = new Date("2026-08-28T12:34:56.789Z");

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
