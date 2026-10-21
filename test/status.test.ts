import assert from "node:assert/strict";
import { test } from "node:test";
import type { DshAgent, DshSessionEvent } from "../lib/dsh-types.js";
import { nativeRoutingFixture } from "./native-routing-fixture.ts";
import {
  DSMM_STATUS_VERSION,
  createDsmmStatusSnapshot,
  formatDsmmStatus
} from "../lib/status.js";
import type { DsmmStatusSnapshot } from "../lib/status.js";
import { DEFAULT_DSMM_SETTINGS, resolveConfig } from "../lib/settings.js";

interface AgentOptions {
  events?: DshSessionEvent[];
  headerPreset?: string;
  origin?: "subagent";
  requestHeader?: NonNullable<DshAgent["session"]["requestHeader"]>;
  provider?: string;
  model?: string;
}

interface AgentHarness {
  agent: DshAgent;
  readonly appended: () => number;
}

function createAgent(options: AgentOptions = {}): AgentHarness {
  let appendCount = 0;
  const requestHeader = options.requestHeader;
  const events = [...(options.events ?? [])];

  return {
    agent: {
      session: {
        events,
        ...(options.headerPreset === undefined && options.origin === undefined ? {} : { header: {
          ...(options.headerPreset === undefined ? {} : { agentPreset: options.headerPreset }),
          ...(options.origin === undefined ? {} : { origin: options.origin })
        } }),
        ...(requestHeader === undefined ? {} : { requestHeader }),
        append() {
          appendCount += 1;
        }
      },
      ...(options.provider === undefined && options.model === undefined
        ? {}
        : { options: { provider: options.provider, model: options.model } })
    },
    appended: () => appendCount
  };
}

function officialRoute(reasoningEffort?: string): AgentOptions {
  return {
    requestHeader: () => ({
      config: {
        provider: "deepseek-official",
        model: "deepseek-v4-pro",
        ...(reasoningEffort === undefined ? {} : { reasoningEffort })
      }
    })
  };
}

function createFormatterFixture(): DsmmStatusSnapshot {
  const settings = resolveConfig({
    runtimeRecovery: {
      enabled: true,
      fallbackRoutes: [
        { provider: "fallback-one", model: "model-one" },
        { provider: "fallback-two", model: "model-two" }
      ],
      maxFallbackAttempts: 2,
      idleContinuation: {
        enabled: false,
        maxContinuations: 3,
        prompt: "DISTINCTIVE_IDLE_PROMPT agent-preset/selected stack=provider-error failure-body credential=secret-token"
      }
    }
  });

  return {
    version: DSMM_STATUS_VERSION,
    mode: {
      name: "deepwork",
      active: false,
      selectedPreset: "dsmm-reviewer",
      dsmmPreset: true,
      inScope: true
    },
    route: {
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
      family: "deepseek",
      currentReasoningEffort: "high"
    },
    rolePolicy: { role: "dsmm-reviewer", applies: false, fallbackRoutes: settings.runtimeRecovery.fallbackRoutes.map((route) => ({ ...route })), fallbackSource: "global", strategy: "startup-lock", rateLimit: { ...settings.runtimePolicy.rateLimit } },
    runtimeRecovery: {
      enabled: true,
      applies: true,
      fallbackRouteCount: 2,
      maxFallbackAttempts: 2,
      idleContinuation: {
        enabled: false,
        maxContinuations: 3
      }
    },
    effectiveSettings: { ...settings, runtimeRecovery: { ...settings.runtimeRecovery, idleContinuation: { ...settings.runtimeRecovery.idleContinuation, prompt: "<configured>" } } }
  };
}

