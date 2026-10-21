import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { ReasoningEffortId, ToolCallId } from "@deepseek-ai/dsh-llm";
import { foldSubagentDescriptor } from "@deepseek-ai/dsh-subagent";
import { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { registerDsmmStatusCommand } from "../src/commands.js";
import type { DshAgent, DshCommandsRegistry, DshContext } from "../src/dsh-types.js";
import { createProfileRuntime, DsmmProfileRuntime } from "../src/profile-runtime.js";
import { ProfileStore } from "../src/profile-store.js";
import { resolveConfig } from "../src/settings.js";
import type { DsmmPluginConfig, DsmmDeploymentSnapshot } from "../src/settings.js";
import { DeepworkModeController } from "../src/state.js";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { headerRoutes, nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

function profile(id: string, settings: DsmmPluginConfig): string {
  return JSON.stringify({ version: 1, id, settings });
}

function mockAgent(id: string): DshAgent {
  return { id, session: { events: [], append() {} } };
}

function liveRoots(services = new Map<string, unknown>()) {
  const roots = new Map<string, DshAgent>();
  const lifetime = new AbortController();
  const owner = { lifetime, isReady: true, blankReason: () => "new-session-required" as const };
  const registry = { get: (id: string) => roots.get(id), roots: () => [...roots.values()] };
  const context: DshContext = { get(name) { return (name === "agents" ? registry : name === "dsmmNativeAdmission" ? owner : services.get(name)) as never; } };
  return { context, roots, lifetime, owner, async admit(runtime: DsmmProfileRuntime, id: string) {
    const agent = mockAgent(id); roots.set(id, agent);
    const candidate = await runtime.prepareRoot(agent, new AbortController().signal);
    runtime.publish(agent, candidate);
    return agent;
  } };
}

test("two Hosts sharing a profile store report external selection conflicts without silently admitting disk settings", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "dsmm-profile-runtime-"));
  const storeDir = join(rootDir, "dsmm-profiles");
  const live = liveRoots();
  const hostA = new DsmmProfileRuntime(live.context, resolveConfig(), new ProfileStore(storeDir));
  try {
    await hostA.initialize();
    const a = await hostA.save({ id: "a", content: profile("a", { defaultActive: true }), expectedRevision: null });
    await hostA.select({ id: "a", expectedRevision: a.revision, expectedSelectionRevision: "absent" });
    const existingA = await live.admit(hostA, "existing-a-root");
    const admittedA = hostA.getSettings(existingA);
    const hostB = new DsmmProfileRuntime({}, resolveConfig(), new ProfileStore(storeDir));
    await hostB.initialize();
    const b = await hostB.save({ id: "b", content: profile("b", { defaultActive: false }), expectedRevision: null });
    const selectedB = await hostB.select({ id: "b", expectedRevision: b.revision, expectedSelectionRevision: (await hostB.describe()).selectionRevision });
    const conflict = await hostA.describe();
    assert.equal(conflict.selectedId, "a", "Host A must not claim the externally selected B policy is admitted here");
    assert.equal(conflict.sourceRevision, a.revision);
    assert.equal(conflict.selectionRevision, selectedB.selectionRevision, "the actual persisted revision remains available for safe reconciliation");
    assert.equal(conflict.selectionError?.code, "conflict");
    const whileConflicted = await live.admit(hostA, "new-a-root-during-conflict");
    const conflictSettings = hostA.getSettings(whileConflicted);
    assert.deepEqual(conflictSettings, admittedA);
    assert.equal(hostA.getSettings().defaultActive, true);
    const reconciled = await hostA.select({ id: "b", expectedRevision: b.revision, expectedSelectionRevision: conflict.selectionRevision });
    assert.equal(reconciled.selectedId, "b");
    assert.equal(reconciled.selectionError, undefined);
    assert.equal(hostA.getSettings(await live.admit(hostA, "new-b-root")).defaultActive, false);
    assert.equal(hostA.getSettings(existingA), admittedA);
    assert.equal(hostA.getSettings(whileConflicted), conflictSettings);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("selection retains committed runtime success when final metadata observation fails", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "dsmm-profile-runtime-"));
  const storeDir = join(rootDir, "dsmm-profiles");
  let refuseObservation = false;
  let refuseDescribe = false;
  const storeA = new ProfileStore(storeDir, { observe() { if (refuseObservation) { refuseDescribe = true; throw new Error("final stat unavailable"); } } });
  const describe = storeA.describe.bind(storeA);
  storeA.describe = async () => { if (refuseDescribe) throw new Error("postcommit read failed"); return describe(); };
  const live = liveRoots();
  const hostA = new DsmmProfileRuntime(live.context, resolveConfig(), storeA);
  const hostB = new DsmmProfileRuntime({}, resolveConfig(), new ProfileStore(storeDir));
  try {
    await hostA.initialize(); await hostB.initialize();
    const a = await hostA.save({ id: "a", content: profile("a", { defaultActive: true }), expectedRevision: null });
    const b = await hostB.save({ id: "b", content: profile("b", { defaultActive: false }), expectedRevision: null });
    refuseObservation = true;
    const selected = await hostA.select({ id: "a", expectedRevision: a.revision, expectedSelectionRevision: "absent" });
    assert.equal(selected.selectedId, "a", "the response identifies the Host-admitted policy, not the later external pointer");
    assert.equal(selected.sourceRevision, a.revision);
    assert.equal(selected.selectionError, undefined);
    assert.equal(selected.selectionRevision, "unavailable");
    assert.equal(selected.refreshRequired, true);
    refuseDescribe = false;
    const committed = hostA.admission();
    const oldA = await live.admit(hostA, "post-commit-a-root");
    assert.equal(hostA.getSettings(oldA).defaultActive, true);
    const refreshed = await hostA.describe();
    assert.equal(hostA.admission(), committed, "metadata observation does not replace admission identity");
    refuseObservation = false;
    const reconciled = await hostA.select({ id: "b", expectedRevision: b.revision, expectedSelectionRevision: refreshed.selectionRevision });
    assert.equal(reconciled.selectedId, "b");
    assert.equal(reconciled.selectionError, undefined);
    assert.equal(hostA.getSettings(await live.admit(hostA, "post-reconcile-b-root")).defaultActive, false);
    assert.equal(hostA.getSettings(oldA).defaultActive, true);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("root publication retains candidate revisions, startup ceiling and replacement-route provenance", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "dsmm-profile-candidate-"));
  const live = liveRoots(), base = resolveConfig({ roles: { "dsmm-builder": false } });
  const startup: DsmmDeploymentSnapshot = { settings: base, global: {}, profile: {}, globalRevision: "startup-global", nativeRevision: "startup-native", entryId: "fixture", hostProfileKey: "fixture", sources: { "roles.dsmm-builder": "profile" } };
  const desired: DsmmDeploymentSnapshot = { ...startup, settings: resolveConfig({ roles: { "dsmm-builder": true }, workflow: { reviewCap: 4 }, roleRouting: { "dsmm-reviewer": { primary: { provider: "fixture", model: "deployment", reasoningEffort: "high" } } } }),
    globalRevision: "desired-global", sources: { "roles.dsmm-builder": "global", "workflow.reviewCap": "global", "roleRouting.dsmm-reviewer.primary.reasoningEffort": "global" } };
  const store = new ProfileStore(join(rootDir, "dsmm-profiles"));
  const runtime = new DsmmProfileRuntime(live.context, base, store, { startup, readDesired: async () => desired });
  try {
    await runtime.initialize();
    const draft = await runtime.save({ id: "overlay", expectedRevision: null, content: profile("overlay", { workflow: { reviewCap: 2 }, roleRouting: { "dsmm-reviewer": { primary: { provider: "fixture", model: "overlay" } } } }) });
    const selected = await runtime.select({ id: draft.id, expectedRevision: draft.revision, expectedSelectionRevision: "absent" });
    const agent = mockAgent("candidate-root"); live.roots.set(agent.id!, agent);
    const candidate = await runtime.prepareRoot(agent, new AbortController().signal);
    runtime.publish(agent, candidate);
    const admission = runtime.admission(agent);
    assert.equal(admission, candidate);
    assert.equal(admission.selectionRevision, selected.selectionRevision);
    assert.equal(admission.sourceRevision, draft.revision);
    assert.equal(admission.baseline.workflow.reviewCap, 4);
    assert.equal(admission.settings.workflow.reviewCap, 2);
    assert.equal(admission.settings.roles["dsmm-builder"], false);
    assert.ok(admission.restartRequired?.includes("roles.dsmm-builder"));
    assert.deepEqual(admission.sourceCaptures?.startup, { globalRevision: "startup-global", nativeRevision: "startup-native" });
    assert.equal(admission.sourceCaptures?.fields["roles.dsmm-builder"], "startup");
    assert.equal(admission.sources?.["roleRouting.dsmm-reviewer.primary.reasoningEffort"], undefined);
    assert.equal(admission.sources?.["roleRouting.dsmm-reviewer.primary.model"], "named-session");
    assert.equal((await runtime.describeDeployment()).admission, null);
    assert.equal(runtime.hasAdmission(agent), true);
    live.roots.set(agent.id!, mockAgent(agent.id!));
    assert.equal(runtime.hasAdmission(agent), false);
    assert.throws(() => runtime.admission(agent), { code: "activation" });
    live.roots.set(agent.id!, agent);
    live.lifetime.abort();
    assert.equal(runtime.hasAdmission(agent), false);
    assert.throws(() => runtime.admission(agent), { code: "activation" });
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("session observation rejects an externally replaced admission epoch", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "dsmm-profile-session-"));
  const live = liveRoots(), store = new ProfileStore(join(rootDir, "dsmm-profiles"));
  const runtime = new DsmmProfileRuntime(live.context, resolveConfig(), store);
  try {
    await runtime.initialize();
    const agent = await live.admit(runtime, "session-root"), admitted = runtime.admission(agent);
    await store.selectSession({ sessionId: agent.id!, id: null, expectedSelectionRevision: "absent", expectedAdmissionEpoch: admitted.epoch }, "b".repeat(64), () => undefined, { assertCurrent() {}, committed() {} });
    await assert.rejects(runtime.getSession(agent), { code: "conflict" });
    assert.equal(runtime.admission(agent), admitted);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("retirement during candidate validation prevents selection publication", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "dsmm-profile-retire-"));
  let retire: (() => unknown) | undefined, release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }), validation = new Promise<void>(resolve => { entered = resolve; });
  const store = new ProfileStore(join(rootDir, "dsmm-profiles"));
  const runtime = new DsmmProfileRuntime({ effect(callback) { retire = callback() as () => unknown; } }, resolveConfig(), store, { async validateCandidate() { entered(); await waiting; } });
  try {
    await runtime.initialize();
    const draft = await runtime.save({ id: "a", expectedRevision: null, content: profile("a", { defaultActive: true }) });
    const selection = runtime.select({ id: "a", expectedRevision: draft.revision, expectedSelectionRevision: "absent" });
    await validation; retire!(); release();
    await assert.rejects(selection, { code: "disposed" });
    assert.equal((await store.loadSelection()).selectedId, null);
  } finally { release(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("ordinary mode intents use native maintenance without replacing admission or enabling live Apply", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "dsmm-profile-mode-"));
  const live = liveRoots(), mode = new DeepworkModeController(live.context);
  const runtime = new DsmmProfileRuntime(live.context, resolveConfig(), new ProfileStore(join(rootDir, "dsmm-profiles")), { modeController: mode });
  try {
    await runtime.initialize();
    const agent = await live.admit(runtime, "mode-root"), admission = runtime.admission(agent);
    const session = Session.create(SessionId(agent.id!));
    agent.session = session as unknown as DshAgent["session"];
    let checks = 0;
    agent.runMaintenance = task => task(new AbortController().signal);
    for (const active of [true, false]) {
      const before = await runtime.getSession(agent);
      const response = await runtime.selectMode({ sessionId: agent.id!, active, expectedModeRevision: before.deepwork!.revision, expectedAdmissionEpoch: before.admissionEpoch }, agent, undefined, () => { checks++; });
      assert.equal(response.deepwork?.active, active);
      assert.equal(response.switchAllowed, false);
      assert.equal(response.canToggleMode, active);
      assert.equal(response.toggleModeUnavailableReason, active ? undefined : "runtime-unavailable");
      assert.equal(runtime.admission(agent), admission);
    }
    assert.equal(session.snapshotEvents().length, 2); assert.ok(checks >= 2);
    const before = await runtime.getSession(agent);
    await assert.rejects(runtime.selectMode({ sessionId: agent.id!, active: true, expectedModeRevision: before.deepwork!.revision, expectedAdmissionEpoch: before.admissionEpoch }, agent, undefined, () => { throw new Error("operator changed"); }));
    assert.equal(session.snapshotEvents().length, 2);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("independent profile model projection stays detached and pinned while future defaults change", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "dsmm-profile-model-")), live = liveRoots();
  const runtime = new DsmmProfileRuntime(live.context, resolveConfig({ defaultActive: true }), new ProfileStore(join(rootDir, "dsmm-profiles")));
  try {
    await runtime.initialize();
    const draft = await runtime.save({ id: "a", expectedRevision: null, content: profile("a", { roleRouting: { "dsmm-orchestrator": { primary: { provider: "native", model: "a", customParameters: { nested: { value: 1 } } } } } }) });
    const selected = await runtime.select({ id: "a", expectedRevision: draft.revision, expectedSelectionRevision: "absent" });
    const agent = await live.admit(runtime, "model-root"), admission = runtime.admission(agent);
    const snapshot = await runtime.getSession(agent);
    assert.equal(snapshot.switchAllowed, false);
    assert.equal(snapshot.profileModel?.model, "a");
    snapshot.profileModel!.model = "caller-copy";
    snapshot.profileModel!.customParameters = { caller: true };
    const next = await runtime.save({ id: "b", expectedRevision: null, content: profile("b", { roleRouting: { "dsmm-orchestrator": { primary: { provider: "native", model: "b" } } } }) });
    await runtime.select({ id: "b", expectedRevision: next.revision, expectedSelectionRevision: selected.selectionRevision });
    const current = await runtime.getSession(agent);
    assert.equal(current.globalDefault.selectedId, "b");
    assert.equal(current.profileModel?.model, "a");
    assert.deepEqual(current.profileModel?.customParameters, { nested: { value: 1 } });
    assert.equal(runtime.admission(agent), admission);
    assert.equal((await runtime.getSession(await live.admit(runtime, "new-model-root"))).profileModel?.model, "b");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("session action capabilities separate native model selection, mode maintenance and overlay Apply", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "dsmm-profile-actions-"));
  const services = new Map<string, unknown>([["subagents", {}], ["agentPresets", { resolve: async () => ({}) }], ["llm", { resolveCallConfig: async (call: unknown) => call }]]);
  const live = liveRoots(services);
  const runtime = new DsmmProfileRuntime(live.context, resolveConfig({ defaultActive: true, roleRouting: { "dsmm-orchestrator": { primary: { provider: "native", model: "selected" } } } }), new ProfileStore(join(rootDir, "dsmm-profiles")));
  try {
    await runtime.initialize();
    const agent = await live.admit(runtime, "action-root");
    agent.runMaintenance = task => task(new AbortController().signal);
    let running = false;
    Object.defineProperty(agent, "status", { get: () => running ? "running" : "idle" });
    const idle = await runtime.getSession(agent);
    assert.equal(idle.canToggleMode, true);
    assert.equal(idle.canSelectModel, true);
    assert.equal(idle.canApplyOverlay, false);
    assert.equal(idle.applyOverlayUnavailableReason, "new-session-required");
    assert.equal(idle.toggleModeUnavailableReason, undefined);
    running = true;
    const active = await runtime.getSession(agent);
    assert.equal(active.canSelectModel, true, "native selection targets the next assembly, not idle overlay maintenance");
    assert.equal(active.canToggleMode, false);
    assert.equal(active.toggleModeUnavailableReason, "busy");
    running = false;
    delete agent.runMaintenance;
    assert.equal((await runtime.getSession(agent)).toggleModeUnavailableReason, "maintenance");
    services.delete("llm");
    const withoutModelService = await runtime.getSession(agent);
    assert.equal(withoutModelService.canSelectModel, false);
    assert.equal(withoutModelService.selectModelUnavailableReason, "model-service-unavailable");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("a ready stock runtime validates root presets before committing a future default", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "dsmm-profile-native-audit-"));
  const live = liveRoots(new Map([["agentPresets", { resolve: async () => ({ broken: "unavailable" }) }]]));
  const store = new ProfileStore(join(rootDir, "dsmm-profiles"));
  const runtime = new DsmmProfileRuntime(live.context, resolveConfig(), store, { runtimeView: () => ({ binding: "stock", deliveryFenceReady: true, restartRequired: false }) });
  try {
    await runtime.initialize();
    const admitted = runtime.admission();
    await assert.rejects(runtime.select({ id: null, expectedSelectionRevision: "absent" }), { code: "activation" });
    assert.equal(runtime.admission(), admitted);
    assert.equal((await store.loadSelection()).selectionRevision, "absent");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("profile admission is immutable for existing and blank roots, and trusted children inherit the parent revision", async () => {
  const fixture = await nativeRoutingFixture({ roles: { "dsmm-builder": false } }, { headless: true, persistence: true });
  const runtime = fixture.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
  const store = ProfileStore.fromCentral(fixture.home, fixture.profileDir, fixture.dsmmEntryId ?? "trusted-direct");
  let childAgent: Awaited<ReturnType<typeof fixture.createAuxiliary>> | undefined;
  try {
    assert.ok(runtime);
    const a = await runtime.save({ id: "a", content: profile("a", { defaultActive: true, guards: { gitWriteGuard: "deny" } }), expectedRevision: null });
    await runtime.select({ id: "a", expectedRevision: a.revision, expectedSelectionRevision: "absent" });
    const parent = await fixture.create({ agentPreset: "dsmm-orchestrator" });
    const root = parent as unknown as DshAgent;
    const blank = await fixture.create({ agentPreset: "standard" }) as unknown as DshAgent;
    const admitted = runtime.getSettings(root);
    const blankAdmitted = runtime.getSettings(blank);
    assert.deepEqual(blankAdmitted, admitted);
    assert.equal(Object.isFrozen(admitted), true);
    assert.equal(Object.isFrozen(admitted.guards.toolOutputTruncation), true);
    const b = await runtime.save({ id: "b", content: profile("b", { defaultActive: false, guards: { gitWriteGuard: "off" } }), expectedRevision: null });
    assert.equal(runtime.getSettings().defaultActive, true, "saving is draft-only");
    await runtime.select({ id: "b", expectedRevision: b.revision, expectedSelectionRevision: (await runtime.describe()).selectionRevision });
    const requests = fixture.adapter.calls.length;
    await assert.rejects(fixture.create({ origin: "subagent", agentPreset: "dsmm-reviewer" }));
    assert.equal(fixture.adapter.calls.length, requests, "an unowned child cannot borrow the new global policy or issue a request");
    childAgent = await fixture.createAuxiliary("dsmm-reviewer", undefined, "one-shot", parent);
    const child = childAgent as unknown as DshAgent;
    assert.equal(fixture.agents.isOwnedBy(childAgent.id, parent), true);
    await runFixtureTurn(childAgent);
    assert.equal(runtime.admission(child).profile?.revision, runtime.admission(root).appliedRevision);
    assert.equal(runtime.admission(child).epoch, runtime.admission(root).epoch);
    const newest = await fixture.create({ agentPreset: "standard" }) as unknown as DshAgent;
    const childAdmitted = runtime.getSettings(child);
    assert.equal(Object.isFrozen(childAdmitted), true);
    assert.equal(runtime.getSettings(root), admitted);
    assert.equal(runtime.getSettings(blank), blankAdmitted, "a global selection cannot change the blank root's admitted runtime settings");
    assert.equal(runtime.getSettings(child).defaultActive, admitted.defaultActive);
    assert.equal(runtime.getSettings(child).guards.gitWriteGuard, admitted.guards.gitWriteGuard);
    assert.equal(runtime.admission(child).appliedRevision, runtime.admission(root).appliedRevision);
    assert.equal(runtime.getSettings(newest).defaultActive, false);
    assert.equal(runtime.getSettings(newest).roles["dsmm-builder"], false);
    const edited = await runtime.save({ id: "b", content: profile("b", { defaultActive: true }), expectedRevision: b.revision });
    assert.notEqual(edited.revision, b.revision);
    assert.equal(runtime.getSettings(newest).defaultActive, false, "active draft edits never mutate a pinned snapshot");
    assert.equal(runtime.getSettings(child), childAdmitted, "draft edits cannot change the child's original captured admission");
    const cold = new DsmmProfileRuntime({}, resolveConfig({ roles: { "dsmm-builder": false } }), store);
    await cold.initialize();
    assert.equal(cold.getSettings().defaultActive, false, "initialization follows immutable applied bytes, not the edited draft");
    assert.equal(cold.admission().sourceRevision, b.revision);
  } finally { try { if (childAgent) await fixture.releaseAuxiliary(childAgent); } finally { await fixture.dispose(); } }
});

test("semantic activation and atomic selection-pointer failures leave the runtime and durable selection unchanged", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "dsmm-profile-runtime-"));
  let failPointer = false;
  let rejectCandidate = false;
  const store = new ProfileStore(join(rootDir, "dsmm-profiles"), {
    rename(source, destination) {
      if (failPointer && basename(destination) === ".selection.json") throw new Error("private-io-fixture");
      renameSync(source, destination);
    }
  });
  const runtime = new DsmmProfileRuntime({}, resolveConfig(), store, { validateCandidate() { if (rejectCandidate) throw new Error("rejected semantic candidate"); } });
  try {
    await runtime.initialize();
    const a = await runtime.save({ id: "a", content: profile("a", { defaultActive: true }), expectedRevision: null });
    await runtime.select({ id: "a", expectedRevision: a.revision, expectedSelectionRevision: "absent" });
    const before = await store.loadSelection();
    const settings = runtime.getSettings();
    const b = await runtime.save({ id: "b", content: profile("b", { defaultActive: false }), expectedRevision: null });
    const select = () => runtime.select({ id: "b", expectedRevision: b.revision, expectedSelectionRevision: before.selectionRevision });
    rejectCandidate = true;
    await assert.rejects(select());
    assert.equal(runtime.getSettings(), settings);
    assert.deepEqual(await store.loadSelection(), before);
    rejectCandidate = false; failPointer = true;
    await assert.rejects(select());
    assert.equal(runtime.getSettings(), settings);
    assert.deepEqual(await store.loadSelection(), before);
    failPointer = false;
    await select();
    assert.equal(runtime.getSettings().defaultActive, false, "a failed operation does not poison later selections");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("native profile installation requires profileContext.dir and never invents a home location", async () => {
  await assert.rejects(createProfileRuntime({ get: () => undefined }, resolveConfig()), { code: "activation" });
  await assert.rejects(createProfileRuntime({ get: () => ({ startedBundles: [] }) as never }, resolveConfig()), { code: "activation" });
});

test("native global A-to-B switching retains admitted routes, guards and startup ceilings", async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "dsmm-profile-runtime-"));
  let fixture = await nativeRoutingFixture({ roles: { "dsmm-builder": false } }, { headless: true, profileDir });
  try {
    const runtime = (fixture.ctx as unknown as DshContext).get!<DsmmProfileRuntime>("dsmmProfileRuntime");
    assert.ok(runtime);
    await fixture.create(); // Genuine Agent-local LLM admission for UI activation.
    const route = (model: string) => ({ provider: "fixture", model, reasoningEffort: "high" });
    const a = await runtime.save({ id: "a", expectedRevision: null, content: profile("a", {
      defaultActive: true, workflow: { policy: "legacy", reviewCap: 2 }, guards: { scope: "always", gitWriteGuard: "deny" }, runtimeRecovery: { enabled: true },
      roleRouting: { "dsmm-orchestrator": { primary: route("root-a"), fallbackRoutes: [route("backup-a")] }, "dsmm-reviewer": { primary: route("review-a") } }
    }) });
    await runtime.select({ id: "a", expectedRevision: a.revision, expectedSelectionRevision: "absent" });
    const parent = await fixture.create({ agentPreset: "dsmm-orchestrator" });
    const blank = await fixture.create({ agentPreset: "standard" });
    const b = await runtime.save({ id: "b", expectedRevision: null, content: profile("b", {
      defaultActive: true, workflow: { policy: "legacy", reviewCap: 4 }, guards: { scope: "always", gitWriteGuard: "off" }, runtimeRecovery: { enabled: true },
      roleRouting: { "dsmm-orchestrator": { primary: route("root-b"), fallbackRoutes: [route("backup-b")] }, "dsmm-reviewer": { primary: route("review-b") }, "dsmm-builder": { primary: route("disabled-builder") } }
    }) });
    fixture.adapter.failModels.add("native-default");
    let switched = false;
    fixture.adapter.beforeStream = async (call) => {
      if (call.model === "native-default" && !switched) {
        switched = true;
        await runtime.select({ id: "b", expectedRevision: b.revision, expectedSelectionRevision: (await runtime.describe()).selectionRevision });
      }
    };
    await runFixtureTurn(parent);
    assert.equal(switched, true);
    assert.deepEqual(headerRoutes(parent).map((value) => value.model), ["native-default"], "ordinary-root failures retain the native model rather than imply profile routing");
    assert.equal(runtime.admission(parent as unknown as DshAgent).sourceRevision, a.revision);
    const childAgent = await fixture.createAuxiliary("dsmm-reviewer", undefined, "one-shot", parent);
    try {
      const denied = await childAgent.ctx.get("tools")!.execute({ callId: ToolCallId("profile-child-deny"), name: "write", arguments: {}, agent: childAgent, signal: new AbortController().signal });
      assert.equal(denied.isError, true);
      await runFixtureTurn(childAgent);
      assert.equal(headerRoutes(childAgent).at(-1)?.model, "review-a");
      assert.equal(runtime.admission(childAgent as unknown as DshAgent).appliedRevision, runtime.admission(parent as unknown as DshAgent).appliedRevision);
    } finally { await fixture.releaseAuxiliary(childAgent); }
    const newRoot = await fixture.create({ agentPreset: "dsmm-orchestrator" });
    await runFixtureTurn(newRoot);
    assert.equal(headerRoutes(newRoot).at(-1)?.model, "native-default");
    assert.equal(runtime.getSettings(newRoot as unknown as DshAgent).roles["dsmm-builder"], false);
    assert.equal(fixture.subagents.getProvider("dsmm-role-builder"), undefined);
    blank.session.append("agent-preset/selected", { agentPreset: "dsmm-orchestrator" });
    fixture.ctx.emit("agent-preset/selected", blank.id, "dsmm-orchestrator");
    await runFixtureTurn(blank);
    assert.equal(headerRoutes(blank).at(-1)?.model, "native-default", "blank root rebinding retains the native model selection");
    assert.equal(runtime.getSettings(blank as unknown as DshAgent).workflow.reviewCap, 2, "blank composition changes keep the admitted snapshot rather than newer desired defaults");
    const executeGit = (agent: typeof parent) => agent.ctx.get("tools")!.execute({ callId: ToolCallId(`profile-guard-${agent.id}`), name: "bash", arguments: { command: "git commit -m never-executed-by-fixture" }, agent, signal: new AbortController().signal });
    assert.equal((await executeGit(parent)).isError, true);
    assert.equal((await executeGit(newRoot)).isError, false);
    assert.match(renderPrompt(await parent.ctx.get("systemPrompt")!.assemble({ agent: parent, scope: parent })), /reviewCap: 2/u);
    assert.match(renderPrompt(await newRoot.ctx.get("systemPrompt")!.assemble({ agent: newRoot, scope: newRoot })), /reviewCap: 4/u);
    let status: Parameters<DshCommandsRegistry["register"]>[0] | undefined;
    registerDsmmStatusCommand({ commands: { register(command) { status = command; } } }, new DeepworkModeController({}), runtime.getSettings);
    const statusA = await status!.handler({ agent: parent as unknown as DshAgent, rawInput: "json" });
    const statusB = await status!.handler({ agent: newRoot as unknown as DshAgent, rawInput: "json" });
    assert.equal(JSON.parse(statusA.text!).effectiveSettings.workflow.reviewCap, 2);
    assert.equal(JSON.parse(statusB.text!).effectiveSettings.workflow.reviewCap, 4);
  } finally { await fixture.dispose(); rmSync(profileDir, { recursive: true, force: true }); }
});

