import { useEffect, useId, useState } from "react";
import type { Ref } from "react";
import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { ModelCatalog } from "@deepseek-ai/dsh-api-session-controller";
import { DSMM_LOCALES } from "../profile-locale.js";
import type { DsmmInvocationLevel, DsmmLevelOverride, DsmmModelRoute } from "../settings.js";
import type { DsmmRateLimitPolicy, DsmmRuntimePolicyConfig, DsmmRuntimePolicySettings } from "../routing-policy.js";
import { DSMM_RATE_LIMIT_BOUNDS } from "../routing-policy.js";
import type { ProfilesActions, ProfilesViewSnapshot } from "./controller.js";
import { structuredDocument } from "./structured.js";
import type { JsonPath, StructuredDocument } from "./structured.js";
import { RETRY_FIELD_LABEL_KEYS } from "./locales.js";
import { EditableChoice } from "./EditableChoice.js";

type Locale = PropsLocale<"settings.dsmm-profiles">;
type Edit = ProfilesActions["editPath"];

export function RetryNumber({ id, name, field, value, inherited, path, disabled, actions, t }: Locale & {
  id: string; name: string; field: keyof DsmmRateLimitPolicy; value: number | undefined; inherited: number | undefined; path: JsonPath; disabled: boolean; actions: ProfilesActions;
}) {
  const key = path.join(".");
  const stored = actions.getNumberDraft?.(key);
  const sourceChanged = stored !== undefined && value !== stored.sourceValue;

  const [draft, setDraft] = useState(stored && !sourceChanged ? stored.draft : (value === undefined ? "" : String(value)));
  const [invalid, setInvalid] = useState(stored && !sourceChanged ? stored.invalid : false);
  const [min, max] = DSMM_RATE_LIMIT_BOUNDS[field];

  useEffect(() => {
    const currentStored = actions.getNumberDraft?.(key);
    if (currentStored && value !== currentStored.sourceValue) {
      setDraft(value === undefined ? "" : String(value));
      setInvalid(false);
    } else if (!currentStored) {
      setDraft(value === undefined ? "" : String(value));
      setInvalid(false);
    }
  }, [value, key, actions]);

  const displayDraft = sourceChanged ? (value === undefined ? "" : String(value)) : draft;
  const isInvalid = sourceChanged ? false : invalid;

  return <div className="dsmm-field"><label htmlFor={id}>{t("retryField", { name, field: t(RETRY_FIELD_LABEL_KEYS[field]) })}</label>
    <Input id={id} data-dsmm-policy-field={field} className="dsmm-input" type="number" inputMode="numeric" min={min} max={max} step={1} disabled={disabled} value={displayDraft} placeholder={inherited === undefined ? t("unknownDefault") : t("inheritNumber", { value: inherited })}
      aria-invalid={isInvalid || undefined} aria-describedby={`${id}-hint${isInvalid ? ` ${id}-invalid` : ""}`} onChange={(event) => {
        const input = event.currentTarget;
        const valStr = input.value;
        const valid = input.validity.valid && (valStr === "" || Number.isSafeInteger(input.valueAsNumber));
        setDraft(valStr);
        setInvalid(!valid);
        if (!valid) {
          actions.setNumberDraft?.(key, { draft: valStr, invalid: true, sourceValue: value });
          actions.setFieldInvalid(key, true);
        } else {
          actions.setNumberDraft?.(key, null);
          actions.setFieldInvalid(key, false);
          actions.editPath(path, valStr === "" ? undefined : input.valueAsNumber);
        }
      }} />
    <p className="dsmm-hint" id={`${id}-hint`}>{t("retryBounds", { min, max, value: inherited ?? t("unknownDefault") })}</p>
    {isInvalid && <p id={`${id}-invalid`}>{t("invalidNumber")}</p>}
  </div>;
}

