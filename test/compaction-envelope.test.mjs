import assert from "node:assert/strict";
import { createCipheriv, hkdfSync } from "node:crypto";
import test from "node:test";
import {
  COMPACTION_ENVELOPE_PREFIX,
  CompactionEnvelopeError,
  createCompactionEnvelopeCodec,
  isCompactionEnvelope,
} from "../src/compaction-envelope.mjs";

const SECRET = "TEST_INSTALLATION_CAPABILITY_0123456789_ABCD";
const BINDING = JSON.stringify({ provider: "lmstudio", model: "example/model", context: 32768 });
const SUMMARY = "Decision: verify the source.\nQuelle: https://example.test/ä — 東京 ⛳️ 🧭";
const ERROR_MESSAGE = "The compaction state is invalid or belongs to another model configuration.";

function assertFixedError(callback, canaries = []) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof CompactionEnvelopeError);
    assert.equal(error.name, "CompactionEnvelopeError");
    assert.equal(error.status, 400);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "INVALID_COMPACTION_STATE");
    assert.equal(error.message, ERROR_MESSAGE);
    assert.equal(error.cause, undefined);
    const publicError = `${error.stack}\n${JSON.stringify(error)}`;
    for (const canary of canaries) {
      assert.equal(publicError.includes(canary), false);
    }
    return true;
  });
}

// Construct authenticated but semantically invalid states to exercise the parser
// beyond the authentication boundary. These are fixed test-only secrets.
function authenticatePayload(payload, { raw = false, binding = BINDING } = {}) {
  const key = Buffer.from(hkdfSync(
    "sha256",
    SECRET,
    "PickerMux compaction envelope v1",
    "AES-256-GCM authenticated summary state",
    32,
  ));
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`${COMPACTION_ENVELOPE_PREFIX}\0${binding}`, "utf8"));
  const plaintext = raw ? payload : JSON.stringify(payload);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `${COMPACTION_ENVELOPE_PREFIX}${Buffer.concat([
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString("base64url")}`;
}

test("compaction envelopes preserve Unicode and survive a codec restart with the same key", () => {
  const codec = createCompactionEnvelopeCodec(SECRET);
  const envelope = codec.seal(SUMMARY, BINDING);
  assert.equal(Object.isFrozen(codec), true);
  assert.deepEqual(Object.keys(codec), ["seal", "open"]);
  assert.equal(isCompactionEnvelope(envelope), true);
  assert.equal(codec.open(envelope, BINDING), SUMMARY);
  assert.equal(createCompactionEnvelopeCodec(SECRET).open(envelope, BINDING), SUMMARY);
  assert.equal(envelope.includes(SUMMARY), false);
  assert.equal(envelope.includes(SECRET), false);
  assert.equal(envelope.includes(BINDING), false);
});

test("compaction envelopes use fresh nonces and conservatively account for decoded summary bytes", () => {
  const codec = createCompactionEnvelopeCodec(SECRET);
  for (const summary of ["x", SUMMARY, "🧭".repeat(4096), "x".repeat(16 * 1024)]) {
    const first = codec.seal(summary, BINDING);
    const second = codec.seal(summary, BINDING);
    assert.notEqual(first, second);
    const firstBytes = Buffer.from(first.slice(COMPACTION_ENVELOPE_PREFIX.length), "base64url");
    const secondBytes = Buffer.from(second.slice(COMPACTION_ENVELOPE_PREFIX.length), "base64url");
    assert.equal(firstBytes.subarray(0, 12).equals(secondBytes.subarray(0, 12)), false);
    assert.ok(first.length <= 32 * 1024);
    const estimatedBytes = Math.max(0, Math.floor(first.length * 3 / 4) - 650);
    assert.ok(estimatedBytes >= Buffer.byteLength(summary, "utf8") + 200);
    assert.equal(codec.open(first, BINDING), summary);
  }
});

test("compaction envelopes reject tampering in the nonce, tag, and ciphertext", () => {
  const codec = createCompactionEnvelopeCodec(SECRET);
  const envelope = codec.seal(SUMMARY, BINDING);
  const bytes = Buffer.from(envelope.slice(COMPACTION_ENVELOPE_PREFIX.length), "base64url");
  for (const index of [0, 11, 12, 27, 28, bytes.length - 1]) {
    const modified = Buffer.from(bytes);
    modified[index] ^= 1;
    assertFixedError(() => codec.open(
      `${COMPACTION_ENVELOPE_PREFIX}${modified.toString("base64url")}`,
      BINDING,
    ), [SUMMARY, SECRET, BINDING]);
  }
});

