import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const anchor = process.env.DSMM_TEST_DSH_ENTRY ?? process.env.DSMM_COLD_PROFILE_SDK_ANCHOR;
test("default DSMM product bundle supports official native launch, delegation, Settings HMR and cold reopen", {
  timeout: 240_000, skip: anchor === undefined ? "requires an explicit installed full DSH SDK anchor" : false,
}, t => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ["--expose-internals", "--test", "--test-concurrency=1",
    fileURLToPath(new URL("./native-runtime-bundle.test.mjs", import.meta.url))], { env, encoding: "utf8", timeout: 230_000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr + child.stdout);
  t.diagnostic(child.stdout.trim());
});