export function RouteFields({ value, path, name, catalog, disabled, edit, editRoute, t, naturalLabels }: Locale & {
  value: DsmmModelRoute; path: JsonPath; name?: string; catalog: ModelCatalog | null; disabled: boolean; edit: Edit; editRoute: ProfilesActions["editRoute"]; naturalLabels?: boolean;
}) {
  const prefix = useId();
  const providers = catalog?.groups ?? [];
  const group = providers.find((candidate) => candidate.id === value.provider);
  const model = group?.models.find((candidate) => candidate.id === value.model);
  const efforts = model?.reasoning?.efforts ?? [];
  const updateModel = (provider: string, modelId: string) => {
    // This is an explicit user change, not a catalog refresh. Clear only this
    // route's adapter-owned effort; do not save or touch the native model default.
    editRoute(path, provider, modelId);
  };
  const providerLabel = naturalLabels ? t("naturalProvider") : t("routeProvider", { name: name ?? "" });
  const modelLabel = naturalLabels ? t("naturalModel") : t("routeModel", { name: name ?? "" });
  const effortLabel = naturalLabels ? t("naturalEffort") : t("routeEffort", { name: name ?? "" });
  return <div className="dsmm-route-fields">
    <div className="dsmm-field"><label htmlFor={`${prefix}-provider`}>{providerLabel}</label>
      <EditableChoice id={`${prefix}-provider`} label={providerLabel} value={value.provider} options={providers} disabled={disabled}
        onChange={provider => updateModel(provider, value.model)} onSelect={provider => updateModel(provider, "")} />
    </div>
    <div className="dsmm-field"><label htmlFor={`${prefix}-model`}>{modelLabel}</label>
      <EditableChoice id={`${prefix}-model`} label={modelLabel} value={value.model} options={group?.models ?? []} disabled={disabled}
        onChange={modelId => updateModel(value.provider, modelId)} />
    </div>
    <div className="dsmm-field"><label htmlFor={`${prefix}-effort`}>{effortLabel}</label>
      <EditableChoice id={`${prefix}-effort`} label={effortLabel} value={value.reasoningEffort ?? ""} options={efforts} disabled={disabled} placeholder={t("effortDefault")}
        onChange={effort => edit([...path, "reasoningEffort"], effort || undefined)} />
    </div>
  </div>;
}

export function PolicyFields({ value, inherited, path, name, disabled, actions, t }: Locale & {
  value: DsmmRuntimePolicyConfig; inherited: DsmmRuntimePolicySettings | undefined; path: JsonPath; name: string; disabled: boolean; actions: ProfilesActions;
}) {
  const prefix = useId();
  return <div className="dsmm-policy-fields">
    <div className="dsmm-field"><label htmlFor={`${prefix}-strategy`}>{t("strategy", { name })}</label>
      <select id={`${prefix}-strategy`} disabled={disabled} value={value.strategy ?? ""} onChange={(event) => actions.editPath([...path, "strategy"], event.currentTarget.value || undefined)}>
        <option value="">{t("inheritStrategy", { value: inherited?.strategy ?? t("unknownDefault") })}</option>
        <option value="startup-lock">{t("startupLock")}</option><option value="rate-limit-fallback">{t("rateFallback")}</option>
      </select>
    </div>
    <p className="dsmm-hint">{t("strategyHint")}</p>
    <div className="dsmm-route-fields">
      {(Object.keys(DSMM_RATE_LIMIT_BOUNDS) as (keyof DsmmRateLimitPolicy)[]).map((field) => (
        <RetryNumber
          key={field}
          id={`${prefix}-${field}`}
          t={t}
          name={name}
          field={field}
          value={value.rateLimit?.[field]}
          inherited={inherited?.rateLimit[field]}
          path={[...path, "rateLimit", field]}
          disabled={disabled}
          actions={actions}
        />
      ))}
    </div>
  </div>;
}

export function LevelFields({ level, value, path, catalog, disabled, actions, t }: Locale & {
  level: Exclude<DsmmInvocationLevel, "normal">; value?: DsmmLevelOverride; path: JsonPath; catalog: ModelCatalog | null; disabled: boolean; actions: ProfilesActions;
}) {
  const prefix = useId();
  const mode = value === undefined ? "inherit" : value.provider === undefined ? "effort" : "route";
  return <fieldset data-dsmm-level={level}><legend>{t("levelName", { level })}</legend>
    <div className="dsmm-field"><label htmlFor={`${prefix}-mode`}>{t("levelMode", { level })}</label>
      <select id={`${prefix}-mode`} value={mode} disabled={disabled} onChange={event => actions.editPath(path,
        event.currentTarget.value === "inherit" ? undefined : event.currentTarget.value === "effort" ? { reasoningEffort: "" } : { provider: "", model: "" })}>
        <option value="inherit">{t("levelUnconfigured")}</option><option value="effort">{t("levelEffortOnly")}</option><option value="route">{t("levelFullRoute")}</option>
      </select>
    </div>
    {mode === "effort" && <div className="dsmm-field"><label htmlFor={`${prefix}-effort`}>{t("routeEffort", { name: level })}</label>
      <EditableChoice id={`${prefix}-effort`} label={t("routeEffort", { name: level })} value={value?.reasoningEffort ?? ""} options={[]} disabled={disabled}
        onChange={effort => actions.editPath([...path, "reasoningEffort"], effort)} />
    </div>}
    {value?.provider !== undefined && <RouteFields value={value} path={path} name={t("levelName", { level })} catalog={catalog} disabled={disabled} edit={actions.editPath} editRoute={actions.editRoute} t={t} />}
  </fieldset>;
}

