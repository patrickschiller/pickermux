import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEX_CONTEXT_HIGH_RISK_BELOW_TOKENS,
  CODEX_CONTEXT_RECOMMENDED_TOKENS,
  MODEL_DEFAULT_REASONING_DESCRIPTION,
  TEXT_ONLY_MODEL_INSTRUCTIONS,
  buildCodexCatalog,
  buildMixedCodexCatalog,
  contextPickerPresentation,
  loadBundledCatalog,
  loadCachedNativeCatalog,
  loadCodexClientVersion,
  loadNativeCatalog,
  replaceCatalogAtomicIfCurrent,
  writeCatalogAtomic,
  writeCatalogAtomicWithReceipt,
} from "../src/catalog.mjs";
import {
  DiscoveryUnavailableError,
  discoverLmStudio,
  normalizeLmStudioBaseUrl,
} from "../src/discovery.mjs";

async function startJsonServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const donor = {
  slug: "gpt-5.4-mini",
  display_name: "GPT-5.4 mini",
  description: "Bundled donor",
  default_reasoning_level: "medium",
  supported_reasoning_levels: [
    { effort: "medium", description: "Bundled setting" },
  ],
  shell_type: "unified_exec",
  visibility: "list",
  supported_in_api: true,
  priority: 8,
  base_instructions: "Legacy donor instructions must not reach text-only LM Studio",
  model_messages: {
    instructions_template: "Donor instructions {{ personality }}",
    instructions_variables: { personality_default: "" },
    persistent_instructions: "Donor persistent instructions",
    tools: { developer_instructions: "Donor tool instructions" },
    approvals: { developer_instructions: "Donor approval instructions" },
    collaboration_modes: { default: "Donor collaboration instructions" },
    auto_review: { developer_instructions: "Donor review instructions" },
    permissions: { developer_instructions: "Donor permission instructions" },
    multi_agent: { developer_instructions: "Donor multi-agent instructions" },
    token_budget: { developer_instructions: "Donor budget instructions" },
    confirmation_policies: {
      developer_instructions: "Donor confirmation instructions",
    },
    guardian_v2: { developer_instructions: "Donor guardian instructions" },
  },
  apply_patch_tool_type: "freeform",
  web_search_tool_type: "text_and_image",
  truncation_policy: { mode: "tokens", limit: 10_000 },
  context_window: 272_000,
  max_context_window: 272_000,
  effective_context_window_percent: 95,
  input_modalities: ["text", "image"],
  supports_search_tool: true,
};

test("normalizes /v1 without nesting the native metadata endpoint", () => {
  assert.deepEqual(
    normalizeLmStudioBaseUrl("http://127.0.0.1:1234/v1/"),
    {
      origin: "http://127.0.0.1:1234",
      apiBaseUrl: "http://127.0.0.1:1234/v1",
      metadataBaseUrl: "http://127.0.0.1:1234/api/v1",
      metadataUrl: "http://127.0.0.1:1234/api/v1/models",
      modelsUrl: "http://127.0.0.1:1234/v1/models",
    },
  );
});

test("classifies only an all-ECONNREFUSED cause tree as unavailable", async () => {
  const refused = new Error("connect refused");
  refused.code = "ECONNREFUSED";
  await assert.rejects(
    discoverLmStudio({
      baseUrl: "http://127.0.0.1:1234",
      discovery: { mode: "loaded", maxModels: 4 },
      allowlist: [],
      fetchImpl: async () => {
        throw new TypeError("fetch failed", { cause: refused });
      },
    }),
    (error) =>
      error instanceof DiscoveryUnavailableError &&
      error.reason === "connection-refused" &&
      !error.message.includes("connect refused"),
  );

  const reset = new Error("reset");
  reset.code = "ECONNRESET";
  await assert.rejects(
    discoverLmStudio({
      baseUrl: "http://127.0.0.1:1234",
      discovery: { mode: "loaded", maxModels: 4 },
      allowlist: [],
      fetchImpl: async () => {
        throw new TypeError("fetch failed", {
          cause: new AggregateError([refused, reset]),
        });
      },
    }),
    (error) =>
      !(error instanceof DiscoveryUnavailableError) &&
      /metadata discovery request failed/u.test(error.message),
  );

  await assert.rejects(
    discoverLmStudio({
      baseUrl: "http://127.0.0.1:1234",
      discovery: { mode: "loaded", maxModels: 4 },
      allowlist: [],
      fetchImpl: async () => {
        throw new TypeError("fetch failed", {
          cause: new AggregateError([refused, "unknown transport detail"]),
        });
      },
    }),
    (error) => !(error instanceof DiscoveryUnavailableError),
  );
});

