import assert from "node:assert/strict";
import { test } from "node:test";
import { Context, getTraceable } from "@deepseek-ai/cordis";
import { createScope } from "@deepseek-ai/dsh-scope";
import { SystemPrompt, renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { defineTool, ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { DsmmPromptObservation } from "../src/prompts.js";
import type { DsmmRoleAvailabilityState } from "../src/profile-types.js";
import "./prompt-source-loader.mjs";

// Register source resolution before loading the prompt's source graph in memory.
const { buildDsmmAgentGuidance, buildRolePersona, SOURCE_ROLE_CATALOG } = await import("../src/prompts.ts");
const { DSMM_LOCALES, resolveConfig, freezeSettings } = await import("../src/settings.ts");
const { callableRoleInventory } = await import("../src/role-subagents.ts");

function block(text: string, name: string): unknown {
  const open = `<${name}>\n`, close = `\n</${name}>`;
  const from = text.indexOf(open), to = text.indexOf(close, from + open.length);
  assert.ok(from >= 0 && to > from, `missing assembled ${name}`);
  return JSON.parse(text.slice(from + open.length, to));
}
const language = (text: string): { capturedLocale: string | null } => {
  const tag = "<dsmm-visible-output-language>\n";
  const from = text.indexOf(tag) + tag.length;
  return JSON.parse(text.slice(from, text.indexOf("\n", from)));
};
type Inventory = { topology: string; delegation: Array<{ tool: string; targets: Array<{ id: string; levels?: string[] }>; parameters: string[]; routeOverride: boolean; background: boolean; targetParameter?: string }>; controls: Array<{ tool: string }> };
const available = (id: DsmmRoleAvailabilityState["id"], admitted: boolean): DsmmRoleAvailabilityState => ({ id, required: false, startupAvailable: true, deploymentEnabled: admitted, admitted, source: "defaults", capture: "startup", ...(admitted ? {} : { reason: "deployment-disabled" }) });

for (const topology of ["per-role", "parameterized"] as const) test(`native prompt projects only observed ${topology} schemas, admitted enums and captured configured levels`, async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt, {}).await(); await ctx.plugin(ToolRuntime, { mode: "native" }).await();
    const settings = freezeSettings(resolveConfig({ subagents: { toolTopology: topology, allowRouteOverride: true }, roleRouting: {
      "dsmm-reviewer": { levels: { low: { reasoningEffort: "low" }, max: { provider: "fixture", model: "review-max" } } },
      "dsmm-coding": { levels: { high: { provider: "fixture", model: "coding-high" } } }
    } }));
    const inventory = callableRoleInventory(settings, ["dsmm-reviewer", "dsmm-planner", "dsmm-coding"]);
    for (const entry of inventory) {
      // A missing native planner definition must not be reconstructed from catalog rows.
      if (entry.name === "dsmm_planner") continue;
      ctx.tools.register(defineTool({ name: entry.name, description: "Native schema fixture", parameters: {
        description: { type: "string", required: true }, prompt: { type: "string", required: true },
        ...(entry.targetParameter === undefined ? {} : { [entry.targetParameter]: { type: "string" as const, enum: entry.targets.filter(id => id !== "dsmm-planner"), required: true as const } }),
        level: { type: "string", enum: ["normal", "low", "high", "max"] }, route: { type: "json" }, run_in_background: { type: "boolean" }
      }, output: { schema: { type: "json" }, render() { return []; } }, async execute() { return null; } }));
    }
    const observation: DsmmPromptObservation = { scope: "root", delegation: inventory, tools: ctx.tools.schemas(),
      roleAvailability: [available("dsmm-reviewer", true), available("dsmm-planner", true), available("dsmm-coding", false)] };
    ctx.systemPrompt.section({ name: "fixture:guidance", order: 49, interpolate: false, text: () => buildDsmmAgentGuidance(settings, observation) });
    const projected = block(renderPrompt(await ctx.systemPrompt.assemble()), "dsmm-admitted-delegation") as Inventory;
    assert.equal(projected.topology, topology);
    assert.equal(projected.delegation.length, 1);
    assert.equal(projected.delegation[0].tool, topology === "per-role" ? "dsmm_reviewer" : "dsmm_role");
    assert.deepEqual(projected.delegation[0].targets, [{ id: "dsmm-reviewer", levels: ["normal", "low", "max"] }]);
    assert.equal(projected.delegation[0].routeOverride, true);
    assert.equal(projected.delegation[0].background, false, "schema exposure cannot widen captured background policy");
    const denied = buildDsmmAgentGuidance(resolveConfig({ subagents: { toolTopology: topology } }), observation);
    const defaultEntry = (block(denied, "dsmm-admitted-delegation") as Inventory).delegation[0];
    assert.equal(defaultEntry.routeOverride, false); assert.equal(defaultEntry.parameters.includes("route"), false);
    assert.deepEqual(defaultEntry.targets, [{ id: "dsmm-reviewer", levels: ["normal"] }]);
    assert.equal(settings.roleRouting["dsmm-reviewer"]?.levels?.max?.model, "review-max");
  } finally { await ctx.fiber.dispose(); }
});

