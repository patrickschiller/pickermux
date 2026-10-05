import path from "node:path";
import os from "node:os";
import { TextDecoder } from "node:util";
import http from "node:http";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const SOURCE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_STATE_BYTES = 1024 * 1024;
const ID_PATTERN = /^[0-9a-f]{64}$/;
const INSTANCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATA_FILES = new Set(["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "added_tokens.json", "tokenizer.model", "vocab.json", "merges.txt", "chat_template.jinja", "model.safetensors.index.json", "LICENSE"]);
const WEIGHT_PATTERN = /^model(?:-\d{5}-of-\d{5})?\.safetensors$/;
const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RUNTIME_VERSIONS = { mlx: "0.32.3", "mlx-lm": "0.32.0", transformers: "5.7.0", "huggingface-hub": "1.5.0" };

export class MlxModelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MlxModelError";
    this.code = code;
  }
}

function fail(code = "MLX_MODEL_INVALID", message = "The managed MLX model could not be verified.") {
  throw new MlxModelError(code, message);
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function strictJson(source) {
  let position = 0;
  const whitespace = () => { while (/[ \t\r\n]/u.test(source[position] ?? "")) position += 1; };
  const string = () => {
    const start = position++;
    while (position < source.length) {
      if (source[position] === "\\") position += 2;
      else if (source[position++] === '"') return JSON.parse(source.slice(start, position));
    }
    fail();
  };
  const value = (depth) => {
    if (depth > 16) fail();
    whitespace();
    const opening = source[position];
    if (opening === '"') { string(); return; }
    if (opening === "{" || opening === "[") {
      const closing = opening === "{" ? "}" : "]";
      const seen = new Set();
      position += 1;
      whitespace();
      if (source[position] === closing) { position += 1; return; }
      while (true) {
        whitespace();
        if (opening === "{") {
          if (source[position] !== '"') fail();
          const key = string();
          if (seen.has(key)) fail();
          seen.add(key);
          whitespace();
          if (source[position++] !== ":") fail();
        }
        value(depth + 1);
        whitespace();
        const separator = source[position++];
        if (separator === closing) return;
        if (separator !== ",") fail();
      }
    }
    const primitive = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u.exec(source.slice(position));
    if (!primitive || (primitive[0] !== "null" && !["true", "false"].includes(primitive[0]) && !Number.isFinite(Number(primitive[0])))) fail();
    position += primitive[0].length;
  };
  value(0);
  whitespace();
  if (position !== source.length) fail();
  return JSON.parse(source);
}

function strictText(bytes) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function computeMlxProfileDigest(profile) {
  const identity = Object.fromEntries(Object.entries(profile).filter(([key]) => !["snapshotDirectory", "profileDigest"].includes(key)));
  return sha256(canonical(identity));
}

function specification(options) {
  const { repository, revision = "main", alias, contextWindow = 8192, maxOutputTokens = 1024 } = options;
  if (typeof repository !== "string" || repository.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(repository) || typeof revision !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(revision) || revision.includes("..") || typeof alias !== "string" || !ALIAS_PATTERN.test(alias) || !Number.isSafeInteger(contextWindow) || contextWindow < 1024 || contextWindow > 8192 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > Math.min(2048, contextWindow - 1)) fail();
  return { repository, revision, alias, contextWindow, maxOutputTokens };
}

function validateProfile(profile) {
  if (!exactKeys(profile, ["schemaVersion", "kind", "repository", "revision", "alias", "contextWindow", "maxOutputTokens", "modelType", "customArchitecture", "runtimeVersions", "files", "snapshotDirectory", "profileDigest"]) || profile.schemaVersion !== 1 || profile.kind !== "pickermux-mlx-profile" || !/^[0-9a-f]{40}$/.test(profile.revision) || !ID_PATTERN.test(profile.profileDigest) || computeMlxProfileDigest(profile) !== profile.profileDigest || canonical(profile.runtimeVersions) !== canonical(RUNTIME_VERSIONS) || typeof profile.modelType !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(profile.modelType) || ![null, "kolibri1"].includes(profile.customArchitecture) || typeof profile.snapshotDirectory !== "string" || !path.isAbsolute(profile.snapshotDirectory) || !Array.isArray(profile.files) || profile.files.length < 3 || profile.files.length > 256) fail();
  specification(profile);
  const names = new Set();
  for (const entry of profile.files) {
    if (!exactKeys(entry, ["name", "bytes", "sha256"]) || typeof entry.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name) || [".", ".."].includes(entry.name) || (!DATA_FILES.has(entry.name) && !WEIGHT_PATTERN.test(entry.name) && !(profile.customArchitecture === "kolibri1" && entry.name === "kolibri1.py")) || names.has(entry.name) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 128 * 1024 ** 3 || !ID_PATTERN.test(entry.sha256)) fail();
    names.add(entry.name);
  }
  if (!names.has("config.json") || !names.has("tokenizer_config.json") || ![...names].some((name) => WEIGHT_PATTERN.test(name)) || profile.files.reduce((sum, entry) => sum + entry.bytes, 0) > 128 * 1024 ** 3) fail();
  return profile;
}

