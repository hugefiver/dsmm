import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { LlmError } from "@deepseek-ai/dsh-llm";
import type { AgentRequestFrame, DshAgent, DshAgentModel, DshContext, DshLlmCallConfig, DshLlmRuntime, DshSessionEvent } from "./dsh-types.js";
import { appendModelSelectionRecord, appendRolePolicyRecord, readModelSelectionRecord } from "./session-metadata.js";
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
export interface RolePolicyState { readonly fields: unknown; readonly identity: string }
const agentPolicies = new WeakMap<DshAgent, RolePolicyState>();
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
  effortSource?: "native" | "dsmm-config";
}

export interface NativeModelSelectionIntent {
  seq: number;
  route: DsmmModelRoute;
}

/** DSMM's own pre-step selections, excluded from native manual-intent detection. */
const selfModelSelectionSeqs = new WeakMap<DshAgent, Set<number>>();
const selfSelectionWindows = new WeakMap<DshAgent, { afterSeq: number; route: DsmmModelRoute }>();

function selectionRoute(event: DshSessionEvent): DsmmModelRoute | undefined {
  if (event.type !== "model/selection" || typeof event.seq !== "number" || !Number.isSafeInteger(event.seq) || !isRecord(event.data)) return undefined;
  const { provider, model, reasoningEffort } = event.data;
  if (typeof provider !== "string" || provider.trim() === "" || typeof model !== "string" || model.trim() === ""
    || reasoningEffort !== undefined && (typeof reasoningEffort !== "string" || reasoningEffort.trim() === "")) return undefined;
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
}

function nonManualSelections(agent: DshAgent, events: readonly DshSessionEvent[]): Set<number> {
  const selected = new Map<number, DsmmModelRoute>();
  for (const event of events) {
    const route = selectionRoute(event);
    if (route !== undefined) selected.set(Number(event.seq), route);
  }
  const result = new Set(selfModelSelectionSeqs.get(agent));
  for (const event of events) {
    const association = readModelSelectionRecord(event);
    const route = association === undefined ? undefined : selected.get(association.selectionSeq);
    if (association !== undefined && association.recordSeq > association.selectionSeq && route !== undefined
      && sameExactModelRoute(route, association.route)) result.add(association.selectionSeq);
  }
  const window = selfSelectionWindows.get(agent);
  if (window !== undefined) for (const [seq, route] of selected) {
    if (seq > window.afterSeq && sameExactModelRoute(route, window.route)) result.add(seq);
  }
  return result;
}

/** DSH 0.2.2+ hosts fix the model selection before step preparation; 0.2.1 exposes no such seam. */
export function hostModelSelection(agent: DshAgent): DshAgentModel | undefined {
  const model = agent.model;
  return typeof model?.select === "function" && typeof model.current === "function" ? model : undefined;
}

export function latestModelSelectionSeq(agent: DshAgent): number {
  let seq = -1;
  for (const event of policyEvents({ agent })) {
    if (event.type === "model/selection" && typeof event.seq === "number") seq = Math.max(seq, event.seq);
  }
  return seq;
}

/** Persist only selections appended during this unpublished activation's trusted setup window. */
export function captureSetupModelSelections(agent: DshAgent, cursor: number): void {
  if (agent.session.header?.origin !== "subagent" || hostModelSelection(agent) === undefined) return;
  const events = policyEvents({ agent });
  const associated = new Set(events.flatMap(event => {
    const record = readModelSelectionRecord(event);
    return record?.source === "activation-setup" ? [record.selectionSeq] : [];
  }));
  for (const event of events) {
    const route = selectionRoute(event);
    if (route === undefined || event.seq! <= cursor || associated.has(event.seq!)) continue;
    appendModelSelectionRecord(agent.session, { version: 1, source: "activation-setup", selectionSeq: event.seq!, route });
  }
}

