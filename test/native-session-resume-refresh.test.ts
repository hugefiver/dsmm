import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DshAgent } from "../src/dsh-types.ts";
import type { DsmmProfileRuntime } from "../src/profile-runtime.ts";
import type { SessionController } from "@deepseek-ai/dsh-api-session-controller";
import { ToolCallId, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { ProfileStore } from "../src/profile-store.ts";
import { DsmmProfileRuntime as ProfileRuntime } from "../src/profile-runtime.ts";
import { resolveConfig } from "../src/settings.ts";
import type { DsmmProfileAdmission } from "../src/settings.ts";
import { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import type { Agent, ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import { SessionLogOffset } from "@deepseek-ai/dsh-session";
import { scopeParentOf } from "../src/native-scope.ts";
import { DSMM_ROLES } from "../src/roles.ts";
import { nativeRoutingFixture, runFixtureTurn, RoutingFixtureAdapter } from "./native-routing-fixture.ts";

test("native DSMM owner captures the current role route before preparing the exact request", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, lsp: { enabled: false },
    subagents: { enableRunInBackground: true, backgroundMode: "continuable" },
    roleRouting: { "dsmm-code-search": { primary: { provider: "fixture", model: "current-role", reasoningEffort: "max" } } }
  }, { dsmmLlm: true, nativePermissionSettings: true });
  try {
    const errors: unknown[] = [];
    f.ctx.on("agent/error", ({ error }) => { errors.push(error); }, { global: true });
    const child = await f.createAuxiliary("dsmm-code-search", undefined, "continuable");
    await runFixtureTurn(child);
    assert.deepEqual(errors, []);
    assert.equal(f.adapter.calls.find(call => call.sessionId === child.id)?.model, "current-role");
    assert.equal(f.adapter.calls.find(call => call.sessionId === child.id)?.reasoningEffort, "max");
    const resumed = await f.resumeAuxiliary(child);
    await runFixtureTurn(resumed);
    assert.equal(f.ctx.dsmmNativeAdmission.invocation(resumed)?.target, "dsmm-code-search");
    assert.equal(f.adapter.calls.filter(call => call.sessionId === child.id).length, 2);
  } finally { await f.dispose(); }
});

