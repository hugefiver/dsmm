import { useEffect, useId, useRef, useState } from "react";
import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { ProfilesActions, ProfilesController, ProfilesViewSnapshot } from "./controller.js";
import { canReconcileSelection } from "./controller.js";
import { AdvancedSettings, RouteFields } from "./StructuredEditor.js";
import { ProfileModelsDialog } from "./ProfileModelsDialog.js";
import { SessionScope, SessionScopeFeedback } from "./SessionProfiles.js";
import { sessionProfileLabels } from "./session-labels.js";
import { structuredDocument } from "./structured.js";
import type { StructuredDocument } from "./structured.js";
import { draftWarnings, IssueDetails, issueKey, ProfileWarnings } from "./diagnostics.js";
import { configurationVersionState, sourceRelationship } from "./configuration-display.js";
import { DSMM_LOCALES } from "../profile-locale.js";
import { DSMM_RATE_LIMIT_BOUNDS } from "../routing-policy.js";
import type { ProfileDiagnosticLocation } from "../profile-types.js";

export type ProfilesInjected = ProfilesActions & { hooks: { profiles: ProfilesController["store"] } };
export type ProfilesSectionProps = InjectFace<ProfilesInjected> & PropsLocale<"settings.dsmm-profiles">;

function locateGlobalField(container: HTMLElement, field: string): HTMLElement | null {
  const path = field.replace(/^settings\./, "");
  const selectors: Record<string, string> = {
    "runtimePolicy.strategy": "select[id$='-strategy']",
    "guards.gitWriteGuard": "select[id$='-git-guard']",
    "guards.gitWriteScope": "select[id$='-git-scope']",
    "subagents.toolTopology": "select[id$='-topology']",
  };
  const rateLimit = /^runtimePolicy\.rateLimit\.([a-zA-Z]+)$/.exec(path);
  const selector = rateLimit && Object.hasOwn(DSMM_RATE_LIMIT_BOUNDS, rateLimit[1])
    ? `input[data-dsmm-policy-field='${rateLimit[1]}']`
    : Object.hasOwn(selectors, path) ? selectors[path] : undefined;
  return selector === undefined ? null : container.querySelector<HTMLElement>(selector);
}

