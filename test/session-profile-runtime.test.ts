import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { symbols } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import { ReasoningEffortId, ToolCallId } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import type { SubagentActivation, SubagentProvider } from "@deepseek-ai/dsh-subagent";
import type { ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import type { DshAgent, DshContext } from "../src/dsh-types.js";
import { createProfileRuntime, DsmmProfileRuntime } from "../src/profile-runtime.js";
import { ProfileStore } from "../src/profile-store.js";
import type { SessionProfileSelectRequest } from "../src/profile-types.js";
import { resolveConfig } from "../src/settings.js";
import { DsmmProfileError } from "../src/profiles.js";
import { DsmmDeploymentConfig } from "../src/deployment-config.js";
import { headerRoutes, nativeRoutingFixture as nativeHostFixture, runFixtureTurn } from "./native-routing-fixture.ts";

function nativeRoutingFixture(...[config, options]: Parameters<typeof nativeHostFixture>) {
  return nativeHostFixture(config, { nativePermissionSettings: true, ...options });
}

const route = (model: string) => ({ provider: "fixture", model, reasoningEffort: "high" });
const profile = (id: string, model: string) => JSON.stringify({ version: 1, id, settings: { defaultActive: true,
  roleRouting: { "dsmm-orchestrator": { primary: route(model) }, "dsmm-reviewer": { primary: route(`${model}-review`) } } } });
const structural = (agent: Agent) => agent as unknown as DshAgent;
const identity = (value: object): object => Reflect.get(value, symbols.original) ?? value;
function runtimeOf(f: Awaited<ReturnType<typeof nativeRoutingFixture>>) { return f.ctx.get("dsmmProfileRuntime") as unknown as DsmmProfileRuntime; }
function centralStore(f: Awaited<ReturnType<typeof nativeRoutingFixture>>) {
  return ProfileStore.fromCentral(f.home, f.profileDir, runtimeOf(f).admission().deployment!.entryId);
}
async function request(runtime: DsmmProfileRuntime, agent: Agent, id: string | null, revision?: string): Promise<SessionProfileSelectRequest> {
  const state = await runtime.getSession(structural(agent));
  return { sessionId: agent.id, id, ...(revision === undefined ? {} : { expectedRevision: revision }), expectedSelectionRevision: state.selection.selectionRevision, expectedAdmissionEpoch: state.admissionEpoch };
}
function gate() { let release!: () => void; const promise = new Promise<void>((done) => { release = done; }); return { promise, release }; }
async function residentChild(f: Awaited<ReturnType<typeof nativeRoutingFixture>>, parent: Agent) {
  const completed = gate();
  const remove = f.ctx.on("tools/result", exec => { if (exec.agent === parent && exec.name === "dsmm_reviewer") completed.release(); }, { global: true });
  try {
    const child = await f.createAuxiliary("dsmm-reviewer", undefined, "continuable", parent);
    await runFixtureTurn(child); await completed.promise;
    const resumed = await f.resumeAuxiliary(child);
    await runFixtureTurn(resumed);
    assert.ok(f.agents.get(resumed.id) === resumed); assert.equal(resumed.status, "idle");
    return resumed;
  } finally { remove(); }
}

test("started idle root switches A to B and baseline for actual requests and new delegated routes", async () => {
  const f = await nativeRoutingFixture();
  try {
    const runtime = runtimeOf(f);
    const a = await runtime.save({ id: "idle-a", content: profile("idle-a", "a-model"), expectedRevision: null });
    const document = JSON.parse(profile("idle-b", "b-model"));
    document.settings.locale = "ja"; document.settings.workflow = { policy: "legacy", reviewCap: 2 };
    const b = await runtime.save({ id: "idle-b", content: JSON.stringify(document), expectedRevision: null });
    await runtime.select({ id: a.id, expectedRevision: a.revision, expectedSelectionRevision: (await runtime.describe()).selectionRevision });
    const agent = await f.create({ agentPreset: "standard" });
    const session = agent.session, options = structuredClone(agent.options);
    await runFixtureTurn(agent);
    assert.equal(agent.status, "idle");
    const history = agent.session.snapshotEvents();
    const before = await runtime.getSession(structural(agent));
    assert.equal(before.canApplyOverlay, true);
    const switched = await runtime.selectSession(await request(runtime, agent, b.id, b.revision), structural(agent));
    assert.notEqual(switched.admissionEpoch, before.admissionEpoch);
    assert.equal(agent.session, session); assert.deepEqual(agent.session.snapshotEvents(), history);
    assert.deepEqual(agent.options, options);
    assert.equal((await runtime.describe()).selectedId, a.id);
    await runFixtureTurn(agent);
    assert.match(JSON.stringify(f.adapter.calls.at(-1)?.messages), /reviewCap: 2/u);
    assert.match(JSON.stringify(f.adapter.calls.at(-1)?.messages), /capturedLocale\\":\\"ja/u);
    assert.equal(headerRoutes(agent).at(-1)?.model, "native-default");
    const child = await f.createAuxiliary("dsmm-reviewer", undefined, "continuable", agent);
    await runFixtureTurn(child);
    assert.equal(headerRoutes(child).at(-1)?.model, "b-model-review");
    await f.releaseAuxiliary(child);
    await runtime.selectSession(await request(runtime, agent, null), structural(agent));
    await runFixtureTurn(agent);
    assert.doesNotMatch(JSON.stringify(f.adapter.calls.at(-1)?.messages), /DEEPWORK MODE ENABLED!/u);
    assert.equal(headerRoutes(agent).at(-1)?.model, "native-default");
  } finally { await f.dispose(); }
});

test("persisted root with a fresh activation epoch switches against its observed disk revision", async () => {
  const f = await nativeRoutingFixture();
  try {
    const runtime = runtimeOf(f), original = await f.create({ agentPreset: "standard" });
    const a = await runtime.save({ id: "restore-a", content: profile("restore-a", "a-model"), expectedRevision: null });
    const document = JSON.parse(profile("restore-b", "b-model")); document.settings.locale = "ja";
    const b = await runtime.save({ id: "restore-b", content: JSON.stringify(document), expectedRevision: null });
    const chosen = await runtime.selectSession(await request(runtime, original, a.id, a.revision), structural(original));
    await runFixtureTurn(original); await f.ctx.sessionPersistence.flush();
    const history = original.session.snapshotEvents(), options = structuredClone(original.options);
    await f.disposeAgent(original);
    const restored = await f.agents.resume({ resumeSessionId: original.id, agentOptions: options,
      async setup(scope) { await f.ctx.agentPresets.mount(scope, "standard"); } });
    try {
      const agent = restored.agent, before = await runtime.getSession(structural(agent));
      assert.equal(agent.id, original.id); assert.notEqual(before.admissionEpoch, chosen.admissionEpoch);
      assert.equal(before.selection.selectionRevision, chosen.selection.selectionRevision);
      assert.equal(before.canApplyOverlay, true);
      await assert.rejects(runtime.selectSession({ ...await request(runtime, agent, b.id, b.revision), expectedAdmissionEpoch: chosen.admissionEpoch }, structural(agent)), { code: "conflict" });
      const selected = await runtime.selectSession(await request(runtime, agent, b.id, b.revision), structural(agent));
      assert.notEqual(selected.admissionEpoch, before.admissionEpoch);
      assert.deepEqual(agent.session.snapshotEvents().slice(0, history.length), history);
      await runFixtureTurn(agent);
      assert.match(JSON.stringify(f.adapter.calls.at(-1)!.messages.filter(message => message.role === "system")), /capturedLocale\\":\\"ja/u);
      assert.equal(headerRoutes(agent).at(-1)?.model, "native-default");
      const child = await f.createAuxiliary("dsmm-reviewer", undefined, "continuable", agent);
      await runFixtureTurn(child); assert.equal(headerRoutes(child).at(-1)?.model, "b-model-review");
      await f.releaseAuxiliary(child);
    } finally { await restored.dispose(); }
  } finally { await f.dispose(); }
});

test("successful idle publication clears command memory only for its exact subtree while failed selection retains it", async () => {
  let bodies = 0, asks = 0;
  const f = await nativeRoutingFixture({ defaultActive: true }, { nativePermissionSettings: true, fixtureTools: [{
    name: "pwsh", description: "Counter only, never runs a process", parameters: { command: { type: "string", required: true }, description: { type: "string", required: true } },
    output: { schema: { type: "string" }, render: () => [] }, async execute() { bodies++; return "counted"; },
  }] });
  try {
    await f.ctx.plugin(ApprovalService, { policy: "ask" }).await();
    f.ctx.on("approval/request", async () => { asks++; return "allowed-once"; }, { global: true });
    const runtime = runtimeOf(f), root = await f.create({ agentPreset: "standard" }), other = await f.create({ agentPreset: "standard" });
    const probe = async (agent: Agent) => {
      const results: boolean[] = [];
      const remove = f.ctx.on("agent/pre-step", async (frame, next) => {
        if (frame.agent === agent) {
          remove();
          for (let index = 0; index < 2; index++) results.push((await agent.ctx.tools.execute({ agent, name: "pwsh", callId: ToolCallId(`memory-${bodies}-${index}`), signal: frame.signal,
            arguments: { command: "git commit -m counted-not-executed", description: "Counter-only approval" } })).isError === true);
        }
        return next();
      }, { global: true });
      try { await runFixtureTurn(agent); assert.deepEqual(results, [false, false]); }
      finally { remove(); }
    };
    await probe(root); await probe(other); assert.equal(asks, 2);
    const invalid = await runtime.save({ id: "memory-invalid", content: profile("memory-invalid", "unavailable"), expectedRevision: null });
    f.adapter.unavailableModels.add("unavailable-review");
    await assert.rejects(runtime.selectSession(await request(runtime, root, invalid.id, invalid.revision), structural(root)), { code: "activation" });
    await probe(root); assert.equal(asks, 2, "failed selection must retain valid memory");
    const saved = await runtime.save({ id: "memory-b", content: profile("memory-b", "memory-b"), expectedRevision: null });
    await runtime.selectSession(await request(runtime, root, saved.id, saved.revision), structural(root));
    await probe(root); assert.equal(asks, 3);
    await probe(other); assert.equal(asks, 3); assert.equal(bodies, 10);
  } finally { await f.dispose(); }
});

test("native approval wait and its open turn prevent switching until the actual tool result and driver idle", async () => {
  const entered = gate(), blocked = gate();
  let bodies = 0;
  const f = await nativeRoutingFixture({ defaultActive: true }, { nativePermissionSettings: true, fixtureTools: [{
    name: "pwsh", description: "Approval counter, no process", parameters: { command: { type: "string", required: true }, description: { type: "string", required: true } },
    output: { schema: { type: "string" }, render: () => [] }, async execute() { bodies++; return "counted"; },
  }] });
  try {
    await f.ctx.plugin(ApprovalService, { policy: "ask" }).await();
    f.ctx.on("approval/request", async () => { entered.release(); await blocked.promise; return "allowed-once"; }, { global: true });
    const runtime = runtimeOf(f), agent = await f.create({ agentPreset: "standard" }), choice = await request(runtime, agent, null);
    let result: boolean | undefined;
    const remove = f.ctx.on("agent/pre-step", async (frame, next) => {
      if (frame.agent === agent) {
        remove();
        result = (await agent.ctx.tools.execute({ agent, name: "pwsh", callId: ToolCallId("profile-approval-pending"), signal: frame.signal,
          arguments: { command: "git commit -m counted-not-executed", description: "Counter-only approval" } })).isError === true;
      }
      return next();
    }, { global: true });
    const turn = runFixtureTurn(agent); await entered.promise;
    assert.equal(bodies, 0);
    assert.equal((await runtime.getSession(structural(agent))).applyOverlayUnavailableReason, "busy");
    await assert.rejects(runtime.selectSession(choice, structural(agent)), { code: "busy" });
    blocked.release(); await turn;
    assert.equal(result, false); assert.equal(bodies, 1);
    assert.equal((await runtime.selectSession(choice, structural(agent))).scope, "deployment-baseline");
  } finally { blocked.release(); await f.dispose(); }
});

test("native cold resume and agents.resume persistence windows admit after commit or refuse before publication", async t => {
  for (const entrance of ["cold-resume", "agents-resume"] as const) for (const completion of ["during", "after"] as const) await t.test(`${entrance}-${completion}`, async () => {
    const f = await nativeRoutingFixture({ defaultActive: true, locale: "en" });
    const loading = gate(), allowLoad = gate(), selectingEntered = gate(), allowSelect = gate();
    let load: ReturnType<typeof mock.method> | undefined, store: ReturnType<typeof mock.method> | undefined;
    let resumedHandle: Awaited<ReturnType<typeof f.agents.resume>> | undefined;
    try {
      const runtime = runtimeOf(f), parent = await f.create({ agentPreset: "standard" });
      const child = await f.createAuxiliary("dsmm-reviewer", undefined, "continuable", parent);
      await runFixtureTurn(child); await f.releaseAuxiliary(child); await f.ctx.sessionPersistence.flush();
      assert.equal(f.agents.get(child.id), undefined);
      const saved = await runtime.save({ id: "resume-b", expectedRevision: null, content: JSON.stringify({ version: 1, id: "resume-b", settings: {
        defaultActive: true, locale: "ja", roleRouting: { "dsmm-reviewer": { primary: route("resume-b-review") } },
      } }) });
      const choice = await request(runtime, parent, saved.id, saved.revision);
      const persistence = f.ctx.sessionPersistence, open = persistence.open.bind(persistence);
      load = mock.method(persistence, "open", async (...args: Parameters<typeof persistence.open>) => {
        if (args[0] === child.id) { loading.release(); await allowLoad.promise; }
        return open(...args);
      });
      const continuation = entrance === "cold-resume"
        ? f.subagents.sendMessage(parent, child.id, [{ type: "text", text: "Cold continuation" }], { signal: new AbortController().signal })
        : f.agents.resume({ resumeSessionId: child.id, parentAgent: parent, agentOptions: child.options,
          async setup(scope, agent) {
            await f.ctx.agentPresets.mount(scope, "standard");
            assert.equal((await scope.tools.execute({ agent, name: "read", arguments: {}, callId: ToolCallId("before-child-admission"), signal: new AbortController().signal })).isError, true,
              "an unpublished native Agent cannot execute before final admission");
          } }).then(handle => { resumedHandle = handle; return handle; });
      const observed = continuation.then(value => ({ value }), error => ({ error }));
      await loading.promise;
      assert.equal(f.agents.get(child.id), undefined, "the public persistence await precedes registry and admission");
      const selectSession = ProfileStore.prototype.selectSession;
      store = mock.method(ProfileStore.prototype, "selectSession", function (this: ProfileStore, ...[request, epoch, validate, commit]: Parameters<ProfileStore["selectSession"]>) {
        return selectSession.call(this, request, epoch, async document => { selectingEntered.release(); await allowSelect.promise; return validate(document); }, commit);
      });
      const selecting = runtime.selectSession(choice, structural(parent));
      await selectingEntered.promise;
      if (completion === "during") {
        allowLoad.release();
        assert.ok("error" in await observed, "creation under the selecting parent must fail closed");
        assert.equal(f.agents.get(child.id), undefined);
        allowSelect.release(); await selecting;
      } else {
        allowSelect.release(); const selected = await selecting;
        allowLoad.release();
        const result = await observed;
        assert.ok(!("error" in result), "pre-admission startup may finish only through the current parent binding");
        const resumed = f.agents.get(child.id)!; assert.ok(resumed);
        assert.equal(runtime.admission(structural(resumed)).settings.locale, "ja");
        assert.equal(f.ctx.dsmmNativeAdmission.get(parent)?.epoch, selected.admissionEpoch);
        if (entrance === "agents-resume") await runFixtureTurn(resumed); else await resumed.whenIdle();
        assert.equal(f.adapter.calls.filter(call => call.sessionId === child.id).at(-1)?.model, "resume-b-review");
        assert.equal((await resumed.ctx.tools.execute({ agent: resumed, name: "write", arguments: {}, callId: ToolCallId("cold-readonly"), signal: new AbortController().signal })).isError, true);
      }
    } finally {
      allowLoad.release(); allowSelect.release(); load?.mock.restore(); store?.mock.restore();
      await resumedHandle?.dispose(); await f.dispose();
    }
  });
});

test("ordinary native mode writes survive future-default changes and reopen without model selection", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true });
  try {
    const runtime = runtimeOf(f);
    const ordinary = await f.create({ agentPreset: "standard" });
    const before = await runtime.getSession(structural(ordinary));
    assert.equal(before.deepwork!.active, true); assert.equal(before.deepwork!.explicit, false);
    const toggle = (state: Awaited<ReturnType<DsmmProfileRuntime["getSession"]>>, active: boolean) => ({ sessionId: state.sessionId, active, expectedModeRevision: state.deepwork!.revision, expectedAdmissionEpoch: state.admissionEpoch });
    const nativeChoice = structuredClone(ordinary.options);
    const disabled = await runtime.selectMode(toggle(before, false), structural(ordinary));
    assert.equal(disabled.deepwork!.active, false); assert.equal(disabled.deepwork!.explicit, true); assert.deepEqual(ordinary.options, nativeChoice);
    await runFixtureTurn(ordinary);
    assert.doesNotMatch(JSON.stringify(f.adapter.calls.at(-1)?.messages), /DEEPWORK MODE ENABLED!/u);
    const saved = await runtime.save({ id: "mode-off-default", content: '{"version":1,"id":"mode-off-default","settings":{"defaultActive":false}}', expectedRevision: null });
    await runtime.select({ id: saved.id, expectedRevision: saved.revision, expectedSelectionRevision: (await runtime.describe()).selectionRevision });
    const future = await f.create({ agentPreset: "standard" });
    const futureState = await runtime.getSession(structural(future));
    assert.equal(futureState.deepwork!.active, false); assert.equal(futureState.deepwork!.explicit, false);
    assert.equal(futureState.canApplyOverlay, true); assert.equal(futureState.applyOverlayUnavailableReason, undefined);
    assert.equal((await runtime.getSession(structural(ordinary))).deepwork!.active, false, "existing admission remains immutable");
    const enabled = await runtime.selectMode(toggle(disabled, true), structural(ordinary));
    assert.equal(enabled.deepwork!.active, true); assert.equal(enabled.deepwork!.explicit, true);
    await runFixtureTurn(ordinary); assert.match(JSON.stringify(f.adapter.calls.at(-1)?.messages), /DEEPWORK MODE ENABLED!/u);
    const seed = ordinary.session.snapshotEvents();
    const resumed = await f.create({ agentPreset: "standard" }, undefined, { seed });
    assert.equal((await runtime.getSession(structural(resumed))).deepwork!.active, true);
    assert.equal((await runtime.getSession(structural(resumed))).deepwork!.explicit, true);
    assert.equal(ordinary.session.snapshotEvents().filter((event) => event.type === "model/selection").length, 0);
    const dw = await f.create({ agentPreset: "dsmm-orchestrator" });
    const managed = await runtime.getSession(structural(dw));
    assert.equal(managed.deepwork!.active, true); assert.equal(managed.deepwork!.locked, false);
    const dwOff = await runtime.selectMode(toggle(managed, false), structural(dw));
    assert.equal(dwOff.deepwork!.active, false); assert.equal(dwOff.deepwork!.explicit, true);
    await runFixtureTurn(dw);
    assert.doesNotMatch(JSON.stringify(f.adapter.calls.at(-1)?.messages), /DEEPWORK MODE ENABLED!/u);
  } finally { await f.dispose(); }
});

