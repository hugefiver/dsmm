import assert from "node:assert/strict";
import { test } from "node:test";
import { DsmmProfileError, MAX_PROFILE_BYTES, mergeProfileConfig, parseProfileDocument, profileErrorInfo, resolveProfileSettings, validateProfileDocument, validateProfileId } from "../lib/profiles.js";
import type { DsmmPluginConfig } from "../lib/settings.js";
import { resolveRoleRuntimePolicy } from "../lib/settings.js";
import { DSMM_RATE_LIMIT_BOUNDS } from "../lib/routing-policy.js";

function content(settings: unknown = {}, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, id: "focus", settings, ...extra });
}

function validation(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => error instanceof DsmmProfileError && error.code === "validation");
}

test("versioned JSONC profiles preserve strict settings and allow comments, BOM and trailing commas", () => {
  const raw = '\uFEFF{ // Keep this note\n "version": 1, "id": "focus", "label": "Focused review", "settings": { "defaultActive": false, }, }';
  const document = parseProfileDocument(raw, "focus");
  assert.deepEqual(document, { version: 1, id: "focus", label: "Focused review", settings: { defaultActive: false } });
  assert.ok(raw.includes("// Keep this note"));
});

test("JSONC input must round-trip through UTF-8, while paired Unicode and JSON escapes remain lossless", () => {
  for (const surrogate of ["\uD800", "\uDC00"]) {
    validation(() => parseProfileDocument(content().replace("focus", `fo${surrogate}cus`)));
    validation(() => parseProfileDocument(`${content()} // ${surrogate}`));
    validation(() => parseProfileDocument(content({}, { label: "fixture" }).replace("fixture", surrogate)));
  }
  const unicode = content({}, { label: "中文 😀" });
  assert.equal(parseProfileDocument(unicode).label, "中文 😀");
  const escaped = content({}, { label: "\uD800" });
  assert.ok(escaped.includes("\\ud800"), "a JSON escape is UTF-8 representable without changing the file bytes");
  validation(() => parseProfileDocument(escaped));
});

test("profile schema rejects unknown, restart-scoped, executable and credential-bearing families", () => {
  for (const key of ["skills", "modeName", "promptOrder", "section", "presets", "lsp", "sessionPersistence", "provider", "apiKey", "credentials", "env", "headers", "import", "profiles", "activeProfile"]) {
    validation(() => parseProfileDocument(content({ [key]: {} })));
  }
  validation(() => parseProfileDocument(content({}, { other: "secret-value-not-echoed" })));
  const info = (() => { try { parseProfileDocument(content({ credentials: "secret-value-not-echoed" })); } catch (error) { return profileErrorInfo(error); } })();
  assert.ok(info);
  assert.equal(JSON.stringify(info).includes("secret-value-not-echoed"), false);
  assert.match(info.message, /native deployment/u);
});

test("profile parser rejects duplicate/unsafe keys, wrong versions, IDs, labels and malformed JSON", () => {
  validation(() => parseProfileDocument('{"version":1,"id":"focus","settings":{"defaultActive":true,"defaultActive":false}}'));
  validation(() => parseProfileDocument('{"version":1,"id":"focus","settings":{"__proto__":{}}}'));
  validation(() => parseProfileDocument(content({}, { version: 2 })));
  assert.equal(validateProfileDocument(content({}, { label: "" })).diagnostics[0]?.code, "blank-label");
  validation(() => parseProfileDocument(content({}, { settings: null })));
  validation(() => parseProfileDocument(content(), "another"));
  validation(() => parseProfileDocument("{broken"));
  validation(() => parseProfileDocument(""));
  for (const id of ["", "Focus", "../focus", "/focus", "focus.jsonc", "focus\\next", "con", "nul", "lpt1", "com9", "中文", "a".repeat(65)]) validation(() => validateProfileId(id));
  for (const id of ["focus", "0", "review_2", "deep-work", "a".repeat(64)]) validateProfileId(id);
});

