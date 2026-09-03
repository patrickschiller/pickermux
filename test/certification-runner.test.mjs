import assert from "node:assert/strict";
import test from "node:test";

import {
  runEfficientFidelityCertification,
  runModelCertification,
} from "../src/certification-runner.mjs";
import { CERTIFICATION_HEADER } from "../src/certification-transport.mjs";
import {
  EFFICIENT_FIDELITY_CERTIFICATION_GATE,
  REQUIRED_CERTIFICATION_GATES,
} from "../src/model-certification.mjs";

const CERTIFICATION_TOKEN = "certification-runtime-instance-0123456789";

function jsonResponse(
  payload,
  status = 200,
  contentType = "application/json",
) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": contentType },
  });
}

function sseResponse(events, contentType = "text/event-stream") {
  const body = events
    .map(({ type, data }) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

function rawSseResponse(source, headers = {}) {
  return new Response(source, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      ...headers,
    },
  });
}

function chunkedResponse(chunks, {
  contentType,
  contentLength,
  onCancel,
} = {}) {
  const encodedChunks = chunks.map((chunk) =>
    typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
  );
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index >= encodedChunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encodedChunks[index]);
      index += 1;
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      ...(contentLength === undefined
        ? {}
        : { "content-length": contentLength }),
    },
  });
}

function namespaceCallFixture(overrides = {}) {
  return {
    type: "function_call",
    namespace: "p3_certification",
    name: "confirm",
    call_id: "call-namespace-fixture",
    status: "completed",
    arguments: "{}",
    ...overrides,
  };
}

function namespaceDoneEvent(call = namespaceCallFixture()) {
  return {
    type: "response.output_item.done",
    data: {
      type: "response.output_item.done",
      item: call,
    },
  };
}

function namespaceAddedEvent(call = namespaceCallFixture()) {
  return {
    type: "response.output_item.added",
    data: {
      type: "response.output_item.added",
      item: {
        ...call,
        arguments: "",
        status: "in_progress",
      },
    },
  };
}

function completedEvent(response) {
  return {
    type: "response.completed",
    data: {
      type: "response.completed",
      ...(response === undefined ? {} : { response }),
    },
  };
}

function efficientSearchCallFixture(overrides = {}) {
  return {
    id: "item-search-fixture",
    type: "tool_search_call",
    execution: "client",
    call_id: "call-search-fixture",
    status: "completed",
    arguments: { query: "certification confirmation", limit: 1 },
    ...overrides,
  };
}

function successfulEfficientSearchEvents(call = efficientSearchCallFixture()) {
  return [
    { type: "response.created", data: { type: "response.created" } },
    {
      type: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        item: call,
      },
    },
    completedEvent(),
  ];
}

function successfulP3Responses({
  textStatus = "completed",
  text = "P3_TEXT_OK",
  textOutput = [],
  streamText = "P3_STREAM_OK",
  streamOutputItems = [],
  directStatus = "completed",
  directCallStatus = "completed",
  directOutput = [],
  toolResultStatus = "completed",
  namespaceStatus = "completed",
  namespaceCallStatus = "completed",
  namespaceOutput = [],
  namespaceEvents,
  longStatus = "completed",
  jsonContentType = "application/json",
  sseContentType = "text/event-stream",
} = {}) {
  const namespaceCall = namespaceCallFixture();
  return [
    jsonResponse({
      status: textStatus,
      output: [
        { content: [{ type: "output_text", text }] },
        ...textOutput,
      ],
    }, 200, jsonContentType),
    sseResponse([
      { type: "response.created", data: { type: "response.created" } },
      {
        type: "response.output_text.delta",
        data: { type: "response.output_text.delta", delta: streamText },
      },
      ...streamOutputItems,
      {
        type: "response.completed",
        data: {
          type: "response.completed",
          response: { status: "completed" },
        },
      },
    ], sseContentType),
    jsonResponse({
      id: "resp-direct-fixture",
      status: directStatus,
      output: [
        {
          type: "function_call",
          name: "p3_direct_confirm",
          call_id: "call-direct-fixture",
          status: directCallStatus,
          arguments: '{"marker":"P3_FUNCTION_OK"}',
        },
        ...directOutput,
      ],
    }, 200, jsonContentType),
    jsonResponse({
      status: toolResultStatus,
      output: [
        {
          content: [{ type: "output_text", text: "P3_TOOL_RESULT_OK" }],
        },
      ],
    }, 200, jsonContentType),
    jsonResponse({
      status: namespaceStatus,
      output: [
        { ...namespaceCall, status: namespaceCallStatus },
        ...namespaceOutput,
      ],
    }, 200, jsonContentType),
    sseResponse(namespaceEvents ?? [
      namespaceDoneEvent(namespaceCall),
      completedEvent({
        status: "completed",
        output: [namespaceCall],
      }),
    ], sseContentType),
    jsonResponse({
      status: longStatus,
      output: [{ content: [{ type: "output_text", text: "P3_LONG_OK" }] }],
      usage: { input_tokens: 4_096 },
    }, 200, jsonContentType),
  ];
}

async function assertP3Rejects(responses, pattern, expectedRequests) {
  let requestCount = 0;
  await assert.rejects(
    runModelCertification({
      baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
      model: { id: "lmstudio/example/model", contextWindow: 32_768 },
      certificationToken: CERTIFICATION_TOKEN,
      fetchImpl: async () => {
        requestCount += 1;
        return responses.shift();
      },
      timeoutMs: 5_000,
    }),
    pattern,
  );
  assert.equal(requestCount, expectedRequests);
}

