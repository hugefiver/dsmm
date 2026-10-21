import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalModelRouteJson, normalizeModelRouteJson, sameModelRouteJson } from "../src/route-json.ts";
import { DSMM_CONFIG_SCHEMA, DSMM_NATIVE_CONFIG_SCHEMA, DSMM_SETTINGS_SCHEMA, deploymentEditorSchema, normalizeLevelOverride, resolveConfig, resolveDeployment, validateDeploymentPath, validateSparseConfig } from "../src/settings.ts";
import { parseProfileDocument, resolveProfileSettings, validateProfileOverlay } from "../src/profiles.ts";
import { admissionFromChildCapture, parseChildAdmissionCapture } from "../src/child-capture.ts";
import type { ChildAdmissionCapture, ChildAdmissionCaptureV3 } from "../src/child-capture.ts";
import { resolvedModelParameterPolicy } from "../src/model-parameter-policy.ts";
import { ProfileStore } from "../src/profile-store.ts";
import { parseDsmmInvocationView, TYPERT_REMOTE } from "../src/profile-remote.ts";

const route = { provider: "fixture", model: "finite-model", reasoningEffort: "medium", temperature: 0, maxTokens: 1, stop: [],
  custom_flag: false, custom_zero: 0, custom_null: null, custom_empty: {}, custom_array: [],
  custom_nested: { values: [false, 0, null, {}, ["中文", "😀"]], headers: { arbitrary_data: true } },
  toString: "llm-data", hasOwnProperty: false,
  customParameters: { original_field: false }, custom_text: "\ufeffdata" };
const overlay = { roleRouting: { "dsmm-reviewer": { primary: route, levels: { max: route }, fallbackRoutes: [route, { ...route, custom_flag: true }] } },
  runtimeRecovery: { fallbackRoutes: [route, { ...route, custom_flag: true }, route] } };
const content = JSON.stringify({ version: 1, id: "raw-route", settings: overlay });

test("route JSON preserves own mixed values, arbitrary fields, exact effort text and detached nested objects", () => {
  const result = normalizeModelRouteJson(route);
  assert.deepEqual(result, route);
  assert.notEqual(result.custom_nested, route.custom_nested);
  assert.equal(Object.hasOwn(result, "custom_null"), true);
  assert.equal(Object.hasOwn(normalizeModelRouteJson({ provider: "p", model: "m" }), "reasoningEffort"), false);
  assert.equal(normalizeLevelOverride({ ...route, reasoningEffort: " provider-specific " }).reasoningEffort, " provider-specific ");
  assert.equal(normalizeLevelOverride({ reasoningEffort: " provider-specific " }).reasoningEffort, " provider-specific ");
  assert.deepEqual(normalizeModelRouteJson({ provider: "p", model: "m", metadata: { permissions: false, role: "data", model: "data" } }).metadata,
    { permissions: false, role: "data", model: "data" });
});

test("source schemas, native volatile refs and resolvers retain complete routes and ordered per-entry fallback values", () => {
  for (const parse of [validateSparseConfig, DSMM_CONFIG_SCHEMA]) assert.deepEqual(parse(overlay), overlay);
  const native = DSMM_NATIVE_CONFIG_SCHEMA(overlay);
  assert.deepEqual((native.roleRouting as unknown as { get(): unknown }).get(), overlay.roleRouting);
  assert.deepEqual((native.runtimeRecovery as unknown as { get(): unknown }).get(), overlay.runtimeRecovery);
  const settings = resolveConfig(overlay);
  assert.deepEqual(settings.roleRouting, overlay.roleRouting);
  assert.deepEqual(settings.runtimeRecovery.fallbackRoutes, overlay.runtimeRecovery.fallbackRoutes);
  assert.deepEqual(DSMM_SETTINGS_SCHEMA(settings).roleRouting, overlay.roleRouting);
  assert.deepEqual(DSMM_SETTINGS_SCHEMA(settings).runtimeRecovery.fallbackRoutes, overlay.runtimeRecovery.fallbackRoutes);
  assert.notEqual(settings.runtimeRecovery.fallbackRoutes[0], settings.runtimeRecovery.fallbackRoutes[2]);
  const schema = deploymentEditorSchema().fields!.roleRouting.inner!.fields!.primary.alternatives![1];
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, "json");
});

