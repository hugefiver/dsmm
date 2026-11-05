import assert from "node:assert/strict";
import { cp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { configure, hostFixture, runCli, sse, successful, toolCall } from "./native-host-route-boundaries-fixture.mjs";

const args = { category: "dsmm-quick", level: "normal", description: "Observe real foreground activation",
  prompt: "Return the isolated observation answer", run_in_background: false };

test("built plugin publishes authenticated live foreground routes in the selected isolated Host", { timeout: 65_000 }, async () => {
  const f = await hostFixture(process.env.DSMM_TEST_DSH_ENTRY);
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  let childRequests = 0, firstCallId, observedWhileHeld = false;
  try {
    const native = createRequire(f.nativeEntry);
    for (const name of ["@deepseek-ai/dsh-api-gateway", "@deepseek-ai/dsh-typert-registry"]) {
      const target = join(f.packageDir, "node_modules", name);
      await mkdir(dirname(target), { recursive: true });
      await symlink(await realpath(dirname(native.resolve(`${name}/package.json`))), target,
        process.platform === "win32" ? "junction" : "dir");
    }
    await cp(new URL("./native-role-observation-integration-probe.mjs", import.meta.url),
      join(f.packageDir, "native-role-observation-integration-probe.mjs"));
    await configure(f, { reasoning: true, settings: { subagents: { enableRunInBackground: true },
      roleRouting: { "dsmm-orchestrator": { primary: { provider: "local", model: "configured-model" } },
        "dsmm-quick": { primary: { provider: "local", model: "child-model", reasoningEffort: "high", temperature: 0.2 } } } } });
    const patchPath = join(f.profileDir, "cordis.patch.yml");
    const patch = JSON.parse(await readFile(patchPath, "utf8"));
    patch.push({ id: "credentials", disabled: false }, { insert: [
      { id: "observation-connection", name: "@deepseek-ai/dsh-client-connection" },
      { id: "observation-probe", name: join(f.packageDir, "native-role-observation-integration-probe.mjs"),
        inject: ["typert", "typertGateway", "connection", "agents", "subagents", "dsmmChildren"],
        config: { controlUrl: `http://127.0.0.1:${f.port}/observation-control`, nativeEntry: f.nativeEntry } }
    ] });
    await writeFile(patchPath, JSON.stringify(patch));
    f.handler = async (body, res) => {
      if (body.probe === "release-observed-child") {
        await entered.promise;
        assert.equal(childRequests, 1);
        observedWhileHeld = true;
        released.resolve();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ released: true }));
        return;
      }
      if (body.model === "child-model") {
        childRequests++;
        assert.equal(body.reasoning_effort, "high", "the selected anchor adapter must dispatch the admitted effort");
        if (childRequests === 1) { entered.resolve(); await released.promise; }
        sse(res, body, { content: `isolated-observed-child-${childRequests}` });
        return;
      }
      assert.equal(body.model, "configured-model");
      const completed = body.messages.filter(message => message.role === "tool" && message.tool_call_id === firstCallId).length;
      if (firstCallId === undefined) {
        firstCallId = `call-${body.messages.length}`;
        toolCall(res, body, "dsmm_category", args);
      } else if (completed === 1) {
        sse(res, body, { tool_calls: [{ index: 0, id: firstCallId, type: "function",
          function: { name: "dsmm_category", arguments: JSON.stringify(args) } }] }, "tool_calls");
      } else {
        assert.equal(completed, 2, "a repeated provider call ID must execute and produce its own result");
        sse(res, body, { content: "isolated-role-observation-complete" });
      }
    };
    const result = await runCli(f, "isolated-role-observation", [], 55_000);
    successful(result);
    assert.equal(observedWhileHeld, true, "real Gateway evidence must precede HTTP gate release");
    assert.equal(childRequests, 2);
    const failures = result.evidence.filter(row => row.type === "observation-error");
    assert.deepEqual(failures, [], JSON.stringify(failures));
    const live = result.evidence.find(row => row.type === "observation-held");
    assert.ok(live, result.stderr);
    assert.equal(live.call.callId, firstCallId);
    assert.equal(live.call.rootCallId, firstCallId);
    assert.equal(live.parentHasResult, false);
    assert.equal(live.childRunningAfterClose, true);
    assert.equal(live.childScopeReadonly, true);
    assert.equal(live.independentPeerRefused, true);
    const results = result.evidence.filter(row => row.type === "observation-tool-result");
    assert.equal(results.length, 2, JSON.stringify(result.evidence));
    assert.equal(new Set(results.map(row => row.meta.childId)).size, 2,
      "reused native call ID must retain each execution's exact child metadata");
    for (const row of results) {
      assert.equal(row.callId, firstCallId);
      assert.equal(row.isError, false);
      assert.equal(row.meta.role, "dsmm-quick");
      assert.equal(row.meta.level, "normal");
      assert.equal(row.meta.delivery, "caller");
      assert.equal(row.meta.phase, "settled");
      assert.equal(row.meta.stopReason, "completed");
      assert.equal(row.meta.routeComparison.childId, row.meta.childId);
      assert.equal(row.meta.routeComparison.liveRoute.source, "own-native-request-header");
      assert.deepEqual(row.meta.routeComparison.liveRoute.route,
        { provider: "local", model: "child-model", reasoningEffort: "high" });
    }
    const starts = result.evidence.filter(row => row.type === "observation-native-start");
    const ends = result.evidence.filter(row => row.type === "observation-native-end");
    assert.equal(starts.length, 2, "each foreground execution must have one native activation");
    assert.equal(ends.length, 2, "observer closure must not add or suppress native settlements");
    for (const row of results) {
      assert.ok(starts.some(start => start.runId === row.meta.runId && start.childId === row.meta.childId));
      assert.ok(ends.some(end => end.runId === row.meta.runId && end.childId === row.meta.childId && end.stopReason === "completed"));
    }
    const owner = result.evidence.find(row => row.type === "observation-owner");
    assert.ok(owner);
    console.log(JSON.stringify({ anchor: f.nativeEntry, owner, gatedObservation: live,
      completedCalls: results.map(row => ({ callId: row.callId, childId: row.meta.childId, routeComparison: row.meta.routeComparison })) }));
  } finally {
    entered.resolve(); released.resolve();
    await f.dispose();
  }
});
