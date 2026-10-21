import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import type { DshAgent as PackageDshAgent } from "../lib/dsh-types.js";
import { nativeConfigRun } from "./native-config-fixture.ts";
import { runFixtureTurn } from "./native-routing-fixture.ts";
import { DSMM_ROLE_IDS } from "../lib/roles.js";

type DshAgent = Omit<PackageDshAgent, "ctx">;

const asDshAgent = (agent: Agent): DshAgent => agent;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("rc.2 native SettingsForms persists sparse DSMM deployment without remounting or cancelling busy admissions", { timeout: 20_000 }, async (t) => {
  const run = nativeConfigRun({ managedRuntime: true });
  try {
    const roles = Object.fromEntries(DSMM_ROLE_IDS.map(id => [id, id === "dsmm-orchestrator"]));
    const a = await run.createProfile("omitted", { roles }), b = await run.createProfile("explicit-false", { roles, defaultActive: false });
    const oldRoot = await a.create(), oldB = await b.create();
    const oldAdmission = a.runtime.admission(asDshAgent(oldRoot));
    const oldBAdmission = b.runtime.admission(asDshAgent(oldB));
    assert.equal(oldAdmission.settings.defaultActive, false);
    assert.equal(Object.hasOwn((await a.deployment.readDesired()).profile, "defaultActive"), false);
    assert.equal((await b.deployment.readDesired()).profile.defaultActive, false);
    assert.equal(a.descriptor().revision, 0);
    assert.equal(b.descriptor().revision, 0);
    const originalPatchA = readFileSync(a.patchPath, "utf8"), originalPatchB = readFileSync(b.patchPath, "utf8");
    const activeRef = Reflect.get(a.fiber.config, "defaultActive");
    const workflowRef = Reflect.get(a.fiber.config, "workflow");
    const global = await a.deployment.saveGlobal({ expectedRevision: "absent", edits: [{ op: "set", path: ["defaultActive"], value: true }] }, () => {});
    const globalPath = join(run.home, "plugins", "dsmm", "config.json");
    const globalBytes = readFileSync(globalPath, "utf8");
    assert.deepEqual(JSON.parse(globalBytes), { defaultActive: true });
    assert.equal((await b.deployment.readGlobal()).revision, global.revision, "two native profiles share one global store");
    assert.equal(readFileSync(a.patchPath, "utf8"), originalPatchA);
    assert.equal(readFileSync(b.patchPath, "utf8"), originalPatchB);
    a.assertLive(); b.assertLive();
    assert.equal(a.lifecycle.partialDisposes, 0, "global save must not enter the native Loader update path");
    assert.equal(b.lifecycle.partialDisposes, 0);
    const inheritedRoot = await a.create(), pinnedRoot = await b.create();
    assert.equal(a.runtime.getSettings(asDshAgent(inheritedRoot)).defaultActive, true, "omission inherits global rather than transport defaults");
    assert.equal(b.runtime.getSettings(asDshAgent(pinnedRoot)).defaultActive, false, "explicit built-in false overrides global true");
    assert.equal(a.runtime.admission(asDshAgent(inheritedRoot)).sources?.defaultActive, "global");
    assert.equal(b.runtime.admission(asDshAgent(pinnedRoot)).sources?.defaultActive, "profile");

    const started = gate(), finish = gate();
    let requestSignal: AbortSignal | undefined;
    a.adapter.beforeStream = async (options) => {
      requestSignal = options.signal;
      options.signal?.addEventListener("abort", finish.release, { once: true });
      started.release();
      try { await finish.promise; }
      finally { options.signal?.removeEventListener("abort", finish.release); }
    };
    t.signal.addEventListener("abort", finish.release, { once: true });
    oldRoot.followup(createUserMessage({ content: [{ type: "text", text: "Hold this local request during a native settings save" }], source: { kind: "user" } }));
    try {
      await started.promise;
      assert.equal(oldRoot.status, "running");
      assert.ok(requestSignal);
      const before = a.descriptor();
      await a.settings.mutate(before.ns, [
        { op: "set", path: ["defaultActive"], value: false },
        { op: "set", path: ["workflow", "reviewCap"], value: 2 },
        { op: "set", path: ["roles", "dsmm-planner"], value: true },
        { op: "set", path: ["skills", "debugging"], value: false },
        { op: "set", path: ["runtimeRecovery", "enabled"], value: true }
      ], before.revision);
      a.assertLive(); b.assertLive();
      assert.equal(Reflect.get(a.fiber.config, "defaultActive"), activeRef, "native refs retain identity");
      assert.equal(Reflect.get(a.fiber.config, "workflow"), workflowRef);
      assert.equal(activeRef.get(), false);
      assert.equal(workflowRef.get().reviewCap, 2);
      t.diagnostic(`native busy-save DSMM lifecycle=${JSON.stringify(a.lifecycle)}`);
      assert.equal(requestSignal.aborted, false, "native save must not abort a live AgentLoop request");
      assert.equal(oldRoot.status, "running");
      assert.equal(a.ctx.agents.get(oldRoot.id), oldRoot);
      assert.equal(a.runtime.admission(asDshAgent(oldRoot)), oldAdmission, "the complete old admission remains pinned");
       assert.equal(oldAdmission.settings.workflow.reviewCap, 5);
       assert.equal(oldAdmission.settings.skills.debugging, true);
       assert.equal(oldAdmission.settings.runtimeRecovery.enabled, false);
      const persisted = a.persistedConfig();
      assert.equal(persisted.defaultActive, false);
      assert.equal(persisted.workflow?.reviewCap, 2);
       assert.equal(persisted.roles?.["dsmm-planner"], true);
       assert.equal(persisted.skills?.debugging, false);
       assert.equal(persisted.runtimeRecovery?.enabled, true);
      assert.notEqual(readFileSync(a.patchPath, "utf8"), originalPatchA, "ConfigEditor must write the native profile patch");
      assert.equal(readFileSync(b.patchPath, "utf8"), originalPatchB, "a native save must not patch another profile");
      assert.equal(readFileSync(globalPath, "utf8"), globalBytes, "profile save must not write the shared global base");
      assert.equal(a.descriptor().revision, before.revision + 1);
    } finally {
      finish.release();
      await oldRoot.whenIdle();
      a.adapter.beforeStream = undefined;
      t.signal.removeEventListener("abort", finish.release);
    }
    assert.equal(a.adapter.calls.length, 1, "the busy request completes without cancellation/retry");
    assert.ok(oldRoot.session.snapshotEvents().some((event) => event.type === "assistant/message" && JSON.stringify(event.data).includes("fixture complete")), "the original request must actually finish");
    assert.ok(oldRoot.session.snapshotEvents().some((event) => event.type === "turn/end" && event.data.reason.kind === "completed"));

    const newRoot = await a.create();
    const newAdmission = a.runtime.admission(asDshAgent(newRoot));
    assert.notEqual(newAdmission.epoch, oldAdmission.epoch);
    assert.equal(newAdmission.settings.defaultActive, false);
     assert.equal(newAdmission.settings.workflow.reviewCap, 2);
     assert.equal(newAdmission.settings.skills.debugging, false);
     assert.equal(newAdmission.settings.runtimeRecovery.enabled, true);
    assert.equal(newAdmission.deployment?.profile.roles?.["dsmm-planner"], true);
    assert.equal(newAdmission.settings.roles["dsmm-planner"], false, "a desired role cannot conjure missing startup substrate");
    assert.deepEqual(newAdmission.restartRequired, ["roles.dsmm-planner"]);
    assert.notEqual(newAdmission.deployment?.nativeRevision, oldAdmission.deployment?.nativeRevision);
    assert.equal(newAdmission.deployment?.globalRevision, global.revision);
    assert.equal(newAdmission.deployment?.nativeFormRevision, a.descriptor().revision);
    assert.equal(newAdmission.deployment?.nativeNamespace, a.descriptor().ns);
    const beforeInherited = a.adapter.calls.length;
    await runFixtureTurn(inheritedRoot);
    assert.equal(a.adapter.calls.length, beforeInherited + 1);
    assert.ok(inheritedRoot.session.snapshotEvents().some(event => event.type === "turn/end" && event.data.reason.kind === "completed"));
    assert.match(JSON.stringify(a.adapter.calls.at(-1)?.messages), /DEEPWORK MODE ENABLED!/);
    await runFixtureTurn(newRoot);
    assert.equal(a.adapter.calls.length, beforeInherited + 2);
    assert.ok(newRoot.session.snapshotEvents().some(event => event.type === "turn/end" && event.data.reason.kind === "completed"));
    assert.doesNotMatch(JSON.stringify(a.adapter.calls.at(-1)?.messages), /DEEPWORK MODE ENABLED!/);

    for (const profile of [a, b]) {
      const descriptor = profile.descriptor();
      await profile.settings.mutate(descriptor.ns, [{ op: "unset", path: ["defaultActive"] }], descriptor.revision);
      profile.assertLive();
      assert.equal(Object.hasOwn(profile.persistedConfig(), "defaultActive"), false, "unset removes the native override, not just the live value");
      assert.equal(Object.hasOwn((await profile.deployment.readDesired()).profile, "defaultActive"), false);
      const nextRoot = await profile.create();
      const admission = profile.runtime.admission(asDshAgent(nextRoot));
      assert.equal(admission.settings.defaultActive, true, "native unset inherits the unchanged global true");
      assert.equal(admission.sources?.defaultActive, "global");
      assert.equal(admission.deployment?.globalRevision, global.revision);
    }
    assert.equal(a.runtime.admission(asDshAgent(oldRoot)), oldAdmission);
    assert.equal(b.runtime.admission(asDshAgent(oldB)), oldBAdmission);
    assert.equal(b.runtime.getSettings(asDshAgent(pinnedRoot)).defaultActive, false);
    assert.equal(a.runtime.admission(asDshAgent(newRoot)), newAdmission);
    assert.equal(readFileSync(globalPath, "utf8"), globalBytes);
    a.assertLive(); b.assertLive();
    t.diagnostic(`rc.2 ConfigEditor/SettingsForms: fibers=${a.fiber.uid},${b.fiber.uid}; native revisions=${a.descriptor().revision},${b.descriptor().revision}; DSMM lifecycle A=${JSON.stringify(a.lifecycle)}, B=${JSON.stringify(b.lifecycle)}; busy request completed; old/new root admissions and unavailable child admission verified`);
    // Include's forced empty-pending update can emit the compatibility signal
    // without updating or disposing a fiber. Assert the actual lifetime seam.
    a.assertLive(); b.assertLive();
    const liveRoots = a.ctx.agents.list();
    await assert.rejects(a.create(oldRoot), { code: "UNAUTHORIZED" }, "malformed native child headers cannot gain admission from parent lineage alone");
    assert.deepEqual(a.ctx.agents.list(), liveRoots, "failed child admission is rolled back without disposing its live parent");
    assert.equal(a.runtime.admission(asDshAgent(oldRoot)), oldAdmission);
    assert.equal(a.lifecycle.agentDisposals, 1, "only the rejected child is disposed");
    assert.equal(a.lifecycle.scopeDisposals, 0);
    assert.equal(a.lifecycle.updates, 0);
  } finally {
    await run.dispose();
    assert.equal(existsSync(run.root), false, "remove only this run's marked fixture tree");
  }
});

