import { useEffect, useId, useRef } from "react";
import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { ProfilesActions, ProfilesController, ProfilesIssue, ProfilesViewSnapshot } from "./controller.js";
import { canReconcileSelection } from "./controller.js";
import { AdvancedSettings, RouteFields } from "./StructuredEditor.js";
import { SessionScope, SessionScopeFeedback } from "./SessionProfiles.js";
import { sessionProfileLabels } from "./session-labels.js";
import { structuredDocument } from "./structured.js";
import type { StructuredDocument } from "./structured.js";
import { draftWarnings, IssueDetails, ProfileWarnings } from "./diagnostics.js";
import { configurationVersionState, sourceRelationship } from "./configuration-display.js";
import { DSMM_LOCALES } from "../profile-locale.js";

export type ProfilesInjected = ProfilesActions & { hooks: { profiles: ProfilesController["store"] } };
export type ProfilesSectionProps = InjectFace<ProfilesInjected> & PropsLocale<"settings.dsmm-profiles">;

function issueKey(issue: ProfilesIssue): "unavailable" | "transport" | "conflict" | "validation" | "io" | "selectionConflict" | "appliedInvalid" {
  if (issue.source === "selection") return issue.code === "conflict" ? "selectionConflict" : "appliedInvalid";
  if (issue.kind === "assembly") return "unavailable";
  if (issue.kind === "transport") return "transport";
  return issue.code === "conflict" || issue.code === "validation" ? issue.code : "io";
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
  const orchestratorRef = useRef<HTMLDivElement>(null);
  const sessionScopeRef = useRef<HTMLDivElement>(null);

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
  const lastValidBasicDocRef = useRef<StructuredDocument | null>(null);
  if (structuredDoc !== null) {
    lastValidBasicDocRef.current = structuredDoc;
  }
  const basicDoc = structuredDoc ?? lastValidBasicDocRef.current;
  const rawInvalid = editor !== null && structuredDoc === null;

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
      handledValidation.current = state.validationEpoch;
      const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const scrollOpt: ScrollIntoViewOptions = { behavior: reducedMotion ? "auto" : "smooth", block: "nearest" };

      if (state.issue.location === undefined && state.issue.field === "id" && inputRef.current !== null
        && !inputRef.current.disabled && !inputRef.current.readOnly) {
        if (typeof inputRef.current.scrollIntoView === "function") inputRef.current.scrollIntoView(scrollOpt);
        inputRef.current.focus();
      } else {
        if (advancedRef.current !== null) {
          advancedRef.current.open = true;
          jsoncOpenRef.current = true;
        }
        const input = editorRef.current;
        if (input !== null) {
          if (typeof input.scrollIntoView === "function") input.scrollIntoView(scrollOpt);
          input.focus();
          const location = state.issue.location;
          if (location !== undefined && location.offset + location.length <= input.value.length) {
            input.setSelectionRange(location.offset, location.offset + location.length);
          }
        }
      }
    }
  }, [state.issue, state.busy, state.validationEpoch]);

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
        <Button type="button" variant="primary" size="sm" disabled={editorDisabled || state.dirty || editor?.revision == null || !reconcilable || (applied && !selectionConflict)} onClick={() => { void props.apply(); }}>{t(state.busy === "apply" ? "applying" : "apply")}</Button>
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
            onJumpToOrchestrator={() => {
              const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
              orchestratorRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" });
              orchestratorRef.current?.querySelector<HTMLElement>("select, input")?.focus();
            }}
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

      <div className="dsmm-save-bar">
        <div className="dsmm-actions">
          <Button type="button" variant="primary" disabled={editorDisabled || !state.dirty || snapshot === null || state.invalidFields.length > 0} onClick={() => { void props.save(); }}>{t(state.busy === "save" ? "saving" : "save")}</Button>
          <Button type="button" variant="outline" disabled={editorDisabled || (!state.dirty && state.invalidFields.length === 0)} onClick={(event) => { initiatorRef.current = event.currentTarget; props.discard(); }}>{t("discard")}</Button>
          {editor.revision !== null && !state.dirty && <Button type="button" variant="outline" disabled={disabled} onClick={(event) => { initiatorRef.current = event.currentTarget; void props.reload(); }}>{t("reload")}</Button>}
        </div>
      </div>
    </div>}

    {state.issue !== null && <div className="dsmm-issue" id={`${prefix}-issue`} role="alert"><p>{t(issueKey(state.issue))}</p><IssueDetails issue={state.issue} t={t} /></div>}
    <p className="dsmm-status" role="status" aria-live="polite" aria-atomic="true">{state.busy === "refresh" && snapshot === null ? t("loading") : state.busy === "read" ? t("reading") : notice}</p>
  </section>;
}
