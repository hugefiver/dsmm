import { LlmError, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { DsmmLlmCallConfig } from "./host-llm.js";
import { normalizeModelRouteJson } from "./route-json.js";
import type { ModelRouteJson } from "./route-json.js";

/** Host-owned metadata admission; never a completion or a request authorization. */
export interface DsmmLlmRouteResolver {
  resolveRoute(route: ModelRouteJson, signal?: AbortSignal): Promise<ModelRouteJson>;
}

/** Only a public provider-directory lookup can establish this absence. */
export class DsmmMissingProviderError extends LlmError {
  constructor() { super("The provider route has no registered adapter", "NO_ADAPTER"); }
}

declare module "@deepseek-ai/cordis" { interface Context { dsmmLlmRoutes: DsmmLlmRouteResolver } }

const callFields = new Set(["provider", "model", "reasoningEffort", "temperature", "maxTokens", "stop"]);

/** Request projection only. The Host supplies provenance; this does not establish admission or ownership. */
export function projectModelRouteParameters(input: unknown, effortSource: "dsmm-config" | "native", passthrough = true): DsmmLlmCallConfig {
  const route = normalizeModelRouteJson(input);
  if (passthrough) return modelRouteToCall(route);
  return { provider: route.provider, model: route.model,
    ...(effortSource === "native" && route.reasoningEffort !== undefined ? { reasoningEffort: ReasoningEffortId(route.reasoningEffort) } : {}),
    ...(typeof route.temperature === "number" ? { temperature: route.temperature } : {}),
    ...(typeof route.maxTokens === "number" ? { maxTokens: route.maxTokens } : {}),
    ...(Array.isArray(route.stop) && route.stop.every(value => typeof value === "string") ? { stop: route.stop } : {}),
  };
}

/** An explicit effort-only choice replaces either spelling of the prior effort. */
export function withRouteEffort(route: ModelRouteJson, reasoningEffort: string): ModelRouteJson {
  const { reasoningEffort: _effort, reasoning_effort: _rawEffort, ...rest } = route;
  return { ...rest, reasoningEffort };
}

/** External route names remain body names; customParameters itself is ordinary user JSON. */
export function modelRouteToCall(input: unknown): DsmmLlmCallConfig {
  const route = normalizeModelRouteJson(input);
  const customParameters = Object.fromEntries(Object.entries(route).filter(([key]) => !callFields.has(key)));
  const stop = route.stop;
  if (Array.isArray(stop) && stop.length === 0) customParameters.stop = stop;
  return { provider: route.provider, model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
    ...(typeof route.temperature === "number" ? { temperature: route.temperature } : {}),
    ...(typeof route.maxTokens === "number" ? { maxTokens: route.maxTokens } : {}),
    ...(Array.isArray(stop) && stop.length > 0 && stop.every(value => typeof value === "string") ? { stop } : {}),
    ...(Object.keys(customParameters).length === 0 ? {} : { customParameters }),
  };
}

/** Decode native header/config storage without treating the internal envelope as a user field. */
export function modelRouteFromCall(input: { provider: string; model: string; customParameters?: unknown }): ModelRouteJson {
  const { customParameters, ...native } = input;
  if (customParameters !== undefined && (customParameters === null || typeof customParameters !== "object" || Array.isArray(customParameters))) throw new LlmError("Invalid raw parameter envelope", "INVALID_CONFIG");
  for (const key of Object.keys(customParameters ?? {})) {
    if (Object.hasOwn(native, key) || callFields.has(key) && key !== "stop") throw new LlmError("Raw parameters conflict with native call fields", "INVALID_CONFIG");
  }
  return normalizeModelRouteJson({ ...native, ...customParameters });
}

/** Adapter defaults are not explicit route intent. */
export function modelRouteFromHeader(header: unknown): ModelRouteJson {
  if (header === null || typeof header !== "object" || !("config" in header) || header.config === null || typeof header.config !== "object"
    || !("provider" in header.config) || typeof header.config.provider !== "string" || !("model" in header.config) || typeof header.config.model !== "string") throw new LlmError("Native header has no model route", "INVALID_CONFIG");
  const route = modelRouteFromCall({ ...header.config, provider: header.config.provider, model: header.config.model });
  const defaults = "adapterDefaults" in header ? header.adapterDefaults : undefined;
  if (defaults !== null && typeof defaults === "object") {
    if ("maxTokens" in defaults && defaults.maxTokens === true) delete route.maxTokens;
    if ("reasoningEffort" in defaults && defaults.reasoningEffort === true) delete route.reasoningEffort;
  }
  return route;
}
