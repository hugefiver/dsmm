import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor } from "@deepseek-ai/dsh-subagent";
import { DsmmDeploymentConfig } from "../lib/deployment-config.js";
import type { DshAgent, DshContext } from "../lib/dsh-types.js";
import { classifyDsmmAgent } from "../lib/runtime-integration.js";
import { nativeRoutingFixture } from "./native-routing-fixture.ts";

test("Core-only admission preserves a foreign native role-named tool and executes its exact definition", async () => {
  let bodies = 0;
  const foreign = {
    name: "dsmm_coding", description: "Foreign native counter; no delegation", parameters: {},
    output: { schema: { type: "string" as const }, render: () => [] },
    async execute() { bodies++; return "foreign-native-result"; },
  };
  const f = await nativeRoutingFixture({}, {
    async beforeDsmm(ctx) {
      const deployment = new DsmmDeploymentConfig(ctx as unknown as DshContext, {});
      await deployment.saveGlobal({ expectedRevision: "absent", edits: [{ op: "set", path: ["modules", "deepwork", "enabled"], value: false }] }, () => {});
      ctx.tools.register(foreign);
    },
  });
  try {
    const root = await f.create();
    assert.equal(root.ctx.tools.get(foreign.name, root), foreign);
    const result = await root.ctx.tools.execute({ agent: root, name: foreign.name, arguments: {},
      callId: ToolCallId("foreign-role-name"), signal: new AbortController().signal });
    assert.notEqual(result.isError, true); assert.equal(result.value, "foreign-native-result");
    assert.equal(bodies, 1); assert.equal(f.adapter.calls.length, 0);
  } finally { await f.dispose(); }
});

test("an admitted DSMM delegation remains fenced when its native spawn provider retires", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true });
  try {
    const root = await f.create();
    assert.ok(root.ctx.tools.get("dsmm_category", root));
    await f.spawnFiber!.dispose();
    const result = await root.ctx.tools.execute({ agent: root, name: "dsmm_category",
      arguments: { category: "dsmm-coding", description: "Retired delivery", prompt: "Must not dispatch" },
      callId: ToolCallId("retired-owned-delegation"), signal: new AbortController().signal });
    assert.equal(result.isError, true); assert.equal(f.adapter.calls.length, 0);
  } finally { await f.dispose(); }
});

test("foreign native provider names and serialized descriptors cannot grant DSMM role authority", async () => {
  let unregister = () => {};
  const f = await nativeRoutingFixture({}, {
    persistence: true,
    async beforeDsmm(ctx) {
      const deployment = new DsmmDeploymentConfig(ctx as unknown as DshContext, {});
      await deployment.saveGlobal({ expectedRevision: "absent", edits: [{ op: "set", path: ["modules", "deepwork", "enabled"], value: false }] }, () => {});
      const spawn = ctx.subagents.getProvider("spawn")!;
      unregister = ctx.subagents.registerProvider({ name: "dsmm-role-coding", capabilities: spawn.capabilities, inheritsParentContext: false,
        prepareContinuable: request => spawn.prepareContinuable!(request) });
    },
  });
  try {
    const root = await f.create();
    const started = await f.subagents.startActivation({ provider: "dsmm-role-coding", label: "Foreign native child", delivery: "parent",
      request: { parent: root, prompt: [] }, signal: new AbortController().signal });
    try {
      const child = f.agents.get(started.childId)!;
      await child.whenIdle();
      assert.equal(classifyDsmmAgent(child), "native");
      assert.equal(f.ctx.get("dsmmProfileRuntime")!.hasAdmission(child as unknown as DshAgent), true);
      const persisted = Session.create(SessionId("descriptor-only-dsmm"));
      persisted.append("subagent/descriptor", snapshotSubagentDescriptor({ mode: "continuable", provider: "dsmm-role-coding", label: "Persisted DSMM child" }));
      let observed = 0;
      const seeded = await f.create({ origin: "subagent", parentSession: root.id, delegationDepth: 1 }, undefined, { parentAgent: root,
        seed: JSON.parse(JSON.stringify(persisted.snapshotEvents())), setup(_scope, agent) {
          observed++; assert.equal(classifyDsmmAgent(agent), "native");
          assert.ok(agent.session.snapshotEvents().some(event => event.type === "subagent/descriptor"));
        } });
      assert.equal(observed, 1);
      const seededView: Omit<DshAgent, "ctx"> = seeded;
      assert.equal(f.ctx.dsmmNativeAdmission.policy.identity(seededView).role, undefined);
      unregister();
      assert.equal(f.subagents.getProvider("dsmm-role-coding"), undefined);
      assert.equal(classifyDsmmAgent(child), "native");
    } finally { await f.subagents.drainChildren(root, [started.childId]); }
  } finally { await f.dispose(); }
});
