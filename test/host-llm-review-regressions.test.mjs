import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRoleProfile, fixture, load, runDoc, startDoc } from "./host-llm-review-fixture.mjs";

test("admitted preparation failure cannot fall through to a working stock adapter", async t => {
  let absent;
  const controls = { generation: generation => absent === undefined ? generation : { ...generation, async prepareCall() { throw absent; } } };
  const f = await fixture(t, controls);
  absent = new f.LlmError("generation was removed", "NO_ADAPTER");
  await f.run("admitted missing generation");
  assert.equal(f.bodies.length, 0);
  assert.equal(f.agent.session.requestHeader(), undefined);
  assert.notEqual(f.errors[0]?.code, "NO_ADAPTER");
  assert.equal(f.errors[0]?.cause, absent);
  await f.mode(false);
  await f.run("stock owner still works");
  assert.ok(f.bodies.length > 0);
  absent = undefined;
  await f.mode(true);
  await f.run("authorized prepared request");
  const request = f.requests.findLast(request => request.sessionId === f.agent.id);
  assert.ok(request);
  const count = f.bodies.length;
  assert.throws(() => f.ready.llm.stream(request), { code: "INVALID_PREPARED_CALL" });
  assert.equal(f.bodies.length, count);
  await f.mode(false);
  controls.nativeConfig = { provider: "unregistered-native-provider", model: "native-model" };
  await f.run("native unprepared adapter failure");
  assert.equal(f.agent.session.requestHeader().config.provider, "unregistered-native-provider");
  assert.equal(f.failures.at(-1)?.failure.code, "NO_ADAPTER");
  assert.equal(f.bodies.length, count);
});

test("finite absence uses ordered full-value routes while provider refusal never selects a fallback", async t => {
  let credential = "fictional-only";
  const f = await fixture(t, { production: true, resolveApiKey: async (provider, reference) => {
    assert.equal(provider, "apai"); assert.equal(reference, "DSMM_W1_REVIEW_FICTIONAL"); return credential;
  }, status: body => body.route_marker === "bad-request" ? 400 : 200 });
  const primary = { provider: "apai", model: "gpt-6.1-sol", reasoningEffort: "medium", primary_only: false };
  const terra = { provider: "apai", model: "gpt-5.6-terra", reasoningEffort: "high", route_marker: "terra", raw_zero: 0 };
  const luna = { provider: "apai", model: "gpt-5.6-luna", reasoningEffort: "high", route_marker: "luna", raw_null: null };
  for (const [id, policy, expected] of [
    ["absent-provider", { primary: { ...primary, provider: "missing-provider" }, fallbackRoutes: [terra, luna] }, terra],
    ["absent-model", { primary: { ...primary, model: "missing-model" }, fallbackRoutes: [{ ...terra, model: "also-missing" }, luna] }, luna],
  ]) {
    const before = f.bodies.length;
    await applyRoleProfile(f, id, policy);
    assert.equal(f.bodies.length, before);
    const call = await runDoc(f);
    assert.equal(call.result.stopReason, "completed", f.errors.map(error => error.stack).join("\n"));
    assert.equal(f.bodies.length, before + 1);
    assert.deepEqual(call.capture.invocation.initialRoute, expected);
    assert.equal(f.bodies.at(-1).model, expected.model);
    assert.equal(f.bodies.at(-1).reasoning_effort, "high");
    assert.equal(f.bodies.at(-1).route_marker, expected.route_marker);
    assert.equal(Object.hasOwn(f.bodies.at(-1), "primary_only"), false);
  }
  const before = f.bodies.length;
  await applyRoleProfile(f, "bad-request", { primary: { ...primary, route_marker: "bad-request" }, fallbackRoutes: [terra, luna] });
  assert.equal((await runDoc(f)).result.stopReason, "error");
  assert.equal(f.bodies.length, before + 1);
  assert.equal(f.bodies.at(-1).model, primary.model);
  credential = undefined;
  await applyRoleProfile(f, "no-credential", { primary, fallbackRoutes: [terra, luna] });
  const denied = await runDoc(f);
  assert.equal(denied.result.stopReason, "error");
  assert.deepEqual(denied.capture.invocation.initialRoute, primary);
  assert.equal(f.bodies.length, before + 1);
  const admission = f.ctx.dsmmProfileRuntime.admission(f.agent);
  await applyRoleProfile(f, "all-absent", { primary: { ...primary, provider: "absent" }, fallbackRoutes: [{ ...terra, model: "absent" }] });
  assert.notEqual(f.ctx.dsmmProfileRuntime.admission(f.agent), admission);
  await assert.rejects(runDoc(f));
  assert.equal(f.bodies.length, before + 1);
  credential = "fictional-only";
  const { LlmAdapter } = await load("@deepseek-ai/dsh-llm");
  const unavailable = new f.LlmError("Registered adapter is not ready", "NO_ADAPTER");
  const remove = f.ctx.llm.registerAdapter(["unready-provider"], new class extends LlmAdapter {
    async resolveModel() { throw unavailable; }
    async *stream() { throw new Error("Unready adapter must not stream"); }
  }());
  t.after(remove);
  await applyRoleProfile(f, "unready-provider", { primary: { provider: "unready-provider", model: "declared" }, fallbackRoutes: [terra] });
  const accepted = f.ctx.dsmmProfileRuntime.admission(f.agent);
  await assert.rejects(runDoc(f), { code: "NO_ADAPTER" });
  const { selectInitialModelRoute } = await import("../src/role-routing.ts");
  await assert.rejects(selectInitialModelRoute(f.ctx.llm, [{ provider: "unready-provider", model: "declared" }, terra]), { code: "NO_ADAPTER" });
  assert.equal(f.ctx.dsmmProfileRuntime.admission(f.agent), accepted);
  assert.equal(f.bodies.length, before + 1);
});

