import assert from "node:assert/strict";
import { appendFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { HostConnectionService } from "@deepseek-ai/dsh-client-connection";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import { remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import { ROLE_CONTROL_REMOTE } from "./lib/role-control-remote.js";

export const inject = ["typert", "typertGateway", "connection", "agents", "subagents", "dsmmChildren"];
const record = value => appendFileSync(process.env.DSMM_HOST_EVIDENCE, `${JSON.stringify(value)}\n`);
const refused = code => error => {
  const remote = remoteErrorOf(error);
  return remote?.code === "dsmm-children/refused" && remote.details.code === code;
};

export async function apply(ctx, config) {
  const native = createRequire(config.nativeEntry), local = createRequire(import.meta.url);
  const sdk = {};
  for (const name of ["@deepseek-ai/cordis", "@deepseek-ai/dsh-agent", "@deepseek-ai/dsh-llm",
    "@deepseek-ai/dsh-subagent", "@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-api-gateway", "@deepseek-ai/dsh-typert-registry"]) {
    sdk[name] = realpathSync(local.resolve(name));
    assert.equal(sdk[name], realpathSync(native.resolve(name)), "probe SDK must resolve from the selected installed anchor");
  }
  assert.ok(ctx.typert instanceof TypertRegistry);
  assert.ok(ctx.typertGateway instanceof TypertGatewayService);
  assert.ok(ctx.connection instanceof HostConnectionService);
  assert.ok(ctx.subagents instanceof SubagentRuntime, "activation must remain owned by the real native runtime");
  record({ type: "observation-owner", runtime: ctx.subagents.constructor.name, sdk });
  const codec = ROLE_CONTROL_REMOTE.descriptors.find(row => row.method === "observe").result.create();
  const starts = new Map();
  ctx.on("subagent/start", info => {
    starts.set(info.runId, { childId: info.id, local: info.local });
    record({ type: "observation-native-start", runId: info.runId, childId: info.id, local: info.local });
  });
  ctx.on("subagent/end", info => record({ type: "observation-native-end", runId: info.runId,
    childId: info.id, stopReason: info.stopReason }));
  let observing = false;
  ctx.on("session/event", (session, event) => {
    const parent = ctx.agents.get(session.id);
    if (!parent || !ctx.agents.roots().includes(parent)) return;
    if (event.type === "tool/result") record({ type: "observation-tool-result", parentId: parent.id,
      callId: event.data.message.toolCallId, isError: event.data.message.isError === true, meta: event.data.meta });
    if (!observing && event.type === "request/header") {
      observing = true;
      void observeHeld(ctx, parent, codec, starts, config).catch(error => {
        record({ type: "observation-error", name: error.name, message: error.message,
          remote: remoteErrorOf(error) });
      });
    }
  });
}

async function observeHeld(ctx, parent, codec, starts, config) {
  const operator = ctx.connection.browserPeer;
  const independent = ctx.connection.createPeer({ principal: { kind: "owner" } });
  const request = (sessionId, peer = operator) => ({ namespace: "dsmmChildren", method: "observe", args: { sessionId }, peer });
  let stream, childStream;
  try {
    await assert.rejects(ctx.typertGateway.stream(request(parent.id, independent)), refused("not-owned"));
    stream = (await ctx.typertGateway.stream(request(parent.id)))[Symbol.asyncIterator]();
    const first = codec.parse((await stream.next()).value);
    assert.equal(first.type, "snapshot");
    assert.equal(first.sessionId, parent.id);
    let call = first.calls.find(row => row.actualRoute.status === "known" && row.phase === "active");
    while (!call) {
      const next = await stream.next();
      assert.equal(next.done, false);
      const frame = codec.parse(next.value);
      record({ type: "observation-frame", frame });
      if (frame.type === "update" && frame.call.actualRoute.status === "known" && frame.call.phase === "active") call = frame.call;
    }
    assert.equal(call.parentSessionId, parent.id);
    assert.equal(call.parentAdmissionEpoch, first.admissionEpoch);
    assert.equal(call.role, "dsmm-quick");
    assert.equal(call.level, "normal");
    assert.equal(call.routeSource, "primary");
    assert.equal(call.delivery, "caller");
    assert.equal(call.initialRoute.source, "invocation-capture");
    assert.deepEqual(call.initialRoute.route, { provider: "local", model: "child-model", reasoningEffort: "high" });
    assert.equal(call.actualRoute.source, "own-native-request-header");
    assert.deepEqual(call.actualRoute.route, { provider: "local", model: "child-model", reasoningEffort: "high" });
    assert.deepEqual(starts.get(call.runId), { childId: call.childId, local: true });
    const child = ctx.agents.get(call.childId);
    assert.ok(child);
    assert.equal(ctx.agents.isOwnedBy(child.id, parent), true);
    const ownHeader = child.session.snapshotEvents().findLast(event => event.type === "request/header");
    assert.equal(ownHeader.data.header.config.model, call.actualRoute.route.model);
    assert.equal(ownHeader.data.header.config.reasoningEffort, call.actualRoute.route.reasoningEffort);
    const parentHasResult = parent.session.snapshotEvents().some(event => event.type === "tool/result" && event.data.message.toolCallId === call.callId);
    assert.equal(parentHasResult, false, "the foreground call must still be pending at observation time");
    childStream = (await ctx.typertGateway.stream(request(child.id)))[Symbol.asyncIterator]();
    const childSnapshot = codec.parse((await childStream.next()).value);
    assert.equal(childSnapshot.type, "snapshot");
    assert.equal(childSnapshot.sessionId, child.id);
    await assert.rejects(ctx.typertGateway.invoke({ namespace: "dsmmChildren", method: "describe",
      args: { sessionId: child.id }, peer: operator }), refused("not-owned"));
    await childStream.return(); childStream = undefined;
    await stream.return(); stream = undefined;
    assert.equal(child.status, "running", "closing observation must leave the native child running");
    assert.equal(parent.session.snapshotEvents().some(event => event.type === "tool/result" && event.data.message.toolCallId === call.callId), false);
    record({ type: "observation-held", call, parentHasResult, childRunningAfterClose: true,
      childScopeReadonly: true, independentPeerRefused: true });
    const release = await fetch(config.controlUrl, { method: "POST", headers: {
      authorization: "Bearer fictional-loopback-only", "content-type": "application/json"
    }, body: JSON.stringify({ probe: "release-observed-child" }) });
    assert.equal(release.status, 200);
    await release.json();
  } finally {
    await childStream?.return();
    await stream?.return();
    await independent.dispose();
  }
}
