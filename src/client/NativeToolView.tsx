import type { Context } from "@deepseek-ai/cordis";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import type { PropsLocale, StoredEntry } from "@deepseek-ai/dsh-client-ui-slots";
import type { ComponentType } from "react";
import { Button, DisclosureRow, IconAgentPresetOutlineRegular, StateDot } from "@deepseek-ai/dsh-client-ui-primitives";
import { nativeActivationIdentity, observedNativeTool } from "./NativeToolView-data.js";
import { childConversationAction, useCardObservation, type childConversationInjection, type ChildConversationCardProps } from "./child-conversation.js";
import { ROLE_TOOL_NS } from "./RoleToolView-locales.js";

type NativeProps = ToolCallViewProps & PropsLocale<"conversation">;
type NativeView = ComponentType<NativeProps>;
type Props = ChildConversationCardProps & { nativeView: NativeView; nativeT: NativeProps["t"] };

export function NativeToolView(props: Props) {
  const { nativeView: NativeView, nativeT, t, useRoleCalls, useChildWorkspace, ...nativeProps } = props;
  const observation = useCardObservation(props);
  const status = useRoleCalls(state => state.status);
  const { expanded, toggle } = props.useDisclosure();
  const result = props.phase === "result" && !props.block.isError && props.block.error == null ? props.block : undefined;
  const receipt = result === undefined ? undefined : nativeActivationIdentity(result.meta);
  const nativeCall = result !== undefined && observation?.kind === "native" && observation.toolName === props.toolName && observation.phase !== "reserved"
    ? observation : undefined;
  const actual = receipt === undefined ? nativeCall : observedNativeTool(props.toolName, props.callId, receipt, nativeCall);
  const identity = receipt ?? (actual === undefined ? undefined : { kind: "id", value: actual.childId } as const);
  const settled = actual?.phase === "settled";
  const live = status === "live";
  const state = settled ? actual.stopReason === undefined ? "accepted" : actual.stopReason === "aborted" ? "stopped" : actual.stopReason === "completed" ? "completed" : "error"
    : actual !== undefined && live ? "running" : "accepted";
  const route = settled || live ? actual?.actualRoute : undefined;

  const receiptChildId = receipt?.kind === "id" ? receipt.value : undefined;
  const observedChildId = (receiptChildId === undefined ? actual : nativeCall)?.childId;
  const openChild = childConversationAction(useChildWorkspace(workspace => workspace), props.sessionId, props.useProjection("subagentCatalog"),
    receiptChildId, observedChildId);

  return <>
    <NativeView {...nativeProps} t={nativeT} />
    {identity !== undefined && <div className="dsmm-role-tool" data-dsmm-native-tool={props.toolName} data-state={state} data-identity="native">
      <DisclosureRow title={`${t("nativeAgent")} · ${identity.value}`} titleClassName="dsmm-role-summary" rowClassName="dsmm-role-heading"
        icon={<IconAgentPresetOutlineRegular size={14} className="dsmm-role-icon" />}
        open={expanded} expandable onToggle={toggle} expandOnRowClick running={state === "running"}>
        <div className="dsmm-role-body">
          <p className="dsmm-role-identity">{t(identity.kind === "name" ? "nativeName" : "nativeId")}: {identity.value}</p>
          {actual !== undefined && <p className="dsmm-role-identity">{t("nativeId")}: {actual.childId}{actual.provider === undefined ? "" : ` · ${t("nativeProvider")}: ${actual.provider}`}</p>}
          <p className="dsmm-role-identity">{t("actualRoute")}: {route?.status === "known"
            ? `${route.route.provider}/${route.route.model} · ${route.route.reasoningEffort ?? t("effortUnreported")}` : t("routeUnknown")}</p>
          <p className="dsmm-role-identity" data-observation-status={actual === undefined ? "unavailable" : status}>
            {actual === undefined ? t("nativeCorrelationUnavailable") : t(({ unavailable: "observationUnavailable", connecting: "observationConnecting", live: "observationLive", stale: "observationStale" } as const)[status])}
          </p>
        </div>
      </DisclosureRow>
      <div className="dsmm-role-actions">
        <StateDot state={state === "error" ? "error" : state === "stopped" ? "warning" : state === "completed" ? "done" : state === "running" ? "ongoing" : "idle"} />
        <p className="dsmm-role-status" role="status">{t(state)}</p>
        {openChild !== undefined && <Button variant="ghost" size="sm" onClick={openChild}>{t("openConversation")}</Button>}
      </div>
    </div>}
  </>;
}

export function registerNativeToolViews(ctx: Context, inject: ReturnType<typeof childConversationInjection>): () => void {
  const mounted = new Map<string, { source: StoredEntry; dispose: () => void }>();
  const reconcile = () => {
    const entries = ctx.slots.entries("tool.call.toolview");
    const nativeEntry = (key: string) => entries.filter(entry => entry.component !== NativeToolView && entry.options.key === key)
      .sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0];
    const subagent = nativeEntry("subagent");
    // The stock subagent DetailsRow also renders the generic receipt and inspect action for fork.
    for (const [key, source] of [["subagent", subagent], ["subagent_fork", nativeEntry("subagent_fork") ?? subagent]] as const) {
      const previous = mounted.get(key);
      if (previous?.source === source) continue;
      previous?.dispose(); mounted.delete(key);
      if (source === undefined || typeof source.component !== "function" || source.locale !== "conversation" || source.inject !== undefined || source.store !== undefined || source.children !== undefined) continue;
      const nativeView = source.component as NativeView;
      const dispose = ctx.slots.register({ name: "tool.call.toolview", key, priority: (source.options.priority ?? 0) - 1, locale: ROLE_TOOL_NS,
        inject: sessionId => ({ ...inject(sessionId), nativeView, nativeT: ctx.locale.bind("conversation") }) }, NativeToolView);
      mounted.set(key, { source, dispose });
    }
  };
  const unsubscribe = ctx.slots.subscribe("tool.call.toolview", reconcile);
  reconcile();
  return () => { unsubscribe(); for (const entry of mounted.values()) entry.dispose(); mounted.clear(); };
}
