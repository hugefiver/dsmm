import assert from "node:assert/strict";
import { test } from "node:test";
import { modelRouteFromCall, modelRouteFromHeader, modelRouteToCall, projectModelRouteParameters, withRouteEffort } from "../src/role-llm.ts";
import { applyModelRoute, captureSetupModelSelections, latestNativeModelSelection, orderedModelRoutes, liveRolePolicyIdentity, pinRoleRoute, roleRouteLock, persistedRoleRoute, selectInitialModelRouteChoice, selectModelRouteForNextStep } from "../src/role-routing.ts";
import type { DshAgent, DshModelSelection } from "../src/dsh-types.ts";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { resolveConfig, resolveDeployment, validateSparseConfig, validateDeploymentPath, DSMM_NATIVE_CONFIG_SCHEMA } from "../src/settings.ts";
import { resolveProfileSettings, parseProfileDocument } from "../src/profiles.ts";
import { configuredModelParameterPolicy } from "../src/model-parameter-policy.ts";
import type { ModelRouteJson } from "../src/route-json.ts";

const primary: ModelRouteJson = { provider: "apai", model: "gpt-6.1-sol", reasoningEffort: "medium", temperature: 0, stop: [],
  customParameters: { flag: false, zero: 0, missing: null, items: [[], {}, { value: null }] }, primary_only: false };

test("Core parameter policy defaults on and follows sparse deployment and named overlays independently of Deepwork", () => {
  const global = { modules: { deepwork: { enabled: false } }, modelParameters: { passthrough: false } };
  assert.equal(configuredModelParameterPolicy(resolveConfig({ modules: global.modules })).mode, "passthrough");
  const baseline = resolveDeployment(global, {});
  assert.equal(configuredModelParameterPolicy(baseline).mode, "native-defaults");
  assert.equal(resolveDeployment(global, { modelParameters: { passthrough: true } }).modelParameters.passthrough, true);
  const named = parseProfileDocument(JSON.stringify({ version: 1, id: "parameters", settings: { modelParameters: { passthrough: true } } }));
  const effective = resolveProfileSettings(baseline, named.settings);
  assert.equal(effective.modules.deepwork.enabled, false);
  assert.equal(effective.modelParameters.passthrough, true);
  assert.equal(baseline.modelParameters.passthrough, false);
  validateDeploymentPath(["modelParameters", "passthrough"]);
  const native = DSMM_NATIVE_CONFIG_SCHEMA({ modelParameters: { passthrough: false } }).modelParameters as unknown as { get(): unknown };
  assert.deepEqual(native.get(), { passthrough: false });
  for (const modelParameters of [null, false, { passthrough: null }, { passthrough: "false" }, { enabled: true }]) {
    assert.throws(() => validateSparseConfig({ modelParameters }));
    assert.throws(() => parseProfileDocument(JSON.stringify({ version: 1, id: "invalid", settings: { modelParameters } })));
  }
});

test("parameter projection defaults to lossless passthrough and never changes requested JSON", () => {
  const saved = structuredClone(primary);
  const call = projectModelRouteParameters(primary, "dsmm-config");
  assert.deepEqual(modelRouteFromCall(call), primary);
  assert.notEqual(call.customParameters?.customParameters, primary.customParameters);
  assert.deepEqual(primary, saved);
});

test("off projection excludes opaque fields and both configured effort aliases but keeps native SDK parameters", () => {
  const { reasoningEffort: _effort, ...base } = primary;
  for (const effort of [{ reasoningEffort: "medium" }, { reasoning_effort: "medium" }]) {
    const requested = { ...base, ...effort, maxTokens: 128, stop: ["END"] };
    const saved = structuredClone(requested);
    const call = projectModelRouteParameters(requested, "dsmm-config", false);
    assert.deepEqual(call, { provider: primary.provider, model: primary.model, temperature: 0, maxTokens: 128, stop: ["END"] });
    assert.notEqual(call.stop, requested.stop);
    assert.deepEqual(requested, saved);
  }
  assert.deepEqual(projectModelRouteParameters({ provider: primary.provider, model: primary.model, max_tokens: 128 }, "dsmm-config", false),
    { provider: primary.provider, model: primary.model });
});

