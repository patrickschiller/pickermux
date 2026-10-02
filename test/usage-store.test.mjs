import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createUsageStore, inventoryUsageStore, revalidateUsageStoreInventory, removeUsageStoreInventory,
  USAGE_STORE_MAX_BYTES, UsageStoreError } from "../src/usage-store.mjs";

const COUNTS = { status: "available", inputTokens: 12, outputTokens: 3, totalTokens: 15 };
const RESET_TIME = "2026-10-02T17:30:00.000Z";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "pickermux-usage-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = path.join(root, "PickerMux");
  await mkdir(parent, { mode: 0o700 });
  const directory = path.join(parent, "usage");
  const target = path.join(directory, "token-usage.json");
  const options = { directory, now: () => Date.parse(RESET_TIME), lockAttempts: 200, retryMs: 5 };
  return { root, parent, directory, target, options, store: createUsageStore(options) };
}

test("absent usage is read-only and finalized deltas survive new instances", async (t) => {
  const f = await fixture(t);
  const empty = { schemaVersion: 2, status: "available", resetAt: null, providers: [] };
  assert.deepEqual(await f.store.readSnapshot(), empty);
  assert.equal(await f.store.canReset(), true);
  assert.deepEqual(await readdir(f.parent), []);
  assert.equal(await f.store.record("lmstudio", { ...COUNTS, responseId: "private-response-canary" }), true);
  assert.equal(await f.store.record("lmstudio", { status: "unavailable", prompt: "private-prompt-canary" }), true);
  assert.equal(await f.store.record("remote", { status: "available", inputTokens: 2, outputTokens: 1 }), true);
  await f.store.flush();
  const snapshot = await f.store.readSnapshot();
  assert.deepEqual(snapshot.providers[0], { providerId: "lmstudio", requests: 2, unavailableRequests: 1,
    last: { status: "unavailable" }, totals: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } });
  assert.deepEqual(snapshot.providers[1].totals, { inputTokens: 2, outputTokens: 1, totalTokens: 3 });
  assert.deepEqual(await createUsageStore(f.options).readSnapshot(), snapshot);
  assert.equal((await lstat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(f.target)).mode & 0o777, 0o600);
  const bytes = await readFile(f.target, "utf8");
  assert.doesNotMatch(bytes, /private-response-canary|private-prompt-canary/u);
  assert.deepEqual(await readdir(f.directory), ["token-usage.json"]);
  snapshot.providers[0].totals.inputTokens = 99;
  assert.equal((await f.store.readSnapshot()).providers[0].totals.inputTokens, 12);
});