/**
 * Record a DSMM-owned selection for future steps. On 0.2.1 hosts this is a no-op;
 * callers keep their request-time route binding. Same-value selections append no
 * event and record nothing, matching the native idempotent contract.
 */
export function selectModelRouteForNextStep(agent: DshAgent, route: Pick<DsmmModelRoute, "provider" | "model" | "reasoningEffort">): void {
  const model = hostModelSelection(agent);
  if (model === undefined) return;
  const selected = canonicalRoute(route), cursor = latestModelSelectionSeq(agent);
  selfSelectionWindows.set(agent, { afterSeq: cursor, route: selected });
  try {
    model.select({ provider: selected.provider, model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) });
  } finally {
    selfSelectionWindows.delete(agent);
  }
  const event = policyEvents({ agent }).filter(candidate => {
    const candidateRoute = selectionRoute(candidate);
    return candidateRoute !== undefined && Number(candidate.seq) > cursor && sameExactModelRoute(candidateRoute, selected);
  }).sort((left, right) => Number(left.seq) - Number(right.seq))[0];
  if (event === undefined) return;
  const seq = Number(event.seq);
  let seqs = selfModelSelectionSeqs.get(agent);
  if (seqs === undefined) { seqs = new Set(); selfModelSelectionSeqs.set(agent, seqs); }
  seqs.add(seq);
  appendModelSelectionRecord(agent.session, { version: 1, source: "dsmm-selection", selectionSeq: seq, route: { provider: selected.provider, model: selected.model,
    ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) } });
}

