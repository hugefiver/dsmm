import assert from "node:assert/strict";
import { test } from "node:test";
import { LlmError, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import type { DshAgent, DshContext } from "../lib/dsh-types.js";
import type { DsmmProfileRuntime } from "../lib/profile-runtime.js";
import { liveRolePolicyIdentity, roleRouteLock, roleRouteRuntimeState } from "../lib/role-routing.js";
import { headerRoutes, nativeRoutingFixture as createNativeRoutingFixture, RoutingFixtureAdapter, runFixtureTurn } from "./native-routing-fixture.ts";

function nativeRoutingFixture(config: Parameters<typeof createNativeRoutingFixture>[0], options?: Parameters<typeof createNativeRoutingFixture>[1]) {
  return createNativeRoutingFixture({ permissionControl: { enabled: false }, ...config }, options);
}

const primary = { provider: "fixture", model: "configured-primary", reasoningEffort: "max" };
const backup = { provider: "fixture", model: "configured-backup", reasoningEffort: "low" };
const native = { provider: "fixture", model: "native-picked", reasoningEffort: "low" };
const bounds = { maxRetries: 1, maxSwitches: 1, switchAfterRateLimits: 1, initialDelayMs: 0, maxDelayMs: 0, maxTotalDelayMs: 0 };
const selection = (route = native): ModelSelectionRef => ({ current: { ...route, reasoningEffort: ReasoningEffortId(route.reasoningEffort) }, assembled: undefined });
const routes = (adapter: RoutingFixtureAdapter) => adapter.calls.map(({ provider, model, reasoningEffort }) => ({ provider, model, reasoningEffort }));

test("configured roots use admitted primary over native intent without a TUI owner or native preference writes", async () => {
  const fixture = await nativeRoutingFixture({ rootModelPolicy: "configured", defaultActive: true,
    roleRouting: { "dsmm-orchestrator": { primary } } }, { dsmmLlm: true });
  try {
    const picked = selection();
    const agent = await fixture.create({}, picked);
    const options = { ...agent.options };
    agent.session.append("model/selection", { ...native, reasoningEffort: ReasoningEffortId(native.reasoningEffort) });
    await runFixtureTurn(agent);
    assert.ok(agent.session.snapshotEvents().some(event => event.type === "turn/end" && event.data.reason.kind === "completed"), JSON.stringify(agent.session.snapshotEvents().filter(event => event.type === "turn/end")));
    picked.current = selection({ ...native, model: "another-native-pick" }).current;
    agent.session.append("model/selection", picked.current!);
    await runFixtureTurn(agent);
    assert.deepEqual(routes(fixture.adapter), [primary, primary]);
    assert.deepEqual(headerRoutes(agent), [primary]);
    assert.deepEqual(agent.options, options);
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === "model/selection").length, 2);
  } finally { await fixture.dispose(); }
});

for (const baseline of ["missing-provider", "unknown-model", "missing-fields"] as const) test(`configured primary reaches actual provider stream with ${baseline} native baseline through setup/system prompt and cold history`, async () => {
  const adapter = new RoutingFixtureAdapter();
  adapter.unavailableModels.add("unknown-baseline");
  const fixture = await nativeRoutingFixture({ rootModelPolicy: "configured", defaultActive: true,
    roleRouting: { "dsmm-orchestrator": { primary } } }, { dsmmLlm: true, adapter });
  try {
    let setups = 0, assemblies = 0;
    const agentOptions = baseline === "missing-fields" ? {} : { provider: baseline === "missing-provider" ? "absent-baseline-provider" : "fixture", model: "unknown-baseline" };
    const extra = { agentOptions, setup(scope: import("@deepseek-ai/cordis").Context) {
      setups++;
      scope.on("system-prompt/assemble", async (_prompt, _context, next) => { assemblies++; return next(); });
    } };
    const first = await fixture.create({}, undefined, extra);
    await runFixtureTurn(first);
    const history = JSON.parse(JSON.stringify(first.session.snapshotEvents()));
    await fixture.disposeAgent(first);
    const resumed = await fixture.create({}, undefined, { ...extra, seed: history });
    await runFixtureTurn(resumed);
    assert.equal(setups, 2); assert.ok(assemblies >= 2);
    assert.deepEqual(routes(adapter), [primary, primary]);
    assert.deepEqual(headerRoutes(resumed).at(-1), primary);
    assert.ok(resumed.session.snapshotEvents().some(event => event.type === "turn/end" && event.data.reason.kind === "completed"));
  } finally { await fixture.dispose(); }
});

test("configured root inherits the assembled baseline when primary is sparse", async () => {
  const fixture = await nativeRoutingFixture({ rootModelPolicy: "configured", defaultActive: true }, { dsmmLlm: true });
  try {
    const agent = await fixture.create({}, selection());
    await runFixtureTurn(agent);
    assert.deepEqual(routes(fixture.adapter), [native]);
  } finally { await fixture.dispose(); }
});

