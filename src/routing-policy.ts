/** Browser-safe route policy grammar shared by settings, profiles and native UI. */
import type { DsmmRoleId } from "./roles.js";
import type { DsmmModelRoute, DsmmResolvedRoleRuntimePolicy, DsmmSettings } from "./settings.js";
import { canonicalModelRouteJson } from "./route-json.js";
export type DsmmRoutingStrategy = "startup-lock" | "rate-limit-fallback";

export interface DsmmRateLimitPolicy {
  /** Same-route requests after the first attempt. */
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  maxTotalDelayMs: number;
  /** Distinct failed native attempts, including the first attempt. */
  switchAfterRateLimits: number;
  maxSwitches: number;
}

export interface DsmmRuntimePolicyConfig {
  strategy?: DsmmRoutingStrategy;
  rateLimit?: Partial<DsmmRateLimitPolicy>;
}

export interface DsmmRuntimePolicySettings {
  strategy: DsmmRoutingStrategy;
  rateLimit: DsmmRateLimitPolicy;
}

export const DEFAULT_DSMM_RATE_LIMIT_POLICY: Readonly<DsmmRateLimitPolicy> = Object.freeze({
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  maxTotalDelayMs: 30000,
  switchAfterRateLimits: 3,
  maxSwitches: 2
});

export const DEFAULT_DSMM_RUNTIME_POLICY: Readonly<DsmmRuntimePolicySettings> = Object.freeze({
  strategy: "startup-lock",
  rateLimit: DEFAULT_DSMM_RATE_LIMIT_POLICY
});

export const DSMM_RATE_LIMIT_BOUNDS: Readonly<Record<keyof DsmmRateLimitPolicy, readonly [number, number]>> = Object.freeze({
  maxRetries: Object.freeze([0, 10] as const),
  initialDelayMs: Object.freeze([0, 30000] as const),
  maxDelayMs: Object.freeze([0, 30000] as const),
  maxTotalDelayMs: Object.freeze([0, 120000] as const),
  switchAfterRateLimits: Object.freeze([1, 10] as const),
  maxSwitches: Object.freeze([0, 10] as const)
});

export function normalizeRoutingStrategy(value: unknown): DsmmRoutingStrategy {
  if (value !== "startup-lock" && value !== "rate-limit-fallback") {
    throw new TypeError("dsmm strategy must be startup-lock or rate-limit-fallback");
  }
  return value;
}

export function normalizeRateLimitOverrides(value: unknown): Partial<DsmmRateLimitPolicy> {
  if (!isRecord(value)) throw new TypeError("dsmm rateLimit must be an object");
  const result: Partial<DsmmRateLimitPolicy> = {};
  for (const [field, raw] of Object.entries(value)) {
    if (!Object.hasOwn(DSMM_RATE_LIMIT_BOUNDS, field)) throw new TypeError("dsmm rateLimit contains an unknown field");
    const [minimum, maximum] = DSMM_RATE_LIMIT_BOUNDS[field as keyof DsmmRateLimitPolicy];
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < minimum || raw > maximum) {
      throw new TypeError(`dsmm rateLimit ${field} must be an integer from ${minimum} to ${maximum}`);
    }
    result[field as keyof DsmmRateLimitPolicy] = raw;
  }
  return result;
}

export function normalizeRateLimitPolicy(value: unknown = undefined, defaults: Readonly<DsmmRateLimitPolicy> = DEFAULT_DSMM_RATE_LIMIT_POLICY): DsmmRateLimitPolicy {
  return { ...defaults, ...(value === undefined ? {} : normalizeRateLimitOverrides(value)) };
}

export function normalizeRuntimePolicy(value: unknown = undefined): DsmmRuntimePolicySettings {
  if (value === undefined) return { strategy: "startup-lock", rateLimit: { ...DEFAULT_DSMM_RATE_LIMIT_POLICY } };
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "strategy" && key !== "rateLimit")) {
    throw new TypeError("dsmm runtimePolicy must contain only strategy and rateLimit");
  }
  return {
    strategy: Object.hasOwn(value, "strategy") ? normalizeRoutingStrategy(value.strategy) : "startup-lock",
    rateLimit: normalizeRateLimitPolicy(Object.hasOwn(value, "rateLimit") ? normalizeRateLimitOverrides(value.rateLimit) : undefined)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const resolvedRoleRuntimePolicies = new WeakMap<DsmmSettings, Map<DsmmRoleId | undefined, DsmmResolvedRoleRuntimePolicy>>();

/** Install a preflighted invocation only on this child's immutable settings identity. */
export function captureRoleRuntimePolicy(settings: DsmmSettings, role: DsmmRoleId, policy: DsmmResolvedRoleRuntimePolicy): void {
  let policies = resolvedRoleRuntimePolicies.get(settings);
  if (policies === undefined) { policies = new Map(); resolvedRoleRuntimePolicies.set(settings, policies); }
  policies.set(role, policy);
}

/** Resolve once per immutable settings admission; omission and explicit [] remain distinct. */
export function resolveRoleRuntimePolicy(settings: DsmmSettings, role?: DsmmRoleId): DsmmResolvedRoleRuntimePolicy {
  let policies = resolvedRoleRuntimePolicies.get(settings);
  if (policies === undefined) {
    policies = new Map();
    resolvedRoleRuntimePolicies.set(settings, policies);
  }
  const existing = policies.get(role);
  if (existing !== undefined) return existing;
  const configured = role === undefined ? undefined : settings.roleRouting[role];
  const defaults = settings.runtimePolicy;
  const primary = configured?.primary === undefined ? undefined : Object.freeze({ ...configured.primary });
  const seen = new Set<string>(primary === undefined ? [] : [canonicalModelRouteJson(primary)]);
  const fallbacks: Readonly<DsmmModelRoute>[] = [];
  for (const route of configured?.fallbackRoutes ?? settings.runtimeRecovery.fallbackRoutes) {
    const identity = canonicalModelRouteJson(route);
    if (seen.has(identity)) continue;
    seen.add(identity);
    fallbacks.push(Object.freeze({ ...route }));
  }
  const policy: DsmmResolvedRoleRuntimePolicy = Object.freeze({
    strategy: configured?.strategy ?? defaults.strategy,
    rateLimit: Object.freeze(normalizeRateLimitPolicy(configured?.rateLimit, defaults.rateLimit)),
    ...(primary === undefined ? {} : { primary }),
    fallbackRoutes: Object.freeze(fallbacks),
    fallbackSource: configured?.fallbackRoutes === undefined ? "global" : "role"
  });
  policies.set(role, policy);
  return policy;
}
