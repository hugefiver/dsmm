import assert from "node:assert/strict";
import test from "node:test";
import type { Agent, AssistantStreamFrame } from "@deepseek-ai/dsh-agent";
import { LlmError, ToolCallId, expandAssistantStream } from "@deepseek-ai/dsh-llm";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import { foldSubagentDescriptor } from "@deepseek-ai/dsh-subagent";
import type { DsmmProfileRuntime } from "../lib/profile-runtime.js";
import type { DshAgent } from "../lib/dsh-types.js";
import { headerRoutes, nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

test("source role tools preserve selected profile strategies and correlate live streams with durable native settlements", { timeout: 20000 }, async t => {
  const fixture = await nativeRoutingFixture({ defaultActive: true });
  const route = (model: string) => ({ provider: "fixture", model, reasoningEffort: "max" });
  try {
    const runtime = fixture.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    for (const strategy of ["startup-lock", "rate-limit-fallback"] as const) {
      for (const output of ["none", "text", "tool"] as const) await t.test(`${strategy}/${output}`, async () => {
        const primary = `${strategy}-${output}`;
        const backup = `${primary}-backup`;
        const saved = await runtime.save({ id: "native-policy", expectedRevision: (await runtime.describe()).profiles.find(row => row.id === "native-policy")?.revision ?? null,
          content: JSON.stringify({ version: 1, id: "native-policy", settings: { defaultActive: true, roleRouting: { "dsmm-reviewer": {
            primary: route(primary), fallbackRoutes: [route(backup)], strategy,
            rateLimit: { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0, maxTotalDelayMs: 0, switchAfterRateLimits: 2, maxSwitches: 1 }
          } } } }) });
        await runtime.select({ id: saved.id, expectedRevision: saved.revision, expectedSelectionRevision: (await runtime.describe()).selectionRevision });
        const parent = await fixture.create();
        const child = await fixture.createAuxiliary("dsmm-reviewer", undefined, "continuable", parent);
        const admission = runtime.admission(child as unknown as DshAgent);
        assert.equal(admission.appliedRevision, runtime.admission(parent as unknown as DshAgent).appliedRevision);
        assert.equal(admission.profile?.id, saved.id);
        assert.equal(admission.epoch, runtime.admission(parent as unknown as DshAgent).epoch);
        const live: AssistantStreamFrame[] = [];
        const remove = fixture.ctx.on("agent/assistant-stream", ({ agent, frame }: { agent: Agent; frame: AssistantStreamFrame }) => { if (agent === child) live.push(frame); }, { global: true });
        let downstream = 0;
        const removeRetry = fixture.ctx.on("agent/request-error", async ({ agent }, next) => { if (agent !== child) return next(); downstream++; return { kind: "retry" }; });
        const calls = fixture.adapter.calls.length;
        fixture.adapter.streamChunks = async function* (options): AsyncIterable<StreamChunk> {
          if (options.model === primary) {
            if (output === "text") {
              yield { type: "block-start", index: 0, blockType: "text" };
              yield { type: "text-delta", index: 0, text: "accepted partial fixture text" };
            } else if (output === "tool") {
              yield { type: "block-start", index: 0, blockType: "tool-call" };
              yield { type: "tool-call-delta", index: 0, id: ToolCallId("incomplete-owned-call"), name: "read", argumentsDelta: '{"file_path":' };
            }
            throw new LlmError("deterministic native no-output or partial failure", "RATE_LIMIT", { status: 429 });
          }
          yield { type: "block-end", index: 0, block: { type: "text", text: "fixture complete" } };
          yield { type: "finish", reason: { kind: "stop" } };
        };
        try {
          await runFixtureTurn(child);
          const expected = output === "none" ? strategy === "startup-lock" ? [primary, primary, primary] : [primary, primary, backup] : [primary];
          assert.deepEqual(fixture.adapter.calls.slice(calls).map(call => call.model), expected);
          assert.deepEqual(headerRoutes(child).map(row => row.model), [...new Set(expected)]);
          assert.equal(downstream, 0);
          const events = child.session.snapshotEvents().slice(child.session.inheritedEventCount);
          assert.equal(foldSubagentDescriptor(events)?.provider, "dsmm-role-reviewer");
          assert.equal(foldSubagentDescriptor(events)?.mode, "continuable");
          assert.equal(events.some(event => event.type === "tool/call" || event.type === "tool/result"), false);
          assert.equal(events.filter(event => event.type === "turn/end").at(-1)?.data.reason.kind, output === "none" && strategy === "rate-limit-fallback" ? "completed" : "error");
          const starts = live.filter(frame => frame.type === "start");
          assert.equal(starts.length, expected.length);
          for (const start of starts) {
            const end = live.find(frame => frame.type === "end" && frame.attemptId === start.attemptId);
            assert.ok(end?.type === "end" && end.outcome.kind === "committed");
            const settlementSeq = end.outcome.seq;
            const settled = events.find(event => event.seq === settlementSeq);
            assert.ok(settled && (settled.type === "assistant/message" || settled.type === "assistant/attempt"));
            assert.deepEqual(expandAssistantStream(settled.data.stream), live.flatMap(frame => frame.type === "chunk" && frame.attemptId === start.attemptId ? [{ time: frame.time, chunk: frame.chunk }] : []));
          }
        } finally { remove(); removeRetry(); fixture.adapter.streamChunks = undefined; await fixture.releaseAuxiliary(child); }
      });
    }
  } finally { await fixture.dispose(); }
});

test("native role tools preserve startup availability, later-turn locks and independent selected-profile routes", { timeout: 20000 }, async t => {
  const fixture = await nativeRoutingFixture({ defaultActive: true });
  const route = (model: string) => ({ provider: "fixture", model, reasoningEffort: "max" });
  try {
    const runtime = fixture.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
    for (const name of ["startup-primary-lock", "startup-first-available", "unavailable-first", "unavailable-partial", "unavailable-later", "profile-alpha-planner", "profile-beta-reviewer"] as const) await t.test(name, async () => {
      const role = name === "profile-alpha-planner" ? "dsmm-planner" : "dsmm-reviewer";
      const rollover = name.startsWith("profile-");
      const fallback = `${name}-fallback`;
      const saved = await runtime.save({ id: name, expectedRevision: null, content: JSON.stringify({ version: 1, id: name, settings: { defaultActive: true, roleRouting: { [role]: {
        primary: { ...route(name), ...(name === "startup-first-available" ? { provider: "missing-native-adapter" } : {}) }, fallbackRoutes: [route(fallback)],
        strategy: rollover ? "rate-limit-fallback" : "startup-lock",
        rateLimit: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0, maxTotalDelayMs: 0, switchAfterRateLimits: 1, maxSwitches: 1 }
      } } } }) });
      await runtime.select({ id: saved.id, expectedRevision: saved.revision, expectedSelectionRevision: (await runtime.describe()).selectionRevision });
      const parent = await fixture.create();
      const child = await fixture.createAuxiliary(role, undefined, "continuable", parent);
      const admission = runtime.admission(child as unknown as DshAgent);
      const calls = fixture.adapter.calls.length;
      fixture.adapter.streamChunks = async function* (options): AsyncIterable<StreamChunk> {
        const attempt = fixture.adapter.calls.length - calls;
        if (options.model === name && (rollover || name === "unavailable-first" && attempt === 1 || name === "unavailable-partial" || name === "unavailable-later" && attempt === 2)) {
          if (name === "unavailable-partial") yield { type: "text-delta", index: 0, text: "accepted output" };
          throw new LlmError("deterministic native route failure", rollover ? "RATE_LIMIT" : "UNKNOWN_MODEL", { status: rollover ? 429 : 503 });
        }
        yield { type: "block-end", index: 0, block: { type: "text", text: "fixture complete" } };
        yield { type: "finish", reason: { kind: "stop" } };
      };
      try {
        await runFixtureTurn(child);
        if (name === "startup-primary-lock" || name === "startup-first-available" || name === "unavailable-later") await runFixtureTurn(child);
        const expected = name === "startup-primary-lock" || name === "unavailable-later" ? [name, name]
          : name === "startup-first-available" ? [fallback, fallback] : name === "unavailable-partial" ? [name] : [name, fallback];
        assert.deepEqual(fixture.adapter.calls.slice(calls).map(call => call.model), expected);
        assert.deepEqual(headerRoutes(child).map(row => row.model), [...new Set(expected)]);
        assert.equal(admission.profile?.id, name);
        assert.equal(runtime.admission(child as unknown as DshAgent), admission);
        assert.equal(child.session.header.parentSession, parent.id);
        assert.equal(fixture.agents.isOwnedBy(child.id, parent), true);
        assert.equal(child.session.snapshotEvents().some(event => event.type === "tool/call" || event.type === "tool/result"), false);
        assert.equal(child.session.snapshotEvents().filter(event => event.type === "turn/end").at(-1)?.data.reason.kind, name === "unavailable-partial" || name === "unavailable-later" ? "error" : "completed");
      } finally { fixture.adapter.streamChunks = undefined; await fixture.releaseAuxiliary(child); }
    });
  } finally { await fixture.dispose(); }
});
