import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { configure, hostFixture, rateLimit, retryBounds, runCli, sse, successful, toolCall } from "./native-host-route-boundaries-fixture.mjs";

const entry = process.env.DSMM_TEST_DSH_ENTRY;
const complete = (body, res) => sse(res, body, { content: "host-boundary-complete" });
const configured = { provider: "local", model: "configured-model" };
const roleRoute = patch => ({ "dsmm-orchestrator": { primary: configured, ...patch } });
function ownerEvidence(result, owner) {
  assert.deepEqual(result.evidence.filter(row => row.type === "owner").map(row => row.owner), [owner]);
}
function allRequests(result, model, temperature) {
  assert.ok(result.requests.length > 0);
  for (const body of result.requests) {
    assert.equal(body.model, model, "every HTTP step must use the admitted route");
    if (temperature !== undefined) assert.equal(body.temperature, temperature);
  }
}

await test("real isolated Host CLI route, owner, tools, child and recovery boundaries", {
  skip: entry === undefined ? "requires an explicit complete Host anchor (DSMM_TEST_DSH_ENTRY)" : false,
  timeout: 540_000
}, async t => {
  const f = await hostFixture(entry);
  try {
    await t.test("configured first request and two-process cold restoration preserve the admitted route", async () => {
      await configure(f, { settings: { roleRouting: roleRoute({ primary: { ...configured, temperature: 0.2 } }) } });
      f.handler = complete;
      const seed = await runCli(f, "configured-first");
      successful(seed); ownerEvidence(seed, "official"); allRequests(seed, "configured-model", 0.2);
      assert.equal(seed.requests.length, 1);
      assert.ok(seed.requests[0].tools.some(row => row.function.name.startsWith("dsmm_")));
      const sessionId = seed.events.find(event => event.type === "session").sessionId;
      assert.ok(sessionId);
      f.handler = (body, res) => f.requests.length < 3
        ? toolCall(res, body, "read", { file_path: "observed.txt" }) : complete(body, res);
      const unchanged = await runCli(f, "cold-unchanged", ["--session-id", sessionId]);
      successful(unchanged); allRequests(unchanged, "configured-model", 0.2);
      assert.equal(unchanged.requests.length, 3);
      assert.ok(unchanged.requests[0].messages.some(message => message.content === "host-boundary-complete"));
      await configure(f, { settings: { roleRouting: roleRoute({ primary: { provider: "local", model: "fallback-model", temperature: 0.2 } }) } });
      const changed = await runCli(f, "cold-changed", ["--session-id", sessionId]);
      successful(changed); allRequests(changed, "fallback-model", 0.2);
      assert.equal(changed.requests.length, 3);
    });
    await t.test("native policy retains the actual native model", async () => {
      await configure(f, { settings: { rootModelPolicy: "native" } }); f.handler = complete;
      const result = await runCli(f, "native-policy");
      successful(result); allRequests(result, "native-model");
    });
    for (const owner of ["official", "dsmm"]) for (const reasoning of [false, true]) {
      await t.test(`${owner} actual LLM owner completes ${reasoning ? "adapter-default medium with passthrough disabled" : "ordinary model"}`, async () => {
        await configure(f, { owner, reasoning, settings: { modelParameters: { passthrough: false } } }); f.handler = complete;
        const result = await runCli(f, `${owner}-${reasoning ? "medium" : "plain"}`);
        successful(result); ownerEvidence(result, owner); allRequests(result, "configured-model");
        assert.equal(result.requests.length, 1);
        if (reasoning) assert.equal(result.requests[0].reasoning_effort, "medium");
        else assert.equal(result.requests[0].reasoning_effort, undefined);
      });
    }
    await t.test("unobserved edit fails with FS_NOT_OBSERVED, then native read/edit/pwsh succeed", async () => {
      await configure(f);
      f.handler = (body, res) => {
        if (f.requests.length === 1) return toolCall(res, body, "edit", { file_path: "observed.txt", old_string: "original", new_string: "forbidden", replace_all: false });
        if (f.requests.length === 2) return toolCall(res, body, "read", { file_path: "observed.txt" });
        if (f.requests.length === 3) return toolCall(res, body, "edit", { file_path: "observed.txt", old_string: "original", new_string: "verified", replace_all: false });
        if (f.requests.length === 4) return toolCall(res, body, "pwsh", { description: "Verify isolated shell execution", command: "Write-Output 'host-boundary-shell-ok'" });
        return complete(body, res);
      };
      const result = await runCli(f, "native-tools"); successful(result);
      const results = result.events.filter(event => event.type === "tool_result");
      assert.equal(results.length, 4);
      assert.equal(results[0].status, "error");
      const sessionId = result.events.find(event => event.type === "session").sessionId;
      const failure = result.evidence.find(row => row.type === "tool-error" && row.sessionId === sessionId && row.callId === results[0].callId);
      assert.equal(failure?.code, "FS_NOT_OBSERVED", JSON.stringify({ result: results[0], evidence: result.evidence }));
      assert.deepEqual(results.slice(1).map(event => event.status), ["completed", "completed", "completed"]);
      assert.equal(await readFile(join(f.workspace, "observed.txt"), "utf8"), "verified isolated content\n");
      assert.ok(JSON.stringify(result.requests.at(-1).messages).includes("host-boundary-shell-ok"));
      allRequests(result, "configured-model");
    });
    await t.test("preset-free CLI parent delegates using only its actual HTTP tool schema", async () => {
      await configure(f);
      f.handler = (body, res) => {
        if (body.model === "child-model") return sse(res, body, { content: "host-boundary-child-result" });
        const parentCalls = f.requests.filter(row => row.model === "configured-model").length;
        if (parentCalls === 1) {
          const schema = body.tools.find(row => row.function.name === "dsmm_category")?.function;
          assert.ok(schema, "parameterized category tool must be admitted");
          const properties = schema.parameters.properties;
          assert.ok(properties.category.enum.includes("dsmm-quick"));
          const args = { description: "Verify isolated child", prompt: "Return the isolated child result.", category: "dsmm-quick" };
          if (properties.level) { assert.ok(properties.level.enum.includes("normal")); args.level = "normal"; }
          if (properties.run_in_background) args.run_in_background = false;
          return toolCall(res, body, schema.name, args);
        }
        return complete(body, res);
      };
      const result = await runCli(f, "preset-free-child"); successful(result);
      assert.ok(result.requests.some(body => body.model === "child-model"), "the real child must dispatch child-model HTTP");
      const tool = result.events.find(event => event.type === "tool_result");
      assert.equal(tool?.status, "completed", JSON.stringify(tool));
      assert.ok(JSON.stringify(tool.result).includes("host-boundary-child-result"));
      assert.ok(result.requests.filter(body => body.model === "configured-model").some(body => JSON.stringify(body.messages).includes("host-boundary-child-result")), "parent must receive the actual child result");
    });
    await t.test("fixed-selection resident child keeps its explicit native model on the next turn", async caseContext => {
      await configure(f, { residentChild: true, settings: { subagents: { enableRunInBackground: true, backgroundMode: "continuable" } } });
      let parentCalls = 0, fixedSelection;
      const manual = body => body.messages.some(message => message.role === "user" && message.content === "host-boundary-child-manual-next-turn");
      f.handler = (body, res) => {
        if (manual(body)) return sse(res, body, { content: "host-boundary-child-second-complete" });
        if (body.model === "child-model") return sse(res, body, { content: "host-boundary-child-initial-complete" });
        if (++parentCalls === 1) {
          fixedSelection = body.tools.some(row => row.function.name === "host_boundary_child_next_turn");
          if (!fixedSelection) return complete(body, res);
          const schema = body.tools.find(row => row.function.name === "dsmm_category")?.function;
          assert.ok(schema, "the parent must create the child through its actual category schema");
          const properties = schema.parameters.properties;
          assert.ok(properties.category.enum.includes("dsmm-quick"));
          const args = { description: "Create resident child", prompt: "Complete the initial isolated resident task.", category: "dsmm-quick" };
          if (properties.level) { assert.ok(properties.level.enum.includes("normal")); args.level = "normal"; }
          if (properties.run_in_background) args.run_in_background = true;
          return toolCall(res, body, schema.name, args);
        }
        if (parentCalls === 2) return toolCall(res, body, "host_boundary_child_next_turn", {});
        return complete(body, res);
      };
      const result = await runCli(f, "resident-child-native-selection"); successful(result);
      const capability = result.evidence.find(row => row.type === "running");
      assert.ok(capability, "the scoped SDK probe must observe the live parent's capability");
      assert.equal(fixedSelection, capability.fixedSelection);
      if (!fixedSelection) { caseContext.skip("requires the public native model.select capability"); return; }
      const results = result.events.filter(event => event.type === "tool_result");
      assert.equal(results.length, 2);
      assert.deepEqual(results.map(event => event.status), ["completed", "completed"], JSON.stringify(results));
      assert.ok(results[1].result.includes("host-boundary-child-manual-complete"));
      const requests = result.requests.filter(body => body.model === "child-model" || manual(body));
      assert.deepEqual(requests.map(body => body.model), ["child-model", "fallback-model"]);
      assert.ok(requests[1].messages.some(message => message.role === "assistant" && message.content === "host-boundary-child-initial-complete"),
        "the second HTTP turn must retain the same resident child's first result");
      const evidence = result.evidence.filter(row => row.type === "resident-child");
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].parentId, result.events.find(event => event.type === "session").sessionId);
      assert.notEqual(evidence[0].childId, evidence[0].parentId);
      assert.equal(evidence[0].completedTurns, 2);
    });
    await t.test("one 429 recovers on the same route and persistent 429 stops within its configured retry budget", async () => {
      await configure(f, { settings: { roleRouting: roleRoute({ strategy: "startup-lock", rateLimit: retryBounds }) } });
      f.handler = (body, res) => f.requests.length === 1 ? rateLimit(res) : complete(body, res);
      const once = await runCli(f, "single-429"); successful(once);
      assert.equal(once.requests.length, 2); allRequests(once, "configured-model");
      f.handler = (_body, res) => rateLimit(res);
      const persistent = await runCli(f, "persistent-429");
      assert.notEqual(persistent.code, 0, "exhausted quota must be a CLI failure");
      assert.equal(persistent.requests.length, 2, "one configured retry permits exactly two HTTP attempts");
      allRequests(persistent, "configured-model");
      const terminal = persistent.events.findLast(event => event.type === "status" && event.phase === "turn_end");
      assert.equal(terminal?.reason?.kind, "error", "official CLI must report failed settlement");
      assert.equal(typeof terminal.reason.error.code, "string");
    });
    await t.test("scoped public SDK idle picker, off/on and profile Apply bind the next real HTTP turn", async () => {
      await configure(f, { lifecycle: true });
      let outerRequests = 0;
      const label = body => body.messages.findLast(message => message.role === "user" && typeof message.content === "string"
        && message.content.startsWith("host-boundary-lifecycle:"))?.content.slice("host-boundary-lifecycle:".length);
      f.handler = (body, res) => {
        if (label(body)) return complete(body, res);
        if (++outerRequests === 1) return toolCall(res, body, "host_boundary_lifecycle", {});
        return complete(body, res);
      };
      const result = await runCli(f, "sdk-lifecycle-driver"); successful(result);
      const tool = result.events.find(event => event.type === "tool_result");
      assert.equal(tool?.status, "completed", JSON.stringify(tool));
      assert.ok(tool.result.includes("host-boundary-lifecycle-complete"), JSON.stringify({ tool,
        lifecycle: result.evidence.filter(row => row.type === "lifecycle") }));
      const requests = result.requests.filter(body => label(body));
      assert.deepEqual(requests.map(label), ["initial", "picker-next-turn", "mode-off", "mode-on", "profile-applied"]);
      assert.deepEqual(requests.map(body => body.model), ["configured-model", "configured-model", "native-model", "configured-model", "fallback-model"]);
      assert.equal(requests.at(-1).temperature, 0.2);
      assert.deepEqual(result.evidence.filter(row => row.type === "lifecycle").map(row => row.label), requests.map(label));
    });
    await t.test("same-route downstream request controls preserve zero temperature and the output cap across a retry", async () => {
      await configure(f, { owner: "official", requestControls: true,
        settings: { roleRouting: roleRoute({ strategy: "startup-lock", rateLimit: retryBounds }) } });
      f.handler = (body, res) => f.requests.length === 1 ? rateLimit(res) : complete(body, res);
      const result = await runCli(f, "downstream-request-controls"); successful(result);
      ownerEvidence(result, "official");
      assert.equal(result.requests.length, 2);
      for (const body of result.requests) {
        assert.equal(body.model, "configured-model");
        assert.equal(body.temperature, 0);
        assert.equal(body.max_tokens, 90);
      }
    });
    await t.test("same-selection fallback replaces route parameters only on a Host that admits switching", async () => {
      await configure(f, { settings: { roleRouting: roleRoute({ primary: { ...configured, temperature: 0.2 },
        fallbackRoutes: [{ ...configured, temperature: 0.8 }], strategy: "rate-limit-fallback", rateLimit: retryBounds }) } });
      f.handler = (body, res) => f.requests.length === 1 ? rateLimit(res) : complete(body, res);
      const result = await runCli(f, "same-selection-fallback"); successful(result);
      const capability = result.evidence.find(row => row.type === "running");
      assert.ok(capability);
      assert.equal(result.requests.length, 2);
      allRequests(result, "configured-model");
      assert.deepEqual(result.requests.map(body => body.temperature), [0.2, capability.fixedSelection ? 0.2 : 0.8]);
    });
    for (const failure of ["select", "association"]) await t.test(`configured-root ${failure} restoration microtask fails closed without another HTTP request`, async caseContext => {
      await configure(f, { microtaskFailure: true });
      let outerCalls = 0, fixedSelection;
      const prefix = `host-boundary-microtask:${failure}:`;
      const probe = body => body.messages.some(message => message.role === "user" && typeof message.content === "string" && message.content.startsWith(prefix));
      f.handler = (body, res) => {
        if (probe(body)) return complete(body, res);
        if (++outerCalls === 1) {
          fixedSelection = body.tools.some(row => row.function.name === "host_boundary_microtask_failure");
          if (fixedSelection) return toolCall(res, body, "host_boundary_microtask_failure", { failure });
        }
        return complete(body, res);
      };
      const result = await runCli(f, `microtask-${failure}-failure`); successful(result);
      const capability = result.evidence.find(row => row.type === "running");
      assert.ok(capability);
      assert.equal(fixedSelection, capability.fixedSelection);
      if (!fixedSelection) { caseContext.skip("requires the public native model.select capability"); return; }
      const tool = result.events.find(event => event.type === "tool_result");
      assert.equal(tool?.status, "completed", JSON.stringify(tool));
      assert.ok(tool.result.includes(`host-boundary-microtask-${failure}-complete`));
      const requests = result.requests.filter(probe);
      assert.equal(requests.length, 1, "only the successful initial turn may dispatch HTTP; the denied follow-up must dispatch zero");
      assert.equal(requests[0].model, "configured-model");
      const evidence = result.evidence.filter(row => row.type === "microtask-failure" && row.failure === failure);
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].injections, 1);
      assert.equal(evidence[0].uncaught, 0);
      assert.equal(typeof evidence[0].terminalCode, "string");
      assert.ok(evidence[0].errorCodes.includes("UNAUTHORIZED"));
    });
    await t.test("fixed-selection capability bounds same-step fallback while legacy Host keeps fallback", async () => {
      await configure(f, { settings: { roleRouting: roleRoute({ strategy: "rate-limit-fallback", rateLimit: retryBounds,
        fallbackRoutes: [{ provider: "local", model: "fallback-model" }] }) } });
      f.handler = (body, res) => f.requests.length === 1 ? rateLimit(res) : complete(body, res);
      const result = await runCli(f, "429-capability"); successful(result);
      const running = result.evidence.find(row => row.type === "running");
      assert.ok(running, "scoped public SDK probe must report the actual model-selection capability");
      assert.equal(result.requests.length, 2);
      assert.deepEqual(result.requests.map(body => body.model), ["configured-model", running.fixedSelection ? "configured-model" : "fallback-model"]);
    });
  } finally { await f.dispose(); }
});
