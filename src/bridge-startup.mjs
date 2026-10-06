import { validateBridgeConfig } from "./bridge-config.mjs";
import { discoverBridgeModels } from "./bridge-discovery.mjs";
import { resolveModelCapabilitySlugs } from "./certification-runner.mjs";
import { buildProviderRegistry } from "./provider-registry.mjs";

/** Bind MLX startup routes to live identity before accepting probe or tool traffic. */
export async function buildBridgeStartupRegistry({
  config,
  mixedCatalog,
  certificationPath,
  codexClientVersion,
  credentialResolver,
}, {
  discoverImpl = discoverBridgeModels,
  resolveCapabilitiesImpl = resolveModelCapabilitySlugs,
} = {}) {
  const normalized = validateBridgeConfig(config);
  const providers = normalized.providers.filter((provider) =>
    provider.kind === "mlx-chat-completions",
  );
  if (providers.length === 0) {
    return buildProviderRegistry({ config: normalized, mixedCatalog });
  }

  const mlxConfig = { ...normalized, providers };
  const discovery = await discoverImpl({ config: mlxConfig, credentialResolver });
  const expected = new Map(providers.flatMap((provider) =>
    provider.models.map((model) => [model.slug, { provider, model }]),
  ));
  if (!Array.isArray(discovery?.models) || discovery.models.length !== expected.size) {
    throw new Error("The local MLX startup discovery is incomplete");
  }
  const seen = new Set();
  for (const live of discovery.models) {
    const entry = expected.get(live?.id);
    if (!entry || seen.has(live.id) || live.providerId !== entry.provider.id ||
        live.upstreamId !== entry.model.id || live.contextWindow !== entry.model.contextWindow ||
        (entry.model.mlxProfileDigest !== undefined &&
          live.capabilities?.mlxProfileDigest !== entry.model.mlxProfileDigest)) {
      throw new Error("The local MLX startup identity does not match its configuration");
    }
    seen.add(live.id);
  }
  const grants = await resolveCapabilitiesImpl({
    storePath: certificationPath,
    config: mlxConfig,
    models: discovery.models,
    codexClientVersion,
  });
  const direct = new Set(grants.certifiedModelSlugs);
  const efficient = new Set(grants.efficientFidelityModelSlugs);
  // Catalog flags cannot preserve authority after the live runtime or receipt
  // changes. Its conservative flags still admit separately authorized probes.
  const catalog = {
    ...mixedCatalog,
    models: mixedCatalog.models.map((model) => {
      if (!expected.has(model.slug)) return model;
      if (!direct.has(model.slug)) {
        return { ...model, tool_mode: null, shell_type: "disabled", supports_search_tool: false };
      }
      return efficient.has(model.slug) ? model : { ...model, supports_search_tool: false };
    }),
  };
  return buildProviderRegistry({
    config: normalized,
    mixedCatalog: catalog,
    discoveredModels: discovery.models,
  });
}
