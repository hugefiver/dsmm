import { appendPluginRecord } from "@deepseek-ai/dsh-session";
import type { Session } from "@deepseek-ai/dsh-session";
import type { DshSession } from "./dsh-types.js";
import type { DsmmRolePolicyEventData } from "./dsh-events.js";

declare module "@deepseek-ai/dsh-session/types" {
  interface PluginRecordMap {
    "plugin:dsmm/mode": { active: boolean };
    "plugin:dsmm/role-policy": DsmmRolePolicyEventData;
  }
}

/** Model-hidden observations use the official ignorable record boundary, never authorization. */
export function appendModeRecord(session: DshSession, active: boolean): void {
  appendPluginRecord(session as Session, "plugin:dsmm/mode", { active });
}
export function appendRolePolicyRecord(session: DshSession, data: DsmmRolePolicyEventData): void {
  appendPluginRecord(session as Session, "plugin:dsmm/role-policy", data);
}
