import assert from "node:assert/strict";
import {
  chmod,
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_CREDENTIAL_LOOKUP_TIMEOUT_MS,
  KEYCHAIN_SECURITY_PATH,
  createCredentialResolver,
  deleteProviderCredential,
  keychainReferenceForProvider,
  listRegisteredKeychainProviderIds,
  providerCredentialStatus,
  purgeKeychainProviderRegistry,
  registerKeychainProvider,
  setProviderCredential,
  unregisterKeychainProvider,
} from "../src/keychain-credentials.mjs";

const keychainProvider = Object.freeze({
  id: "vendor_local",
  credentialKeychain: true,
});

async function registryFixture(t, label = "") {
  const root = await mkdtemp(
    path.join(os.tmpdir(), `pickermux-keychain-registry-${label}`),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryDirectory = path.join(root, "model-bridge");
  const registryPath = path.join(registryDirectory, "keychain-state.json");
  return { root, registryDirectory, registryPath };
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("derives stable provider-scoped Keychain coordinates", () => {
  assert.deepEqual(keychainReferenceForProvider(keychainProvider), {
    service: "com.local.codex-model-bridge.provider.vendor_local",
    account: "vendor_local",
  });
  assert.deepEqual(
    keychainReferenceForProvider({ providerId: "vendor_local" }),
    keychainReferenceForProvider("vendor_local"),
  );
  assert.throws(
    () => keychainReferenceForProvider("../../unsafe"),
    /not valid/u,
  );
});

test("resolves named environment credentials without exposing their value", async () => {
  const resolver = createCredentialResolver({
    environment: { VENDOR_TOKEN: "environment-secret" },
  });
  assert.equal(
    await resolver({ id: "vendor", credentialEnv: "VENDOR_TOKEN" }),
    "environment-secret",
  );
  await assert.rejects(
    createCredentialResolver({ environment: {} })({
      id: "vendor",
      credentialEnv: "VENDOR_TOKEN",
    }),
    (error) => {
      assert.equal(error.code, "PROVIDER_CREDENTIAL_ERROR");
      assert.match(error.message, /VENDOR_TOKEN/u);
      assert.doesNotMatch(error.message, /environment-secret/u);
      return true;
    },
  );
});

test("coalesces Keychain lookup and caches successful values for the TTL", async () => {
  let clock = 1_000;
  let calls = 0;
  const seen = [];
  const resolver = createCredentialResolver({
    ttlMs: 100,
    now: () => clock,
    execFileImpl: async (file, args, options) => {
      calls += 1;
      seen.push({ file, args, options });
      await Promise.resolve();
      return { stdout: `keychain-secret-${calls}\n` };
    },
  });

  const [first, concurrent] = await Promise.all([
    resolver(keychainProvider),
    resolver(keychainProvider),
  ]);
  assert.equal(first, "keychain-secret-1");
  assert.equal(concurrent, first);
  assert.equal(await resolver(keychainProvider), first);
  assert.equal(calls, 1);
  assert.deepEqual(seen[0], {
    file: KEYCHAIN_SECURITY_PATH,
    args: [
      "find-generic-password",
      "-s",
      "com.local.codex-model-bridge.provider.vendor_local",
      "-a",
      "vendor_local",
      "-w",
    ],
    options: {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: DEFAULT_CREDENTIAL_LOOKUP_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  });

  clock += 101;
  assert.equal(await resolver(keychainProvider), "keychain-secret-2");
  resolver.clear(keychainProvider);
  assert.equal(await resolver(keychainProvider), "keychain-secret-3");
});

test("redacts subprocess output and secrets from lookup errors", async () => {
  const resolver = createCredentialResolver({
    execFileImpl: async () => {
      const error = new Error("security leaked top-secret-value");
      error.stdout = "top-secret-value";
      error.stderr = "top-secret-value";
      throw error;
    },
  });
  await assert.rejects(resolver(keychainProvider), (error) => {
    assert.equal(error.name, "ProviderCredentialError");
    assert.equal(error.code, "PROVIDER_CREDENTIAL_ERROR");
    assert.equal(error.providerId, "vendor_local");
    assert.doesNotMatch(String(error), /top-secret-value/u);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("times out hung lookups, coalesces waiters, and releases pending state", {
  timeout: 1_000,
}, async () => {
  let calls = 0;
  const optionsSeen = [];
  const resolver = createCredentialResolver({
    lookupTimeoutMs: 20,
    execFileImpl: async (file, args, options) => {
      calls += 1;
      optionsSeen.push(options);
      if (calls === 1) return new Promise(() => {});
      return { stdout: "recovered-secret\n" };
    },
  });

  const first = resolver(keychainProvider);
  const concurrent = resolver(keychainProvider);
  await Promise.all([
    assert.rejects(first, (error) => {
      assert.equal(error.name, "ProviderCredentialError");
      assert.equal(error.code, "PROVIDER_CREDENTIAL_ERROR");
      assert.equal(error.providerId, "vendor_local");
      assert.doesNotMatch(String(error), /deadline|timeout|secret/u);
      return true;
    }),
    assert.rejects(concurrent, (error) => {
      assert.equal(error.code, "PROVIDER_CREDENTIAL_ERROR");
      return true;
    }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(optionsSeen[0], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 20,
    killSignal: "SIGKILL",
  });

  assert.equal(await resolver(keychainProvider), "recovered-secret");
  assert.equal(calls, 2);
});

test("reports credential availability without returning credential data", async () => {
  assert.deepEqual(
    await providerCredentialStatus(
      { id: "vendor", credentialEnv: "VENDOR_TOKEN" },
      { environment: { VENDOR_TOKEN: "must-not-leak" } },
    ),
    {
      providerId: "vendor",
      source: "environment",
      configured: true,
      available: true,
    },
  );

  const calls = [];
  const status = await providerCredentialStatus(keychainProvider, {
    execFileImpl: async (file, args, options) => {
      calls.push({ file, args, options });
      const missing = new Error("not found");
      missing.code = 44;
      throw missing;
    },
  });
  assert.deepEqual(status, {
    providerId: "vendor_local",
    source: "keychain",
    configured: true,
    available: false,
  });
  assert.equal(calls[0].args.includes("-w"), false);
  assert.equal(JSON.stringify(status).includes("must-not-leak"), false);
});

test("bounds credential status lookups and redacts timeout failures", {
  timeout: 1_000,
}, async () => {
  let optionsSeen;
  await assert.rejects(
    providerCredentialStatus(keychainProvider, {
      lookupTimeoutMs: 20,
      execFileImpl: async (file, args, options) => {
        optionsSeen = options;
        return new Promise(() => {});
      },
    }),
    (error) => {
      assert.equal(error.name, "ProviderCredentialError");
      assert.equal(error.code, "PROVIDER_CREDENTIAL_ERROR");
      assert.equal(error.providerId, "vendor_local");
      assert.doesNotMatch(String(error), /deadline|timeout/u);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.deepEqual(optionsSeen, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 20,
    killSignal: "SIGKILL",
  });
});

test("sets credentials through inherited stdio with bare final -w", async () => {
  let invocation;
  await setProviderCredential(keychainProvider, {
    execFileImpl: async (file, args, options) => {
      invocation = { file, args, options };
      return {};
    },
  });
  assert.equal(invocation.file, KEYCHAIN_SECURITY_PATH);
  assert.equal(invocation.args.at(-1), "-w");
  assert.deepEqual(invocation.options, { stdio: "inherit" });
  assert.equal(invocation.args.some((arg) => /secret|token/u.test(arg)), false);
});

test("deletes exact provider items and treats an absent item as already deleted", async () => {
  let invocation;
  assert.equal(
    await deleteProviderCredential(keychainProvider, {
      execFileImpl: async (file, args, options) => {
        invocation = { file, args, options };
        return {};
      },
    }),
    true,
  );
  assert.deepEqual(invocation.args, [
    "delete-generic-password",
    "-s",
    "com.local.codex-model-bridge.provider.vendor_local",
    "-a",
    "vendor_local",
  ]);
  assert.deepEqual(invocation.options, { stdio: "inherit" });

  assert.equal(
    await deleteProviderCredential(keychainProvider, {
      execFileImpl: async () => {
        const missing = new Error("not found");
        missing.code = 44;
        throw missing;
      },
    }),
    false,
  );
});

test("private Keychain provider registry records only canonical provider ids", async (t) => {
  const { registryPath } = await registryFixture(t, "canonical-");

  assert.deepEqual(
    await listRegisteredKeychainProviderIds({ registryPath }),
    [],
  );
  assert.deepEqual(
    await registerKeychainProvider("vendor_z", { registryPath }),
    {
      providerId: "vendor_z",
      added: true,
      providerIds: ["vendor_z"],
    },
  );
  assert.deepEqual(
    await registerKeychainProvider({ id: "alpha" }, { registryPath }),
    {
      providerId: "alpha",
      added: true,
      providerIds: ["alpha", "vendor_z"],
    },
  );
  assert.deepEqual(
    await registerKeychainProvider("vendor_z", { registryPath }),
    {
      providerId: "vendor_z",
      added: false,
      providerIds: ["alpha", "vendor_z"],
    },
  );

  const raw = await readFile(registryPath, "utf8");
  const stored = JSON.parse(raw);
  assert.deepEqual(stored, {
    schemaVersion: 1,
    product: "pickermux",
    owner: "pickermux-keychain-provider-registry",
    providerIds: ["alpha", "vendor_z"],
  });
  assert.equal((await stat(registryPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(registryPath))).mode & 0o777, 0o700);
  assert.doesNotMatch(raw, /credential|password|secret|token/iu);

  assert.deepEqual(
    await unregisterKeychainProvider("alpha", { registryPath }),
    {
      providerId: "alpha",
      removed: true,
      providerIds: ["vendor_z"],
    },
  );
  assert.deepEqual(
    await unregisterKeychainProvider("already_absent", { registryPath }),
    {
      providerId: "already_absent",
      removed: false,
      providerIds: ["vendor_z"],
    },
  );
  assert.deepEqual(
    await listRegisteredKeychainProviderIds(registryPath),
    ["vendor_z"],
  );
});

test("Keychain provider registry rejects unsafe ids, symlinks and public state", async (t) => {
  const {
    root,
    registryDirectory,
    registryPath,
  } = await registryFixture(t, "unsafe-");
  await mkdir(registryDirectory, { mode: 0o700 });

  await assert.rejects(
    registerKeychainProvider("../../unsafe", { registryPath }),
    /provider id is not valid/iu,
  );

  const target = path.join(root, "do-not-touch.json");
  await writeFile(target, "foreign\n", { mode: 0o600 });
  await symlink(target, registryPath);
  await assert.rejects(
    listRegisteredKeychainProviderIds({ registryPath }),
    /must be a regular file/iu,
  );
  assert.equal(await readFile(target, "utf8"), "foreign\n");
  await rm(registryPath);

  await registerKeychainProvider("vendor", { registryPath });
  await chmod(registryPath, 0o644);
  await assert.rejects(
    listRegisteredKeychainProviderIds({ registryPath }),
    /permissions are not private/iu,
  );
  await chmod(registryPath, 0o600);
  await chmod(registryDirectory, 0o755);
  await assert.rejects(
    listRegisteredKeychainProviderIds({ registryPath }),
    /directory permissions are not private/iu,
  );
});

test("Keychain provider registry rejects non-canonical or extended receipts", async (t) => {
  const { registryPath } = await registryFixture(t, "invalid-");
  await registerKeychainProvider("vendor", { registryPath });

  const receipt = JSON.parse(await readFile(registryPath, "utf8"));
  receipt.unexpected = true;
  await writeFile(registryPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  await assert.rejects(
    listRegisteredKeychainProviderIds({ registryPath }),
    /unsupported fields/iu,
  );

  delete receipt.unexpected;
  receipt.providerIds = ["vendor", "vendor"];
  await writeFile(registryPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  await assert.rejects(
    listRegisteredKeychainProviderIds({ registryPath }),
    /unique and sorted/iu,
  );
});

test("Keychain provider ids are bounded centrally at 127 characters", async (t) => {
  const { registryPath } = await registryFixture(t, "provider-length-");
  const maximum = `a${"b".repeat(125)}c`;
  const oversized = `${maximum}d`;

  assert.equal(maximum.length, 127);
  assert.equal(oversized.length, 128);
  assert.equal(keychainReferenceForProvider(maximum).account, maximum);
  await registerKeychainProvider(maximum, { registryPath });
  assert.deepEqual(
    await listRegisteredKeychainProviderIds({ registryPath }),
    [maximum],
  );
  assert.throws(
    () => keychainReferenceForProvider(oversized),
    /not valid/iu,
  );
  await assert.rejects(
    registerKeychainProvider(oversized, { registryPath }),
    /not valid/iu,
  );
});

test("Keychain provider registry requires its exact managed path", async (t) => {
  const { root, registryDirectory, registryPath } = await registryFixture(
    t,
    "path-",
  );
  await mkdir(registryDirectory, { mode: 0o700 });

  await assert.rejects(
    listRegisteredKeychainProviderIds({
      registryPath: path.join(registryDirectory, "providers.json"),
    }),
    /exact keychain-state\.json filename/iu,
  );
  await assert.rejects(
    listRegisteredKeychainProviderIds({
      registryPath: path.join(root, "private", "keychain-state.json"),
    }),
    /directly inside a non-root model-bridge directory/iu,
  );

  await rm(registryDirectory, { recursive: true });
  const foreignDirectory = path.join(root, "foreign-directory");
  await mkdir(foreignDirectory, { mode: 0o700 });
  await symlink(foreignDirectory, registryDirectory);
  await assert.rejects(
    listRegisteredKeychainProviderIds({ registryPath }),
    /directory must be a real directory/iu,
  );
});

test("Keychain provider registry rejects state larger than 64 KiB", async (t) => {
  const { registryDirectory, registryPath } = await registryFixture(
    t,
    "oversized-",
  );
  await mkdir(registryDirectory, { mode: 0o700 });
  await writeFile(registryPath, Buffer.alloc((64 * 1024) + 1, 0x20), {
    mode: 0o600,
  });
  await assert.rejects(
    listRegisteredKeychainProviderIds({ registryPath }),
    /exceeds the size limit/iu,
  );
});

test("Keychain provider registry purge stages, validates and removes exact state", async (t) => {
  const { registryDirectory, registryPath } = await registryFixture(
    t,
    "purge-",
  );
  await registerKeychainProvider("alpha", { registryPath });
  await registerKeychainProvider("vendor", { registryPath });

  assert.deepEqual(
    await purgeKeychainProviderRegistry({
      registryPath,
      expectedProviderIds: ["alpha", "vendor"],
    }),
    {
      changed: true,
      providerIds: ["alpha", "vendor"],
      cleanupPendingPath: null,
    },
  );
  assert.equal(await exists(registryPath), false);
  assert.deepEqual(await readdir(registryDirectory), []);
});

test("Keychain provider registry purge rolls back before commit", async (t) => {
  const { registryDirectory, registryPath } = await registryFixture(
    t,
    "purge-rollback-",
  );
  await registerKeychainProvider("vendor", { registryPath });

  await assert.rejects(
    purgeKeychainProviderRegistry({
      registryPath,
      expectedProviderIds: ["vendor"],
      beforeCommit: async () => {
        throw new Error("stop before commit");
      },
    }),
    /stop before commit/iu,
  );
  assert.deepEqual(
    await listRegisteredKeychainProviderIds({ registryPath }),
    ["vendor"],
  );
  assert.deepEqual(await readdir(registryDirectory), ["keychain-state.json"]);
});

test("Keychain provider registry purge retains post-commit drift", async (t) => {
  const { registryDirectory, registryPath } = await registryFixture(
    t,
    "purge-drift-",
  );
  await registerKeychainProvider("vendor", { registryPath });
  let quarantinePath;

  const result = await purgeKeychainProviderRegistry({
    registryPath,
    expectedProviderIds: ["vendor"],
    beforeCommit: async () => {
      const [quarantineName] = (await readdir(registryDirectory)).filter(
        (name) => name.endsWith(".staging"),
      );
      quarantinePath = path.join(registryDirectory, quarantineName);
      await writeFile(quarantinePath, `${JSON.stringify({
        schemaVersion: 1,
        product: "pickermux",
        owner: "pickermux-keychain-provider-registry",
        providerIds: ["foreign"],
      })}\n`, { mode: 0o600 });
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.cleanupPendingPath, quarantinePath);
  assert.equal(await exists(registryPath), false);
  assert.equal(await exists(quarantinePath), true);
  assert.match(await readFile(quarantinePath, "utf8"), /"foreign"/u);
});
