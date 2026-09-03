import { createHash } from "node:crypto";

const CODEC_BRAND = Symbol("PickerMux efficient fidelity codec");
const WIRE_PREFIX = "mbts_";
const FALLBACK_SEARCH_DESCRIPTION =
  "Search for only the tools needed to continue the task.";
const SEARCH_RESULT_OUTPUT = "Selected tools are now available.";
const DEFAULT_LIMITS = Object.freeze({
  maxArgumentBytes: 64 * 1024,
  maxDescriptionBytes: 8 * 1024,
  // Codex permits up to 512 KiB of source listings plus its fixed discovery
  // scaffold. Keep that public protocol shape valid while retaining the
  // tighter per-tool description bound for dynamically loaded schemas.
  maxSearchDescriptionBytes: 513 * 1024,
  maxInputItems: 4_096,
  maxJsonBytes: 8 * 1024 * 1024,
  maxJsonDepth: 64,
  maxJsonNodes: 100_000,
  maxLoadedTools: 256,
  maxLoadedToolsBytes: 1024 * 1024,
  maxResponseFunctionCalls: 4_096,
  maxSearchCalls: 256,
  maxSseEvents: 65_536,
});
const TOOL_SEARCH_KEYS = new Set([
  "description",
  "execution",
  "parameters",
  "type",
]);
const FUNCTION_TOOL_KEYS = new Set([
  "defer_loading",
  "description",
  "name",
  "parameters",
  "strict",
  "type",
]);
const NAMESPACE_TOOL_KEYS = new Set([
  "description",
  "name",
  "tools",
  "type",
]);
const FUNCTION_CALL_KEYS = new Set([
  "arguments",
  "call_id",
  "id",
  "name",
  "status",
  "type",
]);
const ORDINARY_FUNCTION_CALL_KEYS = new Set([
  ...FUNCTION_CALL_KEYS,
  "namespace",
]);
const FUNCTION_ARGUMENT_DELTA_EVENT_KEYS = new Set([
  "call_id",
  "delta",
  "item_id",
  "name",
  "output_index",
  "sequence_number",
  "type",
]);
const FUNCTION_ARGUMENT_DONE_EVENT_KEYS = new Set([
  "arguments",
  "call_id",
  "item_id",
  "name",
  "output_index",
  "sequence_number",
  "type",
]);
const SEARCH_CALL_KEYS = new Set([
  "arguments",
  "call_id",
  "execution",
  "id",
  "status",
  "type",
]);
const SEARCH_OUTPUT_KEYS = new Set([
  "call_id",
  "execution",
  "id",
  "status",
  "tools",
  "type",
]);
const SEARCH_ARGUMENT_KEYS = new Set(["limit", "query"]);
const SEARCH_PARAMETER_KEYS = new Set([
  "additionalProperties",
  "properties",
  "required",
  "type",
]);
const SEARCH_PROPERTY_KEYS = new Set(["description", "type"]);
const SEARCH_LIMIT_PROPERTY_KEYS = new Set([
  "description",
  "maximum",
  "minimum",
  "type",
]);
const SEARCH_PROPERTIES = new Set(["limit", "query"]);
const PROJECT_OPTION_KEYS = new Set([
  "limits",
  "parallelToolCalls",
  "toolChoice",
]);

export class EfficientFidelityError extends Error {
  constructor(message, {
    code = "INVALID_TOOL_SEARCH",
    statusCode = 400,
  } = {}) {
    super(message);
    this.name = "EfficientFidelityError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(message, options) {
  throw new EfficientFidelityError(message, options);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function defineJsonProperty(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function normalizeLimits(options = {}) {
  if (!isPlainObject(options)) throw new TypeError("limits must be a plain object");
  const limits = { ...DEFAULT_LIMITS };
  for (const [name, value] of Object.entries(options)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) {
      throw new TypeError(`Unknown efficient fidelity limit ${name}`);
    }
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
    limits[name] = value;
  }
  return Object.freeze(limits);
}

function assertOnlyKeys(value, allowed, label, options) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains an unsupported field`, options);
  }
}

function boundedString(value, label, maxBytes, options, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(`${label} must be a bounded non-empty string`, options);
  }
  return value;
}

function boundedDescription(value, label, limits, options) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > limits.maxDescriptionBytes
  ) {
    fail(`${label} must be a bounded string`, options);
  }
  return value;
}

function cloneBoundedJson(value, limits, label, options, { maxBytes } = {}) {
  let nodes = 0;
  const visit = (current, depth) => {
    nodes += 1;
    if (nodes > limits.maxJsonNodes) {
      fail(`${label} is too structurally complex`, {
        ...options,
        code: "TOOL_SEARCH_LIMIT_EXCEEDED",
      });
    }
    if (depth > limits.maxJsonDepth) {
      fail(`${label} is nested too deeply`, {
        ...options,
        code: "TOOL_SEARCH_LIMIT_EXCEEDED",
      });
    }
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail(`${label} contains a non-finite number`, options);
      return current;
    }
    if (Array.isArray(current)) {
      return current.map((entry) => visit(entry, depth + 1));
    }
    if (!isPlainObject(current)) fail(`${label} must contain only JSON values`, options);
    const cloned = {};
    for (const [key, entry] of Object.entries(current)) {
      if (entry === undefined) fail(`${label} must contain only JSON values`, options);
      defineJsonProperty(cloned, key, visit(entry, depth + 1));
    }
    return cloned;
  };

  const cloned = visit(value, 0);
  let encoded;
  try {
    encoded = JSON.stringify(cloned);
  } catch {
    fail(`${label} is not valid JSON`, options);
  }
  const byteLimit = maxBytes ?? limits.maxJsonBytes;
  if (Buffer.byteLength(encoded, "utf8") > byteLimit) {
    fail(`${label} is too large`, {
      ...options,
      code: "TOOL_SEARCH_LIMIT_EXCEEDED",
    });
  }
  return cloned;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function inputOptions() {
  return { code: "INVALID_TOOL_SEARCH", statusCode: 400 };
}

function upstreamOptions() {
  return { code: "UPSTREAM_TOOL_SEARCH_ERROR", statusCode: 502 };
}

function isUnsupportedInvocationItemType(type) {
  return (
    typeof type === "string" &&
    type !== "function_call" &&
    type !== "function_call_output" &&
    (type.endsWith("_call") ||
      type.endsWith("_call_output") ||
      type.startsWith("mcp_"))
  );
}

function isUnsupportedInvocationSseEventType(type) {
  if (isUnsupportedInvocationItemType(type)) return true;
  if (typeof type !== "string" || !type.startsWith("response.")) return false;
  const eventName = type.slice("response.".length);
  if (eventName.startsWith("function_call_")) return false;
  return (
    /(?:^|\.)[a-z0-9_]*_call(?:[._]|$)/u.test(eventName) ||
    /(?:^|\.)mcp_(?:[a-z0-9_]+)(?:[._]|$)/u.test(eventName)
  );
}

function validateCallId(value, label, options) {
  return boundedString(value, label, 256, options);
}

function validateOptionalId(value, label, options) {
  return boundedString(value, label, 256, options, { optional: true });
}

function validateClientExecution(value, label, options) {
  if (value !== "client") {
    fail(`${label} must use client execution`, {
      ...options,
      code: "UNSUPPORTED_TOOL_SEARCH_EXECUTION",
    });
  }
}

function validateCompletedStatus(value, label, options) {
  if (value !== "completed") fail(`${label} must be completed`, options);
}

function validateCompletedOrMissingStatus(value, label, options) {
  if (value !== undefined && value !== "completed") {
    fail(`${label} must be completed when present`, options);
  }
}

function validateSuccessfulResponseEnvelope(value, label, options) {
  validateCompletedOrMissingStatus(value.status, `${label}.status`, options);
  for (const field of ["error", "incomplete_details"]) {
    if (value[field] !== undefined && value[field] !== null) {
      fail(`${label}.${field} must be null when present`, options);
    }
  }
}

function validateSearchArguments(
  value,
  limits,
  searchLimitBounds,
  label,
  options,
) {
  if (!isPlainObject(value)) {
    fail(`${label} must be a JSON object`, options);
  }
  assertOnlyKeys(value, SEARCH_ARGUMENT_KEYS, label, options);
  const cloned = cloneBoundedJson(value, limits, label, options, {
    maxBytes: limits.maxArgumentBytes,
  });
  if (
    typeof cloned.query !== "string" ||
    cloned.query.trim().length === 0
  ) {
    fail(`${label}.query must be a non-empty string`, options);
  }
  if (
    cloned.limit !== undefined &&
    (!searchLimitBounds.allowed ||
      !Number.isSafeInteger(cloned.limit) ||
      cloned.limit < searchLimitBounds.minimum ||
      cloned.limit > searchLimitBounds.maximum)
  ) {
    fail(`${label}.limit is outside the advertised search bounds`, options);
  }
  return cloned;
}

function validateFunctionArgumentsObject(value, limits, label, options) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > limits.maxArgumentBytes
  ) {
    fail(`${label} must be a bounded JSON string`, options);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(`${label} must contain valid JSON`, options);
  }
  if (!isPlainObject(parsed)) {
    fail(`${label} must contain a JSON object`, options);
  }
  return value;
}

function validateSearchPropertyDescription(value, label, limits, options) {
  boundedDescription(
    value,
    `${label}.description`,
    { ...limits, maxDescriptionBytes: limits.maxSearchDescriptionBytes },
    options,
  );
}

function validatePublicToolSearchParameters(value, limits, options) {
  if (!isPlainObject(value)) {
    fail("tool_search.parameters must be a JSON object", options);
  }
  const parameters = cloneBoundedJson(
    value,
    limits,
    "tool_search.parameters",
    options,
  );
  assertOnlyKeys(
    parameters,
    SEARCH_PARAMETER_KEYS,
    "tool_search.parameters",
    options,
  );
  if (
    parameters.type !== "object" ||
    !isPlainObject(parameters.properties) ||
    parameters.additionalProperties !== false ||
    !Array.isArray(parameters.required) ||
    parameters.required.length !== 1 ||
    parameters.required[0] !== "query"
  ) {
    fail("tool_search.parameters has an unsupported search schema", options);
  }
  assertOnlyKeys(
    parameters.properties,
    SEARCH_PROPERTIES,
    "tool_search.parameters.properties",
    options,
  );
  const query = parameters.properties.query;
  if (!isPlainObject(query)) {
    fail("tool_search.parameters.properties.query must be a JSON object", options);
  }
  assertOnlyKeys(
    query,
    SEARCH_PROPERTY_KEYS,
    "tool_search.parameters.properties.query",
    options,
  );
  if (query.type !== "string") {
    fail("tool_search query must use the string schema", options);
  }
  validateSearchPropertyDescription(
    query.description,
    "tool_search.parameters.properties.query",
    limits,
    options,
  );

  const limit = parameters.properties.limit;
  if (limit !== undefined) {
    if (!isPlainObject(limit)) {
      fail("tool_search.parameters.properties.limit must be a JSON object", options);
    }
    assertOnlyKeys(
      limit,
      SEARCH_LIMIT_PROPERTY_KEYS,
      "tool_search.parameters.properties.limit",
      options,
    );
    if (limit.type !== "number" && limit.type !== "integer") {
      fail("tool_search limit must use a numeric schema", options);
    }
    validateSearchPropertyDescription(
      limit.description,
      "tool_search.parameters.properties.limit",
      limits,
      options,
    );
    for (const field of ["minimum", "maximum"]) {
      if (
        limit[field] !== undefined &&
        (!Number.isSafeInteger(limit[field]) ||
          limit[field] < 1 ||
          limit[field] > limits.maxLoadedTools)
      ) {
        fail(`tool_search limit ${field} is unsupported`, options);
      }
    }
    if (
      limit.minimum !== undefined &&
      limit.maximum !== undefined &&
      limit.maximum < limit.minimum
    ) {
      fail("tool_search limit bounds are inconsistent", options);
    }
  }
  return parameters;
}

function validateLoadedFunction(tool, limits, state, label, options) {
  assertOnlyKeys(tool, FUNCTION_TOOL_KEYS, label, options);
  const name = boundedString(tool.name, `${label}.name`, 256, options);
  if (name.startsWith(WIRE_PREFIX)) {
    fail(`${label}.name uses PickerMux's reserved tool-search namespace`, options);
  }
  boundedDescription(tool.description, `${label}.description`, limits, options);
  if (tool.strict !== undefined && typeof tool.strict !== "boolean") {
    fail(`${label}.strict must be a boolean`, options);
  }
  if (
    tool.defer_loading !== undefined &&
    typeof tool.defer_loading !== "boolean"
  ) {
    fail(`${label}.defer_loading must be a boolean`, options);
  }
  if (tool.parameters !== undefined && !isPlainObject(tool.parameters)) {
    fail(`${label}.parameters must be a JSON object`, options);
  }
  if (tool.parameters !== undefined) {
    cloneBoundedJson(tool.parameters, limits, `${label}.parameters`, options, {
      maxBytes: limits.maxLoadedToolsBytes,
    });
  }
  state.count += 1;
  if (state.count > limits.maxLoadedTools) {
    fail("tool_search_output contains too many tools", {
      ...options,
      code: "TOOL_SEARCH_LIMIT_EXCEEDED",
    });
  }
}

