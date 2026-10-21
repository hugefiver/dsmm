import { useEffect, useId, useSyncExternalStore } from "react";
import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { PermissionRule, PermissionRuleDraft, PermissionRuleMatch } from "../permission-rules.js";
import type { PermissionRuleAction } from "../permission-settings.js";
import type { PermissionController, PermissionView } from "./permission-controller.js";
import { displayUnconfirmed, observedRules } from "./permission-controller.js";
import type { PermissionIssue } from "./permission-client.js";
import type { PermissionLocaleKey } from "./permission-locales.js";

type Locale = PropsLocale<"settings.dsmm-permissions">;
export type PermissionsPanelProps = Locale & { controller: PermissionController; sessionId?: string };
const actions: readonly PermissionRuleAction[] = ["inherit", "allow", "ask", "deny"];
const kinds: readonly PermissionRuleMatch["kind"][] = ["outside-read", "shell", "webSearch", "webFetch"];
const ruleDraft = (rule: PermissionRule): PermissionRuleDraft => ({ id: rule.id, action: rule.action, match: structuredClone(rule.match) });
const newMatch = (kind: PermissionRuleMatch["kind"]): PermissionRuleMatch => kind === "outside-read" ? { kind, path: "", scope: "exact" } : kind === "shell" ? { kind, executable: "", command: "", workingDirectory: "" } : { kind };
function Issue({ value, t }: Locale & { value: PermissionIssue | null }) { return value === null ? null : <p className="dsmm-issue" role="alert">{t(`issue:${value}`)} <code>{value}</code></p>; }
function RootState({ state, t }: Locale & { state: PermissionView }) {
  return <><p>{t("root")}: {t(state.scope === "root" && state.connected ? "active" : "unknown")}</p>
    {state.scope !== "root" && <p className="dsmm-hint">{t(state.scope === "child" ? "child" : "noRoot")}</p>}
    {!state.connected && <p className="dsmm-hint">{t("unknown")}</p>}</>;
}
function ActionSelect({ id, value, inherit = true, onChange, disabled, t }: Locale & { id: string; value: PermissionRuleAction; inherit?: boolean; disabled: boolean; onChange(value: PermissionRuleAction): void }) {
  return <select id={id} value={value} disabled={disabled} onChange={event => { const choice = actions.find(value => value === event.currentTarget.value); if (choice !== undefined) onChange(choice); }}>
    {actions.filter(value => inherit || value !== "inherit").map(value => <option key={value} value={value}>{t(value === "inherit" ? "inherit" : `action:${value}`)}</option>)}</select>;
}
function RuleEditor({ controller, state, t }: Locale & { controller: PermissionController; state: PermissionView }) {
  const id = useId(), editor = state.draft?.editor;
  if (editor == null) return null;
  const disabled = !controller.canEdit(state.generation), change = (value: PermissionRuleDraft) => controller.edit(state.generation, { editor: value });
  const field = (key: "path" | "executable" | "command" | "workingDirectory", label: PermissionLocaleKey) => <div className="dsmm-field"><label htmlFor={`${id}-${key}`}>{t(label)}</label>
    <Input className="dsmm-input" id={`${id}-${key}`} required maxLength={32768} disabled={disabled} value={key in editor.match ? String(Reflect.get(editor.match, key)) : ""} onChange={event => change({ ...editor, match: { ...editor.match, [key]: event.currentTarget.value } })} /></div>;
  return <form className="dsmm-structured" aria-label={t("editor")} onSubmit={event => { event.preventDefault(); controller.stageRule(state.generation); }}>
    <div className="dsmm-field"><label htmlFor={`${id}-id`}>{t("id")}</label><Input className="dsmm-input" id={`${id}-id`} required maxLength={256} value={editor.id} disabled={disabled} onChange={event => change({ ...editor, id: event.currentTarget.value })} /></div>
    <div className="dsmm-field"><label htmlFor={`${id}-action`}>{t("action")}</label><ActionSelect id={`${id}-action`} value={editor.action} disabled={disabled} inherit={false} t={t} onChange={action => { if (action !== "inherit") change({ ...editor, action }); }} /></div>
    <div className="dsmm-field"><label htmlFor={`${id}-kind`}>{t("match")}</label><select id={`${id}-kind`} value={editor.match.kind} disabled={disabled} onChange={event => { const kind = kinds.find(value => value === event.currentTarget.value); if (kind !== undefined) change({ ...editor, match: newMatch(kind) }); }}>
      {kinds.map(kind => <option key={kind} value={kind}>{t(`kind:${kind}`)}</option>)}</select></div>
    {editor.match.kind === "outside-read" && <>{field("path", "path")}<div className="dsmm-field"><label htmlFor={`${id}-path-scope`}>{t("pathScope")}</label><select id={`${id}-path-scope`} value={editor.match.scope} disabled={disabled} onChange={event => { const scope = event.currentTarget.value; if (editor.match.kind === "outside-read" && (scope === "exact" || scope === "tree")) change({ ...editor, match: { ...editor.match, scope } }); }}><option value="exact">{t("exact")}</option><option value="tree">{t("tree")}</option></select></div></>}
    {editor.match.kind === "shell" && <>{field("executable", "executable")}{field("command", "command")}{field("workingDirectory", "cwd")}</>}
    <div className="dsmm-actions"><Button type="submit" variant="outline" disabled={disabled}>{t("stage")}</Button><Button type="button" variant="outline" disabled={disabled} onClick={() => controller.edit(state.generation, { editor: null })}>{t("cancel")}</Button></div>
  </form>;
}
function RuleRecords({ controller, state, t }: Locale & { controller: PermissionController; state: PermissionView }) {
  const records = observedRules(state)?.snapshot.policy.rules ?? state.base?.policy.rules;
  return <div className="dsmm-structured">{records?.length === 0 && <p>{t("noRules")}</p>}{records?.map(rule => <fieldset key={rule.id}><legend>{rule.id}</legend>
    <p>{t(rule.revoked ? "revoked" : "active")} · {t(`action:${rule.action}`)}</p><dl className="dsmm-child-meta"><dt>{t("match")}</dt><dd>{t(`kind:${rule.match.kind}`)}</dd>
      {rule.match.kind === "outside-read" && <><dt>{t("path")}</dt><dd>{rule.match.path} · {t(rule.match.scope)}</dd></>}
      {rule.match.kind === "shell" && <><dt>{t("executable")}</dt><dd>{rule.match.executable}</dd><dt>{t("command")}</dt><dd><code>{rule.match.command}</code></dd><dt>{t("cwd")}</dt><dd>{rule.match.workingDirectory}</dd></>}
      <dt>{t("source")}</dt><dd>{t(rule.source.kind === "operator" ? "operator" : "imported")}</dd></dl>
    <div className="dsmm-actions"><Button type="button" variant="outline" disabled={!controller.canEdit(state.generation) || state.draft === null} onClick={() => controller.edit(state.generation, { editor: ruleDraft(rule) })}>{t("editRule")}</Button>
      <Button type="button" variant="outline" disabled={!controller.canEdit(state.generation) || state.draft === null || rule.revoked || state.draft.revoke.includes(rule.id)} onClick={() => controller.stageRevoke(state.generation, rule.id)}>{t("stageRevoke")}</Button></div>
  </fieldset>)}</div>;
}
function PermissionCoverage({ state, t }: Locale & { state: PermissionView }) {
  const value = observedRules(state)?.capabilities;
  return <section className="dsmm-structured" aria-label={t("coverageTitle")}><h3>{t("coverageTitle")}</h3>
    <p className="dsmm-hint">{t("matchHint")}</p>
    <p className="dsmm-hint">{t("networkLimit")}</p>
    <p className="dsmm-hint">{t("coverage")}</p>
    <p className="dsmm-hint">{t("registrationUnresolved")}</p>
    {value === undefined ? <p>{t("coverageUnavailable")}</p> : <>
      <dl className="dsmm-child-meta"><dt>{t("coverageRuntime")}</dt><dd>{t(value.runtime.state)} · {t("mounted")}: {t(value.runtime.mounted ? "on" : "off")}</dd></dl>
      {value.runtime.restartRequired && <p>{t("restart")}</p>}
      {value.tools.length === 0 ? <p>{t("coverageEmpty")}</p> : <ul className="dsmm-profile-list">{value.tools.map(tool => <li key={tool.name}>
        <dl className="dsmm-child-meta"><dt>{t("toolName")}</dt><dd><code>{tool.name}</code></dd><dt>{t("toolKind")}</dt><dd><code>{tool.kind}</code></dd>
          <dt>{t("toolApproval")}</dt><dd>{t("nativeOnce")}</dd><dt>{t("toolMemory")}</dt><dd>{t("notProvided")}</dd></dl>
      </li>)}</ul>}
      <dl className="dsmm-child-meta"><dt>{t("outsideReads")}</dt><dd>{t("limit:outsideReads")}</dd><dt>{t("finalInode")}</dt><dd>{t("limit:finalInode")}</dd>
        <dt>{t("toolMemory")}</dt><dd>{t("limit:scopedMemory")}</dd><dt>{t("webFetch")}</dt><dd>{t("limit:webFetch")}</dd>
        <dt>{t("searchDestinations")}</dt><dd>{t("limit:webSearchDestinations")}</dd><dt>{t("proxyBinding")}</dt><dd>{t("limit:proxyAddressBinding")}</dd>
        <dt>{t("shellSockets")}</dt><dd>{t("limit:shellSockets")}</dd><dt>{t("providerAuthMcp")}</dt><dd>{t("limit:providerAuthMcp")}</dd></dl>
    </>}
    <p className="dsmm-hint">{t("pathEvidence")}</p>
  </section>;
}
export function PermissionRulesEditor({ controller, state, t }: Locale & { controller: PermissionController; state: PermissionView }) {
  const id = useId(), draft = state.draft, disabled = !controller.canEdit(state.generation), value = observedRules(state), observedPolicy = value?.snapshot ?? null;
  const writable = state.scope === "root" && state.connected;
  return <section className="dsmm-zone" aria-label={t("rules")}><h3>{t("rules")}</h3><p className="dsmm-hint">{t("rulesHint")}</p><Issue value={state.rulesIssue} t={t} />
    {displayUnconfirmed(state) && <p className="dsmm-hint">{t("unconfirmedObservation")}</p>}
    <p className="dsmm-hint">{t("observedPolicy")}</p><dl className="dsmm-child-meta"><dt>{t("profileOverrideState")}</dt><dd>{t("profileOverrideUnknown")}</dd></dl>
    <dl className="dsmm-child-meta"><dt>{t("runtime")}</dt><dd>{value === null ? t("unknown") : t(value.runtime.state)}</dd>
      <dt>{t("mounted")}</dt><dd>{value === null ? t("unknown") : t(value.runtime.mounted ? "on" : "off")}</dd></dl>
    {value?.runtime.restartRequired && <p>{t("restart")}</p>}
    {disabled && !state.reading && !displayUnconfirmed(state) && <p className="dsmm-hint">{t("rulesUnavailable")}</p>}
    {observedPolicy !== null && <dl className="dsmm-child-meta"><dt>permissionControl.enabled</dt><dd>{t(observedPolicy.policy.enabled ? "on" : "off")} · {t("coldHint")}</dd>
      <dt>permissionControl.nativeCommands.enabled</dt><dd>{t(observedPolicy.policy.nativeCommands.enabled ? "on" : "off")}</dd></dl>}
    <details className="dsmm-deployment-group"><summary>{t("coverageDetails")}</summary><PermissionCoverage state={state} t={t} /></details>
    {draft !== null && <><div className="dsmm-field"><label htmlFor={`${id}-outside`}>{t("outsideReads")}</label><ActionSelect id={`${id}-outside`} value={draft.outsideReads} disabled={disabled} t={t} onChange={outsideReads => controller.edit(state.generation, { outsideReads })} /></div>
      {(["webSearch", "webFetch"] as const).map(key => <fieldset key={key}><legend>{t(key)}</legend><label className="dsmm-actions" htmlFor={`${id}-${key}-enabled`}><input type="checkbox" id={`${id}-${key}-enabled`} checked={draft[key].enabled} disabled={disabled} onChange={event => controller.edit(state.generation, { [key]: { ...draft[key], enabled: event.currentTarget.checked } })} />{t("enabled")}</label>
        <div className="dsmm-field"><label htmlFor={`${id}-${key}-rule`}>{t("rule")}</label><ActionSelect id={`${id}-${key}-rule`} value={draft[key].rule} disabled={disabled} t={t} onChange={rule => controller.edit(state.generation, { [key]: { ...draft[key], rule } })} /></div></fieldset>)}
      <Button type="button" variant="outline" disabled={disabled || draft.editor !== null} onClick={() => controller.edit(state.generation, { editor: { id: "", action: "ask", match: newMatch("outside-read") } })}>{t("newRule")}</Button>
      <RuleEditor controller={controller} state={state} t={t} />
      {(draft.upsert.length > 0 || draft.revoke.length > 0) && <div className="dsmm-structured"><h3>{t("staged")}</h3>{draft.upsert.map(row => <div className="dsmm-field" key={row.id}><p>{row.id} · {t(`kind:${row.match.kind}`)} · {t(`action:${row.action}`)}</p><Button type="button" variant="outline" disabled={disabled} onClick={() => controller.edit(state.generation, { upsert: draft.upsert.filter(rule => rule.id !== row.id) })}>{t("unstage")}: {row.id}</Button></div>)}
        {draft.revoke.map(ruleId => <div className="dsmm-field" key={ruleId}><p>{t("stageRevoke")}: {ruleId}</p><Button type="button" variant="outline" disabled={disabled} onClick={() => controller.edit(state.generation, { revoke: draft.revoke.filter(id => id !== ruleId) })}>{t("unstage")}: {ruleId}</Button></div>)}</div>}
    </>}
    <RuleRecords state={state} controller={controller} t={t} />
    <div className="dsmm-actions"><Button type="button" variant="primary" disabled={!controller.canSave(state.generation)} onClick={() => void controller.save(state.generation)}>{t("save")}</Button>
      <Button type="button" variant="outline" disabled={!writable || state.reading || state.busy !== null} onClick={() => void controller.refresh(state.generation)}>{t("refresh")}</Button>
      <Button type="button" variant="outline" disabled={!writable || state.reading || state.busy !== null || !state.dirty && state.rulesIssue === null} onClick={() => void controller.refresh(state.generation, true)}>{t("discard")}</Button></div>
    {state.dirty && <p>{t("dirty")}</p>}
  </section>;
}
export function PermissionsPanel({ controller, t, sessionId }: PermissionsPanelProps) {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  useEffect(() => controller.watch(), [controller]);
  if (sessionId !== undefined && sessionId !== state.sessionId) return <p className="dsmm-hint" role="status">{t("rulesUnavailable")}</p>;
  // Silent revalidation never flips the region busy; a save reports through its own status line.
  return <section className="dsmm-profiles dsmm-children dsmm-permissions" data-dsmm-permissions aria-label={t("title")} aria-busy={state.reading}>
    <h2>{t("title")}</h2><RootState state={state} t={t} /><p className="dsmm-hint">{t("nativeApproval")} {t("sandboxScope")}</p>
    <p className="dsmm-status" role="status" aria-live="polite">{state.busy !== null ? t("busy") : state.reading ? t("reading") : state.notice === null ? "" : t(state.notice)}</p>
    <PermissionRulesEditor controller={controller} state={state} t={t} />
  </section>;
}
