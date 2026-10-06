import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import * as fs from "node:fs/promises";
import { mkdtemp, rm, writeFile, chmod, readFile, symlink } from "node:fs/promises";
import { createMlxModelManager, computeMlxProfileDigest } from "../src/mlx-models.mjs";

const versions = { mlx: "0.32.3", "mlx-lm": "0.32.0", transformers: "5.7.0", "huggingface-hub": "1.5.0" };
const revision = "a".repeat(40);
const spec = { repository: "example/Test-MLX", alias: "test-mlx", contextWindow: 8192, maxOutputTokens: 1024 };
const fileNames = ["config.json", "tokenizer_config.json", "model.safetensors"];

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pickermux-mlx-models-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const python = path.join(temp, "python");
  await writeFile(python, "fixture interpreter", { mode: 0o700 });
  const directory = path.join(temp, "private-store");
  const calls = [];
  let failPrepare = false;
  let failStart = false;
  let busy = false;
  let alive = false;
  const runHelper = async ({ request }) => {
    calls.push(request);
    if (request.action === "verify") return { verified: true };
    if (request.action === "plan") return { schemaVersion: 1, ...request.spec, revision, modelType: "llama", customArchitecture: null, runtimeVersions: versions, files: fileNames.map((name) => ({ name, bytes: 1, hashKind: "sha256", hash: "b".repeat(64) })) };
    if (request.action === "prepare" && failPrepare) throw new Error("private prompt and credential must not escape");
    const plan = request.plan ?? { schemaVersion: 1, ...request.spec, revision, modelType: "llama", customArchitecture: null, runtimeVersions: versions };
    const profile = { ...plan, kind: "pickermux-mlx-profile", files: fileNames.map((name) => ({ name, bytes: 1, sha256: "b".repeat(64) })), snapshotDirectory: request.directory };
    profile.profileDigest = computeMlxProfileDigest(profile);
    return profile;
  };
  const dependencies = {
    directory, python, runHelper,
    startRuntime: async ({ port }) => { if (failStart) throw new Error("secret runtime path"); alive = true; return { port: port || 32123, pid: 424242 }; },
    probeRuntime: async () => { if (!alive) throw new Error("private capability"); return {}; },
    stopRuntime: async () => { if (busy) { const error = new Error("busy"); error.code = "MLX_MODEL_BUSY"; throw error; } alive = false; return {}; },
    isProcessAlive: (pid) => pid === process.pid || alive,
    wait: async () => {},
  };
  return { temp, directory, python, calls, dependencies, manager: createMlxModelManager(dependencies), prepareFailure: (value) => { failPrepare = value; }, startFailure: (value) => { failStart = value; }, setBusy: (value) => { busy = value; } };
}

