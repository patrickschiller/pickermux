import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { setupPickerMux } from "../src/cli.mjs";
import {
  compareVersions,
  managedLauncherContents,
  removeManagedDistribution,
  setupManagedDistribution,
  validateDistributionInstallation,
} from "../src/distribution-installer.mjs";
import {
  resolveDistributionPaths,
  resolveInstallPaths,
} from "../src/paths.mjs";

const execFileAsync = promisify(execFile);

async function temporaryFixture(t, version = "0.4.0", marker = "first") {
  const root = await mkdtemp(path.join(os.tmpdir(), "pickermux-installer-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const codexHome = path.join(root, "codex-home");
  const source = path.join(root, `source-${version}-${marker}`);
  await mkdir(path.join(source, "bin"), { recursive: true });
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(
    path.join(source, "bin", "pickermux.mjs"),
    `#!/usr/bin/env node\n// ${marker}\n`,
  );
  await writeFile(
    path.join(source, "bin", "lmstudio-picker.mjs"),
    `#!/usr/bin/env node\n// ${marker}\n`,
  );
  await writeFile(path.join(source, "src", "main.mjs"), `export const marker = ${JSON.stringify(marker)};\n`);
  await writeFile(
    path.join(source, "package.json"),
    `${JSON.stringify({ name: "pickermux", version, type: "module" }, null, 2)}\n`,
  );
  await writeFile(
    path.join(source, "lmstudio-picker.config.json"),
    `${JSON.stringify({ schemaVersion: 2, marker }, null, 2)}\n`,
  );
  await writeFile(path.join(source, "LICENSE"), `test license ${marker}\n`);
  await writeFile(
    path.join(source, "release-manifest.json"),
    `${JSON.stringify({ version, marker }, null, 2)}\n`,
  );
  const environment = { HOME: home, CODEX_HOME: codexHome };
  return {
    root,
    home,
    codexHome,
    source,
    environment,
    distributionPaths: resolveDistributionPaths(environment),
    installPaths: resolveInstallPaths(environment),
  };
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function removalStagingPath(paths) {
  const parent = path.dirname(paths.applicationDirectory);
  const matches = (await readdir(parent)).filter((name) =>
    /^\.PickerMux\.removal\.[1-9]\d*\.[0-9a-f]{16}\.staging$/u.test(name));
  assert.equal(matches.length, 1);
  return path.join(parent, matches[0]);
}

test("distribution paths honor isolated HOME and CODEX_HOME", async (t) => {
  const fixture = await temporaryFixture(t);
  assert.equal(
    fixture.distributionPaths.applicationDirectory,
    path.join(fixture.home, "Library", "Application Support", "PickerMux"),
  );
  assert.equal(
    fixture.distributionPaths.launcherPath,
    path.join(fixture.home, ".local", "bin", "pickermux"),
  );
  assert.equal(
    fixture.distributionPaths.installedConfigPath,
    path.join(fixture.codexHome, "model-bridge", "service-config.json"),
  );
  assert.equal(
    fixture.installPaths.launchAgentPath,
    path.join(fixture.home, "Library", "LaunchAgents", "com.local.codex-model-bridge.plist"),
  );
  assert.equal(
    fixture.installPaths.keychainRegistryPath,
    path.join(fixture.codexHome, "model-bridge", "keychain-state.json"),
  );
});

test("first setup creates a private version, atomic pointer, launcher, and receipt before activation", async (t) => {
  const fixture = await temporaryFixture(t);
  let activationInput;
  const result = await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    now: () => new Date("2026-08-29T10:00:00.000Z"),
    activate: async (input) => {
      activationInput = input;
      const duringActivation = await validateDistributionInstallation({
        paths: fixture.distributionPaths,
      });
      assert.equal(duringActivation.installed, true);
      assert.equal(duringActivation.receipt.activeVersion, "0.4.0");
      return { action: "install" };
    },
  });

  const versionRoot = path.join(fixture.distributionPaths.versionsDirectory, "0.4.0");
  assert.equal(result.version, "0.4.0");
  assert.equal(result.previousVersion, null);
  assert.equal(result.reused, false);
  assert.equal(result.activation.action, "install");
  assert.equal(activationInput.distributionRoot, versionRoot);
  assert.equal(
    activationInput.configPath,
    path.join(versionRoot, "lmstudio-picker.config.json"),
  );
  assert.equal(await readlink(fixture.distributionPaths.currentPath), "versions/0.4.0");
  assert.equal(
    await readFile(fixture.distributionPaths.launcherPath, "utf8"),
    managedLauncherContents(fixture.distributionPaths),
  );
  assert.match(
    await readFile(fixture.distributionPaths.launcherPath, "utf8"),
    /service-config\.json[\s\S]+lmstudio-picker\.config\.json/u,
  );
  assert.equal((await stat(fixture.distributionPaths.receiptPath)).mode & 0o777, 0o600);
  assert.equal((await stat(fixture.distributionPaths.launcherPath)).mode & 0o777, 0o700);
  assert.equal((await stat(versionRoot)).mode & 0o777, 0o700);
  assert.equal(
    (await stat(path.join(versionRoot, "package.json"))).mode & 0o777,
    0o600,
  );
  assert.equal(
    (await stat(path.join(versionRoot, "bin", "pickermux.mjs"))).mode & 0o777,
    0o700,
  );
});

test("a receipt left before lifecycle activation is safely reusable on rerun", async (t) => {
  const fixture = await temporaryFixture(t);
  const first = await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({ simulatedCrashBoundary: true }),
  });
  assert.equal(first.reused, false);

  let rerunCount = 0;
  const rerun = await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => {
      rerunCount += 1;
      return { action: "install-after-rerun" };
    },
  });
  assert.equal(rerun.reused, true);
  assert.equal(rerun.previousVersion, "0.4.0");
  assert.equal(rerunCount, 1);
  assert.equal(
    (await validateDistributionInstallation({ paths: fixture.distributionPaths })).receipt.activeVersion,
    "0.4.0",
  );
});

