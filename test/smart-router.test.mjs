import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AFFINITY_MAX_ENTRIES,
  AFFINITY_TTL_MS,
  AUTO_MODEL_DISPLAY_NAME,
  AUTO_MODEL_SLUG,
  SMART_ROUTING_REASON_CODES,
  SMART_ROUTING_STRATEGY,
  SmartRouterError,
  createSmartRouter,
  estimateInputTokens,
  extractLatestUserText,
  hasUnsupportedLocalInput,
  scoreRequestComplexity,
} from "../src/smart-router.mjs";

const FALLBACK_MODEL = "gpt-5.6-sol";
const LOCAL_MODEL = "lmstudio/qwen/local";

function nativeRoute(overrides = {}) {
  return {
    kind: "native-openai",
    slug: FALLBACK_MODEL,
    upstreamModel: FALLBACK_MODEL,
    ...overrides,
  };
}

function localRoute(overrides = {}) {
  return {
    kind: "external",
    slug: LOCAL_MODEL,
    upstreamModel: "qwen/local",
    providerKind: "lmstudio-responses",
    contextWindow: 32_768,
    toolsEnabled: false,
    ...overrides,
  };
}

function autoRoute(overrides = {}) {
  return {
    kind: "smart-router",
    slug: AUTO_MODEL_SLUG,
    strategy: SMART_ROUTING_STRATEGY,
    localModel: LOCAL_MODEL,
    fallbackModel: FALLBACK_MODEL,
    maxLocalInputTokens: 16_384,
    complexityThreshold: 3,
    ...overrides,
  };
}

function unknownModel(model) {
  return Object.assign(new Error(`Unknown model ${model}`), {
    code: "UNKNOWN_MODEL",
    statusCode: 400,
  });
}

function fixture({ local = localRoute(), fallback = nativeRoute(), now, onDecision } = {}) {
  const routes = new Map([[FALLBACK_MODEL, fallback]]);
  if (local) routes.set(LOCAL_MODEL, local);
  const registry = {
    resolve(model) {
      if (!routes.has(model)) throw unknownModel(model);
      return routes.get(model);
    },
  };
  return {
    routes,
    registry,
    router: createSmartRouter({ registry, now, onDecision }),
  };
}

function select(router, requestBody, route = autoRoute()) {
  return router.select({ requestBody, path: "/v1/responses", autoRoute: route });
}

test("exports the fixed Auto contract and stable initial reason codes", () => {
  assert.equal(AUTO_MODEL_SLUG, "pickermux/auto");
  assert.equal(AUTO_MODEL_DISPLAY_NAME, "Auto – Smart Routing");
  assert.equal(SMART_ROUTING_STRATEGY, "local-first-v1");
  assert.equal(AFFINITY_TTL_MS, 30 * 60 * 1_000);
  assert.equal(AFFINITY_MAX_ENTRIES, 256);
  assert.deepEqual(SMART_ROUTING_REASON_CODES, [
    "local_eligible",
    "local_unavailable",
    "unsupported_local_input",
    "local_tools_uncertified",
    "high_reasoning_requested",
    "local_context_exceeded",
    "complexity_threshold",
    "previous_response_without_affinity",
    "affinity_local",
    "affinity_fallback",
    "affinity_local_became_ineligible",
  ]);
  assert.equal(Object.isFrozen(SMART_ROUTING_REASON_CODES), true);
});

test("simple compatible text selects the exact local route", () => {
  const { router, routes } = fixture();
  const decision = select(router, { input: "Summarize this paragraph." });

  assert.equal(decision.route, routes.get(LOCAL_MODEL));
  assert.equal(decision.selectedModel, LOCAL_MODEL);
  assert.equal(decision.reason, "local_eligible");
  assert.equal(decision.affinity, "none");
  assert.equal(decision.complexityScore, 0);
  assert.ok(decision.estimatedInputTokens > 0);
  assert.equal(Object.isFrozen(decision), true);
});

test("an unavailable exact local route selects the native fallback", () => {
  const { router, routes } = fixture({ local: null });
  const decision = select(router, { input: "Hello" });
  assert.equal(decision.route, routes.get(FALLBACK_MODEL));
  assert.equal(decision.reason, "local_unavailable");
});

