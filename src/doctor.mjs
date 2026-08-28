import { stat } from "node:fs/promises";

import { readCodexCatalog } from "./catalog.mjs";
import { assertCatalogModels, debugModels } from "./codex.mjs";
import { getConfigStatus } from "./config-manager.mjs";
import { discoverLmStudio } from "./discovery.mjs";

function check(name, ok, detail) {
  return { name, status: ok ? "pass" : "fail", detail };
}

function visibleText(response) {
  if (!Array.isArray(response?.output)) {
    return "";
  }
  return response.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .filter((part) => part?.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
}

export async function runLiveResponseCheck({
  baseUrl,
  model,
  fetchImpl = globalThis.fetch,
  timeoutMs = 180_000,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/u, "")}/responses`, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: "Reply with exactly P1_DOCTOR_OK and nothing else.",
        reasoning: { effort: "low" },
        max_output_tokens: 256,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Live Responses check returned HTTP ${response.status}`);
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("Live Responses check timed out", { cause: error });
      }
      throw new Error("Live Responses check returned invalid JSON", {
        cause: error,
      });
    }
    const text = visibleText(payload).trim();
    if (!text.includes("P1_DOCTOR_OK")) {
      throw new Error("Live Responses check did not return the expected marker");
    }
    return { responseId: payload.id ?? null, text: "P1_DOCTOR_OK" };
  } catch (error) {
    if (controller.signal.aborted && !error.message.includes("timed out")) {
      throw new Error("Live Responses check timed out", { cause: error });
    }
    if (error.message.startsWith("Live Responses check")) throw error;
    throw new Error("Live Responses check failed to connect", { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

export async function runDoctor({
  projectConfig,
  paths,
  codexPath,
  live = false,
  fetchImpl = globalThis.fetch,
  statusImpl = getConfigStatus,
  discoverImpl = discoverLmStudio,
  debugModelsImpl = debugModels,
}) {
  const checks = [];
  const expectedIds = projectConfig.models.map((model) => model.id);

  const configStatus = await statusImpl({
    configPath: paths.configPath,
    statePath: paths.statePath,
  });
  const expectedConfig = {
    model: projectConfig.models[0].id,
    provider: projectConfig.providerId,
    providerName: projectConfig.providerName,
    catalog: paths.catalogPath,
    baseUrl: projectConfig.endpoint.replace(/\/+$/u, ""),
    modelReasoningEffort: "low",
  };
  const configMismatches = [];
  for (const [key, expected] of Object.entries(expectedConfig)) {
    const actual = configStatus[key];
    const normalizedActual =
      key === "baseUrl" && typeof actual === "string"
        ? actual.replace(/\/+$/u, "")
        : actual;
    if (normalizedActual !== expected) {
      configMismatches.push(`${key}=${String(normalizedActual)}`);
    }
  }
  checks.push(
    check(
      "managed-config",
      configStatus.installed === true &&
        configStatus.healthy === true &&
        configMismatches.length === 0,
      configMismatches.length === 0
        ? configStatus.status
        : `${configStatus.status}; unexpected ${configMismatches.join(", ")}`,
    ),
  );

  let discovery;
  try {
    discovery = await discoverImpl({
      baseUrl: projectConfig.endpoint,
      allowlist: projectConfig.models,
      fetchImpl,
      timeoutMs: 8_000,
    });
    checks.push(
      check(
        "lmstudio-discovery",
        true,
        `${discovery.models.length} allowlisted loaded LLM(s) via ${discovery.source}`,
      ),
    );
  } catch (error) {
    checks.push(check("lmstudio-discovery", false, error.message));
  }

  let catalog;
  try {
    catalog = await readCodexCatalog(paths.catalogPath);
    assertCatalogModels(catalog, expectedIds);
    const catalogStat = await stat(paths.catalogPath);
    const mode = catalogStat.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(
        `catalog permissions must be 0600, received ${mode.toString(8)}`,
      );
    }
    checks.push(check("catalog-file", true, `${catalog.models.length} model(s), mode 0600`));
  } catch (error) {
    checks.push(check("catalog-file", false, error.message));
  }

  try {
    const codexCatalog = await debugModelsImpl({ codexPath });
    assertCatalogModels(codexCatalog, expectedIds);
    checks.push(
      check(
        "codex-model-catalog",
        true,
        expectedIds.join(", "),
      ),
    );
  } catch (error) {
    checks.push(check("codex-model-catalog", false, error.message));
  }

  if (live && discovery?.models.length > 0) {
    try {
      await runLiveResponseCheck({
        baseUrl: discovery.apiBaseUrl,
        model: discovery.models[0].id,
        fetchImpl,
      });
      checks.push(check("live-response", true, "P1_DOCTOR_OK"));
    } catch (error) {
      checks.push(check("live-response", false, error.message));
    }
  }

  return {
    ok: checks.every((entry) => entry.status === "pass"),
    checks,
    configStatus,
  };
}
