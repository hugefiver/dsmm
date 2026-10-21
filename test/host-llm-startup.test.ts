import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const entry = process.env.DSMM_TEST_DSH_ENTRY;
const groups = [
  ["cold-start contract", "host-llm-cold-start.test.mjs"],
  ["parameter and native projection", "host-llm-review-parameters.test.mjs"],
  ["route and fallback authority", "host-llm-review-regressions.test.mjs"],
  ["captured policy continuity", "host-llm-review-capture.test.mjs"],
  ["historical capture restore", "host-llm-review-history.test.mjs"],
  ["request revocation", "host-llm-review-revocation.test.mjs"],
] as const;

for (const [contract, fixture] of groups) test(`native Host LLM ${contract}`, { skip: entry === undefined ? "requires an explicit installed DSH anchor" : false }, (t) => {
  const env: NodeJS.ProcessEnv = { ...process.env, DSMM_TEST_DSH_ENTRY: entry };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--import", "./test/child-admission-source-loader.mjs", "--test", "--test-concurrency=1", `./test/${fixture}`], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 120_000,
    env,
  });
  t.diagnostic(`${result.stdout}\n${result.stderr}`.trim());
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
