import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const loader = new URL("./prompt-source-loader.mjs", import.meta.url).href;
const fixture = fileURLToPath(new URL("./host-core-integration.test.mjs", import.meta.url));

test("package MAIN executes its real Host admission, native lifecycle and Core regression suite", { timeout: 70000 }, (t) => {
  const env = { ...process.env };
  // This subprocess owns a new runner, not the parent's node:test IPC context.
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--import", loader, "--test", "--test-reporter=tap", "--test-concurrency=1", fixture], {
    encoding: "utf8", timeout: 60000, env,
  });
  if (child.error !== undefined) t.diagnostic(child.stderr + child.stdout);
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr + child.stdout);
  t.diagnostic(child.stdout.trim());
});
