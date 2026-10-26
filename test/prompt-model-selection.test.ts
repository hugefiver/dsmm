import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import "./prompt-source-loader.mjs";

const marker = (path: string) => `[fixture:${path}]`;
const contentModule = new URL("../src/prompt-content.ts", import.meta.url).href;
const promptsModule = new URL("../src/prompts.ts", import.meta.url).href;
const categoryFixture = ["gpt", "gemini", "glm", "claude", "unknown"]
  .map(family => `<model-calibration model="${family}">\n[fixture:category:${family}]\n</model-calibration>`).join("\n");
const fixtureModule = `data:text/javascript,${encodeURIComponent(`
export { SOURCE_ROLE_CATALOG, buildRolePersona, splitCategory } from ${JSON.stringify(contentModule)};
export function readPromptAsset(path) {
  if (path.startsWith("category/")) return ${JSON.stringify(categoryFixture)};
  return '[fixture:' + path + ']';
}
`)}`;
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === promptsModule && specifier === "./prompt-content.js") return { url: fixtureModule, shortCircuit: true };
    return next(specifier, context);
  }
});
const { BASE_DEEPWORK_PROMPT, SOURCE_ROLE_CATALOG, buildDeepworkPrompt, promptModelVariants, roleModelCalibration } = await import("../src/prompts.ts");
hook.deregister();
const { DEFAULT_DSMM_SETTINGS } = await import("../src/settings.ts");

test("Kimi generations and coding aliases share prompt calibration without provider-name inference", () => {
  // Synthetic names check open-ended family matching, not released model availability.
  const syntheticNames = ["kimi-latest", "kimi-k4-preview", "kimi.future", "kimi_future"];
  for (const model of ["kimi", "kimi-k2", "kimi-k2-thinking", "kimi-k2.5", "kimi-k2.6", "kimi-k2.7", "kimi-k27", "kimi-k2-8-preview",
    "kimi-k3", "kimi-k3.1", "kimi-k3-1-preview", "kimi-for-coding", "kimi-for-coding-highspeed", "k2-p5", "k2p6", "k2.p7", "k2-p8", ...syntheticNames]) {
    for (const fullId of [model, `moonshotai/${model.toUpperCase()}`]) {
      assert.deepEqual(promptModelVariants("builder", fullId), ["kimi"], fullId);
      assert.deepEqual(promptModelVariants("planner", fullId), ["planner", "kimi"], fullId);
    }
  }
  for (const model of ["kimi-provider/unrelated-model", "moonshotai/unrelated", "not-kimi-k3", "kimish", "kimiko-latest", "k2-p70"]) {
    assert.deepEqual(promptModelVariants("builder", model), [], model);
  }
});

test("Gemini 4 prompt selection is major-version bounded across provider and dotted vendor aliases", () => {
  for (const model of ["gemini-4", "gemini-4-argon", "gemini-4.0-pro", "gemini-4.12-preview"]) {
    for (const fullId of [model, `google/${model.toUpperCase()}`, `vertex/google.${model}`, `us.google.${model}`, `us-east-1.google.${model}`, `global.google.${model}`]) {
      assert.deepEqual(promptModelVariants("builder", fullId), ["gemini", "gemini-4"], fullId);
      assert.deepEqual(promptModelVariants("planner", fullId), ["planner", "gemini-4"], fullId);
    }
  }
  for (const model of ["gemini-3.1-pro", "gemini-5.0-pro", "gemini-40-pro", "gemini-4argon", "gemini-4.x-pro"]) {
    assert.deepEqual(promptModelVariants("builder", model), ["gemini"], model);
    assert.deepEqual(promptModelVariants("planner", model), ["planner"], model);
  }
  assert.deepEqual(promptModelVariants("builder", "gemini-4-provider/unrelated"), []);
});

