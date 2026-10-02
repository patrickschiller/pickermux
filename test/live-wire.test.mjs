import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_CONTRACT_VERSION,
  LIVE_MULTIPART_CONTENT_TYPE,
  LIVE_PATH,
  encodeLiveRequest,
  projectLiveResponse,
} from "../src/live-wire.mjs";

const BOUNDARY = "codex-realtime-call-boundary";
const CANARY = "private-live-prompt-and-account-canary";
const SDP = [
  "v=0",
  "o=- 1 1 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=mid:0",
  "a=ice-ufrag:synthetic",
  "a=ice-pwd:synthetic-password-for-tests",
  `a=fingerprint:sha-256 ${Array(32).fill("00").join(":")}`,
  "a=setup:actpass",
  "a=sendrecv",
  "a=rtcp-mux",
  "a=rtpmap:111 opus/48000/2",
  "",
].join("\r\n");
const VOICES = [
  "alloy", "arbor", "ash", "ballad", "breeze", "cedar", "coral",
  "cove", "echo", "ember", "juniper", "maple", "marin", "sage",
  "shimmer", "sol", "spruce", "vale", "verse",
];

function session(fields = {}) {
  return {
    instructions: "Help with the current task. Grüße!",
    audio: { output: { voice: "marin" } },
    delegation: { type: "client" },
    ...fields,
  };
}

function multipart(value = session(), sdp = SDP, sessionJson = JSON.stringify(value)) {
  return Buffer.from(
    `--${BOUNDARY}\r\n` +
    'Content-Disposition: form-data; name="sdp"\r\n' +
    "Content-Type: application/sdp\r\n\r\n" +
    `${sdp}\r\n` +
    `--${BOUNDARY}\r\n` +
    'Content-Disposition: form-data; name="session"\r\n' +
    "Content-Type: application/json\r\n\r\n" +
    `${sessionJson}\r\n` +
    `--${BOUNDARY}--\r\n`,
  );
}

function assertInvalidRequest(body, contentType) {
  if (arguments.length === 1) contentType = LIVE_MULTIPART_CONTENT_TYPE;
  assert.throws(() => encodeLiveRequest(body, contentType), (error) => {
    assert.equal(error.code, "INVALID_LIVE_REQUEST");
    assert.equal(error.statusCode, 400);
    assert.equal(String(error.message).includes(CANARY), false);
    return true;
  });
}

function assertInvalidResponse(body, headers = { location: "/v1/realtime/calls/rtc_example" }) {
  assert.throws(() => projectLiveResponse(body, headers), (error) => {
    assert.equal(error.code, "UPSTREAM_RESPONSE_ERROR");
    assert.equal(error.statusCode, 502);
    assert.equal(String(error.message).includes(CANARY), false);
    return true;
  });
}

test("GPT-Live exposes the reviewed route and translates the exact Codex multipart contract", () => {
  assert.equal(LIVE_PATH, "/v1/live");
  assert.equal(LIVE_CONTRACT_VERSION, 1);
  assert.equal(LIVE_MULTIPART_CONTENT_TYPE, `multipart/form-data; boundary=${BOUNDARY}`);
  const value = session();
  const encoded = encodeLiveRequest(multipart(value), LIVE_MULTIPART_CONTENT_TYPE);
  assert.ok(Buffer.isBuffer(encoded));
  assert.deepEqual(JSON.parse(encoded), { sdp: SDP, session: value });
});

test("GPT-Live preserves every reviewed voice, optional delegation and native voice-model selection", () => {
  for (const voice of VOICES) {
    for (const ack_filler of [undefined, false, true]) {
      const value = session({
        model: "gpt-live-example",
        audio: { output: { voice } },
        delegation: {
          type: "client",
          ...(ack_filler === undefined ? {} : { ack_filler }),
        },
      });
      assert.deepEqual(
        JSON.parse(encodeLiveRequest(multipart(value), LIVE_MULTIPART_CONTENT_TYPE)),
        { sdp: SDP, session: value },
      );
    }
  }
});

test("GPT-Live preserves only the reviewed role-bearing initial text items", () => {
  for (const initial_items of [[], [
    { type: "message", role: "user", content: [{ type: "input_text", text: "A question" }] },
    { type: "message", role: "developer", content: [{ type: "input_text", text: "An instruction" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "An answer" }] },
  ]]) {
    const value = session({ instructions: "", initial_items });
    assert.deepEqual(
      JSON.parse(encodeLiveRequest(multipart(value), LIVE_MULTIPART_CONTENT_TYPE)),
      { sdp: SDP, session: value },
    );
  }
});

