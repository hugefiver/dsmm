import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { DsmmRoleAvailabilityState } from "../profile-types.js";
import { parseRoleAvailability } from "../profile-remote.js";

export function roleAvailability(value: DsmmRoleAvailabilityState | undefined): DsmmRoleAvailabilityState | undefined {
  if (value === undefined) return undefined;
  try { return parseRoleAvailability(value); } catch { return undefined; }
}

export function RoleAvailability({ value, t }: PropsLocale<"settings.dsmm-profiles"> & { value?: DsmmRoleAvailabilityState }) {
  const state = roleAvailability(value);
  if (state === undefined) return <p className="dsmm-hint">{t("availabilityUnknown")}</p>;
  return <div className="dsmm-availability" data-dsmm-role-availability={state.id}>
    <p>{t(state.required ? "roleRequired" : "roleOptional", { reason: state.requiredReason ?? "—" })}</p>
    {state.reason !== undefined && <p>{t("roleUnavailableReason", { reason: state.reason })}</p>}
    <details><summary>{t("technicalDetails")}</summary>
      <p>{t("roleCeiling", { startup: t(state.startupAvailable ? "enabled" : "disabled"), deployment: t(state.deploymentEnabled ? "enabled" : "disabled"), admitted: t(state.admitted ? "enabled" : "disabled") })}</p>
      <p className="dsmm-hint">{t("roleProvenance", { source: state.source, capture: state.capture })}</p>
    </details>
  </div>;
}