test("runs the complete P3 matrix serially and returns only exact passed gates", async () => {
  const requests = [];
  const responses = [
    jsonResponse({
      output: [{ content: [{ type: "output_text", text: "P3_TEXT_OK" }] }],
    }),
    sseResponse([
      { type: "response.created", data: { type: "response.created" } },
      {
        type: "response.output_text.delta",
        data: { type: "response.output_text.delta", delta: "P3_STREAM_OK" },
      },
      { type: "response.completed", data: { type: "response.completed" } },
    ]),
    jsonResponse({
      id: "resp-direct-1",
      output: [
        {
          type: "function_call",
          name: "p3_direct_confirm",
          call_id: "call-direct-1",
          arguments: '{"marker":"P3_FUNCTION_OK"}',
        },
      ],
    }),
    jsonResponse({
      output: [
        {
          content: [{ type: "output_text", text: "P3_TOOL_RESULT_OK" }],
        },
      ],
    }),
    jsonResponse({
      output: [
        {
          type: "function_call",
          namespace: "p3_certification",
          name: "confirm",
          call_id: "call-namespace-1",
          arguments: "{}",
        },
      ],
    }),
    sseResponse([
      {
        type: "response.output_item.done",
        data: {
          type: "response.output_item.done",
          item: {
            type: "message",
            content: [{ type: "output_text", text: "ignore this done item" }],
          },
        },
      },
      {
        type: "response.output_item.done",
        data: {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            namespace: "p3_certification",
            name: "confirm",
            call_id: "call-2",
            arguments: "{}",
          },
        },
      },
      { type: "response.completed", data: { type: "response.completed" } },
    ]),
    jsonResponse({
      output: [{ content: [{ type: "output_text", text: "P3_LONG_OK" }] }],
      usage: { input_tokens: 4_096 },
    }),
  ];

  let active = 0;
  let maximumActive = 0;
  const fetchImpl = async (url, options) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      requests.push({
        url,
        body: JSON.parse(options.body),
        certificationToken: options.headers[CERTIFICATION_HEADER],
      });
      return responses.shift();
    } finally {
      active -= 1;
    }
  };

  const gates = await runModelCertification({
    baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
    model: { id: "lmstudio/example/model", contextWindow: 32_768 },
    certificationToken: CERTIFICATION_TOKEN,
    fetchImpl,
    timeoutMs: 5_000,
  });

  assert.equal(maximumActive, 1);
  assert.equal(requests.length, 7);
  assert.ok(requests.every((entry) => entry.url.endsWith("/responses")));
  assert.ok(
    requests.every(
      (entry) => entry.certificationToken === CERTIFICATION_TOKEN,
    ),
  );
  assert.equal(requests[1].body.stream, true);
  assert.equal(requests[2].body.tools[0].type, "function");
  assert.equal(requests[2].body.max_output_tokens, 2_048);
  assert.equal(requests[2].body.tools[0].name, "p3_direct_confirm");
  assert.equal(requests[2].body.tool_choice.type, "function");
  assert.equal(requests[2].body.parallel_tool_calls, false);
  assert.equal(requests[3].body.previous_response_id, "resp-direct-1");
  assert.equal(requests[3].body.max_output_tokens, 2_048);
  assert.equal(requests[3].body.input.length, 1);
  assert.equal(requests[3].body.input[0].type, "function_call_output");
  assert.equal(requests[4].body.tools[0].type, "namespace");
  assert.equal(requests[4].body.max_output_tokens, 2_048);
  assert.deepEqual(requests[4].body.tools[0].tools[0].parameters, {});
  assert.equal(requests[4].body.tool_choice.type, "namespace");
  assert.equal(requests[4].body.parallel_tool_calls, false);
  assert.equal(requests[5].body.stream, true);
  assert.equal(requests[5].body.max_output_tokens, 2_048);
  assert.equal(requests[5].body.tool_choice.type, "namespace");
  assert.equal(requests[5].body.parallel_tool_calls, false);
  assert.match(requests[6].body.input, /P3_LONG_BEGIN[\s\S]*P3_LONG_END/u);
  assert.deepEqual(
    gates,
    Object.fromEntries(REQUIRED_CERTIFICATION_GATES.map((gate) => [gate, true])),
  );
});

test("rejects unsuccessful status on every JSON probe", async (t) => {
  const cases = [
    {
      name: "failed text marker",
      responses: () => successfulP3Responses({ textStatus: "failed" }),
      pattern: /Text probe did not complete successfully/u,
      requestCount: 1,
    },
    {
      name: "incomplete direct response",
      responses: () => successfulP3Responses({ directStatus: "incomplete" }),
      pattern: /Direct function probe did not complete successfully/u,
      requestCount: 3,
    },
    {
      name: "failed tool-result response",
      responses: () => successfulP3Responses({ toolResultStatus: "failed" }),
      pattern: /Tool-result probe did not complete successfully/u,
      requestCount: 4,
    },
    {
      name: "incomplete namespace response",
      responses: () => successfulP3Responses({ namespaceStatus: "incomplete" }),
      pattern:
        /Parameterless namespace JSON probe did not complete successfully/u,
      requestCount: 5,
    },
    {
      name: "failed long-context response",
      responses: () => successfulP3Responses({ longStatus: "failed" }),
      pattern: /Long-context probe did not complete successfully/u,
      requestCount: 7,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () =>
      assertP3Rejects(entry.responses(), entry.pattern, entry.requestCount),
    );
  }
});