export type BasicSettingsProps = Locale & {
  state: ProfilesViewSnapshot;
  actions: ProfilesActions;
  disabled: boolean;
  inputRef?: Ref<HTMLInputElement>;
  idInvalid?: boolean;
  orchestratorRef?: Ref<HTMLDivElement>;
  onJumpToJsonc?: () => void;
};

export function BasicSettings({ state, actions, disabled, inputRef, idInvalid, orchestratorRef, onJumpToJsonc, t }: BasicSettingsProps) {
  const prefix = useId();
  const editor = state.editor;
  if (editor === null) return null;
  const document = structuredDocument(editor.content);
  if (document === null) {
    return <div className="dsmm-structured-invalid" data-dsmm-structured-invalid>
      <p>{t("rawInvalid")}</p>
      <p className="dsmm-hint">{t("rawInvalidFormDisabled")}</p>
      {onJumpToJsonc && <Button type="button" variant="outline" onClick={onJumpToJsonc}>{t("viewConfiguration")}</Button>}
    </div>;
  }

  const orchPolicy = document.roleRouting["dsmm-orchestrator"] ?? {};
  const orchPath: JsonPath = ["settings", "roleRouting", "dsmm-orchestrator"];

  return <div className="dsmm-basic-settings" data-dsmm-basic-settings>
    <div className="dsmm-field">
      <label htmlFor={`${prefix}-label`}>{t("profileLabel")}</label>
      <Input id={`${prefix}-label`} className="dsmm-input" value={document.label ?? ""} disabled={disabled} onChange={(event) => actions.editPath(["label"], event.currentTarget.value)} />
      <Button type="button" variant="outline" disabled={disabled || document.label === undefined} onClick={() => actions.editPath(["label"], undefined)}>{t("omitLabel")}</Button>
    </div>

    <div className="dsmm-field">
      <label htmlFor={`${prefix}-id`}>{t("profileId")}</label>
      <Input ref={inputRef} id={`${prefix}-id`} className="dsmm-input" value={editor.id} disabled={disabled || editor.revision !== null} aria-invalid={idInvalid || undefined} aria-describedby={`${prefix}-id-hint${idInvalid ? ` ${prefix}-issue` : ""}`} onChange={(event) => actions.editId(event.currentTarget.value)} />
      <p id={`${prefix}-id-hint`} className="dsmm-hint">{t("idHint")}</p>
    </div>

    <div ref={orchestratorRef} className="dsmm-field" id={`${prefix}-orchestrator-primary`}>
      <label htmlFor={`${prefix}-orch-mode`}>{t("orchestratorModel")}</label>
      <p className="dsmm-hint">{t("orchestratorModelDesc")}</p>
      <select id={`${prefix}-orch-mode`} disabled={disabled} value={orchPolicy.primary === undefined ? "inherit" : "explicit"} onChange={(event) => actions.editPath([...orchPath, "primary"], event.currentTarget.value === "inherit" ? undefined : { provider: "", model: "" })}>
        <option value="inherit">{t("inheritRoute")}</option>
        <option value="explicit">{t("configuredRoute")}</option>
      </select>
      {orchPolicy.primary !== undefined && <RouteFields t={t} value={orchPolicy.primary} path={[...orchPath, "primary"]} naturalLabels={true} catalog={state.catalog} disabled={disabled} edit={actions.editPath} editRoute={actions.editRoute} />}
      <p className="dsmm-hint">{t("effortChangeHint")}</p>
    </div>

    <div className="dsmm-field"><label htmlFor={`${prefix}-locale`}>{t("businessLocale")}</label>
      <select id={`${prefix}-locale`} value={String(document.settings.locale ?? "")} disabled={disabled} aria-describedby={`${prefix}-locale-hint`} onChange={event => actions.editPath(["settings", "locale"], event.currentTarget.value || undefined)}>
        <option value="">{t("inheritLocale")}</option>
        {typeof document.settings.locale === "string" && !(DSMM_LOCALES as readonly string[]).includes(document.settings.locale) && <option value={document.settings.locale}>{t("unsupportedLocale")}</option>}
        {DSMM_LOCALES.map(locale => <option value={locale} key={locale}>{locale}</option>)}
      </select><p id={`${prefix}-locale-hint`} className="dsmm-hint">{t("localeHint")}</p>
    </div>

    <div className="dsmm-field"><label htmlFor={`${prefix}-active`}>{t("defaultActive")}</label><select id={`${prefix}-active`} disabled={disabled} value={document.settings.defaultActive === undefined ? "" : String(document.settings.defaultActive)} onChange={(event) => actions.editPath(["settings", "defaultActive"], event.currentTarget.value === "" ? undefined : event.currentTarget.value === "true")}><option value="">{t("inherit")}</option><option value="true">{t("enabled")}</option><option value="false">{t("disabled")}</option></select><p className="dsmm-hint">{t("activeHint")}</p></div>
  </div>;
}