test("compaction envelopes bind state to the installation and exact supplied configuration", () => {
  const codec = createCompactionEnvelopeCodec(SECRET);
  const envelope = codec.seal(SUMMARY, BINDING);
  const foreignCodec = createCompactionEnvelopeCodec("OTHER_INSTALLATION_CAPABILITY_0123456789_ABCD");
  assertFixedError(() => foreignCodec.open(envelope, BINDING), [SUMMARY, SECRET, BINDING]);
  for (const binding of [
    JSON.stringify({ provider: "other", model: "example/model", context: 32768 }),
    JSON.stringify({ provider: "lmstudio", model: "example/other", context: 32768 }),
    JSON.stringify({ provider: "lmstudio", model: "example/model", context: 65536 }),
    `${BINDING} `,
  ]) {
    assertFixedError(() => codec.open(envelope, binding), [SUMMARY, binding]);
  }
});

test("compaction envelopes reject malformed types, encodings, versions, and lengths", () => {
  const codec = createCompactionEnvelopeCodec(SECRET);
  const envelope = codec.seal(SUMMARY, BINDING);
  const encoded = envelope.slice(COMPACTION_ENVELOPE_PREFIX.length);
  for (const value of [
    undefined, null, {}, [], 1, new String(envelope), "", "native-cipher-canary",
    envelope.replace("v1.", "v2."), COMPACTION_ENVELOPE_PREFIX,
    `${COMPACTION_ENVELOPE_PREFIX}A`, `${COMPACTION_ENVELOPE_PREFIX}AA`,
    `${COMPACTION_ENVELOPE_PREFIX}${"A".repeat(37)}`,
    `${COMPACTION_ENVELOPE_PREFIX}${encoded}=`,
    `${COMPACTION_ENVELOPE_PREFIX}${encoded.slice(0, -1)}+`,
    `${COMPACTION_ENVELOPE_PREFIX}${encoded.slice(0, -1)}/`,
    `${COMPACTION_ENVELOPE_PREFIX}\n${encoded}`,
    `${COMPACTION_ENVELOPE_PREFIX}${encoded}\0`,
    `${COMPACTION_ENVELOPE_PREFIX}${"A".repeat(32 * 1024)}`,
    envelope.slice(0, -10),
  ]) {
    assertFixedError(() => codec.open(value, BINDING), ["native-cipher-canary", SUMMARY, BINDING]);
  }
});

test("compaction envelope family recognition guards unknown versions without authenticating them", () => {
  for (const value of [
    COMPACTION_ENVELOPE_PREFIX,
    "pickermux.compaction.v2.invalid",
    "pickermux.compaction.invalid",
  ]) {
    assert.equal(isCompactionEnvelope(value), true);
  }
  for (const value of [undefined, null, {}, [], 1, "", "native-cipher", "xpickermux.compaction.v1."]) {
    assert.equal(isCompactionEnvelope(value), false);
  }
});

test("compaction envelopes reject base64url aliases with nonzero unused bits", () => {
  const codec = createCompactionEnvelopeCodec(SECRET);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let checked = 0;
  for (const summary of ["x", "xx", "xxx"]) {
    const envelope = codec.seal(summary, BINDING);
    const encoded = envelope.slice(COMPACTION_ENVELOPE_PREFIX.length);
    if (encoded.length % 4 === 0) {
      continue;
    }
    const lastIndex = alphabet.indexOf(encoded.at(-1));
    const alias = `${encoded.slice(0, -1)}${alphabet[lastIndex + 1]}`;
    assert.equal(Buffer.from(alias, "base64url").equals(Buffer.from(encoded, "base64url")), true);
    assertFixedError(() => codec.open(`${COMPACTION_ENVELOPE_PREFIX}${alias}`, BINDING));
    checked += 1;
  }
  assert.equal(checked, 2);
});