test("profiles validate every supported nested enum, type, finite bound, role and route", () => {
  const cases = [
    { defaultActive: "false" },
    { workflow: { strictGates: null } },
    { workflow: { policy: "other" } },
    { workflow: { finalReviewPolicy: "oracle-only" } },
    { workflow: { reviewCap: -1 } },
    { workflow: { reviewCap: 11 } },
    { workflow: { reviewCap: 1.1 } },
    { guards: { unknown: true } },
    { guards: { scope: "all" } },
    { guards: { gitWriteGuard: "allow" } },
    { guards: { toolOutputTruncation: { enabled: 1 } } },
    { guards: { toolOutputTruncation: { maxInlineBytes: 0 } } },
    { guards: { questionLabelHelper: { maxLabelChars: 257 } } },
    { runtimeRecovery: { maxFallbackAttempts: 11 } },
    { runtimeRecovery: { retryOnStatusCodes: [99] } },
    { runtimeRecovery: { retryOnStatusCodes: [600] } },
    { runtimeRecovery: { retryOnCodes: [""] } },
    { runtimeRecovery: { fallbackRoutes: [{ provider: "fixture" }] } },
    { runtimeRecovery: { fallbackRoutes: [{ provider: "https://credential@host", model: "m" }] } },
    { runtimeRecovery: { idleContinuation: { maxContinuations: -1 } } },
    { runtimeRecovery: { idleContinuation: { prompt: "" } } },
    { runtimeRecovery: { idleContinuation: { secret: "bad" } } },
    { roleRouting: { other: {} } },
    { roleRouting: { "dsmm-reviewer": null } },
    { roleRouting: { "dsmm-reviewer": { primary: null } } },
    { roleRouting: { "dsmm-reviewer": { fallbackRoutes: null } } },
    { roleRouting: { "dsmm-reviewer": { primary: { provider: "p", model: "m", apiKey: "bad" } } } },
    { roleRouting: { "dsmm-reviewer": { primary: { provider: "p", model: "m", reasoningEffort: "" } } } },
    { deepseekV4ProCalibration: "other" },
    { deepseekFlashDefaultReasoningEffort: "max" },
    { deepseekV4ProMaxReasoningPresets: ["other"] },
    { deepseekFlashMaxReasoningPresets: ["dsmm-reviewer", "dsmm-reviewer"] }
  ];
  for (const settings of cases) validation(() => parseProfileDocument(content(settings)));
  validation(() => parseProfileDocument('{"version":1,"id":"focus","settings":{"workflow":{"reviewCap":1e400}}}'));
  assert.throws(() => parseProfileDocument(`${content()}${" ".repeat(MAX_PROFILE_BYTES)}`), (error: unknown) => error instanceof DsmmProfileError && error.code === "limit");
});

test("all allowed runtime families round-trip through the existing resolver", () => {
  const document = parseProfileDocument(content({
    defaultActive: true,
    roleRouting: { "dsmm-reviewer": { primary: { provider: "fixture", model: "review", reasoningEffort: "max" }, fallbackRoutes: [] } },
    workflow: { policy: "risk-based", strictGates: false, reviewCap: 0, finalReviewPolicy: "off" },
    guards: { scope: "always", shellCommandSafety: false, gitWriteGuard: "deny", toolOutputTruncation: { enabled: false, maxInlineBytes: 512 }, questionLabelHelper: { enabled: false, maxLabelChars: 20 }, planFormatValidation: false, todoDisciplineHelper: false },
    runtimeRecovery: { enabled: true, retryOnStatusCodes: [], retryOnCodes: [], fallbackRoutes: [{ provider: "fixture", model: "recover", reasoningEffort: "xhigh" }], maxFallbackAttempts: 0, idleContinuation: { enabled: false, maxContinuations: 0, prompt: "Continue\ncarefully." } }
  }));
  const settings = resolveProfileSettings({}, document.settings);
  assert.equal(settings.defaultActive, true);
  assert.equal(settings.guards.toolOutputTruncation.enabled, false);
  assert.equal(settings.runtimeRecovery.maxFallbackAttempts, 0);
  assert.equal(settings.runtimeRecovery.fallbackRoutes[0]?.reasoningEffort, "xhigh");
  assert.equal(settings.roleRouting["dsmm-reviewer"]?.primary?.reasoningEffort, "max");
});

