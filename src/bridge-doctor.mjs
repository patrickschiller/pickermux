import { stat } from "node:fs/promises";
import path from "node:path";

import { inspectCodexAccountCache } from "./account-cache.mjs";
import { runtimeSupportsZstd } from "./body-codec.mjs";
import {
  loadBundledCatalog,
  loadCodexClientVersion,
  readCodexCatalog,
} from "./catalog.mjs";
import { checkCurrentCompatibility } from "./compatibility-manifest.mjs";
import { resolveCertificationStatuses } from "./certification-runner.mjs";
import { listPendingModelCertificationIds } from "./model-certification.mjs";
import { assertCatalogSlugs, debugModels } from "./codex.mjs";
import { getConfigStatus } from "./config-manager.mjs";
import { discoverBridgeModels } from "./bridge-discovery.mjs";
import {
  bridgeBaseUrl,
  getBridgeServiceStatus,
  readRuntime,
} from "./bridge-runtime.mjs";
import { splitMixedCatalog } from "./provider-registry.mjs";

function check(name, ok, detail) {
  return { name, status: ok ? "pass" : "fail", detail };
}

function accountCacheAgeDetail(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "";
  return `, age ${Math.floor(ageMs / 60_000)} minute(s)`;
}

const TEXT_ONLY_CONTEXT_OUTCOMES = new Set(["compacted", "unchanged"]);
const TEXT_ONLY_CONTEXT_STOP_REASONS = new Set([
  "ambiguous",
  "conversation",
  "none",
]);

function textOnlyContextCheck(telemetry) {
  const last = telemetry?.last;
  const counters = [
    telemetry?.requests,
    last?.sourceBytes,
    last?.forwardedBytes,
    last?.sourceRequestBytes,
    last?.forwardedRequestBytes,
    last?.omittedParts,
    last?.omittedBytes,
    last?.retainedBootstrapParts,
    last?.retainedBootstrapBytes,
  ];
  if (
    telemetry?.schemaVersion !== 1 ||
    telemetry === null ||
    Array.isArray(telemetry) ||
    typeof telemetry !== "object" ||
    last === null ||
    Array.isArray(last) ||
    typeof last !== "object" ||
    !TEXT_ONLY_CONTEXT_OUTCOMES.has(last.outcome) ||
    !TEXT_ONLY_CONTEXT_STOP_REASONS.has(last.stopReason) ||
    counters.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    return check(
      "text-only-context",
      false,
      "bridge context telemetry is invalid",
    );
  }
  return check(
    "text-only-context",
    true,
    `${telemetry.requests} request(s); input ${last.sourceBytes} -> ${last.forwardedBytes} bytes; request ${last.sourceRequestBytes} -> ${last.forwardedRequestBytes} bytes; omitted ${last.omittedParts} part(s)/${last.omittedBytes} bytes; retained bootstrap ${last.retainedBootstrapParts} part(s)/${last.retainedBootstrapBytes} bytes; stop=${last.stopReason}`,
  );
}

export function assertNativeCatalogSnapshot({
  mixedCatalog,
  nativeCatalog,
  externalSlugs = [],
}) {
  if (!Array.isArray(mixedCatalog?.models) || !Array.isArray(nativeCatalog?.models)) {
    throw new Error("native catalog comparison requires model arrays");
  }
  const external = new Set(externalSlugs);
  const actual = mixedCatalog.models.filter((model) => !external.has(model?.slug));
  if (actual.length !== nativeCatalog.models.length) {
    throw new Error(
      `native catalog model count differs: expected ${nativeCatalog.models.length}, received ${actual.length}`,
    );
  }
  for (let index = 0; index < nativeCatalog.models.length; index += 1) {
    const expected = nativeCatalog.models[index];
    const received = actual[index];
    if (received?.slug !== expected?.slug) {
      throw new Error(
        `native catalog order differs at ${index}: expected ${expected?.slug}, received ${received?.slug}`,
      );
    }
    if (JSON.stringify(received) !== JSON.stringify(expected)) {
      throw new Error(`native catalog picker contract differs for ${expected.slug}`);
    }
  }
  return actual.length;
}

