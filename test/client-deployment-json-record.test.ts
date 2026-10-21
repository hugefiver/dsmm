import assert from "node:assert/strict";
import { test } from "node:test";
import { DeploymentController } from "../src/client/deployment-controller.ts";
import { editLayer, validateEditorValue } from "../src/client/deployment-data.ts";
import type { DsmmConfigRemote } from "../src/profile-remote.ts";
import type { DeploymentEditorSnapshot, DeploymentSchemaNode } from "../src/profile-types.ts";
import { parsePermissionRules } from "../src/permission-rules.ts";
import { deploymentEditorSchema, resolveConfig, resolveDeployment, validateSparseConfig } from "../src/settings.ts";

const rules = [{ id: "web-deny", action: "deny", match: { kind: "webFetch" },
  source: { kind: "user-import", label: "existing-policy" }, revision: 0, revoked: false }];

function fixture(global: Record<string, unknown>, profile: Record<string, unknown> = {}) {
  const defaults = { ...resolveConfig() };
  const snapshot: DeploymentEditorSnapshot = {
    entryId: "include:dsmm", namespace: "dsmm", hostProfileKey: "own-profile",
    global: structuredClone(global), globalRevision: "g0", profile: structuredClone(profile), nativeRevision: "n0",
    nativeFormRevision: 0, nativeForm: { base: {}, user: structuredClone(profile) },
    desired: { ...resolveDeployment(validateSparseConfig(global, true), validateSparseConfig(profile)) },
    sources: {}, startup: defaults, defaults, schema: deploymentEditorSchema(), nextRoot: null, modules: [],
  };
  const writes: Parameters<DsmmConfigRemote["save"]>[0][] = [];
  const remote: DsmmConfigRemote = {
    describe: async () => ({ ok: true, value: { config: snapshot.global, revision: snapshot.globalRevision } }),
    describeModules: async () => ({ ok: true, value: [] }),
    describeSettings: async () => ({ ok: true, value: structuredClone(snapshot) }),
    save: async request => {
      assert.equal(request.expectedRevision, snapshot.globalRevision);
      let next = snapshot.global;
      for (const edit of request.edits) next = editLayer(next, edit.path, edit.op === "set" ? edit.value : undefined);
      validateSparseConfig(next, true);
      writes.push(request);
      snapshot.global = next; snapshot.globalRevision = "g1";
      return { ok: true, value: { config: next, revision: "g1" } };
    },
  };
  return { snapshot, remote, writes };
}

test("Global workflow save preserves existing nonempty permission rules losslessly", async () => {
  assert.deepEqual(parsePermissionRules(rules), rules);
  for (const existing of [[], rules]) {
    const f = fixture({ permissionControl: { rules: existing }, workflow: { reviewCap: 3 } });
    const c = new DeploymentController(f.remote, "global");
    try {
      await c.refresh(); c.edit(["workflow", "reviewCap"], 4); await c.save();
      assert.deepEqual({ saves: f.writes.length, issue: c.getSnapshot().issue }, { saves: 1, issue: null });
      assert.equal(c.getSnapshot().saved, true);
      assert.deepEqual(f.writes, [{ expectedRevision: "g0", edits: [{ op: "set", path: ["workflow", "reviewCap"], value: 4 }] }]);
      assert.deepEqual(f.snapshot.global.permissionControl, { rules: existing });
      assert.deepEqual(c.getSnapshot().draft.permissionControl, { rules: existing });
      assert.deepEqual(c.getSnapshot().snapshot?.global.permissionControl, { rules: existing });
    } finally { c.dispose(); }
  }
});