function validatePlan(plan, spec) {
  if (!exactKeys(plan, ["schemaVersion", "repository", "revision", "alias", "contextWindow", "maxOutputTokens", "modelType", "customArchitecture", "runtimeVersions", "files"]) || plan.schemaVersion !== 1 || typeof plan.revision !== "string" || !/^[0-9a-f]{40}$/.test(plan.revision) || canonical(plan.runtimeVersions) !== canonical(RUNTIME_VERSIONS) || typeof plan.modelType !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(plan.modelType) || ![null, "kolibri1"].includes(plan.customArchitecture) || !Array.isArray(plan.files) || plan.files.length < 3 || plan.files.length > 256) fail();
  specification(plan);
  const names = new Set();
  for (const entry of plan.files) {
    if (!exactKeys(entry, ["name", "bytes", "hashKind", "hash"]) || typeof entry.name !== "string" || (!DATA_FILES.has(entry.name) && !WEIGHT_PATTERN.test(entry.name) && !(plan.customArchitecture === "kolibri1" && entry.name === "kolibri1.py")) || names.has(entry.name) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 128 * 1024 ** 3 || !["sha256", "git-sha1"].includes(entry.hashKind) || typeof entry.hash !== "string" || !(entry.hashKind === "sha256" ? ID_PATTERN : /^[0-9a-f]{40}$/).test(entry.hash)) fail();
    names.add(entry.name);
  }
  if (!names.has("config.json") || !names.has("tokenizer_config.json") || ![...names].some((name) => WEIGHT_PATTERN.test(name)) || plan.files.reduce((sum, entry) => sum + entry.bytes, 0) > 128 * 1024 ** 3) fail();
  if (spec && (plan.repository !== spec.repository || plan.alias !== spec.alias || plan.contextWindow !== spec.contextWindow || plan.maxOutputTokens !== spec.maxOutputTokens || (/^[0-9a-f]{40}$/.test(spec.revision) && plan.revision !== spec.revision))) fail();
  return plan;
}

function publicProfile(record) {
  const profile = record.profile;
  return { profileId: profile.profileDigest, profileDigest: `sha256:${profile.profileDigest}`, repository: profile.repository, revision: profile.revision, alias: profile.alias, contextWindow: profile.contextWindow, maxOutputTokens: profile.maxOutputTokens, modelType: profile.modelType, runtimeVersions: { ...profile.runtimeVersions } };
}

