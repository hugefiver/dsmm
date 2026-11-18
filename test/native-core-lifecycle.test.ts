import assert from "node:assert/strict";
import { test } from "node:test";
import { symbols } from "@deepseek-ai/cordis";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor } from "@deepseek-ai/dsh-subagent";
import { DsmmDeploymentConfig } from "../lib/deployment-config.js";
import type { DshAgent, DshContext } from "../lib/dsh-types.js";
import { classifyDsmmAgent } from "../lib/runtime-integration.js";
import { nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

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
    const admission = f.ctx.dsmmNativeAdmission as unknown as {
      admissionRoutes: WeakMap<object, object>; admissionRouteFailures: WeakMap<object, object>; assert(agent: object): unknown;
    };
    admission.admissionRoutes.delete(root); admission.admissionRouteFailures.delete(root);
    assert.doesNotThrow(() => admission.assert(root), "no cache and no failure remains an admitted baseline");
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
    const root = await f.create({ agentPreset: "dsmm-orchestrator" });
    assert.ok(root.ctx.tools.get("dsmm_category", root));
    await f.spawnFiber!.dispose();
    const result = await root.ctx.tools.execute({ agent: root, name: "dsmm_category",
      arguments: { category: "dsmm-coding", description: "Retired delivery", prompt: "Must not dispatch" },
      callId: ToolCallId("retired-owned-delegation"), signal: new AbortController().signal });
    assert.equal(result.isError, true); assert.equal(f.adapter.calls.length, 0);
  } finally { await f.dispose(); }
});

for (const dsmmLlm of [false, true]) test(`compiled Core replacement keeps physical roots on the resident ${dsmmLlm ? "DSMM" : "stock"} LLM`, async () => {
  const config = { defaultActive: false, lsp: { enabled: false }, subagents: { toolTopology: "per-role" as const } };
  const f = await nativeRoutingFixture(config, { compiledCore: true, nativePermissionSettings: true, dsmmLlm });
  try {
    const ordinary = await f.create({ agentPreset: "standard" });
    const dw = await f.create({ agentPreset: "dsmm-orchestrator" });
    const child = await f.create({ origin: "subagent", parentSession: ordinary.id, delegationDepth: 1 }, undefined, { parentAgent: ordinary });
    const old = f.ctx.dsmmNativeAdmission, provider = f.subagents.getProvider("dsmm-role-reviewer")!;
    const oldDefinition = dw.ctx.tools.get("dsmm_reviewer", dw);
    assert.ok(oldDefinition); assert.ok(old.assert(child));
    const llm = Reflect.get(f.ctx.llm, symbols.original) ?? f.ctx.llm, sessions = [ordinary.session, dw.session];
    const errors: unknown[] = [];
    f.ctx.on("agent/error", ({ error }) => { errors.push(error); }, { global: true });
    await runFixtureTurn(ordinary); await runFixtureTurn(dw);
    assert.deepEqual(errors, []);
    assert.deepEqual(f.adapter.calls.map(call => call.sessionId), [ordinary.id, dw.id]);
    await f.dsmmFiber.dispose();
    await runFixtureTurn(dw);
    assert.equal(f.adapter.calls.length, 2);
    assert.ok(errors.length, "the next turn fails without a successor");
    errors.length = 0;

    await f.mountSuccessorCore({ ...config, subagents: { toolTopology: "parameterized" },
      roleRouting: { "dsmm-reviewer": { primary: { provider: "fixture", model: "successor-review" } } } });
    assert.equal(Reflect.get(f.ctx.llm, symbols.original) ?? f.ctx.llm, llm);
    assert.equal(f.agents.get(child.id), child);
    await runFixtureTurn(child);
    assert.equal(f.adapter.calls.length, 2);
    assert.ok(errors.length, "a retained child is not enrolled by its parent's successor");
    errors.length = 0;
    await runFixtureTurn(ordinary);
    assert.deepEqual(errors, []);
    assert.equal(f.adapter.calls.at(-1)?.sessionId, ordinary.id);
    let delegated = false;
    f.adapter.streamChunks = async function* (request) {
      if (request.sessionId === dw.id && !delegated) {
        delegated = true;
        const id = ToolCallId("successor-review-call"), name = "dsmm_role";
        const args = JSON.stringify({ role: "dsmm-reviewer", description: "Review the fixture", prompt: "Review on the new Core" });
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield { type: "tool-call-delta", index: 0, id, name, argumentsDelta: args };
        yield { type: "block-end", index: 0, block: { type: "tool-call", id, name, arguments: args } };
        yield { type: "finish", reason: { kind: "tool-calls" } };
      } else {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "Review complete" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "Review complete" } };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    };
    await runFixtureTurn(dw);
    assert.deepEqual(errors, []);
    const [proposed, reviewed, completed] = f.adapter.calls.slice(3);
    assert.equal(proposed?.sessionId, dw.id);
    assert.ok(proposed.tools?.some(tool => tool.name === "dsmm_role"));
    assert.ok(!proposed.tools?.some(tool => tool.name === oldDefinition.name));
    assert.equal(reviewed?.model, "successor-review");
    assert.equal((await f.subagents.listChildren(dw.id)).some(row => row.id === reviewed.sessionId), true);
    assert.equal(completed?.sessionId, dw.id);
    assert.ok(completed.messages.some(message => message.role === "tool" && message.toolCallId === "successor-review-call"
      && !message.isError && message.content.some(block => block.type === "text" && block.text.includes("Review complete"))));
    for (const [index, root] of [ordinary, dw].entries()) {
      assert.equal(f.agents.get(sessions[index].id), root);
      assert.equal(root.session, sessions[index]);
      assert.ok(f.ctx.dsmmNativeAdmission.assert(root));
      await assert.rejects(old.guardExecution(root));
    }
    assert.equal(f.ctx.dsmmNativeAdmission.owns(child), false);
    await assert.rejects(provider.prepareContinuable!({ parent: dw, cwd: f.profileDir,
      sessionId: SessionId("old-reviewer-probe"), signal: new AbortController().signal }));
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
