import assert from "node:assert/strict";
import { test } from "node:test";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type {
  AgentRequestErrorFrame,
  AgentRequestFrame,
  AgentTurnStoppingFrame,
  DshAgent,
  DshContext,
  DshEpochHeader,
  DshLlmCallConfig as NativeCallConfig,
  DshLlmFailure,
  DshRequestErrorAction,
  DshSessionEvent
} from "../lib/dsh-types.js";
import { foldAttemptedRecoveryRoutes } from "../lib/recovery-policy.js";
import { registerRuntimeRecovery } from "../lib/runtime-recovery.js";
import { DEFAULT_DSMM_SETTINGS, resolveConfig } from "../lib/settings.js";
import type { DsmmSettings } from "../lib/settings.js";
import { DeepworkModeController } from "../lib/state.js";

type DshLlmCallConfig = NativeCallConfig & Record<string, unknown>;

type RequestListener = (frame: AgentRequestFrame, next: () => Promise<DshLlmCallConfig>) => Promise<DshLlmCallConfig>;
type RequestErrorListener = (frame: AgentRequestErrorFrame, next: () => Promise<DshRequestErrorAction>) => Promise<DshRequestErrorAction>;
type TurnStoppingListener = (frame: AgentTurnStoppingFrame) => void | Promise<void>;

interface Registration {
  event: string;
  listener: (...args: any[]) => unknown;
  options: unknown;
  active: boolean;
  disposeCount: number;
}

interface MutableAgent {
  agent: DshAgent;
  readonly events: DshSessionEvent[];
  appended: number;
  requestHeaderReads: number;
  readonly steered: unknown[];
  setHeader(header: DshEpochHeader | undefined): void;
  setRequestHeader(read: () => DshEpochHeader | undefined): void;
  setPreset(agentPreset: string | undefined): void;
  setSteer(steer: ((message: unknown) => unknown | Promise<unknown>) | undefined): void;
}

interface RecoveryHarness {
  readonly context: DshContext;
  readonly warnings: string[];
  readonly registrations: Registration[];
  createAgent(events?: DshSessionEvent[], header?: DshEpochHeader): MutableAgent;
  error(frame: AgentRequestErrorFrame, next?: () => Promise<DshRequestErrorAction>): Promise<DshRequestErrorAction>;
  request(frame: AgentRequestFrame, downstream: DshLlmCallConfig): Promise<DshLlmCallConfig>;
  turn(frame: AgentTurnStoppingFrame): Promise<void>;
  dispose(): void;
}

function recoverySettings(overrides: Partial<DsmmSettings["runtimeRecovery"]> = {}): DsmmSettings {
  return {
    ...DEFAULT_DSMM_SETTINGS,
    defaultActive: true,
    runtimeRecovery: {
      ...DEFAULT_DSMM_SETTINGS.runtimeRecovery,
      enabled: true,
      fallbackRoutes: [{ provider: "fallback", model: "fallback-model" }],
      ...overrides
    }
  };
}

function continuationSettings(overrides: Partial<DsmmSettings["runtimeRecovery"]["idleContinuation"]> = {}): DsmmSettings {
  return recoverySettings({
    idleContinuation: {
      ...DEFAULT_DSMM_SETTINGS.runtimeRecovery.idleContinuation,
      enabled: true,
      ...overrides
    }
  });
}

function todoWrite(...statuses: Array<"pending" | "in_progress" | "completed">): DshSessionEvent {
  return {
    type: "todo/write",
    data: { todos: statuses.map((status, index) => ({ content: `todo-${index + 1}`, status })) }
  };
}

type GoalPhase = "active" | "paused" | "blocked" | "complete";

interface GoalChangeData extends Record<string, unknown> {
  goal: Record<string, unknown>;
}

function goalChangeData(phase: GoalPhase, objective = "durable goal"): GoalChangeData {
  const goal: Record<string, unknown> = {
    id: "goal-1",
    revision: 1,
    objective,
    phase,
    maxGoalRounds: 3
  };
  if (phase === "blocked") goal.blockedReason = { code: "waiting-on-input", message: "Waiting on input." };

  return {
    kind: "goal/change",
    version: 1,
    operation: { active: "create", paused: "pause", blocked: "block", complete: "complete" }[phase],
    goal,
    roundsStarted: 0,
    createdAt: 1,
    updatedAt: 1
  };
}

function goalChange(phase: GoalPhase, objective = "durable goal"): DshSessionEvent {
  return { type: "goal/change", data: goalChangeData(phase, objective) };
}

