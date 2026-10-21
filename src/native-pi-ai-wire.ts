import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-settings";
import { isDeepStrictEqual } from "node:util";
import { brandString } from "@deepseek-ai/dsh-brand";
import { PiAiAdapter, Config } from "@deepseek-ai/dsh-llm-pi-ai";
import type { Options, PiAiAdapterOptions, ResolvedPiAiProviderProfile } from "@deepseek-ai/dsh-llm-pi-ai";
import { createModels, createProvider, envApiKeyAuth, hasApi } from "@earendil-works/pi-ai";
import type { Model, Provider, OpenAICompletionsOptions } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { LlmError, ReasoningEffortId, assertUsableApiKey, attributionHeaders, freezeMessage, resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, PreparedAdapterCall, LlmAdapter } from "@deepseek-ai/dsh-llm";
import type { DsmmEffortSource, DsmmLlmCallConfig, DsmmLlmGeneration } from "./host-llm.js";
import { singleUsePreparedStream, snapshotDsmmCall } from "./host-llm.js";
import { DsmmMissingProviderError, modelRouteToCall } from "./role-llm.js";
import type { DsmmLlmRouteResolver } from "./role-llm.js";
import { normalizeModelRouteJson } from "./route-json.js";
import type { ModelRouteJson } from "./route-json.js";

export interface DsmmPiAiOwnerOptions {
  readonly config: Options;
  readonly settingsNamespace: string;
  readonly auth: PiAiAdapterOptions["auth"];
  /** Called only at dispatch. An absent named credential fails; no ambient lookup is used. */
  readonly resolveApiKey: (provider: string, reference: string, signal?: AbortSignal) => Promise<string | undefined>;
}

function normalizeDeclaredProfiles(config: Options): ReadonlyMap<string, ResolvedPiAiProviderProfile> {
  const profiles = new Map<string, ResolvedPiAiProviderProfile>();
  const normalized: Config = Config(config);
  for (const [provider, profile] of Object.entries(normalized.providers.get())) {
    if (profile.api !== "openai-completions" || !profile.baseURL || !profile.apiKeyEnv || !profile.models?.length
      || profile.modelOverrides !== undefined && Object.keys(profile.modelOverrides).length > 0) {
      throw new LlmError("Raw execution requires an explicit completions endpoint, credential reference and finite model list without catalog overrides", "UNSUPPORTED_ROUTE_PARAMETERS");
    }
    const endpoint = new URL(profile.baseURL);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new LlmError("Invalid provider endpoint", "INVALID_CONFIG");
    const seen = new Set<string>();
    const models: Model<"openai-completions">[] = profile.models.map(entry => {
      if (!entry.id || seen.has(entry.id)) throw new LlmError("Model identities must be nonempty and unique", "INVALID_CONFIG");
      seen.add(entry.id);
      const contextWindow = entry.contextWindow ?? profile.defaultContextWindow;
      const maxTokens = entry.maxTokens ?? profile.defaultMaxTokens;
      const input = [...(entry.input?.length ? entry.input : profile.defaultInput!)];
      if (input.length === 0) throw new LlmError("Declared models must have input modalities", "INVALID_CONFIG");
      if (!Number.isSafeInteger(contextWindow) || contextWindow! <= 0 || !Number.isSafeInteger(maxTokens) || maxTokens! <= 0) throw new LlmError("Model capacities must be positive integers", "INVALID_CONFIG");
      const efforts = entry.reasoningEfforts;
      const thinkingLevelMap: NonNullable<Model<"openai-completions">["thinkingLevelMap"]> = {
        off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null,
        ...(efforts || {}),
      };
      if (efforts && efforts.off === null) delete thinkingLevelMap.off;
      return { id: entry.id, name: entry.name ?? entry.id, provider, api: "openai-completions", baseUrl: profile.baseURL!,
        reasoning: !!efforts, ...(efforts ? { thinkingLevelMap } : {}), input, contextWindow: contextWindow!, maxTokens: maxTokens!,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { ...profile.compat, ...entry.compat } };
    });
    const piProvider = createProvider({ id: provider, name: profile.displayName ?? provider, baseUrl: profile.baseURL,
      auth: { apiKey: envApiKeyAuth(provider, []) }, models, api: openAICompletionsApi() });
    profiles.set(provider, {
      provider, displayName: profile.displayName ?? provider, api: profile.api, baseURL: profile.baseURL,
      ...(profile.headers === undefined ? {} : { headers: { ...profile.headers } }),
      ...(profile.reasoning === undefined ? {} : { reasoning: profile.reasoning }),
      ...(profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: { ...profile.thinkingBudgets } }),
      ...(profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention }),
      ...(profile.transport === undefined ? {} : { transport: profile.transport }),
      ...(profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs }),
      ...(profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs }),
      apiKeyEnv: brandString<NonNullable<ResolvedPiAiProviderProfile["apiKeyEnv"]>>(profile.apiKeyEnv),
      streamIdleTimeoutMs: profile.streamIdleTimeoutMs!, maxRequestImageBytes: profile.maxRequestImageBytes!,
      requestImagePixelBudget: profile.requestImagePixelBudget!, requestImageMaxBytes: profile.requestImageMaxBytes!,
      retryPolicy: resolveRetryPolicy(profile.retryPolicy?.mode === "normal" ? { ...profile.retryPolicy,
        retryableCodes: profile.retryPolicy.retryableCodes === undefined ? undefined : [...profile.retryPolicy.retryableCodes] } : profile.retryPolicy, `dsmm.providers.${provider}.retryPolicy`), piProvider, modelErrors: new Map(),
      configuredMaxTokens: new Map(profile.models.flatMap(model => model.maxTokens === undefined ? [] : [[model.id, model.maxTokens]])),
    });
  }
  if (profiles.size === 0) throw new LlmError("DSMM provider owner must own at least one declared route", "INVALID_CONFIG");
  return profiles;
}

