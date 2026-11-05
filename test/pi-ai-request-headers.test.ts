import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const entry = process.env.DSMM_TEST_DSH_ENTRY;
test("isolated anchored Pi-AI request headers", { skip: entry === undefined ? "requires an explicit installed SDK anchor" : false }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsmm-headers-process-")));
  try {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    for (const key of Object.keys(env)) if (/^(?:DSH_|DSMM_|XDG_)/iu.test(key) || /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)
      || /^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)$/iu.test(key)) delete env[key];
    Object.assign(env, { DSMM_TEST_DSH_ENTRY: entry, DSMM_HEADERS_TEST_ROOT: root,
      DSH_HOME: join(root, "home"), HOME: join(root, "home"), USERPROFILE: join(root, "home"),
      DSH_AGENTS_HOME: join(root, "agents"), DSH_TELEMETRY_DISABLED: "1", APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"),
      XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
      NO_PROXY: "127.0.0.1,localhost" });
    await mkdir(join(root, "workspace"));
    const source = fileURLToPath(new URL("../", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", new URL("./pi-ai-request-headers-loader.mjs", import.meta.url).href, "--test", "--test-concurrency=1", join(source, "test/pi-ai-request-headers.test.mjs")], {
      cwd: join(root, "workspace"), env, stdio: "inherit", timeout: 45_000,
    });
    assert.ifError(result.error); assert.equal(result.status, 0);
  } finally {
    assert.equal(await realpath(root), root); assert.equal(dirname(root), await realpath(tmpdir()));
    await rm(root, { recursive: true });
  }
});