test("ordinary-root status reports native-owned model selection instead of dormant profile routing", () => {
  const settings = resolveConfig({ roleRouting: { "dsmm-reviewer": {
    primary: { provider: "configured", model: "profile-primary", reasoningEffort: "max" },
    fallbackRoutes: [{ provider: "configured", model: "profile-backup" }], strategy: "rate-limit-fallback"
  } }, runtimeRecovery: { enabled: true, fallbackRoutes: [{ provider: "configured", model: "global-backup" }] } });
  const { agent, appended } = createAgent({ headerPreset: "dsmm-reviewer", ...officialRoute("low") });
  const snapshot = createDsmmStatusSnapshot({ agent, settings, modeActive: true });
  assert.equal(snapshot.rolePolicy.strategy, "startup-lock"); assert.equal(snapshot.rolePolicy.primary, undefined);
  assert.deepEqual(snapshot.rolePolicy.fallbackRoutes, []); assert.equal(snapshot.rolePolicy.fallbackSource, "disabled");
  assert.equal(snapshot.runtimeRecovery.fallbackRouteCount, 0);
  assert.equal(snapshot.route.currentReasoningEffort, "low");
  assert.deepEqual(snapshot.effectiveSettings, { ...settings, runtimeRecovery: { ...settings.runtimeRecovery, idleContinuation: { ...settings.runtimeRecovery.idleContinuation, prompt: "<configured>" } }, lsp: { ...settings.lsp, command: "<configured>", args: ["<configured>"] } }, "routing policy remains inspectable while arbitrary LSP command and prompt contents remain private");
  assert.equal(appended(), 0);
});

test("status formatter renders the exact bounded Deepwork summary with DW role labels", () => {
  const formatted = formatDsmmStatus(createFormatterFixture());

  assert.equal(formatted, [
    "Deepwork status",
    "Mode: inactive (deepwork)",
    "Scope: DW Reviewer preset",
    "Workflow policy: risk-based",
    "Route: deepseek-official/deepseek-v4-pro [deepseek]",
    "Role policy: DW Reviewer; strategy=startup-lock; primary=inherit; fallbacks=global; retries=3; threshold=3; switches=2",
    "Reasoning: current=high",
    "Runtime recovery: enabled; applies=yes; fallbacks=2; max attempts=2",
    "Idle continuation: disabled; max=3",
    "Effective settings: use /dsmm-status json for the normalized snapshot"
  ].join("\n"));
  assert.equal(formatted.split("\n").length, 10);
  assert.equal(formatted.endsWith("\n"), false);
  for (const excluded of [
    "DISTINCTIVE_IDLE_PROMPT",
    "agent-preset/selected",
    "stack=provider-error",
    "failure-body",
    "credential=secret-token",
    "effectiveSettings",
    "{\""
  ]) {
    assert.equal(formatted.includes(excluded), false, excluded);
  }
});

test("status formatter uses unavailable and not-applicable labels for ordinary inactive sessions", () => {
  const fixture = createFormatterFixture();
  const formatted = formatDsmmStatus({
    ...fixture,
    mode: {
      name: "deepwork",
      active: false,
      dsmmPreset: false,
      inScope: false
    },
    route: {
      family: "unknown"
    },
    runtimeRecovery: {
      enabled: false,
      applies: false,
      fallbackRouteCount: 0,
      maxFallbackAttempts: 0,
      idleContinuation: {
        enabled: false,
        maxContinuations: 3
      }
    },
    rolePolicy: { applies: false, fallbackRoutes: [], fallbackSource: "disabled", strategy: "startup-lock", rateLimit: { ...fixture.effectiveSettings.runtimePolicy.rateLimit } }
  });

  assert.equal(formatted, [
    "Deepwork status",
    "Mode: inactive (deepwork)",
    "Scope: out of scope",
    "Workflow policy: risk-based",
    "Route: unavailable/unavailable [unknown]",
    "Role policy: none; strategy=startup-lock; primary=inherit; fallbacks=disabled; retries=3; threshold=3; switches=2",
    "Reasoning: current=provider default",
    "Runtime recovery: disabled; applies=no; fallbacks=0; max attempts=0",
    "Idle continuation: disabled; max=3",
    "Effective settings: use /dsmm-status json for the normalized snapshot"
  ].join("\n"));
});

