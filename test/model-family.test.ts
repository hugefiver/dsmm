import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyModelFamily, recognizeModelName } from "../lib/model-family.js";

test("classifyModelFamily identifies configured model families", () => {
  const cases = [
    [{ providerID: "openai", modelID: "gpt-5.6" }, "gpt"],
    [{ providerID: "openai-codex", modelID: "gpt-5.6-codex" }, "codex"],
    [{ providerID: "anthropic", modelID: "claude-opus-5" }, "claude"],
    [{ providerID: "google-vertex", modelID: "gemini-3-pro" }, "gemini"],
    [{ providerID: "github-copilot", modelID: "google.gemini-2.5-pro" }, "gemini"],
    [{ providerID: "zhipu", modelID: "glm-5" }, "glm"],
    [{ providerID: "moonshot", modelID: "kimi-k2.5" }, "kimi"],
    [{ providerID: "gateway", modelID: "k2-p7" }, "kimi"],
    [{ providerID: "deepseek", modelID: "deepseek-chat" }, "deepseek"],
    [{ providerID: "openrouter", modelID: "deepseek/deepseek-v4-pro" }, "deepseek"],
    [{ providerID: "custom", modelID: "custom-model" }, "unknown"],
    [{}, "unknown"]
  ] as const;

  for (const [input, expected] of cases) {
    assert.equal(classifyModelFamily(input), expected, JSON.stringify(input));
  }
  assert.equal(classifyModelFamily({ providerID: "codex", modelID: "gpt-5.6" }), "gpt", "explicit model identity precedes provider hints");
});

test("classifyModelFamily applies approved provider hints and priority", () => {
  const cases = [
    [{ providerID: "openai", modelID: "claude-opus-5" }, "claude"],
    [{ providerID: "anthropic-compatible", modelID: "custom-model" }, "claude"],
    [{ providerID: "zhipu-proxy", modelID: "custom-model" }, "glm"],
    [{ providerID: "kimi-cloud", modelID: "custom-model" }, "kimi"],
    [{ providerID: "anthropic", modelID: "gpt-5.6" }, "gpt"],
    [{ providerID: "deepseek", modelID: "kimi-k2.5" }, "kimi"],
    [{ providerID: "GOOGLE-VERTEX", modelID: "custom-model" }, "gemini"],
    [{ providerID: "CODEX" }, "codex"],
    [{ providerID: "moonshot" }, "kimi"],
    [{ providerID: "deepseek" }, "deepseek"],
    [{ providerID: "openai" }, "unknown"],
    [{ providerID: "anthropic", modelID: "auto-k2p8-gpt-6" }, "unknown"],
    [{ providerID: "codex", modelID: "auto-swe/2/high-gpt-6" }, "unknown"]
  ] as const;

  for (const [input, expected] of cases) {
    assert.equal(classifyModelFamily(input), expected, JSON.stringify(input));
  }
});

test("model fields scan left to right across wrappers and separators without guessing a provider", () => {
  for (const [modelID, family] of [
    ["group/glm-5.3-1m", "glm"], ["auto-deepseek-v41", "deepseek"],
    ["custom.gemini-4-pro", "gemini"], [" AUTO_GPT 6.1/SOL ", "gpt"],
    ["amazon-bedrock/us.openai.gpt-6.1-sol", "gpt"], ["gateway/auto/gemini/4/pro", "gemini"],
    ["prefix-gpt-5.6-codex-fast", "codex"], ["chatgpt-6-sol", "gpt"], ["auto-fable-5", "claude"],
    ["auto-kimi-k2.7", "kimi"], ["auto-k2p7", "kimi"], ["auto-k2p8", "unknown"],
    ["claude-opus-5-gpt-6.1-sol", "claude"], ["gemini-4-pro-gpt-6-codex", "gemini"],
    ["gpt-5.5-claude-opus-5-codex", "gpt"], ["gpt-5.5-gpt-6-codex", "gpt"],
    ["gpt-6-sol/gemini-4-pro", "gpt"], ["provider-kimi-for-coding/unrelated", "kimi"],
    ["not-kimi-k3", "kimi"], ["xkimi-k3", "unknown"], ["notgpt-6", "unknown"],
    ["kimish", "unknown"], ["codexish", "unknown"], ["k2p80", "unknown"]
  ] as const) {
    assert.equal(classifyModelFamily({ providerID: "gateway", modelID }), family, modelID);
  }
  assert.equal(classifyModelFamily({ providerID: "gpt-6-sol", modelID: "gemini-4-pro" }), "gemini");
  assert.equal(classifyModelFamily({ providerID: "google", modelID: "google/gpt-6.1-sol" }), "gpt");
  assert.equal(classifyModelFamily({ providerID: "zhipu", modelID: "auto-gpt-6.1-sol" }), "gpt");
});