test("named full routes replace baseline extras while deployment primary sparse merge and null data stay explicit", () => {
  const baseline = { roleRouting: { "dsmm-reviewer": { primary: route, levels: { max: route } } } };
  const replacement = { provider: "fixture", model: "finite-model", custom_null: null };
  const named = parseProfileDocument(JSON.stringify({ version: 1, id: "raw-route", settings: {
    roleRouting: { "dsmm-reviewer": { primary: replacement, levels: { max: replacement } } } } }));
  const resolved = resolveProfileSettings(baseline, named.settings);
  assert.deepEqual(resolved.roleRouting["dsmm-reviewer"]!.primary, replacement);
  assert.deepEqual(resolved.roleRouting["dsmm-reviewer"]!.levels!.max, replacement);
  const sparse = resolveDeployment(baseline, { roleRouting: { "dsmm-reviewer": { primary: { custom_flag: true, custom_null: null } as typeof route } } });
  assert.deepEqual(sparse.roleRouting["dsmm-reviewer"]!.primary, { ...route, custom_flag: true });
  assert.deepEqual(parseProfileDocument(content).settings, overlay);
  assert.throws(() => resolveDeployment(baseline, { roleRouting: { "dsmm-reviewer": { primary: { max_tokens: 2 } as unknown as typeof route } } }));
  assert.deepEqual(resolveProfileSettings(baseline, { roleRouting: { "dsmm-reviewer": { primary: { provider: "fixture", model: "finite-model", max_tokens: 2 } } } })
    .roleRouting["dsmm-reviewer"]!.primary, { provider: "fixture", model: "finite-model", max_tokens: 2 });
});

test("only finite lossless plain route data is accepted without invoking accessors", () => {
  let accessed = false;
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { accessed = true; return 1; } });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const hidden = Object.defineProperty({}, "value", { value: 1 });
  const symbol = { [Symbol("value")]: 1 };
  const deep: Record<string, unknown> = {}; let cursor = deep;
  for (let i = 0; i < 34; i++) { const child = {}; cursor.child = child; cursor = child; }
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -0, 1n, Symbol("value"), () => 1, new Date(), accessor, hidden, symbol, cycle,
    new Array(1), Object.create({ value: 1 }), JSON.parse('{"constructor":{}}'), JSON.parse('{"__proto__":{}}'), deep, "x".repeat(128 * 1024)]) {
    const input = { provider: "p", model: "m", custom: value };
    assert.throws(() => normalizeModelRouteJson(input));
    assert.throws(() => validateSparseConfig({ roleRouting: { "dsmm-reviewer": { primary: input } } }));
    assert.throws(() => validateProfileOverlay({ roleRouting: { "dsmm-reviewer": { primary: input } } }));
  }
  assert.equal(accessed, false);
});

test("known field types, Host envelope keys and native-alias conflicts fail instead of silently winning", () => {
  const invalid: Record<string, unknown>[] = [{ provider: "https://unsafe" }, { model: "https://unsafe" }, { reasoningEffort: null }, { temperature: null },
    { temperature: "0" }, { maxTokens: 0 }, { maxTokens: 1.2 }, { stop: [false] }, { stop: null },
    { reasoningEffort: "medium", reasoning_effort: "high" }, { maxTokens: 1, max_tokens: 2 }];
  for (const key of ["messages", "tools", "headers", "api_key", "base_url", "endpoint", "signal", "permissions", "role", "session_id", "onPayload", "adapterDefaults",
    "readOnly", "toolFilter", "guards", "authorityCeiling", "allowRouteOverride", "runtimePolicyCapture"])
    invalid.push({ [key]: {} });
  for (const changes of invalid) assert.throws(() => normalizeModelRouteJson({ provider: "p", model: "m", ...changes }));
  assert.deepEqual(normalizeModelRouteJson({ provider: "p", model: "m", max_tokens: 2, reasoning_effort: "custom-effort" }),
    { provider: "p", model: "m", max_tokens: 2, reasoning_effort: "custom-effort" });
  assert.throws(() => resolveConfig({ runtimeRecovery: { fallbackRoutes: [{ provider: "p", model: " " }] } }));
  assert.throws(() => normalizeLevelOverride({ reasoningEffort: "medium", custom: false }));
  assert.throws(() => validateProfileOverlay({ custom: false }));
  validateDeploymentPath(["roleRouting", "dsmm-reviewer", "primary", "custom_nested", "headers"]);
  assert.throws(() => validateDeploymentPath(["roleRouting", "dsmm-reviewer", "primary", "headers"]));
  assert.throws(() => validateDeploymentPath(["roleRouting", "dsmm-reviewer", "primary", "custom_nested", "constructor"]));
});