function validateLoadedTool(tool, limits, state, label, options) {
  if (!isPlainObject(tool)) fail(`${label} must be a JSON object`, options);
  if (tool.type === "function") {
    validateLoadedFunction(tool, limits, state, label, options);
    return;
  }
  if (tool.type === "namespace") {
    assertOnlyKeys(tool, NAMESPACE_TOOL_KEYS, label, options);
    boundedString(tool.name, `${label}.name`, 256, options);
    boundedDescription(tool.description, `${label}.description`, limits, options);
    if (!Array.isArray(tool.tools)) fail(`${label}.tools must be an array`, options);
    for (const [index, nested] of tool.tools.entries()) {
      if (!isPlainObject(nested) || nested.type !== "function") {
        fail(`${label}.tools[${index}] must be a function tool`, options);
      }
      validateLoadedFunction(
        nested,
        limits,
        state,
        `${label}.tools[${index}]`,
        options,
      );
    }
    return;
  }
  fail(`${label} contains an unsupported loaded tool type`, {
    ...options,
    code: "UNSUPPORTED_LOADED_TOOL_TYPE",
  });
}

function validateLoadedTools(value, limits, label, options) {
  if (!Array.isArray(value)) fail(`${label} must be an array`, options);
  if (value.length > limits.maxLoadedTools) {
    fail("tool_search_output contains too many tools", {
      ...options,
      code: "TOOL_SEARCH_LIMIT_EXCEEDED",
    });
  }
  const cloned = cloneBoundedJson(value, limits, label, options, {
    maxBytes: limits.maxLoadedToolsBytes,
  });
  const state = { count: 0 };
  for (const [index, tool] of cloned.entries()) {
    validateLoadedTool(tool, limits, state, `${label}[${index}]`, options);
  }
  return { count: state.count, tools: cloned };
}

function activateLoadedTool(tool) {
  if (tool.type === "function") {
    const activated = { ...tool };
    delete activated.defer_loading;
    return activated;
  }
  return {
    ...tool,
    tools: tool.tools.map(activateLoadedTool),
  };
}

function deduplicateLoadedTools(tools, projectedToolKeys) {
  const projected = new Set(projectedToolKeys);
  const definitions = new Map();
  const deduplicated = [];

  const includeFunction = (key, tool) => {
    if (projected.has(key)) {
      fail("Tool-search input conflicts with an already projected function", inputOptions());
    }
    const encoded = canonicalJson(tool);
    const prior = definitions.get(key);
    if (prior !== undefined) {
      if (prior !== encoded) {
        fail("Tool-search input changes a previously loaded function", inputOptions());
      }
      return false;
    }
    definitions.set(key, encoded);
    return true;
  };

  for (const tool of tools) {
    if (tool.type === "function") {
      if (includeFunction(`wire:${tool.name}`, tool)) deduplicated.push(tool);
      continue;
    }
    const nested = tool.tools.filter((functionTool) => {
      const key = tool.name === "functions"
        ? `wire:${functionTool.name}`
        : `namespace:${tool.name}\0${functionTool.name}`;
      return includeFunction(key, functionTool);
    });
    if (nested.length > 0) deduplicated.push({ ...tool, tools: nested });
  }
  return deduplicated;
}

function collectProjectedToolKeys(tools) {
  const keys = [];
  for (const tool of tools) {
    if (!isPlainObject(tool)) continue;
    if (tool.type === "function") {
      if (typeof tool.name === "string") keys.push(`wire:${tool.name}`);
      continue;
    }
    if (tool.type !== "namespace" || !Array.isArray(tool.tools)) continue;
    for (const nested of tool.tools) {
      if (!isPlainObject(nested) || nested.type !== "function") continue;
      if (typeof nested.name !== "string" || typeof tool.name !== "string") {
        continue;
      }
      keys.push(
        tool.name === "functions"
          ? `wire:${nested.name}`
          : `namespace:${tool.name}\0${nested.name}`,
      );
    }
  }
  return keys;
}

