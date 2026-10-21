import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionId } from "@deepseek-ai/dsh-session";
import { nativeControlFixture, gate, remoteErrorOf, ROLE_CONTROL_REMOTE } from "./role-control-fixture.ts";
import type { ChildSessionSnapshot, RoleControlDescendantsSnapshot } from "../src/role-control-types.ts";

const refused = (code: string) => (error: unknown) => {
  const remote = remoteErrorOf(error);
  return remote?.code === "dsmm-children/refused" && remote.details.code === code;
};

test("real Gateway authenticates the exact operator and validates requests without warming cold sessions", { timeout: 20000 }, async () => {
  const f = await nativeControlFixture();
  try {
    const root = await f.create(), operator = f.ctx.connection.browserPeer;
    const independent = f.ctx.connection.createPeer({ principal: { kind: "owner" } });
    const request = f.request(root, "cold-child", "not accepted");
    for (const invalid of [{ ...request, owner: operator.id }, { ...request, mode: "one-shot" }, { ...request, delivery: "invalid" }])
      await assert.rejects(f.invoke("prompt", { sessionId: root.id, request: invalid }), error => String(remoteErrorOf(error)?.code) === "gateway/input-invalid");
    for (const peer of [{ ...operator, async dispose() {} }, independent])
      await assert.rejects(f.ctx.typertGateway.invoke({ namespace: "dsmmChildren", method: "describe", args: { sessionId: root.id }, peer }), refused("not-owned"));
    await assert.rejects(f.invoke("describe", { sessionId: "cold-root" }), refused("not-found"));
    await assert.rejects(f.invoke("prompt", { sessionId: root.id, request }), refused("not-resumable"));
    assert.equal(f.agents.get(SessionId("cold-child")), undefined);
    await f.replaceConnection();
    await assert.rejects(f.ctx.typertGateway.invoke({ namespace: "dsmmChildren", method: "describe", args: { sessionId: root.id }, peer: operator }));
    assert.equal((await f.invoke("describe", { sessionId: root.id }) as ChildSessionSnapshot).sessionId, root.id);
  } finally { await f.dispose(); }
});

test("native Gateway queue/steer preserve request identity and interrupt acknowledges the live child", { timeout: 20000 }, async () => {
  const f = await nativeControlFixture(), held = gate();
  f.adapter.beforeStream = () => held.promise;
  try {
    const root = await f.create(), child = await f.start(root), other = await f.create();
    const view = await f.invoke("describe", { sessionId: root.id }) as ChildSessionSnapshot;
    assert.equal(view.children[0].id, child.id);
    assert.equal(view.children[0].invocation?.role, "dsmm-coding");
    assert.equal(view.children[0].label, "Coding: Native control task");
    assert.equal(view.children[0].controls.prompt.enabled, true);
    await assert.rejects(f.invoke("describe", { sessionId: child.id }), refused("not-owned"));
    await assert.rejects(f.invoke("prompt", { sessionId: other.id, request: f.request(other, child.id, "foreign") }), refused("not-owned"));
    for (const delivery of ["queue", "steer"] as const) {
      const request = { ...f.request(root, child.id, `browser ${delivery}`, delivery), clientTimeZone: "UTC" };
      const receipt = await f.invoke("prompt", { sessionId: root.id, request }) as { messageId: string };
      const message = (delivery === "queue" ? child.inbox.nextTurn : child.inbox.nextStep).find(message => message.id === receipt.messageId);
      assert.ok(message);
      assert.match(JSON.stringify(message.source), new RegExp(request.requestId));
    }
    assert.deepEqual(await f.invoke("interrupt", { sessionId: root.id, request: { parentSessionId: root.id, childSessionId: child.id, mode: "continuable" } }), { accepted: true });
    held.release();
    await f.subagents.drainChildren(root, [child.id]);
    await f.ctx.sessionPersistence.flush();
    const cold = await f.invoke("describe", { sessionId: root.id }) as ChildSessionSnapshot;
    assert.equal(cold.children[0].readonly, true);
    await assert.rejects(f.invoke("prompt", { sessionId: root.id, request: f.request(root, child.id, "cold") }), refused("not-resumable"));
    assert.equal(f.agents.get(child.id), undefined);
  } finally { held.release(); await f.dispose(); }
});

test("native catalog projections bound labels and keep external entries and descendant queries read-only", { timeout: 20000 }, async t => {
  const f = await nativeControlFixture();
  try {
    const root = await f.create(), id = SessionId("external-child");
    t.mock.method(f.subagents, "listChildren", async () => [{ id, mode: "external", createdAt: 0, label: "a".repeat(119) + "😀" }]);
    t.mock.method(f.subagents, "listDescendants", async () => [{ kind: "child", id, parentId: root.id, mode: "external", depth: 1, hasChildren: false, label: "a".repeat(119) + "\nmore" }]);
    const view = await f.invoke("describe", { sessionId: root.id }) as ChildSessionSnapshot;
    assert.equal(view.children[0].mode, "unknown");
    assert.equal(view.children[0].label, "a".repeat(119));
    assert.equal(view.children[0].readonly, true);
    const tree = await f.invoke("descendants", { sessionId: root.id }) as RoleControlDescendantsSnapshot;
    const row = tree.descendants[0];
    assert.ok(row.kind === "child");
    assert.equal(row.child.label, "a".repeat(119) + " ");
    assert.equal(row.child.controls.prompt.enabled, false);
    const codec = ROLE_CONTROL_REMOTE.descriptors.find(entry => entry.method === "describe")!.result;
    assert.equal(codec.mode, "strict");
    if (codec.mode !== "strict") throw new Error("Expected strict result codec");
    assert.throws(() => codec.create().parse({ ...view, secret: "private" }));
    assert.throws(() => codec.create().parse({ ...view, children: [{ ...view.children[0], label: "\ud83d" }] }));
    t.mock.method(f.subagents, "listChildren", async () => { throw new Error("SECRET at private/session.jsonl"); });
    await assert.rejects(f.invoke("describe", { sessionId: root.id }), error => {
      assert.doesNotMatch(JSON.stringify(remoteErrorOf(error)), /SECRET|private/);
      return refused("unavailable")(error);
    });
  } finally { await f.dispose(); }
});

test("Gateway catalog awaits cannot outlive operator or owner retirement", { timeout: 20000 }, async t => {
  for (const change of ["operator", "owner"] as const) await t.test(change, async t => {
    const f = await nativeControlFixture(), entered = gate(), release = gate();
    try {
      const root = await f.create();
      t.mock.method(f.subagents, "listChildren", async () => { entered.release(); await release.promise; return []; });
      const pending = f.invoke("describe", { sessionId: root.id });
      const rejection = assert.rejects(pending);
      await entered.promise;
      if (change === "operator") await f.ctx.connection.browserPeer.dispose();
      else await f.dsmmFiber.dispose();
      release.release(); await rejection;
    } finally { release.release(); await f.dispose(); }
  });
});
