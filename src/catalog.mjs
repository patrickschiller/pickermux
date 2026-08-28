import { execFile as execFileCallback } from "node:child_process";
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
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const DEFAULT_CODEX_PATH = "/Applications/ChatGPT.app/Contents/Resources/codex";
const MAX_BUNDLED_CATALOG_BYTES = 32 * 1024 * 1024;
const MAX_ACCOUNT_CACHE_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const ACCOUNT_CACHE_STALE_AFTER_MS = 15 * 60 * 1_000;
const PREFERRED_DONORS = ["gpt-5.4-mini", "gpt-5.4"];
export const CODEX_CONTEXT_HIGH_RISK_BELOW_TOKENS = 24_576;
export const CODEX_CONTEXT_RECOMMENDED_TOKENS = 32_768;
export const MODEL_DEFAULT_REASONING_DESCRIPTION =
  "Uses the model's loaded reasoning setting";
const REASONING_DESCRIPTIONS = Object.freeze({
  none: "No reasoning",
  minimal: "Minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth",
  high: "Greater reasoning depth",
  xhigh: "Extra high reasoning depth",
  max: "Maximum reasoning depth",
  ultra: "Maximum reasoning with automatic task delegation",
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatInteger(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

/**
 * Keep the actual loaded context visible in the picker. The two thresholds are
 * advisories, not capability overrides: Codex still receives the exact context
 * window reported by LM Studio and the user may select every published model.
 */
export function contextPickerPresentation(contextWindow, { source } = {}) {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error("Context window must be a positive integer");
  }

  const exactContext = formatInteger(contextWindow);
  const lmStudioLive = source === "lmstudio-rest";
  const contextStatement = lmStudioLive
    ? `LM Studio; currently loaded with ${exactContext} context tokens.`
    : `External model; published with ${exactContext} context tokens.`;
  if (contextWindow < CODEX_CONTEXT_HIGH_RISK_BELOW_TOKENS) {
    return {
      prefix: "⚠ ",
      suffix: "",
      description:
        `${contextStatement} ` +
        `Likely too small for the current Codex agent prompt; ` +
        (lmStudioLive
          ? `reload it in LM Studio with ${formatInteger(CODEX_CONTEXT_RECOMMENDED_TOKENS)} tokens or more.`
          : `use a model or deployment with at least ${formatInteger(CODEX_CONTEXT_RECOMMENDED_TOKENS)} tokens of confirmed active context.`),
    };
  }
  if (contextWindow < CODEX_CONTEXT_RECOMMENDED_TOKENS) {
    return {
      prefix: "⚠ ",
      suffix: "",
      description:
        `${contextStatement} ` +
        `At least ${formatInteger(CODEX_CONTEXT_RECOMMENDED_TOKENS)} tokens are recommended for longer Codex turns.`,
    };
  }
  return {
    prefix: "",
    suffix: "",
    description: contextStatement,
  };
}

function parseCatalogJson(raw, label) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.models)) {
    throw new Error(`${label} must contain a models array`);
  }
  if (parsed.models.length === 0) {
    throw new Error(`${label} does not contain any model templates`);
  }
  return parsed;
}

/**
 * Ask the same Codex binary used by Desktop for its version-compatible schema.
 */
export async function loadBundledCatalog({
  codexPath = DEFAULT_CODEX_PATH,
  execFileImpl = execFile,
} = {}) {
  if (typeof codexPath !== "string" || !codexPath.trim()) {
    throw new Error("Codex binary path must not be empty");
  }
  if (typeof execFileImpl !== "function") {
    throw new Error("execFileImpl must be a function");
  }

  let result;
  try {
    result = await execFileImpl(
      codexPath,
      ["debug", "models", "--bundled"],
      {
        encoding: "utf8",
        maxBuffer: MAX_BUNDLED_CATALOG_BYTES,
      },
    );
  } catch {
    throw new Error("Failed to read the bundled model catalog from Codex");
  }

  const stdout = typeof result === "string" ? result : result?.stdout;
  if (typeof stdout !== "string") {
    throw new Error("Codex bundled model command did not return text output");
  }
  return parseCatalogJson(stdout, "Codex bundled model catalog");
}

