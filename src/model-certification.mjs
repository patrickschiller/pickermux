import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

export const MODEL_CERTIFICATION_CONTRACT_VERSION = 1;
export const EFFICIENT_FIDELITY_CERTIFICATION_GATE = "toolSearch";

export const REQUIRED_CERTIFICATION_GATES = Object.freeze([
  "text",
  "stream",
  "function",
  "parameterless",
  "namespaceJson",
  "namespaceStream",
  "toolResult",
  "longContext",
]);

const STORE_KEYS = new Set([
  "contractVersion",
  "pendingDeactivations",
  "probeAuthorizations",
  "receipts",
]);
const RECEIPT_KEYS = new Set(["fingerprint", "passedAt", "gates"]);
const SUBJECT_KEYS = new Set([
  "providerId",
  "providerKind",
  "baseUrl",
  "publicModelId",
  "upstreamModelId",
  "contextWindow",
  "reasoning",
  "capabilities",
  "codexClientVersion",
]);
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unsupported property ${key}`);
    }
  }
}

function requireSingleLine(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a non-empty single line`);
  }
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label} must be a non-empty single line`);
  }
  return normalized;
}

function normalizeBaseUrl(value) {
  const input = requireSingleLine(value, "baseUrl");
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("baseUrl must be an absolute HTTP or HTTPS URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseUrl must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash || !url.hostname) {
    throw new Error("baseUrl must not contain credentials, a query, or a fragment");
  }
  return url.toString().replace(/\/+$/u, "");
}

function canonicalJsonValue(value, label, ancestors = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} must contain only JSON values`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${label} must not contain circular references`);
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      canonicalJsonValue(item, `${label}[${index}]`, nextAncestors),
    );
  }
  requirePlainObject(value, label);
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    normalized[key] = canonicalJsonValue(
      value[key],
      `${label}.${key}`,
      nextAncestors,
    );
  }
  return normalized;
}

/**
 * Produce the complete, canonical input to a certification fingerprint. The
 * returned object is safe to hash, but is deliberately never written to the
 * receipt store: probe prompts, answers and credentials have no store field.
 */
export function createCertificationSubject(input) {
  requirePlainObject(input, "Certification subject");
  assertOnlyKeys(input, SUBJECT_KEYS, "Certification subject");
  const contextWindow = input.contextWindow;
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error("contextWindow must be a positive integer");
  }
  requirePlainObject(input.reasoning, "reasoning");
  requirePlainObject(input.capabilities, "capabilities");

  return {
    providerId: requireSingleLine(input.providerId, "providerId"),
    providerKind: requireSingleLine(input.providerKind, "providerKind"),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    publicModelId: requireSingleLine(input.publicModelId, "publicModelId"),
    upstreamModelId: requireSingleLine(input.upstreamModelId, "upstreamModelId"),
    contextWindow,
    reasoning: canonicalJsonValue(input.reasoning, "reasoning"),
    capabilities: canonicalJsonValue(input.capabilities, "capabilities"),
    codexClientVersion: requireSingleLine(
      input.codexClientVersion,
      "codexClientVersion",
    ),
  };
}

/** A stable fingerprint changes whenever any routed model contract changes. */
export function computeCertificationFingerprint(input) {
  const subject = createCertificationSubject(input);
  const hash = createHash("sha256")
    .update(`model-bridge-certification-v${MODEL_CERTIFICATION_CONTRACT_VERSION}\0`)
    .update(JSON.stringify(subject))
    .digest("hex");
  return `sha256:${hash}`;
}

function normalizeGates(gates, label = "Certification gates") {
  requirePlainObject(gates, label);
  const supplied = Object.keys(gates).sort();
  const required = [...REQUIRED_CERTIFICATION_GATES].sort();
  const efficient = [...required, EFFICIENT_FIDELITY_CERTIFICATION_GATE].sort();
  const matches = (expected) =>
    supplied.length === expected.length &&
    supplied.every((key, index) => key === expected[index]);
  if (!matches(required) && !matches(efficient)) {
    throw new Error(
      `${label} must contain exactly the direct gates and optionally ${EFFICIENT_FIDELITY_CERTIFICATION_GATE}`,
    );
  }
  const normalized = {};
  const ordered = [
    ...REQUIRED_CERTIFICATION_GATES,
    ...(supplied.includes(EFFICIENT_FIDELITY_CERTIFICATION_GATE)
      ? [EFFICIENT_FIDELITY_CERTIFICATION_GATE]
      : []),
  ];
  for (const gate of ordered) {
    if (gates[gate] !== true) {
      throw new Error(`${label}.${gate} must be true`);
    }
    normalized[gate] = true;
  }
  return normalized;
}

function normalizeEfficientFidelityGates(gates) {
  requirePlainObject(gates, "Efficient Fidelity certification gates");
  const keys = Object.keys(gates);
  if (
    keys.length !== 1 ||
    keys[0] !== EFFICIENT_FIDELITY_CERTIFICATION_GATE ||
    gates[EFFICIENT_FIDELITY_CERTIFICATION_GATE] !== true
  ) {
    throw new Error(
      `Efficient Fidelity certification gates must contain exactly ${EFFICIENT_FIDELITY_CERTIFICATION_GATE}=true`,
    );
  }
  return { [EFFICIENT_FIDELITY_CERTIFICATION_GATE]: true };
}

function normalizePassedAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("passedAt must be a valid date");
  }
  return date.toISOString();
}

function normalizeReceipt(value, publicModelId) {
  requirePlainObject(value, `Receipt ${publicModelId}`);
  assertOnlyKeys(value, RECEIPT_KEYS, `Receipt ${publicModelId}`);
  if (!FINGERPRINT_PATTERN.test(value.fingerprint ?? "")) {
    throw new Error(`Receipt ${publicModelId} has an invalid fingerprint`);
  }
  return {
    fingerprint: value.fingerprint,
    passedAt: normalizePassedAt(value.passedAt),
    gates: normalizeGates(value.gates, `Receipt ${publicModelId}.gates`),
  };
}

function normalizeModelIdList(value = [], {
  property,
  itemLabel,
}) {
  if (!Array.isArray(value)) {
    throw new Error(`Certification store ${property} must be an array`);
  }
  const normalized = value.map((publicModelId) =>
    requireSingleLine(publicModelId, itemLabel),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(
      `Certification store ${property} must not contain duplicates`,
    );
  }
  return normalized.sort();
}

function emptyStore() {
  return { contractVersion: MODEL_CERTIFICATION_CONTRACT_VERSION, receipts: {} };
}

export function validateCertificationStore(value) {
  requirePlainObject(value, "Certification store");
  assertOnlyKeys(value, STORE_KEYS, "Certification store");
  if (value.contractVersion !== MODEL_CERTIFICATION_CONTRACT_VERSION) {
    throw new Error(
      `Certification store contractVersion must be ${MODEL_CERTIFICATION_CONTRACT_VERSION}`,
    );
  }
  requirePlainObject(value.receipts, "Certification store receipts");
  const pendingDeactivations = normalizeModelIdList(
    value.pendingDeactivations,
    {
      property: "pendingDeactivations",
      itemLabel: "Pending certification public model id",
    },
  );
  const probeAuthorizations = normalizeModelIdList(
    value.probeAuthorizations,
    {
      property: "probeAuthorizations",
      itemLabel: "Authorized certification probe public model id",
    },
  );
  const pending = new Set(pendingDeactivations);
  if (probeAuthorizations.some((publicModelId) => !pending.has(publicModelId))) {
    throw new Error(
      "Certification store probeAuthorizations must be pending deactivations",
    );
  }
  const receipts = {};
  for (const publicModelId of Object.keys(value.receipts).sort()) {
    requireSingleLine(publicModelId, "Receipt public model id");
    receipts[publicModelId] = normalizeReceipt(
      value.receipts[publicModelId],
      publicModelId,
    );
  }
  return {
    contractVersion: MODEL_CERTIFICATION_CONTRACT_VERSION,
    ...(pendingDeactivations.length > 0 ? { pendingDeactivations } : {}),
    ...(probeAuthorizations.length > 0 ? { probeAuthorizations } : {}),
    receipts,
  };
}

function requireStorePath(storePath) {
  if (typeof storePath !== "string" || !storePath.trim()) {
    throw new Error("Certification store path must not be empty");
  }
  return path.resolve(storePath);
}

export async function readCertificationStore(storePath) {
  const destination = requireStorePath(storePath);
  let text;
  try {
    text = await readFile(destination, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyStore();
    throw new Error(`Failed to read certification store ${destination}`, {
      cause: error,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse certification store ${destination}`, {
      cause: error,
    });
  }
  return validateCertificationStore(parsed);
}