test("launcher preserves safe existing directory modes and selects the installed config with fallback", async (t) => {
  const fixture = await temporaryFixture(t);
  const localDirectory = path.join(fixture.home, ".local");
  await mkdir(fixture.distributionPaths.launcherDirectory, {
    recursive: true,
    mode: 0o750,
  });
  await chmod(localDirectory, 0o750);
  await chmod(fixture.distributionPaths.launcherDirectory, 0o750);
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({}),
  });
  assert.equal((await stat(localDirectory)).mode & 0o777, 0o750);
  assert.equal(
    (await stat(fixture.distributionPaths.launcherDirectory)).mode & 0o777,
    0o750,
  );

  const fakeBin = path.join(fixture.root, "fake-bin");
  const fakeNode = path.join(fakeBin, "node");
  await mkdir(fakeBin);
  await writeFile(
    fakeNode,
    '#!/bin/sh\nprintf \'%s\\n\' "$PICKERMUX_CONFIG_PATH"\n',
    { mode: 0o700 },
  );
  const environment = { ...process.env, PATH: fakeBin };
  const fallback = await execFileAsync(fixture.distributionPaths.launcherPath, [], {
    encoding: "utf8",
    env: environment,
  });
  assert.equal(
    fallback.stdout,
    `${path.join(fixture.distributionPaths.currentPath, "lmstudio-picker.config.json")}\n`,
  );

  await mkdir(path.dirname(fixture.distributionPaths.installedConfigPath), {
    recursive: true,
  });
  await writeFile(fixture.distributionPaths.installedConfigPath, "{}\n");
  const installed = await execFileAsync(fixture.distributionPaths.launcherPath, [], {
    encoding: "utf8",
    env: environment,
  });
  assert.equal(installed.stdout, `${fixture.distributionPaths.installedConfigPath}\n`);
});

test("failed upgrade restores the old pointer, launcher, receipt, and version set", async (t) => {
  const fixture = await temporaryFixture(t);
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    now: () => new Date("2026-08-29T10:00:00.000Z"),
    activate: async () => ({ action: "install" }),
  });
  const previousReceipt = await readFile(fixture.distributionPaths.receiptPath);
  const previousLauncher = await readFile(fixture.distributionPaths.launcherPath);

  const upgrade = await temporaryFixture(t, "0.5.0", "upgrade");
  await assert.rejects(
    setupManagedDistribution({
      sourceRoot: upgrade.source,
      paths: fixture.distributionPaths,
      activate: async () => {
        throw new Error("activation doctor failed");
      },
    }),
    /previous CLI activation was restored.*activation doctor failed/iu,
  );

  assert.equal(await readlink(fixture.distributionPaths.currentPath), "versions/0.4.0");
  assert.deepEqual(await readFile(fixture.distributionPaths.receiptPath), previousReceipt);
  assert.deepEqual(await readFile(fixture.distributionPaths.launcherPath), previousLauncher);
  assert.equal(
    await pathExists(path.join(fixture.distributionPaths.versionsDirectory, "0.5.0")),
    false,
  );
  assert.equal(
    (await validateDistributionInstallation({ paths: fixture.distributionPaths })).receipt.activeVersion,
    "0.4.0",
  );
});

test("first cache preflight leaves a real 0.4.1 installation byte-for-byte unchanged", async (t) => {
  const fixture = await temporaryFixture(t, "0.4.1", "installed");
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({ action: "install" }),
  });
  const previousReceipt = await readFile(fixture.distributionPaths.receiptPath);
  const previousLauncher = await readFile(fixture.distributionPaths.launcherPath);
  const previousCurrent = await readlink(fixture.distributionPaths.currentPath);
  const previousVersions = (await readdir(
    fixture.distributionPaths.versionsDirectory,
  )).sort();
  const upgrade = await temporaryFixture(t, "0.4.2", "upgrade");
  const upgradePath = path.join(
    fixture.distributionPaths.versionsDirectory,
    "0.4.2",
  );
  let cacheChecks = 0;
  let setupCalled = false;
  let activateCalled = false;
  let loadConfigCalled = false;
  let discoveryCalled = false;
  let refreshCalled = false;
  let stagedVersionObserved = false;

  await assert.rejects(
    setupPickerMux({
      sourceRoot: upgrade.source,
      paths: fixture.installPaths,
      distributionPaths: fixture.distributionPaths,
      codexPath: "/Applications/Test Codex.app/codex",
      configStatusImpl: async () => ({
        installed: true,
        healthy: true,
        status: "installed",
      }),
      desktopRunningImpl: async () => false,
      accountCacheImpl: async () => {
        cacheChecks += 1;
        stagedVersionObserved = await pathExists(upgradePath);
        const error = new Error("private cache version details");
        error.code = "CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED";
        error.codexClientVersion = "0.151.0";
        throw error;
      },
      loadConfigImpl: async () => {
        loadConfigCalled = true;
        return {};
      },
      discoverImpl: async () => {
        discoveryCalled = true;
        return { models: [{ id: "lmstudio/test" }] };
      },
      setupImpl: async (input) => {
        setupCalled = true;
        return setupManagedDistribution({
          ...input,
          activate: async (activationInput) => {
            activateCalled = true;
            return input.activate(activationInput);
          },
        });
      },
      refreshImpl: async () => {
        refreshCalled = true;
      },
    }),
    (error) => {
      assert.match(error.message, /stopped before activation/iu);
      assert.match(error.message, /No active PickerMux state was changed/iu);
      assert.doesNotMatch(error.message, /private cache version details/iu);
      return true;
    },
  );

  assert.equal(cacheChecks, 1);
  assert.equal(stagedVersionObserved, false);
  assert.equal(setupCalled, false);
  assert.equal(activateCalled, false);
  assert.equal(loadConfigCalled, false);
  assert.equal(discoveryCalled, false);
  assert.equal(refreshCalled, false);
  assert.deepEqual(await readFile(fixture.distributionPaths.receiptPath), previousReceipt);
  assert.deepEqual(await readFile(fixture.distributionPaths.launcherPath), previousLauncher);
  assert.equal(await readlink(fixture.distributionPaths.currentPath), previousCurrent);
  assert.deepEqual(
    (await readdir(fixture.distributionPaths.versionsDirectory)).sort(),
    previousVersions,
  );
  assert.equal(await pathExists(upgradePath), false);
  assert.equal(
    (await validateDistributionInstallation({
      paths: fixture.distributionPaths,
    })).receipt.activeVersion,
    "0.4.1",
  );
});

