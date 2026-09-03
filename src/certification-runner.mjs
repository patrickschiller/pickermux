import {
  EFFICIENT_FIDELITY_CERTIFICATION_GATE,
  REQUIRED_CERTIFICATION_GATES,
  createCertificationSubject,
  evaluateEfficientFidelityCertification,
  evaluateModelCertification,
  readCertificationStore,
} from "./model-certification.mjs";
import {
  CERTIFICATION_HEADER,
  requireCertificationToken,
} from "./certification-transport.mjs";

function providerForModel(config, model) {
  const provider = config.providers.find((entry) => entry.id === model.providerId);
  if (!provider) {
    throw new Error(`No provider configuration exists for ${model.id}`);
  }
  return provider;
}

export function certificationSubjectForModel({
  config,
  model,
  codexClientVersion,
} = {}) {
  const provider = providerForModel(config, model);
  return createCertificationSubject({
    providerId: provider.id,
    providerKind: provider.kind,
    baseUrl: provider.baseUrl,
    publicModelId: model.id,
    upstreamModelId: model.upstreamId,
    contextWindow: model.contextWindow,
    reasoning: {
      effort: model.reasoningEffort ?? null,
      efforts: model.reasoningEfforts ?? [],
      effortMap: model.reasoningEffortMap ?? {},
      omitEfforts: model.reasoningOmitEfforts ?? [],
    },
    capabilities: model.capabilities ?? {},
    codexClientVersion,
  });
}

export async function resolveCertificationStatuses({
  storePath,
  config,
  models,
  codexClientVersion,
} = {}) {
  const store = await readCertificationStore(storePath);
  return models.map((model) => {
    const subject = certificationSubjectForModel({
      config,
      model,
      codexClientVersion,
    });
    return {
      model,
      subject,
      certification: evaluateModelCertification(store, subject),
      efficientFidelityCertification:
        evaluateEfficientFidelityCertification(store, subject),
    };
  });
}

export async function resolveCertifiedModelSlugs(options = {}) {
  const statuses = await resolveCertificationStatuses(options);
  return statuses
    .filter((entry) => entry.certification.status === "valid")
    .map((entry) => entry.model.id);
}

export async function resolveModelCapabilitySlugs(options = {}) {
  const statuses = await resolveCertificationStatuses(options);
  return {
    certifiedModelSlugs: statuses
      .filter((entry) => entry.certification.status === "valid")
      .map((entry) => entry.model.id),
    efficientFidelityModelSlugs: statuses
      .filter(
        (entry) => entry.efficientFidelityCertification.status === "valid",
      )
      .map((entry) => entry.model.id),
  };
}

function responseOutput(response) {
  return Array.isArray(response?.output) ? response.output : [];
}

function outputText(response) {
  return responseOutput(response)
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .filter((part) => part?.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
}

function isToolInvocationItem(item) {
  return (
    typeof item?.type === "string" &&
    (item.type === "function_call" ||
      item.type.endsWith("_call") ||
      item.type.endsWith("_call_output") ||
      item.type.startsWith("mcp_"))
  );
}

function isPlainObject(value) {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertCompletedJsonResponse(payload, label) {
  if (
    !isPlainObject(payload) ||
    (payload.status !== undefined && payload.status !== "completed") ||
    payload.error != null ||
    payload.incomplete_details != null
  ) {
    throw new Error(`${label} did not complete successfully`);
  }
}

const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

function responseMediaType(response) {
  const value = response.headers.get("content-type");
  if (typeof value !== "string" || !value.trim() || value.includes(",")) {
    return null;
  }
  const [essence, ...parameters] = value.split(";").map((part) => part.trim());
  const [type, subtype, ...extra] = essence.split("/");
  if (
    extra.length !== 0 ||
    !HTTP_TOKEN_PATTERN.test(type ?? "") ||
    !HTTP_TOKEN_PATTERN.test(subtype ?? "")
  ) {
    return null;
  }
  for (const parameter of parameters) {
    const equalsIndex = parameter.indexOf("=");
    const name = parameter.slice(0, equalsIndex).trim();
    const parameterValue = parameter.slice(equalsIndex + 1).trim();
    const quotedValue =
      /^"(?:[^"\\\r\n]|\\[\t -~])*"$/u.test(parameterValue);
    if (
      equalsIndex <= 0 ||
      !HTTP_TOKEN_PATTERN.test(name) ||
      (!HTTP_TOKEN_PATTERN.test(parameterValue) && !quotedValue)
    ) {
      return null;
    }
  }
  return `${type.toLowerCase()}/${subtype.toLowerCase()}`;
}