function malformedGoalChange(phase: GoalPhase, mutate: (data: GoalChangeData) => void): DshSessionEvent {
  const data = goalChangeData(phase);
  mutate(data);
  return { type: "goal/change", data };
}

function requestFrame(agent: DshAgent, turn = 1, step = 1): AgentRequestFrame {
  return { agent, turn, step, signal: new AbortController().signal };
}

function turnStoppingFrame(agent: DshAgent, turn = 1, signal = new AbortController().signal): AgentTurnStoppingFrame {
  return { agent, turn, signal };
}

function errorFrame(
  agent: DshAgent,
  overrides: Partial<AgentRequestErrorFrame> = {}
): AgentRequestErrorFrame {
  return {
    agent,
    turn: 1,
    step: 1,
    provider: "primary",
    failure: { message: "sensitive failure body", code: "rate_limit", status: 429 },
    retryPolicy: {},
    signal: new AbortController().signal,
    ...overrides
  };
}

function config(overrides: Partial<DshLlmCallConfig> = {}): DshLlmCallConfig {
  return { provider: "primary", model: "primary-model", ...overrides };
}

function runtimeRecoveryHarness(getSettings: () => DsmmSettings, onWarning?: (message: string) => void): RecoveryHarness {
  const warnings: string[] = [];
  const registrations: Registration[] = [];
  const effects: Array<() => void | (() => void)> = [];
  const context: DshContext = {
    on(event: string, listener: (...args: any[]) => unknown, options?: unknown) {
      const registration: Registration = { event, listener, options, active: true, disposeCount: 0 };
      registrations.push(registration);
      return () => {
        registration.disposeCount += 1;
        registration.active = false;
      };
    },
    effect(callback) {
      effects.push(callback);
    },
    logger: {
      warn(message) {
        warnings.push(message);
        onWarning?.(message);
      }
    }
  };
  const controller = new DeepworkModeController({});
  registerRuntimeRecovery(context, controller, getSettings);

  const ordered = (event: string): Registration[] => {
    const active = registrations.filter((registration) => registration.active && registration.event === event);
    return [
      ...active.filter((registration) => isPrepend(registration.options)),
      ...active.filter((registration) => !isPrepend(registration.options))
    ];
  };

  return {
    context,
    warnings,
    registrations,
    createAgent(events = [], header): MutableAgent {
      let currentHeader = header;
      let requestHeader = (): DshEpochHeader | undefined => currentHeader;
      let agentPreset: string | undefined;
      let steer: ((message: unknown) => unknown | Promise<unknown>) | undefined;
      const steered: unknown[] = [];
      const mutable: MutableAgent = {
        agent: undefined as unknown as DshAgent,
        events,
        appended: 0,
        requestHeaderReads: 0,
        steered,
        setHeader(nextHeader) {
          currentHeader = nextHeader;
          requestHeader = () => currentHeader;
        },
        setRequestHeader(read) {
          requestHeader = read;
        },
        setPreset(nextPreset) {
          agentPreset = nextPreset;
        },
        setSteer(nextSteer) {
          const appliedSteer = nextSteer;
          steer = appliedSteer;
          mutable.agent.steer = appliedSteer === undefined
            ? undefined
            : async (message) => {
              steered.push(message);
              return appliedSteer(message);
            };
        }
      };
      mutable.agent = {
        session: {
          events,
          get header() {
            return agentPreset === undefined ? undefined : { agentPreset };
          },
          requestHeader() {
            mutable.requestHeaderReads += 1;
            return requestHeader();
          },
          append() {
            mutable.appended += 1;
          }
        },
        async steer(message) {
          steered.push(message);
          return steer?.(message);
        }
      };
      return mutable;
    },
    async error(frame, next = async () => undefined) {
      const listeners = ordered("agent/request-error").map((registration) => registration.listener as RequestErrorListener);
      const invoke = async (index: number): Promise<DshRequestErrorAction> => index >= listeners.length
        ? next()
        : listeners[index](frame, () => invoke(index + 1));
      return invoke(0);
    },
    async request(frame, downstream) {
      const listeners = ordered("agent/request").map((registration) => registration.listener as RequestListener);
      const invoke = async (index: number): Promise<DshLlmCallConfig> => index >= listeners.length
        ? downstream
        : listeners[index](frame, () => invoke(index + 1));
      return invoke(0);
    },
    async turn(frame) {
      const listeners = ordered("agent/turn-stopping").map((registration) => registration.listener as TurnStoppingListener);
      for (const listener of listeners) await listener(frame);
    },
    dispose() {
      for (const effect of effects.splice(0)) {
        const cleanup = effect();
        if (typeof cleanup === "function") cleanup();
      }
    }
  };
}

