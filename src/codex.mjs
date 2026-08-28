import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);

function tomlString(value) {
  return JSON.stringify(String(value));
}

export function providerOverrides({
  model,
  reasoningEffort = "low",
  providerId,
  providerName,
  baseUrl,
  catalogPath,
  requiresOpenAiAuth = false,
  supportsWebsockets = false,
}) {
  const prefix = `model_providers.${providerId}`;
  return [
    `model=${tomlString(model)}`,
    `model_reasoning_effort=${tomlString(reasoningEffort)}`,
    `model_provider=${tomlString(providerId)}`,
    `model_catalog_json=${tomlString(catalogPath)}`,
    `${prefix}.name=${tomlString(providerName)}`,
    `${prefix}.base_url=${tomlString(baseUrl)}`,
    `${prefix}.wire_api="responses"`,
    `${prefix}.requires_openai_auth=${requiresOpenAiAuth}`,
    `${prefix}.supports_websockets=${supportsWebsockets}`,
    `${prefix}.supports_standalone_web_search=false`,
  ];
}

export async function debugModels({
  codexPath,
  overrides = [],
  execFileImpl = execFileAsync,
  timeoutMs = 30_000,
}) {
  const args = ["debug", "models"];
  for (const override of overrides) {
    args.push("-c", override);
  }

  let stdout;
  try {
    ({ stdout } = await execFileImpl(codexPath, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
    }));
  } catch (error) {
    const detail = error?.stderr?.trim();
    throw new Error(
      `Codex model catalog validation failed${detail ? `: ${detail}` : ""}`,
      { cause: error },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error("Codex debug models did not return valid JSON", {
      cause: error,
    });
  }
  if (!parsed || !Array.isArray(parsed.models)) {
    throw new Error("Codex debug models returned no models array");
  }
  return parsed;
}

export function assertCatalogModels(catalog, expectedIds) {
  assertCatalogSlugs(catalog, expectedIds);
  for (const model of catalog.models) {
    if (model.visibility !== "list" || model.supported_in_api !== true) {
      throw new Error(`Model ${model.slug} is not visible and API-supported`);
    }
  }
  return true;
}

/** Exact slug/order validation for mixed catalogs that preserve hidden native entries. */
export function assertCatalogSlugs(catalog, expectedIds) {
  const actual = catalog.models.map((model) => model.slug);
  if (
    actual.length !== expectedIds.length ||
    actual.some((slug, index) => slug !== expectedIds[index])
  ) {
    throw new Error(
      `Unexpected Codex catalog models: expected ${expectedIds.join(", ")}; received ${actual.join(", ")}`,
    );
  }
  return true;
}