function validatePublicToolSearch(tool, limits) {
  const options = inputOptions();
  assertOnlyKeys(tool, TOOL_SEARCH_KEYS, "tool_search", options);
  validateClientExecution(tool.execution, "tool_search", options);
  const description = boundedDescription(
    tool.description,
    "tool_search.description",
    { ...limits, maxDescriptionBytes: limits.maxSearchDescriptionBytes },
    options,
  );
  const parameters = validatePublicToolSearchParameters(
    tool.parameters,
    limits,
    options,
  );
  return {
    type: "tool_search",
    execution: "client",
    ...(description === undefined ? {} : { description }),
    parameters,
  };
}

function collectOccupiedNames(tools) {
  const occupied = new Set();
  for (const tool of tools) {
    if (!isPlainObject(tool)) continue;
    if (tool.type === "function" && typeof tool.name === "string") {
      occupied.add(tool.name);
    }
    if (tool.type === "namespace" && tool.name === "functions" && Array.isArray(tool.tools)) {
      for (const nested of tool.tools) {
        if (isPlainObject(nested) && typeof nested.name === "string") {
          occupied.add(nested.name);
        }
      }
    }
  }
  return occupied;
}

function projectInitialTool(tool, label) {
  if (!isPlainObject(tool)) return tool;
  if (tool.type === "function") {
    if (
      tool.defer_loading !== undefined &&
      typeof tool.defer_loading !== "boolean"
    ) {
      fail(`${label}.defer_loading must be a boolean`, inputOptions());
    }
    if (tool.defer_loading === true) return null;
    if (!Object.hasOwn(tool, "defer_loading")) return tool;
    const projected = { ...tool };
    delete projected.defer_loading;
    return projected;
  }
  if (tool.type === "namespace" && Array.isArray(tool.tools)) {
    const nested = tool.tools
      .map((entry, index) => projectInitialTool(entry, `${label}.tools[${index}]`))
      .filter((candidate) => candidate !== null);
    if (nested.length === 0) return null;
    return { ...tool, tools: nested };
  }
  return tool;
}

function allocateWireName(tool, occupied) {
  const source = canonicalJson(tool);
  for (let salt = 0; salt < 64; salt += 1) {
    const digest = createHash("sha256")
      .update(`${source}\0${salt}`)
      .digest("hex")
      .slice(0, 56);
    const candidate = `${WIRE_PREFIX}${digest}`;
    if (!occupied.has(candidate)) return candidate;
  }
  fail("Could not allocate a unique tool-search function name", inputOptions());
}

function assertCodec(codec) {
  if (!codec || codec[CODEC_BRAND] !== true) {
    throw new TypeError("A PickerMux efficient fidelity codec is required");
  }
}

/**
 * Replace exactly one public client-executed tool_search definition with one
 * request-local function definition that LM Studio can call directly.
 */
export function projectClientToolSearch(tools, options) {
  if (!Array.isArray(tools)) throw new TypeError("tools must be an array");
  if (!isPlainObject(options)) {
    throw new TypeError("efficient fidelity projection options are required");
  }
  assertOnlyKeys(options, PROJECT_OPTION_KEYS, "projection options", inputOptions());
  if (options.toolChoice !== "auto") {
    fail("Efficient fidelity requires tool_choice auto", {
      ...inputOptions(),
      code: "UNSUPPORTED_TOOL_CHOICE",
    });
  }
  if (
    options.parallelToolCalls !== undefined &&
    typeof options.parallelToolCalls !== "boolean"
  ) {
    fail("parallel_tool_calls must be a boolean when present", inputOptions());
  }
  const limitOptions = options.limits;
  const limits = normalizeLimits(limitOptions);
  let searchIndex = -1;
  let searchTool;
  for (const [index, tool] of tools.entries()) {
    if (!isPlainObject(tool)) {
      fail(`tools[${index}] must be a JSON object`, inputOptions());
    }
    if (typeof tool.type === "string" && tool.type.startsWith("tool_search")) {
      if (tool.type !== "tool_search") {
        fail(`tools[${index}] has an unknown tool-search type`, inputOptions());
      }
      if (searchIndex !== -1) {
        fail("Exactly one client tool_search tool is required", inputOptions());
      }
      searchIndex = index;
      searchTool = validatePublicToolSearch(tool, limits);
    }
  }
  if (searchIndex === -1) {
    fail("Exactly one client tool_search tool is required", inputOptions());
  }

  const occupied = collectOccupiedNames(tools);
  const wireName = allocateWireName(searchTool, occupied);
  const syntheticTool = {
    type: "function",
    name: wireName,
    description: searchTool.description ?? FALLBACK_SEARCH_DESCRIPTION,
    parameters: searchTool.parameters,
  };
  const projected = tools
    .map((tool, index) =>
      index === searchIndex
        ? syntheticTool
        : projectInitialTool(tool, `tools[${index}]`)
    )
    .filter((tool) => tool !== null);
  const projectedToolKeys = collectProjectedToolKeys(
    projected.filter((tool) => tool !== syntheticTool),
  );
  const projectedNames = collectOccupiedNames(projected);
  const advertisedLimit = searchTool.parameters.properties.limit;
  const codec = {
    [CODEC_BRAND]: true,
    schemaVersion: 1,
    wireName,
    occupiedWireNames: Object.freeze(
      [...projectedNames].filter(
        (name) => name.startsWith(WIRE_PREFIX) && name !== wireName,
      ),
    ),
    projectedToolKeys: Object.freeze(projectedToolKeys),
    reservedCallIds: new Set(),
    reservedItemIds: new Set(),
    searchLimitBounds: Object.freeze({
      allowed: advertisedLimit !== undefined,
      minimum: advertisedLimit?.minimum ?? 1,
      maximum: advertisedLimit?.maximum ?? limits.maxLoadedTools,
    }),
    maxAuthorizedCalls: options.parallelToolCalls === false
      ? 1
      : limits.maxResponseFunctionCalls,
    limits,
  };
  Object.freeze(codec);
  return Object.freeze({
    codec,
    tools: projected,
  });
}

function parseSyntheticArguments(value, codec) {
  const options = upstreamOptions();
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > codec.limits.maxArgumentBytes
  ) {
    fail("Synthetic tool-search arguments are invalid or too large", options);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("Synthetic tool-search arguments are not valid JSON", options);
  }
  if (!isPlainObject(parsed)) {
    fail("Synthetic tool-search arguments must be a JSON object", options);
  }
  return validateSearchArguments(
    parsed,
    codec.limits,
    codec.searchLimitBounds,
    "Synthetic tool-search arguments",
    options,
  );
}

function mapSyntheticResponseItem(item, codec, searchCallIds, callId) {
  const options = upstreamOptions();
  assertOnlyKeys(item, FUNCTION_CALL_KEYS, "Synthetic function_call", options);
  if (item.status !== undefined && item.status !== "completed") {
    fail("Synthetic function_call must be completed", options);
  }
  const id = validateOptionalId(item.id, "Synthetic function_call.id", options);
  const argumentsValue = parseSyntheticArguments(item.arguments, codec);
  if (searchCallIds.size >= codec.limits.maxSearchCalls) {
    fail("LM Studio returned too many tool-search calls", {
      ...options,
      code: "TOOL_SEARCH_LIMIT_EXCEEDED",
    });
  }
  searchCallIds.add(callId);
  return {
    ...(id === undefined ? {} : { id }),
    type: "tool_search_call",
    execution: "client",
    call_id: callId,
    status: "completed",
    arguments: argumentsValue,
  };
}

