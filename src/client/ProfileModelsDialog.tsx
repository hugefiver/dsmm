import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { DsmmModelRoute } from "../settings.js";
import type { DsmmRuntimePolicySettings } from "../routing-policy.js";
import { DSMM_RATE_LIMIT_BOUNDS, normalizeRateLimitPolicy } from "../routing-policy.js";
import type { ProfilesActions, ProfilesViewSnapshot } from "./controller.js";
import type { JsonPath, StructuredDocument } from "./structured.js";
import { LevelFields, PolicyFields, RouteFields } from "./StructuredEditor.js";
import { RoleAvailability, roleAvailability } from "./RoleAvailability.js";
import { IssueDetails, issueKey } from "./diagnostics.js";

type Locale = PropsLocale<"settings.dsmm-profiles">;

function locateFieldInsideRole(
  roleCard: HTMLElement,
  field: string | null | undefined
): HTMLElement | null {
  if (!field) return null;
  const roleId = roleCard.dataset.dsmmRole;
  if (field === `settings.roles.${roleId}` || field === `roles.${roleId}`) {
    const details = roleCard.querySelector<HTMLDetailsElement>("details[data-dsmm-details='non-model']");
    if (details) details.open = true;
    return roleCard.querySelector<HTMLElement>("select[id$='-role-enabled']");
  }
  const roleMatch = /^(?:settings\.)?roleRouting\.([a-zA-Z0-9_-]+)\.(.+)$/.exec(field);
  if (roleMatch === null || roleMatch[1] !== roleId) return null;
  const path = roleMatch[2].replace(/\[(\d+)\]/g, ".$1");
  const routeInput = (container: HTMLElement | null, prop: string): HTMLElement | null => {
    const suffix = prop === "reasoningEffort" ? "effort" : prop;
    return container?.querySelector<HTMLElement>(`input[id$='-${suffix}'], select[id$='-${suffix}']`) ?? null;
  };

  const levelMatch = /^levels\.(low|high|max)(?:\.(provider|model|reasoningEffort))?$/.exec(path);
  if (levelMatch) {
    const level = levelMatch[1];
    const prop = levelMatch[2];
    const details = roleCard.querySelector<HTMLDetailsElement>("details[data-dsmm-details='levels']");
    if (details) details.open = true;
    const fieldset = roleCard.querySelector<HTMLElement>(`fieldset[data-dsmm-level='${level}']`);
    return routeInput(fieldset, prop ?? "mode");
  }

  const fallbackMatch = /^fallbackRoutes\.(0|[1-9]\d*)\.(provider|model|reasoningEffort)$/.exec(path);
  if (fallbackMatch) {
    const index = fallbackMatch[1];
    const prop = fallbackMatch[2];
    const details = roleCard.querySelector<HTMLDetailsElement>("details[data-dsmm-details='fallback']");
    if (details) details.open = true;
    const fieldset = roleCard.querySelector<HTMLElement>(`fieldset[data-dsmm-fallback-index='${index}']`);
    return routeInput(fieldset, prop);
  }
  if (path === "fallbackRoutes") {
    const details = roleCard.querySelector<HTMLDetailsElement>("details[data-dsmm-details='fallback']");
    if (details) details.open = true;
    return roleCard.querySelector<HTMLElement>("select[id$='-fallback-mode']");
  }

  const primaryMatch = /^primary(?:\.(provider|model|reasoningEffort))?$/.exec(path);
  if (primaryMatch) {
    const primaryContainer = roleCard.querySelector<HTMLElement>(".dsmm-role-primary-route");
    return routeInput(primaryContainer, primaryMatch[1] ?? "primary-mode");
  }

  const rateLimitMatch = /^rateLimit\.([a-zA-Z]+)$/.exec(path);
  const selector = path === "strategy" ? "select[id$='-strategy']"
    : rateLimitMatch && Object.hasOwn(DSMM_RATE_LIMIT_BOUNDS, rateLimitMatch[1])
      ? `input[data-dsmm-policy-field='${rateLimitMatch[1]}']` : null;
  if (selector === null) return null;
  const details = roleCard.querySelector<HTMLDetailsElement>("details[data-dsmm-details='non-model']");
  if (details) details.open = true;
  return details?.querySelector<HTMLElement>(selector) ?? null;
}

