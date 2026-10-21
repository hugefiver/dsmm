import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

for (const preset of [undefined, "dsmm-orchestrator"]) test(`ordinary ${preset ?? "CLI Root"} loads native adapters and preserves cold-off tools`, {
  skip: !process.env.DSMM_TEST_DSH_ENTRY, timeout: 60000,
}, async t => {
  const { nativeRootLlmFixture, loadNative } = await import("./native-root-llm-fixture.mjs");
  const { ToolCallId } = await loadNative("@deepseek-ai/dsh-llm");
  for (const enabled of [true, false]) await t.test(enabled ? "rules mounted" : "cold off", async t => {
    const f = await nativeRootLlmFixture(t, { defaultActive: false, permissionControl: { enabled } }, {
      globalConfig: { permissionControl: { enabled, outsideReads: "deny", webSearch: { enabled: false }, webFetch: { enabled: false }, nativeCommands: { enabled: false, entries: [] } } },
    });
    const agent = await f.create(preset);
    const tools = f.ctx.get("agentPresets").serviceFor(agent, "tools") ?? f.ctx.tools;
    const names = ["read", "glob", "grep", "web_search", "web_fetch"];
    for (const name of names) assert.ok(tools.get(name, agent), `${name} must be available through the ordinary source`);
    const controller = f.ctx.get("dsmmPermissionController");
    if (enabled) {
      const coverage = controller.toolCoverage(agent);
      assert.deepEqual(coverage.map(row => row.name).sort(), [...names].sort());
      assert.equal(coverage.find(row => row.name === "read").pathEvidence, "native-fs");
      assert.equal(coverage.find(row => row.name === "glob").pathEvidence, "requires-colocation");
    } else {
      assert.equal(controller.rules.status().mounted, false);
      assert.deepEqual(controller.toolCoverage(agent), []);
    }
    const inside = join(f.workspace, "ordinary-read.txt"), outside = join(f.root, "outside-read.txt");
    await writeFile(inside, "owned ordinary native read");
    await writeFile(outside, "owned outside native read");
    let sequence = 0;
    const execute = (name, args) => tools.execute({ agent, name, arguments: args, callId: ToolCallId(`ordinary-${++sequence}`), signal: new AbortController().signal });
    const read = await execute("read", { file_path: inside });
    assert.equal(read.isError, false);
    assert.ok(read.content.some(block => block.type === "text" && block.text.includes("owned ordinary native read")));
    if (enabled) {
      assert.equal((await execute("read", { file_path: outside })).isError, true);
      assert.equal((await execute("web_fetch", { url: "http://127.0.0.1/ordinary-refused" })).isError, true);
    }
    assert.equal(f.bodies.length, 0);
    assert.deepEqual(f.errors, []);
  });
});
