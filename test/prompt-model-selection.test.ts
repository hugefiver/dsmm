import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { DshAgent } from "../src/dsh-types.js";
import type { DsmmProfileRuntime } from "../src/profile-runtime.js";
import "./prompt-source-loader.mjs";

const marker = (path: string) => `[fixture:${path}]`;
const contentModule = new URL("../src/prompt-content.ts", import.meta.url).href;
const promptsModule = new URL("../src/prompts.ts", import.meta.url).href;
const categoryFixture = ["gpt", "gemini", "glm", "claude", "unknown"]
  .map(family => `<model-calibration model="${family}">\n[fixture:category:${family}]\n</model-calibration>`).join("\n");
const fixtureModule = `data:text/javascript,${encodeURIComponent(`
export { SOURCE_ROLE_CATALOG, buildRolePersona, splitCategory, readSharedPromptAsset } from ${JSON.stringify(contentModule)};
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
    "kimi-k3", "kimi-k3.1", "kimi-k3-1-preview", "kimi-for-coding", "kimi-for-coding-highspeed", "k2-p5", "k2p6", "k2.p7", "k2-p8",
    "not-kimi-k3", "kimi-provider/unrelated-model", "auto-k2p8", ...syntheticNames]) {
    for (const fullId of [model, `moonshotai/${model.toUpperCase()}`]) {
      assert.deepEqual(promptModelVariants("builder", fullId), ["kimi"], fullId);
      assert.deepEqual(promptModelVariants("planner", fullId), ["planner", "kimi"], fullId);
    }
  }
  for (const model of ["moonshotai/unrelated", "xkimi-k3", "kimish", "kimiko-latest", "k2-p70", "k2p80"]) {
    assert.deepEqual(promptModelVariants("builder", model), [], model);
  }
});

test("Gemini 4 prompt selection is major-version bounded across provider and dotted vendor aliases", () => {
  for (const model of ["gemini-4", "gemini-4-argon", "gemini-4.0-pro", "gemini-4.12-preview",
    "gemini-4.x", "gemini-4.x-pro", "gemini-4.x@default", "gemini-4.x-pro:latest",
    "gemini4", "gemini4.1", "gemini4@default", "gemini4.1:latest"]) {
    for (const fullId of [model, `google/${model.toUpperCase()}`, `vertex/google.${model}`, `us.google.${model}`, `us-east-1.google.${model}`, `global.google.${model}`]) {
      assert.deepEqual(promptModelVariants("builder", fullId), ["gemini", "gemini-4"], fullId);
      assert.deepEqual(promptModelVariants("planner", fullId), ["planner", "gemini-4"], fullId);
    }
  }
  for (const model of ["gemini-3.1-pro", "gemini-5.0-pro", "gemini-40-pro", "gemini-4argon",
    "gemini-4.xfoo", "gemini-4.x.1", "gemini4.1foo", "gemini4.1.2.3", "gemini3", "gemini5", "gemini40"]) {
    assert.deepEqual(promptModelVariants("builder", model), ["gemini"], model);
    assert.deepEqual(promptModelVariants("planner", model), ["planner"], model);
  }
  assert.deepEqual(promptModelVariants("builder", "gemini-4-provider/unrelated"), ["gemini", "gemini-4"]);
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
    ["gpt-6.1-sol", "gpt", ["gpt"]], ["glm-5.2", "glm", []],
    ["auto-gpt/6.1/sol", "gpt", ["gpt"]], ["prefix-gpt-5.6-codex-fast", "gpt", ["gpt"]],
    ["claude-opus-5-gpt-6-codex", "claude", []], ["gemini-4-pro-gpt-6-codex", "gemini", ["gemini-4"]],
    ["auto-k2p8-gpt-6", "unknown", ["kimi"]], ["auto-swe/2/high-gpt-6", "unknown", ["swe-2"]],
    ["group/glm-5.3-1m", "glm", []], ["auto-fable-5", "claude", []]
  ] as const) {
    assert.equal(roleModelCalibration(category, model), [`[fixture:category:${family}]`, ...additives.map(variant => marker(`deepwork/${variant}.md`))].join("\n\n---\n\n"), model);
  }
});