test("native maintenance race leaves the accepted mode and model unchanged", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true });
  try {
    const runtime = runtimeOf(f), agent = await f.create({ agentPreset: "standard" });
    const structuralAgent = structural(agent), before = await runtime.getSession(structuralAgent);
    const input = { sessionId: before.sessionId, active: false, expectedModeRevision: before.deepwork!.revision, expectedAdmissionEpoch: before.admissionEpoch };
    const barrier = gate(); const maintenance = agent.runMaintenance(() => barrier.promise);
    try { await assert.rejects(runtime.selectMode(input, structuralAgent), { code: "maintenance" }); }
    finally { barrier.release(); await maintenance; }
    assert.deepEqual((await runtime.getSession(structuralAgent)).deepwork, before.deepwork);
    assert.equal(agent.session.snapshotEvents().filter((event) => event.type === "deepwork/mode").length, 0);
  } finally { await f.dispose(); }
});

test("an unscoped root displays its exact captured global profile after the future-root default changes", async () => {
  const f = await nativeRoutingFixture();
  try {
    const runtime = runtimeOf(f);
    await f.create();
    const a = await runtime.save({ id: "a", content: profile("a", "captured-a"), expectedRevision: null });
    const b = await runtime.save({ id: "b", content: profile("b", "future-b"), expectedRevision: null });
    await runtime.select({ id: "a", expectedRevision: a.revision, expectedSelectionRevision: "absent" });
    const captured = await f.create({ agentPreset: "dsmm-orchestrator" });
    const admission = runtime.admission(structural(captured));
    await runtime.select({ id: "b", expectedRevision: b.revision, expectedSelectionRevision: (await runtime.describe()).selectionRevision });
    const snapshot = await runtime.getSession(structural(captured));
    assert.equal(snapshot.scope, "global-default");
    assert.equal(snapshot.selection.selectionRevision, "absent", "display identity cannot overwrite the actual sidecar CAS state");
    assert.equal(snapshot.admittedSelection?.selectedId, "a");
    assert.equal(snapshot.admittedSelection?.sourceRevision, a.revision);
    assert.equal(snapshot.globalDefault.selectedId, "b");
    assert.deepEqual(snapshot.profileModel, route("captured-a"), "explicit model action metadata comes from the captured admission, not future global B");
    assert.equal(snapshot.admissionEpoch, admission.epoch);
    await runFixtureTurn(captured);
    assert.equal(headerRoutes(captured).at(-1)?.model, "native-default", "profile metadata never implicitly applies a main model");
  } finally { await f.dispose(); }
});