test("requires a successful plain JSON response despite valid evidence", async (t) => {
  await t.test("plain object", () =>
    assertP3Rejects(
      [jsonResponse(["P3_TEXT_OK"])],
      /Text probe did not complete successfully/u,
      1,
    ),
  );

  await t.test("error with exact marker", () =>
    assertP3Rejects(
      [jsonResponse({
        status: "completed",
        error: { code: "probe_failed" },
        output: [
          { content: [{ type: "output_text", text: "P3_TEXT_OK" }] },
        ],
      })],
      /Text probe did not complete successfully/u,
      1,
    ),
  );

  await t.test("incomplete details with exact call", () => {
    const responses = successfulP3Responses();
    responses[2] = jsonResponse({
      id: "resp-direct-incomplete-details",
      status: "completed",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        {
          type: "function_call",
          name: "p3_direct_confirm",
          call_id: "call-direct-incomplete-details",
          status: "completed",
          arguments: '{"marker":"P3_FUNCTION_OK"}',
        },
      ],
    });
    return assertP3Rejects(
      responses,
      /Direct function probe did not complete successfully/u,
      3,
    );
  });
});

test("requires exact invocation-free marker evidence", async (t) => {
  await t.test("JSON marker with trailing text", () =>
    assertP3Rejects(
      successfulP3Responses({ text: "P3_TEXT_OK trailing" }),
      /Text probe did not return P3_TEXT_OK/u,
      1,
    ),
  );

  await t.test("JSON marker beside an invocation", () =>
    assertP3Rejects(
      successfulP3Responses({
        textOutput: [{ type: "custom_tool_call", call_id: "call-shadow" }],
      }),
      /Text probe did not return P3_TEXT_OK/u,
      1,
    ),
  );

  await t.test("SSE marker with trailing text", () =>
    assertP3Rejects(
      successfulP3Responses({ streamText: "P3_STREAM_OK trailing" }),
      /Stream probe did not complete the Responses SSE contract/u,
      2,
    ),
  );

  await t.test("SSE marker beside an invocation", () =>
    assertP3Rejects(
      successfulP3Responses({
        streamOutputItems: [{
          type: "response.output_item.done",
          data: {
            type: "response.output_item.done",
            item: { type: "custom_tool_call", call_id: "call-stream-shadow" },
          },
        }],
      }),
      /Stream probe did not complete the Responses SSE contract/u,
      2,
    ),
  );

  await t.test("SSE terminal text disagrees with exact deltas", () => {
    const responses = successfulP3Responses();
    responses[1] = sseResponse([
      { type: "response.created", data: { type: "response.created" } },
      {
        type: "response.output_text.delta",
        data: { type: "response.output_text.delta", delta: "P3_STREAM_OK" },
      },
      completedEvent({
        status: "completed",
        output: [{
          content: [{ type: "output_text", text: "P3_STREAM_OK trailing" }],
        }],
      }),
    ]);
    return assertP3Rejects(
      responses,
      /Stream probe did not complete the Responses SSE contract/u,
      2,
    );
  });
});

test("rejects incomplete final function calls", async (t) => {
  await t.test("direct JSON", () =>
    assertP3Rejects(
      successfulP3Responses({ directCallStatus: "incomplete" }),
      /Direct function probe did not return the certified direct function call/u,
      3,
    ),
  );
  await t.test("namespace JSON", () =>
    assertP3Rejects(
      successfulP3Responses({ namespaceCallStatus: "failed" }),
      /namespace JSON probe did not return the certified namespace call/u,
      5,
    ),
  );
});

test("requires exactly one invocation from forced JSON tool probes", async (t) => {
  await t.test("direct JSON rejects an additional custom call", () =>
    assertP3Rejects(
      successfulP3Responses({
        directOutput: [{ type: "custom_tool_call", call_id: "call-extra" }],
      }),
      /Direct function probe did not return exactly one function call/u,
      3,
    ),
  );
  await t.test("namespace JSON rejects an additional call", () =>
    assertP3Rejects(
      successfulP3Responses({
        namespaceOutput: [{
          type: "web_search_call",
          call_id: "call-extra-search",
        }],
      }),
      /namespace JSON probe did not return exactly one function call/u,
      5,
    ),
  );
});

test("requires one successful terminal after the namespace SSE call", async (t) => {
  const call = namespaceCallFixture();
  const cases = [
    {
      name: "done then failed",
      events: [
        namespaceDoneEvent(call),
        {
          type: "response.failed",
          data: {
            type: "response.failed",
            response: { status: "failed" },
          },
        },
      ],
    },
    {
      name: "done then incomplete",
      events: [
        namespaceDoneEvent(call),
        {
          type: "response.incomplete",
          data: {
            type: "response.incomplete",
            response: { status: "incomplete" },
          },
        },
      ],
    },
    {
      name: "done without completed",
      events: [namespaceDoneEvent(call)],
    },
    {
      name: "duplicate completed terminal",
      events: [
        namespaceDoneEvent(call),
        completedEvent(),
        completedEvent(),
      ],
    },
    {
      name: "completed event with incomplete response",
      events: [
        namespaceDoneEvent(call),
        completedEvent({ status: "incomplete", output: [call] }),
      ],
      pattern: /Namespace stream probe returned an inconsistent response.completed terminal/u,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () =>
      assertP3Rejects(
        successfulP3Responses({ namespaceEvents: entry.events }),
        entry.pattern ??
          /Namespace stream probe did not return exactly one successful response.completed terminal/u,
        6,
      ),
    );
  }
});

