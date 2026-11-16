import assert from "node:assert/strict";
import { test } from "node:test";
import { symbols } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SubagentRunId } from "@deepseek-ai/dsh-subagent";
import type { SubagentRunInfo } from "@deepseek-ai/dsh-subagent";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

async function publicationFixture() {
  const published = new WeakSet<Agent>();
  const f = await nativeRoutingFixture({}, { async beforeDsmm(ctx) {
    const registry = ctx.agents, runtime = ctx.subagents;
    const original = (value: object): object => Reflect.get(value, symbols.original) ?? value;
    const nativeRegistry = original(registry) as AgentRegistry;
    const roots = AgentRegistry.prototype.roots.bind(nativeRegistry), owned = AgentRegistry.prototype.isOwnedBy.bind(nativeRegistry);
    Object.defineProperties(original(registry), {
      roots: { value: undefined, configurable: true },
      isOwnedBy: { value: undefined, configurable: true },
    });
    Object.defineProperty(original(runtime), "rootOf", { configurable: true, value(agent: Agent): Agent {
      assert.equal(registry.get(agent.id), agent);
      if (roots().includes(agent)) return agent;
      if (!published.has(agent)) throw new Error("Native activation is not published");
      const parent = registry.list().find(candidate => owned(agent.id, candidate));
      assert.ok(parent);
      assert.ok(roots().includes(parent));
      return parent;
    } });
  } });
  return { ...f, publish(child: Agent, parent: Agent) {
    published.add(child);
    f.ctx.emit("subagent/start", { id: child.id, provider: "spawn", local: true,
      runId: SubagentRunId(`publication-${child.id}`), parentSessionId: parent.id } as SubagentRunInfo);
  } };
}

test("a created child cannot dispatch until native publication and admission complete", async () => {
  const f = await publicationFixture();
  try {
    const parent = await f.create({ agentPreset: "standard" });
    const child = await f.create({ agentPreset: "standard", origin: "subagent", parentSession: parent.id }, undefined, { parentAgent: parent });
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    child.ctx.on("agent/pre-step", async (_frame, next) => { entered(); return next(); }, { prepend: true });
    const running = runFixtureTurn(child);
    await waiting;
    assert.equal(f.adapter.calls.length, 0);
    assert.throws(() => f.ctx.dsmmNativeAdmission.assert(child), { code: "UNAUTHORIZED" });
    f.publish(child, parent);
    await running;
    assert.equal(f.adapter.calls.length, 1);
    assert.equal(f.adapter.calls[0].sessionId, child.id);
    assert.equal(f.ctx.dsmmNativeAdmission.owns(child), true);
  } finally { await f.dispose(); }
});

test("a child whose creator is no longer live remains refused after native publication", async () => {
  const f = await publicationFixture();
  try {
    const parent = await f.create({ agentPreset: "standard" });
    const child = await f.create({ agentPreset: "standard", origin: "subagent", parentSession: parent.id }, undefined, { parentAgent: parent });
    await f.disposeAgent(parent);
    f.publish(child, parent);
    await assert.rejects(f.ctx.dsmmNativeAdmission.ensure(child), { code: "UNAUTHORIZED" });
    child.followup(createUserMessage({ content: [{ type: "text", text: "Must not run" }], source: { kind: "user" } }));
    await child.whenIdle();
    assert.equal(f.adapter.calls.length, 0);
    assert.equal(f.ctx.dsmmNativeAdmission.owns(child), false);
  } finally { await f.dispose(); }
});