function isPrepend(options: unknown): boolean {
  return typeof options === "object" && options !== null && "prepend" in options && options.prepend === true;
}

test("host retry is preserved by identity without reading DSMM fallback state", async () => {
  const harness = runtimeRecoveryHarness(() => {
    throw new Error("settings must not be read");
  });
  const agent = harness.createAgent([], { config: config() });
  agent.setRequestHeader(() => {
    throw new Error("request header must not be read");
  });
  const hostRetry = { kind: "retry" } as const;
  const downstream = config({ nested: { preserved: true } });

  assert.equal(await harness.error(errorFrame(agent.agent), async () => hostRetry), hostRetry);
  assert.equal(agent.requestHeaderReads, 0);
  assert.equal(await harness.request(requestFrame(agent.agent), downstream), downstream);
  assert.equal(harness.warnings.length, 0);
});

test("downstream request-error rejection propagates unchanged without a warning or fallback", async () => {
  const harness = runtimeRecoveryHarness(() => recoverySettings());
  const agent = harness.createAgent([], { config: config() });
  const sentinel = new Error("host failure");

  await assert.rejects(harness.error(errorFrame(agent.agent, { failure: { message: "generic", code: "SERVER", status: 503 } }), async () => {
    throw sentinel;
  }), (error) => error === sentinel);
  assert.equal(agent.requestHeaderReads, 0);
  assert.deepEqual(harness.warnings, []);
  const downstream = config();
  assert.equal(await harness.request(requestFrame(agent.agent), downstream), downstream);
});

test("disabled, aborted, out-of-scope, nonretryable, missing-header, and provider mismatch failures preserve host decline", async () => {
  const aborted = new AbortController();
  aborted.abort();
  const cases: Array<{ settings: DsmmSettings; header?: DshEpochHeader; frame?: Partial<AgentRequestErrorFrame> }> = [
    { settings: recoverySettings({ enabled: false }), header: { config: config() } },
    { settings: recoverySettings(), header: { config: config() }, frame: { signal: aborted.signal } },
    { settings: { ...recoverySettings(), defaultActive: false }, header: { config: config() } },
    { settings: recoverySettings(), header: { config: config() }, frame: { failure: { message: "ignored", code: "other", status: 418 } as DshLlmFailure } },
    { settings: recoverySettings() },
    { settings: recoverySettings(), header: { config: config({ provider: "other" }) } }
  ];

  for (const current of cases) {
    const harness = runtimeRecoveryHarness(() => current.settings);
    const agent = harness.createAgent([], current.header);
    const base = config();
    assert.equal(await harness.error(errorFrame(agent.agent, current.frame)), undefined);
    assert.equal(await harness.request(requestFrame(agent.agent), base), base);
    assert.equal(harness.warnings.length, 0);
  }
});

test("missing durable evidence for the live fallback route preserves the host decline without consuming a handoff", async () => {
  const settings = recoverySettings({ fallbackRoutes: [{ provider: "fallback", model: "d" }] });
  const harness = runtimeRecoveryHarness(() => settings);
  const agent = harness.createAgent([
    { type: "request/header", data: { reason: "initial", header: { config: config() } } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "request/header", data: { reason: "change", header: { config: { provider: "fallback", model: "b" } } } }
  ], { config: { provider: "fallback", model: "c" } });
  const downstream = config({ provider: "fallback", model: "c" });

  assert.equal(await harness.error(errorFrame(agent.agent, { provider: "fallback" })), undefined);
  assert.equal(await harness.request(requestFrame(agent.agent), downstream), downstream);
  assert.equal(await harness.request(requestFrame(agent.agent), downstream), downstream);
  assert.deepEqual(harness.warnings, []);
});

test("a durable history tail with the same provider but a different model fails open", async () => {
  const settings = recoverySettings({ fallbackRoutes: [{ provider: "fallback", model: "d" }] });
  const harness = runtimeRecoveryHarness(() => settings);
  const agent = harness.createAgent([
    { type: "request/header", data: { reason: "initial", header: { config: config() } } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "request/header", data: { reason: "change", header: { config: { provider: "fallback", model: "other-model" } } } }
  ], { config: { provider: "fallback", model: "c" } });
  const downstream = config({ provider: "fallback", model: "c" });

  assert.equal(await harness.error(errorFrame(agent.agent, { provider: "fallback" })), undefined);
  assert.equal(await harness.request(requestFrame(agent.agent), downstream), downstream);
  assert.deepEqual(harness.warnings, []);
});