test("official native runtime supports Core off and on requests without an alternate owner", { timeout: 20_000 }, async () => {
  const run = nativeConfigRun({ stockRuntime: true });
  try {
    const roles = Object.fromEntries(DSMM_ROLE_IDS.map(id => [id, id === "dsmm-orchestrator"]));
    const off = await run.createProfile("core-off", { roles });
    const offRoot = await off.create();
    assert.ok(off.ctx.get("subagents") instanceof SubagentRuntime, "official stock runtime remains available without managed delivery");
    assert.equal(off.runtime.getSettings.subagentRuntime?.().binding, "stock");
    assert.equal(off.runtime.getSettings.subagentRuntime?.().deliveryFenceReady, true);
    const offAdmission = off.runtime.admission(asDshAgent(offRoot));
    await runFixtureTurn(offRoot);
    assert.equal(off.adapter.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(off.adapter.calls[0].messages), /DEEPWORK MODE ENABLED!/);
    assert.ok(offRoot.session.snapshotEvents().some(event => event.type === "turn/end" && event.data.reason.kind === "completed"));

    const on = await run.createProfile("no-delivery-on", { roles, defaultActive: true });
    assert.equal(on.runtime.getSettings().defaultActive, true);
    assert.equal(on.runtime.getSettings.subagentRuntime?.().binding, "stock");
    const onRoot = await on.create();
    await runFixtureTurn(onRoot);
    assert.equal(on.adapter.calls.length, 1);
    assert.match(JSON.stringify(on.adapter.calls[0].messages), /DEEPWORK MODE ENABLED!/);
    assert.equal(on.ctx.agents.get(onRoot.id), onRoot);
    assert.equal(off.runtime.admission(asDshAgent(offRoot)), offAdmission, "another profile must not alter the Core admission");
    assert.equal(off.ctx.agents.get(offRoot.id), offRoot);
    assert.equal(off.adapter.calls.length, 1);
  } finally {
    await run.dispose();
    assert.equal(existsSync(run.root), false, "remove only this run's marked fixture tree");
  }
});