test("rejects namespace SSE invocation cardinality and terminal drift", async (t) => {
  const call = namespaceCallFixture();
  await t.test("additional invocation", () =>
    assertP3Rejects(
      successfulP3Responses({
        namespaceEvents: [
          namespaceDoneEvent(call),
          namespaceDoneEvent({
            type: "custom_tool_call",
            call_id: "call-extra-custom",
          }),
          completedEvent(),
        ],
      }),
      /Namespace stream probe did not return exactly one completed function call/u,
      6,
    ),
  );

  await t.test("completed response changes the call id", () =>
    assertP3Rejects(
      successfulP3Responses({
        namespaceEvents: [
          namespaceDoneEvent(call),
          completedEvent({
            status: "completed",
            output: [namespaceCallFixture({ call_id: "call-changed" })],
          }),
        ],
      }),
      /Namespace stream probe returned an inconsistent terminal function call/u,
      6,
    ),
  );

  await t.test("duplicate added lifecycle", () =>
    assertP3Rejects(
      successfulP3Responses({
        namespaceEvents: [
          namespaceAddedEvent(call),
          namespaceAddedEvent(call),
          namespaceDoneEvent(call),
          completedEvent({ status: "completed", output: [call] }),
        ],
      }),
      /repeated its function-call added event/u,
      6,
    ),
  );

  await t.test("argument completion drifts from the final item", () => {
    const locatedCall = namespaceCallFixture({ id: "item-argument-drift" });
    const added = namespaceAddedEvent(locatedCall);
    added.data.item_id = locatedCall.id;
    added.data.output_index = 0;
    const done = namespaceDoneEvent(locatedCall);
    done.data.item_id = locatedCall.id;
    done.data.output_index = 0;
    return assertP3Rejects(
      successfulP3Responses({
        namespaceEvents: [
          added,
          {
            type: "response.function_call_arguments.done",
            data: {
              type: "response.function_call_arguments.done",
              item_id: locatedCall.id,
              output_index: 0,
              arguments: '{"unsafe":true}',
            },
          },
          done,
          completedEvent({ status: "completed", output: [locatedCall] }),
        ],
      }),
      /changed function arguments before item completion/u,
      6,
    );
  });

  await t.test("done call is incomplete", () => {
    const incompleteCall = namespaceCallFixture({ status: "incomplete" });
    return assertP3Rejects(
      successfulP3Responses({
        namespaceEvents: [
          namespaceDoneEvent(incompleteCall),
          completedEvent({
            status: "completed",
            output: [incompleteCall],
          }),
        ],
      }),
      /Namespace stream probe did not return the certified namespace call/u,
      6,
    );
  });
});

test("rejects an SSE error event even if completion follows", async () => {
  const responses = successfulP3Responses();
  responses[1] = sseResponse([
    { type: "response.created", data: { type: "response.created" } },
    {
      type: "error",
      data: { type: "error", code: "stream_error" },
    },
    {
      type: "response.output_text.delta",
      data: { type: "response.output_text.delta", delta: "P3_STREAM_OK" },
    },
    completedEvent({ status: "completed" }),
  ]);
  await assertP3Rejects(
    responses,
    /Certification stream returned an error event/u,
    2,
  );
});

test("parses certification SSE frames without ambiguous authority", async (t) => {
  const validStream =
    "event: response.created\n" +
    'data: {"type":"response.created"}\n\n' +
    "event: response.output_text.delta\n" +
    'data: {"type":"response.output_text.delta","delta":"P3_STREAM_OK"}\n\n' +
    "event: response.completed\n" +
    'data: {"type":"response.completed"}\n\n';

  await t.test("allows comment keepalive and one final DONE", async () => {
    const responses = successfulP3Responses();
    responses[1] = rawSseResponse(": keepalive\n\n" + validStream +
      "data: [DONE]\n\n");
    const gates = await runModelCertification({
      baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
      model: { id: "lmstudio/example/model", contextWindow: 32_768 },
      certificationToken: CERTIFICATION_TOKEN,
      fetchImpl: async () => responses.shift(),
      timeoutMs: 5_000,
    });
    assert.ok(Object.values(gates).every((value) => value === true));
  });

  const cases = [
    {
      name: "error event without data",
      source: "event: error\n\n",
      pattern: /frame without JSON data/u,
    },
    {
      name: "error event with empty data",
      source: "event: error\ndata:\n\n",
      pattern: /invalid SSE JSON/u,
    },
    {
      name: "duplicate event fields",
      source:
        "event: response.created\n" +
        "event: response.completed\n" +
        'data: {"type":"response.created"}\n\n',
      pattern: /duplicate event fields/u,
    },
    {
      name: "event and JSON types disagree",
      source:
        "event: response.completed\n" +
        'data: {"type":"response.failed"}\n\n',
      pattern: /inconsistent SSE event types/u,
    },
    {
      name: "premature DONE",
      source: "data: [DONE]\n\n" + validStream,
      pattern: /premature \[DONE\]/u,
    },
    {
      name: "duplicate DONE",
      source: validStream + "data: [DONE]\n\ndata: [DONE]\n\n",
      pattern: /data after \[DONE\]/u,
    },
    {
      name: "frame after DONE",
      source: validStream + "data: [DONE]\n\n: trailing\n\n",
      pattern: /data after \[DONE\]/u,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const responses = successfulP3Responses();
      responses[1] = rawSseResponse(entry.source);
      return assertP3Rejects(responses, entry.pattern, 2);
    });
  }

  await t.test("redacts invalid SSE JSON source excerpts", async () => {
    const privateMarker = "PRIVATE_SSE_JSON_CANARY";
    const responses = successfulP3Responses();
    responses[1] = rawSseResponse(
      `event: response.created\ndata: {"private":"${privateMarker}",\n\n`,
    );
    let observed;
    await assert.rejects(
      runModelCertification({
        baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
        model: { id: "lmstudio/example/model", contextWindow: 32_768 },
        certificationToken: CERTIFICATION_TOKEN,
        fetchImpl: async () => responses.shift(),
        timeoutMs: 5_000,
      }),
      (error) => {
        observed = error;
        return error.message ===
          "Certification stream returned invalid SSE JSON";
      },
    );
    assert.doesNotMatch(observed.message, new RegExp(privateMarker, "u"));
    assert.equal(observed.cause, undefined);
  });
});

