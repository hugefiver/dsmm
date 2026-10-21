import { useId, useRef } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { DsmmInvocationView, RoleControlAvailability, RoleControlChildView } from "../role-control-types.js";
import type { DsmmRoleRouteComparison } from "../profile-types.js";
import { childActionKey, EMPTY_CHILD_DRAFT, enabled } from "./children-controller.js";
import type { ChildrenActions, ChildrenController, ChildrenIssue, ChildrenSnapshot, ChildOutcome } from "./children-controller.js";
import type { ChildrenLocaleKey } from "./children-locales.js";

type Locale = PropsLocale<"conversation.dsmm-children">;
export type ChildrenInjected = ChildrenActions & { hooks: { children: ChildrenController["store"] } };
export type ChildrenPanelProps = InjectFace<ChildrenInjected> & Locale & { sessionId?: string };
export function ControlAvailability({ value, label, t }: Locale & { value?: RoleControlAvailability; label: ChildrenLocaleKey }) {
  return <div className="dsmm-availability"><p>{t(label)}: {t(value?.enabled === true ? "enabled" : "disabled")}</p>
    {value?.enabled !== true && <p className="dsmm-hint">{t(`reason:${value?.reason ?? "unavailable"}`)}</p>}</div>;
}
function routeText(route: Readonly<NonNullable<DsmmInvocationView["route"]>>): string {
  return `${route.provider}/${route.model}${route.reasoningEffort === undefined ? "" : ` (${route.reasoningEffort})`}`;
}
export function RouteComparisonDetails({ value, t }: Locale & { value?: DsmmRoleRouteComparison }) {
  const initial = value?.initialRoute, live = value?.liveRoute;
  const liveReasons = { "no-own-request-header": "routeNoOwnHeader", "invalid-own-request-header": "routeInvalidOwnHeader", "not-observed": "routeNotObserved" } as const;
  return <div className="dsmm-availability">
    {value === undefined && <p className="dsmm-hint">{t("comparisonUnobserved")}</p>}
    <dl className="dsmm-child-meta">
      <dt>{t("initialRoute")}</dt><dd>{initial?.status === "known" ? routeText(initial.route) : t("routeUnknown")}</dd>
      {initial?.status === "known" ? <><dt>{t("initialRouteSource")}</dt><dd>{t("routeCaptureSource")} · {initial.source}</dd></>
        : initial !== undefined && <><dt>{t("initialRouteReason")}</dt><dd>{t("routeMissingCapture")} · {initial.reason}</dd></>}
      <dt>{t("liveRoute")}</dt><dd>{live?.status === "known" ? routeText(live.route) : t("routeUnknown")}</dd>
      {live?.status === "known" ? <><dt>{t("liveRouteSource")}</dt><dd>{t("routeOwnHeaderSource")} · {live.source}</dd></>
        : live !== undefined && <><dt>{t("liveRouteReason")}</dt><dd>{t(liveReasons[live.reason])} · {live.reason}</dd></>}
    </dl>
  </div>;
}
export function InvocationDetails({ value, t, showComparison = true }: Locale & { value?: DsmmInvocationView; showComparison?: boolean }) {
  if (value === undefined) return <p className="dsmm-hint">{t("invocationUnavailable")}</p>;
  return <>{showComparison && <RouteComparisonDetails value={value.routeComparison} t={t} />}<dl className="dsmm-child-meta">
    <dt>{t("role")}</dt><dd>{value.label} · {value.role}</dd><dt>{t("level")}</dt><dd>{value.level}</dd><dt>{t("mode")}</dt><dd>{value.mode}</dd>
    <dt>{t("reportedRoute")}</dt><dd>{value.route === undefined ? t("routeUnreported") : routeText(value.route)}</dd>
    <dt>{t("routeSource")}</dt><dd>{value.routeSource}</dd>
    {value.runId !== undefined && <><dt>{t("runId")}</dt><dd>{value.runId}</dd></>}
    {value.childId !== undefined && <><dt>{t("childId")}</dt><dd>{value.childId}</dd></>}
    {value.jobId !== undefined && <><dt>{t("jobId")}</dt><dd>{value.jobId}</dd></>}
  </dl></>;
}
function Issue({ value, t }: Locale & { value?: ChildrenIssue | null }) {
  if (!value) return null;
  return <div className="dsmm-issue" role="alert"><p>{t(value.unknown ? "unknownAction" : "error", { code: value.code })}</p>
    <p>{value.code}{value.field === undefined ? "" : ` · ${t("field")}: ${value.field}`}</p>{value.reason !== undefined && <p>{t(`reason:${value.reason}`)}</p>}</div>;
}
function Outcome({ value, t }: Locale & { value?: ChildOutcome }) {
  if (!value) return null;
  return <div className="dsmm-availability" role="status" aria-live="polite">
    {value.kind === "prompt" ? <p>{t("promptAccepted", { id: value.receipt.messageId })}</p>
      : <p>{t("interruptAccepted")}</p>}
  </div>;
}
export function ChildComposer({ child, state, actions, t }: Locale & { child: RoleControlChildView; state: ChildrenSnapshot; actions: ChildrenActions }) {
  const prefix = useId(), picker = useRef<HTMLInputElement>(null), generation = state.generation, key = childActionKey(child.id);
  const draft = state.drafts.get(child.id) ?? EMPTY_CHILD_DRAFT;
  const pending = state.pending.has(key), available = state.fresh && !state.reading && !pending;
  const canPrompt = available && enabled(state.snapshot?.capabilities.prompt) && enabled(child.controls.prompt) && !child.readonly && child.mode === "continuable";
  const canImages = canPrompt && enabled(state.snapshot?.capabilities.images) && !draft.imageBusy;
  const submit = canPrompt && !draft.uncertain && !draft.imageBusy && (draft.text.trim() !== "" || draft.images.length > 0)
    && (draft.images.length === 0 || enabled(state.snapshot?.capabilities.images));
  return <form className="dsmm-child-composer" aria-label={t("prompt")} onSubmit={event => { event.preventDefault(); if (submit) void actions.prompt(generation, child.id); }}>
    {!state.fresh && <p className="dsmm-hint">{t(state.reading ? "reading" : "stale")}</p>}
    <div className="dsmm-field"><label htmlFor={`${prefix}-message`}>{t("text")}</label>
      <textarea id={`${prefix}-message`} className="dsmm-child-message" rows={4} value={draft.text} disabled={pending} aria-describedby={`${prefix}-delivery-hint${draft.uncertain ? ` ${prefix}-unknown` : ""}`}
        onChange={event => actions.editText(generation, child.id, event.currentTarget.value)} />
    </div>
    <div className="dsmm-field"><label htmlFor={`${prefix}-delivery`}>{t("delivery")}</label>
      <select id={`${prefix}-delivery`} value={draft.delivery} disabled={!canPrompt} aria-describedby={`${prefix}-delivery-hint`} onChange={event => {
        const value = event.currentTarget.value; if (value === "queue" || value === "steer") actions.setDelivery(generation, child.id, value);
      }}><option value="queue">{t("queue")}</option><option value="steer">{t("steer")}</option></select>
      <p id={`${prefix}-delivery-hint`} className="dsmm-hint">{t("deliveryHint")}</p>
    </div>
    <div className="dsmm-field"><p id={`${prefix}-images-hint`} className="dsmm-hint">{t("imagesHint")}</p>
      <input ref={picker} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple disabled={!canImages} aria-label={t("images")} onChange={event => {
        const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; if (canImages) void actions.addImages(generation, child.id, files);
      }} />
      <Button type="button" variant="outline" disabled={!canImages} aria-describedby={`${prefix}-images-hint`} onClick={() => { if (canImages) picker.current?.click(); }}>{t("images")}</Button>
      <ControlAvailability value={state.snapshot?.capabilities.images} label="imageAvailability" t={t} />
      {draft.images.length > 0 && <ul className="dsmm-profile-list">{draft.images.map((image, index) => <li key={index}><p>{image.name ?? image.mediaType} · {image.mediaType}</p>
        <Button type="button" variant="outline" disabled={pending || draft.imageBusy} onClick={() => actions.removeImage(generation, child.id, image)} aria-label={`${t("removeImage")}: ${image.name ?? image.mediaType}`}>{t("removeImage")}</Button></li>)}</ul>}
    </div>
    {draft.uncertain && <div className="dsmm-warning"><p id={`${prefix}-unknown`}>{t("unknown")}</p><Button type="button" variant="outline" disabled={!state.fresh || state.reading || pending} onClick={() => actions.acknowledgeUnknown(generation, child.id)}>{t("acknowledge")}</Button></div>}
    <ControlAvailability value={!enabled(state.snapshot?.capabilities.prompt) ? state.snapshot?.capabilities.prompt : child.controls.prompt} label="promptAvailability" t={t} />
    {draft.text.trim() === "" && draft.images.length === 0 && <p className="dsmm-hint">{t("emptyMessage")}</p>}
    {draft.images.length > 0 && !enabled(state.snapshot?.capabilities.images) && <p className="dsmm-hint">{t("deniedImages")}</p>}
    <div className="dsmm-actions"><Button type="submit" variant="primary" disabled={!submit}>{t("send")}</Button>
      <Button type="button" variant="outline" disabled={!available || !enabled(state.snapshot?.capabilities.interrupt) || !enabled(child.controls.interrupt) || child.readonly || child.mode !== "continuable"}
        onClick={() => void actions.interrupt(generation, child.id)}>{t("interrupt")}</Button></div>
    <p className="dsmm-status" role="status" aria-live="polite">{pending ? t("pending") : draft.imageBusy ? t("imageReading") : ""}</p>
  </form>;
}
export function ChildDetails({ child, state, actions, t, inspection = false }: Locale & { child: RoleControlChildView; state: ChildrenSnapshot; actions: ChildrenActions; inspection?: boolean }) {
  return <fieldset><legend>{child.label?.trim() ? child.label : child.id}</legend>
    <p>{t("childId")}: {child.id}</p><p>{t("parentId")}: {child.parentSessionId}</p><p>{t("mode")}: {child.mode}</p><p>{t("activity")}: {child.activity}</p>
    {(inspection || child.readonly) && <p>{t("readonly")}</p>}{child.mode === "one-shot" && <p className="dsmm-hint">{t("oneShot")}</p>}
    <RouteComparisonDetails value={child.routeComparison} t={t} /><InvocationDetails value={child.invocation} t={t} showComparison={false} />
    {(!inspection || !child.controls.prompt.enabled) && <ControlAvailability value={child.controls.prompt} label="promptAvailability" t={t} />}
    {(!inspection || !child.controls.interrupt.enabled) && <ControlAvailability value={child.controls.interrupt} label="interruptAvailability" t={t} />}
    {!inspection && child.mode === "continuable" && !child.readonly && <ChildComposer child={child} state={state} actions={actions} t={t} />}
    {!inspection && <><Issue value={state.issues.get(childActionKey(child.id))} t={t} /><Outcome value={state.outcomes.get(childActionKey(child.id))} t={t} /></>}
  </fieldset>;
}
/** Native session-scoped Conversation View, not a replacement composer or navigation shell. */
export function ChildrenPanel(props: ChildrenPanelProps) {
  const state = props.useChildren(snapshot => snapshot), { t } = props, generation = state.generation;
  if (props.sessionId === undefined || props.sessionId !== state.sessionId) return <section className="dsmm-profiles dsmm-children"><h2>{t("title")}</h2><p>{t(state.sessionId === null ? "noSession" : "foreign")}</p></section>;
  const data = state.snapshot;
  const refreshingDisabled = state.reading || state.pending.size > 0 || [...state.drafts.values()].some(draft => draft.imageBusy);
  return <section className="dsmm-profiles dsmm-children" aria-label={t("title")} aria-busy={state.reading}>
    <h2>{t("title")}</h2><p className="dsmm-hint">{t("description")}</p><p>{t("session")}: {state.sessionId}</p>
    <div className="dsmm-actions"><Button type="button" variant="outline" disabled={refreshingDisabled} onClick={() => void props.refresh(generation)}>{t("refresh")}</Button></div>
    <p className="dsmm-status" role="status" aria-live="polite">{state.reading ? t("reading") : state.pending.size > 0 ? t("pending") : !state.fresh ? t(data === null ? "unavailable" : "stale") : ""}</p>
    <Issue value={state.issue} t={t} />
    {data !== null && <>
      <p>{t("epoch")}: {data.admissionEpoch}</p>
      <section className="dsmm-availability"><p>{t("runtime")}: {data.capabilities.runtime.binding}</p><p>{t("fence")}: {t(data.capabilities.runtime.deliveryFenceReady ? "yes" : "no")}</p><p>{t("restart")}: {t(data.capabilities.runtime.restartRequired ? "yes" : "no")}</p>
        {data.capabilities.runtime.reason !== undefined && <p>{t("authority")}</p>}
         <ControlAvailability value={data.capabilities.prompt} label="promptAvailability" t={t} /><ControlAvailability value={data.capabilities.interrupt} label="interruptAvailability" t={t} />
      </section>
      <p className="dsmm-hint">{t("backgroundHint")}</p>
      <section className="dsmm-zone" aria-label={t("children")}><h3>{t("children")}</h3>{data.children.length === 0 ? <p className="dsmm-hint">{t("emptyChildren")}</p>
        : data.children.map(child => <ChildDetails key={child.id} child={child} state={state} actions={props} t={t} />)}</section>
    </>}
    <section className="dsmm-zone" aria-label={t("descendants")}><h3>{t("descendants")}</h3><Issue value={state.descendantIssue} t={t} />
      {state.descendants === null ? <p className="dsmm-hint">{t("treeUnavailable")}</p> : state.descendants.descendants.length === 0 ? <p className="dsmm-hint">{t("emptyDescendants")}</p>
        : state.descendants.descendants.map((entry, index) => <div className="dsmm-availability" key={index}>
          <p>{t("depth")}: {entry.depth}</p>{entry.kind === "diagnostic" ? <div className="dsmm-issue"><p>{t("diagnostic", { reason: entry.reason })}</p><p>{t("childId")}: {entry.id}</p><p>{t("parentId")}: {entry.parentSessionId}</p></div>
            : <><p>{t("subtree")}: {t(entry.hasChildren ? "yes" : "no")}</p><ChildDetails child={entry.child} state={state} actions={props} t={t} inspection /></>}
        </div>)}
    </section>
  </section>;
}
