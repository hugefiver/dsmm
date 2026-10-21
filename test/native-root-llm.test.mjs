import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeRootLlmFixture, loadNative, nativeCli, nativeEntry } from "./native-root-llm-fixture.mjs";
import { DsmmNativeLlmRuntime } from "../src/llm-runtime.ts";
import { sessionEvents } from "../src/session-scope.ts";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createDsmmRoleLlmOwner } from "../src/role-llm-runtime.ts";

test("migrated Core applies and sends a real OFF-mode Root route before DW spawn exists", { timeout: 20000 }, async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: false }, { lateSpawn: true });
  const integration = f.ctx.get("dsmmRuntimeIntegration"), runtime = f.ctx.get("dsmmProfileRuntime");
  const owner = integration.owner;
  assert.equal(integration.runtime.getProvider("spawn"), undefined);
  assert.equal(integration.runtime.authority.view().deliveryFenceReady, false);
  const agent = await f.create(undefined, { provider: "local", model: "root-model", before_spawn: false });
  const before = runtime.admission(agent);
  const snapshot = await runtime.getSession(agent);
  const saved = await runtime.save({ id: "core-before-spawn", expectedRevision: null, content: JSON.stringify({ version: 1, id: "core-before-spawn",
    settings: { roleRouting: { "dsmm-orchestrator": { primary: { provider: "absent", model: "not-listed", reasoningEffort: "future", raw: false } } } } }) });
  const next = await runtime.selectSession({ sessionId: agent.id, id: saved.id, expectedRevision: saved.revision,
    expectedSelectionRevision: snapshot.selection.selectionRevision, expectedAdmissionEpoch: snapshot.admissionEpoch }, agent);
  assert.notEqual(runtime.admission(agent), before);
  assert.equal(next.admissionEpoch, runtime.admission(agent).epoch);
  assert.equal(f.bodies.length, 0); assert.equal(f.requests.length, 0);
  assert.throws(() => integration.runtime.authority.acquireParentTicket(agent), { code: "UNAUTHORIZED" });
  await f.run(agent);
  assert.deepEqual(f.errors, []);
  assert.equal(f.bodies.length, 1); assert.equal(f.bodies[0].body.before_spawn, false);
  await f.spawn();
  assert.equal(f.ctx.get("dsmmRuntimeIntegration").owner, owner);
  assert.equal(integration.runtime.authority.acquireParentTicket(agent).admission, runtime.admission(agent));
});

test("Core module projection keeps the same live permission owner mounted while its rules are unsynced and becomes unknown on retirement", async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: false });
  const agent = await f.create(), runtime = f.ctx.get("dsmmProfileRuntime"), permissions = f.ctx.get("dsmmPermissionController");
  const permission = () => runtime.getSettings.moduleStates(agent).find(row => row.descriptor.id === "permission-control");
  assert.equal(permission().startupMounted, true);
  permissions.rules.invalidate();
  assert.equal(permissions.rules.status().state, "unsynced");
  assert.equal(permissions.rules.signal.aborted, true);
  assert.equal(permission().startupMounted, true);
  const dsmm = [...f.ctx.loader.entries()].find(entry => entry.options.id === "dsmm");
  await dsmm.update({ disabled: true }); await f.ctx.loader.await();
  assert.equal(permission().startupMounted, null);
});

test("withdrawing real spawn during DW credential await prevents an enhanced Root HTTP dispatch", async t => {
  const f = await nativeRootLlmFixture(t, {}, { deferredCredentials: true });
  const agent = await f.create("dsmm-orchestrator", { provider: "local", model: "root-model", dw_must_not_send: false });
  const pause = f.ctx.get("fixtureCredentialControl").pauseNext(); t.after(pause.release);
  const run = f.run(agent); await pause.entered;
  const spawn = [...f.ctx.loader.entries()].find(entry => entry.options.name === "@deepseek-ai/dsh-subagent-spawn-in-process");
  await spawn.update({ disabled: true }); await f.ctx.loader.await();
  assert.equal(f.ctx.get("dsmmRuntimeIntegration").runtime.authority.view().deliveryFenceReady, false);
  pause.release(); await run;
  assert.equal(f.bodies.length, 0);
});

test("missing Core preflight classifies a complete native stop proposal as enhanced without an opaque envelope", async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: false });
  let frame;
  f.ctx.on("agent/request", async (current, next) => { frame = current; return next(); }, { global: true });
  const agent = await f.create(); await f.run(agent);
  const dsmm = [...f.ctx.loader.entries()].find(entry => entry.options.id === "dsmm");
  await dsmm.update({ disabled: true }); await f.ctx.loader.await();
  const owner = createDsmmRoleLlmOwner(f.ctx, f.ctx.get("dsmmLlmRoutes"));
  await assert.rejects(owner.preflight(frame, { provider: "local", model: "root-model", stop: ["END"] }), { code: "DSMM_NOT_READY" });
  assert.equal(f.bodies.length, 1);
});

test("uncaptured stop without opaque parameters cannot dispatch through prepare or direct stream after Core retirement", async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: false });
  const dsmm = [...f.ctx.loader.entries()].find(entry => entry.options.id === "dsmm");
  await dsmm.update({ disabled: true }); await f.ctx.loader.await();
  const { createUserMessage } = await loadNative("@deepseek-ai/dsh-llm");
  const config = { provider: "local", model: "root-model", stop: ["END"] };
  await t.test("uncaptured prepare", async () => {
    await assert.rejects(f.ctx.llm.prepareCall(config, new AbortController().signal), { code: "INVALID_PREPARED_CALL" });
    assert.equal(f.bodies.length, 0);
  });
  await t.test("direct stream", async () => {
    let failed = false, failureCode;
    try {
      for await (const chunk of f.ctx.llm.stream({ ...config, signal: new AbortController().signal,
        messages: [createUserMessage({ content: [{ type: "text", text: "Must not send an unadmitted stop" }], source: { kind: "user" } })] })) {
        if (chunk.type === "finish" && chunk.reason.kind === "error") { failed = true; failureCode = chunk.reason.failure?.code; }
      }
    } catch (error) { failed = true; failureCode = error.code; }
    assert.equal(f.bodies.length, 0);
    assert.equal(failed, true);
    assert.equal(failureCode, "INVALID_PREPARED_CALL");
  });
  await t.test("official Root Loop", async () => {
    const root = await f.create(undefined, config);
    await f.run(root);
    assert.equal(f.errors.at(-1)?.code, "INVALID_PREPARED_CALL");
    assert.equal(f.bodies.length, 0);
  });
});