test("complete-value canonical identity ignores object key order but retains own null and parameter differences", () => {
  assert.equal(canonicalModelRouteJson({ provider: "p", model: "m", data: { b: false, a: null } }),
    canonicalModelRouteJson({ data: { a: null, b: false }, model: "m", provider: "p" }));
  assert.equal(sameModelRouteJson(route, { ...route, custom_flag: true }), false);
  assert.equal(sameModelRouteJson({ provider: "p", model: "m" }, { provider: "p", model: "m", value: null }), false);
});

function capture(initialRoute: ChildAdmissionCapture["invocation"]["initialRoute"]): ChildAdmissionCaptureV3 {
  const settings = resolveConfig(overlay);
  return { version: 3, delegationMode: "continuable", modelParameterPolicy: { mode: "passthrough" }, childSessionId: "opaque-child", parentSessionId: "opaque-parent", role: "dsmm-reviewer", profilePin: null,
    originalAdmissionEpoch: "a".repeat(64), invocation: { level: "max", initialRoute, requestedRoute: initialRoute, effortSource: "dsmm-config", routeSource: "level" },
    runtimePolicyCapture: { modules: settings.modules, skills: settings.skills, defaultActive: settings.defaultActive,
      roleRouting: settings.roleRouting, runtimePolicy: settings.runtimePolicy, workflow: settings.workflow, guards: settings.guards,
      runtimeRecovery: settings.runtimeRecovery, subagents: { enableRunInBackground: false, backgroundMode: "one-shot" } },
    authorityCeiling: { roles: ["dsmm-reviewer"], readOnly: true, allowRouteOverride: false, maxDepth: 1 }, toolTopology: "per-role" };
}

