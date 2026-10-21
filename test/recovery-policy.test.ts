import assert from "node:assert/strict";
import { test } from "node:test";
import type { DshLlmFailure, DshSessionEvent } from "../src/dsh-types.ts";
import { classifyRecoveryFailure, foldAttemptedRecoveryRoutes, foldDurableRecoveryWork, selectFallbackRoute } from "../src/recovery-policy.ts";
import type { DsmmRecoveryRoute, DsmmRuntimeRecoverySettings } from "../src/settings.ts";

const settings: DsmmRuntimeRecoverySettings = {
  enabled: true,
  retryOnStatusCodes: [429, 503],
  retryOnCodes: ["etimedout"],
  fallbackRoutes: [],
  maxFallbackAttempts: 2,
  idleContinuation: {
    enabled: false,
    maxContinuations: 0,
    prompt: ""
  }
};

function failure(value: unknown): DshLlmFailure {
  return value as DshLlmFailure;
}

function event(type: string, data: unknown): DshSessionEvent {
  return { type, data };
}

function header(provider: string, model: string, reason: "initial" | "resume" | "change" = "change"): DshSessionEvent {
  return event("request/header", { header: { config: { provider, model } }, reason });
}

function step(type: "step/start" | "step/end", turn: number, currentStep: number): DshSessionEvent {
  return event(type, { turn, step: currentStep });
}

type GoalPhase = "active" | "paused" | "blocked" | "complete";

function goalSnapshot(phase: GoalPhase, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "goal-1",
    revision: 1,
    objective: "Ship recovery",
    phase,
    maxGoalRounds: 5,
    ...(phase === "blocked" ? { blockedReason: { code: "blocked", message: "Details" } } : {}),
    ...overrides
  };
}

function snapshotData(goal: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "goal/change",
    version: 1,
    operation: "edit",
    goal,
    roundsStarted: 1,
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  };
}

function snapshotEvent(goal: Record<string, unknown>, overrides: Record<string, unknown> = {}): DshSessionEvent {
  return event("goal/change", snapshotData(goal, overrides));
}

function goalChange(phase: GoalPhase, overrides: Record<string, unknown> = {}): DshSessionEvent {
  return snapshotEvent(goalSnapshot(phase, overrides));
}

function clearData(cleared: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "goal/change",
    version: 1,
    operation: "clear",
    cleared,
    clearedAt: 3,
    ...overrides
  };
}

function clearEvent(cleared: Record<string, unknown>, overrides: Record<string, unknown> = {}): DshSessionEvent {
  return event("goal/change", clearData(cleared, overrides));
}

function clearGoal(revision: unknown): DshSessionEvent {
  return clearEvent({ id: "goal-1", revision });
}

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

test("classifyRecoveryFailure uses exact status precedence and lowercased exact codes only", () => {
  assert.deepEqual(classifyRecoveryFailure(failure({ status: 429, code: "other" }), settings), { kind: "retryable", matchedBy: "status" });
  assert.deepEqual(classifyRecoveryFailure(failure({ status: 401, code: "ETIMEDOUT" }), settings), { kind: "retryable", matchedBy: "code" });
  assert.deepEqual(classifyRecoveryFailure(failure({ code: "etimedout" }), settings), { kind: "retryable", matchedBy: "code" });
  assert.deepEqual(classifyRecoveryFailure(failure({ code: "prefix-etimedout" }), settings), { kind: "ignored" });
  assert.deepEqual(classifyRecoveryFailure(failure({ code: "other", message: "ETIMEDOUT 429" }), settings), { kind: "ignored" });
  assert.deepEqual(classifyRecoveryFailure(failure({ status: 429, code: "ETIMEDOUT", providerRetryAfterMs: 250 }), settings), { kind: "retryable", matchedBy: "status" });
  assert.deepEqual(classifyRecoveryFailure(failure({ status: "429", code: "other" }), settings), { kind: "ignored" });
  assert.deepEqual(classifyRecoveryFailure(failure({ status: 429.5, code: "other" }), settings), { kind: "ignored" });
  assert.deepEqual(classifyRecoveryFailure(failure({ status: undefined, code: 429 }), settings), { kind: "ignored" });

  const noSensitiveAccess = Object.defineProperties({ status: 503, code: "other" }, {
    message: { get: () => { throw new Error("must not read"); } },
    providerRetryAfterMs: { get: () => { throw new Error("must not read"); } }
  });
  assert.deepEqual(classifyRecoveryFailure(failure(noSensitiveAccess), settings), { kind: "retryable", matchedBy: "status" });
});

