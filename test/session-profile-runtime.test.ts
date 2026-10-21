import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { ReasoningEffortId, ToolCallId } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import type { DshAgent, DshContext } from "../src/dsh-types.js";
import { createProfileRuntime, DsmmProfileRuntime } from "../src/profile-runtime.js";
import { ProfileStore } from "../src/profile-store.js";
import type { SessionProfileSelectRequest } from "../src/profile-types.js";
import { resolveConfig } from "../src/settings.js";
import { DsmmProfileError } from "../src/profiles.js";
import { DsmmDeploymentConfig } from "../src/deployment-config.js";
import { headerRoutes, nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

const route = (model: string) => ({ provider: "fixture", model, reasoningEffort: "high" });
const profile = (id: string, model: string) => JSON.stringify({ version: 1, id, settings: { defaultActive: true,
  roleRouting: { "dsmm-orchestrator": { primary: route(model) }, "dsmm-reviewer": { primary: route(`${model}-review`) } } } });
const structural = (agent: Agent) => agent as unknown as DshAgent;
function runtimeOf(f: Awaited<ReturnType<typeof nativeRoutingFixture>>) { return f.ctx.get("dsmmProfileRuntime") as unknown as DsmmProfileRuntime; }
function centralStore(f: Awaited<ReturnType<typeof nativeRoutingFixture>>) {
  return ProfileStore.fromCentral(f.home, f.profileDir, runtimeOf(f).admission().deployment!.entryId);
}
async function request(runtime: DsmmProfileRuntime, agent: Agent, id: string | null, revision?: string): Promise<SessionProfileSelectRequest> {
  const state = await runtime.getSession(structural(agent));
  return { sessionId: agent.id, id, ...(revision === undefined ? {} : { expectedRevision: revision }), expectedSelectionRevision: state.selection.selectionRevision, expectedAdmissionEpoch: state.admissionEpoch };
}
function gate() { let release!: () => void; const promise = new Promise<void>((done) => { release = done; }); return { promise, release }; }

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
    assert.equal((await runtime.getSession(structural(agent))).applyOverlayUnavailableReason, "new-session-required");
    await assert.rejects(choose(a.id, a.revision), { code: "unavailable" });
    assert.equal(runtime.admission(structural(agent)), admitted);
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

test("blank selection refuses preexisting input, seeded history and owned children even without a root turn", async () => {
  const f = await nativeRoutingFixture();
  try {
    const runtime = runtimeOf(f), queued = await f.create({ agentPreset: "standard" });
    const choice = await request(runtime, queued, null);
    queued.inject(createUserMessage({ content: [{ type: "text", text: "Already submitted" }], source: { kind: "user" } }));
    assert.equal((await runtime.getSession(structural(queued))).applyOverlayUnavailableReason, "busy");
    await assert.rejects(runtime.selectSession(choice, structural(queued)), { code: "busy" });
    const seed = queued.session.snapshotEvents();
    const seeded = await f.create({ agentPreset: "standard", isSeeded: true }, undefined, { seed, inheritedEventCount: SessionLogOffset(seed.length) });
    assert.equal(seeded.session.header.isSeeded, true);
    assert.equal((await runtime.getSession(structural(seeded))).applyOverlayUnavailableReason, "new-session-required");
    await assert.rejects(runtime.selectSession(await request(runtime, seeded, null), structural(seeded)), { code: "unavailable" });
    const parent = await f.create({ agentPreset: "dsmm-orchestrator" });
    const child = await f.createAuxiliary("dsmm-reviewer", undefined, "continuable", parent);
    assert.equal(parent.session.snapshotEvents().some(event => event.type === "turn/start"), false);
    await assert.rejects(runtime.selectSession(await request(runtime, parent, null), structural(parent)), { code: "busy" });
    await f.releaseAuxiliary(child);
  } finally { await f.dispose(); }
});

test("failed blank installation restores the old prompt and callable definitions before the first turn", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, locale: "en" });
  let fault: ReturnType<typeof mock.method> | undefined;
  try {
    const runtime = runtimeOf(f), agent = await f.create({ agentPreset: "standard" });
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
    assert.match(JSON.stringify(f.adapter.calls[0]?.messages), /capturedLocale\\":\\"en/u);
    const child = await f.createAuxiliary("dsmm-reviewer", undefined, "continuable", agent);
    await runFixtureTurn(child);
    assert.equal(runtime.admission(structural(child)).epoch, before.epoch);
    await f.releaseAuxiliary(child);
  } finally { fault?.mock.restore(); await f.dispose(); }
});

test("blank transaction reports durable observation failure honestly and rolls back rename/operator failures", async t => {
  for (const failure of ["rename", "observe", "operator"] as const) await t.test(failure, async () => {
    const f = await nativeRoutingFixture({ defaultActive: true, locale: "en" });
    let interception: ReturnType<typeof mock.method> | undefined;
    try {
      const runtime = runtimeOf(f), agent = await f.create({ agentPreset: "standard" });
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
      assert.match(JSON.stringify(f.adapter.calls[0]?.messages), failure === "observe" ? /capturedLocale\\":\\"ja/u : /capturedLocale\\":\\"en/u);
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