export type AdvancedSettingsProps = Locale & {
  state: ProfilesViewSnapshot;
  actions: ProfilesActions;
  disabled: boolean;
  document?: StructuredDocument | null;
  isInvalidProjection?: boolean;
};

export function AdvancedSettings({ state, actions, disabled, document: propDoc, isInvalidProjection: propInvalid, t }: AdvancedSettingsProps) {
  const prefix = useId();
  const editor = state.editor;
  if (editor === null) return null;

  const rawDoc = propDoc !== undefined ? propDoc : structuredDocument(editor.content);
  const isInvalidProjection = propInvalid !== undefined ? propInvalid : (rawDoc === null);
  if (rawDoc === null) return <p className="dsmm-hint" data-dsmm-structured-invalid>{t("rawInvalid")}</p>;
  const document = rawDoc;

  const effectiveDisabled = disabled || isInvalidProjection;
  const baseline = state.snapshot?.editorDefaults;

  const topology = (document.settings.subagents as { toolTopology?: string } | undefined)?.toolTopology;
  const gitGuard = document.guards?.gitWriteGuard;
  const gitScope = document.guards?.gitWriteScope;
  const isGuardOff = gitGuard === "off";

  return <div className="dsmm-structured" data-dsmm-structured>
    {isInvalidProjection && <p className="dsmm-hint" data-dsmm-structured-invalid>{t("rawInvalid")}</p>}
    <fieldset><legend>{t("profileDefaults")}</legend><PolicyFields t={t} value={document.runtimePolicy} inherited={baseline} path={["settings", "runtimePolicy"]} name={t("profileDefaults")} disabled={effectiveDisabled} actions={actions} /></fieldset>

    <fieldset className="dsmm-git-guard"><legend>{t("gitWriteGuard")}</legend>
      <div className="dsmm-field"><label htmlFor={`${prefix}-git-guard`}>{t("gitWriteGuard")}</label>
        <select id={`${prefix}-git-guard`} disabled={effectiveDisabled} value={gitGuard ?? ""} aria-describedby={`${prefix}-git-guard-hint`} onChange={event => actions.editPath(["settings", "guards", "gitWriteGuard"], event.currentTarget.value || undefined)}>
          <option value="">{t("inherit")}</option>
          <option value="ask">{t("gitWriteAsk")}</option>
          <option value="deny">{t("gitWriteDeny")}</option>
          <option value="off">{t("gitWriteOff")}</option>
        </select><p id={`${prefix}-git-guard-hint`} className="dsmm-hint">{t("gitWriteGuardHint")}</p>
      </div>
      <div className="dsmm-field"><label htmlFor={`${prefix}-git-scope`}>{t("gitWriteScope")}</label>
        <select id={`${prefix}-git-scope`} disabled={effectiveDisabled} value={gitScope ?? ""} aria-describedby={`${prefix}-git-scope-hint`} onChange={event => actions.editPath(["settings", "guards", "gitWriteScope"], event.currentTarget.value || undefined)}>
          <option value="">{t("inherit")}</option>
          <option value="all-writes" disabled={isGuardOff}>{t("gitWriteAllWrites")}</option>
          <option value="high-risk" disabled={isGuardOff}>{t("gitWriteHighRisk")}</option>
        </select>
        {isGuardOff && <p id={`${prefix}-git-scope-hint`} className="dsmm-hint">{t("gitWriteScopeDisabledHint")}</p>}
      </div>
    </fieldset>

    <div className="dsmm-field"><label htmlFor={`${prefix}-topology`}>{t("toolTopology")}</label>
      <select id={`${prefix}-topology`} value={topology ?? ""} disabled={effectiveDisabled} aria-describedby={`${prefix}-topology-hint`} onChange={event => actions.editPath(["settings", "subagents", "toolTopology"], event.currentTarget.value || undefined)}>
        <option value="">{t("inherit")}</option><option value="per-role">{t("topologyPerRole")}</option><option value="parameterized">{t("topologyParameterized")}</option>
      </select><p id={`${prefix}-topology-hint`} className="dsmm-hint">{t("topologyHint")}</p>
    </div>
  </div>;
}

/** The same raw draft drives every control; there is no form-to-document rewrite. */
export function StructuredEditor({ state, actions, disabled, t }: Locale & {
  state: ProfilesViewSnapshot; actions: ProfilesActions; disabled: boolean;
}) {
  return <div className="dsmm-structured" data-dsmm-structured>
    <BasicSettings state={state} actions={actions} disabled={disabled} t={t} />
    <AdvancedSettings state={state} actions={actions} disabled={disabled} t={t} />
  </div>;
}
