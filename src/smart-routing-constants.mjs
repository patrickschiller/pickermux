export const AUTO_MODEL_SLUG = "pickermux/auto";
export const AUTO_MODEL_DISPLAY_NAME = "Auto – Smart Routing";
export const SMART_ROUTING_STRATEGY = "local-first-v1";
export const AFFINITY_TTL_MS = 30 * 60 * 1_000;
export const AFFINITY_MAX_ENTRIES = 256;

export function isAutoModelSlugVariant(value) {
  return typeof value === "string" && value.toLowerCase() === AUTO_MODEL_SLUG;
}
