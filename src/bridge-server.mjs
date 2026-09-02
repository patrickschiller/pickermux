import http from "node:http";

import { hasDisallowedOrigin, isExpectedHost } from "./header-policy.mjs";
import { createResponsesProxy } from "./responses-proxy.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u;
const SAFE_COMPATIBILITY_STATUSES = new Set([
  "checking",
  "check-failed",
  "compatible",
  "update-required",
]);
const SAFE_COMPATIBILITY_REASONS = new Set([
  "bridge-contract",
  "bundled-catalog",
  "codex-client-version",
  "manifest-invalid",
  "manifest-missing",
]);
const TEXT_ONLY_CONTEXT_OUTCOMES = new Set(["compacted", "unchanged"]);
const TEXT_ONLY_CONTEXT_STOP_REASONS = new Set([
  "ambiguous",
  "conversation",
  "none",
]);
const TEXT_ONLY_CONTEXT_COUNTERS = Object.freeze([
  "sourceItems",
  "forwardedItems",
  "sourceParts",
  "retainedParts",
  "retainedBootstrapParts",
  "retainedBootstrapBytes",
  "omittedParts",
  "sourceBytes",
  "forwardedBytes",
  "sourceRequestBytes",
  "forwardedRequestBytes",
  "omittedBytes",
]);

