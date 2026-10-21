import { isConfigRevision } from "../config-revision.js";
import type { ProfileSelectionState } from "../profile-types.js";
export const writableSelectionVersion = (value: unknown): boolean => value === "absent" || isConfigRevision(value);
export function configurationVersionState(value: unknown): "versionObserved" | "versionAbsent" | "versionUnknown" {
  if (value === "absent") return "versionAbsent";
  return isConfigRevision(value) || typeof value === "string" && /^native-v1-\d+$/u.test(value) ? "versionObserved" : "versionUnknown";
}
export function sourceRelationship(selection: Pick<ProfileSelectionState, "sourceRevision">, savedRevision: string | null | undefined): "current" | "changed" | "unknown" {
  return selection.sourceRevision === undefined || savedRevision == null || !isConfigRevision(savedRevision) ? "unknown" : selection.sourceRevision === savedRevision ? "current" : "changed";
}
