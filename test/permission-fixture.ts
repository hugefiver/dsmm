import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { LlmRuntime, ToolCallId } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import * as Connection from "@deepseek-ai/dsh-client-connection";
import type { PermissionExecutionAuthority, PermissionControl } from "../src/permission-control.ts";
import { registerPermissionControlRpc } from "../src/permission-rpc.ts";
import { PermissionRulesRuntimeSync } from "../src/permission-rules.ts";
import type { PermissionRulesBackend } from "../src/permission-rules.ts";
import { resolvePermissionControl } from "../src/permission-settings.ts";
import type { PermissionControlSchemaInput } from "../src/permission-settings.ts";
import { installPermissionController } from "../src/permission-controller.ts";
import * as ManagedPwsh from "../src/permission-pwsh.ts";
import * as ManagedBash from "../src/permission-bash.ts";

const sdk = createRequire(createRequire(import.meta.url).resolve("@deepseek-ai/dsh-tools"));
const { ApprovalService, setApprovalPolicy } = await import(pathToFileURL(sdk.resolve("@deepseek-ai/dsh-user-approval")).href);
const connectionSdk = createRequire(createRequire(import.meta.url).resolve("@deepseek-ai/dsh-client-connection"));
const { CredentialProvider } = await import(pathToFileURL(connectionSdk.resolve("@deepseek-ai/dsh-credentials")).href);
const native = createRequire(process.env.DSMM_TEST_DSH_ENTRY ?? import.meta.url);
const { RemoteAccessService } = await import(pathToFileURL(native.resolve("@deepseek-ai/dsh-api-remote-access")).href);
const FileSystem = await import(pathToFileURL(native.resolve("@deepseek-ai/dsh-fs-local")).href);
const WorkingDirectory = await import(pathToFileURL(native.resolve("@deepseek-ai/dsh-working-directory")).href);

export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type ApprovalRequest = Parameters<Context["approval"]["request"]>[0];
type ApprovalOutcome = Awaited<ReturnType<Context["approval"]["request"]>>;
export interface PermissionFixture {
  ctx: Context;
  root: Agent;
  controller: ReturnType<typeof installPermissionController>;
  sync: PermissionRulesRuntimeSync;
  authorities: WeakMap<Agent, PermissionExecutionAuthority>;
  lifetime: AbortController;
  owner: object;
  realm: object;
  runtime: Context["tools"];
  permissions: PermissionControl;
  specs: Record<string, unknown>[];
  requests: ApprovalRequest[];
  invoke(method: string, args: Record<string, unknown>, peer?: Context["connection"]["browserPeer"], signal?: AbortSignal): ReturnType<Context["typertGateway"]["invoke"]>;
  update(policy: PermissionControlSchemaInput): ReturnType<PermissionRulesRuntimeSync["commit"]>;
  create(parent?: Agent): Promise<Agent>;
  starts(): number;
  nativeAnswers(): number;
  execute(command: string, extra?: Record<string, unknown>, signal?: AbortSignal,
    callId?: Parameters<Context["tools"]["execute"]>[0]["callId"], agent?: Agent, kind?: string): ReturnType<Context["tools"]["execute"]>;
  mountManagedShell(kind?: "pwsh" | "bash", config?: { enableRunInBackground: boolean; promoteOnTimeout: boolean }, scope?: Context): Promise<Context["fiber"]>;
  setOutcome(value: ApprovalOutcome): void;
  setAnswer(value: ((request: ApprovalRequest) => Promise<ApprovalOutcome>) | undefined): void;
  setPureDenied(value: boolean): void;
  setPolicy(policy: "ask" | "never", agent?: Agent): void;
  replaceConnection(): Promise<void>;
  replaceApproval(policy: "ask" | "never"): Promise<void>;
  disposeAgent(agent: Agent): Promise<void>;
  dispose(): Promise<void>;
}