test("compact and familyless series retain local version facts across the finite grammar", () => {
  for (const [series, family, version] of [
    ["opus", "claude", [4, 7, 0]], ["sonnet", "claude", [4, 6, 0]], ["haiku", "claude", [4, 5, 0]],
    ["sol", "gpt", [6, 1, 0]], ["terra", "gpt", [6, 2, 0]], ["astra", "gpt", [6, 3, 0]], ["luna", "gpt", [6, 4, 0]]
  ] as const) {
    const [major, minor] = version;
    for (const model of [`${series}${major}.${minor}`, `${series}-${major}-${minor}`, `${major}.${minor}${series}`,
      `${major}-${minor}-${series}`, `${family}-${series}${major}.${minor}`, `${family}-${series}-${major}-${minor}`,
      `Group/${major}_${minor}/${series.toUpperCase()}-128k`]) {
      const recognized = recognizeModelName(model)!;
      assert.equal(recognized.family, family, model);
      assert.equal(recognized.series, series, model);
      assert.deepEqual(recognized.version, version, model);
      assert.equal(recognized.versionParts, 2, model);
    }
  }
  for (const model of ["gpt6.1sol", "gpt6.1-sol", "gpt-6.1sol", "chatgpt6.1sol", "auto/SOL_6_1", "gpt6.1sol-2m"]) {
    assert.equal(recognizeModelName(model)?.series, "sol", model);
    assert.deepEqual(recognizeModelName(model)?.version, [6, 1, 0], model);
  }
  assert.deepEqual(recognizeModelName("6/astra")?.version, [6, 0, 0]);
  assert.equal(recognizeModelName("luna-6")?.versionParts, 1);
});

test("leftmost spans own adjacent versions and stop at independent same-family series", () => {
  for (const [model, family, series, version] of [
    ["6.1sol-opus5", "gpt", "sol", [6, 1, 0]], ["opus4.7-gpt6.1sol", "claude", "opus", [4, 7, 0]],
    ["6.1sol/gemini-4-pro", "gpt", "sol", [6, 1, 0]],
    ["gpt-5.5-sol6.1-mini", "gpt", undefined, [5, 5, 0]], ["gpt-5.5-sol-6.1", "gpt", undefined, [5, 5, 0]],
    ["gpt-5.5-fast-6.1sol-mini", "gpt", undefined, [5, 5, 0]], ["gpt-6.1-sol", "gpt", "sol", [6, 1, 0]],
    ["gpt4o-6.1sol", "gpt", undefined, undefined], ["chatgpt4o", "gpt", undefined, undefined],
    ["gpt6.1sol-codex", "codex", "sol", [6, 1, 0]], ["sol6.1-codex", "codex", "sol", [6, 1, 0]],
    ["gpt-5.5-opus4.7-codex", "gpt", undefined, [5, 5, 0]],
    ["gpt-5.5-sol-6.1-codex", "gpt", undefined, [5, 5, 0]], ["opus5.5foo-gpt6.1sol", "claude", "opus", undefined]
  ] as const) {
    const recognized = recognizeModelName(model)!;
    assert.equal(recognized.family, family, model);
    assert.equal(recognized.series, series, model);
    assert.deepEqual(recognized.version, version, model);
  }
});

test("versions require whole numeric segments and never retry malformed numeric tails", () => {
  for (const model of ["gpt6.1foo", "gpt-6.1foo-sol", "sol6.1foo", "opus5.5foo", "gemini-4.1foo",
    "gpt-6.1.2.3", "sol6.1.2.3", "opus5.5.0.0", "gpt4o", "deepseek-v41"]) {
    assert.equal(recognizeModelName(model)?.version, undefined, model);
    assert.equal(recognizeModelName(model)?.opus5, false, model);
    assert.equal(recognizeModelName(model)?.gemini4, false, model);
  }
  for (const model of ["4.7", "6.1", "xsol6.1", "notgpt6.1sol", "6.1solar", "solstice6.1", "astral6", "lunar6", "sonnetish4.6",
    "4.5.6.1sol", "4-5-6-1-sol", "4.5.6.1sol-gemini-4", "6.1foo-sol"]) {
    assert.equal(classifyModelFamily({ modelID: model }), model.includes("gemini") ? "gemini" : "unknown", model);
  }
  for (const [model, version, parts] of [
    ["sol5.6000", [5, 6000, 0], 2], ["gpt5.1.1000sol", [5, 1, 1000], 3],
    ["opus5.5-19990101", [5, 5, 0], 2], ["opus5.5-20261101", [5, 5, 0], 2],
    ["sol6.1-128k", [6, 1, 0], 2], ["gpt6.1sol-2m", [6, 1, 0], 2], ["opus5.5@default", [5, 5, 0], 2],
    ["sol6.1:latest", [6, 1, 0], 2], ["opus5-fast-6", [5, 0, 0], 1]
  ] as const) {
    assert.deepEqual(recognizeModelName(model)?.version, version, model);
    assert.equal(recognizeModelName(model)?.versionParts, parts, model);
  }
});

