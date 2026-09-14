import { BodyCodecError } from "./body-codec.mjs";

export const WEB_SEARCH_PATH = "/v1/alpha/search";
export const WEB_SEARCH_CONTRACT_VERSION = 1;

const string = (value) => typeof value === "string";
const nonemptyString = (value) => string(value) && value.trim().length > 0;
const boolean = (value) => typeof value === "boolean";
const finiteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const unsignedInteger = (value) => Number.isSafeInteger(value) && value >= 0;

function oneOf(values) {
  const allowed = new Set(values);
  return (value) => allowed.has(value);
}

function arrayOf(validate) {
  return (value) => Array.isArray(value) && value.every(validate);
}

function objectOf(required, optional = {}) {
  const fields = { ...required, ...optional };
  const requiredKeys = Object.keys(required);
  return (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (!requiredKeys.every((key) => Object.hasOwn(value, key))) return false;
    return Reflect.ownKeys(value).every(
      (key) => Object.hasOwn(fields, key) && fields[key](value[key]),
    );
  };
}

const strings = arrayOf(string);
const searchQuery = objectOf({ q: string }, {
  recency: unsignedInteger,
  domains: strings,
});
const openOperation = objectOf({ ref_id: string }, { lineno: unsignedInteger });
const clickOperation = objectOf({ ref_id: string, id: unsignedInteger });
const findOperation = objectOf({ ref_id: string, pattern: string });
const screenshotOperation = objectOf({ ref_id: string, pageno: unsignedInteger });
const financeOperation = objectOf({
  ticker: string,
  type: oneOf(["equity", "fund", "crypto", "index"]),
}, { market: string });
const weatherOperation = objectOf({ location: string }, {
  start: string,
  duration: unsignedInteger,
});
const sportsOperation = objectOf({
  fn: oneOf(["schedule", "standings"]),
  league: oneOf(["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"]),
}, {
  tool: oneOf(["sports"]),
  team: string,
  opponent: string,
  date_from: string,
  date_to: string,
  num_games: unsignedInteger,
  locale: string,
});
const timeOperation = objectOf({ utc_offset: string });

const commands = objectOf({}, {
  search_query: arrayOf(searchQuery),
  image_query: arrayOf(searchQuery),
  open: arrayOf(openOperation),
  click: arrayOf(clickOperation),
  find: arrayOf(findOperation),
  screenshot: arrayOf(screenshotOperation),
  finance: arrayOf(financeOperation),
  weather: arrayOf(weatherOperation),
  sports: arrayOf(sportsOperation),
  time: arrayOf(timeOperation),
  response_length: oneOf(["short", "medium", "long"]),
});

const location = objectOf({ type: oneOf(["approximate"]) }, {
  country: string,
  region: string,
  city: string,
  timezone: string,
});
const filters = objectOf({}, { allowed_domains: strings, blocked_domains: strings });
const imageSettings = objectOf({}, { max_results: unsignedInteger, caption: boolean });
const webAccessMode = oneOf(["cached", "indexed", "live"]);
const settings = objectOf({}, {
  user_location: location,
  search_context_size: oneOf(["low", "medium", "high"]),
  filters,
  image_settings: imageSettings,
  allowed_callers: arrayOf(oneOf(["direct", "shell", "code_interpreter"])),
  external_web_access: (value) => boolean(value) || webAccessMode(value),
});

const reasoning = objectOf({}, {
  // Codex permits model-defined effort strings in addition to its built-in names.
  effort: (value) => string(value) && value.length > 0,
  summary: oneOf(["auto", "concise", "detailed", "none"]),
  context: oneOf(["auto", "current_turn", "all_turns"]),
});
const messageMetadata = objectOf({}, {
  turn_id: string,
  create_time: finiteNumber,
  content_item_kinds: strings,
});
const inputText = objectOf({ type: oneOf(["input_text"]), text: string });
const outputText = objectOf({ type: oneOf(["output_text"]), text: string });
const messageShape = objectOf({
  type: oneOf(["message"]),
  role: oneOf(["user", "assistant"]),
  content: Array.isArray,
}, {
  id: string,
  phase: oneOf(["commentary", "final_answer"]),
  internal_chat_message_metadata_passthrough: messageMetadata,
});

function recentMessage(value) {
  if (!messageShape(value)) return false;
  return value.content.every(value.role === "user" ? inputText : outputText);
}

const recentMessages = arrayOf(recentMessage);
const requestShape = objectOf({ id: nonemptyString, model: nonemptyString }, {
  reasoning,
  input: (value) => string(value) || recentMessages(value),
  commands,
  settings,
  max_output_tokens: unsignedInteger,
});
const responseShape = objectOf({ output: string }, {
  encrypted_output: (value) => value === null || string(value),
  // Codex carries structured results out of band and intentionally treats each
  // result as opaque so new result variants do not change the wire contract.
  results: (value) => value === null || Array.isArray(value),
});

// This boundary follows Codex's standalone search serializer and visible text
// history. It rejects new shapes until reviewed; it never resolves ref_id URLs,
// attaches conversation history, or opens a provider connection itself.
export function validateWebSearchRequest(value) {
  if (!requestShape(value)) {
    throw new BodyCodecError("Web search request has an unsupported or invalid shape", {
      code: "INVALID_WEB_SEARCH",
    });
  }
  return value;
}

export function projectWebSearchResponse(value) {
  if (!responseShape(value)) {
    throw new BodyCodecError("Web search response has an unsupported or invalid shape", {
      code: "INVALID_WEB_SEARCH",
    });
  }
  const result = { output: value.output };
  if (Object.hasOwn(value, "encrypted_output")) result.encrypted_output = value.encrypted_output;
  if (Object.hasOwn(value, "results")) result.results = value.results;
  return result;
}
