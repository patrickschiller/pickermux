import assert from "node:assert/strict";
import test from "node:test";
import { BodyCodecError } from "../src/body-codec.mjs";
import {
  projectWebSearchResponse,
  validateWebSearchRequest,
  WEB_SEARCH_CONTRACT_VERSION,
  WEB_SEARCH_PATH,
} from "../src/web-search-wire.mjs";

function request(fields = {}) {
  return { id: "search-session-example", model: "lmstudio/example-model", ...fields };
}

function assertInvalid(value) {
  assert.throws(() => validateWebSearchRequest(value), (error) => {
    assert.ok(error instanceof BodyCodecError);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "INVALID_WEB_SEARCH");
    assert.equal(error.message, "Web search request has an unsupported or invalid shape");
    assert.equal(error.cause, undefined);
    return true;
  });
}

test("standalone search preserves minimal and commands-only requests without transformation", () => {
  assert.equal(WEB_SEARCH_PATH, "/v1/alpha/search");
  assert.equal(WEB_SEARCH_CONTRACT_VERSION, 1);
  for (const value of [
    request(),
    request({ input: "Where is this year's tournament?" }),
    request({ commands: {} }),
    request({ commands: { open: [{ ref_id: "turn0search0" }] } }),
    request({ commands: { open: [{ ref_id: "https://example.com/source", lineno: 0 }] } }),
  ]) {
    const before = JSON.stringify(value);
    assert.equal(validateWebSearchRequest(value), value);
    assert.equal(JSON.stringify(value), before);
  }
});

test("standalone search accepts every documented command and optional field", () => {
  const value = request({
    commands: {
      search_query: [{ q: "Solheim Cup 2026 host", recency: 30, domains: ["example.com"] }],
      image_query: [{ q: "golf course" }],
      open: [{ ref_id: "turn0search0", lineno: 10 }],
      click: [{ ref_id: "turn0search0", id: 2 }],
      find: [{ ref_id: "turn0search0", pattern: "tournament" }],
      screenshot: [{ ref_id: "turn1view0", pageno: 0 }],
      finance: [{ ticker: "EXAMPLE", type: "equity", market: "USA" }],
      weather: [{ location: "Netherlands, Cromvoirt", start: "2026-09-13", duration: 7 }],
      sports: [{
        tool: "sports",
        fn: "schedule",
        league: "nfl",
        team: "EXA",
        opponent: "EXB",
        date_from: "2026-09-13",
        date_to: "2026-09-20",
        num_games: 2,
        locale: "en-US",
      }],
      time: [{ utc_offset: "+02:00" }],
      response_length: "short",
    },
    settings: {
      user_location: {
        type: "approximate",
        country: "NL",
        region: "North Brabant",
        city: "Cromvoirt",
        timezone: "Europe/Amsterdam",
      },
      search_context_size: "low",
      filters: { allowed_domains: ["example.com"], blocked_domains: ["blocked.example"] },
      image_settings: { max_results: 3, caption: true },
      allowed_callers: ["direct", "shell", "code_interpreter"],
      external_web_access: "live",
    },
    reasoning: { effort: "low", summary: "none", context: "current_turn" },
    max_output_tokens: 512,
  });
  assert.equal(validateWebSearchRequest(value), value);
});

test("standalone search accepts current visible text history with phase and metadata", () => {
  const value = request({ input: [
    {
      type: "message",
      id: "msg_example_user",
      role: "user",
      content: [{ type: "input_text", text: "Which tournament?" }],
      internal_chat_message_metadata_passthrough: {
        turn_id: "turn_example",
        create_time: 1_800_000_000.125,
        content_item_kinds: ["user_message"],
      },
    },
    {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "The Solheim Cup." }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Where is it this year?" }],
    },
  ] });
  assert.equal(validateWebSearchRequest(value), value);
});

