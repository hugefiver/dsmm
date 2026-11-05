import assert from "node:assert/strict";
import { createServer } from "node:http";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { LlmRuntime, createUserMessage } from "@deepseek-ai/dsh-llm";
import * as nativePi from "@deepseek-ai/dsh-llm-pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { LivePiAiOwner } from "../lib/live-pi-ai-owner.js";
import { createDsmmPiAiProviderOwner } from "../lib/native-pi-ai-wire.js";

export const drain = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };

export async function headersFixture(t) {
  const native = createRequire(process.env.DSMM_TEST_DSH_ENTRY);
  t.diagnostic(`DSMM built owner: ${import.meta.resolve("../lib/live-pi-ai-owner.js")}`);
  t.diagnostic(`DSMM built adapter: ${import.meta.resolve("../lib/native-pi-ai-wire.js")}`);
  for (const name of ["@deepseek-ai/cordis", "@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-llm-pi-ai"]) {
    assert.equal(await realpath(fileURLToPath(import.meta.resolve(name))), await realpath(native.resolve(name)), `${name} must execute from the selected anchor`);
  }
  assert.equal(nativePi.PiAiAdapter, (await import(pathToFileURL(native.resolve("@deepseek-ai/dsh-llm-pi-ai")).href)).PiAiAdapter);
  assert.ok(process.env.DSMM_HEADERS_TEST_ROOT, "Run through the isolated parent test entry");
  await realpath(process.env.DSMM_HEADERS_TEST_ROOT);
  const bodies = [], serverErrors = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, "Bearer fictional-headers-key");
      if (req.method === "GET") { bodies.push({ discovery: true, headers: req.headers }); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "headers-model" }] })); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push({ body, headers: req.headers });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "headers-response", object: "chat.completion.chunk", created: 1, model: body.model };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "complete" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`); res.end("data: [DONE]\n\n");
    } catch (error) { serverErrors.push(error); res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.deepEqual(serverErrors, []);
  });
  let live, registered;
  class FixtureRuntime extends LlmRuntime {
    constructor(scope) { super(scope); live = new LivePiAiOwner(scope, this); }
    registerAdapter(providers, adapter) {
      const handle = super.registerAdapter(providers, adapter);
      registered = { scope: this.ctx, adapter };
      return live.register(this.ctx, providers, adapter, handle);
    }
  }
  await ctx.plugin(FixtureRuntime).await();
  let pause;
  ctx.provide("credentials", { async resolve() {
    const pending = pause; pause = undefined;
    if (pending) { pending.entered.resolve(); await pending.release.promise; }
    return { value: "fictional-headers-key", source: "fictional" };
  } });
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(native.resolve("@deepseek-ai/dsh/package.json")).href }).await();
  ctx.loader.internal = { import: name => import(pathToFileURL(native.resolve(name)).href) };
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  const profile = { api: "openai-completions", baseURL, apiKeyEnv: "DSMM_HEADERS_FICTIONAL",
    models: [{ id: "headers-model", reasoningEfforts: { high: "vendor-high", off: null } }],
    headers: { "x-fixture-static": "profile" }, compat: { maxTokensField: "max_tokens", supportsReasoningEffort: true }, retryPolicy: { mode: "normal", maxRetries: 0 } };
  const entryId = await ctx.loader.create({ name: "@deepseek-ai/dsh-llm-pi-ai", config: { providers: { local: profile } } });
  await ctx.loader.await();
  const entry = ctx.loader.resolve(entryId); await entry.fiber.await();
  assert.equal(entry.fiber.state, 2); assert.ok(registered.adapter instanceof nativePi.PiAiAdapter);
  assert.equal(registered.scope.fiber.entry.options.id, entry.options.id, "borrowed execution must retain the real native registration scope");
  const nativeRegistration = registered;
  let owned;
  await ctx.plugin({ inject: ["llm"], apply(scope) { owned = createDsmmPiAiProviderOwner(scope, {
    config: { providers: { owned: profile } }, settingsNamespace: "headers-owned",
    auth: { credentials: new InMemoryCredentialStore(), authContext: { env: async () => { throw new Error("No ambient credential lookup"); }, fileExists: async () => false } },
    resolveApiKey: async () => "fictional-headers-key",
  }); } }).await();
  const messages = [createUserMessage({ content: [{ type: "text", text: "fictional isolated request" }], source: { kind: "user" } })];
  return { ctx, live, owned, entry, nativeRegistration, bodies, baseURL, messages, profile,
    pauseCredential() { pause = { entered: Promise.withResolvers(), release: Promise.withResolvers() }; return pause; },
    async send(provider, fields = {}, { borrowed = false, signal = new AbortController().signal, effortSource = "dsmm-config" } = {}) {
      const raw = fields.stop !== undefined || fields.customParameters !== undefined;
      const prepared = raw ? await (borrowed ? live : owned).generation(provider).prepareCall(provider, "headers-model", signal, undefined, () => effortSource)
        : await (provider === "local" ? nativeRegistration.adapter : owned.stockAdapter).prepareCall(provider, "headers-model", signal);
      return drain(prepared.stream({ provider, model: "headers-model", sessionId: "headers-session", purpose: "chat", messages, signal, ...fields }));
    },
  };
}