test("hard eligibility failures use the required precedence", async (t) => {
  await t.test("unsupported modality precedes tools, reasoning, context, and complexity", () => {
    const { router } = fixture();
    const decision = select(router, {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }],
      }],
      tools: [{ type: "function", name: "inspect" }],
      tool_choice: "required",
      reasoning: { effort: "ultra" },
    });
    assert.equal(decision.reason, "unsupported_local_input");
  });

  await t.test("uncertified tools precede high reasoning", () => {
    const { router } = fixture();
    const decision = select(router, {
      input: "Use a tool",
      tools: [{ type: "function", name: "inspect" }],
      tool_choice: "required",
      reasoning: { effort: "high" },
    });
    assert.equal(decision.reason, "local_tools_uncertified");
  });

  await t.test("high reasoning precedes context and complexity", () => {
    const { router } = fixture({ local: localRoute({ contextWindow: 1_024 }) });
    for (const effort of ["high", "xhigh", "max", "ultra"]) {
      const decision = select(router, {
        input: `architecture ${"x".repeat(4_000)}`,
        reasoning: { effort },
      });
      assert.equal(decision.reason, "high_reasoning_requested");
    }
  });

  await t.test("none through medium remain eligible", () => {
    for (const effort of [undefined, "none", "minimal", "low", "medium"]) {
      const { router } = fixture();
      const reasoning = effort === undefined ? undefined : { effort };
      assert.equal(
        select(router, { input: "Short request", reasoning }).reason,
        "local_eligible",
      );
    }
  });
});

test("non-text content selects fallback only for user input", () => {
  for (const type of [
    "input_image",
    "input_audio",
    "input_file",
    "input_attachment",
    "input_video",
  ]) {
    const { router } = fixture();
    const decision = select(router, {
      input: [{
        type: "message",
        role: "user",
        content: [{ type, value: "opaque" }],
      }],
    });
    assert.equal(decision.reason, "unsupported_local_input", type);
  }

  const compatibleHistory = {
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "input_image", image_url: "assistant-history" }],
      },
      { type: "function_call", name: "inspect", arguments: "{}" },
      { type: "function_call_output", output: "input_file is ordinary text here" },
      { type: "tool_result", content: [{ type: "input_audio" }] },
      { type: "reasoning", summary: "history" },
    ],
  };
  assert.equal(hasUnsupportedLocalInput(compatibleHistory), false);
  assert.equal(
    select(
      fixture({ local: localRoute({ toolsEnabled: true }) }).router,
      compatibleHistory,
    ).reason,
    "local_eligible",
  );
});

test("only required tool turns need current exact route certification", () => {
  const optionalCatalog = {
    input: "Inspect the workspace",
    tools: [{ type: "function", name: "inspect", parameters: {} }],
  };
  for (const toolChoice of [undefined, "auto", "none"]) {
    const requestBody = {
      ...optionalCatalog,
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    };
    assert.equal(select(fixture().router, requestBody).reason, "local_eligible");
  }

  const requiredTool = { ...optionalCatalog, tool_choice: "required" };
  assert.equal(select(fixture().router, requiredTool).reason, "local_tools_uncertified");
  assert.equal(
    select(fixture().router, {
      input: [{ type: "function_call_output", call_id: "call-1", output: "done" }],
      tool_choice: "none",
    }).reason,
    "local_tools_uncertified",
  );
  assert.equal(
    select(
      fixture({ local: localRoute({ toolsEnabled: true }) }).router,
      requiredTool,
    ).reason,
    "local_eligible",
  );
});