export async function loadCodexClientVersion({
  codexPath = DEFAULT_CODEX_PATH,
  execFileImpl = execFile,
} = {}) {
  let result;
  try {
    result = await execFileImpl(codexPath, ["--version"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error("Failed to read the Codex client version");
  }
  const stdout = typeof result === "string" ? result : result?.stdout;
  const version = /(\d+\.\d+\.\d+)/u.exec(stdout ?? "")?.[1];
  if (!version) throw new Error("Codex version output has no semantic version");
  return version;
}

/**
 * Load the last account-scoped catalog fetched by Codex. A new Codex process
 * using the bridge's static catalog does not refresh this cache; an already-running
 * dynamic model manager still can. Callers therefore surface its age.
 */
export async function loadCachedNativeCatalog({
  codexHome,
  expectedClientVersion,
  now = Date.now(),
  readFileImpl = readFile,
} = {}) {
  if (typeof codexHome !== "string" || !codexHome.trim()) {
    throw new Error("Codex home must not be empty");
  }
  const cachePath = path.join(path.resolve(codexHome), "models_cache.json");
  let raw;
  try {
    raw = await readFileImpl(cachePath, "utf8");
  } catch (error) {
    throw new Error(`Failed to read Codex account model cache ${cachePath}`, {
      cause: error,
    });
  }
  const parsed = parseCatalogJson(raw, "Codex account model cache");
  if (typeof parsed.client_version !== "string" || !parsed.client_version.trim()) {
    throw new Error("Codex account model cache has no client_version");
  }
  if (
    expectedClientVersion !== undefined &&
    parsed.client_version !== expectedClientVersion
  ) {
    throw new Error(
      `Codex account model cache version ${parsed.client_version} does not match client ${expectedClientVersion}`,
    );
  }
  const fetchedAt = Date.parse(parsed.fetched_at);
  if (typeof parsed.fetched_at !== "string" || !Number.isFinite(fetchedAt)) {
    throw new Error("Codex account model cache has no valid fetched_at timestamp");
  }
  if (!Number.isFinite(now)) {
    throw new Error("Current time for Codex account cache validation is invalid");
  }
  if (fetchedAt > now + MAX_ACCOUNT_CACHE_FUTURE_SKEW_MS) {
    throw new Error("Codex account model cache fetched_at timestamp is in the future");
  }
  const ageMs = Math.max(0, now - fetchedAt);
  const warning = ageMs > ACCOUNT_CACHE_STALE_AFTER_MS
    ? `Codex account model cache is ${Math.floor(ageMs / 60_000)} minute(s) old; run pickermux uninstall, fully quit and reopen Codex once, then install again to refresh account visibility`
    : undefined;
  const catalog = validateCodexCatalog({ models: cloneJson(parsed.models) });
  return {
    catalog,
    source: "codex-account-cache",
    cachePath,
    clientVersion: parsed.client_version,
    fetchedAt: parsed.fetched_at,
    ...(warning ? { warning } : {}),
  };
}

export async function loadNativeCatalog({
  codexHome,
  bundledCatalog,
  expectedClientVersion,
  allowBundledFallback = true,
} = {}) {
  if (!isPlainObject(bundledCatalog) || !Array.isArray(bundledCatalog.models)) {
    throw new Error("bundledCatalog must contain a models array");
  }
  try {
    return await loadCachedNativeCatalog({ codexHome, expectedClientVersion });
  } catch (error) {
    if (!allowBundledFallback) {
      throw new Error(
        `A valid account-scoped Codex model cache is required: ${error.message}`,
        { cause: error },
      );
    }
    return {
      catalog: validateCodexCatalog(cloneJson(bundledCatalog)),
      source: "codex-bundled-fallback",
      warning: error.message,
    };
  }
}

function selectDonor(bundledCatalog, donorSlug) {
  if (!isPlainObject(bundledCatalog) || !Array.isArray(bundledCatalog.models)) {
    throw new Error("bundledCatalog must contain a models array");
  }

  const requested = donorSlug
    ? [donorSlug]
    : [...PREFERRED_DONORS, undefined];
  for (const slug of requested) {
    const donor = slug
      ? bundledCatalog.models.find((model) => model?.slug === slug)
      : bundledCatalog.models.find(
          (model) =>
            isPlainObject(model) &&
            model.supported_in_api === true &&
            isPlainObject(model.model_messages),
        );
    if (donor) {
      return donor;
    }
  }

  if (donorSlug) {
    throw new Error(`Codex bundled catalog has no donor model ${donorSlug}`);
  }
  throw new Error("Codex bundled catalog has no suitable donor model");
}

function validateDiscoveredModel(model, index, seen) {
  if (!isPlainObject(model)) {
    throw new Error(`discoveredModels[${index}] must be an object`);
  }
  const id = String(model.id ?? "").trim();
  if (!id || /[\r\n]/u.test(id)) {
    throw new Error(`discoveredModels[${index}].id must be a single line`);
  }
  if (seen.has(id)) {
    throw new Error(`Duplicate discovered model id: ${id}`);
  }
  if (model.type !== "llm") {
    throw new Error(`Discovered model ${id} is not an LLM`);
  }
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) {
    throw new Error(`Discovered model ${id} has no loaded context window`);
  }

  const displayName = String(model.displayName ?? id).trim();
  if (!displayName || /[\r\n]/u.test(displayName)) {
    throw new Error(`Discovered model ${id} has an invalid display name`);
  }
  const reasoningEfforts = Array.isArray(model.reasoningEfforts)
    ? [...model.reasoningEfforts]
    : [model.reasoningEffort ?? "low"];
  if (
    reasoningEfforts.length === 0 ||
    reasoningEfforts.some((effort) => !Object.hasOwn(REASONING_DESCRIPTIONS, effort)) ||
    new Set(reasoningEfforts).size !== reasoningEfforts.length
  ) {
    throw new Error(`Discovered model ${id} has invalid reasoning efforts`);
  }
  const reasoningEffort = model.reasoningEffort ?? reasoningEfforts[0];
  if (!reasoningEfforts.includes(reasoningEffort)) {
    throw new Error(`Discovered model ${id} has an invalid default reasoning effort`);
  }
  if (
    model.reasoningOmitEfforts !== undefined &&
    !Array.isArray(model.reasoningOmitEfforts)
  ) {
    throw new Error(`Discovered model ${id} has invalid omitted reasoning efforts`);
  }
  const reasoningOmitEfforts = [...(model.reasoningOmitEfforts ?? [])];
  if (
    new Set(reasoningOmitEfforts).size !== reasoningOmitEfforts.length ||
    reasoningOmitEfforts.some((effort) => !reasoningEfforts.includes(effort))
  ) {
    throw new Error(`Discovered model ${id} has invalid omitted reasoning efforts`);
  }
  seen.add(id);
  return {
    id,
    displayName,
    contextWindow: model.contextWindow,
    source: typeof model.source === "string" ? model.source : undefined,
    reasoningEffort,
    reasoningEfforts,
    reasoningOmitEfforts,
  };
}

function catalogEntry(donor, model, priority, certifiedForTools = false) {
  const entry = cloneJson(donor);
  const contextPresentation = contextPickerPresentation(model.contextWindow, {
    source: model.source,
  });
  const compHash = createHash("sha256")
    .update(
      [
        "model-bridge-p4",
        model.id,
        model.contextWindow,
        model.reasoningEffort,
        model.reasoningEfforts.join(","),
        model.reasoningOmitEfforts.join(","),
        certifiedForTools ? "tools-certified" : "text-only",
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 16);

  entry.slug = model.id;
  entry.display_name =
    `${contextPresentation.prefix}${model.displayName}${contextPresentation.suffix}`;
  entry.description = contextPresentation.description;
  entry.visibility = "list";
  entry.supported_in_api = true;
  entry.priority = priority;
  entry.context_window = model.contextWindow;
  entry.max_context_window = model.contextWindow;
  entry.effective_context_window_percent = 90;
  entry.comp_hash = `model-bridge-p4-${compHash}`;

  // A loaded model remains usable for text before certification. Only a
  // receipt bound to this exact provider/model/context/client contract enables
  // Codex's direct unified-exec tool surface.
  entry.tool_mode = certifiedForTools ? "direct" : null;
  entry.shell_type = certifiedForTools ? "unified_exec" : "disabled";
  entry.input_modalities = ["text"];
  entry.supports_image_detail_original = false;
  entry.supports_search_tool = false;
  entry.web_search_tool_type = "text";
  entry.apply_patch_tool_type = null;
  entry.multi_agent_version = null;
  entry.experimental_supported_tools = [];
  entry.include_skills_usage_instructions = false;
  entry.include_plugin_usage_instructions = false;
  entry.include_apps_usage_instructions = false;
  entry.node_repl_auto_review_required = false;
  entry.node_repl_disabled = true;
  entry.use_responses_lite = false;
  entry.support_verbosity = false;
  entry.default_verbosity = "low";
  entry.default_reasoning_summary = "none";
  entry.default_reasoning_level = model.reasoningEffort;
  entry.supported_reasoning_levels = model.reasoningEfforts.map((effort) => ({
    effort,
    description: model.reasoningOmitEfforts.includes(effort)
      ? MODEL_DEFAULT_REASONING_DESCRIPTION
      : REASONING_DESCRIPTIONS[effort],
  }));
  entry.additional_speed_tiers = [];
  entry.service_tiers = [];
  entry.availability_nux = null;
  entry.upgrade = null;

  if (isPlainObject(entry.truncation_policy)) {
    const donorLimit = entry.truncation_policy.limit;
    if (Number.isSafeInteger(donorLimit) && donorLimit > 0) {
      entry.truncation_policy.limit = Math.max(
        1_024,
        Math.min(donorLimit, Math.floor(model.contextWindow / 4)),
      );
    }
  }

  return entry;
}

/**
 * Clone a complete bundled Codex model as a schema donor for every LM Studio LLM.
 */
export function buildCodexCatalog({
  discoveredModels,
  bundledCatalog,
  donorSlug,
  certifiedModelSlugs = [],
} = {}) {
  if (!Array.isArray(discoveredModels) || discoveredModels.length === 0) {
    throw new Error("At least one discovered LM Studio model is required");
  }

  const donor = selectDonor(bundledCatalog, donorSlug);
  const certified = new Set(certifiedModelSlugs);
  const seen = new Set();
  const models = discoveredModels.map((model, index) =>
    catalogEntry(
      donor,
      validateDiscoveredModel(model, index, seen),
      index + 1,
      certified.has(model.id),
    ),
  );

  return { models };
}

/**
 * Preserve the complete native catalog and append conservative external models.
 * External model ids are already public, namespaced picker slugs here; routing
 * back to the upstream id is deliberately kept in the provider registry.
 */
export function buildMixedCodexCatalog({
  discoveredModels,
  bundledCatalog,
  nativeCatalog = bundledCatalog,
  donorSlug,
  certifiedModelSlugs = [],
} = {}) {
  if (!isPlainObject(nativeCatalog) || !Array.isArray(nativeCatalog.models)) {
    throw new Error("nativeCatalog must contain a models array");
  }

  const mixedCatalog = cloneJson(nativeCatalog);
  const nativeSlugs = new Set(mixedCatalog.models.map((model) => model?.slug));
  for (const model of discoveredModels ?? []) {
    if (nativeSlugs.has(model?.id)) {
      throw new Error(`External model collides with native catalog slug: ${model.id}`);
    }
  }

  if (!Array.isArray(discoveredModels) || discoveredModels.length === 0) {
    return validateCodexCatalog(mixedCatalog);
  }

  const externalCatalog = buildCodexCatalog({
    discoveredModels,
    bundledCatalog,
    donorSlug,
    certifiedModelSlugs,
  });
  const maximumPriority = nativeCatalog.models.reduce(
    (maximum, model) =>
      Number.isSafeInteger(model?.priority)
        ? Math.max(maximum, model.priority)
        : maximum,
    0,
  );
  externalCatalog.models.forEach((model, index) => {
    model.priority = maximumPriority + index + 1;
  });
  mixedCatalog.models.push(...externalCatalog.models);
  return validateCodexCatalog(mixedCatalog);
}

export function validateCodexCatalog(catalog) {
  if (!isPlainObject(catalog) || !Array.isArray(catalog.models)) {
    throw new Error("Codex catalog must contain a models array");
  }
  if (catalog.models.length === 0) {
    throw new Error("Codex catalog must contain at least one model");
  }

  const slugs = new Set();
  for (const [index, model] of catalog.models.entries()) {
    if (!isPlainObject(model) || typeof model.slug !== "string" || !model.slug) {
      throw new Error(`Catalog model ${index} has no slug`);
    }
    if (slugs.has(model.slug)) {
      throw new Error(`Duplicate catalog model slug: ${model.slug}`);
    }
    if (
      !Number.isSafeInteger(model.context_window) ||
      model.context_window <= 0 ||
      !Number.isSafeInteger(model.max_context_window) ||
      model.max_context_window < model.context_window
    ) {
      throw new Error(`Catalog model ${model.slug} has an invalid context window`);
    }
    slugs.add(model.slug);
  }
  return catalog;
}

/**
 * Durably publish a private catalog through a same-directory atomic rename.
 */
export async function writeCatalogAtomic(catalogPath, catalog) {
  if (typeof catalogPath !== "string" || !catalogPath.trim()) {
    throw new Error("Catalog path must not be empty");
  }
  validateCodexCatalog(catalog);

  const destination = path.resolve(catalogPath);
  const directory = path.dirname(destination);
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, destination);

    // Syncing the directory makes the rename durable where the platform permits it.
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
    throw new Error(`Failed to atomically write catalog ${destination}`, {
      cause: error,
    });
  }

  const written = await stat(destination);
  if ((written.mode & 0o777) !== 0o600) {
    throw new Error(`Catalog permissions are not 0600: ${destination}`);
  }
  return destination;
}

/** Read back a generated catalog for callers that need post-write validation. */
export async function readCodexCatalog(catalogPath) {
  return parseCatalogJson(
    await readFile(catalogPath, "utf8"),
    "Generated Codex catalog",
  );
}
