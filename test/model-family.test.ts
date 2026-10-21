import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyModelFamily } from "../lib/model-family.js";

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
  assert.equal(classifyModelFamily({ providerID: "codex", modelID: "gpt-5.6" }), "codex", "codex has priority over gpt");
});

test("classifyModelFamily applies approved provider hints and priority", () => {
  const cases = [
    [{ providerID: "openai", modelID: "claude-opus-5" }, "claude"],
    [{ providerID: "anthropic-compatible", modelID: "custom-model" }, "claude"],
    [{ providerID: "zhipu-proxy", modelID: "custom-model" }, "glm"],
    [{ providerID: "kimi-cloud", modelID: "custom-model" }, "kimi"],
    [{ providerID: "anthropic", modelID: "gpt-5.6" }, "gpt"],
    [{ providerID: "deepseek", modelID: "kimi-k2.5" }, "kimi"]
  ] as const;

  for (const [input, expected] of cases) {
    assert.equal(classifyModelFamily(input), expected, JSON.stringify(input));
  }
});
