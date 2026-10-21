import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import { nativeFixturePlugin, nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

function* call(name: string, args: unknown): Generator<StreamChunk> {
  const id = ToolCallId(`native-${name}`), text = JSON.stringify(args);
  yield { type: "block-start", index: 0, blockType: "tool-call" };
  yield { type: "tool-call-delta", index: 0, id, name, argumentsDelta: text };
  yield { type: "block-end", index: 0, block: { type: "tool-call", id, name, arguments: text } };
  yield { type: "finish", reason: { kind: "tool-calls" } };
}
function* answer(text: string): Generator<StreamChunk> {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: { kind: "stop" } };
}

async function presetHostServices(ctx: import("@deepseek-ai/cordis").Context): Promise<void> {
  const denied = async (): Promise<never> => { throw new Error("fixture forbids web/shell/subprocess operations"); };
  const web = await nativeFixturePlugin("@deepseek-ai/dsh-web", "@deepseek-ai/dsh-tool-web");
  await ctx.plugin(web.default, {}).await();
  ctx.provide("subprocess", { spawn: denied });
  ctx.provide("shell", { execute: denied });
  ctx.provide("shellEnv", { resolve: denied });
}

test("real native root orchestrator owns formal planning; native plan review returns complete Markdown without upgrading planner file permissions", async () => {
  const reviews: string[] = [];
  const plan = "# Native complete plan\n\n- [ ] Implement bounded change\n- [ ] Verify result\n";
  let planner: import("@deepseek-ai/dsh-agent").Agent | undefined;
  const f = await nativeRoutingFixture({ subagents: { maxDepth: 3 }, roleRouting: { "dsmm-planner": { primary: { provider: "fixture", model: "formal-planner" } } } }, {
    nativePresets: true, nativeFs: true,
    async beforeDsmm(ctx) {
      await presetHostServices(ctx);
      const module = await nativeFixturePlugin("@deepseek-ai/dsh-plan-mode");
      await ctx.plugin(module.default, { section: "Return the complete Markdown plan for native review; role permissions do not change." }).await();
      ctx.provide("userQuestions", { async ask(request: { questions: Array<{ id: string; detail?: string }> }) {
        reviews.push(request.questions[0].detail!);
        return { answers: [{ id: request.questions[0].id, selected: ["Approve"] }] };
      } });
      ctx.on("agent/created", ({ agent }) => {
        if (agent.options.model === "formal-planner") { planner = agent; ctx.get("planMode")!.set(agent, true); }
      }, { global: true });
    }
  });
  try {
    const directory = join(f.profileDir, "docs", "superpowers", "plans"); mkdirSync(directory, { recursive: true });
    const path = join(directory, "formal.md");
    const attempts = new Map<string, number>();
    f.adapter.streamChunks = async function* (options) {
      const step = attempts.get(options.model) ?? 0; attempts.set(options.model, step + 1);
      if (options.model === "formal-planner") {
        if (step === 0) yield* call("exit_plan_mode", { plan });
        else if (step === 1) yield* call("write", { file_path: path, content: plan });
        else yield* answer(plan);
      } else if (step === 0) yield* call("dsmm_planner", { description: "Formal native planning", prompt: "Return a complete native-reviewed Markdown plan" });
      else if (step === 1) yield* call("write", { file_path: path, content: plan });
      else yield* answer("Native coordinator persisted the reviewed plan");
    };
    const root = await f.create({ agentPreset: "dsmm-orchestrator", cwd: f.profileDir });
    assert.equal(f.ctx.get("agentPresets")!.composedPreset(root.ctx), "dsmm-orchestrator");
    await runFixtureTurn(root);
    assert.deepEqual(reviews, [plan]);
    assert.ok(planner);
    const results = planner.session.snapshotEvents().filter((event) => event.type === "tool/result");
    assert.match(JSON.stringify(results), /Plan approved/);
    assert.match(JSON.stringify(results), /write.*(?:UNKNOWN_TOOL|not permit)|(?:UNKNOWN_TOOL|not permit).*write/s);
    assert.equal(readFileSync(path, "utf8"), plan);
    assert.deepEqual(f.agents.list(), [root]);
  } finally { await f.dispose(); }
});

