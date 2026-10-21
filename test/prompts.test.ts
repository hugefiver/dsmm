import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BASE_DEEPWORK_PROMPT, SOURCE_ROLE_CATALOG, buildDeepworkPrompt, buildRolePersona, promptModelVariants } from "../lib/prompts.js";
import { DSMM_ROLES } from "../lib/roles.js";
import { DEFAULT_DSMM_SETTINGS } from "../lib/settings.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("prompt assets exist and contain activation boundaries", () => {
  const deepwork = readFileSync(join(packageRoot, "prompts", "deepwork.md"), "utf8");

  assert.match(deepwork, /DEEPWORK MODE ENABLED!/);
  assert.match(deepwork, /\{\{modeName\}\}/);
  assert.match(deepwork, /opt-in boundary/i);
  assert.match(deepwork, /Turn Intent Gate/);
  assert.match(deepwork, /Deepwork Skill Chain/);
  assert.match(deepwork, /Execution Rules/);
  assert.match(deepwork, /\[dsmm safety\]/);
  assert.match(deepwork, /brainstorming/);
  assert.match(deepwork, /writing-plans/);
  assert.match(deepwork, /subagent-driven-development/);
  assert.match(deepwork, /dispatching-parallel-agents/);
  assert.match(deepwork, /requesting-code-review/);
  assert.match(deepwork, /receiving-code-review/);
  assert.match(deepwork, /remove-ai-slops/);
  assert.match(deepwork, /workflow\.policy=risk-based/);
  assert.match(deepwork, /`planner` → `plan-critic` → implementation/);
  assert.match(deepwork, /does not authorize a commit/);
  assert.equal(deepwork.trimEnd(), BASE_DEEPWORK_PROMPT);
});

test("buildDeepworkPrompt accepts composition section override", () => {
  const prompt = buildDeepworkPrompt(DEFAULT_DSMM_SETTINGS, {
    route: { provider: "deepseek-official", model: "deepseek-v4-pro" },
    overrideSection: "Custom dsmm section for {{modeName}}"
  });

  assert.match(prompt, /Custom dsmm section for deepwork/);
  assert.doesNotMatch(prompt, /DEEPWORK MODE ENABLED/);
  assert.match(prompt, /policy: risk-based/);
});

test("buildDeepworkPrompt renders the configured mode name", () => {
  const prompt = buildDeepworkPrompt({ ...DEFAULT_DSMM_SETTINGS, modeName: "dw" });

  assert.match(prompt, /`dw` mode/);
  assert.doesNotMatch(prompt, /`deepwork` mode is active/);
});

test("buildDeepworkPrompt renders effective workflow policy values", () => {
  const prompt = buildDeepworkPrompt({
    ...DEFAULT_DSMM_SETTINGS,
    workflow: {
      policy: "legacy",
      strictGates: false,
      reviewCap: 2,
      finalReviewPolicy: "reviewer-only"
    }
  });

  assert.match(prompt, /strictGates: false/);
  assert.match(prompt, /reviewCap: 2/);
  assert.match(prompt, /finalReviewPolicy: reviewer-only/);
});

