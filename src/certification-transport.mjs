import { timingSafeEqual } from "node:crypto";

export const CERTIFICATION_HEADER = "x-pickermux-certification";

function validToken(value) {
  return (
    typeof value === "string" &&
    value.length >= 16 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function requireCertificationToken(value) {
  if (!validToken(value)) {
    throw new TypeError("Certification token must be a private non-empty string");
  }
  return value;
}

/** Compare the private per-runtime marker without leaking a useful prefix. */
export function isCertificationRequest(headers, expectedToken) {
  if (!validToken(expectedToken)) return false;
  const supplied = headers?.[CERTIFICATION_HEADER];
  if (!validToken(supplied)) return false;
  const actualBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expectedToken, "utf8");
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}
