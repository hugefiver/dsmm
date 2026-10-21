import assert from "node:assert/strict";
import { test } from "node:test";
import { Config, createDsmmStatusSnapshot, resolveConfig } from "../lib/index.js";
import type { DsmmModelRoute, DsmmPluginConfig, DsmmRoleRoutingConfig } from "../lib/index.js";
import { DSMM_SETTINGS_SCHEMA } from "../lib/settings.js";

const primary: DsmmModelRoute = { provider: "fixture", model: "review-primary", reasoningEffort: "max" };
const fallback: DsmmModelRoute = { provider: "fixture", model: "review-fallback", reasoningEffort: "high" };

test("role routing defaults to inheritance and distinguishes missing from explicit empty chains", () => {
  assert.deepEqual(resolveConfig().roleRouting, {});
  const settings = resolveConfig({ roleRouting: {
    "dsmm-reviewer": { primary },
    "dsmm-code-search": { fallbackRoutes: [] },
    "dsmm-planner": {}
  } });
  assert.equal(Object.hasOwn(settings.roleRouting["dsmm-reviewer"]!, "fallbackRoutes"), false);
  assert.deepEqual(settings.roleRouting["dsmm-code-search"]!.fallbackRoutes, []);
  assert.deepEqual(settings.roleRouting["dsmm-planner"], {});
  assert.equal(settings.runtimeRecovery.enabled, false, "routing is not a second recovery gate");
});

test("public Loader and normalized schemas preserve canonical role routes and exact efforts", () => {
  const input = { roleRouting: {
    "dsmm-reviewer": { primary, fallbackRoutes: [fallback] },
    "dsmm-media-reader": { primary: { provider: "fixture", model: "image-model" }, fallbackRoutes: [] }
  } } satisfies DsmmPluginConfig;
  const normalized = resolveConfig(Config(input));
  assert.deepEqual(normalized.roleRouting, input.roleRouting);
  assert.deepEqual(resolveConfig(DSMM_SETTINGS_SCHEMA(normalized)).roleRouting, input.roleRouting);
  assert.equal(Object.hasOwn(normalized.roleRouting["dsmm-media-reader"]!.primary!, "reasoningEffort"), false);
});

test("new explicit role routes reject malformed route pairs, effort names and role identities", () => {
  const malformed: unknown[] = [
    null, [], "fixture", { reviewer: { primary } }, { "dsmm-explore": { primary } },
    { "dsmm-reviewer": null }, { "dsmm-reviewer": [] },
    { "dsmm-reviewer": { primary: null } },
    { "dsmm-reviewer": { primary: { provider: "fixture" } } },
    { "dsmm-reviewer": { primary: { model: "review-primary" } } },
    { "dsmm-reviewer": { primary: { provider: " ", model: "review-primary" } } },
    { "dsmm-reviewer": { primary: { provider: "fixture", model: " " } } },
    { "dsmm-reviewer": { primary: { ...primary, reasoningEffort: " " } } },
    { "dsmm-reviewer": { primary: { ...primary, reasoningEffort: 5 } } },
    { "dsmm-reviewer": { fallbackRoutes: {} } },
    { "dsmm-reviewer": { fallbackRoutes: [null] } },
    { "dsmm-reviewer": { fallbackRoutes: [{ provider: "fixture" }] } },
    { "dsmm-reviewer": { fallbackRoutes: [{ ...fallback, reasoningEffort: "" }] } }
  ];
  for (const roleRouting of malformed) {
    const input = { roleRouting } as unknown as DsmmPluginConfig;
    assert.throws(() => resolveConfig(input), JSON.stringify(roleRouting));
    assert.throws(() => Config(input), `Loader: ${JSON.stringify(roleRouting)}`);
    assert.throws(() => DSMM_SETTINGS_SCHEMA({ ...resolveConfig(), roleRouting } as unknown as ReturnType<typeof resolveConfig>), `settings: ${JSON.stringify(roleRouting)}`);
  }
});