test("overlay merge preserves false, explicit empty arrays, nested baseline and absent fallback inheritance", () => {
  const baseline: DsmmPluginConfig = {
    defaultActive: true, modeName: "deployment-mode", roles: { "dsmm-builder": false },
    lsp: { enabled: true, env: { FIXTURE_ONLY: "retained" } },
    roleRouting: {
      "dsmm-reviewer": { primary: { provider: "old", model: "old", reasoningEffort: "high" }, fallbackRoutes: [{ provider: "old", model: "backup" }] },
      "dsmm-oracle": { primary: { provider: "old", model: "oracle" } }
    },
    guards: { toolOutputTruncation: { enabled: true, maxInlineBytes: 12000 }, questionLabelHelper: { enabled: true } },
    runtimeRecovery: { fallbackRoutes: [{ provider: "global", model: "backup" }], idleContinuation: { enabled: true, maxContinuations: 2 } }
  };
  const original = structuredClone(baseline);
  const overlay = parseProfileDocument(content({ defaultActive: false, guards: { toolOutputTruncation: { enabled: false } }, roleRouting: { "dsmm-reviewer": { primary: { provider: "new", model: "new" } }, "dsmm-oracle": { fallbackRoutes: [] } }, runtimeRecovery: { idleContinuation: { enabled: false } } })).settings;
  const merged = mergeProfileConfig(baseline, overlay);
  assert.deepEqual(baseline, original, "merge must not mutate the deployment baseline");
  assert.equal(merged.defaultActive, false);
  assert.equal(merged.roles?.["dsmm-builder"], false);
  assert.equal(merged.modeName, "deployment-mode");
  assert.deepEqual(merged.lsp, baseline.lsp);
  assert.deepEqual(merged.roleRouting?.["dsmm-reviewer"]?.primary, { provider: "new", model: "new" }, "complete primary replacement must clear the previous effort");
  assert.deepEqual(merged.roleRouting?.["dsmm-reviewer"]?.fallbackRoutes, [{ provider: "old", model: "backup" }]);
  assert.deepEqual(merged.roleRouting?.["dsmm-oracle"]?.fallbackRoutes, []);
  assert.equal(Object.hasOwn(merged.roleRouting?.["dsmm-oracle"] ?? {}, "fallbackRoutes"), true);
  const absent = mergeProfileConfig({}, parseProfileDocument(content({ roleRouting: { "dsmm-reviewer": { primary: { provider: "p", model: "m" } } } })).settings);
  assert.equal(Object.hasOwn(absent.roleRouting?.["dsmm-reviewer"] ?? {}, "fallbackRoutes"), false);
  assert.deepEqual(merged.guards?.toolOutputTruncation, { enabled: false, maxInlineBytes: 12000 });
  assert.deepEqual(merged.runtimeRecovery?.idleContinuation, { enabled: false, maxContinuations: 2 });
  merged.lsp!.env!.FIXTURE_ONLY = "changed";
  assert.equal(baseline.lsp?.env?.FIXTURE_ONLY, "retained", "result must own deep copies of unchanged baseline fields");
});

