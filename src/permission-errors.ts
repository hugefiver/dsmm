export class PermissionRefusal extends Error {
  constructor(readonly code: "not-owned" | "stale" | "cancelled" | "unavailable" | "validation" | "not-found" | "scope-unavailable" | "replayed" | "denied") {
    super("The Host refused the permission operation.");
  }
}
/** A policy lifetime may end while the native answerer is still waiting. */
export async function permissionOutcome<T>(answer: () => Promise<T>, signal: AbortSignal, cancelled: T): Promise<T> {
  if (signal.aborted) return cancelled;
  let abort!: () => void;
  const ended = new Promise<T>(resolve => { abort = () => resolve(cancelled); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(answer), ended]); }
  finally { signal.removeEventListener("abort", abort); }
}