test("normalization trims provider/model while preserving exact efforts and ordered fallback entries", () => {
  const settings = resolveConfig({ roleRouting: { "dsmm-reviewer": {
    primary: { provider: " fixture ", model: " review-primary ", reasoningEffort: " max " },
    fallbackRoutes: [
      { provider: " fixture ", model: " review-fallback ", reasoningEffort: " max " },
      { provider: "fixture", model: "review-fallback", reasoningEffort: "high" },
      { provider: "fixture", model: "second-fallback" }
    ]
  } } });
  assert.deepEqual(settings.roleRouting["dsmm-reviewer"], {
    primary: { ...primary, reasoningEffort: " max " },
    fallbackRoutes: [{ ...fallback, reasoningEffort: " max " }, fallback, { provider: "fixture", model: "second-fallback" }]
  });
});

test("disabled role policy is retained without changing boolean role semantics", () => {
  const policy: DsmmRoleRoutingConfig = { primary, fallbackRoutes: [] };
  const settings = resolveConfig({ roles: { "dsmm-builder": false }, roleRouting: { "dsmm-builder": policy } });
  assert.equal(settings.roles["dsmm-builder"], false);
  assert.deepEqual(settings.roleRouting["dsmm-builder"], policy);
  assert.notEqual(settings.roleRouting["dsmm-builder"], policy);
});

test("resolved and status role policies deeply detach primary, fallback arrays and fallback effort", () => {
  const input = { roleRouting: { "dsmm-reviewer": { primary: { ...primary }, fallbackRoutes: [{ ...fallback }] } } } satisfies DsmmPluginConfig;
  const first = resolveConfig(input);
  const second = resolveConfig(input);
  const snapshot = createDsmmStatusSnapshot({
    agent: { session: { append() {} } }, settings: first, modeActive: false
  });
  const firstPolicy = first.roleRouting["dsmm-reviewer"]!;
  const secondPolicy = second.roleRouting["dsmm-reviewer"]!;
  const copy = snapshot.effectiveSettings.roleRouting["dsmm-reviewer"]!;
  assert.notEqual(first.roleRouting, input.roleRouting);
  assert.notEqual(firstPolicy, secondPolicy);
  assert.notEqual(firstPolicy.primary, input.roleRouting["dsmm-reviewer"].primary);
  assert.notEqual(firstPolicy.fallbackRoutes, secondPolicy.fallbackRoutes);
  assert.notEqual(firstPolicy.fallbackRoutes![0], secondPolicy.fallbackRoutes![0]);
  assert.notEqual(copy, firstPolicy);
  assert.notEqual(copy.primary, firstPolicy.primary);
  assert.notEqual(copy.fallbackRoutes, firstPolicy.fallbackRoutes);
  assert.notEqual(copy.fallbackRoutes![0], firstPolicy.fallbackRoutes![0]);
  firstPolicy.primary!.model = "changed";
  firstPolicy.fallbackRoutes![0].reasoningEffort = "changed";
  firstPolicy.fallbackRoutes!.push({ provider: "fixture", model: "changed" });
  assert.deepEqual(secondPolicy, input.roleRouting["dsmm-reviewer"]);
  assert.deepEqual(copy, input.roleRouting["dsmm-reviewer"]);
  copy.primary!.provider = "snapshot-only";
  assert.equal(input.roleRouting["dsmm-reviewer"].primary.provider, "fixture");
});

test("global recovery configuration preserves exact efforts and rejects incomplete routes", () => {
  const settings = resolveConfig({ runtimeRecovery: { fallbackRoutes: [
    { provider: " fixture ", model: " review-fallback ", reasoningEffort: " max " },
    { provider: "fixture", model: "review-fallback", reasoningEffort: "high" }
  ] } });
  assert.deepEqual(settings.runtimeRecovery.fallbackRoutes, [{ ...fallback, reasoningEffort: " max " }, fallback]);
  assert.throws(() => resolveConfig({ runtimeRecovery: { fallbackRoutes: [{ provider: "", model: "ignored" }] } }));
});
