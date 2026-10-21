import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { ConfigForms } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { DsmmConfigRemote } from "../profile-remote.js";
import type { SubagentRuntimeAdmissionView } from "../profile-types.js";
import type { DeploymentController } from "./deployment-controller.js";
import type { PermissionController } from "./permission-controller.js";
import { deploymentWorkspace } from "./deployment-workspace.js";
import type { ConfigScope, DeploymentWorkspace } from "./deployment-workspace.js";
import { NAVIGATION_MODULES, moduleFields, moduleFor, moduleTitle } from "./deployment-modules.js";
import type { ConfigModule } from "./deployment-modules.js";
import { at, inspectorPaths, scopeSchema, visibleDeploymentPath } from "./deployment-data.js";
import { Field, displayValue, permissionText } from "./DeploymentFields.js";
import { configurationVersionState } from "./configuration-display.js";
import { PermissionsPanel } from "./PermissionsPanel.js";
import { permissionEn } from "./permission-locales.js";
import type { PermissionLocaleKey } from "./permission-locales.js";

type Locale = PropsLocale<"plugins.dsmm">;
export interface DeploymentPageProps extends Locale {
  view: "summary" | "page";
  core: DeploymentController;
  remote: DsmmConfigRemote;
  workspace?: DeploymentWorkspace;
  permissions?: PermissionController;
  permissionsT?: PropsLocale<"settings.dsmm-permissions">["t"];
  forms?: ConfigForms;
}
export function ScopeSave({ controller, workspace, refreshOnly = false, t }: Locale & { controller: DeploymentController; workspace?: DeploymentWorkspace; refreshOnly?: boolean }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const pending = [...new Set(controller.pendingPaths().map(moduleFor))];
  return <section className="dsmm-scope-save" aria-label={t("saveScope")}>
    <p className="dsmm-status" role="status" aria-live="polite">{refreshOnly ? state.busy ? t("loading") : "" : state.busy ? t("saving") : state.refreshRequired ? t("savedRefreshRequired") : state.saved ? t("saved") : state.dirty ? t("dirty") : ""}</p>
    {!refreshOnly && pending.length > 0 && <p>{t("pendingModules")}: {pending.map(module => t(moduleTitle(module))).join(" · ")}</p>}
    {state.issue !== null && <p className="dsmm-issue" role="alert">{t(state.issue)}</p>}
    {!refreshOnly && state.invalidFields.length > 0 && <p className="dsmm-issue" role="alert">{t("invalid")}</p>}
    {controller.layer === "profile" && !controller.canWriteProfile() && <p className="dsmm-hint">{t("unavailableForm")}</p>}
    <div className="dsmm-actions">{!refreshOnly && <Button type="button" variant="primary" disabled={!controller.canSave()} onClick={() => void (workspace?.save() ?? controller.save())}>{t(controller.layer === "global" ? "saveGlobal" : "saveProfile")}</Button>}
      <Button type="button" variant="outline" disabled={state.busy} onClick={() => void controller.refresh()}>{t("refresh")}</Button>
      {!refreshOnly && <Button type="button" variant="outline" disabled={state.busy || !state.dirty && state.issue === null && !state.refreshRequired} onClick={() => void controller.refresh(true)}>{t("discard")}</Button>}</div>
  </section>;
}
export function NativeRuntimeState({ value, t }: Locale & { value?: SubagentRuntimeAdmissionView }) {
  return <details className="dsmm-availability"><summary>{t("nativeRuntimeState")}</summary>
    <p>{t("nativeRuntimeBinding")}: {t(value?.binding === "stock" ? "nativeRuntimeStock" : value?.binding === "unavailable" ? "nativeRuntimeUnavailable" : "unknown")}</p>
    <p>{t("nativeRuntimeFence")}: {value === undefined ? t("unknown") : t(value.deliveryFenceReady ? "on" : "off")} · {t("nativeRuntimeRestart")}: {value === undefined ? t("unknown") : t(value.restartRequired ? "on" : "off")}</p>
    {value?.reason !== undefined && <p>{t(`nativeRuntimeReason-${value.reason}`)}</p>}
  </details>;
}
export function StateInspector({ controller, t }: Locale & { controller: DeploymentController }) {
  const { snapshot, session, dirty, issue } = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  if (snapshot === null) return <p>{t("unavailable")}</p>;
  const admitted = session?.configuration ?? null;
  const source = (value: string | undefined): string => t(value === "profile" ? "profileSource" : value === "global" ? "globalSource" : value === "defaults" ? "defaultsSource" : value === "named-session" ? "namedSource" : value === "startup" ? "startupSource" : value === "deployment" ? "deploymentCapture" : value === "mixed" ? "mixedSource" : "unknown");
  const value = (layer: Record<string, unknown> | undefined, path: string) => layer === undefined ? t("unknown") : at(layer, path.split(".")) === undefined ? t("absent") : displayValue(at(layer, path.split(".")), t);
  const restart = (snapshot.nextRoot?.restartRequired ?? []).filter(path => visibleDeploymentPath(path.split(".")));
  return <div className="dsmm-structured"><p role="status">{session === null ? t("noSession") : admitted === null ? t("sessionUnavailable") : t("sessionObserved")}</p>
    {(dirty || issue !== null) && <p className="dsmm-hint">{t("inspectorStale")}</p>}
    <p>{t("globalSource")}: {t(configurationVersionState(snapshot.globalRevision))} · {t("profileSource")}: {t(configurationVersionState(snapshot.nativeRevision))}</p>
    {snapshot.subagentRuntime !== undefined && <NativeRuntimeState value={snapshot.subagentRuntime} t={t} />}
    {snapshot.modules.map(module => <section className="dsmm-zone" key={module.descriptor.id}><h3>{module.descriptor.label}</h3>
      <p>{t("desired")}: {t(module.desired.enabled ? "on" : "off")} · {source(module.desired.source)}</p>
      <p>{t("startup")}: {module.startupMounted == null ? t("unknown") : t(module.startupMounted ? "on" : "off")}</p>
      <p>{t("next")}: {module.nextRoot.admitted == null ? t("unknown") : t(module.nextRoot.admitted ? "on" : "off")}</p>{module.pending && <p>{t("pending")}</p>}</section>)}
    {inspectorPaths(snapshot, admitted).map(path => <dl key={path} className="dsmm-deployment-state"><dt>{path}</dt>
      <dd>{t("desired")}: {value(snapshot.desired, path)} · {source(snapshot.sources[path])}</dd>
      <dd>{t("startup")}: {value(snapshot.startup, path)} · {source(snapshot.startupSources?.[path])}</dd>
      <dd>{t("next")}: {value(snapshot.nextRoot?.settings, path)} · {source(snapshot.nextRoot?.sources[path])}</dd>
      <dd>{t("session")}: {value(admitted?.settings, path)} · {source(admitted?.sources[path])}</dd>
    </dl>)}{restart.length > 0 && <p>{t("pending")}: {restart.join(", ")}</p>}
  </div>;
}
export function DeploymentPage(props: DeploymentPageProps) {
  const workspace = props.workspace ?? deploymentWorkspace(props.core, props.permissions);
  const navigation = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const core = useSyncExternalStore(props.core.subscribe, props.core.getSnapshot);
  const controller = workspace.controller() ?? props.core;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const id = useId(), heading = useRef<HTMLHeadingElement>(null), triggers = useRef(new Map<ConfigModule, HTMLButtonElement>()), previous = useRef<ConfigModule | null>(null);
  const scopeControl = useRef<HTMLSelectElement>(null), confirmation = useRef<HTMLButtonElement>(null);
  const resume = useRef<{ element: HTMLElement; scope: ConfigScope; module: ConfigModule | null } | null>(null);
  const disclosures = useRef({ global: new Map<string, boolean>(), profile: new Map<string, boolean>() });
  const { t } = props, snapshot = state.snapshot ?? core.snapshot, active = navigation.module;
  useEffect(() => { if (props.view === "page") void props.core.refresh(); }, [props.core, props.view]);
  useEffect(() => { if (props.forms !== undefined) workspace.bindForms(props.forms); }, [workspace, props.forms]);
  // First visit opens the first section with editable fields (or Configuration state).
  useEffect(() => {
    if (navigation.module === null && core.snapshot !== null) workspace.request({ scope: navigation.scope, module: null });
  }, [core.snapshot, navigation.module, navigation.scope, workspace]);
  useEffect(() => {
    if (active !== null) heading.current?.focus(); else if (previous.current !== null) triggers.current.get(previous.current)?.focus();
    previous.current = active;
  }, [active]);
  useEffect(() => {
    if (navigation.pending !== null) { resume.current = { element: document.activeElement as HTMLElement, scope: navigation.scope, module: active }; confirmation.current?.focus(); }
    else if (resume.current !== null) {
      const from = resume.current; resume.current = null;
      if (from.scope === navigation.scope && from.module === active) { if (from.element.isConnected) from.element.focus(); }
      else if (active !== null) heading.current?.focus();
      else if (from.scope !== navigation.scope) scopeControl.current?.focus();
    }
  }, [navigation.pending, navigation.scope, active]);
  if (props.view === "summary") return <span>{t("summary")}</span>;
  const fields = snapshot === null || active === null ? [] : moduleFields(scopeSchema(snapshot, controller.layer), active, controller.layer);
  const tabs = NAVIGATION_MODULES.filter(module => module !== "other" || snapshot === null
    || moduleFields(snapshot.schema, "other", "global").length + moduleFields(scopeSchema(snapshot, "profile"), "other", "profile").length > 0);
  const select = (module: ConfigModule) => workspace.request({ scope: navigation.scope, module });
  const onTabKey = (event: { key: string; preventDefault(): void }, index: number) => {
    const last = tabs.length - 1, move = (target: number) => { const next = tabs[(target + tabs.length) % tabs.length]; triggers.current.get(next)?.focus(); };
    if (event.key === "ArrowRight") move(index + 1);
    else if (event.key === "ArrowLeft") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(last);
    else return;
    event.preventDefault();
  };
  const scopeActions = <ScopeSave controller={active === "state" ? props.core : controller} workspace={workspace} refreshOnly={active === "state" || workspace.controller() === null} t={t} />;
  return <section className="dsmm-profiles dsmm-deployment" data-dsmm-page aria-label={t("title")}>
    <p className="dsmm-hint">{t("boundaries")}</p>
    <div className="dsmm-field"><label htmlFor={`${id}-scope`}>{t("scope")}</label><select ref={scopeControl} id={`${id}-scope`} value={navigation.scope} disabled={state.busy || navigation.pending !== null} onChange={event => {
      const scope = event.currentTarget.value; if (scope === "global" || scope === "profile") workspace.request({ scope, module: null });
    }}><option value="global">{t("global")}</option><option value="profile">{t("profile")}</option></select></div>
    <p className="dsmm-hint">{t(navigation.scope === "global" ? "globalHint" : "profileHint")}</p>
    {navigation.scope === "profile" && (navigation.native === null || !navigation.native.canWriteProfile()) && <p className="dsmm-hint">{t("unavailableForm")}</p>}
    <div className="dsmm-section-tabs" role="tablist" aria-label={t("modules")}>{tabs.map((module, index) => <Button key={module} ref={element => { if (element !== null) triggers.current.set(module, element); else triggers.current.delete(module); }} role="tab" type="button"
      id={`${id}-tab-${module}`} aria-selected={active === module} aria-controls={`${id}-panel`} tabIndex={active === module ? 0 : -1} data-dsmm-tab={module}
      onKeyDown={event => onTabKey(event, index)} onClick={() => select(module)}>{t(moduleTitle(module))}</Button>)}</div>
    {active !== null && <section id={`${id}-panel`} role="tabpanel" className="dsmm-section-panel" aria-labelledby={`${id}-tab-${active}`} data-dsmm-module={active}>
      <div className="dsmm-panel-heading"><h2 id={`${id}-heading`} ref={heading} tabIndex={-1}>{t(moduleTitle(active))}</h2></div>
      {active === "state" ? <><StateInspector controller={props.core} t={t} />{scopeActions}</> : <>
        {navigation.scope === "profile" && navigation.native === null ? <p>{t("unavailableForm")}</p> : state.snapshot === null ? <p>{t(state.busy ? "loading" : "unavailable")}</p> : <div data-dsmm-layer={controller.layer} aria-busy={state.busy} className="dsmm-structured">
          {fields.length === 0 && <p className="dsmm-hint">{t("noModuleFields")}</p>}
          {fields.map(([key, schema]) => <Field key={`${navigation.scope}:${key}`} schema={schema} path={[key]} controller={controller} initiallyOpen={fields.length === 1 && active !== "permissions"} disclosures={disclosures.current[navigation.scope]} t={t} />)}
          {active === "run" && controller.layer === "profile" && <NativeRuntimeState value={state.snapshot.subagentRuntime} t={t} />}
        </div>}
        {scopeActions}
        {active === "permissions" && <section className="dsmm-zone dsmm-rules-transaction" aria-label={t("rootRules")}>{workspace.permissions === undefined ? <p>{t("rootRulesUnavailable")}</p> : <PermissionsPanel controller={workspace.permissions} t={props.permissionsT ?? (key => Object.hasOwn(permissionEn, key) ? permissionText(t)(key as PermissionLocaleKey) : key)} />}</section>}
      </>}
    </section>}
    {navigation.pending !== null && <section className="dsmm-confirm" role="group" aria-label={t("leaveDraft")} onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); workspace.continueEditing(); } }}><p>{t("leaveDraft")}</p><div className="dsmm-actions">
      <Button ref={confirmation} type="button" variant="primary" onClick={() => workspace.continueEditing()}>{t("continueEditing")}</Button>
      <Button type="button" variant="outline" onClick={() => workspace.keepAndNavigate()}>{t("keepDraft")}</Button>
      <Button type="button" variant="outline" disabled={state.busy} onClick={() => void workspace.discardAndNavigate()}>{t("discardDraft")}</Button>
    </div></section>}
  </section>;
}