test("second cache preflight removes staged 0.4.2 and preserves 0.4.1 byte-for-byte", async (t) => {
  const fixture = await temporaryFixture(t, "0.4.1", "installed");
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({ action: "install" }),
  });
  const previousReceipt = await readFile(fixture.distributionPaths.receiptPath);
  const previousLauncher = await readFile(fixture.distributionPaths.launcherPath);
  const previousCurrent = await readlink(fixture.distributionPaths.currentPath);
  const previousVersions = (await readdir(
    fixture.distributionPaths.versionsDirectory,
  )).sort();
  const upgrade = await temporaryFixture(t, "0.4.2", "upgrade");
  const upgradePath = path.join(
    fixture.distributionPaths.versionsDirectory,
    "0.4.2",
  );
  let cacheChecks = 0;
  let setupCalled = false;
  let activateCalled = false;
  let loadConfigCalls = 0;
  let discoveryCalls = 0;
  let refreshCalled = false;
  let stagedVersionObserved = false;

  await assert.rejects(
    setupPickerMux({
      sourceRoot: upgrade.source,
      paths: fixture.installPaths,
      distributionPaths: fixture.distributionPaths,
      codexPath: "/Applications/Test Codex.app/codex",
      configStatusImpl: async () => ({
        installed: true,
        healthy: true,
        status: "installed",
      }),
      desktopRunningImpl: async () => false,
      accountCacheImpl: async () => {
        cacheChecks += 1;
        if (cacheChecks === 1) return { ready: true };
        stagedVersionObserved = await pathExists(upgradePath);
        const error = new Error("private cache version details");
        error.code = "CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED";
        error.codexClientVersion = "0.151.0";
        throw error;
      },
      loadConfigImpl: async () => {
        loadConfigCalls += 1;
        return {};
      },
      discoverImpl: async () => {
        discoveryCalls += 1;
        return { models: [{ id: "lmstudio/test" }] };
      },
      setupImpl: async (input) => {
        setupCalled = true;
        return setupManagedDistribution({
          ...input,
          activate: async (activationInput) => {
            activateCalled = true;
            return input.activate(activationInput);
          },
        });
      },
      refreshImpl: async () => {
        refreshCalled = true;
      },
    }),
    (error) => {
      assert.match(error.message, /stopped before activation/iu);
      assert.match(error.message, /No active PickerMux state was changed/iu);
      assert.doesNotMatch(error.message, /private cache version details/iu);
      return true;
    },
  );

  assert.equal(cacheChecks, 2);
  assert.equal(stagedVersionObserved, true);
  assert.equal(setupCalled, true);
  assert.equal(activateCalled, false);
  assert.equal(loadConfigCalls, 1);
  assert.equal(discoveryCalls, 1);
  assert.equal(refreshCalled, false);
  assert.deepEqual(await readFile(fixture.distributionPaths.receiptPath), previousReceipt);
  assert.deepEqual(await readFile(fixture.distributionPaths.launcherPath), previousLauncher);
  assert.equal(await readlink(fixture.distributionPaths.currentPath), previousCurrent);
  assert.deepEqual(
    (await readdir(fixture.distributionPaths.versionsDirectory)).sort(),
    previousVersions,
  );
  assert.equal(await pathExists(upgradePath), false);
  assert.equal(
    (await validateDistributionInstallation({
      paths: fixture.distributionPaths,
    })).receipt.activeVersion,
    "0.4.1",
  );
});

test("third cache preflight rolls a real 0.4.1 to 0.4.2 upgrade back byte-for-byte", async (t) => {
  const fixture = await temporaryFixture(t, "0.4.1", "installed");
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({ action: "install" }),
  });
  const previousReceipt = await readFile(fixture.distributionPaths.receiptPath);
  const previousLauncher = await readFile(fixture.distributionPaths.launcherPath);
  const previousCurrent = await readlink(fixture.distributionPaths.currentPath);
  const previousVersions = (await readdir(
    fixture.distributionPaths.versionsDirectory,
  )).sort();
  const upgrade = await temporaryFixture(t, "0.4.2", "upgrade");
  let cacheChecks = 0;
  let refreshCalled = false;

  await assert.rejects(
    setupPickerMux({
      sourceRoot: upgrade.source,
      paths: fixture.installPaths,
      distributionPaths: fixture.distributionPaths,
      codexPath: "/Applications/Test Codex.app/codex",
      configStatusImpl: async () => ({
        installed: true,
        healthy: true,
        status: "installed",
      }),
      desktopRunningImpl: async () => false,
      accountCacheImpl: async () => {
        cacheChecks += 1;
        if (cacheChecks < 3) return { ready: true };
        const error = new Error("private cache version details");
        error.code = "CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED";
        error.codexClientVersion = "0.151.0";
        throw error;
      },
      loadConfigImpl: async () => ({}),
      discoverImpl: async () => ({ models: [{ id: "lmstudio/test" }] }),
      refreshImpl: async () => {
        refreshCalled = true;
      },
    }),
    (error) => {
      assert.match(error.message, /previous CLI activation was restored/iu);
      assert.match(error.message, /stopped before activation/iu);
      assert.doesNotMatch(error.message, /private cache version details/iu);
      return true;
    },
  );

  assert.equal(cacheChecks, 3);
  assert.equal(refreshCalled, false);
  assert.deepEqual(await readFile(fixture.distributionPaths.receiptPath), previousReceipt);
  assert.deepEqual(await readFile(fixture.distributionPaths.launcherPath), previousLauncher);
  assert.equal(await readlink(fixture.distributionPaths.currentPath), previousCurrent);
  assert.deepEqual(
    (await readdir(fixture.distributionPaths.versionsDirectory)).sort(),
    previousVersions,
  );
  assert.equal(
    await pathExists(path.join(fixture.distributionPaths.versionsDirectory, "0.4.2")),
    false,
  );
  assert.equal(
    (await validateDistributionInstallation({
      paths: fixture.distributionPaths,
    })).receipt.activeVersion,
    "0.4.1",
  );
});

