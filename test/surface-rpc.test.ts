import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Context, symbols } from "@deepseek-ai/cordis";
import type { Service } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import * as Connection from "@deepseek-ai/dsh-client-connection";
import type { PeerScope } from "@deepseek-ai/dsh-client-connection";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { registerPermissionControlRpc } from "../src/permission-rpc.ts";
import { registerProfilesRpc } from "../src/profile-rpc.ts";
import type { SessionProfileSnapshot } from "../src/profile-types.ts";
import { PermissionRulesRuntimeSync } from "../src/permission-rules.ts";
import { resolvePermissionControl } from "../src/permission-settings.ts";
import { registerRoleControlRpc } from "../src/role-control-rpc.ts";
import type { NativeAdmission } from "../src/native-admission.ts";
import { resolveConfig } from "../src/settings.ts";
import type { ChildSessionSnapshot } from "../src/role-control-types.ts";

const require = createRequire(import.meta.url);
const native = createRequire(require.resolve("@deepseek-ai/dsh-client-connection"));
const { CredentialProvider } = native("@deepseek-ai/dsh-credentials") as { CredentialProvider: new (ctx: Context) => Service };
class MemoryCredentials extends CredentialProvider {
  private readonly records = new Map<string, unknown>();
  async modifyRecord(key: string, modify: (current: unknown) => Promise<unknown>) {
    const value = await modify(this.records.get(key));
    if (value !== undefined) this.records.set(key, value);
    return this.records.get(key);
  }
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** Real Gateway/Connection/Peer scopes; registry and business work are bounded RPC seams, not lifecycle proof. */
async function fixture() {
  const ctx = new Context();
  // These owner-only calls must never consult an ambient access policy.
  ctx.provide("remoteAccess", { decide() { return { kind: "deny", reason: "policy" }; } });
  await ctx.plugin(TypertRegistry).await(); await ctx.plugin(TypertGatewayService, {}).await();
  await ctx.plugin(MemoryCredentials).await(); const connectionFiber = ctx.plugin(Connection); await connectionFiber.await();
  const id = SessionId("surface-root"), session = Session.create(id);
  const root = { id, session, status: "idle" } as Agent;
  ctx.provide("agents", { get: (key: string) => key === id ? root : undefined, roots: () => [root], list: () => [root], isOwnedBy: () => false });
  ctx.provide("settings", { writable: true }); ctx.provide("webServer", { host: "127.0.0.1" });
  let before = async () => {}, writes = 0;
  const policy = { revision: "rules:0", policy: resolvePermissionControl() };
  const sync = new PermissionRulesRuntimeSync(policy, () => {});
  const bound = { epoch: "a".repeat(64), settings: resolveConfig() };
  const admission = { isReady: true, lifetime: new AbortController(), assert: () => bound, get: () => undefined, invocation: () => undefined } as unknown as NativeAdmission;
  ctx.provide("dsmmNativeAdmission", admission);
  const runtime = {
    async listChildren() { await before(); return [{ id: SessionId("external-child"), mode: "external" as const, createdAt: 0 }]; },
  };
  ctx.provide("subagents", runtime);
  const rpc = ctx.plugin({ name: "surface-rpc-boundaries", inject: ["typert", "connection"], apply(scope: Context) {
    const snapshot: SessionProfileSnapshot = { sessionId: id, globalDefault: { selectedId: null, appliedRevision: null, selectionRevision: "absent" },
      selection: { selectedId: null, appliedRevision: null, selectionRevision: "absent" }, scope: "global-default", admissionEpoch: bound.epoch, switchAllowed: true,
      canSelectModel: false, selectModelUnavailableReason: "model-unconfigured",
      canToggleMode: false, toggleModeUnavailableReason: "runtime-unavailable",
      canApplyOverlay: false, applyOverlayUnavailableReason: "new-session-required" };
    registerProfilesRpc(scope, {
      async describe() { throw new Error("unused global seam"); }, async read() { throw new Error("unused global seam"); },
      async save() { throw new Error("unused global seam"); }, async select() { throw new Error("unused global seam"); },
      async getSession() { await before(); return snapshot; },
      async selectSession(_request, _agent, signal, assertAuthority) { await before(); assertAuthority?.(); signal?.throwIfAborted(); writes++; return snapshot; },
    });
    registerPermissionControlRpc(scope, { runtime: sync, backend: {
      assertWritable() {}, async read(authority) { await before(); authority.assertCurrent(); return policy; },
      async save(_request, authority) { authority.assertCurrent(); writes++; return { snapshot: policy, runtime: sync.status() }; },
    } });
    registerRoleControlRpc(scope, admission);
  } });
  await rpc.await();
  const invoke = (namespace: "dsmmProfiles" | "dsmmPermissions" | "dsmmChildren", method: string, args: Record<string, unknown>, peer = ctx.connection.browserPeer, signal?: AbortSignal) => ctx.typertGateway.invoke({ namespace, method, args, peer, signal });
  return { ctx, id, rpc, connectionFiber, invoke, writes: () => writes,
    pause(callback: () => Promise<void>) { before = callback; }, async dispose() { await ctx.fiber.dispose(); } };
}
const refused = (code: string) => (error: unknown) => {
  const failure = remoteErrorOf(error);
  return failure !== undefined && "code" in failure.details && failure.details.code === code;
};

test("RPC admission requires the exact native browser Peer, not another owner principal or ambient fallback", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const browser = f.ctx.connection.browserPeer;
    const otherOwner = f.ctx.connection.createPeer({ principal: { kind: "owner" } });
    assert.notEqual(otherOwner, browser); assert.equal(otherOwner.principal.kind, browser.principal.kind);
    const view = await f.invoke("dsmmChildren", "describe", { sessionId: f.id }) as ChildSessionSnapshot;
    assert.equal(view.sessionId, f.id); assert.equal(view.children[0].mode, "unknown"); assert.equal(view.children[0].readonly, true);
    assert.deepEqual(view.children[0].controls.prompt, { enabled: false, reason: "unknown-mode" });
    await f.invoke("dsmmPermissions", "describeRules", { sessionId: f.id });
    await f.invoke("dsmmProfiles", "describeSession", { sessionId: f.id });
    const calls = [["dsmmPermissions", "describeRules", { sessionId: f.id }], ["dsmmPermissions", "saveRules", { sessionId: f.id, request: { expectedRevision: "rules:0", changes: { outsideReads: "deny" } } }],
      ["dsmmChildren", "describe", { sessionId: f.id }], ["dsmmChildren", "interrupt", { sessionId: f.id, request: { parentSessionId: f.id, childSessionId: "external-child", mode: "continuable" } }],
      ["dsmmProfiles", "describeSession", { sessionId: f.id }], ["dsmmProfiles", "selectSession", { sessionId: f.id, request: { sessionId: f.id, id: null, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "a".repeat(64) } }]] as const;
    for (const [namespace, method, args] of calls) {
      await assert.rejects(f.invoke(namespace, method, args, otherOwner), refused("not-owned"));
      const impersonator = { id: browser.id, ctx: browser.ctx, signal: browser.signal, principal: browser.principal, interactions: browser.interactions, async dispose() {} } satisfies PeerScope;
      await assert.rejects(f.invoke(namespace, method, args, impersonator), refused("not-owned"));
      await assert.rejects(f.ctx.typertGateway.invoke({ namespace, method, args, peer: undefined as never }));
    }
    assert.equal(f.writes(), 0);
  } finally { await f.dispose(); }
});

