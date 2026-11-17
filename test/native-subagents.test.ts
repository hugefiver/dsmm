import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SubagentActivation, SubagentPromptRequest, SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import { interruptNativeChild, listNativeChildren, promptNativeChild, startNativeActivation } from "../src/native-subagents.ts";

test("activation task fields follow the Host's nested or native-tree contract", async () => {
  const parent = {} as Agent, signal = new AbortController().signal;
  const request = { parent, prompt: [{ type: "text" as const, text: "Complete the bounded task" }], agentOptions: { provider: "fixture", model: "child" }, maxDepth: 2 };
  const spec = { childId: SessionId("reserved-child"), provider: "dsmm-child", label: "Child", request, signal, delivery: "caller" as const };
  const activation = {} as SubagentActivation;
  let seen: unknown;
  const legacy = { async startActivation(value: unknown) { seen = value; return activation; } };
  assert.equal(await startNativeActivation(legacy as SubagentRuntime, spec), activation);
  assert.equal(seen, spec);
  const tree = { ...legacy, rootOf(agent: Agent) { return agent; } };
  assert.equal(await startNativeActivation(tree as unknown as SubagentRuntime, spec), activation);
  assert.deepEqual(seen, { ...request, childId: spec.childId, provider: spec.provider, label: spec.label, signal, delivery: spec.delivery });
});

test("named activations keep the reserved UUID and only advance an automatically rejected name", async () => {
  const parent = { session: { snapshotEvents: () => [], inheritedEventCount: 0 } } as unknown as Agent;
  const taken = new Set(["planner-1"]), seen: string[] = [];
  const duplicate = Object.assign(new Error("taken"), { code: "DUPLICATE_AGENT_NAME" });
  const tree = { rootOf: () => parent, async startActivation({ name, childId }: { name: string; childId: string }) {
    seen.push(name);
    if (taken.has(name)) throw duplicate;
    taken.add(name);
    return { childId, name: `parent/${name}` };
  } } as unknown as SubagentRuntime;
  const spec = { provider: "dsmm-planner", request: { parent, prompt: [] }, label: "plan", signal: new AbortController().signal, delivery: "caller" as const };
  const launch = (id: string, name?: string) => startNativeActivation(tree, { ...spec, childId: SessionId(id) }, { role: "planner", name });
  const children = await Promise.all([launch("uuid-a"), launch("uuid-b")]);
  assert.deepEqual(new Set(children.map(c => c.name)), new Set(["parent/planner-2", "parent/planner-3"]));
  assert.deepEqual(children.map(c => c.childId), ["uuid-a", "uuid-b"]);
  assert.equal((await launch("uuid-c", "api-check")).name, "parent/api-check");
  await assert.rejects(launch("uuid-d", "api-check"), duplicate);
  assert.equal(seen.length, 5);
  const failure = new Error("uncertain start");
  let calls = 0;
  const failed = { rootOf: () => parent, async startActivation() { calls++; throw failure; } } as unknown as SubagentRuntime;
  await assert.rejects(startNativeActivation(failed, spec, { role: "planner" }), failure);
  assert.equal(calls, 1);
});

test("direct child discovery preserves legacy catalogs and filters native-tree descendants by catalog parent", async () => {
  const parentId = SessionId("parent"), childId = SessionId("child"), signal = new AbortController().signal;
  const catalog = [{ id: childId, mode: "continuable" as const, label: "Direct child" }];
  const legacy = {
    async listChildren(id: SessionId, cancel?: AbortSignal) { assert.equal(id, parentId); assert.equal(cancel, signal); return catalog; },
    async listDescendants() { throw new Error("The direct catalog API must be used when available"); },
  };
  assert.equal(await listNativeChildren(legacy, parentId, signal), catalog);
  const tree = { async listDescendants(id: SessionId, cancel?: AbortSignal) {
    assert.equal(id, parentId); assert.equal(cancel, signal);
    return [
      { kind: "child" as const, id: childId, parentId, depth: 1, mode: "continuable" as const, label: "Direct child", activity: "running" as const, hasChildren: true },
      { kind: "child" as const, id: SessionId("grandchild"), parentId: childId, depth: 2, mode: "one-shot" as const, activity: "inactive" as const, hasChildren: false },
      { kind: "diagnostic" as const, id: SessionId("unreadable"), parentId, depth: 1, reason: "unavailable" as const },
    ];
  } };
  assert.deepEqual(await listNativeChildren(tree, parentId, signal), [...catalog, { id: SessionId("unreadable"), mode: "unknown" }]);
});

test("native-tree child discovery propagates catalog failures and cancellation", async () => {
  const failure = new Error("Catalog observation cancelled"), controller = new AbortController();
  controller.abort(failure);
  const tree = { async listDescendants(_id: SessionId, signal?: AbortSignal) { signal!.throwIfAborted(); return []; } };
  await assert.rejects(listNativeChildren(tree, SessionId("parent"), controller.signal), failure);
});

test("native-tree prompt transport preserves the human message identity and omits legacy address fields", async () => {
  const signal = new AbortController().signal;
  const request: SubagentPromptRequest = { requestId: "human-message" as SubagentPromptRequest["requestId"],
    parentSessionId: SessionId("parent"), childSessionId: SessionId("child"), mode: "continuable", delivery: "steer",
    content: [{ type: "text", text: "Continue the task" }], clientTimeZone: "Asia/Shanghai" };
  const receipt = { messageId: "accepted-message" };
  let seen: unknown;
  const legacy = { async prompt(value: unknown, cancel: AbortSignal) { seen = value; assert.equal(cancel, signal); return receipt; } };
  assert.equal(await promptNativeChild(legacy as unknown as SubagentRuntime, request, signal), receipt);
  assert.equal(seen, request);
  const tree = { ...legacy, rootOf(agent: Agent) { return agent; } };
  assert.equal(await promptNativeChild(tree as unknown as SubagentRuntime, request, signal), receipt);
  assert.deepEqual(seen, { requestId: request.requestId, childSessionId: request.childSessionId, delivery: "steer",
    content: request.content, clientTimeZone: "Asia/Shanghai" });
});

test("direct-child interrupts use the selected Host's acknowledged control protocol", () => {
  const parentId = SessionId("parent"), childId = SessionId("child"), receipt = { accepted: true as const };
  let seen: unknown[] | undefined;
  const parent = { id: parentId } as Agent;
  const legacy = { interruptByParent(...args: unknown[]) { seen = args; return receipt; } };
  assert.equal(interruptNativeChild(legacy as unknown as SubagentRuntime, childId, parent), receipt);
  assert.deepEqual(seen, [childId, parentId, "continuable"]);
  const tree = { rootOf(agent: Agent) { return agent; }, interrupt(...args: unknown[]) { seen = args; } };
  assert.deepEqual(interruptNativeChild(tree as unknown as SubagentRuntime, childId, parent), receipt);
  assert.deepEqual(seen, [childId, { kind: "ancestor", agent: parent }]);
});
