import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { attributionHeaders } from "@deepseek-ai/dsh-llm";
import { headersFixture, drain } from "./pi-ai-request-headers-fixture.mjs";
import { symbols } from "@deepseek-ai/cordis";

const native = createRequire(process.env.DSMM_TEST_DSH_ENTRY);
const version = JSON.parse(await readFile(native.resolve("@deepseek-ai/dsh-llm-pi-ai/package.json"), "utf8")).version;
const dynamic = version.startsWith("0.2.2-");

test(`anchored ${version} request headers through owned and borrowed adapters`, { timeout: 30_000 }, async t => {
  const f = await headersFixture(t);
  t.diagnostic(`SDK ${version}: ${native.resolve("@deepseek-ai/dsh-llm-pi-ai")}`);
  const calls = [], seenHeaders = new Set(), order = [];
  let fail = false;
  const remove = f.ctx.on("llm-pi-ai/request-headers", (request, headers, next) => {
    calls.push(request); order.push("outer-before");
    assert.equal(Object.isFrozen(request), true);
    assert.equal(seenHeaders.has(headers), false); seenHeaders.add(headers);
    assert.deepEqual(Object.keys(request).sort(), ["baseURL", "model", "provider", "purpose", "sessionId"]);
    assert.equal(request.baseURL, f.baseURL); assert.equal(request.sessionId, "headers-session"); assert.equal(request.purpose, "chat");
    assert.equal(headers.get("x-fixture-static"), "profile"); assert.equal(headers.has("x-fixture-dynamic"), false);
    if (fail) throw new TypeError("fictional-secret-must-stay-private");
    headers.set("x-fixture-dynamic", String(calls.length));
    for (const key of Object.keys(attributionHeaders())) headers.set(key, "fixture-override");
    const result = next(); order.push("outer-after"); return result;
  });
  const inner = f.ctx.on("llm-pi-ai/request-headers", (_request, headers, next) => {
    order.push("inner-before"); const result = next(); order.push("inner-after");
    assert.equal(result, headers); const replaced = new Headers(result); replaced.set("x-fixture-inner", "retained"); return replaced;
  });

  await t.test("standard, stop-only and raw efforts share fresh synchronous native preparation", async () => {
    for (const provider of ["owned", "local"]) {
      for (const [fields, effortSource] of [
        [{}, "native"], [{ stop: ["END"] }, "dsmm-config"],
        [{ customParameters: { fixture_probe: false }, reasoningEffort: "literal-vendor" }, "dsmm-config"],
        [{ customParameters: { fixture_probe: 0 }, reasoningEffort: "high" }, "native"],
      ]) {
        const before = calls.length;
        const chunks = await f.send(provider, fields, { borrowed: provider === "local", effortSource });
        assert.ok(chunks.some(chunk => chunk.type === "finish" && chunk.reason.kind === "stop"), JSON.stringify(chunks));
        const sent = f.bodies.at(-1);
        assert.equal(calls.length - before, dynamic ? 1 : 0, "borrowed standard adapter must not invoke the hook twice");
        if (dynamic) { assert.equal(calls.at(-1).provider, provider); assert.equal(calls.at(-1).model, "headers-model"); }
        if (fields.stop) assert.deepEqual(sent.body.stop, fields.stop);
        if (fields.customParameters) assert.equal(sent.body.fixture_probe, fields.customParameters.fixture_probe);
        if (fields.reasoningEffort) assert.equal(sent.body.reasoning_effort, effortSource === "native" ? "vendor-high" : "literal-vendor");
        assert.equal(sent.headers["x-fixture-dynamic"], dynamic ? String(calls.length) : undefined);
        assert.equal(sent.headers["x-fixture-inner"], dynamic ? "retained" : undefined);
        for (const [key, value] of Object.entries(attributionHeaders())) assert.equal(sent.headers[key.toLowerCase()], value);
      }
    }
    assert.deepEqual(order, Array.from({ length: calls.length }, () => ["outer-before", "inner-before", "inner-after", "outer-after"]).flat());
  });

  await t.test("borrowed native and raw dispatch the waterfall from their registration scope", async () => {
    const scopes = [], prototype = Object.getPrototypeOf(f.ctx.events), waterfall = prototype.waterfall;
    const spy = t.mock.method(prototype, "waterfall", function(...args) {
      if (args[0] === "llm-pi-ai/request-headers") scopes.push(this.ctx.fiber.entry?.options.id);
      return waterfall.apply(this, args);
    });
    try {
      await f.send("local"); await f.send("local", { stop: ["END"] }, { borrowed: true });
      assert.deepEqual(scopes, dynamic ? [f.entry.options.id, f.entry.options.id] : []);
    } finally { spy.mock.restore(); }
  });

  await t.test("discovery does not invoke inference contributors", async () => {
    const before = calls.length;
    await f.nativeRegistration.adapter.listModels("local"); await f.owned.stockAdapter.listModels("owned");
    const models = await f.ctx.llm.discoverModels(f.entry.options.id, { baseURL: f.baseURL, api: "openai-completions", apiKey: "fictional-headers-key" });
    assert.ok(models.some(model => model.id === "headers-model")); assert.equal(f.bodies.at(-1).discovery, true);
    assert.equal(f.bodies.at(-1).headers["x-fixture-dynamic"], undefined); assert.equal(calls.length, before);
  });

  await t.test("throw follows REQUEST_HEADERS before inference HTTP", async st => {
    if (!dynamic) { st.skip("Host has no native dynamic header hook"); return; }
    fail = true;
    for (const provider of ["owned", "local"]) for (const fields of [{}, { stop: ["END"] }]) {
      const before = f.bodies.length;
      await assert.rejects(f.send(provider, fields, { borrowed: provider === "local" }), error => {
        assert.equal(error.code, "REQUEST_HEADERS"); assert.equal(error.message.includes("fictional-secret"), false); return true;
      });
      assert.equal(f.bodies.length, before);
    }
    fail = false;
  });

  remove(); inner();
  await t.test("scoped listeners are removed with their native plugin fiber", async () => {
    let count = 0;
    const plugin = f.ctx.plugin({ apply(scope) { scope.on("llm-pi-ai/request-headers", (_request, headers, next) => { count++; headers.set("x-fixture-scoped", "active"); return next(); }); } });
    await plugin.await(); await f.send("local", { stop: ["END"] }, { borrowed: true });
    assert.equal(count, dynamic ? 1 : 0); assert.equal(f.bodies.at(-1).headers["x-fixture-scoped"], dynamic ? "active" : undefined);
    await plugin.dispose(); await f.send("local", { stop: ["END"] }, { borrowed: true });
    assert.equal(count, dynamic ? 1 : 0); assert.equal(f.bodies.at(-1).headers["x-fixture-scoped"], undefined);
  });

  await t.test("real Loader provider edits retire the captured profile without HTTP", async () => {
    const generation = f.live.generation("local"), signal = new AbortController().signal;
    const prepared = await generation.prepareCall("local", "headers-model", signal);
    const before = f.bodies.length;
    await f.entry.update({ config: { providers: { local: { ...f.profile, headers: { ...f.profile.headers, "x-fixture-reconfigured": "next" } } } } });
    await f.ctx.loader.await();
    assert.throws(() => generation.assertCurrent());
    await assert.rejects(async () => drain(prepared.stream({ provider: "local", model: "headers-model", messages: f.messages, stop: ["END"], signal })));
    assert.equal(f.bodies.length, before);
    await f.send("local", { stop: ["END"] }, { borrowed: true });
    assert.equal(f.bodies.at(-1).headers["x-fixture-reconfigured"], "next");
  });

  await t.test("a different real native fiber cannot satisfy the registration identity fence", async () => {
    const generation = f.live.generation("local"), before = f.bodies.length;
    const entry = Reflect.get(f.entry, symbols.original) ?? f.entry, registered = entry.fiber;
    const replacement = f.ctx.plugin({ apply() {} }); await replacement.await();
    try {
      assert.ok(replacement.ctx.fiber !== registered.ctx.fiber);
      entry.fiber = replacement;
      assert.throws(() => generation.assertCurrent(), { code: "INVALID_PREPARED_CALL" });
      assert.equal(f.bodies.length, before);
    } finally { entry.fiber = registered; await replacement.dispose(); }
    await f.send("local", { stop: ["END"] }, { borrowed: true });
    assert.equal(f.bodies.length, before + 1);
  });

  await t.test("real Loader reactivation replaces effective snapshot and canonical fiber", async () => {
    const original = value => Reflect.get(value, symbols.original) ?? value;
    const fiber = f.entry.fiber.ctx.fiber;
    const snapshot = "effectiveConfig" in fiber ? fiber.effectiveConfig : fiber.config;
    const generation = f.live.generation("local"), signal = new AbortController().signal;
    const prepared = await generation.prepareCall("local", "headers-model", signal), before = f.bodies.length;
    await f.entry.update({ disabled: true }); await f.ctx.loader.await();
    await f.entry.update({ disabled: false }); await f.ctx.loader.await();
    const current = f.entry.fiber.ctx.fiber;
    assert.ok(original(current) !== original(fiber), "native Loader must create a different real fiber");
    assert.ok(("effectiveConfig" in current ? current.effectiveConfig : current.config) !== snapshot);
    assert.throws(() => generation.assertCurrent());
    await assert.rejects(async () => drain(prepared.stream({ provider: "local", model: "headers-model", messages: f.messages, stop: ["END"], signal })));
    assert.equal(f.bodies.length, before);
    await f.send("local", { stop: ["END"] }, { borrowed: true });
    assert.equal(f.bodies.length, before + 1);
  });

  await t.test("credential-await cancellation and registration retirement fence borrowed raw HTTP", async () => {
    for (const boundary of ["cancel", "retire"]) {
      const paused = f.pauseCredential(), call = new AbortController(), before = f.bodies.length;
      const pending = f.send("local", { stop: ["END"] }, { borrowed: true, signal: call.signal });
      await paused.entered.promise;
      if (boundary === "cancel") call.abort(); else await f.entry.update({ disabled: true });
      paused.release.resolve(); await assert.rejects(pending); assert.equal(f.bodies.length, before);
    }
  });
});