test("an empty target-step route history fails open even when the live request header is usable", async () => {
  const harness = runtimeRecoveryHarness(() => recoverySettings());
  const agent = harness.createAgent([
    { type: "request/header", data: { reason: "initial", header: { config: config() } } }
  ], { config: config() });
  const downstream = config();

  assert.equal(await harness.error(errorFrame(agent.agent)), undefined);
  assert.equal(await harness.request(requestFrame(agent.agent), downstream), downstream);
  assert.deepEqual(harness.warnings, []);
});

test("malformed boundaries do not hide the exact live route from durable cap enforcement", async () => {
  const events: DshSessionEvent[] = [
    { type: "request/header", data: { reason: "initial", header: { config: { provider: "primary", model: "a" } } } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "request/header", data: { reason: "change", header: { config: { provider: "fallback", model: "b" } } } },
    { type: "step/start", data: { turn: -1, step: 1 } },
    { type: "request/header", data: { reason: "change", header: { config: { provider: "fallback", model: "c" } } } },
    { type: "step/end", data: { turn: 1, step: 1 } }
  ];
  const settings = recoverySettings({
    fallbackRoutes: [{ provider: "fallback", model: "d" }],
    maxFallbackAttempts: 2
  });
  const harness = runtimeRecoveryHarness(() => settings);
  const agent = harness.createAgent(events, { config: { provider: "fallback", model: "c" } });
  const downstream = config({ provider: "fallback", model: "c" });

  assert.deepEqual(foldAttemptedRecoveryRoutes(events, 1, 1), [
    { provider: "primary", model: "a" },
    { provider: "fallback", model: "b" },
    { provider: "fallback", model: "c" }
  ]);
  assert.equal(await harness.error(errorFrame(agent.agent, { provider: "fallback" })), undefined);
  assert.equal(await harness.request(requestFrame(agent.agent), downstream), downstream);
  assert.deepEqual(harness.warnings, []);
});

test("an active scoped current pending todo queues exactly the configured user continuation message", async () => {
  const prompt = "Continue the durable task.";
  const harness = runtimeRecoveryHarness(() => continuationSettings({ prompt }));
  const agent = harness.createAgent([
    { type: "turn/start", data: { turn: 1 } },
    todoWrite("pending")
  ]);
  agent.setRequestHeader(() => {
    throw new Error("continuation must not read provider state");
  });

  await harness.turn(turnStoppingFrame(agent.agent));

  const expected = createUserMessage({
    content: [{ type: "text", text: prompt }],
    source: { kind: "user" }
  });
  const [actual] = agent.steered as [typeof expected];
  assert.deepEqual(agent.steered, [{ ...expected, id: actual.id }]);
  assert.equal(agent.requestHeaderReads, 0);
  assert.equal(agent.appended, 0);
});

test("current pending or in-progress todos continue, while completed or preceding-turn todos do not", async () => {
  const cases: Array<{ name: string; events: DshSessionEvent[]; expected: number }> = [
    { name: "pending", events: [{ type: "turn/start", data: { turn: 1 } }, todoWrite("pending")], expected: 1 },
    { name: "in_progress", events: [{ type: "turn/start", data: { turn: 1 } }, todoWrite("in_progress")], expected: 1 },
    { name: "completed", events: [{ type: "turn/start", data: { turn: 1 } }, todoWrite("completed")], expected: 0 },
    {
      name: "preceding turn",
      events: [todoWrite("pending"), { type: "turn/start", data: { turn: 2 } }],
      expected: 0
    }
  ];

  for (const current of cases) {
    const harness = runtimeRecoveryHarness(() => continuationSettings());
    const agent = harness.createAgent(current.events);
    await harness.turn(turnStoppingFrame(agent.agent, 2));
    assert.equal(agent.steered.length, current.expected, current.name);
  }
});