function mapResponseOutputItem(item, codec, state, label) {
  const options = upstreamOptions();
  if (!isPlainObject(item)) {
    fail(`${label} must be a JSON object`, options);
  }
  if (typeof item.type === "string" && item.type.startsWith("tool_search")) {
    fail("LM Studio returned an unsupported native tool-search item", options);
  }
  if (isUnsupportedInvocationItemType(item.type)) {
    fail("LM Studio returned an unadvertised invocation item", options);
  }
  if (item.type !== "function_call") return item;
  validateCompletedOrMissingStatus(item.status, `${label}.status`, options);
  const name = boundedString(item.name, `${label}.name`, 256, options);
  boundedString(item.namespace, `${label}.namespace`, 256, options, {
    optional: true,
  });
  const itemId = validateOptionalId(item.id, `${label}.id`, options);
  assertOnlyKeys(
    item,
    name === codec.wireName ? FUNCTION_CALL_KEYS : ORDINARY_FUNCTION_CALL_KEYS,
    label,
    options,
  );
  const callId = validateCallId(item.call_id, `${label}.call_id`, options);
  if (codec.reservedCallIds.has(callId)) {
    fail("LM Studio reused a historical function call id", options);
  }
  if (itemId !== undefined && codec.reservedItemIds.has(itemId)) {
    fail("LM Studio reused a historical function item id", options);
  }
  if (itemId !== undefined && state.allItemIds.has(itemId)) {
    fail("LM Studio returned a duplicate function item id", options);
  }
  if (name !== codec.wireName) {
    validateFunctionArgumentsObject(
      item.arguments,
      codec.limits,
      `${label}.arguments`,
      options,
    );
  }
  if (state.allCallIds.has(callId)) {
    fail("LM Studio returned a duplicate function call id", options);
  }
  if (state.allCallIds.size >= codec.maxAuthorizedCalls) {
    fail("LM Studio returned too many function calls", {
      ...options,
      code: "TOOL_SEARCH_LIMIT_EXCEEDED",
    });
  }
  state.allCallIds.add(callId);
  if (itemId !== undefined) state.allItemIds.add(itemId);
  if (item.name === codec.wireName) {
    return mapSyntheticResponseItem(item, codec, state.searchCallIds, callId);
  }
  if (
    typeof item.name === "string" &&
    item.name.startsWith(WIRE_PREFIX) &&
    !codec.occupiedWireNames.includes(item.name)
  ) {
    fail("LM Studio returned an unknown synthetic tool-search function", options);
  }
  return item;
}

/**
 * Convert complete synthetic function calls in a JSON response's output array
 * back to public client-executed tool_search_call items. Other object paths are
 * opaque so response metadata can never manufacture an authorized call id.
 */
export function rewriteClientToolSearchResponse(value, codec) {
  assertCodec(codec);
  const options = upstreamOptions();
  if (!isPlainObject(value)) {
    fail("Upstream response must be a JSON object", options);
  }
  const cloned = cloneBoundedJson(
    value,
    codec.limits,
    "Upstream tool-search response",
    options,
  );
  validateSuccessfulResponseEnvelope(cloned, "Upstream response", options);
  if (!Array.isArray(cloned.output)) {
    fail("Upstream response.output must be an array", options);
  }
  const state = {
    allCallIds: new Set(),
    allItemIds: new Set(),
    searchCallIds: new Set(),
  };
  const output = cloned.output.map((item, index) =>
    mapResponseOutputItem(item, codec, state, `response.output[${index}]`)
  );
  const rewritten = { ...cloned, output };
  return Object.freeze({
    allCallIds: Object.freeze([...state.allCallIds]),
    callIds: Object.freeze([...state.searchCallIds]),
    value: rewritten,
  });
}

function mapPublicSearchCall(item, codec) {
  const options = inputOptions();
  assertOnlyKeys(item, SEARCH_CALL_KEYS, "tool_search_call", options);
  validateClientExecution(item.execution, "tool_search_call", options);
  validateCompletedOrMissingStatus(item.status, "tool_search_call", options);
  const callId = validateCallId(item.call_id, "tool_search_call.call_id", options);
  const id = validateOptionalId(item.id, "tool_search_call.id", options);
  const argumentsValue = validateSearchArguments(
    item.arguments,
    codec.limits,
    codec.searchLimitBounds,
    "tool_search_call.arguments",
    options,
  );
  return {
    callId,
    item: {
      ...(id === undefined ? {} : { id }),
      type: "function_call",
      name: codec.wireName,
      call_id: callId,
      arguments: JSON.stringify(argumentsValue),
      status: "completed",
    },
  };
}

function mapPublicSearchOutput(item, codec) {
  const options = inputOptions();
  assertOnlyKeys(item, SEARCH_OUTPUT_KEYS, "tool_search_output", options);
  validateClientExecution(item.execution, "tool_search_output", options);
  validateCompletedStatus(item.status, "tool_search_output", options);
  const callId = validateCallId(item.call_id, "tool_search_output.call_id", options);
  const id = validateOptionalId(item.id, "tool_search_output.id", options);
  const loaded = validateLoadedTools(
    item.tools,
    codec.limits,
    "tool_search_output.tools",
    options,
  );
  const loadedTools = loaded.tools.map(activateLoadedTool);
  return {
    callId,
    item: {
      ...(id === undefined ? {} : { id }),
      type: "function_call_output",
      call_id: callId,
      output: SEARCH_RESULT_OUTPUT,
    },
    loadedBytes: Buffer.byteLength(JSON.stringify(loaded.tools), "utf8"),
    toolCount: loaded.count,
    loadedTools,
  };
}

/**
 * Translate public client tool-search history into LM-compatible function call
 * history. Every output must follow its matching call in this same input; the
 * codec deliberately carries no cross-request authorization state.
 */
export function rewriteClientToolSearchInput(input, codec) {
  assertCodec(codec);
  if (!Array.isArray(input)) throw new TypeError("input must be an array");
  if (input.length > codec.limits.maxInputItems) {
    fail("Tool-search input contains too many items", {
      ...inputOptions(),
      code: "TOOL_SEARCH_LIMIT_EXCEEDED",
    });
  }
  const callsInInput = new Map();
  const completedOutputs = new Set();
  const ordinaryCallIds = new Set();
  let loadedToolBytes = 0;
  let loadedToolCount = 0;
  const loadedTools = [];
  const rewritten = [];
  const historicalCallIds = new Set(codec.reservedCallIds);
  const historicalItemIds = new Set(codec.reservedItemIds);

  const reserveHistoryIds = (item, label) => {
    if (typeof item.call_id === "string") {
      historicalCallIds.add(
        validateCallId(item.call_id, `${label}.call_id`, inputOptions()),
      );
    }
    if (item.id !== undefined) {
      historicalItemIds.add(
        validateOptionalId(item.id, `${label}.id`, inputOptions()),
      );
    }
  };

  for (const [index, item] of input.entries()) {
    if (!isPlainObject(item)) {
      rewritten.push(item);
      continue;
    }
    if (item.type === "additional_tools") {
      fail(
        `input[${index}] contains an unsupported secondary tool inventory`,
        inputOptions(),
      );
    }
    if (item.type === "tool_search_call") {
      const mapped = mapPublicSearchCall(item, codec);
      reserveHistoryIds(item, `input[${index}]`);
      if (ordinaryCallIds.has(mapped.callId)) {
        fail(`input[${index}] reuses another function's call id`, inputOptions());
      }
      const prior = callsInInput.get(mapped.callId);
      if (prior !== undefined) {
        fail(`input[${index}] repeats a tool_search_call`, inputOptions());
      }
      if (callsInInput.size >= codec.limits.maxSearchCalls) {
        fail("Too many tool-search calls in input", {
          ...inputOptions(),
          code: "TOOL_SEARCH_LIMIT_EXCEEDED",
        });
      }
      callsInInput.set(mapped.callId, mapped.item.arguments);
      rewritten.push(mapped.item);
      continue;
    }
    if (item.type === "tool_search_output") {
      const mapped = mapPublicSearchOutput(item, codec);
      reserveHistoryIds(item, `input[${index}]`);
      if (ordinaryCallIds.has(mapped.callId)) {
        fail(`input[${index}] reuses another function's call id`, inputOptions());
      }
      if (!callsInInput.has(mapped.callId)) {
        fail(`input[${index}] references an unknown tool-search call`, {
          ...inputOptions(),
          code: "UNKNOWN_TOOL_SEARCH_CALL",
        });
      }
      if (completedOutputs.has(mapped.callId)) {
        fail(`input[${index}] repeats a tool-search output`, inputOptions());
      }
      completedOutputs.add(mapped.callId);
      loadedToolBytes += mapped.loadedBytes;
      if (loadedToolBytes > codec.limits.maxLoadedToolsBytes) {
        fail("Tool-search input loads too much tool data", {
          ...inputOptions(),
          code: "TOOL_SEARCH_LIMIT_EXCEEDED",
        });
      }
      loadedToolCount += mapped.toolCount;
      loadedTools.push(...mapped.loadedTools);
      rewritten.push(mapped.item);
      continue;
    }
    if (typeof item.type === "string" && item.type.startsWith("tool_search")) {
      fail(`input[${index}] has an unknown tool-search item type`, inputOptions());
    }
    if (isUnsupportedInvocationItemType(item.type)) {
      fail(
        `input[${index}] contains an unsupported invocation history item`,
        {
          ...inputOptions(),
          code: "UNSUPPORTED_TOOL_TYPE",
        },
      );
    }
    if (
      item.type === "function_call" &&
      typeof item.name === "string" &&
      item.name.startsWith(WIRE_PREFIX) &&
      !codec.occupiedWireNames.includes(item.name)
    ) {
      fail(`input[${index}] contains a private synthetic tool-search call`, inputOptions());
    }
    if (item.type === "function_call" || item.type === "function_call_output") {
      reserveHistoryIds(item, `input[${index}]`);
    }
    if (
      (item.type === "function_call" || item.type === "function_call_output") &&
      typeof item.call_id === "string"
    ) {
      if (
        callsInInput.has(item.call_id) ||
        completedOutputs.has(item.call_id)
      ) {
        fail(`input[${index}] reuses a tool-search call id`, inputOptions());
      }
      ordinaryCallIds.add(item.call_id);
    }
    rewritten.push(item);
  }

  for (const callId of callsInInput.keys()) {
    if (!completedOutputs.has(callId)) {
      fail("A tool_search_call in input has no matching tool_search_output", {
        ...inputOptions(),
        code: "MISSING_TOOL_SEARCH_OUTPUT",
      });
    }
  }
  if (loadedToolCount > codec.limits.maxLoadedTools) {
    fail("Tool-search input loads too many tools", {
      ...inputOptions(),
      code: "TOOL_SEARCH_LIMIT_EXCEEDED",
    });
  }
  const deduplicatedLoadedTools = deduplicateLoadedTools(
    loadedTools,
    codec.projectedToolKeys,
  );
  for (const callId of historicalCallIds) codec.reservedCallIds.add(callId);
  for (const itemId of historicalItemIds) codec.reservedItemIds.add(itemId);
  return Object.freeze({
    input: rewritten,
    loadedTools: deduplicatedLoadedTools,
  });
}

