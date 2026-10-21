import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DSMM_CONFIG_SCHEMA, DSMM_LOCALES, DSMM_NATIVE_CONFIG_SCHEMA, DSMM_SETTINGS_SCHEMA, resolveConfig, resolveDeployment, validateSparseConfig } from "../src/settings.js";
import { DsmmConfigValidationError, diagnostic, diagnosticSourcePath, fieldLocation, inspectJsonDocument } from "../src/profile-diagnostics.js";
import { parseGlobalConfig } from "../src/deployment-config.js";
import { parseProfileDocument, profileErrorInfo, requiredDeepworkRoles, resolveProfileSettings, validateProfileDocument } from "../src/profiles.js";
import { ProfileStore } from "../src/profile-store.js";
import { admissionFromChildCapture, parseChildAdmissionCapture, parseLegacyChildEvidence } from "../src/child-capture.js";
import type { ChildAdmissionCaptureV3 } from "../src/child-capture.js";
import { parseChildAdmissionEvidenceView } from "../src/child-evidence.js";
import { parseDsmmInvocationView, parseProfileDiagnostic, parseRoleAvailability, parseSubagentRuntimeAdmissionView, TYPERT_REMOTE } from "../src/profile-remote.js";

const raw = (settings: unknown, label?: string) => JSON.stringify({ version: 1, id: "focus", ...(label === undefined ? {} : { label }), settings });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function capture(child = "child/opaque", parent = "parent/opaque", epoch = "a".repeat(64)): ChildAdmissionCaptureV3 {
  const settings = resolveConfig({ locale: "ja", guards: { gitWriteGuard: "deny" }, roleRouting: { "dsmm-reviewer": { levels: { low: { reasoningEffort: "low" } } } } });
  return { version: 3, delegationMode: "continuable", modelParameterPolicy: { mode: "passthrough" }, childSessionId: child, parentSessionId: parent, role: "dsmm-reviewer", profilePin: null, originalAdmissionEpoch: epoch,
    invocation: { level: "low", initialRoute: { provider: "fixture", model: "old-model", reasoningEffort: "low" },
      requestedRoute: { provider: "fixture", model: "old-model", reasoningEffort: "low" }, effortSource: "dsmm-config", routeSource: "level" },
    runtimePolicyCapture: { modules: settings.modules, roleRouting: settings.roleRouting, runtimePolicy: settings.runtimePolicy, workflow: settings.workflow,
      guards: settings.guards, runtimeRecovery: settings.runtimeRecovery, defaultActive: settings.defaultActive, skills: settings.skills,
      subagents: { enableRunInBackground: false, backgroundMode: "one-shot" } },
    authorityCeiling: { roles: ["dsmm-reviewer"], readOnly: true, toolFilter: { allow: ["read"] }, allowRouteOverride: false, maxDepth: 1 }, locale: "ja", toolTopology: "per-role" };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dsmm-wave1-"));
  return { directory, store: new ProfileStore(join(directory, "dsmm-profiles")), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("levels use a strict effort/complete-route union; normal is not a configurable level and root stays native-owned", () => {
  const input = { roleRouting: { "dsmm-reviewer": { levels: { low: { reasoningEffort: "low" }, high: { provider: "fixture", model: "high-model" }, max: { provider: "fixture", model: "max-model", reasoningEffort: "xhigh" } } } } };
  assert.deepEqual(resolveConfig(DSMM_CONFIG_SCHEMA(input)).roleRouting, input.roleRouting);
  const native = DSMM_NATIVE_CONFIG_SCHEMA(input).roleRouting as unknown as { get(): unknown };
  assert.deepEqual(native.get(), input.roleRouting, "native transport uses public volatile refs, not resolved settings");
  for (const levels of [{ normal: { reasoningEffort: "high" } }, { low: {} }, { low: { provider: "p" } }, { low: { model: "m" } }, { low: { reasoningEffort: "" } }, { max: { provider: "p", model: "m", apiKey: "unsafe" } }]) {
    assert.throws(() => validateSparseConfig({ roleRouting: { "dsmm-reviewer": { levels } } }));
    assert.throws(() => parseProfileDocument(raw({ roleRouting: { "dsmm-reviewer": { levels } } })));
  }
  assert.throws(() => resolveConfig({ roleRouting: { "dsmm-orchestrator": { levels: { low: { reasoningEffort: "low" } } } } }), DsmmConfigValidationError);
  const merged = resolveDeployment({ roleRouting: { "dsmm-reviewer": { levels: { high: { provider: "old", model: "old", reasoningEffort: "max" } } } } }, { roleRouting: { "dsmm-reviewer": { levels: { high: { reasoningEffort: "low" } } } } });
  assert.deepEqual(merged.roleRouting["dsmm-reviewer"]?.levels?.high, { reasoningEffort: "low" });
});

test("locale allowlist has no default, alias or implicit normalization; override permission is deployment-only", () => {
  assert.equal(Object.hasOwn(resolveConfig(), "locale"), false);
  for (const locale of DSMM_LOCALES) assert.equal(resolveProfileSettings({ locale: "en" }, { locale }).locale, locale);
  assert.equal(resolveProfileSettings({ locale: "fr" }, {}).locale, "fr");
  for (const locale of ["zh", "auto", "", null, "en-US"]) {
    const result = validateProfileDocument(raw({ locale }));
    assert.equal(result.diagnostics[0]?.code, "unsupported-value");
    assert.equal(result.diagnostics[0]?.field, "settings.locale");
    assert.throws(() => validateSparseConfig({ locale }));
  }
  assert.equal(resolveConfig().subagents.toolTopology, "per-role");
  assert.equal(resolveConfig().subagents.allowRouteOverride, false);
  assert.equal(resolveProfileSettings({ subagents: { allowRouteOverride: true } }, { subagents: { toolTopology: "parameterized" } }).subagents.allowRouteOverride, true);
  for (const key of ["allowRouteOverride", "maxDepth", "enableRunInBackground", "backgroundMode"]) assert.throws(() => parseProfileDocument(raw({ subagents: { [key]: true } })));
});

test("retired fields are refused with the exact safe field through every config parser", () => {
  for (const field of ["deepseekV4ProMaxReasoningPresets", "deepseekFlashMaxReasoningPresets", "deepseekV4ProCalibration", "deepseekV4ProDefaultReasoningEffort", "deepseekFlashCalibration", "deepseekFlashDefaultReasoningEffort"]) {
    for (const parse of [resolveConfig, validateSparseConfig, DSMM_CONFIG_SCHEMA, DSMM_NATIVE_CONFIG_SCHEMA, DSMM_SETTINGS_SCHEMA]) {
      assert.throws(() => parse({ [field]: [] } as never), (error: unknown) => error instanceof DsmmConfigValidationError && error.diagnostic.code === "deprecated-field" && error.diagnostic.field === field);
    }
    const json = JSON.stringify({ [field]: [] });
    try { parseGlobalConfig(json); assert.fail("must refuse"); } catch (error) {
      const info = profileErrorInfo(error); assert.equal(info.reason, "deprecated-field"); assert.equal(info.field, field); assert.equal(json.slice(info.location!.offset, info.location!.offset + info.location!.length), JSON.stringify(field));
    }
    const result = validateProfileDocument(raw({ [field]: [] }));
    assert.equal(result.diagnostics[0]?.field, `settings.${field}`); assert.equal(result.diagnostics[0]?.code, "deprecated-field");
  }
});

test("required roles are independent of root exposure; named true cannot bypass captured module/role ceilings", () => {
  assert.deepEqual(requiredDeepworkRoles(resolveConfig()), ["dsmm-orchestrator", "dsmm-planner", "dsmm-plan-critic"]);
  assert.deepEqual(requiredDeepworkRoles(resolveConfig({ workflow: { policy: "legacy", finalReviewPolicy: "reviewer-only" } })), ["dsmm-orchestrator", "dsmm-planner", "dsmm-plan-critic", "dsmm-reviewer"]);
  assert.deepEqual(requiredDeepworkRoles(resolveConfig({ workflow: { policy: "legacy", finalReviewPolicy: "simple-oracle-complex-reviewer" } })), ["dsmm-orchestrator", "dsmm-planner", "dsmm-plan-critic", "dsmm-reviewer", "dsmm-oracle"]);
  assert.equal(resolveProfileSettings({}, parseProfileDocument(raw({ roles: { "dsmm-reviewer": false, "dsmm-builder": false } })).settings).roles["dsmm-reviewer"], false);
  for (const role of ["dsmm-orchestrator", "dsmm-planner", "dsmm-plan-critic"]) assert.equal(validateProfileDocument(raw({ roles: { [role]: false } })).diagnostics[0]?.code, "required-role");
  assert.throws(() => resolveProfileSettings({ roles: { "dsmm-builder": false } }, { roles: { "dsmm-builder": true } }), { reason: "deployment-ceiling", field: "settings.roles.dsmm-builder" });
  assert.throws(() => resolveProfileSettings({ modules: { deepwork: { enabled: false } } }, { roles: { "dsmm-reviewer": true } }), { reason: "deployment-ceiling" });
});

test("JSONC diagnostics preserve exact offsets for BOM, duplicates, nested arrays and secret-bearing unknown keys", () => {
  for (const [json, code, field, token] of [
    ['\uFEFF{\n"version":1,"id":"focus","settings":{"defaultActive":true,"defaultActive":false}}', "duplicate-field", "settings.defaultActive", '"defaultActive":false'],
    [raw({ runtimeRecovery: { retryOnStatusCodes: [429, 99] } }), "invalid-type", "settings.runtimeRecovery.retryOnStatusCodes[1]", "99"],
    [raw({ guards: { questionLabelHelper: { surprise: true } } }), "unknown-field", "settings.guards.questionLabelHelper.[unknown]", '"surprise"'],
    [raw({ "token=PRIVATE/SECRET": "PRIVATE_VALUE" }), "unknown-field", "settings.[unknown]", '"token=PRIVATE/SECRET"']
  ]) {
    const issue = validateProfileDocument(json).diagnostics[0];
    assert.equal(issue.code, code); assert.equal(issue.field, field); assert.ok(issue.location);
    assert.equal(json.slice(issue.location.offset, issue.location.offset + issue.location.length), token.includes(":false") ? '"defaultActive"' : token);
    assert.equal(JSON.stringify(issue).includes("PRIVATE"), false);
    parseProfileDiagnostic(issue);
  }
  assert.equal(validateProfileDocument('{"version":').diagnostics[0]?.code, "invalid-jsonc");
});

test("blank label is the only warning and persists across raw save/list/pinned default/session reopen", async () => {
  const f = fixture();
  try {
    const content = '\uFEFF{ // untouched\n"version":1,"id":"focus","label":"  ","settings":{"locale":"zh-Hant"},}\n';
    const saved = await f.store.save({ id: "focus", content, expectedRevision: null });
    assert.equal(saved.content, content); assert.equal(saved.warnings?.[0]?.code, "blank-label");
    assert.equal((await f.store.read("focus")).warnings?.[0]?.location?.line, 2);
    const selected = await f.store.select({ id: "focus", expectedRevision: saved.revision, expectedSelectionRevision: "absent" });
    assert.equal(selected.selection.warnings?.[0]?.code, "blank-label");
    assert.equal(selected.selection.sourceRevision, saved.revision);
    assert.match(selected.selection.appliedRevision!, /^snapshot-v1-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    const session = await f.store.selectSession({ sessionId: "root", id: "focus", expectedRevision: saved.revision, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "a".repeat(64) }, "b".repeat(64), () => true, { assertCurrent() {}, committed() {} });
    assert.equal(session.selection.warnings?.[0]?.code, "blank-label");
    const reopened = new ProfileStore(f.store.profileDir);
    assert.equal((await reopened.describe()).profiles[0].error, undefined);
    assert.equal((await reopened.describe()).profiles[0].label, "focus");
    assert.equal((await reopened.describe()).profiles[0].warnings?.[0]?.code, "blank-label");
    assert.equal((await reopened.describe()).selectedWarnings?.[0]?.code, "blank-label");
    assert.equal((await reopened.loadSessionSelection("root")).warnings?.[0]?.code, "blank-label");
    await f.store.save({ id: "focus", content: raw({}, "Nonblank"), expectedRevision: saved.revision });
    assert.equal((await reopened.loadSelection()).warnings?.[0]?.code, "blank-label", "warnings come from admitted immutable revision, not current draft");
    assert.equal((await reopened.loadSelection()).appliedRevision, selected.selection.appliedRevision);
    assert.equal((await reopened.loadSelection()).sourceRevision, saved.revision);
    assert.equal(readFileSync(join(f.store.profileDir, ".revisions", `${selected.selection.appliedRevision}.jsonc`), "utf8"), content);
    for (const label of [42, "\n", "x".repeat(121), "\uD800"]) assert.throws(() => parseProfileDocument(JSON.stringify({ version: 1, id: "focus", label, settings: {} })));
  } finally { f.cleanup(); }
});

test("strict warning codecs cannot downgrade arbitrary security errors or echo unbounded reasons/fields", () => {
  const codec = TYPERT_REMOTE.descriptors.find(row => row.method === "read")!.result;
  if (codec.mode !== "strict") assert.fail("Expected native strict codec");
  const parser = codec.create().parse;
  const valid = { id: "focus", content: raw({}, ""), revision: "a".repeat(64), warnings: [diagnostic("blank-label", "label")] };
  assert.deepEqual(parser(valid), valid);
  for (const warning of [{ ...diagnostic("unsafe-field", "settings"), severity: "warning" }, { ...diagnostic("blank-label", "label"), reason: "PRIVATE_SECRET" }, { ...diagnostic("blank-label", "label"), field: "token=PRIVATE" }, { ...diagnostic("blank-label", "label"), location: { offset: -1, length: 1, line: 1, column: 1 } }]) assert.throws(() => parser({ ...valid, warnings: [warning] }));
  assert.throws(() => parser({ ...valid, warnings: new Array(1) }));
  let accessed = false;
  const getter = Object.defineProperty({ ...valid }, "label", { enumerable: true, get() { accessed = true; return "PRIVATE_SECRET"; } });
  assert.throws(() => parser(getter)); assert.equal(accessed, false);
});

test("child capture is immutable/create-only, keyed by opaque IDs, strict and never migrated on missing/corrupt data", async () => {
  const f = fixture();
  try {
    const input = capture();
    assert.equal(await f.store.readChildAdmission(input.childSessionId, input.parentSessionId), null);
    const written = await f.store.createChildAdmission(input);
    assert.ok(Object.isFrozen(written.runtimePolicyCapture.guards));
    assert.deepEqual(await new ProfileStore(f.store.profileDir).readChildAdmission(input.childSessionId, input.parentSessionId), written);
    assert.deepEqual(await f.store.createChildAdmission(input), written);
    await assert.rejects(f.store.createChildAdmission({ ...input, toolTopology: "parameterized" }), { code: "conflict" });
    await assert.rejects(f.store.readChildAdmission(input.childSessionId, "foreign-parent"), { code: "corrupt-selection" });
    const path = join(f.store.stateDir, ".children", "v1", `${hash(input.childSessionId)}.json`);
    assert.deepEqual(readdirSync(join(f.store.stateDir, ".children", "v1")), [`${hash(input.childSessionId)}.json`]);
    const bytes = readFileSync(path, "utf8");
    writeFileSync(path, bytes.replace('"gitWriteGuard":"deny"', '"gitWriteGuard":"off"'));
    await assert.rejects(f.store.readChildAdmission(input.childSessionId, input.parentSessionId), { code: "corrupt-selection" });
    writeFileSync(path, bytes);
    linkSync(path, join(f.directory, "hard-link"));
    await assert.rejects(f.store.readChildAdmission(input.childSessionId, input.parentSessionId), { code: "unsafe-path" });
    assert.equal(existsSync(join(f.directory, "child", "opaque")), false);
  } finally { f.cleanup(); }
});

test("capture grammar requires full executable policy but excludes private installation configuration", () => {
  const input = capture();
  for (const changed of [{ ...input, credentials: "private" }, { ...input, runtimePolicyCapture: { ...input.runtimePolicyCapture, lsp: { env: { TOKEN: "private" } } } }, { ...input, authorityCeiling: { ...input.authorityCeiling, readOnly: "true" } }, { ...input, invocation: { ...input.invocation, level: "auto" } }]) assert.throws(() => parseChildAdmissionCapture(changed));
  const incomplete = structuredClone(input);
  Reflect.deleteProperty(incomplete.runtimePolicyCapture.guards, "gitWriteGuard");
  assert.throws(() => parseChildAdmissionCapture(incomplete));
  const admitted = admissionFromChildCapture(input, resolveConfig({ locale: "ru", guards: { gitWriteGuard: "off" }, subagents: { allowRouteOverride: true }, roleRouting: { "dsmm-reviewer": { primary: { provider: "new", model: "new" } } } }));
  assert.equal(admitted.settings.guards.gitWriteGuard, "deny"); assert.equal(admitted.settings.subagents.allowRouteOverride, false);
  assert.equal(admitted.settings.locale, "ja"); assert.equal(admitted.settings.roleRouting["dsmm-reviewer"]?.primary, undefined);
  assert.equal(admitted.epoch, input.originalAdmissionEpoch);
});

test("legacy evidence does not fabricate pin/epoch/level and permits only finite proven/limitation fields", () => {
  const evidence = { version: 1, mode: "legacy-conservative", childSessionId: "child", parentSessionId: "parent", role: "dsmm-reviewer", route: { provider: "fixture", model: "old" }, depth: 1,
    toolFilter: { allow: ["read"] }, provenFields: ["lineage", "role", "route", "tool-filter"], limitations: [{ field: "git-write", code: "missing-evidence", effect: "capability-denied" }] };
  assert.deepEqual(parseLegacyChildEvidence(evidence), evidence);
  assert.throws(() => parseLegacyChildEvidence({ ...evidence, originalAdmissionEpoch: "a".repeat(64) }));
  assert.throws(() => parseLegacyChildEvidence({ ...evidence, provenFields: [...evidence.provenFields, "profile-pin"] }));
  const view = { mode: "legacy-conservative", parentAdmissionEpoch: "b".repeat(64), provenFields: evidence.provenFields, limitations: evidence.limitations };
  assert.deepEqual(parseChildAdmissionEvidenceView(view), view);
  assert.throws(() => parseChildAdmissionEvidenceView({ ...view, originalAdmissionEpoch: "a".repeat(64) }));
  assert.throws(() => parseChildAdmissionEvidenceView({ ...view, limitations: [{ field: "private/path", code: "missing-evidence", effect: "capability-denied" }] }));
  assert.throws(() => parseChildAdmissionEvidenceView({ ...view, provenFields: new Array(1) }));
});

test("invocation projections are strict observed metadata, not permission-bearing wire arguments", () => {
  const invocation = { role: "dsmm-reviewer", label: "DW Reviewer · High", level: "high", routeSource: "level", route: { provider: "fixture", model: "review-high", reasoningEffort: "high" }, mode: "continuable", childId: "opaque/native/child" };
  assert.deepEqual(parseDsmmInvocationView(invocation), invocation);
  for (const invalid of [{ ...invocation, role: "dsmm-orchestrator" }, { ...invocation, level: "default" }, { ...invocation, allowRouteOverride: true }, { ...invocation, route: { provider: "fixture" } }, { ...invocation, routeSource: "PRIVATE_PATH" }, { ...invocation, childId: "\u0000PRIVATE" }]) assert.throws(() => parseDsmmInvocationView(invalid));
  const copied = parseDsmmInvocationView(invocation); copied.route!.model = "changed"; assert.equal(invocation.route.model, "review-high");
});

test("schema diagnostics redact identifier-shaped secrets while locating each actual unknown key", () => {
  const secret = "sk-PRIVATE_SECRET_123456789";
  for (const settings of [{ [secret]: true }, { guards: { [secret]: true } }, { roles: { [secret]: true } }, { roleRouting: { "dsmm-reviewer": { [secret]: true } } }]) {
    const json = raw(settings), issue = validateProfileDocument(json).diagnostics[0];
    assert.equal(JSON.stringify(issue).includes(secret), false);
    assert.ok(issue.field.endsWith("[unknown]"));
    assert.equal(json.slice(issue.location!.offset, issue.location!.offset + issue.location!.length), JSON.stringify(secret));
  }
  const multiple = '\uFEFF{"version":1,"id":"focus","settings":{"sk-FIRST_SECRET":1,"sk-FIRST_SECRET":2,"sk-SECOND_SECRET":3,"sk-SECOND_SECRET":4}}';
  const issues = inspectJsonDocument(multiple).diagnostics;
  assert.equal(issues.length, 2); assert.equal(JSON.stringify(issues).includes("SECRET"), false);
  for (const [index, key] of ["sk-FIRST_SECRET", "sk-SECOND_SECRET"].entries()) assert.equal(issues[index].location!.offset, multiple.lastIndexOf(JSON.stringify(key)));
  const distinct = raw({ "sk-FIRST_SECRET": true, "sk-SECOND_SECRET": false }), tree = inspectJsonDocument(distinct).tree!;
  for (const key of ["sk-FIRST_SECRET", "sk-SECOND_SECRET"]) {
    const error = new DsmmConfigValidationError("unknown-field", ["settings", key]);
    assert.equal(JSON.stringify(error).includes("SECRET"), false);
    assert.equal(fieldLocation(distinct, tree, error.diagnostic.field, diagnosticSourcePath(error))!.offset, distinct.indexOf(JSON.stringify(key)));
  }
  const source = raw({ [secret]: { constructor: true } });
  const unsafe = inspectJsonDocument(source).diagnostics[0];
  assert.equal(JSON.stringify(unsafe).includes(secret), false); assert.equal(unsafe.location!.offset, source.indexOf('"constructor"'));
  const trusted = validateProfileDocument(raw({ roles: { "dsmm-planner": false } })).diagnostics[0];
  assert.equal(trusted.field, "settings.roles.dsmm-planner");
  assert.throws(() => parseProfileDiagnostic({ severity: "error", code: "unknown-field", field: `settings.${secret}`, reason: diagnostic("unknown-field", "settings").reason }));
  const global = JSON.stringify({ [secret]: true });
  try { parseGlobalConfig(global); assert.fail("unknown global field must refuse"); } catch (error) { const info = profileErrorInfo(error); assert.equal(JSON.stringify(info).includes(secret), false); assert.equal(info.location!.offset, global.indexOf(JSON.stringify(secret))); }
});

test("capture and wire enum parsers reject string-coercible arrays and objects, including checksum-valid store reload", async () => {
  const f = fixture();
  try {
    for (const level of [["high"], new String("high"), { toString() { return "high"; } }]) assert.throws(() => parseChildAdmissionCapture({ ...capture(), invocation: { ...capture().invocation, level } }));
    for (const changed of [{ ...capture(), toolTopology: ["per-role"] }, { ...capture(), runtimePolicyCapture: { ...capture().runtimePolicyCapture, subagents: { enableRunInBackground: false, backgroundMode: ["one-shot"] } } }]) assert.throws(() => parseChildAdmissionCapture(changed));
    const legacy = { version: 1, mode: "legacy-conservative", childSessionId: "child", parentSessionId: "parent", role: "dsmm-reviewer", route: { provider: "fixture", model: "legacy" }, depth: 1, provenFields: ["lineage", "role", "route"], limitations: [{ field: "git-write", code: "missing-evidence", effect: "capability-denied" }] };
    for (const changed of [{ code: ["missing-evidence"] }, { effect: ["capability-denied"] }]) {
      const limitations = [{ ...legacy.limitations[0], ...changed }];
      assert.throws(() => parseLegacyChildEvidence({ ...legacy, limitations }));
      assert.throws(() => parseChildAdmissionEvidenceView({ mode: "legacy-conservative", parentAdmissionEpoch: "a".repeat(64), provenFields: legacy.provenFields, limitations }));
    }
    const role = { id: "dsmm-reviewer", required: false, startupAvailable: true, deploymentEnabled: true, admitted: true, source: "defaults", capture: "startup" };
    for (const changed of [{ source: ["defaults"] }, { capture: ["startup"] }, { reason: ["module-off"] }, { requiredReason: ["legacy-review"] }]) assert.throws(() => parseRoleAvailability({ ...role, ...changed }));
    assert.throws(() => parseSubagentRuntimeAdmissionView({ binding: ["unavailable"], deliveryFenceReady: false, restartRequired: true }));
    assert.throws(() => parseSubagentRuntimeAdmissionView({ binding: "unavailable", deliveryFenceReady: false, restartRequired: true, reason: ["authority-not-ready"] }));
    const invocation = { role: "dsmm-reviewer", label: "DW Reviewer", level: "high", routeSource: "level", mode: "one-shot" };
    for (const changed of [{ level: ["high"] }, { mode: ["one-shot"] }]) assert.throws(() => parseDsmmInvocationView({ ...invocation, ...changed }));
    const codec = TYPERT_REMOTE.descriptors.find(row => row.method === "describe" && row.service === "dsmmProfiles")!.result;
    if (codec.mode !== "strict") assert.fail("expected native strict codec");
    assert.throws(() => codec.create().parse({ profiles: [], selectedId: null, appliedRevision: null, selectionRevision: "absent", origin: ["central"] }));
    const input = capture("reload", "parent"); await f.store.createChildAdmission(input);
    const path = join(f.store.stateDir, ".children", "v1", `${hash("reload")}.json`);
    const malformed = { ...input, invocation: { ...input.invocation, level: ["high"] } };
    writeFileSync(path, JSON.stringify({ version: 1, revision: hash(JSON.stringify(malformed)), capture: malformed }));
    await assert.rejects(f.store.readChildAdmission("reload", "parent"), { code: "corrupt-selection" });
  } finally { f.cleanup(); }
});
