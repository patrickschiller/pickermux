import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BRIDGE_DEFAULTS,
  isPrivateNetworkHost,
  loadBridgeConfig,
  validateBridgeConfig,
} from "../src/bridge-config.mjs";
import { AUTO_MODEL_SLUG } from "../src/smart-routing-constants.mjs";

function validConfig() {
  return {
    schemaVersion: 2,
    bridge: {
      host: "127.0.0.1",
      port: 4210,
      providerId: "model_bridge",
      defaultModel: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      limits: {
        requestBodyBytes: 2_000_000,
        responseHeaderBytes: 64_000,
        upstreamHeadersTimeoutMs: 45_000,
        streamIdleTimeoutMs: 180_000,
        upstreamTotalTimeoutMs: 600_000,
      },
    },
    providers: [
      {
        id: "lmstudio",
        kind: "lmstudio-responses",
        baseUrl: "http://127.0.0.1:1234/v1/",
        allowPrivateNetwork: true,
        models: [
          {
            id: "qwen/qwen3.8-27b",
            slug: "lmstudio/qwen/qwen3.8-27b",
            displayName: "Qwen 3.8 27B",
            type: "llm",
            contextWindow: 42_496,
            reasoningEffort: "xhigh",
            reasoningEfforts: ["none", "low", "medium", "xhigh"],
          },
        ],
      },
      {
        id: "vendor",
        kind: "openai-responses",
        baseUrl: "https://api.vendor.example/v1",
        allowPrivateNetwork: false,
        credentialEnv: "VENDOR_API_KEY",
        models: [
          {
            id: "reasoning-v2",
            slug: "vendor/reasoning-v2",
            displayName: "Vendor Reasoning v2",
          },
        ],
      },
    ],
  };
}

function enabledSmartRouting(overrides = {}) {
  return {
    enabled: true,
    localModel: "lmstudio/qwen/qwen3.8-27b",
    fallbackModel: "gpt-5.6-sol",
    maxLocalInputTokens: 18_000,
    complexityThreshold: 3,
    ...overrides,
  };
}