/** Source-backed native ToolRuntime fixture. Shell execution is counted, not confinement proof. */
export async function permissionFixture(_timeoutMs = 2000, options: {
  mode?: "native" | "ptc"; settings?: PermissionControlSchemaInput;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  shellExecution?(spec: Record<string, unknown>): Promise<void>;
  rules?(permissions: PermissionControl, ctx: Context): { backend: PermissionRulesBackend; runtime: PermissionRulesRuntimeSync };
} = {}): Promise<PermissionFixture> {
  const ctx = new Context(), handles: AgentHandle[] = [], lifetime = new AbortController();
  const authorities = new WeakMap<Agent, PermissionExecutionAuthority>(), owner = {}, realm = {};
  let starts = 0, nativeAnswers = 0, pureDenied = false;
  let outcome: "allowed-once" | "rejected" | "cancelled" | "unavailable" = "allowed-once";
  let answer: ((request: Parameters<Context["approval"]["request"]>[0]) => Promise<typeof outcome>) | undefined;
  const specs: Record<string, unknown>[] = [], requests: Parameters<Context["approval"]["request"]>[0][] = [];
  let approvalFiber: Context["fiber"];
  class MemoryCredentials extends CredentialProvider {
    async modifyRecord(_key: string, modify: (value: unknown) => Promise<unknown>) { return modify(undefined); }
  }
  try {
    await ctx.plugin(RemoteAccessService).await();
    for (const [plugin, config] of [[AgentRegistry], [SessionStore], [SessionProjectionRegistry], [LlmRuntime], [SystemPrompt, {}], [ToolRuntime, { mode: options.mode ?? "native" }], [ApprovalService, { policy: "ask" }], [TypertRegistry], [TypertGatewayService, {}], [MemoryCredentials]] as const) { const fiber = ctx.plugin(plugin as never, config as never); await fiber.await(); if (plugin === ApprovalService) approvalFiber = fiber; }
    await ctx.plugin(FileSystem.default, { cwd: process.cwd() }).await();
    await ctx.plugin(WorkingDirectory.default, { defaultDirectory: process.cwd() }).await();
    let connectionFiber = ctx.plugin(Connection); await connectionFiber.await();
    ctx.provide("shellEnv", { collect() { return {}; } });
    ctx.provide("sandboxPolicy", { resolve() { return { mode: options.sandboxMode ?? "workspace-write", workspaceRoot: process.cwd() }; } });
    ctx.provide("shell", { sandboxMode: options.sandboxMode ?? "workspace-write", resolve(request: Record<string, unknown>) { return { timeoutMs: 1000, ...request }; },
      async execute(spec: Record<string, unknown>) { (spec.signal as AbortSignal | undefined)?.throwIfAborted(); starts++; specs.push(spec); if (options.shellExecution !== undefined) await options.shellExecution(spec); return { result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000, stdout: { text: "owned counted shell", truncated: false }, stderr: { text: "", truncated: false } }) }; } });
    ctx.on("approval/request", async request => { nativeAnswers++; requests.push(request); return answer === undefined ? outcome : answer(request); }, { global: true });
    const sync = new PermissionRulesRuntimeSync({ revision: "source:initial", policy: resolvePermissionControl(options.settings) }, () => controller?.permissions.revokePolicy());
    const controller = installPermissionController(ctx, { rules: sync, authority: {
      current(exec) { const value = exec.agent === undefined ? undefined : authorities.get(exec.agent); if (value === undefined) throw new Error("No actual fixture agent"); return value; },
      assertCurrent() { if (pureDenied) throw new Error("Owned absolute readonly/role restriction"); },
    }, shellIdentity(_scope, kind) { return { executable: kind === "pwsh" ? "pwsh.exe" : "bash", dialect: kind === "pwsh" ? "powershell" : "posix", commandField: "command", cwdField: "workdir" }; } });
    await ctx.plugin(AgentLoop, {}).await();
    const create = async (parent?: Agent) => {
      const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), ...parent === undefined ? {} : { parentAgent: parent }, meta: { cwd: process.cwd() }, agentOptions: { provider: "unused-local", model: "unused-local" } });
      handles.push(handle); const agent = handle.agent;
      authorities.set(agent, { agent, root: parent ?? agent, owner, realm, ownerGeneration: 1, admissionRevision: "owned-admission", permissionRevision: "owned-policy", signal: lifetime.signal });
      agent.session.append("turn/start", { turn: 1 }); return agent;
    };
    const root = await create();
    const externalRules = options.rules?.(controller.permissions, ctx);
    const rpc = ctx.plugin({ name: "owned-permission-rules-rpc", inject: ["typert", "connection"], apply(scope: Context) { if (externalRules !== undefined) registerPermissionControlRpc(scope, externalRules); } }); await rpc.await();
    const invoke = (method: string, args: Record<string, unknown>, peer = ctx.connection.browserPeer, signal?: AbortSignal) => ctx.typertGateway.invoke({ namespace: "dsmmPermissions", method, args, peer, ...signal === undefined ? {} : { signal } });
    const update = async (policy: PermissionControlSchemaInput) => { const ticket = sync.begin(sync.status().savedRevision); return sync.commit(ticket, { revision: randomUUID(), policy: resolvePermissionControl(policy) }, async () => {}); };
    return { ctx, root, controller, sync, authorities, lifetime, owner, realm, invoke, update, create,
      runtime: ctx.tools, permissions: controller.permissions, starts: () => starts, nativeAnswers: () => nativeAnswers, specs, requests,
      execute(command: string, extra: Record<string, unknown> = {}, signal = new AbortController().signal, callId = ToolCallId(randomUUID()), agent = root, kind = "pwsh") { return ctx.tools.execute({ name: kind, callId, agent, signal, arguments: { command, description: "Run one owned fixture command", workdir: process.cwd(), ...extra } }); },
      async mountManagedShell(kind: "pwsh" | "bash" = "pwsh", config = { enableRunInBackground: false, promoteOnTimeout: false }, scope = ctx) { const fiber = scope.plugin(kind === "pwsh" ? ManagedPwsh : ManagedBash, config); await fiber.await(); return fiber; },
      setOutcome(value: typeof outcome) { outcome = value; }, setAnswer(value: typeof answer) { answer = value; }, setPureDenied(value: boolean) { pureDenied = value; },
      setPolicy(policy: "ask" | "never", agent = root) { setApprovalPolicy(agent.session, policy); },
      async replaceConnection() { await connectionFiber.dispose(); connectionFiber = ctx.plugin(Connection); await connectionFiber.await(); },
      async replaceApproval(policy: "ask" | "never") { await approvalFiber.dispose(); approvalFiber = ctx.plugin(ApprovalService, { policy }); await approvalFiber.await(); },
      async disposeAgent(agent: Agent) { await handles.find(handle => handle.agent === agent)!.dispose(); },
      async dispose() { lifetime.abort(); for (const handle of [...handles].reverse()) await handle.dispose(); await ctx.fiber.dispose(); },
    };
  } catch (error) { lifetime.abort(); for (const handle of [...handles].reverse()) await handle.dispose(); await ctx.fiber.dispose(); throw error; }
}
