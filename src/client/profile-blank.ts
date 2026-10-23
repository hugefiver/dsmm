import type { ISessions, SessionBinding } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { HostObservable } from "@deepseek-ai/dsh-client-ui-slots";

type WorkspaceId = NonNullable<NonNullable<Parameters<ISessions["create"]>[0]>["workspaceId"]>;
export interface ProfileWorkspace { id: string; label: string }
export interface ProfileBlankNative {
  readonly workspaces: HostObservable<readonly ProfileWorkspace[]>;
  beginNavigation(): AbortSignal;
  connectWorkspace(id: string): Promise<SessionId>;
  retain(id: SessionId): { readonly sessionId: SessionId; readonly ready: Promise<Pick<SessionBinding, "sessionId">>; release(): void };
  openSession(id: SessionId): void;
}

/** Public native service subsets; these optional packages are not runtime imports. */
export interface ProfileBlankServices {
  workspaces: { readonly list: HostObservable<{ readonly phase: string; readonly items: readonly { readonly workspaceId: WorkspaceId; readonly title: string; readonly path: string }[] }> };
  uiWorkspace: {
    connectWorkspace(id: WorkspaceId): Promise<SessionId>;
    openSession(id: SessionId): void;
  };
  layout: { beginNavigation(): AbortSignal };
  sessions: Pick<ISessions, "retain">;
}

export function profileBlankNative(services: ProfileBlankServices): ProfileBlankNative {
  const list = services.workspaces.list;
  return {
    workspaces: {
      getSnapshot: () => { const state = list.getSnapshot(); return state.phase === "ready" ? state.items.map(item => ({ id: item.workspaceId, label: item.title || item.path })) : []; },
      subscribe: listener => list.subscribe(listener),
    },
    beginNavigation: () => services.layout.beginNavigation(),
    connectWorkspace: id => {
      const state = list.getSnapshot(), workspace = state.phase === "ready" ? state.items.find(item => item.workspaceId === id) : undefined;
      if (workspace === undefined) return Promise.reject(new Error("Workspace unavailable"));
      return services.uiWorkspace.connectWorkspace(workspace.workspaceId);
    },
    retain: id => services.sessions.retain(id, { source: "controllerOperation" }),
    openSession: id => services.uiWorkspace.openSession(id),
  };
}
