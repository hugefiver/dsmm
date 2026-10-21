import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRoleProfile, fixture, startDoc } from "./host-llm-review-fixture.mjs";

for (const passthrough of [true, false]) test(`a parent admission change cancels a real child's credential wait under policy ${passthrough} before HTTP`, async t => {
  const entered = Promise.withResolvers();
  let release;
  const f = await fixture(t, { production: true, cleanup: () => release?.(new Error("fixture closed")), resolveApiKey: async (provider, reference, signal) => {
    assert.equal(provider, "apai"); assert.equal(reference, "DSMM_W1_REVIEW_FICTIONAL");
    entered.resolve(signal);
    await new Promise((_resolve, reject) => { release = reject; signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
    return "fictional-unreachable";
  } });
  const primary = { provider: "apai", model: "gpt-6.1-sol", reasoningEffort: "medium", original: false };
  await applyRoleProfile(f, "epoch-a", { primary, fallbackRoutes: [] }, { modelParameters: { passthrough } });
  const { run, agent } = await startDoc(f, { prompt: [{ type: "text", text: "Wait for this exact admission" }] });
  try {
    const signal = await entered.promise;
    const admitted = f.ctx.dsmmProfileRuntime.admission(agent);
    await applyRoleProfile(f, "epoch-b", { primary: { provider: "apai", model: "gpt-5.6-terra", reasoningEffort: "high" }, fallbackRoutes: [] });
    assert.equal(signal.aborted, true);
    assert.equal((await run.result).stopReason, "aborted");
    assert.equal(f.bodies.length, 0);
    assert.equal(f.ctx.dsmmProfileRuntime.admission(agent), admitted);
    assert.deepEqual(admitted.childCapture.invocation.requestedRoute, primary);
    assert.equal(agent.session.requestHeader().config.reasoningEffort, passthrough ? "medium" : undefined);
  } finally { await run.dispose(); }
});

test("cancel reaches request-time credentials before the stream watchdog starts", async t => {
  for (const cancel of ["user", "admission", "generation", "owner"]) await t.test(cancel, async t => {
    const started = Promise.withResolvers(), generationLife = new AbortController();
    let resolverSignal, releaseForCleanup;
    const f = await fixture(t, { cleanup: () => releaseForCleanup?.(),
      generation: original => ({ ...original, signal: AbortSignal.any([original.signal, generationLife.signal]) }),
      resolveApiKey: async (_provider, _reference, signal) => {
        resolverSignal = signal;
        started.resolve();
        await new Promise((resolve, reject) => {
          releaseForCleanup = () => reject(new Error("owned fixture cleanup"));
          signal.throwIfAborted();
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return "unreachable-fictional-key";
      } });
    f.start("wait only for the request credential signal");
    await started.promise;
    if (cancel === "user") f.agent.cancel({ kind: "user" }, { keepInbox: true });
    else if (cancel === "admission") f.admissionLife.abort();
    else if (cancel === "generation") generationLife.abort();
    else await [...f.ctx.loader.entries()].find(entry => entry.options.id === "dsmm-llm-owner").fiber.dispose();
    assert.equal(resolverSignal.aborted, true);
    await f.agent.whenIdle();
    assert.equal(f.bodies.length, 0);
    assert.equal(f.ready.provider.generation("apai").signal.aborted, cancel === "owner");
  });
});