test("parameter-only fallback is distinct and uses the existing native rate-limit strategy", async t => {
  const f = await fixture(t, { production: true, status: body => body.route_marker === "first" ? 429 : 200 });
  const primary = { provider: "apai", model: "gpt-6.1-sol", reasoningEffort: "medium", route_marker: "first", primary_only: false };
  const fallback = { provider: "apai", model: "gpt-6.1-sol", reasoningEffort: "medium", route_marker: "second", customParameters: { value: null } };
  await applyRoleProfile(f, "same-endpoint", { primary, fallbackRoutes: [fallback], strategy: "rate-limit-fallback",
    rateLimit: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0, maxTotalDelayMs: 0, switchAfterRateLimits: 1, maxSwitches: 1 } });
  const call = await runDoc(f);
  assert.equal(call.result.stopReason, "completed", f.errors.map(error => error.stack).join("\n"));
  assert.deepEqual(f.bodies.map(body => body.route_marker), ["first", "second"]);
  assert.equal(Object.hasOwn(f.bodies[1], "primary_only"), false);
  assert.deepEqual(f.bodies[1].customParameters, fallback.customParameters);
  assert.deepEqual(call.capture.runtimePolicyCapture.roleRouting["dsmm-doc-search"].fallbackRoutes, [fallback]);
  await f.restart();
  const observation = await f.ctx.sessionQuery.observeSession(call.capture.childSessionId, { signal: new AbortController().signal, projectionMode: "none" });
  try {
    const headers = observation.events.slice(observation.inheritedEventCount).filter(event => event.type === "request/header");
    assert.equal(headers[0].data.header.config.customParameters.route_marker, "first");
    assert.equal(headers.at(-1).data.header.config.customParameters.route_marker, "second");
    assert.deepEqual(headers.at(-1).data.header.config.customParameters.customParameters, fallback.customParameters);
  } finally { observation[Symbol.dispose](); }
});

test("OFF keeps distinct configured fallback positions even when disabled parameters produce the same wire body", async t => {
  let calls = 0;
  const f = await fixture(t, { production: true, status: () => ++calls <= 2 ? 429 : 200 });
  const primary = { provider: "apai", model: "gpt-6.1-sol", reasoningEffort: "medium", temperature: 0, maxTokens: 128, candidate: "first" };
  const fallbacks = [{ ...primary, candidate: "second" }, { ...primary, candidate: "third" }];
  await applyRoleProfile(f, "off-chain", { primary, fallbackRoutes: fallbacks, strategy: "rate-limit-fallback",
    rateLimit: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0, maxTotalDelayMs: 0, switchAfterRateLimits: 1, maxSwitches: 2 } }, { modelParameters: { passthrough: false } });
  const result = await runDoc(f);
  assert.equal(result.result.stopReason, "completed", f.errors.map(error => error.stack).join("\n"));
  assert.equal(f.bodies.length, 3);
  for (const body of f.bodies) { assert.equal(Object.hasOwn(body, "candidate"), false); assert.equal(Object.hasOwn(body, "reasoning_effort"), false); assert.equal(body.max_tokens, 128); }
  assert.deepEqual(result.capture.runtimePolicyCapture.roleRouting["dsmm-doc-search"].fallbackRoutes, fallbacks);
});

