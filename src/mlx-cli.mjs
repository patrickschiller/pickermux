import { createMlxModelManager } from "./mlx-models.mjs";
import { MLX_MIN_CONTEXT_WINDOW, MLX_MAX_CONTEXT_WINDOW } from "./mlx-capabilities.mjs";

export const MLX_COMMANDS = new Set([
  "mlx-load", "mlx-prepare", "mlx-start", "mlx-status", "mlx-stop",
]);

const VALUE_FLAGS = new Map([
  ["--alias", "alias"], ["--revision", "revision"], ["--python", "python"],
  ["--model-dir", "modelDir"], ["--model", "model"], ["--port", "port"],
  ["--context-window", "contextWindow"], ["--max-output-tokens", "maxOutputTokens"],
]);

export function parseMlxArguments(argv) {
  const [command] = argv;
  if (!MLX_COMMANDS.has(command)) throw new Error("Unknown MLX command");
  const options = { command };
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error("MLX options must not be repeated");
    if (flag === "--json") {
      options.json = true;
      seen.add(flag);
    } else if (VALUE_FLAGS.has(flag)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      options[VALUE_FLAGS.get(flag)] = value;
      seen.add(flag);
    } else if (!flag.startsWith("--") && options.repository === undefined &&
      ["mlx-load", "mlx-prepare"].includes(command)) {
      options.repository = flag;
    } else throw new Error("Unknown MLX option");
  }
  const preparing = ["mlx-load", "mlx-prepare"].includes(command);
  if (preparing && (!options.repository || !options.alias || !options.python)) {
    throw new Error(`${command} requires REPOSITORY --alias NAME --python PATH`);
  }
  if (["mlx-start", "mlx-stop"].includes(command) && !options.model) {
    throw new Error(`${command} requires --model NAME`);
  }
  for (const key of ["repository", "alias", "revision", "modelDir", "contextWindow", "maxOutputTokens"]) {
    if (options[key] !== undefined && !preparing) throw new Error(`${key} is supported only when preparing a model`);
  }
  if (options.model && !["mlx-start", "mlx-stop"].includes(command)) throw new Error("--model requires mlx-start or mlx-stop");
  if (options.python && !preparing) throw new Error("--python is supported only when preparing a model");
  if (options.port !== undefined && !["mlx-load", "mlx-start"].includes(command)) throw new Error("--port requires mlx-load or mlx-start");
  for (const [key, low, high] of [["port", 1024, 65535], ["contextWindow", MLX_MIN_CONTEXT_WINDOW, MLX_MAX_CONTEXT_WINDOW], ["maxOutputTokens", 1, 2048]]) {
    if (options[key] === undefined) continue;
    if (!/^\d+$/u.test(options[key])) throw new Error(`${key} must be an integer`);
    options[key] = Number(options[key]);
    if (!Number.isSafeInteger(options[key]) || options[key] < low || options[key] > high) throw new Error(`${key} is outside its supported range`);
  }
  return options;
}

function providerProjection(profile, runtime) {
  return {
    id: "mlx",
    kind: "mlx-chat-completions",
    baseUrl: `http://127.0.0.1:${runtime.port}/v1`,
    allowPrivateNetwork: true,
    models: [{
      id: profile.alias, slug: `mlx/${profile.alias}`, displayName: profile.alias,
      type: "llm", contextWindow: profile.contextWindow,
      mlxProfileDigest: profile.profileDigest,
    }],
  };
}

export async function runMlxCli(argv, { managerFactory = createMlxModelManager, write = (value) => process.stdout.write(value) } = {}) {
  const options = parseMlxArguments(argv);
  const manager = managerFactory({ python: options.python });
  let result;
  if (["mlx-load", "mlx-prepare"].includes(options.command)) {
    const { repository, alias, revision, contextWindow, maxOutputTokens, modelDir } = options;
    const profile = await manager.prepare({ repository, alias, revision, contextWindow, maxOutputTokens, modelDir });
    if (options.command === "mlx-load") {
      const runtime = await manager.start({ profileId: profile.profileId, port: options.port });
      result = { profile, runtime, provider: providerProjection(profile, runtime) };
    } else result = { profile };
  } else if (options.command === "mlx-status") {
    result = await manager.status();
  } else {
    const status = await manager.status();
    const profiles = status.models.filter((entry) => entry.profileId === options.model || entry.alias === options.model);
    if (profiles.length !== 1) throw new Error("Select exactly one prepared MLX model");
    const profile = profiles[0];
    if (options.command === "mlx-start") {
      const runtime = await manager.start({ profileId: profile.profileId, port: options.port });
      result = { profile, runtime, provider: providerProjection(profile, runtime) };
    } else result = await manager.stop({ profileId: profile.profileId });
  }
  // Public projections contain no private paths, control capability or prompts.
  write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}
