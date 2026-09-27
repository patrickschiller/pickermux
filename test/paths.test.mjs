import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveCodexBinary } from "../src/paths.mjs";

const CURRENT_CODEX_BINARY =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const LEGACY_CODEX_BINARY =
  "/Applications/ChatGPT.app/Contents/Resources/codex";
const CODEX_WRAPPER =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";

test("discovers the current nested Codex executable without relying on PATH", () => {
  const calls = [];
  const resolved = resolveCodexBinary({ PATH: "/unrelated/bin" }, {
    existsSyncImpl: (candidate) => {
      calls.push(candidate);
      return candidate === CURRENT_CODEX_BINARY;
    },
  });

  assert.equal(resolved, CURRENT_CODEX_BINARY);
  assert.deepEqual(calls, [CURRENT_CODEX_BINARY]);
});

test("prefers the current Codex executable when both bundle layouts exist", () => {
  const resolved = resolveCodexBinary({}, {
    existsSyncImpl: (candidate) =>
      candidate === CURRENT_CODEX_BINARY || candidate === LEGACY_CODEX_BINARY,
  });

  assert.equal(resolved, CURRENT_CODEX_BINARY);
});

test("retains the legacy Codex bundle layout when the current layout is absent", () => {
  const calls = [];
  const resolved = resolveCodexBinary({}, {
    existsSyncImpl: (candidate) => {
      calls.push(candidate);
      return candidate === LEGACY_CODEX_BINARY;
    },
  });

  assert.equal(resolved, LEGACY_CODEX_BINARY);
  assert.deepEqual(calls, [CURRENT_CODEX_BINARY, LEGACY_CODEX_BINARY]);
});

test("falls back to the Codex PATH command only when both bundle layouts are absent", () => {
  const calls = [];
  const resolved = resolveCodexBinary({}, {
    existsSyncImpl: (candidate) => {
      calls.push(candidate);
      return false;
    },
  });

  assert.equal(resolved, "codex");
  assert.deepEqual(calls, [CURRENT_CODEX_BINARY, LEGACY_CODEX_BINARY]);
});

test("does not discover the shell wrapper in place of the executable watched for updates", () => {
  const resolved = resolveCodexBinary({}, {
    existsSyncImpl: (candidate) => candidate === CODEX_WRAPPER,
  });

  assert.equal(resolved, "codex");
});

test("keeps an explicit Codex binary authoritative without probing alternatives", () => {
  const configured = "/custom/Missing Codex.app/codex";
  const resolved = resolveCodexBinary({ CODEX_BINARY: ` ${configured} ` }, {
    existsSyncImpl: () => {
      assert.fail("An explicit executable must not fall back to another installation");
    },
  });

  assert.equal(resolved, configured);
});

test("resolves an explicit relative Codex binary path", () => {
  const configured = "custom Codex.app/codex";
  const resolved = resolveCodexBinary({ CODEX_BINARY: configured }, {
    existsSyncImpl: () => {
      assert.fail("An explicit executable must not probe bundle discovery");
    },
  });

  assert.equal(resolved, path.resolve(configured));
});

test("uses bundle discovery when the Codex binary override is blank", () => {
  const resolved = resolveCodexBinary({ CODEX_BINARY: " \t " }, {
    existsSyncImpl: (candidate) => candidate === CURRENT_CODEX_BINARY,
  });

  assert.equal(resolved, CURRENT_CODEX_BINARY);
});
