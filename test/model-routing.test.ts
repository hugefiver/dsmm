import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRequestFrame, DshContext, DshLlmCallConfig, DshModelSelection } from "../src/dsh-types.js";
import { prepareAdmissionModelRoute, registerModelRouting } from "../src/model-routing.js";
import { registerRuntimeRecovery } from "../src/runtime-recovery.js";
import { resolveConfig } from "../src/settings.js";
import { DeepworkModeController } from "../src/state.js";
import type { DsmmPluginConfig } from "../src/settings.js";
import type { DsmmProfileAdmission, DsmmSettingsGetter } from "../src/settings.js";
import { preparedRequestRouting } from "../src/request-routing.js";
import { bindRoleInvocation } from "../src/role-invocation.js";
import { liveRolePolicyIdentity, persistedRoleRoute, roleRouteLock } from "../src/role-routing.js";
import { resolveRoleRuntimePolicy } from "../src/routing-policy.js";
import { canonicalHeader, Session, SessionId } from "@deepseek-ai/dsh-session";
import { LlmError } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-api-session-controller";

type Listener = (frame: AgentRequestFrame, next: () => Promise<DshLlmCallConfig>) => Promise<DshLlmCallConfig>;
function harness(config: DsmmPluginConfig = {}, admitted = false) {
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
  let settings = resolveConfig({ defaultActive: true, ...config });
  let admission: DsmmProfileAdmission = { settings, epoch: "initial", scope: "deployment-baseline", profile: null };
  const getter: DsmmSettingsGetter = () => settings;
  if (admitted) getter.admission = () => admission;
  registerModelRouting(context, new DeepworkModeController(context), getter);
  const frame: AgentRequestFrame = { agent: { session: { header: { origin: "subagent" }, events: [], append() {} } },
    turn: 1, step: 1, signal: new AbortController().signal };
  return { frame, get settings() { return settings; }, readmit(config: DsmmPluginConfig) {
    settings = resolveConfig({ defaultActive: true, ...config });
    admission = { ...admission, settings, epoch: "next" };
  }, assemble: () => assemble!(undefined, { agent: frame.agent, signal: frame.signal }, async () => {}), get listener() { return listener; }, dispose() { cleanups.forEach(fn => fn()); } };
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

test("configured deployment needs exact admission and enabled Deepwork before root routing", async () => {
  const primary = { provider: "profile", model: "primary" }, downstream = { provider: "native", model: "baseline" };
  for (const [admitted, enabled] of [[false, true], [true, false]] as const) {
    const h = harness({ rootModelPolicy: "configured", modules: { deepwork: { enabled } }, roleRouting: { "dsmm-orchestrator": { primary } } }, admitted);
    h.frame.agent.session = Session.create(SessionId(`configured-eligibility-${admitted}-${enabled}`));
    try {
      assert.equal(await h.listener!(h.frame, async () => downstream), downstream);
      assert.equal(preparedRequestRouting(h.frame)!.decision.configuredRoot, false);
    } finally { h.dispose(); }
  }
});

test("rc.1 configured request mismatch throws LlmError without selecting a later step", async () => {
  const primary = { provider: "profile", model: "primary", reasoningEffort: "high" };
  const h = harness({ rootModelPolicy: "configured", roleRouting: { "dsmm-orchestrator": { primary } } }, true);
  const session = Session.create(SessionId("configured-request-mismatch"));
  h.frame.agent.session = session; session.append("step/start", { turn: 1, step: 1 });
  let selections = 0;
  Object.assign(h.frame.agent, { model: { current: () => ({ provider: "native", model: "fixed", reasoningEffort: "low" }), select() { selections++; } } });
  h.frame.agent.ctx = { get(name) { return (name === "llm" ? { resolveCallConfig: async (call: DshLlmCallConfig) => call } : undefined) as never; } };
  try {
    await assert.rejects(h.listener!(h.frame, async () => ({ provider: "native", model: "fixed", reasoningEffort: "low",
      temperature: 0, maxTokens: 90, stop: ["END"] })), error => error instanceof LlmError && error.code === "INVALID_PREPARED_CALL");
    assert.equal(selections, 0);
  } finally { h.dispose(); }
});

test("rc.1 configured matching selection preserves downstream controls and opaque parameters", async () => {
  const primary = { provider: "profile", model: "primary" };
  const h = harness({ rootModelPolicy: "configured", roleRouting: { "dsmm-orchestrator": { primary } } }, true);
  const session = Session.create(SessionId("configured-request-parameters"));
  h.frame.agent.session = session; session.append("step/start", { turn: 1, step: 1 });
  Object.assign(h.frame.agent, { model: { current: () => primary, select() {} } });
  h.frame.agent.ctx = { get(name) { return (name === "llm" ? { resolveCallConfig: async (call: DshLlmCallConfig) => call } : undefined) as never; } };
  const proposal = { ...primary, temperature: 0, maxTokens: 90, stop: ["END"], customParameters: { opaque: false } };
  try { assert.deepEqual(await h.listener!(h.frame, async () => proposal), proposal); }
  finally { h.dispose(); }
});

test("rc.1 matching keeps downstream-only controls while explicit candidate fields win", async () => {
  const primary = { provider: "profile", model: "primary-explicit", temperature: 0.8 };
  const h = harness({ rootModelPolicy: "configured", roleRouting: { "dsmm-orchestrator": { primary } } }, true);
  const session = Session.create(SessionId("configured-request-priority"));
  h.frame.agent.session = session; session.append("step/start", { turn: 1, step: 1 });
  Object.assign(h.frame.agent, { model: { current: () => primary, select() {} } });
  h.frame.agent.ctx = { get(name) { return (name === "llm" ? { resolveCallConfig: async (call: DshLlmCallConfig) => call } : undefined) as never; } };
  const proposal = { provider: primary.provider, model: primary.model, temperature: 0.2, maxTokens: 90, stop: ["END"] };
  try { assert.deepEqual(await h.listener!(h.frame, async () => proposal), { ...proposal, temperature: 0.8 }); }
  finally { h.dispose(); }
});

test("profile route rollback restores only its own latest selection event", async () => {
  for (const concurrent of [false, true]) {
    const primary = { provider: "fixture", model: "profile-primary" }, native = { provider: "fixture", model: "native" };
    const settings = resolveConfig({ defaultActive: true, rootModelPolicy: "configured", roleRouting: { "dsmm-orchestrator": { primary } } });
    const admission: DsmmProfileAdmission = { settings, epoch: `rollback-${concurrent}`, scope: "deployment-baseline", profile: null };
    const session = Session.create(SessionId(`profile-route-rollback-${concurrent}`));
    let current: DshModelSelection = { ...native };
    const model = { current: () => ({ ...current }), select(selection: DshModelSelection) {
      if (current.provider === selection.provider && current.model === selection.model && current.reasoningEffort === selection.reasoningEffort) return;
      current = { ...selection }; session.append("model/selection", { ...selection });
    } };
    const llm = { resolveModelInfo: async () => { throw new Error("unused"); }, resolveCallConfig: async (call: DshLlmCallConfig) => call };
    const context: DshContext = { get(name) { return (name === "llm" ? llm : undefined) as never; }, llm };
    const agent = { session, model, ctx: context } as unknown as AgentRequestFrame["agent"];
    const candidate = await prepareAdmissionModelRoute(context, new DeepworkModeController(context), agent,
      { settings, epoch: admission.epoch, admission, signal: new AbortController().signal, assertCurrent() {} });
    const installed = candidate!.install(admission)!;
    assert.deepEqual(current, primary);
    if (concurrent) {
      model.select({ provider: "fixture", model: "operator-b" });
      model.select(primary);
    }
    installed.rollback();
    assert.deepEqual(current, concurrent ? primary : native);
  }
});

test("child admission installs its invocation once and leaves later fixed-selection manual intent intact", async () => {
  const primary = { provider: "fixture", model: "child-primary" }, manual = { provider: "fixture", model: "child-manual" };
  const settings = resolveConfig({ defaultActive: true, roleRouting: { "dsmm-reviewer": { primary } } });
  const admission: DsmmProfileAdmission = { settings, epoch: "child-selection", scope: "deployment-baseline", profile: null };
  const seed = Session.create(SessionId("child-selection-once"));
  const session = Session.create(seed.id, [], { ...seed.header, origin: "subagent" });
  let current: DshModelSelection = { provider: "fixture", model: "inherited" };
  const model = { current: () => ({ ...current }), select(selection: DshModelSelection) {
    if (current.provider === selection.provider && current.model === selection.model && current.reasoningEffort === selection.reasoningEffort) return;
    current = { ...selection }; session.append("model/selection", { ...selection });
  } };
  const context: DshContext = { get() { return undefined; } };
  const agent = { session, model, ctx: context } as unknown as AgentRequestFrame["agent"];
  bindRoleInvocation(agent, { target: "dsmm-reviewer", effectiveLevel: "normal", routeSource: "primary", initialRoute: primary,
    candidates: [primary], exactEffort: false, effortSource: "dsmm-config", policy: resolveRoleRuntimePolicy(settings, "dsmm-reviewer") });
  const candidate = await prepareAdmissionModelRoute(context, new DeepworkModeController(context), agent,
    { settings, epoch: admission.epoch, admission, signal: new AbortController().signal, assertCurrent() {} });
  assert.equal(candidate!.restoresConfiguredPrimary, false);
  candidate!.install(admission);
  assert.deepEqual(current, primary);
  model.select(manual);
  assert.deepEqual(current, manual);
});

test("profile rollback restores the prior policy identity and exact lock budget", async () => {
  const oldPrimary = { provider: "fixture", model: "old-primary" }, oldFallback = { provider: "fixture", model: "old-fallback" };
  const oldSettings = resolveConfig({ defaultActive: true, rootModelPolicy: "configured",
    roleRouting: { "dsmm-orchestrator": { primary: oldPrimary, fallbackRoutes: [oldFallback] } } });
  const oldAdmission: DsmmProfileAdmission = { settings: oldSettings, epoch: "old-policy", scope: "deployment-baseline", profile: null };
  const session = Session.create(SessionId("profile-policy-rollback"));
  let current: DshModelSelection = { provider: "fixture", model: "native" };
  const model = { current: () => ({ ...current }), select(selection: DshModelSelection) {
    if (current.provider === selection.provider && current.model === selection.model && current.reasoningEffort === selection.reasoningEffort) return;
    current = { ...selection }; session.append("model/selection", { ...selection });
  } };
  const llm = { resolveModelInfo: async () => { throw new Error("unused"); }, resolveCallConfig: async (call: DshLlmCallConfig) => call };
  const context: DshContext = { get(name) { return (name === "llm" ? llm : undefined) as never; }, llm };
  const agent = { session, model, ctx: context } as unknown as AgentRequestFrame["agent"];
  const controller = new DeepworkModeController(context);
  const oldCandidate = await prepareAdmissionModelRoute(context, controller, agent,
    { settings: oldSettings, epoch: oldAdmission.epoch, admission: oldAdmission, signal: new AbortController().signal, assertCurrent() {} });
  oldCandidate!.install(oldAdmission);
  const oldIdentity = liveRolePolicyIdentity(agent, oldSettings, "dsmm-orchestrator", oldAdmission.epoch)!;
  const oldLock = roleRouteLock(agent, oldIdentity)!;
  oldLock.startupSettled = true; oldLock.retries = 2; oldLock.switches = 1; oldLock.rateLimits = 3;

  const nextSettings = resolveConfig({ defaultActive: true, rootModelPolicy: "configured",
    roleRouting: { "dsmm-orchestrator": { primary: { provider: "fixture", model: "next-primary" } } } });
  const nextAdmission: DsmmProfileAdmission = { settings: nextSettings, epoch: "next-policy", scope: "session-override", profile: null };
  const nextCandidate = await prepareAdmissionModelRoute(context, controller, agent,
    { settings: nextSettings, epoch: nextAdmission.epoch, admission: nextAdmission, signal: new AbortController().signal, assertCurrent() {} });
  nextCandidate!.install(nextAdmission)!.rollback();

  const restoredIdentity = liveRolePolicyIdentity(agent, oldSettings, "dsmm-orchestrator", oldAdmission.epoch)!;
  assert.equal(restoredIdentity, oldIdentity);
  assert.equal(roleRouteLock(agent, restoredIdentity), oldLock);
  assert.deepEqual(oldLock.candidates, [oldPrimary, oldFallback]);
  assert.equal(oldLock.startupSettled, true); assert.equal(oldLock.retries, 2); assert.equal(oldLock.switches, 1); assert.equal(oldLock.rateLimits, 3);
});

test("mode-off configured preflight failure is cached until the role becomes active", async () => {
  const primary = { provider: "fixture", model: "unavailable" };
  const settings = resolveConfig({ defaultActive: false, rootModelPolicy: "configured", roleRouting: { "dsmm-orchestrator": { primary } } });
  const admission: DsmmProfileAdmission = { settings, epoch: "mode-off-cache", scope: "deployment-baseline", profile: null };
  const session = Session.create(SessionId("mode-off-route-cache"));
  const native = { provider: "fixture", model: "native" };
  const model = { current: () => native, select() { throw new Error("mode-off must not select"); } };
  const llm = { resolveModelInfo: async () => { throw new Error("unused"); }, resolveCallConfig: async () => { throw new LlmError("unavailable", "UNKNOWN_MODEL"); } };
  const context: DshContext = { get(name) { return (name === "llm" ? llm : undefined) as never; }, llm };
  const agent = { session, model, ctx: context } as unknown as AgentRequestFrame["agent"];
  const candidate = await prepareAdmissionModelRoute(context, new DeepworkModeController(context), agent,
    { settings, epoch: admission.epoch, admission, signal: new AbortController().signal, assertCurrent() {} });
  assert.ok(candidate);
  assert.equal(candidate.install(admission), undefined);
  session.append("deepwork/mode", { active: true });
  assert.throws(() => candidate.install(admission), error => error instanceof LlmError && error.code === "UNKNOWN_MODEL");
  assert.deepEqual(model.current(), native);
});

for (const change of ["admission", "mode", "owner", "frame", "generation"] as const) test(`configured routing rejects ${change} changes across async preparation or prepared consumption`, async () => {
  const primary = { provider: "profile", model: "primary" };
  const config = { rootModelPolicy: "configured" as const, roleRouting: { "dsmm-orchestrator": { primary } } };
  const h = harness(config, true), session = Session.create(SessionId(`configured-fence-${change}`));
  h.frame.agent.session = session;
  session.append("step/start", { turn: 1, step: 1 });
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  h.frame.agent.ctx = { get(name) { return (name === "llm" ? { resolveCallConfig: async (call: DshLlmCallConfig) => { entered(); await held; return call; } } : undefined) as never; } };
  try {
    const result = h.listener!(h.frame, async () => ({ provider: "native", model: "baseline" }));
    await started;
    if (change === "admission") h.readmit(config);
    if (change === "mode") session.append("deepwork/mode", { active: false });
    if (change === "owner") h.dispose();
    if (change === "frame") h.frame.step++;
    release();
    if (change !== "generation") await assert.rejects(result);
    else {
      await result;
      const captured = preparedRequestRouting(h.frame)!;
      captured.assertCurrent();
      roleRouteLock(h.frame.agent, captured.decision.policy!)!.generation++;
      assert.throws(() => captured.decision.assertCurrent());
      assert.throws(() => captured.assertCurrent());
    }
  } finally { release(); h.dispose(); }
});

test("configured policy never adopts an arbitrary non-chain durable Host header", async () => {
  const primary = { provider: "profile", model: "primary" }, native = { provider: "native", model: "outside-chain" };
  const h = harness({ rootModelPolicy: "configured", roleRouting: { "dsmm-orchestrator": { primary } } }, true);
  const session = Session.create(SessionId("configured-persisted-policy"));
  h.frame.agent.session = session;
  session.append("step/start", { turn: 1, step: 1 });
  h.frame.agent.ctx = { get(name) { return (name === "llm" ? { resolveCallConfig: async (call: DshLlmCallConfig) => call } : undefined) as never; } };
  try {
    assert.deepEqual(await h.listener!(h.frame, async () => native), primary);
    const { policy } = preparedRequestRouting(h.frame)!.decision;
    session.append("request/header", { header: canonicalHeader({ config: native }), reason: "change" });
    assert.equal(persistedRoleRoute(h.frame, primary, [], policy, true), undefined);
    assert.deepEqual(persistedRoleRoute(h.frame, primary, [], policy), native, "native and child durable Host ownership stays unchanged");
    assert.deepEqual(await h.listener!(h.frame, async () => native), primary);
  } finally { h.dispose(); }
});
