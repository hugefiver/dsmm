import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, getTraceable } from "@deepseek-ai/cordis";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { createScope, scopeOf, scopeParentOf } from "@deepseek-ai/dsh-scope";
import { SystemPrompt, renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { DshAgent as PackageDshAgent, DshContext, DshSkillCandidate, DshSkillProvider, DshSkillRegistry } from "../lib/dsh-types.js";
import { registerSafetyGuards } from "../lib/guards.js";
import { resolveManagedPresetRoot } from "../lib/preset-materializer.js";
import { DSMM_ROLE_IDS, DSMM_ROLES } from "../lib/roles.js";
import { resolveConfig } from "../lib/settings.js";
import { DSMM_SKILL_NAMES, bundledSkillMetadata, readBundledSkill, registerBundledSkills } from "../lib/skills.js";
import { DeepworkModeController } from "../lib/state.js";
import { nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

type DshAgent = Omit<PackageDshAgent, "ctx">;

const noRoles = Object.fromEntries(DSMM_ROLE_IDS.map((id) => [id, false]));
const native = () => nativeRoutingFixture({ roles: noRoles }, { nativePresets: true, spawn: false });
const adapterAgent = (agent: import("@deepseek-ai/dsh-agent").Agent): DshAgent => agent;

test("fixture Hosts isolate default preset roots without relocating shared profiles or explicit caller roots", async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "dsmm-fixture-root-contract-"));
  const marker = join(profileDir, ".run-owner"), owner = `native-fixture-root-contract:${profileDir}`;
  writeFileSync(marker, owner, { flag: "wx" });
  const fixtures: Awaited<ReturnType<typeof nativeRoutingFixture>>[] = [];
  try {
    await Promise.all([0, 1].map(async () => {
      const f = await nativeRoutingFixture({}, { profileDir, spawn: false }); fixtures.push(f);
    }));
    const [a, b] = fixtures;
    const runtime = (f: typeof a) => f.ctx.get("dsmmProfileRuntime") as import("../lib/profile-runtime.js").DsmmProfileRuntime;
    const roots = fixtures.map((f) => resolveManagedPresetRoot(runtime(f).getSettings()));
    assert.notEqual(roots[0], roots[1], "independent Hosts must not inherit the shared DSH_HOME preset root");
    assert.equal(a.profileDir, profileDir); assert.equal(b.profileDir, profileDir);
    const saved = await runtime(a).save({ id: "fixture-shared", expectedRevision: null,
      content: '{"version":1,"id":"fixture-shared","settings":{}}' });
    assert.equal((await runtime(b).read(saved.id)).revision, saved.revision);
    const explicitRoot = join(profileDir, "caller-presets");
    mkdirSync(explicitRoot);
    const callerFile = join(explicitRoot, "caller.txt");
    writeFileSync(callerFile, "caller-owned preset content", { flag: "wx" });
    const c = await nativeRoutingFixture({ presets: { root: explicitRoot, materialize: true } }, { profileDir, spawn: false, nativePresets: true, managedRuntime: true });
    fixtures.push(c);
    assert.equal(resolveManagedPresetRoot(runtime(c).getSettings()), explicitRoot);
    assert.equal(runtime(c).getSettings().presets.materialize, true);
    await c.dispose();
    assert.equal(readFileSync(callerFile, "utf8"), "caller-owned preset content", "fixture disposal must not delete caller-owned content");
  } finally {
    for (const f of fixtures) await f.dispose();
    assert.equal(readFileSync(marker, "utf8"), owner);
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("A regression: actual Agent scope-only assembly resolves common without context.agent", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true });
  try {
    const agent = await f.create({ agentPreset: "standard" });
    assert.match(renderPrompt(await f.ctx.systemPrompt.assemble({ scope: agent })), /DEEPWORK MODE ENABLED!/);
  } finally { await f.dispose(); }
});

test("A regression: ordinary active native request never assembles bundled skill bodies", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true });
  try {
    const agent = await f.create({ agentPreset: "standard" });
    await runFixtureTurn(agent);
    assert.match(JSON.stringify(f.adapter.calls.at(-1)?.messages), /DEEPWORK MODE ENABLED!/);
    assert.doesNotMatch(JSON.stringify(f.adapter.calls.at(-1)?.messages), /<dsmm-skill|# Brainstorming|# Writing Plans/);
  } finally { await f.dispose(); }
});

