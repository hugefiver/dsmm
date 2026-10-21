import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DSMM_ROLES, allowedRoleChildren, renderAgentCordis, renderPresetMetadata } from "../lib/roles.js";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { DsmmProfileRuntime } from "../lib/profile-runtime.js";
import type { DshAgent } from "../lib/dsh-types.js";
import { headerRoutes, nativeRoutingFixture } from "./native-routing-fixture.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("static agent presets exist for every enabled role", () => {
  for (const role of DSMM_ROLES) {
    if (!role.enabledByDefault) continue;

    const presetDirectory = join(packageRoot, "agent-presets", role.id);

    assert.equal(existsSync(presetDirectory), true, `${role.id} preset directory exists`);
    assert.equal(existsSync(join(presetDirectory, "agent.cordis.yml")), true, `${role.id} agent.cordis.yml exists`);
    assert.equal(existsSync(join(presetDirectory, "preset.yml")), true, `${role.id} preset.yml exists`);
  }
});

test("static agent preset files exactly match role render helpers", () => {
  for (const role of DSMM_ROLES) {
    const presetDirectory = join(packageRoot, "agent-presets", role.id);

    assert.equal(readFileSync(join(presetDirectory, "agent.cordis.yml"), "utf8"), renderAgentCordis(role));
    assert.equal(readFileSync(join(presetDirectory, "preset.yml"), "utf8"), renderPresetMetadata(role));
  }
});