test("402 fallback requires an explicit structured status opt-in", () => {
  assert.deepEqual(classifyRecoveryFailure(failure({ status: 402, code: "etimedout" }), settings), { kind: "ignored" });
  assert.deepEqual(classifyRecoveryFailure(failure({ status: 402, code: "other" }), {
    ...settings, retryOnStatusCodes: [...settings.retryOnStatusCodes, 402]
  }), { kind: "retryable", matchedBy: "status" });
  assert.deepEqual(classifyRecoveryFailure(failure({ code: "other", message: "payment required status=402" }), {
    ...settings, retryOnStatusCodes: [402]
  }), { kind: "ignored" });
});

test("foldAttemptedRecoveryRoutes inherits the latest valid route and limits headers to the target step", () => {
  const events = [
    header("Primary", "a", "initial"),
    event("request/header", { header: { config: { provider: "Broken", model: "" } }, reason: "change" }),
    step("step/start", 4, 2),
    header("fallback", "b"),
    header("fallback", "b"),
    header(" ", "ignored"),
    header("ignored", "\t"),
    header("FaLlBaCk ", " b "),
    event("request/header", { header: { config: { provider: "ignored", model: "x" } }, reason: "retry" }),
    step("step/end", 4, 2),
    header("fallback", "c")
  ];

  const routes = foldAttemptedRecoveryRoutes(events, 4, 2);
  assert.deepEqual(routes, [{ provider: "Primary", model: "a" }, { provider: "fallback", model: "b" }, { provider: "FaLlBaCk ", model: " b " }]);
  assert.notEqual(routes, foldAttemptedRecoveryRoutes(events, 4, 2));
  assert.notEqual(routes[0], foldAttemptedRecoveryRoutes(events, 4, 2)[0]);

  const nextStepEvents = [
    header("primary", "a", "initial"),
    step("step/start", 4, 2),
    header("fallback", "b"),
    step("step/start", 4, 3),
    header("fallback", "c")
  ];
  assert.deepEqual(foldAttemptedRecoveryRoutes(nextStepEvents, 4, 2), [{ provider: "primary", model: "a" }, { provider: "fallback", model: "b" }]);
  assert.deepEqual(foldAttemptedRecoveryRoutes([step("step/start", 4, 2), event("turn/start", { turn: 5 }), header("fallback", "b")], 4, 2), []);
});

test("foldAttemptedRecoveryRoutes feeds the fallback cap with inherited and changed routes", () => {
  const attemptedRoutes = foldAttemptedRecoveryRoutes([
    header("primary", "a", "initial"),
    step("step/start", 4, 2),
    header("fallback", "b")
  ], 4, 2);

  assert.deepEqual(attemptedRoutes, [{ provider: "primary", model: "a" }, { provider: "fallback", model: "b" }]);
  assert.equal(selectFallbackRoute({
    failedRoute: { provider: "primary", model: "a" },
    attemptedRoutes,
    fallbackRoutes: [{ provider: "fallback", model: "c" }],
    maxFallbackAttempts: 1
  }), undefined);
});

