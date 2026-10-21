import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const entry = process.env.DSMM_TEST_DSH_ENTRY;
test("migrated native LLM, Core permission authority, ordinary entries and official CLI", { skip: entry === undefined ? "requires an explicit installed DSH anchor" : false }, t => {
  const env: NodeJS.ProcessEnv = { ...process.env, DSMM_TEST_DSH_ENTRY: entry === undefined ? undefined : realpathSync(entry) };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--import", "./test/prompt-source-loader.mjs", "--import", "./test/host-llm-source-loader.mjs",
    "--test", "--test-concurrency=1", "--test-timeout=25000", "./test/native-root-llm.test.mjs", "./test/core-permission-authority.test.mjs", "./test/native-core-review-regressions.test.mjs"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), env, encoding: "utf8", timeout: 180_000,
  });
  t.diagnostic(`${result.stdout}\n${result.stderr}`.trim());
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
