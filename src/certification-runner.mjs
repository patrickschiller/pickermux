import {
  REQUIRED_CERTIFICATION_GATES,
  createCertificationSubject,
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
    };
  });
}

export async function resolveCertifiedModelSlugs(options = {}) {
  const statuses = await resolveCertificationStatuses(options);
  return statuses
    .filter((entry) => entry.certification.status === "valid")
    .map((entry) => entry.model.id);
}

function outputText(response) {
  return (Array.isArray(response?.output) ? response.output : [])
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .filter((part) => part?.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
}

function functionCall(response) {
  return (Array.isArray(response?.output) ? response.output : []).find(
    (item) => item?.type === "function_call",
  );
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
  return response.json();
}

function parseSse(source) {
  const events = [];
  for (const block of source.split(/\r?\n\r?\n/u)) {
    if (!block.trim()) continue;
    const lines = block.split(/\r?\n/u);
    const type = lines.find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const dataText = lines
      .filter((line) => line === "data" || line.startsWith("data:"))
      .map((line) => (line === "data" ? "" : line.slice(5).replace(/^ /u, "")))
      .join("\n");
    if (!dataText || dataText === "[DONE]") continue;
    let data;
    try {
      data = JSON.parse(dataText);
    } catch (error) {
      throw new Error("Certification stream returned invalid SSE JSON", {
        cause: error,
      });
    }
    events.push({ type: type ?? data.type, data });
  }
  return events;
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
  return parseSse(await response.text());
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
  if (!outputText(payload).includes(marker)) {
    throw new Error(`${label} did not return ${marker}`);
  }
}

function parseFunctionArguments(call, label) {
  let args;
  try {
    args = JSON.parse(call?.arguments ?? "");
  } catch (error) {
    throw new Error(`${label} returned invalid function arguments`, { cause: error });
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
  if (
    !streamTypes.has("response.created") ||
    !streamTypes.has("response.completed") ||
    !deltas.includes("P3_STREAM_OK")
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
  const directCall = functionCall(directResponse);
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
  const namespaceCall = functionCall(namespaceResponse);
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
  const doneCall = namespaceEvents
    .filter((event) => event.type === "response.output_item.done")
    .map((event) => event.data?.item)
    .find((item) => item?.type === "function_call");
  assertNamespaceCall(doneCall, "Namespace stream probe");

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
