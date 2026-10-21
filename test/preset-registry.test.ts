import assert from "node:assert/strict";
import { test } from "node:test";
import { registerRolePresets } from "../lib/preset-registry.js";
import { DSMM_ROLES } from "../lib/roles.js";
import type { RolePluginRow } from "../lib/roles.js";
import { DEFAULT_DSMM_SETTINGS, isRootRoleEnabled, resolveConfig } from "../lib/settings.js";
import type { DshContext } from "../lib/dsh-types.js";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { nativeRoutingFixture, headerRoutes, runFixtureTurn } from "./native-routing-fixture.ts";

test("native DSH registration exposes only selectable compositions while delegated children keep role behavior", async () => {
  const definitions: Array<{ id: string; name: string; plugins: RolePluginRow[] }> = [];
  const registry = {
    async register(definition: typeof definitions[number]) {
      definitions.push(definition);
      return async () => {};
    },
    composedPreset() { return undefined; }
  };
  let installer: ((ctx: DshContext) => unknown) | undefined;
  const root: DshContext = {
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ["agentPresets"]);
      installer = callback;
    }
  };
  registerRolePresets(root, () => DEFAULT_DSMM_SETTINGS);
  assert.ok(installer);
  await installer({ get: (name) => (name === "agentPresets" ? registry : name === "agents" ? { list: () => [], get: () => undefined } : { guard: () => () => {} }) as never, on() {} });

  const enabledDefinitions = DSMM_ROLES.filter((role) => isRootRoleEnabled(DEFAULT_DSMM_SETTINGS, role.id));
  assert.deepEqual(definitions.map((item) => item.id), enabledDefinitions.map((role) => role.id));
  assert.deepEqual(definitions.map((item) => item.name), enabledDefinitions.map((role) => role.name));
  assert.equal(enabledDefinitions.length, 1);
  const orchestrator = definitions.find((item) => item.id === "dsmm-orchestrator");
  assert.ok(orchestrator);
  assert.equal(orchestrator.plugins.some((item) => item.name === "@dsmm/dsmm/permission-fs"), true);
  assert.equal("roots" in orchestrator, false);
  const f = await nativeRoutingFixture();
  try {
    // Delegation roles are not registered presets, so forcing one as a root
    // fails closed at the native registry before any admission runs.
    await assert.rejects(f.create({ agentPreset: "dsmm-reviewer" }), /not-found|Unknown agent preset|not eligible.*root/iu);
    const root = await f.create({ agentPreset: "dsmm-orchestrator" });
    const enabled = DSMM_ROLES.filter(role => role.id !== "dsmm-orchestrator" && DEFAULT_DSMM_SETTINGS.roles[role.id]);
    const schemas = root.ctx.tools.schemas(root).filter(row => row.name.startsWith("dsmm_"));
    assert.deepEqual(schemas.map(row => row.name).sort(), [
      ...enabled.filter(role => role.kind === "role").map(role => role.id.replace(/-/gu, "_")), "dsmm_category"
    ].sort());
    const category = schemas.find(row => row.name === "dsmm_category")!;
    assert.deepEqual((category.parameters as { properties: { category: { enum: string[] } } }).properties.category.enum,
      enabled.filter(role => role.kind === "category").map(role => role.id));
    for (const schema of schemas) {
      const parameters = schema.parameters as { required: string[]; properties: Record<string, unknown> };
      assert.ok(parameters.required.includes("description") && parameters.required.includes("prompt"));
      assert.equal(Object.hasOwn(parameters.properties, "route"), false);
      assert.equal(Object.hasOwn(parameters.properties, "run_in_background"), false);
    }
    const child = await f.createAuxiliary("dsmm-plan-critic", undefined, "one-shot", root);
    try {
      const names = child.ctx.tools.schemas(child).map(schema => schema.name);
      assert.ok(names.includes("read") && names.includes("dsmm_code_search"));
      assert.equal((await child.ctx.tools.execute({ agent: child, name: "write", arguments: {}, callId: ToolCallId("registry-readonly"), signal: new AbortController().signal })).isError, true);
      await runFixtureTurn(child);
    } finally { await f.releaseAuxiliary(child); }
  } finally { await f.dispose(); }
});

