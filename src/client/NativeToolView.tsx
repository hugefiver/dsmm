import type { Context } from "@deepseek-ai/cordis";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import type { HostObservable, InjectFace, PropsLocale, StoredEntry } from "@deepseek-ai/dsh-client-ui-slots";
import type { ComponentType } from "react";
import { DisclosureRow, IconAgentPresetOutlineRegular, StateDot } from "@deepseek-ai/dsh-client-ui-primitives";
import { nativeActivationIdentity, observedNativeTool } from "./NativeToolView-data.js";
import { ROLE_TOOL_NS } from "./RoleToolView-locales.js";
import type { RoleCallObservationController, RoleCallObservationState } from "./role-call-observations.js";

type NativeProps = ToolCallViewProps & PropsLocale<"conversation">;
type NativeView = ComponentType<NativeProps>;
type Props = ToolCallViewProps & PropsLocale<typeof ROLE_TOOL_NS> & InjectFace<{
  hooks: { roleCalls: HostObservable<RoleCallObservationState> };
  nativeView: NativeView;
  nativeT: NativeProps["t"];
}>;

export function NativeToolView(props: Props) {
  const { nativeView: NativeView, nativeT, t } = props;
  const observation = props.useRoleCalls(state => state.calls.get(props.callId));
  const status = props.useRoleCalls(state => state.status);
  const { expanded, toggle } = props.useDisclosure();
  const result = props.phase === "result" ? props.block : undefined;
  const identity = result === undefined || result.isError || result.error != null ? undefined : nativeActivationIdentity(result.meta);
  const actual = observedNativeTool(props.toolName, props.callId, identity, observation);
  const settled = actual?.phase === "settled";
  const live = status === "live";
  const state = settled ? actual.stopReason === undefined ? "accepted" : actual.stopReason === "aborted" ? "stopped" : actual.stopReason === "completed" ? "completed" : "error"
    : actual !== undefined && live ? "running" : "accepted";
  const route = settled || live ? actual?.actualRoute : undefined;
  return <>
    <NativeView {...props} t={nativeT} />
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
      </div>
    </div>}
  </>;
}

export function registerNativeToolViews(ctx: Context, observations: RoleCallObservationController): () => void {
  const mounted = new Map<string, { source: StoredEntry; dispose: () => void }>();
  const reconcile = () => {
    const entries = ctx.slots.entries("tool.call.toolview");
    for (const key of ["subagent", "subagent_fork"]) {
      const candidates = entries.filter(entry => entry.component !== NativeToolView && entry.options.key === key);
      const source = candidates.sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0];
      const previous = mounted.get(key);
      if (previous?.source === source) continue;
      previous?.dispose(); mounted.delete(key);
      if (source === undefined || typeof source.component !== "function" || source.locale !== "conversation" || source.inject !== undefined || source.store !== undefined || source.children !== undefined) continue;
      const nativeView = source.component as NativeView;
      const dispose = ctx.slots.register({ name: "tool.call.toolview", key, priority: (source.options.priority ?? 0) - 1, locale: ROLE_TOOL_NS,
        inject: sessionId => ({ hooks: { roleCalls: observations.source(sessionId) }, nativeView, nativeT: ctx.locale.bind("conversation") }) }, NativeToolView);
      mounted.set(key, { source, dispose });
    }
  };
  const unsubscribe = ctx.slots.subscribe("tool.call.toolview", reconcile);
  reconcile();
  return () => { unsubscribe(); for (const entry of mounted.values()) entry.dispose(); mounted.clear(); };
}