test("retired Core retains stock-equivalent third-party prepare/stream, native defaults, single consumption and absence errors", async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: false });
  const dsmm = [...f.ctx.loader.entries()].find(entry => entry.options.id === "dsmm");
  await dsmm.update({ disabled: true }); await f.ctx.loader.await();
  const { LlmAdapter, ReasoningEffortId, createUserMessage } = await loadNative("@deepseek-ai/dsh-llm");
  const calls = [];
  f.ctx.llm.registerAdapter(["ordinary-stock"], new class extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, defaultMaxTokens: 64,
      reasoning: { efforts: ["stock-default", "stock-explicit"].map(id => ({ id: ReasoningEffortId(id), name: id })), defaultEffort: ReasoningEffortId("stock-default") } }; }
    async *stream(options) { calls.push(options); yield { type: "finish", reason: { kind: "stop" } }; }
  }());
  const config = { provider: "ordinary-stock", model: "outside-catalog", stop: ["END"], temperature: 0 };
  const prepared = await f.ctx.llm.prepareCall(config, new AbortController().signal);
  assert.equal(prepared.config.maxTokens, 64);
  assert.equal(prepared.config.reasoningEffort, "stock-default");
  const request = { ...prepared.config, signal: new AbortController().signal,
    messages: [createUserMessage({ content: [{ type: "text", text: "Ordinary native request" }], source: { kind: "user" } })] };
  for await (const chunk of prepared.stream(request)) assert.notEqual(chunk.reason?.kind, "error");
  assert.throws(() => prepared.stream(request), { code: "INVALID_PREPARED_CALL" });
  for await (const chunk of f.ctx.llm.stream({ ...request, reasoningEffort: "stock-explicit" })) assert.notEqual(chunk.reason?.kind, "error");
  assert.equal(calls.length, 2);
  for (const call of calls) { assert.deepEqual(call.stop, ["END"]); assert.equal(call.temperature, 0); assert.equal(call.maxTokens, 64); }
  assert.equal(calls[1].reasoningEffort, "stock-explicit");
  await assert.rejects(f.ctx.llm.prepareCall({ provider: "not-registered", model: "missing" }), { code: "NO_ADAPTER" });
  await assert.rejects(f.ctx.llm.prepareCall({ ...config, reasoningEffort: "unsupported-stock-effort" }), { code: "UNSUPPORTED_REASONING_EFFORT" });
  await assert.rejects(f.ctx.llm.prepareCall({ ...config, unclassified_parameter: false }), { code: "INVALID_CONFIG" });
  assert.equal(calls.length, 2); assert.equal(f.bodies.length, 0);
});

test("a retained DSMM Root without opaque parameters cannot become an ordinary call after Core retirement", async t => {
  const f = await nativeRootLlmFixture(t);
  const root = await f.create("dsmm-orchestrator");
  const dsmm = [...f.ctx.loader.entries()].find(entry => entry.options.id === "dsmm");
  await dsmm.update({ disabled: true }); await f.ctx.loader.await();
  await f.run(root);
  assert.equal(f.bodies.length, 0);
  assert.equal(f.errors.at(-1)?.code, "INVALID_PREPARED_CALL");
  const { createUserMessage } = await loadNative("@deepseek-ai/dsh-llm");
  assert.throws(() => f.ctx.llm.stream({ provider: "local", model: "root-model", sessionId: root.id,
    messages: [createUserMessage({ content: [{ type: "text", text: "No retained role bypass" }], source: { kind: "user" } })],
    signal: new AbortController().signal }), { code: "INVALID_PREPARED_CALL" });
  assert.equal(f.bodies.length, 0);
});

test("ordinary source-selected native owner preserves the stock registry and Core OFF requests", async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: false });
  assert.ok(f.ctx.llm instanceof DsmmNativeLlmRuntime);
  const agent = await f.create();
  await f.run(agent);
  assert.deepEqual(f.errors, []);
  assert.ok(f.bodies.some(({ body }) => JSON.stringify(body.messages).includes("preserve-native-instructions")));
  assert.equal(f.ctx.llm.listProviders().filter(row => row.id === "local").length, 1);
  assert.equal(f.ctx.llm.listConfigurableProviders().find(row => row.provider === "local").settingsNs, "llm-pi-ai");
  assert.equal(await f.ctx.sessions.flush(agent.session), true);
});

test("real admitted Root raw route reaches the official HTTP translator losslessly", async t => {
  const raw = { provider: "local", model: "root-model", reasoningEffort: "future-effort", temperature: 0, maxTokens: 128,
    full: false, zero: 0, nil: null, nested: [[], {}, { x: false }] };
  const f = await nativeRootLlmFixture(t, { roleRouting: { "dsmm-orchestrator": { primary: raw } } });
  const agent = await f.create("dsmm-orchestrator", raw);
  await f.run(agent);
  assert.deepEqual(f.errors, []);
  const body = f.bodies.find(row => row.body.reasoning_effort === "future-effort")?.body;
  assert.ok(body, JSON.stringify(f.bodies.map(({ body }) => ({ model: body.model, effort: body.reasoning_effort, full: body.full }))));
  for (const key of ["full", "zero", "nil", "nested"]) assert.deepEqual(body[key], raw[key]);
  assert.equal(body.temperature, 0); assert.equal(body.max_tokens, 128);
  const header = agent.session.requestHeader();
  assert.deepEqual(header.config.customParameters.nested, raw.nested);
  const messages = sessionEvents(agent.session).filter(event => event.type === "assistant/message");
  assert.ok(messages.some(event => event.data.usage?.totalTokens === 7));
});