test("redacts malformed function argument source excerpts", async () => {
  const privateMarker = "PRIVATE_FUNCTION_ARGUMENT_CANARY";
  const responses = successfulP3Responses();
  responses[2] = jsonResponse({
    id: "resp-direct-private-arguments",
    status: "completed",
    output: [
      {
        type: "function_call",
        name: "p3_direct_confirm",
        call_id: "call-direct-private-arguments",
        status: "completed",
        arguments: `{"private":"${privateMarker}",`,
      },
    ],
  });
  let observed;
  await assert.rejects(
    runModelCertification({
      baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
      model: { id: "lmstudio/example/model", contextWindow: 32_768 },
      certificationToken: CERTIFICATION_TOKEN,
      fetchImpl: async () => responses.shift(),
      timeoutMs: 5_000,
    }),
    (error) => {
      observed = error;
      return error.message ===
        "Direct function probe returned invalid function arguments";
    },
  );
  assert.doesNotMatch(observed.message, new RegExp(privateMarker, "u"));
  assert.equal(observed.cause, undefined);
});

test("strictly validates JSON and SSE response media types", async (t) => {
  for (const contentType of [
    "application/jsonp",
    "text/plain",
    "application/json, text/plain",
  ]) {
    await t.test(`rejects JSON ${contentType}`, () =>
      assertP3Rejects(
        successfulP3Responses({ jsonContentType: contentType }),
        /Text probe returned invalid JSON Content-Type/u,
        1,
      ),
    );
  }

  await t.test("rejects JSON MIME from an SSE probe", () =>
    assertP3Rejects(
      successfulP3Responses({ sseContentType: "application/json" }),
      /Stream probe returned invalid SSE Content-Type/u,
      2,
    ),
  );

  await t.test("accepts structured JSON suffix and MIME parameters", async () => {
    const responses = successfulP3Responses({
      jsonContentType: "application/vnd.pickermux+json; charset=utf-8",
      sseContentType: "text/event-stream; charset=utf-8",
    });
    const gates = await runModelCertification({
      baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
      model: { id: "lmstudio/example/model", contextWindow: 32_768 },
      certificationToken: CERTIFICATION_TOKEN,
      fetchImpl: async () => responses.shift(),
      timeoutMs: 5_000,
    });
    assert.deepEqual(
      gates,
      Object.fromEntries(
        REQUIRED_CERTIFICATION_GATES.map((gate) => [gate, true]),
      ),
    );
  });
});