test("GPT-Live preserves ordinary boundary mentions inside session JSON strings", () => {
  const text = `A literal --${BOUNDARY} token and escaped\r\n--${BOUNDARY} text.`;
  const value = session({
    instructions: text,
    initial_items: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
  });
  assert.deepEqual(
    JSON.parse(encodeLiveRequest(multipart(value), LIVE_MULTIPART_CONTENT_TYPE)),
    { sdp: SDP, session: value },
  );
});

test("GPT-Live accepts unambiguous escaped JSON keys and repeated keys in separate records", () => {
  const value = session({
    instructions: 'Literal {"type":"server","type":"client"} and \\quoted\\ text.',
    initial_items: ["First", "Second"].map((text) => ({
      type: "message", role: "user", content: [{ type: "input_text", text }],
    })),
  });
  const source = ` \r\n${JSON.stringify(value).replace('"instructions":', '"\\u0069nstructions" : ')}\t `;
  assert.deepEqual(
    JSON.parse(encodeLiveRequest(multipart(value, SDP, source), LIVE_MULTIPART_CONTENT_TYPE)),
    { sdp: SDP, session: value },
  );
});

test("GPT-Live rejects duplicate and escaped-equivalent keys at every session boundary", () => {
  const value = session({
    model: "gpt-live-example",
    delegation: { type: "client", ack_filler: true },
    initial_items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
  });
  const source = JSON.stringify(value);
  for (const [original, replacement] of [
    ['"instructions":', `"instructions":"${CANARY}","instructions":`],
    ['"instructions":', `"instructions":"${CANARY}","\\u0069nstructions":`],
    ['"model":', '"model":"lmstudio/other","model":'],
    ['"audio":', '"audio":{},"audio":'],
    ['"output":', '"output":{},"output":'],
    ['"voice":', '"voice":"marin","voice":'],
    ['"voice":', '"voice":"marin","\\u0076oice":'],
    ['"type":"client"', '"type":"server","type":"client"'],
    ['"ack_filler":', '"ack_filler":false,"ack_filler":'],
    ['"initial_items":', '"initial_items":[],"initial_items":'],
    ['"role":', '"role":"assistant","role":'],
    ['"content":', '"content":[],"content":'],
    ['"text":', `"text":"${CANARY}","\\u0074ext":`],
  ]) {
    assertInvalidRequest(multipart(value, SDP, source.replace(original, replacement)));
  }
});

test("GPT-Live bounds JSON nesting and rejects malformed JSON without exposing its contents", () => {
  const source = JSON.stringify(session());
  for (const malformed of [
    source.slice(0, -1),
    `${source}${CANARY}`,
    source.replace('"client"', "tru"),
    source.replace('"client"', "01"),
    source.replace('"client"', "nulljunk"),
    source.replace('"client"', "[true,]"),
    source.replace('"client"', '{"value":true,}'),
    source.replace('"client"', '{"value" true}'),
    source.replace('"client"', `${"[".repeat(256)}null${"]".repeat(256)}`),
  ]) {
    assertInvalidRequest(multipart(session(), SDP, malformed));
  }
});

