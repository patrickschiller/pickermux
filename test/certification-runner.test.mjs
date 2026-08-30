import assert from "node:assert/strict";
import test from "node:test";

import { runModelCertification } from "../src/certification-runner.mjs";
import { CERTIFICATION_HEADER } from "../src/certification-transport.mjs";
import { REQUIRED_CERTIFICATION_GATES } from "../src/model-certification.mjs";

const CERTIFICATION_TOKEN = "certification-runtime-instance-0123456789";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(events) {
  const body = events
    .map(({ type, data }) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
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
  assert.equal(requests[3].body.previous_response_id, "resp-direct-1");
  assert.equal(requests[3].body.max_output_tokens, 2_048);
  assert.equal(requests[3].body.input.length, 1);
  assert.equal(requests[3].body.input[0].type, "function_call_output");
  assert.equal(requests[4].body.tools[0].type, "namespace");
  assert.equal(requests[4].body.max_output_tokens, 2_048);
  assert.deepEqual(requests[4].body.tools[0].tools[0].parameters, {});
  assert.equal(requests[4].body.tool_choice.type, "namespace");
  assert.equal(requests[5].body.stream, true);
  assert.equal(requests[5].body.max_output_tokens, 2_048);
  assert.match(requests[6].body.input, /P3_LONG_BEGIN[\s\S]*P3_LONG_END/u);
  assert.deepEqual(
    gates,
    Object.fromEntries(REQUIRED_CERTIFICATION_GATES.map((gate) => [gate, true])),
  );
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
