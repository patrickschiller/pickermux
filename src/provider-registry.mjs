import { validateBridgeConfig } from "./bridge-config.mjs";
import { isDeepStrictEqual } from "node:util";

import {
  MODEL_DEFAULT_REASONING_DESCRIPTION,
  buildAutoCatalogEntry,
} from "./catalog.mjs";
import {
  AUTO_MODEL_DISPLAY_NAME,
  AUTO_MODEL_SLUG,
  SMART_ROUTING_STRATEGY,
  isAutoModelSlugVariant,
} from "./smart-routing-constants.mjs";

export const NATIVE_CODEX_BASE_URL =
  "https://chatgpt.com/backend-api/codex";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function freezeRoute(route) {
  if (route.model) Object.freeze(route.model);
  if (route.reasoningEfforts) Object.freeze(route.reasoningEfforts);
  if (route.reasoningEffortMap) Object.freeze(route.reasoningEffortMap);
  if (route.reasoningOmitEfforts) Object.freeze(route.reasoningOmitEfforts);
  return Object.freeze(route);
}

function safeModelLabel(value) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 200)
    : "<non-string>";
}

export class UnknownModelError extends Error {
  constructor(model) {
    super(`No route is configured for model ${safeModelLabel(model)}`);
    this.name = "UnknownModelError";
    this.code = "UNKNOWN_MODEL";
    this.statusCode = 400;
  }
}

function nativeRoutes(bundledCatalog) {
  if (!isPlainObject(bundledCatalog) || !Array.isArray(bundledCatalog.models)) {
    throw new Error("bundledCatalog must contain a models array");
  }

  const routes = [];
  const seen = new Set();
  for (const [index, sourceModel] of bundledCatalog.models.entries()) {
    if (
      !isPlainObject(sourceModel) ||
      typeof sourceModel.slug !== "string" ||
      !sourceModel.slug ||
      /[\u0000-\u001f\u007f]/u.test(sourceModel.slug)
    ) {
      throw new Error(`bundledCatalog.models[${index}] has no valid slug`);
    }
    if (isAutoModelSlugVariant(sourceModel.slug)) {
      throw new Error(
        `Native catalog collides with PickerMux Auto slug: ${sourceModel.slug}`,
      );
    }
    if (seen.has(sourceModel.slug)) {
      throw new Error(`Duplicate native model slug: ${sourceModel.slug}`);
    }
    seen.add(sourceModel.slug);
    const model = cloneJson(sourceModel);
    routes.push(
      freezeRoute({
        kind: "native-openai",
        slug: sourceModel.slug,
        upstreamModel: sourceModel.slug,
        baseUrl: NATIVE_CODEX_BASE_URL,
        model,
      }),
    );
  }
  return routes;
}

function configuredExternalRoutes(config) {
  const routes = [];
  for (const provider of config.providers) {
    for (const configuredModel of provider.models) {
      const model = { ...configuredModel };
      const route = {
        kind: "external",
        slug: configuredModel.slug,
        upstreamModel: configuredModel.id,
        providerId: provider.id,
        providerKind: provider.kind,
        baseUrl: provider.baseUrl,
        allowPrivateNetwork: provider.allowPrivateNetwork,
        model,
        certifiedForTools: false,
      };
      if (provider.credentialEnv !== undefined) {
        route.credentialEnv = provider.credentialEnv;
      }
      if (provider.credentialKeychain === true) {
        route.credentialKeychain = true;
      }
      if (configuredModel.reasoningEffort !== undefined) {
        route.reasoningEffort = configuredModel.reasoningEffort;
      }
      if (configuredModel.reasoningEfforts !== undefined) {
        route.reasoningEfforts = [...configuredModel.reasoningEfforts];
      }
      if (configuredModel.reasoningEffortMap !== undefined) {
        route.reasoningEffortMap = { ...configuredModel.reasoningEffortMap };
      }
      routes.push(freezeRoute(route));
    }
  }
  return routes;
}

function isLoadedDiscoveryProvider(provider) {
  return provider.kind === "lmstudio-responses" &&
    provider.discovery?.mode === "loaded";
}

