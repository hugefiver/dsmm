import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { inspectSourceCandidateRuntime } from "./host-llm-candidate-support.mjs";
import { preparedConfigMatches, singleUsePreparedStream, snapshotDsmmCall } from "../src/host-llm.ts";
import { resolveRoleRuntimePolicy } from "../src/routing-policy.ts";

const native = createRequire(process.env.DSMM_TEST_DSH_ENTRY);
const load = name => import(pathToFileURL(native.resolve(name)).href);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

test("standard cold MAIN constructs its configured official loop only after DSMM admission is ready", async () => {
  const parentPath = process.env.DSMM_TEST_TEMP_ROOT ?? join(tmpdir(), "opencode");
  if (process.env.DSMM_TEST_TEMP_ROOT === undefined) await mkdir(parentPath, { recursive: true });
  const tempParent = await realpath(parentPath);
  const root = await mkdtemp(join(tempParent, "dsmm-w1-cold-"));
  const home = join(root, "home"), agentsHome = join(root, "agents"), workspace = join(root, "workspace");
  await Promise.all([home, agentsHome, workspace].map(path => mkdir(path)));
  process.env.DSH_HOME = home;
  process.env.DSH_AGENTS_HOME = agentsHome;
  process.env.DSH_TELEMETRY_DISABLED = "1";
  const bodies = [];
  let echoExecutions = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    bodies.push({ body, headers: req.headers });
    const last = body.messages?.at(-1);
    if (last?.role === "user" && JSON.stringify(last.content).includes("exercise w1 rate limit")) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ error: { message: "owned loopback rate limit", type: "rate_limit_error" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "w1-response", object: "chat.completion.chunk", created: 1, model: "gpt-6.1-sol" };
    if (last?.role === "user" && JSON.stringify(last.content).includes("exercise w1 tool")) {
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "w1-call", type: "function", function: { name: "w1_echo", arguments: '{"text":"w1 tool result"}' } }] }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "w1 complete" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let ctx;
  try {
    const bootApi = await load("@deepseek-ai/dsh-app-boot");
    const { prepareProfile, PROFILE_ROOT_FILENAME } = await load("@deepseek-ai/dsh/profile-boot");
    const { createLaunchEnvironmentSnapshot } = await load("@deepseek-ai/dsh-launch-environment");
    const { AgentLoop } = await load("@deepseek-ai/dsh-agent-loop");
    const { createUserMessage, attributionHeaders } = await load("@deepseek-ai/dsh-llm");
    const { SessionId } = await load("@deepseek-ai/dsh-session");
    const { createDsmmLlmColdStartup } = await import("../src/host-llm-startup.ts");
    const profileDir = bootApi.resolveProfileDir("w1", home);
    await mkdir(join(profileDir, "node_modules", "@dsmm"), { recursive: true });
    await symlink(packageRoot, join(profileDir, "node_modules", "@dsmm", "dsmm"), "junction");
    await writeFile(join(profileDir, "package.json"), JSON.stringify({ name: "dsmm-w1-owned-profile", private: true, type: "module", dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "@dsmm/dsmm"] } } }));
    const config = { presets: { root: join(root, "presets") }, lsp: { enabled: false }, defaultActive: true, sessionPersistence: { root: join(root, "sessions"), compression: "none" } };
    const patches = [
      { id: "agent-loop", disabled: true }, { id: "headless-startup", disabled: true }, { id: "headless-runner", disabled: true },
      { id: "session-persistence-jsonl", disabled: true },
      { id: "llm-pi-ai", config: { providers: {} } },
      { id: "dsmm", inject: ["subagents"], config },
    ];
    await writeFile(join(profileDir, "cordis.patch.yml"), JSON.stringify(patches));
    const profile = prepareProfile("w1");
    const resolution = await bootApi.createRuntimeResolution({ installAnchor: process.env.DSMM_TEST_DSH_ENTRY, profile });
    const profileContext = { name: "w1", dir: profile.dir, patchPath: profile.patchPath, installAnchor: process.env.DSMM_TEST_DSH_ENTRY,
      startedBundles: profile.layers.map(layer => layer.packageName), cwd: workspace, home, overlays: [], telemetryDisabledEnv: "1" };
    const signal = new AbortController();
    let custom = { full: false, zero: 0, nil: null, array: [1, { nested: [false, null] }] };
    let cancelAtPreflight = false;
    const coldOptions = {
      agentLoop: AgentLoop.Config({ agents: [{ id: "w1", sessionId: SessionId("dsmm-w1-cold"), cwd: workspace, provider: "apai", model: "gpt-6.1-sol" }] }),
      provider: { settingsNamespace: "dsmm-llm-owner", config: { providers: { apai: { api: "openai-completions", baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: "DSMM_W1_FICTIONAL",
        headers: Object.fromEntries(Object.keys(attributionHeaders()).map(key => [key.toUpperCase(), "fixture-profile-value"])),
        models: ["gpt-6.1-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map(id => ({ id })), compat: { maxTokensField: "max_tokens" }, retryPolicy: { mode: "normal", maxRetries: 0 } } } },
        auth: { credentials: new InMemoryCredentialStore(), authContext: { env: async () => { throw new Error("Ambient auth is forbidden in this fixture"); }, fileExists: async () => { throw new Error("Credential file probing is forbidden in this fixture"); } } },
        resolveApiKey: async (_provider, ref) => ref === "DSMM_W1_FICTIONAL" ? "fixture-only-not-a-secret" : undefined },
      async establish(scope, providers) {
        scope.tools.register({ name: "w1_echo", description: "Return the supplied text without external effects", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          output: { schema: { type: "string" }, render: value => [{ type: "text", text: value }] },
          async execute(args) { echoExecutions++; return args.text; } });
        return { async preflight(frame, proposal) {
          const runtime = scope.get("dsmmProfileRuntime");
          const admission = runtime.admission(frame.agent);
          if (!(await runtime.getSession(frame.agent)).deepwork.active) return { kind: "native" };
          if (cancelAtPreflight) frame.agent.cancel({ kind: "user" });
          return { kind: "dsmm", config: { ...proposal, reasoningEffort: "medium", temperature: 0, maxTokens: 128, stop: ["w1 stop"], customParameters: custom },
            generation: providers.generation("apai"), admission: { agent: frame.agent, admission, capture: admission, epoch: admission.epoch, signal: signal.signal,
              assertCurrent() { assert.equal(runtime.admission(frame.agent), admission); } } };
        } };
      },
    };
    let cold = createDsmmLlmColdStartup(coldOptions);
    profileContext.overlays = [...cold.patches];
    let creation = Promise.withResolvers();
    creation.promise.catch(() => {});
    const boot = () => bootApi.boot("dsmm-w1", join(profile.dir, PROFILE_ROOT_FILENAME), bootApi.readProfilePatches("dsmm-w1", profileContext, profile), async host => {
      host.on("agent/created", ({ agent }) => { if (agent.id === "dsmm-w1-cold") creation.resolve(agent); }, { global: true });
      host.on("agent-loop/config-start-failed", ({ error }) => creation.reject(error));
      host.provide("profileContext", profileContext);
      host.provide("launchEnvironment", createLaunchEnvironmentSnapshot([{ source: "process", values: { DSH_HOME: home, DSH_AGENTS_HOME: agentsHome } }]));
      await host.plugin(bootApi.PluginPackages, { resolution });
      await cold.prepare(host);
    });
    ctx = await boot();
    const ready = cold.assertReady();
    await creation.promise;
    assert.deepEqual(profileContext.startedBundles, ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "@dsmm/dsmm"]);
    inspectSourceCandidateRuntime(ctx);
    const ownerEntry = [...ctx.loader.entries()].find(entry => entry.options.id === "dsmm-llm-owner");
    assert.equal(ownerEntry.fiber.state, 2);
    assert.ok(ctx.settings.describe().some(form => form.ns === "dsmm-llm-owner"));
    const providerForm = ctx.settings.describe().find(form => form.ns === "dsmm-llm-owner");
    await assert.rejects(() => ctx.settings.mutate(providerForm.ns, [{ op: "set", path: ["providers", "apai", "baseURL"], value: "http://127.0.0.1:1/v1" }], providerForm.revision));
    assert.equal(cold.assertReady().loop, ready.loop);
    assert.equal(ctx.settings.describe().find(form => form.ns === providerForm.ns).revision, providerForm.revision);
    assert.deepEqual((await ctx.llm.discoverModels("dsmm-llm-owner", { provider: "apai" })).map(model => model.id), ["gpt-6.1-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    await assert.rejects(() => ready.provider.generation("apai").prepareCall("apai", "undeclared-model", signal.signal), { code: "UNKNOWN_MODEL" });
    assert.ok(ready.loop instanceof AgentLoop);
    const configured = ctx.agents.get(SessionId("dsmm-w1-cold"));
    assert.ok(configured, "the official constructor must auto-create its configured Agent");
    const errors = [];
    const headers = [];
    const assistantMessages = [];
    let oneShotVerified = false;
    ctx.on("llm/stream", (request, next) => {
      if (request.customParameters === undefined) return next();
      assert.ok(Object.isFrozen(request));
      assert.ok(Object.isFrozen(request.customParameters));
      const currentHeader = configured.session.requestHeader();
      assert.equal(preparedConfigMatches(request, currentHeader.config), true);
      assert.equal(preparedConfigMatches({ ...request, customParameters: { ...request.customParameters, zero: 999 } }, currentHeader.config), false);
      const once = singleUsePreparedStream(next);
      const stream = once(request);
      assert.throws(() => once(request), { code: "INVALID_PREPARED_CALL" });
      oneShotVerified = true;
      return stream;
    }, { global: true });
    ctx.on("session/event", (session, event) => {
      if (session !== configured.session) return;
      if (event.type === "request/header") headers.push(event);
      if (event.type === "assistant/message") assistantMessages.push(event.data);
    });
    ctx.on("agent/error", ({ error }) => errors.push(error));
    configured.followup(createUserMessage({ content: [{ type: "text", text: "Say w1 complete" }], source: { kind: "user" } }));
    await configured.whenIdle();
    assert.deepEqual(errors, []);
    const primary = bodies.filter(({ body }) => body.reasoning_effort === "medium");
    assert.equal(primary.length, 1);
    assert.equal(oneShotVerified, true);
    assert.equal(assistantMessages[0].usage.inputTokens, 5);
    assert.equal(assistantMessages[0].usage.outputTokens, 2);
    assert.equal(assistantMessages[0].usage.totalTokens, 7);
    assert.equal(primary[0].body.temperature, 0);
    assert.equal(primary[0].body.max_tokens, 128);
    assert.equal(primary[0].body.max_completion_tokens, undefined);
    assert.deepEqual(primary[0].body.stop, ["w1 stop"]);
    assert.deepEqual(Object.fromEntries(["full", "zero", "nil", "array"].map(key => [key, primary[0].body[key]])), { full: false, zero: 0, nil: null, array: [1, { nested: [false, null] }] });
    for (const [key, value] of Object.entries(attributionHeaders())) assert.equal(primary[0].headers[key.toLowerCase()], value);
    assert.equal(configured.session.requestHeader().config.reasoningEffort, "medium");
    const firstHeader = configured.session.requestHeader();
    assert.ok(Object.isFrozen(firstHeader.config.customParameters.array[1]));
    custom = { ...custom, full: true };
    configured.followup(createUserMessage({ content: [{ type: "text", text: "custom-only change" }], source: { kind: "user" } }));
    await configured.whenIdle();
    assert.equal(configured.session.requestHeader().config.customParameters.full, true);
    assert.equal(firstHeader.config.customParameters.full, false);
    assert.equal(headers.length, 2);
    const originalHeader = configured.session.requestHeader();
    const beforeTool = bodies.length;
    configured.followup(createUserMessage({ content: [{ type: "text", text: "exercise w1 tool" }], source: { kind: "user" } }));
    await configured.whenIdle();
    assert.equal(echoExecutions, 1);
    assert.ok(bodies.slice(beforeTool).some(({ body }) => body.messages?.some(message => message.role === "tool" && message.tool_call_id === "w1-call")));
    assert.deepEqual(errors, []);
    assert.equal(await ctx.sessions.flush(configured.session), true);
    assert.equal((await ctx.llm.resolveModelInfo("apai", "gpt-6.1-sol")).reasoning, undefined);
    const modeOff = async agent => {
      const runtime = ctx.get("dsmmProfileRuntime"), snapshot = await runtime.getSession(agent);
      await runtime.selectMode({ sessionId: agent.id, active: false, expectedAdmissionEpoch: snapshot.admissionEpoch, expectedModeRevision: snapshot.deepwork.revision }, agent);
    };
    const rejected = await ctx.agents.create({ sessionId: SessionId("dsmm-w1-stock-medium"), meta: { cwd: workspace }, agentOptions: { provider: "apai", model: "gpt-6.1-sol", reasoningEffort: "medium" } });
    await modeOff(rejected.agent);
    const beforeReject = bodies.length;
    rejected.agent.followup(createUserMessage({ content: [{ type: "text", text: "must not send" }], source: { kind: "user" } }));
    await rejected.agent.whenIdle();
    assert.equal(bodies.length, beforeReject);
    assert.equal(errors.at(-1)?.code, "UNSUPPORTED_REASONING_EFFORT");
    await rejected.dispose();
    const nativeDefault = await ctx.agents.create({ sessionId: SessionId("dsmm-w1-stock-default"), meta: { cwd: workspace }, agentOptions: { provider: "apai", model: "gpt-6.1-sol" } });
    await modeOff(nativeDefault.agent);
    const beforeDefault = bodies.length;
    nativeDefault.agent.followup(createUserMessage({ content: [{ type: "text", text: "stock default" }], source: { kind: "user" } }));
    await nativeDefault.agent.whenIdle();
    assert.ok(bodies.length > beforeDefault);
    assert.ok(bodies.slice(beforeDefault).every(({ body }) => body.reasoning_effort === undefined && body.full === undefined));
    await nativeDefault.dispose();
    await ctx.fiber.dispose();
    await assert.rejects(() => ready.provider.generation("apai").prepareCall("apai", "gpt-6.1-sol", new AbortController().signal));
    ctx = undefined;
    cold = createDsmmLlmColdStartup(coldOptions);
    creation = Promise.withResolvers();
    creation.promise.catch(() => {});
    ctx = await boot();
    cold.assertReady();
    await creation.promise;
    inspectSourceCandidateRuntime(ctx);
    const resumed = ctx.agents.get(SessionId("dsmm-w1-cold"));
    assert.ok(resumed);
    assert.notEqual(resumed, configured);
    assert.deepEqual(resumed.session.requestHeader(), originalHeader);
    const resumedHeaders = [];
    ctx.on("session/event", (session, event) => { if (session === resumed.session && event.type === "request/header") resumedHeaders.push(event); });
    custom = { ...custom, zero: 17 };
    resumed.followup(createUserMessage({ content: [{ type: "text", text: "change after cold rebuild" }], source: { kind: "user" } }));
    await resumed.whenIdle();
    assert.equal(resumed.session.requestHeader().config.customParameters.zero, 17);
    assert.equal(originalHeader.config.customParameters.zero, 0);
    assert.equal(resumedHeaders.length, 1);
    const beforeCancellation = bodies.length;
    cancelAtPreflight = true;
    resumed.followup(createUserMessage({ content: [{ type: "text", text: "cancel before header" }], source: { kind: "user" } }));
    await resumed.whenIdle();
    assert.equal(resumedHeaders.length, 1);
    assert.equal(bodies.length, beforeCancellation);
    cancelAtPreflight = false;
    let flushRefused = false;
    const failFlush = ctx.on("session/flush", session => {
      if (session === resumed.session && session.requestHeader()?.config.customParameters?.zero === 18) { flushRefused = true; throw new Error("owned flush refusal"); }
    }, { global: true });
    custom = { ...custom, zero: 18 };
    resumed.followup(createUserMessage({ content: [{ type: "text", text: "refuse before HTTP" }], source: { kind: "user" } }));
    await resumed.whenIdle();
    failFlush();
    assert.equal(flushRefused, true);
    assert.equal(resumedHeaders.length, 2);
    assert.equal(bodies.length, beforeCancellation);
    const cancelAfterHeader = ctx.on("session/event", (session, event) => {
      if (session === resumed.session && event.type === "request/header" && event.data.header.config.customParameters?.zero === 19) resumed.cancel({ kind: "user" }, { keepInbox: true });
    }, { global: true });
    custom = { ...custom, zero: 19 };
    resumed.followup(createUserMessage({ content: [{ type: "text", text: "cancel after durable header commit" }], source: { kind: "user" } }));
    await resumed.whenIdle();
    cancelAfterHeader();
    assert.equal(resumed.session.requestHeader().config.customParameters.zero, 19);
    assert.equal(bodies.length, beforeCancellation);
    const requestFailures = [];
    const retries = resolveRoleRuntimePolicy(ctx.get("dsmmProfileRuntime").getSettings(resumed), "dsmm-orchestrator").rateLimit.maxRetries;
    ctx.on("agent/request-error", (frame, next) => { requestFailures.push(frame); return next(); }, { prepend: true, global: true });
    resumed.followup(createUserMessage({ content: [{ type: "text", text: "exercise w1 rate limit" }], source: { kind: "user" } }));
    await resumed.whenIdle();
    assert.equal(bodies.length, beforeCancellation + retries + 1);
    assert.equal(requestFailures.length, retries + 1);
    assert.ok(requestFailures.every(frame => frame.failure.code === "RATE_LIMIT" && frame.retryPolicy.maxRetries === 0));
    signal.abort();
    resumed.followup(createUserMessage({ content: [{ type: "text", text: "revoked Host capture" }], source: { kind: "user" } }));
    await resumed.whenIdle();
    assert.equal(resumed.session.requestHeader().config.customParameters.zero, 19);
    assert.equal(bodies.length, beforeCancellation + retries + 1);
  } finally {
    await ctx?.fiber.dispose();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(dirname(await realpath(root)), tempParent);
    await rm(root, { recursive: true });
  }
});

test("raw parameter snapshots preserve JSON and reject Host fields and body aliases", () => {
  const input = { provider: "apai", model: "gpt-6.1-sol", reasoningEffort: "medium", customParameters: { full: false, zero: 0, nil: null, nested: [true, { token: "original" }] } };
  const snapshot = snapshotDsmmCall(input);
  input.customParameters.nested[1].token = "changed";
  assert.equal(snapshot.customParameters.nested[1].token, "original");
  assert.ok(Object.isFrozen(snapshot.customParameters.nested));
  for (const field of ["messages", "tools", "Authorization", "base_URL", "session_id", "agentId", "permissions", "onPayload", "max_tokens", "reasoning_effort", "tool_choice"]) {
    assert.throws(() => snapshotDsmmCall({ provider: "apai", model: "gpt-6.1-sol", customParameters: { [field]: null } }), { code: "INVALID_CONFIG" });
  }
  for (const invalid of [NaN, Infinity, -0, undefined, () => {}, 1n, [, 1]]) assert.throws(() => snapshotDsmmCall({ provider: "apai", model: "gpt-6.1-sol", customParameters: { invalid } }), { code: "INVALID_CONFIG" });
});
