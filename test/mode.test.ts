import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import type { Agent, ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId, ToolCallId } from "@deepseek-ai/dsh-llm";
import { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { DsmmProfileRuntime } from "../lib/profile-runtime.js";
import type { DshAgent } from "../lib/dsh-types.js";
import { sessionEvents } from "../lib/session-scope.js";
import { isDeepworkActive } from "../lib/state.js";
import { DSMM_ROLES } from "../lib/roles.js";
import { headerRoutes, nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

const adapterAgent = (agent: Agent): Omit<DshAgent, "ctx"> => agent;
const guidanceCount = (prompt: string) => prompt.split("<avoid-ai-slop-guidance>").length - 1;

for (const section of [undefined, "Custom common workflow {{literal}}"] as const) test(`avoid-ai-slop brief follows native Agent mode for ordinary, role and category prompts (${section === undefined ? "default" : "override"})`, async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, ...(section === undefined ? {} : { section }) }, { nativePresets: true });
  try {
    const runtime = f.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    const render = (scope?: object) => f.ctx.systemPrompt.assemble({ scope }).then(renderPrompt);
    assert.equal(guidanceCount(await render()), 0);
    assert.equal(guidanceCount(await render({})), 0);
    for (const preset of ["standard", "dsmm-orchestrator"]) {
      const agent = await f.create({ agentPreset: preset });
      const persona = DSMM_ROLES.find(role => role.id === preset)?.persona;
      const mode = async (active: boolean) => {
        const before = await runtime.getSession(adapterAgent(agent));
        await runtime.selectMode({ sessionId: agent.id, active, expectedModeRevision: before.deepwork!.revision, expectedAdmissionEpoch: before.admissionEpoch }, adapterAgent(agent));
      };
      for (const active of [true, false, true, false]) {
        await mode(active);
        const prompt = await render(agent);
        assert.equal(guidanceCount(prompt), active ? 1 : 0, preset);
        if (persona !== undefined) {
          assert.ok(prompt.includes(persona), "off retains permanent role/category persona");
          assert.equal(guidanceCount(persona), 0);
        }
        if (active && section !== undefined) assert.ok(prompt.includes(section));
        assert.equal((await agent.ctx.get("skills")!.list({ scope: agent })).some(skill => skill.name === "avoid-ai-slop"), active);
      }
    }
    const parent = await f.create({ agentPreset: "dsmm-orchestrator" });
    const child = await f.createAuxiliary("dsmm-coding", undefined, "continuable", parent);
    const persona = DSMM_ROLES.find(role => role.id === "dsmm-coding")!.persona;
    const childPrompt = await render(child);
    assert.equal(guidanceCount(childPrompt), 1);
    assert.ok(childPrompt.includes(persona));
    assert.equal(guidanceCount(persona), 0);
    if (section !== undefined) assert.ok(childPrompt.includes(section));
    const before = await runtime.getSession(adapterAgent(parent));
    await runtime.selectMode({ sessionId: parent.id, active: false, expectedModeRevision: before.deepwork!.revision, expectedAdmissionEpoch: before.admissionEpoch }, adapterAgent(parent));
    assert.equal(guidanceCount(await render(parent)), 0);
    assert.equal(guidanceCount(await render(child)), 1, "parent off cannot rewrite a child's captured mode");
  } finally { await f.dispose(); }
});

test("disabled skill cannot inject the avoid-ai-slop brief or load its bundled skill", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, skills: { "avoid-ai-slop": false } }, { nativePresets: true, spawn: false, managedRuntime: true });
  try {
    const agent = await f.create({ agentPreset: "standard" });
    const prompt = renderPrompt(await f.ctx.systemPrompt.assemble({ scope: agent }));
    assert.equal(guidanceCount(prompt), 0);
    assert.equal(prompt.includes("avoid-ai-slop"), false, "disabled guidance must not demand an unavailable skill");
    const skills = agent.ctx.get("skills")!;
    assert.equal((await skills.list({ scope: agent })).some(skill => skill.name === "avoid-ai-slop"), false);
    assert.equal(await skills.get("avoid-ai-slop", { scope: agent }), undefined);
  } finally { await f.dispose(); }
});

