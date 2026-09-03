import { createHash } from "node:crypto";

const DEFAULT_NAMESPACE = "functions";
const WIRE_PREFIX = "mbns_";
const UNSUPPORTED_TOOL_TYPES = new Set([
  "custom",
  "tool_search",
  "web_search",
]);
const FUNCTION_CALL_STREAM_EVENTS = new Set([
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
]);
const OUTPUT_ITEM_STREAM_EVENTS = new Set([
  "response.output_item.added",
  "response.output_item.done",
]);
const TERMINAL_RESPONSE_STREAM_EVENTS = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
]);
const MAX_RESPONSE_FUNCTION_CALLS = 4_096;

export class ToolNormalizationError extends Error {
  constructor(message, { code = "UNSUPPORTED_TOOL_TYPE" } = {}) {
    super(message);
    this.name = "ToolNormalizationError";
    this.statusCode = 400;
    this.code = code;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireToolName(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ToolNormalizationError(`${label} has an invalid name`);
  }
  return value;
}

function requireIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ToolNormalizationError(`${label} is invalid`);
  }
  return value;
}

function isUnsupportedInvocationType(type) {
  return (
    typeof type === "string" &&
    type !== "function_call" &&
    type !== "function_call_output" &&
    (type.endsWith("_call") ||
      type.endsWith("_call_output") ||
      type.startsWith("mcp_"))
  );
}

function normalizedParameters(value) {
  if (value === undefined || value === null) {
    return { type: "object", properties: {} };
  }
  if (!isPlainObject(value)) {
    throw new ToolNormalizationError("Function parameters must be a JSON object");
  }
  if (Object.keys(value).length === 0) {
    return { type: "object", properties: {} };
  }
  if (value.type === "object" && value.properties === undefined) {
    return { ...value, properties: {} };
  }
  return { ...value };
}

function normalizedFunction(tool, label) {
  if (!isPlainObject(tool) || tool.type !== "function") {
    throw new ToolNormalizationError(`${label} is not a function tool`);
  }
  if (
    Object.hasOwn(tool, "defer_loading") &&
    typeof tool.defer_loading !== "boolean"
  ) {
    throw new ToolNormalizationError(`${label}.defer_loading must be a boolean`);
  }
  const normalized = {
    ...tool,
    name: requireToolName(tool.name, label),
    parameters: normalizedParameters(tool.parameters),
  };
  // defer_loading is a Codex delivery hint, not part of LM Studio's function
  // schema. Direct fallback still sends the function, but never leaks the hint
  // onto the provider wire.
  delete normalized.defer_loading;
  return normalized;
}

