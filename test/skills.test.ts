import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DSMM_SKILL_NAMES as SETTINGS_SKILL_NAMES, resolveConfig, validateSparseConfig } from "../lib/settings.js";
import { isSafeDiagnosticField, safeDiagnosticField } from "../lib/profile-diagnostics.js";
import { DSMM_SKILL_NAMES, MVP_SKILL_NAMES, enabledSkillNames,
  bundledSkillMetadata, parseSkillMarkdown, readBundledSkill } from "../lib/skills.js";

test("canonical skills share configurable lazy metadata/body inventory", () => {
  assert.deepEqual(DSMM_SKILL_NAMES, ["brainstorming", "writing-plans", "requesting-code-review", "receiving-code-review", "subagent-driven-development", "dispatching-parallel-agents", "avoid-ai-slop", "remove-ai-slops", "debugging", "frontend", "git-master", "ast-grep", "coding-agent-sessions", "init-deep", "using-git-worktrees", "report-fidelity"]);
  assert.equal(MVP_SKILL_NAMES, DSMM_SKILL_NAMES); assert.equal(SETTINGS_SKILL_NAMES, DSMM_SKILL_NAMES);
});

test("parseSkillMarkdown extracts frontmatter and body and rejects invalid entries", () => {
  assert.deepEqual(parseSkillMarkdown("---\nname: sample\ndescription: Sample skill\n---\n\n# Body\n"), { name: "sample", description: "Sample skill", content: "# Body\n" });
  assert.throws(() => parseSkillMarkdown("# No frontmatter"));
  assert.throws(() => parseSkillMarkdown("---\nname: sample\n---\nbody"));
});

test("enabledSkillNames preserves canonical order and deployment disablement", () => {
  assert.deepEqual(enabledSkillNames(resolveConfig({ skills: { "writing-plans": false, "avoid-ai-slop": false, "remove-ai-slops": false, debugging: false, "report-fidelity": false } })), DSMM_SKILL_NAMES.filter((name) => !["writing-plans", "avoid-ai-slop", "remove-ai-slops", "debugging", "report-fidelity"].includes(name)));
});

test("avoid-ai-slop deployment settings accept explicit booleans and preserve safe diagnostic identity", () => {
  assert.equal(resolveConfig().skills["avoid-ai-slop"], true);
  for (const enabled of [true, false]) assert.equal(resolveConfig({ skills: { "avoid-ai-slop": enabled } }).skills["avoid-ai-slop"], enabled);
  assert.equal(safeDiagnosticField(["skills", "avoid-ai-slop"]), "skills.avoid-ai-slop");
  assert.equal(isSafeDiagnosticField("settings.skills.avoid-ai-slop"), true);
  for (const invalid of [null, "true", 1, undefined]) assert.throws(() => validateSparseConfig({ skills: { "avoid-ai-slop": invalid } }, true));
  assert.throws(() => validateSparseConfig({ skills: { unknown: true } }, true));
});

test("metadata inventory exposes packaged resource identity without carrying bodies", async () => {
  for (const name of DSMM_SKILL_NAMES) {
    const meta = bundledSkillMetadata(name);
    assert.equal(meta.resourceBase?.kind, "directory");
    if (meta.resourceBase?.kind !== "directory") throw new Error("bundled skill needs a directory base");
    const parsed = parseSkillMarkdown(readFileSync(join(meta.resourceBase.path, "SKILL.md"), "utf8"));
    const loaded = await readBundledSkill(name, new AbortController().signal);
    assert.equal("content" in meta, false); assert.equal(meta.provider, "dsmm"); assert.equal(meta.source, "bundled");
    assert.deepEqual(meta.invocation, { modelInvocable: true, userInvocable: true });
    assert.equal(meta.name, parsed.name);
    assert.deepEqual(loaded, { ...meta, content: parsed.content });
    assert.doesNotMatch(loaded.content, /^---\r?\nname:/u, "body excludes YAML frontmatter, not legitimate source Markdown separators");
  }
  const debugging = await readBundledSkill("debugging", new AbortController().signal);
  assert.match(debugging.content, /references\/tools\/dap\.md/);
  assert.equal(debugging.resourceBase?.kind, "directory");
  if (debugging.resourceBase?.kind === "directory") {
    assert.match(readFileSync(join(debugging.resourceBase.path, "references/tools/dap.md"), "utf8"), /references\/scripts\/dap\.mjs/);
    assert.match(readFileSync(join(debugging.resourceBase.path, "references/scripts/dap.mjs"), "utf8"), /node/);
  }
  const aborted = AbortSignal.abort();
  await assert.rejects(readBundledSkill("brainstorming", aborted));
});
