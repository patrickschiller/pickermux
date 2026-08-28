import { createHash } from "node:crypto";

const DEFAULT_NAMESPACE = "functions";
const WIRE_PREFIX = "mbns_";
const UNSUPPORTED_TOOL_TYPES = new Set([
  "custom",
  "tool_search",
  "web_search",
]);

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
  return {
    ...tool,
    name: requireToolName(tool.name, label),
    parameters: normalizedParameters(tool.parameters),
  };
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
export function normalizeLmStudioToolRequest(rewritten, source) {
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
      if (!isPlainObject(item) || item.type !== "function_call") return item;
      const normalized = { ...item };
      if (typeof item.namespace === "string") {
        if (item.namespace === DEFAULT_NAMESPACE) {
          delete normalized.namespace;
        } else {
          const mapping = forward.get(`${item.namespace}\0${item.name}`);
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

  return Object.freeze({
    forward,
    reverse,
    droppedTypes: Object.freeze([...droppedTypes].sort()),
  });
}

export function rewriteResponseFunctionCalls(value, codec) {
  if (!codec?.reverse || codec.reverse.size === 0) return value;
  const pending = [value];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    visited += 1;
    if (visited > 1_000_000) {
      throw new ToolNormalizationError("Upstream response is too structurally complex");
    }
    if (!Array.isArray(current) && current.type === "function_call") {
      const mapping = codec.reverse.get(current.name);
      if (mapping) {
        current.name = mapping.name;
        current.namespace = mapping.namespace;
      }
    }
    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
  }
  return value;
}

export const TOOL_NAMESPACE_WIRE_PREFIX = WIRE_PREFIX;