export function hasExplicitModelOverride(roleId: string, doc: StructuredDocument | null): boolean {
  if (doc === null) return false;
  const policy = doc.roleRouting[roleId];
  if (!policy) return false;
  if (policy.primary !== undefined) return true;
  if (policy.levels !== undefined && Object.keys(policy.levels).length > 0) return true;
  if (policy.fallbackRoutes !== undefined) return true;
  return false;
}

export interface ProfileModelsDialogProps extends Locale {
  open: boolean;
  onClose: () => void;
  state: ProfilesViewSnapshot;
  actions: ProfilesActions;
  disabled: boolean;
  document: StructuredDocument | null;
  isInvalidProjection?: boolean;
  triggerRef?: RefObject<HTMLElement | null>;
  targetRoleId?: string | null;
  targetField?: string | null;
  onTargetLocated?: () => void;
  onJumpToJsonc?: () => void;
}

export function ProfileModelsDialog({
  open,
  onClose,
  state,
  actions,
  disabled,
  document: doc,
  isInvalidProjection,
  triggerRef,
  targetRoleId,
  targetField,
  onTargetLocated,
  onJumpToJsonc,
  t,
}: ProfileModelsDialogProps) {
  const prefix = useId();
  const [searchQuery, setSearchQuery] = useState("");
  const [filterExplicitOnly, setFilterExplicitOnly] = useState(false);

  const pendingFallbackFocusRef = useRef<{
    roleId: string;
    index: number;
    action: "add" | "moveUp" | "moveDown" | "remove";
  } | null>(null);

  const wasOpenRef = useRef(open);
  useEffect(() => {
    if (wasOpenRef.current && !open) {
      if (triggerRef?.current && triggerRef.current.isConnected) {
        triggerRef.current.focus();
      }
    }
    wasOpenRef.current = open;
  }, [open, triggerRef]);

  // Background inert on document.body siblings while modal is open
  useEffect(() => {
    if (!open) return;
    const elementsToRestore: { el: HTMLElement; prevInert: string | null }[] = [];

    const timer = setTimeout(() => {
      const dialogElement = document.querySelector(".dsmm-profile-models-dialog");
      for (const child of Array.from(document.body.children)) {
        if (child instanceof HTMLElement && (!dialogElement || !child.contains(dialogElement))) {
          const prev = child.getAttribute("inert");
          child.setAttribute("inert", "");
          elementsToRestore.push({ el: child, prevInert: prev });
        }
      }
    }, 0);

    return () => {
      clearTimeout(timer);
      for (const { el, prevInert } of elementsToRestore) {
        if (prevInert !== null) {
          el.setAttribute("inert", prevInert);
        } else {
          el.removeAttribute("inert");
        }
      }
    };
  }, [open]);

  // Target role locating effect
  useEffect(() => {
    if (!open || !targetRoleId) return;
    setSearchQuery("");
    setFilterExplicitOnly(false);

    const rafId = requestAnimationFrame(() => {
      const roleCard = document.querySelector<HTMLElement>(`[data-dsmm-role='${targetRoleId}']`);
      if (!roleCard) {
        onJumpToJsonc?.();
        return;
      }

      const targetInput = locateFieldInsideRole(roleCard, targetField);
      if (!targetInput) {
        onJumpToJsonc?.();
        return;
      }

      const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const scrollOpt: ScrollIntoViewOptions = { behavior: reducedMotion ? "auto" : "smooth", block: "nearest" };

      if (typeof targetInput.scrollIntoView === "function") {
        targetInput.scrollIntoView(scrollOpt);
      }
      targetInput.focus();
      if (document.activeElement === targetInput) onTargetLocated?.();
      else onJumpToJsonc?.();
    });

    return () => cancelAnimationFrame(rafId);
  }, [open, targetRoleId, targetField, onTargetLocated, onJumpToJsonc]);

  // Safe fallback focus preservation after add, move, or remove
  useEffect(() => {
    if (!pendingFallbackFocusRef.current) return;
    const { roleId, index, action } = pendingFallbackFocusRef.current;
    pendingFallbackFocusRef.current = null;

    const roleCard = document.querySelector(`[data-dsmm-role='${roleId}']`);
    if (!roleCard) return;

    if (action === "add") {
      const item = roleCard.querySelector(`[data-dsmm-fallback-index='${index}']`);
      const providerInput = item?.querySelector<HTMLElement>(
        "input[id$='-provider'], select[id$='-provider'], input, select"
      );
      providerInput?.focus();
    } else if (action === "moveUp" || action === "moveDown") {
      const item = roleCard.querySelector(`[data-dsmm-fallback-index='${index}']`);
      if (item) {
        const targetBtn =
          item.querySelector<HTMLElement>(`button[data-dsmm-action='${action}']:not([disabled])`) ??
          item.querySelector<HTMLElement>("button[data-dsmm-action='moveUp']:not([disabled])") ??
          item.querySelector<HTMLElement>("button[data-dsmm-action='moveDown']:not([disabled])") ??
          item.querySelector<HTMLElement>("button[data-dsmm-action='remove']:not([disabled])") ??
          item.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled])");
        targetBtn?.focus();
      }
    } else if (action === "remove") {
      const nextRemoveBtn =
        roleCard.querySelector<HTMLElement>(`[data-dsmm-fallback-index='${index}'] button[data-dsmm-action='remove']`) ??
        roleCard.querySelector<HTMLElement>(`[data-dsmm-fallback-index='${Math.max(0, index - 1)}'] button[data-dsmm-action='remove']`) ??
        roleCard.querySelector<HTMLElement>("button[data-dsmm-action='add-fallback']");
      nextRemoveBtn?.focus();
    }
  });

  const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      const dialog = (event.currentTarget.classList.contains("dsmm-profile-models-dialog")
        ? event.currentTarget
        : event.currentTarget.querySelector(".dsmm-profile-models-dialog") ?? event.currentTarget) as HTMLElement;

      const candidates = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => {
        const closedDetails = el.closest("details:not([open])");
        if (closedDetails && el !== closedDetails.querySelector("summary")) return false;
        if (el.getAttribute("tabindex") === "-1") return false;
        if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return false;
        if (el.closest("[inert]") || el.closest("[hidden]")) return false;
        if (el.offsetWidth === 0 && el.offsetHeight === 0 && el.getClientRects().length === 0) return false;
        return true;
      });

      if (candidates.length === 0) {
        event.preventDefault();
        return;
      }

      const first = candidates[0];
      const last = candidates[candidates.length - 1];

      if (event.shiftKey) {
        if (document.activeElement === first || !dialog.contains(document.activeElement)) {
          event.preventDefault();
          event.stopPropagation();
          last.focus();
        }
      } else {
        if (document.activeElement === last || !dialog.contains(document.activeElement)) {
          event.preventDefault();
          event.stopPropagation();
          first.focus();
        }
      }
    }
  };

  const roles = state.snapshot?.roles ?? [];
  const effectiveDisabled = disabled || isInvalidProjection || doc === null;
  const baseline = state.snapshot?.editorDefaults;

  const filteredRoles = roles.filter((role) => {
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      const matchesId = role.id.toLowerCase().includes(q);
      const matchesLabel = role.label.toLowerCase().includes(q);
      if (!matchesId && !matchesLabel) return false;
    }
    if (filterExplicitOnly) {
      if (!hasExplicitModelOverride(role.id, doc)) return false;
    }
    return true;
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("modelsDialogTitle")}
      description={t("modelsDialogDesc")}
      closeLabel={t("cancel")}
      className="dsmm-profile-models-dialog"
      contentClassName="dsmm-profile-models-dialog-content"
      onKeyDownCapture={handleKeyDownCapture}
    >
      <div className="dsmm-models-filter-bar dsmm-dialog-filter-bar">
        <div className="dsmm-field dsmm-filter-search">
          <Input
            id={`${prefix}-role-search`}
            className="dsmm-input"
            type="search"
            value={searchQuery}
            placeholder={t("searchRolesPlaceholder")}
            disabled={effectiveDisabled}
            onChange={(e) => setSearchQuery(e.currentTarget.value)}
            data-dsmm-role-search
            data-modal-autofocus
          />
        </div>
        <label className="dsmm-filter-label dsmm-filter-override-toggle">
          <input
            type="checkbox"
            checked={filterExplicitOnly}
            disabled={effectiveDisabled}
            onChange={(e) => setFilterExplicitOnly(e.currentTarget.checked)}
            data-dsmm-filter-overrides
          />
          <span>{t("filterExplicitOverrides")}</span>
        </label>
      </div>

      {state.issue !== null && (
        <div className="dsmm-issue dsmm-dialog-issue" role="region" aria-label={t("savedInventory")}>
          <p className="dsmm-dialog-issue-title">{t(issueKey(state.issue))}</p>
          <IssueDetails issue={state.issue} t={t} />
          {onJumpToJsonc && (
            <div className="dsmm-dialog-issue-action">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onJumpToJsonc}
              >
                {t("jumpToJsonc")}
              </Button>
            </div>
          )}
        </div>
      )}

      {doc === null && (
        <div className="dsmm-structured-invalid" data-dsmm-structured-invalid>
          <p>{t("rawInvalid")}</p>
          <p className="dsmm-hint">{t("rawInvalidFormDisabled")}</p>
          {onJumpToJsonc && (
            <Button
              type="button"
              variant="outline"
              onClick={onJumpToJsonc}
            >
              {t("viewConfiguration")}
            </Button>
          )}
        </div>
      )}

      {doc !== null && (
        <div className="dsmm-roles-list dsmm-dialog-roles-list">
          {filteredRoles.length === 0 && (
            <p className="dsmm-hint dsmm-no-roles">{t("noMatchingRoles")}</p>
          )}

          {filteredRoles.map((role) => {
            const policy = doc.roleRouting[role.id] ?? {};
            const rolePath: JsonPath = ["settings", "roleRouting", role.id];
            const isOrchestrator = role.id === "dsmm-orchestrator";
            const explicitOverride = hasExplicitModelOverride(role.id, doc);

            // Compute inheritance for policy retry
            let inherited: DsmmRuntimePolicySettings | undefined;
            try {
              if (baseline !== undefined) {
                const profileDefaults = {
                  strategy: doc.runtimePolicy.strategy ?? baseline.strategy,
                  rateLimit: normalizeRateLimitPolicy(doc.runtimePolicy.rateLimit, baseline.rateLimit),
                };
                inherited = {
                  strategy: role.runtimePolicy?.strategy ?? profileDefaults.strategy,
                  rateLimit: normalizeRateLimitPolicy(role.runtimePolicy?.rateLimit, profileDefaults.rateLimit),
                };
              }
            } catch {
              // Leave inherited undefined if invalid
            }

            const availability = roleAvailability(role.availability);
            const namedRoles = doc.settings.roles as Record<string, boolean> | undefined;

            // Calling levels summary
            const configuredLevels = (["low", "high", "max"] as const).filter(
              (lvl) => policy.levels?.[lvl] !== undefined
            );
            const levelsSummary =
              configuredLevels.length > 0
                ? t("levelsSummary", { levels: configuredLevels.join(", ") })
                : t("levelsInherited");

            // Fallback chain summary
            const fallbackSummary =
              policy.fallbackRoutes === undefined
                ? t("fallbackInherited")
                : policy.fallbackRoutes.length === 0
                ? t("fallbackExplicitEmptySummary")
                : t("fallbackCountSummary", { count: policy.fallbackRoutes.length });

            // Non-model settings summary
            const statusSummary =
              namedRoles?.[role.id] !== undefined
                ? (namedRoles[role.id] ? t("enabled") : t("disabled"))
                : t("roleSettingsInherited");
            const retrySummary =
              policy.strategy !== undefined || (policy.rateLimit !== undefined && Object.keys(policy.rateLimit).length > 0)
                ? t("roleSettingsOverridden")
                : t("roleSettingsInherited");
            const nonModelSummary = t("roleSettingsSummary", { status: statusSummary, retry: retrySummary });

            return (
              <div
                key={role.id}
                className="dsmm-role-card dsmm-dialog-role-card"
                data-dsmm-role={role.id}
              >
                {/* Desktop primary line: identity, inheritance mode, provider/model/effort */}
                <div className="dsmm-role-main-row">
                  <div className="dsmm-dialog-role-header">
                    <div className="dsmm-role-title-group">
                      <span className="dsmm-role-title">{role.label}</span>
                      <code className="dsmm-role-id-badge">{role.id}</code>
                      {explicitOverride && (
                        <span className="dsmm-override-badge">{t("roleSettingsOverridden")}</span>
                      )}
                    </div>
                  </div>

                  {/* Inline primary model route */}
                  <div className="dsmm-role-primary-route">
                    <div className="dsmm-field dsmm-primary-mode-field">
                      <label htmlFor={`${prefix}-${role.id}-primary-mode`}>
                        {t("primaryMode", { name: role.label })}
                      </label>
                      <select
                        id={`${prefix}-${role.id}-primary-mode`}
                        disabled={effectiveDisabled}
                        value={policy.primary === undefined ? "inherit" : "explicit"}
                        onChange={(event) =>
                          actions.editPath(
                            [...rolePath, "primary"],
                            event.currentTarget.value === "inherit" ? undefined : { provider: "", model: "" }
                          )
                        }
                      >
                        <option value="inherit">{t("inheritRoute")}</option>
                        <option value="explicit">{t("configuredRoute")}</option>
                      </select>
                    </div>
                    {policy.primary !== undefined ? (
                      <RouteFields
                        t={t}
                        value={policy.primary}
                        path={[...rolePath, "primary"]}
                        name={t("primaryName", { name: role.label })}
                        catalog={state.catalog}
                        disabled={effectiveDisabled}
                        edit={actions.editPath}
                        editRoute={actions.editRoute}
                        naturalLabels={true}
                      />
                    ) : (
                      <div className="dsmm-route-inherited-hint">
                        <span>{t("inheritRouteDesc")}</span>
                      </div>
                    )}
                    {isOrchestrator && (
                      <span className="dsmm-orchestrator-tag">{t("orchestratorNoLevelsHint")}</span>
                    )}
                  </div>
                </div>

                {/* Secondary line: compact expandable pills for levels / fallback / non-model settings */}
                <div className="dsmm-role-details-bar">
                  {/* Calling levels (non-orchestrator only) */}
                  {!isOrchestrator && (
                    <details className="dsmm-role-levels-details dsmm-compact-details" data-dsmm-details="levels">
                      <summary className="dsmm-details-summary dsmm-details-pill">
                        <span className="dsmm-pill-label">{t("callingLevels")}:</span>
                        <span className="dsmm-pill-val">{levelsSummary}</span>
                      </summary>
                      <div className="dsmm-details-content">
                        <p className="dsmm-hint">{t("levelsHint")}</p>
                        {(["low", "high", "max"] as const).map((level) => (
                          <LevelFields
                            key={level}
                            level={level}
                            value={policy.levels?.[level]}
                            path={[...rolePath, "levels", level]}
                            catalog={state.catalog}
                            disabled={effectiveDisabled}
                            actions={actions}
                            t={t}
                          />
                        ))}
                      </div>
                    </details>
                  )}

                  {/* Fallback chain (ordered, max 32 items) */}
                  <details className="dsmm-role-fallback-details dsmm-compact-details" data-dsmm-details="fallback">
                    <summary className="dsmm-details-summary dsmm-details-pill">
                      <span className="dsmm-pill-label">{t("fallbackRoutes")}:</span>
                      <span className="dsmm-pill-val">{fallbackSummary}</span>
                    </summary>
                    <div className="dsmm-details-content">
                      <div className="dsmm-field">
                        <label htmlFor={`${prefix}-${role.id}-fallback-mode`}>
                          {t("fallbackMode", { name: role.label })}
                        </label>
                        <select
                          id={`${prefix}-${role.id}-fallback-mode`}
                          disabled={effectiveDisabled}
                          value={policy.fallbackRoutes === undefined ? "inherit" : "explicit"}
                          onChange={(event) =>
                            actions.editPath(
                              [...rolePath, "fallbackRoutes"],
                              event.currentTarget.value === "inherit" ? undefined : []
                            )
                          }
                        >
                          <option value="inherit">{t("inheritChain")}</option>
                          <option value="explicit">{t("configuredChain")}</option>
                        </select>
                      </div>

                      {policy.fallbackRoutes?.length === 0 && (
                        <p className="dsmm-hint">{t("emptyChain")}</p>
                      )}

                      {policy.fallbackRoutes?.map((candidate: DsmmModelRoute, index: number) => {
                        const name = t("fallbackName", { name: role.label, index: index + 1 });
                        return (
                          <fieldset
                            key={index}
                            className="dsmm-fallback-item"
                            data-dsmm-fallback-index={index}
                          >
                            <legend>{name}</legend>
                            <RouteFields
                              t={t}
                              value={candidate}
                              path={[...rolePath, "fallbackRoutes", index]}
                              name={name}
                              catalog={state.catalog}
                              disabled={effectiveDisabled}
                              edit={actions.editPath}
                              editRoute={actions.editRoute}
                              naturalLabels={true}
                            />
                            <div className="dsmm-actions">
                              <Button
                                type="button"
                                variant="outline"
                                data-dsmm-action="moveUp"
                                disabled={effectiveDisabled || index === 0}
                                onClick={() => {
                                  pendingFallbackFocusRef.current = { roleId: role.id, index: index - 1, action: "moveUp" };
                                  actions.moveFallback(role.id, index, index - 1);
                                }}
                              >
                                {t("moveUp", { name })}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                data-dsmm-action="moveDown"
                                disabled={effectiveDisabled || index === policy.fallbackRoutes!.length - 1}
                                onClick={() => {
                                  pendingFallbackFocusRef.current = { roleId: role.id, index: index + 1, action: "moveDown" };
                                  actions.moveFallback(role.id, index, index + 1);
                                }}
                              >
                                {t("moveDown", { name })}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                data-dsmm-action="remove"
                                disabled={effectiveDisabled}
                                onClick={() => {
                                  const newLen = policy.fallbackRoutes!.length - 1;
                                  const nextIdx = Math.min(index, Math.max(0, newLen - 1));
                                  pendingFallbackFocusRef.current = { roleId: role.id, index: nextIdx, action: "remove" };
                                  actions.editPath([...rolePath, "fallbackRoutes", index], undefined);
                                }}
                              >
                                {t("removeFallback", { name })}
                              </Button>
                            </div>
                          </fieldset>
                        );
                      })}

                      <Button
                        type="button"
                        variant="outline"
                        data-dsmm-action="add-fallback"
                        disabled={effectiveDisabled || (policy.fallbackRoutes?.length ?? 0) >= 32}
                        onClick={(e) => {
                          const currentDetails = e.currentTarget.closest("details");
                          if (currentDetails) currentDetails.open = true;
                          const newIndex = policy.fallbackRoutes?.length ?? 0;
                          pendingFallbackFocusRef.current = { roleId: role.id, index: newIndex, action: "add" };
                          if (policy.fallbackRoutes === undefined) {
                            actions.editPath([...rolePath, "fallbackRoutes"], [{ provider: "", model: "" }]);
                          } else {
                            actions.editPath([...rolePath, "fallbackRoutes", policy.fallbackRoutes.length], { provider: "", model: "" });
                          }
                        }}
                      >
                        {t("addFallback", { name: role.label })}
                      </Button>
                    </div>
                  </details>

                  {/* Per-role non-model settings (enabled status, availability, retry policy) */}
                  <details className="dsmm-role-nonmodel-details dsmm-compact-details" data-dsmm-details="non-model">
                    <summary className="dsmm-details-summary dsmm-details-pill">
                      <span className="dsmm-pill-label">{t("roleNonModelSettings")}:</span>
                      <span className="dsmm-pill-val">{nonModelSummary}</span>
                    </summary>
                    <div className="dsmm-details-content">
                      <RoleAvailability value={role.availability} t={t} />
                      <div className="dsmm-field">
                        <label htmlFor={`${prefix}-${role.id}-role-enabled`}>
                          {t("namedRole", { name: role.label })}
                        </label>
                        <select
                          id={`${prefix}-${role.id}-role-enabled`}
                          value={namedRoles?.[role.id] === undefined ? "" : String(namedRoles[role.id])}
                          disabled={effectiveDisabled}
                          aria-describedby={`${prefix}-${role.id}-role-hint`}
                          onChange={(event) =>
                            actions.editPath(
                              ["settings", "roles", role.id],
                              event.currentTarget.value === "" ? undefined : event.currentTarget.value === "true"
                            )
                          }
                        >
                          <option value="">{t("inherit")}</option>
                          <option
                            value="true"
                            disabled={
                              availability === undefined ||
                              !availability.startupAvailable ||
                              !availability.deploymentEnabled ||
                              availability.reason === "module-off"
                            }
                          >
                            {t("enabled")}
                          </option>
                          <option value="false" disabled={availability === undefined || availability.required}>
                            {t("disabled")}
                          </option>
                        </select>
                        <p id={`${prefix}-${role.id}-role-hint`} className="dsmm-hint">
                          {t("namedRoleHint")}
                        </p>
                      </div>

                      <PolicyFields
                        t={t}
                        value={policy}
                        inherited={inherited}
                        path={rolePath}
                        name={role.label}
                        disabled={effectiveDisabled}
                        actions={actions}
                      />
                    </div>
                  </details>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