test("ordinary mode-off stays native; standing preset keeps its admitted role", async () => {
  for (const scenario of ["mode-off", "standing"] as const) {
    const fixture = await nativeRoutingFixture({ rootModelPolicy: "configured", defaultActive: false,
      roleRouting: { "dsmm-orchestrator": { primary } } }, { dsmmLlm: true });
    try {
      const agent = await fixture.create(scenario === "standing" ? { agentPreset: "dsmm-orchestrator" } : {}, selection());
      await runFixtureTurn(agent);
      assert.deepEqual(routes(fixture.adapter), [scenario === "standing" ? primary : native], scenario);
    } finally { await fixture.dispose(); }
  }
});

test("configured initial admission skips only missing provider/UNKNOWN_MODEL and respects explicit empty fallback", async () => {
  for (const unavailable of ["provider", "model", "empty"] as const) {
    const adapter = new RoutingFixtureAdapter(); adapter.unavailableModels.add(primary.model);
    const configured = unavailable === "provider" ? { ...primary, provider: "absent-primary-provider" } : primary;
    const fixture = await nativeRoutingFixture({ rootModelPolicy: "configured", defaultActive: true,
      runtimeRecovery: { fallbackRoutes: [backup] }, roleRouting: { "dsmm-orchestrator": { primary: configured,
        ...(unavailable === "empty" ? { fallbackRoutes: [] } : {}) } } }, { dsmmLlm: true, adapter });
    try {
      const agent = await fixture.create({}, selection());
      await runFixtureTurn(agent);
      assert.deepEqual(routes(adapter), unavailable === "empty" ? [] : [backup]);
      if (unavailable === "empty") assert.ok(agent.session.snapshotEvents().some(event => event.type === "turn/end" && event.data.reason.kind === "error"));
    } finally { await fixture.dispose(); }
  }
});

test("configured root consumes no-output 429 pending fallback and retains its lock despite new native intent", async () => {
  const fixture = await nativeRoutingFixture({ rootModelPolicy: "configured", defaultActive: true,
    roleRouting: { "dsmm-orchestrator": { primary, fallbackRoutes: [backup], strategy: "rate-limit-fallback", rateLimit: bounds } } }, { dsmmLlm: true });
  try {
    const picked = selection(), agent = await fixture.create({}, picked);
    fixture.adapter.rateLimitModels.add(primary.model);
    fixture.ctx.on("agent/assistant-stream", ({ agent: subject, frame }) => {
      if (subject === agent && frame.type === "end" && fixture.adapter.calls.length === 1) agent.session.append("model/selection", picked.current!);
    });
    await runFixtureTurn(agent); await runFixtureTurn(agent);
    assert.deepEqual(routes(fixture.adapter), [primary, backup, backup]);
    assert.deepEqual(headerRoutes(agent), [primary, backup]);
    const runtime = (fixture.ctx as unknown as DshContext).get!<DsmmProfileRuntime>("dsmmProfileRuntime")!;
    const admitted = runtime.admission(agent as unknown as DshAgent);
    const state = roleRouteRuntimeState(agent as unknown as DshAgent, admitted.settings, "dsmm-orchestrator", admitted.epoch);
    assert.equal(state.strategy, "rate-limit-fallback"); assert.equal(state.switches, 1); assert.deepEqual(state.route, backup);
    const lock = roleRouteLock(agent as unknown as DshAgent, liveRolePolicyIdentity(agent as unknown as DshAgent, admitted.settings, "dsmm-orchestrator", admitted.epoch)!)!;
    assert.deepEqual(lock.candidates, [primary, backup]);
  } finally { await fixture.dispose(); }
});

test("stock Host request waterfall also uses configured root recovery after routing capture", async () => {
  const fixture = await nativeRoutingFixture({ rootModelPolicy: "configured", defaultActive: true,
    roleRouting: { "dsmm-orchestrator": { primary, fallbackRoutes: [backup], strategy: "rate-limit-fallback", rateLimit: bounds } } });
  try {
    const agent = await fixture.create({}, selection());
    fixture.adapter.rateLimitModels.add(primary.model);
    await runFixtureTurn(agent);
    assert.deepEqual(routes(fixture.adapter), [primary, backup]);
    assert.deepEqual(headerRoutes(agent), [primary, backup]);
  } finally { await fixture.dispose(); }
});