test("setup safely handles downgrades, foreign state, locks, and modified managed state", async (t) => {
  await t.test("downgrade", async (t) => {
    const fixture = await temporaryFixture(t, "0.5.0", "current");
    await setupManagedDistribution({
      sourceRoot: fixture.source,
      paths: fixture.distributionPaths,
      activate: async () => ({}),
    });
    const downgrade = await temporaryFixture(t, "0.4.0", "older");
    await assert.rejects(
      setupManagedDistribution({
        sourceRoot: downgrade.source,
        paths: fixture.distributionPaths,
        activate: async () => ({}),
      }),
      /refusing to downgrade.*0\.5\.0.*0\.4\.0/iu,
    );
  });

  await t.test("foreign launcher", async (t) => {
    const fixture = await temporaryFixture(t);
    await mkdir(fixture.distributionPaths.launcherDirectory, { recursive: true });
    await writeFile(fixture.distributionPaths.launcherPath, "foreign launcher\n");
    await assert.rejects(
      setupManagedDistribution({
        sourceRoot: fixture.source,
        paths: fixture.distributionPaths,
        activate: async () => ({}),
      }),
      /unmanaged launcher/iu,
    );
    assert.equal(await readFile(fixture.distributionPaths.launcherPath, "utf8"), "foreign launcher\n");
  });

  await t.test("concurrent lock", async (t) => {
    const fixture = await temporaryFixture(t);
    await mkdir(fixture.distributionPaths.applicationDirectory, {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(fixture.distributionPaths.lockPath, `${process.pid}\n`, { mode: 0o600 });
    await assert.rejects(
      setupManagedDistribution({
        sourceRoot: fixture.source,
        paths: fixture.distributionPaths,
        activate: async () => ({}),
      }),
      /another PickerMux setup or removal is in progress/iu,
    );
  });

  await t.test("stale private lock", async (t) => {
    const fixture = await temporaryFixture(t);
    await mkdir(fixture.distributionPaths.applicationDirectory, {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(fixture.distributionPaths.lockPath, "999999\n", { mode: 0o600 });
    let checkedPid;
    const result = await setupManagedDistribution({
      sourceRoot: fixture.source,
      paths: fixture.distributionPaths,
      processKillImpl(pid) {
        checkedPid = pid;
        const error = new Error("no such process");
        error.code = "ESRCH";
        throw error;
      },
      activate: async () => ({}),
    });
    assert.equal(checkedPid, 999999);
    assert.equal(result.version, "0.4.0");
  });

  await t.test("unsafe stale lock", async (t) => {
    const fixture = await temporaryFixture(t);
    await mkdir(fixture.distributionPaths.applicationDirectory, {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(fixture.distributionPaths.lockPath, "999999\n", { mode: 0o644 });
    await assert.rejects(
      setupManagedDistribution({
        sourceRoot: fixture.source,
        paths: fixture.distributionPaths,
        processKillImpl() {
          const error = new Error("no such process");
          error.code = "ESRCH";
          throw error;
        },
        activate: async () => ({}),
      }),
      /lock permissions are unsafe/iu,
    );
    assert.equal(await readFile(fixture.distributionPaths.lockPath, "utf8"), "999999\n");
  });

  await t.test("auth aliases are never processed as stale-lock payloads", async (t) => {
    const cases = [
      {
        name: "symbolic link",
        create: (source, destination) => symlink(source, destination),
        errorPattern: /setup lock.*not a regular file/iu,
        expectedLinks: 1,
      },
      {
        name: "hard link",
        create: (source, destination) => link(source, destination),
        errorPattern: /setup lock.*hard link/iu,
        expectedLinks: 2,
      },
    ];

    for (const entry of cases) {
      await t.test(entry.name, async (subtest) => {
        const fixture = await temporaryFixture(subtest, "0.4.0", entry.name);
        await mkdir(fixture.distributionPaths.applicationDirectory, {
          recursive: true,
          mode: 0o700,
        });
        await mkdir(fixture.codexHome, { recursive: true, mode: 0o700 });
        const authPath = path.join(fixture.codexHome, "auth.json");
        const authContents = Buffer.from("999999\n");
        await writeFile(authPath, authContents, { mode: 0o600 });
        await entry.create(authPath, fixture.distributionPaths.lockPath);
        const authBefore = await lstat(authPath);
        let processKillCalls = 0;

        await assert.rejects(
          setupManagedDistribution({
            sourceRoot: fixture.source,
            paths: fixture.distributionPaths,
            processKillImpl() {
              processKillCalls += 1;
            },
            activate: async () => ({}),
          }),
          entry.errorPattern,
        );

        assert.equal(processKillCalls, 0);
        assert.deepEqual(await readFile(authPath), authContents);
        const authAfter = await lstat(authPath);
        assert.equal(authAfter.dev, authBefore.dev);
        assert.equal(authAfter.ino, authBefore.ino);
        assert.equal(authAfter.nlink, entry.expectedLinks);
      });
    }
  });

  await t.test("modified launcher", async (t) => {
    const fixture = await temporaryFixture(t);
    await setupManagedDistribution({
      sourceRoot: fixture.source,
      paths: fixture.distributionPaths,
      activate: async () => ({}),
    });
    await writeFile(fixture.distributionPaths.launcherPath, "edited\n");
    await assert.rejects(
      setupManagedDistribution({
        sourceRoot: fixture.source,
        paths: fixture.distributionPaths,
        activate: async () => ({}),
      }),
      /launcher was modified/iu,
    );
    assert.equal(await readFile(fixture.distributionPaths.launcherPath, "utf8"), "edited\n");
  });

  await t.test("modified distribution", async (t) => {
    const fixture = await temporaryFixture(t);
    await setupManagedDistribution({
      sourceRoot: fixture.source,
      paths: fixture.distributionPaths,
      activate: async () => ({}),
    });
    const managedSource = path.join(
      fixture.distributionPaths.versionsDirectory,
      "0.4.0",
      "src",
      "main.mjs",
    );
    await chmod(managedSource, 0o600);
    await writeFile(managedSource, "export const edited = true;\n");
    await assert.rejects(
      validateDistributionInstallation({ paths: fixture.distributionPaths }),
      /distribution was modified/iu,
    );
  });

  await t.test("unsafe managed permissions", async (t) => {
    const fixture = await temporaryFixture(t);
    await setupManagedDistribution({
      sourceRoot: fixture.source,
      paths: fixture.distributionPaths,
      activate: async () => ({}),
    });
    const managedPackage = path.join(
      fixture.distributionPaths.versionsDirectory,
      "0.4.0",
      "package.json",
    );
    await chmod(managedPackage, 0o644);
    await assert.rejects(
      validateDistributionInstallation({ paths: fixture.distributionPaths }),
      /distribution permissions are not private/iu,
    );
  });
});

test("receipt-validated CLI removal preserves unrelated backups and state", async (t) => {
  const fixture = await temporaryFixture(t);
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({}),
  });
  const unrelated = path.join(fixture.distributionPaths.applicationDirectory, "operator-notes.txt");
  const backup = path.join(fixture.codexHome, "model-bridge", "backups", "config.toml");
  const keychainSentinel = path.join(fixture.root, "keychain-is-not-a-file-target.txt");
  await writeFile(unrelated, "keep\n");
  await mkdir(path.dirname(backup), { recursive: true });
  await writeFile(backup, "keep backup\n");
  await writeFile(keychainSentinel, "keep keychain\n");
  let beforeRemoveCalled = false;

  const removed = await removeManagedDistribution({
    paths: fixture.distributionPaths,
    beforeRemove: async () => {
      beforeRemoveCalled = true;
      return { integration: "removed" };
    },
  });
  assert.equal(beforeRemoveCalled, true);
  assert.deepEqual(removed.beforeResult, { integration: "removed" });
  assert.deepEqual(removed.removed.versions, ["0.4.0"]);
  assert.equal(await pathExists(fixture.distributionPaths.launcherPath), false);
  assert.equal(await pathExists(fixture.distributionPaths.currentPath), false);
  assert.equal(await pathExists(fixture.distributionPaths.receiptPath), false);
  assert.equal(await readFile(unrelated, "utf8"), "keep\n");
  assert.equal(await readFile(backup, "utf8"), "keep backup\n");
  assert.equal(await readFile(keychainSentinel, "utf8"), "keep keychain\n");
});

test("setup revalidates managed control state after staging a new version", async (t) => {
  const fixture = await temporaryFixture(t);
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({}),
  });
  const previousReceipt = await readFile(fixture.distributionPaths.receiptPath);
  const upgrade = await temporaryFixture(t, "0.5.0", "upgrade-race");

  await assert.rejects(
    setupManagedDistribution({
      sourceRoot: upgrade.source,
      paths: fixture.distributionPaths,
      beforeControlCommit: async () => {
        await writeFile(fixture.distributionPaths.launcherPath, "concurrent edit\n");
      },
      activate: async () => ({}),
    }),
    /launcher was modified|ownership state changed concurrently/iu,
  );

  assert.equal(
    await readFile(fixture.distributionPaths.launcherPath, "utf8"),
    "concurrent edit\n",
  );
  assert.deepEqual(
    await readFile(fixture.distributionPaths.receiptPath),
    previousReceipt,
  );
  assert.equal(
    await pathExists(path.join(fixture.distributionPaths.versionsDirectory, "0.5.0")),
    false,
  );
});

test("setup rehashes a newly staged version immediately before activation", async (t) => {
  const fixture = await temporaryFixture(t);
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({}),
  });
  const upgrade = await temporaryFixture(t, "0.5.0", "upgrade-digest-race");
  const stagedSource = path.join(
    fixture.distributionPaths.versionsDirectory,
    "0.5.0",
    "src",
    "main.mjs",
  );
  let activationCalled = false;

  await assert.rejects(
    setupManagedDistribution({
      sourceRoot: upgrade.source,
      paths: fixture.distributionPaths,
      beforeControlCommit: async () => {
        await writeFile(stagedSource, "export const concurrentEdit = true;\n");
      },
      activate: async () => {
        activationCalled = true;
      },
    }),
    /changed after staging; refusing to activate/iu,
  );

  assert.equal(activationCalled, false);
  assert.equal(await pathExists(path.dirname(path.dirname(stagedSource))), false);
  assert.equal(
    (await validateDistributionInstallation({ paths: fixture.distributionPaths })).receipt.activeVersion,
    "0.4.0",
  );
});

