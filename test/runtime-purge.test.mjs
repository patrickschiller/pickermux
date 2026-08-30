import assert from "node:assert/strict";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inventoryManagedServicePackage,
  removeInventoriedServicePackage,
  revalidateManagedServicePackageInventory,
} from "../src/runtime-purge.mjs";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function fixture(t, label) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), `pickermux-runtime-purge-${label}-`),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "distribution");
  const installDirectory = path.join(root, "model-bridge");
  const serviceDirectory = path.join(installDirectory, "runtime-app");
  await mkdir(path.join(sourceRoot, "bin"), { recursive: true, mode: 0o755 });
  await mkdir(path.join(sourceRoot, "src"), { mode: 0o755 });
  await writeFile(path.join(sourceRoot, "bin", "pickermux.mjs"), "#!/usr/bin/env node\n", {
    mode: 0o755,
  });
  await writeFile(path.join(sourceRoot, "bin", "lmstudio-picker.mjs"), "export {};\n", {
    mode: 0o755,
  });
  await writeFile(path.join(sourceRoot, "src", "main.mjs"), "export const ok = true;\n", {
    mode: 0o644,
  });
  await writeFile(path.join(sourceRoot, "package.json"), "{\"name\":\"pickermux\"}\n", {
    mode: 0o644,
  });
  await writeFile(
    path.join(sourceRoot, "lmstudio-picker.config.json"),
    "{\"schemaVersion\":2}\n",
    { mode: 0o644 },
  );
  await mkdir(installDirectory, { mode: 0o700 });
  await cp(sourceRoot, serviceDirectory, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  await chmod(serviceDirectory, 0o700);
  return { root, sourceRoot, installDirectory, serviceDirectory };
}

test("removes a source-bound service package without recursive deletion", async (t) => {
  const paths = await fixture(t, "success");
  const inventory = await inventoryManagedServicePackage(paths);
  assert.equal(inventory.exists, true);
  assert.equal(
    inventory.runtime.entries.some((entry) => entry.path === "src/main.mjs"),
    true,
  );
  assert.deepEqual(await removeInventoriedServicePackage({ inventory }), {
    changed: true,
    cleanupPendingPath: null,
  });
  assert.equal(await exists(paths.serviceDirectory), false);
  assert.equal(await exists(paths.sourceRoot), true);
});

test("refuses modified or extended runtime packages before removal", async (t) => {
  await t.test("modified file", async (t) => {
    const paths = await fixture(t, "modified");
    await writeFile(
      path.join(paths.serviceDirectory, "src", "main.mjs"),
      "export const changed = true;\n",
    );
    await assert.rejects(
      inventoryManagedServicePackage(paths),
      /differs from its source/iu,
    );
    assert.equal(await exists(paths.serviceDirectory), true);
  });

  await t.test("unexpected nested file", async (t) => {
    const paths = await fixture(t, "unexpected");
    const foreign = path.join(paths.serviceDirectory, "src", "operator.txt");
    await writeFile(foreign, "preserve\n");
    await assert.rejects(
      inventoryManagedServicePackage(paths),
      /path set differs from its source/iu,
    );
    assert.equal(await readFile(foreign, "utf8"), "preserve\n");
  });
});

test("pure revalidation refuses runtime drift without removing it", async (t) => {
  const paths = await fixture(t, "revalidation-drift");
  const inventory = await inventoryManagedServicePackage(paths);
  const runtimeFile = path.join(paths.serviceDirectory, "src", "main.mjs");
  await writeFile(runtimeFile, "export const drifted = true;\n");
  await assert.rejects(
    revalidateManagedServicePackageInventory(inventory),
    /changed after inventory/iu,
  );
  assert.equal(
    await readFile(runtimeFile, "utf8"),
    "export const drifted = true;\n",
  );
});

test("refuses a runtime created after an absent inventory", async (t) => {
  const paths = await fixture(t, "absent-recreated");
  await rm(paths.serviceDirectory, { recursive: true });
  const inventory = await inventoryManagedServicePackage(paths);
  assert.equal(inventory.exists, false);
  await mkdir(paths.serviceDirectory, { mode: 0o700 });
  const foreign = path.join(paths.serviceDirectory, "foreign.txt");
  await writeFile(foreign, "preserve\n");
  await assert.rejects(
    removeInventoriedServicePackage({ inventory }),
    /changed after inventory|appeared after inventory/iu,
  );
  assert.equal(await readFile(foreign, "utf8"), "preserve\n");
});

test("retains quarantine when the original runtime path is recreated", async (t) => {
  const paths = await fixture(t, "original-recreated");
  const inventory = await inventoryManagedServicePackage(paths);
  const foreign = path.join(paths.serviceDirectory, "foreign.txt");
  let stagedPath;
  await assert.rejects(
    removeInventoriedServicePackage({
      inventory,
      renameImpl: async (source, destination) => {
        await rename(source, destination);
        if (source === paths.serviceDirectory) {
          stagedPath = destination;
          await mkdir(paths.serviceDirectory, { mode: 0o700 });
          await writeFile(foreign, "preserve\n");
        }
      },
    }),
    (error) => {
      assert.match(error.message, /rollback was incomplete/iu);
      assert.equal(error.cleanupPendingPath, stagedPath);
      return true;
    },
  );
  assert.equal(await readFile(foreign, "utf8"), "preserve\n");
  assert.equal(await exists(stagedPath), true);
});

test("requires an exact private model-bridge parent and runtime root", async (t) => {
  await t.test("symbolic-link parent", async (t) => {
    const paths = await fixture(t, "symlink-parent");
    const realParent = `${paths.installDirectory}-real`;
    await rename(paths.installDirectory, realParent);
    await symlink(realParent, paths.installDirectory, "dir");
    await assert.rejects(
      inventoryManagedServicePackage(paths),
      /parent must be a real directory/iu,
    );
  });

  await t.test("world-writable parent", async (t) => {
    const paths = await fixture(t, "writable-parent");
    await chmod(paths.installDirectory, 0o777);
    await assert.rejects(
      inventoryManagedServicePackage(paths),
      /parent permissions are not private/iu,
    );
  });

  await t.test("non-private runtime root", async (t) => {
    const paths = await fixture(t, "public-root");
    await chmod(paths.serviceDirectory, 0o755);
    await assert.rejects(
      inventoryManagedServicePackage(paths),
      /root permissions are not private/iu,
    );
  });
});

test("stops on concurrent additions and reports only its private quarantine", async (t) => {
  const paths = await fixture(t, "drift");
  const inventory = await inventoryManagedServicePackage(paths);
  let first = true;
  let pendingPath;
  await assert.rejects(
    removeInventoriedServicePackage({
      inventory,
      unlinkImpl: async (target) => {
        await unlink(target);
        if (first) {
          first = false;
          pendingPath = path.dirname(path.dirname(target));
          await writeFile(path.join(pendingPath, "foreign.txt"), "preserve\n");
        }
      },
    }),
    (error) => {
      assert.match(error.message, /quarantine pending/iu);
      assert.equal(error.cleanupPendingPath, pendingPath);
      return true;
    },
  );
  assert.equal(await exists(paths.serviceDirectory), false);
  assert.equal(await readFile(path.join(pendingPath, "foreign.txt"), "utf8"), "preserve\n");
});
