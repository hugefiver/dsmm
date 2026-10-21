import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRequestFrame, DshContext, DshLlmCallConfig } from "../src/dsh-types.js";
import { registerModelRouting } from "../src/model-routing.js";
import { registerRuntimeRecovery } from "../src/runtime-recovery.js";
import { resolveConfig } from "../src/settings.js";
import { DeepworkModeController } from "../src/state.js";
import type { DsmmPluginConfig } from "../src/settings.js";
import { bindRoleInvocation } from "../src/role-invocation.js";
import { liveRolePolicyIdentity, roleRouteLock } from "../src/role-routing.js";
import { resolveRoleRuntimePolicy } from "../src/routing-policy.js";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-api-session-controller";

type Listener = (frame: AgentRequestFrame, next: () => Promise<DshLlmCallConfig>) => Promise<DshLlmCallConfig>;
function harness(config: DsmmPluginConfig = {}) {
  let listener: Listener | undefined;
  let assemble: ((_assembly: unknown, context: { agent: AgentRequestFrame["agent"]; signal: AbortSignal }, next: () => Promise<void>) => Promise<void>) | undefined;
  const cleanups: Array<() => void> = [];
  const context: DshContext = {
    get() { return undefined; },
    on(event, callback) {
      if (event === "agent/request") listener = callback as Listener;
      if (event === "system-prompt/assemble") assemble = callback as typeof assemble;
      return () => { if (listener === callback) listener = undefined; };
    },
    effect(callback) { const dispose = callback(); if (typeof dispose === "function") cleanups.push(dispose); }
  };
  const settings = resolveConfig({ defaultActive: true, ...config });
  registerModelRouting(context, new DeepworkModeController(context), () => settings);
  const frame: AgentRequestFrame = { agent: { session: { header: { origin: "subagent" }, events: [], append() {} } },
    turn: 1, step: 1, signal: new AbortController().signal };
  return { frame, settings, assemble: () => assemble!(undefined, { agent: frame.agent, signal: frame.signal }, async () => {}), get listener() { return listener; }, dispose() { cleanups.forEach(fn => fn()); } };
}

test("native downstream parameters remain authoritative without an explicit role route", async () => {
  for (const [provider, model] of [["deepseek-official", "deepseek-v4-pro"], ["deepseek-account", "deepseek-flash"], ["native", "model"]]) {
    const h = harness();
    for (const effort of [undefined, "off", "low", "provider-specific"]) {
      const call: DshLlmCallConfig = { provider, model, temperature: 0, stop: ["END"], ...(effort === undefined ? {} : { reasoningEffort: effort }) };
      assert.equal(await h.listener!(h.frame, async () => call), call);
    }
    h.dispose();
    assert.equal(h.listener, undefined);
  }
});

test("child initial routing yields to assembled manual intent and retains admitted fallback until reselection", async () => {
  const primary = { provider: "native", model: "initial", reasoningEffort: "max", temperature: 0 };
  const manual = { provider: "native", model: "chosen" };
  const backup = { provider: "native", model: "backup", reasoningEffort: "low" };
  const h = harness({ roleRouting: { "dsmm-reviewer": { primary, fallbackRoutes: [backup] } } });
  const seed = Session.create(SessionId("routing-child"));
  const session = Session.create(seed.id, [], { ...seed.header, origin: "subagent" });
  h.frame.agent.session = session as unknown as AgentRequestFrame["agent"]["session"];
  session.append("step/start", { turn: 1, step: 1 });
  h.frame.agent.ctx = { get(name) { return (name === "llm" ? { resolveCallConfig: async (call: DshLlmCallConfig) => call } : undefined) as never; } };
  bindRoleInvocation(h.frame.agent, { target: "dsmm-reviewer", effectiveLevel: "normal", routeSource: "primary", initialRoute: primary, candidates: [primary, backup], exactEffort: true, policy: resolveRoleRuntimePolicy(h.settings, "dsmm-reviewer") });
  try {
    await h.assemble();
    assert.deepEqual(await h.listener!(h.frame, async () => ({ provider: "native", model: "inherited" })), primary);
    session.append("model/selection", manual);
    await h.assemble();
    assert.deepEqual(await h.listener!(h.frame, async () => manual), manual, "omitted effort clears the initial route effort and parameters");
    const identity = liveRolePolicyIdentity(h.frame.agent, h.settings, "dsmm-reviewer")!;
    const lock = roleRouteLock(h.frame.agent, identity)!;
    const generation = lock.generation;
    lock.route = backup;
    assert.deepEqual(await h.listener!(h.frame, async () => manual), backup);
    session.append("model/selection", manual);
    await h.assemble();
    assert.deepEqual(await h.listener!(h.frame, async () => manual), manual);
    assert.ok(roleRouteLock(h.frame.agent, identity)!.generation > generation);
  } finally { h.dispose(); }
});

