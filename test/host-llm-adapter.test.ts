import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { attributionHeaders, createUserMessage, markAgentLoopRequest, ReasoningEffortId, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import { createProvider, envApiKeyAuth, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { DsmmAwareLlmRuntime, snapshotDsmmCall } from "../src/host-llm.ts";
import type { DsmmLlmHostOwner, DsmmLlmRequestFrame } from "../src/host-llm.ts";
import { LivePiAiOwner } from "../src/live-pi-ai-owner.ts";
import { createDsmmPiAiProviderOwner } from "../src/native-pi-ai-wire.ts";
import type { DsmmPiAiOwnerOptions, DsmmPiAiProviderOwner } from "../src/native-pi-ai-wire.ts";
import { bindRoleInvocation } from "../src/role-invocation.ts";
import type { ResolvedRoleInvocation } from "../src/role-invocation.ts";
import type { DshAgent } from "../src/dsh-types.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("native preparation and the public Pi-AI payload seam preserve complete calls", async t => {
  const bodies: { body: Record<string, unknown>; headers: import("node:http").IncomingHttpHeaders }[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push({ body: JSON.parse(Buffer.concat(chunks).toString()), headers: req.headers });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "adapter-response", object: "chat.completion.chunk", created: 1, model: "local-model" };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "complete" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const ctx = new Context();
  let currentAgent: Agent | undefined;
  let flushSession = async () => true;
  ctx.provide("agents", { get: (id: string) => id === currentAgent?.id ? currentAgent : undefined, currentInitiator: () => currentAgent } as unknown as Context["agents"]);
  ctx.provide("sessions", { flush: () => flushSession() } as unknown as Context["sessions"]);
  t.after(async () => { await ctx.fiber.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  let requestOwner: DsmmLlmHostOwner = { async preflight() { throw new Error("This adapter test has no Agent request"); } };
  await ctx.plugin({ apply(scope: Context) {
    new DsmmAwareLlmRuntime(scope, undefined, { preflight: (frame, proposal) => requestOwner.preflight(frame, proposal) });
  } }).await();
  const options: DsmmPiAiOwnerOptions = {
    config: { providers: { local: { api: "openai-completions", baseURL: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "DSMM_ADAPTER_FICTIONAL",
      models: [{ id: "local-model", contextWindow: 32768 }, { id: "mapped-model", reasoningEfforts: { high: "vendor-high", off: null } }],
      compat: { maxTokensField: "max_tokens" }, retryPolicy: { mode: "normal", maxRetries: 0 } } } },
    settingsNamespace: "adapter-test",
    auth: { credentials: new InMemoryCredentialStore(), authContext: { env: async () => { throw new Error("No ambient credentials"); }, fileExists: async () => false } },
    async resolveApiKey(provider, reference) { assert.equal(provider, "local"); assert.equal(reference, "DSMM_ADAPTER_FICTIONAL"); return "fictional-loopback-key"; },
  };
  let owner!: DsmmPiAiProviderOwner;
  await ctx.plugin({ inject: ["llm"], apply(scope: Context) { owner = createDsmmPiAiProviderOwner(scope, options); } }).await();
  const route = { provider: "local", model: "local-model" };
  const messages = [createUserMessage({ content: [{ type: "text", text: "isolated request" }], source: { kind: "user" } })];
  const drain = async (stream: AsyncIterable<StreamChunk>) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };

  await t.test("standard controls use the native prepared adapter and configure callback", async () => {
    const prepare = t.mock.method(owner.stockAdapter, "prepareCall");
    const prepared = await ctx.llm.prepareCall(route, undefined, controls => ({ ...controls, temperature: 0, maxTokens: 64 }));
    assert.equal(prepare.mock.callCount(), 1);
    assert.equal(prepared.config.maxTokens, 64);
    await drain(prepared.stream({ ...prepared.config, messages }));
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].body.temperature, 0);
    assert.equal(bodies[0].body.max_tokens, 64);
    assert.throws(() => prepared.stream({ ...prepared.config, messages }), { code: "INVALID_PREPARED_CALL" });
    prepare.mock.restore();
  });

  await t.test("stop-only and arbitrary values actually reach the local provider body", async () => {
    const classifier = new LivePiAiOwner(ctx, ctx.llm);
    const handle = Object.assign(() => {}, { replace(_next: string[]) {} });
    classifier.register(ctx, [route.provider], owner.stockAdapter, handle);
    assert.equal(classifier.requiresRaw(route), false);
    assert.equal(classifier.requiresRaw({ ...route, stop: ["END"] }), true);
    assert.equal(classifier.requiresRaw({ ...route, customParameters: { vendor: false } }), true);
    const prepare = t.mock.method(owner.stockAdapter, "prepareCall");
    for (const fields of [{ stop: ["END"] }, { customParameters: { vendor: false, zero: 0, nested: [[], {}, null] } }]) {
      const signal = new AbortController().signal;
      const prepared = await owner.generation(route.provider).prepareCall(route.provider, route.model, signal);
      const config = snapshotDsmmCall({ ...route, ...fields });
      await drain(prepared.stream({ ...config, messages, signal }));
      const sent = bodies.at(-1)!;
      for (const [key, value] of Object.entries(fields.customParameters ?? fields)) assert.deepEqual(sent.body[key], value);
      for (const [key, value] of Object.entries(attributionHeaders())) assert.equal(sent.headers[key.toLowerCase()], value);
      assert.equal(sent.headers.authorization, "Bearer fictional-loopback-key");
      assert.throws(() => prepared.stream({ ...config, messages, signal }), { code: "INVALID_PREPARED_CALL" });
    }
    assert.equal(prepare.mock.callCount(), 2);
    prepare.mock.restore();
    assert.equal(bodies.length, 3);
  });

  await t.test("raw execution envelope and prepared-route substitution are rejected before dispatch", async () => {
    for (const key of ["provider", "model", "messages", "tools", "toolHistory", "signal", "auth", "apiKey", "headers", "stream", "onPayload"]) {
      assert.throws(() => snapshotDsmmCall({ ...route, customParameters: { [key]: "forbidden" } }), { code: "INVALID_CONFIG" });
    }
    const prepared = await owner.generation(route.provider).prepareCall(route.provider, route.model, new AbortController().signal);
    assert.throws(() => prepared.stream({ ...route, model: "another-model", messages }), { code: "INVALID_PREPARED_CALL" });
    assert.throws(() => prepared.stream({ ...route, messages }), { code: "INVALID_PREPARED_CALL" });
    assert.equal(bodies.length, 3);
  });

  await t.test("cancellation and credential-generation retirement after credential await prevent HTTP dispatch", async () => {
    for (const boundary of ["cancel", "generation"]) {
      const entered = deferred(), release = deferred();
      const life = new AbortController(), call = new AbortController();
      const borrowed = createDsmmPiAiProviderOwner(ctx, { ...options, async resolveApiKey() { entered.resolve(); await release.promise; return "fictional-loopback-key"; } },
        { signal: life.signal, adapter: owner.stockAdapter, assertCurrent() { life.signal.throwIfAborted(); } });
      const prepared = await borrowed.generation(route.provider).prepareCall(route.provider, route.model, call.signal);
      const output = drain(prepared.stream({ ...route, stop: ["END"], messages, signal: call.signal }));
      await entered.promise;
      (boundary === "cancel" ? call : life).abort();
      release.resolve();
      await assert.rejects(output, { name: "AbortError" });
      assert.equal(bodies.length, 3);
    }
  });

  await t.test("provider retirement while its public adapter prepares cannot release a call", async () => {
    const life = new AbortController(), entered = deferred(), release = deferred();
    const originalPrepare = owner.stockAdapter.prepareCall.bind(owner.stockAdapter);
    const prepare = t.mock.method(owner.stockAdapter, "prepareCall", async (...args: Parameters<typeof originalPrepare>) => { entered.resolve(); await release.promise; return originalPrepare(...args); });
    const borrowed = createDsmmPiAiProviderOwner(ctx, options, { signal: life.signal, adapter: owner.stockAdapter, assertCurrent() { life.signal.throwIfAborted(); } });
    const pending = borrowed.generation(route.provider).prepareCall(route.provider, route.model, new AbortController().signal);
    await entered.promise; life.abort(); release.resolve();
    await assert.rejects(pending);
    assert.equal(bodies.length, 3);
    prepare.mock.restore();
  });

  await t.test("admitted raw configuration preserves controls without bypassing a manual choice's capabilities", async () => {
    const events: { type: string; seq: number; data: object }[] = [];
    const agent = { id: "adapter-agent", status: "running", ctx, cancel() {},
      session: { header: { origin: "subagent", agentPreset: "dsmm-doc-search" }, events, requestHeader: () => undefined } } as unknown as Agent;
    currentAgent = agent;
    const signal = new AbortController().signal;
    const frame = { agent, signal, turn: 1, step: 1 } as DsmmLlmRequestFrame;
    const identity = {};
    requestOwner = { async preflight(_frame, config) {
      return { kind: "dsmm", config, generation: owner.generation(route.provider),
        admission: { agent, admission: identity, capture: identity, epoch: "test", signal, assertCurrent() { signal.throwIfAborted(); } } };
    } };
    const proposal = { ...route, stop: ["END"], customParameters: { vendor: false } };
    const admitted = await ctx.waterfall("agent/request", frame, async () => proposal);
    let configured = 0;
    const prepared = await ctx.llm.prepareCall(admitted, signal, controls => { configured++; return { ...controls, temperature: 0, maxTokens: 32 }; });
    assert.equal(configured, 1);
    assert.deepEqual(prepared.config, { ...proposal, temperature: 0, maxTokens: 32 });
    events.push({ type: "model/selection", seq: 1, data: { ...route, reasoningEffort: "unsupported-native-effort" } });
    const nativeChoice = await ctx.waterfall("agent/request", frame, async () => ({ ...proposal, reasoningEffort: ReasoningEffortId("unsupported-native-effort") }));
    await assert.rejects(ctx.llm.prepareCall(nativeChoice, signal), { code: "UNSUPPORTED_REASONING_EFFORT" });
    assert.equal(bodies.length, 3);
  });

  await t.test("admitted streams retain captured native/inherited effort semantics through payload adaptation", async () => {
    let header: unknown;
    const agent = { id: "effort-agent", status: "running", ctx, cancel() {},
      session: { header: { origin: "subagent", agentPreset: "dsmm-doc-search" }, events: [], requestHeader: () => header,
        append(_type: string, data: { header: unknown }) { header = data.header; } } } as unknown as Agent;
    currentAgent = agent;
    const mapped = { ...route, model: "mapped-model" };
    const signal = new AbortController().signal;
    const frame = { agent, signal, turn: 1, step: 1 } as DsmmLlmRequestFrame;
    const identity = {};
    requestOwner = { async preflight(_frame, config) {
      return { kind: "dsmm", config, generation: owner.generation(route.provider),
        admission: { agent, admission: identity, capture: identity, epoch: "effort-test", signal, assertCurrent() { signal.throwIfAborted(); } } };
    } };
    const bindSource = (source: Pick<ResolvedRoleInvocation, "routeSource" | "effortSource">) => bindRoleInvocation(agent as unknown as DshAgent, source as ResolvedRoleInvocation);
    for (const source of [{ routeSource: "invocation-route", effortSource: "native" }, { routeSource: "inherited" }] as const) {
      bindSource(source);
      const invalid = await ctx.waterfall("agent/request", frame, async () => ({ ...mapped, stop: ["END"] }));
      await assert.rejects(ctx.llm.prepareCall(invalid, signal, controls => {
        bindSource({ routeSource: "primary", effortSource: "dsmm-config" });
        return { ...controls, reasoningEffort: ReasoningEffortId("not-offered") };
      }), { code: "UNSUPPORTED_REASONING_EFFORT" });
      for (const effort of ["high", "off"]) {
        bindSource(source);
        const nativePrepared = await owner.stockAdapter.prepareCall(mapped.provider, mapped.model, signal);
        await drain(nativePrepared.stream({ ...mapped, reasoningEffort: ReasoningEffortId(effort), messages, signal }));
        const nativeWireEffort = bodies.at(-1)!.body.reasoning_effort;
        assert.equal(nativeWireEffort, effort === "high" ? "vendor-high" : undefined);
        const before = bodies.length;
        const parameters = source.routeSource === "inherited" ? { customParameters: { probe: false } } : { stop: ["END"] };
        const config = { ...mapped, reasoningEffort: ReasoningEffortId(effort), ...parameters };
        const admitted = await ctx.waterfall("agent/request", frame, async () => config);
        const prepared = await ctx.llm.prepareCall(admitted, signal);
        const chunks = await drain(prepared.stream(Object.freeze(markAgentLoopRequest({ ...prepared.config, messages, signal, sessionId: agent.id }))));
        assert.equal(bodies.length, before + 1, JSON.stringify(chunks));
        if (parameters.stop) assert.deepEqual(bodies.at(-1)!.body.stop, ["END"]);
        else assert.equal(bodies.at(-1)!.body.probe, false);
        assert.equal(bodies.at(-1)!.body.reasoning_effort, nativeWireEffort);
      }
    }
    for (const routeSource of ["primary", "inherited"] as const) {
      bindSource({ routeSource, effortSource: "dsmm-config" });
      const literal = await ctx.waterfall("agent/request", frame, async () => ({ ...mapped, reasoningEffort: ReasoningEffortId("literal-vendor"), stop: ["END"] }));
      const prepared = await ctx.llm.prepareCall(literal, signal);
      await drain(prepared.stream(Object.freeze(markAgentLoopRequest({ ...prepared.config, messages, signal, sessionId: agent.id }))));
      assert.equal(bodies.at(-1)!.body.reasoning_effort, "literal-vendor");
    }
  });

  await t.test("configure-added stop is rejected during native preparation, not deferred to dispatch", async () => {
    const classifier = new LivePiAiOwner(ctx, ctx.llm);
    classifier.register(ctx, [route.provider], owner.stockAdapter, Object.assign(() => {}, { replace(_next: string[]) {} }));
    ctx.provide("dsmmLlmRoutes", classifier);
    const agent = ctx.agents.currentInitiator()!;
    const signal = new AbortController().signal;
    const frame = { agent, signal, turn: 1, step: 1 } as DsmmLlmRequestFrame;
    const identity = {};
    requestOwner = { async preflight(_frame, config) { return { kind: "stock", config,
      admission: { agent, admission: identity, capture: identity, epoch: "stock-test", signal, assertCurrent() {} } }; } };
    const admitted = await ctx.waterfall("agent/request", frame, async () => route);
    const before = bodies.length;
    const prepare = t.mock.method(owner.stockAdapter, "prepareCall");
    let configured = 0;
    await assert.rejects(ctx.llm.prepareCall(admitted, signal, controls => { configured++; return { ...controls, stop: ["END"] }; }), { code: "UNSUPPORTED_ROUTE_PARAMETERS" });
    assert.equal(configured, 1);
    assert.equal(prepare.mock.callCount(), 1);
    assert.equal(bodies.length, before);
    const standard = await ctx.waterfall("agent/request", frame, async () => route);
    const prepared = await ctx.llm.prepareCall(standard, signal, controls => ({ ...controls, provider: "not-the-route", model: "not-the-model", temperature: 0 }));
    assert.equal(prepare.mock.callCount(), 2);
    assert.equal(prepared.config.provider, route.provider);
    assert.equal(prepared.config.model, route.model);
    await drain(prepared.stream(Object.freeze(markAgentLoopRequest({ ...prepared.config, messages, signal, sessionId: agent.id }))));
    assert.equal(bodies.length, before + 1);
    assert.equal(bodies.at(-1)!.body.temperature, 0);
    prepare.mock.restore();
  });

  await t.test("native raw reasoning with unavailable public wire mapping fails without provider dispatch", async () => {
    const agent = currentAgent!, signal = new AbortController().signal;
    const originalPrepare = owner.stockAdapter.prepareCall.bind(owner.stockAdapter);
    const prepare = t.mock.method(owner.stockAdapter, "prepareCall", async (...args: Parameters<typeof originalPrepare>) => {
      const native = await originalPrepare(...args);
      return { ...native, model: { ...native.model, reasoning: { efforts: [{ id: ReasoningEffortId("high"), name: "High" }] } } };
    });
    requestOwner = { async preflight(_frame, config) { return { kind: "dsmm", config, generation: owner.generation(route.provider), effortSource: "native",
      admission: { agent, admission: owner, capture: owner, epoch: "missing-mapping", signal, assertCurrent() {} } }; } };
    const frame = { agent, signal, turn: 1, step: 1 } as DsmmLlmRequestFrame;
    const admitted = await ctx.waterfall("agent/request", frame, async () => ({ ...route, reasoningEffort: ReasoningEffortId("high"), stop: ["END"] }));
    const prepared = await ctx.llm.prepareCall(admitted, signal);
    const before = bodies.length;
    const chunks = await drain(prepared.stream(Object.freeze(markAgentLoopRequest({ ...prepared.config, messages, signal, sessionId: agent.id }))));
    assert.ok(chunks.some(chunk => chunk.type === "finish" && chunk.reason.kind === "error" && chunk.reason.failure.code === "UNSUPPORTED_ROUTE_PARAMETERS"));
    assert.equal(bodies.length, before);
    prepare.mock.restore();
  });

  await t.test("admitted dispatch rechecks cancellation and provider generation after header persistence", async () => {
    const agent = currentAgent!;
    for (const boundary of ["cancel", "generation"]) {
      const life = new AbortController(), call = new AbortController(), entered = deferred(), release = deferred();
      const borrowed = createDsmmPiAiProviderOwner(ctx, options, { signal: life.signal, adapter: owner.stockAdapter, assertCurrent() { life.signal.throwIfAborted(); } });
      requestOwner = { async preflight(_frame, config) { return { kind: "dsmm", config, generation: borrowed.generation(route.provider), effortSource: "dsmm-config",
        admission: { agent, admission: borrowed, capture: borrowed, epoch: "retirement-test", signal: call.signal, assertCurrent() { call.signal.throwIfAborted(); } } }; } };
      const frame = { agent, signal: call.signal, turn: 1, step: 1 } as DsmmLlmRequestFrame;
      const admitted = await ctx.waterfall("agent/request", frame, async () => ({ ...route, stop: ["END"] }));
      const prepared = await ctx.llm.prepareCall(admitted, call.signal);
      flushSession = async () => { entered.resolve(); await release.promise; return true; };
      const before = bodies.length;
      const output = drain(prepared.stream(Object.freeze(markAgentLoopRequest({ ...prepared.config, messages, signal: call.signal, sessionId: agent.id }))));
      await entered.promise;
      (boundary === "cancel" ? call : life).abort(); release.resolve();
      await assert.rejects(output, { name: "AbortError" });
      assert.equal(bodies.length, before);
    }
    flushSession = async () => true;
  });

  await t.test("catalog model DSMM-config raw is refused before dispatch while standard native remains usable", async () => {
    const catalog = getBuiltinModels("openai").find(model => model.id === "gpt-4o");
    assert.ok(catalog);
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    const piProvider = createProvider({ id: "openai", name: "isolated catalog", baseUrl: endpoint,
      auth: { apiKey: envApiKeyAuth("openai", []) }, api: openAICompletionsApi(),
      models: [{ ...catalog, api: "openai-completions", baseUrl: endpoint }] });
    const native = new PiAiAdapter({ auth: options.auth, resolveApiKey: async () => "fictional-loopback-key",
      profiles: () => new Map([["openai", { provider: "openai", displayName: "isolated catalog", api: "openai-completions", baseURL: endpoint, piProvider,
        streamIdleTimeoutMs: 1000, maxRequestImageBytes: 20 * 1024 * 1024, requestImagePixelBudget: 1_000_000, requestImageMaxBytes: 1_000_000,
        retryPolicy: resolveRetryPolicy({ mode: "normal", maxRetries: 0 }, "test.catalog"), modelErrors: new Map(), configuredMaxTokens: new Map() }]]) });
    ctx.llm.registerAdapter(["openai"], native);
    const life = new AbortController();
    let rawCredentials = 0;
    const rawOwner = createDsmmPiAiProviderOwner(ctx, { ...options,
      config: { providers: { openai: { api: "openai-completions", baseURL: endpoint, apiKeyEnv: "DSMM_ADAPTER_FICTIONAL", models: [{ id: "gpt-4o" }] } } },
      async resolveApiKey() { rawCredentials++; return "fictional-loopback-key"; } },
      { signal: life.signal, adapter: native, assertCurrent() { life.signal.throwIfAborted(); } });
    let header: unknown;
    const agent = { id: "catalog-agent", status: "running", ctx, cancel() {},
      session: { header: { origin: "subagent", agentPreset: "dsmm-doc-search" }, events: [], requestHeader: () => header,
        append(_type: string, data: { header: unknown }) { header = data.header; } } } as unknown as Agent;
    currentAgent = agent;
    const signal = new AbortController().signal;
    const frame = { agent, signal, turn: 1, step: 1 } as DsmmLlmRequestFrame;
    let raw = true;
    requestOwner = { async preflight(_frame, config) {
      const admission = { agent, admission: rawOwner, capture: rawOwner, epoch: "catalog-test", signal, assertCurrent() {} };
      return raw ? { kind: "dsmm", config, admission, effortSource: "dsmm-config", generation: rawOwner.generation("openai") }
        : { kind: "stock", config, admission, effortSource: "dsmm-config" };
    } };
    const catalogRoute = { provider: "openai", model: "gpt-4o" };
    const admitted = await ctx.waterfall("agent/request", frame, async () => ({ ...catalogRoute, reasoningEffort: ReasoningEffortId("literal-vendor"), customParameters: { probe: false } }));
    const prepared = await ctx.llm.prepareCall(admitted, signal);
    const before = bodies.length;
    const chunks = await drain(prepared.stream(Object.freeze(markAgentLoopRequest({ ...prepared.config, messages, signal, sessionId: agent.id }))));
    assert.ok(chunks.some(chunk => chunk.type === "finish" && chunk.reason.kind === "error" && chunk.reason.failure.code === "UNSUPPORTED_ROUTE_PARAMETERS"));
    assert.equal(bodies.length, before);
    assert.equal(rawCredentials, 0);
    raw = false;
    const standard = await ctx.waterfall("agent/request", frame, async () => catalogRoute);
    const standardPrepared = await ctx.llm.prepareCall(standard, signal);
    assert.deepEqual(standardPrepared.inputModalities, catalog.input);
    const standardChunks = await drain(standardPrepared.stream(Object.freeze(markAgentLoopRequest({ ...standardPrepared.config, messages, signal, sessionId: agent.id }))));
    assert.ok(standardChunks.some(chunk => chunk.type === "finish" && chunk.reason.kind === "stop"));
    assert.equal(bodies.length, before + 1);
    assert.equal(bodies.at(-1)!.body.model, catalogRoute.model);
    assert.equal(rawCredentials, 0);
  });
});
