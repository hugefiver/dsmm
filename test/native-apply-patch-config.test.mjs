import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { configure, runCli, sse, successful, toolCall } from "./native-host-route-boundaries-fixture.mjs";
import { add, hostFixture, patch } from "./native-apply-patch-fixture.mjs";

const entry = process.env.DSMM_TEST_DSH_ENTRY;
for (const name of ["@deepseek-ai/dsh-tool-fs", "@dsmm/dsmm/permission-fs"]) {
  await test(`ordinary native profile tool-fs opt-in executes through ${name}`, {
    skip: entry === undefined ? "requires DSMM_TEST_DSH_ENTRY selecting a complete Host anchor" : false,
    timeout: 45_000
  }, async t => {
    const f = await hostFixture(entry);
    try {
      const native = await import(pathToFileURL(createRequire(f.nativeEntry).resolve("@deepseek-ai/dsh-tool-fs")).href);
      if (!Object.hasOwn(native.Config({}), "applyPatch")) { t.skip("selected Host has no native applyPatch config"); return; }
      await configure(f);
      const path = join(f.profileDir, "cordis.patch.yml"), rows = JSON.parse(await readFile(path, "utf8"));
      if (name === "@deepseek-ai/dsh-tool-fs") rows.push({ id: "tool-fs", config: { applyPatch: true } });
      else rows.push({ id: "tool-fs", disabled: true }, { insert: [{ id: "managed-tool-fs",
        name, config: { applyPatch: true } }] });
      await writeFile(path, JSON.stringify(rows));
      f.handler = (body, res) => f.requests.length === 1
        ? toolCall(res, body, "apply_patch", { input: patch(add("profile-opt-in.txt", "native-profile-opt-in")) })
        : sse(res, body, { content: "native-profile-complete" });
      const result = await runCli(f, "native-profile-opt-in"); successful(result);
      assert.equal(result.events.find(event => event.type === "tool_result")?.status, "completed");
      assert.equal(await readFile(join(f.workspace, "profile-opt-in.txt"), "utf8"), "native-profile-opt-in\n");
    } finally { await f.dispose(); }
  });
}