test("native blank preset rebind refreshes the actual tool realm, admits only the dispatcher and fails closed on other roles", async () => {
  const f = await nativeRoutingFixture({ roles: { "dsmm-planner": true, "dsmm-quick": true }, subagents: { maxDepth: 3 } }, { nativePresets: true });
  try {
    const root = await f.create({ agentPreset: "standard", cwd: f.profileDir });
    const presets = f.ctx.get("agentPresets")!;
    await presets.select(root, "dsmm-orchestrator");
    await f.ctx.get("systemPrompt")!.assemble({ scope: root });
    const tools = presets.serviceFor(root, "tools") ?? root.ctx.get("tools")!;
    assert.ok(tools.get("dsmm_code_search", root));
    const utility = await tools.execute({ agent: root, name: "dsmm_code_search", callId: ToolCallId("rebound-orchestrator-utility"), arguments: { description: "Read-only utility proof", prompt: "Return a useful local result" }, signal: new AbortController().signal });
    assert.equal(utility.isError, false); assert.match(JSON.stringify(utility), /fixture complete/);
    // Delegation roles are not registered presets. A bound root cannot switch
    // to one (the registry roster only offers the dispatcher), so the admitted
    // dispatcher composition keeps executing; the roster refusal itself is
    // covered by the root-eligibility suite.
    const kept = await tools.execute({ agent: root, name: "dsmm_code_search", callId: ToolCallId("rebound-planner-refused"), arguments: { description: "Kept composition", prompt: "Return a useful local result" }, signal: new AbortController().signal });
    assert.equal(kept.isError, false);
    assert.equal(f.adapter.calls.length, 2);
  } finally { await f.dispose(); }
});

test("native background activation returns accepted identity and survives caller return until explicit interruption", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, subagents: { enableRunInBackground: true, maxDepth: 3 } }, { nativePresets: true });
  try {
    const parent = await f.create(), foreign = await f.create();
    const tools = parent.ctx.get("tools")!, caller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((done) => { entered = done; });
    f.adapter.beforeStream = async (options) => { entered(); await new Promise<void>((done) => options.signal!.addEventListener("abort", () => done(), { once: true })); };
    const result = await tools.execute({ agent: parent, name: "dsmm_category", callId: ToolCallId("native-background"), arguments: { category: "dsmm-coding", description: "Owned native background", prompt: "Return useful background result", run_in_background: true }, signal: caller.signal });
    assert.equal(result.isError, false, JSON.stringify(result)); await started;
    const child = f.agents.list().find(agent => f.agents.isOwnedBy(agent.id, parent))!;
    assert.ok(child); assert.match(JSON.stringify(result.value), new RegExp(child.id));
    caller.abort(); assert.equal(f.adapter.calls[0].signal?.aborted, false);
    assert.throws(() => f.subagents.interruptByParent(child.id, foreign.id, "continuable"));
    assert.deepEqual(await f.subagents.interruptByParent(child.id, parent.id, "continuable"), { accepted: true });
    await f.subagents.drainChildren(parent, [child.id]);
    assert.deepEqual(f.agents.list(), [parent, foreign]);
  } finally { await f.dispose(); }
});

test("native default depth refuses before publication; foreground failure and abort retain typed terminal outcomes", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, subagents: { enableRunInBackground: true }, roleRouting: { "dsmm-coding": { primary: { provider: "fixture", model: "typed-error" } } } }, { nativePresets: true });
  try {
    const parent = await f.create();
    assert.deepEqual(f.agents.list(), [parent]);
    const child = await f.createAuxiliary("dsmm-deep", undefined, "continuable", parent);
    try {
      await runFixtureTurn(child);
      const overDepth = await child.ctx.get("tools")!.execute({ agent: child, name: "dsmm_category", callId: ToolCallId("native-depth-default"), arguments: { category: "dsmm-coding", description: "Legitimate but too deep", prompt: "Native default 1 applies" }, signal: new AbortController().signal });
      assert.equal(overDepth.isError, true); assert.match(JSON.stringify(overDepth), /depth/i);
      assert.equal(f.agents.list().length, 2);
    } finally { await f.releaseAuxiliary(child); }
    f.adapter.failModels.add("typed-error");
    const fail = await parent.ctx.get("tools")!.execute({ agent: parent, name: "dsmm_category", callId: ToolCallId("typed-child-failure"), arguments: { category: "dsmm-coding", description: "Typed failure proof", prompt: "Fail inside mock model", run_in_background: false }, signal: new AbortController().signal });
    assert.equal(fail.isError, true); assert.match(JSON.stringify(fail), /DSMM_INCOMPLETE/);
    f.adapter.failModels.clear();
    let entered!: () => void;
    const started = new Promise<void>((done) => { entered = done; });
    f.adapter.beforeStream = async (options) => { entered(); await new Promise<void>((done) => options.signal!.addEventListener("abort", () => done(), { once: true })); };
    const abort = new AbortController();
    const pending = parent.ctx.get("tools")!.execute({ agent: parent, name: "dsmm_category", callId: ToolCallId("typed-child-abort"), arguments: { category: "dsmm-coding", description: "Owned abort proof", prompt: "Wait for abort", run_in_background: false }, signal: abort.signal });
    await started; abort.abort();
    const cancelled = await pending; assert.equal(cancelled.isError, true); assert.match(JSON.stringify(cancelled), /ABORTED|abort|cancel/i);
    assert.deepEqual(f.agents.list(), [parent]);
  } finally { await f.dispose(); }
});