test("profile model metadata follows the admitted ordinary root role without changing native selection or locks", async () => {
  const f = await nativeRoutingFixture();
  try {
    const runtime = runtimeOf(f);
    const nativeSelection: ModelSelectionRef = { current: { provider: "fixture", model: "native-tab", reasoningEffort: ReasoningEffortId("low") }, assembled: undefined };
    const draft = await runtime.save({ id: "metadata", expectedRevision: null, content: JSON.stringify({ version: 1, id: "metadata", settings: {
      defaultActive: false, roleRouting: {
        "dsmm-orchestrator": { primary: { provider: "fixture", model: "declared-main", reasoningEffort: "max" }, fallbackRoutes: [route("not-the-primary")] },
      },
    } }) });
    await runtime.select({ id: draft.id, expectedRevision: draft.revision, expectedSelectionRevision: (await runtime.describe()).selectionRevision });
    const root = await f.create({ agentPreset: "dsmm-orchestrator" }, nativeSelection);
    const selected = await runtime.getSession(structural(root));
    assert.deepEqual(selected.profileModel, { provider: "fixture", model: "declared-main", reasoningEffort: "max" });
    assert.deepEqual(nativeSelection.current, { provider: "fixture", model: "native-tab", reasoningEffort: "low" });
    await runFixtureTurn(root);
    assert.deepEqual(headerRoutes(root).at(-1), { provider: "fixture", model: "native-tab", reasoningEffort: "low" });
    let resolutions = 0;
    const resolve = f.adapter.resolveModel.bind(f.adapter);
    f.adapter.resolveModel = async (provider, model) => { resolutions++; return resolve(provider, model); };
    const events = JSON.stringify(root.session.snapshotEvents());
    const first = await runtime.getSession(structural(root));
    const next = await runtime.getSession(structural(root));
    assert.deepEqual(first.rolePolicy, next.rolePolicy, "read-only metadata does not reset any route/counter lock");
    assert.deepEqual(first.rolePolicy?.route, { provider: "fixture", model: "native-tab", reasoningEffort: "low" });
    assert.equal(JSON.stringify(root.session.snapshotEvents()), events);
    assert.equal(resolutions, 0, "describe does no LLM preflight or catalog work");
    first.profileModel!.model = "caller-edited-copy";
    assert.equal((await runtime.getSession(structural(root))).profileModel?.model, "declared-main");
    root.session.append("agent-preset/selected", { agentPreset: "dsmm-planner" });
    assert.deepEqual((await runtime.getSession(structural(root))).profileModel, { provider: "fixture", model: "declared-main", reasoningEffort: "max" }, "history labels do not replace the current native role");
    const ordinary = await f.create({ agentPreset: "standard" });
    assert.equal((await runtime.getSession(structural(ordinary))).profileModel, undefined, "inactive non-DW roots do not infer an orchestrator model");
    ordinary.session.append("agent-preset/selected", { agentPreset: "dsmm-planner" });
    const ordinarySnapshot = await runtime.getSession(structural(ordinary));
    assert.equal(ordinarySnapshot.profileModel, undefined, "history labels cannot activate a role on an ordinary native root");
    assert.equal(ordinarySnapshot.deepwork!.active, false);
    ordinary.session.append("deepwork/mode", { active: true });
    assert.equal((await runtime.getSession(structural(ordinary))).profileModel?.model, "declared-main");
    const noPrimary = await runtime.save({ id: "no-primary", expectedRevision: null, content: JSON.stringify({ version: 1, id: "no-primary", settings: { roleRouting: { "dsmm-orchestrator": { fallbackRoutes: [route("fallback-only")] } } } }) });
    await runtime.select({ id: noPrimary.id, expectedRevision: noPrimary.revision, expectedSelectionRevision: (await runtime.describe()).selectionRevision });
    assert.equal((await runtime.getSession(structural(root))).profileModel?.model, "declared-main", "future defaults cannot replace an immutable admission");
    const future = await f.create({ agentPreset: "dsmm-orchestrator" });
    assert.equal((await runtime.getSession(structural(future))).profileModel, undefined, "fallbacks and actual native routes never become a declared profile primary");
    const noEffort = await runtime.save({ id: "no-effort", expectedRevision: null, content: JSON.stringify({ version: 1, id: "no-effort", settings: { roleRouting: { "dsmm-orchestrator": { primary: { provider: "fixture", model: "declared-main" } } } } }) });
    await runtime.select({ id: noEffort.id, expectedRevision: noEffort.revision, expectedSelectionRevision: (await runtime.describe()).selectionRevision });
    const omittedEffort = await f.create({ agentPreset: "dsmm-orchestrator" });
    assert.deepEqual((await runtime.getSession(structural(omittedEffort))).profileModel, { provider: "fixture", model: "declared-main" }, "omitted effort is not replaced by an adapter default");
    assert.deepEqual(nativeSelection.current, { provider: "fixture", model: "native-tab", reasoningEffort: "low" });
  } finally { await f.dispose(); }
});

