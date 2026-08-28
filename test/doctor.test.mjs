import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runDoctor, runLiveResponseCheck } from "../src/doctor.mjs";

async function temporaryCatalog(t) {
  const unique = await mkdtemp(path.join(tmpdir(), "lmstudio-doctor-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(unique, { recursive: true, force: true });
  });
  const catalogPath = path.join(unique, "models.json");
  await writeFile(
    catalogPath,
    `${JSON.stringify({
      models: [
        {
          slug: "qwen/example",
          visibility: "list",
          supported_in_api: true,
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  return { unique, catalogPath };
}

test("doctor combines installed config, discovery, catalog and Codex checks", async (t) => {
  const { unique, catalogPath } = await temporaryCatalog(t);
  const result = await runDoctor({
    projectConfig: {
      endpoint: "http://127.0.0.1:1234/v1",
      providerId: "lmstudio_remote",
      providerName: "LM Studio Local",
      models: [{ id: "qwen/example" }],
    },
    paths: {
      configPath: path.join(unique, "config.toml"),
      statePath: path.join(unique, "state.json"),
      catalogPath,
    },
    codexPath: "/fake/codex",
    statusImpl: async () => ({
      installed: true,
      healthy: true,
      status: "installed",
      model: "qwen/example",
      provider: "lmstudio_remote",
      providerName: "LM Studio Local",
      catalog: catalogPath,
      baseUrl: "http://127.0.0.1:1234/v1",
      modelReasoningEffort: "low",
    }),
    discoverImpl: async () => ({
      apiBaseUrl: "http://127.0.0.1:1234/v1",
      source: "lmstudio-rest",
      models: [{ id: "qwen/example" }],
    }),
    debugModelsImpl: async () => ({
      models: [
        {
          slug: "qwen/example",
          visibility: "list",
          supported_in_api: true,
        },
      ],
    }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.checks.map((entry) => entry.status),
    ["pass", "pass", "pass", "pass"],
  );
});

test("live response check verifies the marker", async () => {
  const calls = [];
  const result = await runLiveResponseCheck({
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen/example",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          id: "resp_test",
          output: [
            {
              content: [{ type: "output_text", text: "P1_DOCTOR_OK" }],
            },
          ],
        }),
      };
    },
  });
  assert.equal(result.text, "P1_DOCTOR_OK");
  assert.equal(calls[0].url, "http://127.0.0.1:1234/v1/responses");
  assert.equal(JSON.parse(calls[0].options.body).reasoning.effort, "low");
});

test("doctor rejects an installed provider that differs from project config", async (t) => {
  const { unique, catalogPath } = await temporaryCatalog(t);
  const result = await runDoctor({
    projectConfig: {
      endpoint: "http://127.0.0.1:1234/v1",
      providerId: "lmstudio_remote",
      providerName: "LM Studio Local",
      models: [{ id: "qwen/example" }],
    },
    paths: {
      configPath: path.join(unique, "config.toml"),
      statePath: path.join(unique, "state.json"),
      catalogPath,
    },
    codexPath: "/fake/codex",
    statusImpl: async () => ({
      installed: true,
      healthy: true,
      status: "installed",
      model: "qwen/example",
      provider: "lmstudio_remote",
      providerName: "LM Studio Local",
      catalog: catalogPath,
      baseUrl: "http://127.0.0.1:9999/v1",
      modelReasoningEffort: "low",
    }),
    discoverImpl: async () => ({
      apiBaseUrl: "http://127.0.0.1:1234/v1",
      source: "lmstudio-rest",
      models: [{ id: "qwen/example" }],
    }),
    debugModelsImpl: async () => ({
      models: [
        {
          slug: "qwen/example",
          visibility: "list",
          supported_in_api: true,
        },
      ],
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.checks[0].detail, /baseUrl/u);
});

test("live response timeout remains active while the body is read", async () => {
  await assert.rejects(
    runLiveResponseCheck({
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen/example",
      timeoutMs: 10,
      fetchImpl: async (_url, options) => ({
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
      }),
    }),
    /timed out/u,
  );
});
