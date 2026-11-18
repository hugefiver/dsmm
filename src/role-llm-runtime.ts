import { LlmError } from "@deepseek-ai/dsh-llm";
import type { Context } from "@deepseek-ai/cordis";
import { captureDsmmEffortSource, requiresDsmmCallAdmission, snapshotDsmmCall } from "./host-llm.js";
import type { DsmmEffortSource, DsmmLlmHostOwner, DsmmLlmAdmission, DsmmLlmRequestFrame, DsmmLlmGeneration, DsmmLlmCallConfig } from "./host-llm.js";
import type { DsmmPiAiProviderOwner } from "./native-pi-ai-wire.js";
import type { DshAgent } from "./dsh-types.js";
import { resolvedModelParameterPolicy } from "./model-parameter-policy.js";
import { modelRouteFromCall, modelRouteToCall } from "./role-llm.js";
import { prepareDsmmRequest } from "./model-routing.js";
import type { AgentRequestFrame } from "./dsh-types.js";
import { preparedRequestRouting } from "./request-routing.js";
import { roleRouteLock } from "./role-routing.js";
import { assertResidentRootCurrent } from "./resident-root.js";

interface CoreLlmAdmission extends DsmmLlmAdmission {
  prepare(proposal: DsmmLlmCallConfig): Promise<{ admission: DsmmLlmAdmission; config: DsmmLlmCallConfig; effortSource: DsmmEffortSource }>;
}

export interface DsmmCoreLlmOwner {
  /** Undefined is only the physically owned ordinary-native child path. */
  admit(frame: DsmmLlmRequestFrame): Promise<CoreLlmAdmission | undefined>;
}

/** Request preparations, route locks and invocation effort belong to the admitting Core's module instance. */
export function bindCoreLlmAdmission(frame: DsmmLlmRequestFrame, admission: DsmmLlmAdmission): CoreLlmAdmission {
  return Object.freeze({ ...admission, async prepare(proposal: DsmmLlmCallConfig) {
    admission.assertCurrent(); frame.signal.throwIfAborted();
    const request = frame as unknown as AgentRequestFrame;
    const routed = await prepareDsmmRequest(request, proposal, admission.assertCurrent);
    admission.assertCurrent(); frame.signal.throwIfAborted();
    const routing = preparedRequestRouting(request);
    if (routing === undefined) throw new Error("DSMM request lost its routing capture");
    const bound = Object.freeze({ ...admission, assertCurrent() { admission.assertCurrent(); routing.assertCurrent(); } });
    const effortSource = routing.effortSource ?? captureDsmmEffortSource(frame.agent);
    const config = snapshotDsmmCall(modelRouteToCall(modelRouteFromCall(routed)));
    bound.assertCurrent();
    if (routing.decision.configuredRoot && routing.decision.policy !== undefined) {
      roleRouteLock(request.agent, routing.decision.policy)!.route = modelRouteFromCall(config);
    }
    return { admission: bound, config, effortSource };
  } });
}
declare module "@deepseek-ai/cordis" { interface Context { dsmmCoreLlmOwner: DsmmCoreLlmOwner } }

/** Connect the cold Host LLM owner to the existing exact Agent/role admission authority. */
export function createDsmmRoleLlmOwner(ctx: Context, providers: Pick<DsmmPiAiProviderOwner, "generation"> & { requiresRaw?(config: DsmmLlmCallConfig): boolean }): DsmmLlmHostOwner {
  const nativeFallback = async (frame: Parameters<DsmmLlmHostOwner["preflight"]>[0], proposal: DsmmLlmCallConfig) => {
    const config = snapshotDsmmCall(proposal);
    if (requiresDsmmCallAdmission(config, providers, frame.agent)) throw new LlmError("Enhanced requests require exact Core admission", "DSMM_NOT_READY");
    assertResidentRootCurrent(frame.agent, ctx.get("dsmmNativeAdmission"));
    // Missing opaque fields do not prove native equivalence: standard options
    // must still resolve using this request's complete frozen configuration.
    await ctx.get("llm")!.resolveCallConfig(config, frame.signal);
    frame.signal.throwIfAborted();
    return { kind: "native" as const };
  };
  return {
    async preflight(frame, proposal) {
      const core = ctx.get("dsmmCoreLlmOwner");
      if (core === undefined) {
        return nativeFallback(frame, proposal);
      }
      const captured = await core.admit(frame);
      if (captured === undefined) {
        return nativeFallback(frame, proposal);
      }
      const agent = frame.agent as unknown as DshAgent;
      const original = ctx.get("dsmmProfileRuntime")!.admission(agent);
      if (original !== captured.admission) throw new Error("LLM policy does not own the exact admission");
      const policy = resolvedModelParameterPolicy(original);
      const { admission, config, effortSource } = await captured.prepare(proposal);
      admission.assertCurrent(); frame.signal.throwIfAborted();
      if (policy.mode !== "passthrough") {
        await ctx.get("llm")!.resolveCallConfig(config, frame.signal);
        admission.assertCurrent(); frame.signal.throwIfAborted();
        return { kind: "stock", admission, config, effortSource };
      }
      if (!requiresDsmmCallAdmission(config, providers)) {
        try {
          await ctx.get("llm")!.resolveCallConfig(config, frame.signal);
          admission.assertCurrent();
          return { kind: "stock", admission, config, effortSource };
        } catch (error) {
          admission.assertCurrent(); frame.signal.throwIfAborted();
          if (!(error instanceof LlmError) || error.code !== "UNSUPPORTED_OPTION"
            && (error.code !== "UNSUPPORTED_REASONING_EFFORT" || effortSource === "native")) throw error;
        }
      }
      const generation: DsmmLlmGeneration = providers.generation(config.provider);
      admission.assertCurrent();
      return { kind: "dsmm", admission, config, generation, effortSource };
    },
  };
}
