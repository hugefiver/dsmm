import { isDeepStrictEqual } from "node:util";
import type { DshLlmFailure, DshSessionEvent } from "./dsh-types.js";
import type { DsmmRecoveryRoute, DsmmRuntimeRecoverySettings } from "./settings.js";
import { normalizeModelRouteJson } from "./route-json.js";
import { modelRouteFromHeader } from "./role-llm.js";

export type RecoveryFailureDecision =
  | { kind: "retryable"; matchedBy: "status" | "code" }
  | { kind: "ignored" };

export interface DurableRecoveryWork {
  incompleteTodo: boolean;
  activeGoal: boolean;
}

interface FallbackRouteSelectionInput {
  failedRoute: DsmmRecoveryRoute;
  attemptedRoutes: readonly DsmmRecoveryRoute[];
  fallbackRoutes: readonly DsmmRecoveryRoute[];
  maxFallbackAttempts: number;
}

const REQUEST_HEADER_REASONS = new Set(["initial", "resume", "change", "series"]);
const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);
const GOAL_OPERATIONS = new Set(["create", "edit", "pause", "resume", "complete", "block"]);
const GOAL_PHASES = new Set(["active", "paused", "blocked", "complete"]);
const LOWER_KEBAB_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SNAPSHOT_EVENT_KEYS = ["createdAt", "goal", "kind", "operation", "roundsStarted", "updatedAt", "version"];
const CLEAR_EVENT_KEYS = ["cleared", "clearedAt", "kind", "operation", "version"];
const BLOCKED_GOAL_KEYS = ["blockedReason", "id", "maxGoalRounds", "objective", "phase", "revision"];
const UNBLOCKED_GOAL_KEYS = ["id", "maxGoalRounds", "objective", "phase", "revision"];
const CLEAR_REF_KEYS = ["id", "revision"];
const BLOCKED_REASON_KEYS = ["code", "message"];

export function classifyRecoveryFailure(failure: DshLlmFailure, settings: DsmmRuntimeRecoverySettings): RecoveryFailureDecision {
  if (!isRecord(failure)) return { kind: "ignored" };

  const status = failure.status;
  if (typeof status === "number" && Number.isInteger(status) && settings.retryOnStatusCodes.includes(status)) {
    return { kind: "retryable", matchedBy: "status" };
  }
  // Payment failures require an explicit status policy, not a generic transport code.
  if (status === 402) return { kind: "ignored" };

  const code = failure.code;
  if (typeof code === "string" && settings.retryOnCodes.includes(code.toLowerCase())) {
    return { kind: "retryable", matchedBy: "code" };
  }

  return { kind: "ignored" };
}

export function isCurrentRecoveryStep(events: readonly DshSessionEvent[], turn: number, step: number): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "step/start" || event.type === "step/end") {
      const coordinates = readStepCoordinates(event.data);
      if (coordinates !== undefined) return event.type === "step/start" && coordinates.turn === turn && coordinates.step === step;
    }
    if (event.type === "turn/start" || event.type === "turn/end") {
      const data = eventData(event);
      if (isRecord(data) && isPositiveSafeInteger(data.turn)) return false;
    }
  }
  return false;
}

export function foldAttemptedRecoveryRoutes(events: readonly DshSessionEvent[], turn: number, step: number): DsmmRecoveryRoute[] {
  const routes: DsmmRecoveryRoute[] = [];
  let inheritedRoute: DsmmRecoveryRoute | undefined;
  let targetStarted = false;

  for (const event of events) {
    if (!targetStarted) {
      if (isTargetStepStart(event, turn, step)) {
        targetStarted = true;
        if (inheritedRoute !== undefined) appendUniqueRoute(routes, inheritedRoute);
        continue;
      }

      const route = readHeaderRoute(event);
      if (route !== undefined) inheritedRoute = route;
      continue;
    }

    if (endsTargetScope(event)) break;

    const route = readHeaderRoute(event);
    if (route !== undefined) appendUniqueRoute(routes, route);
  }

  return routes;
}