function assertJsonContentType(response, label) {
  const mediaType = responseMediaType(response);
  if (
    mediaType !== "application/json" &&
    !/^application\/[!#$%&'*+.^_`|~0-9a-z-]+\+json$/u.test(mediaType ?? "")
  ) {
    throw new Error(`${label} returned invalid JSON Content-Type`);
  }
}

function assertSseContentType(response, label) {
  if (responseMediaType(response) !== "text/event-stream") {
    throw new Error(`${label} returned invalid SSE Content-Type`);
  }
}

const MAX_CERTIFICATION_RESPONSE_BYTES = 8 * 1024 * 1024;

function bodyTooLargeError(label) {
  return new Error(
    `${label} response body exceeds ${MAX_CERTIFICATION_RESPONSE_BYTES} bytes`,
  );
}

async function readBoundedResponseText(response, label) {
  const contentLength = response.headers.get("content-length")?.trim();
  if (
    /^\d+$/u.test(contentLength ?? "") &&
    BigInt(contentLength) > BigInt(MAX_CERTIFICATION_RESPONSE_BYTES)
  ) {
    try {
      await response.body?.cancel();
    } catch {
      // The size violation remains authoritative even if cancellation fails.
    }
    throw bodyTooLargeError(label);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks = [];
  let byteLength = 0;
  const decode = (value, options) => {
    try {
      return decoder.decode(value, options);
    } catch {
      throw new Error(`${label} response body is not valid UTF-8`);
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error(`${label} response body returned a non-byte chunk`);
      }
      byteLength += value.byteLength;
      if (byteLength > MAX_CERTIFICATION_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size violation remains authoritative even if cancellation fails.
        }
        throw bodyTooLargeError(label);
      }
      chunks.push(decode(value, { stream: true }));
    }
    chunks.push(decode());
    return chunks.join("");
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the original read or validation failure.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function parseCertificationJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    // Provider bodies may contain prompts, model output, or other private
    // material. Do not retain JSON.parse's source excerpt in the error chain.
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function postJson({
  baseUrl,
  body,
  fetchImpl,
  timeoutMs,
  label,
  certificationToken,
}) {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/u, "")}/responses`, {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      [CERTIFICATION_HEADER]: certificationToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  assertJsonContentType(response, label);
  const payload = parseCertificationJson(
    await readBoundedResponseText(response, label),
    label,
  );
  assertCompletedJsonResponse(payload, label);
  return payload;
}

function parseSse(source) {
  const events = [];
  let doneSeen = false;
  for (const block of source.split(/\r?\n\r?\n/u)) {
    if (!block.trim()) continue;
    const lines = block.split(/\r?\n/u);
    if (doneSeen) {
      throw new Error("Certification stream returned data after [DONE]");
    }
    const frameLines = lines.filter(
      (line) => line.length > 0 && !line.startsWith(":"),
    );
    if (frameLines.length === 0) continue;

    const eventLines = frameLines.filter(
      (line) => line === "event" || line.startsWith("event:"),
    );
    if (eventLines.length > 1) {
      throw new Error("Certification stream returned duplicate event fields");
    }
    const type = eventLines[0] === "event"
      ? ""
      : eventLines[0]?.slice(6).trim();
    const dataLines = frameLines.filter(
      (line) => line === "data" || line.startsWith("data:"),
    );
    if (dataLines.length === 0) {
      throw new Error("Certification stream returned a frame without JSON data");
    }
    const dataText = dataLines
      .map((line) => (line === "data" ? "" : line.slice(5).replace(/^ /u, "")))
      .join("\n");
    if (dataText === "[DONE]") {
      if (
        eventLines.length !== 0 ||
        frameLines.length !== 1 ||
        events.at(-1)?.type !== "response.completed"
      ) {
        throw new Error("Certification stream returned premature [DONE]");
      }
      assertCompletedSse(events, "Certification stream");
      doneSeen = true;
      continue;
    }
    let data;
    try {
      data = JSON.parse(dataText);
    } catch {
      // SSE data can contain provider output or echoed prompt material. Keep
      // JSON.parse's source excerpt out of the CLI error and its cause chain.
      throw new Error("Certification stream returned invalid SSE JSON");
    }
    const resolvedType = type === undefined ? data?.type : type;
    if (resolvedType === "error" || data?.type === "error") {
      throw new Error("Certification stream returned an error event");
    }
    events.push({ type: resolvedType, data });
  }
  return events;
}

const RESPONSE_TERMINAL_EVENT_TYPES = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
]);

function assertCompletedSse(events, label) {
  for (const event of events) {
    if (
      !isPlainObject(event.data) ||
      (event.data.type !== undefined && event.data.type !== event.type)
    ) {
      throw new Error(`${label} returned inconsistent SSE event types`);
    }
  }

  const terminalEvents = events.filter((event) =>
    RESPONSE_TERMINAL_EVENT_TYPES.has(event.type),
  );
  const terminal = terminalEvents[0];
  if (
    terminalEvents.length !== 1 ||
    terminal?.type !== "response.completed" ||
    events.at(-1) !== terminal ||
    (terminal.data.status !== undefined &&
      terminal.data.status !== "completed") ||
    terminal.data.error != null ||
    terminal.data.incomplete_details != null
  ) {
    throw new Error(
      `${label} did not return exactly one successful response.completed terminal`,
    );
  }

  if (terminal.data?.response !== undefined) {
    const completedResponse = terminal.data.response;
    if (
      !isPlainObject(completedResponse) ||
      (completedResponse.status !== undefined &&
        completedResponse.status !== "completed") ||
      completedResponse.error != null ||
      completedResponse.incomplete_details != null ||
      (Object.hasOwn(completedResponse, "output") &&
        !Array.isArray(completedResponse.output))
    ) {
      throw new Error(`${label} returned an inconsistent response.completed terminal`);
    }
  }
}

async function postSse({
  baseUrl,
  body,
  fetchImpl,
  timeoutMs,
  label,
  certificationToken,
}) {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/u, "")}/responses`, {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      [CERTIFICATION_HEADER]: certificationToken,
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  assertSseContentType(response, label);
  const events = parseSse(await readBoundedResponseText(response, label));
  assertCompletedSse(events, label);
  return events;
}

function namespaceTools() {
  return [
    {
      type: "namespace",
      name: "p3_certification",
      description: "P3 certification tools",
      tools: [
        {
          type: "function",
          name: "confirm",
          description: "Confirm the tool roundtrip",
          parameters: {},
        },
      ],
    },
  ];
}

const DIRECT_FUNCTION_NAME = "p3_direct_confirm";
const DIRECT_FUNCTION_MARKER = "P3_FUNCTION_OK";
const TOOL_PROBE_MAX_OUTPUT_TOKENS = 2_048;

function directFunctionTools() {
  return [
    {
      type: "function",
      name: DIRECT_FUNCTION_NAME,
      description: "Confirm direct function calling with the required marker",
      parameters: {
        type: "object",
        properties: {
          marker: { type: "string", enum: [DIRECT_FUNCTION_MARKER] },
        },
        required: ["marker"],
        additionalProperties: false,
      },
    },
  ];
}

function forcedDirectFunctionChoice() {
  return { type: "function", name: DIRECT_FUNCTION_NAME };
}

function forcedNamespaceChoice() {
  return {
    type: "namespace",
    name: "p3_certification",
    function: { name: "confirm" },
  };
}

function assertMarker(payload, marker, label) {
  const invocations = responseOutput(payload).filter(isToolInvocationItem);
  if (outputText(payload).trim() !== marker || invocations.length !== 0) {
    throw new Error(`${label} did not return ${marker}`);
  }
}

function onlyFunctionCall(response, label) {
  const invocations = responseOutput(response).filter(isToolInvocationItem);
  if (invocations.length !== 1 || invocations[0]?.type !== "function_call") {
    throw new Error(`${label} did not return exactly one function call`);
  }
  return invocations[0];
}

function parseFunctionArguments(call, label) {
  let args;
  try {
    args = JSON.parse(call?.arguments ?? "");
  } catch {
    // Function arguments are provider-controlled and may contain private
    // prompt material. JSON.parse includes source excerpts in some runtimes.
    throw new Error(`${label} returned invalid function arguments`);
  }
  if (args === null || Array.isArray(args) || typeof args !== "object") {
    throw new Error(`${label} returned non-object function arguments`);
  }
  return args;
}

function assertDirectFunctionCall(call, label) {
  if (
    call?.name !== DIRECT_FUNCTION_NAME ||
    call?.namespace !== undefined ||
    (call?.status !== undefined && call.status !== "completed") ||
    typeof call.call_id !== "string" ||
    !call.call_id
  ) {
    throw new Error(`${label} did not return the certified direct function call`);
  }
  const args = parseFunctionArguments(call, label);
  if (
    args.marker !== DIRECT_FUNCTION_MARKER ||
    Object.keys(args).length !== 1
  ) {
    throw new Error(`${label} did not return the required function arguments`);
  }
}

function assertNamespaceCall(call, label) {
  if (
    call?.name !== "confirm" ||
    call?.namespace !== "p3_certification" ||
    (call?.status !== undefined && call.status !== "completed") ||
    typeof call.call_id !== "string" ||
    !call.call_id
  ) {
    throw new Error(`${label} did not return the certified namespace call`);
  }
  const args = parseFunctionArguments(call, label);
  if (Object.keys(args).length !== 0) {
    throw new Error(`${label} returned non-empty parameterless arguments`);
  }
}

function completedSseResponse(events) {
  return events.find((event) => event.type === "response.completed")?.data
    ?.response;
}

function equalProbeValue(left, right) {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return false;
  }
  if (Array.isArray(left)) {
    return (
      left.length === right.length &&
      left.every((entry, index) => equalProbeValue(entry, right[index]))
    );
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && equalProbeValue(left[key], right[key]),
    )
  );
}