test("shared name recognition bounds prompt attributes to the leftmost identifier", () => {
  for (const [model, variants] of [
    ["auto-gpt-6.1-sol", ["gpt"]], ["auto-gpt/6.1/sol", ["gpt"]],
    ["PREFIX_CHATGPT_6_1_SOL", ["gpt"]], ["prefix-gpt-5.6-codex-fast", ["codex", "gpt"]],
    ["gpt-5.5-claude-opus-5-codex", ["gpt"]], ["gpt-5.5-gpt-6-codex", ["gpt"]],
    ["claude-opus-5-gpt-6-codex", []], ["gemini-4-pro-gpt-6-codex", ["gemini", "gemini-4"]],
    ["auto_gemini 4/pro", ["gemini", "gemini-4"]], ["gpt-6-sol/gemini-4-pro", ["gpt"]],
    ["gemini-3-gemini-4-pro", ["gemini"]], ["gemini-gpt-6", ["gemini"]],
    ["auto-k2p8-gpt-6", ["kimi"]], ["auto-swe/2/high-gpt-6", ["swe-2"]],
    ["swe-20", []], ["xkimi-k3", []], ["notgpt-6", []], ["codexish", []]
  ] as const) {
    assert.deepEqual(promptModelVariants("builder", model), variants, model);
    assert.deepEqual(promptModelVariants("planner", model), ["planner", ...variants.filter(variant => ["gpt", "kimi", "gemini-4", "swe-2"].includes(variant))], model);
  }
});

test("Opus prompt versions survive wrappers while retaining exact 5 and 5.5 scope", () => {
  for (const model of ["auto-claude_opus_5_5-20261101", "custom/claude/opus/5.5/fast", "claude-opus-5@default",
    "claude-opus-5-20261101", "claude-opus-5.5-1m", "claude-opus-5-fast-6", "claude-opus-5-gpt-6"]) {
    assert.deepEqual(promptModelVariants("orchestrator", model), ["claude-opus-5"], model);
    assert.deepEqual(promptModelVariants("reviewer", model), [], model);
  }
  for (const model of ["claude-opus-5.0", "claude-opus-5.50", "claude-opus-5.5000", "claude-opus-50", "claude-opus-4.7", "claude-gpt-6-opus-5", "claude-claude-opus-5"]) {
    assert.deepEqual(promptModelVariants("orchestrator", model), [], model);
  }
});

test("partial numeric Opus versions cannot fall back to the Opus 5 calibration", () => {
  const role = SOURCE_ROLE_CATALOG.find(row => row.sourceId === "orchestrator")!;
  assert.equal(roleModelCalibration(role, "claude-opus-5.5foo"), "");
  assert.deepEqual(promptModelVariants("orchestrator", "claude-opus-5.5foo"), []);
  for (const model of ["claude-opus-5.5-20261101", "claude-opus-5.5-1m", "claude-opus-5.5-2m", "auto/claude_opus_5_5.fast"]) {
    assert.equal(roleModelCalibration(role, model), marker("deepwork/claude-opus-5.md"), model);
  }
});

test("partial numeric Gemini versions cannot acquire the Gemini 4 calibration", () => {
  const role = SOURCE_ROLE_CATALOG.find(row => row.sourceId === "builder")!;
  assert.equal(roleModelCalibration(role, "gemini-4.1foo"), marker("deepwork/gemini.md"));
  assert.deepEqual(promptModelVariants("builder", "gemini-4.1foo"), ["gemini"]);
  for (const model of ["gemini-4.1-20261101", "gemini-4.1-1m", "gemini-4.1-128k", "gemini-4.1-2m", "auto/gemini_4_1.pro"]) {
    assert.equal(roleModelCalibration(role, model), ["gemini", "gemini-4"].map(variant => marker(`deepwork/${variant}.md`)).join("\n\n---\n\n"), model);
  }
});