async function writeCertificationStoreAtomic(storePath, store) {
  const destination = requireStorePath(storePath);
  const normalized = validateCertificationStore(store);
  const directory = path.dirname(destination);
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });

  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, destination);

    try {
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // The atomic rename already succeeded. Directory fsync is best effort.
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw new Error(`Failed to atomically write certification store ${destination}`, {
      cause: error,
    });
  }

  const written = await stat(destination);
  if ((written.mode & 0o777) !== 0o600) {
    throw new Error(`Certification store permissions are not 0600: ${destination}`);
  }
  return normalized;
}

function evaluateStoredModelCertification(store, input) {
  const normalizedStore = validateCertificationStore(store);
  const subject = createCertificationSubject(input);
  const expectedFingerprint = computeCertificationFingerprint(subject);
  const receipt = Object.hasOwn(normalizedStore.receipts, subject.publicModelId)
    ? normalizedStore.receipts[subject.publicModelId]
    : undefined;
  const result = !receipt
    ? {
      status: "missing",
      publicModelId: subject.publicModelId,
      expectedFingerprint,
    }
    : {
        status: receipt.fingerprint === expectedFingerprint ? "valid" : "stale",
        publicModelId: subject.publicModelId,
        expectedFingerprint,
        receipt,
      };
  return { normalizedStore, result };
}

