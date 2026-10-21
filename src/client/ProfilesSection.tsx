import { useEffect, useId, useRef } from "react";
import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { ProfilesActions, ProfilesController, ProfilesIssue, ProfilesViewSnapshot } from "./controller.js";
import { canReconcileSelection } from "./controller.js";
import { StructuredEditor } from "./StructuredEditor.js";
import { SessionScope } from "./SessionProfiles.js";
import { structuredDocument } from "./structured.js";
import { draftWarnings, IssueDetails, ProfileWarnings } from "./diagnostics.js";
import { configurationVersionState, sourceRelationship } from "./configuration-display.js";

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
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const handledValidation = useRef(0);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const hadConfirmation = useRef(false);
  const disabled = state.busy !== null || state.pendingEditor !== null || state.sessionBusy === "apply" || state.sessionBusy === "reset";
  const snapshot = state.snapshot;
  const editor = state.editor;
  const readOnly = snapshot?.readOnly === true;
  const editorDisabled = disabled || readOnly || editor?.refreshRequired === true || editor?.revision === "unavailable";
  const reconcilable = canReconcileSelection(snapshot);
  const selectionConflict = reconcilable && snapshot?.selectionError?.code === "conflict";
  const invalid = state.issue?.kind === "domain" && state.issue.code === "validation";
  const idInvalid = invalid && state.issue?.field === "id" && state.issue.location === undefined && editor?.revision === null && !editorDisabled;
  const rawInvalid = editor !== null && structuredDocument(editor.content) === null;
  useEffect(() => {
    if (state.pendingEditor !== null) { cancelRef.current?.focus(); hadConfirmation.current = true; }
    else if (hadConfirmation.current) { selectRef.current?.focus(); hadConfirmation.current = false; }
  }, [state.pendingEditor]);
  useEffect(() => {
    if (state.busy === null && state.validationEpoch > handledValidation.current && state.issue?.kind === "domain" && state.issue.code === "validation") {
      handledValidation.current = state.validationEpoch;
      if (state.issue.location === undefined && state.issue.field === "id" && inputRef.current !== null
        && !inputRef.current.disabled && !inputRef.current.readOnly) inputRef.current.focus();
      else {
        if (advancedRef.current !== null) advancedRef.current.open = true;
        const input = editorRef.current;
        if (input !== null) {
          input.focus();
          const location = state.issue.location;
          if (location !== undefined && location.offset + location.length <= input.value.length) input.setSelectionRange(location.offset, location.offset + location.length);
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
  return <section className="dsmm-profiles" aria-label={t("title")} aria-busy={state.busy !== null}>
    {readOnly && <p role="status" className="dsmm-hint">{t("readOnlyOrigin")}</p>}
    <section className="dsmm-zone" aria-labelledby={`${prefix}-browse`} data-dsmm-zone="browse">
    <h3 id={`${prefix}-browse`}>{t("browseZone")}</h3>
    <div className="dsmm-actions">
      <Button type="button" variant="outline" disabled={editorDisabled || snapshot === null} onClick={() => { void props.create(); }}>{t("new")}</Button>
      <Button type="button" variant="outline" disabled={disabled} onClick={() => { void props.refresh(); }}>{t(state.busy === "refresh" ? "refreshing" : "refresh")}</Button>
    </div>
    {snapshot !== null && <div className="dsmm-field">
      <label htmlFor={`${prefix}-select`}>{t("editorSelect")}</label>
      <select ref={selectRef} id={`${prefix}-select`} disabled={disabled} value={editor?.revision == null ? "" : editor.id} onChange={(event) => { if (event.currentTarget.value) void props.open(event.currentTarget.value); }}>
        <option value="">{t(editor?.revision === null ? "newDraft" : "choose")}</option>
        {snapshot.profiles.map((profile, index) => <option key={`${index}:${profile.id}`} value={profile.id}>{profile.label?.trim() ? `${profile.label} (${profile.id})` : profile.id}{profile.error === undefined ? "" : ` — ${t("invalidProfile", { id: profile.id })}`}{profile.warnings?.length ? ` — ${t("warningProfile")}` : ""}</option>)}
      </select>
      {snapshot.profiles.length === 0 && <p className="dsmm-hint">{t("empty")}</p>}
    </div>}
    {snapshot !== null && snapshot.profiles.some(profile => profile.error !== undefined || profile.warnings?.length) && <ul className="dsmm-profile-list" aria-label={t("savedInventory")}>{snapshot.profiles.filter(profile => profile.error !== undefined || profile.warnings?.length).map((profile, index) => <li key={`${index}:${profile.id}`}>
      <p>{profile.label?.trim() ? `${profile.label} (${profile.id})` : profile.id}</p>
      <ProfileWarnings warnings={profile.warnings} t={t} />
      {profile.error !== undefined && <IssueDetails issue={profile.error} t={t} />}
    </li>)}</ul>}
    {state.pendingEditor !== null && <div className="dsmm-confirm" role="group" aria-labelledby={`${prefix}-confirm`} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); props.cancelDiscard(); } }}>
      <p id={`${prefix}-confirm`}>{t("discardPrompt")}</p>
      <div className="dsmm-actions"><Button type="button" variant="outline" onClick={() => { void props.discardAndOpen(); }}>{t("discard")}</Button><Button ref={cancelRef} type="button" variant="primary" onClick={props.cancelDiscard}>{t("cancel")}</Button></div>
    </div>}
    </section>
    <section className="dsmm-zone" aria-labelledby={`${prefix}-edit`} data-dsmm-zone="edit">
    <h3 id={`${prefix}-edit`}>{t("editZone")}</h3>
    {editor === null && <p className="dsmm-hint">{t("noEditor")}</p>}
    {editor !== null && <div className="dsmm-editor">
      <p data-dsmm-editor-state>{t(editor.refreshRequired ? "savedRefreshRequired" : state.dirty ? "dirty" : applied ? "savedApplied" : relationship === "unknown" ? "savedRelationshipUnknown" : "savedNotApplied")}</p>
      <div className="dsmm-actions">
        <Button type="button" variant="primary" disabled={editorDisabled || !state.dirty || snapshot === null || state.invalidFields.length > 0} onClick={() => { void props.save(); }}>{t(state.busy === "save" ? "saving" : "save")}</Button>
        {editor.revision !== null && <Button type="button" variant="outline" disabled={disabled} onClick={() => { void props.reload(); }}>{t("reload")}</Button>}
      </div>
      {warnings.length > 0 && <div><p>{t("draftWarnings")}</p><ProfileWarnings warnings={warnings} t={t} /></div>}
      {editor.warnings?.length ? <div><p>{t("savedWarnings")}</p><ProfileWarnings warnings={editor.warnings} t={t} /></div> : null}
      <div className="dsmm-field">
        <label htmlFor={`${prefix}-id`}>{t("profileId")}</label>
        <Input ref={inputRef} id={`${prefix}-id`} className="dsmm-input" value={editor.id} disabled={editorDisabled || editor.revision !== null} aria-invalid={idInvalid || undefined} aria-describedby={`${prefix}-id-hint${idInvalid ? ` ${prefix}-issue` : ""}`} onChange={(event) => props.editId(event.currentTarget.value)} />
        <p id={`${prefix}-id-hint`} className="dsmm-hint">{t("idHint")}</p>
      </div>
      <div className="dsmm-catalog">
        {state.catalogUnavailable && <p className="dsmm-hint">{t("catalogUnavailable")}</p>}
        {state.catalog?.failures.map((failure) => <p className="dsmm-hint" key={failure.id}>{t("catalogFailure", { name: failure.name, id: failure.id })}</p>)}
        <Button type="button" variant="outline" disabled={state.catalogBusy} onClick={() => { void props.refreshCatalog(); }}>{t(state.catalogBusy ? "catalogRefreshing" : "catalogRefresh")}</Button>
      </div>
      <StructuredEditor key={`structured:${state.editorEpoch}`} state={state} actions={props} disabled={editorDisabled} t={t} />
      <details ref={advancedRef} key={`advanced:${state.editorEpoch}`} className="dsmm-advanced"><summary>{t("advanced")}</summary><div className="dsmm-field">
        <label htmlFor={`${prefix}-content`}>{t("configuration")}</label>
        <textarea ref={editorRef} id={`${prefix}-content`} rows={12} spellCheck={false} value={editor.content} readOnly={readOnly} disabled={editorDisabled} aria-invalid={rawInvalid || (invalid && !idInvalid) || undefined} aria-describedby={`${prefix}-content-hint ${prefix}-structural-hint${invalid && !idInvalid ? ` ${prefix}-issue` : ""}`} onChange={(event) => props.editContent(event.currentTarget.value)} />
        <p id={`${prefix}-content-hint`} className="dsmm-hint">{t("configurationHint")}</p>
        <p id={`${prefix}-structural-hint`} className="dsmm-hint">{t("structuralHint")}</p>
      </div></details>
    </div>}
    {state.issue !== null && <div className="dsmm-issue" id={`${prefix}-issue`} role="alert"><p>{t(issueKey(state.issue))}</p><IssueDetails issue={state.issue} t={t} /></div>}
    </section>
    <section className="dsmm-zone" aria-labelledby={`${prefix}-global`} data-dsmm-zone="future-default">
      <h3 id={`${prefix}-global`}>{t("globalScope")}</h3>
      <p id={`${prefix}-global-action`} className="dsmm-hint">{t("newSessions")}</p>
      <p data-dsmm-selection>{selection}</p>
      {snapshot?.refreshRequired && <p role="status">{t("savedRefreshRequired")}</p>}
      {snapshot?.selectedWarnings?.length ? <div><p>{t("futureWarnings")}</p><ProfileWarnings warnings={snapshot.selectedWarnings} t={t} /></div> : null}
      <div className="dsmm-actions">
        <Button type="button" variant="primary" aria-describedby={`${prefix}-global-action`} disabled={editorDisabled || state.dirty || editor?.revision == null || !reconcilable || (applied && !selectionConflict)} onClick={() => { void props.apply(); }}>{t(state.busy === "apply" ? "applying" : "apply")}</Button>
        <Button type="button" variant="outline" disabled={editorDisabled || !reconcilable || (snapshot?.selectedId === null && !selectionConflict)} onClick={() => { void props.reset(); }}>{t(state.busy === "reset" ? "resetting" : "reset")}</Button>
      </div>
      {snapshot?.selectionError !== undefined && <div className="dsmm-issue"><p>{t(selectionConflict ? "selectionConflict" : "retry")}</p><IssueDetails issue={snapshot.selectionError} t={t} /></div>}
    </section>
    <section className="dsmm-zone" aria-label={t("sessionScope")} data-dsmm-zone="current-session"><SessionScope state={state} actions={props} t={t} /></section>
    <p className="dsmm-status" role="status" aria-live="polite" aria-atomic="true">{state.busy === "refresh" && snapshot === null ? t("loading") : state.busy === "read" ? t("reading") : notice}</p>
  </section>;
}