test("status formatter identifies active generic deepwork from snapshot scope", () => {
  const fixture = createFormatterFixture();
  const formatted = formatDsmmStatus({
    ...fixture,
    mode: {
      name: "deepwork",
      active: true,
      dsmmPreset: false,
      inScope: true
    },
    route: {
      provider: "openai",
      model: "gpt-5.6",
      family: "gpt"
    },
    rolePolicy: { role: "dsmm-orchestrator", applies: false, fallbackRoutes: fixture.rolePolicy.fallbackRoutes, fallbackSource: "global", strategy: "startup-lock", rateLimit: { ...fixture.effectiveSettings.runtimePolicy.rateLimit } }
  });

  assert.equal(formatted, [
    "Deepwork status",
    "Mode: active (deepwork)",
    "Scope: active deepwork",
    "Workflow policy: risk-based",
    "Route: openai/gpt-5.6 [gpt]",
    "Role policy: DW Orchestrator; strategy=startup-lock; primary=inherit; fallbacks=global; retries=3; threshold=3; switches=2",
    "Reasoning: current=provider default",
    "Runtime recovery: enabled; applies=yes; fallbacks=2; max attempts=2",
    "Idle continuation: disabled; max=3",
    "Effective settings: use /dsmm-status json for the normalized snapshot"
  ].join("\n"));
});

test("status snapshot reports an inactive ordinary session without a route", () => {
  const { agent, appended } = createAgent();
  const settings = resolveConfig({
    runtimeRecovery: {
      enabled: true,
      fallbackRoutes: [{ provider: "fallback-one", model: "model-one" }],
      maxFallbackAttempts: 4,
      idleContinuation: { enabled: true, maxContinuations: 2 }
    }
  });

  const snapshot = createDsmmStatusSnapshot({ agent, settings, modeActive: false });

  assert.deepEqual(snapshot, {
    version: DSMM_STATUS_VERSION,
    mode: {
      name: "deepwork",
      active: false,
      dsmmPreset: false,
      inScope: false
    },
    route: {
      family: "unknown"
    },
    rolePolicy: { applies: false, fallbackRoutes: [], fallbackSource: "disabled", strategy: "startup-lock", rateLimit: { ...settings.runtimePolicy.rateLimit } },
    runtimeRecovery: {
      enabled: true,
      applies: false,
      fallbackRouteCount: 0,
      maxFallbackAttempts: 4,
      idleContinuation: {
        enabled: true,
        maxContinuations: 2
      }
    },
    effectiveSettings: { ...settings, runtimeRecovery: { ...settings.runtimeRecovery, idleContinuation: { ...settings.runtimeRecovery.idleContinuation, prompt: "<configured>" } }, lsp: { ...settings.lsp, command: "<configured>", args: ["<configured>"] } }
  });
  assert.equal(appended(), 0);
});

test("status snapshot reports active generic deepwork with the observed model family", () => {
  const { agent } = createAgent({ provider: "openai", model: "gpt-5.6" });
  const snapshot = createDsmmStatusSnapshot({ agent, settings: DEFAULT_DSMM_SETTINGS, modeActive: true });

  assert.deepEqual(snapshot.mode, {
    name: "deepwork",
    active: true,
    dsmmPreset: false,
    inScope: true
  });
  assert.deepEqual(snapshot.route, {
    provider: "openai",
    model: "gpt-5.6",
    family: "gpt"
  });
});

test("newest valid DSMM preset creates preset-only scope", () => {
  const { agent } = createAgent({
    events: [
      { type: "agent-preset/selected", data: { agentPreset: "standard" } },
      { type: "agent-preset/selected", data: { agentPreset: "dsmm-reviewer" } },
      { type: "agent-preset/selected", data: { agentPreset: 3 } }
    ],
    ...officialRoute()
  });

  const snapshot = createDsmmStatusSnapshot({ agent, settings: DEFAULT_DSMM_SETTINGS, modeActive: false });

  assert.deepEqual(snapshot.mode, {
    name: "deepwork",
    active: false,
    selectedPreset: "dsmm-reviewer",
    dsmmPreset: true,
    inScope: true
  });
  assert.equal(snapshot.rolePolicy.role, "dsmm-reviewer");
});

