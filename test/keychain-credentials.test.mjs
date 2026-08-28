import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CREDENTIAL_LOOKUP_TIMEOUT_MS,
  KEYCHAIN_SECURITY_PATH,
  createCredentialResolver,
  deleteProviderCredential,
  keychainReferenceForProvider,
  providerCredentialStatus,
  setProviderCredential,
} from "../src/keychain-credentials.mjs";

const keychainProvider = Object.freeze({
  id: "vendor_local",
  credentialKeychain: true,
});

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
