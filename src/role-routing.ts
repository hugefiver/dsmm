import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { LlmError } from "@deepseek-ai/dsh-llm";
import type { AgentRequestFrame, DshAgent, DshContext, DshLlmCallConfig, DshLlmRuntime, DshSessionEvent } from "./dsh-types.js";
import { appendRolePolicyRecord } from "./session-metadata.js";
import { isDsmmRoleId } from "./roles.js";
import type { DsmmRoleId } from "./roles.js";
import { isCurrentRecoveryStep } from "./recovery-policy.js";
import { childOwnedSessionEvents, sessionEvents } from "./session-scope.js";
import { resolveRoleRuntimePolicy } from "./routing-policy.js";
import type { DsmmModelRoute, DsmmSettings } from "./settings.js";
import type { DsmmRoleRuntimeState } from "./profile-types.js";
import { canonicalModelRouteJson, normalizeModelRouteJson, sameModelRouteJson } from "./route-json.js";
import { DsmmMissingProviderError, modelRouteFromHeader, modelRouteToCall } from "./role-llm.js";
import type { DsmmLlmRouteResolver } from "./role-llm.js";

const admittedRecoveryRoutes = new WeakMap<AgentRequestFrame, DsmmModelRoute>();
const routeLocks = new WeakMap<DshAgent, RoleRouteLock>();
const agentPolicies = new WeakMap<DshAgent, { fields: unknown; identity: string }>();
export const DSMM_ROLE_POLICY_EVENT = "dsmm/role-policy";

export interface RoleRouteLock {
  identity: string;
  route: DsmmModelRoute;
  candidates: readonly DsmmModelRoute[];
  candidateIndex: number;
  generation: number;
  attempts: number;
  startupSettled: boolean;
  retries: number;
  rateLimits: number;
  switches: number;
  totalDelayMs: number;
  manualSelectionSeq?: number;
}

export interface NativeModelSelectionIntent {
  seq: number;
  route: DsmmModelRoute;
}

/** Native user selection is authority; inherited headers/default configs are not. */
export function latestNativeModelSelection(agent: DshAgent): NativeModelSelectionIntent | undefined {
  let selected: NativeModelSelectionIntent | undefined;
  for (const event of policyEvents({ agent })) {
    if (event.type !== "model/selection" || !("seq" in event) || !Number.isSafeInteger(event.seq)
      || typeof event.seq !== "number" || event.seq < 0 || !isRecord(event.data)) continue;
    const { provider, model, reasoningEffort } = event.data;
    if (typeof provider !== "string" || provider.trim() === "" || typeof model !== "string" || model.trim() === ""
      || (reasoningEffort !== undefined && (typeof reasoningEffort !== "string" || reasoningEffort.trim() === ""))) continue;
    selected = { seq: event.seq, route: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } };
  }
  return selected;
}

export function sameExactModelRoute(left: Pick<DsmmModelRoute, "provider" | "model" | "reasoningEffort">, right: DsmmModelRoute): boolean {
  return sameModelRouteJson(left, right);
}

/** Consumed user intent stays explicit on cold resume and profile re-admission. */
export function nativeModelSelectionWasAccepted(agent: DshAgent, intent: NativeModelSelectionIntent): boolean {
  return policyEvents({ agent }).some((event) => event.type === "request/header" && "seq" in event
    && typeof event.seq === "number" && event.seq > intent.seq && isRecord(event.data)
    && isRecord(event.data.header) && isRecord(event.data.header.config)
    && sameModelRoute(event.data.header.config as unknown as DsmmModelRoute, intent.route)
    && modelRouteFromHeader(event.data.header).reasoningEffort === intent.route.reasoningEffort);
}

/** Only native, machine-routable absence authorizes initial candidate admission. */
export function isUnavailableRouteFailure(error: unknown, nativeRequestFailure = false): boolean {
  return isRecord(error) && (error.status === undefined || error.status === 503)
    && (error instanceof DsmmMissingProviderError || (error.code === "UNKNOWN_MODEL" && (nativeRequestFailure || error instanceof LlmError)));
}

export function orderedModelRoutes(candidates: readonly DsmmModelRoute[]): DsmmModelRoute[] {
  const routes: DsmmModelRoute[] = [];
  for (const route of candidates) if (!routes.some((previous) => sameExactModelRoute(previous, route))) routes.push(canonicalRoute(route));
  return routes;
}

/** Exact metadata preparation, never a completion or advisory catalog health check. */
export async function selectInitialModelRoute(llm: DshLlmRuntime, candidates: readonly DsmmModelRoute[], signal?: AbortSignal, resolver?: DsmmLlmRouteResolver): Promise<DsmmModelRoute> {
  return (await selectInitialModelRouteChoice(llm, candidates, signal, resolver)).route;
}