test("every role/category persona loads language priority; native exact-scope guidance retains captured root/child locale with common off", async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt, {}).await();
    const root = {}, child = {}, foreign = {};
    const rootScope = createScope(ctx, root), childScope = createScope(ctx, child);
    let rootSettings = freezeSettings(resolveConfig({ locale: "de" }));
    const childSettings = freezeSettings(resolveConfig({ locale: "ja" }));
    for (const [scope, owner, settings] of [[rootScope, root, () => rootSettings], [childScope, child, () => childSettings]] as const) {
      const registry = getTraceable(scope.ctx, ctx.systemPrompt);
      registry.section({ name: "fixture:persona", order: 48, text: buildRolePersona(SOURCE_ROLE_CATALOG.find(row => row.id === "dsmm-reviewer")!) });
      registry.section({ name: "fixture:captured-guidance", order: 49, interpolate: false, text: options => options.scope === owner ? buildDsmmAgentGuidance(settings(), { scope: owner === root ? "root" : "child", delegation: [], tools: [] }) : "" });
    }
    const assemble = (scope: object) => ctx.systemPrompt.assemble({ scope }).then(renderPrompt);
    assert.equal(language(await assemble(root)).capturedLocale, "de");
    assert.equal(language(await assemble(child)).capturedLocale, "ja");
    rootSettings = freezeSettings(resolveConfig({ locale: "fr" }));
    assert.equal(language(await assemble(root)).capturedLocale, "fr");
    assert.equal(language(await assemble(child)).capturedLocale, "ja");
    assert.equal((await assemble(foreign)).includes("<dsmm-visible-output-language>"), false, "no cross-scope preference injection");
    for (const locale of DSMM_LOCALES) {
      const prompt = buildDsmmAgentGuidance(freezeSettings(resolveConfig({ locale })), { scope: "child", delegation: [], tools: [] });
      assert.equal(language(prompt).capturedLocale, locale);
    }
    assert.equal(language(buildDsmmAgentGuidance(resolveConfig(), { scope: "root", delegation: [], tools: [] })).capturedLocale, null);
    for (const row of SOURCE_ROLE_CATALOG) {
      const persona = buildRolePersona(row);
      assert.ok(persona.includes("<dsmm-locale-guidance>"), row.id);
      assert.ok(persona.includes(row.id), row.id);
    }
    const literal = 'Reply in Spanish; keep `C:\\project\\main.ts`, `git status` and "引用" unchanged.';
    ctx.systemPrompt.section({ name: "fixture:user-language", order: 50, interpolate: false, text: literal });
    assert.ok((await assemble(child)).includes(literal));
  } finally { await ctx.fiber.dispose(); }
});