test("profile Apply preserves requested effort without requiring an Agent LLM or model metadata", async () => {
  const fixture = await nativeRoutingFixture();
  try {
    const runtime = (fixture.ctx as unknown as DshContext).get!<DsmmProfileRuntime>("dsmmProfileRuntime")!;
    const bad = await runtime.save({ id: "bad", expectedRevision: null, content: profile("bad", { roleRouting: { "dsmm-reviewer": { primary: { provider: "fixture", model: "no-max", reasoningEffort: "max" } } } }) });
    const rootDir = mkdtempSync(join(tmpdir(), "dsmm-profile-runtime-"));
    try {
      const noAgent = new DsmmProfileRuntime({ get: () => undefined }, resolveConfig(), new ProfileStore(join(rootDir, "dsmm-profiles")));
      await noAgent.initialize();
      const draft = await noAgent.save({ id: "bad", expectedRevision: null, content: bad.content });
      await noAgent.select({ id: "bad", expectedRevision: draft.revision, expectedSelectionRevision: "absent" });
      assert.equal((await noAgent.describe()).selectedId, "bad");
      assert.equal(noAgent.getSettings().roleRouting["dsmm-reviewer"]?.primary?.reasoningEffort, "max");
    } finally { rmSync(rootDir, { recursive: true, force: true }); }
    await fixture.create();
    fixture.adapter.unsupportedMaxModels.add("no-max");
    let metadataCalls = 0;
    fixture.adapter.resolveModel = async () => { metadataCalls++; throw new Error("Model metadata is not an Apply dependency"); };
    await runtime.select({ id: "bad", expectedRevision: bad.revision, expectedSelectionRevision: "absent" });
    assert.equal((await runtime.describe()).selectedId, "bad");
    assert.equal(runtime.getSettings().roleRouting["dsmm-reviewer"]?.primary?.reasoningEffort, "max");
    assert.equal(metadataCalls, 0);
    assert.equal(fixture.adapter.calls.length, 0);
  } finally { await fixture.dispose(); }
});

