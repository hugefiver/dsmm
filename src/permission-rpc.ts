import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { HostConnectionHandle } from "@deepseek-ai/dsh-client-connection";
import { SessionId } from "@deepseek-ai/dsh-session";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { PermissionRefusal, permissionOriginal } from "./permission-control.js";
import { PERMISSION_HOST, parsePermissionSessionId } from "./permission-remote.js";
import { parsePermissionRulesSave } from "./permission-rules.js";
import type { PermissionRulesBackend, PermissionRulesRuntimeSync, PermissionRulesSaveAuthority, PermissionRulesSaveRequest, PermissionRulesSaveResult } from "./permission-rules.js";

/** Root controls are ordinary Core controls; no DW delivery fence/ticket is consulted. */
export class DsmmPermissionsHost extends TypertRemoteService {
  private readonly lifetime = new AbortController();
  constructor(ctx: Context, private readonly rules: { readonly backend: PermissionRulesBackend; readonly runtime: PermissionRulesRuntimeSync }) {
    super(ctx, "dsmmPermissions");
    ctx.effect(() => () => this.lifetime.abort());
  }
  private invoke<T>(sessionId: string, operation: (root: Agent, peer: object, signal: AbortSignal, check: () => void) => T | Promise<T>): Promise<T> {
    return Promise.resolve().then(() => {
      const id = SessionId(parsePermissionSessionId(sessionId));
      const invocation = this.ctx.invocation, connection = this.ctx.get("connection") as HostConnectionHandle | undefined;
      if (invocation?.peer === undefined || connection === undefined || invocation.peer !== connection.browserPeer) throw new PermissionRefusal("not-owned");
      const peer = invocation.peer, owner = permissionOriginal(connection), agents = this.ctx.get("agents"), root = agents?.get(id);
      if (root === undefined) throw new PermissionRefusal("not-owned");
      const signal = AbortSignal.any([invocation.signal, peer.signal, this.lifetime.signal]);
      const check = (): void => {
        const current = this.ctx.get("connection") as HostConnectionHandle | undefined, registry = this.ctx.get("agents");
        if (signal.aborted) throw new PermissionRefusal("cancelled");
        if (current === undefined || permissionOriginal(current) !== owner || current.browserPeer !== peer || registry?.get(id) !== root
          || root.id !== sessionId || root.session.id !== sessionId || root.session.header.origin === "subagent" || !registry.roots().includes(root)
          || registry.list().some(agent => agent !== root && registry.isOwnedBy(id, agent))) throw new PermissionRefusal("not-owned");
      };
      check();
      return operation(root, peer, signal, check);
    }).catch(error => {
      const code = error instanceof PermissionRefusal ? error.code : error instanceof TypeError ? "validation" : "unavailable";
      throw new RemoteError("dsmm-permissions/refused", "The Host refused the permission operation.", { code });
    });
  }
  private rulesAuthority(root: Agent, peer: object, signal: AbortSignal, check: () => void): PermissionRulesSaveAuthority {
    const rules = this.rules;
    const settings = this.ctx.get("settings"), webServer = this.ctx.get("webServer") as { host?: string } | undefined;
    const assertCurrent = (): void => {
      check();
      const currentSettings = this.ctx.get("settings"), currentWeb = this.ctx.get("webServer") as { host?: string } | undefined;
      if (settings === undefined || currentSettings === undefined || permissionOriginal(currentSettings) !== permissionOriginal(settings)
        || currentSettings.writable !== true || webServer === undefined || currentWeb === undefined
        || permissionOriginal(currentWeb) !== permissionOriginal(webServer) || currentWeb.host !== "127.0.0.1") throw new PermissionRefusal("not-owned");
      rules.backend.assertWritable(root);
    };
    assertCurrent(); return Object.freeze({ root, peer, signal, assertCurrent });
  }
  private withCapabilities(root: Agent, result: PermissionRulesSaveResult): PermissionRulesSaveResult {
    const controller = this.ctx.get("dsmmPermissionController");
    let capabilities: PermissionRulesSaveResult["capabilities"];
    if (controller !== undefined && permissionOriginal(controller.rules) === permissionOriginal(this.rules.runtime)) {
      try {
        const observed = controller.capabilities(root);
        const current = this.ctx.get("dsmmPermissionController");
        if (current !== undefined && permissionOriginal(current) === permissionOriginal(controller)) capabilities = observed;
      } catch { /* Unavailable live authority is unknown, not an empty successful observation. */ }
    }
    return { snapshot: result.snapshot, runtime: result.runtime, ...capabilities === undefined ? {} : { capabilities } };
  }
  @Remote
  describeRules(sessionId: string): Promise<PermissionRulesSaveResult> {
    return this.invoke(sessionId, async (root, peer, signal, check) => {
      const authority = this.rulesAuthority(root, peer, signal, check), snapshot = await this.rules.backend.read(authority);
      authority.assertCurrent();
      const result = this.withCapabilities(root, { snapshot, runtime: this.rules.runtime.status() });
      authority.assertCurrent(); return result;
    });
  }
  @Remote
  saveRules(sessionId: string, request: PermissionRulesSaveRequest): Promise<PermissionRulesSaveResult> {
    return this.invoke(sessionId, async (root, peer, signal, check) => {
      const parsed = parsePermissionRulesSave(request), authority = this.rulesAuthority(root, peer, signal, check);
      const snapshot = await this.rules.backend.read(authority); authority.assertCurrent();
      if (snapshot.revision !== parsed.expectedRevision) throw new PermissionRefusal("stale");
      const result = await this.rules.backend.save(parsed, authority);
      authority.assertCurrent();
      const decorated = this.withCapabilities(root, result);
      authority.assertCurrent(); return decorated;
    });
  }
}
declare module "@deepseek-ai/cordis" { interface Context { dsmmPermissions: DsmmPermissionsHost } }
export function registerPermissionControlRpc(ctx: Context, rules: { readonly backend: PermissionRulesBackend; readonly runtime: PermissionRulesRuntimeSync }): DsmmPermissionsHost {
  const host = new DsmmPermissionsHost(ctx, rules);
  ctx.typert.register(PERMISSION_HOST);
  return host;
}
/** Native-only mount does not construct a substitute Root ToolRuntime or scoped-memory authority. */
export function registerNativePermissionRulesRpc(ctx: Context, backend: PermissionRulesBackend, runtime: PermissionRulesRuntimeSync): DsmmPermissionsHost {
  return registerPermissionControlRpc(ctx, { backend, runtime });
}