function catalogReasoning(model) {
  const reasoningLevels = Array.isArray(model?.supported_reasoning_levels)
    ? model.supported_reasoning_levels
    : [];
  const reasoningEfforts = reasoningLevels.length > 0
    ? reasoningLevels
        .map((level) => level?.effort)
        .filter((effort) => typeof effort === "string" && effort)
    : [];
  const bridgeGenerated =
    typeof model?.comp_hash === "string" &&
    /^model-bridge-p[234]-[0-9a-f]{16}$/u.test(model.comp_hash);
  const reasoningOmitEfforts = bridgeGenerated
    ? reasoningLevels
        .filter(
          (level) =>
            level?.description === MODEL_DEFAULT_REASONING_DESCRIPTION &&
            typeof level?.effort === "string" &&
            level.effort,
        )
        .map((level) => level.effort)
    : [];
  const reasoningEffort =
    typeof model?.default_reasoning_level === "string" &&
    reasoningEfforts.includes(model.default_reasoning_level)
      ? model.default_reasoning_level
      : reasoningEfforts[0];
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
    ...(reasoningOmitEfforts.length > 0 ? { reasoningOmitEfforts } : {}),
  };
}

function fallbackLmStudioReasoningMap(reasoningEfforts) {
  if (!Array.isArray(reasoningEfforts)) return undefined;
  return Object.fromEntries(
    reasoningEfforts.map((effort) => [effort, effort]),
  );
}

function discoveredBySlug(discoveredModels) {
  const result = new Map();
  for (const [index, model] of (discoveredModels ?? []).entries()) {
    if (!isPlainObject(model) || typeof model.id !== "string" || !model.id) {
      throw new Error(`discoveredModels[${index}] has no valid public model id`);
    }
    if (result.has(model.id)) {
      throw new Error(`Duplicate discovered public model id: ${model.id}`);
    }
    result.set(model.id, model);
  }
  return result;
}

function mixedExternalRoutes(config, assignments, discoveredModels) {
  const discovered = discoveredBySlug(discoveredModels);
  return assignments.map(({ provider, configuredModel, catalogModel, upstreamModel }) => {
    const live = discovered.get(catalogModel.slug);
    const catalogProfile = catalogReasoning(catalogModel);
    const model = configuredModel
      ? { ...configuredModel }
      : {
          id: upstreamModel,
          slug: catalogModel.slug,
          displayName: catalogModel.display_name ?? catalogModel.slug,
          type: "llm",
          contextWindow: catalogModel.context_window,
        };
    if (live) {
      model.displayName = live.displayName ?? model.displayName;
      model.type = live.type ?? model.type;
      model.contextWindow = live.contextWindow ?? model.contextWindow;
    }
    model.contextWindow =
      live?.contextWindow ??
      catalogModel.context_window ??
      configuredModel?.contextWindow;
    const reasoningEffort =
      live?.reasoningEffort ?? configuredModel?.reasoningEffort ?? catalogProfile.reasoningEffort;
    const reasoningEfforts =
      live?.reasoningEfforts ?? configuredModel?.reasoningEfforts ?? catalogProfile.reasoningEfforts;
    const reasoningEffortMap =
      live?.reasoningEffortMap ??
      configuredModel?.reasoningEffortMap ??
      (provider.kind === "lmstudio-responses"
        ? fallbackLmStudioReasoningMap(reasoningEfforts)
        : undefined);
    const reasoningOmitEfforts =
      provider.kind === "lmstudio-responses"
        ? live?.reasoningOmitEfforts ??
          catalogProfile.reasoningOmitEfforts ??
          []
        : undefined;
    const route = {
      kind: "external",
      slug: catalogModel.slug,
      upstreamModel: live?.upstreamId ?? upstreamModel,
      providerId: provider.id,
      providerKind: provider.kind,
      baseUrl: provider.baseUrl,
      allowPrivateNetwork: provider.allowPrivateNetwork,
      model,
      certifiedForTools:
        catalogModel.tool_mode === "direct" &&
        catalogModel.shell_type === "unified_exec",
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(reasoningEfforts?.length ? { reasoningEfforts: [...reasoningEfforts] } : {}),
      ...(reasoningEffortMap ? { reasoningEffortMap: { ...reasoningEffortMap } } : {}),
      ...(reasoningOmitEfforts
        ? { reasoningOmitEfforts: [...reasoningOmitEfforts] }
        : {}),
    };
    if (provider.credentialEnv !== undefined) {
      route.credentialEnv = provider.credentialEnv;
    }
    if (provider.credentialKeychain === true) {
      route.credentialKeychain = true;
    }
    return freezeRoute(route);
  });
}

function descriptor(route) {
  const virtual = route.kind === "smart-router";
  const item = {
    id: route.slug,
    object: "model",
    owned_by:
      route.kind === "native-openai"
        ? "openai"
        : virtual
          ? "pickermux"
          : route.providerId,
    kind: route.kind,
  };
  const displayName =
    route.kind === "native-openai"
      ? route.model.display_name
      : virtual
        ? route.model.display_name
        : route.model.displayName;
  if (typeof displayName === "string" && displayName) {
    item.display_name = displayName;
  }
  return Object.freeze(item);
}