test("MLX profiles bind immutable revision and actual context; public lifecycle hides control data", async (t) => {
  const f = await fixture(t);
  const profile = await f.manager.prepare(spec);
  assert.match(profile.profileDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(profile.revision, revision);
  assert.equal(profile.contextWindow, 8192);
  const runtime = await f.manager.start({ profileId: profile.profileId, port: 32123 });
  assert.equal(runtime.status, "running");
  assert.equal(runtime.port, 32123);
  const status = await f.manager.status();
  assert.equal(status.models[0].status, "running");
  for (const sensitive of [f.directory, f.python, "capability", "instanceId", "424242", "snapshotDirectory"]) assert.ok(!JSON.stringify(status).includes(sensitive));
  const state = JSON.parse(await readFile(path.join(f.directory, "models.json"), "utf8"));
  assert.equal(state.profiles[profile.profileId].python, f.python);
  assert.equal(state.runtimes[profile.profileId].capability.length, 64);
  const withoutInterpreter = createMlxModelManager({ ...f.dependencies, python: undefined });
  assert.equal((await withoutInterpreter.start({ alias: spec.alias })).port, 32123);
  assert.equal((await withoutInterpreter.stop({ alias: spec.alias })).status, "stopped");
  assert.equal((await f.manager.status()).models[0].status, "prepared");
});

test("a larger context uses a new immutable profile without reassigning the existing alias", async (t) => {
  const f = await fixture(t);
  const original = await f.manager.prepare(spec);
  await assert.rejects(f.manager.prepare({ ...spec, contextWindow: 262_144 }), { code: "MLX_STORE_CONFLICT" });
  const large = await f.manager.prepare({ ...spec, alias: "test-mlx-262k", contextWindow: 262_144 });
  assert.notEqual(large.profileDigest, original.profileDigest);
  assert.equal(large.contextWindow, 262_144);
  const stored = await f.manager.status();
  assert.equal(stored.models.length, 2);
  assert.equal(stored.models.find((entry) => entry.alias === spec.alias).profileDigest, original.profileDigest);
  assert.equal((await f.manager.start({ profileId: large.profileId, port: 32123 })).contextWindow, 262_144);
});

test("failed preparation resumes the stored immutable plan and preserves prepared models", async (t) => {
  const f = await fixture(t);
  const original = await f.manager.prepare(spec);
  f.prepareFailure(true);
  await assert.rejects(f.manager.prepare({ ...spec, alias: "second" }), (error) => error.code === "MLX_MODEL_INVALID" && !error.message.includes("credential"));
  const during = await f.manager.status();
  assert.equal(during.models[0].profileId, original.profileId);
  assert.deepEqual(during.pending, [{ alias: "second", repository: spec.repository, status: "preparing" }]);
  await assert.rejects(f.manager.prepare({ ...spec, alias: "second", contextWindow: 4096 }), { code: "MLX_STORE_CONFLICT" });
  f.prepareFailure(false);
  await f.manager.prepare({ ...spec, alias: "second" });
  assert.equal(f.calls.filter((entry) => entry.action === "plan" && entry.spec.alias === "second").length, 1);
  assert.equal((await f.manager.status()).pending.length, 0);
});

test("failed startup and busy stop retain the last owned state without revealing injected errors", async (t) => {
  const f = await fixture(t);
  const profile = await f.manager.prepare(spec);
  f.startFailure(true);
  await assert.rejects(f.manager.start({ profileId: profile.profileId }), (error) => !error.message.includes("secret"));
  assert.equal((await f.manager.status()).models[0].status, "prepared");
  f.startFailure(false);
  await f.manager.start({ profileId: profile.profileId });
  f.setBusy(true);
  await assert.rejects(f.manager.stop({ profileId: profile.profileId }));
  assert.equal((await f.manager.status()).models[0].status, "running");
});

test("model store rejects unsafe state permissions, links, unknown profiles and overclaimed limits", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.manager.prepare({ ...spec, contextWindow: 262145 }), { code: "MLX_MODEL_INVALID" });
  await assert.rejects(f.manager.prepare({ ...spec, repository: "http://unsafe/model" }), { code: "MLX_MODEL_INVALID" });
  await f.manager.prepare(spec);
  await assert.rejects(f.manager.start({ alias: "unknown" }), { code: "MLX_MODEL_UNKNOWN" });
  const statePath = path.join(f.directory, "models.json");
  await chmod(statePath, 0o644);
  await assert.rejects(f.manager.status(), { code: "MLX_STORE_UNSAFE" });
  await chmod(statePath, 0o600);
  const raw = await readFile(statePath);
  await rm(statePath);
  const target = path.join(f.temp, "linked.json");
  await writeFile(target, raw, { mode: 0o600 });
  await symlink(target, statePath);
  await assert.rejects(f.manager.status(), { code: "MLX_STORE_UNSAFE" });
});

test("modified immutable profile fails before any model process starts", async (t) => {
  const f = await fixture(t);
  const profile = await f.manager.prepare(spec);
  const profilePath = path.join(f.directory, "profiles", `${profile.profileId}.json`);
  const data = JSON.parse(await readFile(profilePath, "utf8"));
  data.contextWindow = 4096;
  await writeFile(profilePath, JSON.stringify(data), { mode: 0o600 });
  await assert.rejects(f.manager.start({ profileId: profile.profileId }), { code: "MLX_STORE_CONFLICT" });
  assert.ok(!f.calls.some((entry) => entry.action === "verify"));
});


test("ambiguous JSON and malformed UTF8 state fail closed; prototype aliases remain valid", async (t) => {
  const f = await fixture(t);
  const profile = await f.manager.prepare({ ...spec, alias: "constructor" });
  assert.equal(profile.alias, "constructor");
  assert.equal((await f.manager.start({ alias: "constructor" })).status, "running");
  const statePath = path.join(f.directory, "models.json");
  const source = await readFile(statePath, "utf8");
  await writeFile(statePath, source.replace('"schemaVersion":1', '"schemaVersion":99,"schemaVersion":1'));
  await assert.rejects(f.manager.status(), { code: "MLX_MODEL_INVALID" });
  await writeFile(statePath, Buffer.concat([Buffer.from(source), Buffer.from([0xff])]));
  await assert.rejects(f.manager.status(), { code: "MLX_STORE_UNSAFE" });
});

test("repeated preparation reuses a verified owned immutable snapshot", async (t) => {
  const f = await fixture(t);
  const first = await f.manager.prepare(spec);
  const second = await f.manager.prepare(spec);
  assert.equal(first.profileId, second.profileId);
  assert.equal((await f.manager.status()).models.length, 1);
});