test("text-only Auto ignores optional schemas that the proxy will strip", () => {
  const requestBody = {
    input: "Reply with a short greeting.",
    tools: Array.from({ length: 226 }, (_unused, index) => ({
      type: "function",
      name: `tool_${index}`,
      description: "x".repeat(256),
      parameters: { type: "object", properties: {} },
    })),
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
  const constrainedAutoRoute = autoRoute({ maxLocalInputTokens: 1_024 });
  const textOnly = select(
    fixture().router,
    requestBody,
    constrainedAutoRoute,
  );
  assert.equal(textOnly.reason, "local_eligible");
  assert.ok(textOnly.estimatedInputTokens < 1_024);

  const certified = select(
    fixture({ local: localRoute({ toolsEnabled: true }) }).router,
    requestBody,
    constrainedAutoRoute,
  );
  assert.equal(certified.reason, "local_context_exceeded");
  assert.ok(certified.estimatedInputTokens > 1_024);
});

test("context estimation is deterministic and respects both configured and measured limits", () => {
  const requestBody = {
    instructions: "Be concise",
    input: "hello",
    tools: [{ type: "function", name: "noop" }],
    metadata: { ignored: "x".repeat(20_000) },
  };
  const serialized = JSON.stringify({
    instructions: requestBody.instructions,
    input: requestBody.input,
    tools: requestBody.tools,
  });
  assert.equal(
    estimateInputTokens(requestBody),
    Math.ceil(Buffer.byteLength(serialized, "utf8") / 3),
  );
  assert.equal(estimateInputTokens({}), 1);

  const largeInput = "x".repeat(4_000);
  const configuredLimit = autoRoute({ maxLocalInputTokens: 1_024, complexityThreshold: 10 });
  assert.equal(
    select(fixture().router, { input: largeInput }, configuredLimit).reason,
    "local_context_exceeded",
  );

  const smallContext = fixture({ local: localRoute({ contextWindow: 1_024 }) });
  assert.equal(
    select(
      smallContext.router,
      { input: "x".repeat(2_500) },
      autoRoute({ maxLocalInputTokens: 16_384, complexityThreshold: 10 }),
    ).reason,
    "local_context_exceeded",
  );
  assert.equal(
    select(
      fixture({ local: localRoute({ contextWindow: 0 }) }).router,
      { input: "short" },
    ).reason,
    "local_context_exceeded",
  );
});

test("hard fallbacks short-circuit expensive estimation and scoring work", () => {
  const requestBody = {
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "opaque" }],
    }],
    get instructions() {
      throw new Error("instructions must not be serialized after a hard fallback");
    },
  };
  const decision = select(fixture().router, requestBody);
  assert.equal(decision.reason, "unsupported_local_input");
  assert.equal(decision.estimatedInputTokens, null);
  assert.equal(decision.complexityScore, null);
});

test("complexity scoring uses only the latest user-authored text", () => {
  assert.equal(scoreRequestComplexity({ input: "x".repeat(3_999) }), 0);
  assert.equal(scoreRequestComplexity({ input: "x".repeat(4_000) }), 1);
  assert.equal(scoreRequestComplexity({ input: "x".repeat(12_000) }), 2);
  assert.equal(
    scoreRequestComplexity({
      input: Array.from({ length: 200 }, () => "line").join("\n"),
    }),
    1,
  );
  assert.equal(scoreRequestComplexity({ input: "Please perform a security review." }), 2);
  assert.equal(scoreRequestComplexity({ input: "Bitte analysiere die Parallelität." }), 2);
  assert.equal(
    scoreRequestComplexity({ input: "architecture migration deadlock entire repository" }),
    2,
  );
  assert.equal(scoreRequestComplexity({ input: "microarchitecture" }), 0);

  const history = {
    input: [
      { type: "message", role: "system", content: "entire repository" },
      { type: "message", role: "developer", content: "security review" },
      { type: "message", role: "user", content: "old architecture request" },
      { type: "message", role: "assistant", content: "race condition" },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "latest" },
          { type: "text", text: "simple request" },
        ],
      },
      { type: "function_call_output", output: "production incident" },
    ],
  };
  assert.equal(extractLatestUserText(history), "latest\nsimple request");
  assert.equal(scoreRequestComplexity(history), 0);
  assert.equal(
    scoreRequestComplexity({
      input: [{ type: "message", role: "assistant", content: "architecture" }],
    }),
    0,
  );
});

test("newline-heavy scoring and oversized affinity keys stay allocation-bounded", () => {
  const newlineHeavy = "\n".repeat(1_000_000);
  assert.equal(scoreRequestComplexity({ input: newlineHeavy }), 3);

  const { router } = fixture();
  const decision = select(router, {
    input: "easy",
    prompt_cache_key: "😀".repeat(100_000),
  });
  assert.equal(decision.affinity, "none");
  assert.equal(router.affinitySize, 0);
});

test("complexity below threshold selects local and equality selects fallback", () => {
  const requestBody = { input: "Review the architecture." };
  assert.equal(scoreRequestComplexity(requestBody), 2);
  assert.equal(
    select(
      fixture().router,
      requestBody,
      autoRoute({ complexityThreshold: 3 }),
    ).reason,
    "local_eligible",
  );
  assert.equal(
    select(
      fixture().router,
      requestBody,
      autoRoute({ complexityThreshold: 2 }),
    ).reason,
    "complexity_threshold",
  );
});

test("selection never reads transport or credential metadata", () => {
  let forbiddenReads = 0;
  const local = localRoute();
  for (const property of ["baseUrl", "credentialEnv", "credentialKeychain"]) {
    Object.defineProperty(local, property, {
      enumerable: true,
      get() {
        forbiddenReads += 1;
        throw new Error(`${property} must not be read during selection`);
      },
    });
  }
  const fallback = nativeRoute();
  Object.defineProperty(fallback, "baseUrl", {
    enumerable: true,
    get() {
      forbiddenReads += 1;
      throw new Error("native destination must not be read during selection");
    },
  });
  const { router } = fixture({ local, fallback });
  assert.equal(select(router, { input: "local text" }).selectedModel, LOCAL_MODEL);
  assert.equal(forbiddenReads, 0);
});

