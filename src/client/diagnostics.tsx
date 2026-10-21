import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { findNodeAtLocation } from "jsonc-parser";
import { diagnostic, fieldLocation, inspectJsonDocument } from "../profile-diagnostics.js";
import { parseProfileDiagnostic, parseProfileErrorInfo } from "../profile-remote.js";
import type { ProfileDiagnostic, ProfileErrorInfo } from "../profile-types.js";
import type { ProfilesIssue } from "./controller.js";

/** Wire grammar is checked again at presentation; raw exception text is never retained. */
export function safeIssue(info: unknown): ProfilesIssue {
  try {
    const parsed = parseProfileErrorInfo(info);
    return { kind: "domain", code: parsed.code, ...(parsed.field === undefined ? {} : { field: parsed.field }),
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }), ...(parsed.location === undefined ? {} : { location: parsed.location }) };
  } catch { return { kind: "assembly", code: "unavailable" }; }
}

export function profileWarnings(warnings: ProfileDiagnostic[] | undefined): ProfileDiagnostic[] {
  return (warnings ?? []).flatMap(value => {
    try {
      const warning = parseProfileDiagnostic(value);
      return warning.severity === "warning" && warning.code === "blank-label" && warning.field === "label" ? [warning] : [];
    } catch { return []; }
  });
}

export function draftWarnings(content: string): ProfileDiagnostic[] {
  const { tree, diagnostics } = inspectJsonDocument(content);
  if (tree?.type !== "object" || diagnostics.length !== 0) return [];
  const node = findNodeAtLocation(tree, ["label"]);
  if (node?.type !== "string") return [];
  const label: string = node.value;
  if (label.length > 120 || /[\u0000-\u001f\u007f]/u.test(label) || label.trim() !== ""
    || new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new TextEncoder().encode(label)) !== label) return [];
  return [diagnostic("blank-label", "label", fieldLocation(content, tree, "label"))];
}

export function ProfileWarnings({ warnings, t }: PropsLocale<"settings.dsmm-profiles"> & { warnings?: ProfileDiagnostic[] }) {
  return <>{profileWarnings(warnings).map(warning => <div className="dsmm-warning" key={`${warning.code}:${warning.field}`} data-dsmm-warning>
    <p>{t("warningMarker", { code: warning.code, field: warning.field })}</p>
    <details><summary>{t("details")}</summary><p>{t("blankLabelWarning")}</p></details>
  </div>)}</>;
}

export function IssueDetails({ issue, t }: PropsLocale<"settings.dsmm-profiles"> & { issue: ProfilesIssue | ProfileErrorInfo }) {
  const safe = safeIssue({ code: issue.code, message: "", ...(issue.field === undefined ? {} : { field: issue.field }),
    ...(issue.reason === undefined ? {} : { reason: issue.reason }), ...(issue.location === undefined ? {} : { location: issue.location }) });
  return <div className="dsmm-diagnostic"><p>{t("blockingMarker", { code: safe.reason ?? safe.code, field: safe.field ?? "document" })}</p>
    {safe.location !== undefined && <p>{t("diagnosticLocation", { line: safe.location.line, column: safe.location.column })}</p>}
    {safe.reason !== undefined && <details><summary>{t("details")}</summary><p>{t(DIAGNOSTIC_LABELS[safe.reason])}</p></details>}
  </div>;
}

const DIAGNOSTIC_LABELS = {
  "invalid-jsonc": "diagnosticJsonc", "duplicate-field": "diagnosticDuplicate", "unsafe-field": "diagnosticUnsafe", "unknown-field": "diagnosticUnknown",
  "deprecated-field": "diagnosticDeprecated", "invalid-type": "diagnosticType", "unsupported-value": "diagnosticValue", "invalid-route": "diagnosticRoute",
  "required-role": "diagnosticRequired", "deployment-ceiling": "diagnosticCeiling", "blank-label": "blankLabelWarning",
} as const satisfies Record<ProfileDiagnostic["code"], import("./locales.js").ProfilesLocaleKey>;