test("request headers take complete precedence over stale agent options", () => {
  const selectedHeader = createAgent({
    provider: "openai",
    model: "gpt-5.6",
    ...officialRoute("high")
  });
  const selectedSnapshot = createDsmmStatusSnapshot({
    agent: selectedHeader.agent,
    settings: DEFAULT_DSMM_SETTINGS,
    modeActive: true
  });

  assert.deepEqual(selectedSnapshot.route, {
    provider: "deepseek-official",
    model: "deepseek-v4-pro",
    family: "deepseek",
    currentReasoningEffort: "high"
  });

  const malformedHeader = createAgent({
    provider: "deepseek-official",
    model: "deepseek-v4-pro",
    requestHeader: () => JSON.parse('{"config":{"provider":42,"model":null,"reasoningEffort":false}}')
  });
  const malformedSnapshot = createDsmmStatusSnapshot({
    agent: malformedHeader.agent,
    settings: DEFAULT_DSMM_SETTINGS,
    modeActive: true
  });

  assert.deepEqual(malformedSnapshot.route, {
    family: "unknown"
  });
});

test("runtime recovery summary reports configuration separately from applicability", () => {
  const settings = resolveConfig({
    runtimeRecovery: {
      enabled: true,
      fallbackRoutes: [
        { provider: "first", model: "first-model" },
        { provider: "second", model: "second-model" }
      ],
      maxFallbackAttempts: 7,
      idleContinuation: { enabled: true, maxContinuations: 5 }
    }
  });
  const inactive = createDsmmStatusSnapshot({
    agent: createAgent().agent,
    settings,
    modeActive: false
  });
  const active = createDsmmStatusSnapshot({
    agent: createAgent().agent,
    settings,
    modeActive: true
  });

  assert.deepEqual(inactive.runtimeRecovery, {
    enabled: true,
    applies: false,
    fallbackRouteCount: 0,
    maxFallbackAttempts: 7,
    idleContinuation: { enabled: true, maxContinuations: 5 }
  });
  assert.equal(active.runtimeRecovery.applies, true);
  assert.equal(active.effectiveSettings.runtimeRecovery.fallbackRoutes.length, 2, "declared root configuration is retained separately");
  const auxiliary = createDsmmStatusSnapshot({ agent: createAgent({ origin: "subagent" }).agent, settings, modeActive: true });
  assert.equal(auxiliary.runtimeRecovery.fallbackRouteCount, 2, "auxiliary global fallback reporting is unchanged");
});

