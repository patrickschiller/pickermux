import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const COMPACTION_ENVELOPE_FAMILY = "pickermux.compaction.";
export const COMPACTION_ENVELOPE_PREFIX = `${COMPACTION_ENVELOPE_FAMILY}v1.`;

const MAX_SUMMARY_BYTES = 16 * 1024;
const MAX_BINDING_BYTES = 4096;
const MAX_ENVELOPE_BYTES = 32 * 1024;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PADDING = ".".repeat(1024);
const KEY_SALT = "PickerMux compaction envelope v1";
const KEY_INFO = "AES-256-GCM authenticated summary state";

export class CompactionEnvelopeError extends Error {
  constructor() {
    super("The compaction state is invalid or belongs to another model configuration.");
    this.name = "CompactionEnvelopeError";
    this.status = 400;
    this.statusCode = 400;
    this.code = "INVALID_COMPACTION_STATE";
  }
}

function fail() {
  throw new CompactionEnvelopeError();
}

function validateSummary(summary) {
  if (
    typeof summary !== "string" ||
    summary.length === 0 ||
    summary.length > MAX_SUMMARY_BYTES ||
    !summary.isWellFormed() ||
    summary.includes("\0") ||
    Buffer.byteLength(summary, "utf8") > MAX_SUMMARY_BYTES
  ) {
    fail();
  }
}

function createAdditionalData(binding) {
  if (
    typeof binding !== "string" ||
    binding.length === 0 ||
    binding.length > MAX_BINDING_BYTES ||
    !binding.isWellFormed() ||
    Buffer.byteLength(binding, "utf8") > MAX_BINDING_BYTES
  ) {
    fail();
  }
  return Buffer.from(`${COMPACTION_ENVELOPE_PREFIX}\0${binding}`, "utf8");
}

// Recognize our entire family at native boundaries, including unsupported versions.
// Authentication and format validation belong exclusively to open().
export function isCompactionEnvelope(value) {
  return typeof value === "string" && value.startsWith(COMPACTION_ENVELOPE_FAMILY);
}

export function createCompactionEnvelopeCodec(secret) {
  if (
    typeof secret !== "string" ||
    secret.length < 32 ||
    secret.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(secret)
  ) {
    fail();
  }

  let key;
  try {
    // The installation capability remains private; this key has a distinct purpose.
    key = Buffer.from(hkdfSync("sha256", secret, KEY_SALT, KEY_INFO, 32));
  } catch {
    fail();
  }

  return Object.freeze({
    seal(summary, binding) {
      validateSummary(summary);
      const additionalData = createAdditionalData(binding);
      // Codex discounts 650 bytes when estimating an opaque compaction item.
      // Authenticated padding keeps that estimate conservative for our format.
      const plaintext = JSON.stringify({ version: 1, summary, padding: PADDING });
      const plaintextBytes = Buffer.byteLength(plaintext, "utf8");
      const encodedBytes = Math.ceil((IV_BYTES + TAG_BYTES + plaintextBytes) * 4 / 3);
      if (COMPACTION_ENVELOPE_PREFIX.length + encodedBytes > MAX_ENVELOPE_BYTES) {
        fail();
      }

      try {
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
        cipher.setAAD(additionalData);
        const ciphertext = Buffer.concat([
          cipher.update(plaintext, "utf8"),
          cipher.final(),
        ]);
        const encoded = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
        return `${COMPACTION_ENVELOPE_PREFIX}${encoded}`;
      } catch {
        fail();
      }
    },

    open(encryptedContent, binding) {
      if (
        typeof encryptedContent !== "string" ||
        encryptedContent.length > MAX_ENVELOPE_BYTES ||
        !encryptedContent.startsWith(COMPACTION_ENVELOPE_PREFIX)
      ) {
        fail();
      }
      const encoded = encryptedContent.slice(COMPACTION_ENVELOPE_PREFIX.length);
      if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) {
        fail();
      }
      const additionalData = createAdditionalData(binding);

      try {
        const bytes = Buffer.from(encoded, "base64url");
        if (
          bytes.length <= IV_BYTES + TAG_BYTES ||
          bytes.toString("base64url") !== encoded
        ) {
          fail();
        }
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          bytes.subarray(0, IV_BYTES),
          { authTagLength: TAG_BYTES },
        );
        decipher.setAAD(additionalData);
        decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        const plaintext = Buffer.concat([
          decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
          decipher.final(),
        ]);
        const text = plaintext.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(plaintext)) {
          fail();
        }
        const payload = JSON.parse(text);
        if (
          payload === null ||
          typeof payload !== "object" ||
          Array.isArray(payload) ||
          Object.keys(payload).join(",") !== "version,summary,padding" ||
          payload.version !== 1 ||
          typeof payload.padding !== "string" ||
          payload.padding.length < 1000 ||
          payload.padding.length > 2048 ||
          !/^[\x20-\x7e]+$/.test(payload.padding) ||
          JSON.stringify(payload) !== text
        ) {
          fail();
        }
        validateSummary(payload.summary);
        return payload.summary;
      } catch {
        fail();
      }
    },
  });
}
