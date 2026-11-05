import { symbols } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { HostConnectionHandle } from "@deepseek-ai/dsh-client-connection";
import { SessionId } from "@deepseek-ai/dsh-session";
import { SubagentError } from "@deepseek-ai/dsh-subagent";
import type { SubagentCatalogEntry } from "@deepseek-ai/dsh-subagent";
import { Remote, RemoteError, TypertRemoteService, remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import type { RemoteStream } from "@deepseek-ai/dsh-typert-protocol";
import type {} from "@deepseek-ai/dsh-typert-registry";
import { scopeLifetime } from "./lifetime.js";
import type { NativeAdmission } from "./native-admission.js";
import type { DsmmProfileAdmission } from "./settings.js";
import { runtimeAdmissionView } from "./runtime-integration.js";
import { invocationView } from "./role-invocation.js";
import { roleRouteComparison } from "./role-subagents.js";
import { ROLE_CONTROL_HOST, parseChildSessionSnapshot, parseRoleCallObservationFrame, parseRoleControlDescendants, parseRoleControlPromptRequest, parseRoleControlInterruptRequest, parseRoleControlSessionId } from "./role-control-remote.js";
import type { ChildSessionSnapshot, RoleCallObservationFrame, RoleControlAvailability, RoleControlErrorInfo, RoleControlChildView, RoleControlCapabilities, RoleControlDescendantsSnapshot, RoleControlInterruptRequest, SubagentPromptRequest, SubagentPromptReceipt, SubagentInterruptReceipt } from "./role-control-types.js";

const unavailable = { enabled: false, reason: "unavailable" } as const;
class ControlRefusal extends Error {
  constructor(readonly code: RoleControlErrorInfo["code"], readonly field?: RoleControlErrorInfo["field"], readonly reason?: RoleControlErrorInfo["reason"]) { super("Native child control refused"); }
}
const disabled = (reason: RoleControlErrorInfo["reason"]): RoleControlAvailability => ({ enabled: false, reason: reason ?? "unavailable" });
function boundedLabel(label: string): string {
  const last = label.charCodeAt(119), next = label.charCodeAt(120);
  const bounded = label.slice(0, last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 119 : 120).replace(/[\u0000-\u001f\u007f]/gu, " ");
  return new TextDecoder().decode(new TextEncoder().encode(bounded));
}
interface Scope { parent: Agent; admission: DsmmProfileAdmission; epoch: string; signal: AbortSignal; check(): void }
/** Authenticated projection of the native catalog. Listing never wakes a session. */
export class DsmmChildrenHost extends TypertRemoteService {
  private readonly lifetime = new AbortController();
  constructor(ctx: Context, private readonly admission: NativeAdmission) {
    super(ctx, "dsmmChildren"); scopeLifetime(ctx, "dsmm: retire child controls", () => this.lifetime.abort());
  }
  private openScope(id: string, extraSignal?: AbortSignal): Scope {
    const sessionId = parseRoleControlSessionId(id), invocation = this.ctx.invocation;
    const connection = this.ctx.get("connection") as HostConnectionHandle | undefined;
    if (!invocation?.peer || connection?.browserPeer !== invocation.peer) throw new ControlRefusal("not-owned");
    const owner: object = Reflect.get(connection, symbols.original) ?? connection;
    const agents = this.ctx.get("agents");
    if (!agents) throw new ControlRefusal("unavailable");
    const parent = agents.get(SessionId(sessionId));
    if (!parent) throw new ControlRefusal("not-found", "sessionId");
    if (!agents.roots().includes(parent) || parent.session.header.origin === "subagent" || parent.session.id !== parent.id) throw new ControlRefusal("not-owned", "sessionId");
    const captured = this.admission.assert(parent);
    const signal = AbortSignal.any([invocation.signal, invocation.peer.signal, this.lifetime.signal, this.admission.lifetime.signal,
      ...(extraSignal === undefined ? [] : [extraSignal])]);
    const check = () => {
      signal.throwIfAborted();
      const current = this.ctx.get("connection") as HostConnectionHandle | undefined;
      if (!current || (Reflect.get(current, symbols.original) ?? current) !== owner || current.browserPeer !== invocation.peer
        || this.admission.assert(parent) !== captured || agents.get(parent.id) !== parent) throw new ControlRefusal("not-owned", "sessionId");
    };
    check(); return { parent, admission: captured, epoch: captured.epoch, signal, check };
  }
  private observationRoot(target: Agent, agents: Context["agents"]): Agent {
    const roots = agents.roots(), residents = agents.list(), seen = new Set<Agent>();
    let current = target;
    while (!roots.includes(current)) {
      if (seen.has(current)) throw new ControlRefusal("not-owned", "sessionId");
      seen.add(current);
      const parents = residents.filter(candidate => candidate !== current && agents.isOwnedBy(current.id, candidate));
      if (parents.length !== 1) throw new ControlRefusal("not-owned", "sessionId");
      current = parents[0];
    }
    if (current.session.header.origin === "subagent" || current.session.id !== current.id) throw new ControlRefusal("not-owned", "sessionId");
    return current;
  }
  private openObservationScope(id: string, extraSignal: AbortSignal): Scope {
    const sessionId = parseRoleControlSessionId(id), invocation = this.ctx.invocation;
    const connection = this.ctx.get("connection") as HostConnectionHandle | undefined;
    if (!invocation?.peer || connection?.browserPeer !== invocation.peer) throw new ControlRefusal("not-owned");
    const owner: object = Reflect.get(connection, symbols.original) ?? connection;
    const agents = this.ctx.get("agents");
    if (!agents) throw new ControlRefusal("unavailable");
    const parent = agents.get(SessionId(sessionId));
    if (!parent) throw new ControlRefusal("not-found", "sessionId");
    const root = this.observationRoot(parent, agents), captured = this.admission.assert(parent);
    const signal = AbortSignal.any([invocation.signal, invocation.peer.signal, this.lifetime.signal, this.admission.lifetime.signal, extraSignal]);
    const check = () => {
      signal.throwIfAborted();
      const current = this.ctx.get("connection") as HostConnectionHandle | undefined;
      if (!current || (Reflect.get(current, symbols.original) ?? current) !== owner || current.browserPeer !== invocation.peer
        || agents.get(parent.id) !== parent || this.observationRoot(parent, agents) !== root || this.admission.assert(parent) !== captured) {
        throw new ControlRefusal("not-owned", "sessionId");
      }
    };
    check(); return { parent, admission: captured, epoch: captured.epoch, signal, check };
  }
  private refusal(error: unknown, operationSignal?: AbortSignal): RemoteError<"dsmm-children/refused"> {
    let info: RoleControlErrorInfo;
    if (operationSignal?.aborted) info = { code: "cancelled" };
    else if (error instanceof ControlRefusal) info = { code: error.code, ...(error.field === undefined ? {} : { field: error.field }), ...(error.reason === undefined ? {} : { reason: error.reason }) };
    else if (error instanceof TypeError) info = { code: "validation", field: "request" };
    else {
      const code = remoteErrorOf(error)?.code ?? (error instanceof SubagentError ? error.code : undefined);
      if (code === "ABORTED" || code === "gateway/cancelled" || error instanceof Error && error.name === "AbortError") info = { code: "cancelled" };
      else if (code === "UNAUTHORIZED" || code === "subagent/unauthorized") info = { code: "not-owned" };
      else if (code === "NOT_RESUMABLE" || code === "subagent/not-resumable") info = { code: "not-resumable", field: "childSessionId" };
      else if (code === "subagent/attachment-invalid" || code === "gateway/bad-request") info = { code: "invalid-content", field: "content" };
      else if (code === "subagent/invalid-time-zone") info = { code: "invalid-time-zone", field: "clientTimeZone" };
      else info = { code: "unavailable" };
    }
    return new RemoteError("dsmm-children/refused", "The Host refused the native child control operation.", info);
  }
  private async scoped<T>(id: string, operation: (scope: Scope) => Promise<T>): Promise<T> {
    let scope: Scope | undefined;
    try { scope = this.openScope(id); return await operation(scope); }
    catch (error) { throw this.refusal(error, scope?.signal); }
  }
  private capabilities(scope: Scope): RoleControlCapabilities {
    scope.check();
    const runtime = runtimeAdmissionView(this.ctx), settings = this.admission.assert(scope.parent).settings;
    const control: RoleControlAvailability = !runtime.deliveryFenceReady || this.ctx.get("subagents") === undefined ? unavailable
      : !settings.modules.deepwork.enabled ? disabled("module-off") : { enabled: true };
    return { prompt: control, interrupt: control, images: control.enabled && this.ctx.get("attachments") !== undefined ? control : unavailable, runtime };
  }
  private child(scope: Scope, entry: Pick<SubagentCatalogEntry, "id" | "mode"> & { label?: string }, parentId = scope.parent.id): RoleControlChildView {
    scope.check();
    const child = this.ctx.get("agents")?.get(entry.id), direct = parentId === scope.parent.id;
    const live = child && this.admission.get(child), invocation = child && this.admission.invocation(child);
    const available = this.capabilities(scope);
    const reason = !direct ? "not-direct-child" : entry.mode !== "continuable" ? entry.mode === "one-shot" ? "one-shot" : "unknown-mode" : child && !live ? "evidence-unavailable" : undefined;
    const control: RoleControlAvailability = reason !== undefined ? disabled(reason) : child && !this.ctx.get("agents")?.isOwnedBy(child.id, scope.parent) ? disabled("not-direct-child") : available.prompt;
    return { id: entry.id, parentSessionId: parentId, mode: entry.mode === "external" ? "unknown" : entry.mode, activity: child?.status === "running" ? "running" : "inactive",
      readonly: !control.enabled, controls: { prompt: control, interrupt: child ? control : disabled("evidence-unavailable") }, ...(entry.label === undefined ? {} : { label: boundedLabel(entry.label) }),
      ...(invocation === undefined ? {} : { invocation: invocationView(invocation, boundedLabel(entry.label ?? invocation.target), "continuable", { childId: entry.id }) }),
      ...(child === undefined ? {} : { routeComparison: roleRouteComparison(child) }) };
  }
  @Remote({ mode: "stream" })
  observe(sessionId: string, signal: AbortSignal): RemoteStream<RoleCallObservationFrame> {
    let scope: Scope;
    try { scope = this.openObservationScope(sessionId, signal); }
    catch (error) { throw this.refusal(error, signal); }
    return this.followObservedCalls(scope);
  }
  private async *followObservedCalls(scope: Scope): AsyncIterable<RoleCallObservationFrame> {
    try {
      for await (const frame of this.admission.observeRoleCalls(scope.parent, scope.admission, scope.signal, scope.check)) {
        scope.check(); yield parseRoleCallObservationFrame(frame);
      }
    } catch (error) { throw this.refusal(error, scope.signal); }
  }
  @Remote
  describe(sessionId: string): Promise<ChildSessionSnapshot> { return this.scoped(sessionId, async scope => {
    const rows = await this.ctx.get("subagents")!.listChildren(scope.parent.id, scope.signal); scope.check();
    return parseChildSessionSnapshot({ sessionId, admissionEpoch: scope.epoch, children: rows.map(row => this.child(scope, row)), capabilities: this.capabilities(scope) });
  }); }
  @Remote
  descendants(sessionId: string): Promise<RoleControlDescendantsSnapshot> { return this.scoped(sessionId, async scope => {
    const rows = await this.ctx.get("subagents")!.listDescendants(scope.parent.id, scope.signal); scope.check();
    return parseRoleControlDescendants({ sessionId, admissionEpoch: scope.epoch, descendants: rows.map(row => row.kind === "diagnostic"
      ? { kind: "diagnostic", id: row.id, parentSessionId: row.parentId, depth: row.depth, reason: row.reason }
      : { kind: "child", depth: row.depth, hasChildren: row.hasChildren, child: { ...this.child(scope, row, row.parentId), readonly: true, controls: { prompt: disabled("not-direct-child"), interrupt: disabled("not-direct-child") } } }) });
  }); }
  private direct(scope: Scope, childId: string): Agent {
    scope.check(); const child = this.ctx.get("agents")?.get(SessionId(childId));
    if (!child) throw new ControlRefusal("not-resumable", "childSessionId", "evidence-unavailable");
    if (!this.ctx.get("agents")?.isOwnedBy(child.id, scope.parent)) throw new ControlRefusal("not-owned", "childSessionId");
    this.admission.assert(child); return child;
  }
  @Remote
  prompt(sessionId: string, input: SubagentPromptRequest): Promise<SubagentPromptReceipt> { return this.scoped(sessionId, async scope => {
    const request = parseRoleControlPromptRequest(input);
    if (request.parentSessionId !== sessionId) throw new ControlRefusal("validation", "parentSessionId");
    const capabilities = this.capabilities(scope);
    if (!capabilities.prompt.enabled) throw new ControlRefusal("disabled", undefined, capabilities.prompt.reason);
    if (request.content.some(part => part.type === "image") && !capabilities.images.enabled) throw new ControlRefusal("disabled", "content", capabilities.images.reason);
    const rows = await this.ctx.get("subagents")!.listChildren(scope.parent.id, scope.signal); scope.check();
    const row = rows.find(row => row.id === request.childSessionId);
    if (!row) throw new ControlRefusal("not-owned", "childSessionId");
    if (row.mode !== "continuable") throw new ControlRefusal("not-resumable", "childSessionId");
    if (this.ctx.get("agents")?.get(SessionId(request.childSessionId))) this.direct(scope, request.childSessionId);
    return this.admission.duringCall(scope.parent, scope.signal, async signal => {
      scope.check(); const receipt = await this.ctx.get("subagents")!.prompt(request, signal); scope.check(); return receipt;
    });
  }); }
  @Remote
  interrupt(sessionId: string, input: RoleControlInterruptRequest): Promise<SubagentInterruptReceipt> { return this.scoped(sessionId, async scope => {
    const request = parseRoleControlInterruptRequest(input);
    if (request.parentSessionId !== sessionId) throw new ControlRefusal("validation", "parentSessionId");
    const capabilities = this.capabilities(scope);
    if (!capabilities.interrupt.enabled) throw new ControlRefusal("disabled", undefined, capabilities.interrupt.reason);
    this.direct(scope, request.childSessionId);
    return this.ctx.get("subagents")!.interruptByParent(SessionId(request.childSessionId), scope.parent.id, "continuable");
  }); }
}
declare module "@deepseek-ai/cordis" { interface Context { dsmmChildren: DsmmChildrenHost } }
export function registerRoleControlRpc(ctx: Context, admission: NativeAdmission): DsmmChildrenHost {
  const host = new DsmmChildrenHost(ctx, admission); ctx.typert.register(ROLE_CONTROL_HOST); return host;
}
