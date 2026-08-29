import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cleanupManagedArtifacts,
  finalizeServicePackage,
  readOptionalPrivateFile,
  restorePrivateFile,
  restoreServicePackage,
  stageServicePackage,
  writeServiceConfig,
} from "../src/service-package.mjs";

test("stages a self-contained private runtime outside the source tree", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-service-package-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, "source");
  const install = path.join(root, "install");
  await mkdir(path.join(source, "bin"), { recursive: true });
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(path.join(source, "bin", "tool.mjs"), "#!/usr/bin/env node\n");
  await writeFile(path.join(source, "src", "main.mjs"), "export const ok = true;\n");
  await writeFile(path.join(source, "package.json"), '{"name":"pickermux","version":"0.4.0"}\n');
  await writeFile(path.join(source, "lmstudio-picker.config.json"), '{"schemaVersion":2}\n');

  const config = { schemaVersion: 2, bridge: { host: "127.0.0.1" }, providers: [] };
  const first = await stageServicePackage({ sourceRoot: source, installDirectory: install, config });
  assert.equal(await readFile(path.join(first.serviceDirectory, "src", "main.mjs"), "utf8"), "export const ok = true;\n");
  assert.equal(
    JSON.parse(await readFile(path.join(first.serviceDirectory, "package.json"), "utf8")).version,
    "0.4.0",
  );
  assert.equal(
    JSON.parse(await readFile(path.join(first.serviceDirectory, "lmstudio-picker.config.json"), "utf8")).schemaVersion,
    2,
  );
  assert.deepEqual(JSON.parse(await readFile(first.serviceConfigPath, "utf8")), config);
  assert.equal((await stat(first.serviceConfigPath)).mode & 0o777, 0o600);

  await writeFile(path.join(source, "src", "main.mjs"), "export const ok = 2;\n");
  const second = await stageServicePackage({ sourceRoot: source, installDirectory: install, config });
  assert.ok(second.previousPath);
  assert.equal(await readFile(path.join(second.serviceDirectory, "src", "main.mjs"), "utf8"), "export const ok = 2;\n");
  assert.equal(await readFile(path.join(second.previousPath, "src", "main.mjs"), "utf8"), "export const ok = true;\n");

  assert.deepEqual(await finalizeServicePackage(second), {
    removedPreviousPackage: true,
  });
  await assert.rejects(readFile(second.previousPath), /ENOENT|no such file/iu);
  assert.equal(
    await readFile(path.join(second.serviceDirectory, "src", "main.mjs"), "utf8"),
    "export const ok = 2;\n",
  );
  assert.deepEqual(await finalizeServicePackage(second), {
    removedPreviousPackage: false,
  });
});

test("finalization refuses non-managed rollback paths without deleting them", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-service-finalize-safety-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const serviceDirectory = path.join(root, "install", "runtime-app");
  const unrelated = path.join(root, "unrelated", "runtime-app.previous-1-12345678");
  const badSibling = path.join(root, "install", "some-other-directory");
  await mkdir(serviceDirectory, { recursive: true });
  await mkdir(unrelated, { recursive: true });
  await mkdir(badSibling, { recursive: true });
  await writeFile(path.join(unrelated, "sentinel.txt"), "keep\n");
  await writeFile(path.join(badSibling, "sentinel.txt"), "keep\n");

  await assert.rejects(
    finalizeServicePackage({ serviceDirectory, previousPath: unrelated }),
    /direct sibling/iu,
  );
  await assert.rejects(
    finalizeServicePackage({ serviceDirectory, previousPath: badSibling }),
    /managed runtime backup name/iu,
  );
  assert.equal(await readFile(path.join(unrelated, "sentinel.txt"), "utf8"), "keep\n");
  assert.equal(await readFile(path.join(badSibling, "sentinel.txt"), "utf8"), "keep\n");

  const validPrevious = path.join(root, "install", "runtime-app.previous-1-abcdef12");
  await mkdir(validPrevious);
  await writeFile(path.join(validPrevious, "sentinel.txt"), "keep\n");
  const { rm } = await import("node:fs/promises");
  await rm(serviceDirectory, { recursive: true });
  await assert.rejects(
    finalizeServicePackage({ serviceDirectory, previousPath: validPrevious }),
    /active service package is missing/iu,
  );
  assert.equal(await readFile(path.join(validPrevious, "sentinel.txt"), "utf8"), "keep\n");
});

test("service config replacement remains private", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-service-config-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const destination = path.join(root, "service-config.json");
  await writeServiceConfig(destination, { version: 1 });
  await writeServiceConfig(destination, { version: 2 });
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), { version: 2 });
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
});

test("failed private atomic replacement closes and removes its temporary file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-private-write-failure-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const destination = path.join(root, "service-config.json");
  await mkdir(destination);

  await assert.rejects(
    writeServiceConfig(destination, { version: 1 }),
    /EISDIR|ENOTEMPTY|directory/iu,
  );
  assert.deepEqual(await readdir(root), ["service-config.json"]);
});

