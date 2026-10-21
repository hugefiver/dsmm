import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import type { DshContext } from "../lib/dsh-types.js";
import { DSMM_STATUS_COMMAND } from "../lib/commands.js";
import { DEFAULT_DSMM_LSP_SETTINGS } from "../lib/lsp.js";
import { DSMM_ROLES } from "../lib/roles.js";
import { DSMM_CONFIG_SCHEMA, DSMM_SETTINGS_SCHEMA, DSMM_SKILL_NAMES, DEFAULT_DSMM_SETTINGS, resolveConfig, resolveRoleRuntimePolicy, registerSettings } from "../lib/settings.js";
import { DEFAULT_DSMM_RUNTIME_POLICY, DSMM_RATE_LIMIT_BOUNDS } from "../lib/routing-policy.js";
import type { DsmmPluginConfig, DsmmSettings } from "../lib/settings.js";
import { useIsolatedDshEnvironment } from "./dsh-test-environment.ts";

useIsolatedDshEnvironment();

const DEFAULT_ROLE_SETTINGS = Object.fromEntries(DSMM_ROLES.map((role) => [role.id, role.enabledByDefault]));
const DEFAULT_SKILL_SETTINGS = Object.fromEntries(DSMM_SKILL_NAMES.map((id) => [id, true]));

test("roles, profiles and status load in a fresh ESM process regardless of entry order", () => {
  for (const entries of [["prompts", "roles", "profiles", "status"], ["roles", "prompts", "settings"], ["status", "roles", "settings"], ["routing-policy", "role-providers", "profiles"]]) {
    const script = entries.map((entry) => `await import(${JSON.stringify(new URL(`../lib/${entry}.js`, import.meta.url).href)});`).join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, `${entries.join(",")}: ${result.stderr}`);
    assert.equal(result.error, undefined);
  }
});

test("old routing documents retain their chains but resolve the safer startup lock", () => {
  for (const enabled of [false, true]) {
    const settings = resolveConfig({ runtimeRecovery: { enabled, fallbackRoutes: [{ provider: "global", model: "fallback" }] }, roleRouting: {
      "dsmm-reviewer": { primary: { provider: "p", model: "m" } },
      "dsmm-planner": { fallbackRoutes: [] }
    } });
    const reviewer = resolveRoleRuntimePolicy(settings, "dsmm-reviewer");
    assert.equal(reviewer.strategy, "startup-lock");
    assert.deepEqual(reviewer.rateLimit, DEFAULT_DSMM_RUNTIME_POLICY.rateLimit);
    assert.equal(reviewer.fallbackSource, "global");
    assert.deepEqual(reviewer.fallbackRoutes, [{ provider: "global", model: "fallback" }]);
    assert.deepEqual(resolveRoleRuntimePolicy(settings, "dsmm-planner").fallbackRoutes, []);
    assert.equal(resolveRoleRuntimePolicy(settings, "dsmm-planner").fallbackSource, "role");
    assert.equal(Object.hasOwn(settings.roleRouting["dsmm-reviewer"]!, "strategy"), false);
  }
});

test("each role overrides inherited strategy and retry fields independently", () => {
  const settings = resolveConfig({
    runtimePolicy: { strategy: "rate-limit-fallback", rateLimit: { maxRetries: 8, switchAfterRateLimits: 4, maxSwitches: 5 } },
    roleRouting: {
      "dsmm-reviewer": { strategy: "startup-lock", rateLimit: { maxRetries: 0 } },
      "dsmm-planner": { rateLimit: { switchAfterRateLimits: 2 } }
    }
  });
  const reviewer = resolveRoleRuntimePolicy(settings, "dsmm-reviewer");
  const planner = resolveRoleRuntimePolicy(settings, "dsmm-planner");
  assert.equal(reviewer.strategy, "startup-lock");
  assert.equal(reviewer.rateLimit.maxRetries, 0);
  assert.equal(planner.strategy, "rate-limit-fallback");
  assert.equal(planner.rateLimit.maxRetries, 8);
  assert.equal(planner.rateLimit.switchAfterRateLimits, 2);
  assert.equal(reviewer.rateLimit.switchAfterRateLimits, 4);
  assert.equal(reviewer.rateLimit.maxSwitches, 5);
  assert.equal(resolveRoleRuntimePolicy(settings, "dsmm-reviewer"), reviewer, "normalized identity is resolved once");
  assert.ok(Object.isFrozen(reviewer));
  assert.ok(Object.isFrozen(reviewer.rateLimit));
  assert.ok(Object.isFrozen(reviewer.fallbackRoutes));
});

