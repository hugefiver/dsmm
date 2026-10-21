import type { DsmmDeploymentSnapshot, DsmmProfileAdmission, DsmmSettings } from "./settings.js";

/** Static first-party inventory, not a plugin/provider installation interface. */
export const DSMM_MODULE_DESCRIPTORS = Object.freeze([
  Object.freeze({ id: "deepwork" as const, label: "Deepwork", key: "modules.deepwork.enabled" as const }),
  Object.freeze({ id: "permission-control" as const, label: "Permission control", key: "permissionControl.enabled" as const })
]);

export interface DsmmModuleState {
  descriptor: typeof DSMM_MODULE_DESCRIPTORS[number];
  hostBundleEnabled: "unknown";
  desired: { enabled: boolean; source: "defaults" | "global" | "profile"; capture: "current-global" | "admission" | "startup" };
  startupMounted: boolean | null;
  admitted: boolean | null;
  nextRoot: { admitted: boolean | null; reason: "global-disabled" | "restart-required" | null };
  reason: "global-disabled" | "restart-required" | "captured-off" | null;
  pending: boolean;
}

/** Trusted Host lifecycle observation; missing or retired owners return null, not readiness. */
export type DsmmMountedPermissionGetter = () => boolean | null;

export function deepworkEnabled(settings: DsmmSettings): boolean { return settings.modules.deepwork.enabled; }

export function projectDeepworkModule(startup: DsmmSettings, desired?: DsmmDeploymentSnapshot, admission?: DsmmProfileAdmission, currentGlobal = false): DsmmModuleState {
  const enabled = desired?.settings.modules.deepwork.enabled ?? startup.modules.deepwork.enabled;
  const mounted = deepworkEnabled(startup);
  const admitted = admission === undefined ? null : deepworkEnabled(admission.settings);
  const next = enabled && mounted;
  const reason = !enabled ? "global-disabled" : !mounted ? "restart-required" : null;
  return {
    descriptor: { ...DSMM_MODULE_DESCRIPTORS[0]! }, hostBundleEnabled: "unknown",
    desired: { enabled, source: desired?.sources["modules.deepwork.enabled"] === "global" ? "global" : "defaults",
      capture: currentGlobal ? "current-global" : admission === undefined ? "startup" : "admission" },
    startupMounted: mounted, admitted, nextRoot: { admitted: next, reason },
    reason: admitted === false && next ? "captured-off" : admitted === true ? null : reason,
    pending: enabled !== mounted || admitted !== null && admitted !== next
  };
}

/** Both projections share the same captured deployment/admission; module state grants no authority. */
export function projectDsmmModules(startup: DsmmSettings, desired?: DsmmDeploymentSnapshot, admission?: DsmmProfileAdmission,
  currentGlobal = false, getMountedPermission?: DsmmMountedPermissionGetter): DsmmModuleState[] {
  const enabled = desired?.settings.permissionControl.enabled ?? startup.permissionControl.enabled;
  const mounted = getMountedPermission?.() ?? null;
  const admitted = admission?.settings.permissionControl.enabled ?? null;
  const restartRequired = enabled !== startup.permissionControl.enabled;
  const reason = restartRequired ? "restart-required" : null;
  return [projectDeepworkModule(startup, desired, admission, currentGlobal), {
    descriptor: { ...DSMM_MODULE_DESCRIPTORS[1]! }, hostBundleEnabled: "unknown",
    desired: { enabled, source: desired?.sources["permissionControl.enabled"] ?? "defaults",
      capture: currentGlobal ? "current-global" : admission === undefined ? "startup" : "admission" },
    startupMounted: mounted, admitted, nextRoot: { admitted: mounted, reason }, reason,
    pending: restartRequired || admitted !== null && mounted !== null && admitted !== mounted
  }];
}