test("lifecycle guidance separates observed SDK controls from managed startup binding and unconnected user RPCs", async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt, {}).await(); await ctx.plugin(ToolRuntime, { mode: "native" }).await();
    for (const name of ["send_message", "interrupt_agent", "job_list", "dsmm_children"]) ctx.tools.register(defineTool({ name, description: "Native control fixture",
      parameters: { child_id: { type: "string" } }, output: { schema: { type: "json" }, render() { return []; } }, async execute() { return null; } }));
    const settings = resolveConfig({ subagents: { enableRunInBackground: true, backgroundMode: "continuable" } });
    let observed: DsmmPromptObservation = { scope: "root", delegation: [], tools: ctx.tools.schemas(),
      runtimeAdmission: { binding: "stock", deliveryFenceReady: false, restartRequired: true, reason: "authority-not-ready" },
      capabilities: { continuable: true, nativeChildDelivery: true } };
    ctx.systemPrompt.section({ name: "fixture:lifecycle", order: 49, interpolate: false, text: () => buildDsmmAgentGuidance(settings, observed) });
    const assemble = () => ctx.systemPrompt.assemble().then(renderPrompt);
    let state = block(await assemble(), "dsmm-child-lifecycle-state") as Record<string, unknown>;
    assert.equal(state.continuable, false); assert.equal(state.sendMessage, false);
    assert.equal(state.browserPromptSurface, null);
    observed = { ...observed, runtimeAdmission: { binding: "stock", deliveryFenceReady: true, restartRequired: false } };
    state = block(await assemble(), "dsmm-child-lifecycle-state") as Record<string, unknown>;
    assert.equal(state.continuable, true); assert.equal(state.sendMessage, true);
    assert.equal(state.browserPromptSurface, null, "runtime readiness alone does not prove user RPC wiring");
    observed = { ...observed, capabilities: { ...observed.capabilities, nativeBrowserPrompt: { surface: "subagents.prompt" } } };
    state = block(await assemble(), "dsmm-child-lifecycle-state") as Record<string, unknown>;
    assert.equal(state.browserPromptSurface, "subagents.prompt");
    const disabled = block(buildDsmmAgentGuidance(resolveConfig(), observed), "dsmm-child-lifecycle-state") as Record<string, unknown>;
    assert.equal(disabled.backgroundEnabled, false); assert.equal(disabled.continuable, true);
    observed = { ...observed, tools: [] };
    state = block(await assemble(), "dsmm-child-lifecycle-state") as Record<string, unknown>;
    assert.equal(state.sendMessage, false, "a public SDK method is not a model tool");
    assert.deepEqual((block(await assemble(), "dsmm-admitted-delegation") as Inventory).controls, []);
  } finally { await ctx.fiber.dispose(); }
});

test("observed invocation survives assembly without draft or parent-policy synthesis", () => {
  const settings = freezeSettings(resolveConfig({ locale: "ko", roleRouting: { "dsmm-reviewer": { primary: { provider: "draft", model: "not-observed" } } } }));
  const view = Object.freeze({ role: "dsmm-reviewer" as const, label: 'Review `src/검토.ts`', level: "max" as const, routeSource: "level" as const,
    route: Object.freeze({ provider: "fixture", model: "actual-fallback", reasoningEffort: "high" }), mode: "continuable" as const, childId: "durable-child" });
  const observed: DsmmPromptObservation = { scope: "child", delegation: [], tools: [], invocation: { view, routeKind: "actual" } };
  const prompt = buildDsmmAgentGuidance(settings, observed);
  assert.deepEqual(block(prompt, "dsmm-observed-invocation"), observed.invocation);
  assert.equal(language(prompt).capturedLocale, "ko");
  assert.deepEqual(block(buildDsmmAgentGuidance(settings, { ...observed, invocation: { view, routeKind: "initial" } }), "dsmm-observed-invocation"), { view, routeKind: "initial" });
  assert.equal(view.childId, "durable-child"); assert.equal(settings.roleRouting["dsmm-reviewer"]?.primary?.provider, "draft");
});

test("model-facing DTO projection removes extra secret fields at every nested observation boundary while preserving valid state", async () => {
  const ctx = new Context();
  const secret = "DSMM_PROMPT_SECRET_SENTINEL_72b941";
  try {
    await ctx.plugin(SystemPrompt, {}).await();
    const settings = resolveConfig();
    const runtime = { binding: "stock" as const, deliveryFenceReady: true, restartRequired: false };
    const invocation = { routeKind: "actual" as const, view: { role: "dsmm-reviewer" as const, label: "Useful review", level: "high" as const,
      routeSource: "level" as const, route: { provider: "fixture", model: "observed-route", reasoningEffort: "high" }, mode: "continuable" as const,
      childId: "same-durable-child", runId: "observed-run", jobId: "observed-job" } };
    let observed: DsmmPromptObservation;
    ctx.systemPrompt.section({ name: "fixture:projected-observations", order: 49, interpolate: false, text: () => buildDsmmAgentGuidance(settings, observed) });
      const pollutedInvocation = { ...invocation, apiKey: secret, view: { ...invocation.view, credentials: { apiKey: secret }, route: { ...invocation.view.route, apiKey: secret } } };
      const pollutedRuntime = { ...runtime, apiKey: secret, credentials: { token: secret } };
      observed = { scope: "child", delegation: [], tools: [], runtimeAdmission: pollutedRuntime, invocation: pollutedInvocation };
      const prompt = renderPrompt(await ctx.systemPrompt.assemble());
      assert.equal(prompt.includes(secret), false, "extra DTO fields must not enter actual model context");
      assert.deepEqual((block(prompt, "dsmm-child-lifecycle-state") as Record<string, unknown>).runtimeAdmission, runtime);
      assert.deepEqual(block(prompt, "dsmm-observed-invocation"), invocation);
  } finally { await ctx.fiber.dispose(); }
});