function protectedHeaders(headers: Record<string, string | null>): Record<string, string> {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) if (value !== null) result.set(key, value);
  for (const [key, value] of Object.entries(attributionHeaders())) result.set(key, value);
  return Object.fromEntries(result);
}

/** Public provider composition preserves the SDK's native content/replay/stream translator. */
function rawProvider(provider: Provider, generation: ReturnType<typeof createModels>, request: GenerateOptions & DsmmLlmCallConfig, assertCurrent: () => void, effortSource: DsmmEffortSource): Provider {
  return {
    ...provider,
    streamSimple(model, context, options) {
      const exact = generation.getModel(model.provider, model.id);
      if (exact === undefined || !hasApi(exact, "openai-completions")) throw new LlmError("Raw generation has no exact completions model", "UNKNOWN_MODEL");
      const tokenField = ["max_tokens", "max_completion_tokens", "max_output_tokens"].find(key => Object.hasOwn(request.customParameters ?? {}, key));
      const rawBudget = tokenField === undefined ? undefined : request.customParameters?.[tokenField];
      if (rawBudget !== undefined && (typeof rawBudget !== "number" || options?.maxTokens !== undefined && rawBudget > options.maxTokens)) throw new LlmError("Raw token budget conflicts with the Host request budget", "INVALID_REQUEST");
      const baseOptions = buildBaseOptions(exact, context, { ...options, ...(typeof rawBudget === "number" ? { maxTokens: rawBudget } : {}) });
      if (rawBudget !== undefined && baseOptions.maxTokens !== rawBudget) throw new LlmError("Raw token budget exceeds the native context budget", "INVALID_REQUEST");
      const wireOptions: OpenAICompletionsOptions = {
        ...baseOptions,
        onPayload(payload) {
          assertCurrent(); request.signal?.throwIfAborted();
          if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new LlmError("Provider did not build an object payload", "INVALID_REQUEST");
          if (tokenField !== undefined && !Object.hasOwn(payload, tokenField)) throw new LlmError("Raw token field does not match the declared model protocol", "INVALID_REQUEST");
          const body = { ...payload, ...request.customParameters };
          if (effortSource === "dsmm-config" && request.reasoningEffort !== undefined) Reflect.set(body, "reasoning_effort", request.reasoningEffort);
          if (request.stop !== undefined) Reflect.set(body, "stop", [...request.stop]);
          return body;
        },
      };
      const transformHeaders = (headers: Record<string, string | null>) => {
        assertCurrent(); request.signal?.throwIfAborted();
        return protectedHeaders(headers);
      };
      if (effortSource === "native") return generation.streamSimple(exact, context, { ...options,
        ...(typeof rawBudget === "number" ? { maxTokens: rawBudget } : {}), onPayload: wireOptions.onPayload, transformHeaders });
      return generation.stream({ ...exact, reasoning: false, thinkingLevelMap: undefined }, context, { ...wireOptions, transformHeaders });
    },
  };
}