test("Core saves preserve nonempty rules in either Global or owned native layers", async () => {
  const policies = [rules, [{ ...rules[0], source: { kind: "operator", sessionId: "original-root", savedAt: 1 } }]];
  for (const existing of policies) for (const layer of ["global", "profile"] as const) for (const ruleLayer of ["global", "profile"] as const) {
    const policy = { permissionControl: { rules: existing } };
    const f = fixture(ruleLayer === "global" ? policy : {}, ruleLayer === "profile" ? policy : {});
    const c = new DeploymentController(f.remote, layer, layer === "profile" ? "dsmm" : null);
    const mutations: unknown[] = [];
    if (layer === "profile") {
      c.attachForm({ state: { status: "ready", writable: true, revision: 0, value: f.snapshot.profile, base: {}, user: f.snapshot.profile },
        mutate: async (edits, revision) => {
          assert.equal(revision, 0);
          let next = f.snapshot.profile;
          for (const edit of edits) next = editLayer(next, edit.path, edit.op === "set" ? edit.value : undefined);
          validateSparseConfig(next);
          mutations.push(edits); f.snapshot.profile = next; f.snapshot.nativeForm = { base: {}, user: next };
          return true;
        } });
    }
    try {
      await c.refresh(); c.edit(["defaultActive"], false); c.edit(["permissionControl", "enabled"], false); await c.save();
      assert.equal(c.getSnapshot().issue, null); assert.equal(c.getSnapshot().saved, true);
      assert.equal(f.writes.length, layer === "global" ? 1 : 0); assert.equal(mutations.length, layer === "profile" ? 1 : 0);
      const before = ruleLayer === layer ? policy : {};
      const after = editLayer(editLayer(before, ["defaultActive"], false), ["permissionControl", "enabled"], false);
      assert.deepEqual(c.getSnapshot().draft, after);
      assert.deepEqual(f.snapshot[ruleLayer].permissionControl, ruleLayer === layer ? { rules: existing, enabled: false } : policy.permissionControl);
      assert.deepEqual(parsePermissionRules((f.snapshot[ruleLayer].permissionControl as { rules: unknown }).rules), existing);
    } finally { c.dispose(); }
  }
});

test("JSON record schemas validate declared fields and lossless JSON without route identity requirements", () => {
  const schema = deploymentEditorSchema();
  const ruleSchema = schema.fields!.permissionControl.fields!.rules.inner!;
  const typedRecord: DeploymentSchemaNode = { type: "object", fields: { enabled: { type: "boolean", required: true } }, additionalProperties: "json" };
  for (const sparse of [false, true]) {
    assert.equal(validateEditorValue(rules[0], ruleSchema, sparse), true);
    assert.equal(validateEditorValue({ permissionControl: { rules } }, schema, sparse), true);
    assert.equal(validateEditorValue({ enabled: false, toString: "data", hasOwnProperty: false, metadata: { raw: [false, 0, null], headers: {} } }, typedRecord, sparse), true);
    assert.equal(validateEditorValue({ enabled: "false" }, typedRecord, sparse), false);
    assert.equal(validateEditorValue({ metadata: null }, typedRecord, sparse), sparse);
  }
  for (const invalid of [null, [], [rules[0]], false, 0, "record"]) {
    assert.equal(validateEditorValue(invalid, ruleSchema), false);
    assert.equal(validateEditorValue(invalid, ruleSchema, true), false);
    assert.throws(() => parsePermissionRules([invalid]));
  }
});

test("permission-rule array edits save atomically and retain every record field", async () => {
  const f = fixture({ permissionControl: { rules } });
  const c = new DeploymentController(f.remote, "global");
  const next = [...rules, { ...rules[0], id: "search-ask", action: "ask", match: { kind: "webSearch" }, revision: 2, revoked: true }];
  try {
    await c.refresh(); c.edit(["permissionControl", "rules"], next); await c.save();
    assert.equal(c.getSnapshot().saved, true);
    assert.deepEqual(f.writes, [{ expectedRevision: "g0", edits: [{ op: "set", path: ["permissionControl", "rules"], value: next }] }]);
    assert.deepEqual(f.snapshot.global.permissionControl, { rules: next });
    assert.deepEqual(c.getSnapshot().draft.permissionControl, { rules: next });
    assert.deepEqual(parsePermissionRules(next), next);
  } finally { c.dispose(); }
});

