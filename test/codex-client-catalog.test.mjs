import assert from "node:assert/strict";
import test from "node:test";

import {
  loadBundledCatalog,
  loadCodexClientVersion,
} from "../src/catalog.mjs";

test("version and catalog defaults honor the shared executable override", async (t) => {
  const previous = process.env.CODEX_BINARY;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_BINARY;
    else process.env.CODEX_BINARY = previous;
  });
  process.env.CODEX_BINARY = "/test/Custom Codex.app/Contents/MacOS/codex";
  const catalog = { models: [{ slug: "gpt-test" }] };
  const calls = [];
  const execFileImpl = async (binary, args) => {
    calls.push({ binary, args });
    return {
      stdout: args[0] === "--version"
        ? "codex-cli 0.158.0-alpha.2.1\n"
        : JSON.stringify(catalog),
    };
  };

  assert.equal(await loadCodexClientVersion({ execFileImpl }), "0.158.0");
  assert.deepEqual(await loadBundledCatalog({ execFileImpl }), catalog);
  assert.deepEqual(calls, [
    { binary: process.env.CODEX_BINARY, args: ["--version"] },
    { binary: process.env.CODEX_BINARY, args: ["debug", "models", "--bundled"] },
  ]);

  const explicit = "/test/Explicit Codex.app/Contents/MacOS/codex";
  await loadCodexClientVersion({ codexPath: explicit, execFileImpl });
  await loadBundledCatalog({ codexPath: explicit, execFileImpl });
  assert.equal(calls[2].binary, explicit);
  assert.equal(calls[3].binary, explicit);
});

test("executable failures stay redacted and never retry another Codex client", async () => {
  const privateValue = "private-executable-error-canary";
  for (const code of ["ENOENT", "EACCES", 1]) {
    for (const loader of [loadCodexClientVersion, loadBundledCatalog]) {
      let calls = 0;
      await assert.rejects(
        loader({
          codexPath: `/test/${privateValue}/codex`,
          execFileImpl: async (binary) => {
            calls += 1;
            assert.equal(binary, `/test/${privateValue}/codex`);
            throw Object.assign(new Error(privateValue), {
              code,
              stdout: privateValue,
              stderr: privateValue,
            });
          },
        }),
        (error) => {
          assert.doesNotMatch(error.message, new RegExp(privateValue, "u"));
          assert.equal(error.cause, undefined);
          if (loader === loadCodexClientVersion) {
            assert.match(error.message, /Failed to read the Codex client version/u);
            assert.match(error.message, /CODEX_BINARY/u);
          } else {
            assert.equal(error.message, "Failed to read the bundled model catalog from Codex");
          }
          return true;
        },
      );
      assert.equal(calls, 1);
    }
  }
});

test("a discovered executable must still supply a version and a bundled catalog", async () => {
  await assert.rejects(
    loadCodexClientVersion({
      codexPath: "/test/codex",
      execFileImpl: async () => ({ stdout: "unrecognized client" }),
    }),
    /Codex version output has no semantic version/u,
  );
  await assert.rejects(
    loadBundledCatalog({
      codexPath: "/test/codex",
      execFileImpl: async () => ({ stdout: '{"different_schema":[]}' }),
    }),
    /must contain a models array/u,
  );
});