test("actual isolated prompt realm has no Host service and preserves literal/order/Agent-local mode semantics", async () => {
  const section = "Native {{literal}} section";
  const f = await nativeRoutingFixture({ section }, { isolatedPrompt: true, nativePresets: true });
  try {
    assert.equal(f.host.get("systemPrompt"), undefined);
    const a = await f.create(), b = await f.create();
    const runtime = f.ctx.get("dsmmProfileRuntime") as import("../lib/profile-runtime.js").DsmmProfileRuntime;
    f.ctx.systemPrompt.section({ name: "contract:after-dsmm", order: 51, text: "AFTER_DSMM" });
    const render = (scope?: object) => f.ctx.systemPrompt.assemble({ scope }).then(renderPrompt);
    const mode = async (active: boolean) => {
      const before = await runtime.getSession(adapterAgent(a));
      return runtime.selectMode({ sessionId: a.id, active, expectedModeRevision: before.deepwork!.revision, expectedAdmissionEpoch: before.admissionEpoch }, adapterAgent(a));
    };
    assert.equal((await render(a)).includes(section), false); await mode(true);
    const prompt = await render(a); assert.equal(prompt.split(section).length - 1, 1);
    assert.ok(prompt.includes("AFTER_DSMM")); assert.ok(prompt.indexOf(section) < prompt.indexOf("AFTER_DSMM"));
    assert.equal((await render(b)).includes(section), false); assert.equal((await render()).includes(section), false);
    await mode(false); a.session.append("agent-preset/selected", { agentPreset: "dsmm-reviewer" });
    assert.equal((await render(a)).includes(section), false, "explicit off survives later role choice");
  } finally { await f.dispose(); }
});

