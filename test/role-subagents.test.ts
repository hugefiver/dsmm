import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { nativeRoutingFixture } from "./native-routing-fixture.ts";
import type { DsmmProfileRuntime } from "../lib/profile-runtime.js";
import type { DshAgent } from "../lib/dsh-types.js";

test("headless role catalog is ready before assembly, defaults foreground, and follows explicit idle mode changes without desired remounts", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true }, { headless: true });
  try {
    const agent = await f.create();
    const admittedAgent = agent as unknown as DshAgent;
    const tools = agent.ctx.tools;
    assert.ok(tools.get("dsmm_reviewer", agent));
    const category = tools.schemas(agent).find(row => row.name === "dsmm_category")!;
    assert.equal((category.parameters as { properties: { category: { enum: string[] } } }).properties.category.enum.includes("dsmm-cross-cutting"), false);
    const background = await tools.execute({ name: "dsmm_reviewer", callId: ToolCallId("default-background-rejected"), arguments: { description: "Explicit unsupported background", prompt: "No background permission", run_in_background: true }, agent, signal: new AbortController().signal });
    assert.equal(background.isError, true);
    assert.equal(f.agents.list().length, 1);
    const runtime = f.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    const before = await runtime.getSession(admittedAgent);
    await runtime.selectMode({ sessionId: agent.id, active: false, expectedAdmissionEpoch: before.admissionEpoch, expectedModeRevision: before.deepwork!.revision }, admittedAgent);
    await f.ctx.systemPrompt.assemble({ scope: agent });
    assert.equal(tools.get("dsmm_reviewer", agent), undefined);
    const off = await runtime.getSession(admittedAgent);
    await runtime.selectMode({ sessionId: agent.id, active: true, expectedAdmissionEpoch: off.admissionEpoch, expectedModeRevision: off.deepwork!.revision }, admittedAgent);
    await f.ctx.systemPrompt.assemble({ scope: agent });
    assert.ok(tools.get("dsmm_reviewer", agent));
  } finally { await f.dispose(); }
});

test("native and headless ordinary roots consume the same enabled role policy", async () => {
  const catalogs: string[][] = [];
  for (const headless of [false, true]) {
    const f = await nativeRoutingFixture({ defaultActive: true, roles: { "dsmm-builder": false } }, { headless });
    try {
      const agent = await f.create();
      const catalog = agent.ctx.tools.schemas(agent).map((tool) => tool.name).filter((name) => name.startsWith("dsmm_")).sort();
      assert.equal(catalog.includes("dsmm_builder"), false);
      const category = agent.ctx.tools.schemas(agent).find(row => row.name === "dsmm_category")!;
      assert.equal((category.parameters as { properties: { category: { enum: string[] } } }).properties.category.enum.includes("dsmm-cross-cutting"), false);
      catalogs.push(catalog);
    } finally { await f.dispose(); }
  }
  assert.deepEqual(catalogs[0], catalogs[1]);
});