function sameInvocationIdentity(left, right, { final = false } = {}) {
  if (
    left?.type !== right?.type ||
    left?.name !== right?.name ||
    left?.namespace !== right?.namespace ||
    left?.execution !== right?.execution ||
    left?.call_id !== right?.call_id ||
    (left?.id !== undefined &&
      right?.id !== undefined &&
      left.id !== right.id)
  ) {
    return false;
  }
  return !final || equalProbeValue(left?.arguments, right?.arguments);
}

function invocationEventLocator(event, label) {
  const eventItemId = event.data?.item_id;
  const embeddedItemId = event.data?.item?.id;
  if (
    eventItemId !== undefined &&
    embeddedItemId !== undefined &&
    eventItemId !== embeddedItemId
  ) {
    throw new Error(`${label} returned conflicting function item ids`);
  }
  const itemId = eventItemId ?? embeddedItemId;
  const outputIndex = event.data?.output_index;
  if (
    (itemId !== undefined && !boundedProbeIdentifier(itemId)) ||
    (outputIndex !== undefined &&
      (!Number.isSafeInteger(outputIndex) || outputIndex < 0))
  ) {
    throw new Error(`${label} returned an invalid function event locator`);
  }
  return { itemId, outputIndex };
}

function sameInvocationEventLocator(left, right) {
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

function assertFunctionArgumentLifecycle(
  events,
  doneEvent,
  addedEvent,
  doneCall,
  label,
) {
  const argumentEvents = events.filter(
    (event) =>
      event.type === "response.function_call_arguments.delta" ||
      event.type === "response.function_call_arguments.done",
  );
  if (argumentEvents.length === 0) return;

  const doneLocator = invocationEventLocator(doneEvent, label);
  if (doneLocator.itemId === undefined && doneLocator.outputIndex === undefined) {
    throw new Error(`${label} returned uncorrelated function arguments`);
  }
  if (addedEvent) {
    const addedLocator = invocationEventLocator(addedEvent, label);
    if (!sameInvocationEventLocator(doneLocator, addedLocator)) {
      throw new Error(`${label} changed function event identity before completion`);
    }
  }

  const donePosition = events.indexOf(doneEvent);
  const addedPosition = addedEvent ? events.indexOf(addedEvent) : -1;
  let argumentsValue =
    typeof addedEvent?.data?.item?.arguments === "string"
      ? addedEvent.data.item.arguments
      : "";
  let sawArgumentEvidence = argumentsValue.length > 0;
  let completedArguments;
  for (const event of argumentEvents) {
    const position = events.indexOf(event);
    if (
      position >= donePosition ||
      (addedEvent && position <= addedPosition) ||
      !sameInvocationEventLocator(
        doneLocator,
        invocationEventLocator(event, label),
      ) ||
      (event.data?.call_id !== undefined &&
        event.data.call_id !== doneCall.call_id)
    ) {
      throw new Error(`${label} returned uncorrelated function arguments`);
    }
    if (event.type.endsWith(".delta")) {
      if (completedArguments !== undefined || typeof event.data?.delta !== "string") {
        throw new Error(`${label} returned invalid function argument deltas`);
      }
      argumentsValue += event.data.delta;
      sawArgumentEvidence = true;
      continue;
    }
    if (
      completedArguments !== undefined ||
      typeof event.data?.arguments !== "string"
    ) {
      throw new Error(`${label} returned invalid function argument completion`);
    }
    completedArguments = event.data.arguments;
    if (sawArgumentEvidence && completedArguments !== argumentsValue) {
      throw new Error(`${label} changed function arguments before completion`);
    }
    argumentsValue = completedArguments;
    sawArgumentEvidence = true;
  }
  if (
    sawArgumentEvidence &&
    (typeof doneCall.arguments !== "string" || doneCall.arguments !== argumentsValue)
  ) {
    throw new Error(`${label} changed function arguments before item completion`);
  }
}

function assertSingleSseFunctionCall(events, label) {
  const invocationEvents = events.filter((event) =>
    isToolInvocationItem(event.data?.item)
  );
  if (
    invocationEvents.some(
      (event) =>
        event.type !== "response.output_item.added" &&
        event.type !== "response.output_item.done",
    )
  ) {
    throw new Error(`${label} returned an invocation outside its item lifecycle`);
  }
  const doneEvents = invocationEvents.filter(
    (event) => event.type === "response.output_item.done",
  );
  const doneInvocations = doneEvents.map((event) => event.data.item);
  if (
    doneInvocations.length !== 1 ||
    doneInvocations[0]?.type !== "function_call"
  ) {
    throw new Error(`${label} did not return exactly one completed function call`);
  }
  const doneCall = doneInvocations[0];
  const addedEvents = invocationEvents.filter(
    (event) => event.type === "response.output_item.added",
  );
  if (addedEvents.length > 1) {
    throw new Error(`${label} repeated its function-call added event`);
  }

  const lifecycleInvocations = events
    .filter(
      (event) =>
        event.type === "response.output_item.added" ||
        event.type === "response.output_item.done",
    )
    .map((event) => event.data?.item)
    .filter(isToolInvocationItem);
  if (
    lifecycleInvocations.some(
      (invocation) => !sameInvocationIdentity(doneCall, invocation),
    )
  ) {
    throw new Error(`${label} changed function-call identity before completion`);
  }
  assertFunctionArgumentLifecycle(
    events,
    doneEvents[0],
    addedEvents[0],
    doneCall,
    label,
  );

  const terminalResponse = completedSseResponse(events);
  let terminalCall;
  if (terminalResponse && Object.hasOwn(terminalResponse, "output")) {
    if (!Array.isArray(terminalResponse.output)) {
      throw new Error(`${label} returned invalid terminal output`);
    }
    const terminalInvocations = terminalResponse.output.filter(
      isToolInvocationItem,
    );
    if (
      terminalInvocations.length !== 1 ||
      terminalInvocations[0]?.type !== "function_call"
    ) {
      throw new Error(`${label} returned inconsistent terminal invocations`);
    }
    terminalCall = terminalInvocations[0];
    if (!sameInvocationIdentity(doneCall, terminalCall, { final: true })) {
      throw new Error(`${label} returned an inconsistent terminal function call`);
    }
  }
  return { doneCall, terminalCall };
}

function sseInvocationItems(events) {
  const eventItems = events
    .map((event) => event.data?.item)
    .filter(isToolInvocationItem);
  const terminalResponse = completedSseResponse(events);
  const terminalItems = Array.isArray(terminalResponse?.output)
    ? terminalResponse.output.filter(isToolInvocationItem)
    : [];
  return [...eventItems, ...terminalItems];
}

/**
 * Run the complete P3 live matrix through the installed bridge. Probes are
 * deliberately serial so a single local model never processes two prompts at
 * once. No probe content is returned to the receipt store.
 */
export async function runModelCertification({
  baseUrl,
  model,
  certificationToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10 * 60_000,
} = {}) {
  if (typeof model?.id !== "string" || !Number.isSafeInteger(model.contextWindow)) {
    throw new Error("Certification requires a discovered model with context metadata");
  }
  const privateCertificationToken = requireCertificationToken(certificationToken);
  const common = {
    model: model.id,
    max_output_tokens: 256,
    stream: false,
  };

  const text = await postJson({
    baseUrl,
    fetchImpl,
    timeoutMs,
    label: "Text probe",
    body: {
      ...common,
      input: "Reply with exactly P3_TEXT_OK and nothing else.",
    },
    certificationToken: privateCertificationToken,
  });
  assertMarker(text, "P3_TEXT_OK", "Text probe");

  const streamEvents = await postSse({
    baseUrl,
    fetchImpl,
    timeoutMs,
    label: "Stream probe",
    body: {
      ...common,
      input: "Reply with exactly P3_STREAM_OK and nothing else.",
    },
    certificationToken: privateCertificationToken,
  });
  const streamTypes = new Set(streamEvents.map((event) => event.type));
  const deltas = streamEvents
    .filter((event) => event.type === "response.output_text.delta")
    .map((event) => event.data.delta ?? "")
    .join("");
  const streamTerminalResponse = completedSseResponse(streamEvents);
  const terminalTextMatches =
    !streamTerminalResponse ||
    !Object.hasOwn(streamTerminalResponse, "output") ||
    outputText(streamTerminalResponse).trim() === "P3_STREAM_OK";
  if (
    !streamTypes.has("response.created") ||
    deltas.trim() !== "P3_STREAM_OK" ||
    !terminalTextMatches ||
    sseInvocationItems(streamEvents).length !== 0
  ) {
    throw new Error("Stream probe did not complete the Responses SSE contract");
  }

  const directTools = directFunctionTools();
  const directResponse = await postJson({
    baseUrl,
    fetchImpl,
    timeoutMs,
    label: "Direct function probe",
    body: {
      ...common,
      max_output_tokens: TOOL_PROBE_MAX_OUTPUT_TOKENS,
      input:
        `Call ${DIRECT_FUNCTION_NAME} now with marker=${DIRECT_FUNCTION_MARKER}.`,
      tools: directTools,
      tool_choice: forcedDirectFunctionChoice(),
      parallel_tool_calls: false,
    },
    certificationToken: privateCertificationToken,
  });
  const directCall = onlyFunctionCall(directResponse, "Direct function probe");
  assertDirectFunctionCall(directCall, "Direct function probe");
  if (typeof directResponse.id !== "string" || !directResponse.id) {
    throw new Error("Direct function probe returned no response id");
  }

  const toolResult = await postJson({
    baseUrl,
    fetchImpl,
    timeoutMs,
    label: "Tool-result probe",
    body: {
      ...common,
      max_output_tokens: TOOL_PROBE_MAX_OUTPUT_TOKENS,
      previous_response_id: directResponse.id,
      instructions: "After the tool result, reply with exactly P3_TOOL_RESULT_OK.",
      input: [
        {
          type: "function_call_output",
          call_id: directCall.call_id,
          output: "confirmed",
        },
      ],
      tools: directTools,
      tool_choice: "none",
      parallel_tool_calls: false,
    },
    certificationToken: privateCertificationToken,
  });
  assertMarker(toolResult, "P3_TOOL_RESULT_OK", "Tool-result probe");

  const namespaceToolset = namespaceTools();
  const namespaceResponse = await postJson({
    baseUrl,
    fetchImpl,
    timeoutMs,
    label: "Parameterless namespace JSON probe",
    body: {
      ...common,
      max_output_tokens: TOOL_PROBE_MAX_OUTPUT_TOKENS,
      input: "Call the parameterless confirm tool now.",
      tools: namespaceToolset,
      tool_choice: forcedNamespaceChoice(),
      parallel_tool_calls: false,
    },
    certificationToken: privateCertificationToken,
  });
  const namespaceCall = onlyFunctionCall(
    namespaceResponse,
    "Parameterless namespace JSON probe",
  );
  assertNamespaceCall(namespaceCall, "Parameterless namespace JSON probe");

  const namespaceEvents = await postSse({
    baseUrl,
    fetchImpl,
    timeoutMs,
    label: "Namespace stream probe",
    body: {
      ...common,
      max_output_tokens: TOOL_PROBE_MAX_OUTPUT_TOKENS,
      input: "Call the parameterless confirm tool now.",
      tools: namespaceToolset,
      tool_choice: forcedNamespaceChoice(),
      parallel_tool_calls: false,
    },
    certificationToken: privateCertificationToken,
  });
  const { doneCall, terminalCall } = assertSingleSseFunctionCall(
    namespaceEvents,
    "Namespace stream probe",
  );
  assertNamespaceCall(doneCall, "Namespace stream probe");
  if (terminalCall) {
    assertNamespaceCall(terminalCall, "Namespace stream probe terminal");
  }

  const minimumInputTokens = Math.min(
    8_192,
    Math.max(2_048, Math.floor(model.contextWindow / 8)),
  );
  const longPrompt =
    `P3_LONG_BEGIN\n${"context ".repeat(Math.ceil(minimumInputTokens * 1.4))}` +
    "\nP3_LONG_END\nReply with exactly P3_LONG_OK and nothing else.";
  const longContext = await postJson({
    baseUrl,
    fetchImpl,
    timeoutMs,
    label: "Long-context probe",
    body: { ...common, input: longPrompt },
    certificationToken: privateCertificationToken,
  });
  assertMarker(longContext, "P3_LONG_OK", "Long-context probe");
  if (!Number.isSafeInteger(longContext?.usage?.input_tokens)) {
    throw new Error("Long-context probe returned no input token usage");
  }
  if (longContext.usage.input_tokens < minimumInputTokens) {
    throw new Error(
      `Long-context probe used only ${longContext.usage.input_tokens} of ${minimumInputTokens} required tokens`,
    );
  }

  return Object.fromEntries(REQUIRED_CERTIFICATION_GATES.map((gate) => [gate, true]));
}

const EFFICIENT_FIDELITY_NAMESPACE = "p6_efficient_fidelity";
const EFFICIENT_FIDELITY_FUNCTION = "confirm";
const EFFICIENT_FIDELITY_MARKER = "P6_EFFICIENT_FIDELITY_OK";

function efficientFidelityDeferredTool() {
  return {
    type: "namespace",
    name: EFFICIENT_FIDELITY_NAMESPACE,
    description: "Efficient Fidelity certification tools",
    tools: [
      {
        type: "function",
        name: EFFICIENT_FIDELITY_FUNCTION,
        description: "Confirm the stateless client tool-search roundtrip",
        defer_loading: true,
        strict: true,
        parameters: {
          type: "object",
          properties: {
            marker: {
              type: "string",
              enum: [EFFICIENT_FIDELITY_MARKER],
            },
          },
          required: ["marker"],
          additionalProperties: false,
        },
      },
    ],
  };
}

function efficientFidelitySearchTool() {
  return {
    type: "tool_search",
    execution: "client",
    description: "Search for only the tool needed to continue this probe.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 1,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

function efficientFidelityUserMessage() {
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text:
          "Use client tool search to find the certification confirmation " +
          `tool, then call it with marker=${EFFICIENT_FIDELITY_MARKER}.`,
      },
    ],
  };
}

