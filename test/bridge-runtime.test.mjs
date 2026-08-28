import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bridgeBaseUrl,
  bridgeHealthUrl,
  createRuntimeRecord,
  getBridgeServiceStatus,
  readRuntime,
  renderLaunchAgent,
  resolveLaunchAgentNodePath,
  startBridgeService,
  stopBridgeService,
  waitForBridge,
  writeRuntime,
} from "../src/bridge-runtime.mjs";

const CAPABILITY = "aB_9-".repeat(7).slice(0, 35);
const INSTANCE_ID = "bridge-runtime-test-instance";

function response(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}

function decodeXml(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

async function makeFixture(t, suffix = "") {
  const directory = await mkdtemp(
    path.join(tmpdir(), `lmstudio-bridge-runtime-${suffix}`),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  const configPath = path.join(directory, "configuration", "bridge.json");
  const runtimePath = path.join(directory, "private", "runtime.json");
  const launchAgentPath = path.join(directory, "launch-agents", "bridge.plist");
  const logPath = path.join(directory, "logs", "bridge.log");
  const binPath = path.join(directory, "bin", "lmstudio-picker.mjs");
  const launchAgentLabel = "com.example.codex-model-bridge.test";
  const config = { bridge: { host: "127.0.0.1", port: 4210 } };
  const runtime = createRuntimeRecord({
    configPath,
    capability: CAPABILITY,
    instanceId: INSTANCE_ID,
  });

  return {
    directory,
    config,
    configPath,
    runtimePath,
    launchAgentPath,
    launchAgentLabel,
    logPath,
    binPath,
    runtime,
  };
}

async function assertMissing(filePath) {
  await assert.rejects(access(filePath), (error) => error?.code === "ENOENT");
}

test("runtime records are validated and persisted in a private atomic file", async (t) => {
  const fixture = await makeFixture(t, "private-");

  assert.equal(fixture.runtime.version, 1);
  assert.equal(fixture.runtime.instanceId, INSTANCE_ID);
  assert.equal(fixture.runtime.capability, CAPABILITY);
  assert.equal(fixture.runtime.configPath, path.resolve(fixture.configPath));
  assert.equal(Number.isNaN(Date.parse(fixture.runtime.createdAt)), false);

  const written = await writeRuntime(fixture.runtimePath, fixture.runtime);
  assert.equal(written, fixture.runtime);
  assert.deepEqual(await readRuntime(fixture.runtimePath), fixture.runtime);
  assert.equal((await stat(fixture.runtimePath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(fixture.runtimePath))).mode & 0o777, 0o700);
  assert.equal((await readFile(fixture.runtimePath, "utf8")).endsWith("\n"), true);

  assert.throws(
    () => createRuntimeRecord({ configPath: fixture.configPath, capability: "short" }),
    /32-128 character base64url token/u,
  );
  await writeFile(fixture.runtimePath, '{"version":2}\n');
  await assert.rejects(readRuntime(fixture.runtimePath), /invalid or unsupported/u);
});

test("bridge URLs include the private capability prefix", async (t) => {
  const fixture = await makeFixture(t, "urls-");

  assert.equal(
    bridgeBaseUrl(fixture.config, fixture.runtime),
    `http://127.0.0.1:4210/c/${CAPABILITY}/v1`,
  );
  assert.equal(
    bridgeHealthUrl(fixture.config, fixture.runtime),
    `http://127.0.0.1:4210/c/${CAPABILITY}/health`,
  );
  assert.throws(
    () => bridgeBaseUrl(fixture.config, { version: 2 }),
    /invalid or unsupported/u,
  );
});

test("launch agent XML escapes values and keeps the exact ProgramArguments order", () => {
  const special = `value&<>"'`;
  const values = {
    label: `label-${special}`,
    nodePath: `/node-${special}`,
    binPath: `/bin-${special}`,
    configPath: `/config-${special}`,
    runtimePath: `/runtime-${special}`,
    workingDirectory: `/work-${special}`,
    logPath: `/log-${special}`,
  };

  const plist = renderLaunchAgent(values);
  assert.match(plist, /label-value&amp;&lt;&gt;&quot;&apos;/u);
  assert.doesNotMatch(plist, /label-value&<>/u);

  const argumentsBlock = plist.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u,
  )?.[1];
  assert.ok(argumentsBlock, "ProgramArguments array is present");
  const argumentsList = [...argumentsBlock.matchAll(/<string>(.*?)<\/string>/gu)].map(
    (match) => decodeXml(match[1]),
  );
  assert.deepEqual(argumentsList, [
    values.nodePath,
    values.binPath,
    "serve",
    "--config",
    values.configPath,
    "--runtime",
    values.runtimePath,
  ]);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/u);
  assert.equal(
    [...plist.matchAll(/<key>Standard(?:Out|Error)Path<\/key>\s*<string>(.*?)<\/string>/gu)]
      .map((match) => decodeXml(match[1]))
      .every((value) => value === values.logPath),
    true,
  );
});