test("only a latest valid active durable goal continues without a todo", async () => {
  const validClear: DshSessionEvent = {
    type: "goal/change",
    data: {
      kind: "goal/change",
      version: 1,
      operation: "clear",
      cleared: { id: "goal-1", revision: 1 },
      clearedAt: 2
    }
  };
  const cases: Array<{ name: string; events: DshSessionEvent[]; expected: number }> = [
    { name: "active", events: [goalChange("active")], expected: 1 },
    { name: "paused", events: [goalChange("paused")], expected: 0 },
    { name: "blocked", events: [goalChange("blocked")], expected: 0 },
    { name: "complete", events: [goalChange("complete")], expected: 0 },
    { name: "valid clear", events: [goalChange("active"), validClear], expected: 0 },
    { name: "malformed", events: [{ type: "goal/change", data: { kind: "goal/change", version: 1, operation: "create" } }], expected: 0 },
    { name: "absent", events: [], expected: 0 }
  ];

  for (const current of cases) {
    const harness = runtimeRecoveryHarness(() => continuationSettings());
    const agent = harness.createAgent(current.events);
    await harness.turn(turnStoppingFrame(agent.agent));
    assert.equal(agent.steered.length, current.expected, current.name);
  }
});

test("malformed latest version-1 goals never fabricate turn-stopping continuation eligibility", async () => {
  const malformedCases: Array<{ name: string; event: DshSessionEvent }> = [
    { name: "empty objective", event: malformedGoalChange("active", (data) => { data.goal.objective = ""; }) },
    { name: "unnormalized objective", event: malformedGoalChange("active", (data) => { data.goal.objective = " durable goal"; }) },
    { name: "zero maxGoalRounds", event: malformedGoalChange("active", (data) => { data.goal.maxGoalRounds = 0; }) },
    { name: "negative roundsStarted", event: malformedGoalChange("active", (data) => { data.roundsStarted = -1; }) },
    { name: "non-safe roundsStarted", event: malformedGoalChange("active", (data) => { data.roundsStarted = Number.MAX_SAFE_INTEGER + 1; }) },
    { name: "fractional roundsStarted", event: malformedGoalChange("active", (data) => { data.roundsStarted = 0.5; }) },
    { name: "negative createdAt", event: malformedGoalChange("active", (data) => { data.createdAt = -1; }) },
    { name: "non-safe createdAt", event: malformedGoalChange("active", (data) => { data.createdAt = Number.MAX_SAFE_INTEGER + 1; }) },
    { name: "fractional createdAt", event: malformedGoalChange("active", (data) => { data.createdAt = 0.5; }) },
    { name: "negative updatedAt", event: malformedGoalChange("active", (data) => { data.updatedAt = -1; }) },
    { name: "non-safe updatedAt", event: malformedGoalChange("active", (data) => { data.updatedAt = Number.MAX_SAFE_INTEGER + 1; }) },
    { name: "fractional updatedAt", event: malformedGoalChange("active", (data) => { data.updatedAt = 0.5; }) },
    { name: "updatedAt before createdAt", event: malformedGoalChange("active", (data) => { data.createdAt = 2; data.updatedAt = 1; }) },
    { name: "active goal extra key", event: malformedGoalChange("active", (data) => { data.goal.extra = true; }) },
    { name: "active goal blockedReason", event: malformedGoalChange("active", (data) => { data.goal.blockedReason = { code: "waiting-on-input", message: "Waiting on input." }; }) },
    { name: "blocked goal missing reason", event: malformedGoalChange("blocked", (data) => { delete data.goal.blockedReason; }) },
    { name: "blocked goal invalid reason", event: malformedGoalChange("blocked", (data) => { data.goal.blockedReason = { code: "UPPERCASE", message: "Waiting on input." }; }) }
  ];

  for (const current of malformedCases) {
    const harness = runtimeRecoveryHarness(() => continuationSettings());
    const agent = harness.createAgent([current.event]);
    await harness.turn(turnStoppingFrame(agent.agent));
    assert.equal(agent.steered.length, 0, current.name);
    assert.deepEqual(harness.warnings, [], current.name);
  }

  const malformedClear: DshSessionEvent = {
    type: "goal/change",
    data: {
      kind: "goal/change",
      version: 1,
      operation: "clear",
      cleared: { id: "goal-1", revision: 1, extra: true },
      clearedAt: 2
    }
  };
  for (const current of [
    { name: "active remains authoritative", events: [goalChange("active"), malformedClear], expected: 1 },
    { name: "inactive remains authoritative", events: [goalChange("paused"), malformedClear], expected: 0 }
  ]) {
    const harness = runtimeRecoveryHarness(() => continuationSettings());
    const agent = harness.createAgent(current.events);
    await harness.turn(turnStoppingFrame(agent.agent));
    assert.equal(agent.steered.length, current.expected, current.name);
    assert.deepEqual(harness.warnings, [], current.name);
  }
});