test("explicit series override provider hints without inventing hinted series or versions", () => {
  for (const providerID of ["google", "anthropic", "codex"]) {
    assert.equal(classifyModelFamily({ providerID, modelID: "sol6.1" }), "gpt", providerID);
    assert.equal(classifyModelFamily({ providerID, modelID: "opus4.7" }), "claude", providerID);
    assert.equal(classifyModelFamily({ providerID, modelID: "opus5.5foo-gpt6.1sol" }), "claude", providerID);
  }
  assert.equal(classifyModelFamily({ providerID: "google", modelID: "4.7" }), "gemini");
  assert.equal(recognizeModelName("4.7"), undefined);
});

test("non-target compact family markers retain only coarse identity", () => {
  for (const [model, family] of [
    ["gemini3.1", "gemini"], ["gemini5.1", "gemini"], ["gemini40", "gemini"], ["glm5.1", "glm"], ["claude4.7", "claude"],
    ["fable5.5", "claude"], ["kimi5.1", "kimi"], ["deepseek4.1", "deepseek"], ["codex5.5", "codex"]
  ] as const) {
    const recognized = recognizeModelName(model)!;
    assert.equal(recognized.family, family, model);
    assert.equal(recognized.version, undefined, model);
    assert.equal(recognized.versionParts, undefined, model);
    assert.equal(recognized.gemini4, false, model);
  }
  assert.deepEqual(recognizeModelName("gemini-4.1")?.version, [4, 1, 0]);
  assert.equal(recognizeModelName("gemini-4.1")?.gemini4, true);
  assert.deepEqual(recognizeModelName("claude-opus4.7")?.version, [4, 7, 0]);
});

test("explicit Gemini 4 identities retain numeric versions and leave wildcard versions unknown", () => {
  for (const [model, version, parts] of [
    ["gemini-4", [4, 0, 0], 1], ["gemini4", [4, 0, 0], 1],
    ["gemini4.1", [4, 1, 0], 2], ["gemini-4.12-pro", [4, 12, 0], 2],
    ["gemini-4.1.2", [4, 1, 2], 3], ["gemini-4.x", undefined, undefined],
    ["gemini-4.x-pro", undefined, undefined], ["gemini4.x-pro", undefined, undefined],
    ["gateway/GEMINI/4/pro", [4, 0, 0], 1], ["auto.gemini_4_1", [4, 1, 0], 2]
  ] as const) {
    for (const suffix of ["", "@default", ":latest"]) {
      const fullId = model + suffix;
      const recognized = recognizeModelName(fullId)!;
      assert.equal(recognized.family, "gemini", fullId);
      assert.equal(recognized.gemini4, true, fullId);
      assert.deepEqual(recognized.version, version, fullId);
      assert.equal(recognized.versionParts, parts, fullId);
    }
  }
  for (const model of ["4.x", "4.x-pro", "4.x@default", "4.x-pro:latest"]) {
    assert.equal(recognizeModelName(model), undefined, model);
    assert.equal(classifyModelFamily({ modelID: model }), "unknown", model);
    assert.equal(classifyModelFamily({ providerID: "google", modelID: model }), "gemini", model);
  }
});

test("Gemini 4 recognition rejects malformed versions and respects the first identity", () => {
  for (const model of ["gemini-3.1-pro", "gemini-5-pro", "gemini-40-pro", "gemini3", "gemini5", "gemini40",
    "gemini-4argon", "gemini4argon", "gemini-4.1foo", "gemini4.1foo", "gemini-4.1.2.3", "gemini4.1.2.3",
    "gemini-4.xfoo", "gemini-4.x1", "gemini-4.x.1", "gemini-4.9007199254740992",
    "gemini-3-gemini4.1", "gemini-gemini-4.x-pro", "gpt-6/gemini4.1", "opus5/gemini-4.x"]) {
    assert.equal(recognizeModelName(model)?.gemini4, false, model);
  }
  for (const model of ["gemini-4.x-pro-gpt-6", "gemini4.1/claude-opus-5"]) {
    assert.equal(recognizeModelName(model)?.gemini4, true, model);
    assert.equal(recognizeModelName(model)?.family, "gemini", model);
  }
});