function safeEnvironment() {
  const environment = {};
  for (const name of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SYSTEMROOT"]) if (typeof process.env[name] === "string") environment[name] = process.env[name];
  return { ...environment, HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_DISABLE_PROGRESS_BARS: "1", HF_HUB_DISABLE_IMPLICIT_TOKEN: "1", MLXLM_USE_MODELSCOPE: "False", PYTHONDONTWRITEBYTECODE: "1" };
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

async function spawnHelper({ python, helperPath, request }) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-B", helperPath], { shell: false, env: safeEnvironment(), stdio: ["pipe", "pipe", "ignore"] });
    let output = Buffer.alloc(0);
    let overflow = false;
    child.stdout.on("data", (chunk) => { output = Buffer.concat([output, chunk]); if (Buffer.byteLength(output) > MAX_STATE_BYTES) { overflow = true; child.stdout.destroy(); child.kill("SIGTERM"); } });
    child.on("error", () => reject(new MlxModelError("MLX_RUNTIME_UNAVAILABLE", "The isolated MLX interpreter could not be started.")));
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      try {
        const reply = strictJson(strictText(output));
        if (overflow || code !== 0 || !exactKeys(reply, ["schemaVersion", "ok", "result"]) || reply.schemaVersion !== 1 || reply.ok !== true) fail("MLX_MODEL_INVALID", "Model preparation or verification failed; the previous profile was retained.");
        resolve(reply.result);
      } catch (error) { reject(error instanceof MlxModelError ? error : new MlxModelError("MLX_MODEL_INVALID", "The MLX helper returned an invalid result.")); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function spawnRuntime({ python, serverPath, profilePath, port, instanceId, capability, profileDigest, timeoutMs = 600000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-B", serverPath, "--profile", profilePath, "--port", String(port)], { detached: true, shell: false, env: safeEnvironment(), stdio: ["pipe", "pipe", "ignore"] });
    let output = Buffer.alloc(0);
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill("SIGTERM"); reject(error); }
      else { child.stdout.destroy(); child.unref(); resolve(result); }
    };
    const timer = setTimeout(() => finish(new MlxModelError("MLX_RUNTIME_UNAVAILABLE", "The verified MLX model did not become ready in time.")), timeoutMs);
    child.stdout.on("data", (chunk) => {
      output = Buffer.concat([output, chunk]);
      if (Buffer.byteLength(output) > 4096) return finish(new MlxModelError("MLX_RUNTIME_UNAVAILABLE", "The MLX runtime returned invalid readiness data."));
      if (!output.includes(10)) return;
      try {
        const reply = strictJson(strictText(output).trim());
        if (!exactKeys(reply, ["schemaVersion", "ready", "port", "profileDigest"]) || reply.schemaVersion !== 1 || reply.ready !== true || !Number.isSafeInteger(reply.port) || reply.port < 1024 || reply.port > 65535 || reply.profileDigest !== profileDigest || !Number.isSafeInteger(child.pid)) fail();
        finish(null, { port: reply.port, pid: child.pid });
      } catch { finish(new MlxModelError("MLX_RUNTIME_UNAVAILABLE", "The MLX runtime failed before becoming ready.")); }
    });
    child.stdin.on("error", () => {});
    child.on("error", () => finish(new MlxModelError("MLX_RUNTIME_UNAVAILABLE", "The isolated MLX interpreter could not be started.")));
    child.on("exit", () => finish(new MlxModelError("MLX_RUNTIME_UNAVAILABLE", "The verified MLX runtime stopped before becoming ready.")));
    child.stdin.end(JSON.stringify({ schemaVersion: 1, instanceId, capability }));
  });
}

async function controlRequest(runtime, action) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: runtime.port, path: `/_pickermux/${runtime.capability}/${action}`, method: action === "health" ? "GET" : "POST", headers: { Host: `127.0.0.1:${runtime.port}`, "Content-Length": "0" }, timeout: 3000 }, (response) => {
      let body = Buffer.alloc(0);
      response.on("data", (chunk) => { body = Buffer.concat([body, chunk]); if (Buffer.byteLength(body) > 4096) request.destroy(); });
      response.on("end", () => {
        try {
          const value = strictJson(strictText(body));
          const fields = action === "health" ? ["schemaVersion", "instanceId", "profileDigest", "pid"] : ["schemaVersion", "instanceId", "profileDigest", "stopping"];
          if (response.statusCode === 409) fail("MLX_MODEL_BUSY", "The MLX model is handling a request; stop it after that request completes.");
          if (response.statusCode !== 200 || !exactKeys(value, fields) || value.schemaVersion !== 1 || value.instanceId !== runtime.instanceId || value.profileDigest !== runtime.profileDigest || (action === "health" ? value.pid !== runtime.pid : value.stopping !== true)) fail("MLX_RUNTIME_IDENTITY_MISMATCH", "The running process does not match the owned MLX instance.");
          resolve(value);
        } catch (error) { reject(error instanceof MlxModelError ? error : new MlxModelError("MLX_RUNTIME_UNAVAILABLE", "The managed MLX instance is unavailable.")); }
      });
      response.on("error", () => reject(new MlxModelError("MLX_RUNTIME_UNAVAILABLE", "The managed MLX instance is unavailable.")));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => reject(new MlxModelError("MLX_RUNTIME_UNAVAILABLE", "The managed MLX instance is unavailable.")));
    request.end();
  });
}

