import {
  DiscoveryUnavailableError,
  discoverLmStudio,
} from "./discovery.mjs";
import { createCredentialResolver } from "./keychain-credentials.mjs";

const LM_STUDIO_REASONING_OPTIONS = Object.freeze({
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
});
const PUBLIC_REASONING_ORDER = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function configuredReasoning(model) {
  const result = {};
  if (model.reasoningEffort !== undefined) {
    result.reasoningEffort = model.reasoningEffort;
  }
  if (model.reasoningEfforts !== undefined) {
    result.reasoningEfforts = [...model.reasoningEfforts];
  }
  return result;
}

function deriveLmStudioReasoning(discovered) {
  const advertised = new Set(discovered.capabilities?.reasoningOptions ?? []);
  const publicEfforts = new Set();
  if (advertised.has("off") || advertised.has("none")) publicEfforts.add("none");
  for (const effort of PUBLIC_REASONING_ORDER.slice(1)) {
    if (advertised.has(effort)) publicEfforts.add(effort);
  }
  const hasExactPositive = [...publicEfforts].some(
    (effort) => effort !== "none",
  );
  if (advertised.has("on") && !hasExactPositive) {
    publicEfforts.add("xhigh");
  }
  // `on` without an exact public effort means the model has an intrinsic or
  // toggle-only reasoning mode. Codex still needs a positive picker enum, but
  // sending the synthetic `xhigh` value would make LM Studio warn that it
  // cannot translate the setting into custom KVs. Omitting only that effort
  // preserves a real `none`/off selection for toggle models such as Gemma.
  const upstreamDefault = discovered.capabilities?.reasoningDefault;
  const reasoningOmitEfforts =
    advertised.has("on") &&
    !hasExactPositive &&
    (!publicEfforts.has("none") || upstreamDefault === "on")
      ? ["xhigh"]
      : [];

  const reasoningEfforts = PUBLIC_REASONING_ORDER.filter(
    (effort) => publicEfforts.has(effort),
  );
  // Unknown models get the least assertive public profile instead of inheriting
  // the donor catalog's arbitrary `low` setting.
  if (reasoningEfforts.length === 0) {
    return {
      reasoningEffort: "none",
      reasoningEfforts: ["none"],
      reasoningEffortMap: { none: "none" },
      reasoningOmitEfforts,
    };
  }

  let reasoningEffort = reasoningEfforts.includes(upstreamDefault)
    ? upstreamDefault
    : undefined;
  if (!reasoningEffort && upstreamDefault === "off" && publicEfforts.has("none")) {
    reasoningEffort = "none";
  }
  if (!reasoningEffort && upstreamDefault === "on") {
    reasoningEffort = [...reasoningEfforts]
      .reverse()
      .find((effort) => effort !== "none");
  }
  reasoningEffort ??=
    [...reasoningEfforts].reverse().find((effort) => effort !== "none") ??
    reasoningEfforts[0];

  // LM Studio's REST metadata calls the toggle `off/on`, but its OpenAI-
  // compatible Responses endpoint accepts only the public reasoning enum.
  const reasoningEffortMap = Object.fromEntries(
    reasoningEfforts.map((effort) => [effort, effort]),
  );
  return {
    reasoningEffort,
    reasoningEfforts,
    reasoningEffortMap,
    reasoningOmitEfforts,
  };
}

function configuredLmStudioReasoning(discovered, configured) {
  const configuredEfforts = Array.isArray(configured.reasoningEfforts)
    ? configured.reasoningEfforts
    : configured.reasoningEffort === undefined
      ? []
      : [configured.reasoningEffort];
  const derived = deriveLmStudioReasoning(discovered);
  if (configuredEfforts.length === 0) return derived;
  const advertised = new Set(discovered.capabilities?.reasoningOptions ?? []);
  // Fallback discovery cannot expose native reasoning metadata. In that case
  // the explicit configuration remains the operator's certification.
  const reasoningEffortMap = {};
  for (const effort of configuredEfforts) {
    const upstream =
      advertised.size === 0
        ? LM_STUDIO_REASONING_OPTIONS[effort]
        : derived.reasoningEffortMap?.[effort];
    if (!upstream) {
      throw new Error(
        `LM Studio model ${configured.slug} does not advertise reasoning effort ${effort}`,
      );
    }
    reasoningEffortMap[effort] = upstream;
  }
  return {
    ...configuredReasoning(configured),
    reasoningEffortMap,
    reasoningOmitEfforts: derived.reasoningOmitEfforts.filter((effort) =>
      configuredEfforts.includes(effort)
    ),
  };
}