test("configured startup route-unavailable falls back only on the first un-settled attempt", async () => {
  const fixture = await nativeRoutingFixture({ rootModelPolicy: "configured", defaultActive: true,
    roleRouting: { "dsmm-orchestrator": { primary, fallbackRoutes: [backup] } } }, { dsmmLlm: true });
  try {
    const agent = await fixture.create({}, selection());
    fixture.adapter.beforeStream = async options => { if (options.model === primary.model) throw new LlmError("gone", "UNKNOWN_MODEL"); };
    await runFixtureTurn(agent);
    assert.deepEqual(routes(fixture.adapter), [primary, backup]);
  } finally { await fixture.dispose(); }
});

test("configured 429 waits for its threshold and rejects a pending retry whose generation changed", async () => {
  for (const stale of [false, true]) {
    const fixture = await nativeRoutingFixture({ rootModelPolicy: "configured", defaultActive: true,
      roleRouting: { "dsmm-orchestrator": { primary, fallbackRoutes: [backup], strategy: "rate-limit-fallback",
        rateLimit: { ...bounds, switchAfterRateLimits: stale ? 1 : 2 } } } }, { dsmmLlm: true });
    try {
      let requests = 0;
      const agent = await fixture.create({}, selection(), { setup(scope) {
        scope.on("agent/request", async (frame, next) => {
          const config = await next();
          if (++requests === 2 && stale) {
            const runtime = (fixture.ctx as unknown as DshContext).get!<DsmmProfileRuntime>("dsmmProfileRuntime")!;
            const admitted = runtime.admission(frame.agent as unknown as DshAgent);
            const identity = liveRolePolicyIdentity(frame.agent as unknown as DshAgent, admitted.settings, "dsmm-orchestrator", admitted.epoch)!;
            roleRouteLock(frame.agent as unknown as DshAgent, identity)!.generation++;
          }
          return config;
        });
      } });
      fixture.adapter.rateLimitModels.add(primary.model);
      await runFixtureTurn(agent);
      assert.deepEqual(routes(fixture.adapter), stale ? [primary] : [primary, primary, backup]);
      if (stale) assert.ok(agent.session.snapshotEvents().some(event => event.type === "turn/end" && event.data.reason.kind === "error"));
    } finally { await fixture.dispose(); }
  }
});

test("first configured request refuses retry when generation changes during fallback resolution", async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  class GatedFallback extends RoutingFixtureAdapter {
    override async resolveModel(provider: string, model: string) {
      if (model === backup.model && this.calls.length === 1) { entered(); await held; }
      return super.resolveModel(provider, model);
    }
  }
  const adapter = new GatedFallback();
  const fixture = await nativeRoutingFixture({ rootModelPolicy: "configured", defaultActive: true,
    roleRouting: { "dsmm-orchestrator": { primary, fallbackRoutes: [backup], strategy: "rate-limit-fallback", rateLimit: bounds } } }, { dsmmLlm: true, adapter });
  try {
    const agent = await fixture.create({}, selection());
    let requests = 0, fallthrough = 0;
    fixture.ctx.on("agent/request", async (_frame, next) => { requests++; return next(); });
    fixture.ctx.on("agent/request-error", async () => { fallthrough++; return { kind: "retry" }; });
    adapter.rateLimitModels.add(primary.model);
    const turn = runFixtureTurn(agent);
    try {
      await Promise.race([started, turn.then(() => { throw new Error("first configured failure never resolved its fallback"); })]);
      const runtime = (fixture.ctx as unknown as DshContext).get!<DsmmProfileRuntime>("dsmmProfileRuntime")!;
      const admitted = runtime.admission(agent as unknown as DshAgent);
      const identity = liveRolePolicyIdentity(agent as unknown as DshAgent, admitted.settings, "dsmm-orchestrator", admitted.epoch)!;
      roleRouteLock(agent as unknown as DshAgent, identity)!.generation++;
    } finally { release(); }
    await turn;
    assert.equal(requests, 1);
    assert.equal(fallthrough, 0);
    assert.deepEqual(routes(adapter), [primary]);
    assert.deepEqual(headerRoutes(agent), [primary]);
    assert.ok(agent.session.snapshotEvents().some(event => event.type === "turn/end" && event.data.reason.kind === "error"));
  } finally { release(); await fixture.dispose(); }
});

test("cold configured admission does not reuse a prior fallback lock or its budget", async () => {
  const fixture = await nativeRoutingFixture({ rootModelPolicy: "configured", defaultActive: true,
    roleRouting: { "dsmm-orchestrator": { primary, fallbackRoutes: [backup], strategy: "rate-limit-fallback", rateLimit: bounds } } }, { dsmmLlm: true });
  try {
    const first = await fixture.create({}, selection());
    fixture.adapter.rateLimitModels.add(primary.model);
    await runFixtureTurn(first);
    const seed = JSON.parse(JSON.stringify(first.session.snapshotEvents()));
    await fixture.disposeAgent(first);
    const resumed = await fixture.create({}, selection(), { seed });
    await runFixtureTurn(resumed);
    assert.deepEqual(routes(fixture.adapter), [primary, backup, primary, backup]);
  } finally { await fixture.dispose(); }
});