test("off projection preserves independently native effort and leaves omitted effort for the adapter", () => {
  const native = { provider: "native-provider", model: "native-model", reasoningEffort: "low", maxTokens: 64 };
  assert.deepEqual(projectModelRouteParameters(native, "native", false), native);
  const omitted = { provider: native.provider, model: native.model };
  assert.deepEqual(projectModelRouteParameters(omitted, "native", false), omitted);
  assert.throws(() => projectModelRouteParameters({ ...primary, reasoning_effort: "high" }, "dsmm-config", false));
  assert.throws(() => projectModelRouteParameters({ ...primary, headers: {} }, "dsmm-config", false));
});

test("metadata preflight keeps adapter-default effort out of the selected proposal", async () => {
  const candidate = { provider: "fixture", model: "default-effort", temperature: 0 };
  const choice = await selectInitialModelRouteChoice({
    async resolveModelInfo() { throw new Error("unused"); },
    async resolveCallConfig(call) { return { ...call, reasoningEffort: "medium", maxTokens: 256 }; },
  }, [candidate]);
  assert.deepEqual(choice.requestedRoute, candidate);
  assert.deepEqual(choice.proposal, candidate);
  assert.deepEqual(choice.effective, { ...candidate, reasoningEffort: "medium", maxTokens: 256 });
});

test("route application keeps the selected candidate's complete parameter boundary", () => {
  const route = { provider: "fixture", model: "fixed", temperature: 0.8, stop: ["NEW"], selected_only: true };
  const downstream = modelRouteToCall({ provider: route.provider, model: route.model, temperature: 0.2, maxTokens: 64, stop: ["OLD"], old_only: true });
  assert.deepEqual(modelRouteFromCall(applyModelRoute(downstream, route)), route);
});

test("native call envelopes round-trip original route names and detached JSON presence", () => {
  const call = modelRouteToCall(primary);
  assert.deepEqual(modelRouteFromCall(call), primary);
  assert.deepEqual(call.customParameters?.customParameters, primary.customParameters);
  assert.notEqual(call.customParameters?.customParameters, primary.customParameters);
  assert.deepEqual(call.customParameters?.stop, []);
  for (const value of [false, 0, null, [], {}]) {
    const route = { provider: primary.provider, model: primary.model, customParameters: value };
    assert.deepEqual(modelRouteFromCall(modelRouteToCall(route)), route);
  }
});

test("fallback replacement retains only its own full parameters without mutating the primary", () => {
  const call = modelRouteToCall(primary);
  const original = structuredClone(call);
  const fallback = { provider: "apai", model: "gpt-5.6-terra", reasoningEffort: "high", fallback_only: null };
  assert.deepEqual(modelRouteFromCall(applyModelRoute(call, fallback)), fallback);
  assert.deepEqual(call, original);
  const reordered = { primary_only: false, customParameters: primary.customParameters, stop: [], temperature: 0,
    reasoningEffort: "medium", model: primary.model, provider: primary.provider };
  assert.deepEqual(orderedModelRoutes([primary, reordered, { ...primary, primary_only: true }]), [primary, { ...primary, primary_only: true }]);
});

test("same-triple fallback replaces primary-only parameters with its own complete route", () => {
  const triple = { provider: "fixture", model: "same", reasoningEffort: "high" };
  const primaryCall = modelRouteToCall({ ...triple, temperature: 0.2, primary_only: true });
  const fallback = { ...triple, temperature: 0.8, fallback_only: true };
  assert.deepEqual(modelRouteFromCall(applyModelRoute(primaryCall, fallback)), fallback);
});

test("effort-only overrides replace either effort spelling without rewriting captured input", () => {
  for (const original of [primary, { provider: primary.provider, model: primary.model, reasoning_effort: "medium", data: [false, null] }]) {
    const snapshot = structuredClone(original);
    const next = withRouteEffort(original, "provider-specific");
    assert.equal(next.reasoningEffort, "provider-specific");
    assert.equal(Object.hasOwn(next, "reasoning_effort"), false);
    assert.deepEqual(modelRouteFromCall(modelRouteToCall(next)), next);
    assert.deepEqual(original, snapshot);
  }
});

