import assert from "node:assert/strict";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED } from "../src/account-cache.mjs";
import {
  armFullRefreshLaunchAgent,
  captureFullRefreshBaseline,
  cleanupFullRefreshArtifacts,
  prepareFullRefreshCheckpoint,
  readFullRefreshCheckpoint,
  renderFullRefreshLaunchAgent,
  runFullRefreshWorkflow,
  writeFullRefreshCheckpoint,
} from "../src/full-refresh.mjs";
import { resolveFullRefreshPaths } from "../src/paths.mjs";

const CLIENT_VERSION = "0.153.0";
const BASELINE_FETCHED_AT = "2026-09-02T08:00:00.000Z";
const REFRESHED_AT = "2026-09-02T08:05:00.000Z";
const OPERATION_ID = "full-refresh-test-0001";

function launchctlServiceNotFound() {
  const error = new Error("service not found");
  error.code = 113;
  return error;
}

function baseline(fetchedAt = BASELINE_FETCHED_AT) {
  return { clientVersion: CLIENT_VERSION, fetchedAt };
}

function inspectedCache(
  fetchedAt = REFRESHED_AT,
  {
    codexClientVersion = CLIENT_VERSION,
    cacheClientVersion = CLIENT_VERSION,
  } = {},
) {
  return {
    ready: true,
    status: "ready",
    source: "codex-account-cache",
    codexClientVersion,
    cacheClientVersion,
    fetchedAt,
    catalog: { models: [{ slug: "gpt-test" }] },
  };
}

async function missing(target) {
  await assert.rejects(access(target), (error) => error?.code === "ENOENT");
}

