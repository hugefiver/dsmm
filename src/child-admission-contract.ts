import type { DshAgent } from "./dsh-types.js";
import type { DsmmProfileAdmission } from "./settings.js";
import type { ChildAdmissionEvidence, LegacyChildEvidence, PreparedChildAdmission } from "./child-capture.js";
import type { SubagentRuntimeAdmissionView } from "./profile-types.js";

export interface ParentAdmissionTicket {
  readonly parent: DshAgent;
  readonly owner: object;
  readonly admission: DsmmProfileAdmission;
  readonly parentEpoch: string;
  readonly signal: AbortSignal;
}
/** Implemented by the explicit Host composition; no default or stock fallback. */
export interface DsmmChildAdmissionAuthority {
  view(): SubagentRuntimeAdmissionView;
  registerParent(parent: DshAgent, admission: DsmmProfileAdmission, owner: object): void;
  acquireParentTicket(parent: DshAgent): ParentAdmissionTicket;
  resolveChildEvidence(ticket: ParentAdmissionTicket, childId: string, signal: AbortSignal): Promise<ChildAdmissionEvidence>;
  /** Preparation may fail before durable commit. Publication is synchronous and nonthrowing after it. */
  prepareParentAdmission(parent: DshAgent, expectedEpoch: string, nextAdmission: DsmmProfileAdmission): void;
  /** Host-only non-delivery CAS; it never issues or authorizes a delivery ticket. */
  assertCoreParentAdmission?(parent: DshAgent, owner: object, expected: DsmmProfileAdmission): void;
  prepareCoreParentAdmission?(parent: DshAgent, owner: object, expected: DsmmProfileAdmission, next: DsmmProfileAdmission): void;
  publishParentAdmission(parent: DshAgent, expectedEpoch: string, nextAdmission: DsmmProfileAdmission, install: () => void): void;
  revokeParent(parent: DshAgent, reason: string): void;
}
export interface ChildAdmissionCompletion {
  /** A/C resolve immutable original evidence; B verifies identity and target ceiling in validateRole. */
  prepare(agent: DshAgent, parent: DshAgent, ticket: ParentAdmissionTicket, signal: AbortSignal): Promise<PreparedChildAdmission>;
  validateRole(agent: DshAgent, parent: DshAgent, prepared: ChildRoleAdmissionCandidate): void;
}
export interface ChildRoleAdmissionCandidate extends PreparedChildAdmission {
  /** Derived from the exact live residency cache, not supplied by a caller or inferred from epoch equality. */
  readonly retained: boolean;
}
/** Trusted physical native folds; called only after verified absence of a new capture. */
export type LegacyChildEvidenceReader = (ticket: ParentAdmissionTicket, childId: string, signal: AbortSignal) => Promise<LegacyChildEvidence>;