test("structured prompt routes isolate provider metadata and preserve complete native identity", () => {
  for (const [provider, model, variants] of [
    ["provider-kimi-for-coding", "unrelated", []], ["gemini-4-provider", "unrelated", []],
    ["swe-2-provider", "unrelated", []], ["gpt-6-sol", "gemini-4-pro", ["gemini", "gemini-4"]],
    ["gateway", "gpt-6-sol/gemini-4-pro", ["gpt"]], ["google", "google/gpt/6.1/sol", ["gpt"]],
    ["codex", "gpt-5.6", ["gpt"]], ["gateway", "auto-swe/2/high-gpt-6", ["swe-2"]],
    ["google", "sol6.1", ["gpt"]], ["anthropic", "6.1sol", ["gpt"]],
    ["6.1sol", "gemini-4-pro", ["gemini", "gemini-4"]], ["gateway", "6.1sol/gemini-4-pro", ["gpt"]],
    ["codex", "opus4.7", []], ["google", "sol6.1-codex", ["codex", "gpt"]]
  ] as const) {
    const route = Object.freeze({ provider, model, reasoningEffort: "low" });
    const prompt = buildDeepworkPrompt(DEFAULT_DSMM_SETTINGS, { selectedPreset: "dsmm-builder", route });
    for (const variant of ["codex", "gpt", "gemini", "gemini-4", "glm", "kimi", "swe-2", "claude-opus-5"]) {
      assert.equal(prompt.includes(marker(`deepwork/${variant}.md`)), (variants as readonly string[]).includes(variant), `${provider}/${model}: ${variant}`);
    }
    assert.deepEqual(route, { provider, model, reasoningEffort: "low" });
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

test("compact series select the existing base, planner and category layers once in order", () => {
  const planner = SOURCE_ROLE_CATALOG.find(row => row.sourceId === "planner")!;
  const category = SOURCE_ROLE_CATALOG.find(row => row.kind === "category" && row.promptArtifact !== null)!;
  for (const model of ["gpt6.1sol", "sol6.1", "6.1sol", "terra6.2", "6astra", "luna-6"]) {
    assert.deepEqual(promptModelVariants("builder", model), ["gpt"], model);
    assert.equal(roleModelCalibration(planner, model), ["planner", "gpt"].map(variant => marker(`deepwork/${variant}.md`)).join("\n\n---\n\n"), model);
    assert.equal(roleModelCalibration(category, model), ["[fixture:category:gpt]", marker("deepwork/gpt.md")].join("\n\n---\n\n"), model);
  }
  for (const model of ["gpt6.1sol-codex", "sol6.1-codex"]) {
    assert.deepEqual(promptModelVariants("builder", model), ["codex", "gpt"], model);
    assert.deepEqual(promptModelVariants("planner", model), ["planner", "gpt"], model);
    assert.equal(roleModelCalibration(category, model), ["[fixture:category:gpt]", marker("deepwork/gpt.md")].join("\n\n---\n\n"), model);
  }
  for (const model of ["opus4.7", "opus-4-7", "sonnet4.6", "haiku-4-5", "sonnet5", "haiku5.5"]) {
    assert.deepEqual(promptModelVariants("orchestrator", model), [], model);
    assert.equal(roleModelCalibration(category, model), "[fixture:category:claude]", model);
  }
});

test("compact calibration keeps exact Opus scope and rejects partial and oversized versions", () => {
  for (const model of ["opus5", "5opus", "opus5.5-2m", "5.5opus", "claude-opus5.5-19990101"]) {
    assert.deepEqual(promptModelVariants("orchestrator", model), ["claude-opus-5"], model);
    assert.deepEqual(promptModelVariants("reviewer", model), [], model);
  }
  for (const model of ["opus5.0", "opus5.50", "opus50", "opus5.5foo", "5.5foo-opus", "opus5.5.0.0",
    "sonnet5", "haiku5.5", "gpt-5.5-opus4.7-codex", "sol6.1-opus5"]) {
    assert.equal(promptModelVariants("orchestrator", model).includes("claude-opus-5"), false, model);
  }
  for (const model of ["gemini-4.1foo", "gemini-4.1.2.3"]) {
    assert.deepEqual(promptModelVariants("builder", model), ["gemini"], model);
  }
  for (const model of ["gemini-4.1-19990101", "gemini-4.1-128k", "gemini-4.1-2m"]) {
    assert.deepEqual(promptModelVariants("builder", model), ["gemini", "gemini-4"], model);
  }
  assert.deepEqual(promptModelVariants("builder", "gpt-5.5-sol6.1-codex"), ["gpt"]);
  assert.deepEqual(promptModelVariants("builder", "gpt4o-6.1sol-codex"), ["gpt"]);
  assert.deepEqual(promptModelVariants("builder", "6.1sol/gemini-4-pro"), ["gpt"]);
});

test("non-target compact markers and malformed numeric tails cannot select dedicated calibration", () => {
  const builder = SOURCE_ROLE_CATALOG.find(row => row.sourceId === "builder")!;
  const orchestrator = SOURCE_ROLE_CATALOG.find(row => row.sourceId === "orchestrator")!;
  for (const model of ["gemini3", "gemini5", "gemini40"]) {
    assert.deepEqual(promptModelVariants("builder", model), ["gemini"], model);
    assert.equal(roleModelCalibration(builder, model), marker("deepwork/gemini.md"), model);
  }
  assert.deepEqual(promptModelVariants("builder", "gemini-4.1"), ["gemini", "gemini-4"]);
  assert.equal(roleModelCalibration(orchestrator, "6.1foo.5opus"), "");
  assert.deepEqual(promptModelVariants("orchestrator", "6.1foo.5opus"), []);
  assert.equal(roleModelCalibration(orchestrator, "6.1foo.5opus-gpt6.1sol"), marker("deepwork/gpt.md"));
});

test("Gemini 4 wildcard and compact names compose each role layer once in order", () => {
  for (const model of ["gemini-4.x", "gemini-4.x-pro@default", "gemini4", "gemini4.1:latest"]) {
    for (const [roleId, layers] of [
      [undefined, ["gemini", "gemini-4"]], ["dsmm-builder", ["gemini", "gemini-4"]],
      ["dsmm-planner", ["planner", "gemini-4"]], ["dsmm-research", ["category:gemini", "gemini-4"]]
    ] as const) {
      const prompt = buildDeepworkPrompt(DEFAULT_DSMM_SETTINGS, { roleId, route: { provider: "fixture", model } });
      let previous = prompt.indexOf(marker("deepwork/default.md"));
      assert.ok(previous >= 0);
      for (const layer of layers) {
        const selected = layer === "category:gemini" ? "[fixture:category:gemini]" : marker(`deepwork/${layer}.md`);
        assert.equal(prompt.split(selected).length - 1, 1, `${roleId}/${model}: ${layer}`);
        assert.ok(prompt.indexOf(selected) > previous, `${roleId}/${model}: ${layer} order`);
        previous = prompt.indexOf(selected);
      }
      if (roleId === "dsmm-research") assert.equal(prompt.includes(marker("deepwork/gemini.md")), false);
    }
  }
  for (const provider of ["google", "google-vertex", "gemini-4-provider"]) {
    for (const model of ["unrelated", "4.x", "4.x-pro@default"]) {
      const prompt = buildDeepworkPrompt(DEFAULT_DSMM_SETTINGS, { route: { provider, model } });
      assert.equal(prompt.includes(marker("deepwork/gemini-4.md")), false, `${provider}/${model}`);
    }
  }
});

test("native root and child prompts load Gemini 4 once and retain exact-Agent off behavior", async () => {
  const { renderPrompt } = await import("@deepseek-ai/dsh-system-prompt");
  const { nativeRoutingFixture } = await import("./native-routing-fixture.ts");
  const { appendModeRecord } = await import("../src/session-metadata.ts");
  const f = await nativeRoutingFixture({ defaultActive: true, roleRouting: {
    "dsmm-coding": { primary: { provider: "fixture", model: "gemini-4.x-pro:latest" } }
  } }, { nativePresets: true });
  try {
    const root = await f.create({ agentPreset: "dsmm-orchestrator" }, undefined,
      { agentOptions: { provider: "fixture", model: "gemini4.1@default" } });
    const child = await f.createAuxiliary("dsmm-coding", undefined, "continuable", root);
    const runtime = f.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    const count = async (agent: typeof root) => renderPrompt(await f.ctx.systemPrompt.assemble({ scope: agent }))
      .split(marker("deepwork/gemini-4.md")).length - 1;
    const mode = async (agent: typeof root, active: boolean) => {
      const target: Omit<DshAgent, "ctx"> = agent;
      const before = await runtime.getSession(target);
      await runtime.selectMode({ sessionId: agent.id, active, expectedModeRevision: before.deepwork!.revision,
        expectedAdmissionEpoch: before.admissionEpoch }, target);
    };
    assert.equal(await count(root), 1);
    assert.equal(await count(child), 1);
    await mode(root, false);
    assert.equal(await count(root), 0);
    assert.equal(await count(child), 1);
    appendModeRecord(child.session, false);
    assert.equal(await count(child), 0);
    await mode(root, true);
    assert.equal(await count(root), 1);
    assert.equal(await count(child), 0);
  } finally { await f.dispose(); }
});

test("numeric identifiers after consumed coarse GPT spans stop trailing Codex calibration", () => {
  const builder = SOURCE_ROLE_CATALOG.find(row => row.sourceId === "builder")!;
  for (const model of ["gpt4o-6.1sol-codex", "gpt4o-6.1opus-codex", "gpt-4o-6.1sol-codex", "gpt-4o-6.1opus-codex"]) {
    assert.deepEqual(promptModelVariants("builder", model), ["gpt"], model);
    assert.equal(roleModelCalibration(builder, model), marker("deepwork/gpt.md"), model);
  }
});