test("CLI removal restores its distribution when integration removal fails", async (t) => {
  const fixture = await temporaryFixture(t);
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({}),
  });
  const previousReceipt = await readFile(fixture.distributionPaths.receiptPath);
  const previousLauncher = await readFile(fixture.distributionPaths.launcherPath);

  await assert.rejects(
    removeManagedDistribution({
      paths: fixture.distributionPaths,
      beforeRemove: async () => {
        throw new Error("simulated integration failure");
      },
    }),
    /integration removal failed; the CLI distribution was restored/iu,
  );

  assert.deepEqual(await readFile(fixture.distributionPaths.receiptPath), previousReceipt);
  assert.deepEqual(await readFile(fixture.distributionPaths.launcherPath), previousLauncher);
  assert.equal(
    (await validateDistributionInstallation({ paths: fixture.distributionPaths })).installed,
    true,
  );
});

test("CLI removal preserves stable purge failures after a successful rollback", async (t) => {
  const cases = [
    {
      code: "PICKERMUX_CREDENTIAL_PURGE_INCOMPLETE",
      providerId: "beta",
      completedProviderIds: ["alpha"],
    },
    {
      code: "PICKERMUX_PURGE_COMMIT_INCOMPLETE",
      completedProviderIds: ["alpha", "beta"],
    },
    {
      code: "PICKERMUX_PURGE_INCOMPLETE",
      installDirectoryRemoved: false,
      cleanupPendingPath: "/private/pickermux/.cleanup.pending",
    },
  ];

  for (const expected of cases) {
    await t.test(expected.code, async (subtest) => {
      const fixture = await temporaryFixture(subtest, "0.4.2", expected.code);
      await setupManagedDistribution({
        sourceRoot: fixture.source,
        paths: fixture.distributionPaths,
        activate: async () => ({}),
      });
      const previousReceipt = await readFile(
        fixture.distributionPaths.receiptPath,
      );
      const previousLauncher = await readFile(
        fixture.distributionPaths.launcherPath,
      );

      await assert.rejects(
        removeManagedDistribution({
          paths: fixture.distributionPaths,
          beforeRemove: async () => {
            const error = new Error("sanitized purge failure");
            Object.assign(error, expected, { unsafeCredentialValue: "secret" });
            throw error;
          },
        }),
        (error) => {
          assert.equal(error.code, expected.code);
          assert.match(error.message, new RegExp(expected.code, "u"));
          assert.deepEqual(
            error.completedProviderIds,
            expected.completedProviderIds,
          );
          assert.equal(error.providerId, expected.providerId);
          assert.equal(
            error.installDirectoryRemoved,
            expected.installDirectoryRemoved,
          );
          assert.equal(
            error.cleanupPendingPath,
            expected.cleanupPendingPath,
          );
          assert.equal(error.unsafeCredentialValue, undefined);
          return true;
        },
      );

      assert.deepEqual(
        await readFile(fixture.distributionPaths.receiptPath),
        previousReceipt,
      );
      assert.deepEqual(
        await readFile(fixture.distributionPaths.launcherPath),
        previousLauncher,
      );
    });
  }
});

