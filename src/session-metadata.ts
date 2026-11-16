import { appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { DshSession, DshSessionEvent } from "./dsh-types.js";
import type { DsmmRolePolicyEventData } from "./dsh-events.js";
import type { DsmmInvocationLevel, DsmmModelRoute } from "./settings.js";
import { SubagentError } from "@deepseek-ai/dsh-subagent";
import { isDeepStrictEqual } from "node:util";
import { isDsmmRoleId } from "./roles.js";
import type { DsmmRoleId } from "./roles.js";
import { childOwnedSessionEvents } from "./session-scope.js";
import { validateProfileId } from "./profiles.js";

interface DelegationCeilingRestrictions {
  readonly version: 1;
  readonly childId: string;
  readonly creatorId: string;
  readonly rootId: string;
  readonly provider: string;
  readonly profileId: string | null;
  readonly readOnly: boolean;
  readonly allow: readonly string[] | null;
  readonly deny: readonly string[];
  readonly targets: readonly DsmmRoleId[];
  readonly maxDepth: number | null;
}

export type DsmmDelegationCeiling = DelegationCeilingRestrictions & (
  | { readonly role: DsmmRoleId; readonly level: DsmmInvocationLevel }
  | { readonly role: null; readonly level: null }
);

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
    "plugin:dsmm/delegation-ceiling": DsmmDelegationCeiling;
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

export function appendDelegationCeiling(session: DshSession, data: DsmmDelegationCeiling): void {
  appendPluginRecord(session as Session, "plugin:dsmm/delegation-ceiling", data);
}

/** Only the child's own suffix can restrict a cold admission; fork seeds carry no identity. */
export function readDelegationCeiling(session: DshSession): DsmmDelegationCeiling | undefined {
  let ceiling: DsmmDelegationCeiling | undefined;
  for (const event of childOwnedSessionEvents(session)) {
    const record = pluginRecordOf(event as SessionEvent);
    if (record?.type !== "plugin:dsmm/delegation-ceiling") continue;
    const data: unknown = record.data;
    const invalid = (): never => { throw new SubagentError("Invalid or conflicting delegation ceiling", "UNAUTHORIZED"); };
    if (!isRecord(data)) invalid();
    const row = data as Record<string, unknown>;
    const fields = ["version", "childId", "creatorId", "rootId", "provider", "role", "level", "profileId", "readOnly", "allow", "deny", "targets", "maxDepth"];
    const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
    const names = (value: unknown): value is string[] => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
    if (Object.keys(row).length !== fields.length || fields.some(key => !Object.hasOwn(row, key))
      || row.version !== 1 || !text(row.childId) || !text(row.creatorId) || !text(row.rootId) || !text(row.provider)
      || row.childId === row.creatorId || row.childId === row.rootId
      || (row.role === null ? row.level !== null : !isDsmmRoleId(row.role) || !["normal", "low", "high", "max"].includes(String(row.level)))
      || typeof row.readOnly !== "boolean"
      || row.allow !== null && !names(row.allow) || !names(row.deny) || !names(row.targets) || !row.targets.every(isDsmmRoleId)
      || row.maxDepth !== null && (typeof row.maxDepth !== "number" || !Number.isSafeInteger(row.maxDepth) || row.maxDepth < 0)) invalid();
    if (row.profileId !== null) {
      try { validateProfileId(row.profileId); } catch { invalid(); }
    }
    const current = row as unknown as DsmmDelegationCeiling;
    if (ceiling !== undefined && !isDeepStrictEqual(ceiling, current)) invalid();
    ceiling = current;
  }
  return ceiling;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
