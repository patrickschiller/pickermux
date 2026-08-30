import { execFile as execFileCallback } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Prefer a stable package-manager shim only when it resolves to the exact
 * executable running this command. That avoids pinning a versioned Homebrew
 * Cellar path without silently switching the login service to another Node.
 */
export function resolveLaunchAgentNodePath({
  currentPath = process.execPath,
  candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"],
  existsImpl = existsSync,
  realpathImpl = realpathSync,
} = {}) {
  requireString(currentPath, "currentPath");
  let currentRealPath;
  try {
    currentRealPath = realpathImpl(currentPath);
  } catch {
    return currentPath;
  }

  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate || !existsImpl(candidate)) continue;
    try {
      if (realpathImpl(candidate) === currentRealPath) return candidate;
    } catch {
      // Ignore a broken or concurrently replaced candidate.
    }
  }
  return currentPath;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unescapeXml(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

async function writePrivateAtomic(destination, contents, mode = 0o600) {
  const resolved = path.resolve(destination);
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, mode);
  await rename(temporary, resolved);
  return resolved;
}

export function createRuntimeRecord({ configPath, capability, instanceId } = {}) {
  requireString(configPath, "configPath");
  const resolvedCapability = capability ?? randomBytes(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(resolvedCapability)) {
    throw new Error("capability must be a 32-128 character base64url token");
  }
  return {
    version: 1,
    instanceId: instanceId ?? randomUUID(),
    capability: resolvedCapability,
    configPath: path.resolve(configPath),
    createdAt: new Date().toISOString(),
  };
}