test("reset starts a new cumulative generation and retains exact last-request measurements", async (t) => {
  const f = await fixture(t);
  await f.store.record("lmstudio", COUNTS);
  const previous = JSON.parse(await readFile(f.target, "utf8"));
  const restarted = createUsageStore(f.options);
  const reset = await restarted.resetCumulative();
  assert.equal(reset.resetAt, RESET_TIME);
  assert.deepEqual(reset.providers[0], { providerId: "lmstudio", requests: 0, unavailableRequests: 0,
    last: COUNTS, totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
  const updated = JSON.parse(await readFile(f.target, "utf8"));
  assert.notEqual(updated.generation, previous.generation);
  assert.deepEqual(await f.store.readSnapshot(), reset);
  await f.store.record("lmstudio", { status: "unavailable" });
  assert.deepEqual((await restarted.readSnapshot()).providers[0], { providerId: "lmstudio", requests: 1,
    unavailableRequests: 1, last: { status: "unavailable" }, totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
});

test("independent writers serialize deltas without duplicated baselines or lost increments", async (t) => {
  const f = await fixture(t);
  const writers = Array.from({ length: 12 }, () => createUsageStore(f.options));
  assert.deepEqual(await Promise.all(writers.map((store) => store.record("lmstudio", COUNTS))), Array(12).fill(true));
  const provider = (await f.store.readSnapshot()).providers[0];
  assert.equal(provider.requests, 12);
  assert.deepEqual(provider.totals, { inputTokens: 144, outputTokens: 36, totalTokens: 180 });
  await createUsageStore(f.options).record("lmstudio", COUNTS);
  assert.equal((await f.store.readSnapshot()).providers[0].requests, 13);
});

test("a competing first writer lets the fresh directory creator initialize under the same lock", async (t) => {
  const f = await fixture(t);
  let releaseCreator;
  let created;
  const directoryCreated = new Promise((resolve) => { created = resolve; });
  const paused = new Promise((resolve) => { releaseCreator = resolve; });
  const creator = createUsageStore({ ...f.options, fsImpl: { async mkdir(target, options) {
    await mkdir(target, options);
    created();
    await paused;
  } } });
  const initial = creator.record("lmstudio", COUNTS);
  await directoryCreated;
  const competitor = createUsageStore({ ...f.options, fsImpl: { async open(target, flags, mode) {
    const handle = await open(target, flags, mode);
    if (target.endsWith("/.usage.lock") && mode === 0o600) releaseCreator();
    return handle;
  } } });
  assert.deepEqual(await Promise.all([initial, competitor.record("lmstudio", COUNTS)]), [true, true]);
  assert.equal((await f.store.readSnapshot()).providers[0].requests, 2);
});

test("reset and a pending cross-process record share a fresh locked transaction", async (t) => {
  const f = await fixture(t);
  await f.store.record("lmstudio", COUNTS);
  let release;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const paused = new Promise((resolve) => { release = resolve; });
  const writer = createUsageStore({ ...f.options, fsImpl: { async rename(source, destination) {
    if (source.includes(".token-usage.json.tmp-")) { began(); await paused; }
    return rename(source, destination);
  } } });
  const pending = writer.record("lmstudio", COUNTS);
  await started;
  const resetting = createUsageStore(f.options).resetCumulative();
  release();
  assert.equal(await pending, true);
  const reset = await resetting;
  assert.equal(reset.providers[0].requests, 0);
  assert.deepEqual(reset.providers[0].last, COUNTS);
  await writer.record("lmstudio", COUNTS);
  assert.equal((await f.store.readSnapshot()).providers[0].requests, 1);
  assert.equal((await f.store.readSnapshot()).providers[0].totals.totalTokens, 15);
});

test("checked totals overflow persists across instances until an explicit reset", async (t) => {
  const f = await fixture(t);
  await f.store.record("lmstudio", { status: "available", inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 });
  await f.store.record("lmstudio", { status: "available", inputTokens: 0, outputTokens: 1 });
  assert.equal((await createUsageStore(f.options).readSnapshot()).providers[0].totals, null);
  await createUsageStore(f.options).record("lmstudio", COUNTS);
  assert.equal((await f.store.readSnapshot()).providers[0].totals, null);
  assert.equal(await f.store.canReset(), true);
  const reset = await f.store.resetCumulative();
  assert.deepEqual(reset.providers[0].last, COUNTS);
  assert.equal(reset.providers[0].totals.totalTokens, 0);
});

test("provider and request-counter exhaustion preserve stored counters for reset recovery", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 128; index += 1) assert.equal(await f.store.record(`provider-${index}`, COUNTS), true);
  const before = JSON.parse(await readFile(f.target, "utf8"));
  assert.equal(await f.store.record("overflow-provider", COUNTS), false);
  const after = JSON.parse(await readFile(f.target, "utf8"));
  assert.deepEqual(after.providers, before.providers);
  assert.equal((await createUsageStore(f.options).readSnapshot()).status, "unavailable");
  assert.equal(await f.store.canReset(), true);
  assert.equal((await f.store.resetCumulative()).providers.length, 128);
  const one = await fixture(t);
  await one.store.record("lmstudio", COUNTS);
  const state = JSON.parse(await readFile(one.target, "utf8"));
  state.providers[0].requests = Number.MAX_SAFE_INTEGER;
  await writeFile(one.target, `${JSON.stringify(state)}\n`);
  assert.equal(await one.store.record("lmstudio", COUNTS), false);
  assert.equal((await one.store.readSnapshot()).status, "unavailable");
  assert.equal((await one.store.resetCumulative()).status, "available");
});

test("malformed, ambiguous and non-allowlisted durable data is retained without disclosure", async (t) => {
  for (const [name, mutate] of [
    ["unknown top-level key", (value) => ({ ...value, credential: "private-credential-canary" })],
    ["unknown provider key", (value) => { value.providers[0].endpoint = "private-endpoint-canary"; return value; }],
    ["unsafe provider", (value) => { value.providers[0].providerId = "unsafe/provider"; return value; }],
    ["invalid total", (value) => { value.providers[0].totals.totalTokens = 99; return value; }],
    ["unknown schema", (value) => ({ ...value, schemaVersion: 42 })],
    ["invalid generation", (value) => ({ ...value, generation: "private-id-canary" })],
    ["invalid reset time", (value) => ({ ...value, resetAt: "2026-10-02" })],
  ]) {
    await t.test(name, async (subtest) => {
      const f = await fixture(subtest);
      await f.store.record("lmstudio", COUNTS);
      const malformed = `${JSON.stringify(mutate(JSON.parse(await readFile(f.target, "utf8"))))}\n`;
      await writeFile(f.target, malformed);
      assert.equal((await f.store.readSnapshot()).status, "unavailable");
      assert.equal(await f.store.canReset(), false);
      assert.equal(await f.store.record("lmstudio", COUNTS), false);
      await assert.rejects(f.store.resetCumulative(), (error) => error instanceof UsageStoreError &&
        error.code === "USAGE_STORE_UNAVAILABLE" && !/private-|usage-test/u.test(error.message));
      await assert.rejects(inventoryUsageStore(f.options), UsageStoreError);
      assert.equal(await readFile(f.target, "utf8"), malformed);
    });
  }
  for (const [name, corrupt] of [
    ["duplicate JSON key", (source) => source.replace('"schemaVersion":1', '"schemaVersion":0,"schemaVersion":1')],
    ["escaped duplicate key", (source) => source.replace('"requests":1', '"requests":999,"\\u0072equests":1')],
    ["duplicate nested key", (source) => source.replace('"inputTokens":12', '"inputTokens":0,"inputTokens":12')],
    ["invalid UTF8", () => Buffer.from([0xff])],
    ["oversized file", () => Buffer.alloc(USAGE_STORE_MAX_BYTES + 1)],
  ]) {
    await t.test(name, async (subtest) => {
      const f = await fixture(subtest);
      await f.store.record("lmstudio", COUNTS);
      const bytes = Buffer.from(corrupt(await readFile(f.target, "utf8")));
      await writeFile(f.target, bytes);
      assert.equal((await f.store.readSnapshot()).status, "unavailable");
      assert.equal(await f.store.record("lmstudio", COUNTS), false);
      await assert.rejects(f.store.resetCumulative(), UsageStoreError);
      assert.deepEqual(await readFile(f.target), bytes);
    });
  }
});

test("unsafe directories, symlinks, hard links and public files cannot supply or receive usage", async (t) => {
  for (const kind of ["file-symlink", "hard-link", "public-file", "public-directory", "parent-symlink"]) {
    await t.test(kind, async (subtest) => {
      const f = await fixture(subtest);
      await f.store.record("lmstudio", COUNTS);
      const saved = await readFile(f.target);
      const outside = path.join(f.root, "outside.json");
      await writeFile(outside, saved, { mode: 0o600 });
      if (kind === "file-symlink") { await rm(f.target); await symlink(outside, f.target); }
      if (kind === "hard-link") { await rm(f.target); await link(outside, f.target); }
      if (kind === "public-file") await chmod(f.target, 0o644);
      if (kind === "public-directory") await chmod(f.directory, 0o755);
      if (kind === "parent-symlink") { const moved = path.join(f.root, "moved"); await rename(f.parent, moved); await symlink(moved, f.parent); }
      assert.equal((await f.store.readSnapshot()).status, "unavailable");
      assert.equal(await f.store.canReset(), false);
      assert.equal(await f.store.record("lmstudio", COUNTS), false);
      await assert.rejects(f.store.resetCumulative(), UsageStoreError);
      assert.deepEqual(await readFile(outside), saved);
      assert.deepEqual(await readFile(f.target), saved);
    });
  }
  for (const directory of ["usage", "/tmp/auth.json", "/tmp/Foreign/usage", "/tmp/PickerMux/../usage", "/tmp/PickerMux/usage\n"]) {
    assert.throws(() => createUsageStore({ directory }), UsageStoreError);
  }
});

test("exclusive lock initialization is retried, live locks are retained and dead locks are verified", async (t) => {
  const f = await fixture(t);
  await f.store.resetCumulative();
  const lockPath = path.join(f.directory, ".usage.lock");
  await writeFile(lockPath, "", { mode: 0o600 });
  let retried = false;
  const writer = createUsageStore({ ...f.options, async sleep() {
    retried = true;
    await rm(lockPath);
  } });
  assert.equal(await writer.record("lmstudio", COUNTS), true);
  assert.equal(retried, true);
  const lock = { kind: "pickermux-usage-lock", schemaVersion: 1, pid: process.pid,
    token: "a1111111-1111-4111-8111-111111111111" };
  const bytes = `${JSON.stringify(lock)}\n`;
  await writeFile(lockPath, bytes, { mode: 0o600 });
  const blocked = createUsageStore({ ...f.options, lockAttempts: 2 });
  assert.equal(await blocked.record("lmstudio", COUNTS), false);
  assert.equal(await readFile(lockPath, "utf8"), bytes);
  await assert.rejects(inventoryUsageStore(f.options), UsageStoreError);
  const recovery = createUsageStore({ ...f.options, processAlive: () => false });
  assert.equal(await recovery.record("lmstudio", COUNTS), true);
  assert.deepEqual(await readdir(f.directory), ["token-usage.json"]);
});

test("atomic writes reject concurrent replacement and leave prior private data untouched", async (t) => {
  const f = await fixture(t);
  await f.store.record("lmstudio", COUNTS);
  const edited = `${await readFile(f.target, "utf8")} `;
  let inject = true;
  const writer = createUsageStore({ ...f.options, fsImpl: { async open(target, flags, mode) {
    const handle = await open(target, flags, mode);
    if (target.includes(".token-usage.json.tmp-") && inject) {
      inject = false;
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await writeFile(f.target, edited); await sync(); };
    }
    return handle;
  } } });
  assert.equal(await writer.record("lmstudio", COUNTS), false);
  assert.equal(await readFile(f.target, "utf8"), edited);
  assert.deepEqual(await readdir(f.directory), ["token-usage.json"]);
});

test("write failures remove only their own staging prefixes and never change durable data", async (t) => {
  const f = await fixture(t);
  await f.store.record("lmstudio", COUNTS);
  const saved = await readFile(f.target);
  for (const kind of ["lock", "temporary"]) {
    const writer = createUsageStore({ ...f.options, fsImpl: { async open(target, flags, mode) {
      const handle = await open(target, flags, mode);
      if ((kind === "lock" && target.endsWith(".usage.lock")) || (kind === "temporary" && target.includes(".token-usage.json.tmp-"))) {
        handle.writeFile = async () => { throw new Error("private-write-canary"); };
      }
      return handle;
    } } });
    assert.equal(await writer.record("lmstudio", COUNTS), false);
    assert.deepEqual(await readFile(f.target), saved);
    assert.deepEqual(await readdir(f.directory), ["token-usage.json"]);
  }
});

test("queue exhaustion is bounded and its unavailable state is durable after flush", async (t) => {
  const f = await fixture(t);
  let release;
  let began;
  let pause = true;
  const started = new Promise((resolve) => { began = resolve; });
  const paused = new Promise((resolve) => { release = resolve; });
  const writer = createUsageStore({ ...f.options, maxPendingOperations: 1, fsImpl: { async rename(source, destination) {
    if (source.includes(".token-usage.json.tmp-") && pause) { pause = false; began(); await paused; }
    return rename(source, destination);
  } } });
  const pending = writer.record("lmstudio", COUNTS);
  await started;
  assert.equal(await writer.record("lmstudio", COUNTS), false);
  release();
  assert.equal(await pending, true);
  assert.equal((await writer.readSnapshot()).status, "unavailable");
  await writer.flush();
  assert.equal((await createUsageStore(f.options).readSnapshot()).status, "unavailable");
  assert.equal(await writer.canReset(), true);
  assert.equal((await writer.resetCumulative()).status, "available");
  assert.equal(await writer.record("lmstudio", COUNTS), true);
  assert.equal((await writer.readSnapshot()).providers[0].requests, 1);
});

test("a known store disappearing cannot silently restart counters", async (t) => {
  const f = await fixture(t);
  await f.store.record("lmstudio", COUNTS);
  await rm(f.target);
  assert.equal((await f.store.readSnapshot()).status, "unavailable");
  assert.equal(await f.store.record("lmstudio", COUNTS), false);
  await f.store.flush();
  await assert.rejects(readFile(f.target), { code: "ENOENT" });
  assert.equal((await f.store.resetCumulative()).status, "available");
  assert.equal(await f.store.record("lmstudio", COUNTS), true);
});

test("a preexisting empty directory requires explicit reset even across store instances", async (t) => {
  const f = await fixture(t);
  await f.store.record("lmstudio", COUNTS);
  await rm(f.target);
  const restarted = createUsageStore({ ...f.options, lockAttempts: 4, retryMs: 1 });
  assert.equal((await restarted.readSnapshot()).status, "unavailable");
  assert.equal(await restarted.canReset(), true);
  assert.equal(await restarted.record("lmstudio", COUNTS), false);
  await restarted.flush();
  assert.deepEqual(await readdir(f.directory), []);
  assert.equal((await restarted.resetCumulative()).status, "available");
  assert.equal(await restarted.record("lmstudio", COUNTS), true);
  assert.equal((await createUsageStore(f.options).readSnapshot()).providers[0].requests, 1);
});

test("full-removal inventories bind exact directory and file ownership without recursive cleanup", async (t) => {
  const f = await fixture(t);
  const absent = await inventoryUsageStore(f.options);
  assert.equal(absent.exists, false);
  assert.deepEqual(await removeUsageStoreInventory(absent), { removed: false, cleanupPendingPath: null });
  await f.store.record("lmstudio", COUNTS);
  const receipt = await inventoryUsageStore(f.options);
  assert.equal(await revalidateUsageStoreInventory(receipt, { directory: f.directory }), receipt);
  await assert.rejects(revalidateUsageStoreInventory(receipt, { directory: path.join(f.root, "Other", "usage") }), UsageStoreError);
  await assert.rejects(removeUsageStoreInventory({ exists: true }), UsageStoreError);
  await writeFile(path.join(f.directory, "user-file"), "private-user-canary");
  await assert.rejects(revalidateUsageStoreInventory(receipt), UsageStoreError);
  await assert.rejects(removeUsageStoreInventory(receipt), UsageStoreError);
  assert.equal(await readFile(path.join(f.directory, "user-file"), "utf8"), "private-user-canary");
  await rm(path.join(f.directory, "user-file"));
  const fresh = await inventoryUsageStore(f.options);
  assert.deepEqual(await removeUsageStoreInventory(fresh), { removed: true, cleanupPendingPath: null });
  assert.deepEqual(await readdir(f.parent), []);
});

test("usage inventory rejects a changed store and restores pending exact cleanup", async (t) => {
  const f = await fixture(t);
  await f.store.record("lmstudio", COUNTS);
  const receipt = await inventoryUsageStore(f.options);
  await f.store.record("lmstudio", COUNTS);
  await assert.rejects(removeUsageStoreInventory(receipt), UsageStoreError);
  const fresh = await inventoryUsageStore({ ...f.options, fsImpl: { async unlink() { throw new Error("private-cleanup-canary"); } } });
  const result = await removeUsageStoreInventory(fresh);
  assert.equal(result.removed, false);
  assert.equal(result.cleanupPendingPath, f.directory);
  assert.equal((await f.store.readSnapshot()).providers[0].requests, 2);
  assert.deepEqual(await readdir(f.parent), ["usage"]);
});
