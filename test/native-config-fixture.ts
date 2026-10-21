import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { Fiber } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { LlmRuntime, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import * as nativeSpawn from "@deepseek-ai/dsh-subagent-spawn-in-process";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import DsmmPlugin, { DSMM_ROLE_IDS } from "../lib/index.js";
import { DsmmDeploymentConfig } from "../lib/deployment-config.js";
import type { DsmmPluginConfig, DsmmProfileRuntime } from "../lib/index.js";
import { nativeFixturePlugin, RoutingFixtureAdapter } from "./native-routing-fixture.ts";
import * as ManagedSettings from "../src/managed-settings.ts";

const require = createRequire(import.meta.url);
const presetSdk = createRequire(require.resolve("@deepseek-ai/dsh-agent-preset-registry"));
const settingsSdk = createRequire(presetSdk.resolve("@deepseek-ai/dsh-settings"));
const skillSdk = createRequire(require.resolve("@deepseek-ai/dsh-skill-filesystem"));
const { SkillRegistry } = skillSdk("@deepseek-ai/dsh-skill");
type Entry = ReturnType<Context["loader"]["resolve"]>;
type PathOp = { op: "set"; path: string[]; value: unknown } | { op: "unset"; path: string[] };
interface SettingsDescriptor {
  ns: string;
  revision: number;
  applies: "live";
  value: unknown;
  base?: unknown;
  user?: unknown;
}
interface NativeSettings {
  documentPath: string;
  describe(): SettingsDescriptor[];
  mutate(ns: string, ops: PathOp[], expectedRevision: number): Promise<void>;
}
interface NativeConfigEditor {
  documentPath: string;
  entries(): Entry[];
}
interface NativeConfigProfile {
  ctx: Context;
  adapter: RoutingFixtureAdapter;
  dir: string;
  patchPath: string;
  entry: Entry;
  fiber: Fiber;
  settings: NativeSettings;
  deployment: DsmmDeploymentConfig;
  runtime: DsmmProfileRuntime;
  lifecycle: { partialDisposes: number; updates: number; scopeDisposals: number; agentDisposals: number };
  descriptor(): SettingsDescriptor;
  persistedConfig(): DsmmPluginConfig;
  create(parentAgent?: Agent): Promise<Agent>;
  assertLive(): void;
  dispose(): Promise<void>;
}
const { Loader }: { Loader: new (ctx: Context) => Context["loader"] } = presetSdk("@deepseek-ai/cordis-plugin-loader");
const { SettingsForms }: { SettingsForms: new (ctx: Context) => NativeSettings } = presetSdk("@deepseek-ai/dsh-settings");
const { ConfigEditor }: { ConfigEditor: new (ctx: Context) => NativeConfigEditor } = settingsSdk("@deepseek-ai/dsh-config-editor");
const { mountRootInclude, loadProfileDirectory, readProfilePatches, composeEntries } = presetSdk("@deepseek-ai/dsh-app-boot");

export function nativeConfigRun(options: { managedPermissionSettings?: boolean; managedRuntime?: boolean; stockRuntime?: boolean } = {}): {
  root: string;
  home: string;
  createProfile(name: string, override?: DsmmPluginConfig): Promise<NativeConfigProfile>;
  reopenProfile(name: string): Promise<NativeConfigProfile>;
  dispose(): Promise<void>;
} {
  appendFileSync(join(tmpdir(), "dsmm-c0-journal.jsonl"), `${JSON.stringify({ probe: "native-config-run", prefix: "dsmm-native-config-", time: Date.now() })}\n`);
  const root = mkdtempSync(join(tmpdir(), "dsmm-native-config-"));
  const owner = `native-config:${randomUUID()}`;
  const marker = join(root, ".run-owner");
  const journal = join(root, "journal.jsonl");
  writeFileSync(marker, owner, { flag: "wx" });
  writeFileSync(journal, `${JSON.stringify({ probe: "native-config-run", owner, root })}\n`, { flag: "wx" });
  const home = join(root, "home");
  mkdirSync(home);
  const profiles: Array<{ dispose(): Promise<void> }> = [];

  async function createProfile(name: string, override: DsmmPluginConfig = {}, reopen = false): Promise<NativeConfigProfile> {
    appendFileSync(journal, `${JSON.stringify({ probe: "create-profile", name, home })}\n`);
    const dir = join(root, name);
    if (reopen) assert.equal(readFileSync(join(dir, ".run-owner"), "utf8"), owner);
    else {
      mkdirSync(dir);
      writeFileSync(join(dir, ".run-owner"), owner, { flag: "wx" });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `dsmm-test-${name}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }), { flag: "wx" });
    }
    const basePath = join(dir, "cordis.json");
    const patchPath = join(dir, "cordis.patch.yml");
    if (!reopen) writeFileSync(basePath, "[]\n", { flag: "wx" });
    const baseline = { roles: Object.fromEntries(DSMM_ROLE_IDS.map((id) => [id, false])), presets: { root: join(dir, "agent-presets") } };
    if (!reopen) writeFileSync(patchPath, `${JSON.stringify([
      { insert: [{ id: "dsmm", name: "cordis:fixture-dsmm", config: baseline }] },
      ...(Object.keys(override).length ? [{ id: "dsmm", config: { ...baseline, ...override } }] : [])
    ])}\n`, { flag: "wx" });
    const loaded = loadProfileDirectory("dsh", dir, presetSdk.resolve("@deepseek-ai/dsh-app-boot"));
    assert.deepEqual(loaded.layers, []);
    assert.deepEqual(loaded.skippedBundles, []);
    const profileContext = { ...loaded, home, installAnchor: presetSdk.resolve("@deepseek-ai/dsh-app-boot"), overlays: [], startedBundles: [] };
    const ctx = new Context();
    const handles: AgentHandle[] = [];
    try {
      ctx.provide("profileContext", profileContext);
      await Promise.all([
        ctx.plugin(AgentRegistry), ctx.plugin(SessionStore), ctx.plugin(SessionProjectionRegistry),
        ctx.plugin(LlmRuntime), ctx.plugin(SystemPrompt, {}), ctx.plugin(ToolRuntime, { mode: "native" }), ctx.plugin(SkillRegistry, {})
      ].map((fiber) => fiber.await()));
      if (options.managedRuntime || options.stockRuntime) {
        const filesystem = await nativeFixturePlugin("@deepseek-ai/dsh-fs-local");
        await ctx.plugin(filesystem.default, { cwd: dir }).await();
        const workingDirectory = await nativeFixturePlugin("@deepseek-ai/dsh-working-directory");
        await ctx.plugin(workingDirectory.default, { defaultDirectory: dir }).await();
        const startup = ctx.plugin(SubagentRuntime, {}); await startup.await();
        assert.equal(startup.state, 2, "native runtime must activate before Core startup");
        const { SessionQueryEngine } = await nativeFixturePlugin("@deepseek-ai/dsh-session-query", "@deepseek-ai/dsh-subagent-spawn-in-process");
        class ExactQuery extends SessionQueryEngine {
          async searchSessions(): Promise<never> { throw new Error("config fixture does not offer full-text search"); }
          async searchEvents(): Promise<never> { throw new Error("config fixture does not offer full-text search"); }
        }
        await ctx.plugin(ExactQuery).await();
      } else await ctx.plugin(SubagentRuntime, {}).await();
      const adapter = new RoutingFixtureAdapter();
      ctx.llm.registerAdapter(["fixture"], adapter);
      await ctx.plugin(AgentLoop, {}).await();
      if (options.managedRuntime || options.stockRuntime) await ctx.plugin(nativeSpawn, { providerName: "spawn" }).await();
      await ctx.plugin(Loader).await();
      ctx.loader.builtins["fixture-dsmm"] = { default: DsmmPlugin };
      const include = await mountRootInclude(ctx, basePath, readProfilePatches("dsh", profileContext));
      assert.ok(include, "native boot must retain its root Include");
      await ctx.loader.await();
      const entry = ctx.loader.resolve("include:dsmm");
      const fiber = entry.fiber;
      assert.ok(fiber);
      await fiber.await();
      assert.equal(fiber.state, 2);
      const originalUid = fiber.uid;
      await ctx.plugin(ConfigEditor).await();
      if (options.managedPermissionSettings) await ctx.plugin(ManagedSettings).await();
      else await ctx.plugin(SettingsForms).await();
      const editor = ctx.get("configEditor") as NativeConfigEditor;
      const settings = ctx.get("settings") as NativeSettings;
      const deployment: object | undefined = ctx.get("dsmmDeploymentConfig");
      assert.ok(deployment instanceof DsmmDeploymentConfig);
      const runtime = ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime;
      assert.ok(editor && settings && deployment && runtime);
      assert.deepEqual(editor.entries(), [entry], "only the Include-owned DSMM row is addressable");
      assert.equal(editor.documentPath, patchPath);
      assert.equal(settings.documentPath, patchPath);
      assert.equal(deployment.entryId, "include:dsmm");
      const lifecycle = { partialDisposes: 0, updates: 0, scopeDisposals: 0, agentDisposals: 0 };
      ctx.on("loader/partial-dispose", (row) => { if (row === entry) lifecycle.partialDisposes++; });
      ctx.on("internal/update", function (_config, _noSave, next) {
        if (this === fiber) lifecycle.updates++;
        return next();
      }, { global: true });
      fiber.ctx.effect(() => () => { lifecycle.scopeDisposals++; });
      ctx.on("agent/disposed", () => { lifecycle.agentDisposals++; });
      let disposed = false;
      const fixture = {
        ctx, adapter, dir, patchPath, entry, fiber, settings, deployment, runtime, lifecycle,
        descriptor() {
          const descriptor = settings.describe().find((row) => row.ns === entry.options.id);
          assert.ok(descriptor, "real SettingsForms must expose the DSMM form");
          assert.equal(typeof descriptor.revision, "number");
          assert.equal(descriptor.applies, "live");
          return descriptor;
        },
        persistedConfig(): DsmmPluginConfig {
          const patches = readProfilePatches("dsh", profileContext);
          return composeEntries([patches]).find((row: { id: string }) => row.id === "dsmm").config;
        },
        async create(parentAgent?: Agent) {
          appendFileSync(journal, `${JSON.stringify({ probe: "create-agent", name, parent: parentAgent?.id })}\n`);
          const handle = await ctx.agents.create({
            sessionId: SessionId(`native-config-${randomUUID()}`),
            meta: { cwd: dir, ...(parentAgent ? { origin: "subagent" as const } : {}) },
            ...(parentAgent ? { parentAgent } : {}),
            agentOptions: { provider: "fixture", model: "native-default", reasoningEffort: ReasoningEffortId("low") }
          });
          handles.push(handle);
          return handle.agent;
        },
        assertLive() {
          assert.equal(entry.fiber, fiber, "native save must retain the exact DSMM fiber");
          assert.equal(fiber.uid, originalUid);
          assert.equal(fiber.state, 2);
          assert.equal(ctx.get("dsmmDeploymentConfig"), deployment, "no deployment service reapply");
          assert.equal(ctx.get("dsmmProfileRuntime"), runtime, "no runtime service reapply");
          assert.deepEqual({ updates: lifecycle.updates, scopeDisposals: lifecycle.scopeDisposals, agentDisposals: lifecycle.agentDisposals },
            { updates: 0, scopeDisposals: 0, agentDisposals: 0 });
        },
        async dispose() {
          if (disposed) return;
          disposed = true;
          for (const handle of [...handles].reverse()) await handle.dispose();
          await ctx.fiber.dispose();
        }
      };
      profiles.push(fixture);
      return fixture;
    } catch (error) {
      await ctx.fiber.dispose();
      throw error;
    }
  }

  return {
    root, home, createProfile, reopenProfile: name => createProfile(name, {}, true),
    async dispose() {
      for (const profile of [...profiles].reverse()) await profile.dispose();
      assert.equal(lstatSync(root).isSymbolicLink(), false);
      assert.equal(readFileSync(marker, "utf8"), owner, "cleanup must retain run ownership");
      rmSync(root, { recursive: true, force: true });
    }
  };
}
