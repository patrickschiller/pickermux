import assert from "node:assert/strict";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inventoryPickerMuxBackups,
  inventoryPickerMuxInstallDirectory,
  purgePickerMuxBackups,
  readInventoriedPickerMuxBackup,
  removeInventoriedRuntimeMetadata,
  revalidatePickerMuxBackupInventory,
} from "../src/purge-data.mjs";

async function fixture(t, label = "") {
  const root = await mkdtemp(
    path.join(os.tmpdir(), `pickermux-purge-data-${label}`),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = path.join(root, ".codex");
  const installDirectory = path.join(codexHome, "model-bridge");
  const backupDirectory = path.join(installDirectory, "backups");
  const configPath = path.join(codexHome, "config.toml");
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await chmod(installDirectory, 0o700);
  await chmod(backupDirectory, 0o700);
  return { root, codexHome, installDirectory, backupDirectory, configPath };
}

function backupName(timestamp, suffix = "") {
  return `config.toml.lm-studio-model-router.${timestamp}.bak${suffix}`;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("inventories only exact regular PickerMux backups in deterministic order", async (t) => {
  const paths = await fixture(t, "inventory-");
  const later = backupName("2026-08-30T12-30-45-123Z", ".9");
  const earlier = backupName("2026-08-29T01-02-03-004Z");
  await writeFile(path.join(paths.backupDirectory, later), "later\n", {
    mode: 0o640,
  });
  await writeFile(path.join(paths.backupDirectory, earlier), "earlier\n", {
    mode: 0o600,
  });

  const inventory = await inventoryPickerMuxBackups(paths);
  assert.equal(inventory.exists, true);
  assert.deepEqual(
    inventory.backups.map(({ name }) => name),
    [earlier, later],
  );
  assert.equal(inventory.backups[0].path, path.join(paths.backupDirectory, earlier));
  assert.equal(inventory.backups[0].snapshot.nlink, 1);
  assert.equal(inventory.backups[0].snapshot.size, 8);
  assert.match(inventory.backups[0].sha256, /^[0-9a-f]{64}$/u);
});

test("backup purge requires its issued hash and inode receipt", async (t) => {
  const paths = await fixture(t, "issued-receipt-");
  const name = backupName("2026-08-30T12-30-45-123Z");
  const target = path.join(paths.backupDirectory, name);
  await writeFile(target, "original\n", { mode: 0o600 });
  const inventory = await inventoryPickerMuxBackups(paths);

  await assert.rejects(
    purgePickerMuxBackups({
      ...paths,
      inventory: Object.freeze({ ...inventory }),
    }),
    /inventory issued by this module/iu,
  );
  assert.equal(await readFile(target, "utf8"), "original\n");

  await writeFile(target, "tampered\n", { mode: 0o600 });
  await assert.rejects(
    revalidatePickerMuxBackupInventory(inventory),
    /ownership state changed/iu,
  );
  assert.equal(await readFile(target, "utf8"), "tampered\n");
});

test("backup purge refuses byte-identical replacement with a new inode", async (t) => {
  const paths = await fixture(t, "inode-receipt-");
  const name = backupName("2026-08-30T12-30-45-123Z");
  const target = path.join(paths.backupDirectory, name);
  await writeFile(target, "backup\n", { mode: 0o600 });
  const inventory = await inventoryPickerMuxBackups(paths);
  const replacement = `${target}.replacement`;
  await writeFile(replacement, "backup\n", { mode: 0o600 });
  await rename(replacement, target);

  await assert.rejects(
    purgePickerMuxBackups({ ...paths, inventory }),
    /ownership state changed/iu,
  );
  assert.equal(await readFile(target, "utf8"), "backup\n");
});

test("backup purge rejects a hard link to auth.json before reading or mutating it", async (t) => {
  const paths = await fixture(t, "auth-hardlink-");
  const authPath = path.join(paths.codexHome, "auth.json");
  const backupPath = path.join(
    paths.backupDirectory,
    backupName("2026-08-30T12-30-45-123Z"),
  );
  await writeFile(authPath, "native-auth-sentinel\n", { mode: 0o600 });
  await link(authPath, backupPath);
  await chmod(authPath, 0o000);
  const authBefore = await lstat(authPath);
  const backupBefore = await lstat(backupPath);
  let beforeCommitCalls = 0;
  let renameCalls = 0;

  await assert.rejects(
    purgePickerMuxBackups({
      ...paths,
      beforeCommit: async () => {
        beforeCommitCalls += 1;
      },
      renameImpl: async (source, destination) => {
        renameCalls += 1;
        await rename(source, destination);
      },
    }),
    /managed file with multiple hard links/iu,
  );

  assert.equal(beforeCommitCalls, 0);
  assert.equal(renameCalls, 0);
  const authAfter = await lstat(authPath);
  const backupAfter = await lstat(backupPath);
  for (const key of ["dev", "ino", "mode", "nlink", "size", "mtimeMs"]) {
    assert.equal(authAfter[key], authBefore[key]);
    assert.equal(backupAfter[key], backupBefore[key]);
  }
  assert.equal(authAfter.ino, backupAfter.ino);
  assert.equal(authAfter.nlink, 2);
  await chmod(authPath, 0o600);
  assert.equal(await readFile(authPath, "utf8"), "native-auth-sentinel\n");
  assert.equal(await readFile(backupPath, "utf8"), "native-auth-sentinel\n");
});

test("inventoried backup reads reject hard-link count drift", async (t) => {
  const paths = await fixture(t, "backup-read-hardlink-");
  const backupPath = path.join(
    paths.backupDirectory,
    backupName("2026-08-30T12-30-45-123Z"),
  );
  const secondLink = path.join(paths.root, "backup-second-link");
  await writeFile(backupPath, "backup-sentinel\n", { mode: 0o600 });
  const inventory = await inventoryPickerMuxBackups(paths);
  await link(backupPath, secondLink);
  const backupBefore = await lstat(backupPath);
  const linkBefore = await lstat(secondLink);

  await assert.rejects(
    readInventoriedPickerMuxBackup({
      inventory,
      backupPath,
    }),
    /(?:multiple hard links|managed file changed)/iu,
  );

  const backupAfter = await lstat(backupPath);
  const linkAfter = await lstat(secondLink);
  for (const key of ["dev", "ino", "mode", "nlink", "size", "mtimeMs"]) {
    assert.equal(backupAfter[key], backupBefore[key]);
    assert.equal(linkAfter[key], linkBefore[key]);
  }
  assert.equal(backupAfter.ino, linkAfter.ino);
  assert.equal(backupAfter.nlink, 2);
  assert.equal(await readFile(backupPath, "utf8"), "backup-sentinel\n");
  assert.equal(await readFile(secondLink, "utf8"), "backup-sentinel\n");
});

test("backup purge rejects hard-link count drift before quarantine", async (t) => {
  const paths = await fixture(t, "backup-purge-hardlink-");
  const backupPath = path.join(
    paths.backupDirectory,
    backupName("2026-08-30T12-30-45-123Z"),
  );
  const secondLink = path.join(paths.root, "backup-second-link");
  await writeFile(backupPath, "backup-sentinel\n", { mode: 0o600 });
  const inventory = await inventoryPickerMuxBackups(paths);
  assert.equal(inventory.backups[0].snapshot.nlink, 1);
  await link(backupPath, secondLink);
  let renameCalls = 0;

  await assert.rejects(
    purgePickerMuxBackups({
      ...paths,
      inventory,
      renameImpl: async (source, destination) => {
        renameCalls += 1;
        await rename(source, destination);
      },
    }),
    /(?:multiple hard links|ownership state changed)/iu,
  );

  assert.equal(renameCalls, 0);
  const backupStats = await lstat(backupPath);
  const linkStats = await lstat(secondLink);
  assert.equal(backupStats.ino, linkStats.ino);
  assert.equal(backupStats.nlink, 2);
  assert.equal(linkStats.nlink, 2);
  assert.equal(await readFile(backupPath, "utf8"), "backup-sentinel\n");
  assert.equal(await readFile(secondLink, "utf8"), "backup-sentinel\n");
});

test("purges the exact validated backup directory through quarantine", async (t) => {
  const paths = await fixture(t, "success-");
  const first = backupName("2026-08-29T01-02-03-004Z");
  const second = backupName("2026-08-30T12-30-45-123Z", ".1");
  const unrelated = path.join(paths.installDirectory, "operator-state.json");
  await writeFile(path.join(paths.backupDirectory, first), "one\n");
  await writeFile(path.join(paths.backupDirectory, second), "two\n");
  await writeFile(unrelated, "preserve\n");
  const authPath = path.join(paths.codexHome, "auth.json");
  const cachePath = path.join(paths.codexHome, "models_cache.json");
  await writeFile(authPath, "native-auth-sentinel\n", { mode: 0o600 });
  await writeFile(cachePath, "native-cache-sentinel\n", { mode: 0o600 });
  await chmod(authPath, 0o000);
  const authBefore = await lstat(authPath);
  const cacheBefore = await lstat(cachePath);
  const unlinked = [];
  const removedDirectories = [];

  const result = await purgePickerMuxBackups({
    ...paths,
    unlinkImpl: async (target) => {
      unlinked.push(target);
      await unlink(target);
    },
    rmdirImpl: async (target) => {
      removedDirectories.push(target);
      await rmdir(target);
    },
  });
  assert.deepEqual(result, {
    changed: true,
    backupDirectory: paths.backupDirectory,
    backups: [first, second],
    cleanupPendingPath: null,
  });
  assert.equal(await exists(paths.backupDirectory), false);
  assert.equal(await readFile(unrelated, "utf8"), "preserve\n");
  assert.deepEqual((await readdir(paths.installDirectory)).sort(), [
    "operator-state.json",
  ]);
  assert.deepEqual(
    unlinked.map((target) => path.basename(target)),
    [first, second],
  );
  assert.equal(removedDirectories.length, 1);
  assert.match(
    path.basename(removedDirectories[0]),
    /^\.backups\.purge\.\d+\.[0-9a-f]{16}\.staging$/u,
  );
  const authAfter = await lstat(authPath);
  const cacheAfter = await lstat(cachePath);
  for (const key of ["dev", "ino", "mode", "size", "mtimeMs"]) {
    assert.equal(authAfter[key], authBefore[key]);
    assert.equal(cacheAfter[key], cacheBefore[key]);
  }
  await chmod(authPath, 0o600);
  assert.equal(await readFile(authPath, "utf8"), "native-auth-sentinel\n");
  assert.equal(await readFile(cachePath, "utf8"), "native-cache-sentinel\n");
});

test("missing backup directory is an idempotent no-op", async (t) => {
  const paths = await fixture(t, "missing-");
  await rm(paths.backupDirectory, { recursive: true });
  assert.deepEqual(await purgePickerMuxBackups(paths), {
    changed: false,
    backupDirectory: paths.backupDirectory,
    backups: [],
    cleanupPendingPath: null,
  });
});

test("backup inventory rejects unexpected entries without deleting anything", async (t) => {
  await t.test("unexpected filename", async (t) => {
    const paths = await fixture(t, "unexpected-");
    const foreign = path.join(paths.backupDirectory, "notes.txt");
    await writeFile(foreign, "keep\n");
    await assert.rejects(
      purgePickerMuxBackups(paths),
      /unexpected file: notes\.txt/iu,
    );
    assert.equal(await readFile(foreign, "utf8"), "keep\n");
  });

  await t.test("symbolic link", async (t) => {
    const paths = await fixture(t, "symlink-");
    const target = path.join(paths.root, "foreign.txt");
    const name = backupName("2026-08-30T12-30-45-123Z");
    await writeFile(target, "keep\n");
    await symlink(target, path.join(paths.backupDirectory, name));
    await assert.rejects(
      purgePickerMuxBackups(paths),
      /contains a symbolic link/iu,
    );
    assert.equal(await readFile(target, "utf8"), "keep\n");
  });

  await t.test("nested directory", async (t) => {
    const paths = await fixture(t, "nested-");
    const name = backupName("2026-08-30T12-30-45-123Z");
    await mkdir(path.join(paths.backupDirectory, name));
    await assert.rejects(
      purgePickerMuxBackups(paths),
      /contains a non-file entry/iu,
    );
    assert.equal(await exists(path.join(paths.backupDirectory, name)), true);
  });
});

test("backup purge rejects unsafe directory boundaries", async (t) => {
  await t.test("public backup directory", async (t) => {
    const paths = await fixture(t, "public-backups-");
    await chmod(paths.backupDirectory, 0o755);
    await assert.rejects(
      purgePickerMuxBackups(paths),
      /backup directory permissions are not private/iu,
    );
    assert.equal(await exists(paths.backupDirectory), true);
  });

  await t.test("public parent directory", async (t) => {
    const paths = await fixture(t, "public-parent-");
    await chmod(paths.installDirectory, 0o755);
    await assert.rejects(
      purgePickerMuxBackups(paths),
      /backup parent directory permissions are not private/iu,
    );
    assert.equal(await exists(paths.backupDirectory), true);
  });

  await t.test("non-exact directory name", async (t) => {
    const paths = await fixture(t, "wrong-name-");
    await assert.rejects(
      purgePickerMuxBackups({
        ...paths,
        backupDirectory: paths.installDirectory,
      }),
      /exact non-root backups directory/iu,
    );
    assert.equal(await exists(paths.backupDirectory), true);
  });

  await t.test("directory outside configPath managed state", async (t) => {
    const paths = await fixture(t, "wrong-owner-root-");
    const alternateDirectory = path.join(
      paths.root,
      "alternate",
      "model-bridge",
      "backups",
    );
    await mkdir(alternateDirectory, { recursive: true, mode: 0o700 });
    await chmod(path.dirname(alternateDirectory), 0o700);
    const name = backupName("2026-08-30T12-30-45-123Z");
    const foreign = path.join(alternateDirectory, name);
    await writeFile(foreign, "preserve\n", { mode: 0o600 });
    let beforeCommitCalls = 0;

    await assert.rejects(
      purgePickerMuxBackups({
        backupDirectory: alternateDirectory,
        configPath: paths.configPath,
        beforeCommit: async () => {
          beforeCommitCalls += 1;
        },
      }),
      /exact model-bridge\/backups directory beside configPath/iu,
    );
    assert.equal(beforeCommitCalls, 0);
    assert.equal(await readFile(foreign, "utf8"), "preserve\n");
  });

  await t.test("config directly inside filesystem root", async (t) => {
    const paths = await fixture(t, "root-config-");
    await assert.rejects(
      purgePickerMuxBackups({
        ...paths,
        configPath: path.join(path.parse(paths.root).root, "config.toml"),
      }),
      /configPath must not be directly inside a filesystem root/iu,
    );
    assert.equal(await exists(paths.backupDirectory), true);
  });
});

test("backup purge reports only its private quarantine when cleanup is partial", async (t) => {
  const paths = await fixture(t, "cleanup-");
  const name = backupName("2026-08-30T12-30-45-123Z");
  await writeFile(path.join(paths.backupDirectory, name), "backup\n");

  const result = await purgePickerMuxBackups({
    ...paths,
    unlinkImpl: async (target) => {
      await unlink(target);
      throw new Error("simulated cleanup failure");
    },
  });
  assert.equal(result.changed, true);
  assert.equal(await exists(paths.backupDirectory), false);
  assert.match(
    path.basename(result.cleanupPendingPath),
    /^\.backups\.purge\.\d+\.[0-9a-f]{16}\.staging$/u,
  );
  assert.equal(path.dirname(result.cleanupPendingPath), paths.installDirectory);
  assert.equal(await exists(result.cleanupPendingPath), true);
});

test("post-commit additions remain in quarantine without broad deletion", async (t) => {
  const paths = await fixture(t, "post-commit-drift-");
  const name = backupName("2026-08-30T12-30-45-123Z");
  await writeFile(path.join(paths.backupDirectory, name), "backup\n");
  let quarantinePath;

  const result = await purgePickerMuxBackups({
    ...paths,
    beforeCommit: async () => {
      const [quarantineName] = (await readdir(paths.installDirectory)).filter(
        (entry) => entry.endsWith(".staging"),
      );
      quarantinePath = path.join(paths.installDirectory, quarantineName);
      await writeFile(path.join(quarantinePath, "foreign.txt"), "preserve\n");
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.cleanupPendingPath, quarantinePath);
  assert.equal(await exists(paths.backupDirectory), false);
  assert.equal(
    await readFile(path.join(quarantinePath, name), "utf8"),
    "backup\n",
  );
  assert.equal(
    await readFile(path.join(quarantinePath, "foreign.txt"), "utf8"),
    "preserve\n",
  );
});

test("post-commit backup replacement remains in quarantine", async (t) => {
  const paths = await fixture(t, "post-commit-replacement-");
  const name = backupName("2026-08-30T12-30-45-123Z");
  await writeFile(path.join(paths.backupDirectory, name), "original\n");
  let quarantinePath;

  const result = await purgePickerMuxBackups({
    ...paths,
    beforeCommit: async () => {
      const [quarantineName] = (await readdir(paths.installDirectory)).filter(
        (entry) => entry.endsWith(".staging"),
      );
      quarantinePath = path.join(paths.installDirectory, quarantineName);
      await writeFile(path.join(quarantinePath, name), "replacement\n");
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.cleanupPendingPath, quarantinePath);
  assert.equal(
    await readFile(path.join(quarantinePath, name), "utf8"),
    "replacement\n",
  );
});

test("post-commit byte-identical backup replacement remains in quarantine", async (t) => {
  const paths = await fixture(t, "post-commit-inode-replacement-");
  const name = backupName("2026-08-30T12-30-45-123Z");
  await writeFile(path.join(paths.backupDirectory, name), "original\n");
  const inventory = await inventoryPickerMuxBackups(paths);
  let quarantinePath;

  const result = await purgePickerMuxBackups({
    ...paths,
    inventory,
    beforeCommit: async () => {
      const [quarantineName] = (await readdir(paths.installDirectory)).filter(
        (entry) => entry.endsWith(".staging"),
      );
      quarantinePath = path.join(paths.installDirectory, quarantineName);
      const target = path.join(quarantinePath, name);
      const replacement = `${target}.replacement`;
      await writeFile(replacement, "original\n", { mode: 0o600 });
      await rename(replacement, target);
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.cleanupPendingPath, quarantinePath);
  assert.equal(
    await readFile(path.join(quarantinePath, name), "utf8"),
    "original\n",
  );
});

test("rmdir drift is retained as cleanup-pending state", async (t) => {
  const paths = await fixture(t, "rmdir-drift-");
  const name = backupName("2026-08-30T12-30-45-123Z");
  await writeFile(path.join(paths.backupDirectory, name), "backup\n");
  let inserted;

  const result = await purgePickerMuxBackups({
    ...paths,
    rmdirImpl: async (quarantinePath) => {
      inserted = path.join(quarantinePath, "concurrent.txt");
      await writeFile(inserted, "preserve\n");
      await rmdir(quarantinePath);
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.cleanupPendingPath, path.dirname(inserted));
  assert.equal(await readFile(inserted, "utf8"), "preserve\n");
});

test("post-stage ownership changes roll the backup directory back", async (t) => {
  const paths = await fixture(t, "rollback-");
  const name = backupName("2026-08-30T12-30-45-123Z");
  await writeFile(path.join(paths.backupDirectory, name), "backup\n");
  let renameCalls = 0;

  await assert.rejects(
    purgePickerMuxBackups({
      ...paths,
      renameImpl: async (source, destination) => {
        renameCalls += 1;
        await rename(source, destination);
        if (renameCalls === 1) {
          await writeFile(path.join(destination, "concurrent.txt"), "keep\n");
        }
      },
    }),
    /unexpected file: concurrent\.txt/iu,
  );
  assert.equal(renameCalls, 2);
  assert.equal(
    await readFile(path.join(paths.backupDirectory, "concurrent.txt"), "utf8"),
    "keep\n",
  );
  assert.equal(
    await readFile(path.join(paths.backupDirectory, name), "utf8"),
    "backup\n",
  );
});

test("installation inventory accepts only known private managed entries", async (t) => {
  const paths = await fixture(t, "install-inventory-");
  const fileNames = [
    "bridge.log",
    "certifications.json",
    "compatibility.json",
    "keychain-state.json",
    "models.json",
    "runtime.json",
    "service-config.json",
    "state.json",
  ];
  for (const name of fileNames) {
    await writeFile(path.join(paths.installDirectory, name), `${name}\n`, {
      mode: 0o600,
    });
  }
  const directoryNames = [
    "runtime-app",
    "runtime-app.previous-1720000000000-deadbeef",
  ];
  for (const name of directoryNames) {
    await mkdir(path.join(paths.installDirectory, name), { mode: 0o700 });
  }

  const inventory = await inventoryPickerMuxInstallDirectory({
    installDirectory: paths.installDirectory,
  });
  assert.equal(inventory.exists, true);
  assert.deepEqual(
    inventory.entries.map(({ name }) => name),
    [...fileNames, "backups", ...directoryNames].sort(),
  );
});

test("runtime metadata removal uses the issued install hash and inode receipt", async (t) => {
  const paths = await fixture(t, "metadata-success-");
  const metadataNames = [
    "bridge.log",
    "certifications.json",
    "compatibility.json",
    "models.json",
    "runtime.json",
    "service-config.json",
  ];
  for (const name of [...metadataNames, "keychain-state.json", "state.json"]) {
    await writeFile(path.join(paths.installDirectory, name), `${name}\n`, {
      mode: 0o600,
    });
  }
  const inventory = await inventoryPickerMuxInstallDirectory({
    installDirectory: paths.installDirectory,
  });
  await assert.rejects(
    removeInventoriedRuntimeMetadata({
      inventory: Object.freeze({ ...inventory }),
    }),
    /installation inventory issued by this module/iu,
  );
  const unlinked = [];
  const result = await removeInventoriedRuntimeMetadata({
    inventory,
    unlinkImpl: async (target) => {
      unlinked.push(path.basename(target));
      await unlink(target);
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.cleanupPendingPath, null);
  assert.deepEqual(unlinked, metadataNames);
  for (const name of metadataNames) {
    assert.equal(await exists(path.join(paths.installDirectory, name)), false);
  }
  assert.equal(
    await readFile(path.join(paths.installDirectory, "keychain-state.json"), "utf8"),
    "keychain-state.json\n",
  );
  assert.equal(
    await readFile(path.join(paths.installDirectory, "state.json"), "utf8"),
    "state.json\n",
  );
  assert.equal(await exists(paths.backupDirectory), true);
});

test("runtime metadata removal refuses hash, inode, and appearance drift", async (t) => {
  await t.test("hash drift", async (t) => {
    const paths = await fixture(t, "metadata-hash-");
    const target = path.join(paths.installDirectory, "runtime.json");
    await writeFile(target, "original\n", { mode: 0o600 });
    const inventory = await inventoryPickerMuxInstallDirectory({
      installDirectory: paths.installDirectory,
    });
    await writeFile(target, "tampered\n", { mode: 0o600 });
    await assert.rejects(
      removeInventoriedRuntimeMetadata({ inventory }),
      /(?:runtime metadata|managed file) changed/iu,
    );
    assert.equal(await readFile(target, "utf8"), "tampered\n");
  });

  await t.test("byte-identical inode replacement", async (t) => {
    const paths = await fixture(t, "metadata-inode-");
    const target = path.join(paths.installDirectory, "models.json");
    await writeFile(target, "catalog\n", { mode: 0o600 });
    const inventory = await inventoryPickerMuxInstallDirectory({
      installDirectory: paths.installDirectory,
    });
    const replacement = `${target}.replacement`;
    await writeFile(replacement, "catalog\n", { mode: 0o600 });
    await rename(replacement, target);
    await assert.rejects(
      removeInventoriedRuntimeMetadata({ inventory }),
      /(?:runtime metadata|managed file) changed/iu,
    );
    assert.equal(await readFile(target, "utf8"), "catalog\n");
  });

  await t.test("new managed path", async (t) => {
    const paths = await fixture(t, "metadata-appeared-");
    const inventory = await inventoryPickerMuxInstallDirectory({
      installDirectory: paths.installDirectory,
    });
    const target = path.join(paths.installDirectory, "runtime.json");
    await writeFile(target, "foreign\n", { mode: 0o600 });
    await assert.rejects(
      removeInventoriedRuntimeMetadata({ inventory }),
      /appeared after inventory/iu,
    );
    assert.equal(await readFile(target, "utf8"), "foreign\n");
  });

  await t.test("hard-link count drift", async (t) => {
    const paths = await fixture(t, "metadata-hardlink-");
    const target = path.join(paths.installDirectory, "runtime.json");
    const secondLink = path.join(paths.root, "runtime-second-link.json");
    await writeFile(target, "runtime-sentinel\n", { mode: 0o600 });
    const inventory = await inventoryPickerMuxInstallDirectory({
      installDirectory: paths.installDirectory,
    });
    const runtimeEntry = inventory.entries.find(
      (entry) => entry.name === "runtime.json",
    );
    assert.equal(runtimeEntry.snapshot.nlink, 1);
    await link(target, secondLink);
    let renameCalls = 0;

    await assert.rejects(
      removeInventoriedRuntimeMetadata({
        inventory,
        renameImpl: async (source, destination) => {
          renameCalls += 1;
          await rename(source, destination);
        },
      }),
      /(?:multiple hard links|managed file changed)/iu,
    );

    assert.equal(renameCalls, 0);
    const targetStats = await lstat(target);
    const linkStats = await lstat(secondLink);
    assert.equal(targetStats.ino, linkStats.ino);
    assert.equal(targetStats.nlink, 2);
    assert.equal(linkStats.nlink, 2);
    assert.equal(await readFile(target, "utf8"), "runtime-sentinel\n");
    assert.equal(await readFile(secondLink, "utf8"), "runtime-sentinel\n");
  });
});

test("runtime metadata cleanup preserves additions made after quarantine", async (t) => {
  const paths = await fixture(t, "metadata-quarantine-addition-");
  const target = path.join(paths.installDirectory, "runtime.json");
  await writeFile(target, "runtime\n", { mode: 0o600 });
  const inventory = await inventoryPickerMuxInstallDirectory({
    installDirectory: paths.installDirectory,
  });
  let foreignPath;

  const result = await removeInventoriedRuntimeMetadata({
    inventory,
    unlinkImpl: async (stagedTarget) => {
      foreignPath = path.join(path.dirname(stagedTarget), "foreign.txt");
      await writeFile(foreignPath, "preserve\n", { mode: 0o600 });
      await unlink(stagedTarget);
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.cleanupPendingPath, path.dirname(foreignPath));
  assert.equal(await readFile(foreignPath, "utf8"), "preserve\n");
  assert.equal(await exists(target), false);
});

test("installation inventory fails closed on foreign or unsafe entries", async (t) => {
  await t.test("unexpected entry", async (t) => {
    const paths = await fixture(t, "install-unexpected-");
    const foreign = path.join(paths.installDirectory, "operator-notes.txt");
    await writeFile(foreign, "preserve\n", { mode: 0o600 });
    await assert.rejects(
      inventoryPickerMuxInstallDirectory({
        installDirectory: paths.installDirectory,
      }),
      /unexpected entry: operator-notes\.txt/iu,
    );
    assert.equal(await readFile(foreign, "utf8"), "preserve\n");
  });

  await t.test("symbolic link", async (t) => {
    const paths = await fixture(t, "install-symlink-");
    const target = path.join(paths.root, "foreign-runtime.json");
    await writeFile(target, "preserve\n", { mode: 0o600 });
    await symlink(target, path.join(paths.installDirectory, "runtime.json"));
    await assert.rejects(
      inventoryPickerMuxInstallDirectory({
        installDirectory: paths.installDirectory,
      }),
      /contains a symbolic link: runtime\.json/iu,
    );
    assert.equal(await readFile(target, "utf8"), "preserve\n");
  });

  await t.test("public managed file", async (t) => {
    const paths = await fixture(t, "install-public-file-");
    const managed = path.join(paths.installDirectory, "runtime.json");
    await writeFile(managed, "preserve\n", { mode: 0o644 });
    await assert.rejects(
      inventoryPickerMuxInstallDirectory({
        installDirectory: paths.installDirectory,
      }),
      /managed file permissions are not private: runtime\.json/iu,
    );
    assert.equal(await readFile(managed, "utf8"), "preserve\n");
  });

  await t.test("public install directory", async (t) => {
    const paths = await fixture(t, "install-public-root-");
    await chmod(paths.installDirectory, 0o755);
    await assert.rejects(
      inventoryPickerMuxInstallDirectory({
        installDirectory: paths.installDirectory,
      }),
      /installation directory permissions are not private/iu,
    );
    assert.equal(await exists(paths.installDirectory), true);
  });
});