test("existing SDK LLM isolation metadata remains functional for a Core-only native Loop", async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: false }, { llmRealm: "owned-native-models", globalConfig: { modules: { deepwork: { enabled: false } } } });
  const agent = await f.create(undefined, { provider: "local", model: "root-model", named_realm: false });
  assert.equal(f.ctx.get("llm"), undefined);
  assert.ok(agent.ctx.get("llm") instanceof DsmmNativeLlmRuntime);
  await f.run(agent);
  assert.deepEqual(f.errors, []);
  assert.equal(f.bodies.length, 1);
  assert.equal(f.bodies[0].body.named_realm, false);
});

test("official configured Root keeps launcher identity and Loop configuration after migration", async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: false }, {
    loopConfig: { maxParallelToolCalls: 1, agents: [{ id: "configured-root", sessionId: "config-fallback-identity", provider: "local", model: "root-model" }] },
    configuredIdentities: { "configured-root": { id: "launcher-owned-root", resume: false } },
  });
  const { AgentLoop } = await loadNative("@deepseek-ai/dsh-agent-loop");
  assert.ok(f.ctx.agentLoop instanceof AgentLoop);
  assert.equal(f.ctx.agentLoop.config.maxParallelToolCalls.get(), 1);
  const agent = f.ctx.agents.get("launcher-owned-root");
  assert.ok(agent, "the official Loop must publish its configured Root");
  assert.equal(agent.session.id, "launcher-owned-root");
  await f.run(agent);
  assert.deepEqual(f.errors, []);
  assert.equal(f.bodies.length, 1);
  assert.ok(f.bodies[0].body.messages.some(message => JSON.stringify(message).includes("preserve-native-instructions")));
  assert.equal(await f.ctx.sessions.flush(agent.session), true);
});

test("current registered config retires an enhanced generation without changing provider directory", async t => {
  const f = await nativeRootLlmFixture(t);
  const resolver = f.ctx.get("dsmmLlmRoutes");
  const generation = resolver.generation("local");
  const prepared = await generation.prepareCall("local", "root-model", new AbortController().signal);
  await f.setProvider({ apiKeyEnv: "DSMM_REPLACEMENT_FICTIONAL" });
  assert.throws(() => generation.assertCurrent());
  assert.equal(f.ctx.llm.listProviders().filter(row => row.id === "local").length, 1);
  const { createUserMessage } = await loadNative("@deepseek-ai/dsh-llm");
  assert.throws(() => prepared.stream({ provider: "local", model: "root-model", customParameters: { raw: false }, messages: [createUserMessage({ content: [{ type: "text", text: "stale" }], source: { kind: "user" } })] }));
  assert.equal(f.bodies.length, 0);
});

test("ordinary managed SettingsForms edits retain native provider ownership and retire raw generations", async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: false });
  const generation = f.ctx.get("dsmmLlmRoutes").generation("local");
  const descriptor = f.ctx.settings.describe().find(row => row.ns === "llm-pi-ai");
  assert.ok(descriptor);
  await f.ctx.settings.mutate("llm-pi-ai", [{ op: "set", path: ["providers", "local", "baseURL"], value: `${f.provider.baseURL}/native-settings` }], descriptor.revision);
  await f.ctx.loader.await();
  assert.throws(() => generation.assertCurrent());
  assert.equal(f.ctx.llm.listProviders().filter(row => row.id === "local").length, 1);
  const agent = await f.create(undefined, { provider: "local", model: "root-model", from_settings: false });
  await f.run(agent);
  assert.deepEqual(f.errors, []);
  assert.equal(f.bodies.length, 1);
  assert.ok(f.bodies[0].url.includes("/native-settings/"));
  assert.equal(f.bodies[0].body.from_settings, false);
});

test("native SettingsForms permission save revokes an awaiting real Core LLM request before wire", async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: false }, { deferredCredentials: true, managedSettings: true });
  const permissions = f.ctx.get("dsmmPermissionController");
  assert.ok(permissions, "the ordinary main entry must install the real permission controller");
  assert.ok(f.ctx.get("dsmmPermissions"), "the ordinary main entry must publish the shared permission RPC");
  const previous = permissions.rules.getPolicy();
  const previousSignal = permissions.rules.signal;
  const route = { provider: "local", model: "root-model", permission_save: false };
  const agent = await f.create(undefined, route);
  const pause = f.ctx.get("fixtureCredentialControl").pauseNext();
  t.after(pause.release);
  const run = f.run(agent);
  await pause.entered;
  const descriptor = f.ctx.settings.describe().find(row => row.ns === "dsmm");
  assert.ok(descriptor);
  await f.ctx.settings.mutate("dsmm", [{ op: "set", path: ["permissionControl", "outsideReads"], value: "ask" }], descriptor.revision);
  await f.ctx.loader.await();
  assert.equal(previousSignal.aborted, true);
  assert.notEqual(permissions.rules.getPolicy().revision, previous.revision);
  assert.equal(permissions.rules.status().state, "synced");
  pause.release(); await run;
  assert.equal(f.bodies.length, 0);
  const fresh = await f.create(undefined, route);
  await f.run(fresh);
  assert.equal(f.bodies.length, 1);
  assert.equal(f.bodies[0].body.permission_save, false);
});

