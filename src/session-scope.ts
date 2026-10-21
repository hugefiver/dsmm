import { foldSubagentDescriptor } from "@deepseek-ai/dsh-subagent";
import type { DshAgent, DshSession, DshSessionEvent } from "./dsh-types.js";
import { isDsmmRoleId } from "./roles.js";
import type { DsmmRoleId } from "./roles.js";
import { roleFromProviderName } from "./role-providers.js";
import { capturedRoleInvocation } from "./role-invocation.js";
import type { DsmmSettings } from "./settings.js";

export function sessionEvents(session: DshSession | undefined): readonly DshSessionEvent[] {
  return (session?.snapshotEvents?.() ?? session?.events ?? []).map(event => event.type === "plugin:dsmm/mode"
    ? { ...event, type: "deepwork/mode" } : event.type === "plugin:dsmm/role-policy" ? { ...event, type: "dsmm/role-policy" } : event);
}

export function resolveSelectedAgentPreset(session: DshSession | undefined): string | undefined {
  const events = sessionEvents(session);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "agent-preset/selected") continue;
    const data = event.data;
    if (typeof data === "object" && data !== null && "agentPreset" in data && typeof data.agentPreset === "string") {
      return data.agentPreset;
    }
  }

  return typeof session?.header?.agentPreset === "string" ? session.header.agentPreset : undefined;
}

export function childOwnedSessionEvents(session: DshSession): readonly DshSessionEvent[] {
  const inherited = session.inheritedEventCount ?? 0;
  if (!Number.isSafeInteger(inherited) || inherited < 0) throw new TypeError("dsmm cannot classify an invalid inherited event boundary");
  return sessionEvents(session).slice(inherited);
}

/** Parent preset/persona inheritance is deliberately not delegated role authority. */
export function resolveEffectiveDsmmRole(agent: DshAgent, settings: DsmmSettings, modeActive: boolean): DsmmRoleId | undefined {
  if (!settings.modules.deepwork.enabled) return undefined;
  let role: DsmmRoleId | undefined;
  if (agent.session.header?.origin === "subagent") {
    const own = childOwnedSessionEvents(agent.session);
    const descriptor = foldSubagentDescriptor(own as Parameters<typeof foldSubagentDescriptor>[0]);
    // Native lifecycle mode does not determine an exact Agent's admitted DSMM role.
    role = capturedRoleInvocation(agent)?.target
      ?? (descriptor?.mode === "one-shot" ? roleFromProviderName(descriptor.provider) : undefined);
  } else {
    const preset = resolveSelectedAgentPreset(agent.session);
    role = isDsmmRoleId(preset) ? preset : modeActive ? "dsmm-orchestrator" : undefined;
  }
  return role !== undefined && settings.roles[role] ? role : undefined;
}