test("blank A/B/default choices drive the first native prompt and delegated route without changing future defaults or native model intent", async () => {
  const f = await nativeRoutingFixture();
  try {
    const runtime = runtimeOf(f), agent = await f.create({ agentPreset: "standard" });
    const nativeChoice = structuredClone(agent.options), global = await runtime.describe();
    const a = await runtime.save({ id: "a", content: profile("a", "a-model"), expectedRevision: null });
    const document = JSON.parse(profile("b", "b-model"));
    document.settings.locale = "zh-Hans"; document.settings.subagents = { toolTopology: "parameterized" };
    document.settings.workflow = { policy: "legacy", reviewCap: 2 };
    const b = await runtime.save({ id: "b", content: JSON.stringify(document), expectedRevision: null });
    const choose = async (id: string | null, revision?: string) => runtime.selectSession(await request(runtime, agent, id, revision), structural(agent));
    assert.equal((await runtime.getSession(structural(agent))).canApplyOverlay, true);
    assert.equal((await choose(a.id, a.revision)).admittedSelection?.selectedId, "a");
    const selected = await choose(b.id, b.revision);
    assert.equal(selected.admittedSelection?.selectedId, "b");
    assert.equal(selected.admittedSelection?.refreshRequired, undefined);
    assert.equal(selected.deepwork?.active, true);
    await assert.rejects(runtime.selectSession({ ...await request(runtime, agent, b.id, b.revision), expectedSelectionRevision: "absent" }, structural(agent)), { code: "conflict" });
    assert.equal(agent.ctx.tools.get("dsmm_role", agent)?.name, "dsmm_role");
    assert.equal(agent.ctx.tools.get("dsmm_reviewer", agent), undefined);
    const baseline = await choose(null);
    assert.equal(baseline.scope, "deployment-baseline"); assert.equal(baseline.deepwork?.active, false);
    assert.equal((await choose(b.id, b.revision)).admittedSelection?.selectedId, "b");
    const admitted = runtime.admission(structural(agent));
    assert.equal(f.ctx.get("dsmmNativeAdmission")!.get(agent), admitted);
    assert.equal((await runtime.describe()).selectionRevision, global.selectionRevision);
    assert.deepEqual(agent.options, nativeChoice);
    const skillRegistry = agent.ctx.get("agentPresets")!.serviceFor(agent, "skills") ?? agent.ctx.get("skills")!;
    const skills = await skillRegistry.list({ scope: agent });
    assert.ok(skills.some(skill => skill.name === "brainstorming"));
    await f.ctx.get("agentPresets")!.select(agent, "dsmm-orchestrator");
    await f.ctx.get("dsmmNativeAdmission")!.ensure(agent);
    assert.equal(runtime.admission(structural(agent)), admitted, "blank preset recomposition keeps the accepted current configuration");
    await runFixtureTurn(agent);
    assert.equal(headerRoutes(agent)[0]?.model, "native-default");
    assert.match(JSON.stringify(f.adapter.calls[0]?.messages), /reviewCap: 2/u);
    assert.match(JSON.stringify(f.adapter.calls[0]?.messages), /zh-Hans/u);
    const child = await f.createAuxiliary("dsmm-reviewer", undefined, "continuable", agent);
    await runFixtureTurn(child);
    assert.equal(headerRoutes(child)[0]?.model, "b-model-review");
    assert.equal(runtime.admission(structural(child)).epoch, admitted.epoch);
    assert.equal(runtime.admission(structural(child)).settings.locale, "zh-Hans");
    await f.releaseAuxiliary(child);
    assert.equal((await runtime.getSession(structural(agent))).canApplyOverlay, true);
    await choose(a.id, a.revision);
    assert.notEqual(runtime.admission(structural(agent)), admitted);
  } finally { await f.dispose(); }
});

test("blank selection cannot cross a native preset reservation, cancelled request or disposed exact owner", async t => {
  for (const race of ["preset", "cancelled", "disposed"] as const) await t.test(race, async () => {
    const f = await nativeRoutingFixture(), entered = gate(), blocked = gate();
    const original = ProfileStore.prototype.selectSession;
    let interception: ReturnType<typeof mock.method> | undefined;
    try {
      const runtime = runtimeOf(f), agent = await f.create({ agentPreset: "standard" });
      const saved = await runtime.save({ id: "race", content: profile("race", "race-model"), expectedRevision: null });
      const before = runtime.admission(structural(agent)), choice = await request(runtime, agent, saved.id, saved.revision);
      interception = mock.method(ProfileStore.prototype, "selectSession", function (this: ProfileStore, ...[request, epoch, validate, commit]: Parameters<ProfileStore["selectSession"]>) {
        return original.call(this, request, epoch, async document => { entered.release(); await blocked.promise; return validate(document); }, commit);
      });
      const cancellation = new AbortController();
      const selecting = runtime.selectSession(choice, structural(agent), cancellation.signal);
      await entered.promise;
      if (race === "preset") {
        const refused = assert.rejects(selecting, error => error instanceof DsmmProfileError && ["cancelled", "conflict"].includes(error.code));
        await f.ctx.get("agentPresets")!.select(agent, "dsmm-orchestrator");
        blocked.release();
        await refused;
        await f.ctx.get("dsmmNativeAdmission")!.ensure(agent);
        assert.equal(runtime.admission(structural(agent)), before);
        assert.equal((await centralStore(f).loadSessionSelection(agent.id)).admissionEpoch, null);
        assert.equal(f.ctx.get("agentPresets")!.composedPreset(agent.ctx), "dsmm-orchestrator");
        assert.equal((await runtime.getSession(structural(agent))).canApplyOverlay, true);
      } else {
        const refused = assert.rejects(selecting, error => error instanceof DsmmProfileError);
        const disposal = race === "disposed" ? f.disposeAgent(agent) : undefined;
        if (race === "cancelled") cancellation.abort();
        blocked.release(); await refused; await disposal;
        assert.equal((await centralStore(f).loadSessionSelection(agent.id)).admissionEpoch, null);
        if (race !== "disposed") assert.equal(runtime.admission(structural(agent)), before);
      }
    } finally { blocked.release(); interception?.mock.restore(); await f.dispose(); }
  });
});

test("a tool executing outside a turn still occupies the blank capability until its real result", async () => {
  const entered = gate(), blocked = gate();
  const f = await nativeRoutingFixture({}, { fixtureTools: [{ name: "blank_busy_tool", description: "Isolated pending execution", parameters: {},
    output: { schema: { type: "string" }, render: () => [{ type: "text", text: "done" }] },
    async execute() { entered.release(); await blocked.promise; return "done"; },
  }] });
  try {
    const runtime = runtimeOf(f), agent = await f.create({ agentPreset: "standard" }), choice = await request(runtime, agent, null);
    const execution = agent.ctx.tools.execute({ agent, name: "blank_busy_tool", arguments: {}, callId: ToolCallId("blank-busy-tool"), signal: new AbortController().signal });
    await entered.promise;
    assert.equal(agent.status, "idle");
    await assert.rejects(runtime.selectSession(choice, structural(agent)), { code: "busy" });
    blocked.release(); assert.equal((await execution).isError, false);
    assert.equal((await runtime.selectSession(choice, structural(agent))).scope, "deployment-baseline");
  } finally { blocked.release(); await f.dispose(); }
});

test("native pre-execute occupancy begins before the admission await and survives downstream failure until result", async () => {
  const blocked = gate();
  const f = await nativeRoutingFixture();
  try {
    const runtime = runtimeOf(f), agent = await f.create({ agentPreset: "standard" });
    await runFixtureTurn(agent);
    const choice = await request(runtime, agent, null);
    const remove = f.ctx.on("tools/pre-execute", async (exec, next) => {
      if (exec.agent === agent && exec.name === "read") { await blocked.promise; throw new Error("Native pre-execute failure"); }
      return next();
    }, { global: true });
    try {
      const execution = agent.ctx.tools.execute({ agent, name: "read", arguments: {}, callId: ToolCallId("admission-await"), signal: new AbortController().signal });
      await assert.rejects(runtime.selectSession(choice, structural(agent)), error => error instanceof DsmmProfileError && ["busy", "conflict"].includes(error.code));
      blocked.release(); assert.equal((await execution).isError, true);
      assert.equal((await runtime.selectSession(choice, structural(agent))).scope, "deployment-baseline");
    } finally { remove(); }
  } finally { blocked.release(); await f.dispose(); }
});

