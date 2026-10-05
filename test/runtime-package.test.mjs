import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { distributionDigest, setupManagedDistribution, validateDistributionInstallation } from "../src/distribution-installer.mjs";
import { resolveDistributionPaths } from "../src/paths.mjs";
import { inspectOptionalMlxRuntime } from "../src/runtime-package.mjs";
import { inventoryManagedServicePackage, removeInventoriedServicePackage, revalidateManagedServicePackageInventory } from "../src/runtime-purge.mjs";
import { stageServicePackage } from "../src/service-package.mjs";

const FILES = ["kolibri.py", "manage.py", "model_store.py", "server.py"];

async function fixture(t, { runtime = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pickermux-runtime-package-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  await fs.mkdir(path.join(source, "bin"), { recursive: true });
  await fs.mkdir(path.join(source, "src"));
  await fs.writeFile(path.join(source, "bin", "pickermux.mjs"), "export {};\n");
  await fs.writeFile(path.join(source, "src", "main.mjs"), "export {};\n");
  await fs.writeFile(path.join(source, "package.json"), '{"name":"pickermux","version":"0.4.0","type":"module"}\n');
  await fs.writeFile(path.join(source, "lmstudio-picker.config.json"), '{"schemaVersion":2}\n');
  await fs.writeFile(path.join(source, "LICENSE"), "MIT fixture\n");
  if (runtime) {
    await fs.mkdir(path.join(source, "runtime", "mlx"), { recursive: true });
    for (const name of FILES) await fs.writeFile(path.join(source, "runtime", "mlx", name), `# reviewed ${name}\n`);
  }
  const paths = resolveDistributionPaths({ HOME: path.join(directory, "home"), CODEX_HOME: path.join(directory, "codex-home") });
  return { directory, source, paths };
}

test("older distributions omit the optional runtime and retain their original digest", async (t) => {
  const f = await fixture(t, { runtime: false });
  assert.equal(await inspectOptionalMlxRuntime(f.source), null);
  assert.equal(await distributionDigest(f.source, { allowExtraRootEntries: true }), "6c8184e86da7d3192e660dd4e940cde3dd66640a316e74efea7814daba1a4a18");
  const installed = await setupManagedDistribution({ sourceRoot: f.source, paths: f.paths, activate: async () => ({ changed: true }) });
  assert.equal(installed.version, "0.4.0");
  const validated = await validateDistributionInstallation({ paths: f.paths });
  assert.equal(validated.installed, true);
  assert.equal(validated.receipt.versions[0].sha256, "6c8184e86da7d3192e660dd4e940cde3dd66640a316e74efea7814daba1a4a18");
});

test("distribution and service packaging retain exactly the reviewed runtime and support verified removal", async (t) => {
  const f = await fixture(t);
  const expected = FILES.map((name) => `runtime/mlx/${name}`);
  assert.deepEqual(await inspectOptionalMlxRuntime(f.source), expected);
  let installedSource;
  await setupManagedDistribution({ sourceRoot: f.source, paths: f.paths, activate: async ({ distributionRoot }) => {
    installedSource = distributionRoot;
    return { changed: true };
  } });
  assert.deepEqual(await inspectOptionalMlxRuntime(installedSource), expected);
  for (const name of FILES) {
    const installed = path.join(installedSource, "runtime", "mlx", name);
    assert.equal((await fs.lstat(installed)).mode & 0o777, 0o600);
    assert.equal(await fs.readFile(installed, "utf8"), `# reviewed ${name}\n`);
  }
  const installDirectory = path.join(f.directory, "model-bridge");
  const staged = await stageServicePackage({ sourceRoot: installedSource, installDirectory, config: { schemaVersion: 2 } });
  assert.deepEqual(await inspectOptionalMlxRuntime(staged.serviceDirectory), expected);
  const inventory = await inventoryManagedServicePackage({ serviceDirectory: staged.serviceDirectory, sourceRoot: installedSource });
  assert.equal(inventory.runtime.entries.filter((entry) => entry.path.startsWith("runtime/") && entry.type === "file").length, 4);
  assert.equal((await removeInventoriedServicePackage({ inventory })).changed, true);
  await assert.rejects(fs.lstat(staged.serviceDirectory), { code: "ENOENT" });
  assert.equal((await validateDistributionInstallation({ paths: f.paths })).installed, true);
});

test("unsafe runtime topology fails before distribution activation or service replacement", async (t) => {
  for (const [label, alter] of [
    ["missing file", async (f) => fs.unlink(path.join(f.source, "runtime", "mlx", "server.py"))],
    ["foreign runtime", async (f) => fs.mkdir(path.join(f.source, "runtime", "other"))],
    ["unknown file", async (f) => fs.writeFile(path.join(f.source, "runtime", "mlx", "weights.bin"), "keep")],
    ["directory instead of file", async (f) => {
      const target = path.join(f.source, "runtime", "mlx", "server.py");
      await fs.unlink(target);
      await fs.mkdir(target);
    }],
    ["linked file", async (f) => {
      const target = path.join(f.source, "runtime", "mlx", "server.py");
      await fs.unlink(target);
      await fs.symlink(path.join(f.source, "package.json"), target);
    }],
    ["linked directory", async (f) => {
      const target = path.join(f.source, "runtime", "mlx");
      await fs.rename(target, path.join(f.directory, "displaced"));
      await fs.symlink(path.join(f.directory, "displaced"), target);
    }],
    ["hard-linked file", async (f) => fs.link(path.join(f.source, "runtime", "mlx", "server.py"), path.join(f.directory, "other-link"))],
  ]) {
    await t.test(label, async (t) => {
      const f = await fixture(t);
      await alter(f);
      let activations = 0;
      await assert.rejects(setupManagedDistribution({ sourceRoot: f.source, paths: f.paths, activate: async () => { activations += 1; } }), /MLX runtime/u);
      assert.equal(activations, 0);
      const installDirectory = path.join(f.directory, "model-bridge");
      const active = path.join(installDirectory, "runtime-app");
      await fs.mkdir(active, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(active, "sentinel"), "previous good runtime");
      await assert.rejects(stageServicePackage({ sourceRoot: f.source, installDirectory, config: {} }), /MLX runtime/u);
      assert.equal(await fs.readFile(path.join(active, "sentinel"), "utf8"), "previous good runtime");
      assert.deepEqual(await fs.readdir(installDirectory), ["runtime-app"]);
    });
  }
});

test("runtime ownership is checked for every file without changing host ownership", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.source, "runtime", "mlx", "server.py");
  const ownerUid = (await fs.lstat(target)).uid;
  await assert.rejects(inspectOptionalMlxRuntime(f.source, { ownerUid, fsImpl: {
    ...fs,
    async lstat(value) {
      const stats = await fs.lstat(value);
      if (value === target) stats.uid = ownerUid + 1;
      return stats;
    },
  } }), /owned by the current user/u);
  assert.equal(await fs.readFile(target, "utf8"), "# reviewed server.py\n");
});

test("edited or unmanifested service runtime blocks removal and keeps all files", async (t) => {
  const f = await fixture(t);
  const installDirectory = path.join(f.directory, "model-bridge");
  const staged = await stageServicePackage({ sourceRoot: f.source, installDirectory, config: {} });
  const options = { serviceDirectory: staged.serviceDirectory, sourceRoot: f.source };
  const inventory = await inventoryManagedServicePackage(options);
  const target = path.join(staged.serviceDirectory, "runtime", "mlx", "server.py");
  await fs.writeFile(target, "# contributor edit\n");
  await assert.rejects(revalidateManagedServicePackageInventory(inventory), /changed|differs/u);
  await assert.rejects(removeInventoriedServicePackage({ inventory }), /changed|differs/u);
  assert.equal(await fs.readFile(target, "utf8"), "# contributor edit\n");
  await fs.writeFile(path.join(staged.serviceDirectory, "runtime", "mlx", "operator-note"), "keep");
  await assert.rejects(inventoryManagedServicePackage(options), /MLX runtime/u);
  assert.equal(await fs.readFile(path.join(staged.serviceDirectory, "runtime", "mlx", "operator-note"), "utf8"), "keep");
});