test("local affinity is re-evaluated and becomes one-way fallback when ineligible", () => {
  const { router, routes } = fixture();
  const first = select(router, { input: "short", prompt_cache_key: "thread-local" });
  assert.equal(first.reason, "local_eligible");
  assert.equal(first.affinity, "miss");

  const pinned = select(router, { input: "still short", prompt_cache_key: "thread-local" });
  assert.equal(pinned.reason, "affinity_local");
  assert.equal(pinned.affinity, "local");

  routes.delete(LOCAL_MODEL);
  const moved = select(router, { input: "still short", prompt_cache_key: "thread-local" });
  assert.equal(moved.reason, "affinity_local_became_ineligible");
  assert.equal(moved.selectedModel, FALLBACK_MODEL);
  assert.equal(moved.affinity, "local_became_ineligible");

  routes.set(LOCAL_MODEL, localRoute());
  const oneWay = select(router, { input: "short again", prompt_cache_key: "thread-local" });
  assert.equal(oneWay.reason, "affinity_fallback");
  assert.equal(oneWay.selectedModel, FALLBACK_MODEL);
});

test("a local affinity also moves to fallback when request eligibility changes", () => {
  const { router } = fixture();
  select(router, { input: "short", prompt_cache_key: "thread-capability" });
  const moved = select(router, {
    input: "use tools",
    tools: [{ type: "function", name: "inspect" }],
    tool_choice: "required",
    prompt_cache_key: "thread-capability",
  });
  assert.equal(moved.reason, "affinity_local_became_ineligible");
  assert.equal(moved.selectedModel, FALLBACK_MODEL);
});

test("fallback affinity never moves back to local before its fixed TTL expires", () => {
  let clock = 1_000;
  const { router } = fixture({ now: () => clock });
  const first = select(router, {
    input: "hard turn",
    reasoning: { effort: "ultra" },
    prompt_cache_key: "thread-fallback",
  });
  assert.equal(first.reason, "high_reasoning_requested");

  clock += AFFINITY_TTL_MS - 1;
  assert.equal(
    select(router, { input: "easy", prompt_cache_key: "thread-fallback" }).reason,
    "affinity_fallback",
  );

  clock += 1;
  const expired = select(router, { input: "easy", prompt_cache_key: "thread-fallback" });
  assert.equal(expired.reason, "local_eligible");
  assert.equal(expired.selectedModel, LOCAL_MODEL);
});

test("expired affinity is evicted and the LRU store never exceeds its bound", () => {
  let clock = 10_000;
  const { router } = fixture({ now: () => clock });
  select(router, { input: "easy", prompt_cache_key: "expired-a" });
  select(router, { input: "easy", prompt_cache_key: "expired-b" });
  assert.equal(router.affinitySize, 2);
  clock += AFFINITY_TTL_MS;
  assert.equal(router.affinitySize, 0);

  for (let index = 0; index < AFFINITY_MAX_ENTRIES + 44; index += 1) {
    select(router, { input: "easy", prompt_cache_key: `bounded-${index}` });
  }
  assert.equal(router.affinitySize, AFFINITY_MAX_ENTRIES);
  assert.equal(
    select(router, { input: "easy", prompt_cache_key: "bounded-0" }).reason,
    "local_eligible",
  );
  assert.equal(
    select(
      router,
      { input: "easy", prompt_cache_key: `bounded-${AFFINITY_MAX_ENTRIES + 43}` },
    ).reason,
    "affinity_local",
  );
  assert.equal(router.affinitySize, AFFINITY_MAX_ENTRIES);
});

