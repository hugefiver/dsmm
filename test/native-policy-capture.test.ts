import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ToolCallId, createUserMessage } from "@deepseek-ai/dsh-llm";
import { DsmmDeploymentConfig as DeploymentConfig } from "../lib/deployment-config.js";
import type { DsmmProfileRuntime } from "../lib/profile-runtime.js";
import type { DshAgent, DshContext } from "../lib/dsh-types.js";
import { DsmmRolePolicy } from "../lib/role-policy.js";
import { DeepworkModeController } from "../lib/state.js";
import { nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

function categoryTargets(agent: import("@deepseek-ai/dsh-agent").Agent): string[] {
  const schema = agent.ctx.tools.schemas(agent).find(row => row.name === "dsmm_category");
  return schema === undefined ? [] : (schema.parameters as { properties: { category: { enum: string[] } } }).properties.category.enum;
}

test("retired DSMM entry revokes live child work and releases exact native owned children", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true });
  try {
    const root = await f.create();
    const child = await f.createAuxiliary("dsmm-reviewer", undefined, "continuable", root);
    await runFixtureTurn(child);
    assert.ok(child.session.snapshotEvents().some(event => event.type === "turn/end" && event.data.reason.kind === "completed"));
    const calls = f.adapter.calls.length;
    await f.dsmmFiber.dispose();
    assert.equal(f.agents.get(child.id), undefined);
    assert.equal(f.agents.get(root.id), root);
    await assert.rejects(f.subagents.sendMessage(root, child.id, [{ type: "text", text: "Retired owner cannot deliver" }], { signal: new AbortController().signal }));
    assert.equal(f.adapter.calls.length, calls);
  } finally { await f.dispose(); }
});

test("busy parent and future role children retain their epoch while fresh roots capture desired off/on and startup ceilings", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, roleRouting: { "dsmm-coding": { primary: { provider: "fixture", model: "owned-child" } } } }, {
    async beforeDsmm(ctx) {
      const deployment = new DeploymentConfig(ctx as unknown as DshContext, {});
      await deployment.saveGlobal({ expectedRevision: "absent", edits: [{ op: "set", path: ["runtimeRecovery", "enabled"], value: true }] }, () => {});
    }
  });
  let release!: () => void;
  try {
    const runtime = f.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    const deployment = f.ctx.get("dsmmDeploymentConfig")!;
    const parent = await f.create();
    const before = runtime.admission(parent as unknown as DshAgent);
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    f.adapter.beforeStream = async options => { if (options.model === "native-default") { entered(); await waiting; } };
    parent.followup(createUserMessage({ content: [{ type: "text", text: "Hold while desired is saved" }], source: { kind: "user" } }));
    await started;
    const global = await deployment.readGlobal();
    await deployment.saveGlobal({ expectedRevision: global.revision, edits: [
      { op: "set", path: ["roles", "dsmm-coding"], value: false },
      { op: "set", path: ["skills", "debugging"], value: false },
      { op: "set", path: ["runtimeRecovery", "enabled"], value: false }
    ] }, () => {});
    assert.equal(parent.status, "running");
    assert.equal(runtime.admission(parent as unknown as DshAgent), before);
    const child = await f.createAuxiliary("dsmm-coding", undefined, "continuable", parent);
    const captured = runtime.admission(child as unknown as DshAgent);
    assert.equal(captured.epoch, before.epoch);
    assert.equal(child.session.header.parentSession, parent.id);
    assert.equal(f.agents.isOwnedBy(child.id, parent), true);
    assert.equal(f.ctx.get("dsmmNativeAdmission")!.invocation(child)?.target, "dsmm-coding");
    assert.deepEqual(captured.settings.roleRouting, before.settings.roleRouting);
    assert.equal(captured.settings.roles["dsmm-coding"], true);
    const off = await f.create();
    const offAdmission = runtime.admission(off as unknown as DshAgent);
    assert.equal(offAdmission.settings.roles["dsmm-coding"], false);
    assert.equal(offAdmission.settings.skills.debugging, false);
    assert.equal(offAdmission.settings.runtimeRecovery.enabled, false);
    assert.equal(categoryTargets(off).includes("dsmm-coding"), false);
    assert.equal((await off.ctx.tools.execute({ agent: off, name: "dsmm_category", arguments: { category: "dsmm-coding", description: "Disabled", prompt: "Must not dispatch" }, callId: ToolCallId("disabled-role"), signal: new AbortController().signal })).isError, true);
    assert.equal((await f.ctx.skills.list({ scope: off })).some(row => row.name === "debugging"), false);
    assert.equal((await f.ctx.skills.list({ scope: parent })).some(row => row.name === "debugging"), true);
    release(); await parent.whenIdle(); f.adapter.beforeStream = undefined;
    const restored = await deployment.readGlobal();
    await deployment.saveGlobal({ expectedRevision: restored.revision, edits: [
      { op: "set", path: ["roles", "dsmm-coding"], value: true },
      { op: "set", path: ["roles", "dsmm-cross-cutting"], value: true },
      { op: "set", path: ["skills", "debugging"], value: true },
      { op: "set", path: ["runtimeRecovery", "enabled"], value: true }
    ] }, () => {});
    const on = await f.create();
    const onAdmission = runtime.admission(on as unknown as DshAgent);
    assert.ok(categoryTargets(on).includes("dsmm-coding"));
    assert.equal(onAdmission.settings.skills.debugging, true);
    assert.equal(onAdmission.settings.roles["dsmm-cross-cutting"], false);
    assert.ok(onAdmission.restartRequired?.includes("roles.dsmm-cross-cutting"));
    assert.equal(runtime.admission(off as unknown as DshAgent), offAdmission);
    assert.equal(runtime.admission(child as unknown as DshAgent), captured);
    await runFixtureTurn(child);
  } finally { release?.(); await f.dispose(); }
});

