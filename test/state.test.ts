import assert from "node:assert/strict";
import { test } from "node:test";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import type { DshAgent, DshContext } from "../lib/dsh-types.js";
import { DEEPWORK_MODE_EVENT, DeepworkModeController, hasOpenTurn, isDeepworkActive } from "../lib/state.js";
import { bindRoleInvocation, capturedRoleInvocation } from "../lib/role-invocation.js";
import type { DsmmProfileRuntime } from "../lib/profile-runtime.js";
import { nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";
import { appendModeRecord } from "../lib/session-metadata.js";

test("activation folds last valid intent, role default on, minimal default off", () => {
  assert.equal(isDeepworkActive([], false), false); assert.equal(isDeepworkActive([], true), true);
  assert.equal(isDeepworkActive([], true, "minimal"), false); assert.equal(isDeepworkActive([], true, "custom-minimal"), true);
  assert.equal(isDeepworkActive([], false, "dsmm-reviewer"), true);
  assert.equal(isDeepworkActive([{ type: DEEPWORK_MODE_EVENT, data: { active: false } }], true, "dsmm-reviewer"), false);
  assert.equal(isDeepworkActive([{ type: DEEPWORK_MODE_EVENT, data: { active: true } }, { type: "other/event", data: { active: false } }, { type: DEEPWORK_MODE_EVENT, data: { active: false } }], true), false);
});

let fixtureSequence = 0;
function fixture(preset = "minimal") {
  const initial = Session.create(SessionId(`dsmm-state-${++fixtureSequence}`));
  const session = Session.create(initial.id, [], { ...initial.header, agentPreset: preset });
  const agent: DshAgent & { session: Session } = {
    session,
    async runMaintenance(task) { return task(new AbortController().signal); }
  };
  return { agent, controller: new DeepworkModeController({}) };
}

test("same-default explicit choices persist across preset/profile changes and reopen", async () => {
  const { agent, controller } = fixture();
  assert.equal(controller.active(agent, true), false);
  assert.equal(await controller.select(agent, false, true), "committed");
  agent.session.append("agent-preset/selected", { agentPreset: "dsmm-reviewer" });
  assert.equal(controller.active(agent, true), false); assert.equal(controller.describe(agent, true).locked, false);
  await controller.select(agent, true, false);
  agent.session.append("agent-preset/selected", { agentPreset: "minimal" });
  assert.equal(new DeepworkModeController({}).active(agent, false), true);
  assert.equal(await controller.select(agent, true), "unchanged");
  const disabled = new DeepworkModeController({}, () => false);
  const beforeOff = disabled.describe(agent, false);
  assert.equal(beforeOff.active, false);
  await assert.rejects(disabled.select(agent, true), /not admitted/u);
  assert.equal(await disabled.select(agent, false), "committed", "off must replace persisted on intent even when effective activity is already off");
  assert.notEqual(disabled.describe(agent, false).revision, beforeOff.revision);
  assert.equal(new DeepworkModeController({}).active(agent, true), false, "independent available controller observes saved off intent");
  assert.equal(await disabled.select(agent, false), "unchanged");
});

test("busy mode requests are rejected, not staged into current prompt or future pre-step", async () => {
  const { agent, controller } = fixture("standard");
  agent.session.append("turn/start", { turn: 1 });
  const before = controller.describe(agent, false);
  await assert.rejects(controller.select(agent, true), /idle/);
  await assert.rejects(controller.selectIdle(agent, true, false), /idle/);
  assert.deepEqual(controller.describe(agent, false), before);
  agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  assert.equal(controller.active(agent, false), false);
  await controller.select(agent, true); assert.equal(controller.active(agent, false), true);
});

test("failed record commits change neither intent nor revision and do not notify providers", async () => {
  const { agent, controller } = fixture(); let changes = 0;
  controller.watch(() => { changes++; });
  Object.defineProperty(agent.session, "publicationEntry", { value() { throw new Error("record commit failed"); } });
  const before = controller.describe(agent, false);
  const outcomes = await Promise.allSettled([controller.select(agent, true), controller.select(agent, false)]);
  assert.deepEqual(outcomes.map((value) => value.status), ["rejected", "rejected"]);
  await assert.rejects(controller.selectIdle(agent, true, false));
  assert.deepEqual(controller.describe(agent, false), before); assert.equal(changes, 0);
});

test("revision fences preset ABA but ignores unrelated events; native maintenance is mandatory", async () => {
  const { agent, controller } = fixture("standard");
  const before = controller.describe(agent, false).revision;
  agent.session.append("turn/start", { turn: 1 });
  agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  assert.equal(controller.describe(agent, false).revision, before);
  agent.session.append("agent-preset/selected", { agentPreset: "minimal" });
  agent.session.append("agent-preset/selected", { agentPreset: "standard" });
  assert.notEqual(controller.describe(agent, false).revision, before);
  agent.runMaintenance = undefined;
  await assert.rejects(controller.select(agent, true), /maintenance/);
  let reserved = 0;
  agent.runMaintenance = async (task) => { reserved++; return task(new AbortController().signal); };
  await controller.select(agent, true); assert.equal(reserved, 1);
});

test("turn fold handles successive turns and missing history", () => {
  assert.equal(hasOpenTurn(), false); assert.equal(hasOpenTurn([{ type: "turn/start" }]), true);
  assert.equal(hasOpenTurn([{ type: "turn/start" }, { type: "turn/end" }]), false);
  assert.equal(hasOpenTurn([{ type: "turn/start" }, { type: "turn/end" }, { type: "turn/start" }]), true);
});

test("live admitted child defaults on without inherited mode events; explicit off, module admission and exact residency still govern", async () => {
  const f = await nativeRoutingFixture({ defaultActive: false }, { headless: true });
  try {
    const context = f.ctx as unknown as DshContext;
    const controller = new DeepworkModeController(context);
    const parent = await f.create({ agentPreset: "standard" });
    const parentScope = parent as unknown as DshAgent;
    assert.equal(controller.active(parentScope, false), false);
    const runtime = f.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    const session = await runtime.getSession(parentScope);
    await runtime.selectMode({ sessionId: parent.id, active: true, expectedModeRevision: session.deepwork!.revision, expectedAdmissionEpoch: session.admissionEpoch }, parentScope);
    const child = await f.createAuxiliary("dsmm-coding", undefined, "one-shot", parent);
    const childScope = child as unknown as DshAgent;
    assert.equal(child.session.inheritedEventCount, 0);
    const enabled = controller.describe(childScope, false);
    assert.equal(enabled.active, true);
    assert.equal(enabled.explicit, false);
    assert.equal(controller.active(childScope, false), enabled.active);
    assert.equal(new DeepworkModeController(context, () => false).active(childScope, false), false);

    const unadmitted: DshAgent = { session: child.session, id: child.id, ctx: child.ctx as unknown as DshContext };
    bindRoleInvocation(unadmitted, capturedRoleInvocation(childScope)!);
    assert.equal(controller.active(unadmitted, false), false, "the same history, descriptor and invocation capture without exact native admission cannot grant mode");

    await runFixtureTurn(child);
    assert.match(JSON.stringify(f.adapter.calls.at(-1)!.messages.filter(message => message.role === "system")), /<dsmm-deepwork-mode>/);
    await f.releaseAuxiliary(child);
    assert.equal(f.agents.get(child.id) === undefined, true);
    const afterRelease = controller.describe(childScope, false);
    assert.equal(afterRelease.active, false, "captured invocation is not a live admission after native release");
    assert.notEqual(afterRelease.revision, enabled.revision);

    const removeOff = f.ctx.on("agent/created", ({ agent }) => {
      if (!f.agents.isOwnedBy(agent.id, parent)) return;
      const scope = agent as unknown as DshAgent;
      const beforeOff = controller.describe(scope, false);
      assert.equal(beforeOff.active, true);
      appendModeRecord(agent.session, true);
      appendModeRecord(agent.session, false);
      const disabled = controller.describe(scope, false);
      assert.equal(controller.active(scope, false), false);
      assert.equal(disabled.active, false);
      assert.equal(disabled.explicit, true);
      assert.notEqual(disabled.revision, beforeOff.revision);
    }, { global: true });
    try {
      const disabledChild = await f.createAuxiliary("dsmm-coding", undefined, "one-shot", parent);
      await runFixtureTurn(disabledChild);
      assert.doesNotMatch(JSON.stringify(f.adapter.calls.at(-1)!.messages.filter(message => message.role === "system")), /<dsmm-deepwork-mode>/);
    } finally { removeOff(); }
  } finally { await f.dispose(); }
});
