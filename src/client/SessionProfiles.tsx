import { useEffect, useId, useState } from "react";
import { Button, IconBranchOutlineRegular, Menu } from "@deepseek-ai/dsh-client-ui-primitives";
import type { MenuEntry } from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { ProfilesActions, ProfilesController, ProfilesIssue, ProfilesViewSnapshot } from "./controller.js";
import { sessionProfileLabels } from "./session-labels.js";
import { IssueDetails, ProfileWarnings, profileWarnings } from "./diagnostics.js";
import { RoleAvailability } from "./RoleAvailability.js";
import { parseSubagentRuntimeAdmissionView } from "../profile-remote.js";
import { isSafeDiagnosticField } from "../profile-diagnostics.js";
import { isConfigRevision } from "../config-revision.js";
import { sourceRelationship, writableSelectionVersion } from "./configuration-display.js";
import type { SessionActionUnavailableReason } from "../profile-types.js";

type Injected = ProfilesActions & { hooks: { profiles: ProfilesController["store"] }; readProfileView: ProfilesController["store"]["getSnapshot"] };
export type SessionProfilesProps = InjectFace<Injected> & PropsLocale<"settings.dsmm-profiles"> & { sessionId?: string };

const MENU_ISSUE_CODES = new Set(["validation", "conflict", "not-found", "lock-timeout", "unsafe-path", "io", "activation", "corrupt-selection", "limit", "busy", "maintenance", "disposed", "not-owned", "unavailable", "cancelled", "module-off", "runtime-unavailable", "new-session-required", "model-unconfigured", "model-choice-changed", "model-service-unavailable", "model-observation-unavailable", "model-selection-failed"]);
function capabilityReason(reason: SessionActionUnavailableReason | undefined, t: PropsLocale<"settings.dsmm-profiles">["t"]): string {
  switch (reason) {
    case "busy": return t("headerBusy");
    case "maintenance": return t("headerMaintenanceRefused");
    case "module-off": return t("sessionModuleOff");
    case "runtime-unavailable": return t("headerUnavailableRefused");
    case "model-unconfigured": return t("headerNoProfileModel");
    case "model-service-unavailable": return t("headerModelUnconfirmed");
    case "new-session-required": return t("sessionNewRequired");
    default: return t("headerActionUnavailable");
  }
}
function menuIssue(issue: ProfilesIssue): { code: string; field?: string } {
  const code = MENU_ISSUE_CODES.has(issue.code) ? issue.code : issue.kind === "transport" ? "transport" : "unavailable";
  const field = issue.field;
  // Only closed configuration grammar is displayable; never echo messages,
  // arbitrary wire fields, provider identifiers, credentials or file paths.
  return { code, ...(isSafeDiagnosticField(field) ? { field } : {}) };
}

