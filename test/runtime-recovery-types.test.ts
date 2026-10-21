import assert from "node:assert/strict";
import { test } from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
  AgentRequestErrorFrame,
  AgentTurnStoppingFrame,
  DshAgent,
  DshContext,
  DshEpochHeader,
  DshGoalChangeEventData,
  DshLlmFailure,
  DshRequestErrorAction,
  DshRequestHeaderEventData,
  DshSession,
  DshSessionEvent,
  DshStepBoundaryEventData,
  DshTodoWriteEventData
} from "../src/dsh-types.js";

test("recovery types match the pinned DSH rc.2 structural contracts", async () => {
  const nativeAgentCompatible: Agent extends DshAgent ? true : false = true;
  const nativeContextCompatible: Context extends DshContext ? true : false = true;
  assert.equal(nativeAgentCompatible, true);
  assert.equal(nativeContextCompatible, true);
  const stepBoundary = { turn: 4, step: 2 } satisfies DshStepBoundaryEventData;
  const header = {
    config: { provider: "primary", model: "primary-model", reasoningEffort: "high" }
  } satisfies DshEpochHeader;
  const requestHeader = { header, reason: "initial" } satisfies DshRequestHeaderEventData;
  const todoWrite = {
    todos: [{ content: "Ship v0.7", status: "in_progress" }]
  } satisfies DshTodoWriteEventData;
  const goalChange = {
    kind: "goal/change",
    version: 1,
    operation: "create",
    goal: {
      id: "goal-1",
      revision: 1,
      objective: "Ship v0.7",
      phase: "active",
      maxGoalRounds: 5
    },
    roundsStarted: 0,
    createdAt: 1,
    updatedAt: 1
  } satisfies DshGoalChangeEventData;
  const events = [
    { type: "turn/start", data: { turn: 4 } },
    { type: "step/start", data: stepBoundary },
    { type: "request/header", data: requestHeader },
    { type: "todo/write", data: todoWrite },
    { type: "goal/change", data: goalChange },
    { type: "step/end", data: stepBoundary }
  ] satisfies DshSessionEvent[];
  const session: DshSession = {
    events,
    requestHeader() {
      return header;
    },
    append() {}
  };
  const agent: DshAgent = { session };
  const failure = {
    message: "sensitive provider body",
    code: "rate_limit",
    status: 429,
    providerRetryAfterMs: 250
  } satisfies DshLlmFailure;
  const requestErrorFrame: AgentRequestErrorFrame = {
    agent,
    turn: 4,
    step: 2,
    provider: "primary",
    failure,
    retryPolicy: {},
    signal: new AbortController().signal
  };
  const turnStoppingFrame: AgentTurnStoppingFrame = {
    agent,
    turn: 4,
    signal: new AbortController().signal
  };
  const hostRetry = { kind: "retry" } as const;
  const requestErrorListener = async (
    frame: AgentRequestErrorFrame,
    next: () => Promise<DshRequestErrorAction>
  ): Promise<DshRequestErrorAction> => {
    assert.equal(frame, requestErrorFrame);
    await next();
    return hostRetry;
  };
  const turnStoppingListener = async (frame: AgentTurnStoppingFrame): Promise<void> => {
    assert.equal(frame, turnStoppingFrame);
  };
  const registrations: string[] = [];
  const context: DshContext = {
    on(event, _listener, _options) {
      registrations.push(event);
    }
  };

  context.on?.("agent/request-error", requestErrorListener, { prepend: true, global: true });
  context.on?.("agent/turn-stopping", turnStoppingListener, { prepend: true, global: true });

  assert.equal(session.events?.[1]?.data, stepBoundary);
  assert.equal(session.events?.[2]?.data, requestHeader);
  assert.equal(session.events?.[3]?.data, todoWrite);
  assert.equal(session.events?.[4]?.data, goalChange);
  assert.equal(session.requestHeader?.(), header);
  assert.equal(requestErrorFrame.failure, failure);
  assert.equal(requestErrorFrame.failure.message, "sensitive provider body");
  assert.equal(requestErrorFrame.failure.status, 429);
  assert.equal(requestErrorFrame.failure.providerRetryAfterMs, 250);
  assert.equal(await requestErrorListener(requestErrorFrame, async () => undefined), hostRetry);
  assert.equal(await turnStoppingListener(turnStoppingFrame), undefined);
  assert.deepEqual(registrations, ["agent/request-error", "agent/turn-stopping"]);
});
