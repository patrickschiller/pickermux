export const MLX_TOOL_PROTOCOL = "pickermux-mlx-tools-v1";
export const MLX_MIN_CONTEXT_WINDOW = 1_024;
export const MLX_MAX_CONTEXT_WINDOW = 262_144;

const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const isFingerprint = (value) => typeof value === "string" && FINGERPRINT.test(value);
const KEYS = new Set([
  "mlxToolProtocol", "modelFingerprint", "runtimeFingerprint", "mlxProfileDigest", "mlxMaxOutputTokens",
]);

/** A protocol declaration binds receipts; it never grants tools by itself. */
export function normalizeMlxCapabilities(value = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !KEYS.has(key))) {
    throw new Error("The local MLX model capability contract is unsupported");
  }
  const result = { ...value };
  if (result.mlxMaxOutputTokens !== undefined &&
    (!Number.isSafeInteger(result.mlxMaxOutputTokens) || result.mlxMaxOutputTokens < 1 || result.mlxMaxOutputTokens > 2048)) {
    throw new Error("The local MLX output token bound is invalid");
  }
  if (result.mlxProfileDigest !== undefined && !isFingerprint(result.mlxProfileDigest)) {
    throw new Error("The local MLX model profile identity is invalid");
  }
  const toolKeys = ["mlxToolProtocol", "modelFingerprint", "runtimeFingerprint"];
  if (toolKeys.some((key) => Object.hasOwn(result, key)) &&
    (result.mlxToolProtocol !== MLX_TOOL_PROTOCOL ||
      !isFingerprint(result.modelFingerprint) || !isFingerprint(result.runtimeFingerprint) ||
      result.mlxMaxOutputTokens === undefined)) {
    throw new Error("The local MLX tool protocol identity is invalid");
  }
  return Object.freeze(result);
}

export function supportsMlxTools(value) {
  try {
    return normalizeMlxCapabilities(value).mlxToolProtocol === MLX_TOOL_PROTOCOL;
  } catch {
    return false;
  }
}
