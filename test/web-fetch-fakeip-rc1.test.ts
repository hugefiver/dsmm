import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const entry = process.env.DSMM_TEST_DSH_ENTRY;

test("rc.1 Fake-IP adapter enforces local denies before native dispatch", {
  skip: entry === undefined ? "requires an explicit installed DSH rc.1 anchor" : false,
}, t => {
  const env: NodeJS.ProcessEnv = { ...process.env, DSMM_TEST_DSH_ENTRY: entry };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types", "--test", "--test-concurrency=1", "./test/web-fetch-fakeip-rc1.fixture.mjs",
  ], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), env, encoding: "utf8", timeout: 20_000,
  });
  t.diagnostic(`${result.stdout}\n${result.stderr}`.trim());
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