test("effective settings are an exhaustive defensive copy with private paths and environment values redacted", () => {
  const settings = resolveConfig({
    modeName: "focused-work",
    defaultActive: true,
    promptOrder: 80,
    modelParameters: { passthrough: false },
    skills: { brainstorming: false },
    roles: { "dsmm-reviewer": false },
    presets: { materialize: true, root: "C:/presets" },
    workflow: { strictGates: false, reviewCap: 3, finalReviewPolicy: "reviewer-only" },
    guards: {
      scope: "always",
      shellCommandSafety: false,
      gitWriteGuard: "deny",
      toolOutputTruncation: { enabled: false, maxInlineBytes: 400 },
      planFormatValidation: false,
      questionLabelHelper: { enabled: false, maxLabelChars: 11 },
      todoDisciplineHelper: false
    },
    runtimeRecovery: {
      enabled: true,
      retryOnStatusCodes: [429, 503],
      retryOnCodes: ["EAGAIN"],
      fallbackRoutes: [{ provider: "backup", model: "backup-model" }],
      maxFallbackAttempts: 3,
      idleContinuation: { enabled: true, maxContinuations: 2, prompt: "Continue safely." }
    },
    lsp: {
      enabled: true,
      serverName: "custom_lsp",
      command: "C:/PRIVATE_LSP_SENTINEL/private-server.exe",
      args: ["--config=C:/PRIVATE_LSP_SENTINEL/config.json", "PRIVATE_PARAMETER_SENTINEL"],
      cwd: "C:/workspace",
      env: { CUSTOM_LSP: "1" },
      toolCallTimeoutMs: 4500,
      failOnStartupError: false
    }
  });
  const snapshot = createDsmmStatusSnapshot({
    agent: createAgent().agent,
    settings,
    modeActive: false
  });
  const copy = snapshot.effectiveSettings;

  assert.deepEqual(copy, { ...settings, presets: { ...settings.presets, root: "<configured>" },
    runtimeRecovery: { ...settings.runtimeRecovery, idleContinuation: { ...settings.runtimeRecovery.idleContinuation, prompt: "<configured>" } },
    lsp: { ...settings.lsp, command: "<configured>", args: ["<configured>", "<configured>"], cwd: "<configured>", env: { "variable-1": "<redacted>" } } });
  for (const output of [JSON.stringify(snapshot), formatDsmmStatus(snapshot)]) {
    assert.doesNotMatch(output, /PRIVATE_LSP_SENTINEL|PRIVATE_PARAMETER_SENTINEL/u);
  }
  assert.equal(settings.lsp.command, "C:/PRIVATE_LSP_SENTINEL/private-server.exe", "runtime settings are not redacted in place");
  assert.deepEqual(settings.lsp.args, ["--config=C:/PRIVATE_LSP_SENTINEL/config.json", "PRIVATE_PARAMETER_SENTINEL"]);
  assert.notEqual(copy, settings);
  assert.notEqual(copy.modelParameters, settings.modelParameters);
  assert.notEqual(copy.skills, settings.skills);
  assert.notEqual(copy.roles, settings.roles);
  assert.notEqual(copy.presets, settings.presets);
  assert.notEqual(copy.workflow, settings.workflow);
  assert.notEqual(copy.guards, settings.guards);
  assert.notEqual(copy.guards.toolOutputTruncation, settings.guards.toolOutputTruncation);
  assert.notEqual(copy.guards.questionLabelHelper, settings.guards.questionLabelHelper);
  assert.notEqual(copy.runtimeRecovery, settings.runtimeRecovery);
  assert.notEqual(copy.runtimeRecovery.retryOnStatusCodes, settings.runtimeRecovery.retryOnStatusCodes);
  assert.notEqual(copy.runtimeRecovery.retryOnCodes, settings.runtimeRecovery.retryOnCodes);
  assert.notEqual(copy.runtimeRecovery.fallbackRoutes, settings.runtimeRecovery.fallbackRoutes);
  assert.notEqual(copy.runtimeRecovery.fallbackRoutes[0], settings.runtimeRecovery.fallbackRoutes[0]);
  assert.notEqual(copy.runtimeRecovery.idleContinuation, settings.runtimeRecovery.idleContinuation);
  assert.notEqual(copy.lsp, settings.lsp);
  assert.notEqual(copy.lsp.args, settings.lsp.args);
  assert.notEqual(copy.lsp.env, settings.lsp.env);

  settings.skills.brainstorming = true;
  settings.modelParameters.passthrough = true;
  settings.roles["dsmm-reviewer"] = true;
  settings.presets.root = "C:/changed";
  settings.workflow.reviewCap = 9;
  settings.guards.toolOutputTruncation.maxInlineBytes = 900;
  settings.guards.questionLabelHelper.maxLabelChars = 20;
  settings.runtimeRecovery.retryOnStatusCodes.push(504);
  settings.runtimeRecovery.retryOnCodes.push("ECONNRESET");
  settings.runtimeRecovery.fallbackRoutes[0].provider = "changed";
  settings.runtimeRecovery.idleContinuation.prompt = "Changed prompt.";
  settings.lsp.args.push("--changed");
  settings.lsp.env.CHANGED = "true";

  assert.equal(copy.skills.brainstorming, false);
  assert.equal(copy.modelParameters.passthrough, false);
  assert.equal(copy.roles["dsmm-reviewer"], false);
  assert.equal(copy.presets.root, "<configured>");
  assert.equal(copy.workflow.reviewCap, 3);
  assert.equal(copy.guards.toolOutputTruncation.maxInlineBytes, 400);
  assert.equal(copy.guards.questionLabelHelper.maxLabelChars, 11);
  assert.deepEqual(copy.runtimeRecovery.retryOnStatusCodes, [429, 503]);
  assert.deepEqual(copy.runtimeRecovery.retryOnCodes, ["eagain"]);
  assert.equal(copy.runtimeRecovery.fallbackRoutes[0].provider, "backup");
  assert.equal(copy.runtimeRecovery.idleContinuation.prompt, "<configured>");
  assert.deepEqual(copy.lsp.args, ["<configured>", "<configured>"]);
  assert.deepEqual(copy.lsp.env, { "variable-1": "<redacted>" });

  copy.runtimeRecovery.fallbackRoutes[0].model = "snapshot-model";
  Object.assign(copy.lsp.env, { SNAPSHOT_ONLY: "yes" });
  assert.equal(settings.runtimeRecovery.fallbackRoutes[0].model, "backup-model");
  assert.equal(Object.hasOwn(settings.lsp.env, "SNAPSHOT_ONLY"), false);
});