function writeJson(response, statusCode, value, extraHeaders = {}) {
  if (response.destroyed || response.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": String(body.length),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

function writeRouteError(response, statusCode, code, message) {
  writeJson(response, statusCode, { error: { code, message } });
}

function publicCompatibilityState(compatibilityGate) {
  if (!compatibilityGate) return null;
  try {
    const current = compatibilityGate.snapshot();
    const status = SAFE_COMPATIBILITY_STATUSES.has(current?.status)
      ? current.status
      : "check-failed";
    const reasons = Array.isArray(current?.reasons)
      ? [...new Set(current.reasons.filter((reason) =>
          SAFE_COMPATIBILITY_REASONS.has(reason)))]
      : [];
    return { status, reasons };
  } catch {
    return { status: "check-failed", reasons: [] };
  }
}

async function admitModelRequest(compatibilityGate, response) {
  if (!compatibilityGate) return true;
  try {
    await compatibilityGate.assertReady();
    return true;
  } catch (error) {
    const updateRequired =
      error?.code === "DESKTOP_COMPATIBILITY_UPDATE_REQUIRED";
    writeRouteError(
      response,
      503,
      updateRequired
        ? "DESKTOP_COMPATIBILITY_UPDATE_REQUIRED"
        : "DESKTOP_COMPATIBILITY_UNAVAILABLE",
      updateRequired
        ? "PickerMux must be updated for this Codex Desktop version"
        : "Codex Desktop compatibility could not be verified",
    );
    return false;
  }
}

function safeTextOnlyContextEvent(event) {
  if (
    event === null ||
    Array.isArray(event) ||
    typeof event !== "object" ||
    event.event !== "lmstudio_text_only_compaction" ||
    event.schemaVersion !== 1 ||
    !TEXT_ONLY_CONTEXT_OUTCOMES.has(event.outcome) ||
    !TEXT_ONLY_CONTEXT_STOP_REASONS.has(event.stopReason) ||
    typeof event.changed !== "boolean" ||
    typeof event.stopped !== "boolean"
  ) {
    return null;
  }
  const counters = {};
  for (const name of TEXT_ONLY_CONTEXT_COUNTERS) {
    const value = event[name];
    if (!Number.isSafeInteger(value) || value < 0) return null;
    counters[name] = value;
  }
  if (
    counters.retainedParts + counters.omittedParts !== counters.sourceParts ||
    counters.retainedBootstrapParts > counters.retainedParts ||
    event.changed !== (counters.omittedParts > 0) ||
    event.outcome !== (event.changed ? "compacted" : "unchanged") ||
    event.stopped !== (event.stopReason !== "none")
  ) {
    return null;
  }
  return Object.freeze({
    outcome: event.outcome,
    stopReason: event.stopReason,
    changed: event.changed,
    stopped: event.stopped,
    ...counters,
  });
}

function saturatingAdd(left, right) {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function createTextOnlyContextTelemetry() {
  let requests = 0;
  let last;
  const totals = Object.fromEntries(
    TEXT_ONLY_CONTEXT_COUNTERS.map((name) => [name, 0]),
  );
  return Object.freeze({
    record(event) {
      const safe = safeTextOnlyContextEvent(event);
      if (!safe) return false;
      requests = saturatingAdd(requests, 1);
      for (const name of TEXT_ONLY_CONTEXT_COUNTERS) {
        totals[name] = saturatingAdd(totals[name], safe[name]);
      }
      last = safe;
      return true;
    },
    snapshot() {
      if (!last) return null;
      return {
        schemaVersion: 1,
        requests,
        totals: { ...totals },
        last: { ...last },
      };
    },
  });
}

function publicModelDescriptor(model) {
  if (typeof model === "string") {
    return { id: model, object: "model" };
  }
  if (!model || typeof model !== "object" || typeof model.id !== "string") return null;

  // Explicit projection prevents route destinations and credential metadata
  // from leaking through the diagnostic endpoint.
  const descriptor = {
    id: model.id,
    object: "model",
  };
  for (const key of ["owned_by", "kind", "display_name"]) {
    if (typeof model[key] === "string") descriptor[key] = model[key];
  }
  return descriptor;
}

function wrapLoopbackListen(server) {
  const nodeListen = server.listen.bind(server);
  server.listen = function listenLoopback(...args) {
    if (typeof args[0] === "object" && args[0] !== null) {
      const options = args[0];
      if (options.path) throw new TypeError("The bridge only supports TCP loopback");
      if (options.host && options.host !== LOOPBACK_HOST) {
        throw new TypeError("The bridge can only listen on 127.0.0.1");
      }
      return nodeListen({ ...options, host: LOOPBACK_HOST }, ...args.slice(1));
    }

    if (typeof args[0] !== "number") {
      throw new TypeError("A numeric loopback port is required");
    }
    if (typeof args[1] === "string") {
      if (args[1] !== LOOPBACK_HOST) {
        throw new TypeError("The bridge can only listen on 127.0.0.1");
      }
      return nodeListen(...args);
    }
    return nodeListen(args[0], LOOPBACK_HOST, ...args.slice(1));
  };
}

function listenerPort(server) {
  const address = server.address();
  return address && typeof address === "object" ? address.port : undefined;
}

function isLoopbackSocket(request) {
  const local = request.socket?.localAddress;
  const remote = request.socket?.remoteAddress;
  return local === LOOPBACK_HOST && (remote === LOOPBACK_HOST || remote === "::ffff:127.0.0.1");
}

export function capabilityBasePath(capabilityToken) {
  if (!CAPABILITY_PATTERN.test(String(capabilityToken ?? ""))) {
    throw new TypeError("Capability token must be 32-256 URL-safe characters");
  }
  return `/c/${capabilityToken}`;
}

export function bridgeProviderBaseUrl(server, capabilityToken) {
  const port = listenerPort(server);
  if (!port) throw new Error("Bridge server is not listening");
  return `http://${LOOPBACK_HOST}:${port}${capabilityBasePath(capabilityToken)}/v1`;
}

export function createBridgeServer({
  registry,
  capabilityToken,
  limits,
  nativeBaseUrl,
  env,
  credentialResolver,
  httpTransport,
  httpsTransport,
  dnsLookup,
  requestHeaderBytes = 32 * 1024,
  instanceId = null,
  compatibilityGate,
  onTextOnlyCompaction,
} = {}) {
  if (!registry || typeof registry.resolve !== "function" || typeof registry.listModels !== "function") {
    throw new TypeError("A model registry with resolve() and listModels() is required");
  }
  if (!Number.isSafeInteger(requestHeaderBytes) || requestHeaderBytes < 1) {
    throw new TypeError("requestHeaderBytes must be a positive safe integer");
  }
  if (instanceId !== null && (typeof instanceId !== "string" || !instanceId)) {
    throw new TypeError("instanceId must be a non-empty string or null");
  }
  if (
    compatibilityGate !== undefined &&
    (
      typeof compatibilityGate?.assertReady !== "function" ||
      typeof compatibilityGate?.snapshot !== "function"
    )
  ) {
    throw new TypeError("compatibilityGate must provide assertReady() and snapshot()");
  }
  if (
    onTextOnlyCompaction !== undefined &&
    typeof onTextOnlyCompaction !== "function"
  ) {
    throw new TypeError("onTextOnlyCompaction must be a function");
  }
  const textOnlyContextTelemetry = createTextOnlyContextTelemetry();
  const captureTextOnlyCompaction = (event) => {
    textOnlyContextTelemetry.record(event);
    return onTextOnlyCompaction?.(event);
  };
  const basePath = capabilityBasePath(capabilityToken);
  const handleResponses = createResponsesProxy({
    registry,
    nativeBaseUrl,
    env,
    credentialResolver,
    limits,
    httpTransport,
    httpsTransport,
    dnsLookup,
    certificationToken: instanceId,
    onTextOnlyCompaction: captureTextOnlyCompaction,
  });

  const server = http.createServer({ maxHeaderSize: requestHeaderBytes }, async (request, response) => {
    const port = listenerPort(server);
    if (!port || !isLoopbackSocket(request) || !isExpectedHost(request.headers.host, port)) {
      writeRouteError(response, 421, "INVALID_HOST", "The request host is not allowed");
      return;
    }
    if (hasDisallowedOrigin(request.headers)) {
      writeRouteError(response, 403, "ORIGIN_NOT_ALLOWED", "Browser-origin requests are not allowed");
      return;
    }
    if (
      typeof request.url !== "string" ||
      !request.url.startsWith("/") ||
      request.url.startsWith("//")
    ) {
      writeRouteError(response, 400, "INVALID_TARGET", "The request target is invalid");
      return;
    }

    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host}`);
    } catch {
      writeRouteError(response, 400, "INVALID_TARGET", "The request target is invalid");
      return;
    }
    if (url.search || url.hash || !url.pathname.startsWith(`${basePath}/`)) {
      writeRouteError(response, 404, "NOT_FOUND", "Endpoint not found");
      return;
    }
    const path = url.pathname.slice(basePath.length);

    if (request.method === "GET" && path === "/health") {
      const compatibility = publicCompatibilityState(compatibilityGate);
      const textOnlyContext = textOnlyContextTelemetry.snapshot();
      writeJson(response, 200, {
        ok: compatibility === null || compatibility.status === "compatible",
        instanceId,
        ...(compatibility === null ? {} : { compatibility }),
        ...(textOnlyContext === null ? {} : { textOnlyContext }),
      });
      return;
    }
    if (request.method === "GET" && path === "/v1/models") {
      if (!(await admitModelRequest(compatibilityGate, response))) return;
      try {
        const listed = await registry.listModels();
        const models = (Array.isArray(listed) ? listed : [])
          .map(publicModelDescriptor)
          .filter(Boolean);
        writeJson(response, 200, { object: "list", data: models });
      } catch {
        writeRouteError(response, 500, "REGISTRY_ERROR", "The model catalog is unavailable");
      }
      return;
    }
    if (
      request.method === "POST" &&
      (path === "/v1/responses" || path === "/v1/responses/compact")
    ) {
      if (!(await admitModelRequest(compatibilityGate, response))) return;
      await handleResponses(request, response, path);
      return;
    }

    if (path === "/v1/responses" || path === "/v1/responses/compact") {
      writeRouteError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
      return;
    }
    writeRouteError(response, 404, "NOT_FOUND", "Endpoint not found");
  });

  wrapLoopbackListen(server);
  server.on("upgrade", (_request, socket) => {
    const body = "WebSocket transport is not supported\n";
    socket.end(
      `HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  });

  // Conservative socket defaults limit slow and abandoned local clients.
  server.headersTimeout = 125_000;
  server.keepAliveTimeout = 120_000;
  server.maxRequestsPerSocket = 100;
  Object.defineProperties(server, {
    capabilityPath: { value: basePath, enumerable: true },
    providerBaseUrl: {
      enumerable: true,
      get: () => bridgeProviderBaseUrl(server, capabilityToken),
    },
  });
  return server;
}

export async function listenBridgeServer(options = {}) {
  const { port = 0, ...serverOptions } = options;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("port must be an integer from 0 through 65535");
  }
  const server = createBridgeServer(serverOptions);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