test("ordered candidates are copied and deduplicated by complete JSON value including primary", () => {
  const settings = resolveConfig({ roleRouting: { "dsmm-reviewer": {
    primary: { provider: "p", model: "m", reasoningEffort: "low" },
    fallbackRoutes: [
      { reasoningEffort: "low", model: "m", provider: "p" },
      { provider: "p", model: "m", reasoningEffort: "high" },
      { provider: "q", model: "n", reasoningEffort: "high" },
      { reasoningEffort: "high", model: "n", provider: "q" },
      { provider: "q", model: "n", reasoningEffort: "low" },
      { provider: "r", model: "o" },
      { provider: "r", model: "o", parameters: { flag: false, value: null } },
      { parameters: { value: null, flag: false }, model: "o", provider: "r" },
      { provider: "r", model: "o", parameters: { flag: true, value: null } }
    ]
  } } });
  const policy = resolveRoleRuntimePolicy(settings, "dsmm-reviewer");
  assert.deepEqual(policy.fallbackRoutes, [
    { provider: "p", model: "m", reasoningEffort: "high" },
    { provider: "q", model: "n", reasoningEffort: "high" },
    { provider: "q", model: "n", reasoningEffort: "low" },
    { provider: "r", model: "o" },
    { provider: "r", model: "o", parameters: { flag: false, value: null } },
    { provider: "r", model: "o", parameters: { flag: true, value: null } }
  ]);
  assert.notEqual(policy.primary, settings.roleRouting["dsmm-reviewer"]!.primary);
  assert.notEqual(policy.fallbackRoutes[0], settings.roleRouting["dsmm-reviewer"]!.fallbackRoutes![1]);
  assert.ok(Object.isFrozen(policy.primary));
  assert.ok(Object.isFrozen(policy.fallbackRoutes[0]));
});

test("new policies reject malformed presence and unknown fields before schema defaults", () => {
  const malformed = [
    { runtimePolicy: null }, { runtimePolicy: undefined }, { runtimePolicy: [] },
    { runtimePolicy: { strategy: null } }, { runtimePolicy: { strategy: undefined } },
    { runtimePolicy: { strategy: "automatic" } }, { runtimePolicy: { retries: 2 } },
    { runtimePolicy: { rateLimit: null } }, { runtimePolicy: { rateLimit: undefined } },
    { runtimePolicy: { rateLimit: [] } }, { runtimePolicy: { rateLimit: { unknown: 1 } } },
    { roleRouting: { "dsmm-reviewer": { strategy: null } } },
    { roleRouting: { "dsmm-reviewer": { rateLimit: undefined } } },
    { roleRouting: { "dsmm-reviewer": { rateLimit: { secret: 2 } } } }
  ];
  for (const input of malformed) {
    assert.throws(() => resolveConfig(input as unknown as DsmmPluginConfig));
    assert.throws(() => DSMM_CONFIG_SCHEMA(input as unknown as DsmmPluginConfig));
    assert.throws(() => DSMM_SETTINGS_SCHEMA(input as unknown as DsmmSettings));
  }
});

