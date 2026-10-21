import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SubagentRuntimeAdmissionView } from "./profile-types.js";
import type { DshAgent } from "./dsh-types.js";
import { capturedRoleInvocation } from "./role-invocation.js";
export type DsmmHostStartupOptions = Readonly<Record<string, never>>;
export function assertSupportedHostStartup(options: DsmmHostStartupOptions): void {
  if (options === null || typeof options !== "object" || Object.keys(options).length) throw new Error("DSMM uses official native services; runtime replacement options are unsupported");
}
export function classifyDsmmAgent(agent: Agent): "dsmm" | "native" {
  const admission = agent.ctx.get("dsmmNativeAdmission"), preset = agent.ctx.get("agentPresets")?.composedPreset(agent.ctx);
  return capturedRoleInvocation(agent as DshAgent) || admission?.owns(agent) && preset?.startsWith("dsmm-") ? "dsmm" : "native";
}
export function runtimeAdmissionView(ctx: Context): SubagentRuntimeAdmissionView {
  const native = ctx.get("subagents"), admission = ctx.get("dsmmNativeAdmission");
  const ready = native !== undefined && admission?.isReady === true;
  return { binding: native === undefined ? "unavailable" : "stock", deliveryFenceReady: ready,
    restartRequired: !ready, ...ready ? {} : { reason: "authority-not-ready" } };
}