test("selected DSMM presets are continuation-scoped even when ordinary deepwork mode is inactive", async () => {
  const settings = { ...continuationSettings(), defaultActive: false };
  const selectedHarness = runtimeRecoveryHarness(() => settings);
  const selected = selectedHarness.createAgent([goalChange("active")]);
  selected.setPreset("dsmm-orchestrator");
  await selectedHarness.turn(turnStoppingFrame(selected.agent));
  assert.equal(selected.steered.length, 1);

  const ordinaryHarness = runtimeRecoveryHarness(() => settings);
  const ordinary = ordinaryHarness.createAgent([goalChange("active")]);
  ordinary.setPreset("ordinary-agent");
  await ordinaryHarness.turn(turnStoppingFrame(ordinary.agent));
  assert.equal(ordinary.steered.length, 0);
});

test("disabled recovery, disabled continuation, aborted turns, absent steer, and cap zero do not continue", async () => {
  const aborted = new AbortController();
  aborted.abort();
  const enabled = continuationSettings();
  const cases: Array<{ name: string; settings: DsmmSettings; signal?: AbortSignal; withoutSteer?: boolean }> = [
    {
      name: "recovery disabled",
      settings: { ...enabled, runtimeRecovery: { ...enabled.runtimeRecovery, enabled: false } }
    },
    {
      name: "continuation disabled",
      settings: recoverySettings()
    },
    { name: "aborted", settings: enabled, signal: aborted.signal },
    { name: "missing steer", settings: enabled, withoutSteer: true },
    { name: "cap zero", settings: continuationSettings({ maxContinuations: 0 }) }
  ];

  for (const current of cases) {
    const harness = runtimeRecoveryHarness(() => current.settings);
    const agent = harness.createAgent([goalChange("active")]);
    if (current.withoutSteer) agent.setSteer(undefined);
    await harness.turn(turnStoppingFrame(agent.agent, 1, current.signal));
    assert.equal(agent.steered.length, 0, current.name);
    assert.deepEqual(harness.warnings, [], current.name);
  }
});

test("continuations are capped per agent per turn and each new turn receives a fresh cap", async () => {
  const harness = runtimeRecoveryHarness(() => continuationSettings({ maxContinuations: 2 }));
  const agent = harness.createAgent([goalChange("active")]);

  await harness.turn(turnStoppingFrame(agent.agent, 7));
  await harness.turn(turnStoppingFrame(agent.agent, 7));
  await harness.turn(turnStoppingFrame(agent.agent, 7));
  assert.equal(agent.steered.length, 2);

  await harness.turn(turnStoppingFrame(agent.agent, 8));
  await harness.turn(turnStoppingFrame(agent.agent, 8));
  await harness.turn(turnStoppingFrame(agent.agent, 8));
  assert.equal(agent.steered.length, 4);
});

test("continuation evaluation failures resolve normally with one fixed sanitized warning", async () => {
  const settingsSecret = "settings-provider-body-secret";
  const settings = continuationSettings({ maxContinuations: 1 });
  let settingsReads = 0;
  const settingsHarness = runtimeRecoveryHarness(() => {
    settingsReads += 1;
    if (settingsReads === 1) throw new Error(settingsSecret);
    return settings;
  });
  const settingsAgent = settingsHarness.createAgent([goalChange("active")]);

  await assert.doesNotReject(settingsHarness.turn(turnStoppingFrame(settingsAgent.agent, 4)));
  assert.equal(settingsAgent.steered.length, 0);
  assert.deepEqual(settingsHarness.warnings, ["dsmm runtime recovery continuation steering failed for turn 4"]);
  assert.equal(settingsHarness.warnings[0]?.includes(settingsSecret), false);
  await assert.doesNotReject(settingsHarness.turn(turnStoppingFrame(settingsAgent.agent, 4)));
  assert.equal(settingsAgent.steered.length, 1);
  assert.deepEqual(settingsHarness.warnings, ["dsmm runtime recovery continuation steering failed for turn 4"]);

  const eventsSecret = "durable-goal-secret";
  const eventsHarness = runtimeRecoveryHarness(() => continuationSettings());
  const eventsAgent = eventsHarness.createAgent([goalChange("active", eventsSecret)]);
  let eventReads = 0;
  Object.defineProperty(eventsAgent.agent.session, "events", {
    get() {
      eventReads += 1;
      if (eventReads === 1) return [];
      throw new Error(eventsSecret);
    }
  });

  await assert.doesNotReject(eventsHarness.turn(turnStoppingFrame(eventsAgent.agent, 5)));
  assert.equal(eventsAgent.steered.length, 0);
  assert.equal(eventReads, 2);
  assert.deepEqual(eventsHarness.warnings, ["dsmm runtime recovery continuation steering failed for turn 5"]);
  assert.equal(eventsHarness.warnings[0]?.includes(eventsSecret), false);
});