test("recovery folds native parameter envelopes without defaults and detaches complete route values", () => {
  const config = { provider: "FaLlBaCk ", model: " b ", maxTokens: 2048, reasoningEffort: "high",
    customParameters: { nested: { values: [null, false, 0] }, stop: [] } };
  const events = [event("request/header", { header: { config, adapterDefaults: { maxTokens: true, reasoningEffort: true } }, reason: "initial" }),
    step("step/start", 4, 2)];
  const routes = foldAttemptedRecoveryRoutes(events, 4, 2);
  assert.deepEqual(routes, [{ provider: "FaLlBaCk ", model: " b ", nested: { values: [null, false, 0] }, stop: [] }]);
  assert.notEqual(routes[0].nested, config.customParameters.nested);
  assert.notEqual((routes[0].nested as { values: unknown[] }).values, config.customParameters.nested.values);
  (routes[0].nested as { values: unknown[] }).values.push("changed");
  assert.deepEqual(config.customParameters.nested.values, [null, false, 0]);
  assert.deepEqual(foldAttemptedRecoveryRoutes([
    step("step/start", 4, 2),
    event("request/header", { header: { config: { ...config, customParameters: { provider: "override" } } }, reason: "change" })
  ], 4, 2), []);
});

test("recovery identity includes exact identity text and complete parameters while enforcing unique-attempt caps", () => {
  const primary = { provider: "Primary", model: "a" };
  const attempted = { provider: "FaLlBaCk ", model: " b ", nested: { a: null, b: [false, 0] } };
  const reordered = { nested: { b: [false, 0], a: null }, model: " b ", provider: "FaLlBaCk " };
  const changed = { ...attempted, nested: { a: null, b: [false, 1] } };
  const input = { failedRoute: attempted, attemptedRoutes: [primary, attempted, reordered],
    fallbackRoutes: [reordered, changed], maxFallbackAttempts: 2 };
  const selected = selectFallbackRoute(input);
  assert.deepEqual(selected, changed);
  assert.notEqual(selected!.nested, changed.nested);
  (selected!.nested as { b: unknown[] }).b.push("changed");
  assert.deepEqual(changed.nested.b, [false, 1]);
  assert.deepEqual(selectFallbackRoute({ ...input, fallbackRoutes: [{ ...attempted, provider: "fallback" }] }),
    { ...attempted, provider: "fallback" });
  assert.equal(selectFallbackRoute({ ...input, maxFallbackAttempts: 1 }), undefined);
  assert.equal(selectFallbackRoute({ ...input, attemptedRoutes: [primary, attempted, changed] }), undefined);
  const folded = foldAttemptedRecoveryRoutes([
    header("Primary", "a", "initial"), step("step/start", 4, 2),
    ...[attempted, reordered, changed].map(config => event("request/header", { header: { config }, reason: "change" }))
  ], 4, 2);
  assert.deepEqual(folded, [primary, attempted, changed]);
});

test("foldAttemptedRecoveryRoutes ignores invalid coordinate boundaries", () => {
  const invalidBoundaries = [
    { turn: -1, step: 1 },
    { turn: 0, step: 1 },
    { turn: 1.5, step: 1 },
    { turn: Number.MAX_SAFE_INTEGER + 1, step: 1 },
    { turn: 1, step: 0 },
    { turn: 1, step: 1.5 },
    { turn: 1, step: Number.MAX_SAFE_INTEGER + 1 }
  ];

  for (const boundary of invalidBoundaries) {
    const attemptedRoutes = foldAttemptedRecoveryRoutes([
      header("primary", "A", "initial"),
      step("step/start", 4, 2),
      header("fallback", "B"),
      event("step/start", boundary),
      header("fallback", "C"),
      step("step/end", 4, 2)
    ], 4, 2);

    assert.deepEqual(attemptedRoutes, [
      { provider: "primary", model: "A" },
      { provider: "fallback", model: "B" },
      { provider: "fallback", model: "C" }
    ]);
    assert.equal(selectFallbackRoute({
      failedRoute: { provider: "primary", model: "A" },
      attemptedRoutes,
      fallbackRoutes: [{ provider: "fallback", model: "D" }],
      maxFallbackAttempts: 2
    }), undefined);
  }
});

