import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("ordinary Root and DSMM role public module delivery", { skip: process.env.DSMM_TEST_DSH_ENTRY === undefined ? "requires an explicit installed DSH anchor" : false }, t => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--import", "./test/prompt-source-loader.mjs", "--import", "./test/host-llm-source-loader.mjs",
    "--test", "--test-concurrency=1", "./test/ordinary-module-delivery.test.mjs"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), env, encoding: "utf8", timeout: 150000,
  });
  t.diagnostic(`${result.stdout}\n${result.stderr}`.trim());
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