test("base role selection and additive deduplication retain GPT, Codex, Opus and SWE scope", () => {
  assert.deepEqual(promptModelVariants("planner", "gpt-6.1-sol"), ["planner", "gpt"]);
  assert.deepEqual(promptModelVariants("builder", "gpt-6.1-sol"), ["gpt"]);
  assert.deepEqual(promptModelVariants("builder", "gpt-5.5-codex"), ["codex", "gpt"]);
  assert.deepEqual(promptModelVariants("orchestrator", "us.anthropic.claude-opus-5-20260901"), ["claude-opus-5"]);
  assert.deepEqual(promptModelVariants("reviewer", "claude-opus-5"), []);
  assert.deepEqual(promptModelVariants("orchestrator", "claude-opus-50"), []);
  assert.deepEqual(promptModelVariants("builder", "swe-2-fast"), ["swe-2"]);
  const planner = SOURCE_ROLE_CATALOG.find(row => row.sourceId === "planner")!;
  for (const [model, additives] of [["gpt-6.1-sol", ["gpt"]], ["gemini-3.1-pro", []], ["glm-5.2", []],
    ["kimi-k3.1", ["kimi"]], ["gemini-4-argon", ["gemini-4"]], ["swe-2", ["swe-2"]],
    ["claude-opus-5", []], ["gpt-5.5-codex", ["gpt"]]] as const) {
    assert.equal(roleModelCalibration(planner, model), ["planner", ...additives].map(variant => marker(`deepwork/${variant}.md`)).join("\n\n---\n\n"), model);
  }
});

test("category composition keeps its family layer before additives without importing base-agent workflows", () => {
  const category = SOURCE_ROLE_CATALOG.find(row => row.kind === "category" && row.promptArtifact !== null)!;
  for (const [model, family, additives] of [
    ["gemini-4-argon", "gemini", ["gemini-4"]], ["gemini-3.1-pro", "gemini", []],
    ["kimi-k3.1", "unknown", ["kimi"]], ["swe-2-fast", "unknown", ["swe-2"]],
    ["gpt-6.1-sol", "gpt", ["gpt"]], ["glm-5.2", "glm", []]
  ] as const) {
    assert.equal(roleModelCalibration(category, model), [`[fixture:category:${family}]`, ...additives.map(variant => marker(`deepwork/${variant}.md`))].join("\n\n---\n\n"), model);
  }
});

test("common activation composes once ahead of selected layers and respects explicit section overrides", () => {
  const activation = BASE_DEEPWORK_PROMPT.split("\n\n---\n\n")[0].replaceAll("{{modeName}}", DEFAULT_DSMM_SETTINGS.modeName);
  assert.ok(activation.length > 0);
  for (const selectedPreset of [undefined, "dsmm-planner", "dsmm-builder", "dsmm-research"]) {
    for (const model of ["kimi-k3.1", "gemini-4-argon", "gpt-6.1-sol"]) {
      const route = Object.freeze({ provider: "fixture", model, reasoningEffort: "low" });
      const prompt = buildDeepworkPrompt(DEFAULT_DSMM_SETTINGS, { selectedPreset, route });
      assert.ok(prompt.startsWith(activation));
      assert.equal(prompt.split(activation).length, 2);
      assert.ok(prompt.indexOf(marker("deepwork/default.md")) < prompt.indexOf(marker(`deepwork/${model.startsWith("kimi") ? "kimi" : model.startsWith("gemini") ? "gemini-4" : "gpt"}.md`)));
      assert.deepEqual(route, { provider: "fixture", model, reasoningEffort: "low" });
    }
  }
  const override = buildDeepworkPrompt(DEFAULT_DSMM_SETTINGS, { overrideSection: "[fixture:custom]", route: { provider: "fixture", model: "gemini-4-argon" } });
  assert.ok(override.startsWith("[fixture:custom]"));
  assert.equal(override.includes(activation), false);
  assert.ok(override.includes(marker("deepwork/gemini-4.md")));
});