test("normalizes a strict schema-v2 bridge config without secrets", () => {
  const normalized = validateBridgeConfig(validConfig());
  assert.equal(normalized.schemaVersion, 2);
  assert.deepEqual(normalized.bridge, validConfig().bridge);
  assert.equal(normalized.providers[0].baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(normalized.providers[1].credentialEnv, "VENDOR_API_KEY");
  assert.deepEqual(normalized.providers[0].discovery, {
    mode: "allowlist",
    maxModels: 64,
  });
  assert.deepEqual(normalized.smartRouting, {
    enabled: false,
    fallbackModel: "gpt-5.6-sol",
    maxLocalInputTokens: 16_384,
    complexityThreshold: 3,
  });
  assert.equal(JSON.stringify(normalized).includes("Bearer "), false);
});

test("normalizes omitted, disabled, and enabled smart routing without mutation", () => {
  const omitted = validConfig();
  const omittedBefore = structuredClone(omitted);
  const normalizedOmitted = validateBridgeConfig(omitted);
  assert.deepEqual(omitted, omittedBefore);
  assert.notEqual(normalizedOmitted, omitted);
  assert.notEqual(normalizedOmitted.bridge, omitted.bridge);
  assert.notEqual(normalizedOmitted.providers, omitted.providers);
  assert.deepEqual(normalizedOmitted.smartRouting, {
    enabled: false,
    fallbackModel: omitted.bridge.defaultModel,
    maxLocalInputTokens: 16_384,
    complexityThreshold: 3,
  });

  const disabled = validConfig();
  disabled.smartRouting = { enabled: false };
  assert.deepEqual(validateBridgeConfig(disabled).smartRouting, {
    enabled: false,
    fallbackModel: disabled.bridge.defaultModel,
    maxLocalInputTokens: 16_384,
    complexityThreshold: 3,
  });

  const enabled = validConfig();
  enabled.smartRouting = enabledSmartRouting({ fallbackModel: undefined });
  const enabledBefore = structuredClone(enabled);
  assert.deepEqual(validateBridgeConfig(enabled).smartRouting, {
    enabled: true,
    localModel: "lmstudio/qwen/qwen3.8-27b",
    fallbackModel: enabled.bridge.defaultModel,
    maxLocalInputTokens: 18_000,
    complexityThreshold: 3,
  });
  assert.deepEqual(enabled, enabledBefore);
});

test("rejects malformed smart-routing objects and unknown properties", () => {
  for (const smartRouting of [null, [], "enabled"]) {
    const config = validConfig();
    config.smartRouting = smartRouting;
    assert.throws(() => validateBridgeConfig(config), /must be a JSON object/u);
  }

  const unknown = validConfig();
  unknown.smartRouting = { enabled: false, strategy: "local-first-v2" };
  assert.throws(
    () => validateBridgeConfig(unknown),
    /unsupported property strategy/u,
  );

  const nonBoolean = validConfig();
  nonBoolean.smartRouting = { enabled: "true" };
  assert.throws(() => validateBridgeConfig(nonBoolean), /must be a boolean/u);
});

test("requires an exact configured LM Studio local model when smart routing is enabled", () => {
  const missing = validConfig();
  missing.smartRouting = { enabled: true };
  assert.throws(() => validateBridgeConfig(missing), /localModel is required/u);

  for (const localModel of ["qwen", "lmstudio/", AUTO_MODEL_SLUG]) {
    const config = validConfig();
    config.smartRouting = enabledSmartRouting({ localModel });
    assert.throws(
      () => validateBridgeConfig(config),
      /provider-namespaced|must not be pickermux\/auto/u,
    );
  }

  for (const localModel of ["missing/model", "vendor/reasoning-v2"]) {
    const config = validConfig();
    config.smartRouting = enabledSmartRouting({ localModel });
    assert.throws(
      () => validateBridgeConfig(config),
      /configured lmstudio-responses provider/u,
    );
  }

  const absentFromAllowlist = validConfig();
  absentFromAllowlist.smartRouting = enabledSmartRouting({
    localModel: "lmstudio/not-allowlisted",
  });
  assert.throws(
    () => validateBridgeConfig(absentFromAllowlist),
    /not in provider lmstudio's allowlist/u,
  );

  const loaded = validConfig();
  loaded.providers[0].discovery = { mode: "loaded", maxModels: 32 };
  loaded.smartRouting = enabledSmartRouting({
    localModel: "lmstudio/not-currently-loaded",
  });
  assert.equal(
    validateBridgeConfig(loaded).smartRouting.localModel,
    "lmstudio/not-currently-loaded",
  );
});

test("validates the native smart-routing fallback even while disabled", () => {
  for (const fallbackModel of ["", "lmstudio/qwen", AUTO_MODEL_SLUG]) {
    const config = validConfig();
    config.smartRouting = { enabled: false, fallbackModel };
    assert.throws(
      () => validateBridgeConfig(config),
      /non-empty single line|native model slug|must not be pickermux\/auto/u,
    );
  }

  const sameCandidate = validConfig();
  sameCandidate.smartRouting = enabledSmartRouting({
    fallbackModel: "lmstudio/qwen/qwen3.8-27b",
  });
  assert.throws(
    () => validateBridgeConfig(sameCandidate),
    /native model slug|must not equal/u,
  );
});

test("validates bounded smart-routing numeric controls even while disabled", () => {
  for (const maxLocalInputTokens of [1_023, 1_048_577, 1.5]) {
    const config = validConfig();
    config.smartRouting = { enabled: false, maxLocalInputTokens };
    assert.throws(
      () => validateBridgeConfig(config),
      /maxLocalInputTokens.*between 1024 and 1048576/u,
    );
  }

  for (const complexityThreshold of [0, 11, 1.5]) {
    const config = validConfig();
    config.smartRouting = { enabled: false, complexityThreshold };
    assert.throws(
      () => validateBridgeConfig(config),
      /complexityThreshold.*between 1 and 10/u,
    );
  }
});

test("reserves the synthetic Auto slug from configured providers", () => {
  for (const slug of [AUTO_MODEL_SLUG, "pickermux/Auto", "PICKERMUX/AUTO"]) {
    const config = validConfig();
    config.providers = [
      {
        id: "pickermux",
        kind: "lmstudio-responses",
        baseUrl: "http://127.0.0.1:1234/v1",
        allowPrivateNetwork: true,
        models: [
          {
            id: "auto",
            slug,
            displayName: "Collision",
          },
        ],
      },
    ];
    assert.throws(
      () => validateBridgeConfig(config),
      /reserved by PickerMux/u,
      slug,
    );
  }
});

test("loaded smart-routing candidates use discoverable LM Studio model ids", () => {
  for (const localModel of [
    "lmstudio/contains space",
    "lmstudio/*",
    "lmstudio/line\u2028separator",
  ]) {
    const config = validConfig();
    config.providers = [
      {
        ...config.providers[0],
        discovery: { mode: "loaded", maxModels: 32 },
        models: [],
      },
    ];
    config.smartRouting = {
      enabled: false,
      localModel,
    };
    assert.throws(
      () => validateBridgeConfig(config),
      /valid loaded LM Studio model id/u,
      localModel,
    );
  }
});

test("accepts a Keychain reference and rejects ambiguous credential sources", () => {
  const keychain = validConfig();
  delete keychain.providers[1].credentialEnv;
  keychain.providers[1].credentialKeychain = true;
  const normalized = validateBridgeConfig(keychain);
  assert.equal(normalized.providers[1].credentialKeychain, true);
  assert.equal(normalized.providers[1].credentialEnv, undefined);

  const ambiguous = validConfig();
  ambiguous.providers[1].credentialKeychain = true;
  assert.throws(
    () => validateBridgeConfig(ambiguous),
    /mutually exclusive/u,
  );

  const disabled = validConfig();
  delete disabled.providers[1].credentialEnv;
  disabled.providers[1].credentialKeychain = false;
  assert.throws(
    () => validateBridgeConfig(disabled),
    /must be true/u,
  );
});

test("allows bounded loaded-model discovery only for LM Studio", () => {
  const loaded = validConfig();
  loaded.providers = [
    {
      ...loaded.providers[0],
      discovery: { mode: "loaded", maxModels: 12 },
      models: [],
    },
  ];
  const normalized = validateBridgeConfig(loaded);
  assert.deepEqual(normalized.providers[0].discovery, {
    mode: "loaded",
    maxModels: 12,
  });
  assert.deepEqual(normalized.providers[0].models, []);

  const generic = validConfig();
  generic.providers = [
    {
      ...generic.providers[1],
      discovery: { mode: "loaded" },
      models: [],
    },
  ];
  assert.throws(
    () => validateBridgeConfig(generic),
    /only for lmstudio-responses/u,
  );

  for (const maxModels of [0, 65, 1.5]) {
    const invalid = validConfig();
    invalid.providers[0].discovery = { mode: "loaded", maxModels };
    assert.throws(() => validateBridgeConfig(invalid), /between 1 and 64/u);
  }

  const emptyAllowlist = validConfig();
  emptyAllowlist.providers[0].models = [];
  assert.throws(
    () => validateBridgeConfig(emptyAllowlist),
    /at least one model/u,
  );
});

test("fills secure bridge defaults while leaving the port configurable", () => {
  const config = validConfig();
  config.bridge = { port: 4310 };
  const normalized = validateBridgeConfig(config);
  assert.deepEqual(normalized.bridge, {
    host: BRIDGE_DEFAULTS.host,
    port: 4310,
    providerId: BRIDGE_DEFAULTS.providerId,
    defaultModel: BRIDGE_DEFAULTS.defaultModel,
    reasoningEffort: BRIDGE_DEFAULTS.reasoningEffort,
    limits: { ...BRIDGE_DEFAULTS.limits },
  });
});

test("accepts an account-visible native fallback and supported reasoning effort", () => {
  const config = validConfig();
  config.bridge = {
    defaultModel: "gpt-5.4",
    reasoningEffort: "high",
  };
  const normalized = validateBridgeConfig(config);
  assert.equal(normalized.bridge.defaultModel, "gpt-5.4");
  assert.equal(normalized.bridge.reasoningEffort, "high");
});

test("recognizes loopback, RFC1918, Tailscale and local network names", () => {
  for (const host of [
    "127.0.0.1",
    "10.20.30.40",
    "172.16.0.1",
    "192.168.1.5",
    "100.100.100.100",
    "::1",
    "fd00::1",
    "mac-mini.local",
    "mac-mini.tailnet.ts.net",
  ]) {
    assert.equal(isPrivateNetworkHost(host), true, host);
  }
  assert.equal(isPrivateNetworkHost("api.openai.com"), false);
  assert.equal(isPrivateNetworkHost("0.0.0.0"), false);
});

test("rejects configurable native routing and invalid bridge identity or fallback values", () => {
  for (const bridge of [
    { host: "0.0.0.0" },
    { providerId: "another_bridge" },
  ]) {
    const config = validConfig();
    config.bridge = bridge;
    assert.throws(() => validateBridgeConfig(config), /must be exactly/u);
  }

  for (const defaultModel of ["lmstudio/qwen", "GPT-5.4", "gpt-5.4/"]) {
    const config = validConfig();
    config.bridge = { defaultModel };
    assert.throws(() => validateBridgeConfig(config), /native model id/u);
  }

  const invalidEffort = validConfig();
  invalidEffort.bridge = { reasoningEffort: "turbo" };
  assert.throws(
    () => validateBridgeConfig(invalidEffort),
    /reasoningEffort is not supported/u,
  );

  const config = validConfig();
  config.native = { baseUrl: "https://attacker.example/v1" };
  assert.throws(
    () => validateBridgeConfig(config),
    /unsupported property native/u,
  );
});

test("permits private HTTP only after an explicit opt-in and public providers only over HTTPS", () => {
  const noOptIn = validConfig();
  noOptIn.providers = [
    {
      ...noOptIn.providers[0],
      allowPrivateNetwork: false,
    },
  ];
  assert.throws(() => validateBridgeConfig(noOptIn), /private network/u);

  const publicHttp = validConfig();
  publicHttp.providers = [
    {
      ...publicHttp.providers[1],
      baseUrl: "http://api.vendor.example/v1",
      allowPrivateNetwork: true,
    },
  ];
  assert.throws(() => validateBridgeConfig(publicHttp), /use HTTPS/u);
});

test("rejects URL credentials, query strings, fragments and secret-shaped properties", () => {
  for (const baseUrl of [
    "https://token@api.vendor.example/v1",
    "https://api.vendor.example/v1?key=value",
    "https://api.vendor.example/v1#fragment",
  ]) {
    const config = validConfig();
    config.providers = [{ ...config.providers[1], baseUrl }];
    assert.throws(() => validateBridgeConfig(config), /credentials|query string/u);
  }

  const inlineSecret = validConfig();
  inlineSecret.providers[1].apiKey = "not-allowed";
  assert.throws(() => validateBridgeConfig(inlineSecret), /unsupported property apiKey/u);

  const badEnv = validConfig();
  badEnv.providers[1].credentialEnv = "literal-secret-value!";
  assert.throws(() => validateBridgeConfig(badEnv), /environment variable name/u);
});

test("requires namespaced unique external slugs and unique upstream IDs per provider", () => {
  const wrongPrefix = validConfig();
  wrongPrefix.providers[0].models[0].slug = "other/qwen";
  assert.throws(() => validateBridgeConfig(wrongPrefix), /must start with lmstudio\//u);

  const duplicateSlug = validConfig();
  duplicateSlug.providers[1].models[0].slug =
    duplicateSlug.providers[0].models[0].slug;
  assert.throws(() => validateBridgeConfig(duplicateSlug), /must start with vendor\//u);

  const duplicateId = validConfig();
  duplicateId.providers[0].models.push({
    ...duplicateId.providers[0].models[0],
    slug: "lmstudio/alias",
  });
  assert.throws(() => validateBridgeConfig(duplicateId), /Duplicate upstream model id/u);
});

test("validates bounded limits and model capability metadata", () => {
  const invalidLimit = validConfig();
  invalidLimit.bridge.limits.requestBodyBytes = 0;
  assert.throws(() => validateBridgeConfig(invalidLimit), /between/u);

  const invertedTimeouts = validConfig();
  invertedTimeouts.bridge.limits.upstreamHeadersTimeoutMs = 500_000;
  invertedTimeouts.bridge.limits.upstreamTotalTimeoutMs = 100_000;
  assert.throws(() => validateBridgeConfig(invertedTimeouts), /must not be shorter/u);

  const embedding = validConfig();
  embedding.providers[0].models[0].type = "embedding";
  assert.throws(() => validateBridgeConfig(embedding), /must be llm/u);

  const unsupportedEffort = validConfig();
  unsupportedEffort.providers[0].models[0].reasoningEffort = "turbo";
  assert.throws(() => validateBridgeConfig(unsupportedEffort), /not supported/u);

  for (const effort of ["max", "ultra"]) {
    const unsupportedLmStudioEffort = validConfig();
    unsupportedLmStudioEffort.providers[0].models[0].reasoningEffort = effort;
    unsupportedLmStudioEffort.providers[0].models[0].reasoningEfforts = [effort];
    assert.throws(
      () => validateBridgeConfig(unsupportedLmStudioEffort),
      /not supported/u,
    );
  }

  const duplicateEfforts = validConfig();
  duplicateEfforts.providers[0].models[0].reasoningEfforts.push("xhigh");
  assert.throws(() => validateBridgeConfig(duplicateEfforts), /must not contain duplicates/u);

  const missingDefault = validConfig();
  missingDefault.providers[0].models[0].reasoningEfforts = ["low", "medium"];
  assert.throws(() => validateBridgeConfig(missingDefault), /must be included/u);
});

test("loads and validates a JSON bridge config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "model-bridge-config-"));
  const configPath = path.join(directory, "bridge.json");
  await writeFile(configPath, JSON.stringify(validConfig()), { mode: 0o600 });
  const loaded = await loadBridgeConfig(configPath);
  assert.equal(loaded.bridge.defaultModel, "gpt-5.6-sol");
  assert.equal(loaded.providers.length, 2);
});
