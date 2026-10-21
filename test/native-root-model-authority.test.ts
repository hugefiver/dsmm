import assert from "node:assert/strict";
import { test } from "node:test";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-api-session-controller";
import { LlmError, ReasoningEffortId, ToolCallId } from "@deepseek-ai/dsh-llm";
import type { DshAgent, DshContext } from "../lib/dsh-types.js";
import type { DsmmProfileRuntime } from "../lib/profile-runtime.js";
import { liveRolePolicyIdentity, roleRouteLock, roleRouteRuntimeState } from "../lib/role-routing.js";
import { headerRoutes, nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

const native = { provider: "fixture", model: "native-picked", reasoningEffort: "low" };
const configured = { provider: "fixture", model: "profile-default", reasoningEffort: "max" };

function selection(route = native): ModelSelectionRef {
  return { current: { ...route, reasoningEffort: ReasoningEffortId(route.reasoningEffort) }, assembled: undefined };
}

test("ordinary active roots keep the native model tab instead of implicitly applying the profile primary", async () => {
  const fixture = await nativeRoutingFixture({ defaultActive: true, roleRouting: { "dsmm-orchestrator": { primary: configured } } });
  try {
    const agent = await fixture.create({}, selection());
    await runFixtureTurn(agent); await runFixtureTurn(agent);
    assert.deepEqual(headerRoutes(agent), [native]);
    assert.deepEqual(fixture.adapter.calls.map(({ provider, model, reasoningEffort }) => ({ provider, model, reasoningEffort })), [native, native]);
    assert.equal(agent.session.snapshotEvents().some((event) => event.type === "model/selection"), false, "a native default is not fabricated human intent");
  } finally { await fixture.dispose(); }
});

test("a top-level role preset does not preflight an unavailable profile primary over the native root model", async () => {
  const fixture = await nativeRoutingFixture({ roleRouting: { "dsmm-orchestrator": { primary: configured } } });
  try {
    fixture.adapter.unavailableModels.add(configured.model);
    const agent = await fixture.create({ agentPreset: "dsmm-orchestrator" }, selection());
    await runFixtureTurn(agent);
    assert.deepEqual(headerRoutes(agent), [native]);
    assert.equal(fixture.adapter.calls.length, 1);
  } finally { await fixture.dispose(); }
});

test("accepted model intent never replays over a root's later native assembled selection", async () => {
  const fixture = await nativeRoutingFixture({ defaultActive: true, roleRouting: { "dsmm-orchestrator": { primary: configured } } });
  try {
    const picked = selection(configured);
    const original = await fixture.create({}, picked);
    original.session.append("model/selection", { ...configured, reasoningEffort: ReasoningEffortId(configured.reasoningEffort) });
    await runFixtureTurn(original);
    picked.current = selection().current;
    await runFixtureTurn(original);
    assert.deepEqual(headerRoutes(original).at(-1), native, "DSMM must not replay the older accepted event over native downstream");
    assert.deepEqual(fixture.adapter.calls.map(({ model }) => model), [configured.model, native.model]);
  } finally { await fixture.dispose(); }
});

for (const effort of ["low", undefined]) test(`root routing preserves the native ${effort ?? "adapter-default"} effort`, async () => {
  const fixture = await nativeRoutingFixture();
  try {
    const current = { provider: "deepseek-official", model: "deepseek-v4-pro", ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }) };
    const agent = await fixture.create({ agentPreset: "dsmm-orchestrator" }, { current, assembled: undefined });
    await runFixtureTurn(agent);
    assert.deepEqual(headerRoutes(agent), [{ ...current, reasoningEffort: effort ?? "high" }]);
  } finally { await fixture.dispose(); }
});

test("ordinary root RATE_LIMIT retries stay finite on the native model without silently switching profile channels", async () => {
  const fixture = await nativeRoutingFixture({ defaultActive: true, roleRouting: { "dsmm-orchestrator": {
    primary: configured, fallbackRoutes: [{ provider: "deepseek-official", model: "automatic-backup", reasoningEffort: "max" }],
    strategy: "rate-limit-fallback", rateLimit: { maxRetries: 2, switchAfterRateLimits: 1, maxSwitches: 2, initialDelayMs: 0, maxDelayMs: 0, maxTotalDelayMs: 0 }
  } } });
  try {
    const agent = await fixture.create({}, selection());
    fixture.adapter.beforeStream = async () => { throw new LlmError("root native rate limit", "RATE_LIMIT", { status: 429 }); };
    let nativeFallthrough = 0;
    fixture.ctx.on("agent/request-error", async () => { nativeFallthrough += 1; return { kind: "retry" }; });
    await runFixtureTurn(agent);
    assert.deepEqual(fixture.adapter.calls.map(({ provider, model, reasoningEffort }) => ({ provider, model, reasoningEffort })), [native, native, native]);
    assert.equal(nativeFallthrough, 0, "owned root retry exhaustion must not reach native always retry");
    assert.deepEqual(headerRoutes(agent), [native]);
    const runtime = (fixture.ctx as unknown as DshContext).get!<DsmmProfileRuntime>("dsmmProfileRuntime")!;
    const admitted = runtime.admission(agent as unknown as DshAgent);
    const state = roleRouteRuntimeState(agent as unknown as DshAgent, admitted.settings, "dsmm-orchestrator", admitted.epoch);
    assert.equal(state.strategy, "startup-lock", "runtime status reports native-only root behavior, not the dormant declared switch strategy");
    assert.equal(state.retries, 2); assert.equal(state.switches, 0);
    assert.equal(admitted.settings.roleRouting["dsmm-orchestrator"]!.strategy, "rate-limit-fallback", "display does not mutate profile configuration");
    const identity = liveRolePolicyIdentity(agent as unknown as DshAgent, admitted.settings, "dsmm-orchestrator", admitted.epoch)!;
    assert.deepEqual(roleRouteLock(agent as unknown as DshAgent, identity)!.candidates, [native]);
  } finally { await fixture.dispose(); }
});

