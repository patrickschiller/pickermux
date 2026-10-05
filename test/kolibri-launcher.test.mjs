import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Kolibri launcher validates its offline runtime and loopback boundaries", () => {
  const fixture = fileURLToPath(new URL("./kolibri-launcher.test.py", import.meta.url));
  const result = spawnSync("python3", ["-B", fixture], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
