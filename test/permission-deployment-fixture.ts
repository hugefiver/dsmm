import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { DsmmDeploymentConfig } from "../src/deployment-config.ts";
import { DSMM_NATIVE_CONFIG_SCHEMA } from "../src/settings.ts";
import type { DsmmPluginConfig } from "../src/settings.ts";
import type { DshContext } from "../src/dsh-types.ts";
import * as ManagedSettings from "../src/managed-settings.ts";

const require = createRequire(import.meta.url), preset = createRequire(require.resolve("@deepseek-ai/dsh-agent-preset-registry")), settings = createRequire(preset.resolve("@deepseek-ai/dsh-settings"));
const { Loader } = preset("@deepseek-ai/cordis-plugin-loader"), { ConfigEditor } = settings("@deepseek-ai/dsh-config-editor");
const { mountRootInclude, loadProfileDirectory, readProfilePatches, composeEntries } = preset("@deepseek-ai/dsh-app-boot");

export interface PermissionDeploymentProfile {
  ctx: Context;
  entry: ReturnType<Context["loader"]["resolve"]>;
  fiber: Context["fiber"];
  deployment: DsmmDeploymentConfig;
  settings: {
    describe(): { ns: string; revision: number }[];
    mutate(ns: string, ops: unknown[], revision: number): Promise<void>;
  };
  descriptor(): { ns: string; revision: number };
  persistedConfig(): DsmmPluginConfig;
  create(parent?: Agent): Promise<Agent>;
  assertLive(): void;
  dispose(): Promise<void>;
}
export interface PermissionDeploymentRun {
  root: string;
  home: string;
  createProfile(name: string, override?: DsmmPluginConfig, reopen?: boolean): Promise<PermissionDeploymentProfile>;
  reopenProfile(name: string): Promise<PermissionDeploymentProfile>;
  dispose(): Promise<void>;
}

/** Native Loader/ConfigEditor/SettingsForms with only the source-backed deployment capability. */
export function nativeConfigRun(_options: { managedPermissionSettings?: boolean } = {}): PermissionDeploymentRun {
  const root = mkdtempSync(join(tmpdir(), "dsmm-permission-deployment-")), home = join(root, "home"); mkdirSync(home);
  const profiles: { dispose(): Promise<void> }[] = [];
  const createProfile = async (name: string, override: DsmmPluginConfig = {}, reopen = false) => {
    const dir = join(root, name), base = join(dir, "cordis.json"), patchPath = join(dir, "cordis.patch.yml");
    if (!reopen) { mkdirSync(dir); writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "owned-permission-deployment", private: true, dependencies: {}, dsh: { profile: { bundles: [] } } })); writeFileSync(base, "[]\n"); writeFileSync(patchPath, JSON.stringify([{ insert: [{ id: "dsmm", name: "cordis:owned-permission-deployment", config: override }] }])); }
    const loaded = loadProfileDirectory("dsh", dir, preset.resolve("@deepseek-ai/dsh-app-boot")), ctx = new Context(), handles: AgentHandle[] = [];
    const profileContext = { ...loaded, home, installAnchor: preset.resolve("@deepseek-ai/dsh-app-boot"), overlays: [], startedBundles: [] };
    try {
      ctx.provide("profileContext", profileContext);
      for (const [plugin, config] of [[AgentRegistry], [SessionStore], [SessionProjectionRegistry], [LlmRuntime], [SystemPrompt, {}], [ToolRuntime, { mode: "native" }], [AgentLoop, {}], [Loader]] as const) await ctx.plugin(plugin as never, config as never).await();
      let deployment!: DsmmDeploymentConfig;
      ctx.loader.builtins["owned-permission-deployment"] = { Config: DSMM_NATIVE_CONFIG_SCHEMA, apply(scope: Context, config: DsmmPluginConfig) { deployment = new DsmmDeploymentConfig(scope as unknown as DshContext, config); } };
      await mountRootInclude(ctx, base, readProfilePatches("dsh", ctx.get("profileContext"))); await ctx.loader.await();
      const entry = ctx.loader.resolve("include:dsmm"), fiber = entry.fiber!; await fiber.await(); const uid = fiber.uid;
      await ctx.plugin(ConfigEditor).await(); await ctx.plugin(ManagedSettings).await();
      const forms = ctx.get("settings") as unknown as { describe(): { ns: string; revision: number }[]; mutate(ns: string, ops: unknown[], revision: number): Promise<void> };
      let disposed = false;
      const profile = { ctx, entry, fiber, deployment, settings: forms,
        descriptor() { const value = forms.describe().find(row => row.ns === entry.options.id); assert.ok(value); return value; },
        persistedConfig(): DsmmPluginConfig { const patches = readProfilePatches("dsh", profileContext); return composeEntries([patches]).find((row: { id: string }) => row.id === "dsmm").config as DsmmPluginConfig; },
        async create(parent?: Agent) { const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), ...parent === undefined ? {} : { parentAgent: parent }, meta: { cwd: root }, agentOptions: { provider: "unused-local", model: "unused-local" } }); handles.push(handle); return handle.agent; },
        assertLive() { assert.equal(fiber.uid, uid); assert.equal(fiber.state, 2); },
        async dispose() { if (disposed) return; disposed = true; for (const handle of [...handles].reverse()) await handle.dispose(); await ctx.fiber.dispose(); },
      };
      profiles.push(profile); return profile;
    } catch (error) { for (const handle of [...handles].reverse()) await handle.dispose(); await ctx.fiber.dispose(); throw error; }
  };
  return { root, home, createProfile, reopenProfile: (name: string) => createProfile(name, {}, true), async dispose() { for (const profile of [...profiles].reverse()) await profile.dispose(); const exact = await realpath(root); assert.equal(dirname(exact), await realpath(tmpdir())); assert.ok(exact.startsWith(join(await realpath(tmpdir()), "dsmm-permission-deployment-"))); await rm(exact, { recursive: true, force: false }); } };
}