test("native mode changes affect only the exact Agent common section and lazy skills, never its role composition", async () => {
  const section = "Configured common workflow";
  const f = await nativeRoutingFixture({ section }, { nativePresets: true, nativeFs: true });
  try {
    const ordinary = await f.create(), dispatcher = await f.create({ agentPreset: "dsmm-orchestrator" });
    const runtime = f.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    const render = (agent?: Agent) => f.ctx.systemPrompt.assemble({ scope: agent }).then(renderPrompt);
    const mode = async (agent: Agent, active: boolean) => {
      const before = await runtime.getSession(adapterAgent(agent));
      return runtime.selectMode({ sessionId: agent.id, active, expectedModeRevision: before.deepwork!.revision, expectedAdmissionEpoch: before.admissionEpoch }, adapterAgent(agent));
    };
    assert.equal((await render()).includes(section), false);
    assert.equal((await render(ordinary)).includes(section), false);
    assert.equal((await render(dispatcher)).includes(section), true);
    const initial = runtime.admission(adapterAgent(ordinary));
    await mode(ordinary, true);
    assert.equal((await render(ordinary)).split(section).length, 2);
    assert.ok((await ordinary.ctx.get("skills")!.list({ scope: ordinary })).length > 0);
    await mode(dispatcher, false);
    assert.equal((await render(dispatcher)).includes(section), false);
    assert.equal(await dispatcher.ctx.get("skills")!.get("brainstorming", { scope: dispatcher }), undefined);
    const writePath = join(f.profileDir, "mode-off-write-proof.txt");
    const written = await dispatcher.ctx.tools.execute({ agent: dispatcher, name: "write", arguments: { file_path: writePath, content: "kept\n" }, callId: ToolCallId("off-write"), signal: new AbortController().signal });
    assert.equal(written.isError, false, JSON.stringify(written));
    assert.equal((await render(ordinary)).includes(section), true);
    await mode(ordinary, false);
    assert.equal((await render(ordinary)).includes(section), false);
    assert.equal(runtime.admission(adapterAgent(ordinary)), initial);
    assert.equal(isDeepworkActive(sessionEvents(ordinary.session), true), false);
    await mode(ordinary, true);
    await f.dsmmFiber.dispose();
    assert.deepEqual(await ordinary.ctx.get("skills")!.list({ scope: ordinary }), []);
    assert.equal((await render(ordinary)).includes(section), false);
  } finally { await f.dispose(); }
});

test("active ordinary and dispatcher roots retain native model and observed effort ownership", async () => {
  const configured = { provider: "fixture", model: "configured-role-model", reasoningEffort: "max" };
  const route = { provider: "deepseek-official", model: "deepseek-v4-pro" };
  const f = await nativeRoutingFixture({ defaultActive: true, roleRouting: {
    "dsmm-orchestrator": { primary: configured }, "dsmm-builder": { primary: configured }
  } });
  try {
    const runtime = f.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    for (const preset of ["standard", "dsmm-orchestrator"]) {
      const selection: ModelSelectionRef = { current: { ...route, reasoningEffort: ReasoningEffortId("low") }, assembled: undefined };
      const agent = await f.create({ agentPreset: preset }, selection);
      const admission = runtime.admission(adapterAgent(agent)), before = f.adapter.calls.length;
      await runFixtureTurn(agent);
      for (const effort of ["max", undefined]) {
        const selected = await agent.ctx.llm.resolveCallConfig({ ...route, ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }) });
        selection.current = { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) };
        agent.session.append("model/selection", selection.current);
        await runFixtureTurn(agent);
        assert.deepEqual(selection.assembled, selection.current);
      }
      const expected = ["low", "max", "high"].map(reasoningEffort => ({ ...route, reasoningEffort }));
      assert.deepEqual(headerRoutes(agent), expected);
      assert.deepEqual(f.adapter.calls.slice(before).map(({ provider, model, reasoningEffort }) => ({ provider, model, reasoningEffort })), expected);
      assert.equal(runtime.admission(adapterAgent(agent)), admission);
      assert.deepEqual(admission.settings.roleRouting["dsmm-orchestrator"]?.primary, configured);
    }
  } finally { await f.dispose(); }
});
