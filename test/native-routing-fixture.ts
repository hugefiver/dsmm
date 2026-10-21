import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createRequire, registerHooks } from "node:module";
import { after } from "node:test";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry, installModelSelection } from "@deepseek-ai/dsh-agent";
import type { Agent, AgentHandle, CreateAgentOptions, ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { LlmAdapter, LlmError, LlmRuntime, ReasoningEffortId, ToolCallId, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import type { SubagentStartRequest } from "@deepseek-ai/dsh-subagent";
import * as nativeSpawn from "@deepseek-ai/dsh-subagent-spawn-in-process";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { JobRegistry } from "@deepseek-ai/dsh-jobs";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { AgentPresetRegistry } from "@deepseek-ai/dsh-agent-preset-registry";
import DsmmPlugin from "../lib/index.js";
import { apply } from "../lib/index.js";
import type { DsmmPluginConfig } from "../src/settings.ts";
import type { DshContext } from "../lib/dsh-types.js";
import type { DsmmRoleId } from "../lib/roles.js";
import * as NativeSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { DSMM_ROLES } from "../lib/roles.js";
import { useIsolatedDshEnvironment } from "./dsh-test-environment.ts";

useIsolatedDshEnvironment();

// Host-loaded preset peers use the explicitly supplied full CLI resolver when
// testing a partial source dependency closure. Production resolution is untouched.
if (process.env.DSMM_TEST_DSH_ENTRY !== undefined) {
  const sdk = createRequire(process.env.DSMM_TEST_DSH_ENTRY);
  const presetPeers = ["tool-web", "plan-mode", "compaction-basic", "command-compact", "compaction-tool-result-pruner", "tool-ask-user", "tool-todo"];
  const urls = new Map(presetPeers.map((name) => {
    const specifier = `@deepseek-ai/dsh-${name}`;
    return [specifier, pathToFileURL(sdk.resolve(specifier)).href];
  }));
  // Scoped registries must share the fixture's real Agent/preset scope identity;
  // a second installed copy has its own WeakMap and would register globals.
  urls.set("@deepseek-ai/dsh-scope", pathToFileURL(createRequire(import.meta.url).resolve("@deepseek-ai/dsh-scope")).href);
  const hook = registerHooks({ resolve(specifier, context, next) {
    const url = urls.get(specifier);
    return url === undefined ? next(specifier, context) : { url, shortCircuit: true };
  } });
  after(() => hook.deregister());
}

/** All requests terminate inside this adapter; no credentials, network or shell. */
export class RoutingFixtureAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = [];
  readonly failModels = new Set<string>();
  readonly rateLimitModels = new Set<string>();
  readonly unsupportedMaxModels = new Set<string>();
  readonly unavailableModels = new Set<string>();
  beforeStream?: (options: GenerateOptions) => Promise<void>;
  streamChunks?: (options: GenerateOptions) => AsyncIterable<StreamChunk>;

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (this.unavailableModels.has(model)) throw new LlmError("deterministic native exact model absence", "UNKNOWN_MODEL");
    const efforts = this.unsupportedMaxModels.has(model) ? ["high"] : ["off", "low", "high", "max"];
    return {
      provider, id: model, name: model,
      inputModalities: ["text"],
      reasoning: { efforts: efforts.map((id) => ({ id: ReasoningEffortId(id), name: id })), defaultEffort: ReasoningEffortId("high") }
    };
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    await this.beforeStream?.(options);
    options.signal?.throwIfAborted();
    if (this.streamChunks !== undefined) { yield* this.streamChunks(options); return; }
    if (this.rateLimitModels.has(options.model)) throw new LlmError("deterministic local rate limit", "RATE_LIMIT", { status: 429 });
    if (this.failModels.has(options.model)) throw new LlmError("deterministic local transient fixture", "FIXTURE_TRANSIENT", { status: 503 });
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "fixture complete" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "fixture complete" } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

let fixtureSequence = 0;
const initialAuxiliaryTurns = new WeakMap<Agent, { release(): void; entered: Promise<void> }>();
function holdAuxiliaryTurn(agent: Agent, selection?: ModelSelectionRef): void {
  if (selection !== undefined) installModelSelection(agent.ctx, selection);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const removeStep = agent.ctx.on("agent/pre-step", async (frame, next) => {
    if (frame.agent !== agent) return next();
    frame.signal.throwIfAborted();
    enter();
    frame.signal.addEventListener("abort", release, { once: true });
    try { await held; } finally { frame.signal.removeEventListener("abort", release); removeStep(); }
    return next();
  });
  initialAuxiliaryTurns.set(agent, { release, entered });
}
const require = createRequire(import.meta.url);
const skillSdk = createRequire(require.resolve("@deepseek-ai/dsh-skill-filesystem"));
const { SkillRegistry } = skillSdk("@deepseek-ai/dsh-skill");
const presetSdk = createRequire(require.resolve("@deepseek-ai/dsh-agent-preset-registry"));
const { Loader, Group }: { Loader: new (ctx: Context, config?: { baseUrl?: string }) => Context["loader"]; Group: import("@deepseek-ai/cordis").Plugin } = presetSdk("@deepseek-ai/cordis-plugin-loader");

/** Explicit full CLI resolution is test-only; no production absolute SDK path. */
export async function nativeFixturePlugin(name: string, peer?: string) {
  const sdk = createRequire(process.env.DSMM_TEST_DSH_ENTRY ?? import.meta.url);
  const resolver = peer === undefined ? sdk : createRequire(sdk.resolve(peer));
  return import(pathToFileURL(resolver.resolve(name)).href);
}

export async function nativeRoutingFixture(config: DsmmPluginConfig = {}, options: { headless?: boolean; spawn?: boolean; profileDir?: string; home?: string; nativePresets?: boolean; isolatedPrompt?: boolean; persistence?: boolean;
  adapter?: RoutingFixtureAdapter;
  managedRuntime?: boolean;
  nativePermissionSettings?: boolean;
  nativeControls?: boolean;
  deferPresets?: boolean;
  fixtureTools?: readonly ToolDefinition[];
  nativeFs?: boolean;
  fixtureShells?: boolean;
  nativeJobs?: boolean;
  nativeSubagents?: { maxDepth?: number; maxActiveSubagents?: number };
  beforeDsmm?: (ctx: Context, create: (meta?: CreateAgentOptions["meta"], selection?: ModelSelectionRef, extra?: Partial<CreateAgentOptions>) => Promise<Agent>) => Promise<void>;
} = {}) {
  options = { ...options, nativePresets: options.nativePresets ?? options.spawn !== false };
  const host = new Context();
  const ctx = (options.isolatedPrompt ? host.isolate("systemPrompt") : host).extend({ baseUrl: new URL("../", import.meta.url).href });
  // Filesystem ownership is per Host even when a test deliberately shares profiles.
  const fixtureDir = mkdtempSync(join(tmpdir(), "dsmm-native-routing-"));
  const owner = `native-routing-fixture:${randomUUID()}`;
  const marker = join(fixtureDir, ".run-owner");
  writeFileSync(marker, owner, { flag: "wx" });
  const profileDir = options.profileDir ?? fixtureDir;
  const home = options.home ?? join(profileDir, "dsh-home");
  const withPresetRoot = (input: DsmmPluginConfig): DsmmPluginConfig => ({ ...input,
    presets: { ...input.presets, root: input.presets?.root ?? join(fixtureDir, "agent-presets") }
  });
  config = withPresetRoot(config);
  const removeOwnedFixture = (): void => {
    if (!existsSync(fixtureDir)) return;
    assert.equal(lstatSync(fixtureDir).isSymbolicLink(), false, "fixture root must not be linked");
    assert.equal(readFileSync(marker, "utf8"), owner, "fixture root owner changed");
    rmSync(fixtureDir, { recursive: true, force: true });
  };
  try {
    const permissionHost = options.nativePermissionSettings ? await import("./permission-host-fixture.ts") : undefined;
    const adapter = options.adapter ?? new RoutingFixtureAdapter();
    const managedRuntime = options.managedRuntime ?? options.spawn !== false;
    const fibers = [
      ctx.plugin(AgentRegistry), ctx.plugin(SessionStore), ctx.plugin(SessionProjectionRegistry),
      ctx.plugin(LlmRuntime), ctx.plugin(SystemPrompt, {}), ctx.plugin(ToolRuntime, { mode: "native" }),
      ctx.plugin(SubagentRuntime, options.nativeSubagents ?? {}), ctx.plugin(SkillRegistry, {})
    ];
    await Promise.all(fibers.map((fiber) => fiber.await()));
    if (options.nativeFs || process.env.DSMM_TEST_DSH_ENTRY) {
      const fsLocal = await nativeFixturePlugin("@deepseek-ai/dsh-fs-local");
      await ctx.plugin(fsLocal.default, { cwd: fixtureDir }).await();
    } else {
      const { FileSystem, FsError } = await nativeFixturePlugin("@deepseek-ai/dsh-fs", "@deepseek-ai/dsh-subagent-spawn-in-process");
      class FixtureDirectory extends FileSystem {
        async resolve(path: string, options: { cwd?: string; signal?: AbortSignal } = {}) {
          options.signal?.throwIfAborted(); const target = resolve(options.cwd ?? fixtureDir, path);
          return { targetKey: target, displayPath: target };
        }
        async stat(target: { displayPath: string }) {
          if (!existsSync(target.displayPath)) return undefined;
          const value = lstatSync(target.displayPath);
          return { type: value.isDirectory() ? "directory" : "file", size: value.size, version: String(value.mtimeMs) };
        }
        async readText(target: { displayPath: string }) {
          if (!existsSync(target.displayPath)) throw new FsError("No fixture file", "FS_NOT_FOUND");
          const exact = realpathSync(target.displayPath);
          if (![fixtureDir, profileDir].some(root => exact.startsWith(`${realpathSync(root)}${sep}`))) throw new FsError("Outside fixture storage", "FS_SANDBOX_DENIED");
          return readFileSync(exact, "utf8");
        }
        async *streamText(target: { displayPath: string }) { yield await this.readText(target); }
        fileUrl(target: { displayPath: string }) { return pathToFileURL(target.displayPath).href; }
        contains(parent: { displayPath: string }, child: { displayPath: string }) { return child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath}${sep}`); }
        async lstat(path: string, options: { cwd?: string; signal?: AbortSignal } = {}) { return this.stat(await this.resolve(path, options)); }
        async listDir(target: { displayPath: string }, signal?: AbortSignal) {
          signal?.throwIfAborted();
          const exact = realpathSync(target.displayPath);
          if (![fixtureDir, profileDir].some(root => exact === realpathSync(root) || exact.startsWith(`${realpathSync(root)}${sep}`))) throw new FsError("Outside fixture storage", "FS_SANDBOX_DENIED");
          return readdirSync(exact, { withFileTypes: true }).map(entry => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
            target: { targetKey: join(exact, entry.name), displayPath: join(exact, entry.name) } }));
        }
        processPath(target: { displayPath: string }) { return target.displayPath; }
      }
      await ctx.plugin(FixtureDirectory).await();
    }
    const directory = await nativeFixturePlugin("@deepseek-ai/dsh-working-directory", "@deepseek-ai/dsh-subagent-spawn-in-process");
    await ctx.plugin(directory.default, { defaultDirectory: fixtureDir }).await();
    await Promise.all(fibers.map((fiber) => fiber.await()));
    if (managedRuntime) {
      const { SessionQueryEngine } = await nativeFixturePlugin("@deepseek-ai/dsh-session-query", "@deepseek-ai/dsh-subagent-spawn-in-process");
      class ExactQuery extends SessionQueryEngine {
        async searchSessions(): Promise<never> { throw new Error("routing fixture does not offer full-text search"); }
        async searchEvents(): Promise<never> { throw new Error("routing fixture does not offer full-text search"); }
      }
      await ctx.plugin(ExactQuery).await();
    }
    if (options.persistence ?? options.spawn !== false) {
      await ctx.plugin(NativeSessionPersistence, { root: join(fixtureDir, "sessions"), compression: "none" }).await();
    }
    if (options.nativeJobs) {
      const jobs = await nativeFixturePlugin("@deepseek-ai/dsh-jobs-local");
      const jobTools = await nativeFixturePlugin("@deepseek-ai/dsh-tool-jobs");
      await ctx.plugin(jobs.default, {}).await();
      await ctx.plugin(jobTools, {}).await();
    }
    const llm = ctx.get("llm");
    const tools = ctx.get("tools");
    assert.ok(llm && tools);
    llm.registerAdapter(["fixture", "deepseek-official"], adapter);
    if (options.nativeFs) {
      const observed = await nativeFixturePlugin("@deepseek-ai/dsh-fs-observation-policy");
      const fsTools = await nativeFixturePlugin("@deepseek-ai/dsh-tool-fs");
      await ctx.plugin(observed).await();
      await ctx.plugin(fsTools, {}).await();
    }
    for (const name of ["read", "glob", "grep", "write", "edit", "bash", "pwsh", "shell"].filter((name) => (!options.nativeFs || !["read", "write", "edit"].includes(name))
      && (options.fixtureShells !== false || !["bash", "pwsh"].includes(name))
      && !options.fixtureTools?.some(definition => definition.name === name))) {
      tools.register({
        name, description: `Local native routing fixture ${name}; never touches disk`, parameters: {},
        output: { schema: { type: "string" }, render: () => [{ type: "text", text: name }] },
        async execute() { return name; }
      });
    }
    for (const definition of options.fixtureTools ?? []) tools.register(definition);
    ctx.provide("profileContext", { ...(permissionHost ? permissionHost.permissionHostProfile(profileDir, home, config)
      : { home, dir: profileDir, installAnchor: options.nativeControls ? require.resolve("@deepseek-ai/dsh-tool-subagent-control") : process.env.DSMM_TEST_DSH_ENTRY }),
      baseUrl: new URL("../", import.meta.url).href, startedBundles: options.headless ? ["@deepseek-ai/dsh-headless"] : [] });
    let loader: Context["loader"] | undefined;
    const mountPresets = async () => {
      assert.ok(loader);
      await loader.create({ name: "cordis:parity-presets", config: { default: "standard" } });
      await loader.await();
      const presets = ctx.get("agentPresets")!;
      await presets.register({ id: "standard", name: "Ordinary", description: "Native parity fixture", plugins: [] });
      if (config.roles?.["dsmm-planner"] === false) {
        await presets.register({ id: "dsmm-planner", name: "DW Planner", description: "Native persona/restriction fixture", plugins: [{ name: "cordis:parity-persona", config: { prefix: "ROLE_PERSONA_SENTINEL" } }] });
      }
    };
    if (options.nativePresets) {
      const loaderFiber = ctx.plugin(Loader, { baseUrl: new URL("../", import.meta.url).href });
      await loaderFiber.await();
      loader = ctx.get("loader")!;
      loader.builtins.group = { default: Group };
      loader.builtins["parity-presets"] = { default: AgentPresetRegistry };
      loader.builtins["parity-persona"] = require("@deepseek-ai/dsh-persona");
      loader.builtins["parity-dsmm"] = { default: DsmmPlugin };
      if (!options.deferPresets) await mountPresets();
    }
    const loopFiber = ctx.plugin(AgentLoop, {});
    await loopFiber.await();
    const spawnFiber = options.spawn === false ? undefined : ctx.plugin(nativeSpawn, { providerName: "spawn" });
    await spawnFiber?.await();
    const agents = ctx.get("agents");
    const subagents = ctx.get("subagents");
    assert.ok(agents && subagents);
    const handles: AgentHandle[] = [];
    const auxiliaryRuns = new Map<Agent, { dispose(): void | Promise<void>; parent: Agent }>();
    const create = async (meta: CreateAgentOptions["meta"] = {}, selection?: ModelSelectionRef, extra: Partial<CreateAgentOptions> = {}): Promise<Agent> => {
      const handle = await agents.create({
        sessionId: SessionId(`dsmm-routing-fixture-${++fixtureSequence}`),
        meta: { cwd: fixtureDir, ...meta }, agentOptions: { provider: "fixture", model: "native-default", reasoningEffort: ReasoningEffortId("low") },
        ...extra,
        ...(options.nativePresets || selection ? { async setup(agentCtx: Context, agent: Agent) {
          if (options.nativePresets) await ctx.get("agentPresets")!.mount(agentCtx, meta?.agentPreset);
          if (selection) installModelSelection(agentCtx, selection);
          return extra.setup?.(agentCtx, agent);
        } } : {})
      });
      handles.push(handle);
      return handle.agent;
    };
    await options.beforeDsmm?.(ctx, create);
    if (options.nativePresets) {
      const denied = async (): Promise<never> => { throw new Error("Routing fixture forbids external I/O"); };
      if (ctx.get("web") === undefined) ctx.provide("web", { search: denied, fetch: denied });
      if (ctx.get("subprocess") === undefined) ctx.provide("subprocess", { spawn: denied });
      if (ctx.get("shell") === undefined) ctx.provide("shell", { execute: denied });
      if (ctx.get("shellEnv") === undefined) ctx.provide("shellEnv", { resolve: denied });
      if (ctx.get("jobs") === undefined) {
        class InertJobs extends JobRegistry {
          events = { subscribe: () => () => {} };
          start(): never { throw new Error("Routing fixture has no jobs backend"); }
          list() { return []; }
          get(): never { throw new Error("No fixture job"); }
          read(): never { throw new Error("No fixture job"); }
          readAt(): never { throw new Error("No fixture job"); }
          wait(): never { throw new Error("No fixture job"); }
          kill(): never { throw new Error("No fixture job"); }
          remove(): never { throw new Error("No fixture job"); }
          attachController() { return () => {}; }
        }
        await ctx.plugin(InertJobs).await();
      }
      // Standard preset capabilities consume these real Host services. They are
      // not role rows, and none of their adapters may perform external work here.
      for (const [service, plugin, peer] of [
        ["commands", "dsh-commands", "dsh-command-compact"],
        ["tokenMeter", "dsh-token-meter", "dsh-compaction-tool-result-pruner"],
        ["userQuestions", "dsh-user-questions", "dsh-tool-ask-user"]
      ]) {
        if (ctx.get(service) !== undefined) continue;
        const module = await nativeFixturePlugin(`@deepseek-ai/${plugin}`, `@deepseek-ai/${peer}`);
        await ctx.plugin(module.default, {}).await();
      }
    }
    const dsmmEntryId = options.nativePermissionSettings || loader === undefined ? undefined : await loader.create({ name: "cordis:parity-dsmm", config });
    await loader?.await();
    const dsmmFiber = permissionHost ? await permissionHost.mountPermissionHostCore(ctx, DsmmPlugin) : dsmmEntryId === undefined ? ctx.plugin({
      name: "dsmm-native-routing-fixture",
      inject: [...DsmmPlugin.inject],
      apply(ready: Context) { return apply(ready as unknown as DshContext, config); }
    }) : loader!.resolve(dsmmEntryId).fiber!;
    await dsmmFiber.await();
    for (const runtime of ctx.registry.values()) {
      if (runtime.callback.name !== "installProfiles") continue;
      for (const fiber of runtime.fibers) {
        let parent = fiber.parent.fiber;
        while (parent.uid !== 0 && parent.uid !== dsmmFiber.uid) parent = parent.parent.fiber;
        if (parent.uid === dsmmFiber.uid) await fiber.await();
      }
    }
    return {
      ctx, host, adapter, agents, subagents, dsmmFiber, spawnFiber, tools, profileDir, home, dsmmEntryId, mountPresets,
      async reloadDeployment(next: DsmmPluginConfig): Promise<void> {
        assert.ok(loader && dsmmEntryId);
        await loader.update(dsmmEntryId, { config: withPresetRoot(next) }); await loader.await();
      },
      async saveDeployment(next: DsmmPluginConfig): Promise<void> {
        assert.ok(loader && dsmmEntryId);
        await loader.resolve(dsmmEntryId).update({ config: withPresetRoot(next) }); await loader.await();
      },
      deploymentConfig(): unknown { return loader?.resolve(dsmmEntryId!).fiber?.config; },
      create,
      async disposeAgent(agent: Agent): Promise<void> {
        const handle = handles.find((candidate) => candidate.agent === agent);
        assert.ok(handle, "only the exact fixture-owned Agent may be disposed");
        await handle.dispose();
      },
      /** A real native provider owns publication, capture and the initial queued turn. */
      async createAuxiliary(role: DsmmRoleId = "dsmm-reviewer", selection?: ModelSelectionRef, mode: "one-shot" | "continuable" = "one-shot", existingParent?: Agent,
        request: Partial<Pick<SubagentStartRequest, "agentOptions" | "prompt">> = {}): Promise<Agent> {
        if (mode === "continuable" && ctx.get("sessionPersistence") === undefined) {
          await ctx.plugin(NativeSessionPersistence, { root: join(fixtureDir, "auxiliary-sessions"), compression: "none" }).await();
        }
        const parent = existingParent ?? await create({ agentPreset: "dsmm-orchestrator" }, selection,
          selection?.current === undefined ? {} : { agentOptions: { ...selection.current } });
        let publish!: (agent: Agent) => void;
        const published = new Promise<Agent>(resolve => { publish = resolve; });
        const remove = ctx.on("agent/created", ({ agent }) => {
          if (!agents.isOwnedBy(agent.id, parent)) return;
          holdAuxiliaryTurn(agent, selection);
          publish(agent);
        }, { global: true });
        try {
          const category = DSMM_ROLES.find(row => row.id === role)!.kind === "category";
          const merged = parent.ctx.tools.get("dsmm_role", parent) !== undefined;
          const name = category ? "dsmm_category" : merged ? "dsmm_role" : role.replaceAll("-", "_");
          const prompt = request.prompt?.map(block => { assert.ok(block.type === "text"); return block.text; }).join("\n") ?? "Complete this local fixture";
          const started = parent.ctx.tools.execute({ agent: parent, name, callId: ToolCallId(randomUUID()), signal: new AbortController().signal,
            arguments: { description: `Native routing ${role}`, prompt, ...(category ? { category: role } : merged ? { role } : {}),
              ...(request.agentOptions === undefined ? {} : { route: request.agentOptions }) } });
          const child = await Promise.race([published, started.then(result => { throw new Error(`Child was not created: ${JSON.stringify(result)}`); })]);
          assert.ok(child && initialAuxiliaryTurns.has(child));
          auxiliaryRuns.set(child, { async dispose() {
            const draining = agents.get(child.id) === child ? subagents.drainChildren(parent, [child.id]) : undefined;
            initialAuxiliaryTurns.get(child)?.release();
            initialAuxiliaryTurns.delete(child);
            await draining; await started;
          }, parent });
          assert.equal(agents.isOwnedBy(child.id, parent), true);
          await Promise.race([initialAuxiliaryTurns.get(child)!.entered, started.then(result => { throw new Error(`Initial child turn did not start: ${JSON.stringify(result)}`); })]);
          return child;
        } finally { remove(); }
      },
      async resumeAuxiliary(agent: Agent, selection?: ModelSelectionRef): Promise<Agent> {
        const owned = auxiliaryRuns.get(agent);
        assert.ok(owned, "cold resume requires the exact fixture-owned native run");
        await owned.dispose();
        auxiliaryRuns.delete(agent);
        await owned.parent.whenIdle();
        await ctx.sessionPersistence.flush();
        const remove = ctx.on("agent/created", ({ agent: resumed }) => { if (resumed.id === agent.id) holdAuxiliaryTurn(resumed, selection); }, { global: true });
        try {
          await subagents.sendMessage(owned.parent, agent.id, [{ type: "text", text: "Complete this local fixture" }], { signal: new AbortController().signal });
          const resumed = agents.get(agent.id)!;
          assert.ok(resumed && resumed !== agent);
          auxiliaryRuns.set(resumed, { dispose: () => agents.get(resumed.id) === resumed ? subagents.drainChildren(owned.parent, [resumed.id]) : Promise.resolve(), parent: owned.parent });
          return resumed;
        } finally { remove(); }
      },
      async releaseAuxiliary(agent: Agent): Promise<void> {
        const owned = auxiliaryRuns.get(agent);
        assert.ok(owned, "release requires the exact fixture-owned native run");
        await owned.dispose();
        auxiliaryRuns.delete(agent);
      },
      async dispose() {
        const errors: unknown[] = [];
        for (const owned of [...auxiliaryRuns.values()].reverse()) try { await owned.dispose(); } catch (error) { errors.push(error); }
        for (const handle of [...handles].reverse()) try { await handle.dispose(); } catch (error) { errors.push(error); }
        try { await ctx.fiber.dispose(); } catch (error) { errors.push(error); }
        finally { removeOwnedFixture(); }
        if (errors.length) throw new AggregateError(errors, "Native routing fixture cleanup failed");
      }
    };
  } catch (error) {
    await ctx.fiber.dispose();
    removeOwnedFixture();
    throw error;
  }
}

export async function runFixtureTurn(agent: Agent): Promise<void> {
  const initial = initialAuxiliaryTurns.get(agent);
  if (initial !== undefined) {
    initialAuxiliaryTurns.delete(agent);
    initial.release();
    await agent.whenIdle();
    return;
  }
  agent.followup(createUserMessage({ content: [{ type: "text", text: "Complete this local fixture" }], source: { kind: "user" } }));
  await agent.whenIdle();
}

/** Observed route transitions, excluding native header changes that retain the same route. */
export function headerRoutes(agent: Agent): Array<{ provider: string; model: string; reasoningEffort?: string }> {
  return agent.session.snapshotEvents().flatMap((event) => event.type === "request/header" ? [{
    provider: event.data.header.config.provider, model: event.data.header.config.model,
    ...(event.data.header.config.reasoningEffort === undefined ? {} : { reasoningEffort: event.data.header.config.reasoningEffort })
  }] : []).filter((route, index, routes) => index === 0 || route.provider !== routes[index - 1].provider
    || route.model !== routes[index - 1].model || route.reasoningEffort !== routes[index - 1].reasoningEffort);
}