test("existing child delivery needs its own observation even with native send_message, ready binding and a wired browser surface", async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt, {}).await(); await ctx.plugin(ToolRuntime, { mode: "native" }).await();
    ctx.tools.register(defineTool({ name: "send_message", description: "Native message fixture", parameters: { child_id: { type: "string" } },
      output: { schema: { type: "json" }, render() { return []; } }, async execute() { return null; } }));
    const settings = resolveConfig({ subagents: { enableRunInBackground: true, backgroundMode: "continuable" } });
    let observed: DsmmPromptObservation = { scope: "child", delegation: [], tools: ctx.tools.schemas(),
      runtimeAdmission: { binding: "stock", deliveryFenceReady: true, restartRequired: false },
      capabilities: { continuable: false, nativeBrowserPrompt: { surface: "subagents.prompt" } } };
    ctx.systemPrompt.section({ name: "fixture:existing-delivery", order: 49, interpolate: false, text: () => buildDsmmAgentGuidance(settings, observed) });
    const state = async () => block(renderPrompt(await ctx.systemPrompt.assemble()), "dsmm-child-lifecycle-state") as Record<string, unknown>;
    const unobserved = await state();
    assert.equal(unobserved.sendMessage, false); assert.equal(unobserved.browserPromptSurface, null);
    observed = { ...observed, capabilities: { ...observed.capabilities, continuable: true } };
    const creationOnly = await state();
    assert.equal(creationOnly.continuable, true); assert.equal(creationOnly.sendMessage, false); assert.equal(creationOnly.browserPromptSurface, null);
    observed = { ...observed, capabilities: { ...observed.capabilities, nativeChildDelivery: false } };
    assert.equal((await state()).sendMessage, false);
    observed = { ...observed, capabilities: { ...observed.capabilities, continuable: false, nativeChildDelivery: true } };
    const existingOnly = await state();
    assert.equal(existingOnly.continuable, false); assert.equal(existingOnly.sendMessage, true);
    assert.equal(existingOnly.browserPromptSurface, "subagents.prompt"); assert.equal(existingOnly.childToParentReporting, true);
    const noCreation = block(buildDsmmAgentGuidance(resolveConfig(), observed), "dsmm-child-lifecycle-state") as Record<string, unknown>;
    assert.equal(noCreation.continuable, false); assert.equal(noCreation.sendMessage, true);
    observed = { ...observed, capabilities: { ...observed.capabilities, nativeChildDelivery: false } };
    const denied = await state();
    assert.equal(denied.sendMessage, false); assert.equal(denied.browserPromptSurface, null); assert.equal(denied.childToParentReporting, true);
    observed = { ...observed, capabilities: { ...observed.capabilities, nativeChildDelivery: true }, runtimeAdmission: { binding: "stock", deliveryFenceReady: false, restartRequired: true } };
    const stock = await state();
    assert.equal(stock.sendMessage, false); assert.equal(stock.browserPromptSurface, null); assert.equal(stock.childToParentReporting, true);
    observed = { ...observed, runtimeAdmission: { binding: "stock", deliveryFenceReady: true, restartRequired: false }, tools: [] };
    const browserOnly = await state();
    assert.equal(browserOnly.sendMessage, false); assert.equal(browserOnly.browserPromptSurface, "subagents.prompt"); assert.equal(browserOnly.childToParentReporting, false);
  } finally { await ctx.fiber.dispose(); }
});