test("launch agent prefers only a stable Node path resolving to the active executable", () => {
  const links = new Map([
    ["/cellar/node/26/bin/node", "/cellar/node/26/bin/node"],
    ["/opt/homebrew/bin/node", "/cellar/node/26/bin/node"],
    ["/usr/local/bin/node", "/other/node"],
  ]);
  const options = {
    currentPath: "/cellar/node/26/bin/node",
    candidates: ["/opt/homebrew/bin/node", "/usr/local/bin/node"],
    existsImpl: (candidate) => links.has(candidate),
    realpathImpl: (candidate) => {
      if (!links.has(candidate)) throw new Error("missing");
      return links.get(candidate);
    },
  };
  assert.equal(resolveLaunchAgentNodePath(options), "/opt/homebrew/bin/node");

  assert.equal(
    resolveLaunchAgentNodePath({
      ...options,
      candidates: ["/usr/local/bin/node"],
    }),
    "/cellar/node/26/bin/node",
  );
});

test("waitForBridge accepts only the expected healthy instance", async () => {
  const calls = [];
  const payload = await waitForBridge({
    healthUrl: "http://127.0.0.1:4210/private/health",
    instanceId: INSTANCE_ID,
    timeoutMs: 1_000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ ok: true, instanceId: INSTANCE_ID });
    },
  });

  assert.deepEqual(payload, { ok: true, instanceId: INSTANCE_ID });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:4210/private/health");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
});

test("start writes private artifacts, bootstraps launchd, and verifies health", async (t) => {
  const fixture = await makeFixture(t, "start-");
  const execCalls = [];
  const fetchCalls = [];
  const execFileImpl = async (file, args, options) => {
    execCalls.push({ file, args, options });
    if (args[0] === "print") throw new Error("not loaded");
    assert.equal(args[0], "bootstrap");
    return { stdout: "", stderr: "" };
  };
  const fetchImpl = async (url, options) => {
    fetchCalls.push({ url, options });
    return response({ ok: true, instanceId: INSTANCE_ID, pid: 1234 });
  };

  const result = await startBridgeService({
    ...fixture,
    nodePath: "/private/test-node",
    workingDirectory: fixture.directory,
    execFileImpl,
    fetchImpl,
  });

  assert.equal(result.runtime, fixture.runtime);
  assert.deepEqual(result.health, {
    ok: true,
    instanceId: INSTANCE_ID,
    pid: 1234,
  });
  assert.equal(result.launchAgentPath, fixture.launchAgentPath);
  assert.equal(result.launchAgentLabel, fixture.launchAgentLabel);
  assert.deepEqual(
    execCalls.map(({ file, args }) => [file, ...args]),
    [
      [
        "/bin/launchctl",
        "print",
        `gui/${process.getuid()}/${fixture.launchAgentLabel}`,
      ],
      [
        "/bin/launchctl",
        "bootstrap",
        `gui/${process.getuid()}`,
        fixture.launchAgentPath,
      ],
    ],
  );
  assert.equal(fetchCalls.length, 1);
  assert.equal(
    fetchCalls[0].url,
    `http://127.0.0.1:4210/c/${CAPABILITY}/health`,
  );
  assert.deepEqual(await readRuntime(fixture.runtimePath), fixture.runtime);
  assert.equal((await stat(fixture.runtimePath)).mode & 0o777, 0o600);
  assert.equal((await stat(fixture.launchAgentPath)).mode & 0o777, 0o600);
  assert.equal((await stat(fixture.logPath)).mode & 0o777, 0o600);
  const plist = await readFile(fixture.launchAgentPath, "utf8");
  assert.match(plist, /<string>\/private\/test-node<\/string>/u);
  assert.equal(plist.includes(`<string>${fixture.runtimePath}</string>`), true);
});

test("start rolls back runtime and launch-agent files when bootstrap fails", async (t) => {
  const fixture = await makeFixture(t, "rollback-");
  const execCalls = [];
  const execFileImpl = async (_file, args) => {
    execCalls.push(args);
    if (args[0] === "print") throw new Error("not loaded");
    if (args[0] === "bootstrap") throw new Error("bootstrap denied");
    assert.equal(args[0], "bootout");
    return { stdout: "", stderr: "" };
  };

  await assert.rejects(
    startBridgeService({
      ...fixture,
      nodePath: "/private/test-node",
      workingDirectory: fixture.directory,
      execFileImpl,
      fetchImpl: async () => {
        assert.fail("health must not run after a failed bootstrap");
      },
    }),
    /Could not start bridge service: bootstrap denied/u,
  );

  assert.deepEqual(
    execCalls.map((args) => args[0]),
    ["print", "bootstrap", "bootout"],
  );
  await assertMissing(fixture.runtimePath);
  await assertMissing(fixture.launchAgentPath);
});