test("only the dispatcher registers as a selectable preset while delegation targets need none", async () => {
  const definitions: Array<{ id: string; plugins?: Array<{ config?: { toolName?: string } }> }> = [];
  let installer: ((ctx: DshContext) => unknown) | undefined;
  const settings = resolveConfig({
    roles: { "dsmm-orchestrator": true, "dsmm-planner": true, "dsmm-builder": true, "dsmm-oracle": false }
  });
  registerRolePresets({ inject(_deps, callback) { installer = callback; } }, () => settings);
  assert.ok(installer);
  await installer({
    get: (name) => (name === "agentPresets" ? {
      async register(definition: { id: string; plugins?: Array<{ config?: { toolName?: string } }> }) { definitions.push(definition); return async () => {}; },
      composedPreset() { return undefined; }
    } : name === "agents" ? { list: () => [], get: () => undefined } : undefined) as never,
    on() {}
  });
  // Delegation targets share their parent's standing composition instead of
  // owning registered presets, so the roster stays selectable-only.
  assert.deepEqual(definitions.map((definition) => definition.id), ["dsmm-orchestrator"]);
  // A disabled role contributes no callable tool row to the standing composition.
  const orchestrator = definitions[0];
  assert.equal(orchestrator.plugins?.some((item) => !Array.isArray(item.config) && (item.config?.toolName === "dsmm_builder" || item.config?.toolName === "dsmm_oracle")), false);
});