test("configured primary rejects initial capability/auth errors rather than trying its fallback", async () => {
  for (const code of ["AUTH", "UNSUPPORTED_REASONING_EFFORT"]) {
    class RejectedPrimary extends RoutingFixtureAdapter {
      override async resolveModel(provider: string, model: string) {
        if (model === primary.model) throw new LlmError("fixture exact admission rejection", code);
        return super.resolveModel(provider, model);
      }
    }
    const fixture = await nativeRoutingFixture({ rootModelPolicy: "configured", defaultActive: true,
      roleRouting: { "dsmm-orchestrator": { primary, fallbackRoutes: [backup] } } }, { dsmmLlm: true, adapter: new RejectedPrimary() });
    try {
      const agent = await fixture.create({}, selection());
      await runFixtureTurn(agent);
      assert.deepEqual(routes(fixture.adapter), []);
      assert.ok(agent.session.snapshotEvents().some(event => event.type === "turn/end" && event.data.reason.kind === "error"));
    } finally { await fixture.dispose(); }
  }
});

test("prepared configured stream rejects late provider chunks after its routing generation changes", async () => {
  const fixture = await nativeRoutingFixture({ rootModelPolicy: "configured", defaultActive: true,
    roleRouting: { "dsmm-orchestrator": { primary, fallbackRoutes: [backup] } } }, { dsmmLlm: true });
  try {
    const agent = await fixture.create({}, selection());
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    fixture.adapter.beforeStream = async () => { entered(); await held; };
    const turn = runFixtureTurn(agent);
    try {
      await Promise.race([started, turn.then(() => { throw new Error("configured stream never entered its provider"); })]);
      const runtime = (fixture.ctx as unknown as DshContext).get!<DsmmProfileRuntime>("dsmmProfileRuntime")!;
      const admitted = runtime.admission(agent as unknown as DshAgent);
      const identity = liveRolePolicyIdentity(agent as unknown as DshAgent, admitted.settings, "dsmm-orchestrator", admitted.epoch)!;
      roleRouteLock(agent as unknown as DshAgent, identity)!.generation++;
    } finally { release(); }
    await turn;
    assert.deepEqual(routes(fixture.adapter), [primary]);
    assert.equal(agent.session.snapshotEvents().some(event => event.type === "assistant/message"), false);
    assert.ok(agent.session.snapshotEvents().some(event => event.type === "turn/end" && event.data.reason.kind === "error"));
  } finally { await fixture.dispose(); }
});

test("configured native-default parameter policy ignores configured effort, including fallback, not old native selection", async () => {
  const fixture = await nativeRoutingFixture({ rootModelPolicy: "configured", defaultActive: true, modelParameters: { passthrough: false },
    roleRouting: { "dsmm-orchestrator": { primary, fallbackRoutes: [backup], strategy: "rate-limit-fallback", rateLimit: bounds } } }, { dsmmLlm: true });
  try {
    const agent = await fixture.create({}, selection());
    agent.session.append("model/selection", selection().current!);
    fixture.adapter.rateLimitModels.add(primary.model);
    await runFixtureTurn(agent);
    assert.deepEqual(routes(fixture.adapter), [{ ...primary, reasoningEffort: "high" }, { ...backup, reasoningEffort: "high" }]);
  } finally { await fixture.dispose(); }
});

for (const failure of ["AUTH", "PERMISSION_DENIED", "QUOTA", "partial", "cancel", "exhausted"] as const) test(`configured root does not fall back for ${failure}`, async () => {
  const fixture = await nativeRoutingFixture({ rootModelPolicy: "configured", defaultActive: true,
    roleRouting: { "dsmm-orchestrator": { primary, fallbackRoutes: [backup], strategy: "rate-limit-fallback",
      rateLimit: failure === "exhausted" ? { ...bounds, maxSwitches: 0, maxRetries: 0 } : bounds } } }, { dsmmLlm: true });
  try {
    const agent = await fixture.create({}, selection());
    fixture.adapter.streamChunks = async function* () {
      if (failure === "partial") yield { type: "text-delta", index: 0, text: "accepted" };
      if (failure === "cancel") agent.cancel({ kind: "hook", reason: "fixture cancellation" });
      throw new LlmError("fixture failure", ["partial", "cancel", "exhausted"].includes(failure) ? "RATE_LIMIT" : failure, { status: 429 });
    };
    await runFixtureTurn(agent);
    assert.deepEqual(routes(fixture.adapter), [primary]);
  } finally { await fixture.dispose(); }
});