async function discoverGenericProvider({
  provider,
  fetchImpl,
  credentialResolver,
  timeoutMs,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const headers = { accept: "application/json" };
    const credential = await credentialResolver(provider);
    if (credential) headers.authorization = `Bearer ${credential}`;
    const response = await fetchImpl(
      `${provider.baseUrl.replace(/\/+$/u, "")}/models`,
      { headers, redirect: "error", signal: controller.signal },
    );
    if (!response.ok) {
      throw new Error(`Provider ${provider.id} model discovery returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    const ids = new Set(
      Array.isArray(payload?.data)
        ? payload.data.map((entry) => String(entry?.id ?? "")).filter(Boolean)
        : [],
    );
    if (ids.size === 0) {
      throw new Error(`Provider ${provider.id} returned no model ids`);
    }

    return provider.models.map((model) => {
      if (!ids.has(model.id)) {
        throw new Error(`Allowlisted model ${provider.id}/${model.id} was not discovered`);
      }
      if (model.type !== "llm" || !Number.isSafeInteger(model.contextWindow)) {
        throw new Error(
          `Generic provider model ${model.slug} requires type=llm and a positive contextWindow`,
        );
      }
      return {
        id: model.slug,
        upstreamId: model.id,
        providerId: provider.id,
        displayName: model.displayName,
        type: "llm",
        contextWindow: model.contextWindow,
        source: "openai-compatible-models",
        capabilities: {},
        ...configuredReasoning(model),
      };
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Provider ${provider.id} model discovery timed out`, { cause: error });
    }
    if (error.message?.startsWith(`Provider ${provider.id}`) || error.message?.startsWith("Generic")) {
      throw error;
    }
    throw new Error(`Provider ${provider.id} model discovery failed`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

export async function discoverBridgeModels({
  config,
  fetchImpl = globalThis.fetch,
  environment = process.env,
  credentialResolver,
  timeoutMs = 8_000,
} = {}) {
  const resolveCredential =
    credentialResolver ?? createCredentialResolver({ environment });
  const models = [];
  const providers = [];
  for (const provider of config.providers) {
    if (provider.kind === "lmstudio-responses") {
      let discovered;
      try {
        discovered = await discoverLmStudio({
          baseUrl: provider.baseUrl,
          allowlist: provider.models,
          discovery: provider.discovery,
          apiToken: await resolveCredential(provider),
          fetchImpl,
          timeoutMs,
        });
      } catch (error) {
        if (
          provider.discovery?.mode === "loaded" &&
          error instanceof DiscoveryUnavailableError &&
          error.reason === "connection-refused"
        ) {
          discovered = {
            source: "lmstudio-unavailable",
            models: [],
            skipped: [],
            unavailableReason: error.reason,
          };
        } else {
          throw error;
        }
      }
      const configurationById = new Map(
        provider.models.map((model) => [model.id, model]),
      );
      const mapped = discovered.models.map((model) => {
        const configured = configurationById.get(model.id);
        const reasoning = configured
          ? configuredLmStudioReasoning(model, configured)
          : deriveLmStudioReasoning(model);
        return {
          ...model,
          id: configured?.slug ?? `${provider.id}/${model.id}`,
          upstreamId: model.id,
          providerId: provider.id,
          displayName:
            configured?.displayName ?? `${model.displayName} – LM Studio`,
          ...reasoning,
        };
      });
      models.push(...mapped);
      providers.push({
        id: provider.id,
        source: discovered.source,
        models: mapped,
        skipped: discovered.skipped,
        ...(discovered.unavailableReason
          ? { unavailableReason: discovered.unavailableReason }
          : {}),
      });
      continue;
    }

    const mapped = await discoverGenericProvider({
      provider,
      fetchImpl,
      credentialResolver: resolveCredential,
      timeoutMs,
    });
    models.push(...mapped);
    providers.push({
      id: provider.id,
      source: "openai-compatible-models",
      models: mapped,
      skipped: [],
    });
  }

  return { models, providers };
}
