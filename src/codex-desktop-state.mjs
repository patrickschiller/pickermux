import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const LSAPPINFO_PATH = "/usr/bin/lsappinfo";
const CODEX_DESKTOP_BUNDLE_ID = "com.openai.codex";

/** Query LaunchServices without inspecting or signaling any Codex process. */
export async function isCodexDesktopRunning({ execFileImpl = execFile } = {}) {
  if (typeof execFileImpl !== "function") {
    throw new TypeError("An execFile implementation is required");
  }
  let result;
  try {
    result = await execFileImpl(
      LSAPPINFO_PATH,
      ["find", `bundleID=${CODEX_DESKTOP_BUNDLE_ID}`],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    );
  } catch (error) {
    throw new Error("Failed to query Codex Desktop state from LaunchServices", {
      cause: error,
    });
  }
  const stdout = typeof result === "string" ? result : result?.stdout;
  if (typeof stdout !== "string") {
    throw new Error("LaunchServices returned an invalid Codex Desktop state");
  }
  return stdout.trim().length > 0;
}
