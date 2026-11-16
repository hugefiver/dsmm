import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeActivationIdentity, observedNativeTool } from "../src/client/NativeToolView-data.ts";
import type { NativeCallObservation } from "../src/role-control-types.ts";

const observation: NativeCallObservation = {
  kind: "native", toolName: "subagent", nativeName: "worker", childId: "child", callId: "call", rootCallId: "ptc-root",
  parentSessionId: "parent", parentAdmissionEpoch: "epoch", phase: "active", delivery: "parent",
  initialRoute: { status: "unknown", reason: "missing-invocation-capture" },
  actualRoute: { status: "known", source: "own-native-request-header", route: { provider: "native", model: "model" } },
};

test("native identity comes from a structured activation receipt, never task text or DSMM metadata", () => {
  assert.deepEqual(nativeActivationIdentity({ kind: "activation", name: "worker" }), { kind: "name", value: "worker" });
  assert.deepEqual(nativeActivationIdentity({ kind: "activation", subagentId: "child" }), { kind: "id", value: "child" });
  for (const meta of [undefined, null, [], "started subagent worker", { name: "worker" }, { kind: "activation", name: " " },
    { role: "dsmm-builder", level: "high", childId: "child" }]) assert.equal(nativeActivationIdentity(meta), undefined);
});

test("native observations match the exact atomic call and receipt identity", () => {
  const identity = nativeActivationIdentity({ kind: "activation", name: "worker" });
  assert.equal(observedNativeTool("subagent", "call", identity, observation), observation);
  assert.equal(observedNativeTool("subagent", "call", { kind: "id", value: "child" }, observation), observation);
  for (const [toolName, callId, receipt, candidate] of [
    ["fork", "call", identity, observation],
    ["subagent", "ptc-root", identity, observation],
    ["subagent", "call", undefined, observation],
    ["subagent", "call", { kind: "name", value: "previous-worker" }, observation],
    ["subagent", "call", identity, { ...observation, nativeName: undefined }],
    ["subagent", "call", identity, undefined],
  ] as const) assert.equal(observedNativeTool(toolName, callId, receipt, candidate), undefined);
  const roleObservation = { parentSessionId: "parent", parentAdmissionEpoch: "epoch", callId: "call", rootCallId: "call", childId: "child",
    role: "dsmm-builder", level: "normal", routeSource: "inherited", phase: "active", delivery: "parent", initialRoute: observation.initialRoute,
    actualRoute: observation.actualRoute } as const;
  assert.equal(observedNativeTool("subagent", "call", identity, roleObservation), undefined);
});