test("foldDurableRecoveryWork keeps only current-turn todos and valid active goals", () => {
  assert.deepEqual(foldDurableRecoveryWork([
    event("todo/write", { todos: [{ content: "stale", status: "pending" }] })
  ]), { incompleteTodo: false, activeGoal: false });

  assert.deepEqual(foldDurableRecoveryWork([
    event("turn/start", { turn: 1 }),
    event("todo/write", { todos: [{ content: "current", status: "pending" }] })
  ]), { incompleteTodo: true, activeGoal: false });

  assert.deepEqual(foldDurableRecoveryWork([
    event("todo/write", { todos: [{ content: "stale", status: "pending" }] }),
    event("turn/start", { turn: 1 }),
    event("todo/write", { todos: [{ content: "current", status: "in_progress" }] }),
    event("todo/write", { todos: [{ content: "malformed", status: "unknown" }] }),
    event("todo/write", { todos: [{ content: "done", status: "completed" }] })
  ]), { incompleteTodo: false, activeGoal: false });

  assert.deepEqual(foldDurableRecoveryWork([
    event("todo/write", { todos: [{ content: "old", status: "pending" }] }),
    event("turn/start", { turn: 1 }),
    event("todo/write", { todos: [{ content: "first", status: "completed" }] }),
    event("turn/start", { turn: 2 })
  ]), { incompleteTodo: false, activeGoal: false });

  assert.deepEqual(foldDurableRecoveryWork([
    goalChange("active"),
    event("goal/change", { kind: "goal/change", version: 2 }),
    goalChange("paused"),
    goalChange("active"),
    event("goal/change", {
      kind: "goal/change",
      version: 1,
      operation: "clear",
      cleared: { id: "goal-1", revision: 2 },
      clearedAt: 3
    })
  ]), { incompleteTodo: false, activeGoal: false });

  assert.deepEqual(foldDurableRecoveryWork([goalChange("active"), goalChange("complete")]), { incompleteTodo: false, activeGoal: false });
  assert.deepEqual(foldDurableRecoveryWork([goalChange("blocked"), goalChange("active")]), { incompleteTodo: false, activeGoal: true });

  for (const invalidTurn of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(foldDurableRecoveryWork([
      event("turn/start", { turn: 1 }),
      event("todo/write", { todos: [{ content: "current", status: "pending" }] }),
      event("turn/start", { turn: invalidTurn })
    ]), { incompleteTodo: true, activeGoal: false });
  }
});