test("GPT-Live rejects unknown session fields and authority at every nested boundary", () => {
  for (const value of [
    session({ endpoint: `https://${CANARY}.example/` }),
    session({ tools: [{ type: "function", name: "shell" }] }),
    session({ client_metadata: { account: CANARY } }),
    session({ audio: { input: {}, output: { voice: "marin" } } }),
    session({ audio: { output: { voice: "marin", format: "pcm16" } } }),
    session({ delegation: { type: "client", url: `https://${CANARY}.example/` } }),
    session({ delegation: { type: "server" } }),
    session({ delegation: { type: "client", ack_filler: "true" } }),
    session({ initial_items: [{ type: "function_call", name: "shell", arguments: CANARY }] }),
    session({ initial_items: [{ type: "message", role: "user", id: CANARY, content: [{ type: "input_text", text: "hello" }] }] }),
    session({ initial_items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello", account: CANARY }] }] }),
  ]) {
    assertInvalidRequest(multipart(value));
  }
});

test("GPT-Live rejects malformed sessions, unsupported voices and external model slugs", () => {
  for (const value of [
    null, [], "session", 1,
    {},
    session({ instructions: null }),
    session({ audio: null }),
    session({ audio: { output: {} } }),
    session({ audio: { output: { voice: "unknown-voice" } } }),
    session({ audio: { output: { voice: "Marin" } } }),
    session({ delegation: null }),
    session({ initial_items: null }),
    session({ initial_items: "history" }),
  ]) {
    assertInvalidRequest(multipart(value));
  }
  for (const model of [null, 1, "", " ", "lmstudio/example", "../gpt-live", "gpt-live?route=other", "x".repeat(129)]) {
    assertInvalidRequest(multipart(session({ model })));
  }
  for (const item of [
    { type: "message", role: "system", content: [{ type: "input_text", text: CANARY }] },
    { type: "message", role: "assistant", content: [{ type: "input_text", text: CANARY }] },
    { type: "message", role: "user", content: [{ type: "output_text", text: CANARY }] },
    { type: "message", role: "user", content: [{ type: "input_audio", data: CANARY }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: null }] },
    { type: "message", role: "user", content: CANARY },
    { type: "message", role: "user", content: [] },
  ]) {
    assertInvalidRequest(multipart(session({ initial_items: [item] })));
  }
});

test("GPT-Live rejects other content types and ambiguous or modified multipart layouts", () => {
  const canonical = multipart().toString();
  for (const contentType of [
    undefined,
    "application/json",
    "application/sdp",
    "multipart/form-data",
    "multipart/form-data; boundary=other",
    `${LIVE_MULTIPART_CONTENT_TYPE}; charset=utf-8`,
  ]) {
    assertInvalidRequest(multipart(), contentType);
  }
  for (const body of [
    Buffer.from(JSON.stringify({ sdp: SDP, session: session() })),
    Buffer.from(canonical.replaceAll("\r\n", "\n")),
    Buffer.from(canonical.replace('name="sdp"', 'name="session"')),
    Buffer.from(canonical.replace("Content-Type: application/sdp", "Content-Type: text/plain")),
    Buffer.from(canonical.replace("Content-Type: application/json", "Content-Type: text/plain")),
    Buffer.from(canonical.replace("Content-Type: application/sdp", `X-Secret: ${CANARY}\r\nContent-Type: application/sdp`)),
    Buffer.from(canonical.slice(0, -2)),
    Buffer.from(canonical.replace(`--${BOUNDARY}--\r\n`, "")),
    Buffer.from(`${canonical}${CANARY}`),
    Buffer.from(`${CANARY}${canonical}`),
    Buffer.from(canonical.replace(JSON.stringify(session()), `{"instructions":"${CANARY}"`)),
    Buffer.from(canonical.replace(`--${BOUNDARY}--\r\n`, `--${BOUNDARY}\r\nContent-Disposition: form-data; name="extra"\r\n\r\n${CANARY}\r\n--${BOUNDARY}--\r\n`)),
  ]) {
    assertInvalidRequest(body);
  }
});

test("GPT-Live rejects invalid UTF-8 and SDP format before adapting any request", () => {
  for (const sdp of ["", "v=offer\r\n", "v=0\n", `${SDP}\u0000${CANARY}`]) {
    assertInvalidRequest(multipart(session(), sdp));
  }
  const canonical = multipart().toString();
  const offset = canonical.indexOf(SDP);
  assertInvalidRequest(Buffer.concat([
    Buffer.from(canonical.slice(0, offset)),
    Buffer.from([0xc0, 0x80]),
    Buffer.from(canonical.slice(offset)),
  ]));
});

test("GPT-Live preserves complete SDP offers and answers with opaque negotiation values", () => {
  const descriptions = [
    SDP,
    `${SDP.replace("a=setup:actpass", "a=setup:active")}a=candidate:1 1 UDP 2122260223 192.0.2.1 50000 typ host\r\n`,
    [
      "v=0",
      "o=- 12345678901234567890 2 IN IP6 ::1",
      "s=Grüße",
      "i=Synthetic test session",
      "u=https://example.invalid/session",
      "e=test@example.invalid",
      "p=+1 555 0100",
      "c=IN IP6 ::",
      "b=AS:128",
      "t=0 0",
      "r=7d 1h 0 25h",
      "z=2882844526 -1h",
      "t=3000000000 3000003600",
      "k=prompt",
      "a=group:BUNDLE audio data",
      "a=x-extension:opaque ü /?token=a=b",
      "m=audio 0 UDP/TLS/RTP/SAVPF 111 0",
      "i=Synthetic audio",
      "b=AS:64",
      "a=mid:audio",
      "a=inactive",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      "c=IN IP6 ::1",
      "a=mid:data",
      "a=sctp-port:5000",
      "",
    ].join("\r\n"),
  ];
  for (const sdp of descriptions) {
    assert.deepEqual(
      JSON.parse(encodeLiveRequest(multipart(session(), sdp), LIVE_MULTIPART_CONTENT_TYPE)),
      { sdp, session: session() },
    );
    const body = Buffer.from(sdp);
    assert.equal(projectLiveResponse(body, { location: "/v1/realtime/calls/rtc_example" }).body, body);
  }
});

test("GPT-Live rejects incomplete SDP, invalid records and ambiguous session framing on both boundaries", () => {
  for (const sdp of [
    "v=0\r\n",
    SDP.replace("o=- 1 1 IN IP4 127.0.0.1\r\n", ""),
    SDP.replace("s=-\r\n", ""),
    SDP.replace("t=0 0\r\n", ""),
    SDP.slice(0, -2),
    SDP.replace("s=-\r\n", "s=-\n"),
    SDP.replace("s=-\r\n", "s=-\r"),
    SDP.replace("s=-\r\n", "s=-\r\n\r\n"),
    SDP.replace("s=-\r\n", "s=\r\n"),
    SDP.replace("s=-\r\n", "s=-\r\ns=second\r\n"),
    SDP.replace("s=-\r\n", "s=-\r\nv=0\r\n"),
    SDP.replace("s=-\r\n", "s=-\r\no=- 2 2 IN IP4 127.0.0.1\r\n"),
    SDP.replace("o=- 1 1 IN IP4 127.0.0.1", "o=- invalid"),
    SDP.replace("o=- 1 1 IN IP4 127.0.0.1", "o=- first 1 IN IP4 127.0.0.1"),
    SDP.replace("t=0 0", "t=zero 0"),
    SDP.replace("t=0 0", "t=0"),
    SDP.replace("c=IN IP4 0.0.0.0", "c=IN IP4"),
    SDP.replace("c=IN IP4 0.0.0.0\r\n", ""),
    SDP.replace("m=audio 9 UDP/TLS/RTP/SAVPF 111", "m=audio 9 UDP/TLS/RTP/SAVPF"),
    SDP.replace("m=audio 9 UDP/TLS/RTP/SAVPF 111", "m=audio port UDP/TLS/RTP/SAVPF 111"),
    SDP.replace("a=sendrecv", "x=unknown"),
    SDP.replace("a=sendrecv", "a="),
    SDP.replace("a=sendrecv", "A=sendrecv"),
    SDP.replace("a=sendrecv", "attribute=sendrecv"),
    SDP.replace("a=sendrecv", `not-a-record ${CANARY}`),
    `${SDP}t=0 0\r\n`,
    SDP.replace("t=0 0\r\na=group:BUNDLE 0", "a=group:BUNDLE 0\r\nt=0 0"),
  ]) {
    assertInvalidRequest(multipart(session(), sdp));
    assertInvalidResponse(Buffer.from(sdp));
  }
});

test("GPT-Live preserves SDP and projects only a relative canonical call Location", () => {
  for (const id of ["rtc_example_A-1", "019eb97d-8e9a-7ff3-94b0-ea019babd5d7"]) {
    for (const location of [
      `/v1/realtime/calls/${id}`,
      `https://${CANARY}.example/backend-api/codex/realtime/calls/${id}?private=${CANARY}`,
    ]) {
      const body = Buffer.from(SDP);
      const projected = projectLiveResponse(body, { location, "set-cookie": CANARY });
      assert.deepEqual(projected, { body, location: `/v1/live/${id}` });
      assert.equal(JSON.stringify(projected).includes(CANARY), false);
    }
  }
});

test("GPT-Live rejects missing, malformed or nonterminal call IDs without disclosing Location", () => {
  for (const location of [
    undefined, "", "/v1/realtime/calls", "/v1/realtime/calls/rtc_",
    `/v1/realtime/calls/${CANARY}`,
    "/v1/realtime/calls/rtc_example/extra",
    "/v1/realtime/calls/rtc_example/",
    "/v1/realtime/calls/rtc_%65xample",
    "/v1/realtime/calls/rtc_example#private",
    "/v1/realtime/calls/rtc_example\r\nX-Private: value",
    `/v1/realtime/calls/rtc_${"x".repeat(129)}`,
    ["/v1/realtime/calls/rtc_first", "/v1/realtime/calls/rtc_second"],
  ]) {
    assertInvalidResponse(Buffer.from(SDP), { location });
  }
});

test("GPT-Live rejects invalid UTF-8, non-SDP and oversized native answers", () => {
  for (const body of [
    Buffer.alloc(0),
    Buffer.from(`{"error":"${CANARY}"}`),
    Buffer.from("v=0\n"),
    Buffer.from(`${SDP}\u0000${CANARY}`),
    Buffer.concat([Buffer.from(SDP), Buffer.from([0xc0, 0x80])]),
    Buffer.from(`${SDP}${"a".repeat(256 * 1024)}`),
  ]) {
    assertInvalidResponse(body);
  }
});