test("live reviewer and coding children retain captured read-only and Git ceilings across parent mode and future-default changes", async () => {
  let bodies = 0;
  const f = await nativeRoutingFixture({ defaultActive: true, guards: { gitWriteGuard: "deny" } }, { headless: true, nativeFs: true, fixtureTools: [
    { name: "pwsh", description: "Counter-only shell; never executes commands", parameters: { command: { type: "string", required: true } },
      output: { schema: { type: "string" }, render: () => [] }, async execute() { bodies++; return "COUNTER_ONLY"; } }
  ] });
  try {
    const readable = join(f.profileDir, "captured-read.txt");
    writeFileSync(readable, "captured fixture read");
    const runtime = f.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    const parent = await f.create();
    const reviewer = await f.createAuxiliary("dsmm-reviewer", undefined, "continuable", parent);
    const coding = await f.createAuxiliary("dsmm-coding", undefined, "continuable", parent);
    const reviewerAdmission = runtime.admission(reviewer as unknown as DshAgent);
    const codingAdmission = runtime.admission(coding as unknown as DshAgent);
    const policy = new DsmmRolePolicy(f.ctx as unknown as DshContext, runtime.getSettings, new DeepworkModeController(f.ctx as unknown as DshContext));
    const reviewerIdentity = policy.identity(reviewer as unknown as DshAgent);
    assert.equal(reviewerIdentity.readOnly, true);
    assert.ok(Object.isFrozen(reviewerIdentity));
    const session = await runtime.getSession(parent as unknown as DshAgent);
    await runtime.selectMode({ sessionId: parent.id, active: false, expectedModeRevision: session.deepwork!.revision, expectedAdmissionEpoch: session.admissionEpoch }, parent as unknown as DshAgent);
    const draft = await runtime.save({ id: "future-guard-off", expectedRevision: null, content: '{"version":1,"id":"future-guard-off","settings":{"defaultActive":true,"guards":{"gitWriteGuard":"off"}}}' });
    await runtime.select({ id: draft.id, expectedRevision: draft.revision, expectedSelectionRevision: (await runtime.describe()).selectionRevision });
    for (const child of [reviewer, coding]) {
      const denied = await child.ctx.tools.execute({ agent: child, name: "pwsh", arguments: { command: "git push origin main" }, callId: ToolCallId(`captured-git-${child.id}`), signal: new AbortController().signal });
      assert.equal(denied.isError, true);
      const read = await child.ctx.tools.execute({ agent: child, name: "read", arguments: { file_path: readable }, callId: ToolCallId(`captured-read-${child.id}`), signal: new AbortController().signal });
      assert.equal(read.isError, false, JSON.stringify(read));
      assert.ok(read.content.some(block => block.type === "text" && block.text.includes("captured fixture read")));
    }
    assert.equal(runtime.admission(reviewer as unknown as DshAgent), reviewerAdmission);
    assert.equal(runtime.admission(coding as unknown as DshAgent), codingAdmission);
    assert.equal(codingAdmission.settings.guards.gitWriteGuard, "deny");
    assert.equal(bodies, 0);
    const fresh = await f.create();
    assert.equal(runtime.getSettings(fresh as unknown as DshAgent).guards.gitWriteGuard, "off");
    assert.equal((await fresh.ctx.tools.execute({ agent: fresh, name: "pwsh", arguments: { command: "git push origin main" }, callId: ToolCallId("fresh-counter-only"), signal: new AbortController().signal })).isError, false);
    assert.equal(bodies, 1);
    await runFixtureTurn(reviewer); await runFixtureTurn(coding);
  } finally { await f.dispose(); }
});