export interface DsmmPiAiProviderOwner extends DsmmLlmRouteResolver {
  readonly stockAdapter: PiAiAdapter;
  readonly providers: readonly string[];
  requiresRaw(config: DsmmLlmCallConfig): boolean;
  supportsNativeStop(provider: string): boolean;
  generation(provider: string): DsmmLlmGeneration;
}
declare module "@deepseek-ai/cordis" { interface Context { dsmmLlmProviderOwner: DsmmPiAiProviderOwner } }

export interface DsmmPiAiProviderPlugin {
  readonly name: "dsmm-llm-provider-owner";
  readonly inject: string[];
  readonly Config: typeof Config;
  apply(ctx: Context, config: ReturnType<typeof Config>): void;
}

export function createDsmmPiAiProviderPlugin(options: DsmmPiAiOwnerOptions, ready: (owner: DsmmPiAiProviderOwner) => void): DsmmPiAiProviderPlugin {
  return { name: "dsmm-llm-provider-owner", inject: ["llm", "settings"], Config,
    apply(ctx: Context, config: ReturnType<typeof Config>) {
      const expected = Config(options.config).providers.get();
      if (!isDeepStrictEqual(config.providers.get(), expected)) throw new LlmError("Cold provider entry differs from the Host-owned declaration", "INVALID_CONFIG");
      ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber));
      ctx.on("internal/config", function(_raw, next) {
        const candidate = next();
        if (this === ctx.fiber && !isDeepStrictEqual(Config(candidate).providers.get(), expected)) throw new LlmError("Provider ownership changes require a cold Host restart", "INVALID_CONFIG");
        return candidate;
      });
      const owner = createDsmmPiAiProviderOwner(ctx, options);
      ctx.provide("dsmmLlmRoutes", owner);
      ready(owner);
    },
  };
}