export function SessionScope({ state, actions, t, compact = false }: PropsLocale<"settings.dsmm-profiles"> & {
  state: ProfilesViewSnapshot; actions: ProfilesActions; compact?: boolean;
}) {
  const prefix = useId();
  const session = state.session;
  const labels = session === null ? null : sessionProfileLabels(session, t);
  const selected = state.snapshot?.profiles.find((profile) => profile.id === state.sessionChoice);
  const disabled = state.busy !== null || state.pendingEditor !== null || state.sessionBusy !== null || state.dirty || state.invalidFields.length > 0;
  const current = () => { const live = actions.readProfileView(); return live.currentSessionId === state.currentSessionId && live.sessionViewEpoch === state.sessionViewEpoch && live.session === session; };
  const ready = session !== null && !state.sessionUnconfirmed && !session.refreshRequired && !session.selection.refreshRequired && writableSelectionVersion(session.selection.selectionRevision);
  const allowed = ready && session.canApplyOverlay === true && session.applyOverlayUnavailableReason !== "new-session-required";
  const modelAllowed = ready && session.canSelectModel === true && session.profileModel !== undefined;
  const status = state.sessionNotice === null ? "" : t(state.sessionNotice === "mode-on" ? "headerModeOn" : state.sessionNotice === "mode-off" ? "headerModeOff" : state.sessionNotice === "applied-with-model" ? "sessionAppliedWithModel" : state.sessionNotice === "applied" ? "sessionApplied" : "sessionResetDone");
  let binding = session?.subagentRuntime;
  try { if (binding !== undefined) binding = parseSubagentRuntimeAdmissionView(binding); } catch { binding = undefined; }
  return <div className="dsmm-session-scope" aria-busy={state.sessionBusy !== null} data-dsmm-session-scope>
    {!compact && <h3>{t("sessionScope")}</h3>}
    {state.currentSessionId === null ? <p className="dsmm-hint">{t("sessionChooseWorkspace")}</p> : <>
      {labels !== null && <p data-dsmm-session-state>{labels.admitted}</p>}
      {labels !== null && !compact && <p className="dsmm-hint" data-dsmm-session-future-default>{labels.futureDefault}</p>}
      {session === null && <p className="dsmm-hint" id={`${prefix}-overlay-reason`}>{t("sessionUnavailable")}</p>}
      {session?.warnings?.length ? <div><p>{t("admissionWarnings")}</p><ProfileWarnings warnings={session.warnings} t={t} /></div> : null}
      {session !== null && !allowed && <p className="dsmm-hint" id={`${prefix}-overlay-reason`}>{capabilityReason(session.applyOverlayUnavailableReason, t)}</p>}
      <div className="dsmm-field"><label htmlFor={`${prefix}-choice`}>{t("sessionSelect")}</label>
        <select id={`${prefix}-choice`} value={state.sessionChoice ?? ""} disabled={disabled || !allowed} aria-describedby={!allowed ? `${prefix}-overlay-reason` : undefined} onChange={(event) => { if (current()) actions.chooseSessionProfile(event.currentTarget.value || null); }}>
          <option value="">{t("sessionBaseline")}</option>
          {state.sessionChoice !== null && selected === undefined && <option value={state.sessionChoice}>{state.sessionChoice}</option>}
          {state.snapshot?.profiles.map((profile) => <option key={profile.id} value={profile.id} disabled={!isConfigRevision(profile.revision) || profile.error !== undefined}>{profile.label?.trim() || profile.id}{profileWarnings(profile.warnings).length ? ` — ${t("warningProfile")}` : ""}</option>)}
        </select>
      </div>
      {!compact && <><p className="dsmm-hint">{t("sessionModelHint")}</p>
        <Button type="button" variant="outline" disabled={disabled || !modelAllowed} aria-describedby={!modelAllowed ? `${prefix}-model-reason` : undefined} onClick={() => { if (current()) void actions.useSessionProfileModel(); }}>{t("headerUseCurrentModel")}</Button>
        {!modelAllowed && <p className="dsmm-hint" id={`${prefix}-model-reason`}>{capabilityReason(session?.selectModelUnavailableReason, t)}</p>}
        {session !== null && <details><summary>{t("technicalDetails")}</summary><div className="dsmm-availability">
          <p>{binding === undefined ? t("bindingUnknown") : t("bindingState", { binding: binding.binding, ready: t(binding.deliveryFenceReady ? "enabled" : "disabled"), restart: t(binding.restartRequired ? "enabled" : "disabled") })}</p>
          {binding?.reason !== undefined && <p>{t("bindingReason", { reason: binding.reason })}</p>}
        </div>
        {session.roles !== undefined && <details><summary>{t("admittedRoles")}</summary>{session.roles.map(role => <div className="dsmm-availability" key={role.id}><p>{role.id}</p><RoleAvailability value={role} t={t} /></div>)}</details>}
        {session.rolePolicy !== undefined && <p data-dsmm-session-policy>{t("roleState", { route: session.rolePolicy.route === undefined ? t("inheritRoute") : `${session.rolePolicy.route.provider}/${session.rolePolicy.route.model}${session.rolePolicy.route.reasoningEffort === undefined ? "" : ` (${session.rolePolicy.route.reasoningEffort})`}`, strategy: session.rolePolicy.strategy, retries: session.rolePolicy.retries, failures: session.rolePolicy.rateLimitFailures, switches: session.rolePolicy.switches, delay: session.rolePolicy.totalDelayMs })}</p>}
        </details>}
      </>}
      {state.dirty && <p className="dsmm-hint">{t("sessionDirty")}</p>}
      {(session?.refreshRequired || session?.selection.refreshRequired) && <p role="status">{t("sessionCommittedRefresh")}</p>}
      {state.sessionUnconfirmed && <p role="status">{t("sessionUnconfirmedRefresh")}</p>}
      <div className="dsmm-actions"><Button type="button" variant="outline" disabled={disabled || !allowed || (state.sessionChoice !== null && !isConfigRevision(selected?.revision))} aria-describedby={!allowed ? `${prefix}-overlay-reason` : undefined} onClick={() => { if (current()) void actions.applySession(); }}>{t(state.sessionBusy === "apply" ? "sessionApplying" : "sessionApply")}</Button>
        {!compact && <Button type="button" variant="outline" disabled={disabled || !allowed} aria-describedby={!allowed ? `${prefix}-overlay-reason` : undefined} onClick={() => { if (current()) void actions.resetSession(); }}>{t(state.sessionBusy === "reset" ? "sessionResetting" : "sessionReset")}</Button>}
        <Button type="button" variant="outline" disabled={state.sessionBusy !== null || state.busy !== null || state.pendingEditor !== null} onClick={() => { if (current()) void actions.refreshSession(); }}>{t("sessionRefresh")}</Button>
      </div>
    </>}
    {state.sessionIssue !== null && <p role="alert">{state.sessionIssue.source === "profile-model" ? t(state.sessionIssue.code === "model-unconfigured" ? "headerNoProfileModel" : state.sessionIssue.code === "model-choice-changed" ? "headerModelChoiceChanged" : "headerModelUnconfirmed")
      : state.sessionIssue.code === "conflict" ? t("sessionConflict")
      : ["busy", "maintenance", "disposed", "not-owned"].includes(state.sessionIssue.code) ? t("sessionBusy", { reason: state.sessionIssue.code })
       : t(state.sessionIssue.code === "validation" ? "validation" : "sessionUnavailable")}</p>}
    {state.sessionIssue !== null && <IssueDetails issue={state.sessionIssue} t={t} />}
    <p className="dsmm-status" role="status" aria-live="polite" aria-atomic="true">{state.sessionBusy === "read" ? t("reading") : status}</p>
  </div>;
}