test("plain native Root turns refresh a direct permission file edit before admitting the next model call", { timeout: 40000 }, async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: false }, {
    globalConfig: { permissionControl: { outsideReads: "inherit" } },
  });
  const root = await f.create(), profiles = f.ctx.get("dsmmProfileRuntime"), permissions = f.ctx.get("dsmmPermissionController");
  const owner = f.ctx.get("dsmmCoreLlmOwner"), admission = profiles.admission(root);
  const frames = [];
  f.ctx.on("agent/request", (frame, next) => { frames.push(frame); return next(); }, { global: true });
  await f.run(root, "First plain native turn");
  assert.deepEqual(f.errors, []); assert.equal(f.bodies.length, 1);
  const previous = permissions.rules.getPolicy(), previousSignal = permissions.rules.signal;
  await writeFile(join(f.home, "plugins", "dsmm", "config.json"), JSON.stringify({ permissionControl: { outsideReads: "deny" } }));
  await f.run(root, "Second plain native turn after a direct file edit");
  await f.run(root, "Third plain native turn");
  assert.deepEqual(f.errors, []); assert.equal(f.bodies.length, 3);
  assert.equal(frames.length, 3); assert.ok(frames.every(frame => !frame.signal.aborted));
  assert.equal(previousSignal.aborted, true);
  assert.notEqual(permissions.rules.signal, previousSignal); assert.equal(permissions.rules.signal.aborted, false);
  assert.notEqual(permissions.rules.getPolicy().revision, previous.revision);
  assert.equal(permissions.rules.getPolicy().policy.outsideReads, "deny");
  assert.equal(permissions.rules.status().state, "synced");
  assert.equal(f.ctx.get("dsmmCoreLlmOwner"), owner);
  assert.equal(profiles.admission(root), admission);
  const events = sessionEvents(root.session);
  assert.equal(events.filter(event => event.type === "tool/result").length, 0);
  assert.equal(events.filter(event => event.type === "turn/end" && event.data.reason.kind === "completed").length, 3);
  const messages = events.filter(event => event.type === "assistant/message");
  assert.equal(messages.length, 3); assert.ok(messages.every(event => event.data.usage?.totalTokens === 7));
});

test("completed model calls release their permission fence before native tool refresh without cancelling the turn", { timeout: 40000 }, async t => {
  for (const enhanced of [false, true]) await t.test(enhanced ? "enhanced provider stream" : "stock prepared stream", async t => {
    let f, toolName, command, refreshFile = false, sends = 0;
    const fConfig = { permissionControl: { nativeCommands: { enabled: false, entries: [] } } };
    f = await nativeRootLlmFixture(t, { defaultActive: false }, {
      migrateShell: true, approvalPolicy: "never", globalConfig: fConfig,
      async beforeRespond() {
        if (!refreshFile) return;
        refreshFile = false;
        await writeFile(join(f.home, "plugins", "dsmm", "config.json"), JSON.stringify({ permissionControl: { nativeCommands: {
          enabled: false, entries: [{ id: "inactive-output", mode: "allow", sandboxMode: "danger-full-access",
            match: { tool: process.platform === "win32" ? "pwsh" : "bash", executable: process.platform === "win32" ? "Write-Output" : "printf",
              args: ["42"], workingDirectory: f.workspace } }],
        } } }));
      },
      respond(body, res) {
        const tool = ++sends % 2 === 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        const base = { id: "permission-refresh", object: "chat.completion.chunk", created: 1, model: body.model };
        const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `output-${sends}`, type: "function", function: {
          name: toolName, arguments: JSON.stringify({ command, workdir: f.workspace, description: "Return the native output" }) } }] }
          : { role: "assistant", content: "native tool completed" };
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
        res.end("data: [DONE]\n\n");
      },
    });
    const { symbols } = await loadNative("@deepseek-ai/cordis");
    const original = value => Reflect.get(value, symbols.original) ?? value;
    const permissions = f.ctx.get("dsmmPermissionController"), owner = f.ctx.get("dsmmCoreLlmOwner"), profiles = f.ctx.get("dsmmProfileRuntime");
    const kind = process.platform === "win32" ? "pwsh" : "bash";
    toolName = permissions.coverage().find(row => row.kind === kind)?.name;
    assert.ok(toolName);
    command = kind === "pwsh" ? "Write-Output 42" : "printf 42";
    const streams = [], executions = [], frames = [];
    f.ctx.on("agent/request", async (frame, next) => { frames.push(frame); return next(); }, { global: true });
    f.ctx.on("llm/stream", (request, next) => {
      const stream = next(), observed = { request, finished: false }; streams.push(observed);
      return (async function* () { try { yield* stream; } finally { observed.finished = true; } })();
    }, { global: true });
    f.ctx.on("tools/pre-execute", async (exec, next) => {
      if (exec.name !== toolName) return next();
      const observed = { streamFinished: streams.at(-1)?.finished, beforeAborted: exec.signal.aborted };
      const decision = await next();
      executions.push({ ...observed, decision, afterAborted: exec.signal.aborted, policy: permissions.rules.getPolicy(), signal: permissions.rules.signal });
      return decision;
    }, { prepend: true, global: true });
    const route = enhanced ? { provider: "local", model: "root-model", lifecycle_probe: false } : undefined;
    const control = await f.create(undefined, route); await f.run(control);
    assert.equal(f.bodies.length, 2); assert.deepEqual(f.errors, []);
    const root = await f.create(undefined, route), admission = profiles.admission(root), previous = permissions.rules.getPolicy(), oldSignal = permissions.rules.signal;
    refreshFile = true; await f.run(root);
    assert.ok(streams.every(stream => stream.finished));
    assert.ok(executions.every(exec => exec.streamFinished));
    assert.equal(frames.at(-1).signal.aborted, false);
    assert.deepEqual(f.errors, []);
    assert.equal(f.bodies.length, 4);
    assert.equal(executions.length, 2);
    assert.ok(executions.every(exec => !exec.beforeAborted && !exec.afterAborted && exec.decision.kind === "allow"));
    assert.equal(oldSignal.aborted, true);
    assert.notEqual(executions[1].signal, oldSignal); assert.equal(executions[1].signal.aborted, false);
    assert.notEqual(executions[1].policy.revision, previous.revision);
    assert.equal(executions[1].policy.policy.nativeCommands.enabled, false);
    assert.equal(executions[1].policy.policy.nativeCommands.entries.length, 1);
    const status = permissions.rules.status();
    assert.equal(status.state, "synced"); assert.equal(status.savedRevision, status.runtimeRevision); assert.equal(status.mounted, true);
    assert.equal(original(f.ctx.get("dsmmCoreLlmOwner")), original(owner));
    assert.equal(original(f.ctx.get("dsmmPermissionController")), original(permissions));
    assert.equal(profiles.admission(root), admission);
    for (const index of [1, 3]) assert.ok(f.bodies[index].body.messages.some(message => message.role === "tool" && JSON.stringify(message.content).includes("42")));
    assert.ok(sessionEvents(root.session).some(event => event.type === "turn/end" && event.data.reason.kind === "completed"));
    assert.ok(sessionEvents(root.session).some(event => event.type === "assistant/message" && event.data.usage?.totalTokens === 7));
  });
});

