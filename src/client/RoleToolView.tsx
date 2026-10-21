import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { Button, CodeBlock, DisclosureRow, StateDot } from "@deepseek-ai/dsh-client-ui-primitives";
import { actualRoleTool, preparingRoleTool, requestedRoleTool, roleToolDisplay, roleToolKeys } from "./RoleToolView-data.js";
import { ROLE_TOOL_NS, roleToolEn, roleToolZh } from "./RoleToolView-locales.js";

type Props = ToolCallViewProps & PropsLocale<typeof ROLE_TOOL_NS>;
const styles = `
.dsmm-role-tool{min-width:0;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:14px;line-height:22px}
.dsmm-role-tool .dsmm-role-heading{color:var(--dsw-alias-label-primary);height:auto;min-height:32px}
.dsmm-role-tool .dsmm-role-title{white-space:normal;overflow-wrap:anywhere;min-width:0;max-width:100%;color:inherit;font-size:inherit;line-height:inherit}
.dsmm-role-tool .dsmm-role-text{flex:1;min-width:0}
.dsmm-role-tool .dsmm-role-body{display:flex;flex-direction:column;gap:12px;min-width:0;padding:8px 0}
.dsmm-role-tool p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.dsmm-role-tool .dsmm-role-status{color:var(--dsw-alias-label-secondary)}
.dsmm-role-tool .dsmm-role-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dsmm-role-tool :is(button,[role=button]):focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
`;

export function RoleToolView(props: Props) {
  const { expanded, toggle } = props.useDisclosure();
  const partial = props.phase === "preparing" ? preparingRoleTool(props.toolName, props.block.args) : undefined;
  const { t } = props;
  const raw = props.phase === "preparing" ? partial!.preview : props.phase === "start" ? props.block.argsRaw : props.block.call?.argsRaw ?? "";
  const requested = partial?.requested ?? requestedRoleTool(props.toolName, raw);
  const result = props.phase === "result" ? props.block : undefined;
  const failed = result !== undefined && (result.isError || result.error != null);
  const actual = result === undefined ? undefined : actualRoleTool(props.toolName, result.meta, failed);
  const target = actual?.role ?? requested.target;
  const title = `${t("call")} ${target === undefined ? t("unknownTarget") : roleToolDisplay(target)}${(actual?.level ?? requested.level) === undefined ? "" : ` · ${actual?.level ?? requested.level}`}`;
  const state = result?.error?.code === "interrupted" ? "stopped" : failed ? "error" : result === undefined ? props.phase === "preparing" ? "preparing" : "running" : actual?.jobId !== undefined || actual?.mode === "continuable" ? "background" : "result";
  const code = (value: string) => <CodeBlock code={value} copyLabel={t("copy")} copiedLabel={t("copied")} />;
  return <div className="dsmm-role-tool" data-dsmm-role-tool={props.toolName} data-identity={actual === undefined ? "requested" : "actual"} data-state={state}>
    <DisclosureRow title={title} titleClassName="dsmm-role-title" rowClassName="dsmm-role-heading" contentClassName="dsmm-role-text"
      icon={<StateDot state={state === "error" ? "error" : state === "stopped" ? "warning" : result === undefined ? "ongoing" : state === "background" ? "idle" : "done"} />}
      open={expanded} expandable onToggle={toggle} expandOnRowClick>
      <div className="dsmm-role-body">
        <p>{props.toolName} · {props.callId}</p>
        <p className="dsmm-role-status">{t("requested")} {t(requested.kind)}: {requested.target === undefined ? t("unknown") : roleToolDisplay(requested.target)}</p>
        {requested.description !== undefined && <p className="dsmm-role-status">{requested.description}</p>}
        {actual !== undefined && <>
          <p>{t("actual")} {t(requested.kind)}: {roleToolDisplay(actual.role)} · {t("level")}: {actual.level}</p>
          <p>{t("routeSource")}: {actual.routeSource} · {t("route")}: {actual.route === undefined ? t("unknown") : `${actual.route.provider}/${actual.route.model}${actual.route.reasoningEffort === undefined ? "" : ` · ${actual.route.reasoningEffort}`}`}</p>
        </>}
        <div><p>{t(props.phase === "preparing" ? "preparingArgs" : "args")}</p>{raw === "" ? <p>{t("emptyArgs")}</p> : code(raw)}</div>
        {result !== undefined && <>
          {actual === undefined && <p>{t("unavailable")}</p>}
          <div><p>{t("output")}</p>{code(JSON.stringify(result.content, null, 2))}</div>
          {result.error != null && <div><p>{t("failure")}</p>{code(JSON.stringify(result.error, null, 2))}</div>}
          {result.meta != null && <div><p>{t("metadata")}</p>{code(JSON.stringify(result.meta, null, 2))}</div>}
        </>}
      </div>
    </DisclosureRow>
    <div className="dsmm-role-actions">
      <p className="dsmm-role-status" role="status">{t(state)}</p>
      {props.inspect !== undefined && <Button variant="ghost" size="sm" onClick={props.inspect}>{t("inspect")}</Button>}
    </div>
  </div>;
}

/** Called once by the parent client apply(ctx), alongside the other slot registrations. */
export function registerRoleToolViews(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(ROLE_TOOL_NS, { en: roleToolEn, zh: roleToolZh }), "dsmm: role tool locale");
  ctx.effect(() => {
    const style = document.createElement("style"); style.dataset.dsmmRoleToolStyles = ""; style.textContent = styles;
    document.head.append(style); return () => style.remove();
  }, "dsmm: role tool styles");
  ctx.slots.inject("tool.call.toolview", () => {
    const disposers = [...Object.keys(roleToolKeys), "dsmm_role", "dsmm_category"].map(key => ctx.slots.register({ name: "tool.call.toolview", key, locale: ROLE_TOOL_NS }, RoleToolView));
    return () => { for (const dispose of disposers.reverse()) dispose(); };
  });
}