/** Native user selection is authority; inherited headers/default configs are not. DSMM's own selections are not manual intent. */
export function latestNativeModelSelection(agent: DshAgent): NativeModelSelectionIntent | undefined {
  let selected: NativeModelSelectionIntent | undefined;
  const events = policyEvents({ agent }), excluded = nonManualSelections(agent, events);
  for (const event of events) {
    const route = selectionRoute(event);
    if (route === undefined || !("seq" in event) || typeof event.seq !== "number" || event.seq < 0 || excluded.has(event.seq)) continue;
    selected = { seq: event.seq, route };
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
export async function selectInitialModelRoute(llm: DshLlmRuntime, candidates: readonly DsmmModelRoute[], signal?: AbortSignal, resolver?: DsmmLlmRouteResolver, assertCurrent?: () => void): Promise<DsmmModelRoute> {
  return (await selectInitialModelRouteChoice(llm, candidates, signal, resolver, undefined, assertCurrent)).proposal;
}

export interface InitialModelRouteChoice {
  readonly requestedRoute: DsmmModelRoute;
  readonly proposal: DsmmModelRoute;
  readonly effective: DsmmModelRoute;
}

export async function selectInitialModelRouteChoice(llm: DshLlmRuntime, candidates: readonly DsmmModelRoute[], signal?: AbortSignal, resolver?: DsmmLlmRouteResolver, project?: (route: DsmmModelRoute) => DsmmModelRoute, assertCurrent?: () => void): Promise<InitialModelRouteChoice> {
  if (resolver === undefined && llm.resolveCallConfig === undefined) throw new Error("dsmm route admission requires the Host model service");
  let unavailable: unknown;
  for (const route of orderedModelRoutes(candidates)) {
    assertCurrent?.();
    signal?.throwIfAborted();
    try {
      if (resolver === undefined && llm.listProviders !== undefined && !llm.listProviders().some(provider => provider.id === route.provider)) throw new DsmmMissingProviderError();
      const requestedRoute = canonicalRoute(route), proposal = canonicalRoute(project?.(route) ?? route);
      const call = modelRouteToCall(proposal);
      const prepared = resolver === undefined ? await llm.resolveCallConfig!(call, signal) : await resolver.resolveRoute(proposal, signal);
      assertCurrent?.();
      if (resolver === undefined && call.customParameters !== undefined) throw new LlmError("Raw route parameters require their declared Host provider owner", "UNSUPPORTED_ROUTE_PARAMETERS");
      signal?.throwIfAborted();
      const effective = canonicalRoute(prepared);
      if (!sameModelRoute(proposal, effective)) throw new LlmError("Provider resolved another model during route admission", "INVALID_ADAPTER");
      return { requestedRoute, proposal, effective };
    } catch (error) {
      assertCurrent?.();
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
export function currentRoleRouteLock(agent: DshAgent): RoleRouteLock | undefined { return routeLocks.get(agent); }
export function currentRolePolicyState(agent: DshAgent): RolePolicyState | undefined { return agentPolicies.get(agent); }
export function restoreRolePolicyAndLock(agent: DshAgent, installedPolicy: RolePolicyState, installedLock: RoleRouteLock,
  previousPolicy: RolePolicyState | undefined, previousLock: RoleRouteLock | undefined): boolean {
  if (agentPolicies.get(agent) !== installedPolicy || routeLocks.get(agent) !== installedLock) return false;
  if (previousPolicy === undefined) agentPolicies.delete(agent); else agentPolicies.set(agent, previousPolicy);
  if (previousLock === undefined) routeLocks.delete(agent); else routeLocks.set(agent, previousLock);
  return true;
}

export function roleRouteRuntimeState(agent: DshAgent, settings: DsmmSettings, role: DsmmRoleId | undefined, epoch?: string): DsmmRoleRuntimeState {
  const resolved = resolveRoleRuntimePolicy(settings, role);
  const identity = liveRolePolicyIdentity(agent, settings, role, epoch);
  const lock = identity === undefined ? undefined : roleRouteLock(agent, identity);
  return { ...(role === undefined ? {} : { role }), strategy: agent.session.header?.origin === "subagent" || epoch !== undefined && settings.rootModelPolicy === "configured" && settings.modules.deepwork.enabled && role !== undefined ? resolved.strategy : "startup-lock", rateLimit: { ...resolved.rateLimit },
    ...(lock === undefined ? {} : { route: { ...lock.route } }), retries: lock?.retries ?? 0,
    rateLimitFailures: lock?.rateLimits ?? 0, switches: lock?.switches ?? 0, totalDelayMs: lock?.totalDelayMs ?? 0 };
}

export function liveRolePolicyIdentity(agent: DshAgent, settings: DsmmSettings, role: DsmmRoleId | undefined, epoch?: string): string | undefined {
  if (role === undefined) { agentPolicies.delete(agent); return undefined; }
  const policy = settings.roleRouting[role];
  const resolved = resolveRoleRuntimePolicy(settings, role);
  const fields = { role, epoch, rootModelPolicy: settings.rootModelPolicy, deepworkEnabled: settings.modules.deepwork.enabled, primary: policy?.primary, levels: policy?.levels,
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

export function applyModelRoute(_config: DshLlmCallConfig, route: DsmmModelRoute): DshLlmCallConfig {
  return modelRouteToCall(route);
}

export function sameModelRoute(left: Pick<DsmmModelRoute, "provider" | "model">, right: Pick<DsmmModelRoute, "provider" | "model">): boolean {
  return left.provider === right.provider && left.model === right.model;
}

/** Accepted post-policy route changes are durable host/recovery ownership, not a new primary request. */
export function persistedRoleRoute(frame: Pick<AgentRequestFrame, "agent">, primary: DsmmModelRoute | undefined, fallbacks: readonly DsmmModelRoute[] = [], identity?: string, configuredRoot = false): DsmmModelRoute | undefined {
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
  if (configuredRoot) {
    const lock = identity === undefined ? undefined : roleRouteLock(frame.agent, identity);
    return selected !== undefined && lock !== undefined && lock.candidateIndex >= 0 && sameExactModelRoute(selected, lock.route) ? lock.route : undefined;
  }
  // Native/child routes retain durable Host ownership after a matching policy.
  return selected === undefined ? undefined : [primary, ...fallbacks].find((route) => route !== undefined && sameExactModelRoute(route, selected)) ?? selected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
