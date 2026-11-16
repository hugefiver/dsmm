import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import * as NativeSubagentTool from "@deepseek-ai/dsh-tool-subagent";
import { delegationDepthOf } from "@deepseek-ai/dsh-subagent";
import { readDelegationCeiling } from "../src/session-metadata.js";
import type { DsmmProfileRuntime } from "../src/profile-runtime.js";
import { nativeRoutingFixture, executeFixtureTool } from "./native-routing-fixture.ts";

let callSequence = 0;
function invoke(agent: Agent, name: string, args: unknown) {
  return executeFixtureTool(agent.ctx.tools, { agent, name, arguments: args,
    callId: ToolCallId(`native-tree-${++callSequence}`), signal: new AbortController().signal });
}

for (const explicitDepth of [true, false]) test(`ordinary native grandchildren cold-resume with original identity and current captured profile; explicit DSMM depth=${explicitDepth}`, {
  skip: process.env.DSMM_TEST_DSH_ENTRY === undefined, timeout: 20000
}, async () => {
  const f = await nativeRoutingFixture({}, { persistence: true, nativeControls: true, nativeFs: true,
    ...(explicitDepth ? { nativeSubagents: { maxDepth: 4 } } : {}),
    beforeDsmm: async ctx => { await ctx.plugin(NativeSubagentTool, { provider: "spawn", maxDepth: explicitDepth ? 4 : 2 }).await(); } });
  let reopened: AgentHandle | undefined;
  let release!: () => void;
  let held = new Promise<void>(resolve => { release = resolve; });
  let releaseCold = () => {};
  let coldId: string | undefined, enteredCold: (() => void) | undefined;
  f.adapter.beforeStream = async options => {
    if (options.sessionId === coldId) enteredCold?.();
    let abort!: () => void;
    const cancelled = new Promise<void>(resolve => { abort = resolve; });
    options.signal!.addEventListener("abort", abort, { once: true });
    try { await Promise.race([held, cancelled]); }
    finally { options.signal!.removeEventListener("abort", abort); }
  };
  const spawn = async (parent: Agent) => {
    const result = await invoke(parent, "subagent", { description: "Native tree member", prompt: "Continue native work" });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.ok(typeof result.value === "object" && result.value !== null && "name" in result.value && typeof result.value.name === "string");
    const runtime = f.subagents as unknown as { resolveName(agent: Agent, name: string, signal: AbortSignal): Promise<string> };
    return runtime.resolveName(parent, result.value.name, new AbortController().signal);
  };
  try {
    const profiles = f.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    const deployment = f.ctx.get("dsmmDeploymentConfig")!;
    if (explicitDepth) {
      const initial = await deployment.readGlobal();
      await deployment.saveGlobal({ expectedRevision: initial.revision, edits: [{ op: "set", path: ["subagents", "maxDepth"], value: 2 }] }, () => {});
    }
    const saved = await profiles.save({ id: "native-original", expectedRevision: null, content: JSON.stringify({ version: 1, id: "native-original", settings: { defaultActive: true } }) });
    const selected = await profiles.select({ id: saved.id, expectedRevision: saved.revision, expectedSelectionRevision: "absent" });
    const root = await f.create({ agentPreset: "standard" });
    const a = f.agents.get(await spawn(root)); assert.ok(a);
    a.ctx.tools.restrict({ deny: ["write"] });
    const b = f.agents.get(await spawn(a)); assert.ok(b);
    const ceiling = readDelegationCeiling(b.session); assert.ok(ceiling);
    assert.equal(ceiling.role, null); assert.equal(ceiling.level, null);
    assert.equal(ceiling.creatorId, a.id); assert.equal(ceiling.rootId, root.id);
    assert.equal(ceiling.profileId, saved.id); assert.equal(ceiling.maxDepth, explicitDepth ? 2 : null);
    assert.equal(ceiling.allow?.includes("write"), false);
    release(); await b.whenIdle(); await a.whenIdle(); await root.whenIdle();
    await f.disposeAgent(root); await f.ctx.sessionPersistence.flush();
    if (explicitDepth) {
      const current = await deployment.readGlobal();
      await deployment.saveGlobal({ expectedRevision: current.revision, edits: [{ op: "set", path: ["subagents", "maxDepth"], value: 4 }] }, () => {});
    }
    await profiles.save({ id: saved.id, expectedRevision: saved.revision, content: JSON.stringify({ version: 1, id: saved.id, settings: { defaultActive: false } }) });
    const other = await profiles.save({ id: "native-current-root", expectedRevision: null, content: JSON.stringify({ version: 1, id: "native-current-root", settings: { defaultActive: true } }) });
    await profiles.select({ id: other.id, expectedRevision: other.revision, expectedSelectionRevision: selected.selectionRevision });
    reopened = await f.agents.resume({ resumeSessionId: root.id, agentOptions: { ...root.options },
      setup: async (ctx, agent) => { await f.ctx.agentPresets.mount(ctx, agent.session.header.agentPreset); } });
    assert.equal(f.ctx.dsmmNativeAdmission.assert(reopened.agent).profile?.id, other.id);
    assert.equal(f.ctx.dsmmNativeAdmission.assert(reopened.agent).settings.subagents.maxDepth, explicitDepth ? 4 : undefined);
    coldId = b.id;
    const coldStarted = new Promise<void>(resolve => { enteredCold = resolve; });
    held = new Promise<void>(resolve => { releaseCold = resolve; });
    assert.equal((await invoke(reopened.agent, "send_message", { agent: b.id, message: "Resume original native identity" })).isError, false);
    const resumed = f.agents.get(b.id); assert.ok(resumed);
    assert.equal(resumed.id, b.id); assert.equal(resumed.session.header.parentSession, a.id);
    assert.equal(f.agents.get(a.id), undefined); assert.equal(delegationDepthOf(resumed), 2);
    await coldStarted;
    const admission = await f.ctx.dsmmNativeAdmission.ensure(resumed);
    assert.equal(admission.profile?.id, saved.id); assert.equal(admission.settings.defaultActive, false);
    assert.equal(f.ctx.dsmmNativeAdmission.policy.identity(resumed).role, undefined);
    assert.equal(f.ctx.dsmmNativeAdmission.invocation(resumed), undefined);
    assert.deepEqual(readDelegationCeiling(resumed.session), ceiling);
    assert.equal(f.adapter.calls.filter(call => call.sessionId === resumed.id).at(-1)?.model, "native-default");
    const probe = join(f.profileDir, "native-resumed-read.txt"), denied = join(f.profileDir, "native-denied-write.txt");
    writeFileSync(probe, "native resumed work", { flag: "wx" });
    assert.equal((await invoke(resumed, "read", { file_path: probe })).isError, false);
    assert.equal((await invoke(resumed, "write", { file_path: denied, content: "must not write" })).isError, true);
    assert.equal(existsSync(denied), false);
    assert.ok(resumed.ctx.tools.get("subagent", resumed));
    assert.equal(f.ctx.dsmmNativeAdmission.policy.maximumDepth(resumed), explicitDepth ? 2 : undefined);
    if (explicitDepth) {
      const overDepthId = await spawn(resumed);
      const overDepth = f.agents.get(overDepthId);
      if (overDepth !== undefined) await overDepth.whenIdle();
      assert.equal(f.adapter.calls.some(call => call.sessionId === overDepthId), false);
    } else {
      const overDepth = await invoke(resumed, "subagent", { description: "Native tool depth exhausted", prompt: "Must remain under the native tool cap" });
      assert.ok(overDepth.isError, JSON.stringify(overDepth));
    }
    assert.equal(f.agents.get(a.id), undefined);
  } finally { release(); releaseCold(); await reopened?.dispose(); await f.dispose(); }
});