/**
 * Build an immutable exact-match routing table. Native model slugs always go
 * to the hard-coded ChatGPT Codex backend; the config can only add namespaced
 * external routes.
 */
export function splitMixedCatalog(mixedCatalog, config) {
  if (!isPlainObject(mixedCatalog) || !Array.isArray(mixedCatalog.models)) {
    throw new Error("mixedCatalog must contain a models array");
  }
  const configuredBySlug = new Map();
  for (const provider of config.providers) {
    for (const model of provider.models) {
      configuredBySlug.set(model.slug, { provider, configuredModel: model });
    }
  }
  const loadedProviders = config.providers.filter(isLoadedDiscoveryProvider);
  const seen = new Set();
  const nativeModels = [];
  const virtualModels = [];
  const externalAssignments = [];
  for (const [index, model] of mixedCatalog.models.entries()) {
    if (!isPlainObject(model) || typeof model.slug !== "string" || !model.slug) {
      throw new Error(`mixedCatalog.models[${index}] has no valid slug`);
    }
    if (seen.has(model.slug)) {
      throw new Error(`Duplicate mixed catalog model slug: ${model.slug}`);
    }
    seen.add(model.slug);
    if (isAutoModelSlugVariant(model.slug)) {
      if (model.slug !== AUTO_MODEL_SLUG) {
        throw new Error(
          `Model slug is a reserved PickerMux Auto variant: ${model.slug}`,
        );
      }
      virtualModels.push(model);
      continue;
    }
    let assignment = configuredBySlug.get(model.slug);
    if (!assignment) {
      const provider = loadedProviders.find((candidate) =>
        model.slug.startsWith(`${candidate.id}/`) &&
        model.slug.length > candidate.id.length + 1,
      );
      if (provider) {
        assignment = {
          provider,
          configuredModel: undefined,
          upstreamModel: model.slug.slice(provider.id.length + 1),
        };
      }
    }
    if (assignment) {
      externalAssignments.push({
        ...assignment,
        catalogModel: model,
        upstreamModel: assignment.configuredModel?.id ?? assignment.upstreamModel,
      });
    } else {
      nativeModels.push(model);
    }
  }
  for (const provider of config.providers) {
    if (isLoadedDiscoveryProvider(provider)) continue;
    for (const model of provider.models) {
      if (!seen.has(model.slug)) {
        throw new Error(`mixedCatalog is missing configured external model ${model.slug}`);
      }
    }
  }
  const unclaimedNamespaced = nativeModels.find((model) => model.slug.includes("/"));
  if (unclaimedNamespaced) {
    throw new Error(
      `Refusing to classify unclaimed namespaced model as native: ${unclaimedNamespaced.slug}`,
    );
  }
  const classifiedSlugs = [
    ...nativeModels.map((model) => model.slug),
    ...virtualModels.map((model) => model.slug),
    ...externalAssignments.map((assignment) => assignment.catalogModel.slug),
  ];
  const catalogSlugs = mixedCatalog.models.map((model) => model.slug);
  if (JSON.stringify(classifiedSlugs) !== JSON.stringify(catalogSlugs)) {
    throw new Error(
      "Mixed catalog order must be native models, PickerMux virtual models, then external models",
    );
  }
  return {
    nativeCatalog: { models: nativeModels },
    virtualModels,
    externalAssignments,
  };
}

