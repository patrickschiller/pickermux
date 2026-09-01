import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { writeServiceConfig } from "./service-package.mjs";

export const COMPATIBILITY_MANIFEST_SCHEMA_VERSION = 1;
export const CURRENT_BRIDGE_CONTRACT = "codex-responses-bridge/p5-v2";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Bundled catalog must contain only JSON-compatible values");
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function hashBundledCatalog(bundledCatalog) {
  if (!isPlainObject(bundledCatalog) || !Array.isArray(bundledCatalog.models)) {
    throw new Error("Bundled catalog must contain a models array");
  }
  return createHash("sha256").update(canonicalJson(bundledCatalog)).digest("hex");
}

export function createCompatibilityManifest({
  bridgeContract = CURRENT_BRIDGE_CONTRACT,
  codexClientVersion,
  bundledCatalog,
} = {}) {
  return {
    schemaVersion: COMPATIBILITY_MANIFEST_SCHEMA_VERSION,
    bridgeContract: requireNonEmptyString(bridgeContract, "Bridge contract"),
    codexClientVersion: requireNonEmptyString(
      codexClientVersion,
      "Codex client version",
    ),
    bundledCatalogSha256: hashBundledCatalog(bundledCatalog),
  };
}

export function validateCompatibilityManifest(manifest) {
  if (!isPlainObject(manifest)) {
    throw new Error("Compatibility manifest must be an object");
  }
  if (manifest.schemaVersion !== COMPATIBILITY_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported compatibility manifest schema ${String(manifest.schemaVersion)}`,
    );
  }
  const bridgeContract = requireNonEmptyString(
    manifest.bridgeContract,
    "Manifest bridge contract",
  );
  const codexClientVersion = requireNonEmptyString(
    manifest.codexClientVersion,
    "Manifest Codex client version",
  );
  if (
    typeof manifest.bundledCatalogSha256 !== "string" ||
    !SHA256_PATTERN.test(manifest.bundledCatalogSha256)
  ) {
    throw new Error("Manifest bundled catalog hash must be a lowercase SHA-256 value");
  }
  return {
    schemaVersion: COMPATIBILITY_MANIFEST_SCHEMA_VERSION,
    bridgeContract,
    codexClientVersion,
    bundledCatalogSha256: manifest.bundledCatalogSha256,
  };
}

export async function writeCompatibilityManifest(manifestPath, manifest) {
  const destination = path.resolve(
    requireNonEmptyString(manifestPath, "Compatibility manifest path"),
  );
  const validated = validateCompatibilityManifest(manifest);
  await writeServiceConfig(destination, validated);
  return destination;
}

export async function readCompatibilityManifest(manifestPath, {
  readFileImpl = readFile,
} = {}) {
  const destination = path.resolve(
    requireNonEmptyString(manifestPath, "Compatibility manifest path"),
  );
  const raw = await readFileImpl(destination, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw invalidManifestError(destination, error);
  }
  try {
    return validateCompatibilityManifest(parsed);
  } catch (error) {
    throw invalidManifestError(destination, error);
  }
}

/**
 * Compare the installed manifest with the current bridge/Codex contract.
 * Missing or malformed managed state is an update requirement, while failures
 * to read an existing file (for example EACCES) remain operational errors.
 */
export async function checkCurrentCompatibility({
  manifest,
  manifestPath,
  bridgeContract = CURRENT_BRIDGE_CONTRACT,
  codexClientVersion,
  bundledCatalog,
  readFileImpl = readFile,
} = {}) {
  if (manifest !== undefined && manifestPath !== undefined) {
    throw new Error("Supply either a compatibility manifest or its path, not both");
  }
  const expected = createCompatibilityManifest({
    bridgeContract,
    codexClientVersion,
    bundledCatalog,
  });
  let current;
  if (manifest !== undefined) {
    try {
      current = validateCompatibilityManifest(manifest);
    } catch {
      return compatibilityResult(expected, null, ["manifest-invalid"]);
    }
  } else {
    if (manifestPath === undefined) {
      throw new Error("Compatibility check requires a manifest or manifest path");
    }
    try {
      current = await readCompatibilityManifest(manifestPath, { readFileImpl });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return compatibilityResult(expected, null, ["manifest-missing"]);
      }
      if (error?.code === "INVALID_COMPATIBILITY_MANIFEST") {
        return compatibilityResult(expected, null, ["manifest-invalid"]);
      }
      throw error;
    }
  }

  const reasons = [];
  if (current.bridgeContract !== expected.bridgeContract) {
    reasons.push("bridge-contract");
  }
  if (current.codexClientVersion !== expected.codexClientVersion) {
    reasons.push("codex-client-version");
  }
  if (current.bundledCatalogSha256 !== expected.bundledCatalogSha256) {
    reasons.push("bundled-catalog");
  }
  return compatibilityResult(expected, current, reasons);
}

function invalidManifestError(destination, cause) {
  const error = new Error(`Compatibility manifest is invalid: ${destination}`, {
    cause,
  });
  error.code = "INVALID_COMPATIBILITY_MANIFEST";
  return error;
}

function compatibilityResult(expected, current, reasons) {
  const compatible = reasons.length === 0;
  return {
    status: compatible ? "compatible" : "update-required",
    compatible,
    updateRequired: !compatible,
    reasons,
    expected,
    current,
  };
}
