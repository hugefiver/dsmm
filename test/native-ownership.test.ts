import assert from "node:assert/strict";
import { test } from "node:test";
import { symbols } from "@deepseek-ai/cordis";
import { bindNativeParent, nativeIsOwnedBy, nativeRoots, nativeSameTree, nativeTreeRoot } from "../src/native-ownership.js";

function fixture() {
  interface Member { id: string; ctx: { get(name: string): unknown } }
  const residents = new Map<string, Member>(), roots = new Map<Member, Member>();
  const runtime = { rootOf(agent: Member) {
    const root = roots.get(agent);
    if (residents.get(agent.id) !== agent || root === undefined || residents.get(root.id) !== root) throw new Error("not materialized");
    return root;
  } };
  const registry = { get: (id: string) => residents.get(id), list: () => [...residents.values()] };
  const member = (id: string, root?: Member) => {
    const agent: Member = { id, ctx: { get: name => name === "subagents" ? runtime : undefined } };
    residents.set(id, agent); roots.set(agent, root ?? agent); return agent;
  };
  return { residents, roots, registry, member };
}

test("legacy ownership uses the native registry's exact contract", () => {
  const f = fixture(), root = f.member("root"), child = f.member("child", root);
  const registry = { ...f.registry, roots: () => [root], isOwnedBy: (id: string, parent: typeof root) => id === child.id && parent === root };
  assert.deepEqual(nativeRoots(registry), [root]);
  assert.equal(nativeIsOwnedBy(registry, child.id, root), true);
  bindNativeParent(registry, child, root);
  assert.throws(() => bindNativeParent(registry, root, child), { code: "UNAUTHORIZED" });
});

test("new ownership never turns same-tree membership into direct-parent authority", () => {
  const f = fixture(), root = f.member("root"), parent = f.member("parent", root), child = f.member("child", root);
  assert.deepEqual(nativeRoots(f.registry), [root]);
  assert.equal(nativeIsOwnedBy(f.registry, child.id, parent), false);
  assert.equal(nativeIsOwnedBy(f.registry, child.id, root), false);
  bindNativeParent(f.registry, parent, root);
  bindNativeParent(f.registry, child, parent);
  assert.equal(nativeIsOwnedBy(f.registry, child.id, parent), true);
  assert.equal(nativeIsOwnedBy(f.registry, child.id, root), false);
  assert.throws(() => bindNativeParent(f.registry, child, root), { code: "UNAUTHORIZED" });
  const otherRegistry = { ...f.registry };
  assert.equal(nativeIsOwnedBy(otherRegistry, child.id, parent), false);
  const projection = { ...f.registry, [symbols.original]: f.registry };
  assert.equal(nativeIsOwnedBy(projection, child.id, parent), true);
  const foreign = f.member("foreign");
  assert.throws(() => bindNativeParent(f.registry, child, foreign), { code: "UNAUTHORIZED" });
  assert.throws(() => bindNativeParent(f.registry, root, root), { code: "UNAUTHORIZED" });
});

test("new ownership refuses pending children and exact parent or child replacement", () => {
  const f = fixture(), root = f.member("root"), parent = f.member("parent", root), child = f.member("child", root);
  f.roots.delete(child);
  assert.deepEqual(nativeRoots(f.registry), [root]);
  assert.throws(() => bindNativeParent(f.registry, child, parent), /not materialized/u);
  f.roots.set(child, root);
  bindNativeParent(f.registry, child, parent);
  f.residents.delete(parent.id);
  assert.equal(nativeIsOwnedBy(f.registry, child.id, parent), false);
  assert.equal(nativeTreeRoot(f.registry, child), root);
  assert.equal(nativeSameTree(f.registry, child, root), true);
  assert.equal(nativeSameTree(f.registry, child, parent), false);
  const foreign = f.member("other-root");
  assert.equal(nativeSameTree(f.registry, child, foreign), false);
  const replacement = f.member(parent.id, root);
  assert.equal(nativeIsOwnedBy(f.registry, child.id, parent), false);
  assert.equal(nativeIsOwnedBy(f.registry, child.id, replacement), false);
  f.residents.set(parent.id, parent);
  assert.equal(nativeIsOwnedBy(f.registry, child.id, parent), true);
  f.member(child.id, root);
  assert.equal(nativeIsOwnedBy(f.registry, child.id, parent), false);
  f.residents.set(child.id, child);
  f.residents.delete(root.id);
  assert.equal(nativeIsOwnedBy(f.registry, child.id, parent), false);
  assert.deepEqual(nativeRoots(f.registry), [foreign]);
  assert.equal(nativeTreeRoot(f.registry, child), undefined);
});