function boundedProbeIdentifier(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function assertEfficientFidelitySearchCall(events) {
  const types = new Set(events.map((event) => event.type));
  const completedItems = events
    .filter((event) => event.type === "response.output_item.done")
    .map((event) => event.data?.item);
  const calls = completedItems.filter(
    (item) => item?.type === "tool_search_call",
  );
  const invocations = completedItems.filter(isToolInvocationItem);
  const terminalResponse = completedSseResponse(events);
  const terminalInvocations = Array.isArray(terminalResponse?.output)
    ? terminalResponse.output.filter(isToolInvocationItem)
    : [];
  if (
    !types.has("response.created") ||
    !types.has("response.completed") ||
    calls.length !== 1 ||
    invocations.length !== 1 ||
    (terminalResponse &&
      Object.hasOwn(terminalResponse, "output") &&
      (terminalInvocations.length !== 1 ||
        terminalInvocations[0]?.type !== "tool_search_call"))
  ) {
    throw new Error(
      "Efficient Fidelity search probe did not complete one client tool search",
    );
  }
  const call = calls[0];
  const lifecycleInvocations = events
    .filter(
      (event) =>
        event.type === "response.output_item.added" ||
        event.type === "response.output_item.done",
    )
    .map((event) => event.data?.item)
    .filter(isToolInvocationItem);
  const addedInvocations = events
    .filter((event) => event.type === "response.output_item.added")
    .map((event) => event.data?.item)
    .filter(isToolInvocationItem);
  if (
    addedInvocations.length > 1 ||
    events.some((event) =>
      event.type === "response.function_call_arguments.delta" ||
      event.type === "response.function_call_arguments.done"
    ) ||
    lifecycleInvocations.some(
      (invocation) => !sameInvocationIdentity(call, invocation),
    )
  ) {
    throw new Error(
      "Efficient Fidelity search probe changed invocation identity before completion",
    );
  }
  const terminalCall = terminalInvocations[0];
  const callsToValidate = terminalCall ? [call, terminalCall] : [call];
  const invalidCall = callsToValidate.some((candidate) => {
    const argumentKeys =
      candidate.arguments && typeof candidate.arguments === "object" &&
      !Array.isArray(candidate.arguments)
        ? Object.keys(candidate.arguments)
        : [];
    return (
      candidate.execution !== "client" ||
      candidate.status !== "completed" ||
      !boundedProbeIdentifier(candidate.call_id) ||
      (candidate.id !== undefined && !boundedProbeIdentifier(candidate.id)) ||
      argumentKeys.some((key) => key !== "query" && key !== "limit") ||
      typeof candidate.arguments?.query !== "string" ||
      candidate.arguments.query.trim().length === 0 ||
      Buffer.byteLength(candidate.arguments.query, "utf8") > 1_024 ||
      (candidate.arguments.limit !== undefined &&
        (!Number.isSafeInteger(candidate.arguments.limit) ||
          candidate.arguments.limit < 1 ||
          candidate.arguments.limit > 1))
    );
  });
  if (
    invalidCall ||
    (terminalCall &&
      !sameInvocationIdentity(call, terminalCall, { final: true }))
  ) {
    throw new Error(
      "Efficient Fidelity search probe returned an invalid client tool-search call",
    );
  }
  return {
    ...(call.id === undefined ? {} : { id: call.id }),
    type: "tool_search_call",
    execution: "client",
    call_id: call.call_id,
    status: "completed",
    arguments: {
      query: call.arguments.query,
      ...(call.arguments.limit === undefined
        ? {}
        : { limit: call.arguments.limit }),
    },
  };
}

function assertEfficientFidelityFunctionCall(response, searchCallId) {
  if (response?.status !== undefined && response.status !== "completed") {
    throw new Error(
      "Efficient Fidelity loaded-tool probe did not complete successfully",
    );
  }
  const output = Array.isArray(response?.output) ? response.output : [];
  const calls = output.filter((item) => item?.type === "function_call");
  const invocations = output.filter(isToolInvocationItem);
  if (calls.length !== 1 || invocations.length !== 1) {
    throw new Error(
      "Efficient Fidelity loaded-tool probe did not return one function call",
    );
  }
  const call = calls[0];
  if (
    call.namespace !== EFFICIENT_FIDELITY_NAMESPACE ||
    call.name !== EFFICIENT_FIDELITY_FUNCTION ||
    (call.status !== undefined && call.status !== "completed") ||
    !boundedProbeIdentifier(call.call_id) ||
    call.call_id === searchCallId
  ) {
    throw new Error(
      "Efficient Fidelity loaded-tool probe did not return the certified namespace call",
    );
  }
  const args = parseFunctionArguments(call, "Efficient Fidelity loaded-tool probe");
  if (
    args.marker !== EFFICIENT_FIDELITY_MARKER ||
    Object.keys(args).length !== 1
  ) {
    throw new Error(
      "Efficient Fidelity loaded-tool probe did not return the required arguments",
    );
  }
}

/**
 * Certify only the additive Efficient Fidelity gate. The second leg replays
 * the complete transcript and intentionally does not rely on provider-side
 * response history.
 */
export async function runEfficientFidelityCertification({
  baseUrl,
  model,
  certificationToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10 * 60_000,
} = {}) {
  if (typeof model?.id !== "string" || !Number.isSafeInteger(model.contextWindow)) {
    throw new Error(
      "Efficient Fidelity certification requires a discovered model with context metadata",
    );
  }
  const privateCertificationToken = requireCertificationToken(certificationToken);
  const tools = [
    efficientFidelityDeferredTool(),
    efficientFidelitySearchTool(),
  ];
  const userMessage = efficientFidelityUserMessage();
  const common = {
    model: model.id,
    max_output_tokens: TOOL_PROBE_MAX_OUTPUT_TOKENS,
    tools,
    tool_choice: "auto",
    parallel_tool_calls: false,
  };

  const searchEvents = await postSse({
    baseUrl,
    fetchImpl,
    timeoutMs,
    label: "Efficient Fidelity search probe",
    body: {
      ...common,
      input: [userMessage],
    },
    certificationToken: privateCertificationToken,
  });
  const searchCall = assertEfficientFidelitySearchCall(searchEvents);

  const loadedTool = efficientFidelityDeferredTool();
  const loadedToolResponse = await postJson({
    baseUrl,
    fetchImpl,
    timeoutMs,
    label: "Efficient Fidelity loaded-tool probe",
    body: {
      ...common,
      stream: false,
      input: [
        userMessage,
        searchCall,
        {
          type: "tool_search_output",
          execution: "client",
          call_id: searchCall.call_id,
          status: "completed",
          tools: [loadedTool],
        },
      ],
    },
    certificationToken: privateCertificationToken,
  });
  assertEfficientFidelityFunctionCall(loadedToolResponse, searchCall.call_id);

  return { [EFFICIENT_FIDELITY_CERTIFICATION_GATE]: true };
}
