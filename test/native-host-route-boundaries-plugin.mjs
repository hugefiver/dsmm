import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { LlmRuntime, createUserMessage } from "@deepseek-ai/dsh-llm";
import { DsmmNativeLlmRuntime } from "@dsmm/dsmm/llm-runtime";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const inject = ["llm", "agents", "tools", "dsmmProfileRuntime"];
const record = value => appendFileSync(process.env.DSMM_HOST_EVIDENCE, `${JSON.stringify(value)}\n`);

export async function apply(ctx, config) {
  assert.ok(ctx.llm instanceof LlmRuntime, "probe and Host must use the same anchor LLM class");
  const dsmm = ctx.llm instanceof DsmmNativeLlmRuntime;
  assert.equal(dsmm, config.owner === "dsmm", "actual LLM service identity must match the cold composition");
  record({ type: "owner", owner: dsmm ? "dsmm" : "official" });
  ctx.on("session/event", (session, event) => {
    if (event.type === "tool/result" && event.data.error) record({ type: "tool-error", sessionId: session.id,
      callId: event.data.message.toolCallId, code: event.data.error.code });
  });
  ctx.on("agent/created", async ({ agent }) => {
    if (agent.session.header.origin === "subagent") return;
    await agent.ctx.plugin(ScopedProbe).await();
    if (config.requestControls) agent.ctx.on("agent/request", async (_frame, next) => ({ ...await next(), temperature: 0, maxTokens: 90 }));
    if (config.residentChild && typeof agent.model?.select === "function") await agent.ctx.plugin(ResidentChildProbe).await();
    if (config.microtaskFailure && typeof agent.model?.select === "function") await agent.ctx.plugin(MicrotaskFailureProbe).await();
  });
  if (config.lifecycle) ctx.tools.register({
    name: "host_boundary_lifecycle", description: "Exercise isolated public SDK root lifecycle boundaries", parameters: {},
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute() { return lifecycle(ctx); }
  });
}

async function lifecycle(ctx) {
  const ref = { current: undefined, assembled: undefined };
  const handle = await ctx.agents.create({
    sessionId: `session-${randomUUID()}`, meta: { cwd: process.cwd() },
    agentOptions: { provider: "local", model: "native-model" },
    setup(scope) { installModelSelection(scope, ref); }
  });
  const agent = handle.agent;
  const profiles = ctx.get("dsmmProfileRuntime");
  const pick = () => {
    assert.equal(agent.status, "idle");
    const selection = { provider: "local", model: "native-model" };
    if (typeof agent.model?.select === "function") agent.model.select(selection);
    else { ref.current = selection; agent.session.append("model/selection", selection); }
  };
  const turn = async label => {
    assert.equal(agent.status, "idle");
    agent.followup(createUserMessage({ content: [{ type: "text", text: `host-boundary-lifecycle:${label}` }], source: { kind: "user" } }));
    await agent.whenIdle();
    const terminal = agent.session.snapshotEvents().findLast(event => event.type === "turn/end");
    assert.equal(terminal?.data.reason.kind, "completed", JSON.stringify(terminal));
    record({ type: "lifecycle", label, sessionId: agent.id });
  };
  const mode = async active => {
    const state = await profiles.getSession(agent);
    const result = await profiles.selectMode({ sessionId: agent.id, active, expectedAdmissionEpoch: state.admissionEpoch,
      expectedModeRevision: state.deepwork.revision }, agent);
    assert.equal(result.deepwork.active, active);
  };
  try {
    await turn("initial");
    pick(); await turn("picker-next-turn");
    await mode(false); pick(); await turn("mode-off");
    await mode(true); await turn("mode-on");
    const saved = await profiles.save({ id: "host-boundary-profile", expectedRevision: null, content: JSON.stringify({
      version: 1, id: "host-boundary-profile", settings: { roleRouting: {
        "dsmm-orchestrator": { primary: { provider: "local", model: "fallback-model", temperature: 0.2 } }
      } }
    }) });
    const before = await profiles.getSession(agent);
    const applied = await profiles.selectSession({ sessionId: agent.id, id: "host-boundary-profile", expectedRevision: saved.revision,
      expectedSelectionRevision: before.selection.selectionRevision, expectedAdmissionEpoch: before.admissionEpoch }, agent);
    assert.notEqual(applied.admissionEpoch, before.admissionEpoch);
    await turn("profile-applied");
    return "host-boundary-lifecycle-complete";
  } finally { await handle.dispose(); }
}

