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