test("tool occupancy covers the awaited admission guard and native pre-execute before a real result", async () => {
  const f = await nativeRoutingFixture();
  const entered = gate(), blocked = gate();
  let guard: ReturnType<typeof mock.method> | undefined;
  try {
    const runtime = runtimeOf(f), agent = await f.create({ agentPreset: "standard" }), choice = await request(runtime, agent, null);
    const owner = f.ctx.dsmmNativeAdmission, ensure = owner.ensure.bind(owner);
    guard = mock.method(owner, "ensure", async (actor: Agent) => { if (actor === agent) { entered.release(); await blocked.promise; } return ensure(actor); });
    const execution = agent.ctx.tools.execute({ agent, name: "read", arguments: {}, callId: ToolCallId("pending-native-admission"), signal: new AbortController().signal });
    await entered.promise;
    assert.equal(owner.blankReason(agent), "busy");
    await assert.rejects(runtime.selectSession(choice, structural(agent)), { code: "busy" });
    blocked.release(); assert.equal((await execution).isError, false);
    guard.mock.restore(); guard = undefined;
    assert.equal((await runtime.selectSession(choice, structural(agent))).scope, "deployment-baseline");
  } finally { blocked.release(); guard?.mock.restore(); await f.dispose(); }
});

test("resident child maintenance preserves captured admission and ceilings and releases queued input after publication or rollback", async t => {
  for (const failure of [false, true]) await t.test(failure ? "rollback" : "publication", async () => {
    const f = await nativeRoutingFixture({ defaultActive: true, locale: "en" });
    const entered = gate(), blocked = gate();
    let interception: ReturnType<typeof mock.method> | undefined;
    try {
      const runtime = runtimeOf(f), parent = await f.create({ agentPreset: "standard" });
      await runFixtureTurn(parent);
      const child = await residentChild(f, parent), captured = runtime.admission(structural(child));
      const before = runtime.admission(structural(parent)), events = child.session.snapshotEvents();
      const saved = await runtime.save({ id: "resident-b", expectedRevision: null, content: JSON.stringify({ version: 1, id: "resident-b", settings: {
        defaultActive: true, locale: "ja", roleRouting: { "dsmm-reviewer": { primary: route("resident-b-review") } },
      } }) });
      const choice = await request(runtime, parent, saved.id, saved.revision);
      assert.equal((await runtime.getSession(structural(parent))).canApplyOverlay, true);
      const original = ProfileStore.prototype.selectSession;
      interception = mock.method(ProfileStore.prototype, "selectSession", function (this: ProfileStore, ...[request, epoch, validate, commit]: Parameters<ProfileStore["selectSession"]>) {
        return original.call(this, request, epoch, async document => { entered.release(); await blocked.promise; return validate(document); }, commit);
      });
      let authorized = true;
      const selecting = runtime.selectSession(choice, structural(parent), undefined, () => { if (!authorized) throw new DsmmProfileError("not-owned", "Operator retired"); });
      const failed = failure ? assert.rejects(selecting, { code: "not-owned" }) : undefined;
      await entered.promise;
      const requestsBefore = f.adapter.calls.length;
      parent.followup(createUserMessage({ content: [{ type: "text", text: "Queued parent" }], source: { kind: "user" } }));
      child.steer(createUserMessage({ content: [{ type: "text", text: "Queued child" }], source: { kind: "user" } }));
      assert.equal(parent.status, "idle"); assert.equal(child.status, "idle");
      assert.equal(f.adapter.calls.length, requestsBefore);
      const direct = await child.ctx.tools.execute({ agent: child, name: "read", arguments: {}, callId: ToolCallId("resident-direct-maintenance"), signal: new AbortController().signal });
      assert.equal(direct.isError, true);
      if (failure) authorized = false;
      blocked.release();
      if (failed) await failed; else await selecting;
      await Promise.all([parent.whenIdle(), child.whenIdle()]);
      assert.equal(runtime.admission(structural(child)), captured);
      assert.deepEqual(child.session.snapshotEvents().slice(0, events.length), events);
      assert.equal(runtime.admission(structural(parent)) === before, failure);
      const parentCall = f.adapter.calls.filter(call => call.sessionId === parent.id).at(-1)!;
      const childCall = f.adapter.calls.filter(call => call.sessionId === child.id).at(-1)!;
      assert.match(JSON.stringify(parentCall.messages.filter(message => message.role === "system")), failure ? /capturedLocale\\":\\"en/u : /capturedLocale\\":\\"ja/u);
      assert.match(JSON.stringify(childCall.messages.filter(message => message.role === "system")), /capturedLocale\\":\\"en/u);
      assert.equal(f.adapter.calls.length, requestsBefore + 2, "queued child must execute, not fail against its parent's selection gate");
      assert.equal((await child.ctx.tools.execute({ agent: child, name: "write", arguments: {}, callId: ToolCallId("resident-readonly"), signal: new AbortController().signal })).isError, true);
      await f.releaseAuxiliary(child);
    } finally { blocked.release(); interception?.mock.restore(); await f.dispose(); }
  });
});

test("running, queued, open-turn and separately reserved resident descendants refuse a root switch", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true });
  const entered = gate(), blocked = gate();
  try {
    const runtime = runtimeOf(f), parent = await f.create({ agentPreset: "standard" });
    const child = await residentChild(f, parent), choice = await request(runtime, parent, null);
    const maintenance = child.runMaintenance(() => blocked.promise);
    await assert.rejects(runtime.selectSession(choice, structural(parent)), { code: "maintenance" });
    blocked.release(); await maintenance;
    child.inject(createUserMessage({ content: [{ type: "text", text: "Queued before selection" }], source: { kind: "user" } }));
    await assert.rejects(runtime.selectSession(choice, structural(parent)), { code: "busy" });
    f.adapter.beforeStream = async options => { if (options.sessionId === child.id) { entered.release(); await blockedRunning.promise; } };
    const blockedRunning = gate();
    try {
      const turn = runFixtureTurn(child); await entered.promise;
      await assert.rejects(runtime.selectSession(choice, structural(parent)), { code: "busy" });
      blockedRunning.release(); await turn;
    } finally { blockedRunning.release(); f.adapter.beforeStream = undefined; }
    child.session.append("turn/start", { turn: 100 });
    await assert.rejects(runtime.selectSession(choice, structural(parent)), { code: "busy" });
    child.session.append("turn/end", { turn: 100, reason: { kind: "completed" } });
    assert.equal((await runtime.selectSession(choice, structural(parent))).scope, "deployment-baseline");
    await f.releaseAuxiliary(child);
  } finally { blocked.release(); await f.dispose(); }
});

test("a running grandchild blocks the root while completed resident descendants keep their own captures", async () => {
  const f = await nativeRoutingFixture({}, { nativePermissionSettings: true });
  const entered = gate(), blocked = gate();
  try {
    const runtime = runtimeOf(f), root = await f.create({ agentPreset: "standard" });
    const child = await f.create({ agentPreset: "standard", origin: "subagent", parentSession: root.id }, undefined, { parentAgent: root });
    const grandchild = await f.create({ agentPreset: "standard", origin: "subagent", parentSession: child.id }, undefined, { parentAgent: child });
    const childCapture = runtime.admission(structural(child)), grandchildCapture = runtime.admission(structural(grandchild));
    const choice = await request(runtime, root, null);
    f.adapter.beforeStream = async options => { if (options.sessionId === grandchild.id) { entered.release(); await blocked.promise; } };
    const running = runFixtureTurn(grandchild); await entered.promise;
    await assert.rejects(runtime.selectSession(choice, structural(root)), { code: "busy" });
    blocked.release(); await running; f.adapter.beforeStream = undefined;
    await runtime.selectSession(choice, structural(root));
    assert.equal(runtime.admission(structural(child)), childCapture);
    assert.equal(runtime.admission(structural(grandchild)), grandchildCapture);
  } finally { blocked.release(); await f.dispose(); }
});