test("standalone search preserves schema-valid empty values and safe unsigned integer boundaries", () => {
  const value = request({
    input: [],
    commands: {
      search_query: [{ q: "", recency: 0, domains: [] }],
      image_query: [],
      finance: [{ ticker: "EXAMPLE", type: "crypto", market: "" }],
      weather: [{ location: "", duration: Number.MAX_SAFE_INTEGER }],
      response_length: "medium",
    },
    max_output_tokens: 0,
  });
  assert.equal(validateWebSearchRequest(value), value);
  for (const external_web_access of [true, false, "cached", "indexed", "live"]) {
    validateWebSearchRequest(request({ settings: { external_web_access } }));
  }
  for (const effort of ["none", "persistent", "custom-effort"]) {
    validateWebSearchRequest(request({ reasoning: { effort } }));
  }
  validateWebSearchRequest(request({ commands: {
    search_query: Array.from({ length: 8 }, () => ({ q: "example" })),
    response_length: "short",
  } }));
});

test("standalone search rejects missing and malformed identifiers and request containers", () => {
  for (const value of [null, [], "example", 1, new Date(), {}, { id: "example" }, { model: "example" }]) {
    assertInvalid(value);
  }
  for (const field of ["id", "model"]) {
    for (const value of [null, undefined, 1, false, [], {}, "", "   "]) {
      assertInvalid(request({ [field]: value }));
    }
  }
});

test("standalone search rejects unknown fields at every admitted object boundary", () => {
  for (const fields of [
    { additional_tools: [] },
    { commands: { future_search: [] } },
    { commands: { search_query: [{ q: "example", credential: "example-secret" }] } },
    { commands: { sports: [{ fn: "schedule", league: "nfl", endpoint: "https://example.com" }] } },
    { settings: { future_setting: true } },
    { settings: { user_location: { type: "approximate", latitude: 0 } } },
    { settings: { filters: { extra: [] } } },
    { settings: { image_settings: { extra: true } } },
    { reasoning: { encrypted_content: "example-secret" } },
  ]) {
    assertInvalid(request(fields));
  }
});

test("standalone search rejects malformed command arrays, required fields and unsigned numbers", () => {
  for (const command of [
    "search_query", "image_query", "open", "click", "find", "screenshot", "finance", "weather", "sports", "time",
  ]) {
    for (const value of [null, {}, "example", [null], [[]], ["example"], [{}]]) {
      assertInvalid(request({ commands: { [command]: value } }));
    }
  }
  for (const value of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
    assertInvalid(request({ max_output_tokens: value }));
    assertInvalid(request({ commands: { search_query: [{ q: "example", recency: value }] } }));
    assertInvalid(request({ commands: { click: [{ ref_id: "turn0search0", id: value }] } }));
    assertInvalid(request({ settings: { image_settings: { max_results: value } } }));
  }
  assertInvalid(request({ commands: { search_query: [{ q: 1 }] } }));
  assertInvalid(request({ commands: { search_query: [{ q: "example", domains: [1] }] } }));
  assertInvalid(request({ commands: { open: [{ ref_id: { url: "https://example.com" } }] } }));
});

test("standalone search rejects unsupported enums and malformed optional values", () => {
  for (const fields of [
    { commands: null },
    { commands: [] },
    { commands: { response_length: "huge" } },
    { commands: { finance: [{ ticker: "EXAMPLE", type: "option" }] } },
    { commands: { sports: [{ fn: "scores", league: "nfl" }] } },
    { commands: { sports: [{ fn: "schedule", league: "future-league" }] } },
    { commands: { sports: [{ tool: "other", fn: "schedule", league: "nfl" }] } },
    { settings: null },
    { settings: { user_location: { type: "precise" } } },
    { settings: { search_context_size: "unlimited" } },
    { settings: { allowed_callers: ["browser"] } },
    { settings: { external_web_access: "automatic" } },
    { settings: { external_web_access: 1 } },
    { settings: { image_settings: { caption: "true" } } },
    { reasoning: null },
    { reasoning: { effort: "" } },
    { reasoning: { effort: 1 } },
    { reasoning: { summary: "full" } },
    { reasoning: { context: "forever" } },
  ]) {
    assertInvalid(request(fields));
  }
});

