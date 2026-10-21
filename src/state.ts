import type { DshAgent, DshContext, DshSessionEvent } from "./dsh-types.js";
import { resolveSelectedAgentPreset, sessionEvents } from "./session-scope.js";
import { appendModeRecord } from "./session-metadata.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isDsmmRoleId } from "./roles.js";
import type { SessionDeepworkState } from "./profile-types.js";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { NativeAdmission } from "./native-admission.js";
import { capturedRoleInvocation } from "./role-invocation.js";
import { Context } from "@deepseek-ai/cordis";

export const DEEPWORK_MODE_EVENT = "deepwork/mode";
export type DeepworkSelectionOutcome = "committed" | "unchanged";

function activeFromEvent(event: DshSessionEvent): boolean | undefined {
  const data = event.data;
  return event.type === DEEPWORK_MODE_EVENT && typeof data === "object" && data !== null && "active" in data && typeof data.active === "boolean" ? data.active : undefined;
}

export function isDeepworkActive(events: readonly DshSessionEvent[] = [], defaultActive = false, selectedPreset?: string): boolean {
  return foldModeIntent(events, isDsmmRoleId(selectedPreset) || (selectedPreset !== "minimal" && defaultActive));
}

function foldModeIntent(events: readonly DshSessionEvent[], active: boolean): boolean {
  for (const event of events) active = activeFromEvent(event) ?? active;
  return active;
}

export function hasOpenTurn(events: readonly DshSessionEvent[] = []): boolean {
  let open = false;
  for (const event of events) {
    if (event.type === "turn/start") open = true;
    else if (event.type === "turn/end") open = false;
  }
  return open;
}

export class DeepworkModeController {
  private readonly listeners = new Set<(agent: DshAgent) => void>();
  private readonly versions = new WeakMap<DshAgent, Map<boolean, { fields: unknown; revision: string }>>();
  constructor(private readonly ctx: DshContext, private readonly moduleEnabled: (agent: DshAgent) => boolean = () => true,
    private readonly runtimeReady: () => boolean = () => true) {}

  watch(listener: (agent: DshAgent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Profile commits have no native session event; notify their Agent mount. */
  changed(agent: DshAgent): void { for (const listener of this.listeners) listener(agent); }

  active(agent: DshAgent | undefined, defaultActive: boolean): boolean {
    return agent !== undefined && this.moduleEnabled(agent) && foldModeIntent(sessionEvents(agent.session),
      this.childDefaultActive(agent) || isDeepworkActive([], defaultActive, this.selectedPreset(agent)));
  }

  private selectedPreset(agent: DshAgent): string | undefined {
    return Context.is(agent.ctx) ? agent.ctx.get("agentPresets")?.composedPreset(agent.ctx) : resolveSelectedAgentPreset(agent.session);
  }

  private childDefaultActive(agent: DshAgent): boolean {
    const invocation = capturedRoleInvocation(agent), admission = this.ctx.get?.<NativeAdmission>("dsmmNativeAdmission");
    if (invocation === undefined || admission?.isReady !== true) return false;
    try {
      if (admission.get(agent as Agent) === undefined) {
        // bindChild precedes installation; only its current admission candidate may supply this default.
        admission.configuration(agent as Agent);
        admission.policy.assertModuleAdmission(agent);
      } else {
        if (admission.invocation(agent as Agent) !== invocation) return false;
        admission.assert(agent as Agent);
      }
      const identity = admission.policy.identity(agent);
      return identity.child && identity.role === invocation.target;
    } catch { return false; }
  }

  describe(agent: DshAgent, defaultActive: boolean): SessionDeepworkState {
    const events = sessionEvents(agent.session), preset = this.selectedPreset(agent);
    const intents = events.map(activeFromEvent).filter((value) => value !== undefined);
    const fields = { preset, defaultActive, intents, enabled: this.moduleEnabled(agent), childDefaultActive: this.childDefaultActive(agent),
      presetChanges: events.filter((event) => event.type === "agent-preset/selected").length };
    let defaults = this.versions.get(agent);
    if (defaults === undefined) { defaults = new Map(); this.versions.set(agent, defaults); }
    let version = defaults.get(defaultActive);
    if (version === undefined || !isDeepStrictEqual(version.fields, fields)) {
      version = { fields, revision: `mode-v1-${randomUUID()}` };
      defaults.set(defaultActive, version);
    }
    return { active: fields.enabled && foldModeIntent(events, fields.childDefaultActive || isDeepworkActive([], defaultActive, preset)), explicit: intents.length > 0, locked: false,
      revision: version.revision };
  }

  private intent(agent: DshAgent): boolean | undefined {
    const events = sessionEvents(agent.session);
    for (let index = events.length - 1; index >= 0; index--) {
      const value = activeFromEvent(events[index]);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  async select(agent: DshAgent, active: boolean, defaultActive = false): Promise<DeepworkSelectionOutcome> {
    if (active && !this.runtimeReady()) throw new Error("Deepwork runtime is not ready; enable it in native settings and restart the Host");
    if (active && !this.moduleEnabled(agent)) throw new Error("Deepwork module is not admitted in this session; a mode intent cannot enable it");
    if (agent.status === "running" || hasOpenTurn(sessionEvents(agent.session))) throw new Error("Deepwork mode requires an idle session; no change was queued");
    const before = this.describe(agent, defaultActive);
    if (this.intent(agent) === active) return "unchanged";
    const write = async (signal?: AbortSignal): Promise<void> => {
      signal?.throwIfAborted();
      if (this.describe(agent, defaultActive).revision !== before.revision) throw new Error("Deepwork mode changed; refresh before retrying");
      await this.selectIdle(agent, active, defaultActive);
    };
    if (agent.runMaintenance === undefined) throw new Error("Deepwork mode requires native idle maintenance");
    await agent.runMaintenance(write);
    return "committed";
  }

  /** Called inside the existing native maintenance / admission CAS boundary. */
  async selectIdle(agent: DshAgent, active: boolean, _defaultActive: boolean): Promise<void> {
    if (active && !this.runtimeReady()) throw new Error("Deepwork runtime is not ready; enable it in native settings and restart the Host");
    if (active && !this.moduleEnabled(agent)) throw new Error("Deepwork module is not admitted in this session; a mode intent cannot enable it");
    if (hasOpenTurn(sessionEvents(agent.session))) throw new Error("Deepwork mode requires an idle session");
    if (this.intent(agent) === active) return;
    appendModeRecord(agent.session, active);
    this.changed(agent);
  }
}