test("all retry-policy bounds are strict finite integers, not silently repaired", () => {
  for (const [field, [minimum, maximum]] of Object.entries(DSMM_RATE_LIMIT_BOUNDS)) {
    for (const value of [minimum - 1, maximum + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null, undefined]) {
      for (const input of [
        { runtimePolicy: { rateLimit: { [field]: value } } },
        { roleRouting: { "dsmm-reviewer": { rateLimit: { [field]: value } } } }
      ]) {
        assert.throws(() => resolveConfig(input as unknown as DsmmPluginConfig), `${field}=${String(value)}`);
        assert.throws(() => DSMM_CONFIG_SCHEMA(input), `${field}=${String(value)}`);
      }
    }
    for (const value of [minimum, maximum]) {
      const rateLimit = { initialDelayMs: 0, maxDelayMs: 30000, [field]: value };
      const settings = resolveConfig({ runtimePolicy: { rateLimit } });
      assert.equal(settings.runtimePolicy.rateLimit[field as keyof typeof settings.runtimePolicy.rateLimit], value);
    }
  }
  assert.deepEqual(resolveConfig({ runtimePolicy: { rateLimit: { initialDelayMs: 2000, maxDelayMs: 1000 } } }).runtimePolicy.rateLimit,
    { ...DEFAULT_DSMM_RUNTIME_POLICY.rateLimit, initialDelayMs: 2000, maxDelayMs: 1000 }, "bounded knobs remain independent; the retry owner caps computed delay");
});
const DEFAULT_WORKFLOW_SETTINGS = {
  policy: "risk-based",
  strictGates: true,
  reviewCap: 5,
  finalReviewPolicy: "simple-oracle-complex-reviewer"
};
const DEFAULT_GUARD_SETTINGS = {
  scope: "deepwork-or-dsmm-agent",
  shellCommandSafety: true,
  gitWriteGuard: "ask",
  toolOutputTruncation: {
    enabled: true,
    maxInlineBytes: 12000
  },
  planFormatValidation: true,
  questionLabelHelper: {
    enabled: true,
    maxLabelChars: 30
  },
  todoDisciplineHelper: true
};
const DEFAULT_RUNTIME_RECOVERY_SETTINGS = {
  enabled: false,
  retryOnStatusCodes: [429, 500, 502, 503, 504],
  retryOnCodes: [],
  fallbackRoutes: [],
  maxFallbackAttempts: 2,
  idleContinuation: {
    enabled: false,
    maxContinuations: 3,
    prompt: "Continue the current task from the durable goal or unfinished todo list. Do not repeat completed work."
  }
};
const DEFAULT_PERMISSION_CONTROL_SETTINGS = {
  enabled: true,
  outsideReads: "inherit",
  webSearch: { enabled: true, rule: "inherit" },
  webFetch: { enabled: true, rule: "inherit" },
  rules: [],
  nativeCommands: { enabled: false, entries: [] }
};

test("default settings keep deepwork opt-in", () => {
  assert.deepEqual(DEFAULT_DSMM_SETTINGS, {
    permissionControl: DEFAULT_PERMISSION_CONTROL_SETTINGS,
    modelParameters: { passthrough: true },
    modules: { deepwork: { enabled: true } },
    modeName: "deepwork",
    defaultActive: false,
    promptOrder: 50,
    skills: DEFAULT_SKILL_SETTINGS,
    roles: DEFAULT_ROLE_SETTINGS,
    roleRouting: {},
    runtimePolicy: DEFAULT_DSMM_RUNTIME_POLICY,
    presets: {
      materialize: false
    },
    subagents: { enableRunInBackground: false, backgroundMode: "one-shot", toolTopology: "per-role", allowRouteOverride: false },
    workflow: DEFAULT_WORKFLOW_SETTINGS,
    guards: DEFAULT_GUARD_SETTINGS,
    runtimeRecovery: DEFAULT_RUNTIME_RECOVERY_SETTINGS,
    lsp: DEFAULT_DSMM_LSP_SETTINGS
  });
});

test("default settings enable scoped safety guards", () => {
  assert.deepEqual(DEFAULT_DSMM_SETTINGS.guards, DEFAULT_GUARD_SETTINGS);
});

test("current Loader config installs without legacy settings registration or systemPrompt injection", () => {
  let installed = 0;
  const context: DshContext = {
    get() { return undefined; },
    inject() { throw new Error("settings must not depend on service injection"); }
  };
  const settings = registerSettings(context, { workflow: { policy: "legacy", strictGates: false, reviewCap: 2 } }, {
    install(ready, getSettings) {
      assert.equal(ready, context);
      assert.equal(getSettings().workflow.policy, "legacy");
      installed += 1;
    }
  })();
  assert.equal(installed, 1);
  assert.equal(settings.workflow.strictGates, false);
  assert.equal(settings.workflow.reviewCap, 2);
});