test("Host restart restores the original root and continuable child with latest named content", async t => {
  const root = mkdtempSync(join(tmpdir(), "dsmm-resume-refresh-"));
  const profileDir = join(root, "profile"), home = join(root, "home"), persistenceRoot = join(root, "sessions");
  mkdirSync(profileDir); mkdirSync(home);
  const config = { defaultActive: true, presets: { root: join(root, "presets") }, lsp: { enabled: false }, subagents: { enableRunInBackground: true, backgroundMode: "continuable" as const } };
  let shellBodies = 0;
  const shell = { name: "pwsh", description: "Count only; no process or Git execution", parameters: { command: { type: "string" as const, required: true }, description: { type: "string" as const, required: true } },
    output: { schema: { type: "string" as const }, render: () => [] }, async execute() { shellBodies++; return "counted"; } };
  const options = { profileDir, home, persistenceRoot, dsmmLlm: true, nativePermissionSettings: true, controller: true, fixtureTools: [shell] };
  const command = (agent: Agent, id: string) => agent.ctx.tools.execute({ agent, name: "pwsh", callId: ToolCallId(id), signal: new AbortController().signal,
    arguments: { command: "git commit -m counted-not-executed", description: "Counter-only approval probe" } });
  let a: Awaited<ReturnType<typeof nativeRoutingFixture>> | undefined;
  let b: Awaited<ReturnType<typeof nativeRoutingFixture>> | undefined;
  try {
    a = await nativeRoutingFixture(config, options);
    const parent = await a.create({ agentPreset: "standard", cwd: profileDir });
    const runtime = a.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    const document = (model: string) => JSON.stringify({ version: 1, id: "chosen", settings: {
      subagents: { toolTopology: model === "old-role" ? "per-role" : "parameterized" },
      roleRouting: { "dsmm-code-search": { primary: { provider: "fixture", model, reasoningEffort: "max" } } }
    } });
    const saved = await runtime.save({ id: "chosen", expectedRevision: null, content: document("old-role") });
    const session = await runtime.getSession(parent as unknown as DshAgent);
    const chosen = await runtime.selectSession({ sessionId: parent.id, id: "chosen", expectedRevision: saved.revision,
      expectedSelectionRevision: session.selection.selectionRevision, expectedAdmissionEpoch: session.admissionEpoch }, parent as unknown as DshAgent);
    await a.ctx.plugin(ApprovalService, { policy: "ask" }).await();
    let asksA = 0;
    a.ctx.on("approval/request", async () => { asksA++; return "allowed-once"; }, { global: true });
    const askBeforeStepA = a.ctx.on("agent/pre-step", async (frame, next) => {
      if (frame.agent === parent) {
        askBeforeStepA();
        const approved = await command(parent, "approval-a1");
        assert.equal(approved.isError, false, JSON.stringify(approved));
        assert.equal((await command(parent, "approval-a2")).isError, false);
      }
      return next();
    }, { global: true });
    await runFixtureTurn(parent);
    assert.equal(asksA, 1); assert.equal(shellBodies, 2);
    const child = await a.createAuxiliary("dsmm-code-search", undefined, "continuable", parent, { prompt: [{ type: "text", text: "Read the original durable task" }] });
    await runFixtureTurn(child);
    assert.equal(a.adapter.calls.find(call => call.sessionId === child.id)?.model, "old-role");
    const parentId = parent.id, childId = child.id;
    await runFixtureTurn(parent);
    const baselineRoot = await a.create({ agentPreset: "standard", cwd: profileDir });
    const baselineState = await runtime.getSession(baselineRoot as unknown as DshAgent);
    await runtime.selectSession({ sessionId: baselineRoot.id, id: null, expectedSelectionRevision: baselineState.selection.selectionRevision, expectedAdmissionEpoch: baselineState.admissionEpoch }, baselineRoot as unknown as DshAgent);
    const globalRoot = await a.create({ agentPreset: "standard", cwd: profileDir });
    await runFixtureTurn(baselineRoot); await runFixtureTurn(globalRoot);
    await a.releaseAuxiliary(child); await a.ctx.sessionPersistence.flush();
    await a.dispose(); a = undefined;
    const store = ProfileStore.fromCentral(home, profileDir, "include:permission-core");
    // The Host fixture uses the permission core's stable entry identity.
    const latest = await store.read("chosen");
    await store.save({ id: "chosen", expectedRevision: latest.revision, content: document("new-role") });
    const other = await store.save({ id: "other", expectedRevision: null, content: JSON.stringify({ version: 1, id: "other", settings: { defaultActive: true } }) });
    await store.select({ id: "other", expectedRevision: other.revision, expectedSelectionRevision: "absent" });
    unlinkSync(join(store.profileDir, ".revisions", `${chosen.selection.appliedRevision}.jsonc`));
    const adapter = new RoutingFixtureAdapter(); adapter.unavailableModels.add("old-role");
    let reads = 0, writes = 0, childRequests = 0;
    adapter.streamChunks = async function* (options) {
      if (options.sessionId === childId && childRequests++ === 0) {
        const id = ToolCallId("restored-role-read");
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield { type: "tool-call-delta", index: 0, id, name: "read", argumentsDelta: "{}" };
        yield { type: "block-end", index: 0, block: { type: "tool-call", id, name: "read", arguments: "{}" } };
        yield { type: "finish", reason: { kind: "tool-calls" } };
      } else {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "Restored code search task complete" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "Restored code search task complete" } };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    };
    b = await nativeRoutingFixture(config, { ...options, adapter, reopenProfile: true, fixtureTools: [
      shell,
      { name: "read", description: "Read the task-owned fixture", parameters: {}, output: { schema: { type: "string" }, render: value => [{ type: "text", text: String(value) }] }, async execute() { reads++; return "current code search evidence"; } },
      { name: "write", description: "Count forbidden writes", parameters: {}, output: { schema: { type: "string" }, render: () => [] }, async execute() { writes++; return "write"; } }
    ] });
    const errors: unknown[] = [];
    b.ctx.on("agent/error", ({ error }) => { errors.push(error); }, { global: true });
    const observation = await b.ctx.get("sessionQuery")!.observeSession(parentId);
    observation[Symbol.dispose]();
    const controller = b.ctx.get("sessionController") as SessionController;
    const result = await controller.resolveAgent(parentId);
    if ("error" in result) throw result.error;
    const resumedParent = result.agent;
    assert.notEqual(resumedParent, parent);
    for (const [id, scope, profileId] of [[baselineRoot.id, "deployment-baseline", null], [globalRoot.id, "global-default", "other"]] as const) {
      const restored = await controller.resolveAgent(id);
      if ("error" in restored) throw restored.error;
      const admission: DsmmProfileAdmission = b.ctx.dsmmNativeAdmission.assert(restored.agent);
      assert.equal(admission.scope, scope); assert.equal(admission.profile?.id ?? null, profileId);
    }
    await b.ctx.plugin(ApprovalService, { policy: "ask" }).await();
    let asksB = 0;
    b.ctx.on("approval/request", async () => { asksB++; return "rejected"; }, { global: true });
    const askBeforeStepB = b.ctx.on("agent/pre-step", async (frame, next) => {
      if (frame.agent === resumedParent) { askBeforeStepB(); assert.equal((await command(resumedParent, "approval-b")).isError, true); }
      return next();
    }, { global: true });
    await runFixtureTurn(resumedParent);
    assert.equal(asksB, 1); assert.equal(shellBodies, 2, "no old once/rule approval reaches the restored Agent");
    assert.equal((await (b.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime).getSession(resumedParent as unknown as DshAgent)).configuration?.named?.id, "chosen");
    assert.ok(resumedParent.ctx.tools.schemas(resumedParent).some(schema => schema.name === "dsmm_role"));
    assert.equal(b.agents.get(childId), undefined);
    const children = await b.subagents.listChildren(parentId, new AbortController().signal);
    assert.ok(children.some(row => row.id === childId));
    assert.equal(b.agents.get(childId), undefined, "listing does not activate a child");
    await b.subagents.sendMessage(resumedParent, childId, [{ type: "text", text: "Continue the original durable task" }], { signal: new AbortController().signal });
    const resumedChild = b.agents.get(childId)!;
    assert.ok(resumedChild); await resumedChild.whenIdle();
    assert.equal(b.agents.isOwnedBy(childId, resumedParent), true);
    assert.equal(b.ctx.dsmmNativeAdmission.invocation(resumedChild)?.target, "dsmm-code-search");
    assert.deepEqual(errors, []);
    assert.equal(adapter.calls.find(call => call.sessionId === childId)?.model, "new-role");
    assert.equal(adapter.calls.find(call => call.sessionId === childId)?.reasoningEffort, "max");
    const system = JSON.stringify(adapter.calls.find(call => call.sessionId === childId)!.messages.filter(message => message.role === "system"));
    assert.ok(system.includes(JSON.stringify(DSMM_ROLES.find(role => role.id === "dsmm-code-search")!.persona).slice(1, -1)), "the restored request delivers the current installed role resource");
    assert.equal(reads, 1);
    assert.match(JSON.stringify(resumedChild.session.snapshotEvents().filter(event => event.type === "assistant/message")), /Restored code search task complete/);
    const schemas = resumedChild.ctx.tools.schemas(resumedChild).map(schema => schema.name);
    assert.ok(schemas.includes("read")); assert.ok(!schemas.includes("write"));
    for (const name of ["write", "pwsh"]) assert.equal((await resumedChild.ctx.tools.execute({ agent: resumedChild, name, arguments: name === "pwsh" ? { command: "echo counted", description: "Readonly counter probe" } : {}, callId: ToolCallId(`readonly-${name}`), signal: new AbortController().signal })).isError, true);
    assert.equal(writes, 0);
    assert.ok(JSON.stringify(resumedChild.session.snapshotEvents()).includes("Read the original durable task"));
    await b.subagents.drainChildren(resumedParent, [childId]);
    await assert.rejects(b.ctx.dsmmNativeAdmission.guardExecution(resumedChild));
    const sibling = await b.createAuxiliary("dsmm-code-search", undefined, "continuable", resumedParent);
    await runFixtureTurn(sibling);
    const second = await store.read("chosen");
    await store.save({ id: "chosen", expectedRevision: second.revision, content: document("third-role") });
    await b.subagents.sendMessage(resumedParent, childId, [{ type: "text", text: "Reactivate with newest config" }], { signal: new AbortController().signal });
    const third = b.agents.get(childId)!; await third.whenIdle();
    assert.notEqual(third, resumedChild);
    assert.equal(adapter.calls.filter(call => call.sessionId === childId).at(-1)?.model, "third-role");
    await runFixtureTurn(sibling);
    assert.equal(adapter.calls.filter(call => call.sessionId === sibling.id).at(-1)?.model, "new-role", "resident sibling does not hot-switch");
    await b.subagents.drainChildren(resumedParent, [childId]);
    const thirdSaved = await store.read("chosen");
    await store.save({ id: "chosen", expectedRevision: thirdSaved.revision, content: JSON.stringify({ version: 1, id: "chosen", settings: { roles: { "dsmm-code-search": false } } }) });
    await assert.rejects(b.subagents.sendMessage(resumedParent, childId, [{ type: "text", text: "Disabled role" }], { signal: new AbortController().signal }), { code: "UNAUTHORIZED" });
    assert.equal(b.agents.get(childId), undefined);
    const disabled = await store.read("chosen");
    await store.save({ id: "chosen", expectedRevision: disabled.revision, content: document("third-role") });
    const deployment = b.ctx.get("dsmmDeploymentConfig")!;
    const global = await deployment.readGlobal();
    await deployment.saveGlobal({ expectedRevision: global.revision, edits: [{ op: "set", path: ["modules", "deepwork", "enabled"], value: false }] }, () => {});
    await assert.rejects(b.subagents.sendMessage(resumedParent, childId, [{ type: "text", text: "Disabled module" }], { signal: new AbortController().signal }), { code: "UNAUTHORIZED" });
    assert.equal(b.agents.get(childId), undefined);
    t.diagnostic(`original root ${parentId} and child ${childId}: old-role unavailable, new-role executed through DSMM owner`);
  } finally {
    await b?.dispose(); await a?.dispose(); rmSync(root, { recursive: true, force: true });
  }
});