test("a throwing continuation logger cannot reject evaluation or reserved steer failures", async () => {
  let evaluationWarnings = 0;
  const evaluationHarness = runtimeRecoveryHarness(() => {
    throw new Error("evaluation-secret");
  });
  evaluationHarness.context.logger = {
    warn() {
      evaluationWarnings += 1;
      throw new Error("logger-secret");
    }
  };

  await assert.doesNotReject(evaluationHarness.turn(turnStoppingFrame(evaluationHarness.createAgent([goalChange("active")]).agent, 6)));
  assert.equal(evaluationWarnings, 1);

  let steerWarnings = 0;
  const steerHarness = runtimeRecoveryHarness(() => continuationSettings({ maxContinuations: 1 }));
  steerHarness.context.logger = {
    warn() {
      steerWarnings += 1;
      throw new Error("logger-secret");
    }
  };
  const steerAgent = steerHarness.createAgent([goalChange("active")]);
  steerAgent.setSteer(async () => {
    throw new Error("steer-secret");
  });

  await assert.doesNotReject(steerHarness.turn(turnStoppingFrame(steerAgent.agent, 7)));
  await assert.doesNotReject(steerHarness.turn(turnStoppingFrame(steerAgent.agent, 7)));
  assert.equal(steerAgent.steered.length, 1);
  assert.equal(steerWarnings, 1);
});

test("a rejected steer consumes its attempt and logs only a sanitized turn warning", async () => {
  const prompt = "prompt-and-todo-secret";
  const steerError = new Error("provider-body-and-credential-secret");
  const todoContent = "todo-content-secret";
  const goalContent = "goal-content-secret";
  const harness = runtimeRecoveryHarness(() => continuationSettings({ maxContinuations: 1, prompt }));
  const agent = harness.createAgent([
    { type: "turn/start", data: { turn: 3 } },
    { type: "todo/write", data: { todos: [{ content: todoContent, status: "pending" }] } },
    goalChange("active", goalContent)
  ]);
  agent.setSteer(async () => {
    throw steerError;
  });

  await assert.doesNotReject(harness.turn(turnStoppingFrame(agent.agent, 3)));
  await harness.turn(turnStoppingFrame(agent.agent, 3));

  assert.equal(agent.steered.length, 1);
  assert.deepEqual(harness.warnings, ["dsmm runtime recovery continuation steering failed for turn 3"]);
  for (const secret of [prompt, steerError.message, todoContent, goalContent, "credential", "provider-body"]) {
    assert.equal(harness.warnings[0]?.includes(secret), false);
  }
});

test("a throwing continuation warning sink does not reject turn stopping", async () => {
  const warningSentinel = new Error("warning sink failed");
  const harness = runtimeRecoveryHarness(() => continuationSettings(), () => {
    throw warningSentinel;
  });
  const agent = harness.createAgent([goalChange("active")]);
  agent.setSteer(async () => {
    throw new Error("steer failed");
  });

  await assert.doesNotReject(harness.turn(turnStoppingFrame(agent.agent, 4)));
  assert.deepEqual(harness.warnings, ["dsmm runtime recovery continuation steering failed for turn 4"]);
});