test("standalone search rejects tool history, hidden roles, media and unknown message shapes", () => {
  const userMessage = { type: "message", role: "user", content: [{ type: "input_text", text: "example" }] };
  for (const item of [
    null,
    "example",
    { type: "function_call", name: "example", arguments: "{}", call_id: "example" },
    { ...userMessage, role: "system" },
    { ...userMessage, role: "developer" },
    { ...userMessage, additional_tools: [] },
    { ...userMessage, id: 1 },
    { ...userMessage, phase: "analysis" },
    { ...userMessage, content: "example" },
    { ...userMessage, content: [{ type: "input_image", image_url: "https://example.com/image.png" }] },
    { ...userMessage, content: [{ type: "input_text", text: "example", annotations: [] }] },
    { ...userMessage, content: [{ type: "output_text", text: "example" }] },
    { ...userMessage, role: "assistant" },
    { ...userMessage, internal_chat_message_metadata_passthrough: { future_metadata: "example" } },
    { ...userMessage, internal_chat_message_metadata_passthrough: { turn_id: 1 } },
    { ...userMessage, internal_chat_message_metadata_passthrough: { create_time: Infinity } },
    { ...userMessage, internal_chat_message_metadata_passthrough: { content_item_kinds: [1] } },
    { ...userMessage, internal_chat_message_metadata_passthrough: { executed_tool_calls: [] } },
  ]) {
    assertInvalid(request({ input: [item] }));
  }
  assertInvalid(request({ input: {} }));
});

test("standalone search errors do not disclose request values, unknown keys or context", () => {
  const secret = "synthetic-private-context-must-not-appear";
  for (const value of [
    request({ input: secret, [secret]: secret }),
    request({ commands: { search_query: [{ q: secret, [secret]: secret }] } }),
    request({ settings: { [secret]: secret } }),
  ]) {
    assert.throws(() => validateWebSearchRequest(value), (error) => {
      assert.ok(error instanceof BodyCodecError);
      assert.equal(String(error).includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("standalone search projects only the documented response envelope", () => {
  for (const value of [
    { output: "Source: https://example.com" },
    { output: "", encrypted_output: null, results: null },
    { output: "Found one source", encrypted_output: "encrypted-example", results: [] },
    {
      output: "Found one source",
      results: [{ type: "future_result", title: "Example", nested: { value: [1, true, null] } }],
    },
  ]) {
    const before = JSON.stringify(value);
    const projected = projectWebSearchResponse(value);
    assert.notEqual(projected, value);
    assert.deepEqual(projected, value);
    assert.equal(JSON.stringify(value), before);
  }
});

test("standalone search rejects unknown response envelope fields and malformed values", () => {
  for (const value of [
    null,
    [],
    "example",
    {},
    { output: null },
    { output: 1 },
    { output: [] },
    { output: "example", encrypted_output: 1 },
    { output: "example", encrypted_output: {} },
    { output: "example", results: "example" },
    { output: "example", results: {} },
    { output: "example", account: "example-private-account" },
    { output: "example", error: { message: "example-private-context" } },
  ]) {
    assert.throws(() => projectWebSearchResponse(value), (error) => {
      assert.ok(error instanceof BodyCodecError);
      assert.equal(error.code, "INVALID_WEB_SEARCH");
      assert.equal(error.message, "Web search response has an unsupported or invalid shape");
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("standalone search response errors do not disclose upstream metadata or context", () => {
  const secret = "synthetic-private-upstream-must-not-appear";
  assert.throws(() => projectWebSearchResponse({ output: secret, [secret]: secret }), (error) => {
    assert.ok(error instanceof BodyCodecError);
    assert.equal(String(error).includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});