test("owned raw routes activate through both profile Apply scopes without completion", async t => {
  for (const scope of ["default", "session"]) await t.test(scope, async t => {
    const response = Promise.withResolvers();
    const f = await fixture(t, { production: true, disableNativeBash: true, dsmm: { guards: { gitWriteGuard: "deny" } },
      beforeRespond: () => response.promise, cleanup: () => response.resolve() });
    const runtime = f.ctx.get("dsmmProfileRuntime");
    const primary = { provider: "apai", model: "gpt-6.1-sol", reasoningEffort: "medium", full: false, zero: 0, nil: null,
      nested: [[], {}, { flag: false }], customParameters: { keepOriginalName: true } };
    const saved = await runtime.save({ id: "raw-profile", expectedRevision: null, content: JSON.stringify({ version: 1, id: "raw-profile",
      settings: { roleRouting: { "dsmm-orchestrator": { primary }, "dsmm-doc-search": { primary } } } }) });
    const old = runtime.admission(f.agent), global = await runtime.describe(), session = await runtime.getSession(f.agent);
    assert.equal((await f.ctx.llm.resolveModelInfo(primary.provider, primary.model)).reasoning, undefined);
    const { selectInitialModelRoute } = await import("../src/role-routing.ts");
    await assert.rejects(selectInitialModelRoute(f.ctx.llm, [{ provider: primary.provider, model: primary.model, full: false }]), { code: "UNSUPPORTED_ROUTE_PARAMETERS" });
    if (scope === "default") {
      await runtime.select({ id: saved.id, expectedRevision: saved.revision, expectedSelectionRevision: global.selectionRevision });
      assert.equal(runtime.admission(f.agent), old);
      assert.deepEqual(runtime.admission().settings.roleRouting["dsmm-doc-search"].primary, primary);
    } else {
      const applied = await runtime.selectSession({ sessionId: f.agent.id, id: saved.id, expectedRevision: saved.revision,
        expectedSelectionRevision: session.selection.selectionRevision, expectedAdmissionEpoch: session.admissionEpoch }, f.agent);
      assert.deepEqual(applied.profileModel, primary);
      assert.equal((await runtime.describe()).selectionRevision, global.selectionRevision);
    }
    assert.equal(f.bodies.length, 0);
    let executed = 0;
    assert.equal(f.ctx.tools.get("bash"), undefined, "the isolated git probe must never execute a real shell");
    const unregister = f.ctx.tools.register({ name: "bash", description: "Isolated command stub", parameters: { command: { type: "string", required: true } },
      output: { schema: { type: "string" }, render: () => [{ type: "text", text: "stub" }] }, async execute() { executed++; return "stub"; } });
    t.after(unregister);
    const { ToolCallId } = await load("@deepseek-ai/dsh-llm");
    const gitDenied = await f.ctx.tools.execute({ name: "bash", callId: ToolCallId("dsmm-w2-core-git"), arguments: { command: "git commit -m isolated-stub" }, agent: f.agent, signal: new AbortController().signal });
    assert.equal(gitDenied.isError, true);
    assert.equal(executed, 0);
    const parent = scope === "default" ? await f.createRoot("dsmm-w2-new-root") : f.agent;
    assert.deepEqual(runtime.admission(parent).settings.roleRouting["dsmm-doc-search"].primary, primary);
    const { run, agent } = await startDoc(f, { parent, prompt: [{ type: "text", text: "Read the isolated documentation response" }] });
    try {
      assert.equal(f.ctx.agents.isOwnedBy(agent.id, parent), true);
      const capture = runtime.admission(agent).childCapture;
      assert.deepEqual(capture.invocation.initialRoute, primary);
      assert.equal(capture.authorityCeiling.readOnly, true);
      const denied = await agent.ctx.tools.execute({ name: "dsmm_role", callId: ToolCallId("dsmm-w2-child-escalation"), arguments: { role: "dsmm-orchestrator", description: "invalid escalation", prompt: "must not run" }, agent, signal: new AbortController().signal });
      assert.equal(denied.isError, true);
      const writeDenied = await agent.ctx.tools.execute({ name: "bash", callId: ToolCallId("dsmm-w2-child-write"), arguments: { command: "echo isolated-stub" }, agent, signal: new AbortController().signal });
      assert.equal(writeDenied.isError, true);
      assert.equal(executed, 0);
      response.resolve();
      assert.equal((await run.result).stopReason, "completed", f.errors.map(error => error.stack).join("\n"));
      const body = f.bodies.at(-1);
      assert.equal(body.model, primary.model);
      assert.equal(body.reasoning_effort, "medium");
      for (const key of ["full", "zero", "nil", "nested", "customParameters"]) assert.deepEqual(body[key], primary[key]);
      assert.equal(agent.session.requestHeader().config.reasoningEffort, "medium");
      assert.deepEqual(agent.session.requestHeader().config.customParameters.customParameters, primary.customParameters);
    } finally { response.resolve(); await run.dispose(); }
  });
});