test("opaque foreign startup stays unavailable after provider removal and cannot cross an idle profile transaction", async t => {
  for (const service of ["resolved", "isolated"] as const) for (const timing of ["before", "during"] as const) await t.test(`${service}-${timing}`, async () => {
    const f = await nativeRoutingFixture({ defaultActive: true, locale: "en" });
    let isolated: ReturnType<typeof f.ctx.plugin> | undefined;
    let native = f.subagents;
    const entered = gate(), allowStart = gate(), finishRun = gate(), selectingEntered = gate(), allowSelection = gate();
    let removeProvider: (() => void | Promise<void>) | undefined;
    let starting: Promise<SubagentActivation> | undefined, transaction: Promise<unknown> | undefined;
    let interception: ReturnType<typeof mock.method> | undefined;
    let disposed = 0, startSignal: AbortSignal | undefined;
    try {
      const runtime = runtimeOf(f), root = await f.create({ agentPreset: "standard" });
      assert.ok(identity(root.ctx.get("subagents")!) === identity(f.subagents));
      await runFixtureTurn(root);
      const before = runtime.admission(structural(root)), history = root.session.snapshotEvents(), options = structuredClone(root.options);
      const saved = await runtime.save({ id: "opaque-b", content: profile("opaque-b", "opaque-b"), expectedRevision: null });
      const choice = await request(runtime, root, saved.id, saved.revision);
      assert.equal((await runtime.getSession(structural(root))).canApplyOverlay, true);
      if (timing === "during") {
        const original = ProfileStore.prototype.selectSession;
        interception = mock.method(ProfileStore.prototype, "selectSession", function (this: ProfileStore, ...[request, epoch, validate, commit]: Parameters<ProfileStore["selectSession"]>) {
          return original.call(this, request, epoch, async document => { selectingEntered.release(); await allowSelection.promise; return validate(document); }, commit);
        });
        transaction = assert.rejects(runtime.selectSession(choice, structural(root)), { code: "conflict" });
        await selectingEntered.promise;
      }
      if (service === "isolated") {
        isolated = f.ctx.isolate("subagents").plugin(SubagentRuntime, {}); await isolated.await();
        native = isolated.ctx.get("subagents")!;
        assert.ok(identity(native) !== identity(root.ctx.get("subagents")!));
      }
      const provider: SubagentProvider = {
        name: "foreign-deferred", capabilities: {}, inheritsParentContext: false,
        async start(request) {
          startSignal = request.signal; entered.release(); await allowStart.promise;
          return { id: SessionId(`foreign-deferred-${root.id}`), result: finishRun.promise.then(() => ({ output: [], stopReason: "completed" as const })),
            async dispose() { disposed++; } };
        },
      };
      removeProvider = native.registerProvider(provider);
      const exposed = await f.create({ agentPreset: "standard" });
      starting = native.startActivation({ provider: provider.name, label: "Opaque local fixture", delivery: "caller", signal: new AbortController().signal,
        request: { parent: root, prompt: [] } });
      await entered.promise;
      await removeProvider(); removeProvider = undefined;
      assert.equal(native.getProvider(provider.name), undefined);
      assert.equal((await runtime.getSession(structural(exposed))).applyOverlayUnavailableReason, "runtime-unavailable");
      assert.equal(root.status, "idle");
      assert.equal(f.agents.list().some(agent => f.agents.isOwnedBy(agent.id, root)), false);
      if (transaction) { allowSelection.release(); await transaction; }
      else {
        assert.equal((await runtime.getSession(structural(root))).applyOverlayUnavailableReason, "runtime-unavailable");
        await assert.rejects(runtime.selectSession(choice, structural(root)), { code: "unavailable" });
      }
      assert.equal(runtime.admission(structural(root)), before);
      assert.equal((await centralStore(f).loadSessionSelection(root.id)).admissionEpoch, null);
      assert.deepEqual(root.session.snapshotEvents(), history); assert.deepEqual(root.options, options);
      assert.equal(startSignal?.aborted, false); assert.equal(disposed, 0, "configuration maintenance must not cancel opaque work");
      interception?.mock.restore(); interception = undefined;
      const fresh = await f.create({ agentPreset: "standard" });
      const child = await residentChild(f, fresh), childCapture = runtime.admission(structural(child));
      assert.equal((await runtime.getSession(structural(fresh))).canApplyOverlay, true, "a new exact Agent after removal was never exposed to that provider");
      await runtime.selectSession(await request(runtime, fresh, saved.id, saved.revision), structural(fresh));
      assert.equal(runtime.admission(structural(child)), childCapture);
      await f.releaseAuxiliary(child);
      allowStart.release(); const activation = await starting;
      assert.equal((await runtime.getSession(structural(root))).applyOverlayUnavailableReason, "runtime-unavailable");
      finishRun.release(); await activation.result;
      assert.equal(startSignal?.aborted, false);
      assert.equal((await runtime.getSession(structural(root))).applyOverlayUnavailableReason, "runtime-unavailable", "late start/end cannot prove absence of earlier unpublished starts");
      await runFixtureTurn(root);
      assert.equal(runtime.admission(structural(root)), before);
    } finally {
      allowSelection.release(); allowStart.release(); finishRun.release();
      await transaction; await starting?.then(activation => activation.result); await removeProvider?.();
      interception?.mock.restore(); await isolated?.dispose(); await f.dispose();
    }
  });
});

test("a foreign local preparation reaches current native admission after maintenance without a provider-name whitelist", async () => {
  const f = await nativeRoutingFixture();
  const entered = gate(), blocked = gate();
  let starting: Promise<SubagentActivation> | undefined, removeProvider: (() => void | Promise<void>) | undefined;
  try {
    const runtime = runtimeOf(f), root = await f.create({ agentPreset: "standard" });
    const provider: SubagentProvider = { name: "foreign-deferred", capabilities: {}, inheritsParentContext: false,
      async prepareContinuable() { entered.release(); await blocked.promise; return {}; } };
    removeProvider = f.subagents.registerProvider(provider);
    starting = f.subagents.startActivation({ provider: provider.name, label: "Local native lifecycle", delivery: "caller", signal: new AbortController().signal,
      request: { parent: root, prompt: [{ type: "text", text: "Complete the local fixture" }] } });
    await entered.promise;
    assert.equal((await runtime.getSession(structural(root))).canApplyOverlay, true);
    const saved = await runtime.save({ id: "local-b", expectedRevision: null, content: JSON.stringify({ version: 1, id: "local-b", settings: { locale: "ja" } }) });
    const selected = await runtime.selectSession(await request(runtime, root, saved.id, saved.revision), structural(root));
    const observed: Array<{ epoch: string; locale: string | undefined }> = [];
    const removeRequest = f.ctx.on("agent/request", async (frame, next) => {
      if (f.agents.isOwnedBy(frame.agent.id, root)) {
        const admission = f.ctx.dsmmNativeAdmission.assert(frame.agent);
        observed.push({ epoch: admission.epoch, locale: admission.settings.locale });
      }
      return next();
    }, { global: true });
    try {
      blocked.release(); const activation = await starting; await activation.result;
      assert.deepEqual(observed, [{ epoch: selected.admissionEpoch, locale: "ja" }]);
      assert.equal(f.adapter.calls.filter(call => call.sessionId === activation.childId).at(-1)?.model, "native-default");
      assert.equal((await runtime.getSession(structural(root))).canApplyOverlay, true);
    } finally { removeRequest(); }
  } finally { blocked.release(); await starting?.then(activation => activation.result); await removeProvider?.(); await f.dispose(); }
});

test("opaque providers on an independent Agent registry do not restrict an admitted root", async () => {
  const f = await nativeRoutingFixture();
  const scope = f.ctx.isolate("agents").isolate("subagents"), registry = scope.plugin(AgentRegistry);
  await registry.await();
  const service = scope.plugin(SubagentRuntime, {}); await service.await();
  let removeProvider: (() => void | Promise<void>) | undefined, starts = 0;
  try {
    const runtime = runtimeOf(f), root = await f.create({ agentPreset: "standard" }), native = service.ctx.get("subagents")!;
    assert.ok(identity(service.ctx.get("agents")!) !== identity(f.agents));
    removeProvider = native.registerProvider({ name: "foreign-independent", capabilities: {}, inheritsParentContext: false,
      async start() { starts++; throw new Error("An unrelated parent must not reach the provider"); } });
    await assert.rejects(native.startActivation({ provider: "foreign-independent", label: "Independent registry", delivery: "caller", signal: new AbortController().signal,
      request: { parent: root, prompt: [] } }), { code: "UNAUTHORIZED" });
    assert.equal(starts, 0);
    assert.equal((await runtime.getSession(structural(root))).canApplyOverlay, true);
    await runtime.selectSession(await request(runtime, root, null), structural(root));
    await removeProvider(); removeProvider = undefined;
    assert.equal((await runtime.getSession(structural(root))).canApplyOverlay, true);
    await runFixtureTurn(root); assert.equal(f.adapter.calls.at(-1)?.model, "native-default");
  } finally { await removeProvider?.(); await service.dispose(); await registry.dispose(); await f.dispose(); }
});

