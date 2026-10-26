import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { admissionFromChildCapture, parseChildAdmissionCapture } from "../src/child-capture.ts";
import { ProfileStore } from "../src/profile-store.ts";
import { resolveConfig, validateSparseConfig } from "../src/settings.ts";
import { resolvedModelParameterPolicy } from "../src/model-parameter-policy.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const historical = { deepseekV4ProCalibration: "strict", deepseekV4ProDefaultReasoningEffort: "high", deepseekFlashCalibration: "auto", deepseekFlashDefaultReasoningEffort: "low" };
function payload(version: 1 | 2 | 3, revision = "a".repeat(64)) {
  const settings = resolveConfig({ defaultActive: true, roleRouting: { "dsmm-reviewer": { primary: { provider: "native", model: "model", reasoningEffort: "off" } } } });
  const { modules, roleRouting, runtimePolicy, workflow, guards, runtimeRecovery, defaultActive, skills } = settings;
  return { version, ...version === 3 ? { delegationMode: "one-shot" } : {}, childSessionId: "child", parentSessionId: "parent", role: "dsmm-reviewer", profilePin: { id: "focus", revision },
    originalAdmissionEpoch: "b".repeat(64), invocation: { level: "high", initialRoute: roleRouting["dsmm-reviewer"]!.primary, routeSource: "primary",
      ...version === 1 ? {} : { requestedRoute: roleRouting["dsmm-reviewer"]!.primary, effortSource: "dsmm-config" } },
    runtimePolicyCapture: { modules, roleRouting, runtimePolicy, workflow, guards, runtimeRecovery, defaultActive, skills,
      subagents: { enableRunInBackground: false, backgroundMode: "one-shot" }, ...version === 3 ? {} : historical },
    authorityCeiling: { roles: ["dsmm-reviewer"], readOnly: true, allowRouteOverride: false, maxDepth: 2 }, toolTopology: "per-role",
    ...version === 1 ? {} : { modelParameterPolicy: { mode: "native-defaults" } } };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dsmm-capture-versions-")), root = join(directory, "dsmm-profiles");
  return { root, store: new ProfileStore(root), path: join(root, ".children", "v1", `${hash("child")}.json`), cleanup() { rmSync(directory, { recursive: true, force: true }); } };
}
function persist(path: string, capture: unknown, revision = hash(JSON.stringify(capture))) {
  writeFileSync(path, JSON.stringify({ version: 1, revision, capture }));
}

for (const version of [1, 2] as const) test(`historical v${version} durable evidence is frozen and restored through a current-policy projection without rewrite`, async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, ".children", "v1"), { recursive: true });
    const raw = payload(version); persist(f.path, raw);
    const before = readFileSync(f.path);
    const capture = await f.store.readChildAdmission("child", "parent"); assert.ok(capture);
    assert.deepEqual(capture, raw); assert.equal(Object.isFrozen(capture.runtimePolicyCapture), true);
    const admission = admissionFromChildCapture(capture, resolveConfig());
    validateSparseConfig(admission.settings, true);
    assert.equal(admission.settings.roleRouting["dsmm-reviewer"]?.primary?.reasoningEffort, "off");
    assert.equal(admission.settings.subagents.allowRouteOverride, false);
    assert.equal(admission.settings.subagents.maxDepth, 2);
    assert.equal(admission.epoch, raw.originalAdmissionEpoch);
    assert.deepEqual(admission.profile, raw.profilePin);
    assert.equal(resolvedModelParameterPolicy(admission).mode, version === 1 ? "legacy-native-v1" : "native-defaults");
    assert.deepEqual(admission.childCapture, raw);
    assert.deepEqual(readFileSync(f.path), before);
    await assert.rejects(f.store.createChildAdmission(capture), { code: "validation" });
  } finally { f.cleanup(); }
});

for (const version of [1, 2, 3] as const) test(`v${version} captures without Git scope restore all-writes without changing durable evidence or authority`, async () => {
  const f = fixture();
  try {
    const raw = payload(version);
    Reflect.deleteProperty(raw.runtimePolicyCapture.guards, "gitWriteScope");
    mkdirSync(join(f.root, ".children", "v1"), { recursive: true });
    persist(f.path, raw);
    const before = readFileSync(f.path);
    const parsed = parseChildAdmissionCapture(raw);
    assert.equal(parsed.runtimePolicyCapture.guards.gitWriteScope, "all-writes");
    assert.equal(Object.hasOwn(raw.runtimePolicyCapture.guards, "gitWriteScope"), false);
    const restored = await new ProfileStore(f.root).readChildAdmission("child", "parent");
    assert.deepEqual(restored, parsed);
    const admission = admissionFromChildCapture(restored!, resolveConfig({ guards: { gitWriteScope: "high-risk", gitWriteGuard: "off" }, subagents: { allowRouteOverride: true } }));
    assert.equal(admission.settings.guards.gitWriteScope, "all-writes");
    assert.equal(admission.settings.guards.gitWriteGuard, "ask");
    assert.deepEqual(admission.childCapture?.authorityCeiling, raw.authorityCeiling);
    assert.equal(admission.settings.subagents.allowRouteOverride, false);
    assert.equal(admission.settings.subagents.maxDepth, 2);
    assert.equal(admission.settings.roles["dsmm-reviewer"], true);
    assert.equal(admission.settings.roles["dsmm-coding"], false);
    assert.equal(admission.epoch, raw.originalAdmissionEpoch);
    assert.deepEqual(admission.profile, raw.profilePin);
    assert.deepEqual(readFileSync(f.path), before);
  } finally { f.cleanup(); }
});

