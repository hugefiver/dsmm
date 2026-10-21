import { Context } from "@deepseek-ai/cordis";
import { createRequire } from "node:module";
import type { DshAgent, DshContext, DshSystemPromptContext } from "./dsh-types.js";

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

/** A scope key is opaque; resolve identity against live Agents, not its fields. */
export function agentForScope(ctx: DshContext, key: object | undefined): DshAgent | undefined {
  if (key === undefined) return undefined;
  return ctx.get?.<{ list(): DshAgent[] }>("agents")?.list().find((agent) => agent === key);
}