test("native role tool preflights exact parent-profile route before child creation and preserves explicit request priority", async () => {
  const fixture = await nativeRoutingFixture({ defaultActive: true, subagents: { allowRouteOverride: true }, roleRouting: { "dsmm-reviewer": { primary: { provider: "fixture", model: "review-preflight", reasoningEffort: "max" } } } }, { nativePresets: true, nativeJobs: true, beforeDsmm(ctx) {
    const denied = async (): Promise<never> => { throw new Error("Profile fixture forbids external work"); };
    ctx.provide("web", { search: denied, fetch: denied });
    ctx.provide("subprocess", { spawn: denied });
    ctx.provide("shell", { execute: denied });
    ctx.provide("shellEnv", { resolve: denied });
    return Promise.resolve();
  } });
  try {
    const parent = await fixture.create();
    fixture.adapter.unsupportedMaxModels.add("review-preflight");
    const count = fixture.agents.list().length;
    const refused = await parent.ctx.tools.execute({ agent: parent, name: "dsmm_reviewer", callId: ToolCallId("profile-preflight"), signal: new AbortController().signal,
      arguments: { description: "Preflight", prompt: "bounded local preflight" } });
    assert.equal(refused.isError, true);
    if (refused.isError) assert.equal(refused.error.info?.code, "UNSUPPORTED_REASONING_EFFORT");
    assert.equal(fixture.agents.list().length, count, "unsupported effort rejects before native child allocation");
    assert.equal(fixture.adapter.calls.length, 0);
    const signal = new AbortController().signal;
    const agentOptions = { provider: "fixture", model: "explicit-route", reasoningEffort: ReasoningEffortId("low"), maxTokens: 30 };
    const child = await fixture.createAuxiliary("dsmm-reviewer", undefined, "continuable", parent,
      { prompt: [{ type: "text", text: "forward exact native authority" }], agentOptions });
    try {
      assert.equal(child.options.model, "explicit-route");
      assert.equal(child.options.reasoningEffort, "low");
      assert.equal(child.options.maxTokens, 30);
      assert.equal(fixture.ctx.agentPresets.composedPreset(child.ctx), fixture.ctx.agentPresets.composedPreset(parent.ctx), "a delegated child shares its parent's standing composition");
      assert.equal(child.session.header.parentSession, parent.id);
      assert.equal(child.session.header.delegationDepth, 1);
      assert.equal(fixture.agents.isOwnedBy(child.id, parent), true);
      assert.equal((await child.ctx.tools.execute({ agent: child, name: "write", arguments: {}, callId: ToolCallId("explicit-reviewer-deny"), signal })).isError, true);
      await runFixtureTurn(child);
      assert.ok(child.session.snapshotEvents().some(event => event.type === "turn/end" && event.data.reason.kind === "completed"));
      const descriptor = foldSubagentDescriptor(child.session.snapshotEvents());
      assert.equal(descriptor?.mode, "continuable");
      assert.equal(descriptor?.provider, "dsmm-role-reviewer");
      assert.equal(fixture.adapter.calls.at(-1)?.model, "explicit-route");
    } finally { await fixture.releaseAuxiliary(child); }
  } finally { await fixture.dispose(); }
});