export async function selectInitialModelRouteChoice(llm: DshLlmRuntime, candidates: readonly DsmmModelRoute[], signal?: AbortSignal, resolver?: DsmmLlmRouteResolver): Promise<{ route: DsmmModelRoute; requestedRoute: DsmmModelRoute }> {
  if (resolver === undefined && llm.resolveCallConfig === undefined) throw new Error("dsmm route admission requires the Host model service");
  let unavailable: unknown;
  for (const route of orderedModelRoutes(candidates)) {
    signal?.throwIfAborted();
    try {
      if (resolver === undefined && llm.listProviders !== undefined && !llm.listProviders().some(provider => provider.id === route.provider)) throw new DsmmMissingProviderError();
      const call = modelRouteToCall(route);
      const prepared = resolver === undefined ? await llm.resolveCallConfig!(call, signal) : await resolver.resolveRoute(route, signal);
      if (resolver === undefined && call.customParameters !== undefined) throw new LlmError("Raw route parameters require their declared Host provider owner", "UNSUPPORTED_ROUTE_PARAMETERS");
      signal?.throwIfAborted();
      return { route: canonicalRoute(prepared), requestedRoute: canonicalRoute(route) };
    } catch (error) {
      signal?.throwIfAborted();
      if (!isUnavailableRouteFailure(error)) throw error;
      unavailable = error;
    }
  }
  throw unavailable ?? new Error("dsmm route admission has no configured candidate");
}

export function roleRouteLock(agent: DshAgent, identity: string): RoleRouteLock | undefined {
  const lock = routeLocks.get(agent);
  return lock?.identity === identity ? lock : undefined;
}

export function pinRoleRoute(agent: DshAgent, identity: string, route: DsmmModelRoute, candidates: readonly DsmmModelRoute[], projection?: { preserveCandidates: boolean; initialCandidate?: DsmmModelRoute }): RoleRouteLock {
  const ordered = projection?.preserveCandidates ? candidates.map(canonicalRoute) : orderedModelRoutes(candidates);
  const lock: RoleRouteLock = { identity, route: canonicalRoute(route), candidates: ordered,
    candidateIndex: ordered.findIndex(candidate => sameExactModelRoute(candidate, projection?.initialCandidate ?? route)), generation: 0,
    attempts: 0, startupSettled: false, retries: 0, rateLimits: 0, switches: 0, totalDelayMs: 0 };
  routeLocks.set(agent, lock);
  return lock;
}

export function clearRoleRouteLock(agent: DshAgent): void { routeLocks.delete(agent); }

export function roleRouteRuntimeState(agent: DshAgent, settings: DsmmSettings, role: DsmmRoleId | undefined, epoch?: string): DsmmRoleRuntimeState {
  const resolved = resolveRoleRuntimePolicy(settings, role);
  const identity = liveRolePolicyIdentity(agent, settings, role, epoch);
  const lock = identity === undefined ? undefined : roleRouteLock(agent, identity);
  return { ...(role === undefined ? {} : { role }), strategy: agent.session.header?.origin === "subagent" ? resolved.strategy : "startup-lock", rateLimit: { ...resolved.rateLimit },
    ...(lock === undefined ? {} : { route: { ...lock.route } }), retries: lock?.retries ?? 0,
    rateLimitFailures: lock?.rateLimits ?? 0, switches: lock?.switches ?? 0, totalDelayMs: lock?.totalDelayMs ?? 0 };
}

export function liveRolePolicyIdentity(agent: DshAgent, settings: DsmmSettings, role: DsmmRoleId | undefined, epoch?: string): string | undefined {
  if (role === undefined) { agentPolicies.delete(agent); return undefined; }
  const policy = settings.roleRouting[role];
  const resolved = resolveRoleRuntimePolicy(settings, role);
  const fields = { role, epoch, primary: policy?.primary, levels: policy?.levels,
    fallbackSource: resolved.fallbackSource, fallbackRoutes: resolved.fallbackRoutes,
    strategy: resolved.strategy, rateLimit: resolved.rateLimit, modelParameters: settings.modelParameters,
    recovery: { enabled: settings.runtimeRecovery.enabled, retryOnStatusCodes: settings.runtimeRecovery.retryOnStatusCodes,
      retryOnCodes: settings.runtimeRecovery.retryOnCodes, maxFallbackAttempts: settings.runtimeRecovery.maxFallbackAttempts } };
  let observed = agentPolicies.get(agent);
  if (observed === undefined || !isDeepStrictEqual(observed.fields, fields)) {
    observed = { fields: structuredClone(fields), identity: randomBytes(32).toString("hex") };
    agentPolicies.set(agent, observed);
  }
  return observed.identity;
}

function canonicalRoute(route: DsmmModelRoute): DsmmModelRoute {
  if (Object.keys(route).every(key => ["provider", "model", "reasoningEffort"].includes(key))) {
    return { provider: route.provider, model: route.model, ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) };
  }
  return normalizeModelRouteJson(JSON.parse(canonicalModelRouteJson(route)));
}

function policyEvents(frame: Pick<AgentRequestFrame, "agent">): readonly DshSessionEvent[] {
  const session = frame.agent.session;
  return session.header?.origin === "subagent" ? childOwnedSessionEvents(session) : sessionEvents(session);
}