test("resolveConfig overlays plugin config on defaults", () => {
  assert.deepEqual(resolveConfig({ modeName: "dw", promptOrder: 60 }), {
    permissionControl: DEFAULT_PERMISSION_CONTROL_SETTINGS,
    modelParameters: { passthrough: true },
    modules: { deepwork: { enabled: true } },
    modeName: "dw",
    defaultActive: false,
    promptOrder: 60,
    skills: DEFAULT_SKILL_SETTINGS,
    roles: DEFAULT_ROLE_SETTINGS,
    roleRouting: {},
    runtimePolicy: DEFAULT_DSMM_RUNTIME_POLICY,
    presets: {
      materialize: false
    },
    subagents: { enableRunInBackground: false, backgroundMode: "one-shot", toolTopology: "per-role", allowRouteOverride: false },
    workflow: DEFAULT_WORKFLOW_SETTINGS,
    guards: DEFAULT_GUARD_SETTINGS,
    runtimeRecovery: DEFAULT_RUNTIME_RECOVERY_SETTINGS,
    lsp: DEFAULT_DSMM_LSP_SETTINGS
  });
});

test("resolveConfig reserves only the exact dsmm-status mode name", () => {
  const cases: Array<readonly [string | undefined, string]> = [
    [undefined, DEFAULT_DSMM_SETTINGS.modeName],
    [DSMM_STATUS_COMMAND, DEFAULT_DSMM_SETTINGS.modeName],
    ["custom", "custom"],
    ["", ""],
    ["DSMM-STATUS", "DSMM-STATUS"],
    ["dsmm-status ", "dsmm-status "]
  ];

  for (const [modeName, expected] of cases) {
    assert.equal(resolveConfig({ modeName }).modeName, expected);
  }
});

test("resolveConfig supports partial lsp setting overlays", () => {
  const settings = resolveConfig({
    lsp: {
      enabled: true,
      serverName: "custom_lsp",
      args: ["mcp", "--trace"],
      env: { DSMM_LSP_LOG: "1" },
      toolCallTimeoutMs: 4500.8
    }
  });

  assert.deepEqual(settings.lsp, {
    ...DEFAULT_DSMM_LSP_SETTINGS,
    enabled: true,
    serverName: "custom_lsp",
    args: ["mcp", "--trace"],
    env: { DSMM_LSP_LOG: "1" },
    toolCallTimeoutMs: 4500
  });
});

test("resolveConfig falls back for invalid lsp timeouts", () => {
  assert.equal(resolveConfig({ lsp: { toolCallTimeoutMs: 0 } }).lsp.toolCallTimeoutMs, DEFAULT_DSMM_LSP_SETTINGS.toolCallTimeoutMs);
  assert.equal(resolveConfig({ lsp: { toolCallTimeoutMs: Number.NaN } }).lsp.toolCallTimeoutMs, DEFAULT_DSMM_LSP_SETTINGS.toolCallTimeoutMs);
});

test("resolveConfig supports partial guard setting overlays", () => {
  const settings = resolveConfig({
    guards: {
      scope: "always",
      gitWriteGuard: "deny",
      toolOutputTruncation: { maxInlineBytes: 80 },
      questionLabelHelper: { enabled: false }
    }
  });

  assert.deepEqual(settings.guards, {
    ...DEFAULT_GUARD_SETTINGS,
    scope: "always",
    gitWriteGuard: "deny",
    toolOutputTruncation: {
      enabled: true,
      maxInlineBytes: 80
    },
    questionLabelHelper: {
      enabled: false,
      maxLabelChars: 30
    }
  });
});

test("resolveConfig normalizes guard positive integer limits", () => {
  assert.equal(resolveConfig({ guards: { toolOutputTruncation: { maxInlineBytes: 0 } } }).guards.toolOutputTruncation.maxInlineBytes, 12000);
  assert.equal(resolveConfig({ guards: { questionLabelHelper: { maxLabelChars: Number.NaN } } }).guards.questionLabelHelper.maxLabelChars, 30);
  assert.equal(resolveConfig({ guards: { toolOutputTruncation: { maxInlineBytes: 80.9 } } }).guards.toolOutputTruncation.maxInlineBytes, 80);
});

