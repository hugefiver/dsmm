import assert from "node:assert/strict";
import { test } from "node:test";
import { DSMM_ROLE_IDS as EXPORTED_ROLE_IDS } from "../lib/index.js";
import { DSMM_ROLES, DSMM_ROLE_IDS, isDsmmRoleId, isRootRole, renderAgentCordis, renderPresetMetadata, rolePluginRows } from "../src/roles.ts";

const EXPECTED_ROLE_IDS = [
  "dsmm-orchestrator",
  "dsmm-planner",
  "dsmm-plan-critic",
  "dsmm-builder",
  "dsmm-reviewer",
  "dsmm-oracle",
  "dsmm-oracle-2nd",
  "dsmm-creative",
  "dsmm-code-search",
  "dsmm-doc-search",
  "dsmm-clarifier",
  "dsmm-media-reader",
  "dsmm-frontend", "dsmm-hard-reasoning", "dsmm-research", "dsmm-quick",
  "dsmm-coding", "dsmm-normal-task", "dsmm-complex", "dsmm-deep",
  "dsmm-documenting", "dsmm-cross-cutting"
] as const;

test("role ids are stable and exported from the package entrypoint", () => {
  assert.deepEqual(DSMM_ROLE_IDS, EXPECTED_ROLE_IDS);
  assert.deepEqual(EXPORTED_ROLE_IDS, EXPECTED_ROLE_IDS);
  assert.deepEqual(DSMM_ROLES.map((role) => role.id), EXPECTED_ROLE_IDS);
});

test("role ids are valid dsh preset ids", () => {
  for (const id of DSMM_ROLE_IDS) {
    assert.match(id, /^[a-z0-9][a-z0-9-]*$/u);
    assert.equal(isDsmmRoleId(id), true);
  }

  assert.equal(isDsmmRoleId("dsmm_orchestrator"), false);
  assert.equal(isDsmmRoleId(""), false);
  assert.equal(isDsmmRoleId(undefined), false);
});

test("root eligibility follows explicit role mode without hiding enabled auxiliary roles", () => {
  assert.deepEqual(DSMM_ROLES.map((role) => [role.id, role.mode]), [
    ["dsmm-orchestrator", "primary"],
    ["dsmm-planner", "all"],
    ["dsmm-plan-critic", "subagent"],
    ["dsmm-builder", "primary"],
    ["dsmm-reviewer", "subagent"],
    ["dsmm-oracle", "subagent"],
    ["dsmm-oracle-2nd", "subagent"],
    ["dsmm-creative", "subagent"],
    ["dsmm-code-search", "subagent"],
    ["dsmm-doc-search", "subagent"],
    ["dsmm-clarifier", "subagent"],
    ["dsmm-media-reader", "subagent"],
    ...EXPECTED_ROLE_IDS.slice(12).map((id) => [id, "subagent"])
  ]);
  assert.deepEqual(DSMM_ROLES.filter(isRootRole).map((role) => role.id), ["dsmm-orchestrator", "dsmm-planner", "dsmm-builder"]);
  assert.equal(DSMM_ROLES.filter((role) => !isRootRole(role)).length, 19);
  assert.equal(DSMM_ROLES.find((role) => role.id === "dsmm-planner")?.access, "read-only");
  assert.deepEqual(DSMM_ROLES.filter((role) => !role.enabledByDefault).map((role) => role.id), ["dsmm-cross-cutting"]);
  assert.equal(DSMM_ROLES.filter((role) => role.kind === "role").length, 11);
  assert.equal(DSMM_ROLES.filter((role) => role.kind === "category").length, 11);
});

test("Deepwork uses DW display names and personas without changing compatible role identities", () => {
  assert.deepEqual(DSMM_ROLES.map((role) => role.name), [
    "DW Orchestrator", "DW Planner", "DW Plan Critic", "DW Builder",
    "DW Reviewer", "DW Oracle", "DW Oracle 2nd", "DW Creative",
    "DW Code Search", "DW Doc Search", "DW Clarifier", "DW Media Reader",
    "DW Frontend", "DW Hard Reasoning", "DW Research", "DW Quick",
    "DW Coding", "DW Normal Task", "DW Complex", "DW Deep",
    "DW Documenting", "DW Cross Cutting"
  ]);
  assert.deepEqual(DSMM_ROLES.map((role) => role.id), EXPECTED_ROLE_IDS);
  for (const role of DSMM_ROLES) {
    assert.ok(role.persona.startsWith(`You are ${role.name} (role ID: ${role.id})`));
  }
});

test("preset metadata renders id, name, and description", () => {
  for (const role of DSMM_ROLES) {
    const metadata = renderPresetMetadata(role);

    assert.match(metadata, new RegExp(`^id: ${role.id}$`, "mu"));
    assert.match(metadata, new RegExp(`^name: '${role.name}'$`, "mu"));
    assert.match(metadata, /^description: '.+'$/mu);
    assert.equal(metadata.endsWith("\n"), true);
  }
});

