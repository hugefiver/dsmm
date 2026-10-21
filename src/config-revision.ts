/** Configuration versions are metadata markers, not content-integrity proofs. */
export function isConfigRevision(value: unknown): value is string {
  return typeof value === "string" && (/^[a-f0-9]{64}$/u.test(value)
    || /^stat-v1--?\d{1,24}--?\d{1,24}$/u.test(value));
}

/** Immutable snapshot references are bounded path components, including historical IDs. */
export function isProfileReference(value: unknown): value is string {
  return typeof value === "string" && (/^[a-f0-9]{64}$/u.test(value)
    || /^snapshot-v1-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value));
}
