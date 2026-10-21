import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRoleProfile, fixture, load, runDoc } from "./host-llm-review-fixture.mjs";

test("parameter projection reaches the official loop and stock defaults without sending disabled opaque fields", async t => {
  const { projectModelRouteParameters } = await import("../src/role-llm.ts");
  const { isAgentLoopRequest } = await load("@deepseek-ai/dsh-llm");
  for (const spelling of ["reasoningEffort", "reasoning_effort"]) await t.test(spelling, async t => {
    const requested = { provider: "apai", model: "gpt-6.1-sol", [spelling]: "medium", temperature: 0, maxTokens: 128,
      full: false, zero: 0, nil: null, nested: [[], {}, { flag: false }], customParameters: { originalName: true } };
    const saved = structuredClone(requested);
    const f = await fixture(t, { config: projectModelRouteParameters(requested, "dsmm-config", false), stockPrepared: true });
    assert.equal((await f.ctx.dsmmProfileRuntime.getSession(f.agent)).deepwork.active, true);
    await f.run("Use the native defaults for this isolated projected request");
    assert.equal(f.errors.length, 0, f.errors.map(error => error.stack).join("\n"));
    assert.equal(f.requests.filter(isAgentLoopRequest).length, 1);
    const projectedBodies = f.bodies.filter(body => body.temperature === 0 && body.max_tokens === 128);
    assert.equal(projectedBodies.length, 1);
    const body = projectedBodies[0];
    assert.equal(body.temperature, 0); assert.equal(body.max_tokens, 128);
    for (const sent of f.bodies) for (const key of ["reasoning_effort", "full", "zero", "nil", "nested", "customParameters"]) assert.equal(Object.hasOwn(sent, key), false);
    const header = f.agent.session.requestHeader();
    assert.equal(Object.hasOwn(header.config, "reasoningEffort"), false);
    assert.equal(Object.hasOwn(header.config, "customParameters"), false);
    assert.deepEqual(requested, saved);
  });
  await t.test("native standard-option refusal is preserved", async t => {
    const requested = { provider: "apai", model: "gpt-6.1-sol", reasoningEffort: "medium", stop: [], customParameters: false };
    const saved = structuredClone(requested);
    const f = await fixture(t, { config: projectModelRouteParameters(requested, "dsmm-config", false), stockPrepared: true });
    await f.run("Do not silently discard a native standard parameter");
    assert.equal(f.errors.length, 1);
    assert.equal(f.failures.at(-1)?.failure.code, "UNSUPPORTED_OPTION");
    assert.equal(f.bodies.length, 0);
    assert.deepEqual(requested, saved);
  });
});

test("raw alias fields and empty arrays keep their original JSON with native budget enforcement", async t => {
  const f = await fixture(t, { production: true, contextWindow: 32768 });
  const primary = { provider: "apai", model: "gpt-6.1-sol", reasoning_effort: "vendor-medium", max_tokens: 128, temperature: 0, stop: [],
    customParameters: false, full: false, zero: 0, nil: null, emptyObject: {}, nested: [[], {}, null, false, 0] };
  await applyRoleProfile(f, "raw-aliases", { primary, fallbackRoutes: [] });
  const call = await runDoc(f);
  assert.equal(call.result.stopReason, "completed", f.errors.map(error => error.stack).join("\n"));
  for (const [key, value] of Object.entries(primary)) if (key !== "provider") assert.deepEqual(f.bodies[0][key], value);
  assert.deepEqual(call.capture.invocation.initialRoute, primary);
  const before = f.bodies.length;
  await applyRoleProfile(f, "raw-over-budget", { primary: { ...primary, max_tokens: 32768 }, fallbackRoutes: [] });
  assert.equal((await runDoc(f)).result.stopReason, "error");
  assert.equal(f.bodies.length, before);
  await applyRoleProfile(f, "wrong-token-protocol", { primary: { provider: "apai", model: "gpt-6.1-sol", max_output_tokens: 128 }, fallbackRoutes: [] });
  assert.equal((await runDoc(f)).result.stopReason, "error");
  assert.equal(f.bodies.length, before);
});

test("native Root intent retains stock metadata and does not take the configured role primary under either policy", async t => {
  for (const passthrough of [true, false]) await t.test(String(passthrough), async t => {
    const controls = { production: true, nativeConfig: { provider: "apai", model: "gpt-5.6-terra", reasoningEffort: "medium", temperature: 0, maxTokens: 128 },
      dsmm: { modelParameters: { passthrough }, roleRouting: { "dsmm-orchestrator": { primary: { provider: "apai", model: "gpt-6.1-sol", reasoningEffort: "medium", role_only: false } } } } };
    const f = await fixture(t, controls);
    await f.run("Native explicit unsupported effort must stay native");
    assert.equal(f.bodies.length, 0);
    assert.equal(f.errors.length, 1);
    delete controls.nativeConfig.reasoningEffort;
    await f.run("Native omitted effort uses stock defaults");
    const body = f.bodies.findLast(body => body.temperature === 0 && body.max_tokens === 128);
    assert.ok(body);
    assert.equal(body.model, "gpt-5.6-terra");
    assert.equal(Object.hasOwn(body, "reasoning_effort"), false);
    assert.equal(Object.hasOwn(body, "role_only"), false);
    const agents = f.ctx.agents.list();
    await assert.rejects(f.ctx.subagents.startActivation({ provider: "dsmm-role-doc-search", label: "Unsupported native effort", delivery: "caller",
      request: { parent: f.agent, prompt: [], agentOptions: { provider: "apai", model: "gpt-6.1-sol", reasoningEffort: "medium" } }, signal: new AbortController().signal }));
    assert.deepEqual(f.ctx.agents.list(), agents);
  });
});

test("raw completions keeps stock default and near-context output budgets", async t => {
  for (const tokenField of ["max_tokens", "max_completion_tokens"]) await t.test(tokenField, async t => {
    const f = await fixture(t, { contextWindow: 32768, tokenField, config: { customParameters: { w1_budget_probe: true } } });
    const budgets = [];
    for (const text of ["implicit model budget", `near context budget ${"budget ".repeat(4000)}`]) {
      const start = f.bodies.length;
      await f.run(text);
      assert.deepEqual(f.errors, []);
      const request = f.requests.findLast(request => request.sessionId === f.agent.id);
      assert.ok(request);
      const raw = f.bodies.slice(start).find(body => body.w1_budget_probe === true);
      assert.equal(f.agent.session.requestHeader().config.maxTokens, undefined);
      const referenceStart = f.bodies.length;
      // Reference translation uses the exact native request emitted by the official loop.
      for await (const _chunk of f.ready.provider.stockAdapter.stream(request)) { /* drain the public adapter */ }
      const stock = f.bodies.slice(referenceStart).find(body => JSON.stringify(body.messages) === JSON.stringify(raw.messages));
      assert.ok(Number.isInteger(stock[tokenField]));
      assert.equal(raw[tokenField], stock[tokenField]);
      assert.ok(raw[tokenField] > 0 && raw[tokenField] <= 32768);
      budgets.push(raw[tokenField]);
    }
    assert.ok(budgets[1] < budgets[0], JSON.stringify(budgets));
  });
});
