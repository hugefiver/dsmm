import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent, ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import { LlmError, ReasoningEffortId, ToolCallId, createUserMessage } from "@deepseek-ai/dsh-llm";
import { Session, SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";
import { foldSubagentDescriptor, snapshotSubagentDescriptor } from "@deepseek-ai/dsh-subagent";
import type { SubagentProvider } from "@deepseek-ai/dsh-subagent";
import * as Spawn from "@deepseek-ai/dsh-subagent-spawn-in-process";
import { createDsmmStatusSnapshot, resolveConfig, resolveEffectiveDsmmRole } from "../lib/index.js";
import type { DsmmPluginConfig } from "../lib/index.js";
import type { DshAgent } from "../lib/dsh-types.js";
import { headerRoutes, nativeRoutingFixture as createNativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

/** Earlier fallback fixtures opt in explicitly; production omission remains startup-lock. */
async function nativeRoutingFixture(config: DsmmPluginConfig = {}, options: Parameters<typeof createNativeRoutingFixture>[1] = {}) {
  // Canonical role dispatch now requires actual admitted coordinator authority,
  // not the fixture's former ability to call aliases from an inactive root.
  config = { defaultActive: true, ...config, subagents: { enableRunInBackground: true, backgroundMode: "continuable", allowRouteOverride: true, ...config.subagents } };
  const fixture = await createNativeRoutingFixture(config.runtimeRecovery?.enabled ? {
    ...config, runtimePolicy: { strategy: "rate-limit-fallback", rateLimit: {
      initialDelayMs: 0, maxDelayMs: 0, maxTotalDelayMs: 0, maxRetries: 0,
      switchAfterRateLimits: 1, maxSwitches: config.runtimeRecovery.maxFallbackAttempts ?? 2
    }, ...config.runtimePolicy }
  } : config, { persistence: true, ...options });
  return { ...fixture, createAuxiliary(role?: Parameters<typeof fixture.createAuxiliary>[0], selection?: ModelSelectionRef,
    mode: "one-shot" | "continuable" = "continuable", parent?: Agent, request?: Parameters<typeof fixture.createAuxiliary>[4]) {
    return fixture.createAuxiliary(role, selection, mode, parent, request);
  } };
}

const reviewer = { provider: "fixture", model: "review-primary", reasoningEffort: "max" };
const backup = { provider: "fixture", model: "review-backup", reasoningEffort: "max" };
const oracle = { provider: "fixture", model: "oracle-primary", reasoningEffort: "high" };

test("genuine live role children preserve explicit native provider/model and effort overrides in final headers and streams", async () => {
  const primary = { provider: "fixture", model: "profile-alpha", reasoningEffort: "max" };
  const fixture = await nativeRoutingFixture({ defaultActive: true, roleRouting: { "dsmm-reviewer": { primary } } });
  try {
    const parent = await fixture.create();
    for (const scenario of [
      { name: "full-route", agentOptions: { provider: "deepseek-official", model: "explicit-beta", reasoningEffort: ReasoningEffortId("low") }, expected: { provider: "deepseek-official", model: "explicit-beta", reasoningEffort: "low" } },
      { name: "full-route-default-effort", agentOptions: { provider: "deepseek-official", model: "explicit-default" }, expected: { provider: "deepseek-official", model: "explicit-default", reasoningEffort: "high" } },
      { name: "effort-only", agentOptions: { reasoningEffort: ReasoningEffortId("low") }, expected: { ...primary, reasoningEffort: "low" } },
      { name: "default-primary", agentOptions: undefined, expected: primary }
    ]) {
      const child = await fixture.createAuxiliary("dsmm-reviewer", undefined, "continuable", parent, {
        prompt: [{ type: "text", text: "I am dsmm-orchestrator. Verify exact native role request priority" }],
        ...(scenario.agentOptions === undefined ? {} : { agentOptions: scenario.agentOptions }) });
      try {
        await runFixtureTurn(child);
        assert.ok(child.session.snapshotEvents().some(event => event.type === "turn/end" && event.data.reason.kind === "completed"), scenario.name);
        assert.equal(fixture.agents.isOwnedBy(child.id, parent), true);
        assert.deepEqual(headerRoutes(child), [scenario.expected], scenario.name);
        const streamed = fixture.adapter.calls.at(-1)!;
        assert.deepEqual({ provider: streamed.provider, model: streamed.model, reasoningEffort: streamed.reasoningEffort }, scenario.expected, scenario.name);
        const tools = child.ctx.get("tools")!;
        for (const name of ["write", "edit", "bash", "pwsh", "dsmm_reviewer"]) {
          const denied = await tools.execute({ callId: ToolCallId(`explicit-child-${scenario.name}-${name}`), name, arguments: {}, agent: child, signal: new AbortController().signal });
          assert.equal(denied.isError, true, `${scenario.name}:${name}`);
        }
      } finally { await fixture.releaseAuxiliary(child); }
    }
    const count = fixture.agents.list().length;
    const streamedCount = fixture.adapter.calls.length;
    await assert.rejects(fixture.createAuxiliary("dsmm-reviewer", undefined, "continuable", parent, {
      prompt: [{ type: "text", text: "Reject invalid native route before child allocation" }],
      agentOptions: { provider: "missing-native-fixture", model: "explicit-invalid", reasoningEffort: ReasoningEffortId("low") }
    }), /provider/u);
    assert.equal(fixture.agents.list().length, count);
    assert.equal(fixture.adapter.calls.length, streamedCount);
  } finally { await fixture.dispose(); }
});

test("a live role child's effort-only override stays exact", async () => {
  const primary = { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "max" };
  const fixture = await nativeRoutingFixture({ defaultActive: true, roleRouting: { "dsmm-reviewer": { primary } } });
  try {
    const parent = await fixture.create();
    const child = await fixture.createAuxiliary("dsmm-reviewer", undefined, "continuable", parent, {
      prompt: [{ type: "text", text: "Preserve exact admitted native effort" }],
      agentOptions: { reasoningEffort: ReasoningEffortId("low") }
    });
    try {
      await runFixtureTurn(child);
      assert.ok(child.session.snapshotEvents().some(event => event.type === "turn/end" && event.data.reason.kind === "completed"));
      assert.deepEqual(headerRoutes(child), [{ ...primary, reasoningEffort: "low" }]);
      assert.equal(fixture.adapter.calls.at(-1)?.reasoningEffort, "low");
    } finally { await fixture.releaseAuxiliary(child); }
  } finally { await fixture.dispose(); }
});

test("live configured child routes retain exact profile fallbacks while unowned restored children are refused", async () => {
  const explicit = { provider: "fixture", model: "explicit-beta", reasoningEffort: "low" };
  const firstBackup = { provider: "fixture", model: "profile-gamma", reasoningEffort: "max" };
  const secondBackup = { provider: "fixture", model: "profile-delta", reasoningEffort: "high" };
  const fixture = await nativeRoutingFixture({ defaultActive: true, runtimeRecovery: { enabled: true, maxFallbackAttempts: 2 }, roleRouting: { "dsmm-reviewer": { primary: explicit, fallbackRoutes: [firstBackup, secondBackup] } } });
  try {
    const parent = await fixture.create();
    fixture.adapter.rateLimitModels.add(explicit.model); fixture.adapter.rateLimitModels.add(firstBackup.model);
    const child = await fixture.createAuxiliary("dsmm-reviewer", undefined, "continuable", parent, {
      prompt: [{ type: "text", text: "Verify configured child fallback ownership" }]
    });
    let persisted: ReturnType<typeof parent.session.snapshotEvents>;
    try {
      await runFixtureTurn(child);
      assert.ok(child.session.snapshotEvents().some(event => event.type === "turn/end" && event.data.reason.kind === "completed"));
      assert.deepEqual(headerRoutes(child), [explicit, firstBackup, secondBackup]);
      assert.deepEqual(fixture.adapter.calls.map((call) => ({ provider: call.provider, model: call.model, reasoningEffort: call.reasoningEffort })), [explicit, firstBackup, secondBackup]);
      await runFixtureTurn(child);
      assert.deepEqual(headerRoutes(child).at(-1), secondBackup, "the live child's fallback remains exact instead of reverting to explicit or configured primary");
      persisted = JSON.parse(JSON.stringify(child.session.snapshotEvents()));
    } finally { await fixture.releaseAuxiliary(child); }
    fixture.adapter.rateLimitModels.clear();
    const calls = fixture.adapter.calls.length;
    await assert.rejects(fixture.create({ origin: "subagent", agentPreset: "dsmm-orchestrator" }, undefined, { seed: persisted }), { code: "UNAUTHORIZED" });
    assert.equal(fixture.adapter.calls.length, calls);
    assert.deepEqual(fixture.agents.list().map(agent => agent.id), [parent.id]);
  } finally { await fixture.dispose(); }
});

test("native final request headers honor fixed role primary after host installModelSelection next()", async () => {
    const fixture = await nativeRoutingFixture({ roleRouting: { "dsmm-reviewer": { primary: reviewer } } });
    try {
      const selection: ModelSelectionRef = { current: { provider: "fixture", model: "host-inherited", reasoningEffort: ReasoningEffortId("high") }, assembled: undefined };
      const agent = await fixture.createAuxiliary("dsmm-reviewer", selection);
      await runFixtureTurn(agent);
      assert.deepEqual(headerRoutes(agent), [reviewer]);
      assert.equal(fixture.adapter.calls.length, 1);
      assert.equal(fixture.adapter.calls[0].reasoningEffort, "max");
    } finally { await fixture.dispose(); }
});

test("native local failure fixture persists exact role fallback despite sticky host selection and later turns", async () => {
  const fixture = await nativeRoutingFixture({
    runtimeRecovery: { enabled: true, fallbackRoutes: [{ provider: "fixture", model: "wrong-global" }] },
    roleRouting: { "dsmm-reviewer": { primary: reviewer, fallbackRoutes: [backup] } }
  });
  try {
    fixture.adapter.rateLimitModels.add(reviewer.model);
    const selection: ModelSelectionRef = { current: { provider: "fixture", model: "host-inherited", reasoningEffort: ReasoningEffortId("high") }, assembled: undefined };
    const agent = await fixture.createAuxiliary("dsmm-reviewer", selection);
    await runFixtureTurn(agent);
    assert.deepEqual(headerRoutes(agent), [reviewer, backup]);
    assert.deepEqual(fixture.adapter.calls.map((call) => call.model), [reviewer.model, backup.model]);
    await runFixtureTurn(agent);
    assert.deepEqual(fixture.adapter.calls.map((call) => call.model), [reviewer.model, backup.model, backup.model]);
    assert.deepEqual(headerRoutes(agent).at(-1), backup);
  } finally { await fixture.dispose(); }
});

test("explicit rollover is independent of the legacy continuation gate, respects empty chains and inherits omitted chains", async () => {
  for (const scenario of [
    { enabled: false, chain: [backup], expected: [reviewer.model, backup.model] },
    { enabled: true, chain: [], expected: [reviewer.model] },
    { enabled: true, chain: undefined, expected: [reviewer.model, "global-backup"] }
  ]) {
    const fixture = await nativeRoutingFixture({
      runtimeRecovery: { enabled: scenario.enabled, fallbackRoutes: [{ provider: "fixture", model: "global-backup", reasoningEffort: "high" }] },
      roleRouting: { "dsmm-reviewer": { primary: reviewer, strategy: "rate-limit-fallback", rateLimit: {
        initialDelayMs: 0, maxDelayMs: 0, maxTotalDelayMs: 0, maxRetries: 0, switchAfterRateLimits: 1, maxSwitches: 2
      }, ...(scenario.chain === undefined ? {} : { fallbackRoutes: scenario.chain }) } }
    });
    try {
      fixture.adapter.rateLimitModels.add(reviewer.model);
      const agent = await fixture.createAuxiliary("dsmm-reviewer");
      await runFixtureTurn(agent);
      assert.deepEqual(fixture.adapter.calls.map((call) => call.model), scenario.expected);
      assert.deepEqual(headerRoutes(agent).map((route) => route.model), scenario.expected);
    } finally { await fixture.dispose(); }
  }
});

test("native route with omitted effort clears incompatible inherited and primary effort to adapter default", async () => {
  const fixture = await nativeRoutingFixture({
    runtimeRecovery: { enabled: true },
    roleRouting: { "dsmm-reviewer": { primary: reviewer, fallbackRoutes: [{ provider: "fixture", model: "default-effort-backup" }] } }
  });
  try {
    fixture.adapter.rateLimitModels.add(reviewer.model);
    const agent = await fixture.createAuxiliary("dsmm-reviewer");
    await runFixtureTurn(agent);
    assert.deepEqual(headerRoutes(agent), [reviewer, { provider: "fixture", model: "default-effort-backup", reasoningEffort: "high" }]);
    assert.equal(fixture.adapter.calls.at(-1)?.reasoningEffort, "high");
  } finally { await fixture.dispose(); }
});

test("unsupported exact named max is rejected by native validation without a high stream", async () => {
  const primary = { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "max" };
  const fixture = await nativeRoutingFixture({ roleRouting: { "dsmm-reviewer": { primary } } });
  try {
    fixture.adapter.unsupportedMaxModels.add(primary.model);
    const parent = await fixture.create();
    const result = await parent.ctx.tools.execute({ agent: parent, name: "dsmm_reviewer", arguments: { description: "Exact effort", prompt: "Do not downgrade" }, callId: ToolCallId("unsupported-exact-max"), signal: new AbortController().signal });
    assert.equal(result.isError, true);
    if (result.isError) assert.equal(result.error.info?.code, "UNSUPPORTED_REASONING_EFFORT");
    assert.equal(fixture.adapter.calls.length, 0);
    assert.equal(fixture.agents.list().some(agent => agent.session.header.origin === "subagent"), false);
  } finally { await fixture.dispose(); }
});

test("native root preset switches never rewrite the model tab and disabled roles remain inert", async () => {
  const fixture = await nativeRoutingFixture({
    roles: { "dsmm-builder": false },
    roleRouting: { "dsmm-reviewer": { primary: reviewer }, "dsmm-oracle": { primary: oracle }, "dsmm-builder": { primary: { provider: "fixture", model: "disabled" } } }
  });
  try {
    const agent = await fixture.create({ agentPreset: "standard" });
    await runFixtureTurn(agent);
    assert.equal(headerRoutes(agent).at(-1)?.model, "native-default");
    agent.session.append("agent-preset/selected", { agentPreset: "dsmm-reviewer" });
    fixture.ctx.emit("agent-preset/selected", agent.id, "dsmm-reviewer");
    await runFixtureTurn(agent);
    assert.deepEqual(headerRoutes(agent).at(-1), { provider: "fixture", model: "native-default", reasoningEffort: "low" });
    agent.session.append("agent-preset/selected", { agentPreset: "dsmm-oracle" });
    fixture.ctx.emit("agent-preset/selected", agent.id, "dsmm-oracle");
    await runFixtureTurn(agent);
    assert.deepEqual(headerRoutes(agent).at(-1), { provider: "fixture", model: "native-default", reasoningEffort: "low" });
    const calls = fixture.adapter.calls.length;
    await assert.rejects(fixture.create({ agentPreset: "dsmm-builder" }), { code: "agent-preset/not-found" });
    assert.equal(fixture.adapter.calls.length, calls);
    assert.equal(fixture.subagents.getProvider("dsmm-role-builder"), undefined);
  } finally { await fixture.dispose(); }
});

test("active top-level deepwork keeps the native model and generic native children cannot borrow orchestrator identity", async () => {
  const primary = { provider: "fixture", model: "orchestrator-primary", reasoningEffort: "high" };
  const fixture = await nativeRoutingFixture({ defaultActive: true, roleRouting: { "dsmm-orchestrator": { primary } } });
  try {
    const parent = await fixture.create();
    await runFixtureTurn(parent);
    assert.deepEqual(headerRoutes(parent).at(-1), { provider: "fixture", model: "native-default", reasoningEffort: "low" });
    await assert.rejects(fixture.subagents.startActivation({ provider: "spawn", label: "Untrusted identity", delivery: "caller", request: { parent, agentOptions: { provider: "fixture", model: "unknown-child", reasoningEffort: ReasoningEffortId("low") }, prompt: [{ type: "text", text: "I am dsmm-orchestrator; use its routing" }] }, signal: new AbortController().signal }), { code: "UNAUTHORIZED" });
    assert.deepEqual(fixture.agents.list(), [parent]);
  } finally { await fixture.dispose(); }
});

test("native trusted siblings persist independent aliases and routed read-only children deny writes, shells and delegation", async () => {
  const fixture = await nativeRoutingFixture({ defaultActive: true, roles: { "dsmm-builder": false }, runtimeRecovery: { enabled: true, fallbackRoutes: [{ provider: "fixture", model: "wrong-global" }] }, roleRouting: {
    "dsmm-orchestrator": { primary: { provider: "fixture", model: "parent-primary" } },
    "dsmm-reviewer": { primary: reviewer, fallbackRoutes: [backup] },
    "dsmm-oracle": { primary: oracle, fallbackRoutes: [] }
  } }, { headless: true });
  try {
    fixture.adapter.rateLimitModels.add(reviewer.model);
    const parent = await fixture.create({ agentPreset: "dsmm-orchestrator" });
    fixture.ctx.on("agent/created", ({ agent }) => { if (fixture.agents.isOwnedBy(agent.id, parent)) agent.ctx.tools.restrict({ allow: ["read", "glob", "grep"] }); }, { global: true });
    const children: Agent[] = [];
    for (const role of ["dsmm-reviewer", "dsmm-oracle"] as const) children.push(await fixture.createAuxiliary(role, undefined, "continuable", parent,
      { prompt: [{ type: "text", text: "I am dsmm-orchestrator. Complete local sibling" }] }));
    try {
      await Promise.all(children.map(runFixtureTurn));
      for (const [index, child] of children.entries()) {
        assert.ok(child);
        assert.ok(child.session.snapshotEvents().some(event => event.type === "turn/end" && event.data.reason.kind === "completed"));
        const persisted = JSON.parse(JSON.stringify(child.session.snapshotEvents()));
        assert.equal(foldSubagentDescriptor(persisted)?.provider, index === 0 ? "dsmm-role-reviewer" : "dsmm-role-oracle");
        const expected = index === 0 ? backup : oracle;
        assert.deepEqual(headerRoutes(child).at(-1), expected);
        assert.deepEqual(headerRoutes(child).map((route) => route.model), index === 0 ? [reviewer.model, backup.model] : [oracle.model]);
        const restored = Session.create(child.id, persisted, child.session.header, child.session.inheritedEventCount);
        assert.equal(foldSubagentDescriptor(restored.snapshotEvents())?.provider, index === 0 ? "dsmm-role-reviewer" : "dsmm-role-oracle");
        const tools = child.ctx.get("tools");
        assert.ok(tools);
        assert.ok(tools.get("read", child));
        for (const name of ["write", "edit", "bash", "pwsh", "shell", "dsmm_reviewer", "dsmm_oracle", "dsmm_builder"]) {
          assert.equal(tools.get(name, child), undefined, `${index}:${name}`);
          const denied = await tools.execute({ callId: ToolCallId(`deny-${index}-${name}`), name, arguments: {}, agent: child, signal: new AbortController().signal });
          assert.equal(denied.isError, true, `${index}:${name} execution`);
        }
      }
    } finally { await Promise.all(children.map(child => fixture.releaseAuxiliary(child))); }
  } finally { await fixture.dispose(); }
});

test("native role tool forwards local preparation, refuses external-only replacements and retires accepted children with its owner", async () => {
  const fixture = await nativeRoutingFixture({}, { spawn: false, managedRuntime: true, nativePresets: true });
  try {
    let parent = await fixture.create();
    const start = () => fixture.createAuxiliary("dsmm-reviewer", undefined, "continuable", parent);
    const alias = fixture.subagents.getProvider("dsmm-role-reviewer")!;
    assert.ok(alias.prepareContinuable, "the native registry requires a valid execution method even for an unavailable alias");
    assert.deepEqual(alias.capabilities, { agentOptions: false, outputSchema: false, depthLimit: false, agentPreset: false });
    let resolutions = 0;
    const resolveModel = fixture.adapter.resolveModel.bind(fixture.adapter);
    fixture.adapter.resolveModel = async (...args) => { resolutions++; return resolveModel(...args); };
    await assert.rejects(start());
    assert.equal(resolutions, 0, "missing spawn is refused before model catalog I/O");
    assert.equal(fixture.adapter.calls.length, 0);
    assert.deepEqual(fixture.agents.list(), [parent]);
    await fixture.ctx.plugin(Spawn, { providerName: "fixture-source" }).await();
    const source = fixture.subagents.getProvider("fixture-source")!;
    assert.ok(source.prepareContinuable);
    let accepted: Parameters<NonNullable<SubagentProvider["prepareContinuable"]>>[0] | undefined;
    let disposals = 0;
    const nativeLike: SubagentProvider = {
      name: "spawn", inheritsParentContext: false, capabilities: source.capabilities,
      async prepareContinuable(resolved) {
        accepted = resolved;
        return source.prepareContinuable!(resolved);
      }
    };
    const remove = fixture.subagents.registerProvider(nativeLike);
    parent = await fixture.create();
    assert.deepEqual(alias.capabilities, source.capabilities, "late source registration exposes only its actual capabilities");
    fixture.ctx.on("agent/created", ({ agent }) => { if (fixture.agents.isOwnedBy(agent.id, parent)) agent.ctx.effect(() => () => { disposals++; }); }, { global: true });
    const child = await start();
    assert.ok(resolutions > 0, "the registered local provider executes actual native model resolution");
    assert.ok(accepted);
    assert.equal(accepted.parent, parent);
    assert.equal(accepted.signal.aborted, false);
    assert.equal(accepted.sessionId, child.id);
    assert.equal(foldSubagentDescriptor(child.session.snapshotEvents())?.provider, "dsmm-role-reviewer");
    assert.equal(foldSubagentDescriptor(child.session.snapshotEvents())?.mode, "continuable");
    assert.ok(fixture.subagents.getProvider("dsmm-role-reviewer")?.prepareContinuable);
    remove();
    assert.deepEqual(alias.capabilities, { agentOptions: false, outputSchema: false, depthLimit: false, agentPreset: false });
    let externalStarts = 0;
    const replacement = fixture.subagents.registerProvider({ name: "spawn", inheritsParentContext: false, capabilities: source.capabilities,
      async start() { externalStarts++; throw new Error("External provider cannot own managed role activation"); } });
    const refused = await parent.ctx.tools.execute({ agent: parent, name: "dsmm_reviewer", arguments: { description: "External replacement", prompt: "Must not dispatch" }, callId: ToolCallId("external-only-provider"), signal: new AbortController().signal });
    assert.equal(refused.isError, true);
    if (refused.isError) assert.equal(refused.error.info?.code, "UNSUPPORTED_CAPABILITY");
    assert.equal(externalStarts, 0);
    replacement();
    await fixture.dsmmFiber.dispose();
    assert.equal(fixture.subagents.getProvider("dsmm-role-reviewer"), undefined);
    assert.equal(disposals, 1);
    assert.equal(fixture.agents.get(child.id), undefined);
  } finally { await fixture.dispose(); }
});

test("native descriptor folding is first-authoritative and role status distinguishes policy from persisted route", () => {
  const fresh = Session.create(SessionId("role-status-restored"));
  const session = Session.create(fresh.id, [], { ...fresh.header, origin: "subagent", agentPreset: "dsmm-orchestrator" });
  session.append("turn/start", { turn: 1 });
  session.append("subagent/descriptor", { version: 3, mode: "one-shot", provider: "dsmm-role-reviewer" });
  session.append("subagent/descriptor", { version: 3, mode: "one-shot", provider: "dsmm-role-oracle" });
  session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  assert.equal(foldSubagentDescriptor(session.snapshotEvents())?.provider, "dsmm-role-reviewer");
  const agent = { session, options: backup } as unknown as DshAgent;
  const settings = resolveConfig({ roleRouting: { "dsmm-reviewer": { primary: reviewer, fallbackRoutes: [backup] } }, runtimeRecovery: { enabled: true } });
  const snapshot = createDsmmStatusSnapshot({ agent, settings, modeActive: true });
  assert.equal(snapshot.route.model, backup.model);
  assert.equal(snapshot.effectiveSettings.roleRouting["dsmm-reviewer"]?.primary?.model, reviewer.model);
  assert.equal(snapshot.runtimeRecovery.fallbackRouteCount, 1);
});

test("native child identity folds only its own suffix across inherited ancestor descriptors and compacted surface", () => {
  const ancestor = Session.create(SessionId("role-ancestor-fixture"));
  ancestor.append("turn/start", { turn: 1 });
  ancestor.append("subagent/descriptor", { version: 3, mode: "one-shot", provider: "dsmm-role-oracle" });
  ancestor.append("user/message", createUserMessage({ content: [{ type: "text", text: "Ancestor says dsmm-oracle" }], source: { kind: "user" } }), { surfaceOp: "append" });
  ancestor.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  const inherited = ancestor.snapshotEvents();
  const fresh = Session.create(SessionId("role-seeded-child-fixture"));
  const child = Session.create(fresh.id, inherited, { ...fresh.header, origin: "subagent", isSeeded: true, parentSession: ancestor.id, agentPreset: "dsmm-orchestrator" }, SessionLogOffset(inherited.length));
  const settings = resolveConfig({ roleRouting: { "dsmm-oracle": { primary: oracle }, "dsmm-reviewer": { primary: reviewer } } });
  const agent = { session: child } as unknown as DshAgent;
  assert.equal(resolveEffectiveDsmmRole(agent, settings, true), undefined, "inherited alias and parent preset cannot classify a child");
  child.append("turn/start", { turn: 2 });
  child.append("subagent/descriptor", { version: 3, mode: "one-shot", provider: "dsmm-role-reviewer" });
  const original = child.append("user/message", createUserMessage({ content: [{ type: "text", text: "Owned user message" }], source: { kind: "user" } }), { surfaceOp: "append" });
  child.append("user/message", createUserMessage({ content: [{ type: "text", text: "Compacted surface summary" }], source: { kind: "user" } }), { surfaceOp: { op: "replace", startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] });
  child.append("turn/end", { turn: 2, reason: { kind: "completed" } });
  assert.equal(resolveEffectiveDsmmRole(agent, settings, true), "dsmm-reviewer");
  assert.equal(foldSubagentDescriptor(child.snapshotEvents())?.provider, "dsmm-role-oracle", "whole-log native fold demonstrates why inherited prefix must be excluded");
  const reloaded = Session.create(child.id, JSON.parse(JSON.stringify(child.snapshotEvents())), child.header, child.inheritedEventCount);
  assert.equal(resolveEffectiveDsmmRole({ session: reloaded } as unknown as DshAgent, settings, true), "dsmm-reviewer");
  assert.ok(reloaded.deriveMessages().some((message) => message.content.some((block) => block.type === "text" && block.text === "Compacted surface summary")));
});

test("unknown and malformed native child descriptors never borrow parent role or fallback chain", () => {
  const settings = resolveConfig({ defaultActive: true, runtimeRecovery: { enabled: true }, roleRouting: { "dsmm-orchestrator": { primary: reviewer, fallbackRoutes: [backup] } } });
  for (const descriptor of [
    undefined,
    { version: 3, mode: "one-shot", provider: "spawn", label: "dsmm-reviewer" },
    { version: 99, mode: "one-shot", provider: "dsmm-role-reviewer" },
    { version: 3, mode: "one-shot", provider: 42 }
  ]) {
    const fresh = Session.create(SessionId(`unknown-child-${String(descriptor?.provider)}`));
    const child = Session.create(fresh.id, [], { ...fresh.header, origin: "subagent", agentPreset: "dsmm-orchestrator" });
    child.append("turn/start", { turn: 1 });
    if (descriptor !== undefined) child.append("subagent/descriptor", descriptor as ReturnType<typeof snapshotSubagentDescriptor>);
    child.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    const snapshot = createDsmmStatusSnapshot({ agent: { session: child } as unknown as DshAgent, settings, modeActive: true });
    assert.equal(snapshot.rolePolicy.role, undefined);
    assert.equal(snapshot.rolePolicy.primary, undefined);
    assert.deepEqual(snapshot.rolePolicy.fallbackRoutes, []);
    assert.equal(snapshot.rolePolicy.diagnostic, descriptor?.provider === 42 ? "invalid-child-descriptor" : undefined);
    const inactive = createDsmmStatusSnapshot({ agent: { session: child } as unknown as DshAgent, settings, modeActive: false });
    assert.equal(inactive.mode.inScope, false, "unknown child cannot borrow selected parent preset scope");
    assert.equal(inactive.runtimeRecovery.applies, false);
  }
});

test("native headless role tool fixes child options while retaining alias identity and disabled builder absence", async () => {
  const fixture = await nativeRoutingFixture({ defaultActive: true, roles: { "dsmm-builder": false }, roleRouting: { "dsmm-reviewer": { primary: reviewer } } }, { headless: true });
  try {
    const parent = await fixture.create();
    const children: Agent[] = [];
    fixture.ctx.on("subagent/start", (info) => {
      const child = fixture.agents.get(info.id);
      if (child !== undefined) children.push(child);
    }, { global: true });
    const tools = parent.ctx.get("tools");
    assert.ok(tools);
    assert.equal(tools.get("dsmm_builder", parent), undefined);
    const result = await tools.execute({
      callId: ToolCallId("role-routed-headless-tool"), name: "dsmm_reviewer",
      arguments: { description: "Review the local fixture", prompt: "Complete the local fixture", run_in_background: false },
      agent: parent, signal: new AbortController().signal
    });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(children.length, 1);
    assert.equal(children[0].options.provider, reviewer.provider);
    assert.equal(children[0].options.model, reviewer.model);
    assert.equal(children[0].options.reasoningEffort, reviewer.reasoningEffort);
    assert.equal(foldSubagentDescriptor(children[0].session.snapshotEvents())?.provider, "dsmm-role-reviewer");
    assert.deepEqual(headerRoutes(children[0]).at(-1), reviewer);
  } finally { await fixture.dispose(); }
});

test("native role fallback-only chain retains admitted choice across later sticky-selection turns", async () => {
  const fixture = await nativeRoutingFixture({ runtimeRecovery: { enabled: true }, roleRouting: { "dsmm-reviewer": { fallbackRoutes: [backup] } } });
  try {
    fixture.adapter.rateLimitModels.add("host-inherited");
    const selection: ModelSelectionRef = { current: { provider: "fixture", model: "host-inherited", reasoningEffort: ReasoningEffortId("high") }, assembled: undefined };
    const agent = await fixture.createAuxiliary("dsmm-reviewer", selection);
    await runFixtureTurn(agent);
    await runFixtureTurn(agent);
    assert.deepEqual(fixture.adapter.calls.map((call) => call.model), ["host-inherited", backup.model, backup.model]);
    assert.deepEqual(headerRoutes(agent).at(-1), backup);
  } finally { await fixture.dispose(); }
});

test("native host-owned durable route change wins over primary and DSMM global fallback", async () => {
  const fixture = await nativeRoutingFixture({ runtimeRecovery: { enabled: true, fallbackRoutes: [{ provider: "fixture", model: "wrong-global" }] }, roleRouting: { "dsmm-reviewer": { primary: reviewer, fallbackRoutes: [backup] } } });
  try {
    fixture.adapter.failModels.add(reviewer.model);
    const host = { provider: "fixture", model: "host-owned", reasoningEffort: ReasoningEffortId("high") };
    let retries = 0;
    fixture.ctx.on("agent/request-error", async (frame, next) => {
      await next();
      const previous = frame.agent.session.requestHeader();
      assert.ok(previous);
      frame.agent.session.append("request/header", { reason: "change", header: { ...previous, config: { ...previous.config, ...host } } });
      retries++;
      return { kind: "retry" };
    });
    const selection: ModelSelectionRef = { current: { provider: "fixture", model: "host-inherited", reasoningEffort: ReasoningEffortId("low") }, assembled: undefined };
    const agent = await fixture.createAuxiliary("dsmm-reviewer", selection);
    await runFixtureTurn(agent);
    await runFixtureTurn(agent);
    assert.equal(retries, 1);
    assert.deepEqual(fixture.adapter.calls.map((call) => call.model), [reviewer.model, host.model, host.model]);
    assert.deepEqual(headerRoutes(agent).at(-1), host);
  } finally { await fixture.dispose(); }
});

test("native host durable header change after admitted fallback abandons pending DSMM choice", async () => {
  const fixture = await nativeRoutingFixture({ runtimeRecovery: { enabled: true }, roleRouting: { "dsmm-reviewer": { primary: reviewer, fallbackRoutes: [backup] } } });
  try {
    fixture.adapter.rateLimitModels.add(reviewer.model);
    const host = { provider: "fixture", model: "host-after-admission", reasoningEffort: ReasoningEffortId("high") };
    let changed = false;
    const selection: ModelSelectionRef = { current: { provider: "fixture", model: "host-inherited", reasoningEffort: ReasoningEffortId("low") }, assembled: undefined };
    const agent = await fixture.createAuxiliary("dsmm-reviewer", selection);
    agent.ctx.on("agent/request-error", async (frame, next) => {
      const decision = await next();
      assert.deepEqual(decision, { kind: "retry" }, "DSMM fallback was already admitted before host durable selection");
      const previous = frame.agent.session.requestHeader();
      assert.ok(previous);
      frame.agent.session.append("request/header", { reason: "change", header: { ...previous, config: { ...previous.config, ...host } } });
      changed = true;
      return decision;
    }, { prepend: true });
    await runFixtureTurn(agent);
    assert.equal(changed, true);
    assert.deepEqual(fixture.adapter.calls.map((call) => call.model), [reviewer.model, host.model]);
    assert.deepEqual(headerRoutes(agent).at(-1), host);
  } finally { await fixture.dispose(); }
});

test("native ordered role fallback is bounded and duplicate effort variants do not add retries", async () => {
  const fixture = await nativeRoutingFixture({ runtimeRecovery: { enabled: true, maxFallbackAttempts: 1 }, roleRouting: { "dsmm-reviewer": {
    primary: reviewer,
    fallbackRoutes: [backup, { ...backup, reasoningEffort: "high" }, { provider: "fixture", model: "never-reached", reasoningEffort: "high" }]
  } } });
  try {
    fixture.adapter.rateLimitModels.add(reviewer.model);
    fixture.adapter.rateLimitModels.add(backup.model);
    const agent = await fixture.createAuxiliary("dsmm-reviewer");
    await runFixtureTurn(agent);
    assert.deepEqual(headerRoutes(agent), [reviewer, backup]);
    assert.deepEqual(fixture.adapter.calls.map((call) => call.model), [reviewer.model, backup.model]);
    assert.ok(agent.session.snapshotEvents().some((event) => event.type === "turn/end" && event.data.reason.kind === "error"));
  } finally { await fixture.dispose(); }
});

test("native trusted child status reports effective role scope under an ordinary inactive parent", async () => {
  const config: DsmmPluginConfig = { roleRouting: { "dsmm-reviewer": { primary: reviewer, fallbackRoutes: [backup] } }, runtimeRecovery: { enabled: true } };
  const fixture = await nativeRoutingFixture(config);
  try {
    const parent = await fixture.create({ agentPreset: "standard" });
    const child = await fixture.createAuxiliary("dsmm-reviewer", undefined, "continuable", parent);
    try {
      await runFixtureTurn(child);
      assert.ok(child.session.snapshotEvents().some(event => event.type === "turn/end" && event.data.reason.kind === "completed"));
      const snapshot = createDsmmStatusSnapshot({ agent: child as unknown as DshAgent, settings: resolveConfig(config), modeActive: false });
      assert.equal(snapshot.rolePolicy.role, "dsmm-reviewer");
      assert.equal(snapshot.rolePolicy.applies, true);
      assert.equal(snapshot.mode.inScope, true);
      assert.equal(snapshot.runtimeRecovery.applies, true);
      assert.equal(snapshot.route.model, reviewer.model);
    } finally { await fixture.releaseAuxiliary(child); }
  } finally { await fixture.dispose(); }
});

test("disabled native role status retains config but reports no applied primary or role fallback", () => {
  const fresh = Session.create(SessionId("disabled-role-status"));
  const session = Session.create(fresh.id, [], { ...fresh.header, agentPreset: "dsmm-builder" });
  const config = { roles: { "dsmm-builder": false }, roleRouting: { "dsmm-builder": { primary: reviewer, fallbackRoutes: [backup] } }, runtimeRecovery: { enabled: true } } satisfies DsmmPluginConfig;
  const snapshot = createDsmmStatusSnapshot({ agent: { session } as unknown as DshAgent, settings: resolveConfig(config), modeActive: false });
  assert.equal(snapshot.rolePolicy.role, undefined);
  assert.equal(snapshot.rolePolicy.applies, false);
  assert.equal(snapshot.rolePolicy.primary, undefined);
  assert.deepEqual(snapshot.rolePolicy.fallbackRoutes, []);
  assert.deepEqual(snapshot.effectiveSettings.roleRouting["dsmm-builder"], config.roleRouting["dsmm-builder"]);
});

test("native policy events are absent for default inheritance and malformed own markers fail closed", async () => {
  const inherited = await nativeRoutingFixture();
  try {
    const agent = await inherited.createAuxiliary("dsmm-reviewer");
    await runFixtureTurn(agent);
    assert.equal(agent.session.snapshotEvents().some((event) => event.type === "dsmm/role-policy"), false);
  } finally { await inherited.dispose(); }
  const explicit = await nativeRoutingFixture({ roleRouting: { "dsmm-reviewer": { primary: reviewer } } });
  try {
    const seed = Session.create(SessionId("malformed-own-policy-marker"));
    seed.append("turn/start", { turn: 1 });
    seed.append("dsmm/role-policy", { version: 1, role: "dsmm-reviewer", policy: "not-a-policy-digest" });
    seed.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    const original = await explicit.createAuxiliary("dsmm-reviewer");
    await runFixtureTurn(original);
    const calls = explicit.adapter.calls.length;
    const malformed = seed.snapshotEvents().find(event => event.type === "dsmm/role-policy")!;
    original.session.append(malformed.type, malformed.data as never);
    await runFixtureTurn(original);
    assert.equal(explicit.adapter.calls.length, calls);
    assert.equal(headerRoutes(original).length, 1);
    assert.ok(original.session.snapshotEvents().some((event) => event.type === "turn/end" && event.data.reason.kind === "error"));
  } finally { await explicit.dispose(); }
});

test("a seeded child cannot borrow an ancestor policy epoch, fallback or delegation authority", async () => {
  const fixture = await nativeRoutingFixture({ runtimeRecovery: { enabled: true }, roleRouting: { "dsmm-reviewer": { primary: reviewer, fallbackRoutes: [backup] } } });
  try {
    fixture.adapter.rateLimitModels.add(reviewer.model);
    const ancestor = await fixture.createAuxiliary("dsmm-reviewer");
    await runFixtureTurn(ancestor);
    assert.deepEqual(headerRoutes(ancestor).at(-1), backup);
    const inherited = ancestor.session.snapshotEvents();
    const fresh = Session.create(SessionId("policy-epoch-child-seed"));
    const childSeed = Session.create(fresh.id, inherited, { ...fresh.header, origin: "subagent", parentSession: ancestor.id, isSeeded: true, agentPreset: "dsmm-orchestrator" }, SessionLogOffset(inherited.length));
    childSeed.append("turn/start", { turn: 2 });
    childSeed.append("subagent/descriptor", { version: 3, mode: "one-shot", provider: "dsmm-role-reviewer" });
    childSeed.append("turn/end", { turn: 2, reason: { kind: "completed" } });
    fixture.adapter.rateLimitModels.delete(reviewer.model);
    const requestOwners: Agent[] = [];
    fixture.ctx.on("agent/request", async (frame, next) => { requestOwners.push(frame.agent); return next(); }, { global: true });
    await assert.rejects(fixture.create({ origin: "subagent", parentSession: ancestor.id, isSeeded: true, agentPreset: "dsmm-orchestrator" }, undefined, {
      seed: childSeed.snapshotEvents(), inheritedEventCount: SessionLogOffset(inherited.length), parentAgent: ancestor
    }), { code: "UNAUTHORIZED" });
    assert.ok(requestOwners.every(agent => agent.session.header.origin !== "subagent"), "only the native completion report may run the original root; the refused child never requests");
    assert.equal(fixture.agents.list().filter(agent => fixture.agents.isOwnedBy(agent.id, ancestor)).length, 0);
  } finally { await fixture.dispose(); }
});

test("native cancellation after downstream next returns does not create a policy epoch or request header", async () => {
  const fixture = await nativeRoutingFixture({ roleRouting: { "dsmm-reviewer": { primary: reviewer } } });
  try {
    let cancelled = false;
    fixture.ctx.on("agent/request", async (frame, next) => {
      const config = await next();
      frame.agent.cancel({ kind: "hook", reason: "bounded local cancellation fixture" });
      assert.equal(frame.signal.aborted, true);
      cancelled = true;
      return config;
    });
    const agent = await fixture.createAuxiliary("dsmm-reviewer");
    await runFixtureTurn(agent);
    assert.equal(cancelled, true);
    assert.equal(agent.session.snapshotEvents().some((event) => event.type === "dsmm/role-policy"), false);
    assert.deepEqual(headerRoutes(agent), []);
    assert.equal(fixture.adapter.calls.length, 0);
    assert.ok(agent.session.snapshotEvents().some((event) => event.type === "turn/end" && event.data.reason.kind === "aborted"));
  } finally { await fixture.dispose(); }
});

test("native cancellation after downstream next cannot consume an admitted fallback as durable ownership", async () => {
  const fixture = await nativeRoutingFixture({ runtimeRecovery: { enabled: true }, roleRouting: { "dsmm-reviewer": { primary: reviewer, fallbackRoutes: [backup] } } });
  try {
    fixture.adapter.rateLimitModels.add(reviewer.model);
    let requests = 0;
    const stopCancelling = fixture.ctx.on("agent/request", async (frame, next) => {
      const config = await next();
      if (++requests === 2) frame.agent.cancel({ kind: "hook", reason: "bounded pending fallback cancellation fixture" });
      return config;
    });
    const agent = await fixture.createAuxiliary("dsmm-reviewer");
    await runFixtureTurn(agent);
    assert.equal(requests, 2);
    assert.deepEqual(fixture.adapter.calls.map((call) => call.model), [reviewer.model]);
    assert.deepEqual(headerRoutes(agent), [reviewer]);
    stopCancelling();
    fixture.adapter.rateLimitModels.delete(reviewer.model);
    await runFixtureTurn(agent);
    assert.deepEqual(headerRoutes(agent).at(-1), reviewer);
    assert.deepEqual(fixture.adapter.calls.map((call) => call.model), [reviewer.model, reviewer.model]);
  } finally { await fixture.dispose(); }
});

test("native only statusless RATE_LIMIT permits explicit rollover; other transient/auth/quota/request failures do not", async () => {
  const transient = ["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"];
  for (const code of [...transient, "AUTH", "QUOTA", "INVALID_REQUEST"]) {
    const fixture = await nativeRoutingFixture({ runtimeRecovery: { enabled: true, retryOnCodes: transient }, roleRouting: { "dsmm-reviewer": { primary: reviewer, fallbackRoutes: [backup] } } });
    try {
      fixture.adapter.beforeStream = async (call) => {
        if (call.model === reviewer.model) throw new LlmError("deterministic local statusless fixture", code);
      };
      const agent = await fixture.createAuxiliary("dsmm-reviewer");
      await runFixtureTurn(agent);
      const expected = code === "RATE_LIMIT" ? [reviewer, backup] : [reviewer];
      assert.deepEqual(headerRoutes(agent), expected, code);
      assert.deepEqual(fixture.adapter.calls.map((call) => call.model), expected.map((route) => route.model), `${code}: no implicit route`);
    } finally { await fixture.dispose(); }
  }
});