test("initial root UNKNOWN_MODEL never authorizes an automatic profile or global model switch", async () => {
  const fixture = await nativeRoutingFixture({ defaultActive: true, runtimeRecovery: { fallbackRoutes: [configured] }, roleRouting: { "dsmm-orchestrator": {
    primary: configured, fallbackRoutes: [{ provider: "deepseek-official", model: "automatic-backup" }]
  } } });
  try {
    const agent = await fixture.create({}, selection());
    fixture.adapter.beforeStream = async () => { throw new LlmError("root native model disappeared", "UNKNOWN_MODEL"); };
    let nativeFallthrough = 0;
    fixture.ctx.on("agent/request-error", async () => { nativeFallthrough += 1; return { kind: "retry" }; });
    await runFixtureTurn(agent);
    assert.deepEqual(fixture.adapter.calls.map(({ provider, model, reasoningEffort }) => ({ provider, model, reasoningEffort })), [native]);
    assert.equal(nativeFallthrough, 0);
  } finally { await fixture.dispose(); }
});

test("root pending retry preserves the exact downstream native request configuration", async () => {
  const fixture = await nativeRoutingFixture({ defaultActive: true, roleRouting: { "dsmm-orchestrator": {
    primary: configured, rateLimit: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0, maxTotalDelayMs: 0 }
  } } });
  try {
    let requests = 0;
    const agent = await fixture.create({}, undefined, { setup(agentCtx) {
      agentCtx.on("agent/request", async (_frame, next) => {
        const downstream = await next();
        return ++requests === 2 ? { ...downstream, reasoningEffort: ReasoningEffortId("high") } : downstream;
      });
      installModelSelection(agentCtx, selection());
    } });
    fixture.adapter.beforeStream = async () => {
      if (fixture.adapter.calls.length === 1) throw new LlmError("root native retry before newer assembly", "RATE_LIMIT", { status: 429 });
    };
    await runFixtureTurn(agent);
    assert.deepEqual(fixture.adapter.calls.map(({ reasoningEffort }) => reasoningEffort), ["low", "high"]);
    assert.deepEqual(headerRoutes(agent), [native, { ...native, reasoningEffort: "high" }]);
    assert.equal(agent.session.snapshotEvents().some((event) => event.type === "model/selection"), false);
  } finally { await fixture.dispose(); }
});

for (const output of ["text", "tool-fragment"] as const) test(`partial root ${output} refuses same-model RATE_LIMIT retry without native always fallthrough`, async () => {
  const fixture = await nativeRoutingFixture({ defaultActive: true, roleRouting: { "dsmm-orchestrator": {
    primary: configured, strategy: "rate-limit-fallback", rateLimit: { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0, maxTotalDelayMs: 0 }
  } } });
  try {
    const agent = await fixture.create({}, selection());
    fixture.adapter.streamChunks = async function* () {
      if (output === "text") yield { type: "text-delta", index: 0, text: "accepted partial root output" };
      else yield { type: "tool-call-delta", index: 0, id: ToolCallId("partial-root-tool"), name: "read", argumentsDelta: "{" };
      throw new LlmError("partial root rate limit", "RATE_LIMIT", { status: 429 });
    };
    let nativeFallthrough = 0;
    fixture.ctx.on("agent/request-error", async () => { nativeFallthrough += 1; return { kind: "retry" }; });
    await runFixtureTurn(agent);
    assert.equal(fixture.adapter.calls.length, 1); assert.equal(nativeFallthrough, 0);
    assert.equal(agent.session.snapshotEvents().some((event) => event.type === "tool/call" || event.type === "tool/result"), false);
    const attempts = agent.session.snapshotEvents().filter((event) => event.type === "assistant/attempt");
    assert.equal(attempts.length, 1); assert.ok(attempts[0].data.stream.length > 1);
  } finally { await fixture.dispose(); }
});

test("native cancellation after downstream assembly prevents provider dispatch", async () => {
  const fixture = await nativeRoutingFixture({ defaultActive: true, roleRouting: { "dsmm-orchestrator": { primary: configured } } });
  try {
    const agent = await fixture.create({}, selection(), { setup(scope) {
      scope.on("agent/request", async (frame, next) => {
        const config = await next();
        frame.agent.cancel({ kind: "hook", reason: "local request cancellation" });
        return config;
      });
    } });
    await runFixtureTurn(agent);
    assert.equal(fixture.adapter.calls.length, 0);
    assert.deepEqual(headerRoutes(agent), []);
  } finally { await fixture.dispose(); }
});

test("native cancellation of a no-output failure does not dispatch another retry", async () => {
  const fixture = await nativeRoutingFixture({ defaultActive: true, roleRouting: { "dsmm-orchestrator": {
    rateLimit: { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0, maxTotalDelayMs: 0 }
  } } });
  try {
    const agent = await fixture.create({}, selection());
    fixture.adapter.rateLimitModels.add(native.model);
    fixture.ctx.on("agent/assistant-stream", ({ agent: subject, frame }) => {
      if (subject === agent && frame.type === "end") agent.cancel({ kind: "hook", reason: "local retry cancellation" });
    });
    await runFixtureTurn(agent);
    assert.equal(fixture.adapter.calls.length, 1);
    assert.deepEqual(headerRoutes(agent), [native]);
  } finally { await fixture.dispose(); }
});
