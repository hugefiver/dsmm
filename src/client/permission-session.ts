import type { SessionBinding, SessionListState, SessionSnapshot, SessionSummary } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { PermissionView } from "./permission-controller.js";

/** The observable subset this binding uses; no store engine is imported. */
interface Observable<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
/** The current native selection source; it retains whatever it renders. */
export type PermissionSessionSource = Observable<{ readonly key: string | undefined }>;
/** The session fields this binding classifies; a real `SessionFace` satisfies the projection. */
export type PermissionSessionSnapshot = Pick<SessionSnapshot, "sessionId" | "subagent" | "removed" | "openState">;
export type PermissionSessionBinding = Pick<SessionBinding, "sessionId"> & { readonly session: Observable<PermissionSessionSnapshot> };
/** Only the catalog membership and lineage fields this binding reads. */
export type PermissionSessionCatalog = Pick<SessionListState, "ids"> & { readonly byId: Readonly<Record<SessionId, Pick<SessionSummary, "origin" | "parentId">>> };
export interface PermissionSessions {
  binding(id: SessionId): PermissionSessionBinding | undefined;
  readonly list: Observable<PermissionSessionCatalog>;
}
/** The only controller capability this binding needs. */
export interface PermissionScopeSink {
  bindScope(sessionId: string | null, owner: object | null, scope: PermissionView["scope"]): void;
}
/**
 * Follow the selected native session without retaining, opening or debouncing it.
 * A binding is reused across notifications and only an actual session change clears
 * the controller's display projection.
 */
export function bindPermissionSession(source: PermissionSessionSource, sessions: PermissionSessions, permissions: PermissionScopeSink): () => void {
  let observed: PermissionSessionBinding | undefined, stop: (() => void) | undefined;
  const update = (): void => {
    const id = source.getSnapshot().key as SessionId | undefined, binding = id === undefined ? undefined : sessions.binding(id);
    if (binding !== observed) { stop?.(); observed = binding; stop = binding?.session.subscribe(update); }
    const snapshot = binding?.session.getSnapshot(), catalog = sessions.list.getSnapshot(), summary = id === undefined ? undefined : catalog.byId[id];
    const child = snapshot?.subagent != null || summary?.origin === "subagent" || summary?.parentId !== undefined;
    const root = id !== undefined && binding?.sessionId === id && snapshot?.sessionId === id && snapshot.openState === "open" && !snapshot.removed
      && catalog.ids.includes(id) && summary !== undefined && !child;
    permissions.bindScope(id ?? null, binding ?? null, child ? "child" : root ? "root" : "unknown");
  };
  update();
  const stopSource = source.subscribe(update), stopCatalog = sessions.list.subscribe(update);
  let active = true;
  return () => {
    if (!active) return; active = false;
    stopSource(); stopCatalog(); stop?.();
    permissions.bindScope(null, null, "unknown");
  };
}