function ResidentChildProbe(ctx) {
  ctx.tools.register({
    name: "host_boundary_child_next_turn", description: "Select and continue the exact owned idle resident child", parameters: {},
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(_args, exec) {
      const parent = exec.agent;
      assert.equal(ctx.agents.get(parent.id), parent);
      const children = ctx.agents.list().filter(child => ctx.agents.isOwnedBy(child.id, parent));
      assert.equal(children.length, 1, "the exact parent must own one real resident child");
      const child = children[0];
      await child.whenIdle();
      assert.equal(child.status, "idle");
      const first = child.session.snapshotEvents().findLast(event => event.type === "turn/end");
      assert.equal(first?.data.reason.kind, "completed", JSON.stringify(first));
      assert.equal(typeof child.model?.select, "function");
      child.model.select({ provider: "local", model: "fallback-model" });
      child.followup(createUserMessage({ content: [{ type: "text", text: "host-boundary-child-manual-next-turn" }], source: { kind: "user" } }));
      await child.whenIdle();
      const terminal = child.session.snapshotEvents().findLast(event => event.type === "turn/end");
      assert.notEqual(terminal.seq, first.seq, "the same resident child must settle a second turn");
      assert.equal(terminal.data.reason.kind, "completed", JSON.stringify(terminal));
      const answer = child.session.snapshotEvents().findLast(event => event.type === "assistant/message");
      assert.ok(answer?.data.message.content.some(block => block.type === "text" && block.text === "host-boundary-child-second-complete"));
      record({ type: "resident-child", parentId: parent.id, childId: child.id, completedTurns: 2 });
      return "host-boundary-child-manual-complete";
    }
  });
}

function MicrotaskFailureProbe(ctx) {
  ctx.tools.register(defineTool({
    name: "host_boundary_microtask_failure", description: "Exercise one isolated configured-root restoration failure",
    parameters: { failure: { type: "string", enum: ["select", "association"], required: true } },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute({ failure }) {
      const handle = await ctx.agents.create({ sessionId: `session-${randomUUID()}`, meta: { cwd: process.cwd() },
        agentOptions: { provider: "local", model: "native-model" }, setup(scope) { installModelSelection(scope); } });
      const agent = handle.agent, select = agent.model.select, commit = agent.session.commit;
      const uncaught = [], errors = [];
      const monitor = error => { uncaught.push(error); };
      process.on("uncaughtExceptionMonitor", monitor);
      const stopErrors = agent.ctx.on("agent/error", ({ error }) => { errors.push(error); });
      let injections = 0;
      const send = label => agent.followup(createUserMessage({ content: [{ type: "text", text: `host-boundary-microtask:${failure}:${label}` }], source: { kind: "user" } }));
      try {
        send("initial"); await agent.whenIdle();
        const first = agent.session.snapshotEvents().findLast(event => event.type === "turn/end");
        assert.equal(first?.data.reason.kind, "completed", JSON.stringify(first));
        assert.equal(agent.status, "idle");
        if (failure === "select") agent.model.select = function (selection) {
          if (selection.provider === "local" && selection.model === "configured-model") {
            injections++; throw new Error("Injected configured-selection failure");
          }
          return select.call(this, selection);
        };
        else agent.session.commit = function (event, ...rest) {
          if (event.type === "plugin:dsmm/model-selection") {
            injections++; throw new Error("Injected model-selection association failure");
          }
          return commit.call(this, event, ...rest);
        };
        agent.model.select({ provider: "local", model: "native-model" });
        await new Promise(resolve => queueMicrotask(resolve));
        assert.equal(injections, 1, "the real restoration microtask must reach the precise injected failure");
        agent.model.select = select; agent.session.commit = commit;
        send("denied"); await agent.whenIdle();
        const terminal = agent.session.snapshotEvents().findLast(event => event.type === "turn/end");
        assert.ok(terminal.seq > first.seq);
        record({ type: "microtask-failure", failure, sessionId: agent.id, injections, uncaught: uncaught.length,
          terminalCode: terminal.data.reason.error?.code, errorCodes: errors.map(error => error.code) });
        assert.equal(terminal.data.reason.kind, "error", JSON.stringify(terminal));
        assert.equal(typeof terminal.data.reason.error.code, "string");
        assert.ok(errors.some(error => error.code === "UNAUTHORIZED"), JSON.stringify(errors.map(error => ({ name: error.name, code: error.code }))));
        assert.equal(uncaught.length, 0);
        return `host-boundary-microtask-${failure}-complete`;
      } finally {
        agent.model.select = select; agent.session.commit = commit;
        stopErrors();
        try { await handle.dispose(); } finally { process.off("uncaughtExceptionMonitor", monitor); }
      }
    }
  }));
}

function ScopedProbe(ctx) {
  ctx.on("agent/status", ({ agent, status }) => {
    if (status !== "running") return;
    const fixedSelection = typeof agent.model?.select === "function";
    record({ type: "running", sessionId: agent.id, fixedSelection });
  });
}
