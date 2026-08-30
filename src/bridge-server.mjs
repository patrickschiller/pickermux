import http from "node:http";

import { hasDisallowedOrigin, isExpectedHost } from "./header-policy.mjs";
import { createResponsesProxy } from "./responses-proxy.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u;

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
      writeJson(response, 200, { ok: true, instanceId });
      return;
    }
    if (request.method === "GET" && path === "/v1/models") {
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