async function fixture(t, suffix = "") {
  const temporary = await mkdtemp(
    path.join(tmpdir(), `pickermux-full-refresh-${suffix}`),
  );
  const installDirectory = await realpath(temporary);
  await chmod(installDirectory, 0o700);
  t.after(() => rm(installDirectory, { recursive: true, force: true }));
  const operationDirectory = path.join(installDirectory, "full-refresh");
  const checkpointPath = path.join(
    operationDirectory,
    "full-refresh-state.json",
  );
  const launchAgentPath = path.join(
    operationDirectory,
    "com.local.pickermux-full-refresh.plist",
  );
  const logPath = path.join(operationDirectory, "full-refresh.log");
  const label = "com.local.pickermux-full-refresh";
  const nodePath = path.join(installDirectory, "node");
  const workerPath = path.join(
    installDirectory,
    "versions",
    "0.5.4",
    "bin",
    "pickermux.mjs",
  );
  const receiptPath = path.join(installDirectory, "install-receipt.json");

  await writeFile(nodePath, "#!/bin/sh\n", { mode: 0o700 });
  await mkdir(path.dirname(workerPath), { recursive: true, mode: 0o700 });
  for (const directory of [
    path.join(installDirectory, "versions"),
    path.join(installDirectory, "versions", "0.5.4"),
    path.dirname(workerPath),
  ]) {
    await chmod(directory, 0o700);
  }
  await writeFile(workerPath, "#!/usr/bin/env node\n", { mode: 0o700 });
  await writeFile(
    receiptPath,
    `${JSON.stringify({
      schemaVersion: 1,
      product: "pickermux",
      owner: "pickermux-cli-installer",
      activeVersion: "0.5.4",
      activeTarget: "versions/0.5.4",
      launcherPath: path.join(installDirectory, "launcher"),
      launcherSha256: "a".repeat(64),
      versions: [{
        version: "0.5.4",
        path: "versions/0.5.4",
        sha256: "b".repeat(64),
      }],
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    installDirectory,
    operationDirectory,
    checkpointPath,
    launchAgentPath,
    logPath,
    label,
    nodePath,
    workerPath,
    receiptPath,
  };
}

async function prepare(paths, options = {}) {
  return prepareFullRefreshCheckpoint({
    installDirectory: paths.installDirectory,
    checkpointPath: paths.checkpointPath,
    baseline: baseline(),
    operationId: OPERATION_ID,
    nowImpl: () => new Date("2026-09-02T08:01:00.000Z"),
    ...options,
  });
}

function callbackDefaults(events, inspectAccountCacheImpl) {
  return {
    quitCodexImpl: async ({ stage }) => events.push(`quit:${stage}`),
    temporarySuspendImpl: async () => events.push("suspend"),
    openNativeCodexImpl: async () => events.push("open-native"),
    inspectAccountCacheImpl,
    reactivateAndDoctorImpl: async () => events.push("reactivate-doctor"),
    finalOpenImpl: async () => events.push("open-final"),
    progressImpl: async ({ phase }) => events.push(`phase:${phase}`),
    sleepImpl: async () => events.push("sleep"),
    nowImpl: () => new Date("2026-09-02T08:10:00.000Z"),
  };
}

test("full refresh runs the confirmation-neutral lifecycle in exact order", async (t) => {
  const paths = await fixture(t, "success-");
  await prepare(paths);
  const events = [];
  let inspections = 0;
  const result = await runFullRefreshWorkflow({
    installDirectory: paths.installDirectory,
    checkpointPath: paths.checkpointPath,
    codexHome: "/private/codex-home",
    codexPath: "/Applications/Codex.app/codex",
    ...callbackDefaults(events, async (options) => {
      events.push(`inspect:${options.codexClientVersion}`);
      inspections += 1;
      return inspectedCache(
        inspections === 1 ? BASELINE_FETCHED_AT : REFRESHED_AT,
      );
    }),
  });

  assert.deepEqual(events, [
    "quit:before-suspend",
    "phase:first-quit-complete",
    "suspend",
    "phase:suspended",
    "open-native",
    "phase:native-opened",
    `inspect:${CLIENT_VERSION}`,
    "sleep",
    `inspect:${CLIENT_VERSION}`,
    "phase:cache-refreshed",
    "quit:before-reactivation",
    "phase:second-quit-complete",
    "reactivate-doctor",
    "phase:reactivated",
    "open-final",
    "phase:completed",
  ]);
  assert.deepEqual(result, {
    completed: true,
    operationId: OPERATION_ID,
    clientVersion: CLIENT_VERSION,
    baselineFetchedAt: BASELINE_FETCHED_AT,
    refreshedCacheFetchedAt: REFRESHED_AT,
  });
  const completed = await readFullRefreshCheckpoint({
    installDirectory: paths.installDirectory,
    checkpointPath: paths.checkpointPath,
    allowMissing: true,
  });
  assert.equal(completed.phase, "completed");
  assert.equal(completed.operationId, OPERATION_ID);
});

test("a graceful quit failure removes prepared state before lifecycle mutation", async (t) => {
  const paths = await fixture(t, "quit-failure-");
  await prepare(paths);
  let suspended = false;
  await assert.rejects(
    runFullRefreshWorkflow({
      installDirectory: paths.installDirectory,
      checkpointPath: paths.checkpointPath,
      quitCodexImpl: async () => {
        throw new Error("quit denied");
      },
      temporarySuspendImpl: async () => {
        suspended = true;
      },
      openNativeCodexImpl: async () => {},
      inspectAccountCacheImpl: async () => inspectedCache(),
      reactivateAndDoctorImpl: async () => {},
      finalOpenImpl: async () => {},
    }),
    /quit denied/u,
  );
  assert.equal(suspended, false);
  await missing(paths.checkpointPath);
});

test("a missing or invalid starting cache produces a null baseline", async (t) => {
  const paths = await fixture(t, "null-baseline-");
  const refreshRequired = new Error("cache details must remain private");
  refreshRequired.code = CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED;
  refreshRequired.codexClientVersion = CLIENT_VERSION;

  assert.deepEqual(
    await captureFullRefreshBaseline({
      codexHome: "/private/codex-home",
      codexPath: "/Applications/Codex.app/codex",
      inspectAccountCacheImpl: async () => {
        throw refreshRequired;
      },
    }),
    { clientVersion: CLIENT_VERSION, fetchedAt: null },
  );
  const prepared = await prepareFullRefreshCheckpoint({
    installDirectory: paths.installDirectory,
    checkpointPath: paths.checkpointPath,
    operationId: OPERATION_ID,
    inspectAccountCacheImpl: async () => {
      throw refreshRequired;
    },
    nowImpl: () => new Date("2026-09-02T08:01:00.000Z"),
  });
  assert.equal(prepared.checkpoint.baselineFetchedAt, null);

  const events = [];
  const result = await runFullRefreshWorkflow({
    installDirectory: paths.installDirectory,
    checkpointPath: paths.checkpointPath,
    ...callbackDefaults(events, async () =>
      inspectedCache("2026-01-01T00:00:00.000Z")),
  });
  assert.equal(result.baselineFetchedAt, null);
  assert.equal(result.refreshedCacheFetchedAt, "2026-01-01T00:00:00.000Z");
});

test("unchanged, mismatched and temporarily invalid caches cannot complete", async (t) => {
  const paths = await fixture(t, "cache-timeout-");
  await prepare(paths);
  const refreshRequired = new Error("temporary cache replacement");
  refreshRequired.code = CODEX_ACCOUNT_CACHE_REFRESH_REQUIRED;
  const responses = [
    inspectedCache(BASELINE_FETCHED_AT),
    inspectedCache(REFRESHED_AT, { cacheClientVersion: "0.152.0" }),
    refreshRequired,
  ];
  const events = [];
  await assert.rejects(
    runFullRefreshWorkflow({
      installDirectory: paths.installDirectory,
      checkpointPath: paths.checkpointPath,
      cacheTimeoutMs: 20,
      cachePollIntervalMs: 10,
      ...callbackDefaults(events, async () => {
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response;
      }),
    }),
    /was not refreshed within 20 ms/u,
  );
  assert.equal(events.filter((event) => event === "sleep").length, 2);
  assert.equal(events.includes("quit:before-reactivation"), false);
  assert.equal(events.includes("reactivate-doctor"), false);
  assert.equal(
    (await readFullRefreshCheckpoint({
      installDirectory: paths.installDirectory,
      checkpointPath: paths.checkpointPath,
    })).phase,
    "native-opened",
  );
});

test("second quit failure is resumable without repeating suspension", async (t) => {
  const paths = await fixture(t, "second-quit-");
  await prepare(paths);
  const firstEvents = [];
  await assert.rejects(
    runFullRefreshWorkflow({
      installDirectory: paths.installDirectory,
      checkpointPath: paths.checkpointPath,
      ...callbackDefaults(firstEvents, async () => inspectedCache()),
      quitCodexImpl: async ({ stage }) => {
        firstEvents.push(`quit:${stage}`);
        if (stage === "before-reactivation") throw new Error("second quit failed");
      },
    }),
    /second quit failed/u,
  );
  assert.equal(
    (await readFullRefreshCheckpoint({
      installDirectory: paths.installDirectory,
      checkpointPath: paths.checkpointPath,
    })).phase,
    "cache-refreshed",
  );

  const resumedEvents = [];
  await runFullRefreshWorkflow({
    installDirectory: paths.installDirectory,
    checkpointPath: paths.checkpointPath,
    ...callbackDefaults(resumedEvents, async () => {
      assert.fail("cache must not be re-read from cache-refreshed");
    }),
  });
  assert.deepEqual(resumedEvents, [
    "quit:before-reactivation",
    "phase:second-quit-complete",
    "reactivate-doctor",
    "phase:reactivated",
    "open-final",
    "phase:completed",
  ]);
});

test("reactivation failure resumes at the doctor-bound activation phase", async (t) => {
  const paths = await fixture(t, "reactivation-");
  await prepare(paths);
  const firstEvents = [];
  await assert.rejects(
    runFullRefreshWorkflow({
      installDirectory: paths.installDirectory,
      checkpointPath: paths.checkpointPath,
      ...callbackDefaults(firstEvents, async () => inspectedCache()),
      reactivateAndDoctorImpl: async () => {
        firstEvents.push("reactivate-doctor");
        throw new Error("doctor rejected activation");
      },
    }),
    /doctor rejected activation/u,
  );
  assert.equal(
    (await readFullRefreshCheckpoint({
      installDirectory: paths.installDirectory,
      checkpointPath: paths.checkpointPath,
    })).phase,
    "second-quit-complete",
  );

  const resumedEvents = [];
  await runFullRefreshWorkflow({
    installDirectory: paths.installDirectory,
    checkpointPath: paths.checkpointPath,
    ...callbackDefaults(resumedEvents, async () => {
      assert.fail("cache must not be read during reactivation resume");
    }),
  });
  assert.deepEqual(resumedEvents, [
    "reactivate-doctor",
    "phase:reactivated",
    "open-final",
    "phase:completed",
  ]);
});

function checkpointAt(phase) {
  const afterCache = [
    "cache-refreshed",
    "second-quit-complete",
    "reactivated",
    "completed",
  ].includes(phase);
  return {
    schemaVersion: 1,
    product: "pickermux",
    kind: "full-refresh",
    operationId: OPERATION_ID,
    phase,
    clientVersion: CLIENT_VERSION,
    baselineFetchedAt: BASELINE_FETCHED_AT,
    refreshedCacheFetchedAt: afterCache ? REFRESHED_AT : null,
    createdAt: "2026-09-02T08:01:00.000Z",
    updatedAt: "2026-09-02T08:02:00.000Z",
  };
}

test("every post-suspension checkpoint phase resumes only remaining work", async (t) => {
  const cases = [
    ["suspended", ["open-native", "inspect", "quit:before-reactivation", "reactivate-doctor", "open-final"]],
    ["native-opened", ["inspect", "quit:before-reactivation", "reactivate-doctor", "open-final"]],
    ["cache-refreshed", ["quit:before-reactivation", "reactivate-doctor", "open-final"]],
    ["second-quit-complete", ["reactivate-doctor", "open-final"]],
    ["reactivated", ["open-final"]],
    ["completed", []],
  ];
  for (const [phase, expected] of cases) {
    await t.test(phase, async (t) => {
      const paths = await fixture(t, `resume-${phase}-`);
      await writeFullRefreshCheckpoint({
        installDirectory: paths.installDirectory,
        checkpointPath: paths.checkpointPath,
        checkpoint: checkpointAt(phase),
      });
      const events = [];
      await runFullRefreshWorkflow({
        installDirectory: paths.installDirectory,
        checkpointPath: paths.checkpointPath,
        quitCodexImpl: async ({ stage }) => events.push(`quit:${stage}`),
        temporarySuspendImpl: async () => events.push("suspend"),
        openNativeCodexImpl: async () => events.push("open-native"),
        inspectAccountCacheImpl: async () => {
          events.push("inspect");
          return inspectedCache();
        },
        reactivateAndDoctorImpl: async () => events.push("reactivate-doctor"),
        finalOpenImpl: async () => events.push("open-final"),
        nowImpl: () => new Date("2026-09-02T08:10:00.000Z"),
      });
      assert.deepEqual(events, expected);
    });
  }
});

test("checkpoint preparation is private, atomic and resumable", async (t) => {
  const paths = await fixture(t, "checkpoint-");
  const initial = await prepare(paths);
  const resumed = await prepare(paths, {
    operationId: "ignored-on-resume-0002",
  });
  assert.equal(initial.resumed, false);
  assert.equal(resumed.resumed, true);
  assert.deepEqual(resumed.checkpoint, initial.checkpoint);
  assert.equal((await stat(paths.operationDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.checkpointPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(paths.operationDirectory), [
    "full-refresh-state.json",
  ]);
  const raw = await readFile(paths.checkpointPath, "utf8");
  assert.doesNotMatch(raw, /token|credential|capability|catalog|model/iu);
});

test("allowMissing checkpoint reads are read-only for absent directories", async (t) => {
  const parent = await realpath(await mkdtemp(
    path.join(tmpdir(), "pickermux-full-refresh-readonly-"),
  ));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await chmod(parent, 0o700);
  const missingInstall = path.join(parent, "missing-install");
  const missingInstallCheckpoint = path.join(
    missingInstall,
    "full-refresh",
    "checkpoint.json",
  );
  assert.equal(
    await readFullRefreshCheckpoint({
      installDirectory: missingInstall,
      checkpointPath: missingInstallCheckpoint,
      allowMissing: true,
    }),
    null,
  );
  await missing(missingInstall);

  const operationDirectory = path.join(parent, "full-refresh");
  assert.equal(
    await readFullRefreshCheckpoint({
      installDirectory: parent,
      checkpointPath: path.join(operationDirectory, "checkpoint.json"),
      allowMissing: true,
    }),
    null,
  );
  await missing(operationDirectory);
});

test("checkpoint reads reject escaping paths, links, public modes and extra fields", async (t) => {
  await t.test("outside install directory", async (t) => {
    const paths = await fixture(t, "outside-");
    await assert.rejects(
      readFullRefreshCheckpoint({
        installDirectory: paths.installDirectory,
        checkpointPath: path.join(path.dirname(paths.installDirectory), "outside.json"),
        allowMissing: true,
      }),
      /below the PickerMux install directory/u,
    );
  });

  for (const kind of ["symbolic link", "hard link"]) {
    await t.test(kind, async (t) => {
      const paths = await fixture(t, `${kind.replace(" ", "-")}-`);
      await mkdir(paths.operationDirectory, { mode: 0o700 });
      const foreign = path.join(paths.installDirectory, "auth.json");
      await writeFile(foreign, '{"token":"must-not-be-read"}\n', { mode: 0o600 });
      if (kind === "symbolic link") {
        await symlink(foreign, paths.checkpointPath);
      } else {
        await link(foreign, paths.checkpointPath);
      }
      await assert.rejects(
        readFullRefreshCheckpoint({
          installDirectory: paths.installDirectory,
          checkpointPath: paths.checkpointPath,
        }),
        kind === "symbolic link" ? /regular file/u : /one hard link/u,
      );
      assert.equal(await readFile(foreign, "utf8"), '{"token":"must-not-be-read"}\n');
    });
  }

  await t.test("public checkpoint mode", async (t) => {
    const paths = await fixture(t, "public-file-");
    await prepare(paths);
    await chmod(paths.checkpointPath, 0o644);
    await assert.rejects(
      readFullRefreshCheckpoint({
        installDirectory: paths.installDirectory,
        checkpointPath: paths.checkpointPath,
      }),
      /permissions are unsafe/u,
    );
  });

  await t.test("unsupported secret-like field", async (t) => {
    const paths = await fixture(t, "secret-field-");
    await prepare(paths);
    const parsed = JSON.parse(await readFile(paths.checkpointPath, "utf8"));
    parsed.token = "must-not-be-accepted";
    await writeFile(paths.checkpointPath, `${JSON.stringify(parsed)}\n`, {
      mode: 0o600,
    });
    await assert.rejects(
      readFullRefreshCheckpoint({
        installDirectory: paths.installDirectory,
        checkpointPath: paths.checkpointPath,
      }),
      /unsupported or sensitive fields/u,
    );
  });

  await t.test("symbolic operation directory", async (t) => {
    const paths = await fixture(t, "symlink-directory-");
    const foreign = path.join(paths.installDirectory, "foreign");
    await mkdir(foreign, { mode: 0o700 });
    await symlink(foreign, paths.operationDirectory);
    await assert.rejects(
      readFullRefreshCheckpoint({
        installDirectory: paths.installDirectory,
        checkpointPath: paths.checkpointPath,
        allowMissing: true,
      }),
      /directory must be real/u,
    );
  });
});

test("resolved full-refresh artifacts share a dedicated private subdirectory", () => {
  const resolved = resolveFullRefreshPaths({
    HOME: "/Users/tester",
    CODEX_HOME: "/Users/tester/.codex",
  });
  assert.equal(
    resolved.operationDirectory,
    "/Users/tester/Library/Application Support/PickerMux/full-refresh",
  );
  for (const target of [
    resolved.checkpointPath,
    resolved.launchAgentPath,
    resolved.logPath,
  ]) {
    assert.equal(path.dirname(target), resolved.operationDirectory);
  }
});

function artifactOptions(paths) {
  return {
    installDirectory: paths.installDirectory,
    label: paths.label,
    nodePath: paths.nodePath,
    workerPath: paths.workerPath,
    checkpointPath: paths.checkpointPath,
    launchAgentPath: paths.launchAgentPath,
    logPath: paths.logPath,
  };
}

test("one-shot LaunchAgent is receipt-bound, private and non-restarting", async (t) => {
  const paths = await fixture(t, "launch-agent-");
  await prepare(paths);
  const calls = [];
  const armed = await armFullRefreshLaunchAgent({
    ...artifactOptions(paths),
    receiptPath: paths.receiptPath,
    execFileImpl: async (file, args, options) => {
      calls.push([file, args, options]);
      if (args[0] === "print") throw launchctlServiceNotFound();
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(armed.workerPath, paths.workerPath);
  assert.match(armed.receiptSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(calls.map(([, args]) => args[0]), ["print", "bootstrap"]);
  assert.deepEqual(calls.at(-1), [
    "/bin/launchctl",
    ["bootstrap", `gui/${process.getuid()}`, paths.launchAgentPath],
    { encoding: "utf8", timeout: 15_000 },
  ]);
  const plist = await readFile(paths.launchAgentPath, "utf8");
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/u);
  assert.match(plist, /<key>LaunchOnlyOnce<\/key>\s*<true\/>/u);
  assert.match(plist, /<key>ProcessType<\/key>\s*<string>Background<\/string>/u);
  assert.match(plist, /<string>refresh<\/string>/u);
  assert.match(plist, /<string>--full-worker<\/string>/u);
  assert.equal((await stat(paths.launchAgentPath)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.logPath)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.operationDirectory)).mode & 0o777, 0o700);
});

test("arming replaces only an exact old loaded one-shot job", async (t) => {
  const paths = await fixture(t, "rearm-");
  await prepare(paths);
  let loaded = false;
  const actions = [];
  const execFileImpl = async (_file, args) => {
    actions.push(args[0]);
    if (args[0] === "print" && !loaded) {
      throw launchctlServiceNotFound();
    }
    if (args[0] === "bootstrap") loaded = true;
    if (args[0] === "bootout") loaded = false;
    return { stdout: "", stderr: "" };
  };
  await armFullRefreshLaunchAgent({
    ...artifactOptions(paths),
    receiptPath: paths.receiptPath,
    execFileImpl,
  });
  await armFullRefreshLaunchAgent({
    ...artifactOptions(paths),
    receiptPath: paths.receiptPath,
    execFileImpl,
  });
  assert.deepEqual(actions, [
    "print",
    "bootstrap",
    "print",
    "bootout",
    "bootstrap",
  ]);
});

test("arming fails closed when launchctl cannot determine job state", async (t) => {
  const paths = await fixture(t, "rearm-indeterminate-");
  await prepare(paths);
  await armFullRefreshLaunchAgent({
    ...artifactOptions(paths),
    receiptPath: paths.receiptPath,
    execFileImpl: async (_file, args) => {
      if (args[0] === "print") throw launchctlServiceNotFound();
      return { stdout: "", stderr: "" };
    },
  });
  const expectedPlist = await readFile(paths.launchAgentPath);
  const actions = [];
  const timeout = new Error("launchctl timed out");
  timeout.code = "ETIMEDOUT";

  await assert.rejects(
    armFullRefreshLaunchAgent({
      ...artifactOptions(paths),
      receiptPath: paths.receiptPath,
      execFileImpl: async (_file, args) => {
        actions.push(args[0]);
        if (args[0] === "print") throw timeout;
        return { stdout: "", stderr: "" };
      },
    }),
    /failed to inspect the full-refresh worker/iu,
  );

  assert.deepEqual(actions, ["print"]);
  assert.deepEqual(await readFile(paths.launchAgentPath), expectedPlist);
});

test("arming preserves ownership state unless bootstrap is proven not loaded", async (t) => {
  for (const outcome of ["loaded", "indeterminate", "not-loaded"]) {
    await t.test(outcome, async (t) => {
      const paths = await fixture(t, `bootstrap-${outcome}-`);
      await prepare(paths);
      const actions = [];
      let printCalls = 0;
      const bootstrapError = new Error("bootstrap result was not successful");
      bootstrapError.code = "ETIMEDOUT";

      await assert.rejects(
        armFullRefreshLaunchAgent({
          ...artifactOptions(paths),
          receiptPath: paths.receiptPath,
          execFileImpl: async (_file, args) => {
            actions.push(args[0]);
            if (args[0] === "print") {
              printCalls += 1;
              if (printCalls === 1 || outcome === "not-loaded") {
                throw launchctlServiceNotFound();
              }
              if (outcome === "indeterminate") {
                const inspectionError = new Error("launchctl inspection failed");
                inspectionError.code = "EIO";
                throw inspectionError;
              }
              return { stdout: "", stderr: "" };
            }
            if (args[0] === "bootstrap") throw bootstrapError;
            return { stdout: "", stderr: "" };
          },
        }),
        outcome === "indeterminate"
          ? /launchd state is indeterminate/iu
          : /failed to arm full-refresh worker/iu,
      );

      assert.deepEqual(actions, ["print", "bootstrap", "print"]);
      if (outcome === "not-loaded") {
        await missing(paths.launchAgentPath);
      } else {
        assert.equal((await lstat(paths.launchAgentPath)).isFile(), true);
      }
      assert.equal((await lstat(paths.checkpointPath)).isFile(), true);
      assert.equal((await lstat(paths.logPath)).isFile(), true);
    });
  }
});

test("resumable cleanup removes the helper but retains checkpoint and log", async (t) => {
  const paths = await fixture(t, "cleanup-resume-");
  await prepare(paths);
  await armFullRefreshLaunchAgent({
    ...artifactOptions(paths),
    receiptPath: paths.receiptPath,
    execFileImpl: async (_file, args) => {
      if (args[0] === "print") throw launchctlServiceNotFound();
      return { stdout: "", stderr: "" };
    },
  });
  const actions = [];
  const result = await cleanupFullRefreshArtifacts({
    successful: false,
    ...artifactOptions(paths),
    execFileImpl: async (_file, args) => {
      actions.push(args[0]);
      return { stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(result, {
    successful: false,
    launchAgentRemoved: true,
    resumableStateRetained: true,
  });
  assert.deepEqual(actions, ["print", "bootout"]);
  await missing(paths.launchAgentPath);
  assert.equal((await lstat(paths.checkpointPath)).isFile(), true);
  assert.equal((await lstat(paths.logPath)).isFile(), true);
  assert.equal((await lstat(paths.operationDirectory)).isDirectory(), true);
});

test("successful cleanup removes only the empty operation directory and is idempotent", async (t) => {
  const paths = await fixture(t, "cleanup-success-");
  await prepare(paths);
  await armFullRefreshLaunchAgent({
    ...artifactOptions(paths),
    receiptPath: paths.receiptPath,
    execFileImpl: async (_file, args) => {
      if (args[0] === "print") throw launchctlServiceNotFound();
      return { stdout: "", stderr: "" };
    },
  });
  const calls = [];
  const signalEvents = [];
  await cleanupFullRefreshArtifacts({
    successful: true,
    ...artifactOptions(paths),
    execFileImpl: async (_file, args) => {
      calls.push(args[0]);
      if (args[0] === "bootout") {
        for (const target of [
          paths.launchAgentPath,
          paths.checkpointPath,
          paths.logPath,
        ]) {
          await access(target);
        }
      }
      return { stdout: "", stderr: "" };
    },
    processImpl: {
      on(eventName) {
        signalEvents.push(`on:${eventName}`);
      },
      off(eventName) {
        signalEvents.push(`off:${eventName}`);
      },
    },
  });
  await missing(paths.operationDirectory);
  assert.equal((await lstat(paths.installDirectory)).isDirectory(), true);
  assert.deepEqual(calls, ["print", "bootout"]);
  assert.deepEqual(signalEvents, ["on:SIGTERM", "off:SIGTERM"]);

  const second = await cleanupFullRefreshArtifacts({
    successful: true,
    ...artifactOptions(paths),
    execFileImpl: async () => assert.fail("missing plist must not unload a job"),
  });
  assert.deepEqual(second, {
    successful: true,
    launchAgentRemoved: false,
    resumableStateRetained: false,
  });
});

test("cleanup preserves recovery state when launchctl bootout fails", async (t) => {
  const paths = await fixture(t, "cleanup-bootout-failure-");
  await prepare(paths);
  await armFullRefreshLaunchAgent({
    ...artifactOptions(paths),
    receiptPath: paths.receiptPath,
    execFileImpl: async (_file, args) => {
      if (args[0] === "print") throw launchctlServiceNotFound();
      return { stdout: "", stderr: "" };
    },
  });
  const expected = new Map();
  for (const target of [
    paths.launchAgentPath,
    paths.checkpointPath,
    paths.logPath,
  ]) {
    expected.set(target, await readFile(target));
  }
  const actions = [];
  const signalEvents = [];

  await assert.rejects(
    cleanupFullRefreshArtifacts({
      successful: true,
      ...artifactOptions(paths),
      execFileImpl: async (_file, args) => {
        actions.push(args[0]);
        if (args[0] === "bootout") {
          const error = new Error("transient launchctl failure");
          error.code = "EIO";
          throw error;
        }
        return { stdout: "", stderr: "" };
      },
      processImpl: {
        on(eventName) {
          signalEvents.push(`on:${eventName}`);
        },
        off(eventName) {
          signalEvents.push(`off:${eventName}`);
        },
      },
    }),
    /failed to unload the full-refresh worker/iu,
  );

  assert.deepEqual(actions, ["print", "bootout"]);
  assert.deepEqual(signalEvents, ["on:SIGTERM", "off:SIGTERM"]);
  for (const [target, contents] of expected) {
    assert.deepEqual(await readFile(target), contents);
  }
  assert.equal((await lstat(paths.operationDirectory)).isDirectory(), true);
});

test("cleanup treats only launchctl service-not-found as unloaded", async (t) => {
  const paths = await fixture(t, "cleanup-unloaded-");
  await prepare(paths);
  await armFullRefreshLaunchAgent({
    ...artifactOptions(paths),
    receiptPath: paths.receiptPath,
    execFileImpl: async (_file, args) => {
      if (args[0] === "print") throw launchctlServiceNotFound();
      return { stdout: "", stderr: "" };
    },
  });
  const actions = [];

  await cleanupFullRefreshArtifacts({
    successful: true,
    ...artifactOptions(paths),
    execFileImpl: async (_file, args) => {
      actions.push(args[0]);
      if (args[0] === "print") throw launchctlServiceNotFound();
      return { stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(actions, ["print"]);
  await missing(paths.operationDirectory);
});

test("cleanup preserves every artifact when launchctl state is indeterminate", async (t) => {
  const paths = await fixture(t, "cleanup-indeterminate-");
  await prepare(paths);
  await armFullRefreshLaunchAgent({
    ...artifactOptions(paths),
    receiptPath: paths.receiptPath,
    execFileImpl: async (_file, args) => {
      if (args[0] === "print") throw launchctlServiceNotFound();
      return { stdout: "", stderr: "" };
    },
  });
  const expected = new Map();
  for (const target of [
    paths.launchAgentPath,
    paths.checkpointPath,
    paths.logPath,
  ]) {
    expected.set(target, await readFile(target));
  }
  const actions = [];
  const permissionError = new Error("launchctl denied inspection");
  permissionError.code = "EACCES";

  await assert.rejects(
    cleanupFullRefreshArtifacts({
      successful: true,
      ...artifactOptions(paths),
      execFileImpl: async (_file, args) => {
        actions.push(args[0]);
        if (args[0] === "print") throw permissionError;
        return { stdout: "", stderr: "" };
      },
    }),
    /failed to inspect the full-refresh worker/iu,
  );

  assert.deepEqual(actions, ["print"]);
  for (const [target, contents] of expected) {
    assert.deepEqual(await readFile(target), contents);
  }
  assert.equal((await lstat(paths.operationDirectory)).isDirectory(), true);
});

test("LaunchAgent arming and cleanup reject unsafe or modified state", async (t) => {
  await t.test("worker outside receipt target", async (t) => {
    const paths = await fixture(t, "foreign-worker-");
    await prepare(paths);
    const foreignWorker = path.join(paths.installDirectory, "foreign-worker.mjs");
    await writeFile(foreignWorker, "#!/usr/bin/env node\n", { mode: 0o700 });
    await assert.rejects(
      armFullRefreshLaunchAgent({
        ...artifactOptions(paths),
        workerPath: foreignWorker,
        receiptPath: paths.receiptPath,
        execFileImpl: async () => assert.fail("launchctl must not run"),
      }),
      /not the receipt-owned active worker/u,
    );
  });

  for (const kind of ["symbolic link", "hard link"]) {
    await t.test(`${kind} plist`, async (t) => {
      const paths = await fixture(t, `${kind.replace(" ", "-")}-plist-`);
      await prepare(paths);
      const foreign = path.join(paths.installDirectory, "foreign.plist");
      await writeFile(foreign, "foreign\n", { mode: 0o600 });
      if (kind === "symbolic link") {
        await symlink(foreign, paths.launchAgentPath);
      } else {
        await link(foreign, paths.launchAgentPath);
      }
      await assert.rejects(
        armFullRefreshLaunchAgent({
          ...artifactOptions(paths),
          receiptPath: paths.receiptPath,
          execFileImpl: async () => assert.fail("launchctl must not run"),
        }),
        kind === "symbolic link" ? /regular file/u : /one hard link/u,
      );
      assert.equal(await readFile(foreign, "utf8"), "foreign\n");
    });
  }

  await t.test("public receipt", async (t) => {
    const paths = await fixture(t, "public-receipt-");
    await prepare(paths);
    await chmod(paths.receiptPath, 0o644);
    await assert.rejects(
      armFullRefreshLaunchAgent({
        ...artifactOptions(paths),
        receiptPath: paths.receiptPath,
        execFileImpl: async () => assert.fail("launchctl must not run"),
      }),
      /permissions are unsafe/u,
    );
  });

  await t.test("modified plist cleanup", async (t) => {
    const paths = await fixture(t, "modified-cleanup-");
    await prepare(paths);
    await armFullRefreshLaunchAgent({
      ...artifactOptions(paths),
      receiptPath: paths.receiptPath,
      execFileImpl: async (_file, args) => {
        if (args[0] === "print") throw launchctlServiceNotFound();
        return { stdout: "", stderr: "" };
      },
    });
    await writeFile(paths.launchAgentPath, "modified\n", { mode: 0o600 });
    await assert.rejects(
      cleanupFullRefreshArtifacts({
        successful: false,
        ...artifactOptions(paths),
        execFileImpl: async () => assert.fail("launchctl must not run"),
      }),
      /modified full-refresh state/u,
    );
    assert.equal(await readFile(paths.launchAgentPath, "utf8"), "modified\n");
  });

  await t.test("path outside private install directory", async (t) => {
    const paths = await fixture(t, "outside-plist-");
    assert.throws(
      () => renderFullRefreshLaunchAgent({
        ...artifactOptions(paths),
        launchAgentPath: path.join(path.dirname(paths.installDirectory), "job.plist"),
      }),
      /below the PickerMux install directory/u,
    );
  });
});