export function foldDurableRecoveryWork(events: readonly DshSessionEvent[]): DurableRecoveryWork {
  let latestTurnStart = -1;

  for (let index = 0; index < events.length; index += 1) {
    if (isTurnStart(events[index])) latestTurnStart = index;
  }

  let incompleteTodo = false;
  if (latestTurnStart >= 0) {
    for (let index = latestTurnStart + 1; index < events.length; index += 1) {
      const todos = readTodos(events[index]);
      if (todos !== undefined) incompleteTodo = todos.some((todo) => todo.status === "pending" || todo.status === "in_progress");
    }
  }

  let activeGoal = false;
  for (const event of events) {
    const nextActiveGoal = readGoalActivity(event);
    if (nextActiveGoal !== undefined) activeGoal = nextActiveGoal;
  }

  return { incompleteTodo, activeGoal };
}

export function selectFallbackRoute({
  failedRoute,
  attemptedRoutes,
  fallbackRoutes,
  maxFallbackAttempts
}: FallbackRouteSelectionInput): DsmmRecoveryRoute | undefined {
  const cap = Number.isFinite(maxFallbackAttempts) ? Math.floor(maxFallbackAttempts) : 0;
  if (cap <= 0) return undefined;

  const attempts = uniqueRoutes(attemptedRoutes);
  if (attempts.slice(1).length >= cap) return undefined;

  for (const fallbackRoute of fallbackRoutes) {
    const route = readRoute(fallbackRoute);
    if (route === undefined || sameRoute(route, failedRoute) || attempts.some((attempt) => sameRoute(attempt, route))) continue;
    return { ...route };
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNormalizedNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value === value.trim();
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && keys.every((key) => expectedKeys.includes(key));
}

function readRoute(value: unknown): DsmmRecoveryRoute | undefined {
  try { return normalizeModelRouteJson(value, false, true); } catch { return undefined; }
}

function sameRoute(left: DsmmRecoveryRoute, right: DsmmRecoveryRoute): boolean {
  return isDeepStrictEqual(readRoute(left), readRoute(right));
}

function appendUniqueRoute(routes: DsmmRecoveryRoute[], route: DsmmRecoveryRoute): void {
  if (!routes.some((candidate) => sameRoute(candidate, route))) routes.push({ ...route });
}

function uniqueRoutes(routes: readonly DsmmRecoveryRoute[]): DsmmRecoveryRoute[] {
  const unique: DsmmRecoveryRoute[] = [];
  for (const candidate of routes) {
    const route = readRoute(candidate);
    if (route !== undefined) appendUniqueRoute(unique, route);
  }
  return unique;
}

function eventType(event: unknown): string | undefined {
  return isRecord(event) && typeof event.type === "string" ? event.type : undefined;
}

function eventData(event: unknown): unknown {
  return isRecord(event) ? event.data : undefined;
}

function readStepCoordinates(value: unknown): { turn: number; step: number } | undefined {
  if (!isRecord(value) || !isPositiveSafeInteger(value.turn) || !isPositiveSafeInteger(value.step)) return undefined;
  return { turn: value.turn, step: value.step };
}

function isTargetStepStart(event: unknown, turn: number, step: number): boolean {
  if (eventType(event) !== "step/start") return false;
  const coordinates = readStepCoordinates(eventData(event));
  return coordinates?.turn === turn && coordinates.step === step;
}

function readHeaderRoute(event: unknown): DsmmRecoveryRoute | undefined {
  if (eventType(event) !== "request/header") return undefined;
  const data = eventData(event);
  if (!isRecord(data) || typeof data.reason !== "string" || !REQUEST_HEADER_REASONS.has(data.reason)) return undefined;
  if (!isRecord(data.header) || !isRecord(data.header.config)) return undefined;
  try {
    const provider = data.header.config.provider;
    if (typeof provider !== "string") return undefined;
    // Decode native envelopes with valid grammar, then retain the exact durable identity.
    const route = modelRouteFromHeader({ ...data.header, config: { ...data.header.config, provider: provider.trim() } });
    return readRoute({ ...route, provider });
  } catch { return undefined; }
}

function endsTargetScope(event: unknown): boolean {
  const type = eventType(event);
  if (type === "step/start" || type === "step/end") {
    const coordinates = readStepCoordinates(eventData(event));
    if (coordinates === undefined) return false;
    return true;
  }

  if (type !== "turn/start" && type !== "turn/end") return false;
  const data = eventData(event);
  return isRecord(data) && isPositiveSafeInteger(data.turn);
}

function isTurnStart(event: unknown): boolean {
  if (eventType(event) !== "turn/start") return false;
  const data = eventData(event);
  return isRecord(data) && isPositiveSafeInteger(data.turn);
}

function readTodos(event: unknown): Array<{ status: string }> | undefined {
  if (eventType(event) !== "todo/write") return undefined;
  const data = eventData(event);
  if (!isRecord(data) || !Array.isArray(data.todos)) return undefined;

  const todos: Array<{ status: string }> = [];
  for (const todo of data.todos) {
    if (!isRecord(todo) || typeof todo.content !== "string" || typeof todo.status !== "string" || !TODO_STATUSES.has(todo.status)) return undefined;
    todos.push({ status: todo.status });
  }

  return todos;
}

function readGoalActivity(event: unknown): boolean | undefined {
  if (eventType(event) !== "goal/change") return undefined;
  const data = eventData(event);
  if (!isRecord(data) || data.kind !== "goal/change" || data.version !== 1) return undefined;

  if (data.operation === "clear") {
    return hasExactKeys(data, CLEAR_EVENT_KEYS) && isValidGoalClear(data) ? false : undefined;
  }

  if (typeof data.operation !== "string" || !hasExactKeys(data, SNAPSHOT_EVENT_KEYS) || !GOAL_OPERATIONS.has(data.operation) || !isValidGoalSnapshot(data)) return undefined;
  return data.goal.phase === "active";
}

function isValidGoalClear(data: Record<string, unknown>): boolean {
  return isRecord(data.cleared)
    && hasExactKeys(data.cleared, CLEAR_REF_KEYS)
    && typeof data.cleared.id === "string"
    && data.cleared.id !== ""
    && isPositiveSafeInteger(data.cleared.revision)
    && isNonnegativeSafeInteger(data.clearedAt);
}

function isValidGoalSnapshot(data: Record<string, unknown>): data is Record<string, unknown> & { goal: { phase: string } } {
  if (!isRecord(data.goal) || typeof data.goal.phase !== "string" || !GOAL_PHASES.has(data.goal.phase)) return false;
  const expectedGoalKeys = data.goal.phase === "blocked" ? BLOCKED_GOAL_KEYS : UNBLOCKED_GOAL_KEYS;
  if (!hasExactKeys(data.goal, expectedGoalKeys) || typeof data.goal.id !== "string" || data.goal.id === "") return false;
  if (!isPositiveSafeInteger(data.goal.revision) || !isNormalizedNonEmptyString(data.goal.objective) || !isPositiveSafeInteger(data.goal.maxGoalRounds)) return false;
  if (data.goal.phase === "blocked" && !isValidBlockedReason(data.goal.blockedReason)) return false;

  const roundsStarted = data.roundsStarted;
  const createdAt = data.createdAt;
  const updatedAt = data.updatedAt;
  return isNonnegativeSafeInteger(roundsStarted)
    && isNonnegativeSafeInteger(createdAt)
    && isNonnegativeSafeInteger(updatedAt)
    && updatedAt >= createdAt;
}

function isValidBlockedReason(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, BLOCKED_REASON_KEYS)
    && typeof value.code === "string"
    && LOWER_KEBAB_CODE.test(value.code)
    && isNormalizedNonEmptyString(value.message);
}