function emptySseResult() {
  return Object.freeze({
    callIds: Object.freeze([]),
    events: Object.freeze([]),
    streamEntries: Object.freeze([]),
  });
}

function sseEventEntry(event, frame) {
  return Object.freeze({ kind: "event", event, frame });
}

function sseRawEntry(raw) {
  return Object.freeze({ kind: "raw", raw });
}

function sseResult(streamEntries, callIds = []) {
  const entries = Object.freeze([...streamEntries]);
  return Object.freeze({
    callIds: Object.freeze([...callIds]),
    events: Object.freeze(
      entries
        .filter((entry) => entry.kind === "event")
        .map((entry) => entry.event),
    ),
    streamEntries: entries,
  });
}

function streamLocator(event, item, options) {
  const eventItemId = event.item_id;
  const embeddedItemId = item?.id;
  if (eventItemId !== undefined) {
    validateOptionalId(eventItemId, "SSE event item id", options);
  }
  if (embeddedItemId !== undefined) {
    validateOptionalId(embeddedItemId, "SSE embedded item id", options);
  }
  if (
    eventItemId !== undefined &&
    embeddedItemId !== undefined &&
    eventItemId !== embeddedItemId
  ) {
    fail("SSE event and embedded function item ids do not match", options);
  }
  const itemId = eventItemId ?? embeddedItemId;
  const outputIndex = event.output_index;
  if (
    outputIndex !== undefined &&
    (!Number.isSafeInteger(outputIndex) || outputIndex < 0)
  ) {
    fail("SSE output_index must be a non-negative safe integer", options);
  }
  if (itemId === undefined && outputIndex === undefined) {
    fail("Synthetic SSE function call has no stable item identity", options);
  }
  return { itemId, outputIndex };
}

function sameLocator(left, right) {
  let matched = false;
  if (left.itemId !== undefined && right.itemId !== undefined) {
    if (left.itemId !== right.itemId) return false;
    matched = true;
  }
  if (left.outputIndex !== undefined && right.outputIndex !== undefined) {
    if (left.outputIndex !== right.outputIndex) return false;
    matched = true;
  }
  return matched;
}

function conflictingLocator(left, right) {
  const sameItem =
    left.itemId !== undefined &&
    right.itemId !== undefined &&
    left.itemId === right.itemId;
  const sameIndex =
    left.outputIndex !== undefined &&
    right.outputIndex !== undefined &&
    left.outputIndex === right.outputIndex;
  const differentItem =
    left.itemId !== undefined &&
    right.itemId !== undefined &&
    left.itemId !== right.itemId;
  const differentIndex =
    left.outputIndex !== undefined &&
    right.outputIndex !== undefined &&
    left.outputIndex !== right.outputIndex;
  return (sameItem && differentIndex) || (sameIndex && differentItem);
}

function validateArgumentEventAuthority(event, tracked, options) {
  const delta = event.type.endsWith(".delta");
  assertOnlyKeys(
    event,
    delta
      ? FUNCTION_ARGUMENT_DELTA_EVENT_KEYS
      : FUNCTION_ARGUMENT_DONE_EVENT_KEYS,
    "SSE function argument event",
    options,
  );
  if (
    event.sequence_number !== undefined &&
    (!Number.isSafeInteger(event.sequence_number) || event.sequence_number < 0)
  ) {
    fail("SSE function argument sequence_number is invalid", options);
  }
  if (event.call_id !== undefined) {
    const callId = validateCallId(
      event.call_id,
      "SSE function argument call_id",
      options,
    );
    if (tracked.callId === undefined || callId !== tracked.callId) {
      fail("SSE function argument call_id changed identity", options);
    }
  }
  if (event.name !== undefined) {
    const name = boundedString(
      event.name,
      "SSE function argument name",
      256,
      options,
    );
    if (name !== tracked.name) {
      fail("SSE function argument name changed identity", options);
    }
  }
}

/**
 * Reuse the fail-closed ordinary Function lifecycle for Direct/Namespace
 * routes that do not carry a client Tool Search projection.
 */
function functionCallAuthorityCodec({
  allowedWireNames = new Set(),
  limits: limitOptions,
  maxAuthorizedCalls,
  reservedCallIds = new Set(),
  reservedItemIds = new Set(),
} = {}) {
  if (
    !(allowedWireNames instanceof Set) ||
    !(reservedCallIds instanceof Set) ||
    !(reservedItemIds instanceof Set)
  ) {
    throw new TypeError("Function-call SSE policy sets are invalid");
  }
  const limits = normalizeLimits(limitOptions);
  const authorizedCalls = maxAuthorizedCalls ?? limits.maxResponseFunctionCalls;
  if (
    !Number.isSafeInteger(authorizedCalls) ||
    authorizedCalls < 0 ||
    authorizedCalls > limits.maxResponseFunctionCalls
  ) {
    throw new TypeError("maxAuthorizedCalls is invalid");
  }
  return Object.freeze({
    [CODEC_BRAND]: true,
    schemaVersion: 1,
    // null cannot collide with a validated public Function name, so the
    // Tool-Search-specific branch is unreachable for this policy.
    wireName: null,
    occupiedWireNames: Object.freeze(
      [...allowedWireNames].filter(
        (name) => typeof name === "string" && name.startsWith(WIRE_PREFIX),
      ),
    ),
    projectedToolKeys: Object.freeze([]),
    reservedCallIds: new Set(reservedCallIds),
    reservedItemIds: new Set(reservedItemIds),
    searchLimitBounds: Object.freeze({
      allowed: false,
      minimum: 1,
      maximum: limits.maxLoadedTools,
    }),
    maxAuthorizedCalls: authorizedCalls,
    limits,
  });
}

export function rewriteFunctionCallResponse(value, policy) {
  if (
    !Array.isArray(value?.output) ||
    !value.output.some((item) => isPlainObject(item) && item.type === "function_call")
  ) {
    return value;
  }
  return rewriteClientToolSearchResponse(
    value,
    functionCallAuthorityCodec(policy),
  ).value;
}

export function createFunctionCallSseRewriter(policy) {
  return createClientToolSearchSseRewriter(
    functionCallAuthorityCodec(policy),
  );
}

/**
 * Adapt parsed SSE events without exposing LM Studio's synthetic function. The
 * incomplete added/argument events are retained only in this stream-local
 * object and suppressed; the complete output_item.done is emitted publicly.
 */