test("startup and selection CAS use pointer identity without interpreting retired snapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsmm-resume-selection-"));
  const store = new ProfileStore(join(root, "dsmm-profiles"));
  try {
    const content = (active: boolean) => JSON.stringify({ version: 1, id: "selected", settings: { defaultActive: active } });
    const saved = await store.save({ id: "selected", content: content(false), expectedRevision: null });
    const selected = await store.select({ id: "selected", expectedRevision: saved.revision, expectedSelectionRevision: "absent" });
    const choice = await store.selectSession({ sessionId: "historical", id: "selected", expectedRevision: saved.revision, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "a".repeat(64) }, "b".repeat(64), () => {}, { assertCurrent() {}, committed() {} });
    const current = await store.save({ id: "selected", content: content(true), expectedRevision: saved.revision });
    for (const revision of [selected.selection.appliedRevision, choice.selection.appliedRevision]) unlinkSync(join(store.profileDir, ".revisions", `${revision}.jsonc`));
    const runtime = new ProfileRuntime({}, resolveConfig(), store);
    await runtime.initialize();
    assert.equal(runtime.getSettings().defaultActive, true);
    assert.equal(runtime.admission().profile?.revision, current.revision);
    writeFileSync(join(store.profileDir, "selected.jsonc"), "{ invalid latest content");
    await assert.rejects(new ProfileRuntime({}, resolveConfig(), store).initialize(), { code: "validation" });
    assert.equal(runtime.getSettings().defaultActive, true, "a resident admission does not reload a changed document");
    assert.equal((await store.loadSessionSelectionIdentity("historical")).selectedId, "selected");
    await assert.rejects(store.select({ id: null, expectedSelectionRevision: "absent" }), { code: "conflict" });
    await store.selectSession({ sessionId: "historical", id: null, expectedSelectionRevision: choice.selection.selectionRevision, expectedAdmissionEpoch: "b".repeat(64) }, "c".repeat(64), () => {}, { assertCurrent() {}, committed() {} });
    await store.select({ id: null, expectedSelectionRevision: selected.selection.selectionRevision });
    assert.equal((await store.loadSessionSelectionIdentity("historical")).selectedId, null);
    assert.equal((await store.loadSelectionIdentity()).selectedId, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("historical child identity reads ignore retired runtime fields but retain envelope and lineage validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsmm-resume-metadata-"));
  const store = new ProfileStore(join(root, "dsmm-profiles"));
  try {
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const directory = join(store.stateDir, ".children", "v1"); mkdirSync(directory, { recursive: true });
    const capture = { version: 1, childSessionId: "child", parentSessionId: "parent", role: "dsmm-code-search", profilePin: { id: "chosen", revision: "missing-retired-revision" },
      invocation: { level: "high", initialRoute: { retired: "not a current route" } }, runtimePolicyCapture: { retiredFields: true }, authorityCeiling: "not restored" };
    const path = join(directory, `${hash("child")}.json`);
    writeFileSync(path, JSON.stringify({ version: 1, revision: hash(JSON.stringify(capture)), capture }));
    assert.deepEqual(await store.readChildIdentity("child", "parent"), { childSessionId: "child", parentSessionId: "parent", role: "dsmm-code-search", profileId: "chosen", level: "high" });
    await assert.rejects(store.readChildIdentity("child", "foreign"), { code: "corrupt-selection" });
    await assert.rejects(store.readChildAdmission("child", "parent"), { code: "corrupt-selection" });
    writeFileSync(path, JSON.stringify({ version: 1, revision: "a".repeat(64), capture }));
    await assert.rejects(store.readChildIdentity("child", "parent"), { code: "corrupt-selection" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("DSMM owner recovery prepares the fallback once before final capture", async () => {
  const route = { primary: { provider: "fixture", model: "limited" }, fallbackRoutes: [{ provider: "fixture", model: "fallback" }], strategy: "rate-limit-fallback" as const,
    rateLimit: { initialDelayMs: 0, maxDelayMs: 0, maxTotalDelayMs: 0, maxRetries: 0, switchAfterRateLimits: 1, maxSwitches: 1 } };
  const f = await nativeRoutingFixture({ defaultActive: true, lsp: { enabled: false },
    roleRouting: { "dsmm-code-search": route, "dsmm-orchestrator": route }
  }, { dsmmLlm: true, nativePermissionSettings: true });
  try {
    f.adapter.rateLimitModels.add("limited");
    const child = await f.createAuxiliary("dsmm-code-search");
    await runFixtureTurn(child);
    assert.deepEqual(f.adapter.calls.filter(call => call.sessionId === child.id).map(call => call.model), ["limited", "fallback"]);
    assert.equal(child.session.snapshotEvents().filter(event => event.type === "turn/end").at(-1)?.data.reason.kind, "completed");
    const parent = await f.create(); await runFixtureTurn(parent);
    assert.deepEqual(f.adapter.calls.filter(call => call.sessionId === parent.id).map(call => call.model), ["native-default"]);
    assert.equal(parent.session.snapshotEvents().filter(event => event.type === "turn/end").at(-1)?.data.reason.kind, "completed");
  } finally { await f.dispose(); }
});

test("native independent child composition cold-resumes with current role policy and its own tool realm", async () => {
  let originalParent!: Agent, originalChild!: Agent;
  const f = await nativeRoutingFixture({ defaultActive: true, lsp: { enabled: false },
    roleRouting: { "dsmm-code-search": { primary: { provider: "fixture", model: "independent-current" } } }
  }, { controller: true, nativePermissionSettings: true,
    async beforeDsmm(ctx, create) {
      await ctx.agentPresets.register({ id: "dsmm-code-search", name: "Independent historical search", description: "Native own composition", plugins: [] });
      originalParent = await create({ agentPreset: "standard" });
      const run = await ctx.subagents.startActivation({ provider: "spawn", label: "Original independent task", delivery: "caller", signal: new AbortController().signal,
        request: { parent: originalParent, agentPreset: "dsmm-code-search", agentOptions: { provider: "fixture", model: "independent-old" }, prompt: [{ type: "text", text: "Preserve independent native task" }] } });
      originalChild = ctx.agents.get(run.childId)!;
      await originalChild.whenIdle(); await run.dispose(); await ctx.sessionPersistence.flush();
    }
  });
  try {
    await f.disposeAgent(originalParent); await f.ctx.sessionPersistence.flush();
    f.adapter.unavailableModels.add("independent-old");
    const result = await (f.ctx.get("sessionController") as SessionController).resolveAgent(originalParent.id);
    if ("error" in result) throw result.error;
    const parent = result.agent;
    await f.subagents.sendMessage(parent, originalChild.id, [{ type: "text", text: "Continue independent task" }], { signal: new AbortController().signal });
    const child = f.agents.get(originalChild.id)!; await child.whenIdle();
    assert.equal(f.ctx.dsmmNativeAdmission.invocation(child)?.target, "dsmm-code-search");
    assert.notEqual(scopeParentOf(child), scopeParentOf(parent));
    assert.equal(child.ctx.get("agentPresets")!.composedPreset(child.ctx), "dsmm-code-search");
    assert.equal(f.adapter.calls.filter(call => call.sessionId === child.id).at(-1)?.model, "independent-current");
    assert.equal((await child.ctx.tools.execute({ agent: child, name: "write", arguments: {}, callId: ToolCallId("independent-denied"), signal: new AbortController().signal })).isError, true);
    await f.subagents.drainChildren(parent, [child.id]);
  } finally { await f.dispose(); }
});

test("a native fork root ignores inherited child descriptors but rejects its own orphan identity", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true });
  try {
    const child = await f.createAuxiliary("dsmm-code-search", undefined, "continuable");
    await runFixtureTurn(child);
    const events = child.session.snapshotEvents();
    const fork = await f.create({ agentPreset: "standard", parentSession: child.id, isSeeded: true }, undefined, { seed: events, inheritedEventCount: SessionLogOffset(events.length) });
    assert.equal(f.ctx.dsmmNativeAdmission.owns(fork), true);
    assert.equal(f.ctx.dsmmNativeAdmission.invocation(fork), undefined);
    await runFixtureTurn(fork);
    assert.ok(f.adapter.calls.some(call => call.sessionId === fork.id));
    await assert.rejects(f.create({ origin: "subagent" }, undefined, { seed: events }), { code: "UNAUTHORIZED" });
  } finally { await f.dispose(); }
});

test("cancelled cold admission rolls back and cannot authorize a retained object when its ID is restored", async t => {
  const f = await nativeRoutingFixture({ defaultActive: true, lsp: { enabled: false } }, { dsmmLlm: true, nativePermissionSettings: true });
  try {
    const parent = await f.create();
    const child = await f.createAuxiliary("dsmm-code-search", undefined, "continuable", parent);
    await runFixtureTurn(child); await f.releaseAuxiliary(child); await f.ctx.sessionPersistence.flush();
    const runtime = f.ctx.dsmmNativeAdmission.profiles;
    const original = runtime.prepareChild.bind(runtime);
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const release = new Promise<void>(resolve => { finish = resolve; });
    let rejectedAgent: DshAgent | undefined;
    const mock = t.mock.method(runtime, "prepareChild", async (...args: Parameters<typeof original>) => {
      rejectedAgent = args[0]; enter(); await release; return original(...args);
    });
    const abort = new AbortController(), calls = f.adapter.calls.length;
    const pending = f.subagents.sendMessage(parent, child.id, [{ type: "text", text: "Cancelled activation" }], { signal: abort.signal });
    const rejection = assert.rejects(pending);
    await entered; abort.abort(); finish(); await rejection; mock.mock.restore();
    assert.ok(rejectedAgent);
    assert.equal(f.agents.get(child.id), undefined); assert.equal(f.adapter.calls.length, calls);
    await assert.rejects(f.ctx.dsmmNativeAdmission.guardExecution(rejectedAgent as Agent));
    await f.subagents.sendMessage(parent, child.id, [{ type: "text", text: "Valid activation" }], { signal: new AbortController().signal });
    const recovered = f.agents.get(child.id)!; await recovered.whenIdle();
    assert.notEqual(recovered, rejectedAgent); assert.ok(f.ctx.dsmmNativeAdmission.get(recovered));
    await assert.rejects(f.ctx.dsmmNativeAdmission.guardExecution(rejectedAgent as Agent));
    await f.subagents.drainChildren(parent, [child.id]);
  } finally { await f.dispose(); }
});

test("cold child depth remains bounded by its resident parent's admitted ceiling for subsequent delegation", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, lsp: { enabled: false } }, { dsmmLlm: true, nativePermissionSettings: true });
  try {
    const deployment = f.ctx.get("dsmmDeploymentConfig")!;
    const setDepth = async (value: number) => {
      const current = await deployment.readGlobal();
      await deployment.saveGlobal({ expectedRevision: current.revision, edits: [{ op: "set", path: ["subagents", "maxDepth"], value }] }, () => {});
    };
    await setDepth(1);
    const parent = await f.create();
    const child = await f.createAuxiliary("dsmm-coding", undefined, "continuable", parent);
    await runFixtureTurn(child);
    await setDepth(3);
    const resumed = await f.resumeAuxiliary(child); await runFixtureTurn(resumed);
    await assert.rejects(f.createAuxiliary("dsmm-quick", undefined, "continuable", resumed));
    assert.equal(f.ctx.dsmmNativeAdmission.assert(resumed).settings.subagents.maxDepth, 1);
  } finally { await f.dispose(); }
});