function visibleText(response) {
  if (!Array.isArray(response?.output)) return "";
  return response.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .filter((part) => part?.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
}

export async function runBridgeLiveCheck({
  baseUrl,
  model,
  fetchImpl = globalThis.fetch,
  timeoutMs = 180_000,
}) {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/u, "")}/responses`, {
    method: "POST",
    redirect: "error",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      input: "Reply with exactly P4_DOCTOR_OK and nothing else.",
      reasoning: { effort: "ultra" },
      max_output_tokens: 256,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Bridge live response returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!visibleText(payload).includes("P4_DOCTOR_OK")) {
    throw new Error("Bridge live response did not return P4_DOCTOR_OK");
  }
  return { responseId: payload.id ?? null, text: "P4_DOCTOR_OK" };
}

export async function readBridgeModelIds({
  baseUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5_000,
}) {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/u, "")}/models`, {
    method: "GET",
    redirect: "error",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Bridge model registry returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload?.object !== "list" || !Array.isArray(payload.data)) {
    throw new Error("Bridge model registry returned an invalid response");
  }
  const ids = payload.data.map((entry) => entry?.id);
  if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) {
    throw new Error("Bridge model registry returned invalid or duplicate model IDs");
  }
  return ids;
}

export async function runBridgeDoctor({
  config,
  paths,
  codexPath,
  live = false,
  fetchImpl = globalThis.fetch,
  environment = process.env,
  statusImpl = getConfigStatus,
  serviceStatusImpl = getBridgeServiceStatus,
  discoveryImpl = discoverBridgeModels,
  debugModelsImpl = debugModels,
  accountCacheImpl = inspectCodexAccountCache,
  runtimeSupportsZstdImpl = runtimeSupportsZstd,
  bundledCatalogImpl = loadBundledCatalog,
  clientVersionImpl = loadCodexClientVersion,
  compatibilityImpl = checkCurrentCompatibility,
  certificationStatusesImpl = resolveCertificationStatuses,
  pendingModelIdsImpl = listPendingModelCertificationIds,
}) {
  const installDirectory = path.dirname(paths.runtimePath);
  const compatibilityPath =
    paths.compatibilityPath ?? path.join(installDirectory, "compatibility.json");
  const certificationPath =
    paths.certificationPath ?? path.join(installDirectory, "certifications.json");
  const zstdAvailable = runtimeSupportsZstdImpl();
  const checks = [
    check(
      "node-runtime",
      zstdAvailable,
      zstdAvailable
        ? `${process.version}, zstd available`
        : `${process.version}, zstd unavailable`,
    ),
  ];
  let codexClientVersion;
  try {
    const [bundledCatalog, currentClientVersion] = await Promise.all([
      bundledCatalogImpl({ codexPath }),
      clientVersionImpl({ codexPath }),
    ]);
    codexClientVersion = currentClientVersion;
    const compatibility = await compatibilityImpl({
      manifestPath: compatibilityPath,
      bundledCatalog,
      codexClientVersion,
    });
    checks.push(
      check(
        "desktop-compatibility",
        compatibility.compatible === true,
        compatibility.compatible
          ? `${codexClientVersion}, ${compatibility.status}`
          : `${compatibility.status}: ${compatibility.reasons.join(", ")}`,
      ),
    );
  } catch (error) {
    checks.push(check("desktop-compatibility", false, error.message));
  }

  let accountCache;
  try {
    accountCache = await accountCacheImpl({
      codexHome: paths.codexHome,
      codexPath,
      codexClientVersion,
      clientVersionImpl,
    });
    codexClientVersion ??= accountCache.codexClientVersion;
    const modelCount = accountCache.catalog.models.length;
    const cacheWarning = accountCache.warning
      ? `; WARNING: ${accountCache.warning}`
      : "";
    const ageDetail = accountCacheAgeDetail(accountCache.ageMs);
    checks.push(
      check(
        "codex-account-cache",
        true,
        `${accountCache.cacheClientVersion}, ${modelCount} account model(s), fetched ${accountCache.fetchedAt}${ageDetail}${cacheWarning}`,
      ),
    );
  } catch (error) {
    checks.push(check("codex-account-cache", false, error.message));
  }

  let runtime;
  try {
    runtime = await readRuntime(paths.runtimePath);
  } catch (error) {
    checks.push(check("bridge-runtime", false, error.message));
  }

  let serviceStatus;
  if (runtime) {
    serviceStatus = await serviceStatusImpl({
      config,
      runtimePath: paths.runtimePath,
      launchAgentLabel: paths.launchAgentLabel,
      fetchImpl,
    });
    checks.push(
      check(
        "bridge-service",
        serviceStatus.loaded === true && serviceStatus.healthy === true,
        serviceStatus.status,
      ),
    );
    if (serviceStatus.health?.textOnlyContext !== undefined) {
      checks.push(textOnlyContextCheck(serviceStatus.health.textOnlyContext));
    }
  }

  const configStatus = await statusImpl({
    configPath: paths.configPath,
    statePath: paths.statePath,
  });
  if (runtime) {
    const expected = {
      provider: config.bridge.providerId,
      providerName: "OpenAI",
      catalog: paths.catalogPath,
      baseUrl: bridgeBaseUrl(config, runtime),
    };
    const mismatches = Object.entries(expected).filter(
      ([key, value]) => configStatus[key]?.replace?.(/\/+$/u, "") !== value.replace?.(/\/+$/u, ""),
    );
    checks.push(
      check(
        "managed-config",
        configStatus.installed === true && configStatus.healthy === true && mismatches.length === 0,
        mismatches.length === 0
          ? configStatus.status
          : `${configStatus.status}; unexpected ${mismatches.map(([key]) => key).join(", ")}`,
      ),
    );
  } else {
    checks.push(check("managed-config", false, configStatus.status));
  }

  let discovery;
  try {
    discovery = await discoveryImpl({ config, fetchImpl, environment });
    const loadedMode = config.providers.some(
      (provider) => provider.discovery?.mode === "loaded",
    );
    checks.push(
      check(
        "external-discovery",
        loadedMode || discovery.models.length > 0,
        `${discovery.models.length} loaded external LLM(s)${loadedMode ? " via automatic discovery" : " via allowlist"}`,
      ),
    );
  } catch (error) {
    checks.push(check("external-discovery", false, error.message));
  }

  let catalog;
  let externalSlugs = new Set();
  try {
    catalog = await readCodexCatalog(paths.catalogPath);
    const metadata = await stat(paths.catalogPath);
    const mode = metadata.mode & 0o777;
    if (mode !== 0o600) throw new Error(`catalog permissions must be 0600, received ${mode.toString(8)}`);
    const split = splitMixedCatalog(catalog, config);
    externalSlugs = new Set(
      split.externalAssignments.map((assignment) => assignment.catalogModel.slug),
    );
    const discoveredSlugs = new Set(discovery?.models.map((model) => model.id) ?? []);
    for (const slug of discoveredSlugs) {
      if (!catalog.models.some((model) => model.slug === slug)) {
        throw new Error(`catalog is missing external model ${slug}`);
      }
    }
    if (discovery && (
      discoveredSlugs.size !== externalSlugs.size ||
      [...externalSlugs].some((slug) => !discoveredSlugs.has(slug))
    )) {
      throw new Error(
        `catalog/discovery drift: catalog=${[...externalSlugs].join(", ")}; loaded=${[...discoveredSlugs].join(", ")}`,
      );
    }
    if (!catalog.models.some((model) => model.slug === "gpt-5.6-sol")) {
      throw new Error("catalog is missing native model gpt-5.6-sol");
    }
    const selected = catalog.models.find((model) => model.slug === configStatus.model);
    if (!selected) {
      throw new Error(`catalog is missing selected model ${configStatus.model}`);
    }
    const supportedEfforts = new Set(
      Array.isArray(selected.supported_reasoning_levels)
        ? selected.supported_reasoning_levels.map((level) => level?.effort)
        : [],
    );
    if (
      configStatus.modelReasoningEffort &&
      supportedEfforts.size > 0 &&
      !supportedEfforts.has(configStatus.modelReasoningEffort)
    ) {
      throw new Error(
        `selected model ${configStatus.model} does not support reasoning effort ${configStatus.modelReasoningEffort}`,
      );
    }
    checks.push(check("mixed-catalog-file", true, `${catalog.models.length} model(s), mode 0600`));
  } catch (error) {
    checks.push(check("mixed-catalog-file", false, error.message));
  }

  if (catalog && accountCache) {
    try {
      const nativeCount = assertNativeCatalogSnapshot({
        mixedCatalog: catalog,
        nativeCatalog: accountCache.catalog,
        externalSlugs,
      });
      checks.push(
        check(
          "native-account-catalog",
          true,
          `${nativeCount} exact account model(s) in the mixed catalog`,
        ),
      );
    } catch (error) {
      checks.push(check("native-account-catalog", false, error.message));
    }
  }

  if (catalog) {
    if (runtime && serviceStatus?.healthy) {
      try {
        const runningIds = await readBridgeModelIds({
          baseUrl: bridgeBaseUrl(config, runtime),
          fetchImpl,
        });
        const expectedIds = catalog.models.map((model) => model.slug);
        const expectedSorted = [...expectedIds].sort();
        const runningSorted = [...runningIds].sort();
        if (JSON.stringify(runningSorted) !== JSON.stringify(expectedSorted)) {
          throw new Error(
            `expected ${expectedSorted.join(", ")}; received ${runningSorted.join(", ")}`,
          );
        }
        checks.push(check("running-model-registry", true, `${runningIds.length} exact route(s)`));
      } catch (error) {
        checks.push(check("running-model-registry", false, error.message));
      }
    }
    try {
      const codexCatalog = await debugModelsImpl({ codexPath });
      assertCatalogSlugs(codexCatalog, catalog.models.map((model) => model.slug));
      checks.push(check("codex-model-catalog", true, `${catalog.models.length} mixed model(s)`));
    } catch (error) {
      checks.push(check("codex-model-catalog", false, error.message));
    }
  }

  if (catalog && discovery && codexClientVersion) {
    try {
      const [statuses, pendingModelIds] = await Promise.all([
        certificationStatusesImpl({
          storePath: certificationPath,
          config,
          models: discovery.models,
          codexClientVersion,
        }),
        pendingModelIdsImpl(certificationPath),
      ]);
      let efficientFidelity = 0;
      let direct = 0;
      let textOnly = 0;
      for (const entry of statuses) {
        const catalogModel = catalog.models.find(
          (model) => model.slug === entry.model.id,
        );
        if (!catalogModel) {
          throw new Error(`catalog is missing certification model ${entry.model.id}`);
        }
        const enabled =
          catalogModel.tool_mode === "direct" &&
          catalogModel.shell_type === "unified_exec";
        const shouldEnable = entry.certification.status === "valid";
        if (enabled !== shouldEnable) {
          throw new Error(
            `tool capability drift for ${entry.model.id}: certification=${entry.certification.status}, catalog=${enabled ? "enabled" : "disabled"}`,
          );
        }
        const searchEnabled = catalogModel.supports_search_tool === true;
        const shouldEnableSearch =
          entry.efficientFidelityCertification?.status === "valid";
        if (searchEnabled !== shouldEnableSearch) {
          throw new Error(
            `tool search capability drift for ${entry.model.id}: certification=${entry.efficientFidelityCertification?.status ?? "missing"}, catalog=${searchEnabled ? "enabled" : "disabled"}`,
          );
        }
        if (shouldEnableSearch) efficientFidelity += 1;
        else if (shouldEnable) direct += 1;
        else textOnly += 1;
      }
      checks.push(
        check(
          "tool-certifications",
          true,
          `${efficientFidelity} Efficient Fidelity, ${direct} direct, ${textOnly} conservative text-only model(s); ${pendingModelIds.length} certification recovery operation(s) pending`,
        ),
      );
    } catch (error) {
      checks.push(check("tool-certifications", false, error.message));
    }
  }

  if (live && runtime && discovery?.models.length > 0 && serviceStatus?.healthy) {
    try {
      await runBridgeLiveCheck({
        baseUrl: bridgeBaseUrl(config, runtime),
        model: discovery.models[0].id,
        fetchImpl,
      });
      checks.push(check("live-external-response", true, "P4_DOCTOR_OK through bridge"));
    } catch (error) {
      checks.push(check("live-external-response", false, error.message));
    }
  }

  return {
    ok: checks.every((entry) => entry.status === "pass"),
    checks,
    configStatus,
    serviceStatus,
  };
}