test("header route extraction excludes only declared adapter defaults and rejects envelope collisions", () => {
  const config = { ...modelRouteToCall(primary), maxTokens: 128 };
  const extracted = modelRouteFromHeader({ config, adapterDefaults: { maxTokens: true, reasoningEffort: true } });
  const { reasoningEffort: _effort, ...explicit } = primary;
  assert.deepEqual(extracted, explicit);
  assert.deepEqual(modelRouteFromHeader({ config, adapterDefaults: { maxTokens: false, reasoningEffort: false } }), { ...primary, maxTokens: 128 });
  assert.throws(() => modelRouteFromCall({ provider: primary.provider, model: primary.model, customParameters: { provider: "foreign" } }));
  assert.throws(() => modelRouteToCall({ ...primary, reasoning_effort: "high" }));
});

test("extended policy identity is key-order independent and binds parameter-only changes", () => {
  const agent: DshAgent = { session: { events: [], append() {} } };
  const identity = (parameters: { a: null; b: boolean }) => liveRolePolicyIdentity(agent, resolveConfig({ roleRouting: {
    "dsmm-reviewer": { primary: { ...primary, parameters }, fallbackRoutes: [] },
  } }), "dsmm-reviewer", "original-admission");
  assert.equal(identity({ a: null, b: false }), identity({ b: false, a: null }));
  assert.notEqual(identity({ a: null, b: false }), identity({ a: null, b: true }));
});

test("route locks follow relevant policy and admission lifecycle, not unrelated settings", () => {
  const agent: DshAgent = { session: { events: [], append() {} } };
  const settings = resolveConfig({ roleRouting: { "dsmm-reviewer": { primary } } });
  const first = liveRolePolicyIdentity(agent, settings, "dsmm-reviewer", "epoch")!;
  const lock = pinRoleRoute(agent, first, primary, [primary]);
  const unrelated = resolveConfig({ ...settings, locale: "zh-Hans" });
  assert.equal(roleRouteLock(agent, liveRolePolicyIdentity(agent, unrelated, "dsmm-reviewer", "epoch")!), lock);
  assert.equal(roleRouteLock(agent, liveRolePolicyIdentity(agent, settings, "dsmm-reviewer", "next-epoch")!), undefined);
  assert.notEqual(liveRolePolicyIdentity({ session: { events: [], append() {} } }, settings, "dsmm-reviewer", "epoch"), first);
});

test("historical policy markers cannot authorize a current persisted route and remain untouched", () => {
  const events = [{ type: "dsmm/role-policy", data: { version: 1, role: "dsmm-reviewer", policy: "a".repeat(64) } },
    { type: "request/header", data: { reason: "initial", header: { config: { provider: "native", model: "historical-fallback" } } } }];
  const original = structuredClone(events), agent: DshAgent = { session: { events, append() {} } };
  assert.equal(persistedRoleRoute({ agent }, primary, [], "a".repeat(64)), undefined);
  assert.equal(persistedRoleRoute({ agent }, primary, [], liveRolePolicyIdentity(agent, resolveConfig(), "dsmm-reviewer", "epoch")), undefined);
  assert.deepEqual(events, original);
});

test("DSMM selection associations survive reload without claiming a same-value native event", () => {
  const route: DshModelSelection = { provider: "fixture", model: "owned" };
  const session = Session.create(SessionId("selection-association"));
  let current: DshModelSelection | undefined;
  const agent = { session, model: {
    current: () => current === undefined ? undefined : { ...current },
    select(selection: DshModelSelection) {
      if (current?.provider === selection.provider && current.model === selection.model && current.reasoningEffort === selection.reasoningEffort) return;
      current = { ...selection }; session.append("model/selection", { ...selection });
    },
  } } as unknown as DshAgent;
  selectModelRouteForNextStep(agent, route);
  assert.equal(latestNativeModelSelection(agent), undefined);
  assert.ok(session.snapshotEvents().some(event => event.type === "plugin:dsmm/model-selection"));

  const reloaded = Session.create(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())), session.header, session.inheritedEventCount);
  const resumed = { session: reloaded } as unknown as DshAgent;
  assert.equal(latestNativeModelSelection(resumed), undefined);
  reloaded.append("model/selection", { provider: "fixture", model: "manual" });
  assert.deepEqual(latestNativeModelSelection(resumed)?.route, { provider: "fixture", model: "manual" });

  const same = Session.create(SessionId("same-value-native-selection"));
  same.append("model/selection", route);
  const sameAgent = { session: same, model: { current: () => ({ ...route }), select() {} } } as unknown as DshAgent;
  selectModelRouteForNextStep(sameAgent, route);
  assert.deepEqual(latestNativeModelSelection(sameAgent)?.route, route);
  assert.equal(same.snapshotEvents().some(event => event.type === "plugin:dsmm/model-selection"), false);
});