test("read-only restriction follows native blank preset switches without sticking to a write role", async () => {
  const events = new Map<string, (...args: any[]) => unknown>();
  let installer: ((ctx: DshContext) => unknown) | undefined;
  let selected: string = "dsmm-builder";
  const registry = {
    async register() { return async () => {}; },
    composedPreset() { return selected; }
  };
  const filters: unknown[] = [];
  let active = 0;
  const agent = { ctx: { tools: {
    get(name: string) { return ["write", "edit"].includes(name) ? {} : undefined; },
    restrict(filter: unknown) { filters.push(filter); active++; return () => { active--; }; }
  } } };
  registerRolePresets({ inject(_deps, callback) { installer = callback; } }, () => DEFAULT_DSMM_SETTINGS);
  assert.ok(installer);
  await installer({
    get: (name) => (name === "agentPresets" ? registry : name === "agents" ? { list: () => [agent], get: () => agent } : undefined) as never,
    on(event, callback, options) {
      assert.deepEqual(options, event === "tools/pre-execute" ? { global: true, prepend: true } : { global: true });
      events.set(event, callback);
    }
  });
  assert.deepEqual([...events.keys()].sort(), ["agent-preset/selected", "agent/created", "agent/disposed", "tools/change", "tools/pre-execute"]);
  events.get("agent/created")?.({ agent });
  assert.equal(active, 0);
  selected = "dsmm-plan-critic";
  events.get("tools/change")?.();
  assert.deepEqual(filters, [{ deny: ["write", "edit"] }]);
  assert.equal(active, 1);
  const preExecute = events.get("tools/pre-execute") as (execution: { name: string; agent: typeof agent }, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>;
  const allowed = async () => ({ kind: "allow" });
  assert.equal((await preExecute({ name: "write", agent }, allowed)).kind, "deny");
  assert.equal((await preExecute({ name: "dsmm_builder", agent }, allowed)).kind, "deny");
  assert.equal((await preExecute({ name: "read", agent }, allowed)).kind, "allow");
  events.get("agent-preset/selected")?.("session-id");
  assert.equal(active, 1, "duplicate signals cannot stack restrictions");
  selected = "dsmm-builder";
  events.get("tools/change")?.();
  assert.equal(active, 0, "returning to builder lifts the prior read-only mask");
  assert.equal((await preExecute({ name: "write", agent }, allowed)).kind, "allow");
  selected = "dsmm-reviewer";
  agent.ctx = {} as typeof agent.ctx;
  assert.throws(() => events.get("tools/change")?.());
  events.get("agent/disposed")?.({ agent });
});

test("native preset child inventory is profile-invariant and retains deployment disablement", async () => {
  const primary = { provider: "fixture", model: "review-primary", reasoningEffort: "max" };
  const settings = resolveConfig({ roles: { "dsmm-builder": false }, roleRouting: {
    "dsmm-reviewer": { primary }, "dsmm-builder": { primary: { provider: "fixture", model: "disabled-policy" } }
  } });
  const definitions: Array<{ id: string; plugins: RolePluginRow[] }> = [];
  let install: ((ctx: DshContext) => unknown) | undefined;
  registerRolePresets({ inject(_deps, callback) { install = callback; } }, () => settings);
  assert.ok(install);
  await install({ get: (name) => (name === "agentPresets" ? {
    async register(definition: typeof definitions[number]) { definitions.push(definition); return async () => {}; },
    composedPreset() { return undefined; }
  } : name === "agents" ? { list: () => [] } : undefined) as never, on() {} });
  assert.equal(definitions.some((definition) => definition.id === "dsmm-builder"), false);
  for (const toolTopology of ["per-role", "parameterized"] as const) {
    const f = await nativeRoutingFixture({ roles: { "dsmm-builder": false, "dsmm-oracle": false },
      subagents: { toolTopology }, roleRouting: settings.roleRouting });
    try {
      const root = await f.create({ agentPreset: "dsmm-orchestrator" });
      const tools = root.ctx.tools;
      const schemas = tools.schemas(root);
      if (toolTopology === "per-role") {
        assert.ok(tools.get("dsmm_reviewer", root));
        assert.equal(tools.get("dsmm_builder", root), undefined);
        assert.equal(tools.get("dsmm_oracle", root), undefined);
      } else {
        const schema = schemas.find(row => row.name === "dsmm_role")!;
        const targets = (schema.parameters as { properties: { role: { enum: string[] } } }).properties.role.enum;
        assert.ok(targets.includes("dsmm-reviewer"));
        assert.equal(targets.includes("dsmm-builder") || targets.includes("dsmm-oracle"), false);
      }
      const name = toolTopology === "per-role" ? "dsmm_reviewer" : "dsmm_role";
      const result = await tools.execute({ agent: root, name, arguments: { description: "Registry route admission", prompt: "Return useful local output",
        ...(toolTopology === "parameterized" ? { role: "dsmm-reviewer" } : {}) }, callId: ToolCallId("registry-review"), signal: new AbortController().signal });
      assert.equal(result.isError, false);
      assert.deepEqual(f.adapter.calls.map(({ provider, model, reasoningEffort }) => ({ provider, model, reasoningEffort })), [primary]);
      assert.deepEqual(headerRoutes(root), [], "child route admission does not modify the native root route");
      for (const role of ["dsmm-builder", "dsmm-oracle"]) {
        await assert.rejects(f.subagents.startActivation({ provider: `dsmm-role-${role.slice(5)}`, label: "Disabled role", delivery: "caller", signal: new AbortController().signal,
          request: { parent: root, prompt: [] } }));
        const denied = await tools.execute({ agent: root, name: toolTopology === "per-role" ? role.replace(/-/gu, "_") : "dsmm_role",
          arguments: { description: "Disabled role", prompt: "No publication", role }, callId: ToolCallId(role), signal: new AbortController().signal });
        assert.equal(denied.isError, true);
      }
      assert.equal(f.adapter.calls.length, 1, "disabled roles cannot dispatch through aliases or providers");
      assert.deepEqual(f.agents.list(), [root]);
    } finally { await f.dispose(); }
  }
});
