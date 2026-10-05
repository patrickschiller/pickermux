import assert from "node:assert/strict";
import test from "node:test";
import { parseMlxArguments, runMlxCli } from "../src/mlx-cli.mjs";

const profile = {
  profileId: "example-profile", alias: "example-model", contextWindow: 8192,
  profileDigest: `sha256:${"a".repeat(64)}`,
};

test("MLX load resolves a prepared immutable profile and emits a conservative provider", async () => {
  const calls = [];
  let output;
  const result = await runMlxCli([
    "mlx-load", "example/model", "--alias", profile.alias, "--python", "/private/test/bin/python",
    "--revision", "main", "--port", "8081", "--context-window", "8192", "--max-output-tokens", "1024",
  ], {
    write: (value) => { output = value; },
    managerFactory: (options) => {
      assert.equal(options.python, "/private/test/bin/python");
      return {
        async prepare(value) { calls.push(["prepare", value]); return profile; },
        async start(value) { calls.push(["start", value]); return { profileId: profile.profileId, port: 8081 }; },
      };
    },
  });
  assert.equal(calls[0][0], "prepare");
  assert.deepEqual(calls[1], ["start", { profileId: profile.profileId, port: 8081 }]);
  assert.equal(result.provider.models[0].mlxProfileDigest, profile.profileDigest);
  assert.equal(result.provider.baseUrl, "http://127.0.0.1:8081/v1");
  assert.equal(result.provider.models[0].slug, "mlx/example-model");
  assert.doesNotMatch(output, /private\/test|capability|toolsEnabled|credential/u);
});

test("MLX start and stop require an unambiguous owned prepared identity", async () => {
  for (const command of ["mlx-start", "mlx-stop"]) {
    let selected;
    const options = { write: () => {}, managerFactory: () => ({
      status: async () => ({ models: [profile] }),
      start: async (value) => { selected = value; return { port: 8081 }; },
      stop: async (value) => { selected = value; return { stopped: true }; },
    }) };
    await runMlxCli([command, "--model", profile.alias], options);
    assert.equal(selected.profileId, profile.profileId);
    await assert.rejects(runMlxCli([command, "--model", "unknown"], options), /exactly one/u);
    options.managerFactory = () => ({ status: async () => ({ models: [profile, profile] }) });
    await assert.rejects(runMlxCli([command, "--model", profile.alias], options), /exactly one/u);
  }
});

test("MLX argument boundary rejects ambiguous commands, flags and invalid limits", () => {
  const load = ["mlx-load", "example/model", "--alias", "example", "--python", "/private/test/python"];
  for (const argv of [
    ["mlx-load"], ["mlx-start"], ["mlx-stop"], ["mlx-status", "--alias", "example"],
    [...load, "--port", "0"], [...load, "--port", "8081oops"], [...load, "--port", "65536"],
    [...load, "--context-window", "8193"], [...load, "--max-output-tokens", "0"],
    [...load, "--alias", "second"], [...load, "--revision"], [...load, "second/repo"],
    [...load, "--config", "/private/config"], ["mlx-prepare", ...load.slice(1), "--port", "8081"],
  ]) assert.throws(() => parseMlxArguments(argv));
});

test("failed preparation cannot start a runtime or publish configuration", async () => {
  let writes = 0;
  let starts = 0;
  await assert.rejects(runMlxCli([
    "mlx-load", "example/model", "--alias", "example", "--python", "/private/test/python",
  ], { write: () => { writes += 1; }, managerFactory: () => ({
    prepare: async () => { throw new Error("Snapshot verification failed"); },
    start: async () => { starts += 1; },
  }) }));
  assert.equal(writes, 0);
  assert.equal(starts, 0);
});
