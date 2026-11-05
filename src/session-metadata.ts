import { appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { DshSession, DshSessionEvent } from "./dsh-types.js";
import type { DsmmRolePolicyEventData } from "./dsh-events.js";
import type { DsmmModelRoute } from "./settings.js";

export interface DsmmModelSelectionRecordData {
  readonly version: 1;
  readonly source: "dsmm-selection" | "activation-setup";
  readonly selectionSeq: number;
  readonly route: Readonly<Pick<DsmmModelRoute, "provider" | "model" | "reasoningEffort">>;
}

declare module "@deepseek-ai/dsh-session/types" {
  interface PluginRecordMap {
    "plugin:dsmm/mode": { active: boolean };
    "plugin:dsmm/role-policy": DsmmRolePolicyEventData;
    "plugin:dsmm/model-selection": DsmmModelSelectionRecordData;
  }
}

/** Model-hidden observations use the official ignorable record boundary, never authorization. */
export function appendModeRecord(session: DshSession, active: boolean): void {
  appendPluginRecord(session as Session, "plugin:dsmm/mode", { active });
}
export function appendRolePolicyRecord(session: DshSession, data: DsmmRolePolicyEventData): void {
  appendPluginRecord(session as Session, "plugin:dsmm/role-policy", data);
}
export function appendModelSelectionRecord(session: DshSession, data: DsmmModelSelectionRecordData): void {
  appendPluginRecord(session as Session, "plugin:dsmm/model-selection", data);
}
export function readModelSelectionRecord(event: DshSessionEvent): (DsmmModelSelectionRecordData & { recordSeq: number }) | undefined {
  const record = pluginRecordOf(event as SessionEvent);
  if (record?.type !== "plugin:dsmm/model-selection" || !isRecord(record.data)) return undefined;
  const { version, source, selectionSeq, route } = record.data;
  if (version !== 1 || source !== "dsmm-selection" && source !== "activation-setup"
    || !Number.isSafeInteger(selectionSeq) || typeof selectionSeq !== "number" || selectionSeq < 0 || !isRecord(route)
    || Object.keys(route).some(key => !["provider", "model", "reasoningEffort"].includes(key))
    || typeof route.provider !== "string" || route.provider.trim() === "" || typeof route.model !== "string" || route.model.trim() === ""
    || route.reasoningEffort !== undefined && (typeof route.reasoningEffort !== "string" || route.reasoningEffort.trim() === "")) return undefined;
  return { version, source, selectionSeq, route: { provider: route.provider, model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) }, recordSeq: Number(record.seq) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