test("JSON records reject unsafe prototypes, accessors and unbounded or non-lossless JSON", () => {
  const schema = deploymentEditorSchema().fields!.permissionControl.fields!.rules.inner!;
  let reads = 0;
  const getter = Object.defineProperty({}, "value", { enumerable: true, get() { reads++; return 1; } });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const deep: Record<string, unknown> = {}; let cursor = deep;
  for (let i = 0; i < 34; i++) { const child = {}; cursor.child = child; cursor = child; }
  const invalid = [undefined, NaN, Infinity, -0, 1n, Symbol("value"), () => 1, new Date(), getter, cycle, deep,
    new Array(1), Object.create({ inherited: true }), Object.defineProperty({}, "hidden", { value: 1 }), { [Symbol("key")]: 1 },
    JSON.parse('{"__proto__":{}}'), JSON.parse('{"constructor":{}}'), JSON.parse('{"prototype":{}}'), "\ud800", "x".repeat(128 * 1024)];
  for (const value of invalid) for (const sparse of [false, true]) {
    assert.equal(validateEditorValue({ value }, schema, sparse), false);
  }
  assert.equal(validateEditorValue(Object.create({ value: 1 }), schema), false);
  assert.equal(validateEditorValue(getter, schema), false); assert.equal(reads, 0);
  assert.equal(validateEditorValue(Object.assign(Object.create(null), { value: [false, 0, null] }), schema), true);
});

test("permission-rule semantic validation remains server-owned after plain JSON record checks", () => {
  const schema = deploymentEditorSchema().fields!.permissionControl.fields!.rules;
  for (const invalid of [[{}], [{ ...rules[0], action: "invalid" }], [{ ...rules[0], revoked: null }], [rules[0], rules[0]]]) {
    assert.equal(validateEditorValue(invalid, schema), true);
    assert.throws(() => parsePermissionRules(invalid));
    assert.throws(() => validateSparseConfig({ permissionControl: { rules: invalid } }, true));
  }
});

test("model-route schemas retain complete identity, protected keys, aliases and atomic fallback arrays", () => {
  const schema = deploymentEditorSchema();
  const routeSchema = schema.fields!.roleRouting.inner!.fields!.primary.alternatives![1];
  const route = { provider: "fixture", model: "review", custom_flag: false, custom_zero: 0, custom_null: null,
    custom_nested: { values: [false, 0, null], headers: {} }, stop: [] };
  for (const sparse of [false, true]) {
    assert.equal(validateEditorValue(route, routeSchema, sparse), true);
    for (const alias of ["reasoningEffort", "reasoning_effort"]) assert.equal(validateEditorValue({ ...route, [alias]: " exact-effort " }, routeSchema, sparse), true);
    const invalid = [null, [], false, {}, { provider: "fixture" }, { model: "review" }];
    for (const input of invalid) assert.equal(validateEditorValue(input, routeSchema, sparse), sparse && input !== null && typeof input === "object" && !Array.isArray(input));
    for (const extra of [{ provider: " " }, { model: false }, { model: "https://remote" }, { temperature: null }, { maxTokens: 0 }, { stop: [false] },
      { reasoningEffort: "one", reasoning_effort: "two" }, { maxTokens: 1, max_tokens: 2 }, { headers: {} }, { api_key: "value" },
      { permissions: false }, { runtimePolicyCapture: {} }, { data: JSON.parse('{"__proto__":{}}') }]) {
      assert.equal(validateEditorValue({ ...route, ...extra }, routeSchema, sparse), false);
    }
  }
  assert.equal(validateEditorValue({ roleRouting: { "dsmm-reviewer": { primary: { model: "review" } } } }, schema, true), true);
  for (const routeList of [[{ model: "review" }], [{ provider: "fixture" }], Array.from({ length: 33 }, () => route)]) {
    assert.equal(validateEditorValue({ roleRouting: { "dsmm-reviewer": { fallbackRoutes: routeList } } }, schema, true), false);
  }
  assert.equal(validateEditorValue({ roleRouting: { "dsmm-reviewer": { fallbackRoutes: [route, { ...route, model: "next" }] } } }, schema, true), true);
});
