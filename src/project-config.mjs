import { readFile } from "node:fs/promises";

const PROVIDER_ID_PATTERN = /^[a-z0-9_-]+$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    !url.username &&
    !url.password
  );
}

export function validateProjectConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Project config must be a JSON object");
  }

  const endpoint = String(input.endpoint ?? "").replace(/\/+$/, "");
  if (!isLoopbackEndpoint(endpoint)) {
    throw new Error(
      "P1 endpoint must be an unauthenticated loopback HTTP URL; use LM Link or a local tunnel",
    );
  }

  const endpointUrl = new URL(endpoint);
  if (endpointUrl.search || endpointUrl.hash) {
    throw new Error("P1 endpoint must not contain a query string or fragment");
  }

  const providerId = String(input.providerId ?? "").trim();
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error(
      "providerId must contain only lowercase letters, digits, underscores, or hyphens",
    );
  }
  if (providerId === "lmstudio" || providerId === "openai") {
    throw new Error(`providerId ${providerId} is reserved by Codex`);
  }

  const providerName = String(input.providerName ?? "").trim();
  if (!providerName || /[\r\n]/u.test(providerName)) {
    throw new Error("providerName must be a non-empty single line");
  }

  const donorSlug = String(input.donorSlug ?? "gpt-5.4-mini").trim();
  if (!donorSlug) {
    throw new Error("donorSlug must not be empty");
  }

  if (!Array.isArray(input.models) || input.models.length === 0) {
    throw new Error("models must contain at least one explicitly allowed model");
  }

  const seen = new Set();
  const models = input.models.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`models[${index}] must be an object`);
    }
    const id = String(entry.id ?? "").trim();
    if (!id || /[\r\n]/u.test(id)) {
      throw new Error(`models[${index}].id must be a non-empty single line`);
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate allowlisted model id: ${id}`);
    }
    seen.add(id);

    const displayName = String(entry.displayName ?? id).trim();
    if (!displayName || /[\r\n]/u.test(displayName)) {
      throw new Error(`models[${index}].displayName must be a single line`);
    }

    const normalized = { id, displayName };
    if (entry.type !== undefined) {
      normalized.type = String(entry.type);
    }
    if (entry.contextWindow !== undefined) {
      if (!Number.isSafeInteger(entry.contextWindow) || entry.contextWindow <= 0) {
        throw new Error(`models[${index}].contextWindow must be a positive integer`);
      }
      normalized.contextWindow = entry.contextWindow;
    }
    return normalized;
  });

  return {
    endpoint,
    providerId,
    providerName,
    donorSlug,
    models,
  };
}

export async function loadProjectConfig(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read project config ${path}: ${error.message}`, {
      cause: error,
    });
  }
  return validateProjectConfig(parsed);
}