for (const toolTopology of ["per-role", "parameterized"] as const) {
  test(`native preset delegation schemas and delivery follow admitted ${toolTopology} topology, routes and role ceilings`, async () => {
    const primary = { provider: "fixture", model: "preset-review", reasoningEffort: "max" };
    const f = await nativeRoutingFixture({ subagents: { toolTopology }, roles: { "dsmm-oracle": false },
      skills: { "writing-plans": false }, roleRouting: { "dsmm-reviewer": { primary } } }, {
      nativePresets: true, nativeFs: true, nativeJobs: true, async beforeDsmm(ctx) {
        const denied = async (): Promise<never> => { throw new Error("fixture forbids external web/shell/subprocess work"); };
        ctx.provide("web", { search: denied, fetch: denied });
        ctx.provide("subprocess", { spawn: denied });
        ctx.provide("shell", { execute: denied });
        ctx.provide("shellEnv", { resolve: denied });
      }
    });
    try {
      const root = await f.create({ agentPreset: "dsmm-orchestrator" });
      const runtime = f.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
      const admission = runtime.admission(root as unknown as DshAgent);
      const enabled = allowedRoleChildren("dsmm-orchestrator").filter(id => admission.settings.roles[id]);
      const roles = enabled.filter(id => DSMM_ROLES.find(row => row.id === id)!.kind === "role");
      const categories = enabled.filter(id => DSMM_ROLES.find(row => row.id === id)!.kind === "category");
      const tools = f.ctx.get("agentPresets")!.serviceFor(root, "tools") ?? root.ctx.tools, schemas = tools.schemas(root);
      const expectedNames = [...toolTopology === "per-role" ? roles.map(id => id.replace(/-/gu, "_")) : ["dsmm_role"], "dsmm_category"];
      assert.deepEqual(schemas.filter(row => row.name.startsWith("dsmm_")).map(row => row.name).sort(), expectedNames.sort());
      for (const [name, parameter, targets] of [
        ["dsmm_category", "category", categories],
        ...toolTopology === "parameterized" ? [["dsmm_role", "role", roles] as const] : []
      ] as const) {
        const schema = schemas.find(row => row.name === name)!;
        assert.ok(tools.get(name, root));
        const properties = schema.parameters.properties as Record<string, { enum?: readonly string[] }>;
        assert.deepEqual(properties[parameter].enum, targets);
        assert.equal(Object.hasOwn(properties, "route"), false);
        assert.equal(Object.hasOwn(properties, "run_in_background"), false);
      }
      assert.equal(admission.sources?.["subagents.toolTopology"], "profile");
      assert.equal(admission.sources?.["roleRouting.dsmm-reviewer.primary.model"], "profile");
      const skills = f.ctx.get("agentPresets")!.serviceFor(root, "skills") ?? root.ctx.get("skills")!;
      const lookup = { scope: root, cwd: root.session.header.cwd };
      const skill = await skills.get("debugging", lookup);
      assert.ok(skill);
      assert.equal(skill.provider, "dsmm");
      assert.equal(skill.source, "bundled");
      assert.equal(await skills.get("writing-plans", lookup), undefined);
      const loaded = await tools.execute({ agent: root, name: "skill", arguments: { name: "debugging" },
        callId: ToolCallId(`skill-${toolTopology}`), signal: new AbortController().signal });
      assert.equal(loaded.isError, false);
      assert.deepEqual(loaded.value, { name: skill.name, provider: skill.provider, resourceBase: skill.resourceBase, content: skill.content });
      assert.ok(skill.content.length > 0);
      assert.equal(skill.resourceBase?.kind, "directory");
      if (skill.resourceBase?.kind !== "directory") throw new Error("bundled skill requires its resource directory");
      const resource = await tools.execute({ agent: root, name: "read", arguments: { file_path: join(skill.resourceBase.path, "references/scripts/dap.mjs") },
        callId: ToolCallId(`resource-${toolTopology}`), signal: new AbortController().signal });
      assert.equal(resource.isError, false);
      assert.ok(resource.content.some(block => block.type === "text" && block.text.length > 0));
      const result = await tools.execute({ agent: root, name: toolTopology === "per-role" ? "dsmm_reviewer" : "dsmm_role",
        arguments: { description: "Preset route delivery", prompt: "Return a local result", ...(toolTopology === "parameterized" ? { role: "dsmm-reviewer" } : {}) },
        callId: ToolCallId(`preset-${toolTopology}`), signal: new AbortController().signal });
      assert.equal(result.isError, false);
      assert.ok(result.content.some(block => block.type === "text" && block.text === "fixture complete"));
      assert.deepEqual(f.adapter.calls.map(({ provider, model, reasoningEffort }) => ({ provider, model, reasoningEffort })), [primary]);
      assert.deepEqual(headerRoutes(root), [], "delegation cannot rewrite the root model");
      const denied = await tools.execute({ agent: root, name: toolTopology === "per-role" ? "dsmm_oracle" : "dsmm_role",
        arguments: { description: "Disabled target", prompt: "Do not dispatch", role: "dsmm-oracle" },
        callId: ToolCallId(`disabled-${toolTopology}`), signal: new AbortController().signal });
      assert.equal(denied.isError, true);
      assert.equal(f.subagents.getProvider("dsmm-role-oracle"), undefined);
      assert.equal(f.adapter.calls.length, 1);
      assert.deepEqual(f.agents.list(), [root]);
      const planner = await f.createAuxiliary("dsmm-planner", undefined, "one-shot", root);
      try {
        const plannerTools = f.ctx.get("agentPresets")!.serviceFor(planner, "tools") ?? planner.ctx.tools;
        const sentinel = join(f.profileDir, "planner-denied-sentinel");
        const before = f.adapter.calls.length;
        const write = await plannerTools.execute({ agent: planner, name: "write", arguments: { file_path: sentinel, content: "not permitted" },
          callId: ToolCallId(`planner-write-${toolTopology}`), signal: new AbortController().signal });
        assert.equal(write.isError, true);
        assert.equal(existsSync(sentinel), false);
        assert.equal(f.adapter.calls.length, before, "a denied child write never reaches the model");
      } finally { await f.releaseAuxiliary(planner); }
      await assert.rejects(f.subagents.startActivation({ provider: "dsmm-role-oracle", label: "Disabled oracle", delivery: "caller",
        request: { parent: root, prompt: [] }, signal: new AbortController().signal }), { code: "NO_PROVIDER" });
    } finally { await f.dispose(); }
  });
}

test("optional native default patch does not configure removed directory discovery", () => {
  const patch = readFileSync(join(packageRoot, "patches", "agent-presets-root.example.cordis.patch.yml"), "utf8");
  assert.match(patch, /^- id: agent-presets\r?\n  config:\r?\n    default: dsmm-orchestrator\r?\n?$/mu);
  assert.doesNotMatch(patch, /roots:|includeUserRoot:|trust:|path:/u);
  assert.match(patch, /inspection templates, not discovery inputs/u);
  assert.match(patch, /does not apply this patch or change the deployment default/u);
});
