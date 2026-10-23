import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { useState } from "react";
import { Button, CodeBlock, DisclosureRow, IconAgentPresetOutlineRegular, SegmentedControl, StateDot, TextShimmer } from "@deepseek-ai/dsh-client-ui-primitives";
import { actualRoleTool, preparingRoleTool, requestedRoleTool, roleToolDisplay, roleToolKeys, technicalJsonData, technicalTableRows } from "./RoleToolView-data.js";
import { ROLE_TOOL_NS, roleToolEn, roleToolZh } from "./RoleToolView-locales.js";

type Props = ToolCallViewProps & PropsLocale<typeof ROLE_TOOL_NS>;
const styles = `
.dsmm-role-tool{min-width:0;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:14px;line-height:22px}
.dsmm-role-tool .dsmm-role-heading{color:var(--dsw-alias-label-primary);height:auto;min-height:32px}
.dsmm-role-tool .dsmm-role-title{white-space:nowrap;flex:none;color:inherit;font-size:inherit;line-height:inherit}
.dsmm-role-tool .dsmm-role-text{display:inline-flex;align-items:center;min-width:0;flex:1;overflow:hidden}
.dsmm-role-tool .dsmm-role-sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}
.dsmm-role-tool .dsmm-role-summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:auto;overflow:hidden;color:var(--dsw-alias-label-secondary)}
.dsmm-role-tool .dsmm-role-icon{flex:none;color:inherit}
.dsmm-role-tool .dsmm-role-body{display:flex;flex-direction:column;gap:8px;min-width:0;padding:8px 0}
.dsmm-role-tool p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.dsmm-role-tool .dsmm-role-status{color:var(--dsw-alias-label-secondary)}
.dsmm-role-tool .dsmm-role-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dsmm-role-tool .dsmm-role-identity{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dsmm-role-tool .dsmm-role-task{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dsmm-role-tool .dsmm-role-dim{color:var(--dsw-alias-label-tertiary)}
.dsmm-role-tool .dsmm-role-section-title{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-bottom:4px}
.dsmm-role-tool .dsmm-role-details{border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px;margin-top:4px}
.dsmm-role-tool .dsmm-role-details summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;user-select:none}
.dsmm-role-tool .dsmm-role-details-body{display:flex;flex-direction:column;gap:8px;margin-top:8px;padding-left:8px}
.dsmm-role-tool .dsmm-role-details-header{display:flex;align-items:center;margin-bottom:4px}
.dsmm-role-tool .dsmm-role-view-switch{margin-bottom:4px}
.dsmm-role-tool .dsmm-role-table{width:100%;border-collapse:collapse;font-size:12px;line-height:18px;margin-top:4px}
.dsmm-role-tool .dsmm-role-table th,.dsmm-role-tool .dsmm-role-table td{padding:4px 8px;text-align:left;vertical-align:top;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsmm-role-tool .dsmm-role-table th{color:var(--dsw-alias-label-secondary);font-weight:500;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsmm-role-tool .dsmm-role-prop-cell{color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family-code,monospace);word-break:break-all;width:35%;max-width:180px}
.dsmm-role-tool .dsmm-role-val-cell{color:var(--dsw-alias-label-primary);word-break:break-word}
.dsmm-role-tool .dsmm-role-cell-text{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.dsmm-role-tool .dsmm-role-cell-code{margin:0;font-family:var(--dsw-font-family-code,monospace);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-all;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,0.04));padding:4px 6px;border-radius:4px}
.dsmm-role-tool :is(button,[role=button],summary):focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
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

  const action = props.phase === "preparing" ? t("calling") : t("call");
  const targetLabel = target === undefined ? t("unknownTarget") : roleToolDisplay(target);
  const rawDesc = requested.description?.trim();
  const singleLineDesc = rawDesc ? rawDesc.replace(/\s+/gu, " ") : undefined;
  const title = `${action} ${targetLabel}`;

  const state = result?.error?.code === "interrupted" ? "stopped" : failed ? "error" : result === undefined ? props.phase === "preparing" ? "preparing" : "running" : actual?.jobId !== undefined || actual?.mode === "continuable" ? "background" : "result";
  const isOngoing = state === "running" || props.phase === "preparing";
  const code = (value: string) => <CodeBlock code={value} copyLabel={t("copy")} copiedLabel={t("copied")} />;

  const [viewMode, setViewMode] = useState<"table" | "json">("table");
  const controlId = `dsmm-tech-${props.callId || "call"}`;
  const viewOptions = [
    { value: "table" as const, label: t("table") },
    { value: "json" as const, label: t("json") },
  ];
  const tableRows = technicalTableRows(props.toolName, props.callId, raw, result?.meta, actual?.routeSource);
  const jsonData = technicalJsonData(props.toolName, props.callId, raw, result?.meta, actual?.routeSource);

  const roleDiffers = requested.target !== undefined && actual !== undefined && actual.role !== requested.target;
  const levelDiffers = requested.level !== undefined && actual !== undefined && actual.level !== requested.level;
  const showRequestedVsActual = roleDiffers || levelDiffers;

  const collapsedContent = singleLineDesc ? <>
    <span className="dsmm-role-sep" aria-hidden="true" />
    <span className="dsmm-role-summary">
      <TextShimmer active={isOngoing}>{singleLineDesc}</TextShimmer>
    </span>
  </> : undefined;

  const stateDotState = state === "error" ? "error" : state === "stopped" ? "warning" : result === undefined ? "ongoing" : state === "background" ? "idle" : "done";

  return <div className="dsmm-role-tool" data-dsmm-role-tool={props.toolName} data-identity={actual === undefined ? "requested" : "actual"} data-state={state} data-expanded={expanded ? "true" : "false"}>
    <DisclosureRow title={title} titleClassName="dsmm-role-title" rowClassName="dsmm-role-heading" contentClassName="dsmm-role-text"
      icon={<IconAgentPresetOutlineRegular size={14} className="dsmm-role-icon" />}
      collapsedContent={collapsedContent} keepContentWhenOpen running={isOngoing}
      open={expanded} expandable onToggle={toggle} expandOnRowClick>
      <div className="dsmm-role-body">
        <p className="dsmm-role-identity">
          {showRequestedVsActual ? <>
            <span className="dsmm-role-dim">{t("requested")}: </span>
            <span>{requested.target === undefined ? t("unknown") : roleToolDisplay(requested.target)}{requested.level ? ` (${requested.level})` : ""}</span>
            <span className="dsmm-role-dim"> → </span>
            <span className="dsmm-role-dim">{t("actual")}: </span>
            <span>{roleToolDisplay(actual!.role)} ({actual!.level})</span>
          </> : <span>
            {actual !== undefined ? roleToolDisplay(actual.role) : requested.target === undefined ? t("unknownTarget") : roleToolDisplay(requested.target)}
            {(actual?.level ?? requested.level) !== undefined && ` · ${actual?.level ?? requested.level}`}
            {result !== undefined && actual === undefined && <span className="dsmm-role-dim"> · {t("actualUnknown")}</span>}
          </span>}
          {actual?.route !== undefined && <span className="dsmm-role-model">
            {" · "}{actual.route.provider}/{actual.route.model}{actual.route.reasoningEffort ? ` · ${actual.route.reasoningEffort}` : ""}
          </span>}
        </p>
        {requested.description !== undefined && <p className="dsmm-role-task">{requested.description}</p>}
        {result?.error != null && <div className="dsmm-role-failure">
          <p className="dsmm-role-section-title">{t("failure")}</p>
          {code(JSON.stringify(result.error, null, 2))}
        </div>}
        <details className="dsmm-role-details">
          <summary>{t("technicalDetails")}</summary>
          <div className="dsmm-role-details-body">
            <div className="dsmm-role-details-header">
              <SegmentedControl id={controlId} value={viewMode} options={viewOptions} onChange={setViewMode} label={t("viewMode")} className="dsmm-role-view-switch" />
            </div>
            <div id={`${controlId}-table-panel`} role="tabpanel" aria-labelledby={`${controlId}-table`} hidden={viewMode !== "table"} tabIndex={0}>
              {viewMode === "table" && <table className="dsmm-role-table">
                <thead>
                  <tr>
                    <th scope="col">{t("property")}</th>
                    <th scope="col">{t("value")}</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map(row => <tr key={row.property}>
                    <td className="dsmm-role-prop-cell">{row.property}</td>
                    <td className="dsmm-role-val-cell">
                      {row.isComplex ? <pre className="dsmm-role-cell-code">{JSON.stringify(row.value, null, 2)}</pre>
                        : typeof row.value === "string" ? <span className="dsmm-role-cell-text">{row.value}</span>
                        : <span>{row.value === null ? "null" : row.value === undefined ? "undefined" : String(row.value)}</span>}
                    </td>
                  </tr>)}
                </tbody>
              </table>}
            </div>
            <div id={`${controlId}-json-panel`} role="tabpanel" aria-labelledby={`${controlId}-json`} hidden={viewMode !== "json"} tabIndex={0}>
              {viewMode === "json" && code(JSON.stringify(jsonData, null, 2))}
            </div>
          </div>
        </details>
      </div>
    </DisclosureRow>
    <div className="dsmm-role-actions">
      <StateDot state={stateDotState} />
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
