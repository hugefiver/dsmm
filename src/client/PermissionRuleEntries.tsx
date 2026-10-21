import { useId, useSyncExternalStore } from "react";
import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import { parsePermissionRules } from "../permission-rules.js";
import type { PermissionRule, PermissionRuleMatch } from "../permission-rules.js";
import type { DeploymentController } from "./deployment-controller.js";
import { parseAdvanced } from "./deployment-data.js";
import type { PermissionLocaleKey } from "./permission-locales.js";

type Text = (key: PermissionLocaleKey) => string;
const actions: readonly PermissionRule["action"][] = ["allow", "ask", "deny"];
const kinds: readonly PermissionRuleMatch["kind"][] = ["outside-read", "shell", "webSearch", "webFetch"];
const name = "permissionControl.rules";
export function validPermissionRules(value: unknown): boolean {
  try { parsePermissionRules(value); return true; } catch { return false; }
}
function newMatch(kind: PermissionRuleMatch["kind"]): PermissionRuleMatch {
  return kind === "outside-read" ? { kind, path: "", scope: "exact" } : kind === "shell" ? { kind, executable: "", command: "", workingDirectory: "" } : { kind };
}
/** Honest user-import provenance; the Host re-stamps it and owns revision/revocation. */
function newRule(): PermissionRule {
  return { id: "", action: "ask", match: newMatch("outside-read"), source: { kind: "user-import", label: "configuration" }, revision: 0, revoked: false };
}
function Row({ rule, index, disabled, change, remove, t }: {
  rule: PermissionRule; index: number; disabled: boolean; change(value: PermissionRule): void; remove(): void; t: Text;
}) {
  const id = useId();
  const field = (key: "path" | "executable" | "command" | "workingDirectory") => <div className="dsmm-field"><label htmlFor={`${id}-${key}`}>{t(key === "workingDirectory" ? "cwd" : key)}</label>
    <Input className="dsmm-input" id={`${id}-${key}`} required maxLength={32768} disabled={disabled} value={key in rule.match ? String(Reflect.get(rule.match, key)) : ""} onChange={event => change({ ...rule, match: { ...rule.match, [key]: event.currentTarget.value } })} /></div>;
  return <fieldset><legend>{rule.id === "" ? `${t("newRule")} ${index + 1}` : rule.id}</legend>
    <p>{t(rule.revoked ? "revoked" : "active")} · {t(`action:${rule.action}`)}</p>
    <dl className="dsmm-child-meta"><dt>{t("source")}</dt><dd>{rule.source.kind === "operator" ? `${t("recordedOperator")} · ${rule.source.savedAt}` : `${t("imported")} · ${rule.source.label}`}</dd>
      <dt>{t("recordVersion")}</dt><dd>{rule.revision}</dd></dl>
    <div className="dsmm-field"><label htmlFor={`${id}-id`}>{t("id")}</label><Input className="dsmm-input" id={`${id}-id`} required maxLength={256} disabled={disabled} value={rule.id} onChange={event => change({ ...rule, id: event.currentTarget.value })} /></div>
    <div className="dsmm-field"><label htmlFor={`${id}-action`}>{t("action")}</label><select id={`${id}-action`} disabled={disabled} value={rule.action} onChange={event => {
      const action = actions.find(value => value === event.currentTarget.value); if (action !== undefined) change({ ...rule, action });
    }}>{actions.map(action => <option key={action} value={action}>{t(`action:${action}`)}</option>)}</select></div>
    <div className="dsmm-field"><label htmlFor={`${id}-kind`}>{t("match")}</label><select id={`${id}-kind`} disabled={disabled} value={rule.match.kind} onChange={event => {
      const kind = kinds.find(value => value === event.currentTarget.value); if (kind !== undefined) change({ ...rule, match: newMatch(kind) });
    }}>{kinds.map(kind => <option key={kind} value={kind}>{t(`kind:${kind}`)}</option>)}</select></div>
    {rule.match.kind === "outside-read" && <>{field("path")}<div className="dsmm-field"><label htmlFor={`${id}-scope`}>{t("pathScope")}</label><select id={`${id}-scope`} disabled={disabled} value={rule.match.scope} onChange={event => {
      const scope = event.currentTarget.value; if (rule.match.kind === "outside-read" && (scope === "exact" || scope === "tree")) change({ ...rule, match: { ...rule.match, scope } });
    }}><option value="exact">{t("exact")}</option><option value="tree">{t("tree")}</option></select></div></>}
    {rule.match.kind === "shell" && <>{field("executable")}{field("command")}{field("workingDirectory")}</>}
    <Button type="button" variant="outline" disabled={disabled} onClick={remove}>{t("removeRule")} {index + 1}</Button>
  </fieldset>;
}
export function PermissionRuleEntries({ value, inherited, controller, disabled, onChange, expanded, onExpandedChange, t }: {
  value: readonly PermissionRule[] | undefined; inherited: readonly PermissionRule[]; controller: DeploymentController; disabled: boolean;
  onChange(value: readonly PermissionRule[] | undefined): void; expanded?: boolean; onExpandedChange?(expanded: boolean): void; t: Text;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot), id = useId();
  const raw = state.raw[name], locked = raw?.invalid === true, entries = value ?? inherited, valid = validPermissionRules(entries);
  const text = raw?.text ?? (value === undefined ? "" : JSON.stringify(value, null, 2));
  const change = (next: readonly PermissionRule[]) => {
    // Any structured edit supersedes an invalid raw list; that replacement is explicit, not silent.
    if (raw !== undefined) controller.clearRaw(name);
    controller.setInvalid(name, !validPermissionRules(next)); onChange(next);
  };
  const remove = (index: number) => change(entries.filter((_, position) => position !== index));
  const held = disabled || locked;
  const isGlobal = controller.layer === "global";
  const unsetLabel = isGlobal ? t("useDefaults") : t("restoreInheritance");
  return <details className="dsmm-deployment-group" data-field={name} open={expanded} onToggle={event => onExpandedChange?.(event.currentTarget.open)}><summary>{t("configRules")} <code>{name}</code></summary><div className="dsmm-structured">
    <p className="dsmm-hint">{t("configRulesHint")}</p>
    {!valid && <p className="dsmm-issue" role="alert">{t("invalidRule")}</p>}
    {entries.length === 0 && <p>{t("configRulesEmpty")}</p>}
    {entries.map((rule, index) => <Row key={index} rule={rule} index={index} disabled={held} t={t}
      change={next => change(entries.map((row, position) => position === index ? next : row))} remove={() => remove(index)} />)}
    <div className="dsmm-actions"><Button type="button" variant="outline" disabled={held || entries.length >= 1024} onClick={() => change([...entries, newRule()])}>{t("addRule")}</Button>
      <Button type="button" variant="outline" data-dsmm-unset={name} disabled={disabled || value === undefined && raw === undefined} onClick={() => { controller.clearRaw(name); onChange(undefined); }}>{unsetLabel}</Button></div>
    <details><summary id={`${id}-advanced-label`}>{t("advancedRules")}</summary><div className="dsmm-field">
      <textarea id={`${id}-advanced`} rows={6} maxLength={32768} value={text} disabled={disabled} aria-labelledby={`${id}-advanced-label`} aria-invalid={locked} aria-describedby={`${id}-error`} onChange={event => {
        const next = event.currentTarget.value; let parsed: unknown, ok = false;
        try { parsed = parseAdvanced(next); ok = parsed === undefined || validPermissionRules(parsed); } catch { ok = false; }
        controller.setRaw(name, next, !ok); if (ok) onChange(parsed as readonly PermissionRule[] | undefined);
      }} /><p id={`${id}-error`} className="dsmm-hint">{locked ? t("invalidRule") : ""}</p>
    </div></details>
  </div></details>;
}
