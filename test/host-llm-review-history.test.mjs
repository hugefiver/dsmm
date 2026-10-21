import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { applyRoleProfile, fixture } from "./host-llm-review-fixture.mjs";

test("historical v1 cold restore keeps native effort validation and original evidence under either current flag", async t => {
  for (const passthrough of [true, false]) for (const effort of [undefined, "medium"]) await t.test(`${passthrough}/${effort ?? "default"}`, async t => {
    const f = await fixture(t, { production: true, dsmm: { subagents: { enableRunInBackground: true, backgroundMode: "continuable" } } });
    const primary = { provider: "apai", model: "gpt-5.6-terra", ...(effort === undefined ? {} : { reasoningEffort: effort }) };
    await applyRoleProfile(f, "historical", { primary, fallbackRoutes: [] });
    const created = Promise.withResolvers(), retired = Promise.withResolvers();
    f.ctx.on("agent/created", ({ agent }) => { if (agent !== f.agent) created.resolve(agent); }, { global: true });
    f.ctx.on("agent/disposed", ({ agent }) => { if (agent !== f.agent) retired.resolve(); }, { global: true });
    const activation = await f.ctx.subagents.startActivation({ provider: "dsmm-role-doc-search", label: "Historical native role", delivery: "parent",
      request: { parent: f.agent, prompt: [{ type: "text", text: "Prepare the isolated native session fixture" }] }, signal: new AbortController().signal });
    f.activations.add(activation);
    const child = await created.promise;
    await child.whenIdle(); await activation.dispose(); await retired.promise; await f.agent.whenIdle();
    const store = f.ctx.dsmmProfileRuntime.childCaptureStore;
    const original = await store.readChildAdmission(child.id, f.agent.id);
    const { modelParameterPolicy: _policy, invocation: { requestedRoute: _requested, effortSource: _source, ...invocation }, ...base } = original;
    const historical = { ...base, version: 1, invocation,
      profilePin: base.profilePin === null ? null : { ...base.profilePin, revision: "a".repeat(64) },
      runtimePolicyCapture: { ...base.runtimePolicyCapture, deepseekV4ProCalibration: "auto", deepseekV4ProDefaultReasoningEffort: "low", deepseekFlashCalibration: "strict", deepseekFlashDefaultReasoningEffort: "high" } };
    const digest = value => createHash("sha256").update(value).digest("hex");
    const path = join(store.stateDir, ".children", "v1", `${digest(child.id)}.json`);
    const historicalBytes = JSON.stringify({ version: 1, revision: digest(JSON.stringify(historical)), capture: historical });
    await f.agent.whenIdle();
    await applyRoleProfile(f, "current", { primary: { provider: "apai", model: "gpt-5.6-luna" }, fallbackRoutes: [] },
      { modelParameters: { passthrough } });
    // Seed an old-format record only while the isolated fixture Host is stopped.
    await f.restart(async () => {
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")).capture, original);
      await writeFile(path, historicalBytes);
    });
    const resumed = Promise.withResolvers(), disposed = Promise.withResolvers();
    f.ctx.on("agent/created", ({ agent }) => { if (agent.id === child.id) resumed.resolve({ agent, admission: f.ctx.dsmmProfileRuntime.admission(agent) }); }, { global: true });
    f.ctx.on("agent/disposed", ({ agent }) => { if (agent.id === child.id) disposed.resolve(); }, { global: true });
    const before = f.bodies.filter(body => body.model === primary.model).length;
    await f.ctx.subagents.sendMessage(f.agent, child.id, [{ type: "text", text: "Resume historical native behavior" }], { signal: new AbortController().signal });
    const { agent: cold, admission } = await resumed.promise;
    await cold.whenIdle(); await disposed.promise; await f.agent.whenIdle();
    assert.equal(f.bodies.filter(body => body.model === primary.model).length, before + (effort === undefined ? 1 : 0));
    const { resolvedModelParameterPolicy } = await import("../src/model-parameter-policy.ts");
    assert.equal(resolvedModelParameterPolicy(admission).mode, "legacy-native-v1");
    assert.equal(admission.settings.roleRouting["dsmm-doc-search"].primary.reasoningEffort, effort);
    assert.deepEqual(admission.childCapture, historical);
    assert.equal(await readFile(path, "utf8"), historicalBytes);
  });
});
