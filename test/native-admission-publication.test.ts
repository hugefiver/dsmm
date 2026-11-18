import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { symbols } from "@deepseek-ai/cordis";
import { createUserMessage, ToolCallId } from "@deepseek-ai/dsh-llm";
import { SubagentRunId } from "@deepseek-ai/dsh-subagent";
import type { SubagentRunInfo } from "@deepseek-ai/dsh-subagent";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { executeFixtureTool, nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

async function publicationFixture() {
  const published = new WeakSet<Agent>();
  const f = await nativeRoutingFixture({}, { nativeFs: true, async beforeDsmm(ctx) {
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

test("a turn and tool started during child revalidation use the same publication result", async t => {
  for (const outcome of ["published", "failed", "revoked"] as const) await t.test(outcome, async t => {
    const f = await publicationFixture();
    const revalidating = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    try {
      const parent = await f.create({ agentPreset: "standard" });
      const child = await f.create({ agentPreset: "standard", origin: "subagent", parentSession: parent.id }, undefined, { parentAgent: parent });
      const admission = f.ctx.dsmmNativeAdmission, profiles = admission.profiles;
      const revalidate = profiles.revalidateActivation.bind(profiles);
      const failure = new Error("Child revalidation failed");
      t.mock.method(profiles, "revalidateActivation", async (...args: Parameters<typeof revalidate>) => {
        revalidating.resolve();
        await resume.promise;
        if (outcome === "failed") throw failure;
        await revalidate(...args);
      });
      const file = join(f.profileDir, "publication.txt"), marker = "read by the original child call";
      writeFileSync(file, marker);
      f.publish(child, parent);
      await revalidating.promise;

      const turnEntered = Promise.withResolvers<void>(), toolEntered = Promise.withResolvers<void>();
      let executions = 0;
      child.ctx.on("agent/pre-step", async (_frame, next) => { turnEntered.resolve(); return next(); }, { prepend: true });
      child.ctx.on("tools/pre-execute", async (_exec, next) => { toolEntered.resolve(); return next(); }, { prepend: true });
      child.ctx.on("tools/execute", async (_exec, next) => { executions++; return next(); });
      const running = runFixtureTurn(child);
      const reading = executeFixtureTool(child.ctx.tools, { agent: child, name: "read", callId: ToolCallId("publication-read"),
        arguments: { file_path: file }, signal: new AbortController().signal });
      await Promise.all([turnEntered.promise, toolEntered.promise]);
      const stepCount = () => child.session.snapshotEvents().filter(event => event.type === "step/start").length;
      assert.equal(stepCount(), 0);
      assert.equal(executions, 0);
      assert.equal(f.adapter.calls.length, 0);
      if (outcome === "revoked") await f.disposeAgent(parent);
      resume.resolve();

      if (outcome === "published") await admission.ensure(child);
      else if (outcome === "failed") await assert.rejects(admission.ensure(child), error => error === failure);
      else await assert.rejects(admission.ensure(child));
      const [result] = await Promise.all([reading, running]);
      assert.equal(result.isError, outcome !== "published", JSON.stringify(result));
      const count = outcome === "published" ? 1 : 0;
      assert.equal(stepCount(), count);
      assert.equal(executions, count);
      assert.deepEqual(f.adapter.calls.map(call => call.sessionId), count ? [child.id] : []);
      if (outcome === "published") assert.ok(result.content.some(block => block.type === "text" && block.text.includes(marker)), JSON.stringify(result));
    } finally { resume.resolve(); await f.dispose(); }
  });
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
