import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import { Peer } from "@deepseek-ai/dsh-client-connection";
import { JobRegistry } from "@deepseek-ai/dsh-jobs";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { createUserMessage, ToolCallId } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor } from "@deepseek-ai/dsh-subagent";
import { remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import type { DshAgent as PackageDshAgent } from "../lib/dsh-types.js";
import type { GlobalConfigSnapshot } from "../lib/deployment-config.js";
import type { DsmmProfileRuntime } from "../lib/profile-runtime.js";
import type { DsmmModuleState } from "../lib/modules.js";
import type { DeploymentEditorSnapshot } from "../lib/profile-types.js";
import { at } from "../lib/client/deployment-data.js";
import { DSMM_ROLE_IDS } from "../lib/roles.js";
import { classifyDsmmAgent } from "../lib/runtime-integration.js";
import { appendModeRecord } from "../src/session-metadata.ts";
import { sessionEvents } from "../src/session-scope.ts";
import { nativeFixturePlugin, nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

type DshAgent = Omit<PackageDshAgent, "ctx">;

function refused(code: string) {
  return (error: unknown) => {
    const remote = remoteErrorOf(error);
    return remote?.code === "dsmm-profiles/refused" && remote.details.code === code;
  };
}

test("real Loader module admission preserves busy captures, fences off work, and mounts only after an independent restart", { timeout: 25_000 }, async (t) => {
  let peer!: Peer;
  const carrier = { host: "127.0.0.1" }, authority = { writable: true, describe: () => [] };
  const beforeDsmm = async (ctx: Context) => {
    const { RemoteAccessService } = await nativeFixturePlugin("@deepseek-ai/dsh-api-remote-access");
    await ctx.plugin(RemoteAccessService).await();
    await Promise.all([ctx.plugin(TypertRegistry).await(), ctx.plugin(TypertGatewayService, {}).await()]);
    // Public native Peer and exact browser identity, without credentials or an HTTP server.
    const ownedPeer = new Peer(ctx, { principal: { kind: "owner" } });
    peer = ownedPeer;
    ctx.provide("connection", { browserPeer: ownedPeer });
    ctx.provide("webServer", carrier); ctx.provide("settings", authority);
    ctx.effect(() => () => ownedPeer.dispose());
    const denied = async (): Promise<never> => { throw new Error("module fixture forbids filesystem/network/process operations"); };
    ctx.provide("web", { search: denied, fetch: denied });
    if (ctx.get("fs") === undefined) ctx.provide("fs", { readFile: denied, writeFile: denied, edit: denied, stat: denied });
    ctx.provide("subprocess", { spawn: denied }); ctx.provide("shell", { execute: denied });
    ctx.provide("shellEnv", { resolve: denied });
    class InertJobs extends JobRegistry {
      events = { subscribe: () => () => {} };
      start(): never { throw new Error("Module fixture forbids background work"); }
      list() { return []; }
      get(): never { throw new Error("No fixture job"); }
      read(): never { throw new Error("No fixture job"); }
      readAt(): never { throw new Error("No fixture job"); }
      wait(): never { throw new Error("No fixture job"); }
      kill(): never { throw new Error("No fixture job"); }
      remove(): never { throw new Error("No fixture job"); }
      attachController() { return () => {}; }
    }
    await ctx.plugin(InertJobs).await();
  };
  const config = { defaultActive: true, roleRouting: { "dsmm-coding": { primary: { provider: "fixture", model: "owned-child" } } },
    runtimeRecovery: { enabled: true, idleContinuation: { enabled: true } } };
  const mounted = await nativeRoutingFixture(config, { nativePresets: true, beforeDsmm });
  const fixtures = [mounted];
  let release!: () => void;
  try {
    const runtime = mounted.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    const invoke = <T>(method: string, args: Record<string, unknown> = {}) => mounted.ctx.typertGateway.invoke({ namespace: "dsmmConfig", method, args, peer }) as Promise<T>;
    const absent = await invoke<GlobalConfigSnapshot>("describe");
    assert.equal(absent.revision, "absent");
    const moduleStates = await invoke<DsmmModuleState[]>("describeModules");
    assert.equal(moduleStates[0].desired.source, "defaults");
    assert.deepEqual(moduleStates.map(module => module.descriptor.id), ["deepwork", "permission-control"]);
    const editor = await invoke<DeploymentEditorSnapshot>("describeSettings");
    assert.deepEqual(editor.modules, moduleStates);
    const deployment = mounted.ctx.get("dsmmDeploymentConfig");
    assert.ok(deployment);
    const entry = await deployment.readDesired();
    assert.equal(editor.entryId, entry.entryId);assert.equal(editor.namespace, entry.nativeNamespace);
    assert.equal(editor.globalRevision, "absent");assert.equal(editor.schema.fields?.modules.type, "object");
    assert.equal(editor.schema.fields?.sessionPersistence, undefined);
    assert.deepEqual(editor.schema.fields?.roleRouting.keys, [...DSMM_ROLE_IDS]);
    const routeFields = editor.schema.fields?.roleRouting.inner?.fields;
    assert.equal(routeFields?.primary.alternatives?.[1]?.fields?.model.nonempty, true);
    assert.equal(routeFields?.fallbackRoutes.alternatives?.[1]?.max, 32);
    const retrySchema = editor.schema.fields?.runtimePolicy.fields?.rateLimit.fields?.maxRetries;
    assert.equal(retrySchema?.min, 0); assert.equal(retrySchema?.max, 10); assert.equal(retrySchema?.step, 1);
    assert.equal(at(editor.nextRoot?.settings, ["modules", "deepwork", "enabled"]), true);
    assert.equal((await mounted.ctx.agentPresets.resolve("dsmm-orchestrator")).broken, undefined);
    const parent = await mounted.create(), captured = runtime.admission(parent as DshAgent);
    assert.equal(captured.settings.modules.deepwork.enabled, true);
    let entered!: () => void;
    const started = new Promise<void>((done) => { entered = done; });
    const waiting = new Promise<void>((done) => { release = done; });
    let busySignal: AbortSignal | undefined;
    mounted.adapter.beforeStream = async (options) => {
      if (options.model !== "native-default") return;
      busySignal = options.signal; entered(); await waiting;
    };
    t.signal.addEventListener("abort", release, { once: true });
    let updates = 0, disposals = 0;
    mounted.ctx.on("internal/update", function (_config, _noSave, next) { if (this === mounted.dsmmFiber) updates++; next(); });
    mounted.dsmmFiber.ctx.effect(() => () => { disposals++; });
    parent.followup(createUserMessage({ content: [{ type: "text", text: "Busy native parent during global module save" }], source: { kind: "user" } }));
    await started;
    let offGlobal = await invoke<GlobalConfigSnapshot>("save", { request: { expectedRevision: absent.revision, edits: [{ op: "set", path: ["modules", "deepwork", "enabled"], value: false }] } });
    assert.equal(parent.status, "running"); assert.equal(busySignal!.aborted, false);
    assert.equal(runtime.admission(parent as DshAgent), captured);
    const childAgent = await mounted.createAuxiliary("dsmm-coding", undefined, "one-shot", parent);
    const childAdmission = runtime.admission(childAgent as DshAgent);
    const childInvocation = mounted.ctx.dsmmNativeAdmission.invocation(childAgent)!;
    assert.ok(childInvocation);
    assert.notEqual(childAdmission, captured);
    const inheritedSettings = captured.settings;
    assert.deepEqual(childAdmission.settings, inheritedSettings);
    assert.deepEqual(childAdmission.profile, captured.profile);
    assert.equal(childAdmission.epoch, captured.epoch);
    assert.equal(childInvocation.target, "dsmm-coding");
    assert.equal(childInvocation.effectiveLevel, "normal");
    assert.equal(childInvocation.routeSource, "primary");
    assert.equal(childInvocation.initialRoute.provider, "fixture");
    assert.equal(childInvocation.initialRoute.model, "owned-child");
    assert.equal(mounted.agents.isOwnedBy(childAgent.id, parent), true);
    assert.equal(Reflect.set(childAdmission.settings.modules.deepwork, "enabled", false), false);
    assert.equal(Reflect.set(childInvocation, "target", "dsmm-reviewer"), false);
    assert.equal(childAdmission.settings.modules.deepwork.enabled, true);
    assert.equal(childAdmission.epoch, captured.epoch);
    await t.test("global save preserves exact live root and immutable owned child captures", async () => {
      const previousRevision = offGlobal.revision;
      offGlobal = await invoke<GlobalConfigSnapshot>("save", { request: { expectedRevision: previousRevision,
        edits: [{ op: "set", path: ["workflow", "reviewCap"], value: 3 }] } });
      assert.notEqual(offGlobal.revision, previousRevision);
      assert.equal(parent.status, "running"); assert.equal(busySignal!.aborted, false);
      assert.equal(runtime.admission(parent as DshAgent), captured);
      assert.equal(runtime.admission(childAgent as DshAgent), childAdmission);
      assert.deepEqual(childAdmission.settings, inheritedSettings);
      assert.equal(mounted.ctx.dsmmNativeAdmission.invocation(childAgent), childInvocation);
      assert.equal(mounted.agents.isOwnedBy(childAgent.id, parent), true);
    });
    release(); await parent.whenIdle(); mounted.adapter.beforeStream = undefined;
    assert.equal(updates, 0); assert.equal(disposals, 0);
    assert.match(JSON.stringify(mounted.adapter.calls[0].messages), /DEEPWORK MODE ENABLED!/u);

    const off = await mounted.create(), offCapture = runtime.admission(off as DshAgent);
    assert.equal(mounted.agents.isOwnedBy(childAgent.id, off), false);
    assert.equal(offCapture.settings.modules.deepwork.enabled, false);
    assert.equal(offCapture.settings.workflow.reviewCap, 3);
    assert.equal((await runtime.getSession(off as DshAgent)).deepwork!.active, false);
    assert.deepEqual(await mounted.ctx.skills.list({ scope: off }), []);
    assert.equal(off.ctx.tools.get("dsmm_coding", off), undefined);
    const beforeDenied = mounted.adapter.calls.length;
    await assert.rejects(mounted.subagents.startActivation({ provider: "dsmm-role-coding", label: "Disabled module", delivery: "caller", signal: new AbortController().signal,
       request: { parent: off, prompt: [] } }), { code: "UNAUTHORIZED" });
    const deniedTool = await off.ctx.tools.execute({ agent: off, name: "dsmm_coding", arguments: { description: "Off", prompt: "Must not dispatch" }, callId: ToolCallId("module-off-alias"), signal: new AbortController().signal });
    assert.equal(deniedTool.isError, true);
    const offSnapshot = await runtime.getSession(off as DshAgent);
    await assert.rejects(runtime.selectMode({ sessionId: off.id, active: true, expectedModeRevision: offSnapshot.deepwork!.revision, expectedAdmissionEpoch: offSnapshot.admissionEpoch }, off as DshAgent), { code: "unavailable" });
    // Historical mode intent remains recorded but is not effective authority.
    appendModeRecord(off.session, true);
    await t.test("native mode-off replaces dormant persisted on intent under admission CAS", async () => {
      const before = await runtime.getSession(off as DshAgent);
      const selected = await runtime.selectMode({ sessionId: off.id, active: false, expectedModeRevision: before.deepwork!.revision, expectedAdmissionEpoch: before.admissionEpoch }, off as DshAgent);
      assert.notEqual(selected.deepwork!.revision, before.deepwork!.revision);
      assert.deepEqual(sessionEvents(off.session).filter((event) => event.type === "deepwork/mode").at(-1)!.data, { active: false });
      const count = off.session.snapshotEvents().length;
      await runtime.selectMode({ sessionId: off.id, active: false, expectedModeRevision: selected.deepwork!.revision, expectedAdmissionEpoch: selected.admissionEpoch }, off as DshAgent);
      assert.equal(off.session.snapshotEvents().length, count);
      await assert.rejects(runtime.selectMode({ sessionId: off.id, active: false, expectedModeRevision: before.deepwork!.revision, expectedAdmissionEpoch: before.admissionEpoch }, off as DshAgent), /changed/u);
    });
    await runFixtureTurn(off);
    assert.equal(mounted.adapter.calls.length, beforeDenied + 1, "off ordinary root still uses the native main model exactly once");
    assert.doesNotMatch(JSON.stringify(mounted.adapter.calls.at(-1)!.messages), /DEEPWORK MODE ENABLED!|ROLE_PERSONA_SENTINEL/u);
    let standingBody = 0, standingRequest = 0;
    mounted.ctx.on("system-prompt/assemble", async (_assembly, _options, next) => { standingBody++; return next(); });
    mounted.ctx.on("agent/request", async (_frame, next) => { standingRequest++; return next(); });
    // Delegation roles are not registered presets; forcing one as a root is
    // refused by the registry before admission runs.
    await assert.rejects(mounted.create({ agentPreset: "dsmm-planner" }), { code: "agent-preset/not-found" });
    await mounted.ctx.agentPresets.register({ id: "dsmm-fake", name: "Invalid root", description: "Native picker residue", plugins: [] });
    await assert.rejects(mounted.create({ agentPreset: "dsmm-fake" }), { code: "activation" });
    const resume = Session.create(SessionId("module-off-child-resume"));
    resume.append("subagent/descriptor", snapshotSubagentDescriptor({ mode: "continuable", provider: "dsmm-role-coding", label: "Captured DW child" }));
    await assert.rejects(mounted.create({ origin: "subagent" }, undefined, { seed: JSON.parse(JSON.stringify(resume.snapshotEvents())) }), { code: "UNAUTHORIZED" });
    assert.equal(standingBody, 0); assert.equal(standingRequest, 0);
    assert.equal(mounted.adapter.calls.length, beforeDenied + 1);

    const overlay = await runtime.save({ id: "module-overlay", expectedRevision: null, content: '{"version":1,"id":"module-overlay","settings":{"workflow":{"reviewCap":2}}}' });
    const parentSession = await runtime.getSession(parent as DshAgent);
    await assert.rejects(runtime.selectSession({ sessionId: parent.id, id: overlay.id, expectedRevision: overlay.revision, expectedSelectionRevision: parentSession.selection.selectionRevision, expectedAdmissionEpoch: parentSession.admissionEpoch }, parent as DshAgent), { code: "unavailable" });
    await runtime.select({ id: overlay.id, expectedRevision: overlay.revision, expectedSelectionRevision: (await runtime.describe()).selectionRevision });
    assert.equal(runtime.getSettings(parent as DshAgent).modules.deepwork.enabled, true);
    assert.equal(runtime.getSettings(parent as DshAgent).workflow.reviewCap, captured.settings.workflow.reviewCap);
    const fixedParent = runtime.admission(parent as DshAgent);
    assert.equal(fixedParent, captured);
    assert.equal(runtime.admission(childAgent as DshAgent), childAdmission);
    assert.equal(childAdmission.settings.workflow.reviewCap, captured.settings.workflow.reviewCap);
    assert.deepEqual(childAdmission.profile, captured.profile);
    const pinnedAgent = await mounted.createAuxiliary("dsmm-coding", undefined, "one-shot", parent);
    const pinnedAdmission = runtime.admission(pinnedAgent as DshAgent);
    assert.deepEqual(pinnedAdmission.profile, fixedParent.profile);
    assert.equal(pinnedAdmission.epoch, fixedParent.epoch);
    assert.deepEqual(pinnedAdmission.settings, fixedParent.settings);
    await t.test("future overlay selection preserves existing parent and every new delegation's fixed snapshot", async () => {
      assert.equal(runtime.admission(childAgent as DshAgent), childAdmission);
      assert.deepEqual(childAdmission.profile, captured.profile);
      assert.equal(childAdmission.epoch, captured.epoch);
      assert.equal(mounted.ctx.dsmmNativeAdmission.get(pinnedAgent), pinnedAdmission);
      assert.equal(mounted.agents.isOwnedBy(pinnedAgent.id, parent), true);
      assert.equal(mounted.agents.isOwnedBy(pinnedAgent.id, off), false);
      assert.equal(pinnedAdmission.settings.workflow.reviewCap, captured.settings.workflow.reviewCap);
    });
    const originalBytes = readFileSync(join(mounted.home, "plugins", "dsmm", "config.json"));
    await assert.rejects(invoke("save", { request: { expectedRevision: "absent", edits: [{ op: "unset", path: ["modules", "deepwork", "enabled"] }] } }), refused("conflict"));
    assert.deepEqual(readFileSync(join(mounted.home, "plugins", "dsmm", "config.json")), originalBytes);

    // Same first-party bundle installed, but DW substrate never mounts on this Host.
    let foreignProvider: ReturnType<typeof mounted.subagents.getProvider>;
    let gitBodies = 0, readBodies = 0;
    const cold = await nativeRoutingFixture({ ...config, guards: { scope: "always", gitWriteGuard: "deny" }, presets: { materialize: true }, lsp: { enabled: true, command: "module-off-must-not-spawn" } }, {
      nativePresets: true, home: mounted.home, profileDir: mounted.profileDir,
      async beforeDsmm(ctx) {
        await beforeDsmm(ctx);
        const spawn = ctx.subagents.getProvider("spawn")!;
        ctx.subagents.registerProvider({ name: "dsmm-role-coding", capabilities: spawn.capabilities, inheritsParentContext: false, prepareContinuable: (request) => spawn.prepareContinuable!(request) });
        foreignProvider = ctx.subagents.getProvider("dsmm-role-coding");
        ctx.tools.register({ name: "dsmm_coding", description: "Foreign native tool", parameters: {}, output: { schema: { type: "string" }, render: () => [{ type: "text", text: "FOREIGN_NATIVE_TOOL" }] }, async execute() { return "FOREIGN_NATIVE_TOOL"; } });
        await ctx.agentPresets.register({ id: "dsmm-planner", name: "Legacy standing", description: "Static residue", plugins: [{ name: "cordis:parity-persona", config: { prefix: "ROLE_PERSONA_SENTINEL" } }] });
      }
    });
    fixtures.push(cold);
    const coldRuntime = cold.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    const coldDeployment = cold.ctx.get("dsmmDeploymentConfig");
    assert.ok(coldDeployment);
    const coldInvoke = <T>(method: string, args: Record<string, unknown> = {}) => cold.ctx.typertGateway.invoke({ namespace: "dsmmConfig", method, args, peer }) as Promise<T>;
    const module = (await coldInvoke<DsmmModuleState[]>("describeModules"))[0];
    assert.equal(module.startupMounted, false); assert.equal(module.desired.enabled, false); assert.equal(module.hostBundleEnabled, "unknown");
    const coldEditor = await coldInvoke<DeploymentEditorSnapshot>("describeSettings");
    assert.equal(at(coldEditor.startup, ["modules", "deepwork", "enabled"]), false);
    assert.equal(at(coldEditor.nextRoot?.settings, ["modules", "deepwork", "enabled"]), false);
    assert.equal(coldEditor.modules[0].hostBundleEnabled, "unknown");
    assert.equal(cold.ctx.get("mcp"), undefined);
    assert.equal(cold.subagents.getProvider("dsmm-role-coding"), foreignProvider);
    assert.equal(DSMM_ROLE_IDS.filter((role) => cold.subagents.getProvider(`dsmm-role-${role.slice(5)}`) !== undefined).length, 1, "zero DSMM providers; only the preexisting foreign provider survives");
    assert.equal((await cold.ctx.agentPresets.list()).filter((preset) => preset.id.startsWith("dsmm-")).length, 1, "zero DSMM standing registrations; static legacy picker entry remains");
    const desiredCold = await coldDeployment.readDesired();
    assert.equal(existsSync(desiredCold.profile.presets!.root!), false, "cold-off does not materialize DW assets");
    const coldRoot = await cold.create();
    assert.deepEqual(await cold.ctx.skills.list({ scope: coldRoot }), []);
    const foreignTool = await coldRoot.ctx.tools.execute({ agent: coldRoot, name: "dsmm_coding", arguments: {}, callId: ToolCallId("foreign-module-off"), signal: new AbortController().signal });
    assert.notEqual(foreignTool.isError, true); assert.match(JSON.stringify(foreignTool.content), /FOREIGN_NATIVE_TOOL/u);
    const foreignChild = await cold.subagents.startActivation({ provider: "dsmm-role-coding", label: "Foreign native read", delivery: "caller", signal: new AbortController().signal,
      request: { parent: coldRoot, prompt: [] } });
    const foreignAgent = cold.agents.get(foreignChild.childId)!;
    assert.ok(foreignAgent);
    try {
      assert.equal(classifyDsmmAgent(foreignAgent), "native");
      assert.equal(coldRuntime.hasAdmission(foreignAgent as DshAgent), true);
      await t.test("cold-off real native foreign child performs useful read through the native loop", async () => {
        foreignAgent.ctx.tools.register({ name: "read", description: "Public native read stub; no filesystem access", parameters: {}, output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] }, async execute() { readBodies++; return "FOREIGN_CHILD_READ_PROOF"; } });
        let turns = 0;
        cold.adapter.streamChunks = async function* (options): AsyncGenerator<StreamChunk> {
          if (turns++ === 0) {
            const id = ToolCallId("foreign-child-read");
            yield { type: "block-start", index: 0, blockType: "tool-call" };
            yield { type: "tool-call-delta", index: 0, id, name: "read", argumentsDelta: "{}" };
            yield { type: "block-end", index: 0, block: { type: "tool-call", id, name: "read", arguments: "{}" } };
            yield { type: "finish", reason: { kind: "tool-calls" } };
          } else {
            assert.match(JSON.stringify(options.messages), /FOREIGN_CHILD_READ_PROOF/u);
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "text-delta", index: 0, text: "Useful native foreign child read returned" };
            yield { type: "block-end", index: 0, block: { type: "text", text: "Useful native foreign child read returned" } };
            yield { type: "finish", reason: { kind: "stop" } };
          }
        };
        try {
          await cold.subagents.sendMessage(coldRoot, foreignAgent.id, [{ type: "text", text: "Read the task-owned fixture value" }], { signal: t.signal });
          assert.equal((await foreignChild.result).stopReason, "completed");
          const result = foreignAgent.session.snapshotEvents().filter((event) => event.type === "tool/result").at(-1);
          t.diagnostic(`foreign child read bodies=${readBodies}; native tool/result=${JSON.stringify(result)}`);
          assert.equal(readBodies, 1);
          assert.match(JSON.stringify(result), /FOREIGN_CHILD_READ_PROOF/u);
          assert.equal(turns, 2);
        } finally { cold.adapter.streamChunks = undefined; }
      });
    }
    finally { await foreignChild.dispose(); }
    await t.test("cold-off always-scoped Git deny prevents the real native tool body", async () => {
      coldRoot.ctx.tools.register({ name: "pwsh", description: "Counter-only shell; no execution", parameters: {}, output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] }, async execute() { gitBodies++; return "NO_SHELL_EXECUTION"; } });
      const execute = (command: string, id: string) => coldRoot.ctx.tools.execute({ agent: coldRoot, name: "pwsh", arguments: { command }, callId: ToolCallId(id), signal: new AbortController().signal });
      assert.notEqual((await execute("git status", "cold-git-read")).isError, true);
      assert.equal(gitBodies, 1, "the harmless counter-only tool is actually usable");
      const denied = await execute("git push", "cold-git-write-denied");
      t.diagnostic(`cold-off git push isError=${denied.isError}; counter-only shell bodies=${gitBodies}`);
      assert.equal(denied.isError, true);
      assert.match(JSON.stringify(denied), /git write command is disabled/u);
      assert.equal(gitBodies, 1, "git push never reaches the shell stub body");
    });
    let coldBody = 0, coldRequest = 0;
    cold.ctx.on("system-prompt/assemble", async (_assembly, _options, next) => { coldBody++; return next(); });
    cold.ctx.on("agent/request", async (_frame, next) => { coldRequest++; return next(); });
    const calls = cold.adapter.calls.length;
    await assert.rejects(cold.create({ agentPreset: "dsmm-planner" }), { code: "activation" });
    assert.equal(coldBody, 0); assert.equal(coldRequest, 0); assert.equal(cold.adapter.calls.length, calls);
    let coldUpdates = 0, coldDisposals = 0;
    cold.ctx.on("internal/update", function (_config, _noSave, next) { if (this === cold.dsmmFiber) coldUpdates++; next(); });
    cold.dsmmFiber.ctx.effect(() => () => { coldDisposals++; });
    const coldRevision = await coldInvoke<GlobalConfigSnapshot>("describe");
    assert.equal(coldRevision.revision, offGlobal.revision);
    const impostor = new Peer(cold.ctx, { principal: { kind: "owner" } });
    try { for (const method of ["describeModules", "describeSettings"]) await assert.rejects(cold.ctx.typertGateway.invoke({ namespace: "dsmmConfig", method, args: {}, peer: impostor }), refused("not-owned")); }
    finally { await impostor.dispose(); }
    authority.writable = false;
    await assert.rejects(coldInvoke("describe"), refused("not-owned"));
    await assert.rejects(coldInvoke("describeSettings"), refused("not-owned"));
    authority.writable = true;
    carrier.host = "0.0.0.0";await assert.rejects(coldInvoke("describeSettings"), refused("not-owned"));carrier.host = "127.0.0.1";
    const restored = await coldInvoke<GlobalConfigSnapshot>("save", { request: { expectedRevision: coldRevision.revision, edits: [{ op: "unset", path: ["modules", "deepwork", "enabled"] }] } });
    assert.equal(restored.config.modules?.deepwork?.enabled, undefined);
    const pending = (await coldInvoke<DsmmModuleState[]>("describeModules"))[0];
    assert.equal(pending.desired.enabled, true); assert.equal(pending.desired.source, "defaults"); assert.equal(pending.pending, true);
    assert.equal(pending.startupMounted, false); assert.equal(pending.nextRoot.admitted, false); assert.equal(pending.reason, "restart-required");
    const pendingRoot = await cold.create(), pendingCapture = coldRuntime.admission(pendingRoot as DshAgent);
    assert.equal(pendingCapture.settings.modules.deepwork.enabled, false); assert.ok(pendingCapture.restartRequired!.includes("modules.deepwork.enabled"));
    const pendingEditor = await coldInvoke<DeploymentEditorSnapshot>("describeSettings");
    assert.equal(at(pendingEditor.desired, ["modules", "deepwork", "enabled"]), true);
    assert.equal(at(pendingEditor.nextRoot?.settings, ["modules", "deepwork", "enabled"]), false);
    assert.ok(pendingEditor.nextRoot?.restartRequired.includes("modules.deepwork.enabled"));
    const admitted = await coldRuntime.getSession(pendingRoot as DshAgent);
    assert.equal(at(admitted.configuration?.settings, ["modules", "deepwork", "enabled"]), false);
    await runFixtureTurn(pendingRoot);
    assert.doesNotMatch(JSON.stringify(cold.adapter.calls.at(-1)!.messages), /DEEPWORK MODE ENABLED!|ROLE_PERSONA_SENTINEL/u);
    assert.equal(cold.ctx.get("mcp"), undefined); assert.equal(existsSync(desiredCold.profile.presets!.root!), false);
    assert.equal(coldUpdates, 0); assert.equal(coldDisposals, 0);

    const restoredRoot = await mounted.create();
    assert.equal(runtime.getSettings(restoredRoot as DshAgent).modules.deepwork.enabled, true);
    assert.equal(runtime.admission(off as DshAgent), offCapture, "global restore never rebinds an old root");
    assert.equal(runtime.admission(parent as DshAgent), fixedParent);
    assert.equal(runtime.admission(childAgent as DshAgent), childAdmission);
    assert.equal(runtime.admission(pinnedAgent as DshAgent), pinnedAdmission);
    assert.equal(childAdmission.epoch, captured.epoch);
    assert.deepEqual(pinnedAdmission.profile, fixedParent.profile);
    const offNow = await runtime.getSession(off as DshAgent);
    await assert.rejects(runtime.selectSession({ sessionId: off.id, id: overlay.id, expectedRevision: overlay.revision, expectedSelectionRevision: offNow.selection.selectionRevision, expectedAdmissionEpoch: offNow.admissionEpoch }, off as DshAgent), { code: "unavailable" });
    assert.equal(runtime.getSettings(off as DshAgent).modules.deepwork.enabled, false, "idle overlay does not pull a newer master state");
    assert.equal((await runtime.getSession(off as DshAgent)).deepwork!.active, false);
    const restarted = await nativeRoutingFixture(config, { nativePresets: true, home: mounted.home, profileDir: mounted.profileDir, beforeDsmm });
    fixtures.push(restarted);
    const first = await restarted.create();
    assert.equal((restarted.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime).getSettings(first as DshAgent).modules.deepwork.enabled, true);
    await runFixtureTurn(first);
    assert.match(JSON.stringify(restarted.adapter.calls.at(-1)!.messages), /DEEPWORK MODE ENABLED!/u);
    assert.ok(restarted.subagents.getProvider("dsmm-role-coding"));
    const restartedRuntime = restarted.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    const firstState = await restartedRuntime.getSession(first as DshAgent);
    await restartedRuntime.selectMode({ sessionId: first.id, active: false, expectedModeRevision: firstState.deepwork!.revision, expectedAdmissionEpoch: firstState.admissionEpoch }, first as DshAgent);
    await restarted.disposeAgent(first);
    await restarted.ctx.sessionPersistence.flush();
    // A persisted session resumes with a fresh admission; the user's explicit
    // Deepwork-off intent survives as a mode event, so the resumed session
    // stays on its ordinary composition without delegated role tools.
    const resumedHandle = await restarted.agents.resume({ resumeSessionId: first.id, agentOptions: first.options,
      async setup(scope) { await restarted.ctx.agentPresets.mount(scope, "standard"); } });
    const resumed = resumedHandle.agent;
    assert.equal(restarted.agents.get(first.id), resumed);
    assert.equal((await (restarted.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime).getSession(resumed as DshAgent)).deepwork!.active, false, "the explicit Deepwork-off intent survives the resume");
    assert.equal((restarted.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime).getSettings(resumed as DshAgent).modules.deepwork.enabled, true);
    assert.equal(resumed.ctx.tools.schemas(resumed).some(schema => schema.name.startsWith("dsmm_")), false, "the mounted standard composition exposes no delegated role tools");
    await resumedHandle.dispose();
    assert.equal(restarted.agents.get(first.id), undefined);
    for (const agent of [childAgent, pinnedAgent]) {
      await runFixtureTurn(agent);
      assert.equal(agent.session.snapshotEvents().filter(event => event.type === "turn/end").at(-1)?.data.reason.kind, "completed");
      await mounted.releaseAuxiliary(agent);
      assert.equal(agent.session.requestHeader()!.config.model, "owned-child");
    }
    t.diagnostic(`real Loader/native loop: immutable parent/child snapshots; off standing body/request=0/0; foreign child read bodies=${readBodies}; git push body=0; resume keeps explicit Deepwork-off; desired-on pending until independent startup; save updates/disposals=${updates}/${disposals},${coldUpdates}/${coldDisposals}`);
  } finally {
    release?.(); t.signal.removeEventListener("abort", release);
    for (const fixture of [...fixtures].reverse()) await fixture.dispose();
  }
});