test("direct permission source refresh still revokes an unfinished credential-bound model call and requires a fresh call", { timeout: 40000 }, async t => {
  for (const enhanced of [false, true]) await t.test(enhanced ? "enhanced preparation" : "stock preparation", async t => {
    const f = await nativeRootLlmFixture(t, { defaultActive: false }, { deferredCredentials: true,
      globalConfig: { permissionControl: { nativeCommands: { enabled: false, entries: [] } } } });
    const permissions = f.ctx.get("dsmmPermissionController"), profiles = f.ctx.get("dsmmProfileRuntime"), frames = [];
    f.ctx.on("agent/request", (frame, next) => { frames.push(frame); return next(); }, { global: true });
    const agent = await f.create(undefined, enhanced ? { provider: "local", model: "root-model", lifecycle_probe: false } : undefined);
    const admission = profiles.admission(agent), oldSignal = permissions.rules.signal, previous = permissions.rules.getPolicy();
    const pause = f.ctx.get("fixtureCredentialControl").pauseNext(); t.after(pause.release);
    const run = f.run(agent); await pause.entered;
    assert.equal(frames[0].signal.aborted, false);
    await writeFile(join(f.home, "plugins", "dsmm", "config.json"), JSON.stringify({ permissionControl: { outsideReads: "ask", nativeCommands: { enabled: false, entries: [] } } }));
    await permissions.rules.refresh();
    assert.equal(oldSignal.aborted, true); assert.equal(frames[0].signal.aborted, true);
    assert.notEqual(permissions.rules.signal, oldSignal); assert.equal(permissions.rules.signal.aborted, false);
    assert.notEqual(permissions.rules.getPolicy().revision, previous.revision);
    assert.equal(permissions.rules.status().state, "synced"); assert.equal(profiles.admission(agent), admission);
    pause.release(); await run;
    assert.equal(f.bodies.length, 0);
    await f.run(agent);
    assert.equal(f.bodies.length, 1); assert.equal(frames.at(-1).signal.aborted, false);
    assert.ok(sessionEvents(agent.session).some(event => event.type === "turn/end" && event.data.reason.kind === "completed"));
  });
});