test("discovers only allowlisted loaded LLMs and uses loaded context", async (t) => {
  const requests = [];
  const baseUrl = await startJsonServer(t, (request, response) => {
    requests.push(request.url);
    sendJson(response, 200, {
      models: [
        {
          key: "qwen/qwen3.8-27b",
          type: "llm",
          display_name: "Qwen Native Name",
          loaded_instances: [
            { id: "a", config: { context_length: 65_536 } },
            { id: "b", config: { context_length: 42_496 } },
          ],
          max_context_length: 262_144,
          capabilities: {
            vision: true,
            trained_for_tool_use: true,
            reasoning: { allowed_options: ["low", "medium"] },
          },
        },
        {
          key: "prism/unloaded",
          type: "llm",
          display_name: "Unloaded",
          loaded_instances: [],
          max_context_length: 131_072,
        },
        {
          key: "text-embedding-model",
          type: "embedding",
          display_name: "Embedding",
          loaded_instances: [
            { id: "embedding", config: { context_length: 2_048 } },
          ],
        },
        {
          key: "not-allowlisted",
          type: "llm",
          loaded_instances: [
            { id: "other", config: { context_length: 8_192 } },
          ],
        },
      ],
    });
  });

  const discovered = await discoverLmStudio({
    baseUrl: `${baseUrl}/v1`,
    allowlist: [
      { id: "qwen/qwen3.8-27b", displayName: "Qwen Curated" },
      { id: "prism/unloaded" },
      { id: "text-embedding-model" },
    ],
  });

  assert.equal(discovered.apiBaseUrl, `${baseUrl}/v1`);
  assert.equal(discovered.metadataUrl, `${baseUrl}/api/v1/models`);
  assert.equal(discovered.source, "lmstudio-rest");
  assert.deepEqual(requests, ["/api/v1/models"]);
  assert.deepEqual(discovered.models, [
    {
      id: "qwen/qwen3.8-27b",
      displayName: "Qwen Curated",
      type: "llm",
      loaded: true,
      contextWindow: 42_496,
      source: "lmstudio-rest",
      capabilities: {
        trainedForToolUse: true,
        vision: true,
        reasoningOptions: ["low", "medium"],
      },
    },
  ]);
  assert.deepEqual(discovered.skipped, [
    { id: "prism/unloaded", reason: "not-loaded" },
    { id: "text-embedding-model", reason: "not-an-llm" },
  ]);
});