export function buildProviderRegistry({
  bundledCatalog,
  mixedCatalog,
  config,
  discoveredModels,
} = {}) {
  const normalizedConfig = validateBridgeConfig(config);
  if (bundledCatalog !== undefined && mixedCatalog !== undefined) {
    throw new Error("Supply either bundledCatalog or mixedCatalog, not both");
  }
  const split = mixedCatalog === undefined
    ? undefined
    : splitMixedCatalog(mixedCatalog, normalizedConfig);
  const nativeCatalog = split?.nativeCatalog ?? bundledCatalog;
  const natives = nativeRoutes(nativeCatalog);
  const externals = split
    ? mixedExternalRoutes(
        normalizedConfig,
        split.externalAssignments,
        discoveredModels,
      )
    : configuredExternalRoutes(normalizedConfig);
  const autoCatalogModels = split?.virtualModels ?? [];
  if (autoCatalogModels.length > 1) {
    throw new Error(`Duplicate virtual model slug: ${AUTO_MODEL_SLUG}`);
  }
  if (!normalizedConfig.smartRouting.enabled && autoCatalogModels.length > 0) {
    throw new Error(
      `${AUTO_MODEL_SLUG} is present while smart routing is disabled`,
    );
  }
  if (
    natives.some((route) => route.slug === AUTO_MODEL_SLUG) ||
    externals.some((route) => route.slug === AUTO_MODEL_SLUG)
  ) {
    throw new Error(`Model route collides with PickerMux virtual slug: ${AUTO_MODEL_SLUG}`);
  }

  const virtuals = [];
  if (normalizedConfig.smartRouting.enabled) {
    if (mixedCatalog !== undefined && autoCatalogModels.length !== 1) {
      throw new Error(`Mixed catalog is missing virtual model ${AUTO_MODEL_SLUG}`);
    }
    const fallback = natives.find(
      (route) => route.slug === normalizedConfig.smartRouting.fallbackModel,
    );
    if (!fallback || fallback.kind !== "native-openai") {
      throw new Error(
        `Smart-routing fallback is not an available native model: ${normalizedConfig.smartRouting.fallbackModel}`,
      );
    }
    if (autoCatalogModels[0]) {
      const maximumNativePriority = natives.reduce(
        (maximum, route) =>
          Number.isSafeInteger(route.model?.priority)
            ? Math.max(maximum, route.model.priority)
            : maximum,
        0,
      );
      const expectedAutoModel = buildAutoCatalogEntry(
        fallback.model,
        normalizedConfig.smartRouting,
        maximumNativePriority + 1,
      );
      if (!isDeepStrictEqual(autoCatalogModels[0], expectedAutoModel)) {
        throw new Error(
          "PickerMux Auto catalog record does not match the current routing configuration and fallback",
        );
      }
    }
    const local = externals.find(
      (route) => route.slug === normalizedConfig.smartRouting.localModel,
    );
    if (
      local &&
      (local.kind !== "external" || local.providerKind !== "lmstudio-responses")
    ) {
      throw new Error(
        `Smart-routing local candidate is not an LM Studio route: ${normalizedConfig.smartRouting.localModel}`,
      );
    }
    const model = autoCatalogModels[0]
      ? cloneJson(autoCatalogModels[0])
      : {
          slug: AUTO_MODEL_SLUG,
          display_name: AUTO_MODEL_DISPLAY_NAME,
        };
    virtuals.push(
      freezeRoute({
        kind: "smart-router",
        slug: AUTO_MODEL_SLUG,
        strategy: SMART_ROUTING_STRATEGY,
        localModel: normalizedConfig.smartRouting.localModel,
        fallbackModel: normalizedConfig.smartRouting.fallbackModel,
        maxLocalInputTokens: normalizedConfig.smartRouting.maxLocalInputTokens,
        complexityThreshold: normalizedConfig.smartRouting.complexityThreshold,
        model,
      }),
    );
  }

  const routeMap = new Map();

  for (const route of [...natives, ...virtuals, ...externals]) {
    if (routeMap.has(route.slug)) {
      throw new Error(`Model route collides with existing slug: ${route.slug}`);
    }
    routeMap.set(route.slug, route);
  }

  const nativeModels = Object.freeze(natives.map(descriptor));
  const virtualModels = Object.freeze(virtuals.map(descriptor));
  const externalModels = Object.freeze(externals.map(descriptor));
  const allModels = Object.freeze([
    ...nativeModels,
    ...virtualModels,
    ...externalModels,
  ]);

  return Object.freeze({
    nativeModels,
    virtualModels,
    externalModels,
    resolve(model) {
      if (typeof model !== "string" || !routeMap.has(model)) {
        throw new UnknownModelError(model);
      }
      return routeMap.get(model);
    },
    listModels() {
      return allModels.map((model) => ({ ...model }));
    },
  });
}

/** Stable facade whose immutable registry snapshot can be replaced atomically. */
export function createReloadableProviderRegistry(initialRegistry) {
  if (
    !initialRegistry ||
    typeof initialRegistry.resolve !== "function" ||
    typeof initialRegistry.listModels !== "function"
  ) {
    throw new TypeError("An initial provider registry is required");
  }
  let current = initialRegistry;
  return Object.freeze({
    get nativeModels() {
      return current.nativeModels;
    },
    get externalModels() {
      return current.externalModels;
    },
    get virtualModels() {
      return current.virtualModels;
    },
    resolve(model) {
      return current.resolve(model);
    },
    listModels() {
      return current.listModels();
    },
    replace(nextRegistry) {
      if (
        !nextRegistry ||
        typeof nextRegistry.resolve !== "function" ||
        typeof nextRegistry.listModels !== "function"
      ) {
        throw new TypeError("A replacement provider registry is required");
      }
      current = nextRegistry;
    },
  });
}