function wireNameFor(namespace, name, occupied) {
  for (let salt = 0; salt < 64; salt += 1) {
    const digest = createHash("sha256")
      .update(`${namespace}\0${name}\0${salt}`)
      .digest("hex")
      .slice(0, 56);
    const candidate = `${WIRE_PREFIX}${digest}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw new ToolNormalizationError("Could not allocate a unique namespace tool name");
}

function unsupportedChoice(message) {
  throw new ToolNormalizationError(message, { code: "UNSUPPORTED_TOOL_CHOICE" });
}

function choiceTarget(choice) {
  if (!isPlainObject(choice)) return null;
  if (choice.type === "function") {
    const name = choice.name ?? choice.function?.name;
    return typeof name === "string"
      ? { namespace: undefined, name }
      : null;
  }
  if (choice.type === "namespace") {
    const name = choice.function?.name ?? choice.tool?.name;
    return typeof choice.name === "string" && typeof name === "string"
      ? { namespace: choice.name, name }
      : null;
  }
  return null;
}

/**
 * Convert Codex namespace tools into the direct function shape accepted by LM
 * Studio. The returned maps are request-local and contain no arguments or
 * provider data.
 */
export function normalizeLmStudioToolRequest(
  rewritten,
  source,
  { allowHistoryOnlyNamespaces = false } = {},
) {
  if (typeof allowHistoryOnlyNamespaces !== "boolean") {
    throw new TypeError("allowHistoryOnlyNamespaces must be a boolean");
  }
  if (
    source.parallel_tool_calls !== undefined &&
    typeof source.parallel_tool_calls !== "boolean"
  ) {
    throw new ToolNormalizationError(
      "parallel_tool_calls must be a boolean when present",
    );
  }
  const directNames = new Set();
  for (const tool of Array.isArray(source.tools) ? source.tools : []) {
    if (isPlainObject(tool) && tool.type === "function") {
      directNames.add(requireToolName(tool.name, "Function tool"));
    }
  }

  const occupied = new Set(directNames);
  const usedWireNames = new Set();
  const forward = new Map();
  const reverse = new Map();
  const historyOnlyWireNames = new Set();
  const reservedCallIds = new Set();
  const reservedItemIds = new Set();
  const tools = [];
  const keys = new Set();
  const droppedTypes = new Set();

  const add = ({ namespace, tool, label }) => {
    const normalized = normalizedFunction(tool, label);
    const semanticKey = `${namespace ?? ""}\0${normalized.name}`;
    if (keys.has(semanticKey)) {
      throw new ToolNormalizationError(`Duplicate function tool ${normalized.name}`);
    }
    keys.add(semanticKey);

    let wireName = normalized.name;
    if (namespace && namespace !== DEFAULT_NAMESPACE) {
      wireName = wireNameFor(namespace, normalized.name, occupied);
      const mapping = Object.freeze({ namespace, name: normalized.name, wireName });
      forward.set(semanticKey, mapping);
      reverse.set(wireName, mapping);
    } else if (namespace === DEFAULT_NAMESPACE) {
      forward.set(semanticKey, Object.freeze({ namespace, name: normalized.name, wireName }));
    }
    if (usedWireNames.has(wireName)) {
      throw new ToolNormalizationError(`Duplicate wire function ${wireName}`);
    }
    occupied.add(wireName);
    usedWireNames.add(wireName);
    tools.push({ ...normalized, name: wireName });
  };

  for (const [index, tool] of (Array.isArray(source.tools) ? source.tools : []).entries()) {
    if (!isPlainObject(tool)) {
      throw new ToolNormalizationError(`tools[${index}] must be a JSON object`);
    }
    if (tool.type === "function") {
      add({ tool, label: `tools[${index}]` });
      continue;
    }
    if (tool.type === "namespace") {
      const namespace = requireToolName(tool.name, `tools[${index}] namespace`);
      if (!Array.isArray(tool.tools)) {
        throw new ToolNormalizationError(`Namespace ${namespace} must contain tools`);
      }
      for (const [nestedIndex, nested] of tool.tools.entries()) {
        if (!isPlainObject(nested) || nested.type !== "function") {
          throw new ToolNormalizationError(
            `Namespace ${namespace} contains unsupported tool type ${String(nested?.type ?? "invalid")}`,
          );
        }
        add({
          namespace,
          tool: nested,
          label: `tools[${index}].tools[${nestedIndex}]`,
        });
      }
      continue;
    }
    if (UNSUPPORTED_TOOL_TYPES.has(tool.type)) {
      droppedTypes.add(tool.type);
      continue;
    }
    throw new ToolNormalizationError(
      `Unsupported tool type ${String(tool.type ?? "invalid")}`,
    );
  }

  if (Array.isArray(source.input)) {
    rewritten.input = rewritten.input.map((item) => {
      if (isPlainObject(item) && isUnsupportedInvocationType(item.type)) {
        throw new ToolNormalizationError(
          "LM Studio does not accept unadvertised invocation history",
        );
      }
      if (
        isPlainObject(item) &&
        (item.type === "function_call" ||
          item.type === "function_call_output")
      ) {
        if (item.call_id !== undefined) {
          reservedCallIds.add(
            requireIdentifier(item.call_id, "Function history call_id"),
          );
        }
        if (item.id !== undefined) {
          reservedItemIds.add(
            requireIdentifier(item.id, "Function history item id"),
          );
        }
      }
      if (!isPlainObject(item) || item.type !== "function_call") return item;
      const normalized = { ...item };
      if (typeof item.namespace === "string") {
        if (item.namespace === DEFAULT_NAMESPACE) {
          delete normalized.namespace;
        } else {
          const namespace = requireToolName(
            item.namespace,
            "Function history namespace",
          );
          const name = requireToolName(item.name, "Function history tool");
          const semanticKey = `${namespace}\0${name}`;
          let mapping = forward.get(semanticKey);
          if (!mapping && allowHistoryOnlyNamespaces) {
            const wireName = wireNameFor(namespace, name, occupied);
            mapping = Object.freeze({ namespace, name, wireName });
            forward.set(semanticKey, mapping);
            // This mapping exists only to encode completed request history for
            // remote compaction. Without an advertised schema it conveys no
            // response-side call authority.
            historyOnlyWireNames.add(wireName);
            occupied.add(wireName);
            usedWireNames.add(wireName);
          }
          if (!mapping) {
            throw new ToolNormalizationError(
              `Function history references unknown namespace tool ${item.namespace}/${String(item.name)}`,
            );
          }
          normalized.name = mapping.wireName;
          delete normalized.namespace;
        }
      }
      return normalized;
    });
  }

  const target = choiceTarget(source.tool_choice);
  if (isPlainObject(source.tool_choice) && !target) {
    const type = String(source.tool_choice.type ?? "invalid");
    if (UNSUPPORTED_TOOL_TYPES.has(type)) {
      throw new ToolNormalizationError(`Selected unsupported tool type ${type}`);
    }
    unsupportedChoice("LM Studio cannot satisfy the selected tool choice");
  }

  if (target) {
    let wireName;
    if (target.namespace && target.namespace !== DEFAULT_NAMESPACE) {
      wireName = forward.get(`${target.namespace}\0${target.name}`)?.wireName;
    } else {
      wireName = target.name;
    }
    const selected = tools.find((tool) => tool.name === wireName);
    if (!selected) unsupportedChoice("LM Studio cannot satisfy the selected tool choice");
    rewritten.tools = [selected];
    rewritten.tool_choice = "required";
    rewritten.parallel_tool_calls = false;
  } else if (tools.length > 0) {
    rewritten.tools = tools;
  } else {
    delete rewritten.tools;
    delete rewritten.parallel_tool_calls;
    if (source.tool_choice === "required") {
      unsupportedChoice("LM Studio cannot satisfy the required tool choice");
    }
    delete rewritten.tool_choice;
  }

  const allowedWireNames = new Set(
    source.tool_choice !== "none" && Array.isArray(rewritten.tools)
      ? rewritten.tools.map((tool) => tool.name)
      : [],
  );
  const maxAuthorizedCalls = source.tool_choice === "none"
    ? 0
    : target || source.parallel_tool_calls === false
      ? 1
      : MAX_RESPONSE_FUNCTION_CALLS;
  return Object.freeze({
    allowedWireNames,
    forward,
    historyOnlyWireNames,
    maxAuthorizedCalls,
    reservedCallIds,
    reservedItemIds,
    reverse,
    droppedTypes: Object.freeze([...droppedTypes].sort()),
  });
}

/** Build a response-only authority codec for an external text-only route. */
export function createTextOnlyToolResponseCodec() {
  return Object.freeze({
    allowedWireNames: new Set(),
    forward: new Map(),
    historyOnlyWireNames: new Set(),
    maxAuthorizedCalls: 0,
    reservedCallIds: new Set(),
    reservedItemIds: new Set(),
    reverse: new Map(),
    droppedTypes: Object.freeze([]),
  });
}

function rewriteAuthorizedWireName(value, codec, { addNamespace }) {
  if (Object.hasOwn(value, "namespace")) {
    throw new ToolNormalizationError(
      "Upstream function calls must not supply a namespace",
    );
  }
  const wireName = requireToolName(value.name, "Upstream function call");
  if (codec.historyOnlyWireNames?.has(wireName)) {
    throw new ToolNormalizationError(
      "Upstream invoked a history-only namespace tool",
    );
  }
  if (codec.allowedWireNames && !codec.allowedWireNames.has(wireName)) {
    throw new ToolNormalizationError(
      "Upstream invoked a function that was not advertised",
    );
  }
  const mapping = codec.reverse?.get(wireName);
  if (mapping) {
    value.name = mapping.name;
    if (addNamespace) value.namespace = mapping.namespace;
  }
}

export function rewriteResponseFunctionCalls(
  value,
  codec,
  { mode = "json" } = {},
) {
  if (mode !== "json" && mode !== "sse") {
    throw new TypeError("response function-call rewrite mode is invalid");
  }
  if (
    !codec?.allowedWireNames &&
    (!codec?.reverse || codec.reverse.size === 0) &&
    (!codec?.historyOnlyWireNames || codec.historyOnlyWireNames.size === 0)
  ) {
    return value;
  }
  const canonicalItems = new Set();
  if (isPlainObject(value)) {
    if (mode === "json" && Array.isArray(value.output)) {
      for (const item of value.output) {
        if (item !== null && typeof item === "object") canonicalItems.add(item);
      }
    }
    if (
      mode === "sse" &&
      OUTPUT_ITEM_STREAM_EVENTS.has(value.type) &&
      value.item !== null &&
      typeof value.item === "object"
    ) {
      canonicalItems.add(value.item);
    }
    if (
      mode === "sse" &&
      TERMINAL_RESPONSE_STREAM_EVENTS.has(value.type) &&
      isPlainObject(value.response) &&
      Array.isArray(value.response.output)
    ) {
      for (const item of value.response.output) {
        if (item !== null && typeof item === "object") canonicalItems.add(item);
      }
    }
  }

  const pending = [value];
  const seen = new WeakSet();
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    visited += 1;
    if (visited > 1_000_000) {
      throw new ToolNormalizationError("Upstream response is too structurally complex");
    }
    if (!Array.isArray(current) && typeof current.type === "string") {
      if (
        current.type.startsWith("response.") &&
        (current.type.includes("_call") ||
          current.type.includes("mcp_")) &&
        (
          current !== value ||
          codec.allowedWireNames?.size === 0 ||
          !FUNCTION_CALL_STREAM_EVENTS.has(current.type)
        )
      ) {
        throw new ToolNormalizationError(
          "Upstream emitted an unauthorized tool-call lifecycle event",
        );
      }
      if (isUnsupportedInvocationType(current.type)) {
        throw new ToolNormalizationError(
          "Upstream emitted an unsupported tool invocation",
        );
      }
      if (
        current === value &&
        FUNCTION_CALL_STREAM_EVENTS.has(current.type) &&
        current.name !== undefined
      ) {
        rewriteAuthorizedWireName(current, codec, { addNamespace: false });
      }
    }
    if (!Array.isArray(current) && current.type === "function_call") {
      if (!canonicalItems.has(current)) {
        throw new ToolNormalizationError(
          "Upstream emitted a function call outside a canonical response output path",
        );
      }
      rewriteAuthorizedWireName(current, codec, { addNamespace: true });
    }
    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
  }
  return value;
}

export const TOOL_NAMESPACE_WIRE_PREFIX = WIRE_PREFIX;