export function createClientToolSearchSseRewriter(codec) {
  assertCodec(codec);
  const options = upstreamOptions();
  const pending = [];
  const ordinaryPending = [];
  const emittedFunctionCalls = new Map();
  const emittedSearchCalls = new Map();
  const emittedCallIds = new Set();
  const emittedFunctionCallSequence = [];
  const emittedOutputIndexes = new Set();
  const emittedItemIds = new Set();
  const nonFunctionOutputIndexes = new Set();
  const nonFunctionItemIds = new Set();
  const heldStreamEntries = [];
  let heldStreamBytes = 0;
  let closed = false;
  let doneMarkerSeen = false;
  let terminalSeen = false;
  let observedSseFrames = 0;

  const observeSseFrame = () => {
    observedSseFrames += 1;
    if (observedSseFrames > codec.limits.maxSseEvents) {
      fail("Upstream SSE contains too many events", {
        ...options,
        code: "TOOL_SEARCH_LIMIT_EXCEEDED",
      });
    }
  };

  const assertFunctionCallCapacity = () => {
    if (
      pending.length + ordinaryPending.length + emittedCallIds.size >=
      codec.maxAuthorizedCalls
    ) {
      fail("Upstream SSE contains too many function calls", {
        ...options,
        code: "TOOL_SEARCH_LIMIT_EXCEEDED",
      });
    }
  };

  const clearHeldStream = () => {
    heldStreamEntries.length = 0;
    heldStreamBytes = 0;
  };

  const discardUncommittedCalls = () => {
    pending.length = 0;
    ordinaryPending.length = 0;
    emittedFunctionCalls.clear();
    emittedSearchCalls.clear();
    emittedCallIds.clear();
    emittedFunctionCallSequence.length = 0;
    emittedOutputIndexes.clear();
    emittedItemIds.clear();
    nonFunctionOutputIndexes.clear();
    nonFunctionItemIds.clear();
    clearHeldStream();
  };

  const holdStreamEntry = (entry) => {
    if (heldStreamEntries.length >= codec.limits.maxSseEvents) {
      fail("Upstream SSE contains too many deferred events", {
        ...options,
        code: "TOOL_SEARCH_LIMIT_EXCEEDED",
      });
    }
    const entryBytes = entry.kind === "raw"
      ? Buffer.byteLength(entry.raw, "utf8") + 2
      : Buffer.byteLength(canonicalJson(entry.event), "utf8") +
        (Number.isSafeInteger(entry.frame?.framingBytes)
          && entry.frame.framingBytes > 0
          ? entry.frame.framingBytes
          : 0) +
        2;
    heldStreamBytes += entryBytes;
    if (heldStreamBytes > codec.limits.maxJsonBytes) {
      fail("Upstream SSE contains too much deferred stream data", {
        ...options,
        code: "TOOL_SEARCH_LIMIT_EXCEEDED",
      });
    }
    heldStreamEntries.push(entry);
    return emptySseResult();
  };

  const holdFunctionDone = (event, frame) =>
    holdStreamEntry(sseEventEntry(event, frame));

  const emitOrHoldEvent = (event, frame) =>
    heldStreamEntries.length > 0
      ? holdStreamEntry(sseEventEntry(event, frame))
      : sseResult([sseEventEntry(event, frame)]);

  const recordNonFunctionOutputIndex = (event) => {
    const eventItemId = validateOptionalId(
      event.item_id,
      "SSE non-function event item id",
      options,
    );
    const embeddedItemId = validateOptionalId(
      event.item?.id,
      "SSE non-function embedded item id",
      options,
    );
    if (
      eventItemId !== undefined &&
      embeddedItemId !== undefined &&
      eventItemId !== embeddedItemId
    ) {
      fail("SSE non-function event and embedded item ids do not match", options);
    }
    const itemId = eventItemId ?? embeddedItemId;
    if (
      itemId !== undefined &&
      (emittedItemIds.has(itemId) ||
        pending.some((candidate) => candidate.itemId === itemId) ||
        ordinaryPending.some((candidate) => candidate.itemId === itemId))
    ) {
      fail("SSE non-function item reused a function item id", options);
    }
    if (
      itemId !== undefined &&
      !nonFunctionItemIds.has(itemId) &&
      nonFunctionItemIds.size >= codec.limits.maxSseEvents
    ) {
      fail("Upstream SSE contains too many item locators", {
        ...options,
        code: "TOOL_SEARCH_LIMIT_EXCEEDED",
      });
    }
    if (itemId !== undefined) nonFunctionItemIds.add(itemId);

    const outputIndex = event.output_index;
    if (outputIndex === undefined) return;
    if (!Number.isSafeInteger(outputIndex) || outputIndex < 0) {
      fail("SSE output_index must be a non-negative safe integer", options);
    }
    if (
      emittedOutputIndexes.has(outputIndex) ||
      pending.some((candidate) => candidate.outputIndex === outputIndex) ||
      ordinaryPending.some((candidate) => candidate.outputIndex === outputIndex)
    ) {
      fail("SSE non-function item reused a function output_index", options);
    }
    if (
      !nonFunctionOutputIndexes.has(outputIndex) &&
      nonFunctionOutputIndexes.size >= codec.limits.maxSseEvents
    ) {
      fail("Upstream SSE contains too many output locators", {
        ...options,
        code: "TOOL_SEARCH_LIMIT_EXCEEDED",
      });
    }
    nonFunctionOutputIndexes.add(outputIndex);
  };

  const recordCompletedFunctionCall = (event, item, callId) => {
    const locator = streamLocator(event, item, options);
    const outputIndex = event.output_index;
    if (
      !Number.isSafeInteger(outputIndex) ||
      outputIndex < 0 ||
      emittedOutputIndexes.has(outputIndex)
    ) {
      fail("SSE function call has an invalid or duplicate output_index", options);
    }
    if (nonFunctionOutputIndexes.has(outputIndex)) {
      fail("SSE function call reused a non-function output_index", options);
    }
    if (
      locator.itemId !== undefined &&
      emittedItemIds.has(locator.itemId)
    ) {
      fail("Upstream SSE repeated a function item id", options);
    }
    if (
      locator.itemId !== undefined &&
      nonFunctionItemIds.has(locator.itemId)
    ) {
      fail("SSE function call reused a non-function item id", options);
    }
    emittedOutputIndexes.add(outputIndex);
    if (locator.itemId !== undefined) emittedItemIds.add(locator.itemId);
    emittedFunctionCallSequence.push({ callId, outputIndex });
    emittedFunctionCalls.set(callId, canonicalJson(item));
  };

  const findPending = (event, item) => {
    const locator = streamLocator(event, item, options);
    if (
      locator.itemId !== undefined &&
      codec.reservedItemIds.has(locator.itemId)
    ) {
      fail("LM Studio reused a historical function item id", options);
    }
    if (
      locator.itemId !== undefined &&
      emittedItemIds.has(locator.itemId)
    ) {
      fail("Upstream SSE repeated a function item id", options);
    }
    if (
      locator.itemId !== undefined &&
      nonFunctionItemIds.has(locator.itemId)
    ) {
      fail("SSE function call reused a non-function item id", options);
    }
    if (
      locator.outputIndex !== undefined &&
      nonFunctionOutputIndexes.has(locator.outputIndex)
    ) {
      fail("SSE function call reused a non-function output_index", options);
    }
    const tracked = [...pending, ...ordinaryPending];
    if (tracked.some((candidate) => conflictingLocator(candidate, locator))) {
      fail("SSE function call identity changed", options);
    }
    const matches = tracked.filter((candidate) => sameLocator(candidate, locator));
    if (matches.length > 1) {
      fail("SSE function call identity is ambiguous", options);
    }
    const match = matches[0];
    return {
      locator,
      ordinaryCall: match?.kind === "ordinary" ? match : undefined,
      pendingCall: match?.kind === "synthetic" ? match : undefined,
    };
  };

  const push = (event, frame) => {
    if (!isPlainObject(event) || typeof event.type !== "string") {
      fail("Upstream SSE event must be a JSON object with a type", options);
    }
    if (closed || terminalSeen) {
      fail("Upstream SSE emitted data after the terminal event", options);
    }
    observeSseFrame();
    const current = cloneBoundedJson(
      event,
      codec.limits,
      "Upstream SSE event",
      options,
    );

    if (isUnsupportedInvocationSseEventType(current.type)) {
      fail("LM Studio returned an unadvertised invocation event", options);
    }

    if (current.type === "error") {
      discardUncommittedCalls();
      terminalSeen = true;
      return sseResult([sseEventEntry(current, frame)]);
    }

    if (current.type === "response.output_item.added") {
      const item = current.item;
      if (isPlainObject(item) && isUnsupportedInvocationItemType(item.type)) {
        fail("LM Studio returned an unadvertised invocation item", options);
      }
      if (
        isPlainObject(item) &&
        typeof item.type === "string" &&
        item.type.startsWith("tool_search")
      ) {
        fail("LM Studio returned an unsupported native tool-search item", options);
      }
      if (
        isPlainObject(item) &&
        item.type === "function_call" &&
        typeof item.name === "string" &&
        item.name.startsWith(WIRE_PREFIX) &&
        item.name !== codec.wireName &&
        !codec.occupiedWireNames.includes(item.name)
      ) {
        fail("LM Studio returned an unknown synthetic tool-search function", options);
      }
      if (!isPlainObject(item) || item.type !== "function_call") {
        recordNonFunctionOutputIndex(current);
      }
      if (
        isPlainObject(item) &&
        item.type === "function_call" &&
        item.name === codec.wireName
      ) {
        assertFunctionCallCapacity();
        assertOnlyKeys(item, FUNCTION_CALL_KEYS, "Synthetic function_call", options);
        if (
          item.status !== undefined &&
          item.status !== "in_progress" &&
          item.status !== "completed"
        ) {
          fail("Synthetic SSE function_call has an invalid status", options);
        }
        if (item.call_id !== undefined) {
          validateCallId(item.call_id, "Synthetic function_call.call_id", options);
        }
        if (item.arguments !== undefined) {
          if (
            typeof item.arguments !== "string" ||
            Buffer.byteLength(item.arguments, "utf8") > codec.limits.maxArgumentBytes
          ) {
            fail("Synthetic SSE function_call arguments are invalid or too large", options);
          }
        }
        const { locator, ordinaryCall, pendingCall } = findPending(current, item);
        if (pendingCall || ordinaryCall) {
          fail("SSE function call was added twice or changed identity", options);
        }
        if (
          locator.itemId !== undefined &&
          codec.reservedItemIds.has(locator.itemId)
        ) {
          fail("LM Studio reused a historical function item id", options);
        }
        if (
          pending.length + emittedSearchCalls.size >=
          codec.limits.maxSearchCalls
        ) {
          fail("Upstream SSE contains too many tool-search calls", {
            ...options,
            code: "TOOL_SEARCH_LIMIT_EXCEEDED",
          });
        }
        if (
          item.call_id !== undefined &&
          (codec.reservedCallIds.has(item.call_id) ||
            [...pending, ...ordinaryPending].some(
            (candidate) => candidate.callId === item.call_id,
          ) ||
            emittedCallIds.has(item.call_id))
        ) {
          fail("Upstream SSE repeated a tool-search call id", options);
        }
        pending.push({
          ...locator,
          kind: "synthetic",
          callId: item.call_id,
          name: codec.wireName,
          arguments: item.arguments ?? "",
          doneArguments: undefined,
        });
        return emptySseResult();
      }
      if (isPlainObject(item) && item.type === "function_call") {
        const name = boundedString(
          item.name,
          "SSE function_call.name",
          256,
          options,
        );
        const namespace = boundedString(
          item.namespace,
          "SSE function_call.namespace",
          256,
          options,
          { optional: true },
        );
        assertOnlyKeys(
          item,
          ORDINARY_FUNCTION_CALL_KEYS,
          "SSE function_call added item",
          options,
        );
        if (item.status !== undefined && item.status !== "in_progress") {
          fail("SSE function_call added item must be in progress", options);
        }
        if (
          item.arguments !== undefined &&
          (typeof item.arguments !== "string" ||
            Buffer.byteLength(item.arguments, "utf8") >
              codec.limits.maxArgumentBytes)
        ) {
          fail("SSE function_call added arguments are invalid or too large", options);
        }
        assertFunctionCallCapacity();
        if (item.call_id !== undefined) {
          validateCallId(item.call_id, "SSE function_call.call_id", options);
        }
        const { locator, ordinaryCall, pendingCall } = findPending(current, item);
        if (pendingCall || ordinaryCall) {
          fail("SSE function call was added twice or changed identity", options);
        }
        if (
          locator.itemId !== undefined &&
          codec.reservedItemIds.has(locator.itemId)
        ) {
          fail("LM Studio reused a historical function item id", options);
        }
        if (
          item.call_id !== undefined &&
          (codec.reservedCallIds.has(item.call_id) ||
            [...pending, ...ordinaryPending].some(
            (candidate) => candidate.callId === item.call_id,
          ) ||
            emittedCallIds.has(item.call_id))
        ) {
          fail("Upstream SSE repeated a function call id", options);
        }
        ordinaryPending.push({
          ...locator,
          kind: "ordinary",
          callId: item.call_id,
          name,
          namespace,
          arguments: item.arguments ?? "",
          hasArguments:
            typeof item.arguments === "string" && item.arguments.length > 0,
          sawArgumentDelta: false,
          doneArguments: undefined,
        });
        return holdStreamEntry(sseEventEntry(current, frame));
      }
    }

    if (
      current.type === "response.function_call_arguments.delta" ||
      current.type === "response.function_call_arguments.done"
    ) {
      const { ordinaryCall, pendingCall } = findPending(current);
      if (pendingCall) {
        validateArgumentEventAuthority(current, pendingCall, options);
        if (current.type.endsWith(".delta")) {
          if (typeof current.delta !== "string") {
            fail("Synthetic function argument delta must be a string", options);
          }
          pendingCall.arguments += current.delta;
          if (
            Buffer.byteLength(pendingCall.arguments, "utf8") >
            codec.limits.maxArgumentBytes
          ) {
            fail("Synthetic function arguments are too large", {
              ...options,
              code: "TOOL_SEARCH_LIMIT_EXCEEDED",
            });
          }
        } else {
          if (pendingCall.doneArguments !== undefined) {
            fail("Synthetic function arguments were completed twice", options);
          }
          if (
            typeof current.arguments !== "string" ||
            Buffer.byteLength(current.arguments, "utf8") >
              codec.limits.maxArgumentBytes
          ) {
            fail("Synthetic function arguments are invalid or too large", options);
          }
          pendingCall.doneArguments = current.arguments;
        }
        return emptySseResult();
      }
      if (!ordinaryCall) {
        fail("SSE function arguments precede their output item", options);
      }
      validateArgumentEventAuthority(current, ordinaryCall, options);
      if (current.type.endsWith(".delta")) {
        if (ordinaryCall.doneArguments !== undefined) {
          fail("SSE function arguments continued after their done event", options);
        }
        if (typeof current.delta !== "string") {
          fail("SSE function argument delta must be a string", options);
        }
        ordinaryCall.arguments += current.delta;
        ordinaryCall.sawArgumentDelta = true;
        ordinaryCall.hasArguments = true;
        if (
          Buffer.byteLength(ordinaryCall.arguments, "utf8") >
          codec.limits.maxArgumentBytes
        ) {
          fail("SSE function arguments are too large", {
            ...options,
            code: "TOOL_SEARCH_LIMIT_EXCEEDED",
          });
        }
        return emitOrHoldEvent(current, frame);
      }
      if (ordinaryCall.doneArguments !== undefined) {
        fail("SSE function arguments were completed twice", options);
      }
      if (
        typeof current.arguments !== "string" ||
        Buffer.byteLength(current.arguments, "utf8") >
          codec.limits.maxArgumentBytes
      ) {
        fail("SSE completed function arguments are invalid or too large", options);
      }
      if (
        ordinaryCall.hasArguments &&
        ordinaryCall.arguments !== current.arguments
      ) {
        fail("SSE function argument deltas do not match their done event", options);
      }
      ordinaryCall.arguments = current.arguments;
      ordinaryCall.hasArguments = true;
      ordinaryCall.doneArguments = current.arguments;
      return holdStreamEntry(sseEventEntry(current, frame));
    }

    if (current.type === "response.output_item.done") {
      const item = current.item;
      if (
        isPlainObject(item) &&
        typeof item.type === "string" &&
        item.type.startsWith("tool_search")
      ) {
        fail("LM Studio returned an unsupported native tool-search item", options);
      }
      const functionItem =
        isPlainObject(item) && item.type === "function_call";
      if (!functionItem) recordNonFunctionOutputIndex(current);
      const tracked = pending.length + ordinaryPending.length > 0 || functionItem
        ? findPending(current, item)
        : {};
      const syntheticItem =
        functionItem &&
        item.name === codec.wireName;
      if (
        syntheticItem &&
        !tracked.pendingCall &&
        !tracked.ordinaryCall
      ) {
        assertFunctionCallCapacity();
      }
      if (tracked.pendingCall && !syntheticItem) {
        fail("Synthetic SSE function call changed identity before completion", options);
      }
      if (tracked.ordinaryCall) {
        if (
          !isPlainObject(item) ||
          item.type !== "function_call" ||
          item.name !== tracked.ordinaryCall.name ||
          item.namespace !== tracked.ordinaryCall.namespace ||
          (tracked.ordinaryCall.callId !== undefined &&
            item.call_id !== tracked.ordinaryCall.callId)
        ) {
          fail("SSE function call changed identity before completion", options);
        }
        if (syntheticItem) {
          fail("SSE function call changed into PickerMux tool search", options);
        }
        if (
          typeof item.arguments !== "string" ||
          (tracked.ordinaryCall.hasArguments &&
            item.arguments !== tracked.ordinaryCall.arguments) ||
          (tracked.ordinaryCall.doneArguments !== undefined &&
            item.arguments !== tracked.ordinaryCall.doneArguments)
        ) {
          fail("SSE function arguments changed before item completion", options);
        }
      }
      if (
        syntheticItem
      ) {
        const pendingCall = tracked.pendingCall;
        const finalArguments = item.arguments;
        if (pendingCall) {
          if (
            pendingCall.callId !== undefined &&
            pendingCall.callId !== item.call_id
          ) {
            fail("Synthetic SSE call id changed before completion", options);
          }
          if (
            pendingCall.arguments &&
            pendingCall.arguments !== finalArguments
          ) {
            fail("Synthetic SSE argument deltas do not match the completed call", options);
          }
          if (
            pendingCall.doneArguments !== undefined &&
            pendingCall.doneArguments !== finalArguments
          ) {
            fail("Synthetic SSE arguments do not match the completed call", options);
          }
        }
        const state = {
          allCallIds: new Set(),
          allItemIds: new Set(),
          searchCallIds: new Set(),
        };
        const mappedItem = mapResponseOutputItem(
          item,
          codec,
          state,
          "response.output_item.done.item",
        );
        const [callId] = state.searchCallIds;
        if (emittedCallIds.has(callId)) {
          fail("Upstream SSE repeated a function call id", options);
        }
        if (emittedSearchCalls.size >= codec.limits.maxSearchCalls) {
          fail("Upstream SSE contains too many tool-search calls", {
            ...options,
            code: "TOOL_SEARCH_LIMIT_EXCEEDED",
          });
        }
        if (pendingCall) {
          const position = pending.indexOf(pendingCall);
          pending.splice(position, 1);
        }
        emittedCallIds.add(callId);
        recordCompletedFunctionCall(current, mappedItem, callId);
        emittedSearchCalls.set(callId, canonicalJson(mappedItem));
        return holdFunctionDone({ ...current, item: mappedItem }, frame);
      }
      const state = {
        allCallIds: new Set(),
        allItemIds: new Set(),
        searchCallIds: new Set(),
      };
      if (
        isPlainObject(item) &&
        item.type === "function_call" &&
        !tracked.pendingCall &&
        !tracked.ordinaryCall
      ) {
        assertFunctionCallCapacity();
      }
      const mappedItem = mapResponseOutputItem(
        item,
        codec,
        state,
        "response.output_item.done.item",
      );
      for (const callId of state.allCallIds) {
        if (emittedCallIds.has(callId)) {
          fail("Upstream SSE repeated a function call id", options);
        }
        emittedCallIds.add(callId);
        recordCompletedFunctionCall(current, mappedItem, callId);
      }
      if (tracked.ordinaryCall) {
        const position = ordinaryPending.indexOf(tracked.ordinaryCall);
        ordinaryPending.splice(position, 1);
      }
      return state.allCallIds.size > 0
        ? holdFunctionDone({ ...current, item: mappedItem }, frame)
        : emitOrHoldEvent({ ...current, item: mappedItem }, frame);
    }

    if (
      current.type === "response.completed" ||
      current.type === "response.failed" ||
      current.type === "response.incomplete"
    ) {
      if (!isPlainObject(current.response)) {
        fail("Upstream SSE terminal response must be a JSON object", options);
      }
      if (current.type !== "response.completed") {
        discardUncommittedCalls();
        const response = { ...current.response };
        // A failed or incomplete response cannot authorize a function call. Its
        // uncommitted output is omitted so a synthetic name or call cannot leak
        // through a terminal shape that Codex treats only as an error.
        delete response.output;
        terminalSeen = true;
        return sseResult([
          sseEventEntry({ ...current, response }, frame),
        ]);
      }
      if (pending.length > 0 || ordinaryPending.length > 0) {
        fail("Upstream SSE terminated before a tool-search output item was done", options);
      }

      const hasTerminalOutput = Object.hasOwn(current.response, "output");
      let rewritten;
      if (hasTerminalOutput) {
        rewritten = rewriteClientToolSearchResponse(current.response, codec);
      } else {
        validateSuccessfulResponseEnvelope(
          current.response,
          "Upstream SSE completed response",
          options,
        );
        rewritten = Object.freeze({
          allCallIds: Object.freeze([...emittedCallIds]),
          callIds: Object.freeze([...emittedSearchCalls.keys()]),
          value: current.response,
        });
      }
      if (hasTerminalOutput) {
        if (
          rewritten.allCallIds.length !== emittedCallIds.size ||
          rewritten.allCallIds.some((callId) => !emittedCallIds.has(callId))
        ) {
          fail("SSE terminal output does not match completed function calls", options);
        }
        const terminalCalls = new Map();
        const terminalFunctionCallSequence = [];
        for (const [outputIndex, item] of rewritten.value.output.entries()) {
          if (item.type !== "function_call" && item.type !== "tool_search_call") {
            continue;
          }
          terminalCalls.set(item.call_id, canonicalJson(item));
          terminalFunctionCallSequence.push({
            callId: item.call_id,
            outputIndex,
          });
        }
        if (terminalCalls.size !== emittedFunctionCalls.size) {
          fail("SSE terminal output does not match completed function-call items", options);
        }
        if (
          terminalFunctionCallSequence.length !== emittedFunctionCallSequence.length ||
          terminalFunctionCallSequence.some((terminalCall, index) => {
            const emittedCall = emittedFunctionCallSequence[index];
            return (
              terminalCall.callId !== emittedCall.callId ||
              terminalCall.outputIndex !== emittedCall.outputIndex
            );
          })
        ) {
          fail("SSE terminal output reordered a completed function-call item", options);
        }
        for (const [callId, encoded] of terminalCalls) {
          if (emittedFunctionCalls.get(callId) !== encoded) {
            fail("SSE terminal output changed a completed function-call item", options);
          }
        }
      }
      terminalSeen = true;
      const terminalEntry = sseEventEntry(
        { ...current, response: rewritten.value },
        frame,
      );
      if (heldStreamEntries.length === 0) {
        return sseResult([terminalEntry], rewritten.callIds);
      }
      holdStreamEntry(terminalEntry);
      const committed = [...heldStreamEntries];
      clearHeldStream();
      return sseResult(committed, rewritten.callIds);
    }
    if (
      current.output_index !== undefined ||
      current.item_id !== undefined
    ) {
      recordNonFunctionOutputIndex(current);
    }
    return emitOrHoldEvent(current, frame);
  };

  const pushRawFrame = (raw) => {
    if (typeof raw !== "string") throw new TypeError("SSE frame must be a string");
    if (closed || doneMarkerSeen) {
      fail("Upstream SSE emitted data after its done marker", options);
    }
    observeSseFrame();
    const entry = sseRawEntry(raw);
    return heldStreamEntries.length > 0
      ? holdStreamEntry(entry)
      : sseResult([entry]);
  };

  const finish = () => {
    if (closed) return emptySseResult();
    if (pending.length > 0 || ordinaryPending.length > 0) {
      fail("Upstream SSE ended with an incomplete tool-search call", options);
    }
    if (!terminalSeen) {
      fail("Upstream SSE ended before a terminal response event", options);
    }
    closed = true;
    return emptySseResult();
  };

  const acceptDoneMarker = () => {
    if (closed || doneMarkerSeen) {
      fail("Upstream SSE repeated its done marker", options);
    }
    observeSseFrame();
    if (!terminalSeen) {
      fail("Upstream SSE ended before a terminal response event", options);
    }
    doneMarkerSeen = true;
  };

  return Object.freeze({ acceptDoneMarker, finish, push, pushRawFrame });
}

export const EFFICIENT_FIDELITY_WIRE_PREFIX = WIRE_PREFIX;
export const EFFICIENT_FIDELITY_DEFAULT_LIMITS = DEFAULT_LIMITS;
export const EFFICIENT_FIDELITY_SEARCH_RESULT_OUTPUT = SEARCH_RESULT_OUTPUT;