test("a child's accepted manual selection preserves stop-only and arbitrary downstream parameters", async () => {
  const h = harness(), seed = Session.create(SessionId("manual-parameters-child"));
  const session = Session.create(seed.id, [], { ...seed.header, origin: "subagent" });
  h.frame.agent.session = session as unknown as AgentRequestFrame["agent"]["session"];
  const primary = { provider: "native", model: "initial", reasoningEffort: "max" };
  bindRoleInvocation(h.frame.agent, { target: "dsmm-reviewer", effectiveLevel: "normal", routeSource: "primary", initialRoute: primary, candidates: [primary], exactEffort: true, policy: resolveRoleRuntimePolicy(h.settings, "dsmm-reviewer") });
  session.append("step/start", { turn: 1, step: 1 });
  try {
    for (const customParameters of [undefined, { custom_payload: { enabled: false } }]) {
      session.append("model/selection", { provider: "native", model: "selected" });
      const downstream = { provider: "native", model: "selected", temperature: 0, maxTokens: 90, stop: ["END"], ...(customParameters === undefined ? {} : { customParameters }) };
      await h.assemble();
      assert.deepEqual(await h.listener!(h.frame, async () => downstream), downstream);
      const intent = roleRouteLock(h.frame.agent, liveRolePolicyIdentity(h.frame.agent, h.settings, "dsmm-reviewer")!)!;
      assert.equal(intent.route.reasoningEffort, undefined);
      assert.deepEqual(intent.route.stop, ["END"]);
      assert.deepEqual(intent.route.custom_payload, customParameters?.custom_payload);
    }
  } finally { h.dispose(); }
});

test("manual selection made after assembly does not override the captured native step", async () => {
  const h = harness(), initial = { provider: "native", model: "assembled", temperature: 0 }, later = { provider: "native", model: "later" };
  const session = Session.create(SessionId("routing-root"));
  h.frame.agent.session = session as unknown as AgentRequestFrame["agent"]["session"];
  session.append("step/start", { turn: 1, step: 1 });
  try {
    await h.assemble();
    session.append("model/selection", later);
    assert.equal(await h.listener!(h.frame, async () => initial), initial);
    await h.assemble();
    assert.deepEqual(await h.listener!(h.frame, async () => later), later);
  } finally { h.dispose(); }
});

test("a fresh root model intent never rewrites native downstream parameters or an assembled route", async () => {
  const h = harness(), session = Session.create(SessionId("routing-native-root"));
  h.frame.agent.session = session as unknown as AgentRequestFrame["agent"]["session"];
  session.append("step/start", { turn: 1, step: 1 });
  session.append("model/selection", { provider: "native", model: "manual" });
  const downstream = { provider: "native", model: "assembled", temperature: 0, maxTokens: 80, stop: ["END"], reasoningEffort: "native-default" };
  try {
    await h.assemble();
    assert.equal(await h.listener!(h.frame, async () => downstream), downstream);
    const lock = roleRouteLock(h.frame.agent, liveRolePolicyIdentity(h.frame.agent, h.settings, "dsmm-orchestrator")!)!;
    assert.equal(lock.manualSelectionSeq, 1);
    assert.equal(lock.route.model, "assembled");
    assert.equal(lock.route.temperature, 0);
    assert.equal(lock.route.maxTokens, 80);
  } finally { h.dispose(); }
});

test("routing preserves downstream failure and cancelled requests", async () => {
  const h = harness(), failure = new Error("native downstream failed");
  await assert.rejects(h.listener!(h.frame, async () => { throw failure; }), error => error === failure);
  const abort = new AbortController(); abort.abort();
  const call = { provider: "native", model: "model", reasoningEffort: "exact" };
  assert.equal(await h.listener!({ ...h.frame, signal: abort.signal }, async () => call), call);
  h.dispose();
});

test("candidate mode projection preserves the current fence while native intent changes invalidate it", () => {
  const h = harness(), controller = new DeepworkModeController({});
  const current = controller.describe(h.frame.agent, false);
  assert.equal(controller.describe(h.frame.agent, true).active, true);
  assert.equal(controller.describe(h.frame.agent, false).revision, current.revision);
  h.frame.agent.session.events = [{ type: "deepwork/mode", data: { active: true } }];
  assert.notEqual(controller.describe(h.frame.agent, false).revision, current.revision);
  h.dispose();
});

test("injected routing listeners are owned by the ready context and dispose without duplicate installation", () => {
  let install: ((context: DshContext) => unknown) | undefined, requests = 0, removals = 0;
  const effects: Array<() => void | (() => void)> = [];
  const root: DshContext = { inject(_dependencies, callback) { install = callback; } };
  registerModelRouting(root, new DeepworkModeController(root), () => resolveConfig());
  assert.ok(install);
  const ready: DshContext = {
    on(event) { if (event === "agent/request") requests++; return () => { if (event === "agent/request") removals++; }; },
    effect(callback) { effects.push(callback); }
  };
  install(ready);
  const installed = requests;
  assert.ok(installed > 0);
  install(ready);
  assert.equal(requests, installed);
  for (const effect of effects.splice(0)) { const cleanup = effect(); if (typeof cleanup === "function") cleanup(); }
  assert.equal(removals, installed);
  install(ready); assert.equal(requests, installed * 2);
  for (const effect of effects.splice(0)) { const cleanup = effect(); if (typeof cleanup === "function") cleanup(); }
});

test("recovery and routing composition preserves native parameters without a correlated pending fallback", async () => {
  const requests: Listener[] = [];
  const context: DshContext = { get() { return undefined; }, on(event, callback) { if (event === "agent/request") requests.unshift(callback as Listener); } };
  const settings = resolveConfig({ defaultActive: true, runtimeRecovery: { enabled: true, fallbackRoutes: [{ provider: "native", model: "fallback" }] } });
  const mode = new DeepworkModeController(context);
  registerRuntimeRecovery(context, mode, () => settings); registerModelRouting(context, mode, () => settings);
  const h = harness(), config = { provider: "native", model: "primary", reasoningEffort: "low", temperature: 0 };
  h.frame.agent.session.events = [{ type: "request/header", data: { reason: "initial", header: { config } } }];
  const invoke = (index: number): Promise<DshLlmCallConfig> => index === requests.length ? Promise.resolve(config) : requests[index]!(h.frame, () => invoke(index + 1));
  assert.equal(await invoke(0), config);
  h.dispose();
});
