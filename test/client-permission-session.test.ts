import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionId } from "@deepseek-ai/dsh-session";
import { bindPermissionSession } from "../src/client/permission-session.ts";
import type { PermissionScopeSink, PermissionSessionBinding, PermissionSessionCatalog, PermissionSessionSnapshot } from "../src/client/permission-session.ts";
import type { PermissionView } from "../src/client/permission-controller.ts";

const rootA = SessionId("root-a"), rootB = SessionId("root-b");
/** Minimal observable face shared by the native session source and catalog. */
function observable<T>(initial: T) {
  let value = initial; const listeners = new Set<() => void>();
  return { getSnapshot: () => value, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next: T) { value = next; for (const listener of listeners) listener(); } };
}
const catalogState = (ids: SessionId[], byId: Readonly<Record<SessionId, { readonly origin?: "subagent"; readonly parentId?: SessionId }>>): PermissionSessionCatalog => ({ ids, byId });
function harness() {
  const key = observable<{ readonly key: string | undefined }>({ key: rootA });
  let open = true, removed = false, subagent: PermissionSessionSnapshot["subagent"] = null, bound = true;
  const session = observable<PermissionSessionSnapshot>({ sessionId: rootA, subagent, openState: "open", removed });
  const binding: PermissionSessionBinding = { sessionId: rootA, session };
  const list = observable<PermissionSessionCatalog>(catalogState([rootA], { [rootA]: {} }));
  const sessions = { binding: (id: SessionId) => bound && id === rootA ? binding : undefined, list };
  const calls: Array<{ id: string | null; owner: object | null; scope: PermissionView["scope"] }> = [];
  const sink: PermissionScopeSink = { bindScope: (id, owner, scope) => calls.push({ id, owner, scope }) };
  return { key, list, sessions, calls, sink, last: () => calls.at(-1)!,
    hideBinding() { bound = false; }, showBinding() { bound = true; },
    set(openState: boolean, isRemoved = false, child: PermissionSessionSnapshot["subagent"] = null) {
      open = openState; removed = isRemoved; subagent = child;
      session.set({ sessionId: rootA, subagent, openState: open ? "open" : "cold", removed });
    } };
}
test("the production binding helper derives Root, child and unknown scope from the real catalog and session snapshot", () => {
  const h = harness();
  bindPermissionSession(h.key, h.sessions, h.sink);
  assert.equal(h.last().scope, "root"); assert.equal(h.last().id, rootA);
  h.set(true, false, { address: { parentSessionId: SessionId("parent"), childSessionId: rootA, mode: "unknown" } });
  h.key.set({ key: rootA });
  assert.equal(h.last().scope, "child", "a subagent snapshot demotes an otherwise open Root");
  h.set(false);
  h.key.set({ key: rootA });
  assert.equal(h.last().scope, "unknown", "a closed session is not a Root entry");
  h.set(true);
  h.list.set(catalogState([], { [rootA]: { parentId: SessionId("parent") } }));
  assert.equal(h.last().scope, "child", "a parented catalog summary is never a Root");
  h.list.set(catalogState([rootA], { [rootA]: {} }));
  assert.equal(h.last().scope, "root");
});
test("a same-session transient scope gap never reports a session switch or null", () => {
  const h = harness();
  bindPermissionSession(h.key, h.sessions, h.sink);
  const owner = h.last().owner;
  h.hideBinding();
  h.key.set({ key: rootA });
  assert.deepEqual(h.last(), { id: rootA, owner: null, scope: "unknown" }, "the ID survives a temporary binding gap");
  assert.notEqual(owner, null);
  h.showBinding();
  h.key.set({ key: rootA });
  assert.equal(h.last().scope, "root"); assert.equal(h.last().id, rootA);
});
test("a real session switch or withdrawal clears, and disposal stops observing", () => {
  const h = harness();
  const stop = bindPermissionSession(h.key, h.sessions, h.sink);
  h.key.set({ key: rootB });
  assert.deepEqual(h.last(), { id: rootB, owner: null, scope: "unknown" }, "an unknown ID is not a retained scope");
  h.key.set({ key: undefined });
  assert.deepEqual(h.last(), { id: null, owner: null, scope: "unknown" });
  stop();
  assert.deepEqual(h.calls.at(-1), { id: null, owner: null, scope: "unknown" });
  const published = h.calls.length;
  h.key.set({ key: rootA }); h.list.set(catalogState([], {}));
  assert.equal(h.calls.length, published, "the helper detaches every source subscription on disposal");
});