test("role persona survives while durable explicit off wins over role common", async () => {
  const f = await nativeRoutingFixture({ roles: { ...noRoles, "dsmm-orchestrator": true } }, { nativePresets: true, nativeFs: true });
  try {
    const agent = await f.create({ agentPreset: "dsmm-orchestrator" });
    assert.equal(scopeOf(agent.ctx), agent); assert.notEqual(scopeParentOf(agent), agent);
    const skills = agent.ctx.get("skills")!, tools = agent.ctx.get("tools")!;
    const view = { scope: agent, cwd: agent.session.header.cwd };
    const render = () => f.ctx.systemPrompt.assemble({ scope: agent }).then(renderPrompt);
    const persona = DSMM_ROLES.find((role) => role.id === "dsmm-orchestrator")!.persona;
    assert.ok((await render()).includes(persona)); assert.match(await render(), /DEEPWORK MODE ENABLED!/);
    assert.doesNotMatch(await render(), /# Brainstorming|# Writing Plans|<dsmm-skill/);
    assert.deepEqual((await skills.list(view)).map((skill) => skill.name).sort(), [...DSMM_SKILL_NAMES].sort());
    assert.match((await skills.get("writing-plans", view))?.content ?? "", /# Writing Plans/);
    const runtime = f.ctx.get("dsmmProfileRuntime") as import("../lib/profile-runtime.js").DsmmProfileRuntime;
    const before = await runtime.getSession(adapterAgent(agent));
    const disabled = await runtime.selectMode({ sessionId: agent.id, active: false, expectedModeRevision: before.deepwork!.revision, expectedAdmissionEpoch: before.admissionEpoch }, adapterAgent(agent));
    assert.equal(disabled.deepwork!.active, false); assert.equal(disabled.deepwork!.locked, false);
    assert.ok((await render()).includes(persona)); assert.doesNotMatch(await render(), /DEEPWORK MODE ENABLED!|# Brainstorming/);
    assert.equal(await skills.get("brainstorming", view), undefined);
    const sentinel = join(f.profileDir, "role-off-write-sentinel.txt");
    const writeArgs = { file_path: sentinel, content: "native authorized write control\n" };
    assert.equal(existsSync(sentinel), false);
    assert.ok(tools.get("write", agent), "off keeps the write-capable role composition");
    const allowed = await tools.execute({ callId: ToolCallId("role-off-write"), name: "write", arguments: writeArgs, agent, signal: new AbortController().signal });
    assert.equal(allowed.isError, false, "off only removes the common workflow, never the admitted role composition");
    assert.equal(readFileSync(sentinel, "utf8"), writeArgs.content);
  } finally { await f.dispose(); }
});

test("real Cordis Loader shares preset but Agent skills/mode/cwd stay private; blank rebind disposes old providers", async () => {
  const f = await nativeRoutingFixture({ roles: { ...noRoles, "dsmm-orchestrator": true } }, { nativePresets: true, spawn: false, managedRuntime: true });
  try {
    const a = await f.create({ agentPreset: "standard", cwd: f.profileDir }), b = await f.create({ agentPreset: "standard", cwd: join(f.profileDir, "other") });
    assert.equal(scopeParentOf(a), scopeParentOf(b)); assert.notEqual(scopeOf(a.ctx), scopeOf(b.ctx));
    const runtime = f.ctx.get("dsmmProfileRuntime") as import("../lib/profile-runtime.js").DsmmProfileRuntime;
    const before = await runtime.getSession(adapterAgent(a));
    await runtime.selectMode({ sessionId: a.id, active: true, expectedModeRevision: before.deepwork!.revision, expectedAdmissionEpoch: before.admissionEpoch }, adapterAgent(a));
    assert.equal((await f.ctx.skills.list({ scope: a, cwd: a.session.header.cwd })).length, DSMM_SKILL_NAMES.length);
    assert.deepEqual(await f.ctx.skills.list({ scope: b, cwd: b.session.header.cwd }), []);
    assert.deepEqual(await f.ctx.skills.list(), []);
    assert.deepEqual(await f.ctx.skills.list({ scope: scopeParentOf(a) }), []);
    const loaded = await f.ctx.skills.get("debugging", { scope: a, cwd: a.session.header.cwd }); assert.ok(loaded);
    assert.equal(loaded.resourceBase?.kind, "directory");
    if (loaded.resourceBase?.kind === "directory") assert.match(await readFile(join(loaded.resourceBase.path, "references/scripts/dap.mjs"), "utf8"), /node/);
    let changes = 0; const stop = f.ctx.on("skills/change", () => { changes++; });
    for (const preset of ["dsmm-orchestrator", "standard", "dsmm-orchestrator", "standard"]) {
      await f.ctx.agentPresets.select(b, preset);
      await f.ctx.get("dsmmNativeAdmission")!.ensure(b);
      assert.equal((await runtime.getSession(adapterAgent(b))).deepwork?.active, preset !== "standard");
      const skills = f.ctx.agentPresets.serviceFor(b, "skills") ?? b.ctx.get("skills")!;
      const catalog = await skills.list({ scope: b, cwd: b.session.header.cwd });
      assert.equal(catalog.length, preset === "standard" ? 0 : DSMM_SKILL_NAMES.length);
    }
    const quiet = changes; await f.ctx.skills.list({ scope: a }); await f.ctx.skills.list({ scope: b });
    assert.equal(changes, quiet, "metadata queries never reflect skills/change into invalidate loops");
    stop();
    await f.dsmmFiber.dispose();
    assert.deepEqual(await f.ctx.skills.list({ scope: a }), []);
  } finally { await f.dispose(); }
});

test("native skill tool consumes metadata catalog and loads a body only at invocation", async () => {
  const f = await providerFixture();
  const sdk = createRequire(createRequire(import.meta.url).resolve("@deepseek-ai/dsh-tool-skill"));
  try {
    const fiber = f.ctx.plugin(sdk("@deepseek-ai/dsh-tool-skill")); await fiber.await();
    const agent = f.agent;
    assert.equal((await f.ctx.skills.list(f.view)).length, DSMM_SKILL_NAMES.length);
    const prompt = renderPrompt(await f.ctx.systemPrompt.assemble({ scope: agent }));
    assert.doesNotMatch(prompt, /# Brainstorming|<dsmm-skill/);
    await runFixtureTurn(agent); assert.equal(f.reads(), 0, "native catalog assembly never loads skill bodies");
    const result = await f.tools.execute({ callId: ToolCallId("native-skill-load"), name: "skill", arguments: { name: "brainstorming" }, agent, signal: new AbortController().signal });
    assert.equal(result.isError, false);
    assert.equal(f.reads(), 1, "invocation loads the selected skill body only");
    const registration = await f.ctx.skills.get("brainstorming", f.view); assert.ok(registration);
    assert.deepEqual(result.value, { name: registration.name, provider: registration.provider, resourceBase: registration.resourceBase, content: registration.content });
    assert.ok(result.content.some((block) => block.type === "text" && block.text.includes('<skill_content name="brainstorming">')));
    for (const name of ["debugging", "ast-grep", "coding-agent-sessions"] as const) {
      const loaded = await f.tools.execute({ callId: ToolCallId(`native-skill-load-${name}`), name: "skill", arguments: { name }, agent, signal: new AbortController().signal });
      assert.equal(loaded.isError, false, name);
      const registration = await f.ctx.skills.get(name, { scope: agent });
      assert.equal(registration?.resourceBase?.kind, "directory");
      if (registration?.resourceBase?.kind === "directory") {
        const resource = name === "debugging" ? "references/scripts/dap.mjs" : name === "ast-grep" ? "scripts/ast_grep_helper.py" : "scripts/agent_sessions/cli.py";
        assert.ok((await readFile(join(registration.resourceBase.path, resource), "utf8")).length > 0);
      }
    }
  } finally { await f.dispose(); }
});

function gate() { let release!: () => void; const promise = new Promise<void>((done) => { release = done; }); return { promise, release }; }

async function providerFixture() {
  const f = await native();
  const agent = await f.create({ agentPreset: "standard", cwd: f.profileDir });
  const controller = new DeepworkModeController({});
  const settings = resolveConfig({ defaultActive: true });
  let reads = 0, beforeRead: (() => Promise<void>) | undefined;
  const provider = registerBundledSkills(agent.ctx, agent.ctx.get("skills")!, { agent: adapterAgent(agent), controller, getSettings: () => settings,
    async load(name, signal) { reads++; await beforeRead?.(); return readBundledSkill(name, signal); } });
  const view = { scope: agent, cwd: agent.session.header.cwd };
  return { ...f, agent, view, provider, reads: () => reads, holdRead(fn: (() => Promise<void>) | undefined) { beforeRead = fn; } };
}

test("another isolated native registry cannot permanently poison cached bundled candidates", async () => {
  const f = await providerFixture();
  const sdk = createRequire(createRequire(import.meta.url).resolve("@deepseek-ai/dsh-skill-filesystem"));
  const barrier = gate();
  try {
    const otherCtx = f.ctx.isolate("skills");
    await otherCtx.plugin(sdk("@deepseek-ai/dsh-skill").SkillRegistry, {}).await();
    const other = otherCtx.get("skills")!;
    assert.notEqual(other, f.ctx.skills);
    const catalog = await f.ctx.skills.snapshot(f.view);
    assert.equal(catalog.complete, true); assert.equal(catalog.skills.length, DSMM_SKILL_NAMES.length); assert.equal(f.reads(), 0);
    assert.match((await f.ctx.skills.get("brainstorming", f.view))?.content ?? "", /# Brainstorming/);
    let changes = 0;
    f.ctx.on("skills/change", () => { changes++; });
    const undo = other.registerProvider(() => ({ name: "other-registry",
      async list() { return [{ ...bundledSkillMetadata("brainstorming"), provider: "other-registry", rank: 1, locator: "other" }]; },
      async get(candidate) { return { ...candidate, content: "OTHER_REGISTRY_BODY" }; }
    }));
    assert.equal((await other.list()).at(0)?.provider, "other-registry");
    assert.deepEqual(await f.ctx.skills.snapshot(f.view), catalog);
    assert.equal(f.reads(), 1, "catalog lookup must remain metadata-only");
    const first = await f.ctx.skills.get("brainstorming", f.view);
    const second = await f.ctx.skills.get("brainstorming", f.view);
    assert.match(first?.content ?? "", /# Brainstorming/, "first cached get after a foreign broadcast must load");
    assert.match(second?.content ?? "", /# Brainstorming/, "repeated cached get must not require local invalidate");
    assert.equal(changes, 1, "the listener must not reflect the broadcast into local invalidation");
    const started = gate();
    f.holdRead(async () => { started.release(); await barrier.promise; });
    const inFlight = f.ctx.skills.get("brainstorming", f.view); await started.promise;
    undo(); barrier.release();
    assert.equal(await inFlight, undefined, "a foreign broadcast still fences the current body read");
    f.holdRead(undefined);
    assert.match((await f.ctx.skills.get("brainstorming", f.view))?.content ?? "", /# Brainstorming/);
    assert.equal(changes, 2, "stable subsequent loads must not broadcast another invalidate");
  } finally { barrier.release(); await f.dispose(); }
});

test("ancestor project winner add/remove/add beats Agent rank600; policy and resourceBase cannot be bypassed", async () => {
  const f = await providerFixture();
  try {
    let project = false, invalidate!: () => void, lists = 0;
    // Deliberately global ancestor: rank 900 would lose in the SAME layer.
    const undo = f.ctx.skills.registerProvider((control) => { invalidate = control.invalidate; return { name: "project",
      async list(lookup) { lists++; return project && lookup.cwd === f.view.cwd ? [{ ...bundledSkillMetadata("brainstorming"), provider: "project", source: "project-dsh", rank: 900, locator: "project", invocation: { modelInvocable: false, userInvocable: false }, resourceBase: { kind: "opaque", description: "project base" } }] : []; },
      async get(candidate) { return { ...candidate, content: "PROJECT_BODY" }; } }; });
    assert.equal((await f.ctx.skills.snapshot(f.view)).complete, true); assert.equal(f.reads(), 0);
    assert.equal((await f.ctx.skills.get("brainstorming", f.view))?.provider, "dsmm"); assert.equal(f.reads(), 1);
    for (const value of [true, false, true]) {
      project = value; invalidate();
      const catalog = await f.ctx.skills.list(f.view); assert.equal(f.reads(), 1);
      const winner = catalog.find((entry) => entry.name === "brainstorming")!;
      assert.equal(winner.provider, value ? "project" : "dsmm");
      if (value) { assert.deepEqual(winner.invocation, { modelInvocable: false, userInvocable: false }); assert.deepEqual(winner.resourceBase, { kind: "opaque", description: "project base" }); }
    }
    assert.equal((await f.ctx.skills.get("brainstorming", f.view))?.content, "PROJECT_BODY"); assert.equal(f.reads(), 1);
    assert.ok(lists < 30, "ancestor snapshot is strictly upward, not recursive");
    undo(); assert.equal((await f.ctx.skills.list(f.view)).find((entry) => entry.name === "brainstorming")?.provider, "dsmm");
  } finally { await f.dispose(); }
});

test("preset-layer cwd-specific winner affects only its session; invocation-disabled project cannot use bundled fallback", async () => {
  const f = await nativeRoutingFixture({ roles: { ...noRoles, "dsmm-orchestrator": true }, defaultActive: true }, { nativePresets: true, spawn: false, managedRuntime: true });
  const sdk = createRequire(createRequire(import.meta.url).resolve("@deepseek-ai/dsh-tool-skill"));
  try {
    await f.ctx.plugin(sdk("@deepseek-ai/dsh-tool-skill")).await();
    const a = await f.create({ agentPreset: "standard", cwd: f.profileDir });
    const b = await f.create({ agentPreset: "standard", cwd: join(f.profileDir, "second") });
    assert.equal(scopeParentOf(a), scopeParentOf(b));
    const ancestorScope = createScope(f.ctx, scopeParentOf(a)!);
    const ancestor = getTraceable(ancestorScope.ctx, f.ctx.skills);
    let present = true, invalidate!: () => void;
    ancestor.registerProvider((control) => { invalidate = control.invalidate; return { name: "preset-project",
      async list(options) { return present && options.cwd === a.session.header.cwd ? [{ ...bundledSkillMetadata("brainstorming"), provider: "preset-project", rank: 900, locator: "ancestor", invocation: { modelInvocable: false, userInvocable: false } }] : []; },
      async get(candidate) { return { ...candidate, content: "FORBIDDEN_PROJECT_BODY" }; } }; });
    const view = (agent: typeof a) => ({ scope: agent, cwd: agent.session.header.cwd });
    for (const value of [true, false, true]) {
      present = value; invalidate();
      assert.equal((await f.ctx.skills.list(view(a))).find((skill) => skill.name === "brainstorming")?.provider, value ? "preset-project" : "dsmm");
      assert.equal((await f.ctx.skills.list(view(b))).find((skill) => skill.name === "brainstorming")?.provider, "dsmm");
    }
    const denied = await f.tools.execute({ callId: ToolCallId("disabled-project"), name: "skill", arguments: { name: "brainstorming" }, agent: a, signal: new AbortController().signal });
    assert.equal(denied.isError, true); assert.doesNotMatch(JSON.stringify(denied.content), /# Brainstorming|FORBIDDEN_PROJECT_BODY/);
    const runtime = f.ctx.get("dsmmProfileRuntime")!;
    const before = await runtime.getSession(adapterAgent(a));
    await runtime.selectMode({ sessionId: a.id, active: false, expectedModeRevision: before.deepwork!.revision, expectedAdmissionEpoch: before.admissionEpoch }, adapterAgent(a));
    assert.equal((await f.ctx.skills.list(view(a))).length, 1, "off withdraws DSMM only, not ancestor project");
    assert.equal((await f.ctx.skills.list(view(b))).length, DSMM_SKILL_NAMES.length);
    await ancestorScope.dispose();
  } finally { await f.dispose(); }
});

test("native Loader desired updates preserve admissions while owner retirement revokes old execution", async () => {
  const roles = { ...noRoles, "dsmm-orchestrator": true };
  const f = await nativeRoutingFixture({ roles }, { nativePresets: true, spawn: false, managedRuntime: true });
  try {
    assert.ok(f.dsmmEntryId); assert.equal((f.deploymentConfig() as { defaultActive: { get(): unknown } }).defaultActive.get(), undefined);
    await f.reloadDeployment({ roles, defaultActive: true, promptOrder: 73 });
    assert.equal((f.deploymentConfig() as { promptOrder: { get(): unknown } }).promptOrder.get(), 73);
    const a = await f.create({ agentPreset: "standard" });
    const runtime = f.ctx.get("dsmmProfileRuntime") as import("../lib/profile-runtime.js").DsmmProfileRuntime;
    const before = await runtime.getSession(adapterAgent(a));
    const barrier = gate(), busy = a.runMaintenance(() => barrier.promise);
    try {
      await f.saveDeployment({ roles, defaultActive: false, promptOrder: 74 });
      assert.equal((f.deploymentConfig() as { promptOrder: { get(): unknown } }).promptOrder.get(), 74);
      assert.equal(f.agents.get(a.id), a, "desired saves retain the admitted native Agent");
      assert.equal(runtime.getSettings(adapterAgent(a)).defaultActive, true);
      assert.equal((await runtime.getSession(adapterAgent(a))).admissionEpoch, before.admissionEpoch);
      assert.equal((await f.ctx.skills.list({ scope: a })).length, DSMM_SKILL_NAMES.length);
    } finally { barrier.release(); await busy; }
    await f.reloadDeployment({ roles, defaultActive: false });
    assert.equal(runtime.admission(adapterAgent(a)).epoch, before.admissionEpoch);
    await f.dsmmFiber.dispose();
    const denied = await a.ctx.tools.execute({ agent: a, name: "read", arguments: {}, callId: ToolCallId("retired-remount-read"), signal: new AbortController().signal });
    assert.equal(denied.isError, true);
  } finally { await f.dispose(); }
});

test("ancestor incomplete/error/abort never means missing; later native lookup recovers without negative cache", async () => {
  const f = await providerFixture();
  try {
    let state: "incomplete" | "error" | "complete" = "incomplete", invalidate!: () => void;
    f.ctx.skills.registerProvider((control) => { invalidate = control.invalidate; return { name: "uncertain",
      async list() { if (state === "error") throw new Error("fixture provider unavailable"); return { candidates: [], complete: state === "complete" }; }, async get() { return undefined; } }; });
    for (const next of ["incomplete", "error"] as const) {
      state = next; invalidate(); const snapshot = await f.ctx.skills.snapshot(f.view);
      assert.equal(snapshot.complete, false); assert.deepEqual(snapshot.skills, []); assert.equal(f.reads(), 0);
      assert.equal(await f.ctx.skills.get("brainstorming", f.view), undefined);
    }
    await assert.rejects(f.ctx.skills.snapshot({ ...f.view, signal: AbortSignal.abort() }));
    state = "complete"; invalidate(); assert.equal((await f.ctx.skills.snapshot(f.view)).skills.length, DSMM_SKILL_NAMES.length); assert.equal(f.reads(), 0);
  } finally { await f.dispose(); }
});

test("metadata/get generation races and registration/caller abort cannot publish stale bundled content", async () => {
  const f = await providerFixture();
  try {
    await f.ctx.skills.list(f.view); assert.equal(f.reads(), 0);
    const barrier = gate(), started = gate();
    f.holdRead(async () => { started.release(); await barrier.promise; });
    const oldGet = f.ctx.skills.get("brainstorming", f.view); await started.promise;
    const undo = f.ctx.skills.registerProvider(() => ({ name: "late-project", async list() { return [{ ...bundledSkillMetadata("brainstorming"), provider: "late-project", rank: 1, locator: "late" }]; }, async get(candidate) { return { ...candidate, content: "LATE_PROJECT" }; } }));
    barrier.release(); assert.equal(await oldGet, undefined);
    assert.equal((await f.ctx.skills.get("brainstorming", f.view))?.content, "LATE_PROJECT");
    undo(); f.holdRead(undefined);
    const abort = new AbortController(), hold = gate(), reached = gate();
    f.holdRead(async () => { reached.release(); await hold.promise; });
    const canceled = f.ctx.skills.get("writing-plans", { ...f.view, signal: abort.signal }); await reached.promise;
    abort.abort(); await assert.rejects(canceled); hold.release();
    const disposal = gate(), inside = gate(); f.holdRead(async () => { inside.release(); await disposal.promise; });
    const stopped = f.ctx.skills.get("writing-plans", f.view); await inside.promise;
    f.provider.dispose(); disposal.release(); await assert.rejects(stopped);
    f.provider.dispose(); assert.deepEqual(await f.ctx.skills.list(f.view), []);
  } finally { await f.dispose(); }
});

test("native metadata invalidation retries a changing ancestor, and cached stale candidate is refused before body I/O", async () => {
  const f = await native();
  try {
    const agent = await f.create({ agentPreset: "standard", cwd: f.profileDir });
    const real = agent.ctx.get("skills")!;
    let provider!: DshSkillProvider, reads = 0;
    const bridge: DshSkillRegistry = {
      snapshot: real.snapshot.bind(real), list: real.list.bind(real), get: real.get.bind(real),
      registerProvider(factory) { return real.registerProvider((control) => { provider = factory(control); return provider; }); }
    };
    const options = { agent: adapterAgent(agent), controller: new DeepworkModeController({}), getSettings: () => resolveConfig({ defaultActive: true }),
      async load(name: Parameters<typeof readBundledSkill>[0], signal: AbortSignal) { reads++; return readBundledSkill(name, signal); } };
    assert.throws(() => registerBundledSkills(f.ctx, f.ctx.skills, options), /exact Agent scope/);
    const registration = registerBundledSkills(agent.ctx, bridge, options);
    const lookup = { cwd: agent.session.header.cwd }, view = { ...lookup, scope: agent };
    const observation = await provider.list(lookup);
    const candidates = Array.isArray(observation) ? observation : (observation as { candidates: readonly DshSkillCandidate[] }).candidates;
    const old = candidates.find((candidate) => candidate.name === "brainstorming")!; assert.ok(old); assert.equal(reads, 0);
    let changing = true, invalidate!: () => void, present = false, lists = 0;
    f.ctx.skills.registerProvider((control) => { invalidate = control.invalidate; return { name: "changing-project",
      async list() {
        lists++;
        if (changing) { changing = false; present = true; invalidate(); }
        return present ? [{ ...bundledSkillMetadata("brainstorming"), provider: "changing-project", rank: 900, locator: "project" }] : [];
      }, async get(candidate) { return { ...candidate, content: "CURRENT_PROJECT" }; } }; });
    assert.equal(await provider.get(old, lookup), undefined); assert.equal(reads, 0, "stale candidate must revalidate the ancestor before body I/O");
    const snapshot = await f.ctx.skills.snapshot(view);
    assert.equal(snapshot.complete, true); assert.equal(snapshot.skills.find((skill) => skill.name === "brainstorming")?.provider, "changing-project");
    assert.equal((await f.ctx.skills.get("brainstorming", view))?.content, "CURRENT_PROJECT");
    assert.equal(reads, 0); assert.ok(lists < 12);
    registration.dispose();
  } finally { await f.dispose(); }
});

test("registration abort cancels ancestor discovery; repeated same-scope mounts leave no DSMM rows/listeners", async () => {
  const f = await native();
  try {
    const agent = await f.create({ agentPreset: "standard", cwd: f.profileDir });
    const real = agent.ctx.get("skills")!;
    let provider!: DshSkillProvider;
    const bridge: DshSkillRegistry = { snapshot: real.snapshot.bind(real), list: real.list.bind(real), get: real.get.bind(real),
      registerProvider(factory) { return real.registerProvider((control) => { provider = factory(control); return provider; }); } };
    const options = { agent: adapterAgent(agent), controller: new DeepworkModeController({}), getSettings: () => resolveConfig({ defaultActive: true }) };
    let controlInvalidate!: () => void, block = true;
    const barrier = gate(), entered = gate();
    const undo = f.ctx.skills.registerProvider((control) => { controlInvalidate = control.invalidate; return { name: "slow-ancestor",
      async list() { if (block) { entered.release(); await barrier.promise; } return []; }, async get() { return undefined; } }; });
    const registration = registerBundledSkills(agent.ctx, bridge, options);
    const pending = provider.list({ cwd: f.profileDir }); await entered.promise;
    registration.dispose(); await assert.rejects(pending, /disposed/);
    block = false; barrier.release(); controlInvalidate();
    assert.deepEqual(await f.ctx.skills.list({ scope: agent }), []);
    for (let i = 0; i < 4; i++) {
      const current = registerBundledSkills(agent.ctx, bridge, options);
      assert.equal((await f.ctx.skills.list({ scope: agent })).length, DSMM_SKILL_NAMES.length);
      current.dispose(); current.dispose(); assert.deepEqual(await f.ctx.skills.list({ scope: agent }), []);
    }
    undo(); assert.deepEqual(await f.ctx.skills.list(), []);
  } finally { await f.dispose(); }
});

test("native ToolRuntime still denies Git writes and truncates rendering without mutating canonical values", async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt, {}).await(); await ctx.plugin(ToolRuntime, { mode: "native" }).await();
    const settings = resolveConfig({ guards: { scope: "always", gitWriteGuard: "deny", toolOutputTruncation: { maxInlineBytes: 90 } } });
    // This pre-existing guard adapter is outside A's native prompt/skill seam.
    registerSafetyGuards(ctx as unknown as DshContext, new DeepworkModeController({}), () => settings);
    let calls = 0; const value = "x".repeat(300);
    ctx.tools.register({ name: "bash", description: "Never runs a shell", parameters: { command: { type: "string", required: true } }, output: { schema: { type: "string" }, render: (_args, result) => [{ type: "text", text: String(result) }] }, async execute() { calls++; return value; } });
    const signal = new AbortController().signal;
    const denied = await ctx.tools.execute({ callId: ToolCallId("git-denied"), name: "bash", arguments: { command: "git commit -m blocked" }, signal });
    assert.equal(denied.isError, true); assert.equal(calls, 0);
    const result = await ctx.tools.execute({ callId: ToolCallId("git-read"), name: "bash", arguments: { command: "git status" }, signal });
    assert.equal(result.isError, false); assert.equal(result.value, value); assert.equal(calls, 1);
    const rendered = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
    assert.match(rendered, /\[dsmm safety\] truncated/); assert.ok(Buffer.byteLength(rendered) <= 90);
  } finally { await ctx.fiber.dispose(); }
});