test("official model-facing controls enforce adjacency and continue useful output on the same interrupted child", { timeout: 15000 }, async () => {
  const f = await nativeRoutingFixture({ defaultActive: true, subagents: { enableRunInBackground: true, maxDepth: 3 } }, { nativePresets: true, nativeControls: true, nativeSubagents: { maxActiveSubagents: 1 } });
  try {
    const parent = await f.create(), other = await f.create();
    let entered!: () => void;
    const started = new Promise<void>((done) => { entered = done; });
    f.adapter.beforeStream = async (options) => {
      if (options.sessionId === parent.id) return;
      entered(); await new Promise<void>((done) => options.signal!.addEventListener("abort", () => done(), { once: true }));
    };
    const invoke = (agent: typeof parent, name: string, args: unknown) => agent.ctx.get("tools")!.execute({ agent, name, arguments: args, callId: ToolCallId(name), signal: new AbortController().signal });
    const first = await invoke(parent, "dsmm_category", { category: "dsmm-coding", description: "Durable child proof", prompt: "Wait for continuation", run_in_background: true });
    assert.equal(first.isError, false);
    const id = f.agents.list().find(agent => f.agents.isOwnedBy(agent.id, parent))!.id;
    const child = f.agents.get(id)!; await started;
    const overflow = await invoke(parent, "dsmm_category", { category: "dsmm-coding", description: "Capacity refusal", prompt: "Must not publish", run_in_background: true });
    assert.equal(overflow.isError, true); assert.match(JSON.stringify(overflow), /capacity|maxActive|limit|active.*subagent/i);
    const independent = await invoke(other, "dsmm_category", { category: "dsmm-coding", description: "Independent parent pool", prompt: "No cross-parent starvation", run_in_background: true });
    assert.equal(independent.isError, false);
    const delivered = await invoke(parent, "send_message", { agent_id: id, message: "SAME_CHILD_CONTINUATION_INPUT" });
    assert.equal(delivered.isError, false, JSON.stringify(delivered));
    assert.ok(delivered.value !== null && typeof delivered.value === "object" && "messageId" in delivered.value);
    assert.equal(typeof delivered.value.messageId, "string");
    assert.equal((await invoke(other, "send_message", { agent_id: id, message: "Not my child" })).isError, true);
    assert.equal((await invoke(other, "interrupt_agent", { agent_id: id })).isError, true);
    let requestedInterrupt = false;
    f.adapter.streamChunks = async function* (options) {
      if (options.sessionId === parent.id && !requestedInterrupt) {
        requestedInterrupt = true;
        yield* call("interrupt_agent", { agent_id: id });
      } else yield* answer("Interrupt requested");
    };
    await runFixtureTurn(parent);
    assert.equal(requestedInterrupt, true);
    const interruptResult = parent.session.snapshotEvents().filter(event => event.type === "tool/result").find(event => event.data.message.toolCallId === ToolCallId("native-interrupt_agent"));
    assert.ok(interruptResult);
    assert.equal(interruptResult.data.message.isError, false);
    await child.whenIdle();
    assert.equal(child.session.snapshotEvents().filter(event => event.type === "turn/end").at(-1)?.data.reason.kind, "aborted");
    f.adapter.beforeStream = undefined;
    let requestedContinuation = false;
    f.adapter.streamChunks = async function* (options) {
      if (options.sessionId === parent.id && !requestedContinuation) {
        requestedContinuation = true;
        yield* call("send_message", { agent_id: id, message: "Wake the retained conversation" });
      } else yield* answer("CONTINUED_USEFUL_OUTPUT");
    };
    let released!: () => void;
    const disposed = new Promise<void>((done) => { released = done; });
    f.ctx.on("agent/disposed", ({ agent }) => { if (agent === child) released(); }, { global: true });
    await runFixtureTurn(parent);
    assert.equal(requestedContinuation, true);
    const controlResult = parent.session.snapshotEvents().filter(event => event.type === "tool/result").find(event => event.data.message.toolCallId === ToolCallId("native-send_message"));
    assert.ok(controlResult);
    assert.equal(controlResult.data.message.isError, false);
    assert.equal(f.agents.get(id), child, "the durable id still selects the exact retained Agent, not a replacement task");
    await child.whenIdle();
    const events = child.session.snapshotEvents();
    assert.match(JSON.stringify(events), /SAME_CHILD_CONTINUATION_INPUT/);
    assert.match(JSON.stringify(events.filter((event) => event.type === "assistant/message")), /CONTINUED_USEFUL_OUTPUT/);
    await f.subagents.drainChildren(parent, [id]);
    await disposed;
    assert.equal((await invoke(parent, "send_message", { agent_id: id, message: "Cold-resume the same durable child" })).isError, true);
    assert.equal(f.agents.get(id), undefined);
    await f.disposeAgent(other);
    assert.equal(f.agents.list().some((agent) => agent !== parent && f.agents.isOwnedBy(agent.id, other)), false);
  } finally { await f.dispose(); }
});