test("foldDurableRecoveryWork accepts only strict goal decoder evidence", () => {
  const invalidPositiveSafeIntegers = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1];
  const invalidNonnegativeSafeIntegers = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1];
  const malformedSnapshots: DshSessionEvent[] = [
    snapshotEvent(goalSnapshot("active", { id: "" })),
    ...["", " ", " Ship recovery", "Ship recovery "].map((objective) => snapshotEvent(goalSnapshot("active", { objective }))),
    ...invalidPositiveSafeIntegers.map((revision) => goalChange("active", { revision })),
    ...invalidPositiveSafeIntegers.map((maxGoalRounds) => goalChange("active", { maxGoalRounds })),
    ...invalidNonnegativeSafeIntegers.map((roundsStarted) => snapshotEvent(goalSnapshot("active"), { roundsStarted })),
    ...invalidNonnegativeSafeIntegers.map((createdAt) => snapshotEvent(goalSnapshot("active"), { createdAt })),
    ...invalidNonnegativeSafeIntegers.map((updatedAt) => snapshotEvent(goalSnapshot("active"), { updatedAt })),
    snapshotEvent(goalSnapshot("active"), { createdAt: 4, updatedAt: 3 }),
    snapshotEvent(goalSnapshot("active"), { extra: true }),
    event("goal/change", withoutKey(snapshotData(goalSnapshot("active")), "createdAt")),
    snapshotEvent(goalSnapshot("active", { extra: true })),
    snapshotEvent(withoutKey(goalSnapshot("active"), "objective")),
    event("goal/change", Object.assign([], snapshotData(goalSnapshot("active")))),
    snapshotEvent(Object.assign([], goalSnapshot("active"))),
    snapshotEvent(withoutKey(goalSnapshot("blocked"), "blockedReason")),
    snapshotEvent(goalSnapshot("active", { blockedReason: { code: "blocked", message: "Details" } })),
    snapshotEvent(goalSnapshot("blocked", { blockedReason: { code: "blocked", message: "Details", extra: true } })),
    snapshotEvent(goalSnapshot("blocked", { blockedReason: { message: "Details" } })),
    snapshotEvent(goalSnapshot("blocked", { blockedReason: { code: "blocked" } })),
    ...["", "Blocked", "blocked_code", "blocked--code", "1blocked"].map((code) => snapshotEvent(goalSnapshot("blocked", { blockedReason: { code, message: "Details" } }))),
    ...["", " ", " Details", "Details "].map((message) => snapshotEvent(goalSnapshot("blocked", { blockedReason: { code: "blocked", message } }))),
    snapshotEvent(goalSnapshot("active"), { version: 2 }),
    snapshotEvent(goalSnapshot("active"), { operation: "clear" })
  ];
  const malformedClears: DshSessionEvent[] = [
    ...invalidPositiveSafeIntegers.map((revision) => clearGoal(revision)),
    clearEvent({ id: "", revision: 1 }),
    clearEvent({ id: "goal-1", revision: 1, extra: true }),
    clearEvent(withoutKey({ id: "goal-1", revision: 1 }, "id")),
    clearEvent({ id: "goal-1", revision: 1 }, { extra: true }),
    event("goal/change", withoutKey(clearData({ id: "goal-1", revision: 1 }), "clearedAt")),
    ...invalidNonnegativeSafeIntegers.map((clearedAt) => clearEvent({ id: "goal-1", revision: 1 }, { clearedAt })),
    event("goal/change", Object.assign([], clearData({ id: "goal-1", revision: 1 }))),
    clearEvent({ id: "goal-1", revision: 1 }, { version: 2 }),
    clearEvent({ id: "goal-1", revision: 1 }, { operation: "edit" })
  ];

  for (const malformed of [...malformedSnapshots, ...malformedClears]) {
    assert.deepEqual(foldDurableRecoveryWork([goalChange("paused"), malformed]), { incompleteTodo: false, activeGoal: false });
    assert.deepEqual(foldDurableRecoveryWork([goalChange("active"), malformed]), { incompleteTodo: false, activeGoal: true });
  }

  assert.deepEqual(foldDurableRecoveryWork([goalChange("active"), goalChange("blocked")]), { incompleteTodo: false, activeGoal: false });
  assert.deepEqual(foldDurableRecoveryWork([goalChange("active"), clearGoal(2)]), { incompleteTodo: false, activeGoal: false });
});

test("selectFallbackRoute skips attempted routes, honors caps, and does not mutate inputs", () => {
  const primary: DsmmRecoveryRoute = { provider: "primary", model: "a" };
  const fallbackB: DsmmRecoveryRoute = { provider: "fallback", model: "b" };
  const fallbackC: DsmmRecoveryRoute = { provider: "fallback", model: "c" };
  const attemptedRoutes = [primary];
  const fallbackRoutes = [primary, fallbackB, fallbackB, fallbackC];

  const first = selectFallbackRoute({ failedRoute: primary, attemptedRoutes, fallbackRoutes, maxFallbackAttempts: 2 });
  assert.deepEqual(first, fallbackB);
  assert.notEqual(first, fallbackB);
  assert.deepEqual(attemptedRoutes, [primary]);
  assert.deepEqual(fallbackRoutes, [primary, fallbackB, fallbackB, fallbackC]);
  assert.deepEqual(selectFallbackRoute({ failedRoute: primary, attemptedRoutes: [primary, fallbackB], fallbackRoutes, maxFallbackAttempts: 2 }), fallbackC);
  assert.equal(selectFallbackRoute({ failedRoute: primary, attemptedRoutes: [primary, fallbackB, fallbackC], fallbackRoutes, maxFallbackAttempts: 2 }), undefined);
  assert.equal(selectFallbackRoute({ failedRoute: primary, attemptedRoutes, fallbackRoutes, maxFallbackAttempts: 0 }), undefined);
  assert.deepEqual(selectFallbackRoute({
    failedRoute: primary,
    attemptedRoutes,
    fallbackRoutes: [
      { provider: " ", model: "blank-provider" },
      { provider: "blank-model", model: "\t" },
      { provider: "FaLlBaCk ", model: " c " }
    ],
    maxFallbackAttempts: 2
  }), { provider: "FaLlBaCk ", model: " c " });
});
