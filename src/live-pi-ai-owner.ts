import { symbols } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { LlmError } from "@deepseek-ai/dsh-llm";
import type { LlmAdapter, LlmRuntime } from "@deepseek-ai/dsh-llm";
import { Config, PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import type { Options } from "@deepseek-ai/dsh-llm-pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { brandString } from "@deepseek-ai/dsh-brand";
import { isDeepStrictEqual } from "node:util";
import { createDsmmPiAiProviderOwner } from "./native-pi-ai-wire.js";
import type { DsmmLlmGeneration, DsmmLlmCallConfig } from "./host-llm.js";
import { snapshotDsmmCall } from "./host-llm.js";
import { DsmmMissingProviderError, modelRouteToCall } from "./role-llm.js";
import type { DsmmLlmRouteResolver } from "./role-llm.js";
import { normalizeModelRouteJson } from "./route-json.js";

type RegistrationHandle = ReturnType<LlmRuntime["registerAdapter"]>;
type ProviderConfig = ReturnType<typeof Config>["providers"];
const original = (value: object): object => Reflect.get(value, symbols.original) ?? value;
interface Registration {
  readonly scope: Context;
  readonly adapter: LlmAdapter;
  readonly life: AbortController;
  readonly generations: Map<string, { value: DsmmLlmGeneration; retire: AbortController }>;
  providers: readonly string[];
}

/** Captures public registering-fiber provenance; the native runtime remains the sole registry. */
export class LivePiAiOwner implements DsmmLlmRouteResolver {
  private readonly registrations = new Map<string, Registration>();
  constructor(private readonly ctx: Context, private readonly native: LlmRuntime) {}

  supportsNativeStop(provider: string): boolean {
    const registration = this.registrations.get(provider);
    return registration !== undefined && !(registration.adapter instanceof PiAiAdapter);
  }

  requiresRaw(config: DsmmLlmCallConfig): boolean {
    return config.customParameters !== undefined || config.stop !== undefined && !this.supportsNativeStop(config.provider);
  }

  register(scope: Context, providers: readonly string[], adapter: LlmAdapter, handle: RegistrationHandle): RegistrationHandle {
    const record: Registration = { scope, adapter, life: new AbortController(), generations: new Map(), providers: [...providers] };
    const retire = (): void => {
      for (const generation of record.generations.values()) generation.retire.abort(new LlmError("Provider generation retired", "INVALID_PREPARED_CALL"));
      record.generations.clear();
    };
    const remove = (): void => {
      retire(); record.life.abort();
      for (const provider of record.providers) if (this.registrations.get(provider) === record) this.registrations.delete(provider);
    };
    for (const provider of providers) this.registrations.set(provider, record);
    scope.effect(() => remove);
    scope.on("loader/volatile-update", retire, { prepend: true });
    scope.on("loader/partial-dispose", entry => { if (entry === scope.fiber.entry) retire(); }, { prepend: true, global: true });
    scope.on("credentials/reference-updated", retire, { prepend: true, global: true });
    const wrapped: RegistrationHandle = Object.assign(() => { remove(); handle(); }, {
      replace: (next: string[]) => {
        // Native validation is atomic: a rejected replacement leaves the old routes registered.
        retire(); handle.replace(next);
        for (const provider of record.providers) if (this.registrations.get(provider) === record) this.registrations.delete(provider);
        record.providers = [...next];
        for (const provider of next) this.registrations.set(provider, record);
      },
    });
    return wrapped;
  }

  generation(provider: string): DsmmLlmGeneration {
    const record = this.registrations.get(provider);
    if (record === undefined) throw new LlmError("Provider registration is not ready", "DSMM_PROVIDER_NOT_READY");
    const { scope, adapter } = record;
    if (!(adapter instanceof PiAiAdapter) || scope.fiber.entry?.options.name !== "@deepseek-ai/dsh-llm-pi-ai") throw new LlmError("This provider has no raw executor", "UNSUPPORTED_ROUTE_PARAMETERS");
    const config: unknown = scope.fiber.config;
    if (config === null || typeof config !== "object" || !("providers" in config) || config.providers === null || typeof config.providers !== "object"
      || !("get" in config.providers) || typeof config.providers.get !== "function") throw new LlmError("Pi-AI live configuration is unavailable", "DSMM_PROVIDER_NOT_READY");
    const ref = config.providers as ProviderConfig;
    const current = ref.get()[provider];
    if (current === undefined) throw new LlmError("Pi-AI no longer declares this route", "DSMM_PROVIDER_NOT_READY");
    const profile = structuredClone(current);
    const cached = record.generations.get(provider);
    if (cached !== undefined) {
      try { cached.value.assertCurrent(); return cached.value; }
      catch { cached.retire.abort(); record.generations.delete(provider); }
    }
    const retire = new AbortController();
    const credentials = scope.get("credentials");
    const signal = AbortSignal.any([record.life.signal, retire.signal]);
    const assertCurrent = (): void => {
      signal.throwIfAborted();
      if (this.registrations.get(provider) !== record || scope.fiber.state !== 2 || scope.fiber.entry?.fiber !== scope.fiber
        || scope.fiber.config !== config || !isDeepStrictEqual(ref.get()[provider], profile)
        || (credentials === undefined ? scope.get("credentials") !== undefined : scope.get("credentials") === undefined || original(scope.get("credentials")!) !== original(credentials))) {
        retire.abort(new LlmError("Provider configuration or owner changed", "INVALID_PREPARED_CALL"));
        signal.throwIfAborted();
      }
    };
    assertCurrent();
    const owner = createDsmmPiAiProviderOwner(this.ctx, {
      config: { providers: { [provider]: structuredClone(profile) as NonNullable<Options["providers"]>[string] } },
      settingsNamespace: scope.fiber.entry!.options.id,
      auth: { credentials: new InMemoryCredentialStore(), authContext: {
        env: async () => { throw new LlmError("Raw requests require named credentials", "MISSING_CREDENTIAL"); }, fileExists: async () => false,
      } },
      async resolveApiKey(_provider, reference, requestSignal) {
        assertCurrent(); requestSignal?.throwIfAborted();
        if (credentials === undefined) throw new LlmError("The credential service is unavailable", "MISSING_CREDENTIAL");
        const key = await credentials.resolve(brandString<Parameters<Context["credentials"]["resolve"]>[0]>(reference));
        assertCurrent(); requestSignal?.throwIfAborted();
        return key?.value;
      },
    }, { signal, adapter, assertCurrent });
    const value = owner.generation(provider);
    record.generations.set(provider, { value, retire });
    return value;
  }

  async resolveRoute(input: Parameters<DsmmLlmRouteResolver["resolveRoute"]>[0], signal?: AbortSignal) {
    const route = normalizeModelRouteJson(input), call = snapshotDsmmCall(modelRouteToCall(route));
    signal?.throwIfAborted();
    if (!this.native.listProviders().some(row => row.id === route.provider)) throw new DsmmMissingProviderError();
    if (!this.requiresRaw(call)) {
      try { await this.native.resolveCallConfig(call, signal); signal?.throwIfAborted(); return route; }
      catch (error) { if (!(error instanceof LlmError) || !["UNSUPPORTED_REASONING_EFFORT", "UNSUPPORTED_OPTION"].includes(error.code)) throw error; }
    }
    const generation = this.generation(route.provider);
    await generation.prepareCall(route.provider, route.model, signal ?? generation.signal);
    generation.assertCurrent(); signal?.throwIfAborted();
    return route;
  }
}
