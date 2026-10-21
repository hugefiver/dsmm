import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { symbols } from "@deepseek-ai/cordis";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { DSMM_ROLES, rolePluginRows, renderAgentCordis } from "../lib/roles.js";
import { nativeFixturePlugin, nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

test("native entry-list YAML parses nested role groups and agrees with the installed SDK's exported standard defaults", async () => {
  const sdk = createRequire(process.env.DSMM_TEST_DSH_ENTRY ?? import.meta.url);
  const include = await nativeFixturePlugin("@deepseek-ai/cordis-plugin-include", "@deepseek-ai/dsh-agent-preset-registry");
  const yaml = createRequire(sdk.resolve("@deepseek-ai/dsh-agent-preset-registry"))("js-yaml");
  const registry = await nativeFixturePlugin("@deepseek-ai/dsh-agent-preset-registry");
  const standard = yaml.load(readFileSync(sdk.resolve("@deepseek-ai/dsh-web-app/presets/standard.patch.yml"), "utf8"), { schema: include.entryListSchema })[0].insert[0].config.plugins;
  for (const role of DSMM_ROLES) {
    const parsed = yaml.load(renderAgentCordis(role), { schema: include.entryListSchema });
    assert.equal(registry.entryListProblem(parsed), undefined, role.id);
    // Only the two renderer-owned platform expressions are normalized. No
    // arbitrary YAML expression or installed standard expression is evaluated.
    for (const row of parsed) {
      if (row.id === "tool-bash" || row.id === "tool-pwsh") {
        assert.equal(row.disabled.__jsExpr, `process.platform ${row.id === "tool-bash" ? "===" : "!=="} 'win32'`);
        row.disabled = row.id === "tool-bash" ? process.platform === "win32" : process.platform !== "win32";
      }
    }
    assert.deepEqual(parsed, rolePluginRows(role), role.id);
  }
  const rows = rolePluginRows(DSMM_ROLES[0]);
  for (const id of ["compaction", "tool-ask-user", "tool-todo"]) assert.deepEqual(rows.find((row) => row.id === id), standard.find((row: { id: string }) => row.id === id));
  const planning = rows.find((row) => row.id === "planning")!;
  assert.ok(Array.isArray(planning.config));
  assert.ok(planning.config[0].config && !Array.isArray(planning.config[0].config));
});

interface NativeCommands {
  list(agent: Agent): ReadonlyArray<{ name: string }>;
  execute(agent: Agent, line: string, attachments: [], signal: AbortSignal): Promise<{ result: { kind: string; text?: string } } | undefined>;
}
interface NativePlanMode {
  get(agent: Agent): { active: boolean; pending?: boolean };
  set(agent: Agent, active: boolean): string;
}
interface NativePruner {
  config: { thresholdChars: number; headChars: number; tailChars: number };
  pruneContent(blocks: Array<{ type: "text"; text: string }>): Array<{ type: "text"; text: string }> | null;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    planMode: NativePlanMode;
    toolResultPruner: NativePruner;
    compaction: object;
  }
}