test("profile role strategy overrides are independent and never rewrite omitted JSONC fields", () => {
  const firstRaw = content({ roleRouting: {
    "dsmm-reviewer": { strategy: "startup-lock", rateLimit: { maxRetries: 1 } },
    "dsmm-planner": { strategy: "rate-limit-fallback", rateLimit: { maxRetries: 5, switchAfterRateLimits: 4 } }
  } });
  const first = parseProfileDocument(firstRaw);
  const second = parseProfileDocument(content({ roleRouting: { "dsmm-reviewer": { strategy: "rate-limit-fallback" } } }));
  const baseline: DsmmPluginConfig = { runtimeRecovery: { enabled: true, fallbackRoutes: [{ provider: "p", model: "fallback" }] } };
  const firstSettings = resolveProfileSettings(baseline, first.settings);
  const secondSettings = resolveProfileSettings(baseline, second.settings);
  assert.equal(resolveRoleRuntimePolicy(firstSettings, "dsmm-reviewer").strategy, "startup-lock");
  assert.equal(resolveRoleRuntimePolicy(firstSettings, "dsmm-planner").strategy, "rate-limit-fallback");
  assert.equal(resolveRoleRuntimePolicy(secondSettings, "dsmm-reviewer").strategy, "rate-limit-fallback");
  assert.equal(resolveRoleRuntimePolicy(firstSettings, "dsmm-planner").rateLimit.switchAfterRateLimits, 4);
  assert.equal(resolveRoleRuntimePolicy(secondSettings, "dsmm-reviewer").rateLimit.maxRetries, 3);
  assert.equal(Object.hasOwn(first.settings, "runtimePolicy"), false);
  assert.equal(JSON.stringify(first), firstRaw);
  const oldRaw = content({ roleRouting: { "dsmm-reviewer": { fallbackRoutes: [] } } });
  const old = parseProfileDocument(oldRaw);
  assert.equal(resolveRoleRuntimePolicy(resolveProfileSettings(baseline, old.settings), "dsmm-reviewer").strategy, "startup-lock");
  assert.equal(JSON.stringify(old), oldRaw);
});

test("profile policy inheritance preserves deployment defaults and explicit per-role overrides", () => {
  const baseline: DsmmPluginConfig = {
    runtimePolicy: { strategy: "rate-limit-fallback", rateLimit: { maxRetries: 7, maxSwitches: 5 } },
    roleRouting: { "dsmm-reviewer": { strategy: "startup-lock", rateLimit: { maxRetries: 2 } } }
  };
  const overlay = parseProfileDocument(content({
    runtimePolicy: { rateLimit: { maxSwitches: 1 } },
    roleRouting: { "dsmm-reviewer": { rateLimit: { switchAfterRateLimits: 2 } } }
  })).settings;
  const settings = resolveProfileSettings(baseline, overlay);
  assert.equal(resolveRoleRuntimePolicy(settings, "dsmm-planner").strategy, "rate-limit-fallback");
  const reviewer = resolveRoleRuntimePolicy(settings, "dsmm-reviewer");
  assert.equal(reviewer.strategy, "startup-lock");
  assert.equal(reviewer.rateLimit.maxRetries, 2);
  assert.equal(reviewer.rateLimit.maxSwitches, 1);
  assert.equal(reviewer.rateLimit.switchAfterRateLimits, 2);
  const limited = parseProfileDocument(content({ runtimePolicy: { rateLimit: { maxDelayMs: 100 } } }));
  assert.equal(resolveProfileSettings({ runtimePolicy: { rateLimit: { initialDelayMs: 0 } } }, limited.settings).runtimePolicy.rateLimit.maxDelayMs, 100,
    "a bounded overlay must not be rejected against standalone defaults before deployment inheritance");
});

test("profile policy grammar rejects unknown fields, invalid strategies and every invalid bound", () => {
  for (const policy of [null, [], { strategy: null }, { strategy: "always" }, { other: true }, { rateLimit: null }, { rateLimit: { unexpected: 1 } }]) {
    validation(() => parseProfileDocument(content({ runtimePolicy: policy })));
  }
  for (const policy of [{ strategy: null }, { strategy: "always" }, { rateLimit: null }, { rateLimit: { unexpected: 1 } }]) {
    validation(() => parseProfileDocument(content({ roleRouting: { "dsmm-reviewer": policy } })));
  }
  for (const [field, [minimum, maximum]] of Object.entries(DSMM_RATE_LIMIT_BOUNDS)) {
    for (const value of [minimum - 1, maximum + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null]) {
      validation(() => parseProfileDocument(content({ runtimePolicy: { rateLimit: { [field]: value } } })));
      validation(() => parseProfileDocument(content({ roleRouting: { "dsmm-reviewer": { rateLimit: { [field]: value } } } })));
    }
  }
});