test("direct permission source refresh cancels a model stream that has not ended before tools can execute", { timeout: 40000 }, async t => {
  for (const enhanced of [false, true]) await t.test(enhanced ? "enhanced active stream" : "stock active stream", async t => {
    const response = Promise.withResolvers(); let heldResponse, executed = 0;
    const f = await nativeRootLlmFixture(t, { defaultActive: false }, {
      globalConfig: { permissionControl: { nativeCommands: { enabled: false, entries: [] } } },
      respond(body, res) {
        heldResponse = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "unfinished-model", object: "chat.completion.chunk", created: 1, model: body.model,
          choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "unfinished-tool", type: "function",
            function: { name: "local_lifecycle_probe", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`);
        response.resolve();
      },
      cleanup() { heldResponse?.end(); },
    });
    f.ctx.tools.register({ name: "local_lifecycle_probe", description: "Return local input", parameters: { type: "object", properties: {} },
      output: { schema: { type: "string" }, render: value => [{ type: "text", text: value }] }, execute() { executed++; return "local result"; } });
    const frames = []; f.ctx.on("agent/request", (frame, next) => { frames.push(frame); return next(); }, { global: true });
    const agent = await f.create(undefined, enhanced ? { provider: "local", model: "root-model", lifecycle_probe: false } : undefined);
    const permissions = f.ctx.get("dsmmPermissionController"), oldSignal = permissions.rules.signal;
    const run = f.run(agent); await response.promise;
    assert.equal(frames[0].signal.aborted, false); assert.equal(executed, 0);
    await writeFile(join(f.home, "plugins", "dsmm", "config.json"), JSON.stringify({ permissionControl: { outsideReads: "ask", nativeCommands: { enabled: false, entries: [] } } }));
    await permissions.rules.refresh(); await run;
    assert.equal(oldSignal.aborted, true); assert.equal(frames[0].signal.aborted, true);
    assert.equal(permissions.rules.status().state, "synced"); assert.equal(permissions.rules.signal.aborted, false);
    assert.equal(f.bodies.length, 1); assert.equal(executed, 0);
    assert.ok(sessionEvents(agent.session).some(event => event.type === "turn/end" && event.data.reason.kind === "aborted"));
  });
});

test("ordinary native Shell escalation preserves native never before the real body", async t => {
  let sends = 0, toolName, command, workdir;
  const f = await nativeRootLlmFixture(t, { defaultActive: false }, { migrateShell: true, approvalPolicy: "never", respond(body, res) {
    const first = ++sends === 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "permission-response", object: "chat.completion.chunk", created: 1, model: body.model };
    const delta = first ? { role: "assistant", tool_calls: [{ index: 0, id: "managed-shell-call", type: "function", function: {
      name: toolName, arguments: JSON.stringify({ command, workdir, sandbox_permissions: "danger-full-access", description: "Check the isolated permission boundary" }) } }] } : { role: "assistant", content: "permission checked" };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  } });
  const agent = await f.create();
  const { setSandboxMode } = await loadNative("@deepseek-ai/dsh-sandbox-policy");
  setSandboxMode(agent.session, "workspace-write");
  const kind = process.platform === "win32" ? "pwsh" : "bash";
  const coverage = f.ctx.get("dsmmPermissionController").coverage(agent).find(row => row.kind === kind);
  assert.ok(coverage, "the real native Shell must register through its ordinary managed entry");
  toolName = coverage.name; workdir = f.workspace;
  const marker = join(workdir, "permission-body-marker");
  command = kind === "pwsh" ? `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value ([string]42)` : `printf protected > '${marker}'; (true)`;
  await f.run(agent);
  assert.deepEqual(f.errors, []);
  assert.equal(f.bodies.length, 2);
  assert.ok(f.bodies[1].body.messages.some(message => message.role === "tool" && message.tool_call_id === "managed-shell-call"));
  assert.equal(existsSync(marker), false, "a refused operation must never enter its native body");
});

test("Core OFF omits raw values and DSMM effort while preserving a native explicit refusal", async t => {
  const f = await nativeRootLlmFixture(t, { modelParameters: { passthrough: false } });
  const agent = await f.create("dsmm-orchestrator", { provider: "local", model: "root-model", reasoning_effort: "future-effort", raw_false: false, maxTokens: 128, temperature: 0 });
  await f.run(agent);
  assert.deepEqual(f.errors, []);
  assert.equal(f.bodies.length, 1);
  assert.equal(f.bodies[0].body.reasoning_effort, undefined);
  assert.equal(f.bodies[0].body.raw_false, undefined);
  assert.equal(f.bodies[0].body.temperature, 0);
  assert.equal(f.bodies[0].body.max_tokens, 128);
  const explicit = await f.create(undefined, { provider: "local", model: "root-model", reasoningEffort: "native-explicit" });
  await f.run(explicit);
  assert.equal(f.bodies.length, 1);
  assert.equal(f.errors.at(-1).code, "UNSUPPORTED_REASONING_EFFORT");
});

test("credential await cancellation and live endpoint changes cannot send an admitted old generation", async t => {
  const f = await nativeRootLlmFixture(t, {}, { deferredCredentials: true });
  const raw = { provider: "local", model: "root-model", reasoningEffort: "future", raw_generation: 1 };
  for (const revoke of ["cancel", "endpoint", "credential"]) {
    const agent = await f.create("dsmm-orchestrator", raw);
    const pause = f.ctx.get("fixtureCredentialControl").pauseNext();
    t.after(pause.release);
    const run = f.run(agent);
    await pause.entered;
    if (revoke === "cancel") agent.cancel({ kind: "user" });
    if (revoke === "endpoint") await f.setProvider({ baseURL: `${f.provider.baseURL}/changed` });
    if (revoke === "credential") await f.setProvider({ apiKeyEnv: "DSMM_CHANGED_FICTIONAL" });
    pause.release(); await run;
    assert.equal(f.bodies.length, 0, revoke);
  }
  const { credentialRef } = await loadNative("@deepseek-ai/dsh-credentials");
  await f.ctx.credentials.set(credentialRef("DSMM_CHANGED_FICTIONAL"), "new-fictional-key");
  const fresh = await f.create("dsmm-orchestrator", raw);
  await f.run(fresh);
  assert.equal(f.bodies.length, 1);
  assert.ok(f.bodies[0].url.includes("/changed/"));
  assert.equal(f.bodies[0].headers.authorization, "Bearer new-fictional-key");
});

test("two official same-turn tool steps consume separate exact proposals and preserve results and usage", async t => {
  let sends = 0;
  const f = await nativeRootLlmFixture(t, {}, { respond(body, res) {
    const first = ++sends === 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "tool-response", object: "chat.completion.chunk", created: 1, model: body.model };
    const delta = first ? { role: "assistant", tool_calls: [{ index: 0, id: "echo-call", type: "function", function: { name: "local_echo", arguments: '{"text":"native tool result"}' } }] } : { role: "assistant", content: "complete after tool" };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  } });
  let executed = 0;
  f.ctx.tools.register({ name: "local_echo", description: "Return local input", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    output: { schema: { type: "string" }, render: value => [{ type: "text", text: value }] }, execute(args) { executed++; return args.text; } });
  const seen = [];
  f.ctx.on("agent/request", async (frame, next) => { const proposal = await next(); seen.push({ frame, proposal }); return proposal; }, { prepend: true, global: true });
  const agent = await f.create("dsmm-orchestrator", { provider: "local", model: "root-model", raw_tool: false });
  await f.run(agent);
  assert.deepEqual(f.errors, []);
  assert.equal(executed, 1); assert.equal(f.bodies.length, 2);
  assert.equal(seen.length, 2); assert.equal(seen[0].frame.signal, seen[1].frame.signal);
  assert.notEqual(seen[0].proposal, seen[1].proposal);
  assert.ok(f.bodies[1].body.messages.some(message => message.role === "tool" && message.tool_call_id === "echo-call"));
  for (const item of seen) await assert.rejects(f.ctx.llm.prepareCall(item.proposal, item.frame.signal), { code: "INVALID_PREPARED_CALL" });
  assert.equal(f.bodies.length, 2);
});

test("standard stop needs the raw Pi-AI executor even without an opaque envelope", async t => {
  const f = await nativeRootLlmFixture(t);
  const agent = await f.create("dsmm-orchestrator", { provider: "local", model: "root-model", stop: ["END"] });
  await f.run(agent);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.bodies[0].body.stop, ["END"]);
});

test("Core raw execution stays independent of DW admission when the module is off", async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: false }, { globalConfig: { modules: { deepwork: { enabled: false } } } });
  assert.equal(f.ctx.get("dsmmRuntimeIntegration"), undefined);
  assert.ok(f.ctx.get("dsmmCoreLlmOwner"));
  const agent = await f.create(undefined, { provider: "local", model: "root-model", core_only: false });
  await f.run(agent);
  assert.deepEqual(f.errors, []);
  assert.equal(f.bodies[0].body.core_only, false);
});

test("ordinary native children retain the stock LLM path without a DW admission", async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: false });
  const parent = await f.create();
  const started = await f.ctx.subagents.startActivation({ provider: "spawn", label: "ordinary native child", delivery: "parent", signal: new AbortController().signal,
    request: { parent, prompt: [{ type: "text", text: "Answer from the ordinary native child" }], agentOptions: { provider: "local", model: "root-model" } } });
  const child = f.ctx.agents.get(started.childId);
  assert.ok(child);
  await child.whenIdle();
  assert.deepEqual(f.errors, []);
  assert.equal(f.bodies.length, 1);
  child.ctx.on("agent/request", async (_frame, next) => ({ ...await next(), customParameters: { unadmitted_child: false } }));
  await f.run(child);
  assert.equal(f.errors.at(-1).code, "DSMM_NOT_READY");
  assert.equal(f.bodies.length, 1);
});

test("concurrent Core requests keep independent exact route parameters", async t => {
  const f = await nativeRootLlmFixture(t, { defaultActive: false });
  const a = await f.create(undefined, { provider: "local", model: "root-model", request_id: "a", nested: { enabled: false } });
  const b = await f.create(undefined, { provider: "local", model: "fallback-model", request_id: "b", nested: [null, 0] });
  await Promise.all([f.run(a, "Question A"), f.run(b, "Question B")]);
  assert.deepEqual(f.errors, []);
  assert.equal(f.bodies.length, 2);
  const one = f.bodies.find(row => row.body.request_id === "a").body, two = f.bodies.find(row => row.body.request_id === "b").body;
  assert.deepEqual(one.nested, { enabled: false }); assert.deepEqual(two.nested, [null, 0]);
  assert.ok(one.messages.some(message => JSON.stringify(message.content).includes("Question A")));
  assert.ok(two.messages.some(message => JSON.stringify(message.content).includes("Question B")));
});

test("missing Core owner and lost exact raw proposal have no native fallback", async t => {
  const f = await nativeRootLlmFixture(t);
  const config = { provider: "local", model: "root-model", customParameters: { must_not_send: false } };
  await assert.rejects(f.ctx.llm.prepareCall(config, new AbortController().signal), { code: "INVALID_PREPARED_CALL" });
  const agent = await f.create("dsmm-orchestrator", { provider: "local", model: "root-model", must_not_send: false });
  f.ctx.on("agent/request", async (frame, next) => {
    const proposal = await next();
    return frame.agent === agent ? { ...proposal, customParameters: undefined } : proposal;
  }, { prepend: true, global: true });
  await f.run(agent);
  assert.equal(f.bodies.length, 0);
  assert.equal(f.errors.at(-1).code, "INVALID_PREPARED_CALL");
  const dsmm = [...f.ctx.loader.entries()].find(entry => entry.options.id === "dsmm");
  await dsmm.update({ disabled: true }); await f.ctx.loader.await();
  assert.equal(f.ctx.get("dsmmCoreLlmOwner"), undefined);
  const raw = await f.create(undefined, { provider: "local", model: "root-model", requires_core: true });
  await f.run(raw);
  assert.equal(f.bodies.length, 0);
  assert.equal(f.errors.at(-1).code, "INVALID_PREPARED_CALL");
  const ordinary = await f.create(); await f.run(ordinary);
  assert.equal(f.bodies.length, 1);
});

test("real child invocation uses each absent candidate's complete parameters and preserves a cold header", async t => {
  const f = await nativeRootLlmFixture(t, { roleRouting: { "dsmm-doc-search": {
    primary: { provider: "not-registered", model: "root-model", primary_only: false },
    fallbackRoutes: [{ provider: "local", model: "missing-model", absent_only: 0 },
      { provider: "local", model: "fallback-model", reasoningEffort: "unknown-exact", final_null: null }],
  } } });
  const parent = await f.create("dsmm-orchestrator");
  const run = await f.ctx.subagents.startActivation({ provider: "dsmm-role-doc-search", label: "Local documentation", delivery: "caller",
    request: { parent, prompt: [{ type: "text", text: "Read local documentation" }] }, signal: new AbortController().signal });
  const child = f.ctx.agents.get(run.childId);
  assert.ok(child);
  try {
    assert.equal((await run.result).stopReason, "completed", f.errors.map(error => error.stack).join("\n"));
    const header = child.session.requestHeader();
    const body = f.bodies[0].body;
    assert.equal(body.model, "fallback-model"); assert.equal(body.reasoning_effort, "unknown-exact");
    assert.equal(body.primary_only, undefined); assert.equal(body.absent_only, undefined); assert.equal(body.final_null, null);
    assert.equal(f.ctx.agents.get(child.id), undefined, "rc1 caller result settles after residency cleanup");
    const id = child.id;
    await run.dispose();
    const observation = await f.ctx.sessionQuery.observeSession(id, { signal: new AbortController().signal, projectionMode: "none" });
    try {
      const persisted = observation.events.filter(event => event.type === "request/header").at(-1).data.header;
      assert.deepEqual(persisted.config, header.config);
    } finally { observation[Symbol.dispose](); }
  } finally { await run.dispose(); }
});

test("registered not-ready, authentication and unsupported raw protocols never authorize candidate fallback", async t => {
  const f = await nativeRootLlmFixture(t);
  const { LlmAdapter, LlmError } = await loadNative("@deepseek-ai/dsh-llm");
  f.ctx.llm.registerAdapter(["not-ready"], new class extends LlmAdapter {
    async resolveModel() { throw new LlmError("Registered provider is not ready", "NO_ADAPTER"); }
    async *stream() { assert.fail("not-ready provider must not dispatch"); }
  }());
  const parent = await f.create("dsmm-orchestrator"), runtime = f.ctx.get("dsmmProfileRuntime");
  const select = async (id, primary) => {
    const saved = await runtime.save({ id, expectedRevision: null, content: JSON.stringify({ version: 1, id, settings: { roleRouting: { "dsmm-doc-search": {
      primary, fallbackRoutes: [{ provider: "local", model: "fallback-model", unexpected_fallback: true }],
    } } } }) });
    const current = await runtime.getSession(parent);
    await runtime.selectSession({ sessionId: parent.id, id, expectedRevision: saved.revision, expectedSelectionRevision: current.selection.selectionRevision,
      expectedAdmissionEpoch: current.admissionEpoch }, parent);
  };
  const run = () => f.ctx.subagents.startActivation({ provider: "dsmm-role-doc-search", label: "Exact candidate refusal", delivery: "caller",
    request: { parent, prompt: [{ type: "text", text: "Local input" }] }, signal: new AbortController().signal });
  await select("unready", { provider: "not-ready", model: "root-model" });
  await assert.rejects(run(), { code: "NO_ADAPTER" });
  assert.equal(f.bodies.length, 0);
  await select("no-credential", { provider: "local", model: "root-model", required_raw: true });
  const { credentialRef } = await loadNative("@deepseek-ai/dsh-credentials");
  await f.ctx.credentials.unset(credentialRef("DSMM_ROOT_FICTIONAL"));
  const unauthenticated = await run();
  try { assert.equal((await unauthenticated.result).stopReason, "error"); }
  finally { await unauthenticated.dispose(); }
  assert.equal(f.bodies.length, 0);
  await f.setProvider({ api: "anthropic-messages", compat: undefined });
  assert.equal([...f.ctx.loader.entries()].find(entry => entry.options.id === "llm-pi-ai").fiber.config.providers.get().local.api, "anthropic-messages");
  assert.throws(() => f.ctx.get("dsmmLlmRoutes").generation("local"), { code: "UNSUPPORTED_ROUTE_PARAMETERS" });
  await f.ctx.credentials.set(credentialRef("DSMM_ROOT_FICTIONAL"), "fictional-only");
  await select("unsupported", { provider: "local", model: "root-model", required_raw: true });
  try {
    const unsupported = await run();
    try { assert.equal((await unsupported.result).stopReason, "error"); }
    finally { await unsupported.dispose(); }
  } catch (error) { assert.equal(error.code, "UNSUPPORTED_ROUTE_PARAMETERS"); }
  assert.equal(f.bodies.length, 0);
});

test("original dsh CLI consumes the migrated ordinary package and sends a real enhanced Root request", { timeout: 60000 }, async t => {
  const raw = { reasoning_effort: "cli-exact-unknown", cli_false: false, cli_zero: 0, cli_nested: [{ nil: null }] };
  const f = await nativeRootLlmFixture(t, { defaultActive: false }, { cli: raw });
  const env = Object.fromEntries(["PATH", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  Object.assign(env, { DSH_HOME: f.home, DSH_AGENTS_HOME: join(f.root, "agents"), DSH_TELEMETRY_DISABLED: "1", DSMM_ROOT_FICTIONAL: "fictional-cli-key", DSMM_TEST_DSH_ENTRY: nativeEntry });
  const args = ["--experimental-strip-types", "--import", new URL("./child-admission-source-loader.mjs", import.meta.url).href,
    nativeCli, "--profile", "native-root", "Complete this isolated native request"];
  const child = spawn(process.execPath, args, { env, cwd: f.workspace, stdio: ["ignore", "pipe", "pipe"], signal: t.signal, timeout: 45000 });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", value => { stdout += value; });
  child.stderr.setEncoding("utf8").on("data", value => { stderr += value; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /native root completed/u);
  assert.equal(f.bodies.length, 1);
  for (const [key, value] of Object.entries(raw)) assert.deepEqual(f.bodies[0].body[key], value);
});

test("compiled ordinary CLI refreshes an outside-read restriction after the model stream and completes the next step", { timeout: 60000 }, async t => {
  let fixture;
  const secret = "owned-outside-content-must-not-reach-provider";
  const f = await nativeRootLlmFixture(t, { defaultActive: false }, {
    cli: {}, compiled: true, migrateFs: true,
    globalConfig: { permissionControl: { outsideReads: "inherit" } },
    async respond(body, res) {
      const step = fixture.bodies.length, reading = step <= 2;
      if (step === 2) await writeFile(join(fixture.home, "plugins", "dsmm", "config.json"), JSON.stringify({ permissionControl: { outsideReads: "deny" } }));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "owned-cli-refresh", object: "chat.completion.chunk", created: 1, model: body.model };
      const delta = reading ? { role: "assistant", tool_calls: [{ index: 0, id: `owned-read-${step}`, type: "function", function: { name: "read", arguments: JSON.stringify({ file_path: "../outside/secret.txt" }) } }] }
        : { role: "assistant", content: "native root completed" };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: reading ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    },
  });
  fixture = f;
  await mkdir(join(f.root, "outside")); await writeFile(join(f.root, "outside", "secret.txt"), secret);
  const env = Object.fromEntries(["PATH", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  Object.assign(env, { DSH_HOME: f.home, DSH_AGENTS_HOME: join(f.root, "agents"), DSH_TELEMETRY_DISABLED: "1", DSMM_ROOT_FICTIONAL: "fictional-cli-key" });
  const child = spawn(process.execPath, [nativeCli, "--profile", "native-root", "Read the requested owned file, then finish"],
    { env, cwd: f.workspace, stdio: ["ignore", "pipe", "pipe"], signal: t.signal, timeout: 45000 });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", value => { stdout += value; });
  child.stderr.setEncoding("utf8").on("data", value => { stderr += value; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, stderr); assert.match(stdout, /native root completed/u);
  assert.equal(f.bodies.length, 3);
  const results = f.bodies[2].body.messages.filter(message => message.role === "tool");
  assert.equal(results.length, 2); assert.equal(results[1].tool_call_id, "owned-read-2");
  assert.equal(JSON.stringify(results[0].content).includes(secret), true);
  assert.ok(JSON.stringify(results[1].content).length > 2);
  assert.equal(JSON.stringify(results[1].content).includes(secret), false, stderr);
});