test("compaction codecs reject invalid secrets without disclosing them", () => {
  for (const secret of [
    undefined, null, {}, [], 1, "", "s".repeat(31), "s".repeat(257),
    `SECRET_CANARY_${"x".repeat(32)}=`, `${SECRET}\n`, `${SECRET}\0`, `${SECRET}é`,
  ]) {
    assertFixedError(() => createCompactionEnvelopeCodec(secret), ["SECRET_CANARY", SECRET]);
  }
  for (const secret of ["s".repeat(32), "s".repeat(128), "s".repeat(256), "_-".repeat(16)]) {
    const codec = createCompactionEnvelopeCodec(secret);
    assert.equal(codec.open(codec.seal("ok", BINDING), BINDING), "ok");
  }
});

test("compaction envelopes enforce UTF-8 summary and binding bounds before encryption", () => {
  const codec = createCompactionEnvelopeCodec(SECRET);
  for (const summary of [
    undefined, null, {}, [], 1, "", "SUMMARY_CANARY\0", "x".repeat(16 * 1024 + 1),
    "🧭".repeat(4097), "\ud800", "\udfff", "\u0001".repeat(16 * 1024),
  ]) {
    assertFixedError(() => codec.seal(summary, BINDING), ["SUMMARY_CANARY", BINDING]);
  }
  const envelope = codec.seal(SUMMARY, BINDING);
  for (const binding of [
    undefined, null, {}, [], 1, "", "BINDING_CANARY".repeat(400), "🧭".repeat(1025), "\ud800",
  ]) {
    assertFixedError(() => codec.seal(SUMMARY, binding), ["BINDING_CANARY", SUMMARY]);
    assertFixedError(() => codec.open(envelope, binding), ["BINDING_CANARY", SUMMARY]);
  }
  for (const binding of ["b".repeat(4096), "🧭".repeat(1024)]) {
    assert.equal(codec.open(codec.seal(SUMMARY, binding), binding), SUMMARY);
  }
});

test("compaction envelopes reject authenticated invalid payload shapes and summaries", () => {
  const codec = createCompactionEnvelopeCodec(SECRET);
  const valid = { version: 1, summary: SUMMARY, padding: ".".repeat(1024) };
  for (const payload of [
    null, [], 1, "PAYLOAD_CANARY", {},
    { ...valid, version: 2 }, { ...valid, version: "1" },
    { summary: SUMMARY, padding: valid.padding },
    { ...valid, unknown: "PAYLOAD_CANARY" },
    { ...valid, summary: null }, { ...valid, summary: [] },
    { ...valid, summary: "" }, { ...valid, summary: "SUMMARY_CANARY\0" },
    { ...valid, summary: "🧭".repeat(4097) }, { ...valid, summary: "\ud800" },
    { ...valid, padding: null }, { ...valid, padding: [] },
    { ...valid, padding: ".".repeat(999) }, { ...valid, padding: ".".repeat(2049) },
    { ...valid, padding: "é".repeat(1024) }, { ...valid, padding: "\0".repeat(1024) },
  ]) {
    const envelope = authenticatePayload(payload);
    assertFixedError(() => codec.open(envelope, BINDING), [SUMMARY, "SUMMARY_CANARY", "PAYLOAD_CANARY"]);
  }
  for (const padding of [" ".repeat(1000), "~".repeat(2048)]) {
    assert.equal(codec.open(authenticatePayload({ ...valid, padding }), BINDING), SUMMARY);
  }
});

test("compaction envelopes reject authenticated noncanonical JSON and invalid UTF-8", () => {
  const codec = createCompactionEnvelopeCodec(SECRET);
  const padding = ".".repeat(1024);
  for (const text of [
    "not-json-PAYLOAD_CANARY",
    JSON.stringify({ summary: "x", version: 1, padding }),
    ` {"version":1,"summary":"x","padding":"${padding}"}`,
    `{"version":1,"summary":"old","summary":"x","padding":"${padding}"}`,
    `{"version":1.0,"summary":"x","padding":"${padding}"}`,
    `{"version":1,"summary":"\\u0078","padding":"${padding}"}`,
    Buffer.from([0xff, 0xfe]),
  ]) {
    assertFixedError(() => codec.open(authenticatePayload(text, { raw: true }), BINDING), ["PAYLOAD_CANARY"]);
  }
});