test("resolveConfig normalizes runtime recovery settings", () => {
  const settings = resolveConfig({
    runtimeRecovery: {
      retryOnStatusCodes: [429, 429, 99, 600, 500.5, 503],
      retryOnCodes: [" ETIMEDOUT ", "etimedout", "", "ECONNRESET"],
      fallbackRoutes: [
        { provider: " primary ", model: " primary-model " },
        { provider: "primary", model: "primary-model" },
        { provider: " secondary ", model: " fallback-model " }
      ],
      maxFallbackAttempts: 99,
      idleContinuation: { maxContinuations: -4 }
    }
  });

  assert.deepEqual(settings.runtimeRecovery, {
    ...DEFAULT_RUNTIME_RECOVERY_SETTINGS,
    retryOnStatusCodes: [429, 503],
    retryOnCodes: ["etimedout", "econnreset"],
    fallbackRoutes: [
      { provider: "primary", model: "primary-model" },
      { provider: "primary", model: "primary-model" },
      { provider: "secondary", model: "fallback-model" }
    ],
    maxFallbackAttempts: 10,
    idleContinuation: {
      ...DEFAULT_RUNTIME_RECOVERY_SETTINGS.idleContinuation,
      maxContinuations: 0
    }
  });
});

test("resolveConfig keeps explicit empty recovery lists and non-finite limits defaulted", () => {
  const empty = resolveConfig({
    runtimeRecovery: {
      retryOnStatusCodes: [],
      retryOnCodes: [],
      fallbackRoutes: []
    }
  });
  const nonFinite = resolveConfig({
    runtimeRecovery: {
      maxFallbackAttempts: Number.POSITIVE_INFINITY,
      idleContinuation: { maxContinuations: Number.NaN }
    }
  });

  assert.deepEqual(empty.runtimeRecovery.retryOnStatusCodes, []);
  assert.deepEqual(empty.runtimeRecovery.retryOnCodes, []);
  assert.deepEqual(empty.runtimeRecovery.fallbackRoutes, []);
  assert.equal(nonFinite.runtimeRecovery.maxFallbackAttempts, 2);
  assert.equal(nonFinite.runtimeRecovery.idleContinuation.maxContinuations, 3);
});

test("resolveConfig defensively copies normalized recovery settings", () => {
  const input = {
    runtimeRecovery: {
      retryOnStatusCodes: [429],
      retryOnCodes: ["ETIMEDOUT"],
      fallbackRoutes: [{ provider: "primary", model: "primary-model" }],
      idleContinuation: { prompt: "Keep going." }
    }
  } satisfies DsmmPluginConfig;
  const first = resolveConfig(input);
  const second = resolveConfig(input);

  assert.notEqual(first.runtimeRecovery, second.runtimeRecovery);
  assert.notEqual(first.runtimeRecovery.retryOnStatusCodes, second.runtimeRecovery.retryOnStatusCodes);
  assert.notEqual(first.runtimeRecovery.retryOnCodes, second.runtimeRecovery.retryOnCodes);
  assert.notEqual(first.runtimeRecovery.fallbackRoutes, second.runtimeRecovery.fallbackRoutes);
  assert.notEqual(first.runtimeRecovery.fallbackRoutes[0], second.runtimeRecovery.fallbackRoutes[0]);
  assert.notEqual(first.runtimeRecovery.idleContinuation, second.runtimeRecovery.idleContinuation);
  assert.notEqual(first.runtimeRecovery.retryOnStatusCodes, DEFAULT_DSMM_SETTINGS.runtimeRecovery.retryOnStatusCodes);
  assert.notEqual(first.runtimeRecovery.retryOnCodes, DEFAULT_DSMM_SETTINGS.runtimeRecovery.retryOnCodes);
  assert.notEqual(first.runtimeRecovery.fallbackRoutes, DEFAULT_DSMM_SETTINGS.runtimeRecovery.fallbackRoutes);
  assert.notEqual(first.runtimeRecovery.fallbackRoutes[0], input.runtimeRecovery.fallbackRoutes?.[0]);

  first.runtimeRecovery.retryOnStatusCodes.push(503);
  first.runtimeRecovery.retryOnCodes.push("econnreset");
  first.runtimeRecovery.fallbackRoutes[0].provider = "changed";
  first.runtimeRecovery.idleContinuation.prompt = "Changed.";

  assert.deepEqual(second.runtimeRecovery, {
    ...DEFAULT_RUNTIME_RECOVERY_SETTINGS,
    retryOnStatusCodes: [429],
    retryOnCodes: ["etimedout"],
    fallbackRoutes: [{ provider: "primary", model: "primary-model" }],
    idleContinuation: {
      ...DEFAULT_RUNTIME_RECOVERY_SETTINGS.idleContinuation,
      prompt: "Keep going."
    }
  });
});

