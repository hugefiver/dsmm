import { LlmError } from "@deepseek-ai/dsh-llm";
import type { Context } from "@deepseek-ai/cordis";
import { captureDsmmEffortSource, requiresDsmmCallAdmission, snapshotDsmmCall } from "./host-llm.js";
import type { DsmmLlmHostOwner, DsmmLlmAdmission, DsmmLlmRequestFrame, DsmmLlmGeneration, DsmmLlmCallConfig } from "./host-llm.js";
import type { DsmmPiAiProviderOwner } from "./native-pi-ai-wire.js";
import type { DshAgent } from "./dsh-types.js";
import { resolvedModelParameterPolicy } from "./model-parameter-policy.js";
import { modelRouteFromCall, projectModelRouteParameters } from "./role-llm.js";

export interface DsmmCoreLlmOwner {
  /** Undefined is only the physically owned ordinary-native child path. */
  admit(frame: DsmmLlmRequestFrame): Promise<DsmmLlmAdmission | undefined>;
}
declare module "@deepseek-ai/cordis" { interface Context { dsmmCoreLlmOwner: DsmmCoreLlmOwner } }

/** Connect the cold Host LLM owner to the existing exact Agent/role admission authority. */
export function createDsmmRoleLlmOwner(ctx: Context, providers: Pick<DsmmPiAiProviderOwner, "generation"> & { requiresRaw?(config: DsmmLlmCallConfig): boolean }): DsmmLlmHostOwner {
  const nativeFallback = async (frame: Parameters<DsmmLlmHostOwner["preflight"]>[0], proposal: DsmmLlmCallConfig) => {
    const config = snapshotDsmmCall(proposal);
    if (requiresDsmmCallAdmission(config, providers, frame.agent)) throw new LlmError("Enhanced requests require exact Core admission", "DSMM_NOT_READY");
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
      const admission = await core.admit(frame);
      if (admission === undefined) {
        return nativeFallback(frame, proposal);
      }
      const agent = frame.agent as unknown as DshAgent;
      const original = ctx.get("dsmmProfileRuntime")!.admission(agent);
      if (original !== admission.admission) throw new Error("LLM policy does not own the exact admission");
      const policy = resolvedModelParameterPolicy(original);
      const effortSource = captureDsmmEffortSource(frame.agent);
      const config = snapshotDsmmCall(projectModelRouteParameters(modelRouteFromCall(proposal), effortSource, policy.mode !== "native-defaults"));
      admission.assertCurrent();
      if (policy.mode !== "passthrough") {
        return { kind: "stock", admission, config, effortSource };
      }
      if (!requiresDsmmCallAdmission(config, providers)) {
        try {
          await ctx.get("llm")!.resolveCallConfig(config, frame.signal);
          admission.assertCurrent();
          return { kind: "stock", admission, config, effortSource };
        } catch (error) {
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
