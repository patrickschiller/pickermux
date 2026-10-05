import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("MLX model store and profile server enforce offline identity, architecture and ownership boundaries", () => {
  const result = spawnSync("python3", ["-B", fileURLToPath(new URL("./mlx-model-store.test.py", import.meta.url))], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