test("start cleans private artifacts when setup fails before bootstrap", async (t) => {
  const fixture = await makeFixture(t, "pre-bootstrap-rollback-");
  const execCalls = [];
  const execFileImpl = async (_file, args) => {
    execCalls.push(args[0]);
    if (args[0] === "print") throw new Error("not loaded");
    assert.equal(args[0], "bootout");
    return { stdout: "", stderr: "" };
  };

  await assert.rejects(
    startBridgeService({
      ...fixture,
      binPath: "",
      nodePath: "/private/test-node",
      workingDirectory: fixture.directory,
      execFileImpl,
      fetchImpl: async () => assert.fail("health must not run"),
    }),
    /Could not start bridge service: binPath must be a non-empty string/u,
  );
  assert.deepEqual(execCalls, ["print", "bootout"]);
  await assertMissing(fixture.runtimePath);
  await assertMissing(fixture.launchAgentPath);
});

test("stop boots out a loaded service and removes its managed files", async (t) => {
  const fixture = await makeFixture(t, "stop-");
  await writeRuntime(fixture.runtimePath, fixture.runtime);
  await mkdir(path.dirname(fixture.launchAgentPath), { recursive: true });
  await writeFile(fixture.launchAgentPath, "placeholder", { mode: 0o600 });
  const execCalls = [];
  const execFileImpl = async (_file, args) => {
    execCalls.push(args);
    return { stdout: "", stderr: "" };
  };

  const result = await stopBridgeService({
    ...fixture,
    execFileImpl,
  });

  assert.deepEqual(result, {
    stopped: true,
    launchAgentRemoved: true,
    runtimeRemoved: true,
  });
  assert.deepEqual(
    execCalls.map((args) => args[0]),
    ["print", "bootout"],
  );
  await assertMissing(fixture.runtimePath);
  await assertMissing(fixture.launchAgentPath);
});

test("service status distinguishes installation, process, and health states", async (t) => {
  await t.test("not-installed", async (t) => {
    const fixture = await makeFixture(t, "status-not-installed-");
    const status = await getBridgeServiceStatus({
      ...fixture,
      execFileImpl: async () => {
        throw new Error("not loaded");
      },
      fetchImpl: async () => assert.fail("health must not be requested"),
    });
    assert.deepEqual(status, {
      loaded: false,
      healthy: false,
      status: "not-installed",
    });
  });

  await t.test("runtime-missing", async (t) => {
    const fixture = await makeFixture(t, "status-runtime-missing-");
    const status = await getBridgeServiceStatus({
      ...fixture,
      execFileImpl: async () => ({ stdout: "", stderr: "" }),
      fetchImpl: async () => assert.fail("health must not be requested"),
    });
    assert.deepEqual(status, {
      loaded: true,
      healthy: false,
      status: "runtime-missing",
    });
  });

  await t.test("stopped", async (t) => {
    const fixture = await makeFixture(t, "status-stopped-");
    await writeRuntime(fixture.runtimePath, fixture.runtime);
    const status = await getBridgeServiceStatus({
      ...fixture,
      execFileImpl: async () => {
        throw new Error("not loaded");
      },
      fetchImpl: async () => assert.fail("health must not be requested"),
    });
    assert.equal(status.loaded, false);
    assert.equal(status.healthy, false);
    assert.equal(status.status, "stopped");
    assert.deepEqual(status.runtime, fixture.runtime);
  });

  await t.test("running", async (t) => {
    const fixture = await makeFixture(t, "status-running-");
    await writeRuntime(fixture.runtimePath, fixture.runtime);
    const health = { ok: true, instanceId: INSTANCE_ID };
    const status = await getBridgeServiceStatus({
      ...fixture,
      execFileImpl: async () => ({ stdout: "", stderr: "" }),
      fetchImpl: async (_url, options) => {
        assert.equal(options.redirect, "error");
        assert.equal(options.signal instanceof AbortSignal, true);
        return response(health);
      },
    });
    assert.equal(status.loaded, true);
    assert.equal(status.healthy, true);
    assert.equal(status.status, "running");
    assert.deepEqual(status.health, health);
  });

  await t.test("unhealthy", async (t) => {
    const fixture = await makeFixture(t, "status-unhealthy-");
    await writeRuntime(fixture.runtimePath, fixture.runtime);
    const health = { ok: true, instanceId: "another-instance" };
    const status = await getBridgeServiceStatus({
      ...fixture,
      execFileImpl: async () => ({ stdout: "", stderr: "" }),
      fetchImpl: async () => response(health),
    });
    assert.equal(status.loaded, true);
    assert.equal(status.healthy, false);
    assert.equal(status.status, "unhealthy");
    assert.deepEqual(status.health, health);
  });

  await t.test("unreachable", async (t) => {
    const fixture = await makeFixture(t, "status-unreachable-");
    await writeRuntime(fixture.runtimePath, fixture.runtime);
    const status = await getBridgeServiceStatus({
      ...fixture,
      execFileImpl: async () => ({ stdout: "", stderr: "" }),
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });
    assert.equal(status.loaded, true);
    assert.equal(status.healthy, false);
    assert.equal(status.status, "unreachable");
    assert.match(status.error.message, /connection refused/u);
  });
});