export function createMlxModelManager({ directory = path.join(os.homedir(), "Library", "Application Support", "PickerMuxMLX"), sourceRoot = SOURCE_ROOT, python, fsImpl = fs, runHelper = spawnHelper, startRuntime = spawnRuntime, probeRuntime = (runtime) => controlRequest(runtime, "health"), stopRuntime = (runtime) => controlRequest(runtime, "shutdown"), isProcessAlive = processAlive, uuid = randomUUID, capability = () => randomBytes(32).toString("hex"), wait = sleep } = {}) {
  if (!path.isAbsolute(directory) || !path.isAbsolute(sourceRoot)) fail();
  const statePath = path.join(directory, "models.json");
  const lockPath = path.join(directory, ".manager-lock");
  const helperPath = path.join(sourceRoot, "runtime", "mlx", "manage.py");
  const serverPath = path.join(sourceRoot, "runtime", "mlx", "server.py");
  let active = false;
  let lockProof = null;

  async function privateDirectory(target, create = false) {
    if (create) await fsImpl.mkdir(target, { recursive: true, mode: 0o700 });
    const info = await fsImpl.lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) fail("MLX_STORE_UNSAFE", "The MLX model store must be private and owned by the current user.");
  }

  async function readPrivate(target, missing = false) {
    let handle;
    try {
      const info = await fsImpl.lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > MAX_STATE_BYTES) fail("MLX_STORE_UNSAFE", "The managed MLX state is unsafe or modified.");
      handle = await fsImpl.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) fail("MLX_STORE_CONFLICT", "Managed MLX state changed during verification.");
      return strictText(await handle.readFile());
    } catch (error) {
      if (missing && error.code === "ENOENT") return null;
      throw error;
    } finally { await handle?.close(); }
  }

  async function assertLockOwnership() {
    if (!lockProof) return;
    await privateDirectory(lockPath);
    const observed = await fsImpl.lstat(lockPath);
    if (observed.dev !== lockProof.dev || observed.ino !== lockProof.ino || await readPrivate(path.join(lockPath, "owner.json")) !== lockProof.raw) fail("MLX_STORE_CONFLICT", "The managed MLX operation lock changed; existing state was retained.");
  }

  async function writePrivate(target, value, expected = null) {
    await assertLockOwnership();
    const serialized = `${canonical(value)}\n`;
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) fail("MLX_STORE_FULL", "The bounded MLX model store is full; existing profiles were retained.");
    const current = await readPrivate(target, true);
    if (current !== expected) fail("MLX_STORE_CONFLICT", "Managed MLX state changed; retry after reviewing it.");
    const temp = `${target}.${uuid()}.tmp`;
    let handle;
    try {
      handle = await fsImpl.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(serialized);
      await handle.sync();
      await handle.close();
      handle = null;
      await assertLockOwnership();
      if (await readPrivate(target, true) !== expected) fail("MLX_STORE_CONFLICT", "Managed MLX state changed; retry after reviewing it.");
      await fsImpl.rename(temp, target);
    } finally { await handle?.close(); await fsImpl.unlink(temp).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  }

  async function readState() {
    const raw = await readPrivate(statePath, true);
    const value = raw === null ? { schemaVersion: 1, kind: "pickermux-mlx-models", profiles: {}, runtimes: {}, pending: {} } : strictJson(raw);
    if (!exactKeys(value, ["schemaVersion", "kind", "profiles", "runtimes", "pending"]) || value.schemaVersion !== 1 || value.kind !== "pickermux-mlx-models" || [value.profiles, value.runtimes, value.pending].some((part) => !part || typeof part !== "object" || Array.isArray(part) || Object.keys(part).length > 64)) fail();
    for (const [id, record] of Object.entries(value.profiles)) {
      if (!ID_PATTERN.test(id) || !exactKeys(record, ["profile", "python"]) || record.profile.profileDigest !== id || typeof record.python !== "string" || !path.isAbsolute(record.python)) fail();
      validateProfile(record.profile);
    }
    for (const [id, runtime] of Object.entries(value.runtimes)) if (!value.profiles[id] || !exactKeys(runtime, ["profileDigest", "instanceId", "capability", "pid", "port"]) || runtime.profileDigest !== id || !INSTANCE_PATTERN.test(runtime.instanceId) || !ID_PATTERN.test(runtime.capability) || !Number.isSafeInteger(runtime.pid) || runtime.pid < 1 || !Number.isSafeInteger(runtime.port) || runtime.port < 1024 || runtime.port > 65535) fail();
    for (const [alias, pending] of Object.entries(value.pending)) if (!ALIAS_PATTERN.test(alias) || !exactKeys(pending, ["spec", "operationId", "python", "plan"]) || specification(pending.spec).alias !== alias || !INSTANCE_PATTERN.test(pending.operationId) || typeof pending.python !== "string" || !path.isAbsolute(pending.python) || (pending.plan !== null && (!exactKeys(pending.plan, ["schemaVersion", "repository", "revision", "alias", "contextWindow", "maxOutputTokens", "modelType", "customArchitecture", "runtimeVersions", "files"]) || pending.plan.alias !== alias || !/^[0-9a-f]{40}$/.test(pending.plan.revision)))) fail();
    for (const entry of Object.values(value.pending)) if (entry.plan !== null) validatePlan(entry.plan, entry.spec);
    return { value, raw };
  }

  async function locked(operation) {
    if (active) fail("MLX_STORE_BUSY", "Another managed MLX operation is still running.");
    active = true;
    let owner;
    try {
      await privateDirectory(directory, true);
      try { await fsImpl.mkdir(lockPath, { mode: 0o700 }); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        await privateDirectory(lockPath);
        const captured = await fsImpl.lstat(lockPath);
        const previousRaw = await readPrivate(path.join(lockPath, "owner.json"));
        const previous = strictJson(previousRaw);
        if (!exactKeys(previous, ["pid", "operationId"]) || !Number.isSafeInteger(previous.pid) || previous.pid < 1 || !INSTANCE_PATTERN.test(previous.operationId) || isProcessAlive(previous.pid)) fail("MLX_STORE_BUSY", "Another managed MLX operation is still running.");
        const confirmed = await fsImpl.lstat(lockPath);
        if (captured.dev !== confirmed.dev || captured.ino !== confirmed.ino || await readPrivate(path.join(lockPath, "owner.json")) !== previousRaw || canonical(await fsImpl.readdir(lockPath)) !== '["owner.json"]') fail("MLX_STORE_CONFLICT", "The managed MLX operation lock changed; existing state was retained.");
        const retired = `${lockPath}.stale-${uuid()}`;
        await fsImpl.rename(lockPath, retired);
        try {
          await privateDirectory(retired);
          const moved = await fsImpl.lstat(retired);
          if (captured.dev !== moved.dev || captured.ino !== moved.ino || await readPrivate(path.join(retired, "owner.json")) !== previousRaw || canonical(await fsImpl.readdir(retired)) !== '["owner.json"]') fail("MLX_STORE_CONFLICT", "The managed MLX operation lock changed; existing state was retained.");
          await fsImpl.unlink(path.join(retired, "owner.json"));
          await fsImpl.rmdir(retired);
        } catch (failure) {
          const exists = await fsImpl.lstat(lockPath).then(() => true, (missing) => { if (missing.code === "ENOENT") return false; throw missing; });
          if (!exists) await fsImpl.rename(retired, lockPath).catch(() => {});
          throw failure;
        }
        await fsImpl.mkdir(lockPath, { mode: 0o700 });
      }
      owner = { pid: process.pid, operationId: uuid() };
      await writePrivate(path.join(lockPath, "owner.json"), owner);
      const owned = await fsImpl.lstat(lockPath);
      lockProof = { dev: owned.dev, ino: owned.ino, raw: await readPrivate(path.join(lockPath, "owner.json")) };
      await privateDirectory(path.join(directory, "profiles"), true);
      await privateDirectory(path.join(directory, "staging"), true);
      await privateDirectory(path.join(directory, "snapshots"), true);
      return await operation();
    } catch (error) { throw error instanceof MlxModelError ? error : new MlxModelError("MLX_MODEL_INVALID", "The managed MLX operation failed; existing profiles were retained."); }
    finally {
      if (owner) {
        try {
          const raw = await readPrivate(path.join(lockPath, "owner.json"), true);
          if (raw && canonical(strictJson(raw)) === canonical(owner)) {
            await assertLockOwnership();
            await fsImpl.unlink(path.join(lockPath, "owner.json"));
            await fsImpl.rmdir(lockPath);
          }
        } catch { /* Unknown or changed lock ownership has no cleanup authority. */ }
      }
      lockProof = null;
      active = false;
    }
  }

  async function interpreter(value) {
    if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) fail("MLX_INTERPRETER_REQUIRED", "Supply an absolute Python interpreter from the isolated MLX environment.");
    const info = await fsImpl.stat(value);
    if (!info.isFile() || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0) fail("MLX_INTERPRETER_REQUIRED", "The isolated MLX interpreter is unsafe or unavailable.");
    return value;
  }

  function resolveProfile(state, idOrAlias) {
    const key = idOrAlias?.replace?.(/^sha256:/, "");
    if (Object.hasOwn(state.profiles, key)) return key;
    const candidates = Object.keys(state.profiles).filter((id) => state.profiles[id].profile.alias === idOrAlias);
    if (candidates.length !== 1) fail("MLX_MODEL_UNKNOWN", "Supply an exact managed profile ID; this alias is unknown or ambiguous.");
    return candidates[0];
  }

  return {
    directory,
    async prepare(options = {}) {
      const spec = specification(options);
      return locked(async () => {
        let promoted = null;
        try {
          let state = await readState();
          const pending = Object.hasOwn(state.value.pending, spec.alias) ? state.value.pending[spec.alias] : undefined;
          const existingAliases = Object.values(state.value.profiles).filter((record) => record.profile.alias === spec.alias);
          if (existingAliases.length > 1) fail("MLX_STORE_CONFLICT", "The managed alias is ambiguous; existing profiles were retained.");
          if (existingAliases.length === 1) {
            const existing = existingAliases[0];
            const bound = existing.profile;
            if (pending || bound.repository !== spec.repository || bound.contextWindow !== spec.contextWindow || bound.maxOutputTokens !== spec.maxOutputTokens || !["main", bound.revision].includes(spec.revision) || (python !== undefined && python !== existing.python)) fail("MLX_STORE_CONFLICT", "This alias already belongs to an immutable profile; use a new alias for a changed model or configuration.");
            const selectedPython = await interpreter(existing.python);
            const ownedPath = path.join(directory, "profiles", `${bound.profileDigest}.json`);
            if (canonical(strictJson(await readPrivate(ownedPath))) !== canonical(bound)) fail("MLX_STORE_CONFLICT", "The immutable MLX profile was modified.");
            const verified = await runHelper({ python: selectedPython, helperPath, request: { schemaVersion: 1, action: "verify", profile: bound } });
            if (!exactKeys(verified, ["verified"]) || verified.verified !== true) fail();
            // A mutable ref is resolved only when an alias is first created.
            return publicProfile(existing);
          }
          const selectedPython = await interpreter(python ?? pending?.python);
          let profile;
          if (options.modelDir !== undefined) {
            if (pending) fail("MLX_STORE_CONFLICT", "Resume the existing model preparation before importing a snapshot for this alias.");
            if (typeof options.modelDir !== "string" || !path.isAbsolute(options.modelDir)) fail();
            profile = validateProfile(await runHelper({ python: selectedPython, helperPath, request: { schemaVersion: 1, action: "import", spec, directory: options.modelDir } }));
          } else {
            if (pending && canonical(pending.spec) !== canonical(spec)) fail("MLX_STORE_CONFLICT", "A different model preparation already owns this alias; resume it before changing the specification.");
            const entry = pending ?? { spec, operationId: uuid(), python: selectedPython, plan: null };
            if (entry.python !== selectedPython) fail("MLX_STORE_CONFLICT", "Resume model preparation with the same isolated interpreter.");
            const staging = path.join(directory, "staging", entry.operationId);
            await privateDirectory(staging, true);
            if (!pending && Object.keys(state.value.pending).length >= 64) fail("MLX_STORE_FULL", "The bounded MLX model store is full; existing profiles were retained.");
            if (!pending) { state.value.pending[spec.alias] = entry; await writePrivate(statePath, state.value, state.raw); state = await readState(); }
            if (entry.plan === null) {
              entry.plan = validatePlan(await runHelper({ python: selectedPython, helperPath, request: { schemaVersion: 1, action: "plan", spec, directory: staging } }), spec);
              state.value.pending[spec.alias] = entry;
              await writePrivate(statePath, state.value, state.raw);
              state = await readState();
            }
            profile = validateProfile(await runHelper({ python: selectedPython, helperPath, request: { schemaVersion: 1, action: "prepare", plan: entry.plan, directory: staging } }));
            if (profile.repository !== spec.repository || profile.alias !== spec.alias || profile.contextWindow !== spec.contextWindow || profile.maxOutputTokens !== spec.maxOutputTokens || profile.revision !== entry.plan.revision) fail();
            const destination = path.join(directory, "snapshots", profile.profileDigest);
            if (profile.snapshotDirectory !== staging) fail();
            let exists = false;
            try { await fsImpl.lstat(destination); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
            if (exists) {
              const existingRecord = state.value.profiles[profile.profileDigest];
              if (!existingRecord || existingRecord.profile.snapshotDirectory !== destination || canonical(existingRecord.profile) !== canonical({ ...profile, snapshotDirectory: destination })) fail("MLX_STORE_CONFLICT", "The immutable model snapshot already exists without matching ownership.");
              const verified = await runHelper({ python: selectedPython, helperPath, request: { schemaVersion: 1, action: "verify", profile: existingRecord.profile } });
              if (!exactKeys(verified, ["verified"]) || verified.verified !== true) fail();
              // A verified owned duplicate is disposable; foreign files are never overwritten.
              await fsImpl.rm(staging, { recursive: true });
            } else {
              await fsImpl.rename(staging, destination);
              promoted = { staging, destination, profile: { ...profile, snapshotDirectory: destination }, python: selectedPython };
            }
            profile = { ...profile, snapshotDirectory: destination };
          }
          if (profile.repository !== spec.repository || profile.alias !== spec.alias || profile.contextWindow !== spec.contextWindow || profile.maxOutputTokens !== spec.maxOutputTokens) fail();
          const profilePath = path.join(directory, "profiles", `${profile.profileDigest}.json`);
          const existing = await readPrivate(profilePath, true);
          if (existing !== null && canonical(strictJson(existing)) !== canonical(profile)) fail("MLX_STORE_CONFLICT", "The immutable MLX profile was modified.");
          if (existing === null) await writePrivate(profilePath, profile);
          state = await readState();
          if (!Object.hasOwn(state.value.profiles, profile.profileDigest) && Object.keys(state.value.profiles).length >= 64) fail("MLX_STORE_FULL", "The bounded MLX model store is full; existing profiles were retained.");
          state.value.profiles[profile.profileDigest] = { profile, python: selectedPython };
          delete state.value.pending[spec.alias];
          await writePrivate(statePath, state.value, state.raw);
          return publicProfile(state.value.profiles[profile.profileDigest]);
        } catch (error) {
          if (promoted) {
            // A failed state commit retains verified download progress for the same operation.
            // Re-read ownership before moving anything; edited state remains untouched.
            try {
              const observed = await readState();
              if (!Object.hasOwn(observed.value.profiles, promoted.profile.profileDigest)) {
                const stagingExists = await fsImpl.lstat(promoted.staging).then(() => true, (failure) => { if (failure.code === "ENOENT") return false; throw failure; });
                if (!stagingExists) {
                  const verified = await runHelper({ python: promoted.python, helperPath, request: { schemaVersion: 1, action: "verify", profile: promoted.profile } });
                  if (exactKeys(verified, ["verified"]) && verified.verified === true) { await assertLockOwnership(); await fsImpl.rename(promoted.destination, promoted.staging); }
                }
              }
            } catch { /* Recovery must never replace concurrently changed state. */ }
          }
          throw error;
        }
      });
    },
    async start({ profileId, alias, port = 8081 } = {}) {
      if (!Number.isSafeInteger(port) || port < 0 || (port !== 0 && (port < 1024 || port > 65535))) fail();
      return locked(async () => {
        const state = await readState();
        const id = resolveProfile(state.value, profileId ?? alias);
        const record = state.value.profiles[id];
        const previous = state.value.runtimes[id];
        if (previous) {
          try { await probeRuntime(previous); return { ...publicProfile(record), port: previous.port, status: "running" }; }
          catch { if (isProcessAlive(previous.pid)) fail("MLX_RUNTIME_IDENTITY_MISMATCH", "The owned MLX instance could not be verified; no process was changed."); }
        }
        const selectedPython = await interpreter(python ?? record.python);
        const profilePath = path.join(directory, "profiles", `${id}.json`);
        if (canonical(strictJson(await readPrivate(profilePath))) !== canonical(record.profile)) fail("MLX_STORE_CONFLICT", "The immutable MLX profile was modified.");
        const verified = await runHelper({ python: selectedPython, helperPath, request: { schemaVersion: 1, action: "verify", profile: record.profile } });
        if (!exactKeys(verified, ["verified"]) || verified.verified !== true) fail();
        const control = { profileDigest: id, instanceId: uuid(), capability: capability() };
        if (!INSTANCE_PATTERN.test(control.instanceId) || !ID_PATTERN.test(control.capability)) fail();
        let runtime;
        try {
          const started = await startRuntime({ python: selectedPython, serverPath, profilePath, port, ...control });
          runtime = { ...control, pid: started.pid, port: started.port };
          if (!Number.isSafeInteger(runtime.pid) || runtime.pid < 1 || !Number.isSafeInteger(runtime.port) || runtime.port < 1024 || runtime.port > 65535) fail();
          await probeRuntime(runtime);
          state.value.runtimes[id] = runtime;
          await writePrivate(statePath, state.value, state.raw);
        } catch (error) {
          if (runtime) await stopRuntime(runtime).catch(() => {});
          throw error;
        }
        return { ...publicProfile(record), port: runtime.port, status: "running" };
      });
    },
    async status() {
      try {
        try { await privateDirectory(directory); } catch (error) { if (error.code === "ENOENT") return { schemaVersion: 1, models: [], pending: [] }; throw error; }
        const { value } = await readState();
        const models = await Promise.all(Object.entries(value.profiles).map(async ([id, record]) => {
          const runtime = value.runtimes[id];
          let status = "prepared";
          if (runtime) { try { await probeRuntime(runtime); status = "running"; } catch { status = "unavailable"; } }
          return { ...publicProfile(record), status, ...(runtime ? { port: runtime.port } : {}) };
        }));
        return { schemaVersion: 1, models, pending: Object.values(value.pending).map((entry) => ({ alias: entry.spec.alias, repository: entry.spec.repository, status: "preparing" })) };
      } catch (error) { throw error instanceof MlxModelError ? error : new MlxModelError("MLX_STORE_UNSAFE", "The managed MLX state could not be verified."); }
    },
    async stop({ profileId, alias } = {}) {
      return locked(async () => {
        const state = await readState();
        const id = resolveProfile(state.value, profileId ?? alias);
        const record = state.value.profiles[id];
        const runtime = state.value.runtimes[id];
        if (!runtime) return { ...publicProfile(record), status: "stopped" };
        try { await probeRuntime(runtime); }
        catch { if (isProcessAlive(runtime.pid)) fail("MLX_RUNTIME_IDENTITY_MISMATCH", "The owned MLX instance could not be verified; no process was changed."); }
        if (isProcessAlive(runtime.pid)) {
          await stopRuntime(runtime);
          for (let attempt = 0; attempt < 30 && isProcessAlive(runtime.pid); attempt += 1) await wait(100);
          if (isProcessAlive(runtime.pid)) fail("MLX_RUNTIME_UNAVAILABLE", "The MLX runtime acknowledged stop but has not exited; its ownership record was retained.");
        }
        delete state.value.runtimes[id];
        await writePrivate(statePath, state.value, state.raw);
        return { ...publicProfile(record), status: "stopped" };
      });
    },
  };
}