test("exclusive CLI removal rejects foreign application state before staging", async (t) => {
  const fixture = await temporaryFixture(t);
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({}),
  });
  const foreign = path.join(
    fixture.distributionPaths.applicationDirectory,
    "operator-notes.txt",
  );
  await writeFile(foreign, "preserve\n", { mode: 0o600 });
  let beforeRemoveCalled = false;

  await assert.rejects(
    removeManagedDistribution({
      paths: fixture.distributionPaths,
      requireExclusiveApplicationDirectory: true,
      beforeRemove: async () => {
        beforeRemoveCalled = true;
      },
    }),
    /full removal refuses unowned application state.*operator-notes\.txt/iu,
  );

  assert.equal(beforeRemoveCalled, false);
  assert.equal(await readFile(foreign, "utf8"), "preserve\n");
  assert.equal(
    (await validateDistributionInstallation({
      paths: fixture.distributionPaths,
    })).installed,
    true,
  );
});

test("CLI removal preserves application and versions paths created after staging", async (t) => {
  const fixture = await temporaryFixture(t);
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({}),
  });
  const foreignVersion = path.join(
    fixture.distributionPaths.versionsDirectory,
    "foreign.txt",
  );
  const foreignApplication = path.join(
    fixture.distributionPaths.applicationDirectory,
    "concurrent.txt",
  );

  const result = await removeManagedDistribution({
    paths: fixture.distributionPaths,
    requireExclusiveApplicationDirectory: true,
    beforeRemove: async () => {
      await mkdir(fixture.distributionPaths.versionsDirectory, {
        recursive: false,
        mode: 0o700,
      });
      await writeFile(foreignVersion, "preserve version\n", { mode: 0o600 });
      await writeFile(foreignApplication, "preserve application\n", {
        mode: 0o600,
      });
    },
  });

  assert.equal(result.removed.versionsDirectoryRemoved, false);
  assert.equal(result.removed.applicationDirectoryRemoved, false);
  assert.equal(await readFile(foreignVersion, "utf8"), "preserve version\n");
  assert.equal(
    await readFile(foreignApplication, "utf8"),
    "preserve application\n",
  );
});

test("distribution validation rejects hard-linked managed files before reading", async (t) => {
  const cases = [
    {
      name: "receipt",
      target: (fixture) => fixture.distributionPaths.receiptPath,
    },
    {
      name: "launcher",
      target: (fixture) => fixture.distributionPaths.launcherPath,
    },
    {
      name: "version file",
      target: (fixture) => path.join(
        fixture.distributionPaths.versionsDirectory,
        "0.4.0",
        "package.json",
      ),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const fixture = await temporaryFixture(subtest, "0.4.0", entry.name);
      await setupManagedDistribution({
        sourceRoot: fixture.source,
        paths: fixture.distributionPaths,
        activate: async () => ({}),
      });
      const authPath = path.join(fixture.codexHome, "auth.json");
      const authContents = Buffer.from("private auth sentinel\n");
      await mkdir(fixture.codexHome, { recursive: true, mode: 0o700 });
      await writeFile(authPath, authContents, { mode: 0o600 });
      const target = entry.target(fixture);
      await unlink(target);
      await link(authPath, target);
      const authBefore = await lstat(authPath);

      await assert.rejects(
        validateDistributionInstallation({ paths: fixture.distributionPaths }),
        /hard link/iu,
      );

      assert.deepEqual(await readFile(authPath), authContents);
      const authAfter = await lstat(authPath);
      assert.equal(authAfter.dev, authBefore.dev);
      assert.equal(authAfter.ino, authBefore.ino);
      assert.equal(authAfter.nlink, 2);
    });
  }
});

test("CLI removal never restores quarantine drift after integration failure", async (t) => {
  const fixture = await temporaryFixture(t);
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({}),
  });
  let staging;
  let changed;

  await assert.rejects(
    removeManagedDistribution({
      paths: fixture.distributionPaths,
      beforeRemove: async () => {
        staging = await removalStagingPath(fixture.distributionPaths);
        changed = path.join(
          staging,
          "versions",
          "0.4.0",
          "src",
          "main.mjs",
        );
        await writeFile(changed, "export const foreign = true;\n", {
          mode: 0o600,
        });
        throw new Error("simulated integration failure after drift");
      },
    }),
    (error) => {
      assert.match(error.message, /changed CLI quarantine was not restored/iu);
      assert.equal(error.cleanupPendingPath, staging);
      return true;
    },
  );

  assert.equal(await pathExists(fixture.distributionPaths.launcherPath), false);
  assert.equal(await pathExists(fixture.distributionPaths.currentPath), false);
  assert.equal(await pathExists(fixture.distributionPaths.receiptPath), false);
  assert.equal(await pathExists(fixture.distributionPaths.versionsDirectory), false);
  assert.equal(
    await readFile(changed, "utf8"),
    "export const foreign = true;\n",
  );
});

test("CLI removal rolls staged files back before mutating integration", async (t) => {
  const fixture = await temporaryFixture(t);
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({}),
  });
  let renameCalls = 0;
  let beforeRemoveCalled = false;

  await assert.rejects(
    removeManagedDistribution({
      paths: fixture.distributionPaths,
      renameImpl: async (source, destination) => {
        renameCalls += 1;
        if (renameCalls === 2) throw new Error("simulated staging failure");
        return rename(source, destination);
      },
      beforeRemove: async () => {
        beforeRemoveCalled = true;
      },
    }),
    /simulated staging failure/iu,
  );

  assert.equal(beforeRemoveCalled, false);
  assert.equal(
    (await validateDistributionInstallation({ paths: fixture.distributionPaths })).installed,
    true,
  );
});