test("private snapshots and staged runtime package can be rolled back exactly", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-service-rollback-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, "source");
  const install = path.join(root, "install");
  await mkdir(path.join(source, "bin"), { recursive: true });
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(path.join(source, "bin", "tool.mjs"), "#!/usr/bin/env node\n");
  await writeFile(path.join(source, "src", "main.mjs"), "export const version = 1;\n");
  await writeFile(path.join(source, "package.json"), '{"name":"pickermux","version":"0.4.0"}\n');
  await writeFile(path.join(source, "lmstudio-picker.config.json"), '{"schemaVersion":2}\n');
  const firstConfig = { version: 1 };
  await stageServicePackage({ sourceRoot: source, installDirectory: install, config: firstConfig });

  await writeFile(path.join(source, "src", "main.mjs"), "export const version = 2;\n");
  const second = await stageServicePackage({
    sourceRoot: source,
    installDirectory: install,
    config: { version: 2 },
  });
  assert.deepEqual(JSON.parse(second.previousServiceConfig.toString("utf8")), firstConfig);

  await restoreServicePackage({
    serviceDirectory: second.serviceDirectory,
    previousPath: second.previousPath,
    serviceConfigPath: second.serviceConfigPath,
    previousServiceConfig: second.previousServiceConfig,
  });
  assert.equal(
    await readFile(path.join(second.serviceDirectory, "src", "main.mjs"), "utf8"),
    "export const version = 1;\n",
  );
  assert.deepEqual(JSON.parse(await readFile(second.serviceConfigPath, "utf8")), firstConfig);

  const standalone = path.join(root, "standalone", "secret.txt");
  assert.equal(await readOptionalPrivateFile(standalone), null);
  await restorePrivateFile(standalone, Buffer.from("previous\n"));
  assert.equal((await stat(standalone)).mode & 0o777, 0o600);
  assert.equal((await readOptionalPrivateFile(standalone)).toString("utf8"), "previous\n");
  await restorePrivateFile(standalone, null);
  assert.equal(await readOptionalPrivateFile(standalone), null);
});

test("failed runtime copy removes its private staging directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-service-copy-failure-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, "source");
  const install = path.join(root, "install");
  await mkdir(path.join(source, "bin"), { recursive: true });
  await writeFile(path.join(source, "bin", "tool.mjs"), "#!/usr/bin/env node\n");

  await assert.rejects(
    stageServicePackage({ sourceRoot: source, installDirectory: install, config: {} }),
    /ENOENT|no such file/iu,
  );
  assert.deepEqual(await readdir(install), []);

  const existingRuntime = path.join(install, "runtime-app");
  await mkdir(existingRuntime, { recursive: true });
  await writeFile(path.join(existingRuntime, "sentinel.txt"), "keep me\n");
  await assert.rejects(
    stageServicePackage({ sourceRoot: source, installDirectory: install, config: {} }),
    /ENOENT|no such file/iu,
  );
  assert.equal(await readFile(path.join(existingRuntime, "sentinel.txt"), "utf8"), "keep me\n");
  assert.deepEqual(await readdir(install), ["runtime-app"]);
});

test("managed artifact cleanup is explicit, idempotent and leaves backups alone", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-service-cleanup-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const install = path.join(root, "install");
  const catalogPath = path.join(install, "models.json");
  const runtimePath = path.join(install, "runtime.json");
  const serviceDirectory = path.join(install, "runtime-app");
  const backupDirectory = path.join(install, "backups");
  const keychainSentinel = path.join(root, "keychain-is-not-a-file-cleanup-target.txt");
  await mkdir(serviceDirectory, { recursive: true });
  await mkdir(backupDirectory, { recursive: true });
  await writeFile(catalogPath, "{}\n");
  await writeFile(runtimePath, "{}\n");
  await writeFile(path.join(serviceDirectory, "runtime.mjs"), "export {};\n");
  await writeFile(path.join(backupDirectory, "config.toml"), "keep\n");
  await writeFile(keychainSentinel, "keep\n");

  const removed = await cleanupManagedArtifacts({
    managedFiles: [catalogPath, runtimePath, catalogPath],
    runtimeDirectories: [serviceDirectory, serviceDirectory],
  });
  assert.deepEqual(removed.removedFiles, [catalogPath, runtimePath]);
  assert.deepEqual(removed.removedRuntimeDirectories, [serviceDirectory]);
  await assert.rejects(readFile(catalogPath), /ENOENT|no such file/iu);
  await assert.rejects(readFile(path.join(serviceDirectory, "runtime.mjs")), /ENOENT|no such file/iu);
  assert.equal(await readFile(path.join(backupDirectory, "config.toml"), "utf8"), "keep\n");
  assert.equal(await readFile(keychainSentinel, "utf8"), "keep\n");

  assert.deepEqual(
    await cleanupManagedArtifacts({
      managedFiles: [catalogPath, runtimePath],
      runtimeDirectories: [serviceDirectory],
    }),
    { removedFiles: [], removedRuntimeDirectories: [] },
  );
});