test("Kimi K versions stay local to their first identity", () => {
  for (const [model, version] of [
    ["kimi-k3", [3, 0, 0]], ["kimi-k3.1", [3, 1, 0]], ["kimi-k3-1", [3, 1, 0]],
    ["kimi-k3p1", [3, 1, 0]], ["gateway/KIMI/K3/2/preview", [3, 2, 0]],
    ["kimi-k4", [4, 0, 0]], ["kimi-k10", [10, 0, 0]], ["kimi-k27", [2, 7, 0]],
    ["auto-kimi-k27", [2, 7, 0]], ["kimi-k27-preview", [2, 7, 0]], ["kimi-k27.1", [2, 7, 0]],
    ["kimi-k270", [270, 0, 0]], ["kimi-k3-kimi-k3.1", [3, 0, 0]],
    ["kimi-k3/kimi-k4", [3, 0, 0]], ["gpt-6-kimi-k3.1", [6, 0, 0]]
  ] as const) {
    assert.deepEqual(recognizeModelName(model, { promptAliases: true })?.version, version, model);
    assert.deepEqual(recognizeModelName(model)?.version, model.startsWith("gpt") ? version : undefined, model);
    assert.equal(classifyModelFamily({ modelID: model }), model.startsWith("gpt") ? "gpt" : "kimi", model);
  }
  for (const model of ["kimi", "kimi-latest", "kimi-k3.1foo", "kimi-k3p1foo", "kimi-k3.1.2.3",
    "kimi-k3.9007199254740992", "kimi-unknown-k4"]) {
    assert.equal(recognizeModelName(model, { promptAliases: true })?.version, undefined, model);
    assert.equal(classifyModelFamily({ modelID: model }), "kimi", model);
  }
});

test("bare K aliases are opt-in prompt identities and retain ordinary provider classification", () => {
  for (const [model, version] of [
    ["k3", [3, 0, 0]], ["k3.0", [3, 0, 0]], ["k3p0", [3, 0, 0]],
    ["k3p1", [3, 1, 0]], ["k3.1", [3, 1, 0]], ["k3-1", [3, 1, 0]],
    ["k3-k3.1", [3, 0, 0]], ["k3.0/k3p1", [3, 0, 0]],
    ["auto/K3.2", [3, 2, 0]], ["group/k4/preview", [4, 0, 0]], ["k27", [27, 0, 0]]
  ] as const) {
    assert.equal(recognizeModelName(model), undefined, model);
    assert.equal(classifyModelFamily({ modelID: model }), "unknown", model);
    assert.equal(classifyModelFamily({ providerID: "google", modelID: model }), "gemini", model);
    assert.equal(classifyModelFamily({ providerID: "moonshot", modelID: model }), "kimi", model);
    const recognized = recognizeModelName(model, { promptAliases: true })!;
    assert.equal(recognized.identifier, "kimi", model);
    assert.deepEqual(recognized.version, version, model);
  }
  for (const model of ["k3p1foo", "xk3.1", "xkimi-k3", "xkimi-k3.1", "not-k3p1"]) {
    assert.equal(recognizeModelName(model, { promptAliases: true }), undefined, model);
    assert.equal(classifyModelFamily({ modelID: model }), "unknown", model);
  }
  assert.equal(classifyModelFamily({ modelID: "k3.1-gpt-6" }), "gpt");
  assert.equal(recognizeModelName("k3.1-gpt-6", { promptAliases: true })?.identifier, "kimi");
});

test("malformed numeric spans cannot restart at later numeric series fragments", () => {
  for (const model of ["6.1foo.5opus", "6_1foo/5-opus", "6.1foo.5.5opus"]) {
    assert.equal(recognizeModelName(model), undefined, model);
    assert.equal(classifyModelFamily({ modelID: model }), "unknown", model);
    assert.equal(classifyModelFamily({ providerID: "google", modelID: model }), "gemini", model);
    const later = recognizeModelName(`${model}-gpt6.1sol`)!;
    assert.equal(later.family, "gpt", model);
    assert.equal(later.series, "sol", model);
    assert.deepEqual(later.version, [6, 1, 0], model);
  }
});