export function evaluateModelCertification(store, input) {
  const { normalizedStore, result } = evaluateStoredModelCertification(
    store,
    input,
  );
  return normalizedStore.pendingDeactivations?.includes(result.publicModelId)
    ? { ...result, status: "pending" }
    : result;
}

export async function getModelCertificationStatus(storePath, input) {
  return evaluateModelCertification(await readCertificationStore(storePath), input);
}

export function evaluateEfficientFidelityCertification(store, input) {
  const subject = createCertificationSubject(input);
  const direct = evaluateModelCertification(store, subject);
  if (direct.status !== "valid") return direct;
  return {
    ...direct,
    status:
      subject.providerKind === "lmstudio-responses" &&
      direct.receipt.gates[EFFICIENT_FIDELITY_CERTIFICATION_GATE] === true
        ? "valid"
        : "missing",
  };
}

/** Remove a previous pass before starting any new live certification probes. */
export async function invalidateModelCertification(storePath, input) {
  const subject = createCertificationSubject(input);
  const store = await readCertificationStore(storePath);
  if (!Object.hasOwn(store.receipts, subject.publicModelId)) return false;
  delete store.receipts[subject.publicModelId];
  await writeCertificationStoreAtomic(storePath, store);
  return true;
}

function normalizePublicModelIds(publicModelIds) {
  if (!Array.isArray(publicModelIds) || publicModelIds.length === 0) {
    throw new Error("Certification deactivation requires at least one model id");
  }
  const normalized = publicModelIds.map((publicModelId) =>
    requireSingleLine(publicModelId, "Certification deactivation model id"),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Certification deactivation model ids must not contain duplicates");
  }
  return normalized.sort();
}

/**
 * Persist a conservative publication barrier while keeping the last valid
 * receipts available for rollback. Evaluators suppress every staged model.
 */
export async function stageModelCertificationDeactivation(
  storePath,
  publicModelIds,
) {
  const normalizedIds = normalizePublicModelIds(publicModelIds);
  const store = await readCertificationStore(storePath);
  store.pendingDeactivations = [
    ...new Set([...(store.pendingDeactivations ?? []), ...normalizedIds]),
  ].sort();
  const staged = new Set(normalizedIds);
  const remainingAuthorizations = (store.probeAuthorizations ?? []).filter(
    (publicModelId) => !staged.has(publicModelId),
  );
  if (remainingAuthorizations.length > 0) {
    store.probeAuthorizations = remainingAuthorizations;
  } else {
    delete store.probeAuthorizations;
  }
  await writeCertificationStoreAtomic(storePath, store);
  return Object.freeze([...normalizedIds]);
}

/**
 * Remove the old receipts only after the staged text-only catalog is live.
 * The publication barrier remains in place throughout the live probes.
 */
export async function commitModelCertificationDeactivation(
  storePath,
  publicModelIds,
) {
  const normalizedIds = normalizePublicModelIds(publicModelIds);
  const store = await readCertificationStore(storePath);
  const pending = new Set(store.pendingDeactivations ?? []);
  if (normalizedIds.some((publicModelId) => !pending.has(publicModelId))) {
    throw new Error(
      "Certification deactivation was not staged for every requested model",
    );
  }
  for (const publicModelId of normalizedIds) {
    delete store.receipts[publicModelId];
  }
  store.probeAuthorizations = [
    ...new Set([...(store.probeAuthorizations ?? []), ...normalizedIds]),
  ].sort();
  await writeCertificationStoreAtomic(storePath, store);
  return Object.freeze([...normalizedIds]);
}

/** Clear only the requested publication barriers after success or safe abort. */
export async function clearModelCertificationDeactivation(
  storePath,
  publicModelIds,
) {
  const normalizedIds = normalizePublicModelIds(publicModelIds);
  const store = await readCertificationStore(storePath);
  const removed = new Set(normalizedIds);
  const remaining = (store.pendingDeactivations ?? []).filter(
    (publicModelId) => !removed.has(publicModelId),
  );
  const remainingAuthorizations = (store.probeAuthorizations ?? []).filter(
    (publicModelId) => !removed.has(publicModelId),
  );
  if (remaining.length > 0) store.pendingDeactivations = remaining;
  else delete store.pendingDeactivations;
  if (remainingAuthorizations.length > 0) {
    store.probeAuthorizations = remainingAuthorizations;
  } else {
    delete store.probeAuthorizations;
  }
  await writeCertificationStoreAtomic(storePath, store);
  return Object.freeze([...remaining]);
}