test("resolveConfig supports per-skill toggles", () => {
  const settings = resolveConfig({ skills: { "writing-plans": false, "remove-ai-slops": false } });
  assert.equal(settings.skills["writing-plans"], false);
  assert.equal(settings.skills["remove-ai-slops"], false);
  assert.equal(settings.skills.brainstorming, true);
});

test("resolveConfig supports workflow setting overlays", () => {
  const settings = resolveConfig({ workflow: { reviewCap: 2, finalReviewPolicy: "reviewer-only" } });

  assert.deepEqual(settings.workflow, {
    policy: "legacy",
    strictGates: true,
    reviewCap: 2,
    finalReviewPolicy: "reviewer-only"
  });
});

test("Loader schema preserves explicit legacy workflow provenance", () => {
  assert.equal(resolveConfig(DSMM_CONFIG_SCHEMA({})).workflow.policy, "risk-based");
  assert.equal(resolveConfig(DSMM_CONFIG_SCHEMA({ workflow: { reviewCap: 2 } })).workflow.policy, "legacy");
  assert.equal(resolveConfig(DSMM_CONFIG_SCHEMA({ workflow: { strictGates: true } })).workflow.policy, "legacy");
  assert.equal(resolveConfig(DSMM_CONFIG_SCHEMA({ workflow: { policy: "risk-based", strictGates: true } })).workflow.policy, "risk-based");
});

test("resolveConfig supports per-role toggles", () => {
  const settings = resolveConfig({ roles: { "dsmm-reviewer": false } });

  assert.equal(settings.roles["dsmm-reviewer"], false);
  assert.equal(settings.roles["dsmm-orchestrator"], true);
});

test("resolveConfig supports preset materialization settings", () => {
  const settings = resolveConfig({ presets: { materialize: true, root: "/tmp/dsmm-presets" } });

  assert.deepEqual(settings.presets, {
    materialize: true,
    root: "/tmp/dsmm-presets"
  });
  assert.deepEqual(resolveConfig({ presets: { materialize: true } }).presets, { materialize: true });
});

test("restart-scoped Config is the only deployment input, even on a legacy-shaped host", () => {
  const observed: string[] = [];
  const ctx = new Proxy({} as DshContext, { get(_target, property) {
    if (property === "settings") throw new Error("removed settings API was read");
    return undefined;
  } });
  const getSettings = registerSettings(ctx, { modeName: "base", defaultActive: true }, {
    onChange(settings) { observed.push(settings.modeName); },
    install(ready, settings) { assert.equal(ready, ctx); observed.push(`install:${settings().modeName}`); }
  });
  assert.deepEqual(getSettings(), resolveConfig({ modeName: "base", defaultActive: true }));
  assert.deepEqual(observed, ["base", "install:base"]);
});

test("Config reinstallation makes a separate baseline and cannot replace an old getter", () => {
  const a = registerSettings({}, { defaultActive: true });
  const b = registerSettings({}, { defaultActive: false });
  assert.equal(a().defaultActive, true); assert.equal(b().defaultActive, false);
  assert.notEqual(a(), b());
  const invalid = { runtimePolicy: { strategy: "unknown" } } as unknown as DsmmPluginConfig;
  assert.throws(() => registerSettings({}, invalid));
});

test("Config normalizes reserved command names for getters and installation", () => {
  const installed: string[] = [];
  const getSettings = registerSettings({}, { modeName: DSMM_STATUS_COMMAND }, {
    install(_ctx, settings) { installed.push(settings().modeName); }
  });
  assert.equal(getSettings().modeName, DEFAULT_DSMM_SETTINGS.modeName);
  assert.deepEqual(installed, [DEFAULT_DSMM_SETTINGS.modeName]);
});
