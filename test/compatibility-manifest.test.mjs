import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CURRENT_BRIDGE_CONTRACT,
  checkCurrentCompatibility,
  createCompatibilityManifest,
  hashBundledCatalog,
  readCompatibilityManifest,
  writeCompatibilityManifest,
} from "../src/compatibility-manifest.mjs";

const bundledCatalog = {
  models: [
    {
      slug: "gpt-test",
      display_name: "GPT Test",
      supported_reasoning_levels: [{ effort: "low", description: "Low" }],
    },
  ],
};

test("bundled catalog fingerprint is canonical across object key order", () => {
  const reordered = {
    models: [
      {
        supported_reasoning_levels: [{ description: "Low", effort: "low" }],
        display_name: "GPT Test",
        slug: "gpt-test",
      },
    ],
  };
  assert.match(hashBundledCatalog(bundledCatalog), /^[0-9a-f]{64}$/u);
  assert.equal(hashBundledCatalog(reordered), hashBundledCatalog(bundledCatalog));
});

test("compatibility manifest is atomically replaced as a private file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-compatibility-manifest-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const manifestPath = path.join(root, "managed", "compatibility.json");
  const first = createCompatibilityManifest({
    codexClientVersion: "0.150.0",
    bundledCatalog,
  });
  await writeCompatibilityManifest(manifestPath, first);
  assert.deepEqual(await readCompatibilityManifest(manifestPath), first);
  assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);

  const second = createCompatibilityManifest({
    bridgeContract: "codex-responses-bridge/p4-v2",
    codexClientVersion: "0.151.0",
    bundledCatalog,
  });
  await writeCompatibilityManifest(manifestPath, second);
  assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), second);
  assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(path.dirname(manifestPath)), ["compatibility.json"]);
});

test("current compatibility reports compatible or exact update reasons", async () => {
  const current = createCompatibilityManifest({
    codexClientVersion: "0.150.0",
    bundledCatalog,
  });
  const compatible = await checkCurrentCompatibility({
    manifest: current,
    codexClientVersion: "0.150.0",
    bundledCatalog,
  });
  assert.equal(compatible.status, "compatible");
  assert.equal(compatible.compatible, true);
  assert.equal(compatible.updateRequired, false);
  assert.deepEqual(compatible.reasons, []);

  const changedCatalog = {
    models: [{ ...bundledCatalog.models[0], display_name: "Changed" }],
  };
  const update = await checkCurrentCompatibility({
    manifest: current,
    bridgeContract: "codex-responses-bridge/p4-v2",
    codexClientVersion: "0.151.0",
    bundledCatalog: changedCatalog,
  });
  assert.equal(update.status, "update-required");
  assert.equal(update.compatible, false);
  assert.equal(update.updateRequired, true);
  assert.deepEqual(update.reasons, [
    "bridge-contract",
    "codex-client-version",
    "bundled-catalog",
  ]);
  assert.equal(update.current.bridgeContract, CURRENT_BRIDGE_CONTRACT);
});

test("missing and malformed manifests require an update", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-compatibility-state-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const manifestPath = path.join(root, "compatibility.json");
  const base = {
    manifestPath,
    codexClientVersion: "0.150.0",
    bundledCatalog,
  };
  assert.deepEqual((await checkCurrentCompatibility(base)).reasons, ["manifest-missing"]);

  await writeFile(manifestPath, "not-json\n");
  const malformed = await checkCurrentCompatibility(base);
  assert.equal(malformed.status, "update-required");
  assert.deepEqual(malformed.reasons, ["manifest-invalid"]);

  const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
  await assert.rejects(
    checkCurrentCompatibility({
      ...base,
      readFileImpl: async () => {
        throw permissionError;
      },
    }),
    (error) => error === permissionError,
  );
});

test("manifest validation rejects an invalid schema and hash", async () => {
  await assert.rejects(
    writeCompatibilityManifest("/tmp/unused-compatibility.json", {
      schemaVersion: 2,
      bridgeContract: CURRENT_BRIDGE_CONTRACT,
      codexClientVersion: "0.150.0",
      bundledCatalogSha256: "not-a-hash",
    }),
    /unsupported compatibility manifest schema/iu,
  );
});