test("agent cordis renders one full persona and native skill tools without a standing private skill provider", () => {
  for (const role of DSMM_ROLES) {
    const cordis = renderAgentCordis(role);
    const personaMarkers = cordis.match(/name: '@deepseek-ai\/dsh-persona'/gu) ?? [];

    assert.equal(personaMarkers.length, 1);
    assert.doesNotMatch(cordis, /@dsmm\/dsmm\/preset-skills/u);
    assert.match(cordis, /^- id: persona\n  name: '@deepseek-ai\/dsh-persona'\n  config:\n    prefix: /mu);
    assert.match(cordis, /- id: agent-instructions\n  name: '@deepseek-ai\/dsh-agent-instructions'\n  config:\n    maxBytes: 65536\n/u);
    assert.ok(cordis.includes(role.id));
    assert.match(cordis, /name: '@deepseek-ai\/dsh-tool-skill'/u);
    assert.match(cordis, /name: '@deepseek-ai\/dsh-skill-filesystem'/u);
    const rows = rolePluginRows(role);
    assert.deepEqual(rows.filter(row => ["tool-fs", "tool-fs-search", "tool-web"].includes(row.id)), [
      { id: "tool-fs", name: "@dsmm/dsmm/permission-fs" },
      { id: "tool-fs-search", name: "@dsmm/dsmm/permission-fs-search", config: { sampleOverCapGlobResults: false } },
      { id: "tool-web", name: "@dsmm/dsmm/permission-web", config: { fetch: true } },
    ]);
    assert.equal(cordis.includes("name: '@deepseek-ai/dsh-tool-pwsh'"), role.access !== "read-only");
    assert.equal(cordis.endsWith("\n"), true);
    assert.doesNotMatch(cordis, /^[\t ]+$/mu, "blank scalar lines must not acquire indentation-only whitespace");
  }
});

test("standing composition never serializes a session-private skill enable list", () => {
  const role = DSMM_ROLES[0];
  assert.ok(role);
  const cordis = renderAgentCordis(role, []);

  assert.equal(cordis, renderAgentCordis(role));
  assert.doesNotMatch(cordis, /dsmm-preset-skills|    skills:/u);
  assert.ok(cordis.includes(role.id));
});

test("personas are role-scoped and avoid host-specific tool names", () => {
  for (const role of DSMM_ROLES) {
    assert.ok(role.persona.includes(role.id));
    assert.doesNotMatch(role.persona, /Native OpenCode Background|Task tool \(general-purpose\)|task\(description/u);
  }
});

test("native standard capabilities use role-sized groups without widening delegation or read/write access", () => {
  const roots = new Set(["dsmm-orchestrator", "dsmm-builder", "dsmm-planner"]);
  const longDevelopment = new Set(["dsmm-coding", "dsmm-frontend", "dsmm-deep", "dsmm-complex", "dsmm-cross-cutting"]);
  for (const role of DSMM_ROLES) {
    const rows = rolePluginRows(role);
    const planning = rows.find((row) => row.id === "planning");
    const compaction = rows.find((row) => row.id === "compaction");
    const long = roots.has(role.id) || longDevelopment.has(role.id);
    assert.equal(planning !== undefined, roots.has(role.id), role.id);
    assert.equal(compaction !== undefined, long, role.id);
    assert.equal(rows.some((row) => row.id === "tool-ask-user"), long, role.id);
    assert.equal(rows.some((row) => row.id === "tool-todo"), long && role.id !== "dsmm-planner", role.id);
    assert.equal(rows.some((row) => row.id === "tool-pwsh"), role.access !== "read-only", role.id);
    if (planning) {
      assert.equal(planning.group, true);
      assert.deepEqual(planning.isolate, { planMode: true });
      assert.ok(Array.isArray(planning.config));
      const config = planning.config[0].config;
      assert.ok(config && !Array.isArray(config));
      assert.match(String(config.section), /Do not use todo_write.*exit_plan_mode/su);
    }
    if (compaction) {
      assert.equal(compaction.name, "cordis:group");
      assert.equal(compaction.group, true);
      assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true });
      assert.ok(Array.isArray(compaction.config));
      assert.deepEqual(compaction.config.map((child) => child.name), ["@deepseek-ai/dsh-compaction-basic", "@deepseek-ai/dsh-command-compact", "@deepseek-ai/dsh-compaction-tool-result-pruner"]);
      assert.deepEqual(compaction.config[2].config, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 });
      assert.equal(Object.hasOwn(compaction, "children"), false, "Loader consumes config arrays, not an invented children field");
    }
    assert.equal(rows.some((row) => /workflow|ralph|plugin-manager/u.test(row.name)), false);
  }
});