function isPresetBoundary(frame: Pick<AgentRequestFrame, "agent">, event: DshSessionEvent): boolean {
  return frame.agent.session.header?.origin !== "subagent" && event.type === "agent-preset/selected"
    && isRecord(event.data) && typeof event.data.agentPreset === "string";
}

function readPolicyMarker(event: DshSessionEvent): { role: DsmmRoleId; policy: string | null } | undefined {
  if (event.type !== DSMM_ROLE_POLICY_EVENT) return undefined;
  const data = event.data;
  if (!isRecord(data) || data.version !== 1) return undefined;
  if (Object.keys(data).length !== 3 || !isDsmmRoleId(data.role)
    || (data.policy !== null && (typeof data.policy !== "string" || !/^[a-f0-9]{64}$/u.test(data.policy)))) {
    throw new TypeError("dsmm role-policy marker is malformed");
  }
  return { role: data.role, policy: data.policy };
}

/** Native custom events are model-hidden log facts, retained across surface compaction. */
export async function establishRolePolicy(frame: AgentRequestFrame, settings: DsmmSettings, role: DsmmRoleId | undefined, _ctx?: DshContext, epoch?: string): Promise<string | undefined> {
  const identity = liveRolePolicyIdentity(frame.agent, settings, role, epoch);
  const declared = role !== undefined && (Object.keys(settings.roleRouting[role] ?? {}).length > 0 || settings.runtimeRecovery.fallbackRoutes.length > 0);
  if (frame.signal.aborted) return identity;
  let latest: ReturnType<typeof readPolicyMarker>;
  const events = policyEvents(frame);
  for (const event of events) {
    if (isPresetBoundary(frame, event)) latest = undefined;
    else if (event.type === DSMM_ROLE_POLICY_EVENT) latest = readPolicyMarker(event);
  }
  if (frame.signal.aborted || !isCurrentRecoveryStep(events, frame.turn, frame.step)) return identity;
  if (identity === undefined || role === undefined || !declared) {
    if (latest !== undefined && latest.policy !== null) {
      appendRolePolicyRecord(frame.agent.session, { version: 1, role: latest.role, policy: null });
    }
    return identity;
  }
  if (latest?.role !== role || latest.policy !== identity) {
    appendRolePolicyRecord(frame.agent.session, { version: 1, role, policy: identity });
  }
  return identity;
}

export function recordAdmittedRecoveryRoute(frame: AgentRequestFrame, route: DsmmModelRoute): void {
  admittedRecoveryRoutes.set(frame, { ...route });
}

export function takeAdmittedRecoveryRoute(frame: AgentRequestFrame): DsmmModelRoute | undefined {
  const route = admittedRecoveryRoutes.get(frame);
  admittedRecoveryRoutes.delete(frame);
  return route;
}

export function effectiveRoleFallbackRoutes(settings: DsmmSettings, role: DsmmRoleId | undefined): readonly DsmmModelRoute[] {
  return resolveRoleRuntimePolicy(settings, role).fallbackRoutes;
}

export function applyModelRoute(config: DshLlmCallConfig, route: DsmmModelRoute): DshLlmCallConfig {
  return modelRouteToCall(route);
}

export function sameModelRoute(left: Pick<DsmmModelRoute, "provider" | "model">, right: Pick<DsmmModelRoute, "provider" | "model">): boolean {
  return left.provider === right.provider && left.model === right.model;
}

/** Accepted post-policy route changes are durable host/recovery ownership, not a new primary request. */
export function persistedRoleRoute(frame: Pick<AgentRequestFrame, "agent">, primary: DsmmModelRoute | undefined, fallbacks: readonly DsmmModelRoute[] = [], identity?: string): DsmmModelRoute | undefined {
  const currentIdentity = agentPolicies.get(frame.agent)?.identity;
  const events = policyEvents(frame);
  let matchingPolicy = false;
  let selected: DsmmModelRoute | undefined;
  for (const event of events) {
    if (isPresetBoundary(frame, event) || event.type === DSMM_ROLE_POLICY_EVENT) {
      const marker = event.type === DSMM_ROLE_POLICY_EVENT ? readPolicyMarker(event) : undefined;
      matchingPolicy = identity !== undefined && identity === currentIdentity && marker?.policy === identity;
      selected = undefined;
      continue;
    }
    if (!matchingPolicy) continue;
    if (event.type !== "request/header" || !isRecord(event.data)
      || !["initial", "resume", "change", "series"].includes(String(event.data.reason)) || !("header" in event.data)) continue;
    const header = event.data.header;
    if (!isRecord(header) || !isRecord(header.config)) continue;
    const config = header.config;
    if (typeof config?.provider !== "string" || config.provider.trim() === ""
      || typeof config.model !== "string" || config.model.trim() === "") continue;
    selected = modelRouteFromHeader(header);
  }
  // A configured fallback remains exact after its adapter/default header is
  // persisted. A later non-chain durable host route remains host-owned instead.
  return selected === undefined ? undefined : [primary, ...fallbacks].find((route) => route !== undefined && sameExactModelRoute(route, selected)) ?? selected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
