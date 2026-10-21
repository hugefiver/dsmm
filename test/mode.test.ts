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
import { headerRoutes, nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

const adapterAgent = (agent: Agent): Omit<DshAgent, "ctx"> => agent;

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