test("child setup associations survive consecutive cold objects while preserving historical and later native intent", () => {
  const fresh = Session.create(SessionId("setup-selection-source"));
  const session = Session.create(fresh.id, [], { ...fresh.header, origin: "subagent" });
  const historical = session.append("model/selection", { provider: "fixture", model: "historical-manual" });
  const firstSetup = session.append("model/selection", { provider: "fixture", model: "setup-reconstruction-1" });
  const fixedModel = { current: () => undefined, select() {} };
  captureSetupModelSelections({ session, model: fixedModel } as unknown as DshAgent, Number(historical.seq));

  const coldOnce = Session.create(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())), session.header, session.inheritedEventCount);
  assert.deepEqual(latestNativeModelSelection({ session: coldOnce } as unknown as DshAgent)?.route,
    { provider: "fixture", model: "historical-manual" });
  coldOnce.append("model/selection", { provider: "fixture", model: "setup-reconstruction-2" });
  captureSetupModelSelections({ session: coldOnce, model: fixedModel } as unknown as DshAgent, Number(firstSetup.seq));

  const coldTwice = Session.create(coldOnce.id, JSON.parse(JSON.stringify(coldOnce.snapshotEvents())), coldOnce.header, coldOnce.inheritedEventCount);
  const twiceAgent = { session: coldTwice } as unknown as DshAgent;
  assert.deepEqual(latestNativeModelSelection(twiceAgent)?.route, { provider: "fixture", model: "historical-manual" });
  coldTwice.append("model/selection", { provider: "fixture", model: "resident-manual" });
  assert.deepEqual(latestNativeModelSelection(twiceAgent)?.route, { provider: "fixture", model: "resident-manual" });

  const legacyFresh = Session.create(SessionId("setup-selection-legacy-child"));
  const legacyChild = Session.create(legacyFresh.id, [], { ...legacyFresh.header, origin: "subagent" });
  legacyChild.append("model/selection", { provider: "fixture", model: "explicit-setup-manual" });
  const legacyAgent = { session: legacyChild } as unknown as DshAgent;
  captureSetupModelSelections(legacyAgent, -1);
  assert.deepEqual(latestNativeModelSelection(legacyAgent)?.route, { provider: "fixture", model: "explicit-setup-manual" });
  assert.equal(legacyChild.snapshotEvents().some(event => event.type === "plugin:dsmm/model-selection"), false);

  const root = Session.create(SessionId("setup-selection-native-root"));
  const rootAgent = { session: root } as unknown as DshAgent;
  root.append("model/selection", { provider: "fixture", model: "native-root" });
  captureSetupModelSelections(rootAgent, -1);
  assert.deepEqual(latestNativeModelSelection(rootAgent)?.route, { provider: "fixture", model: "native-root" });
});

test("persisted route decisions require the same Agent's current policy identity", () => {
  const fallback = { provider: "native", model: "fallback" };
  const events: { type: string; data: unknown }[] = [];
  const agent: DshAgent = { session: { events, append() {} } };
  const settings = resolveConfig({ roleRouting: { "dsmm-reviewer": { primary, fallbackRoutes: [fallback] } } });
  const identity = liveRolePolicyIdentity(agent, settings, "dsmm-reviewer", "epoch")!;
  events.push({ type: "dsmm/role-policy", data: { version: 1, role: "dsmm-reviewer", policy: identity } },
    { type: "request/header", data: { reason: "initial", header: { config: fallback } } });
  assert.deepEqual(persistedRoleRoute({ agent }, primary, [fallback], identity), fallback);
  const unrelated = liveRolePolicyIdentity(agent, resolveConfig({ ...settings, locale: "zh-Hans" }), "dsmm-reviewer", "epoch");
  assert.deepEqual(persistedRoleRoute({ agent }, primary, [fallback], unrelated), fallback);
  const other: DshAgent = { session: { events, append() {} } };
  assert.equal(persistedRoleRoute({ agent: other }, primary, [fallback], identity), undefined);
  const next = liveRolePolicyIdentity(agent, settings, "dsmm-reviewer", "next-epoch");
  assert.equal(persistedRoleRoute({ agent }, primary, [fallback], identity), undefined);
  assert.equal(persistedRoleRoute({ agent }, primary, [fallback], next), undefined);
});