test("malformed successful plan leaves existing profiles and resumable state usable", async (t) => {
  const f = await fixture(t);
  const original = await f.manager.prepare(spec);
  const manager = createMlxModelManager({ ...f.dependencies, runHelper: async ({ request }) => request.action === "plan" ? {} : f.dependencies.runHelper({ request }) });
  await assert.rejects(manager.prepare({ ...spec, alias: "bad-plan" }), { code: "MLX_MODEL_INVALID" });
  const status = await f.manager.status();
  assert.equal(status.models[0].profileId, original.profileId);
  assert.deepEqual(status.pending, [{ alias: "bad-plan", repository: spec.repository, status: "preparing" }]);
});


test("state commit failure rolls the new snapshot back into resumable staging", async (t) => {
  const f = await fixture(t);
  const original = await f.manager.prepare(spec);
  let promoted = false;
  let failOnce = true;
  const manager = createMlxModelManager({ ...f.dependencies, fsImpl: { ...fs, rename: async (from, to) => {
    if (from.includes(`${path.sep}staging${path.sep}`) && to.includes(`${path.sep}snapshots${path.sep}`)) promoted = true;
    if (promoted && to === path.join(f.directory, "models.json") && failOnce) { failOnce = false; throw new Error("injected state commit failure"); }
    return fs.rename(from, to);
  } } });
  await assert.rejects(manager.prepare({ ...spec, alias: "rollback" }), { code: "MLX_MODEL_INVALID" });
  const status = await f.manager.status();
  assert.equal(status.models[0].profileId, original.profileId);
  const state = JSON.parse(await readFile(path.join(f.directory, "models.json"), "utf8"));
  const operation = state.pending.rollback.operationId;
  assert.ok((await fs.stat(path.join(f.directory, "staging", operation))).isDirectory());
  await f.manager.prepare({ ...spec, alias: "rollback" });
  assert.equal((await f.manager.status()).models.length, 2);
});


test("an alias cannot be reassigned to another revision, repository, context or output limit", async (t) => {
  const f = await fixture(t);
  const original = await f.manager.prepare(spec);
  const before = await readFile(path.join(f.directory, "models.json"), "utf8");
  for (const change of [{ revision: "c".repeat(40) }, { repository: "example/Another-MLX" }, { contextWindow: 4096 }, { maxOutputTokens: 512 }]) {
    await assert.rejects(f.manager.prepare({ ...spec, ...change }), { code: "MLX_STORE_CONFLICT" });
    assert.equal(await readFile(path.join(f.directory, "models.json"), "utf8"), before);
  }
  assert.equal((await f.manager.status()).models[0].profileId, original.profileId);
  assert.equal(f.calls.filter((entry) => entry.action === "plan").length, 1);
  assert.equal((await f.manager.prepare(spec)).profileId, original.profileId);
  assert.equal(f.calls.filter((entry) => entry.action === "plan").length, 1);
});


test("stale locks recover by inode and owner proof; a replacement live lock is retained", async (t) => {
  const f = await fixture(t);
  const original = await f.manager.prepare(spec);
  const lock = path.join(f.directory, ".manager-lock");
  const stale = { pid: 99999999, operationId: "00000000-0000-4000-8000-000000000000" };
  const makeLock = async (owner) => { await fs.mkdir(lock, { mode: 0o700 }); await writeFile(path.join(lock, "owner.json"), JSON.stringify(owner), { mode: 0o600 }); };
  await makeLock(stale);
  assert.equal((await f.manager.prepare(spec)).profileId, original.profileId);
  await makeLock(stale);
  const replacement = { pid: process.pid, operationId: "11111111-1111-4111-8111-111111111111" };
  let replaced = false;
  const manager = createMlxModelManager({ ...f.dependencies, fsImpl: { ...fs, rename: async (from, to) => {
    if (from === lock && !replaced) { replaced = true; await fs.unlink(path.join(lock, "owner.json")); await fs.rmdir(lock); await makeLock(replacement); }
    return fs.rename(from, to);
  } } });
  await assert.rejects(manager.prepare(spec), { code: "MLX_STORE_CONFLICT" });
  assert.deepEqual(JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")), replacement);
  assert.equal((await f.manager.status()).models[0].profileId, original.profileId);
});


test("malformed concurrently edited lock data never reaches public errors or deletion", async (t) => {
  const f = await fixture(t);
  const ownerPath = path.join(f.directory, ".manager-lock", "owner.json");
  const raw = '{"pid":"\\xPRIVATE_LOCK_VALUE","operationId":"unknown"}';
  const manager = createMlxModelManager({ ...f.dependencies, runHelper: async ({ request }) => {
    await writeFile(ownerPath, raw, { mode: 0o600 });
    return f.dependencies.runHelper({ request });
  } });
  await assert.rejects(manager.prepare(spec), (error) => error.code === "MLX_STORE_CONFLICT" && !error.message.includes("PRIVATE_LOCK_VALUE"));
  assert.equal(await readFile(ownerPath, "utf8"), raw);
});
