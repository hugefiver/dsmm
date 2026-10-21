/** Wire-only evidence projection; no native service or filesystem imports. */
export const CHILD_EVIDENCE_FIELDS = ["lineage", "role", "route", "profile-pin", "admission-epoch", "invocation-level", "runtime-policy", "modules", "roles", "read-only", "tool-filter", "route-override", "max-depth", "locale", "tool-topology", "guards", "git-write", "shell", "delegation", "active-intent", "max-tokens", "output-schema"] as const;
export type ChildEvidenceField = typeof CHILD_EVIDENCE_FIELDS[number];
export interface ChildAdmissionLimitation { field: ChildEvidenceField; code: "missing-evidence" | "not-persisted" | "unverified" | "parent-denied"; effect: "capability-denied" | "native-default" | "display-only" }
export interface ChildAdmissionEvidenceView {
  mode: "captured" | "legacy-conservative";
  originalAdmissionEpoch?: string;
  parentAdmissionEpoch: string;
  provenFields: ChildEvidenceField[];
  limitations: ChildAdmissionLimitation[];
}
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
    || Object.getOwnPropertySymbols(value).length || Object.values(Object.getOwnPropertyDescriptors(value)).some(property => !Object.hasOwn(property, "value") || !property.enumerable)) throw new TypeError("Invalid child evidence object");
  const row = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) throw new TypeError("Invalid child evidence fields");
  return row;
}
function epoch(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError("Invalid child evidence epoch");
  return value;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length
    || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, property]) => key !== "length" && (!/^(0|[1-9][0-9]*)$/u.test(key) || !Object.hasOwn(property, "value") || !property.enumerable))) throw new TypeError("Invalid child evidence array");
  return value;
}
export function parseChildAdmissionEvidenceView(input: unknown): ChildAdmissionEvidenceView {
  const row = object(input, ["mode", "parentAdmissionEpoch", "provenFields", "limitations"], ["originalAdmissionEpoch"]);
  if (row.mode !== "captured" && row.mode !== "legacy-conservative") throw new TypeError("Invalid child evidence mode");
  if (row.mode === "legacy-conservative" && Object.hasOwn(row, "originalAdmissionEpoch")) throw new TypeError("Legacy evidence has no original admission epoch");
  const proven = array(row.provenFields, CHILD_EVIDENCE_FIELDS.length);
  if (new Set(proven).size !== proven.length || proven.some(field => !(CHILD_EVIDENCE_FIELDS as readonly unknown[]).includes(field))) throw new TypeError("Invalid proven evidence fields");
  const limitations = array(row.limitations, CHILD_EVIDENCE_FIELDS.length).map(input => {
    const limitation = object(input, ["field", "code", "effect"]);
    if (!(CHILD_EVIDENCE_FIELDS as readonly unknown[]).includes(limitation.field) || typeof limitation.code !== "string" || !["missing-evidence", "not-persisted", "unverified", "parent-denied"].includes(limitation.code)
      || typeof limitation.effect !== "string" || !["capability-denied", "native-default", "display-only"].includes(limitation.effect)) throw new TypeError("Invalid child evidence limitation");
    return { field: limitation.field, code: limitation.code, effect: limitation.effect } as ChildAdmissionLimitation;
  });
  if (row.mode === "legacy-conservative" && proven.some(field => ["admission-epoch", "profile-pin", "invocation-level"].includes(field as string))) throw new TypeError("Legacy evidence cannot synthesize original capture identity");
  return { mode: row.mode, parentAdmissionEpoch: epoch(row.parentAdmissionEpoch), ...(row.mode === "captured" ? { originalAdmissionEpoch: epoch(row.originalAdmissionEpoch) } : {}), provenFields: [...proven] as ChildEvidenceField[], limitations };
}
