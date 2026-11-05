import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const inject = ["tools", "fs", "agents", "dsmmNativeAdmission"];
const record = value => appendFileSync(process.env.DSMM_HOST_EVIDENCE, `${JSON.stringify(value)}\n`);

export function apply(ctx, config) {
  record({ type: "patch-provider", provider: ctx.fs.constructor.name });
  ctx.on("tools/result", (exec, result) => {
    if (exec.name === "apply_patch") record({ type: "patch-result", callId: exec.callId, sessionId: exec.agent?.id,
      isError: result.isError, error: result.error, value: result.value, meta: result.meta });
  }, { global: true });
  ctx.on("fs/observed", (target, observation, actor) => {
    record({ type: "patch-observation", path: target.displayPath, key: target.targetKey, observation, sessionId: actor?.agent?.id });
  }, { global: true });
  ctx.on("approval/request", () => { record({ type: "patch-approval-interaction" }); return "rejected"; }, { global: true });
  if (config.gate) ctx.on("tools/pre-execute", async (exec, next) => {
    const decision = await next();
    if (exec.name !== "apply_patch" || decision.kind !== "allow") return decision;
    record({ type: "patch-native-gate", gate: config.gate });
    return { kind: config.gate, reason: "Isolated native patch gate" };
  }, { global: true });
  ctx.on("agent/created", async ({ agent }) => {
    if (config.ceiling && agent.session.header.origin !== "subagent") agent.ctx.tools.restrict({ deny: ["apply_patch"] });
  });
  ctx.tools.register(defineTool({
    name: "native_apply_patch_probe", description: "Exercise isolated native patch runtime boundaries",
    parameters: { action: { type: "string", enum: ["cancel", "cancel-commit", "ceiling", "retired", "move-partial"], required: true },
      input: { type: "string", required: true } },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute({ action, input }, exec) {
      const abort = new AbortController(), stops = [];
      let agent = exec.agent, handle;
      const call = async () => {
        try {
          const batch = await ctx.tools.execute({ calls: [{ type: "tool-call", id: ToolCallId(randomUUID()),
            name: "apply_patch", arguments: JSON.stringify({ input }) }], agent, signal: abort.signal,
            ...(agent === exec.agent ? { toolSet: exec.toolSet } : {}) });
          return batch.results[0].result;
        } catch (error) {
          record({ type: "patch-probe-dispatch-error", action, message: error.message, code: error.code,
            cause: error.cause?.message, causeCode: error.cause?.code });
          throw error;
        }
      };
      try {
        if (action === "cancel") abort.abort();
        if (action === "ceiling") stops.push(agent.ctx.tools.restrict({ deny: ["apply_patch"] }));
        if (action === "retired") {
          handle = await ctx.agents.create({ sessionId: `session-${randomUUID()}`, meta: { cwd: process.cwd() },
            agentOptions: { provider: "local", model: "native-model" } });
          agent = handle.agent;
          await handle.dispose();
          assert.equal(ctx.agents.get(agent.id), undefined);
        }
        if (action === "cancel-commit") stops.push(ctx.on("fs/observed", (target, _observation, actor) => {
          if (actor?.agent === agent && basename(target.displayPath) === "cancel-first.txt") abort.abort();
        }, { global: true }));
        if (action === "move-partial") {
          const previous = ctx.fs.internals;
          assert.ok(previous, "native LocalFileSystem must expose its documented IO test seam");
          ctx.fs.internals = { ...previous, async removeFile(path) {
            assert.equal(basename(path), "move-source.txt");
            record({ type: "patch-native-remove-fault", path });
            throw Object.assign(new Error("Isolated source removal denied"), { code: "EACCES" });
          } };
          stops.push(() => { ctx.fs.internals = previous; });
        }
        const result = await call();
        record({ type: "patch-probe", action, isError: result.isError, error: result.error, value: result.value });
        return JSON.stringify({ action, result });
      } finally {
        for (const stop of stops.reverse()) stop();
        if (handle && ctx.agents.get(handle.agent.id)) await handle.dispose();
      }
    }
  }));
}