test("buildDeepworkPrompt has no skill-body injection seam", () => {
  const prompt = buildDeepworkPrompt(DEFAULT_DSMM_SETTINGS);
  assert.match(prompt, /<\/dsmm-workflow-policy>$/u);
  assert.doesNotMatch(prompt, /<dsmm-skill|# Brainstorming/u);
});

test("exported prompt constants match asset intent", () => {
  assert.match(BASE_DEEPWORK_PROMPT, /DEEPWORK MODE ENABLED/);
  assert.match(BASE_DEEPWORK_PROMPT, /\{\{modeName\}\}/);
  assert.match(BASE_DEEPWORK_PROMPT, /brainstorming/);
  assert.match(BASE_DEEPWORK_PROMPT, /writing-plans/);
  assert.match(BASE_DEEPWORK_PROMPT, /subagent-driven-development/);
  assert.match(BASE_DEEPWORK_PROMPT, /dispatching-parallel-agents/);
  assert.match(BASE_DEEPWORK_PROMPT, /requesting-code-review/);
  assert.match(BASE_DEEPWORK_PROMPT, /receiving-code-review/);
  assert.match(BASE_DEEPWORK_PROMPT, /remove-ai-slops/);
  assert.match(BASE_DEEPWORK_PROMPT, /\[dsmm safety\]/);
  assert.match(BASE_DEEPWORK_PROMPT, /workflow\.policy=risk-based/);
  assert.match(buildDeepworkPrompt(DEFAULT_DSMM_SETTINGS), /policy: risk-based/);
  assert.doesNotMatch(buildDeepworkPrompt(DEFAULT_DSMM_SETTINGS), /reviewCap: 5/);
});

test("buildDeepworkPrompt preserves legacy workflow policy when explicit", () => {
  const legacy = buildDeepworkPrompt({ ...DEFAULT_DSMM_SETTINGS, workflow: { ...DEFAULT_DSMM_SETTINGS.workflow, policy: "legacy" } });
  assert.match(legacy, /strictGates: true/);
  assert.match(legacy, /reviewCap: 5/);
});

test("all source role/category bodies assemble once and category family blocks stay out of persistent personas", () => {
  for (const row of SOURCE_ROLE_CATALOG) {
    const role = DSMM_ROLES.find((role) => role.id === row.id)!;
    assert.equal(role.persona, buildRolePersona(row));
    const assembled = `${role.persona}\n${buildDeepworkPrompt(DEFAULT_DSMM_SETTINGS, { selectedPreset: role.id, route: { provider: "fixture", model: "gpt-6.1-sol" } })}`;
    assert.equal((assembled.match(/# GPT EXECUTION CALIBRATION/gu) ?? []).length, 1, role.id);
    assert.equal((assembled.match(/# Deepwork Workflow Prompt - default/gu) ?? []).length, 1, role.id);
    assert.equal((assembled.match(/# Shell Command Safety/gu) ?? []).length, 1, role.id);
    assert.doesNotMatch(role.persona, /<model-calibration model=/u);
    assert.ok(role.persona.includes("<dsmm-locale-guidance>"), role.id);
    if (row.promptArtifact !== null) {
      const source = readFileSync(join(packageRoot, row.promptArtifact), "utf8").trim();
      const base = source.replace(/\r?\n?<model-calibration model="([^"]+)">\r?\n([\s\S]*?)\r?\n<\/model-calibration>\r?\n?/gu, "\n").trim();
      assert.ok(role.persona.includes(base), role.id);
    } else assert.ok(role.persona.includes(row.description), role.id);
  }
});

test("source family selection is additive, planner-first, exact Opus orchestrator-only, and never changes routes", () => {
  assert.deepEqual(promptModelVariants("planner", "gpt-6.1-sol"), ["planner", "gpt"]);
  assert.deepEqual(promptModelVariants("orchestrator", "us.anthropic.claude-opus-5-20260901"), ["claude-opus-5"]);
  assert.deepEqual(promptModelVariants("reviewer", "claude-opus-5"), []);
  assert.deepEqual(promptModelVariants("orchestrator", "claude-opus-50"), []);
  assert.deepEqual(promptModelVariants("builder", "gpt-5.5-codex"), ["codex", "gpt"]);
  assert.deepEqual(promptModelVariants("builder", "kimi-for-coding"), ["kimi-k27"]);
  assert.deepEqual(promptModelVariants("builder", "kimi-for-coding-highspeed"), ["kimi-k27"]);
  assert.deepEqual(promptModelVariants("builder", "kimi-k2.8-preview"), ["kimi-k27"]);
  assert.deepEqual(promptModelVariants("builder", "kimi-k2.6"), []);
  assert.deepEqual(promptModelVariants("builder", "swe-2-fast"), ["swe-2"]);
  for (const model of ["gpt-6.1-sol", "gemini-3.1-pro", "glm-5.2", "kimi-k2.7", "swe-2", "claude-opus-5", "gpt-5.5-codex"]) {
    const route = Object.freeze({ provider: "fixture", model });
    const prompt = buildDeepworkPrompt(DEFAULT_DSMM_SETTINGS, { selectedPreset: "dsmm-planner", route });
    assert.match(prompt, /# Deepwork Planner Injection/u);
    assert.doesNotMatch(prompt, /# CLAUDE OPUS 5 EXECUTION CALIBRATION/u);
    assert.deepEqual(route, { provider: "fixture", model });
  }
});

test("source delegation matrices preserve root Builder, bounded child Builder, strict research leaf and local specialists", () => {
  const byId = (id: string) => DSMM_ROLES.find((role) => role.id === id)!;
  assert.match(byId("dsmm-builder").persona, /Root Builder is not a bounded worker/u);
  assert.match(byId("dsmm-builder").persona, /native child Builder has only bounded implementation authority/u);
  assert.ok(byId("dsmm-builder").allowedChildren.includes("dsmm-planner"));
  assert.equal(byId("dsmm-builder").childBuilderAllowedChildren?.includes("dsmm-planner"), false);
  assert.deepEqual(byId("dsmm-research").allowedChildren, []);
  assert.match(byId("dsmm-research").persona, /utility leaf agent\. Do not dispatch any subagent/u);
  for (const id of ["dsmm-deep", "dsmm-complex", "dsmm-cross-cutting"]) {
    assert.ok(byId(id).allowedChildren.includes("dsmm-coding"));
    assert.equal(byId(id).allowedChildren.includes("dsmm-planner"), false);
    assert.equal(byId(id).allowedChildren.includes("dsmm-complex"), false);
  }
  for (const id of ["dsmm-planner", "dsmm-reviewer", "dsmm-oracle", "dsmm-plan-critic", "dsmm-clarifier"]) {
    assert.ok(byId(id).allowedChildren.includes("dsmm-code-search"));
    assert.equal(byId(id).allowedChildren.includes("dsmm-quick"), false);
  }
});