test("partial CLI quarantine cleanup never fragments active state or blocks setup", async (t) => {
  const fixture = await temporaryFixture(t);
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({}),
  });
  let beforeRemoveCalled = false;

  const result = await removeManagedDistribution({
    paths: fixture.distributionPaths,
    beforeRemove: async () => {
      beforeRemoveCalled = true;
    },
    unlinkImpl: async (target) => {
      await unlink(target);
      throw new Error("simulated partial quarantine cleanup failure");
    },
  });

  assert.equal(beforeRemoveCalled, true);
  assert.equal(await pathExists(fixture.distributionPaths.launcherPath), false);
  assert.equal(await pathExists(fixture.distributionPaths.receiptPath), false);
  assert.equal(await pathExists(fixture.distributionPaths.applicationDirectory), false);
  assert.equal(await pathExists(result.removed.cleanupPendingPath), true);
  assert.equal(
    path.dirname(result.removed.cleanupPendingPath),
    path.dirname(fixture.distributionPaths.applicationDirectory),
  );

  const reinstalled = await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({ action: "reinstall" }),
  });
  assert.equal(reinstalled.version, "0.4.0");
  assert.equal(reinstalled.activation.action, "reinstall");
});

test("CLI removal preserves foreign state added after staging", async (t) => {
  const fixture = await temporaryFixture(t);
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({}),
  });
  let staging;
  let foreign;

  const result = await removeManagedDistribution({
    paths: fixture.distributionPaths,
    beforeRemove: async () => {
      staging = await removalStagingPath(fixture.distributionPaths);
      foreign = path.join(staging, "foreign.txt");
      await writeFile(foreign, "preserve\n", { mode: 0o600 });
    },
  });

  assert.equal(result.removed.cleanupPendingPath, staging);
  assert.equal(await readFile(foreign, "utf8"), "preserve\n");
  assert.equal(await pathExists(fixture.distributionPaths.launcherPath), false);
  assert.equal(await pathExists(fixture.distributionPaths.receiptPath), false);
});

test("CLI removal preserves a receipt-bound file replaced after staging", async (t) => {
  const fixture = await temporaryFixture(t);
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({}),
  });
  let staging;
  let replacement;

  const result = await removeManagedDistribution({
    paths: fixture.distributionPaths,
    beforeRemove: async () => {
      staging = await removalStagingPath(fixture.distributionPaths);
      replacement = path.join(staging, "replacement.mjs");
      const managed = path.join(
        staging,
        "versions",
        "0.4.0",
        "src",
        "main.mjs",
      );
      await writeFile(replacement, "export const replacement = true;\n", {
        mode: 0o600,
      });
      await rename(replacement, managed);
      replacement = managed;
    },
  });

  assert.equal(result.removed.cleanupPendingPath, staging);
  assert.equal(
    await readFile(replacement, "utf8"),
    "export const replacement = true;\n",
  );
});

test("CLI removal preserves additions made during exact cleanup", async (t) => {
  const fixture = await temporaryFixture(t);
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({}),
  });
  let staging;
  let foreign;
  let unlinkCalls = 0;

  const result = await removeManagedDistribution({
    paths: fixture.distributionPaths,
    beforeRemove: async () => {
      staging = await removalStagingPath(fixture.distributionPaths);
    },
    unlinkImpl: async (target) => {
      await unlink(target);
      unlinkCalls += 1;
      if (unlinkCalls === 1) {
        foreign = path.join(staging, "concurrent.txt");
        await writeFile(foreign, "preserve\n", { mode: 0o600 });
      }
    },
  });

  assert.ok(unlinkCalls > 1);
  assert.equal(result.removed.cleanupPendingPath, staging);
  assert.equal(await readFile(foreign, "utf8"), "preserve\n");
});

test("CLI removal fails hard when cleanup quarantine disappears", async (t) => {
  const fixture = await temporaryFixture(t);
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({}),
  });
  let staging;

  await assert.rejects(
    removeManagedDistribution({
      paths: fixture.distributionPaths,
      beforeRemove: async () => {
        staging = await removalStagingPath(fixture.distributionPaths);
      },
      unlinkImpl: async () => {
        await rm(staging, { recursive: true, force: false });
        throw new Error("simulated external quarantine removal");
      },
    }),
    /cleanup failed after its private quarantine disappeared/iu,
  );
  assert.equal(await pathExists(staging), false);
  assert.equal(await pathExists(fixture.distributionPaths.launcherPath), false);
});

test("CLI removal refuses modified ownership state before integration mutation", async (t) => {
  const fixture = await temporaryFixture(t);
  await setupManagedDistribution({
    sourceRoot: fixture.source,
    paths: fixture.distributionPaths,
    activate: async () => ({}),
  });
  await writeFile(fixture.distributionPaths.launcherPath, "foreign edit\n");
  let beforeRemoveCalled = false;
  await assert.rejects(
    removeManagedDistribution({
      paths: fixture.distributionPaths,
      beforeRemove: async () => {
        beforeRemoveCalled = true;
      },
    }),
    /launcher was modified/iu,
  );
  assert.equal(beforeRemoveCalled, false);
  assert.equal(await pathExists(fixture.distributionPaths.receiptPath), true);
});

