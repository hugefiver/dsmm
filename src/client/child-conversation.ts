import type { Context } from "@deepseek-ai/cordis";
import type { SessionTarget } from "@deepseek-ai/dsh-api-session-controller/client";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import type { HostObservable, InjectFace, PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SubagentCatalogEntry } from "@deepseek-ai/dsh-subagent/client";
import type { ROLE_TOOL_NS } from "./RoleToolView-locales.js";
import type { RoleCallObservationController, RoleCallObservationState } from "./role-call-observations.js";

type ChildAddress = Exclude<SessionTarget, SessionId>;
type WorkspaceNavigation = { openSession(target: SessionTarget): void };
type CardInjection = {
  hooks: {
    roleCalls: HostObservable<RoleCallObservationState>;
    childWorkspace: HostObservable<WorkspaceNavigation | undefined>;
  };
};
export type ChildConversationCardProps = ToolCallViewProps & PropsLocale<typeof ROLE_TOOL_NS> & InjectFace<CardInjection>;

export function childConversationInjection(ctx: Context, observations: RoleCallObservationController): (sessionId: SessionId) => CardInjection {
  let workspace: WorkspaceNavigation | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: WorkspaceNavigation | undefined) => {
    workspace = next;
    for (const listener of listeners) listener();
  };
  const childWorkspace: CardInjection["hooks"]["childWorkspace"] = {
    getSnapshot: () => workspace,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  void ctx.inject(["uiWorkspace"], scope => {
    const navigation: WorkspaceNavigation = scope.get("uiWorkspace");
    scope.effect(() => {
      publish(navigation);
      return () => publish(undefined);
    });
  });
  return sessionId => ({ hooks: { roleCalls: observations.source(sessionId), childWorkspace } });
}

export function useCardObservation({ useRoleCalls, sessionId, callId }: ChildConversationCardProps) {
  return useRoleCalls(state => {
    const call = state.calls.get(callId);
    return call?.parentSessionId === sessionId && call?.callId === callId ? call : undefined;
  });
}

export function childConversationAction(
  workspace: WorkspaceNavigation | undefined,
  parentSessionId: SessionId,
  catalog: readonly SubagentCatalogEntry[] | undefined,
  receiptChildId: string | undefined,
  observedChildId: string | undefined,
  fallbackMode?: ChildAddress["mode"],
): (() => void) | undefined {
  if (workspace === undefined || receiptChildId !== undefined && observedChildId !== undefined && receiptChildId !== observedChildId) return undefined;
  const childSessionId = receiptChildId ?? observedChildId;
  if (childSessionId === undefined || childSessionId === parentSessionId) return undefined;
  const mode = catalog?.find(entry => entry.id === childSessionId)?.mode ?? fallbackMode;
  if (mode === undefined || mode === "external") return undefined;
  return () => workspace.openSession({ parentSessionId, childSessionId: childSessionId as SessionId, mode });
}