test("pending scoped RPC writes and reads reject cancelled or replaced browser/Connection/RPC scopes", { timeout: 15000 }, async t => {
  for (const namespace of ["dsmmProfiles", "dsmmPermissions", "dsmmChildren"] as const) for (const change of ["request", "browser", "connection", "replacement", "RPC"] as const) await t.test(`${namespace}/${change}`, async () => {
    const f = await fixture(), entered = gate(), release = gate();
    const connection = Reflect.get(f.ctx.connection, symbols.original) ?? f.ctx.connection;
    try {
      const browser = f.ctx.connection.browserPeer, abort = new AbortController();
      f.pause(async () => { entered.release(); await release.promise; });
      const args = namespace === "dsmmPermissions" ? { sessionId: f.id, request: { expectedRevision: "rules:0", changes: { outsideReads: "deny" } } }
        : namespace === "dsmmProfiles" ? { sessionId: f.id, request: { sessionId: f.id, id: null, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "a".repeat(64) } } : { sessionId: f.id };
      const pending = f.invoke(namespace, namespace === "dsmmPermissions" ? "saveRules" : namespace === "dsmmProfiles" ? "selectSession" : "describe", args, browser, abort.signal);
      const rejected = assert.rejects(pending, error => change === "request" ? remoteErrorOf(error)?.code === "gateway/cancelled"
        : refused(change === "replacement" ? "not-owned" : "cancelled")(error));
      await entered.promise;
      if (change === "request") abort.abort(); else if (change === "browser") await browser.dispose();
      else if (change === "connection") await f.connectionFiber.dispose(); else if (change === "RPC") await f.rpc.dispose();
      else Reflect.set(connection, "browserPeer", f.ctx.connection.createPeer({ principal: { kind: "owner" } }));
      release.release(); await rejected; assert.equal(f.writes(), 0);
    } finally { release.release(); await f.dispose(); }
  });
});
