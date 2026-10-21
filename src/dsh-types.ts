import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent-preset-registry";
import type {} from "@deepseek-ai/dsh-skill-filesystem";

export interface DshSessionEvent {
  type: string;
  data?: unknown;
}

export interface DshSessionHeader {
  cwd?: string;
  agentPreset?: string;
  origin?: string;
  parentSession?: string;
  delegationDepth?: number;
}

export interface DshSession {
  readonly id?: string;
  inheritedEventCount?: number;
  events?: readonly DshSessionEvent[];
  snapshotEvents?(): readonly DshSessionEvent[];
  header?: DshSessionHeader;
  requestHeader?(): DshEpochHeader | undefined;
  append(type: "deepwork/mode", payload: { active: boolean }): unknown | Promise<unknown>;
  append(type: "dsmm/role-policy", payload: import("./dsh-events.js").DsmmRolePolicyEventData): unknown | Promise<unknown>;
}

export interface DshAgent {
  id?: string;
  ctx?: DshContext;
  session: DshSession;
  readonly status?: "idle" | "running";
  /** Public native reservation: throws synchronously unless truly idle. */
  runMaintenance?<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
  options?: { provider?: string; model?: string; reasoningEffort?: string };
  steer?(message: unknown): unknown | Promise<unknown>;
  inject?(message: unknown): unknown | Promise<unknown>;
}

export interface DshAgentsRegistry {
  get(id: string): DshAgent | undefined;
  list(): DshAgent[];
  roots(): DshAgent[];
  isOwnedBy(id: string, owner: DshAgent): boolean;
}

export interface DshAgentCreatedFrame {
  agent: DshAgent;
  source: "startup" | "resume" | "clear" | "compact";
  signal?: AbortSignal;
}

export type DshLlmCallConfig = {
  provider: string;
  model: string;
  reasoningEffort?: string;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
};

export interface DshLlmFailure {
  readonly message: string;
  readonly code: string;
  readonly status?: number;
  readonly providerRetryAfterMs?: number;
  readonly requestId?: unknown;
}

export interface DshEpochHeader {
  config: DshLlmCallConfig;
}

export interface DshReasoningEffortInfo {
  id: string;
  name: string;
}

export interface DshModelReasoningInfo {
  efforts: readonly DshReasoningEffortInfo[];
  defaultEffort?: string;
}

export interface DshResolvedModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning?: DshModelReasoningInfo;
}

export interface DshLlmRuntime {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<DshResolvedModelInfo>;
  resolveCallConfig?(config: DshLlmCallConfig, signal?: AbortSignal): Promise<DshLlmCallConfig>;
  listProviders?(): readonly { id: string }[];
}

export interface AgentRequestFrame {
  agent: DshAgent;
  turn: number;
  step: number;
  signal: AbortSignal;
}

export interface AgentRequestErrorFrame {
  agent: DshAgent;
  turn: number;
  step: number;
  provider: string;
  failure: DshLlmFailure;
  retryPolicy: unknown;
  signal: AbortSignal;
}

export type DshRequestErrorAction = { kind: "retry" } | undefined;

export interface AgentTurnStoppingFrame {
  agent: DshAgent;
  turn: number;
  signal: AbortSignal;
}

export interface DshStepBoundaryEventData {
  turn: number;
  step: number;
}

export interface DshRequestHeaderEventData {
  header: DshEpochHeader;
  reason: "initial" | "resume" | "change" | "series";
}

export interface DshTodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface DshTodoWriteEventData {
  todos: DshTodoItem[];
}

export interface DshGoalSnapshot {
  id: string;
  revision: number;
  objective: string;
  phase: "active" | "paused" | "blocked" | "complete";
  blockedReason?: { code: string; message: string };
  maxGoalRounds: number;
}

export type DshGoalChangeEventData =
  | {
      kind: "goal/change";
      version: 1;
      operation: "create" | "edit" | "pause" | "resume" | "complete" | "block";
      goal: DshGoalSnapshot;
      roundsStarted: number;
      createdAt: number;
      updatedAt: number;
    }
  | {
      kind: "goal/change";
      version: 1;
      operation: "clear";
      cleared: { id: string; revision: number };
      clearedAt: number;
    };

type NativePromptRegistry = Context["systemPrompt"];
export type DshSystemPromptContext = Pick<NonNullable<Parameters<NativePromptRegistry["assemble"]>[0]>, "scope" | "signal">;