test("role tool enforces the captured zero-depth ceiling before native child allocation", async () => {
  const fixture = await nativeRoutingFixture({ defaultActive: true, subagents: { maxDepth: 0 } });
  try {
    const parent = await fixture.create();
    const result = await parent.ctx.tools.execute({ agent: parent, name: "dsmm_reviewer", arguments: { description: "Depth ceiling", prompt: "Must not dispatch" }, callId: ToolCallId("profile-depth-ceiling"), signal: new AbortController().signal });
    assert.equal(result.isError, true);
    assert.deepEqual(fixture.agents.list(), [parent]);
    assert.equal(fixture.adapter.calls.length, 0);
  } finally { await fixture.dispose(); }
});

test("named-profile levels preserve arbitrary effort without model I/O or changing Root selection", async () => {
  const fixture = await nativeRoutingFixture();
  try {
    const runtime = (fixture.ctx as unknown as DshContext).get!<DsmmProfileRuntime>("dsmmProfileRuntime")!;
    const root = await fixture.create();
    const options = structuredClone(root.options);
    let metadataCalls = 0;
    fixture.adapter.resolveModel = async () => { metadataCalls++; throw new Error("Model metadata is not an Apply dependency"); };
    const good = await runtime.save({ id: "level-good", expectedRevision: null, content: profile("level-good", { roleRouting: {
      "dsmm-reviewer": { levels: { low: { reasoningEffort: "low" }, high: { provider: "fixture", model: "review-high", reasoningEffort: "high" } } }
    } }) });
    const selected = await runtime.select({ id: good.id, expectedRevision: good.revision, expectedSelectionRevision: "absent" });
    assert.equal(selected.selectedId, good.id);
    assert.deepEqual(root.options, options); assert.equal(fixture.adapter.calls.length, 0);
    fixture.adapter.unsupportedMaxModels.add("review-no-max");
    const bad = await runtime.save({ id: "level-bad", expectedRevision: null, content: profile("level-bad", { roleRouting: {
      "dsmm-reviewer": { levels: { max: { provider: "fixture", model: "review-no-max", reasoningEffort: "max" } } }
    } }) });
    await runtime.select({ id: bad.id, expectedRevision: bad.revision, expectedSelectionRevision: selected.selectionRevision });
    assert.equal((await runtime.describe()).selectedId, bad.id); assert.deepEqual(root.options, options);
    assert.equal(runtime.getSettings().roleRouting["dsmm-reviewer"]?.levels?.max?.reasoningEffort, "max");
    assert.equal(metadataCalls, 0);
  } finally { await fixture.dispose(); }
});
