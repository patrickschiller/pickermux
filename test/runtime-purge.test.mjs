import assert from "node:assert/strict";
import {
  access,
  chmod,
  cp,
  link,
  lstat,
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

async function assertHardlinkPairUnchanged(left, right, expected) {
  const [leftContents, rightContents, leftStats, rightStats] = await Promise.all([
    readFile(left),
    readFile(right),
    lstat(left),
    lstat(right),
  ]);
  assert.deepEqual(leftContents, expected);
  assert.deepEqual(rightContents, expected);
  assert.equal(leftStats.dev, rightStats.dev);
  assert.equal(leftStats.ino, rightStats.ino);
  assert.equal(leftStats.nlink, 2);
  assert.equal(rightStats.nlink, 2);
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

test("requires an explicit final-removal option for receipt-bound sibling cleanup", async (t) => {
  const paths = await fixture(t, "sibling-cleanup");
  const metadataPath = path.join(paths.installDirectory, "state.json");
  await writeFile(metadataPath, '{"managed":true}\n', { mode: 0o600 });
  const inventory = await inventoryManagedServicePackage(paths);

  await unlink(metadataPath);

  await assert.rejects(
    revalidateManagedServicePackageInventory(inventory),
    /parent changed after inventory/iu,
  );
  await assert.rejects(
    removeInventoriedServicePackage({ inventory }),
    /parent changed after inventory/iu,
  );
  assert.equal(await exists(paths.serviceDirectory), true);

  assert.deepEqual(await removeInventoriedServicePackage({
    inventory,
    allowReceiptBoundParentTransitions: true,
  }), {
    changed: true,
    cleanupPendingPath: null,
  });
  assert.equal(await exists(paths.serviceDirectory), false);
});

test("rejects and preserves foreign parent entries added after inventory", async (t) => {
  const paths = await fixture(t, "foreign-sibling");
  const inventory = await inventoryManagedServicePackage(paths);
  const foreign = path.join(paths.installDirectory, "operator-notes.txt");
  await writeFile(foreign, "preserve\n", { mode: 0o600 });

  await assert.rejects(
    removeInventoriedServicePackage({
      inventory,
      allowReceiptBoundParentTransitions: true,
    }),
    /parent gained entries after inventory/iu,
  );
  assert.equal(await readFile(foreign, "utf8"), "preserve\n");
  assert.equal(await exists(paths.serviceDirectory), true);
});

test("accepts only inode-bound backup and registry quarantine transitions", async (t) => {
  const paths = await fixture(t, "receipt-quarantines");
  const backups = path.join(paths.installDirectory, "backups");
  const registry = path.join(paths.installDirectory, "keychain-state.json");
  await mkdir(backups, { mode: 0o700 });
  await writeFile(registry, '{"providerIds":[]}\n', { mode: 0o600 });
  const inventory = await inventoryManagedServicePackage(paths);
  const backupQuarantine = path.join(
    paths.installDirectory,
    `.backups.purge.${process.pid}.0123456789abcdef.staging`,
  );
  const registryQuarantine = path.join(
    paths.installDirectory,
    `.keychain-state.json.purge.${process.pid}.fedcba9876543210.staging`,
  );
  await rename(backups, backupQuarantine);
  await rename(registry, registryQuarantine);

  assert.deepEqual(await removeInventoriedServicePackage({
    inventory,
    allowReceiptBoundParentTransitions: true,
  }), {
    changed: true,
    cleanupPendingPath: null,
  });
  assert.equal(await exists(backupQuarantine), true);
  assert.equal(await readFile(registryQuarantine, "utf8"), '{"providerIds":[]}\n');
});

test("refuses a replacement model-bridge parent even when runtime bytes match", async (t) => {
  const paths = await fixture(t, "replaced-parent");
  const inventory = await inventoryManagedServicePackage(paths);
  const displacedParent = `${paths.installDirectory}-displaced`;
  await rename(paths.installDirectory, displacedParent);
  await mkdir(paths.installDirectory, { mode: 0o700 });
  await cp(
    path.join(displacedParent, "runtime-app"),
    paths.serviceDirectory,
    { recursive: true },
  );
  await chmod(paths.serviceDirectory, 0o700);

  await assert.rejects(
    removeInventoriedServicePackage({
      inventory,
      allowReceiptBoundParentTransitions: true,
    }),
    /parent changed after inventory/iu,
  );
  assert.equal(await exists(paths.serviceDirectory), true);
  assert.equal(
    await exists(path.join(displacedParent, "runtime-app")),
    true,
  );
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

test("refuses hard-linked package files without changing either link", async (t) => {
  await t.test("source payload before processing", async (t) => {
    const paths = await fixture(t, "hardlink-source");
    const sourceFile = path.join(paths.sourceRoot, "src", "main.mjs");
    const peer = path.join(paths.root, "source-peer.mjs");
    const expected = await readFile(sourceFile);
    await link(sourceFile, peer);

    await assert.rejects(
      inventoryManagedServicePackage(paths),
      /regular file with one filesystem link/iu,
    );

    await assertHardlinkPairUnchanged(sourceFile, peer, expected);
    assert.equal(await exists(paths.serviceDirectory), true);
  });

  await t.test("runtime revalidation before mutation", async (t) => {
    const paths = await fixture(t, "hardlink-runtime");
    const inventory = await inventoryManagedServicePackage(paths);
    const runtimeFile = path.join(paths.serviceDirectory, "src", "main.mjs");
    const peer = path.join(paths.root, "runtime-peer.mjs");
    const expected = await readFile(runtimeFile);
    await link(runtimeFile, peer);
    let renameCalls = 0;

    await assert.rejects(
      removeInventoriedServicePackage({
        inventory,
        renameImpl: async () => {
          renameCalls += 1;
        },
      }),
      /regular file with one filesystem link/iu,
    );

    assert.equal(renameCalls, 0);
    await assertHardlinkPairUnchanged(runtimeFile, peer, expected);
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