for (const unavailable of [false, true]) test(`cold child retains its own accepted native selection with configured primary unavailable=${unavailable}`, async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, lsp: { enabled: false },
    roleRouting: { "dsmm-code-search": { primary: { provider: "fixture", model: "configured", reasoningEffort: "max" } } }
  }, { dsmmLlm: true, nativePermissionSettings: true });
  try {
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined };
    const child = await f.createAuxiliary("dsmm-code-search", selection, "continuable");
    await runFixtureTurn(child);
    const route = { provider: "fixture", model: "manual-current", reasoningEffort: ReasoningEffortId("low") };
    await child.ctx.llm.resolveCallConfig(route);
    child.session.append("model/selection", route); selection.current = route;
    await runFixtureTurn(child);
    assert.equal(f.adapter.calls.at(-1)?.model, "manual-current");
    if (unavailable) f.adapter.unavailableModels.add("configured");
    const resumed = await f.resumeAuxiliary(child); await runFixtureTurn(resumed);
    assert.deepEqual(f.adapter.calls.filter(call => call.sessionId === child.id).map(call => [call.model, call.reasoningEffort]), [
      ["configured", "max"], ["manual-current", "low"], ["manual-current", "low"]
    ]);
    assert.equal(resumed.session.snapshotEvents().filter(event => event.type === "turn/end").at(-1)?.data.reason.kind, "completed");
  } finally { await f.dispose(); }
});

test("mode-off native root keeps native effort with dormant DSMM primary and passthrough disabled", async () => {
  const f = await nativeRoutingFixture({ defaultActive: false, modelParameters: { passthrough: false }, lsp: { enabled: false },
    roleRouting: { "dsmm-orchestrator": { primary: { provider: "fixture", model: "dormant", reasoningEffort: "max" } } }
  }, { dsmmLlm: true, nativePermissionSettings: true });
  try {
    const parent = await f.create({}, undefined, { agentOptions: { provider: "fixture", model: "native-default", reasoningEffort: ReasoningEffortId("low") } });
    await runFixtureTurn(parent);
    assert.deepEqual(f.adapter.calls.map(call => [call.model, call.reasoningEffort]), [["native-default", "low"]]);
  } finally { await f.dispose(); }
});
