import { Context, getTraceable, symbols } from "@deepseek-ai/cordis";
import { createRequire } from "node:module";
import type { DshAgent, DshSystemPromptContext } from "./dsh-types.js";

type NativeScopeKey = NonNullable<DshSystemPromptContext["scope"]>;
interface NativeScopeApi {
  scopeOf(ctx: Context): NativeScopeKey | undefined;
  scopeParentOf(key: NativeScopeKey): NativeScopeKey | undefined;
}

// Resolve through the declared SDK peer, not a developer/global installation.
const require = createRequire(import.meta.url);
const sdk = createRequire(require.resolve("@deepseek-ai/dsh-agent-preset-registry"));
const scope: NativeScopeApi = sdk("@deepseek-ai/dsh-scope");
export const { scopeOf, scopeParentOf } = scope;

export function nativeAgentContext(agent: DshAgent): Context {
  if (!Context.is(agent.ctx) || scopeOf(agent.ctx) !== agent) {
    throw new Error("dsmm skills require the exact native Agent scope, never a shared preset/global scope");
  }
  return agent.ctx;
}

/** Select the retained preset's implementation, but register effects on the caller's Agent layer. */
export function agentScopeService<K extends "systemPrompt" | "skills" | "tools">(ctx: Context, name: K): Context[K] | undefined {
  const preset = ctx.get("agentPresets")?.serviceFor({ ctx }, name);
  return preset === undefined ? ctx.get(name) : getTraceable(ctx, (Reflect.get(preset, symbols.original) as Context[K] | undefined) ?? preset);
}