test("setup orchestration preflights desktop, loaded LLM, config, and lifecycle action", async (t) => {
  const fixture = await temporaryFixture(t);
  const baseOptions = {
    sourceRoot: fixture.source,
    paths: fixture.installPaths,
    distributionPaths: fixture.distributionPaths,
    codexPath: "/Applications/Test Codex.app/codex",
    desktopRunningImpl: async () => false,
    accountCacheImpl: async () => ({
      ready: true,
      codexClientVersion: "0.151.0",
      cacheClientVersion: "0.151.0",
    }),
    discoverImpl: async () => ({ models: [{ id: "lmstudio/test" }] }),
  };

  await t.test("first install uses an explicit custom config", async () => {
    const customConfigPath = path.join(fixture.root, "custom-config.json");
    const loadedPaths = [];
    let installInput;
    const result = await setupPickerMux({
      ...baseOptions,
      setupConfigPath: customConfigPath,
      configStatusImpl: async () => ({
        installed: false,
        healthy: true,
        status: "not-installed",
      }),
      loadConfigImpl: async (configPath) => {
        loadedPaths.push(configPath);
        return { source: configPath };
      },
      setupImpl: async ({ activate }) => activate({
        distributionRoot: "/managed/versions/0.4.0",
        previousVersion: null,
        version: "0.4.0",
      }),
      installImpl: async (input) => {
        installInput = input;
        return { installed: true };
      },
    });
    assert.equal(result.action, "install");
    assert.deepEqual(loadedPaths, [customConfigPath, customConfigPath]);
    assert.equal(installInput.configPath, customConfigPath);
    assert.equal(installInput.sourceRoot, "/managed/versions/0.4.0");
  });

  await t.test("healthy upgrade reuses installed service config", async () => {
    const loadedPaths = [];
    let refreshInput;
    const result = await setupPickerMux({
      ...baseOptions,
      configStatusImpl: async () => ({
        installed: true,
        healthy: true,
        status: "installed",
      }),
      loadConfigImpl: async (configPath) => {
        loadedPaths.push(configPath);
        return { source: configPath };
      },
      setupImpl: async ({ activate }) => activate({
        distributionRoot: "/managed/versions/0.4.2",
        previousVersion: "0.4.1",
        version: "0.4.2",
      }),
      refreshImpl: async (input) => {
        refreshInput = input;
        return { refreshed: true };
      },
    });
    assert.equal(result.action, "upgrade");
    assert.deepEqual(loadedPaths, [
      fixture.installPaths.serviceConfigPath,
      fixture.installPaths.serviceConfigPath,
    ]);
    assert.equal(refreshInput.sourceRoot, "/managed/versions/0.4.2");
  });

  await t.test("running Codex blocks setup before distribution mutation", async () => {
    let setupCalled = false;
    await assert.rejects(
      setupPickerMux({
        ...baseOptions,
        configStatusImpl: async () => ({
          installed: false,
          healthy: true,
          status: "not-installed",
        }),
        desktopRunningImpl: async () => true,
        setupImpl: async () => {
          setupCalled = true;
        },
      }),
      /fully quit.*Command-Q/iu,
    );
    assert.equal(setupCalled, false);
  });

  await t.test("no loaded external LLM blocks setup before distribution mutation", async () => {
    let setupCalled = false;
    await assert.rejects(
      setupPickerMux({
        ...baseOptions,
        configStatusImpl: async () => ({
          installed: false,
          healthy: true,
          status: "not-installed",
        }),
        loadConfigImpl: async () => ({}),
        discoverImpl: async () => ({ models: [] }),
        setupImpl: async () => {
          setupCalled = true;
        },
      }),
      /at least one loaded external LLM/iu,
    );
    assert.equal(setupCalled, false);
  });

  await t.test("stale account cache blocks setup before distribution mutation", async () => {
    let setupCalled = false;
    let discoveryCalled = false;
    await assert.rejects(
      setupPickerMux({
        ...baseOptions,
        configStatusImpl: async () => ({
          installed: false,
          healthy: true,
          status: "not-installed",
        }),
        accountCacheImpl: async () => {
          const error = new Error("cache mismatch details must remain internal");
          error.code = "CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED";
          error.codexClientVersion = "0.151.0";
          throw error;
        },
        discoverImpl: async () => {
          discoveryCalled = true;
          return { models: [{ id: "lmstudio/test" }] };
        },
        setupImpl: async () => {
          setupCalled = true;
        },
      }),
      (error) => {
        assert.match(error.message, /stopped before activation/iu);
        assert.match(error.message, /No active PickerMux state was changed/iu);
        assert.match(error.message, /Codex 0\.151\.0/iu);
        assert.doesNotMatch(error.message, /internal/u);
        return true;
      },
    );
    assert.equal(discoveryCalled, false);
    assert.equal(setupCalled, false);
  });

  await t.test("cache is rechecked under the setup lock before control activation", async () => {
    let cacheChecks = 0;
    let activateCalled = false;
    await assert.rejects(
      setupPickerMux({
        ...baseOptions,
        configStatusImpl: async () => ({
          installed: false,
          healthy: true,
          status: "not-installed",
        }),
        accountCacheImpl: async () => {
          cacheChecks += 1;
          if (cacheChecks === 1) return { ready: true };
          const error = new Error("changed concurrently");
          error.code = "CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED";
          error.codexClientVersion = "0.151.0";
          throw error;
        },
        loadConfigImpl: async () => ({}),
        setupImpl: async ({ beforeControlCommit, activate }) => {
          await beforeControlCommit();
          activateCalled = true;
          return activate({
            distributionRoot: "/managed/versions/0.4.2",
            previousVersion: null,
            version: "0.4.2",
          });
        },
      }),
      /stopped before activation/iu,
    );
    assert.equal(cacheChecks, 2);
    assert.equal(activateCalled, false);
  });

  await t.test("Codex starting after preflight blocks lifecycle activation", async () => {
    let desktopChecks = 0;
    let installCalled = false;
    await assert.rejects(
      setupPickerMux({
        ...baseOptions,
        configStatusImpl: async () => ({
          installed: false,
          healthy: true,
          status: "not-installed",
        }),
        desktopRunningImpl: async () => {
          desktopChecks += 1;
          return desktopChecks > 1;
        },
        loadConfigImpl: async () => ({}),
        setupImpl: async ({ activate }) => activate({
          distributionRoot: "/managed/versions/0.4.2",
          previousVersion: null,
          version: "0.4.2",
        }),
        installImpl: async () => {
          installCalled = true;
        },
      }),
      /remain fully quit/iu,
    );
    assert.equal(installCalled, false);
  });

  await t.test("inconsistent integration blocks setup before other preflights", async () => {
    let desktopChecked = false;
    await assert.rejects(
      setupPickerMux({
        ...baseOptions,
        configStatusImpl: async () => ({
          installed: true,
          healthy: false,
          status: "modified",
        }),
        desktopRunningImpl: async () => {
          desktopChecked = true;
          return false;
        },
      }),
      /inconsistent integration state.*modified/iu,
    );
    assert.equal(desktopChecked, false);
  });
});

test("semantic version ordering rejects silent downgrade edge cases", () => {
  assert.equal(compareVersions("0.4.0", "0.4.0"), 0);
  assert.equal(compareVersions("0.5.0", "0.4.9"), 1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
});