export type DshSystemPromptSection = Omit<Parameters<NativePromptRegistry["section"]>[0], "text"> & {
  text(context: DshSystemPromptContext): string;
};

export interface DshSystemPromptRegistry {
  section(section: DshSystemPromptSection): ReturnType<NativePromptRegistry["section"]>;
}

export interface DshCommandInvocation {
  agent: DshAgent;
  rawInput: string;
  attachments?: readonly unknown[];
  signal?: AbortSignal;
}

export interface DshCommandResult {
  kind: "success" | "error";
  text?: string;
}

export interface DshCommandsRegistry {
  register(command: {
    name: string;
    description: string;
    input?: { hint: string; images?: boolean };
    handler(invocation: DshCommandInvocation): DshCommandResult | Promise<DshCommandResult>;
  }): unknown;
}

export type DshSkillRegistry = Pick<Context["skills"], "registerProvider" | "snapshot" | "list" | "get">;
export type DshSkillRegistration = NonNullable<Awaited<ReturnType<DshSkillRegistry["get"]>>>;
export type DshSkillProvider = ReturnType<Parameters<DshSkillRegistry["registerProvider"]>[0]>;
export type DshSkillCandidate = Parameters<DshSkillProvider["get"]>[0];
export type DshSkillLookupOptions = Parameters<DshSkillProvider["list"]>[0];

export interface DshContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface DshToolExecution {
  callId?: unknown;
  rootCallId?: unknown;
  name: string;
  arguments: unknown;
  agent?: DshAgent;
  parent?: unknown;
  signal?: AbortSignal;
}

export type DshPreToolDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason?: string }
  | { kind: "cancel" };

export type DshPostToolDecision =
  | { kind: "accept"; content?: DshContentBlock[]; value?: never; additionalContexts?: unknown[] }
  | { kind: "accept"; value: unknown; content?: never; additionalContexts?: unknown[] }
  | { kind: "block"; feedback: DshContentBlock[]; additionalContexts?: unknown[] };

export interface DshToolExecutionResult {
  isError: boolean;
  content: DshContentBlock[];
  value?: unknown;
  error?: unknown;
  additionalContexts?: unknown[];
}

export interface DshToolRuntime {
  guard?(guard: (execution: Readonly<DshToolExecution>) => string | undefined): () => void;
  get?(name: string): unknown;
}

export type DshEventListener = (...args: any[]) => any;

export interface PreStepFrame {
  agent: DshAgent;
  signal: AbortSignal;
}

export interface PreStepDecision {
  kind: string;
  messages?: readonly unknown[];
  [key: string]: unknown;
}

export interface DshContext {
  agents?: DshAgentsRegistry;
  subagents?: import("./role-providers.js").DsmmSubagentRegistry;
  systemPrompt?: DshSystemPromptRegistry;
  skills?: DshSkillRegistry;
  commands?: DshCommandsRegistry;
  tools?: DshToolRuntime;
  llm?: DshLlmRuntime;
  dsmmNativeAdmission?: import("./native-admission.js").NativeAdmission;
  get?<T = unknown>(name: string): T | undefined;
  provide?(name: string, service: unknown): unknown;
  plugin?(plugin: unknown, config?: unknown): PromiseLike<unknown>;
  inject?(dependencies: string[], installer: (readyCtx: DshContext) => unknown): unknown;
  effect?(callback: () => () => void): unknown;
  on?(event: "agent/request", listener: (frame: AgentRequestFrame, next: () => Promise<DshLlmCallConfig>) => Promise<DshLlmCallConfig>, options?: boolean | { prepend?: boolean; global?: boolean }): unknown;
  on?(event: "agent/request-error", listener: (frame: AgentRequestErrorFrame, next: () => Promise<DshRequestErrorAction>) => Promise<DshRequestErrorAction>, options?: boolean | { prepend?: boolean; global?: boolean }): unknown;
  on?(event: "agent/turn-stopping", listener: (frame: AgentTurnStoppingFrame) => void | Promise<void>, options?: boolean | { prepend?: boolean; global?: boolean }): unknown;
  on?(event: "agent/pre-step", listener: (frame: PreStepFrame, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>, options?: unknown): unknown;
  on?(event: string, listener: DshEventListener, options?: unknown): unknown;
  logger?: { warn(message: string, ...args: unknown[]): void };
}