export async function writeRuntime(runtimePath, runtime) {
  validateRuntime(runtime);
  await writePrivateAtomic(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
  return runtime;
}

export async function readRuntime(runtimePath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(runtimePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read bridge runtime ${runtimePath}: ${error.message}`, {
      cause: error,
    });
  }
  return validateRuntime(parsed);
}

function validateRuntime(runtime) {
  if (
    runtime?.version !== 1 ||
    typeof runtime.instanceId !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(runtime.capability ?? "") ||
    typeof runtime.configPath !== "string"
  ) {
    throw new Error("Bridge runtime is invalid or unsupported");
  }
  return runtime;
}

export function bridgeBaseUrl(config, runtime) {
  validateRuntime(runtime);
  return `http://${config.bridge.host}:${config.bridge.port}/c/${runtime.capability}/v1`;
}

export function bridgeHealthUrl(config, runtime) {
  validateRuntime(runtime);
  return `http://${config.bridge.host}:${config.bridge.port}/c/${runtime.capability}/health`;
}

export function renderLaunchAgent({
  label,
  nodePath,
  binPath,
  configPath,
  runtimePath,
  workingDirectory,
  logPath,
}) {
  for (const [key, value] of Object.entries({
    label,
    nodePath,
    binPath,
    configPath,
    runtimePath,
    workingDirectory,
    logPath,
  })) {
    requireString(value, key);
  }
  const argumentsXml = [
    nodePath,
    binPath,
    "serve",
    "--config",
    configPath,
    "--runtime",
    runtimePath,
  ]
    .map((argument) => `      <string>${xml(argument)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(workingDirectory)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>Umask</key>
    <integer>63</integer>
    <key>StandardOutPath</key>
    <string>${xml(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(logPath)}</string>
  </dict>
</plist>
`;
}

export async function assertManagedLaunchAgent({
  launchAgentPath,
  launchAgentLabel,
  binPath,
  configPath,
  runtimePath,
  workingDirectory,
  logPath,
} = {}) {
  let metadata;
  try {
    metadata = await lstat(launchAgentPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false };
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Refusing to remove a launch agent that is not a regular file");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("Refusing to remove a launch agent not owned by the current user");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("Refusing to remove a launch agent with non-private permissions");
  }
  const contents = await readFile(launchAgentPath, "utf8");
  const argumentsBlock = contents.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u,
  )?.[1];
  const encodedNodePath = argumentsBlock?.match(/<string>(.*?)<\/string>/u)?.[1];
  if (!encodedNodePath) {
    throw new Error("Refusing to remove an unrecognized launch agent");
  }
  const nodePath = unescapeXml(encodedNodePath);
  if (!path.isAbsolute(nodePath) || /[\u0000\r\n]/u.test(nodePath)) {
    throw new Error("Refusing to remove a launch agent with an invalid Node path");
  }
  const expected = renderLaunchAgent({
    label: launchAgentLabel,
    nodePath,
    binPath,
    configPath,
    runtimePath,
    workingDirectory,
    logPath,
  });
  if (contents !== expected) {
    throw new Error("Refusing to remove a modified or foreign launch agent");
  }
  return {
    present: true,
    nodePath,
    device: metadata.dev,
    inode: metadata.ino,
  };
}

async function serviceLoaded({ label, uid = process.getuid(), execFileImpl = execFile }) {
  try {
    await execFileImpl("/bin/launchctl", ["print", `gui/${uid}/${label}`], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function waitForBridge({
  healthUrl,
  instanceId,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(healthUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(2_000, Math.max(1, deadline - Date.now()))),
      });
      const payload = response.ok ? await response.json() : null;
      if (payload?.ok === true && payload.instanceId === instanceId) return payload;
      lastError = new Error(
        response.ok
          ? "health returned an unexpected bridge instance"
          : `health returned HTTP ${response.status}`,
      );
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Bridge did not become healthy: ${lastError?.message ?? "timeout"}`);
}

export async function startBridgeService({
  config,
  configPath,
  runtimePath,
  launchAgentPath,
  launchAgentLabel,
  logPath,
  binPath,
  workingDirectory,
  nodePath = process.execPath,
  execFileImpl = execFile,
  fetchImpl = globalThis.fetch,
  runtime = createRuntimeRecord({ configPath }),
}) {
  if (await serviceLoaded({ label: launchAgentLabel, execFileImpl })) {
    throw new Error(`Bridge launch agent is already loaded: ${launchAgentLabel}`);
  }

  try {
    await writeRuntime(runtimePath, runtime);
    await mkdir(path.dirname(launchAgentPath), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
    await writeFile(logPath, "", { flag: "a", mode: 0o600 });
    await chmod(logPath, 0o600);
    const plist = renderLaunchAgent({
      label: launchAgentLabel,
      nodePath,
      binPath,
      configPath: path.resolve(configPath),
      runtimePath: path.resolve(runtimePath),
      workingDirectory,
      logPath,
    });
    await writePrivateAtomic(launchAgentPath, plist);
    await execFileImpl(
      "/bin/launchctl",
      ["bootstrap", `gui/${process.getuid()}`, launchAgentPath],
      { encoding: "utf8", timeout: 15_000 },
    );
    const health = await waitForBridge({
      healthUrl: bridgeHealthUrl(config, runtime),
      instanceId: runtime.instanceId,
      fetchImpl,
    });
    return { runtime, health, launchAgentPath, launchAgentLabel };
  } catch (error) {
    await execFileImpl(
      "/bin/launchctl",
      ["bootout", `gui/${process.getuid()}/${launchAgentLabel}`],
      { encoding: "utf8", timeout: 10_000 },
    ).catch(() => {});
    await unlink(launchAgentPath).catch(() => {});
    await unlink(runtimePath).catch(() => {});
    throw new Error(`Could not start bridge service: ${error.message}`, { cause: error });
  }
}

export async function stopBridgeService({
  runtimePath,
  launchAgentPath,
  launchAgentLabel,
  execFileImpl = execFile,
  removeRuntime = true,
  expectedLaunchAgent,
}) {
  const launchAgent = expectedLaunchAgent
    ? await assertManagedLaunchAgent({
        ...expectedLaunchAgent,
        launchAgentPath,
        launchAgentLabel,
      })
    : undefined;
  const loaded = await serviceLoaded({ label: launchAgentLabel, execFileImpl });
  if (loaded && launchAgent?.present === false) {
    throw new Error("Refusing to stop a loaded launch agent whose managed plist is missing");
  }
  if (launchAgent?.present) {
    const confirmed = await assertManagedLaunchAgent({
      ...expectedLaunchAgent,
      launchAgentPath,
      launchAgentLabel,
    });
    if (
      !confirmed.present ||
      confirmed.device !== launchAgent.device ||
      confirmed.inode !== launchAgent.inode
    ) {
      throw new Error("Refusing to stop a launch agent that changed during removal");
    }
  }
  if (loaded) {
    await execFileImpl(
      "/bin/launchctl",
      ["bootout", `gui/${process.getuid()}/${launchAgentLabel}`],
      { encoding: "utf8", timeout: 15_000 },
    );
  }
  if (launchAgent?.present) {
    const quarantinePath = path.join(
      path.dirname(launchAgentPath),
      `.${path.basename(launchAgentPath)}.remove.${process.pid}.${randomBytes(8).toString("hex")}.staging`,
    );
    const quarantine = await lstat(quarantinePath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (quarantine !== null) {
      throw new Error("Refusing to reuse an existing launch-agent quarantine");
    }
    await rename(launchAgentPath, quarantinePath);
    try {
      const staged = await assertManagedLaunchAgent({
        ...expectedLaunchAgent,
        launchAgentPath: quarantinePath,
        launchAgentLabel,
      });
      if (
        !staged.present ||
        staged.device !== launchAgent.device ||
        staged.inode !== launchAgent.inode
      ) {
        throw new Error("Refusing to remove a launch agent replaced during removal");
      }
      await unlink(quarantinePath);
    } catch (error) {
      const replacement = await lstat(launchAgentPath).catch((readError) => {
        if (readError?.code === "ENOENT") return null;
        throw readError;
      });
      const staged = await lstat(quarantinePath).catch((readError) => {
        if (readError?.code === "ENOENT") return null;
        throw readError;
      });
      if (replacement === null && staged !== null) {
        await rename(quarantinePath, launchAgentPath);
      }
      throw error;
    }
    const replacement = await lstat(launchAgentPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (replacement !== null) {
      throw new Error(
        "A new launch agent appeared during removal and was preserved for review",
      );
    }
  } else {
    await unlink(launchAgentPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  if (removeRuntime) {
    await unlink(runtimePath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  return { stopped: loaded, launchAgentRemoved: true, runtimeRemoved: removeRuntime };
}

export async function restartBridgeService({
  config,
  runtimePath,
  launchAgentLabel,
  execFileImpl = execFile,
  fetchImpl = globalThis.fetch,
}) {
  const runtime = await readRuntime(runtimePath);
  if (!(await serviceLoaded({ label: launchAgentLabel, execFileImpl }))) {
    throw new Error(`Bridge launch agent is not loaded: ${launchAgentLabel}`);
  }
  await execFileImpl(
    "/bin/launchctl",
    ["kickstart", "-k", `gui/${process.getuid()}/${launchAgentLabel}`],
    { encoding: "utf8", timeout: 15_000 },
  );
  const health = await waitForBridge({
    healthUrl: bridgeHealthUrl(config, runtime),
    instanceId: runtime.instanceId,
    fetchImpl,
  });
  return { restarted: true, runtime, health };
}

export async function getBridgeServiceStatus({
  config,
  runtimePath,
  launchAgentLabel,
  execFileImpl = execFile,
  fetchImpl = globalThis.fetch,
}) {
  const loaded = await serviceLoaded({ label: launchAgentLabel, execFileImpl });
  let runtime;
  try {
    runtime = await readRuntime(runtimePath);
  } catch {
    return { loaded, healthy: false, status: loaded ? "runtime-missing" : "not-installed" };
  }
  if (!loaded) return { loaded: false, healthy: false, status: "stopped", runtime };
  try {
    const response = await fetchImpl(bridgeHealthUrl(config, runtime), {
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    const health = response.ok ? await response.json() : null;
    const healthy = health?.ok === true && health.instanceId === runtime.instanceId;
    return { loaded, healthy, status: healthy ? "running" : "unhealthy", runtime, health };
  } catch (error) {
    return { loaded, healthy: false, status: "unreachable", runtime, error };
  }
}