test("status copies independent role strategy, nested retry overrides and scoped admission provenance", async () => {
  const settings = resolveConfig({
    runtimePolicy: { strategy: "rate-limit-fallback", rateLimit: { maxRetries: 6 } },
    roleRouting: { "dsmm-reviewer": { strategy: "startup-lock", rateLimit: { maxRetries: 1, maxSwitches: 0 },
      primary: { provider: "fixture", model: "m", reasoningEffort: "high" }, fallbackRoutes: [] } }
  });
  const admission = { settings, profile: { id: "focus", revision: "a".repeat(64) }, epoch: "b".repeat(64), scope: "session-override" as const };
  const runtimeState = { role: "dsmm-reviewer" as const, strategy: "startup-lock" as const,
    rateLimit: { ...settings.runtimePolicy.rateLimit, maxRetries: 1, maxSwitches: 0 },
    route: { provider: "fixture", model: "m", reasoningEffort: "high" }, retries: 1, rateLimitFailures: 2, switches: 0, totalDelayMs: 500 };
  const fixture = await nativeRoutingFixture({ runtimePolicy: settings.runtimePolicy, roleRouting: settings.roleRouting });
  try {
    const agent = await fixture.createAuxiliary("dsmm-reviewer");
    const statusAgent: Omit<DshAgent, "ctx"> = agent;
    const snapshot = createDsmmStatusSnapshot({ agent: statusAgent, settings, modeActive: false, admission, roleRuntimeState: runtimeState });
    assert.equal(snapshot.rolePolicy.strategy, "startup-lock");
    assert.equal(snapshot.rolePolicy.rateLimit.maxRetries, 1);
    assert.equal(snapshot.rolePolicy.rateLimit.maxSwitches, 0);
    assert.deepEqual(snapshot.rolePolicy.fallbackRoutes, []);
    assert.equal(snapshot.rolePolicy.fallbackSource, "role");
    assert.deepEqual(snapshot.admission, { profile: admission.profile, epoch: admission.epoch, scope: admission.scope });
    assert.notEqual(snapshot.admission!.profile, admission.profile);
    assert.notEqual(snapshot.effectiveSettings.runtimePolicy, settings.runtimePolicy);
    assert.notEqual(snapshot.effectiveSettings.runtimePolicy.rateLimit, settings.runtimePolicy.rateLimit);
    assert.notEqual(snapshot.effectiveSettings.roleRouting["dsmm-reviewer"]!.rateLimit, settings.roleRouting["dsmm-reviewer"]!.rateLimit);
    assert.notEqual(snapshot.rolePolicy.runtimeState, runtimeState);
    assert.notEqual(snapshot.rolePolicy.runtimeState!.rateLimit, runtimeState.rateLimit);
    assert.notEqual(snapshot.rolePolicy.runtimeState!.route, runtimeState.route);
    admission.profile.id = "changed";
    settings.runtimePolicy.rateLimit.maxRetries = 0;
    settings.roleRouting["dsmm-reviewer"]!.rateLimit!.maxRetries = 9;
    runtimeState.rateLimit.maxRetries = 9;
    runtimeState.route.model = "changed";
    assert.equal(snapshot.admission!.profile!.id, "focus");
    assert.equal(snapshot.effectiveSettings.runtimePolicy.rateLimit.maxRetries, 6);
    assert.equal(snapshot.effectiveSettings.roleRouting["dsmm-reviewer"]!.rateLimit!.maxRetries, 1);
    assert.equal(snapshot.rolePolicy.runtimeState!.rateLimit.maxRetries, 1);
    assert.equal(snapshot.rolePolicy.runtimeState!.route!.model, "m");
    assert.match(formatDsmmStatus(snapshot), /Profile admission: session-override; profile=focus/u);
    assert.match(formatDsmmStatus(snapshot), /Retry state: retries=1; rate limits=2; switches=0; delay ms=500/u);
  } finally { await fixture.dispose(); }
});
