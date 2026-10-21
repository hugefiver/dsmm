import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRoleProfile, fixture, runDoc } from "./host-llm-review-fixture.mjs";

for (const passthrough of [true, false]) test(`fresh Host continuation retains captured parameter policy ${passthrough} after its parent changes profile`, async t => {
  const f = await fixture(t, { production: true, dsmm: { subagents: { enableRunInBackground: true, backgroundMode: "continuable", allowRouteOverride: true } } });
  const primary = { provider: "apai", model: "gpt-6.1-sol", reasoningEffort: "medium", temperature: 0, maxTokens: 128, route_marker: "original", customParameters: [false, 0, null, {}] };
  await applyRoleProfile(f, "capture-a", { primary, fallbackRoutes: [] }, { modelParameters: { passthrough } });
  const isChildBody = body => body.model === primary.model && body.temperature === 0 && body.max_tokens === 128;
  const created = new Map(), disposed = new Map();
  f.ctx.on("agent/created", ({ agent }) => {
    if (agent === f.agent) return;
    created.set(agent.id, agent); disposed.set(agent.id, Promise.withResolvers());
  }, { global: true });
  f.ctx.on("agent/disposed", ({ agent }) => disposed.get(agent.id)?.resolve(), { global: true });
  const receipt = await f.ctx.subagents.startActivation({ provider: "dsmm-role-doc-search", label: "Original route capture", delivery: "parent",
    request: { parent: f.agent, prompt: [{ type: "text", text: "First durable documentation request" }] }, signal: new AbortController().signal });
  f.activations.add(receipt);
  const child = created.get(receipt.childId);
  assert.ok(child);
  assert.equal((await receipt.result).stopReason, "completed");
  await receipt.dispose();
  await disposed.get(child.id).promise;
  assert.ok(f.bodies.some(isChildBody));
  const originalHeader = child.session.requestHeader();
  const captureA = await f.ctx.dsmmProfileRuntime.childCaptureStore.readChildAdmission(child.id, f.agent.id);
  assert.equal(captureA.version, 3);
  assert.deepEqual(captureA.invocation.requestedRoute, primary);
  assert.equal(captureA.modelParameterPolicy.mode, passthrough ? "passthrough" : "native-defaults");
  const replacement = { provider: "apai", model: "gpt-5.6-terra", reasoningEffort: "high", route_marker: "new-parent", new_only: true };
  await f.agent.whenIdle();
  await applyRoleProfile(f, "capture-b", { primary: replacement, fallbackRoutes: [] }, { modelParameters: { passthrough: !passthrough } });
  await f.restart();
  const resumed = Promise.withResolvers(), retired = Promise.withResolvers();
  f.ctx.on("agent/created", ({ agent }) => { if (agent.id === child.id) resumed.resolve(agent); }, { global: true });
  f.ctx.on("agent/disposed", ({ agent }) => { if (agent.id === child.id) retired.resolve(); }, { global: true });
  const before = f.bodies.filter(isChildBody).length;
  await f.ctx.subagents.sendMessage(f.agent, child.id, [{ type: "text", text: "Resume the original captured documentation route" }], { signal: new AbortController().signal });
  const cold = await resumed.promise;
  assert.notEqual(cold, child);
  await cold.whenIdle(); await retired.promise;
  await f.agent.whenIdle();
  const body = f.bodies.findLast(isChildBody);
  assert.equal(f.bodies.filter(isChildBody).length, before + 1, f.errors.map(error => error.stack).join("\n"));
  assert.equal(body.model, primary.model);
  assert.equal(body.reasoning_effort, passthrough ? primary.reasoningEffort : undefined);
  assert.deepEqual(body.customParameters, passthrough ? primary.customParameters : undefined);
  assert.equal(Object.hasOwn(body, "new_only"), false);
  assert.deepEqual(await f.ctx.dsmmProfileRuntime.childCaptureStore.readChildAdmission(child.id, f.agent.id), captureA);
  assert.deepEqual(child.session.requestHeader(), originalHeader);
});

test("real role requests use immutable OFF policy for both effort aliases and keep stored JSON", async t => {
  const f = await fixture(t, { production: true });
  for (const effort of [{ reasoningEffort: "medium" }, { reasoning_effort: "vendor-medium" }]) {
    const primary = { provider: "apai", model: "gpt-6.1-sol", ...effort, temperature: 0, maxTokens: 128,
      flag: false, zero: 0, nil: null, nested: [[], {}, null, false], customParameters: { retained: false } };
    await applyRoleProfile(f, Object.hasOwn(effort, "reasoningEffort") ? "off-camel" : "off-raw", { primary, fallbackRoutes: [] }, { modelParameters: { passthrough: false } });
    const result = await runDoc(f);
    assert.equal(result.result.stopReason, "completed", f.errors.map(error => error.stack).join("\n"));
    assert.deepEqual(result.capture.invocation.requestedRoute, primary);
    assert.equal(result.capture.modelParameterPolicy.mode, "native-defaults");
    assert.deepEqual(result.capture.runtimePolicyCapture.roleRouting["dsmm-doc-search"].primary, primary);
    const body = f.bodies.at(-1);
    assert.equal(body.temperature, 0); assert.equal(body.max_tokens, 128);
    for (const field of ["reasoning_effort", "flag", "zero", "nil", "nested", "customParameters"]) assert.equal(Object.hasOwn(body, field), false);
    assert.equal(result.header.config.reasoningEffort, undefined);
    assert.equal(result.header.config.customParameters, undefined);
  }
});