test("bounds decoded certification response bodies incrementally", async (t) => {
  const maximumBytes = 8 * 1024 * 1024;

  await t.test("accepts a valid chunked JSON body", async () => {
    const responses = successfulP3Responses();
    const payload = JSON.stringify({
      status: "completed",
      error: null,
      incomplete_details: null,
      output: [{ content: [{ type: "output_text", text: "P3_TEXT_OK" }] }],
    });
    responses[0] = chunkedResponse(
      [payload.slice(0, 17), payload.slice(17)],
      { contentType: "application/json" },
    );
    const gates = await runModelCertification({
      baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
      model: { id: "lmstudio/example/model", contextWindow: 32_768 },
      certificationToken: CERTIFICATION_TOKEN,
      fetchImpl: async () => responses.shift(),
      timeoutMs: 5_000,
    });
    assert.ok(Object.values(gates).every((value) => value === true));
  });

  await t.test("rejects declared overflow before reading", async () => {
    let canceled = false;
    const responses = successfulP3Responses();
    responses[0] = chunkedResponse(["{}"], {
      contentType: "application/json",
      contentLength: String(maximumBytes + 1),
      onCancel: () => {
        canceled = true;
      },
    });
    await assertP3Rejects(
      responses,
      /Text probe response body exceeds 8388608 bytes/u,
      1,
    );
    assert.equal(canceled, true);
  });

  await t.test("rejects chunked JSON overflow and cancels the body", async () => {
    let canceled = false;
    const responses = successfulP3Responses();
    responses[0] = chunkedResponse([
      new Uint8Array(maximumBytes / 2),
      new Uint8Array(maximumBytes / 2),
      new Uint8Array(1),
      new Uint8Array(1),
    ], {
      contentType: "application/json",
      onCancel: () => {
        canceled = true;
      },
    });
    await assertP3Rejects(
      responses,
      /Text probe response body exceeds 8388608 bytes/u,
      1,
    );
    assert.equal(canceled, true);
  });

  await t.test("does not trust a false small SSE Content-Length", async () => {
    let canceled = false;
    const responses = successfulP3Responses();
    responses[1] = chunkedResponse([
      new Uint8Array(maximumBytes),
      new Uint8Array(1),
      new Uint8Array(1),
    ], {
      contentType: "text/event-stream",
      contentLength: "1",
      onCancel: () => {
        canceled = true;
      },
    });
    await assertP3Rejects(
      responses,
      /Stream probe response body exceeds 8388608 bytes/u,
      2,
    );
    assert.equal(canceled, true);
  });

  await t.test("rejects invalid UTF-8 without exposing provider bytes", async () => {
    const privateMarker = "PRIVATE_PROVIDER_BODY_CANARY";
    const responses = successfulP3Responses();
    responses[0] = chunkedResponse([
      Buffer.from(`{"private":"${privateMarker}","value":"`, "utf8"),
      Uint8Array.from([0xff]),
      Buffer.from('"}', "utf8"),
    ], { contentType: "application/json" });
    let observed;
    await assert.rejects(
      runModelCertification({
        baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
        model: { id: "lmstudio/example/model", contextWindow: 32_768 },
        certificationToken: CERTIFICATION_TOKEN,
        fetchImpl: async () => responses.shift(),
        timeoutMs: 5_000,
      }),
      (error) => {
        observed = error;
        return /Text probe response body is not valid UTF-8/u.test(error.message);
      },
    );
    assert.doesNotMatch(observed.message, new RegExp(privateMarker, "u"));
    assert.equal(observed.cause, undefined);
  });

  await t.test("redacts malformed JSON source excerpts", async () => {
    const privateMarker = "PRIVATE_JSON_SYNTAX_CANARY";
    const responses = successfulP3Responses();
    responses[0] = new Response(
      `{"private":"${privateMarker}","unterminated":`,
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
    let observed;
    await assert.rejects(
      runModelCertification({
        baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
        model: { id: "lmstudio/example/model", contextWindow: 32_768 },
        certificationToken: CERTIFICATION_TOKEN,
        fetchImpl: async () => responses.shift(),
        timeoutMs: 5_000,
      }),
      (error) => {
        observed = error;
        return error.message === "Text probe returned invalid JSON";
      },
    );
    assert.doesNotMatch(observed.message, new RegExp(privateMarker, "u"));
    assert.equal(observed.cause, undefined);
  });
});

test("fails certification without publishing gates when a mandatory probe fails", async () => {
  await assert.rejects(
    runModelCertification({
      baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
      model: { id: "lmstudio/example/model", contextWindow: 32_768 },
      certificationToken: CERTIFICATION_TOKEN,
      fetchImpl: async () => jsonResponse({ output: [] }),
      timeoutMs: 5_000,
    }),
    /Text probe did not return P3_TEXT_OK/u,
  );
});

test("rejects non-empty arguments from the parameterless namespace JSON probe", async () => {
  const responses = [
    jsonResponse({
      output: [{ content: [{ type: "output_text", text: "P3_TEXT_OK" }] }],
    }),
    sseResponse([
      { type: "response.created", data: { type: "response.created" } },
      {
        type: "response.output_text.delta",
        data: { type: "response.output_text.delta", delta: "P3_STREAM_OK" },
      },
      { type: "response.completed", data: { type: "response.completed" } },
    ]),
    jsonResponse({
      id: "resp-direct-2",
      output: [
        {
          type: "function_call",
          name: "p3_direct_confirm",
          call_id: "call-direct-2",
          arguments: '{"marker":"P3_FUNCTION_OK"}',
        },
      ],
    }),
    jsonResponse({
      output: [
        {
          content: [{ type: "output_text", text: "P3_TOOL_RESULT_OK" }],
        },
      ],
    }),
    jsonResponse({
      output: [
        {
          type: "function_call",
          namespace: "p3_certification",
          name: "confirm",
          call_id: "call-namespace-2",
          arguments: '{"unexpected":true}',
        },
      ],
    }),
  ];

  await assert.rejects(
    runModelCertification({
      baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
      model: { id: "lmstudio/example/model", contextWindow: 32_768 },
      certificationToken: CERTIFICATION_TOKEN,
      fetchImpl: async () => responses.shift(),
      timeoutMs: 5_000,
    }),
    /Parameterless namespace JSON probe returned non-empty parameterless arguments/u,
  );
});

test("requires a private runtime marker before certification sends a request", async () => {
  let requested = false;
  await assert.rejects(
    runModelCertification({
      baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
      model: { id: "lmstudio/example/model", contextWindow: 32_768 },
      fetchImpl: async () => {
        requested = true;
        return jsonResponse({});
      },
      timeoutMs: 5_000,
    }),
    /Certification token/u,
  );
  assert.equal(requested, false);
});

test("certifies Efficient Fidelity with a stateless client tool-search replay", async () => {
  const requests = [];
  const responses = [
    sseResponse([
      { type: "response.created", data: { type: "response.created" } },
      {
        type: "response.output_item.done",
        data: {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "item-search-1",
            type: "tool_search_call",
            execution: "client",
            call_id: "call-search-1",
            status: "completed",
            arguments: {
              query: "efficient fidelity certification confirmation",
              limit: 1,
            },
          },
        },
      },
      { type: "response.completed", data: { type: "response.completed" } },
    ]),
    jsonResponse({
      output: [
        {
          type: "function_call",
          namespace: "p6_efficient_fidelity",
          name: "confirm",
          call_id: "call-confirm-1",
          arguments: '{"marker":"P6_EFFICIENT_FIDELITY_OK"}',
        },
      ],
    }),
  ];
  let active = 0;
  let maximumActive = 0;
  const fetchImpl = async (url, options) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      requests.push({
        url,
        body: JSON.parse(options.body),
        certificationToken: options.headers[CERTIFICATION_HEADER],
      });
      return responses.shift();
    } finally {
      active -= 1;
    }
  };

  const gates = await runEfficientFidelityCertification({
    baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
    model: { id: "lmstudio/example/model", contextWindow: 32_768 },
    certificationToken: CERTIFICATION_TOKEN,
    fetchImpl,
    timeoutMs: 5_000,
  });

  assert.equal(maximumActive, 1);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((entry) => entry.url.endsWith("/responses")));
  assert.ok(
    requests.every(
      (entry) => entry.certificationToken === CERTIFICATION_TOKEN,
    ),
  );
  assert.ok(
    requests.every(
      (entry) => !Object.hasOwn(entry.body, "previous_response_id"),
    ),
  );
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[1].body.stream, false);
  assert.equal(requests[0].body.tool_choice, "auto");
  assert.equal(requests[1].body.tool_choice, "auto");
  assert.equal(requests[0].body.max_output_tokens, 2_048);
  assert.equal(requests[0].body.tools.length, 2);
  assert.deepEqual(
    requests[0].body.tools.map((tool) => tool.type),
    ["namespace", "tool_search"],
  );
  assert.equal(requests[0].body.tools[0].tools[0].defer_loading, true);
  assert.equal(requests[0].body.tools[1].execution, "client");
  assert.deepEqual(requests[0].body.tools[1].parameters.required, ["query"]);
  assert.equal(requests[1].body.input.length, 3);
  assert.deepEqual(requests[1].body.input[0], requests[0].body.input[0]);
  assert.deepEqual(requests[1].body.input[1], {
    id: "item-search-1",
    type: "tool_search_call",
    execution: "client",
    call_id: "call-search-1",
    status: "completed",
    arguments: {
      query: "efficient fidelity certification confirmation",
      limit: 1,
    },
  });
  assert.equal(requests[1].body.input[2].type, "tool_search_output");
  assert.equal(requests[1].body.input[2].execution, "client");
  assert.equal(requests[1].body.input[2].status, "completed");
  assert.equal(requests[1].body.input[2].call_id, "call-search-1");
  assert.equal(requests[1].body.input[2].tools[0].type, "namespace");
  assert.equal(
    requests[1].body.input[2].tools[0].tools[0].defer_loading,
    true,
  );
  assert.deepEqual(gates, {
    [EFFICIENT_FIDELITY_CERTIFICATION_GATE]: true,
  });
});

