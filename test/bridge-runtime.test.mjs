import assert from "node:assert/strict";
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bridgeBaseUrl,
  bridgeHealthUrl,
  createRuntimeRecord,
  assertManagedLaunchAgent,
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

async function trackedFileHandle(target, flags, onRead) {
  const handle = await open(target, flags);
  return {
    close: () => handle.close(),
    readFile: async () => {
      onRead();
      return handle.readFile();
    },
    stat: () => handle.stat(),
  };
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

test("runtime reads reject links to native auth before opening the payload", async (t) => {
  await t.test("symbolic link", async (t) => {
    const fixture = await makeFixture(t, "runtime-auth-symlink-");
    const authPath = path.join(fixture.directory, "auth.json");
    const authContents = "native-auth-sentinel\n";
    await mkdir(path.dirname(fixture.runtimePath), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(authPath, authContents, { mode: 0o600 });
    await symlink(authPath, fixture.runtimePath);
    let openCalls = 0;

    await assert.rejects(
      readRuntime(fixture.runtimePath, {
        openImpl: async () => {
          openCalls += 1;
          throw new Error("runtime payload must not be opened");
        },
      }),
      /must be a regular file/iu,
    );

    assert.equal(openCalls, 0);
    assert.equal((await lstat(fixture.runtimePath)).isSymbolicLink(), true);
    assert.equal(await readFile(authPath, "utf8"), authContents);
  });

  await t.test("hard link", async (t) => {
    const fixture = await makeFixture(t, "runtime-auth-hardlink-");
    const authPath = path.join(fixture.directory, "auth.json");
    const authContents = "native-auth-sentinel\n";
    await mkdir(path.dirname(fixture.runtimePath), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(authPath, authContents, { mode: 0o600 });
    await link(authPath, fixture.runtimePath);
    let openCalls = 0;

    await assert.rejects(
      readRuntime(fixture.runtimePath, {
        openImpl: async () => {
          openCalls += 1;
          throw new Error("runtime payload must not be opened");
        },
      }),
      /exactly one hard link/iu,
    );

    assert.equal(openCalls, 0);
    const [authStats, runtimeStats] = await Promise.all([
      lstat(authPath),
      lstat(fixture.runtimePath),
    ]);
    assert.equal(authStats.ino, runtimeStats.ino);
    assert.equal(authStats.nlink, 2);
    assert.equal(runtimeStats.nlink, 2);
    assert.equal(await readFile(authPath, "utf8"), authContents);
    assert.equal(await readFile(fixture.runtimePath, "utf8"), authContents);
  });
});

test("runtime reads reject an inode swap before payload processing", async (t) => {
  const fixture = await makeFixture(t, "runtime-inode-swap-");
  await writeRuntime(fixture.runtimePath, fixture.runtime);
  const originalPath = `${fixture.runtimePath}.original`;
  const replacementPath = `${fixture.runtimePath}.replacement`;
  const replacementContents = "foreign-runtime-payload\n";
  await writeFile(replacementPath, replacementContents, { mode: 0o600 });
  let readCalls = 0;

  await assert.rejects(
    readRuntime(fixture.runtimePath, {
      openImpl: async (target, flags) => {
        await rename(target, originalPath);
        await rename(replacementPath, target);
        return trackedFileHandle(target, flags, () => {
          readCalls += 1;
        });
      },
    }),
    /changed before payload read/iu,
  );

  assert.equal(readCalls, 0);
  assert.equal(await readFile(fixture.runtimePath, "utf8"), replacementContents);
  assert.deepEqual(await readRuntime(originalPath), fixture.runtime);
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

test("managed launch-agent removal validates exact ownership and contents", async (t) => {
  const fixture = await makeFixture(t, "owned-stop-");
  const workingDirectory = fixture.directory;
  const nodePath = "/private/test-node";
  await mkdir(path.dirname(fixture.launchAgentPath), { recursive: true });
  await writeFile(
    fixture.launchAgentPath,
    renderLaunchAgent({
      label: fixture.launchAgentLabel,
      nodePath,
      binPath: fixture.binPath,
      configPath: fixture.configPath,
      runtimePath: fixture.runtimePath,
      workingDirectory,
      logPath: fixture.logPath,
    }),
    { mode: 0o600 },
  );
  const expectedLaunchAgent = {
    binPath: fixture.binPath,
    configPath: fixture.configPath,
    runtimePath: fixture.runtimePath,
    workingDirectory,
    logPath: fixture.logPath,
  };
  const owned = await assertManagedLaunchAgent({
    launchAgentPath: fixture.launchAgentPath,
    launchAgentLabel: fixture.launchAgentLabel,
    ...expectedLaunchAgent,
  });
  assert.equal(owned.present, true);
  assert.equal(owned.nodePath, nodePath);

  await writeFile(fixture.launchAgentPath, "foreign plist\n", { mode: 0o600 });
  let launchctlCalled = false;
  await assert.rejects(
    stopBridgeService({
      ...fixture,
      expectedLaunchAgent,
      execFileImpl: async () => {
        launchctlCalled = true;
        return { stdout: "", stderr: "" };
      },
    }),
    /modified or foreign|unrecognized/iu,
  );
  assert.equal(launchctlCalled, false);
  assert.equal(await readFile(fixture.launchAgentPath, "utf8"), "foreign plist\n");
});

test("managed launch-agent validation rejects links to native auth before opening the payload", async (t) => {
  const expectedLaunchAgent = (fixture) => ({
    launchAgentPath: fixture.launchAgentPath,
    launchAgentLabel: fixture.launchAgentLabel,
    binPath: fixture.binPath,
    configPath: fixture.configPath,
    runtimePath: fixture.runtimePath,
    workingDirectory: fixture.directory,
    logPath: fixture.logPath,
  });

  await t.test("symbolic link", async (t) => {
    const fixture = await makeFixture(t, "launch-agent-auth-symlink-");
    const authPath = path.join(fixture.directory, "auth.json");
    const authContents = "native-auth-sentinel\n";
    await mkdir(path.dirname(fixture.launchAgentPath), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(authPath, authContents, { mode: 0o600 });
    await symlink(authPath, fixture.launchAgentPath);
    let openCalls = 0;

    await assert.rejects(
      assertManagedLaunchAgent({
        ...expectedLaunchAgent(fixture),
        openImpl: async () => {
          openCalls += 1;
          throw new Error("launch-agent payload must not be opened");
        },
      }),
      /not a regular file/iu,
    );

    assert.equal(openCalls, 0);
    assert.equal((await lstat(fixture.launchAgentPath)).isSymbolicLink(), true);
    assert.equal(await readFile(authPath, "utf8"), authContents);
  });

  await t.test("hard link", async (t) => {
    const fixture = await makeFixture(t, "launch-agent-auth-hardlink-");
    const authPath = path.join(fixture.directory, "auth.json");
    const authContents = "native-auth-sentinel\n";
    await mkdir(path.dirname(fixture.launchAgentPath), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(authPath, authContents, { mode: 0o600 });
    await link(authPath, fixture.launchAgentPath);
    let openCalls = 0;

    await assert.rejects(
      assertManagedLaunchAgent({
        ...expectedLaunchAgent(fixture),
        openImpl: async () => {
          openCalls += 1;
          throw new Error("launch-agent payload must not be opened");
        },
      }),
      /more than one hard link/iu,
    );

    assert.equal(openCalls, 0);
    const [authStats, launchAgentStats] = await Promise.all([
      lstat(authPath),
      lstat(fixture.launchAgentPath),
    ]);
    assert.equal(authStats.ino, launchAgentStats.ino);
    assert.equal(authStats.nlink, 2);
    assert.equal(launchAgentStats.nlink, 2);
    assert.equal(await readFile(authPath, "utf8"), authContents);
    assert.equal(await readFile(fixture.launchAgentPath, "utf8"), authContents);
  });
});

test("managed launch-agent validation rejects an inode swap before payload processing", async (t) => {
  const fixture = await makeFixture(t, "launch-agent-inode-swap-");
  const originalPath = `${fixture.launchAgentPath}.original`;
  const replacementPath = `${fixture.launchAgentPath}.replacement`;
  const replacementContents = "foreign-launch-agent-payload\n";
  await mkdir(path.dirname(fixture.launchAgentPath), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    fixture.launchAgentPath,
    renderLaunchAgent({
      label: fixture.launchAgentLabel,
      nodePath: "/private/test-node",
      binPath: fixture.binPath,
      configPath: fixture.configPath,
      runtimePath: fixture.runtimePath,
      workingDirectory: fixture.directory,
      logPath: fixture.logPath,
    }),
    { mode: 0o600 },
  );
  await writeFile(replacementPath, replacementContents, { mode: 0o600 });
  let readCalls = 0;

  await assert.rejects(
    assertManagedLaunchAgent({
      launchAgentPath: fixture.launchAgentPath,
      launchAgentLabel: fixture.launchAgentLabel,
      binPath: fixture.binPath,
      configPath: fixture.configPath,
      runtimePath: fixture.runtimePath,
      workingDirectory: fixture.directory,
      logPath: fixture.logPath,
      openImpl: async (target, flags) => {
        await rename(target, originalPath);
        await rename(replacementPath, target);
        return trackedFileHandle(target, flags, () => {
          readCalls += 1;
        });
      },
    }),
    /changed before payload read/iu,
  );

  assert.equal(readCalls, 0);
  assert.equal(
    await readFile(fixture.launchAgentPath, "utf8"),
    replacementContents,
  );
  assert.equal(
    (await assertManagedLaunchAgent({
      launchAgentPath: originalPath,
      launchAgentLabel: fixture.launchAgentLabel,
      binPath: fixture.binPath,
      configPath: fixture.configPath,
      runtimePath: fixture.runtimePath,
      workingDirectory: fixture.directory,
      logPath: fixture.logPath,
    })).present,
    true,
  );
});

test("managed launch-agent removal restores a file changed after bootout", async (t) => {
  const fixture = await makeFixture(t, "owned-stop-race-");
  const expectedLaunchAgent = {
    binPath: fixture.binPath,
    configPath: fixture.configPath,
    runtimePath: fixture.runtimePath,
    workingDirectory: fixture.directory,
    logPath: fixture.logPath,
  };
  await mkdir(path.dirname(fixture.launchAgentPath), { recursive: true });
  await writeFile(
    fixture.launchAgentPath,
    renderLaunchAgent({
      label: fixture.launchAgentLabel,
      nodePath: "/private/test-node",
      ...expectedLaunchAgent,
    }),
    { mode: 0o600 },
  );
  await writeRuntime(fixture.runtimePath, fixture.runtime);

  await assert.rejects(
    stopBridgeService({
      ...fixture,
      expectedLaunchAgent,
      execFileImpl: async (_file, args) => {
        if (args[0] === "bootout") {
          await writeFile(
            fixture.launchAgentPath,
            "foreign replacement\n",
            { mode: 0o600 },
          );
        }
        return { stdout: "", stderr: "" };
      },
    }),
    /modified or foreign|replaced during removal|unrecognized/iu,
  );
  assert.equal(
    await readFile(fixture.launchAgentPath, "utf8"),
    "foreign replacement\n",
  );
  assert.deepEqual(await readRuntime(fixture.runtimePath), fixture.runtime);
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

  await t.test("update-required", async (t) => {
    const fixture = await makeFixture(t, "status-update-required-");
    await writeRuntime(fixture.runtimePath, fixture.runtime);
    const health = {
      ok: false,
      instanceId: INSTANCE_ID,
      compatibility: {
        status: "update-required",
        reasons: ["codex-client-version"],
      },
    };
    const status = await getBridgeServiceStatus({
      ...fixture,
      execFileImpl: async () => ({ stdout: "", stderr: "" }),
      fetchImpl: async () => response(health),
    });
    assert.equal(status.loaded, true);
    assert.equal(status.healthy, false);
    assert.equal(status.status, "update-required");
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