test("fails closed when any loaded instance has no confirmed context", async () => {
  const discovered = await discoverLmStudio({
    baseUrl: "http://127.0.0.1:1234/v1",
    allowlist: ["safe/model", "uncertain/model"],
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              key: "safe/model",
              type: "llm",
              loaded_instances: [
                { config: { context_length: 32_768 } },
                { config: { context_length: 42_496 } },
              ],
            },
            {
              key: "uncertain/model",
              type: "llm",
              max_context_length: 262_144,
              loaded_instances: [
                { config: { context_length: 32_768 } },
                { config: {} },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  assert.equal(discovered.models[0].contextWindow, 32_768);
  assert.deepEqual(discovered.skipped, [
    { id: "uncertain/model", reason: "loaded-context-not-confirmed" },
  ]);
});

test("duplicate LM Studio metadata is merged conservatively and conflicts fail closed", async () => {
  for (const mode of ["allowlist", "loaded"]) {
    for (const reverse of [false, true]) {
      const typeConflict = [
        {
          key: "type-conflict/model",
          type: "llm",
          loaded_instances: [{ config: { context_length: 32_768 } }],
        },
        {
          key: "type-conflict/model",
          type: "embedding",
          loaded_instances: [{ config: { context_length: 8_192 } }],
        },
      ];
      const capabilityConflict = [
        {
          key: "capability-conflict/model",
          type: "llm",
          capabilities: { vision: true },
          loaded_instances: [{ config: { context_length: 32_768 } }],
        },
        {
          key: "capability-conflict/model",
          type: "llm",
          capabilities: { vision: false },
          loaded_instances: [{ config: { context_length: 8_192 } }],
        },
      ];
      const discovered = await discoverLmStudio({
        baseUrl: "http://127.0.0.1:1234/v1",
        discovery: { mode, maxModels: 8 },
        allowlist: [
          "safe/model",
          "type-conflict/model",
          "capability-conflict/model",
          "uncertain-duplicate/model",
        ],
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  key: "safe/model",
                  type: "llm",
                  loaded_instances: [
                    { config: { context_length: 42_496 } },
                  ],
                },
                ...(reverse ? [...typeConflict].reverse() : typeConflict),
                ...(reverse
                  ? [...capabilityConflict].reverse()
                  : capabilityConflict),
                {
                  key: "uncertain-duplicate/model",
                  type: "llm",
                  loaded_instances: [
                    { config: { context_length: 32_768 } },
                  ],
                },
                {
                  key: "uncertain-duplicate/model",
                  type: "llm",
                  loaded_instances: [{ config: {} }],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      });

      assert.deepEqual(
        discovered.models.map((model) => model.id),
        ["safe/model"],
      );
      const skipped = new Map(
        discovered.skipped.map((entry) => [entry.id, entry.reason]),
      );
      assert.equal(
        skipped.get("type-conflict/model"),
        "inconsistent-model-metadata",
      );
      assert.equal(
        skipped.get("capability-conflict/model"),
        "inconsistent-model-metadata",
      );
      assert.equal(
        skipped.get("uncertain-duplicate/model"),
        "loaded-context-not-confirmed",
      );
    }
  }
});

test("loaded mode publishes every loaded LLM with overrides first and no fallback", async () => {
  const requests = [];
  const discovered = await discoverLmStudio({
    baseUrl: "http://127.0.0.1:1234/v1",
    discovery: { mode: "loaded", maxModels: 8 },
    allowlist: [
      { id: "zeta/override", displayName: "Curated Zeta" },
    ],
    fetchImpl: async (url) => {
      requests.push(url);
      return new Response(
        JSON.stringify({
          models: [
            {
              key: "zeta/override",
              type: "llm",
              display_name: "Native Zeta",
              loaded_instances: [{ config: { context_length: 16_384 } }],
              capabilities: {
                reasoning: {
                  allowed_options: ["off", "on"],
                  default: "on",
                },
              },
            },
            {
              key: "beta/model",
              type: "llm",
              display_name: "Beta",
              loaded_instances: [{ config: { context_length: 8_192 } }],
            },
            {
              key: "alpha/model",
              type: "llm",
              display_name: "Alpha",
              loaded_instances: [{ config: { context_length: 32_768 } }],
            },
            {
              key: "alpha/model",
              type: "llm",
              display_name: "Duplicate Alpha",
              loaded_instances: [{ config: { context_length: 4_096 } }],
            },
            {
              key: "unloaded/model",
              type: "llm",
              loaded_instances: [],
            },
            {
              key: "embed/model",
              type: "embedding",
              loaded_instances: [{ config: { context_length: 2_048 } }],
            },
            {
              key: "invalid model",
              type: "llm",
              loaded_instances: [{ config: { context_length: 2_048 } }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.deepEqual(requests, ["http://127.0.0.1:1234/api/v1/models"]);
  assert.deepEqual(
    discovered.models.map((model) => model.id),
    ["zeta/override", "alpha/model", "beta/model"],
  );
  assert.equal(discovered.models[0].displayName, "Curated Zeta");
  assert.equal(
    discovered.models.find((model) => model.id === "alpha/model").contextWindow,
    4_096,
  );
  assert.deepEqual(discovered.models[0].capabilities, {
    trainedForToolUse: false,
    vision: false,
    reasoningOptions: ["off", "on"],
    reasoningDefault: "on",
  });
  assert.equal(
    discovered.skipped.some(
      (entry) => entry.id === "embed/model" && entry.reason === "not-an-llm",
    ),
    true,
  );
  assert.equal(
    discovered.skipped.some(
      (entry) => entry.id === "invalid model" && entry.reason === "invalid-id",
    ),
    true,
  );
});

test("loaded mode accepts zero models, fails closed above its cap, and never falls back", async () => {
  const empty = await discoverLmStudio({
    baseUrl: "http://127.0.0.1:1234",
    discovery: { mode: "loaded", maxModels: 1 },
    allowlist: [],
    fetchImpl: async () =>
      new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  assert.deepEqual(empty.models, []);

  await assert.rejects(
    discoverLmStudio({
      baseUrl: "http://127.0.0.1:1234",
      discovery: { mode: "loaded", maxModels: 1 },
      allowlist: [],
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            models: ["a", "b"].map((key) => ({
              key,
              type: "llm",
              loaded_instances: [{ config: { context_length: 8_192 } }],
            })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    }),
    /exceeding maxModels 1/u,
  );

  let requests = 0;
  await assert.rejects(
    discoverLmStudio({
      baseUrl: "http://127.0.0.1:1234",
      discovery: { mode: "loaded", maxModels: 4 },
      allowlist: [],
      fetchImpl: async () => {
        requests += 1;
        return new Response("not available", { status: 404 });
      },
    }),
    /metadata discovery returned HTTP 404/u,
  );
  assert.equal(requests, 1);
});

test("falls back to /v1/models only with explicit type and context metadata", async (t) => {
  const requests = [];
  const baseUrl = await startJsonServer(t, (request, response) => {
    requests.push(request.url);
    if (request.url === "/api/v1/models") {
      sendJson(response, 404, { error: "not supported" });
      return;
    }
    sendJson(response, 200, {
      data: [{ id: "fallback-llm" }, { id: "fallback-embedding" }],
    });
  });

  const discovered = await discoverLmStudio({
    baseUrl,
    allowlist: [
      {
        id: "fallback-llm",
        displayName: "Fallback LLM",
        type: "llm",
        contextWindow: 16_384,
      },
      {
        id: "fallback-embedding",
        type: "embedding",
        contextWindow: 2_048,
      },
    ],
  });

  assert.equal(discovered.source, "openai-compatible-fallback");
  assert.deepEqual(requests, ["/api/v1/models", "/v1/models"]);
  assert.equal(discovered.models[0].id, "fallback-llm");
  assert.equal(discovered.models[0].contextWindow, 16_384);
  assert.deepEqual(discovered.skipped, [
    { id: "fallback-embedding", reason: "type-not-confirmed-as-llm" },
  ]);
});

test("does not infer fallback type or context and keeps tokens out of errors", async (t) => {
  const secret = "lm-secret-value";
  const baseUrl = await startJsonServer(t, (request, response) => {
    if (request.headers.authorization !== `Bearer ${secret}`) {
      sendJson(response, 401, { error: "missing token" });
      return;
    }
    sendJson(response, 401, { error: `do not expose ${secret}` });
  });

  await assert.rejects(
    discoverLmStudio({
      baseUrl,
      allowlist: ["fallback-llm"],
      apiToken: secret,
    }),
    (error) => {
      assert.match(error.message, /HTTP 401/u);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );

  assert.throws(
    () => normalizeLmStudioBaseUrl("http://user:password@localhost:1234/v1"),
    (error) => {
      assert.equal(error.message.includes("password"), false);
      return true;
    },
  );
});

test("loads a bundled catalog by invoking a fake Codex binary", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lmstudio-codex-fake-"));
  const binary = path.join(directory, "fake codex");
  const fixture = { models: [donor] };
  const script = `#!/usr/bin/env node\nif (process.argv.slice(2).join(" ") !== "debug models --bundled") process.exit(7);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(fixture))});\n`;
  await writeFile(binary, script, { mode: 0o700 });
  await chmod(binary, 0o700);

  const loaded = await loadBundledCatalog({ codexPath: binary });
  assert.deepEqual(loaded, fixture);
});

test("normalizes the embedded Codex prerelease to its account-cache version", async () => {
  const version = await loadCodexClientVersion({
    codexPath: "/fake/codex",
    execFileImpl: async (_binary, args) => {
      assert.deepEqual(args, ["--version"]);
      return { stdout: "codex-cli 0.150.0-alpha.12.2\n" };
    },
  });
  assert.equal(version, "0.150.0");
});

test("builds complete conservative entries without mutating the donor", () => {
  const bundledCatalog = { models: [donor] };
  const before = JSON.stringify(bundledCatalog);
  const catalog = buildCodexCatalog({
    bundledCatalog,
    donorSlug: "gpt-5.4-mini",
    discoveredModels: [
      {
        id: "qwen/qwen3.8-27b",
        displayName: "Qwen 3.8 27B",
        type: "llm",
        contextWindow: 42_496,
        source: "lmstudio-rest",
      },
      {
        id: "prism/bonsai-27b",
        displayName: "Bonsai 27B",
        type: "llm",
        contextWindow: 32_768,
        source: "openai-compatible-fallback",
      },
    ],
  });

  assert.equal(JSON.stringify(bundledCatalog), before);
  assert.equal(catalog.models.length, 2);
  assert.deepEqual(
    catalog.models.map(({ slug, priority }) => ({ slug, priority })),
    [
      { slug: "qwen/qwen3.8-27b", priority: 1 },
      { slug: "prism/bonsai-27b", priority: 2 },
    ],
  );

  const model = catalog.models[0];
  assert.equal(model.base_instructions, TEXT_ONLY_MODEL_INSTRUCTIONS);
  assert.deepEqual(model.model_messages, {
    instructions_template: TEXT_ONLY_MODEL_INSTRUCTIONS,
    instructions_variables: null,
  });
  assert.doesNotMatch(
    JSON.stringify(model),
    /Legacy donor instructions|Donor instructions|Donor tool|Donor approval|Donor collaboration|Donor review|Donor permission|Donor multi-agent|Donor budget|Donor confirmation|Donor guardian/u,
  );
  assert.ok(TEXT_ONLY_MODEL_INSTRUCTIONS.length < 256);
  assert.match(model.comp_hash, /^model-bridge-p6-[0-9a-f]{16}$/u);
  assert.equal(model.context_window, 42_496);
  assert.equal(model.max_context_window, 42_496);
  assert.equal(model.supports_search_tool, false);
  assert.equal(model.apply_patch_tool_type, null);
  assert.equal(model.shell_type, "disabled");
  assert.equal(model.tool_mode, null);
  assert.deepEqual(model.input_modalities, ["text"]);
  assert.equal(model.multi_agent_version, null);
  assert.equal(model.node_repl_disabled, true);
  assert.deepEqual(model.experimental_supported_tools, []);
  assert.equal(model.include_skills_usage_instructions, false);
  assert.equal(model.include_plugin_usage_instructions, false);
  assert.equal(model.include_apps_usage_instructions, false);
  assert.deepEqual(catalog.models[1].model_messages, {
    instructions_template: TEXT_ONLY_MODEL_INSTRUCTIONS,
    instructions_variables: null,
  });
});

test("enables only direct unified-exec after an exact model certification", () => {
  const discoveredModels = [
    {
      id: "lmstudio/qwen/certified",
      displayName: "Certified Qwen",
      type: "llm",
      contextWindow: 32_768,
      source: "lmstudio-rest",
    },
    {
      id: "lmstudio/gemma/text-only",
      displayName: "Text-only Gemma",
      type: "llm",
      contextWindow: 32_768,
      source: "lmstudio-rest",
    },
  ];
  const catalog = buildCodexCatalog({
    bundledCatalog: { models: [donor] },
    discoveredModels,
    certifiedModelSlugs: ["lmstudio/qwen/certified"],
  });
  const [certified, textOnly] = catalog.models;

  assert.equal(certified.tool_mode, "direct");
  assert.equal(certified.shell_type, "unified_exec");
  assert.equal(certified.apply_patch_tool_type, null);
  assert.equal(certified.supports_search_tool, false);
  assert.deepEqual(certified.experimental_supported_tools, []);
  assert.equal(certified.multi_agent_version, null);
  assert.equal(certified.base_instructions, donor.base_instructions);
  assert.deepEqual(certified.model_messages, donor.model_messages);

  assert.equal(textOnly.tool_mode, null);
  assert.equal(textOnly.shell_type, "disabled");
  assert.equal(textOnly.base_instructions, TEXT_ONLY_MODEL_INSTRUCTIONS);
  assert.equal(
    textOnly.model_messages.instructions_template,
    TEXT_ONLY_MODEL_INSTRUCTIONS,
  );
  assert.notEqual(certified.comp_hash, textOnly.comp_hash);
});

test("enables Efficient Fidelity only after its additive LM Studio certification", () => {
  const model = {
    id: "lmstudio/qwen/efficient",
    displayName: "Efficient Qwen",
    type: "llm",
    contextWindow: 32_768,
    source: "lmstudio-rest",
  };
  const [efficient] = buildCodexCatalog({
    bundledCatalog: { models: [donor] },
    discoveredModels: [model],
    certifiedModelSlugs: [model.id],
    efficientFidelityModelSlugs: [model.id],
  }).models;

  assert.equal(efficient.tool_mode, "direct");
  assert.equal(efficient.shell_type, "unified_exec");
  assert.equal(efficient.supports_search_tool, true);
  assert.equal(efficient.base_instructions, donor.base_instructions);
  assert.deepEqual(efficient.model_messages, donor.model_messages);

  assert.throws(
    () =>
      buildCodexCatalog({
        bundledCatalog: { models: [donor] },
        discoveredModels: [model],
        efficientFidelityModelSlugs: [model.id],
      }),
    /requires direct tool certification/u,
  );
});

test("keeps the donor prompt for generic Responses-compatible providers", () => {
  const catalog = buildCodexCatalog({
    bundledCatalog: { models: [donor] },
    discoveredModels: [
      {
        id: "vendor/text-only",
        displayName: "Vendor text-only",
        type: "llm",
        contextWindow: 32_768,
        source: "openai-compatible-models",
      },
    ],
  });
  const [model] = catalog.models;

  assert.equal(model.tool_mode, null);
  assert.equal(model.base_instructions, donor.base_instructions);
  assert.deepEqual(model.model_messages, donor.model_messages);
  assert.match(model.comp_hash, /^model-bridge-p6-[0-9a-f]{16}$/u);
});

test("persists model-defined reasoning efforts in supported catalog metadata", () => {
  const catalog = buildCodexCatalog({
    bundledCatalog: { models: [donor] },
    discoveredModels: [
      {
        id: "lmstudio/microsoft/phi-reasoning",
        displayName: "Phi Reasoning – LM Studio",
        type: "llm",
        contextWindow: 32_768,
        reasoningEffort: "xhigh",
        reasoningEfforts: ["xhigh"],
        reasoningOmitEfforts: ["xhigh"],
      },
    ],
  });

  assert.deepEqual(catalog.models[0].supported_reasoning_levels, [
    {
      effort: "xhigh",
      description: MODEL_DEFAULT_REASONING_DESCRIPTION,
    },
  ]);
  for (const reasoningOmitEfforts of [
    "xhigh",
    null,
    ["xhigh", "xhigh"],
    ["medium"],
  ]) {
    assert.throws(
      () =>
        buildCodexCatalog({
          bundledCatalog: { models: [donor] },
          discoveredModels: [
            {
              id: "lmstudio/invalid",
              displayName: "Invalid",
              type: "llm",
              contextWindow: 32_768,
              reasoningEffort: "xhigh",
              reasoningEfforts: ["xhigh"],
              reasoningOmitEfforts,
            },
          ],
        }),
      /invalid omitted reasoning efforts/u,
    );
  }
});

test("keeps context out of the picker name and warns only below 32K", () => {
  const liveLmStudio = { source: "lmstudio-rest" };
  assert.deepEqual(contextPickerPresentation(42_496, liveLmStudio), {
    prefix: "",
    suffix: "",
    description: "LM Studio; currently loaded with 42,496 context tokens.",
  });
  assert.deepEqual(contextPickerPresentation(25_856, liveLmStudio), {
    prefix: "⚠ ",
    suffix: "",
    description:
      "LM Studio; currently loaded with 25,856 context tokens. " +
      "At least 32,768 tokens are recommended for longer Codex turns.",
  });
  assert.deepEqual(contextPickerPresentation(8_192, liveLmStudio), {
    prefix: "⚠ ",
    suffix: "",
    description:
      "LM Studio; currently loaded with 8,192 context tokens. " +
      "Likely too small for longer Codex turns; " +
      "reload it in LM Studio with 32,768 tokens or more.",
  });
  assert.equal(
    contextPickerPresentation(16_525, liveLmStudio).prefix,
    "⚠ ",
  );
  assert.equal(
    contextPickerPresentation(8_192).description,
    "External model; published with 8,192 context tokens. " +
      "Likely too small for longer Codex turns; " +
      "use a model or deployment with at least 32,768 tokens of confirmed " +
      "active context.",
  );

  const catalog = buildCodexCatalog({
    bundledCatalog: { models: [donor] },
    discoveredModels: [
      {
        id: "lmstudio/safe",
        displayName: "Safe – LM Studio",
        type: "llm",
        contextWindow: 42_496,
        source: "lmstudio-rest",
      },
      {
        id: "lmstudio/tight",
        displayName: "Tight – LM Studio",
        type: "llm",
        contextWindow: 25_856,
        source: "lmstudio-rest",
      },
      {
        id: "lmstudio/small",
        displayName: "Small – LM Studio",
        type: "llm",
        contextWindow: 8_192,
        source: "lmstudio-rest",
      },
    ],
  });
  assert.deepEqual(
    catalog.models.map((model) => model.display_name),
    [
      "Safe – LM Studio",
      "⚠ Tight – LM Studio",
      "⚠ Small – LM Studio",
    ],
  );
  assert.deepEqual(
    catalog.models.map((model) => model.context_window),
    [42_496, 25_856, 8_192],
  );

  const nearbyContextCatalog = buildCodexCatalog({
    bundledCatalog: { models: [donor] },
    discoveredModels: [
      {
        id: "lmstudio/safe",
        displayName: "Safe – LM Studio",
        type: "llm",
        contextWindow: 42_500,
        source: "lmstudio-rest",
      },
    ],
  });
  assert.equal(
    nearbyContextCatalog.models[0].display_name,
    catalog.models[0].display_name,
  );
  assert.notEqual(
    nearbyContextCatalog.models[0].comp_hash,
    catalog.models[0].comp_hash,
  );

  assert.equal(
    contextPickerPresentation(
      CODEX_CONTEXT_HIGH_RISK_BELOW_TOKENS - 1,
      liveLmStudio,
    ).prefix,
    "⚠ ",
  );
  assert.equal(CODEX_CONTEXT_HIGH_RISK_BELOW_TOKENS, 24_576);
  assert.equal(CODEX_CONTEXT_RECOMMENDED_TOKENS, 32_768);
  assert.equal(
    contextPickerPresentation(
      CODEX_CONTEXT_HIGH_RISK_BELOW_TOKENS,
      liveLmStudio,
    ).prefix,
    "⚠ ",
  );
  assert.equal(
    contextPickerPresentation(
      CODEX_CONTEXT_RECOMMENDED_TOKENS - 1,
      liveLmStudio,
    ).prefix,
    "⚠ ",
  );
  assert.equal(
    contextPickerPresentation(
      CODEX_CONTEXT_RECOMMENDED_TOKENS,
      liveLmStudio,
    ).prefix,
    "",
  );
  assert.throws(
    () => contextPickerPresentation(0, liveLmStudio),
    /positive integer/u,
  );
});

test("mixed catalog preserves native models and appends namespaced externals", () => {
  const native = {
    models: [
      { ...donor, slug: "gpt-5.6-sol", priority: 1 },
      { ...donor, slug: "gpt-5.4-mini", priority: 8 },
    ],
  };
  const mixed = buildMixedCodexCatalog({
    bundledCatalog: native,
    donorSlug: "gpt-5.4-mini",
    discoveredModels: [
      {
        id: "lmstudio/qwen/example",
        displayName: "Qwen Example – LM Studio",
        type: "llm",
        contextWindow: 32_768,
      },
    ],
  });

  assert.deepEqual(mixed.models.map((model) => model.slug), [
    "gpt-5.6-sol",
    "gpt-5.4-mini",
    "lmstudio/qwen/example",
  ]);
  assert.deepEqual(mixed.models.slice(0, 2), native.models);
  assert.equal(mixed.models[0].supported_reasoning_levels[0].effort, "medium");
  assert.deepEqual(mixed.models[2].supported_reasoning_levels, [
    {
      effort: "low",
      description: "Fast responses with lighter reasoning",
    },
  ]);
  assert.equal(mixed.models[2].priority, 9);
  assert.equal(native.models.length, 2);

  assert.throws(
    () =>
      buildMixedCodexCatalog({
        bundledCatalog: native,
        discoveredModels: [
          {
            id: "gpt-5.6-sol",
            displayName: "Collision",
            type: "llm",
            contextWindow: 8_192,
          },
        ],
      }),
    /collides/u,
  );
});

test("uses the complete account cache as native picker source and the bundle only as donor", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lmstudio-native-cache-"));
  const accountModels = [
    { ...donor, slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", priority: 1 },
    {
      ...donor,
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      visibility: "list",
      priority: 2,
    },
    {
      ...donor,
      slug: "gpt-5.3-codex-spark",
      display_name: "GPT-5.3-Codex-Spark",
      supported_in_api: false,
      priority: 3,
    },
  ];
  await writeFile(
    path.join(directory, "models_cache.json"),
    JSON.stringify({
      fetched_at: "2026-08-28T16:06:00Z",
      client_version: "0.150.0",
      etag: "account-etag",
      models: accountModels,
    }),
  );

  const cached = await loadCachedNativeCatalog({ codexHome: directory });
  assert.equal(cached.source, "codex-account-cache");
  assert.equal(cached.fetchedAt, "2026-08-28T16:06:00Z");
  assert.deepEqual(cached.catalog.models.map((model) => model.slug), [
    "gpt-5.6-sol",
    "gpt-5.5",
    "gpt-5.3-codex-spark",
  ]);

  const mixed = buildMixedCodexCatalog({
    nativeCatalog: cached.catalog,
    bundledCatalog: { models: [donor] },
    discoveredModels: [
      {
        id: "lmstudio/qwen/example",
        displayName: "Qwen Example",
        type: "llm",
        contextWindow: 32_768,
        reasoningEffort: "xhigh",
        reasoningEfforts: ["none", "low", "medium", "xhigh"],
      },
    ],
  });
  assert.deepEqual(mixed.models.map((model) => model.slug), [
    "gpt-5.6-sol",
    "gpt-5.5",
    "gpt-5.3-codex-spark",
    "lmstudio/qwen/example",
  ]);
  assert.equal(mixed.models[1].visibility, "list");
  assert.equal(mixed.models[3].default_reasoning_level, "xhigh");
  assert.deepEqual(
    mixed.models[3].supported_reasoning_levels.map((level) => level.effort),
    ["none", "low", "medium", "xhigh"],
  );
});

test("falls back to the bundled native catalog when the account cache is invalid", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lmstudio-invalid-cache-"));
  await writeFile(path.join(directory, "models_cache.json"), "{not-json");
  const bundledCatalog = { models: [donor] };
  const native = await loadNativeCatalog({ codexHome: directory, bundledCatalog });
  assert.equal(native.source, "codex-bundled-fallback");
  assert.match(native.warning, /not valid JSON/u);
  assert.deepEqual(native.catalog, bundledCatalog);

  await assert.rejects(
    loadNativeCatalog({
      codexHome: directory,
      bundledCatalog,
      allowBundledFallback: false,
    }),
    /valid account-scoped Codex model cache is required/u,
  );
});

test("rejects an account cache from another Codex client version", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lmstudio-version-cache-"));
  await writeFile(
    path.join(directory, "models_cache.json"),
    JSON.stringify({
      fetched_at: "2026-08-28T16:06:00Z",
      client_version: "0.149.1",
      models: [donor],
    }),
  );
  await assert.rejects(
    loadCachedNativeCatalog({
      codexHome: directory,
      expectedClientVersion: "0.150.0",
    }),
    /does not match client 0\.150\.0/u,
  );
});

test("rejects future account caches and accepts old exact-version snapshots", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lmstudio-time-cache-"));
  const cachePath = path.join(directory, "models_cache.json");
  await writeFile(
    cachePath,
    JSON.stringify({
      fetched_at: "2026-08-28T16:30:01Z",
      client_version: "0.150.0",
      models: [donor],
    }),
  );
  await assert.rejects(
    loadCachedNativeCatalog({
      codexHome: directory,
      expectedClientVersion: "0.150.0",
      now: Date.parse("2026-08-28T16:25:00Z"),
    }),
    /timestamp is in the future/u,
  );

  await writeFile(
    cachePath,
    JSON.stringify({
      fetched_at: "2026-08-28T16:00:00Z",
      client_version: "0.150.0",
      models: [donor],
    }),
  );
  const oldSnapshot = await loadCachedNativeCatalog({
    codexHome: directory,
    expectedClientVersion: "0.150.0",
    now: Date.parse("2026-08-29T01:19:00Z"),
  });
  assert.equal(oldSnapshot.ageMs, 559 * 60_000);
  assert.equal(oldSnapshot.warning, undefined);
});

test("writes an atomic private catalog with no temporary file left behind", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lmstudio-catalog-"));
  const target = path.join(directory, "nested", "models.json");
  const catalog = buildCodexCatalog({
    bundledCatalog: { models: [donor] },
    discoveredModels: [
      {
        id: "qwen/qwen3.8-27b",
        displayName: "Qwen",
        type: "llm",
        contextWindow: 42_496,
      },
    ],
  });

  assert.equal(await writeCatalogAtomic(target, catalog), target);
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), catalog);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(path.dirname(target)), ["models.json"]);
});

test("guarded catalog rollback preserves a concurrent catalog edit", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lmstudio-catalog-cas-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const target = path.join(directory, "models.json");
  const published = buildCodexCatalog({
    bundledCatalog: { models: [donor] },
    discoveredModels: [
      {
        id: "qwen/published",
        displayName: "Published",
        type: "llm",
        contextWindow: 32_768,
      },
    ],
  });
  const replacement = buildCodexCatalog({
    bundledCatalog: { models: [donor] },
    discoveredModels: [
      {
        id: "qwen/previous",
        displayName: "Previous",
        type: "llm",
        contextWindow: 32_768,
      },
    ],
  });
  const concurrent = buildCodexCatalog({
    bundledCatalog: { models: [donor] },
    discoveredModels: [
      {
        id: "qwen/concurrent",
        displayName: "Concurrent",
        type: "llm",
        contextWindow: 32_768,
      },
    ],
  });

  const firstReceipt = await writeCatalogAtomicWithReceipt(target, published);
  await replaceCatalogAtomicIfCurrent(target, replacement, {
    expectedCatalog: published,
    expectedSnapshot: firstReceipt.snapshot,
  });
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), replacement);

  const secondReceipt = await writeCatalogAtomicWithReceipt(target, published);
  await writeFile(target, `${JSON.stringify(concurrent, null, 2)}\n`, { mode: 0o600 });
  await chmod(target, 0o600);
  await assert.rejects(
    replaceCatalogAtomicIfCurrent(target, replacement, {
      expectedCatalog: published,
      expectedSnapshot: secondReceipt.snapshot,
    }),
    (error) => error.code === "CATALOG_CHANGED_CONCURRENTLY",
  );
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), concurrent);
  assert.deepEqual(await readdir(directory), ["models.json"]);
});