test("requires a completed terminal for the Efficient Fidelity SSE probe", async (t) => {
  const call = efficientSearchCallFixture();
  const cases = [
    {
      name: "missing completed",
      events: successfulEfficientSearchEvents(call).slice(0, -1),
    },
    {
      name: "failed terminal",
      events: [
        ...successfulEfficientSearchEvents(call).slice(0, -1),
        {
          type: "response.failed",
          data: {
            type: "response.failed",
            response: { status: "failed" },
          },
        },
      ],
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      let requestCount = 0;
      await assert.rejects(
        runEfficientFidelityCertification({
          baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
          model: { id: "lmstudio/example/model", contextWindow: 32_768 },
          certificationToken: CERTIFICATION_TOKEN,
          fetchImpl: async () => {
            requestCount += 1;
            return sseResponse(entry.events);
          },
          timeoutMs: 5_000,
        }),
        /Efficient Fidelity search probe did not return exactly one successful response.completed terminal/u,
      );
      assert.equal(requestCount, 1);
    });
  }
});

test("rejects extra Efficient Fidelity invocations in terminal and JSON output", async (t) => {
  await t.test("search terminal", async () => {
    const call = efficientSearchCallFixture();
    let requestCount = 0;
    await assert.rejects(
      runEfficientFidelityCertification({
        baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
        model: { id: "lmstudio/example/model", contextWindow: 32_768 },
        certificationToken: CERTIFICATION_TOKEN,
        fetchImpl: async () => {
          requestCount += 1;
          return sseResponse([
            ...successfulEfficientSearchEvents(call).slice(0, -1),
            completedEvent({
              status: "completed",
              output: [
                call,
                { type: "shell_call", call_id: "call-unadvertised-shell" },
              ],
            }),
          ]);
        },
        timeoutMs: 5_000,
      }),
      /did not complete one client tool search/u,
    );
    assert.equal(requestCount, 1);
  });

  await t.test("loaded-tool JSON", async () => {
    const responses = [
      sseResponse(successfulEfficientSearchEvents()),
      jsonResponse({
        status: "completed",
        output: [
          {
            type: "function_call",
            namespace: "p6_efficient_fidelity",
            name: "confirm",
            call_id: "call-confirm-with-extra",
            status: "completed",
            arguments: '{"marker":"P6_EFFICIENT_FIDELITY_OK"}',
          },
          { type: "mcp_call", call_id: "call-unadvertised-mcp" },
        ],
      }),
    ];
    await assert.rejects(
      runEfficientFidelityCertification({
        baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
        model: { id: "lmstudio/example/model", contextWindow: 32_768 },
        certificationToken: CERTIFICATION_TOKEN,
        fetchImpl: async () => responses.shift(),
        timeoutMs: 5_000,
      }),
      /loaded-tool probe did not return one function call/u,
    );
  });
});

test("fails Efficient Fidelity before replaying an invalid tool-search call", async () => {
  let requestCount = 0;
  await assert.rejects(
    runEfficientFidelityCertification({
      baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
      model: { id: "lmstudio/example/model", contextWindow: 32_768 },
      certificationToken: CERTIFICATION_TOKEN,
      fetchImpl: async () => {
        requestCount += 1;
        return sseResponse([
          { type: "response.created", data: { type: "response.created" } },
          {
            type: "response.output_item.done",
            data: {
              type: "response.output_item.done",
              item: {
                type: "tool_search_call",
                execution: "server",
                call_id: "call-search-invalid",
                status: "completed",
                arguments: { query: "confirmation", limit: 1 },
              },
            },
          },
          {
            type: "response.completed",
            data: { type: "response.completed" },
          },
        ]);
      },
      timeoutMs: 5_000,
    }),
    /returned an invalid client tool-search call/u,
  );
  assert.equal(requestCount, 1);
});

test("rejects an additional invocation during the search probe", async () => {
  let requestCount = 0;
  await assert.rejects(
    runEfficientFidelityCertification({
      baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
      model: { id: "lmstudio/example/model", contextWindow: 32_768 },
      certificationToken: CERTIFICATION_TOKEN,
      fetchImpl: async () => {
        requestCount += 1;
        return sseResponse([
          { type: "response.created", data: { type: "response.created" } },
          {
            type: "response.output_item.done",
            data: {
              type: "response.output_item.done",
              item: {
                type: "tool_search_call",
                execution: "client",
                call_id: "call-search-with-extra",
                status: "completed",
                arguments: { query: "confirmation" },
              },
            },
          },
          {
            type: "response.output_item.done",
            data: {
              type: "response.output_item.done",
              item: {
                type: "function_call",
                name: "unexpected",
                call_id: "call-extra",
                status: "completed",
                arguments: "{}",
              },
            },
          },
          { type: "response.completed", data: { type: "response.completed" } },
        ]);
      },
      timeoutMs: 5_000,
    }),
    /did not complete one client tool search/u,
  );
  assert.equal(requestCount, 1);
});