test("v3 persists full routes and strict v1 restores historical policy without rewriting its original file", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsmm-route-json-"));
  try {
    const store = new ProfileStore(join(root, "dsmm-profiles"));
    const saved = await store.save({ id: "raw-route", expectedRevision: null, content });
    assert.equal((await new ProfileStore(store.profileDir).read(saved.id)).content, content);
    const input = capture(route);
    const written = await store.createChildAdmission(input);
    assert.deepEqual(written, input);
    assert.ok(Object.isFrozen(written.invocation.initialRoute.custom_nested));
    assert.deepEqual(await new ProfileStore(store.profileDir).readChildAdmission(input.childSessionId, input.parentSessionId), input);
    const { modelParameterPolicy: _policy, delegationMode: _delegationMode, invocation: { requestedRoute: _requested, effortSource: _source, ...invocation }, ...legacy } = capture({ provider: "fixture", model: "old", reasoningEffort: "low" });
    const old: ChildAdmissionCapture = { ...legacy, version: 1, invocation, runtimePolicyCapture: { ...legacy.runtimePolicyCapture,
      deepseekV4ProCalibration: "auto", deepseekV4ProDefaultReasoningEffort: "high", deepseekFlashCalibration: "off", deepseekFlashDefaultReasoningEffort: "low" } };
    old.childSessionId = "old-child"; old.runtimePolicyCapture.roleRouting = {};
    old.runtimePolicyCapture.runtimeRecovery.fallbackRoutes = [];
    await assert.rejects(store.createChildAdmission(old), { code: "validation" });
    const digest = (input: string) => createHash("sha256").update(input).digest("hex");
    const path = join(store.stateDir, ".children", "v1", `${digest(old.childSessionId)}.json`);
    const bytes = JSON.stringify({ version: 1, revision: digest(JSON.stringify(old)), capture: old });
    await writeFile(path, bytes, { flag: "wx" });
    const reopened = await new ProfileStore(store.profileDir).readChildAdmission(old.childSessionId, old.parentSessionId);
    assert.deepEqual(reopened, old);
    const future = resolveConfig({ guards: { gitWriteGuard: "off" }, roleRouting: { "dsmm-reviewer": { primary: route } } });
    const admitted = admissionFromChildCapture(reopened!, future);
    assert.equal(admitted.epoch, old.originalAdmissionEpoch);
    assert.deepEqual(admitted.childCapture!.invocation.initialRoute, old.invocation.initialRoute);
    assert.equal(admitted.settings.guards.gitWriteGuard, old.runtimePolicyCapture.guards.gitWriteGuard);
    assert.deepEqual(admitted.settings.roleRouting, {});
    assert.throws(() => parseChildAdmissionCapture({ ...input, parameters: {} }));
    const missingGuard = structuredClone(input); Reflect.deleteProperty(missingGuard.runtimePolicyCapture.guards, "gitWriteGuard");
    assert.throws(() => parseChildAdmissionCapture(missingGuard));
    assert.throws(() => parseChildAdmissionCapture({ ...input, invocation: { ...input.invocation, initialRoute: { ...route, permissions: true } } }));
    assert.equal(admitted.settings.subagents.allowRouteOverride, false);
    assert.equal(admitted.childCapture!.authorityCeiling.readOnly, true);
    assert.equal(resolvedModelParameterPolicy(admitted).mode, "legacy-native-v1");
    assert.equal(resolvedModelParameterPolicy(admissionFromChildCapture(old, resolveConfig({ modelParameters: { passthrough: false } }))).mode, "legacy-native-v1");
    assert.equal(await readFile(path, "utf8"), bytes);
    assert.throws(() => parseChildAdmissionCapture({ ...old, invocation: { ...old.invocation, initialRoute: route } }));
    assert.throws(() => parseChildAdmissionCapture({ ...old, runtimePolicyCapture: { ...old.runtimePolicyCapture, modelParameters: { passthrough: true } } }));
    assert.throws(() => parseChildAdmissionCapture({ ...old, version: 3 }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("strict native route DTO codecs preserve extras while non-route unknown fields remain rejected", () => {
  const invocation = { role: "dsmm-reviewer", label: "Reviewer", level: "max", routeSource: "level", route, mode: "one-shot" };
  assert.deepEqual(parseDsmmInvocationView(invocation), invocation);
  assert.throws(() => parseDsmmInvocationView({ ...invocation, custom_null: null }));
  const descriptor = TYPERT_REMOTE.descriptors.find(row => row.method === "describeSession")!;
  assert.equal(descriptor.result.mode, "strict");
  if (descriptor.result.mode !== "strict") throw new Error("Strict route codec required");
  const parse = descriptor.result.create().parse;
  const snapshot = { sessionId: "session", globalDefault: { selectedId: null, appliedRevision: null, selectionRevision: "absent" },
    selection: { selectedId: null, appliedRevision: null, selectionRevision: "absent" }, scope: "deployment-baseline",
    admissionEpoch: "a".repeat(64), switchAllowed: true, profileModel: route,
    canSelectModel: true, canToggleMode: false, toggleModeUnavailableReason: "runtime-unavailable",
    canApplyOverlay: false, applyOverlayUnavailableReason: "new-session-required" };
  assert.deepEqual(parse(snapshot), snapshot);
  assert.throws(() => parse({ ...snapshot, profileModel: JSON.parse('{"provider":"p","model":"m","constructor":{}}') }));
});