test("v3 random snapshot pins survive cold reads with captured route, epoch and ceiling", async () => {
  const f = fixture();
  try {
    const saved = await f.store.save({ id: "focus", expectedRevision: null, content: JSON.stringify({ version: 1, id: "focus", settings: {} }) });
    const selected = await f.store.select({ id: "focus", expectedRevision: saved.revision, expectedSelectionRevision: "absent" });
    const capture = parseChildAdmissionCapture(payload(3, selected.selection.appliedRevision!));
    await f.store.createChildAdmission(capture);
    const cold = await new ProfileStore(f.root).readChildAdmission("child", "parent");
    assert.deepEqual(cold, capture);
    assert.deepEqual(admissionFromChildCapture(cold!, resolveConfig()).childCapture, capture);
  } finally { f.cleanup(); }
});

for (const version of [1, 2, 3] as const) for (const skill of ["report-fidelity", "avoid-ai-slop"] as const) test(`v${version} ${skill} admission uses captured policy and denies an uncaptured skill`, () => {
  const currentParent = resolveConfig({ skills: { [skill]: true } });
  for (const enabled of [true, false]) {
    const raw = payload(version);
    raw.runtimePolicyCapture.skills[skill] = enabled;
    const captured = parseChildAdmissionCapture(raw);
    assert.equal(admissionFromChildCapture(captured, currentParent).settings.skills[skill], enabled);
  }
  const historical = payload(version);
  Reflect.deleteProperty(historical.runtimePolicyCapture.skills, skill);
  const captured = parseChildAdmissionCapture(historical);
  assert.equal(Object.hasOwn(captured.runtimePolicyCapture.skills, skill), false);
  const restored = admissionFromChildCapture(captured, currentParent);
  assert.equal(restored.settings.skills[skill], false);
  assert.deepEqual(restored.childCapture, captured);
  assert.deepEqual(restored.childCapture?.authorityCeiling, historical.authorityCeiling);
  assert.equal(restored.epoch, historical.originalAdmissionEpoch);
  for (const invalid of [null, "true", 1]) {
    assert.throws(() => parseChildAdmissionCapture({ ...historical, runtimePolicyCapture: { ...historical.runtimePolicyCapture,
       skills: { ...historical.runtimePolicyCapture.skills, [skill]: invalid } } }));
  }
  assert.throws(() => parseChildAdmissionCapture({ ...historical, runtimePolicyCapture: { ...historical.runtimePolicyCapture,
    skills: { ...historical.runtimePolicyCapture.skills, unknown: true } } }));
});

test("capture integrity, lineage, original epoch and reference grammars fail closed", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, ".children", "v1"), { recursive: true });
    persist(f.path, payload(2), "f".repeat(64));
    await assert.rejects(f.store.readChildAdmission("child", "parent"), { code: "corrupt-selection" });
    persist(f.path, payload(2));
    await assert.rejects(f.store.readChildAdmission("child", "other"), { code: "corrupt-selection" });
    for (const version of [1, 2, 3] as const) {
      const raw = payload(version);
      for (const gitWriteScope of ["invalid", null, false]) assert.throws(() => parseChildAdmissionCapture({ ...raw, runtimePolicyCapture: { ...raw.runtimePolicyCapture, guards: { ...raw.runtimePolicyCapture.guards, gitWriteScope } } }));
      for (const changed of [{ ...raw, parentSessionId: "child" }, { ...raw, originalAdmissionEpoch: "stat-v1-1-2" },
        { ...raw, profilePin: { id: "focus", revision: "../escape" } }, { ...raw, profilePin: { id: "focus", revision: "stat-v1-1-2" } }]) {
        persist(f.path, changed);
        await assert.rejects(f.store.readChildAdmission("child", "parent"), { code: "corrupt-selection" });
      }
    }
    assert.throws(() => parseChildAdmissionCapture({ ...payload(1), runtimePolicyCapture: { ...payload(1).runtimePolicyCapture, deepseekV4ProCalibration: "unknown" } }));
    assert.throws(() => parseChildAdmissionCapture(payload(2, "snapshot-v1-12345678-1234-4234-8234-123456789abc")));
  } finally { f.cleanup(); }
});