export async function assertNoPendingModelCertification(storePath) {
  const store = await readCertificationStore(storePath);
  if ((store.pendingDeactivations?.length ?? 0) > 0) {
    throw new Error(
      "Catalog synchronization is paused while model certification recovery is pending",
    );
  }
}

export async function listPendingModelCertificationIds(storePath) {
  const store = await readCertificationStore(storePath);
  return Object.freeze([...(store.pendingDeactivations ?? [])]);
}

/**
 * Fail closed at request time so a stale in-memory route cannot retain tool
 * authority after the persistent deactivation barrier has been staged.
 */
export async function assertModelCertificationRequestAllowed(
  storePath,
  publicModelId,
  {
    certificationRequest = false,
    requiresDirectReceipt = false,
    requiresEfficientFidelityReceipt = false,
  } = {},
) {
  for (const [name, value] of Object.entries({
    certificationRequest,
    requiresDirectReceipt,
    requiresEfficientFidelityReceipt,
  })) {
    if (typeof value !== "boolean") {
      throw new TypeError(`${name} must be a boolean`);
    }
  }
  if (requiresEfficientFidelityReceipt && !requiresDirectReceipt) {
    throw new TypeError(
      "requiresEfficientFidelityReceipt requires requiresDirectReceipt",
    );
  }
  const normalizedId = requireSingleLine(
    publicModelId,
    "Certification request public model id",
  );
  const store = await readCertificationStore(storePath);
  const pending = store.pendingDeactivations?.includes(normalizedId) === true;
  if (certificationRequest === true) {
    if (pending && store.probeAuthorizations?.includes(normalizedId)) return;
    throw new Error(
      "Certification probes are blocked outside an authorized conservative publication window",
    );
  }
  if (!pending) {
    const receipt = Object.hasOwn(store.receipts, normalizedId)
      ? store.receipts[normalizedId]
      : undefined;
    if (requiresDirectReceipt && !receipt) {
      throw new Error(
        "The selected model has no active direct certification receipt",
      );
    }
    if (
      requiresEfficientFidelityReceipt &&
      receipt?.gates[EFFICIENT_FIDELITY_CERTIFICATION_GATE] !== true
    ) {
      throw new Error(
        "The selected model has no active Efficient Fidelity certification receipt",
      );
    }
    return;
  }
  throw new Error(
    "The selected model is unavailable while certification recovery is pending",
  );
}

/** Publish a pass only after every required gate completed successfully. */
export async function recordPassedCertification(
  storePath,
  input,
  gates,
  { now = new Date() } = {},
) {
  const subject = createCertificationSubject(input);
  const normalizedGates = normalizeGates(gates);
  if (normalizedGates[EFFICIENT_FIDELITY_CERTIFICATION_GATE] === true) {
    throw new Error(
      "Efficient Fidelity must be recorded only after a valid direct certification",
    );
  }
  const store = await readCertificationStore(storePath);
  const receipt = {
    fingerprint: computeCertificationFingerprint(subject),
    passedAt: normalizePassedAt(now),
    gates: normalizedGates,
  };
  store.receipts[subject.publicModelId] = receipt;
  await writeCertificationStoreAtomic(storePath, store);
  return receipt;
}

/** Add the search grant without weakening or replacing a valid direct grant. */
export async function recordPassedEfficientFidelityCertification(
  storePath,
  input,
  gates,
  { now = new Date() } = {},
) {
  const subject = createCertificationSubject(input);
  const normalizedGates = normalizeEfficientFidelityGates(gates);
  if (subject.providerKind !== "lmstudio-responses") {
    throw new Error("Efficient Fidelity is available only for LM Studio routes");
  }
  const store = await readCertificationStore(storePath);
  const { result: direct } = evaluateStoredModelCertification(store, subject);
  if (direct.status !== "valid") {
    throw new Error(
      "Efficient Fidelity requires a valid direct certification receipt",
    );
  }
  const receipt = {
    fingerprint: direct.receipt.fingerprint,
    passedAt: normalizePassedAt(now),
    gates: {
      ...direct.receipt.gates,
      ...normalizedGates,
    },
  };
  store.receipts[subject.publicModelId] = receipt;
  await writeCertificationStoreAtomic(storePath, store);
  return receipt;
}