test("a pre-existing isolated native service is covered before a new Agent's admission", async () => {
  let removeProvider: (() => void | Promise<void>) | undefined;
  const f = await nativeRoutingFixture({}, { async beforeDsmm(ctx) {
    const service = ctx.isolate("subagents").plugin(SubagentRuntime, {}); await service.await();
    removeProvider = service.ctx.get("subagents")!.registerProvider({ name: "foreign-existing", capabilities: {}, inheritsParentContext: false,
      async start() { throw new Error("This fixture only probes registry exposure"); } });
  } });
  try {
    const runtime = runtimeOf(f), root = await f.create({ agentPreset: "standard" });
    const choice = await request(runtime, root, null);
    assert.equal((await runtime.getSession(structural(root))).applyOverlayUnavailableReason, "runtime-unavailable");
    await removeProvider?.(); removeProvider = undefined;
    await assert.rejects(runtime.selectSession(choice, structural(root)), { code: "unavailable" });
    const fresh = await f.create({ agentPreset: "standard" });
    assert.equal((await runtime.getSession(structural(fresh))).canApplyOverlay, true);
    await runtime.selectSession(await request(runtime, fresh, null), structural(fresh));
  } finally { await removeProvider?.(); await f.dispose(); }
});

test("blank choices read current deployment values but cannot mount runtime or permission capabilities above startup", async () => {
  const f = await nativeRoutingFixture({}, { async beforeDsmm(ctx) {
    const deployment = new DsmmDeploymentConfig(ctx as DshContext, {});
    await deployment.store.save(JSON.stringify({ modules: { deepwork: { enabled: false } }, permissionControl: { enabled: false } }), (await deployment.readGlobal()).revision, () => {});
  } });
  try {
    const runtime = runtimeOf(f), agent = await f.create({ agentPreset: "standard" });
    const deployment = f.ctx.get("dsmmDeploymentConfig")!;
    await deployment.store.save(JSON.stringify({ defaultActive: true, locale: "ja", modules: { deepwork: { enabled: true } }, permissionControl: { enabled: true }, subagents: { allowRouteOverride: true } }), (await deployment.readGlobal()).revision, () => {});
    const selected = await runtime.selectSession(await request(runtime, agent, null), structural(agent));
    const admission = runtime.admission(structural(agent));
    assert.equal(admission.settings.locale, "ja");
    assert.equal(admission.settings.modules.deepwork.enabled, false);
    assert.equal(admission.settings.permissionControl.enabled, false);
    assert.equal(admission.settings.subagents.allowRouteOverride, false);
    assert.equal(selected.deepwork?.active, false);
    assert.ok(selected.configuration?.restartRequired.includes("modules.deepwork.enabled"));
    assert.ok(selected.configuration?.restartRequired.includes("permissionControl.enabled"));
    await runFixtureTurn(agent);
    assert.doesNotMatch(JSON.stringify(f.adapter.calls[0]?.messages), /DEEPWORK MODE ENABLED!/u);
    assert.equal(headerRoutes(agent)[0]?.model, "native-default");
  } finally { await f.dispose(); }
});

test("blank route preflight refuses unavailable delegated models without changing admission or consuming the first prompt", async () => {
  const f = await nativeRoutingFixture();
  try {
    const runtime = runtimeOf(f), agent = await f.create({ agentPreset: "standard" }), before = runtime.admission(structural(agent));
    const saved = await runtime.save({ id: "missing-route", content: profile("missing-route", "missing-model"), expectedRevision: null });
    f.adapter.unavailableModels.add("missing-model-review");
    await assert.rejects(runtime.selectSession(await request(runtime, agent, saved.id, saved.revision), structural(agent)), { code: "activation" });
    assert.equal(runtime.admission(structural(agent)), before);
    assert.equal((await centralStore(f).loadSessionSelection(agent.id)).admissionEpoch, null);
    assert.equal(f.adapter.calls.length, 0);
    await runFixtureTurn(agent);
    assert.doesNotMatch(JSON.stringify(f.adapter.calls[0]?.messages), /DEEPWORK MODE ENABLED!/u);
  } finally { await f.dispose(); }
});

test("blank maintenance orders a queued first prompt after the committed choice and rejects competing/stale choices", async () => {
  const f = await nativeRoutingFixture();
  const original = ProfileStore.prototype.selectSession;
  let interception: ReturnType<typeof mock.method> | undefined;
  const entered = gate(), blocked = gate();
  try {
    const runtime = runtimeOf(f), agent = await f.create({ agentPreset: "standard" });
    const saved = await runtime.save({ id: "queued", content: profile("queued", "queued-model"), expectedRevision: null });
    const choice = await request(runtime, agent, saved.id, saved.revision);
    interception = mock.method(ProfileStore.prototype, "selectSession", function (this: ProfileStore, ...[request, epoch, validate, commit]: Parameters<ProfileStore["selectSession"]>) {
      return original.call(this, request, epoch, async document => { entered.release(); await blocked.promise; return validate(document); }, commit);
    });
    const selecting = runtime.selectSession(choice, structural(agent));
    await entered.promise;
    const firstTurn = runFixtureTurn(agent);
    assert.equal(agent.status, "idle"); assert.equal(f.adapter.calls.length, 0);
    await assert.rejects(runtime.selectSession(choice, structural(agent)), { code: "maintenance" });
    blocked.release();
    const selected = await selecting;
    await firstTurn;
    assert.equal(selected.admittedSelection?.selectedId, saved.id);
    assert.match(JSON.stringify(f.adapter.calls[0]?.messages), /DEEPWORK MODE ENABLED!/u);
    assert.equal(headerRoutes(agent)[0]?.model, "native-default");
    await assert.rejects(runtime.selectSession(choice, structural(agent)), { code: "conflict" });
    assert.equal((await centralStore(f).loadSessionSelection(agent.id)).admissionEpoch, selected.admissionEpoch);
  } finally { blocked.release(); interception?.mock.restore(); await f.dispose(); }
});

test("selection refuses preexisting input and running children but accepts seeded idle history", async () => {
  const f = await nativeRoutingFixture();
  try {
    const runtime = runtimeOf(f), queued = await f.create({ agentPreset: "standard" });
    const choice = await request(runtime, queued, null);
    queued.inject(createUserMessage({ content: [{ type: "text", text: "Already submitted" }], source: { kind: "user" } }));
    assert.equal((await runtime.getSession(structural(queued))).applyOverlayUnavailableReason, "busy");
    await assert.rejects(runtime.selectSession(choice, structural(queued)), { code: "busy" });
    const source = await f.create({ agentPreset: "standard" });
    await runFixtureTurn(source);
    const seed = source.session.snapshotEvents();
    const seeded = await f.create({ agentPreset: "standard", isSeeded: true }, undefined, { seed, inheritedEventCount: SessionLogOffset(seed.length) });
    assert.equal(seeded.session.header.isSeeded, true);
    assert.equal((await runtime.getSession(structural(seeded))).canApplyOverlay, true);
    assert.equal((await runtime.selectSession(await request(runtime, seeded, null), structural(seeded))).scope, "deployment-baseline");
    const parent = await f.create({ agentPreset: "dsmm-orchestrator" });
    const child = await f.createAuxiliary("dsmm-reviewer", undefined, "continuable", parent);
    assert.equal(parent.session.snapshotEvents().some(event => event.type === "turn/start"), false);
    await assert.rejects(runtime.selectSession(await request(runtime, parent, null), structural(parent)), { code: "busy" });
    await f.releaseAuxiliary(child);
  } finally { await f.dispose(); }
});

test("failed idle installation restores the old prompt and callable definitions for the next actual turn", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, locale: "en" });
  let fault: ReturnType<typeof mock.method> | undefined;
  try {
    const runtime = runtimeOf(f), agent = await f.create({ agentPreset: "standard" });
    await runFixtureTurn(agent);
    const before = runtime.admission(structural(agent));
    const saved = await runtime.save({ id: "broken", expectedRevision: null, content: JSON.stringify({ version: 1, id: "broken", settings: {
      defaultActive: true, locale: "ja", subagents: { toolTopology: "parameterized" },
    } }) });
    const register = ToolRuntime.prototype.register;
    let failed = false;
    fault = mock.method(ToolRuntime.prototype, "register", function (this: ToolRuntime, definition: Parameters<ToolRuntime["register"]>[0]) {
      if (definition.name === "dsmm_role" && !failed) { failed = true; throw new Error("Fixture installation failure"); }
      return register.call(this, definition);
    });
    await assert.rejects(runtime.selectSession(await request(runtime, agent, saved.id, saved.revision), structural(agent)), { code: "activation" });
    assert.equal(failed, true);
    assert.equal(runtime.admission(structural(agent)), before);
    assert.equal((await centralStore(f).loadSessionSelection(agent.id)).admissionEpoch, null);
    assert.equal(agent.ctx.tools.get("dsmm_reviewer", agent)?.name, "dsmm_reviewer");
    assert.equal(agent.ctx.tools.get("dsmm_role", agent), undefined);
    await runFixtureTurn(agent);
    assert.match(JSON.stringify(f.adapter.calls.at(-1)?.messages.filter(message => message.role === "system")), /capturedLocale\\":\\"en/u);
    const child = await f.createAuxiliary("dsmm-reviewer", undefined, "continuable", agent);
    await runFixtureTurn(child);
    assert.equal(runtime.admission(structural(child)).epoch, before.epoch);
    await f.releaseAuxiliary(child);
  } finally { fault?.mock.restore(); await f.dispose(); }
});