test("rejects a different function after Efficient Fidelity loads the tool", async () => {
  const responses = [
    sseResponse([
      { type: "response.created", data: { type: "response.created" } },
      {
        type: "response.output_item.done",
        data: {
          type: "response.output_item.done",
          item: {
            type: "tool_search_call",
            execution: "client",
            call_id: "call-search-2",
            status: "completed",
            arguments: { query: "confirmation" },
          },
        },
      },
      { type: "response.completed", data: { type: "response.completed" } },
    ]),
    jsonResponse({
      output: [
        {
          type: "function_call",
          namespace: "p6_efficient_fidelity",
          name: "unexpected",
          call_id: "call-unexpected-1",
          arguments: "{}",
        },
      ],
    }),
  ];

  await assert.rejects(
    runEfficientFidelityCertification({
      baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
      model: { id: "lmstudio/example/model", contextWindow: 32_768 },
      certificationToken: CERTIFICATION_TOKEN,
      fetchImpl: async () => responses.shift(),
      timeoutMs: 5_000,
    }),
    /did not return the certified namespace call/u,
  );
});

test("rejects a failed JSON response from the loaded-tool probe", async () => {
  const responses = [
    sseResponse([
      { type: "response.created", data: { type: "response.created" } },
      {
        type: "response.output_item.done",
        data: {
          type: "response.output_item.done",
          item: {
            type: "tool_search_call",
            execution: "client",
            call_id: "call-search-failed-json",
            status: "completed",
            arguments: { query: "confirmation" },
          },
        },
      },
      { type: "response.completed", data: { type: "response.completed" } },
    ]),
    jsonResponse({
      status: "failed",
      output: [
        {
          type: "function_call",
          namespace: "p6_efficient_fidelity",
          name: "confirm",
          call_id: "call-confirm-failed-json",
          arguments: '{"marker":"P6_EFFICIENT_FIDELITY_OK"}',
        },
      ],
    }),
  ];

  await assert.rejects(
    runEfficientFidelityCertification({
      baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
      model: { id: "lmstudio/example/model", contextWindow: 32_768 },
      certificationToken: CERTIFICATION_TOKEN,
      fetchImpl: async () => responses.shift(),
      timeoutMs: 5_000,
    }),
    /did not complete successfully/u,
  );
});

test("rejects an incomplete function call from the loaded-tool probe", async () => {
  const responses = [
    sseResponse([
      { type: "response.created", data: { type: "response.created" } },
      {
        type: "response.output_item.done",
        data: {
          type: "response.output_item.done",
          item: {
            type: "tool_search_call",
            execution: "client",
            call_id: "call-search-incomplete-function",
            status: "completed",
            arguments: { query: "confirmation" },
          },
        },
      },
      { type: "response.completed", data: { type: "response.completed" } },
    ]),
    jsonResponse({
      status: "completed",
      output: [
        {
          type: "function_call",
          namespace: "p6_efficient_fidelity",
          name: "confirm",
          call_id: "call-confirm-incomplete",
          status: "in_progress",
          arguments: '{"marker":"P6_EFFICIENT_FIDELITY_OK"}',
        },
      ],
    }),
  ];

  await assert.rejects(
    runEfficientFidelityCertification({
      baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
      model: { id: "lmstudio/example/model", contextWindow: 32_768 },
      certificationToken: CERTIFICATION_TOKEN,
      fetchImpl: async () => responses.shift(),
      timeoutMs: 5_000,
    }),
    /did not return the certified namespace call/u,
  );
});

test("rejects a loaded-tool call that reuses the tool-search call id", async () => {
  const responses = [
    sseResponse([
      { type: "response.created", data: { type: "response.created" } },
      {
        type: "response.output_item.done",
        data: {
          type: "response.output_item.done",
          item: {
            type: "tool_search_call",
            execution: "client",
            call_id: "call-reused",
            status: "completed",
            arguments: { query: "confirmation" },
          },
        },
      },
      { type: "response.completed", data: { type: "response.completed" } },
    ]),
    jsonResponse({
      output: [
        {
          type: "function_call",
          namespace: "p6_efficient_fidelity",
          name: "confirm",
          call_id: "call-reused",
          arguments: '{"marker":"P6_EFFICIENT_FIDELITY_OK"}',
        },
      ],
    }),
  ];

  await assert.rejects(
    runEfficientFidelityCertification({
      baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
      model: { id: "lmstudio/example/model", contextWindow: 32_768 },
      certificationToken: CERTIFICATION_TOKEN,
      fetchImpl: async () => responses.shift(),
      timeoutMs: 5_000,
    }),
    /did not return the certified namespace call/u,
  );
});

test("requires the private runtime marker for Efficient Fidelity certification", async () => {
  let requested = false;
  await assert.rejects(
    runEfficientFidelityCertification({
      baseUrl: "http://127.0.0.1:4210/c/test-capability/v1",
      model: { id: "lmstudio/example/model", contextWindow: 32_768 },
      fetchImpl: async () => {
        requested = true;
        return jsonResponse({});
      },
      timeoutMs: 5_000,
    }),
    /Certification token/u,
  );
  assert.equal(requested, false);
});