/** Root-scoped native menu; an explicitly scoped foreign occurrence still refuses. */
export function SessionProfiles(props: SessionProfilesProps) {
  const prefix = useId();
  const state = props.useProfiles((snapshot: ProfilesViewSnapshot) => snapshot);
  const id = state.currentSessionId;
  const [openFor, setOpenFor] = useState<string | null | undefined>(undefined);
  useEffect(() => { setOpenFor(undefined); }, [id]);
  if (props.sessionId !== undefined && props.sessionId !== id) return null;
  const { t } = props;
  const session = state.session;
  const admission = session?.admittedSelection;
  const unknownCaptured = session !== null && admission === undefined;
  const current = session === null ? "__dsmm_session_unavailable__" : unknownCaptured ? "__dsmm_captured_default__" : admission?.selectedId ?? "";
  const profiles = state.snapshot?.profiles ?? [];
  const currentSaved = profiles.find((profile) => profile.id === current);
  const committing = state.sessionBusy !== null;
  const unavailable = id === null || committing || state.busy !== null || state.sessionUnconfirmed || session === null || session.refreshRequired === true || session.selection.refreshRequired === true;
  const profileDisabled = unavailable || state.pendingEditor !== null || state.dirty || state.invalidFields.length > 0
    || session === null || !writableSelectionVersion(session.selection.selectionRevision);
  const disabled = profileDisabled || session?.canApplyOverlay !== true || session?.applyOverlayUnavailableReason === "new-session-required" || state.snapshot === null;
  let feedback = "";
  if (state.sessionUnconfirmed) feedback = t("sessionUnconfirmedRefresh");
  else if (session?.refreshRequired || session?.selection.refreshRequired) feedback = t("sessionCommittedRefresh");
  else if (state.sessionIssue !== null) feedback = t(state.sessionIssue.source === "profile-model" ? state.sessionIssue.code === "model-unconfigured" ? "headerNoProfileModel" : state.sessionIssue.code === "model-choice-changed" ? "headerModelChoiceChanged" : "headerModelUnconfirmed"
    : state.sessionIssue.code === "conflict" ? "headerConflict" : state.sessionIssue.code === "activation" ? "headerActivationRefused"
    : state.sessionIssue.code === "maintenance" ? "headerMaintenanceRefused" : state.sessionIssue.code === "busy" ? "headerBusyRefused"
    : state.sessionIssue.code === "cancelled" ? "headerCancelledRefused" : state.sessionIssue.code === "unavailable" || state.sessionIssue.kind === "assembly" ? "headerUnavailableRefused" : "headerSelectionRefused");
  else if (committing || state.busy !== null) feedback = t(state.sessionBusy === "apply" || state.sessionBusy === "reset" ? "headerApplying" : "headerLoading");
  else if (state.dirty || state.invalidFields.length > 0 || state.pendingEditor !== null) feedback = t("headerDraft");
   else if (id === null) feedback = t("sessionChooseWorkspace");
  else if (session === null || state.snapshot === null) feedback = t("headerUnavailable");
  else if (state.sessionNotice !== null) feedback = t(state.sessionNotice === "mode-on" ? "headerModeOn" : state.sessionNotice === "mode-off" ? "headerModeOff" : state.sessionNotice === "applied-with-model" ? "headerAppliedWithModel" : "headerApplied");
  const profileName = unknownCaptured ? t("headerCaptured") : admission !== undefined && sourceRelationship(admission, currentSaved?.revision) === "current" && currentSaved?.label?.trim() ? currentSaved.label : admission?.selectedId ?? t("sessionBaseline");
  const currentLabel = t("headerCurrentProfile", { profile: session === null ? t("headerUnavailable") : profileName });
  const entries: MenuEntry[] = [{ type: "label", id: "@current", text: currentLabel }];
  for (const warning of profileWarnings(session?.warnings)) entries.push({ type: "label", id: `@warning:${warning.code}`, text: t("warningMarker", { code: warning.code, field: warning.field }) });
  if ((id === null || session?.canApplyOverlay === true) && state.snapshot !== null) entries.push({ type: "label", id: "@future", text: t("sessionFutureDefault", { profile: state.snapshot.profiles.find((profile) => profile.id === state.snapshot!.selectedId)?.label?.trim() || state.snapshot.selectedId || t("sessionBaseline") }) });
  if (feedback !== "" && (state.sessionNotice === null || state.sessionIssue !== null || state.sessionUnconfirmed || session?.refreshRequired || session?.selection.refreshRequired)) entries.push({ type: "label", id: "@status", text: feedback });
  const mode = session?.deepwork;
  entries.push({ id: "@mode", label: t(mode === undefined ? "headerModeUnavailable" : mode.locked ? "headerModePreset" : mode.active ? "headerModeDisable" : "headerModeEnable"),
     disabled: unavailable || session?.canToggleMode !== true || mode === undefined || mode.locked });
  if (session !== null && session.canToggleMode !== true) entries.push({ type: "label", id: "@mode-reason", text: capabilityReason(session.toggleModeUnavailableReason, t) });
  const diagnostic = state.sessionIssue === null ? null : menuIssue(state.sessionIssue);
  const diagnosticText = diagnostic === null ? "" : t("headerIssueCode", { code: diagnostic.code }) + (diagnostic.field === undefined ? "" : ` ${t("headerIssueField", { field: diagnostic.field })}`);
  const retryHint = t(state.sessionUnconfirmed ? "sessionUnconfirmedRefresh" : diagnostic?.code === "maintenance" || diagnostic?.code === "busy" ? "headerWaitRetryHint" : "headerRetryHint");
  if (diagnostic !== null) entries.push({ type: "label", id: "@diagnostic", text: diagnosticText }, { type: "label", id: "@retry", text: retryHint });
  if (admission?.selectedId != null && currentSaved === undefined) entries.push({ id: admission.selectedId, label: `${admission.selectedId} — ${t("headerSavedUnavailable")}`, disabled: true });
  if (unknownCaptured) entries.push({ id: "__dsmm_captured_default__", label: t("headerCaptured"), disabled: true });
  entries.push({ type: "separator", id: "@keep-separator" }, { type: "label", id: "@keep-heading", text: t("headerCompactProfiles") }, { id: "", label: t("sessionBaseline"), disabled });
  if (session !== null && (session.canApplyOverlay !== true || session.applyOverlayUnavailableReason === "new-session-required")) entries.push({ type: "label", id: "@overlay-reason", text: capabilityReason(session.applyOverlayUnavailableReason, t) });
   for (const profile of profiles) entries.push({ id: profile.id, label: (profile.label?.trim() ? profile.label : profile.id) + (profile.error === undefined && isConfigRevision(profile.revision) ? "" : ` — ${t("headerSavedUnavailable")}`) + (profileWarnings(profile.warnings).length ? ` — ${t("warningProfile")}` : ""), disabled: disabled || !isConfigRevision(profile.revision) || profile.error !== undefined });
  entries.push({ type: "separator", id: "@model-separator" }, { id: "@use-model", label: t("headerUseCurrentModel"), disabled: profileDisabled || session?.canSelectModel !== true || session?.profileModel === undefined });
  if (session !== null && session.canSelectModel !== true) entries.push({ type: "label", id: "@model-reason", text: capabilityReason(session.selectModelUnavailableReason, t) });
  const open = openFor === id;
  return <div className="dsmm-header-profiles" data-dsmm-header-profile aria-busy={committing}>
    <Menu open={open} autoFocus portal align="start" className="dsmm-profile-anchor" listClassName="dsmm-profile-menu" items={entries} selectedId={current}
      footer={[{ id: "@refresh", label: t("headerCompactRefresh"), disabled: committing || state.busy !== null }]}
      anchor={<Button type="button" size="sm" variant="toolbar" className="dsmm-profile-trigger" icon={<IconBranchOutlineRegular />} aria-label={t("headerProfileLabel")} aria-haspopup="menu" aria-expanded={open} aria-describedby={`${prefix}-feedback`} onClick={() => setOpenFor(open ? undefined : id)} />}
      onClose={() => setOpenFor(undefined)} onSelect={(value) => {
         const live = props.readProfileView();
         if (live.currentSessionId !== id || live.sessionViewEpoch !== state.sessionViewEpoch || live.session !== session) return;
        if (value === "@refresh") {
          if (committing || state.busy !== null) return;
           void (async () => { await props.refresh(); if (id !== null && props.readProfileView().currentSessionId === id && props.readProfileView().sessionViewEpoch === state.sessionViewEpoch) await props.refreshSession(); })();
        } else {
          const row = entries.find((entry) => entry.id === value && !("type" in entry));
          if (row === undefined || !("disabled" in row) || row.disabled) return;
          if (value === "@mode") { if (mode !== undefined) void props.setDeepwork(!mode.active); }
          else if (value === "@use-model") void props.useSessionProfileModel();
          else { props.chooseSessionProfile(value || null); void props.applySession(); }
        }
        setOpenFor(undefined);
      }} />
    <span className="dsmm-profile-announcement" id={`${prefix}-feedback`} role={state.sessionIssue === null ? "status" : "alert"} aria-live="polite" aria-atomic="true">{feedback || currentLabel}{diagnostic === null ? "" : ` ${diagnosticText} ${retryHint}`}</span>
  </div>;
}