test("affinity keys are validated, hashed, memory-only, and absent from diagnostics", () => {
  const observed = [];
  const { router } = fixture({ onDecision: (decision) => observed.push(decision) });
  const rawKey = "private-affinity-value-do-not-log";
  const hash = createHash("sha256").update(rawKey).digest("hex");
  const decision = select(router, { input: "easy", prompt_cache_key: rawKey });
  assert.equal(router.affinitySize, 1);
  assert.doesNotMatch(JSON.stringify(decision), new RegExp(rawKey, "u"));
  assert.doesNotMatch(JSON.stringify(decision), new RegExp(hash, "u"));
  assert.doesNotMatch(JSON.stringify(observed), new RegExp(rawKey, "u"));
  assert.doesNotMatch(JSON.stringify(observed), new RegExp(hash, "u"));
  assert.equal(Object.hasOwn(observed[0], "route"), false);

  for (const invalid of ["", "control\nvalue", "control\u0085value", "x".repeat(1_025), 123]) {
    const isolated = fixture().router;
    const result = select(isolated, { input: "easy", prompt_cache_key: invalid });
    assert.equal(result.affinity, "none");
    assert.equal(isolated.affinitySize, 0);
  }

  const unicodeKeyRouter = fixture().router;
  assert.equal(
    select(unicodeKeyRouter, {
      input: "easy",
      prompt_cache_key: "😀".repeat(1_024),
    }).affinity,
    "miss",
  );
  assert.equal(unicodeKeyRouter.affinitySize, 1);
});

test("previous_response_id without valid affinity pins the request to fallback", () => {
  const { router } = fixture();
  const first = select(router, {
    input: "easy",
    previous_response_id: "resp_provider_specific",
    prompt_cache_key: "thread-previous",
  });
  assert.equal(first.reason, "previous_response_without_affinity");
  assert.equal(first.selectedModel, FALLBACK_MODEL);
  assert.equal(first.affinity, "miss");
  assert.equal(
    select(router, { input: "easy", prompt_cache_key: "thread-previous" }).reason,
    "affinity_fallback",
  );

  const withoutUsableKey = fixture().router;
  const unpinned = select(withoutUsableKey, {
    input: "easy",
    previous_response_id: "resp_provider_specific",
    prompt_cache_key: "invalid\nkey",
  });
  assert.equal(unpinned.reason, "previous_response_without_affinity");
  assert.equal(unpinned.affinity, "none");
  assert.equal(withoutUsableKey.affinitySize, 0);

  assert.equal(
    select(fixture().router, {
      input: "easy",
      previous_response_id: 42,
    }).reason,
    "previous_response_without_affinity",
  );
});

test("invalid, recursive, ambiguous, and non-exact routes fail closed", () => {
  assert.throws(
    () => select(fixture().router, { input: "x" }, autoRoute({ localModel: AUTO_MODEL_SLUG })),
    SmartRouterError,
  );
  assert.throws(
    () => select(fixture().router, { input: "x" }, autoRoute({ localModel: "pickermux/Auto" })),
    SmartRouterError,
  );
  assert.throws(
    () => select(fixture().router, { input: "x" }, autoRoute({ fallbackModel: AUTO_MODEL_SLUG })),
    SmartRouterError,
  );
  assert.throws(
    () => select(fixture().router, { input: "x" }, autoRoute({ strategy: "unknown" })),
    SmartRouterError,
  );
  assert.throws(
    () => select(fixture().router, { input: "x" }, autoRoute({ maxLocalInputTokens: 1_023 })),
    SmartRouterError,
  );
  assert.throws(
    () => select(fixture().router, { input: "x" }, autoRoute({ complexityThreshold: 11 })),
    SmartRouterError,
  );
  assert.throws(
    () => select(fixture({ fallback: null }).router, { input: "x" }),
    (error) => error instanceof SmartRouterError && error.code === "INVALID_ROUTE",
  );
  assert.throws(
    () => select(fixture({ fallback: nativeRoute({ slug: "wrong-native" }) }).router, { input: "x" }),
    SmartRouterError,
  );
  assert.throws(
    () =>
      select(
        fixture({
          fallback: nativeRoute({ upstreamModel: "gpt-wrong-upstream" }),
        }).router,
        { input: "x" },
      ),
    SmartRouterError,
  );
  assert.throws(
    () => select(fixture({ local: localRoute({ slug: "wrong-local" }) }).router, { input: "x" }),
    SmartRouterError,
  );
  assert.throws(
    () => select(fixture({ local: localRoute({ kind: "smart-router" }) }).router, { input: "x" }),
    SmartRouterError,
  );
});

test("decision observers receive only safe fields and cannot alter selection", () => {
  let observed;
  const { router } = fixture({
    onDecision(decision) {
      observed = decision;
      throw new Error("observer failure");
    },
  });
  const decision = select(router, { input: "safe" });
  assert.equal(decision.selectedModel, LOCAL_MODEL);
  assert.deepEqual(observed, {
    selectedModel: LOCAL_MODEL,
    reason: "local_eligible",
    estimatedInputTokens: decision.estimatedInputTokens,
    complexityScore: 0,
    affinity: "none",
  });
  assert.equal(Object.isFrozen(observed), true);
});