test("failed restoration on a started root keeps execution fail-closed without affecting another root", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, locale: "en" });
  let fault: ReturnType<typeof mock.method> | undefined;
  try {
    const runtime = runtimeOf(f), agent = await f.create({ agentPreset: "standard" }), other = await f.create({ agentPreset: "standard" });
    await runFixtureTurn(agent);
    const before = runtime.admission(structural(agent));
    const saved = await runtime.save({ id: "restore-fault", expectedRevision: null, content: JSON.stringify({ version: 1, id: "restore-fault", settings: {
      defaultActive: true, locale: "ja", subagents: { toolTopology: "parameterized" },
    } }) });
    const register = ToolRuntime.prototype.register, faults: string[] = [];
    fault = mock.method(ToolRuntime.prototype, "register", function (this: ToolRuntime, definition: Parameters<ToolRuntime["register"]>[0]) {
      if (["dsmm_role", "dsmm_reviewer"].includes(definition.name)) { faults.push(definition.name); throw new Error("Installation unavailable"); }
      return register.call(this, definition);
    });
    await assert.rejects(runtime.selectSession(await request(runtime, agent, saved.id, saved.revision), structural(agent)), { code: "activation" });
    assert.ok(faults.includes("dsmm_role") && faults.includes("dsmm_reviewer"));
    fault.mock.restore(); fault = undefined;
    assert.equal(runtime.admission(structural(agent)), before);
    assert.equal((await centralStore(f).loadSessionSelection(agent.id)).admissionEpoch, null);
    const calls = f.adapter.calls.length;
    await runFixtureTurn(agent); assert.equal(f.adapter.calls.length, calls);
    assert.equal((await agent.ctx.tools.execute({ agent, name: "read", arguments: {}, callId: ToolCallId("failed-restoration"), signal: new AbortController().signal })).isError, true);
    await runFixtureTurn(other); assert.equal(f.adapter.calls.length, calls + 1);
  } finally { fault?.mock.restore(); await f.dispose(); }
});

test("idle transaction reports durable observation failure honestly and rolls back rename/operator failures", async t => {
  for (const failure of ["rename", "observe", "operator"] as const) await t.test(failure, async () => {
    const f = await nativeRoutingFixture({ defaultActive: true, locale: "en" });
    let interception: ReturnType<typeof mock.method> | undefined;
    try {
      const runtime = runtimeOf(f), agent = await f.create({ agentPreset: "standard" });
      await runFixtureTurn(agent);
      const before = runtime.admission(structural(agent)), original = ProfileStore.prototype.selectSession;
      const saved = await runtime.save({ id: "transaction", expectedRevision: null, content: JSON.stringify({ version: 1, id: "transaction", settings: {
        defaultActive: true, locale: "ja", subagents: { toolTopology: "parameterized" },
      } }) });
      let observed = false, authorized = true;
      const store = ProfileStore.fromCentral(f.home, f.profileDir, before.deployment!.entryId, {
        rename(source, destination) { if (failure === "rename" && destination.includes(".sessions")) throw new Error("Fixture rename failure"); renameSync(source, destination); },
        observe(path) {
          if (failure !== "observe" || !path.includes(".sessions")) return;
          observed = true;
          assert.notEqual(runtime.admission(structural(agent)), before);
          assert.equal(f.ctx.get("dsmmNativeAdmission")!.get(agent), runtime.admission(structural(agent)));
          throw new Error("Fixture post-commit observation failure");
        },
      });
      interception = mock.method(ProfileStore.prototype, "selectSession", function (...[_request, epoch, validate, commit]: Parameters<ProfileStore["selectSession"]>) {
        return original.call(store, _request, epoch, validate, { ...commit, async prepare(selection, prepared) {
          await commit.prepare?.(selection, prepared);
          if (failure === "operator") authorized = false;
        } });
      });
      const choice = await request(runtime, agent, saved.id, saved.revision);
      const selecting = runtime.selectSession(choice, structural(agent), undefined, () => { if (!authorized) throw new DsmmProfileError("not-owned", "Fixture operator retired"); });
      if (failure === "observe") {
        const result = await selecting;
        assert.equal(observed, true); assert.equal(result.refreshRequired, true);
        assert.equal(result.admittedSelection?.selectedId, saved.id);
        assert.equal((await store.loadSessionSelection(agent.id)).admissionEpoch, result.admissionEpoch);
        const confirmed = await runtime.getSession(structural(agent));
        assert.equal(confirmed.admittedSelection?.selectedId, saved.id);
        assert.equal(confirmed.admittedSelection?.refreshRequired, undefined);
        assert.equal(confirmed.admittedSelection?.selectionRevision, confirmed.selection.selectionRevision);
        await assert.rejects(runtime.selectSession(choice, structural(agent)), { code: "conflict" });
      } else {
        await assert.rejects(selecting, { code: failure === "rename" ? "io" : "not-owned" });
        assert.equal(runtime.admission(structural(agent)), before);
        assert.equal((await store.loadSessionSelection(agent.id)).admissionEpoch, null);
        assert.equal(agent.ctx.tools.get("dsmm_reviewer", agent)?.name, "dsmm_reviewer");
        assert.equal(agent.ctx.tools.get("dsmm_role", agent), undefined);
      }
      await runFixtureTurn(agent);
      assert.match(JSON.stringify(f.adapter.calls.at(-1)?.messages.filter(message => message.role === "system")), failure === "observe" ? /capturedLocale\\":\\"ja/u : /capturedLocale\\":\\"en/u);
    } finally { interception?.mock.restore(); await f.dispose(); }
  });
});

test("explicit store startup lock contention still refuses, while strict legacy startup reads never contend or write locks", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsmm-startup-lock-"));
  try {
    const storeDir = join(root, "dsmm-profiles");
    const store = new ProfileStore(storeDir);
    const saved = await store.save({ id: "a", content: profile("a", "startup-a"), expectedRevision: null });
    await store.select({ id: "a", expectedRevision: saved.revision, expectedSelectionRevision: "absent" });
    const pointer = readFileSync(join(storeDir, ".selection.json"));
    writeFileSync(join(storeDir, ".lock"), "preexisting-init-owner");
    let listeners = 0;
    const explicit = new DsmmProfileRuntime({ on() { listeners++; } }, resolveConfig(), store);
    await assert.rejects(explicit.initialize(), { code: "lock-timeout" });
    assert.equal(listeners, 0);
    const legacy = await createProfileRuntime({ get: (name) => (name === "profileContext" ? { dir: root } : undefined) as never }, resolveConfig());
    assert.equal(legacy.admission().sourceRevision, saved.revision);
    assert.equal((await legacy.describe()).readOnly, true);
    assert.equal(readFileSync(join(storeDir, ".selection.json")).equals(pointer), true);
    assert.equal(readFileSync(join(storeDir, ".lock"), "utf8"), "preexisting-init-owner");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an exact native entered Agent cannot bypass its sidecar through a synchronous getter before serial created admission", async () => {
  const f = await nativeRoutingFixture();
  try {
    const runtime = runtimeOf(f);
    let setupObserved = false, enteredObserved = false;
    f.ctx.on("agent/created", async ({ agent }) => {
      if (agent.id !== "dsmm-entered-before-created") return;
      enteredObserved = true;
      assert.throws(() => runtime.getSettings(structural(agent)), { code: "activation" });
      await assert.rejects(runtime.getSession(structural(agent)), { code: "activation" });
    }, { prepend: true, global: true });
    const early = await f.create({}, undefined, {
      sessionId: SessionId("dsmm-entered-before-created"),
      async setup(_agentCtx, agent) {
        setupObserved = true;
        assert.throws(() => runtime.getSettings(structural(agent)), { code: "activation" }, "unpublished native setup cannot establish a default binding either");
        await assert.rejects(runtime.getSession(structural(agent)), { code: "not-owned" }, "setup has not published an owned Agent yet");
        return { commit() { assert.throws(() => runtime.getSettings(structural(agent)), { code: "activation" }); } };
      }
    });
    assert.equal(setupObserved, true);
    assert.equal(enteredObserved, true);
    assert.equal(runtime.admission(structural(early)).scope, "global-default");
  } finally { await f.dispose(); }
});
