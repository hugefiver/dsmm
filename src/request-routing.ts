import type { AgentRequestFrame, DshAgent, DshAgentsRegistry, DshContext } from "./dsh-types.js";
import type { DsmmSettingsGetter } from "./settings.js";
import type { DeepworkModeController } from "./state.js";
import type { DsmmEffortSource } from "./host-llm.js";
import { resolveAdmittedDsmmRole } from "./role-policy.js";
import { liveRolePolicyIdentity, roleRouteLock } from "./role-routing.js";
import { childOwnedSessionEvents, sessionEvents } from "./session-scope.js";
import { isCurrentRecoveryStep } from "./recovery-policy.js";

/** Shared by selection, recovery and the native prepared-call owner. */
export interface DsmmRequestRoutingDecision {
  readonly frame: AgentRequestFrame;
  readonly settings: ReturnType<DsmmSettingsGetter>;
  readonly admission: ReturnType<NonNullable<DsmmSettingsGetter["admission"]>> | undefined;
  readonly role: ReturnType<typeof resolveAdmittedDsmmRole>;
  readonly policy: string | undefined;
  readonly configuredRoot: boolean;
  assertPolicyCurrent(): void;
  assertCurrent(): void;
}

const decisions = new WeakMap<DshAgent, DsmmRequestRoutingDecision>();
const routeAssertions = new WeakMap<DsmmRequestRoutingDecision, () => void>();
const results = new WeakMap<AgentRequestFrame, { decision: DsmmRequestRoutingDecision; effortSource?: DsmmEffortSource; assertCurrent(): void }>();

export function currentRequestRouting(agent: DshAgent): DsmmRequestRoutingDecision | undefined { return decisions.get(agent); }
export function preparedRequestRouting(frame: AgentRequestFrame): ReturnType<typeof results.get> { return results.get(frame); }

export function captureRequestRouting(frame: AgentRequestFrame, ctx: DshContext, controller: DeepworkModeController,
  getSettings: DsmmSettingsGetter, assertOwner: () => void): DsmmRequestRoutingDecision {
  const settings = getSettings(frame.agent), admission = getSettings.admission?.(frame.agent);
  const role = settings.modules.deepwork.enabled
    ? resolveAdmittedDsmmRole(frame.agent, settings, controller.active(frame.agent, settings.defaultActive)) : undefined;
  const policy = liveRolePolicyIdentity(frame.agent, settings, role, admission?.epoch);
  const modeRevision = controller.describe(frame.agent, settings.defaultActive).revision;
  const initialLock = policy === undefined ? undefined : roleRouteLock(frame.agent, policy);
  const initialGeneration = initialLock?.generation;
  const captured = Object.freeze({ ...frame });
  const events = () => captured.agent.session.header?.origin === "subagent" ? childOwnedSessionEvents(captured.agent.session) : sessionEvents(captured.agent.session);
  const currentStep = isCurrentRecoveryStep(events(), captured.turn, captured.step);
  const decision: DsmmRequestRoutingDecision = Object.freeze({ frame: captured, settings, admission, role, policy,
    configuredRoot: captured.agent.session.header?.origin !== "subagent" && admission !== undefined
      && admission.settings === settings && settings.rootModelPolicy === "configured" && settings.modules.deepwork.enabled && role !== undefined,
    assertPolicyCurrent() {
      assertOwner(); captured.signal.throwIfAborted();
      if (frame.agent !== captured.agent || frame.signal !== captured.signal || frame.turn !== captured.turn || frame.step !== captured.step) {
        throw new Error("DSMM request frame changed");
      }
      const agents = ctx.get?.<DshAgentsRegistry>("agents");
      const current = getSettings(captured.agent), currentAdmission = getSettings.admission?.(captured.agent);
      const currentRole = current.modules.deepwork.enabled
        ? resolveAdmittedDsmmRole(captured.agent, current, controller.active(captured.agent, current.defaultActive)) : undefined;
      if (agents !== undefined && (captured.agent.id === undefined || agents.get(captured.agent.id) !== captured.agent)
        || current !== settings || currentAdmission !== admission || currentRole !== role
        || controller.describe(captured.agent, current.defaultActive).revision !== modeRevision
        || liveRolePolicyIdentity(captured.agent, current, currentRole, currentAdmission?.epoch) !== policy
        || currentStep && !isCurrentRecoveryStep(events(), captured.turn, captured.step)) {
        throw new Error("DSMM request routing admission is no longer current");
      }
    },
    assertCurrent() {
      decision.assertPolicyCurrent();
      if (decisions.get(captured.agent) !== decision) throw new Error("DSMM request routing was superseded");
      const assertRoute = routeAssertions.get(decision);
      if (assertRoute !== undefined) assertRoute();
      else if (decision.configuredRoot && initialLock !== undefined
        && (roleRouteLock(captured.agent, policy!) !== initialLock || initialLock.generation !== initialGeneration)) {
        throw new Error("DSMM request route generation changed");
      }
    },
  });
  decisions.set(frame.agent, decision);
  return decision;
}

export function captureRequestRoute(frame: AgentRequestFrame, decision: DsmmRequestRoutingDecision, effortSource?: DsmmEffortSource): void {
  decision.assertCurrent();
  const lock = decision.policy === undefined ? undefined : roleRouteLock(frame.agent, decision.policy);
  const generation = lock?.generation;
  routeAssertions.set(decision, () => {
    const current = decision.policy === undefined ? undefined : roleRouteLock(frame.agent, decision.policy);
    if (current !== lock || current?.generation !== generation) throw new Error("DSMM request route generation changed");
  });
  results.set(frame, Object.freeze({ decision, effortSource, assertCurrent: decision.assertCurrent }));
}