/** Build the raw executor from declared profiles; borrowed registrations remain native-owned. */
export function createDsmmPiAiProviderOwner(ctx: Context, options: DsmmPiAiOwnerOptions,
  borrowed?: { readonly signal: AbortSignal; readonly adapter: LlmAdapter; assertCurrent(): void }): DsmmPiAiProviderOwner {
  const profiles = normalizeDeclaredProfiles(options.config);
  const identity = Object.freeze({});
  const life = new AbortController();
  const assertCurrent = (): void => {
    life.signal.throwIfAborted();
    if (borrowed !== undefined) { borrowed.signal.throwIfAborted(); borrowed.assertCurrent(); }
    else if (ctx.get("dsmmLlmProviderOwner") !== owner) throw new LlmError("Provider generation no longer owns its Host service", "INVALID_PREPARED_CALL");
  };
  if (borrowed === undefined) ctx.effect(() => () => life.abort(new LlmError("Provider owner retired", "INVALID_PREPARED_CALL")));
  const resolveNamedKey = async (provider: string, profile: ResolvedPiAiProviderProfile, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted(); assertCurrent();
    if (profile.apiKeyEnv === undefined) throw new LlmError("Provider credential reference is required", "MISSING_CREDENTIAL");
    const key = await options.resolveApiKey(provider, profile.apiKeyEnv, signal);
    signal.throwIfAborted(); assertCurrent();
    if (key === undefined) throw new LlmError("Provider credential is unavailable", "MISSING_CREDENTIAL");
    return assertUsableApiKey(key, "dsmm", profile.apiKeyEnv);
  };
  const resolveApiKey: PiAiAdapterOptions["resolveApiKey"] = (provider, profile) => resolveNamedKey(provider, profile, life.signal);
  const adapterOptions: PiAiAdapterOptions = { profiles: () => profiles, resolveApiKey, auth: options.auth,
    resolveAttachments: () => ctx.get("attachments"),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, path => ctx.get("fs")?.processPathFromHostPath(path), ref),
    onReplayDegrade: () => ctx.logger.warn("DSMM provider replay degraded to native content"),
  };
  const stockStream = (request: GenerateOptions, preparationSignal?: AbortSignal) => {
    assertCurrent();
    const signal = AbortSignal.any([life.signal, ...request.signal === undefined ? [] : [request.signal], ...preparationSignal === undefined ? [] : [preparationSignal]]);
    return new PiAiAdapter({ ...adapterOptions, resolveApiKey: (provider, profile) => resolveNamedKey(provider, profile, signal) }).stream(request);
  };
  const stockAdapter = new class extends PiAiAdapter {
    override stream(request: GenerateOptions) { return stockStream(request); }
    override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
      const prepared = await super.prepareCall(provider, model, signal);
      signal?.throwIfAborted(); assertCurrent();
      return { ...prepared, stream: request => stockStream(request, signal) };
    }
  }(adapterOptions);
  const providers = Object.freeze([...profiles.keys()]);
  if (borrowed === undefined) {
    ctx.llm.registerAdapter([...providers], stockAdapter);
    ctx.llm.registerConfigurableProviders([...profiles.values()].map(profile => ({ provider: profile.provider, displayName: profile.displayName,
      settingsNs: options.settingsNamespace, settingsPath: ["providers", profile.provider], declared: true })));
    ctx.llm.registerModelDiscovery(options.settingsNamespace, async (request, signal) => {
      signal?.throwIfAborted();
      if (request.provider === undefined || !profiles.has(request.provider)) throw new LlmError("Discovery requires a route owned by this Host", "NO_ADAPTER");
      return (await stockAdapter.listModels(request.provider)).map(model => ({ id: model.id, name: model.name, inputModalities: model.inputModalities }));
    });
  }
  const models = createModels(options.auth);
  for (const profile of profiles.values()) models.setProvider(profile.piProvider!);
  const owner: DsmmPiAiProviderOwner = Object.freeze({ stockAdapter, providers,
    requiresRaw: (config: DsmmLlmCallConfig) => config.customParameters !== undefined || config.stop !== undefined && profiles.has(config.provider),
    supportsNativeStop: (provider: string) => !profiles.has(provider),
    async resolveRoute(input: ModelRouteJson, signal?: AbortSignal) {
      const route = normalizeModelRouteJson(input);
      signal?.throwIfAborted(); assertCurrent();
      const call = snapshotDsmmCall(modelRouteToCall(route));
      if (profiles.has(route.provider)) {
        if (models.getModel(route.provider, route.model) === undefined) throw new LlmError("Provider has no exact declared model", "UNKNOWN_MODEL");
        await stockAdapter.resolveModel(route.provider, route.model, signal);
      } else {
        if (!ctx.llm.listProviders().some(provider => provider.id === route.provider)) throw new DsmmMissingProviderError();
        await ctx.llm.resolveCallConfig(call, signal);
        if (call.customParameters !== undefined) throw new LlmError("Raw route parameters require their declared Host provider owner", "UNSUPPORTED_ROUTE_PARAMETERS");
      }
      signal?.throwIfAborted(); assertCurrent();
      return route;
    },
    generation(provider: string): DsmmLlmGeneration {
      const profile = profiles.get(provider);
      if (profile === undefined) throw new LlmError("Provider is not owned by this Host", "NO_ADAPTER");
      return Object.freeze({ identity, signal: borrowed === undefined ? life.signal : AbortSignal.any([life.signal, borrowed.signal]), retryPolicy: profile.retryPolicy, assertCurrent,
        ...(profile.reasoning === undefined ? {} : { defaultReasoningEffort: ReasoningEffortId(profile.reasoning) }),
        async prepareCall(selectedProvider: string, model: string, signal: AbortSignal, assertAdmission?: () => void, effortSource?: () => DsmmEffortSource): Promise<PreparedAdapterCall> {
          const assertCall = (): void => { signal.throwIfAborted(); assertCurrent(); assertAdmission?.(); };
          assertCall();
          if (selectedProvider !== provider || models.getModel(provider, model) === undefined) throw new LlmError("Provider has no exact declared model", "UNKNOWN_MODEL");
          const prepared = await (borrowed?.adapter ?? stockAdapter).prepareCall(provider, model, signal);
          assertCall();
          if (prepared.model.provider !== provider || prepared.model.id !== model) throw new LlmError("Provider resolved another model", "INVALID_ADAPTER");
          const catalogProvider = getBuiltinProviders().find(id => id === provider);
          const catalogModel = catalogProvider !== undefined && getBuiltinModels(catalogProvider).some(entry => entry.id === model);
          return { model: prepared.model, stream: singleUsePreparedStream(request => {
            assertCall(); request.signal?.throwIfAborted();
            if (request.provider !== provider || request.model !== model) throw new LlmError("Raw request changed its prepared route", "INVALID_PREPARED_CALL");
            const extended: GenerateOptions & DsmmLlmCallConfig = request;
            const checked = snapshotDsmmCall({ provider: request.provider, model: request.model,
              ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
              ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
              ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
              ...(request.stop === undefined ? {} : { stop: request.stop }),
              ...(extended.customParameters === undefined ? {} : { customParameters: extended.customParameters }),
            });
            if (catalogModel) throw new LlmError("Raw execution cannot reproduce implicit catalog model semantics", "UNSUPPORTED_ROUTE_PARAMETERS");
            const source = effortSource?.() ?? "dsmm-config";
            if (source === "native") {
              if (prepared.model.reasoning !== undefined && models.getModel(provider, model)?.thinkingLevelMap === undefined
                || Object.hasOwn(checked.customParameters ?? {}, "reasoning_effort")) {
                throw new LlmError("Native raw execution requires its declared wire mapping and cannot replace native effort with raw effort", "UNSUPPORTED_ROUTE_PARAMETERS");
              }
            }
            const projectedProfiles = new Map([...profiles].map(([id, item]) => [id, { ...item, reasoning: source === "native" ? item.reasoning : undefined,
              piProvider: rawProvider(item.piProvider!, models, { ...request, ...checked }, assertCall, source) }]));
            const credentialSignal = request.signal === undefined ? life.signal : AbortSignal.any([life.signal, request.signal]);
            const rawAdapter = new PiAiAdapter({ ...adapterOptions, profiles: () => projectedProfiles,
              resolveApiKey: async (selectedProvider, selectedProfile) => {
                assertCall();
                const key = await resolveNamedKey(selectedProvider, selectedProfile, credentialSignal);
                assertCall();
                return key;
              } });
            const { reasoningEffort: _effort, stop: _stop, ...native } = request;
            const messages = native.messages.map(message => {
              if (message.role !== "assistant" || message.source.replayState === undefined || profiles.has(message.source.provider)) return message;
              const { replayState: _replay, ...source } = message.source;
              return freezeMessage({ ...message, source });
            });
            return rawAdapter.stream({ ...native, ...(source === "native" && request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}), messages });
          }) };
        },
      });
    },
  });
  if (borrowed === undefined) ctx.provide("dsmmLlmProviderOwner", owner);
  return owner;
}
