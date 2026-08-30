import assert from "node:assert/strict";
import {
  access,
  chmod,
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
  assert.equal(inventory.backups[0].snapshot.size, 8);
});

test("purges the exact validated backup directory through quarantine", async (t) => {
  const paths = await fixture(t, "success-");
  const first = backupName("2026-08-29T01-02-03-004Z");
  const second = backupName("2026-08-30T12-30-45-123Z", ".1");
  const unrelated = path.join(paths.installDirectory, "operator-state.json");
  await writeFile(path.join(paths.backupDirectory, first), "one\n");
  await writeFile(path.join(paths.backupDirectory, second), "two\n");
  await writeFile(unrelated, "preserve\n");
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