test("registration is idempotent, cleanup disposes all four listeners, and replacement resets pending and continuation state", async () => {
  const harness = runtimeRecoveryHarness(() => recoverySettings());
  const settings = continuationSettings({ maxContinuations: 1 });
  harness.dispose();
  registerRuntimeRecovery(harness.context, new DeepworkModeController({}), () => settings);
  registerRuntimeRecovery(harness.context, new DeepworkModeController({}), () => settings);
  assert.deepEqual(harness.registrations.filter((registration) => registration.active).map((registration) => [registration.event, registration.options]), [
    ["agent/assistant-stream", { prepend: true }],
    ["agent/request", { prepend: true }],
    ["agent/request-error", { prepend: true }],
    ["agent/turn-stopping", undefined]
  ]);

  const agent = harness.createAgent([
    { type: "request/header", data: { reason: "initial", header: { config: config() } } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    goalChange("active")
  ], { config: config() });
  assert.equal(await harness.error(errorFrame(agent.agent)), undefined);
  await harness.turn(turnStoppingFrame(agent.agent));
  assert.equal(agent.steered.length, 1);

  harness.dispose();
  assert.equal(harness.registrations.some((registration) => registration.active), false);
  assert.deepEqual(harness.registrations.map((registration) => registration.disposeCount), [1, 1, 1, 1, 1, 1, 1, 1]);
  registerRuntimeRecovery(harness.context, new DeepworkModeController({}), () => settings);
  assert.equal(harness.registrations.filter((registration) => registration.active).length, 4);
  const base = config();
  assert.equal(await harness.request(requestFrame(agent.agent), base), base);
  await harness.turn(turnStoppingFrame(agent.agent));
  assert.equal(agent.steered.length, 2);
  assert.equal(agent.appended, 0);
  assert.equal(harness.registrations.some((registration) => registration.event === "subagent/end"), false);
});

test("every listener and effect registration failure rolls back prior listeners and permits replacement", () => {
  for (const failureBoundary of ["agent/assistant-stream", "agent/request", "agent/request-error", "agent/turn-stopping", "effect"] as const) {
    const registrations: Registration[] = [];
    const sentinel = new Error(`${failureBoundary} failed`);
    let fail = true;
    const context: DshContext = {
      on(event: string, listener: (...args: any[]) => unknown, options?: unknown) {
        if (fail && event === failureBoundary) throw sentinel;
        const registration: Registration = { event, listener, options, active: true, disposeCount: 0 };
        registrations.push(registration);
        return () => {
          registration.disposeCount += 1;
          registration.active = false;
        };
      },
      effect() {
        if (fail && failureBoundary === "effect") throw sentinel;
      }
    };

    assert.throws(() => registerRuntimeRecovery(context, new DeepworkModeController({}), () => continuationSettings()), (error) => error === sentinel, failureBoundary);
    assert.equal(registrations.some((registration) => registration.active), false, failureBoundary);
    assert.deepEqual(registrations.map((registration) => registration.disposeCount), registrations.map(() => 1), failureBoundary);
    fail = false;
    assert.doesNotThrow(() => registerRuntimeRecovery(context, new DeepworkModeController({}), () => continuationSettings()), failureBoundary);
    assert.deepEqual(registrations.filter((registration) => registration.active).map((registration) => [registration.event, registration.options]), [
      ["agent/assistant-stream", { prepend: true }],
      ["agent/request", { prepend: true }],
      ["agent/request-error", { prepend: true }],
      ["agent/turn-stopping", undefined]
    ], failureBoundary);
  }
});


test("headers alone never prove a no-output attempt, even for explicit rollover and duplicate RATE_LIMIT delivery", async () => {
  const settings = resolveConfig({ defaultActive: true, roleRouting: {
    "dsmm-reviewer": { strategy: "rate-limit-fallback", fallbackRoutes: [{ provider: "review", model: "backup", reasoningEffort: "max" }], rateLimit: { switchAfterRateLimits: 1 } },
    "dsmm-oracle": { strategy: "startup-lock", fallbackRoutes: [{ provider: "oracle", model: "backup" }] }
  } });
  const harness = runtimeRecoveryHarness(() => settings);
  for (const preset of ["dsmm-reviewer", "dsmm-oracle"]) {
    const agent = harness.createAgent([
      { type: "request/header", data: { reason: "initial", header: { config: config() } } },
      { type: "step/start", data: { turn: 1, step: 1 } }
    ], { config: config() });
    agent.setPreset(preset);
    let hostCalls = 0;
    const hostAlways = async () => { hostCalls++; return { kind: "retry" } as const; };
    assert.equal(await harness.error(errorFrame(agent.agent), hostAlways), undefined);
    assert.equal(await harness.error(errorFrame(agent.agent), hostAlways), undefined);
    assert.equal(hostCalls, 0);
    const downstream = config({ reasoningEffort: "low", nested: { preserved: true } });
    assert.equal(await harness.request(requestFrame(agent.agent), downstream), downstream);
    assert.equal(agent.appended, 0);
  }
});