/** One native settings.section; policy selection is never coupled to browsing. */
export function ProfilesSection(props: ProfilesSectionProps) {
  const { t } = props;
  const state: ProfilesViewSnapshot = props.useProfiles((snapshot: ProfilesViewSnapshot) => snapshot);
  const prefix = useId();
  const selectRef = useRef<HTMLSelectElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const advancedSettingsRef = useRef<HTMLDetailsElement>(null);
  const moreActionsRef = useRef<HTMLDetailsElement>(null);
  const handledValidation = useRef(0);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const hadConfirmation = useRef(false);
  const initiatorRef = useRef<HTMLElement | null>(null);
  const dialogInitiatorRef = useRef<HTMLElement | null>(null);
  const orchestratorRef = useRef<HTMLDivElement>(null);
  const sessionScopeRef = useRef<HTMLDivElement>(null);

  const [modelsDialogOpen, setModelsDialogOpen] = useState(false);
  const [targetRole, setTargetRole] = useState<string | null>(null);
  const [targetRoleField, setTargetRoleField] = useState<string | null>(null);
  const pendingDialogFocus = useRef<{
    kind: "trigger" | "jsonc";
    editorEpoch: number;
    validationEpoch: number;
    issue: ProfilesViewSnapshot["issue"];
    trigger: HTMLElement | null;
  } | null>(null);

  const advancedOpenRef = useRef(false);
  const jsoncOpenRef = useRef(false);
  const moreActionsOpenRef = useRef(false);

  const disabled = state.busy !== null || state.pendingEditor !== null || state.sessionBusy === "apply" || state.sessionBusy === "reset";
  const snapshot = state.snapshot;
  const hasOrchestrator = snapshot?.roles?.some(role => role.id === "dsmm-orchestrator") === true;
  const editor = state.editor;
  const readOnly = snapshot?.readOnly === true;
  const editorDisabled = disabled || readOnly || editor?.refreshRequired === true || editor?.revision === "unavailable";
  const reconcilable = canReconcileSelection(snapshot);
  const selectionConflict = reconcilable && snapshot?.selectionError?.code === "conflict";
  const invalid = state.issue?.kind === "domain" && state.issue.code === "validation";
  const idInvalid = invalid && state.issue?.field === "id" && state.issue.location === undefined && editor?.revision === null && !editorDisabled;
  const structuredDoc = editor === null ? null : structuredDocument(editor.content);
  const lastValidBasicDocRef = useRef<{ id: string; epoch: number; doc: StructuredDocument } | null>(null);
  if (editor !== null && structuredDoc !== null) {
    lastValidBasicDocRef.current = { id: editor.id, epoch: state.editorEpoch, doc: structuredDoc };
  }
  const basicDoc = structuredDoc ?? (lastValidBasicDocRef.current !== null && lastValidBasicDocRef.current.id === editor?.id && lastValidBasicDocRef.current.epoch === state.editorEpoch ? lastValidBasicDocRef.current.doc : null);
  const rawInvalid = editor !== null && structuredDoc === null;

  function focusJsonc(location?: ProfileDiagnosticLocation): boolean {
    if (advancedRef.current !== null) {
      advancedRef.current.open = true;
      jsoncOpenRef.current = true;
    }
    const input = editorRef.current;
    if (input === null) return false;
    const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    input.scrollIntoView?.({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
    input.focus();
    if (input.ownerDocument.activeElement !== input) return false;
    if (location !== undefined && location.offset + location.length <= input.value.length) {
      input.setSelectionRange(location.offset, location.offset + location.length);
    }
    return true;
  }

  function focusGlobalField(field: string): boolean {
    const container = advancedSettingsRef.current;
    if (container === null) return false;
    const target = locateGlobalField(container, field);
    if (target === null) return false;
    container.open = true;
    advancedOpenRef.current = true;
    const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView?.({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
    target.focus();
    return target.ownerDocument.activeElement === target;
  }

  function closeModelsDialog(kind: "trigger" | "jsonc") {
    pendingDialogFocus.current = { kind, editorEpoch: state.editorEpoch, validationEpoch: state.validationEpoch,
      issue: state.issue, trigger: dialogInitiatorRef.current };
    setModelsDialogOpen(false);
    setTargetRole(null);
    setTargetRoleField(null);
  }

  // Passive effect cleanup restores Modal isolation before the new focus destination runs.
  useEffect(() => {
    if (modelsDialogOpen) return;
    const pending = pendingDialogFocus.current;
    if (pending === null) return;
    pendingDialogFocus.current = null;
    if (pending.editorEpoch !== state.editorEpoch || pending.validationEpoch !== state.validationEpoch || pending.issue !== state.issue) return;
    if (pending.kind === "jsonc") {
      if (focusJsonc(pending.issue?.location)) handledValidation.current = pending.validationEpoch;
    } else if (pending.trigger?.isConnected) {
      pending.trigger.focus();
    }
  }, [modelsDialogOpen, state.editorEpoch, state.validationEpoch, state.issue]);

  useEffect(() => {
    if (state.pendingEditor !== null) {
      cancelRef.current?.focus();
      hadConfirmation.current = true;
    } else if (hadConfirmation.current) {
      hadConfirmation.current = false;
      if (initiatorRef.current && initiatorRef.current.isConnected) {
        initiatorRef.current.focus();
      } else {
        selectRef.current?.focus();
      }
    }
  }, [state.pendingEditor]);

  useEffect(() => {
    if (state.busy === null && state.validationEpoch > handledValidation.current && state.issue?.kind === "domain" && state.issue.code === "validation") {
      const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const scrollOpt: ScrollIntoViewOptions = { behavior: reducedMotion ? "auto" : "smooth", block: "nearest" };

      // Case 1: ID field
      if (state.issue.location === undefined && (state.issue.field === "id" || state.issue.field === "newId") && inputRef.current !== null
        && !inputRef.current.disabled && !inputRef.current.readOnly) {
        handledValidation.current = state.validationEpoch;
        if (typeof inputRef.current.scrollIntoView === "function") inputRef.current.scrollIntoView(scrollOpt);
        inputRef.current.focus();
        return;
      }

      // Case 2: Role field that maps to snapshot role
      const field = state.issue.field ?? "";
      const roleMatch = /^(?:settings\.)?(?:roleRouting|roles)\.([a-zA-Z0-9_-]+)(?:\.|$)/.exec(field);
      const roleId = roleMatch?.[1];
      if (roleId && snapshot?.roles?.some(r => r.id === roleId)) {
        setTargetRole(roleId);
        setTargetRoleField(field);
        setModelsDialogOpen(true);
        return;
      }

      // Case 3: Global setting in advanced settings
      if (focusGlobalField(field)) {
        handledValidation.current = state.validationEpoch;
        return;
      }

      // Case 4: Unmapped Host diagnostic or missing role in inventory -> JSONC fallback with UTF16 offset/length
      if (modelsDialogOpen) closeModelsDialog("jsonc");
      else if (focusJsonc(state.issue.location)) handledValidation.current = state.validationEpoch;
    }
  }, [state.issue, state.busy, state.validationEpoch, snapshot?.roles]);

  const relationship = editor?.revision != null && editor.id === snapshot?.selectedId ? sourceRelationship(snapshot, editor.revision) : "changed";
  const applied = relationship === "current";
  let selection = t(snapshot === null ? "unavailable" : "baseline");
  if (snapshot?.selectionError !== undefined && !selectionConflict) selection = t("appliedInvalid");
  else if (snapshot?.selectedId !== null && snapshot?.selectedId !== undefined) selection = t("appliedProfile", { id: snapshot.selectedId, revision: t(configurationVersionState(snapshot.sourceRevision)) });
  const notice = state.notice === null ? "" : t(state.notice.key === "reset" ? "resetDone" : state.notice.key, { id: state.notice.id });
  const warnings = editor === null ? [] : draftWarnings(editor.content);

  return <section className="dsmm-profiles dsmm-named-profiles" aria-label={t("title")} aria-busy={state.busy !== null}>
    {readOnly && <p role="status" className="dsmm-hint">{t("readOnlyOrigin")}</p>}

    <h2>{t("title")}</h2>
    <p className="dsmm-hint">{t("description")}</p>

    <div className="dsmm-browse-row">
      {snapshot !== null && <div className="dsmm-field">
        <label htmlFor={`${prefix}-select`}>{t("editorSelect")}</label>
        <select ref={selectRef} id={`${prefix}-select`} disabled={disabled} value={editor?.revision == null ? "" : editor.id} onChange={(event) => { initiatorRef.current = event.currentTarget; if (event.currentTarget.value) void props.open(event.currentTarget.value); }}>
          <option value="">{t(editor?.revision === null ? "newDraft" : "choose")}</option>
          {snapshot.profiles.map((profile, index) => <option key={`${index}:${profile.id}`} value={profile.id}>{profile.label?.trim() ? `${profile.label} (${profile.id})` : profile.id}{profile.error === undefined ? "" : ` — ${t("invalidProfile", { id: profile.id })}`}{profile.warnings?.length ? ` — ${t("warningProfile")}` : ""}</option>)}
        </select>
      </div>}
      <div className="dsmm-actions">
        <Button type="button" variant="outline" disabled={editorDisabled || snapshot === null} onClick={(event) => { initiatorRef.current = event.currentTarget; void props.create(); }}>{t("new")}</Button>
        <Button type="button" variant="outline" disabled={disabled} onClick={(event) => { initiatorRef.current = event.currentTarget; void props.refresh(); }}>{t(state.busy === "refresh" ? "refreshing" : "refresh")}</Button>
      </div>
      {editor !== null && <p className="dsmm-badge" data-dsmm-editor-state={state.invalidFields.length > 0 || invalid || rawInvalid ? "invalid" : state.dirty ? "dirty" : readOnly ? "readonly" : "ready"}>{t(editor.refreshRequired ? "savedRefreshRequired" : state.invalidFields.length > 0 || invalid || rawInvalid ? "validation" : state.dirty ? "dirty" : applied ? "savedApplied" : relationship === "unknown" ? "savedRelationshipUnknown" : "savedNotApplied")}</p>}
    </div>
    {snapshot?.profiles.length === 0 && <p className="dsmm-hint">{t("empty")}</p>}

    {snapshot !== null && snapshot.profiles.some(profile => profile.error !== undefined || profile.warnings?.length) && <ul className="dsmm-profile-list" aria-label={t("savedInventory")}>{snapshot.profiles.filter(profile => profile.error !== undefined || profile.warnings?.length).map((profile, index) => <li key={`${index}:${profile.id}`}>
      <p>{profile.label?.trim() ? `${profile.label} (${profile.id})` : profile.id}</p>
      <ProfileWarnings warnings={profile.warnings} t={t} />
      {profile.error !== undefined && <IssueDetails issue={profile.error} t={t} />}
    </li>)}</ul>}

    {state.pendingEditor !== null && <div className="dsmm-confirm" role="group" aria-labelledby={`${prefix}-confirm`} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); props.cancelDiscard(); } }}>
      <p id={`${prefix}-confirm`}>{t("discardPrompt")}</p>
      <div className="dsmm-actions"><Button type="button" variant="outline" onClick={() => { void props.discardAndOpen(); }}>{t("discard")}</Button><Button ref={cancelRef} type="button" variant="primary" onClick={props.cancelDiscard}>{t("cancel")}</Button></div>
    </div>}

    <div className="dsmm-effective-summary" data-dsmm-effective-summary>
      <div className="dsmm-summary-row">
        <div><span className="dsmm-summary-label">{t("futureDefaultSummary")}</span> <span className="dsmm-summary-val" data-dsmm-selection>{selection}</span></div>
        <Button type="button" variant="primary" size="sm" disabled={editorDisabled || state.dirty || state.invalidFields.length > 0 || editor?.revision == null || !reconcilable || (applied && !selectionConflict)} onClick={() => { void props.apply(); }}>{t(state.busy === "apply" ? "applying" : "apply")}</Button>
      </div>
      {snapshot?.refreshRequired && <p role="status">{t("savedRefreshRequired")}</p>}
      {snapshot?.selectedWarnings?.length ? <div><p>{t("futureWarnings")}</p><ProfileWarnings warnings={snapshot.selectedWarnings} t={t} /></div> : null}
      {snapshot?.selectionError !== undefined && <div className="dsmm-issue"><p>{t(selectionConflict ? "selectionConflict" : "retry")}</p><IssueDetails issue={snapshot.selectionError} t={t} /></div>}

      <div className="dsmm-summary-row">
        <div><span className="dsmm-summary-label">{t("currentSessionSummary")}</span> <span className="dsmm-summary-val">{state.session === null ? t("sessionUnavailable") : sessionProfileLabels(state.session, t).admitted}</span></div>
        <Button type="button" variant="outline" size="sm" onClick={() => {
          if (moreActionsRef.current !== null) {
            moreActionsRef.current.open = true;
            moreActionsOpenRef.current = true;
          }
          const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          sessionScopeRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" });
        }}>{t("locateSessionScope")}</Button>
      </div>

      <SessionScopeFeedback state={state} t={t} />
      <details ref={moreActionsRef} className="dsmm-more-actions" open={moreActionsOpenRef.current || undefined} onToggle={e => { moreActionsOpenRef.current = e.currentTarget.open; }}>
        <summary>{t("moreActions")}</summary>
        <div>
          <div>
            <Button type="button" variant="outline" disabled={editorDisabled || !reconcilable || (snapshot?.selectedId === null && !selectionConflict)} onClick={() => { void props.reset(); }}>{t(state.busy === "reset" ? "resetting" : "reset")}</Button>
            <p className="dsmm-hint">{t("futureResetHint")}</p>
          </div>
          <div ref={sessionScopeRef}><SessionScope state={state} actions={props} t={t} showFeedback={false} /></div>
        </div>
      </details>
    </div>

    {editor === null && <p className="dsmm-hint">{t("noEditor")}</p>}
    {editor !== null && <div className="dsmm-editor">
      {warnings.length > 0 && <div><p>{t("draftWarnings")}</p><ProfileWarnings warnings={warnings} t={t} /></div>}
      {editor.warnings?.length ? <div><p>{t("savedWarnings")}</p><ProfileWarnings warnings={editor.warnings} t={t} /></div> : null}

      <div className="dsmm-catalog">
        {state.catalogUnavailable && <p className="dsmm-hint">{t("catalogUnavailable")}</p>}
        {state.catalog?.failures.map((failure) => <p className="dsmm-hint" key={failure.id}>{t("catalogFailure", { name: failure.name, id: failure.id })}</p>)}
        <Button type="button" variant="outline" disabled={state.catalogBusy} onClick={() => { void props.refreshCatalog(); }}>{t(state.catalogBusy ? "catalogRefreshing" : "catalogRefresh")}</Button>
      </div>

      {/* Flat Basic Settings */}
      <div key={`basic:${state.editorEpoch}`} className="dsmm-basic-settings" data-dsmm-basic-settings>
        {structuredDoc === null && (
          <div className="dsmm-structured-invalid" data-dsmm-structured-invalid>
            <p>{t("rawInvalid")}</p>
            <p className="dsmm-hint">{t("rawInvalidFormDisabled")}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (advancedRef.current !== null) {
                  advancedRef.current.open = true;
                  jsoncOpenRef.current = true;
                }
                const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                editorRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" });
                editorRef.current?.focus();
              }}
            >
              {t("viewConfiguration")}
            </Button>
          </div>
        )}
        {basicDoc !== null && (
          <>
            <div className="dsmm-field">
              <label htmlFor={`${prefix}-label`}>{t("profileLabel")}</label>
              <Input
                ref={labelRef}
                id={`${prefix}-label`}
                className="dsmm-input"
                value={basicDoc.label ?? ""}
                disabled={editorDisabled || structuredDoc === null}
                onChange={(event) => props.editPath(["label"], event.currentTarget.value)}
              />
              <Button
                type="button"
                variant="outline"
                disabled={editorDisabled || structuredDoc === null || basicDoc.label === undefined}
                onClick={() => props.editPath(["label"], undefined)}
              >
                {t("omitLabel")}
              </Button>
            </div>

            <div className="dsmm-field">
              <label htmlFor={`${prefix}-id`}>{t("profileId")}</label>
              <Input
                ref={inputRef}
                id={`${prefix}-id`}
                className="dsmm-input"
                value={editor.id}
                disabled={editorDisabled || structuredDoc === null || editor.revision !== null}
                aria-invalid={idInvalid || undefined}
                aria-describedby={`${prefix}-id-hint${idInvalid ? ` ${prefix}-issue` : ""}`}
                onChange={(event) => props.editId(event.currentTarget.value)}
              />
              <p id={`${prefix}-id-hint`} className="dsmm-hint">{t("idHint")}</p>
            </div>

            <div ref={orchestratorRef} className="dsmm-field" id={`${prefix}-orchestrator-primary`}>
              <label htmlFor={`${prefix}-orch-mode`}>{t("orchestratorModel")}</label>
              <p className="dsmm-hint">{t("orchestratorModelDesc")}</p>
              <select
                id={`${prefix}-orch-mode`}
                disabled={editorDisabled || structuredDoc === null || !hasOrchestrator}
                aria-describedby={!hasOrchestrator ? `${prefix}-orch-unavailable` : undefined}
                value={basicDoc.roleRouting["dsmm-orchestrator"]?.primary === undefined ? "inherit" : "explicit"}
                onChange={(event) => props.editPath(["settings", "roleRouting", "dsmm-orchestrator", "primary"], event.currentTarget.value === "inherit" ? undefined : { provider: "", model: "" })}
              >
                <option value="inherit">{t("inheritRoute")}</option>
                <option value="explicit">{t("configuredRoute")}</option>
              </select>
              {!hasOrchestrator && <p className="dsmm-hint" id={`${prefix}-orch-unavailable`}>{t("orchestratorUnavailable")}</p>}
              {basicDoc.roleRouting["dsmm-orchestrator"]?.primary !== undefined && (
                <RouteFields
                  t={t}
                  value={basicDoc.roleRouting["dsmm-orchestrator"].primary}
                  path={["settings", "roleRouting", "dsmm-orchestrator", "primary"]}
                  naturalLabels={true}
                  catalog={state.catalog}
                  disabled={editorDisabled || structuredDoc === null || !hasOrchestrator}
                  edit={props.editPath}
                  editRoute={props.editRoute}
                />
              )}
              <p className="dsmm-hint">{t("effortChangeHint")}</p>
            </div>

            <div className="dsmm-field dsmm-configure-models-field">
              <label>{t("configureAllAgentModels")}</label>
              <p className="dsmm-hint">{t("modelsDialogDesc")}</p>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  className="dsmm-open-models-dialog-btn"
                  disabled={editorDisabled || structuredDoc === null}
                  onClick={(event) => {
                    dialogInitiatorRef.current = event.currentTarget;
                    setModelsDialogOpen(true);
                  }}
                >
                  {t("configureAllAgentModels")}
                </Button>
              </div>
            </div>

            <div className="dsmm-field">
              <label htmlFor={`${prefix}-locale`}>{t("businessLocale")}</label>
              <select
                id={`${prefix}-locale`}
                value={String(basicDoc.settings.locale ?? "")}
                disabled={editorDisabled || structuredDoc === null}
                aria-describedby={`${prefix}-locale-hint`}
                onChange={(event) => props.editPath(["settings", "locale"], event.currentTarget.value || undefined)}
              >
                <option value="">{t("inheritLocale")}</option>
                {typeof basicDoc.settings.locale === "string" && !(DSMM_LOCALES as readonly string[]).includes(basicDoc.settings.locale) && (
                  <option value={basicDoc.settings.locale}>{t("unsupportedLocale")}</option>
                )}
                {DSMM_LOCALES.map((locale: string) => (
                  <option value={locale} key={locale}>{locale}</option>
                ))}
              </select>
              <p id={`${prefix}-locale-hint`} className="dsmm-hint">{t("localeHint")}</p>
            </div>

            <div className="dsmm-field">
              <label htmlFor={`${prefix}-active`}>{t("defaultActive")}</label>
              <select
                id={`${prefix}-active`}
                disabled={editorDisabled || structuredDoc === null}
                value={basicDoc.settings.defaultActive === undefined ? "" : String(basicDoc.settings.defaultActive)}
                onChange={(event) => props.editPath(["settings", "defaultActive"], event.currentTarget.value === "" ? undefined : event.currentTarget.value === "true")}
              >
                <option value="">{t("inherit")}</option>
                <option value="true">{t("enabled")}</option>
                <option value="false">{t("disabled")}</option>
              </select>
              <p className="dsmm-hint">{t("activeHint")}</p>
            </div>
          </>
        )}
      </div>

      <details
        ref={advancedSettingsRef}
        key={`advanced-settings:${state.editorEpoch}`}
        className="dsmm-advanced-settings"
        open={advancedOpenRef.current || undefined}
        onToggle={e => { advancedOpenRef.current = e.currentTarget.open; }}
      >
        <summary>{t("advancedSettings")}</summary>
        <div>
          <AdvancedSettings
            state={state}
            actions={props}
            disabled={editorDisabled}
            document={basicDoc}
            isInvalidProjection={rawInvalid}
            t={t}
          />
        </div>
      </details>

      <details
        ref={advancedRef}
        key={`advanced:${state.editorEpoch}`}
        className="dsmm-advanced"
        open={jsoncOpenRef.current || undefined}
        onToggle={e => { jsoncOpenRef.current = e.currentTarget.open; }}
      >
        <summary>{t("configuration")}</summary>
        <div className="dsmm-field">
          <label htmlFor={`${prefix}-content`}>{t("configuration")}</label>
          <textarea ref={editorRef} id={`${prefix}-content`} rows={12} spellCheck={false} value={editor.content} readOnly={readOnly} disabled={editorDisabled} aria-invalid={rawInvalid || (invalid && !idInvalid) || undefined} aria-describedby={`${prefix}-content-hint ${prefix}-structural-hint${invalid && !idInvalid ? ` ${prefix}-issue` : ""}`} onChange={(event) => props.editContent(event.currentTarget.value)} />
          <p id={`${prefix}-content-hint`} className="dsmm-hint">{t("configurationHint")}</p>
          <p id={`${prefix}-structural-hint`} className="dsmm-hint">{t("structuralHint")}</p>
        </div>
      </details>

      <ProfileModelsDialog
        open={modelsDialogOpen}
        onClose={() => closeModelsDialog("trigger")}
        state={state}
        actions={props}
        disabled={editorDisabled}
        document={basicDoc}
        isInvalidProjection={rawInvalid}
        targetRoleId={targetRole}
        targetField={targetRoleField}
        onTargetLocated={() => {
          handledValidation.current = state.validationEpoch;
          setTargetRole(null);
          setTargetRoleField(null);
        }}
        onJumpToJsonc={() => closeModelsDialog("jsonc")}
        t={t}
      />

      <div className="dsmm-save-bar">
        {(() => {
          const isSaveLocked = (state.dirty || state.invalidFields.length > 0) && !editorDisabled && snapshot !== null && (state.invalidFields.length > 0 || rawInvalid || invalid);
          if (!isSaveLocked) return null;
          return (
            <div className="dsmm-save-lock-reason" role="status">
              <span className="dsmm-save-lock-text">
                {rawInvalid
                  ? t("rawInvalid")
                  : state.invalidFields.length > 0
                  ? t("saveLockedReason", { count: state.invalidFields.length })
                  : t("validation")}
              </span>
              <div className="dsmm-save-lock-action">
                {rawInvalid && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (advancedRef.current !== null) {
                        advancedRef.current.open = true;
                        jsoncOpenRef.current = true;
                      }
                      const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                      editorRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" });
                      editorRef.current?.focus();
                    }}
                  >
                    {t("jumpToJsonc")}
                  </Button>
                )}
                {!rawInvalid && state.invalidFields.length > 0 && (() => {
                  const firstInvalid = state.invalidFields[0];
                  const roleMatch = /^(?:settings\.)?(?:roleRouting|roles)\.([a-zA-Z0-9_-]+)(?:\.|$)/.exec(firstInvalid);
                  const roleId = roleMatch?.[1];
                  if (roleId) {
                    return (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          dialogInitiatorRef.current = e.currentTarget;
                          setTargetRole(roleId);
                          setTargetRoleField(firstInvalid);
                          setModelsDialogOpen(true);
                        }}
                      >
                        {t("jumpToField")}: {firstInvalid}
                      </Button>
                    );
                  }
                  return (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (!focusGlobalField(firstInvalid)) focusJsonc(state.issue?.location);
                      }}
                    >
                      {t("jumpToField")}: {firstInvalid}
                    </Button>
                  );
                })()}
                {!rawInvalid && state.invalidFields.length === 0 && invalid && (() => {
                  if (state.issue?.field === "id" || state.issue?.field === "newId") {
                    return (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                          inputRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" });
                          inputRef.current?.focus();
                        }}
                      >
                        {t("jumpToField")}: ID
                      </Button>
                    );
                  }
                  const roleMatch = /^(?:settings\.)?(?:roleRouting|roles)\.([a-zA-Z0-9_-]+)(?:\.|$)/.exec(state.issue?.field ?? "");
                  const roleId = roleMatch?.[1];
                  if (roleId && snapshot?.roles?.some(r => r.id === roleId)) {
                    return (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          dialogInitiatorRef.current = e.currentTarget;
                          setTargetRole(roleId);
                          setTargetRoleField(state.issue?.field ?? null);
                          setModelsDialogOpen(true);
                        }}
                      >
                        {t("jumpToRole")}: {roleId}
                      </Button>
                    );
                  }
                  return (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (advancedRef.current !== null) {
                          advancedRef.current.open = true;
                          jsoncOpenRef.current = true;
                        }
                        const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                        editorRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" });
                        editorRef.current?.focus();
                        const location = state.issue?.location;
                        if (location !== undefined && editorRef.current && location.offset + location.length <= editorRef.current.value.length) {
                          editorRef.current.setSelectionRange(location.offset, location.offset + location.length);
                        }
                      }}
                    >
                      {t("jumpToJsonc")}
                    </Button>
                  );
                })()}
              </div>
            </div>
          );
        })()}
        <div className="dsmm-actions">
          <Button type="button" variant="primary" disabled={editorDisabled || !state.dirty || snapshot === null || state.invalidFields.length > 0 || rawInvalid} onClick={() => { void props.save(); }}>{t(state.busy === "save" ? "saving" : "save")}</Button>
          <Button type="button" variant="outline" disabled={editorDisabled || (!state.dirty && state.invalidFields.length === 0)} onClick={(event) => { initiatorRef.current = event.currentTarget; props.discard(); }}>{t("discard")}</Button>
          {editor.revision !== null && !state.dirty && <Button type="button" variant="outline" disabled={disabled} onClick={(event) => { initiatorRef.current = event.currentTarget; void props.reload(); }}>{t("reload")}</Button>}
        </div>
      </div>
    </div>}

    {state.issue !== null && !modelsDialogOpen && <div className="dsmm-issue" id={`${prefix}-issue`} role="alert"><p>{t(issueKey(state.issue))}</p><IssueDetails issue={state.issue} t={t} /></div>}
    <p className="dsmm-status" role="status" aria-live="polite" aria-atomic="true">{state.busy === "refresh" && snapshot === null ? t("loading") : state.busy === "read" ? t("reading") : notice}</p>
  </section>;
}