test("first real DW compositions expose scoped native compact/plan/interaction without automatic model calls; children keep their own ceilings (planner read-only, quick native write)", async () => {
  const f = await nativeRoutingFixture({ roles: { "dsmm-planner": true, "dsmm-quick": true } }, { nativePresets: true, nativeFs: true, nativeJobs: true, async beforeDsmm(ctx) {
    const denied = async (): Promise<never> => { throw new Error("fixture forbids external web/shell/subprocess work"); };
    ctx.provide("web", { search: denied, fetch: denied });
    ctx.provide("subprocess", { spawn: denied });
    ctx.provide("shell", { execute: denied });
    ctx.provide("shellEnv", { resolve: denied });
  } });
  try {
    const presets = f.ctx.get("agentPresets")!;
    const commands = f.ctx.get("commands") as NativeCommands;
    const roots = await Promise.all(["dsmm-orchestrator", "dsmm-orchestrator"].map((agentPreset) => f.create({ agentPreset, cwd: f.profileDir })));
    const compactions: unknown[] = [];
    const planners: NativePlanMode[] = [];
    for (const agent of roots) {
      assert.equal((await presets.resolve(presets.composedPreset(agent.ctx))).broken, undefined);
      const tools = presets.serviceFor(agent, "tools") ?? agent.ctx.get("tools")!;
      const names = tools.schemas(agent).map((schema) => schema.name);
      assert.ok(names.includes("ask_user_question"));
      assert.ok(names.includes("exit_plan_mode"));
      assert.equal(names.includes("todo_write"), presets.composedPreset(agent.ctx) !== "dsmm-planner");
      assert.equal(names.includes("compact"), false, "/compact is a human command, not a model tool");
      for (const name of ["plan", "compact"]) assert.equal(commands.list(agent).filter((command) => command.name === name).length, 1);
      assert.deepEqual((await commands.execute(agent, "/compact", [], new AbortController().signal))?.result, { kind: "success", text: "No compactable history yet." });
      assert.equal(agent.session.snapshotEvents().filter((event) => event.type === "command/run" && event.data.name === "compact").length, 1);
      const pruner = presets.serviceFor(agent, "toolResultPruner") as NativePruner | undefined;
      assert.ok(pruner);
      assert.deepEqual(pruner.config, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 });
      assert.equal(pruner.pruneContent([{ type: "text", text: "x".repeat(8192) }]), null);
      const pruned = pruner.pruneContent([{ type: "text", text: "H".repeat(4096) + "M".repeat(4096) + "T".repeat(1024) }])!;
      assert.equal(pruned[0].text, "H".repeat(4096) + "\n\n[... tool result middle pruned ...]\n\n" + "T".repeat(1024));
      compactions.push(presets.serviceFor(agent, "compaction"));
      planners.push(presets.serviceFor(agent, "planMode") as NativePlanMode);
    }
    assert.ok(compactions.every(Boolean));
    const implementation = (service: object) => Reflect.get(service, symbols.original) ?? service;
    assert.equal(new Set(compactions.map((service) => implementation(service as object))).size, 1, "one dispatcher preset realm, shared by both roots without leaking to the Host");
    assert.equal(new Set(planners.map(implementation)).size, 1);
    assert.equal(f.ctx.get("compaction"), undefined, "no compaction service leaks to the Host realm");
    assert.equal(f.ctx.get("planMode"), undefined, "no plan service leaks to the Host realm");
    const [first, second] = roots;
    const todos = [
      { content: "[preset] [inspect] to [scope defaults] - expect [native rows]", status: "in_progress" },
      { content: "[preset] [verify] to [retain authority] - expect [no mutation]", status: "in_progress" }
    ];
    const tools = presets.serviceFor(first, "tools") ?? first.ctx.get("tools")!;
    const result = await tools.execute({ agent: first, name: "todo_write", arguments: { todos }, callId: ToolCallId("native-default-todo"), signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.deepEqual(first.session.snapshotEvents().filter((event) => event.type === "todo/write").at(-1)?.data.todos, todos);
    assert.equal(second.session.snapshotEvents().some((event) => event.type === "todo/write"), false, "shared preset never shares the session's todo list");
    await commands.execute(first, "/plan", [], new AbortController().signal);
    assert.equal(planners[0].get(first).active, true);
    assert.equal(planners[1].get(second).active, false);
    assert.equal(f.adapter.calls.length, 0, "human commands/pruning/todo do not invoke an LLM");
    const planner = await f.createAuxiliary("dsmm-planner", undefined, "one-shot", first);
    try {
      const plannerTools = presets.serviceFor(planner, "tools") ?? planner.ctx.get("tools")!;
      const sentinel = join(f.profileDir, "planner-denied-sentinel");
      const denied = await plannerTools.execute({ agent: planner, name: "write", arguments: { file_path: sentinel, content: "must not execute" }, callId: ToolCallId("native-default-planner-denied"), signal: new AbortController().signal });
      assert.equal(denied.isError, true);
      assert.equal(existsSync(sentinel), false);
    } finally { await f.releaseAuxiliary(planner); }
    const quick = await f.createAuxiliary("dsmm-quick", undefined, "one-shot", first);
    try {
      assert.equal(presets.composedPreset(quick.ctx), presets.composedPreset(first.ctx), "a delegation child shares its parent's standing composition");
      assert.notEqual(presets.serviceFor(quick, "compaction"), undefined, "the shared standing composition serves every delegated child alike");
      const path = join(f.profileDir, "quick-write-proof");
      const written = await quick.ctx.get("tools")!.execute({ agent: quick, name: "write", arguments: { file_path: path, content: "QUICK_WRITE_PROOF" }, callId: ToolCallId("native-default-quick-write"), signal: new AbortController().signal });
      assert.equal(written.isError, false, JSON.stringify(written));
      assert.equal(readFileSync(path, "utf8"), "QUICK_WRITE_PROOF");
      await runFixtureTurn(quick);
      assert.equal(f.adapter.calls.length, 1, "only the explicitly invoked local mock child turn calls the adapter");
    } finally { await f.releaseAuxiliary(quick); }
  } finally { await f.dispose(); }
});

test("globally disabled DW module adds no role presets or standard capability groups", async () => {
  const f = await nativeRoutingFixture({}, { nativePresets: true, spawn: false, async beforeDsmm(ctx) {
    const profile = ctx.get("profileContext") as { home: string };
    const directory = join(profile.home, "plugins", "dsmm");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "config.json"), JSON.stringify({ modules: { deepwork: { enabled: false } } }), { flag: "wx" });
  } });
  try {
    assert.deepEqual((await f.ctx.get("agentPresets")!.list()).map((preset) => preset.id), ["standard"]);
    const agent = await f.create({ agentPreset: "standard" });
    const names = f.tools.schemas(agent).map((schema) => schema.name);
    for (const name of ["todo_write", "ask_user_question", "exit_plan_mode"]) assert.equal(names.includes(name), false);
    assert.equal((f.ctx.get("commands") as NativeCommands).list(agent).some((command) => command.name === "compact" || command.name === "plan"), false);
    assert.equal(f.adapter.calls.length, 0);
  } finally { await f.dispose(); }
});