test("rc.2 native settings refuses unknown, ordinary and raw-reference edits without changing DSMM config", { timeout: 20_000 }, async () => {
  const run = nativeConfigRun({ stockRuntime: true });
  try {
    const f = await run.createProfile("refusals");
    const descriptor = f.descriptor();
    const bytes = readFileSync(f.patchPath, "utf8");
    const desired = await f.deployment.readDesired();
    const rawRef = Reflect.get(f.fiber.config, "defaultActive");
    assert.equal(typeof rawRef.get, "function", "use the real Cordis volatile reference, not a fake raw value");
    for (const [path, value, error] of [
      [["unknown"], true, /not volatile/],
      [["modules", "deepwork", "enabled"], false, /not volatile/],
      [["modules"], { deepwork: { enabled: false } }, /not volatile/],
      [["sessionPersistence"], { root: join(f.dir, "must-not-be-mounted") }, /not volatile/],
      [["defaultActive"], rawRef, /Config .*contains/]
    ] as const) {
      await assert.rejects(f.settings.mutate(descriptor.ns, [{ op: "set", path: [...path], value }], descriptor.revision), error);
      assert.equal(readFileSync(f.patchPath, "utf8"), bytes);
      assert.deepEqual(await f.deployment.readDesired(), desired);
      assert.equal(f.descriptor().revision, descriptor.revision);
      f.assertLive();
      assert.equal(f.lifecycle.partialDisposes, 0);
    }
  } finally {
    await run.dispose();
    assert.equal(existsSync(run.root), false, "remove only this run's marked fixture tree");
  }
});
