# Model routing

Providers, accounts and credentials remain native DSH configuration, never named-profile contents.

DSMM 0.3.14 targets exactly DSH `0.2.1-rc.2`. Standard calls use native prepared calls. The public Pi-AI completions seam supports self-contained literal and explicit model-mapping raw configurations; unsupported catalog-backed raw combinations are rejected without affecting standard calls.

## Native roots and child defaults

Every root retains native assembled provider/model/effort, including implicit defaults before the first `model/selection` event. Activating Deepwork, choosing a preset, saving/selecting a profile or refreshing a cold admission does not implicitly apply a root primary. **Use profile model** is the explicit native selection action against admitted configuration; later manual choices remain authoritative. Root retry preserves the exact native downstream configuration and never switches to a profile fallback channel automatically.

`roleRouting` is keyed by canonical IDs such as `dsmm-reviewer`, not tool names or labels. Each entry accepts `primary`, ordered `fallbackRoutes`, `strategy`, bounded `rateLimit`, and `levels`. Omitted primary inherits the native parent route for a child. Explicit host options on new delegation retain their priority. Historical descriptor options are reconstruction defaults, not a new override of current DSMM routing. A cold child resolves its invocation again, taking its own explicit native selection before configured-route preparation; a configured model that will not be used is not a preflight dependency. Ancestor selections, labels and old request defaults are not child selection intent.

```jsonc
{
  "roleRouting": {
    "dsmm-reviewer": {
      "primary": { "provider": "my-provider", "model": "review-model" },
      "levels": {
        "low": { "reasoningEffort": "low" },
        "high": { "reasoningEffort": "high" },
        "max": { "provider": "my-provider", "model": "large-review-model", "reasoningEffort": "max" }
      },
      "fallbackRoutes": [],
      "strategy": "startup-lock"
    }
  }
}
```

These identifiers are placeholders for resolvable routes. Native model selection and standard requests retain the owning adapter's exact effort validation and encoding. Raw support doesn't authorize rewriting advertised capabilities, weakening manual-choice validation or changing standard effort encoding.

## Native prepared calls and raw parameters

`modelParameters.passthrough` is an ordinary Core setting, defaulting to `true`, resolved through Global, explicit native profile and admitted named overlays. It's independent of Deepwork enablement and doesn't prove that a raw executor is installed. Save and future-default selection preserve the original JSON; each admitted Agent keeps its immutable policy.

With passthrough **ON**, applicable routes retain bounded opaque JSON for a supported raw adapter. With **OFF**, opaque/custom parameters remain stored but aren't sent, and configured effort doesn't override native defaults. Independent native model/effort choices remain authoritative under either policy. OFF doesn't erase configuration or force replacement effort.

Standard requests that the native adapter can fully express and consume use native `LlmRuntime.prepareCall`: route, defaults, validation, adapter generation and single dispatch remain native-owned. A synchronous configure callback can't change the captured route. An earlier `resolveCallConfig` query isn't a generation credential for later execution. Native catalog/model APIs remain the directory; DSMM doesn't add another model registry or scheduler.

rc.2's `LlmCallConfig` doesn't carry arbitrary provider JSON, and its Pi-AI stream doesn't consume `stop`. Such custom or stop-only requests use the minimal public Pi-AI `openai-completions` adapter/payload seam. It supports self-contained literal and explicit model-mapping configurations. Catalog-backed raw combinations that can't be reliably reproduced are rejected regardless of whether the parameter source is native selection or DSMM configuration. The loop request stays frozen and isn't patched through `llm/stream`. Standard Coding remains available. Responses and other APIs aren't covered by this raw seam.

The raw seam captures the actual registered adapter fiber, provider configuration and credential-reference generation, with native `LlmAdapter.prepareCall` model/capability checks and single dispatch. Admission, cancellation and owner generations are rechecked after awaits and before submission. Native attribution, attachments, system prompts, tool updates and error classification are preserved. Credentials aren't copied into profiles or resolved through an ambient fallback. Standard native effort encoding remains unchanged; a raw payload hook can't mutate a captured native route or widen its authority.

Saving or selecting a future default preserves route JSON without sending a completion. Actual invocation/preparation checks provider/model support. Existing Agents use admitted parameter policy, while native reactivation resolves current configuration. **Use profile model** is a separate native selection action, not raw execution authorization.

```jsonc
{
  "roleRouting": {
    "dsmm-doc-search": {
      "primary": {
        "provider": "my-provider", "model": "search-model", "reasoningEffort": "medium",
        "temperature": 0, "full": false, "count": 0, "optional_value": null,
        "customParameters": { "rows": [false, 0, null, [], {}] }
      },
      "fallbackRoutes": [
        { "provider": "my-provider", "model": "fallback-model-a", "reasoningEffort": "high", "fallback_kind": "a" },
        { "provider": "my-provider", "model": "fallback-model-b", "reasoningEffort": "high", "fallback_kind": "b" }
      ]
    }
  }
}
```

Additional route properties are bounded plain JSON. Their names, values and presence are preserved, including an ordinary property named `customParameters`. In the supported completions seam, `reasoningEffort` and raw `reasoning_effort` are mutually exclusive. So are `maxTokens`, `max_tokens`, `max_completion_tokens` and `max_output_tokens`. A raw token field must match the actual API/model field and native context budget; conflicts refuse before HTTP rather than rewriting values or selecting a fallback. Raw JSON can't override provider/model, messages, tools, authentication, endpoint, headers, signals, callbacks or authority fields. Native attribution remains authoritative.

Every fallback owns its full parameter set; primary-only properties never flow into it. Complete JSON values distinguish parameter-only changes at the same provider/model, while key order doesn't. Missing admission or an unsupported raw adapter must not silently fall through to native dispatch with parameters removed.

The native Root model-selection API remains its separate provider/model/effort contract. Its capability and manual-intent checks are independent of unavailable live overlay Apply; it doesn't write a profile selection pointer.

## Invocation selection

Calls default to `level:"normal"`, meaning primary or inherited routing. There is no `levels.normal` setting. `low`, `high` and `max` must be configured for that exact target; an unconfigured requested level refuses before a model request. Orchestrator isn't a child delegation target and doesn't accept level configuration. Levels don't synthesize suffixed personas or change workflow ownership.

A level override is either `{reasoningEffort}` or a complete route with `provider`, `model` and optional effort/JSON parameters. Effort-only selection keeps the resolved model and applies the exact effort to candidate preparation. A complete route replaces the route parameters together; omitted effort isn't borrowed from the old route. Native host options are then honored, and an admitted invocation `route` has final override precedence.

Model-facing `route` is absent by default. Explicit deployment `subagents.allowRouteOverride:true` makes it available with the same effort-only/complete-route grammar; a named overlay can't grant this permission. A complete invocation route fixes initial preparation to that route and removes fallback routes. Effort-only overrides retain configured candidates with the requested effort. All paths still require native preflight and role/depth/filter admission. `modelSelectionSettings:false` remains in native child options.

Invocation metadata reports role, label, effective level, route source (`inherited`, `primary`, `level`, or `invocation-route`), mode and actual IDs when available. Raw call arguments aren't evidence that a route executed.

## Tool topology and target filters

`subagents.toolTopology:"per-role"` exposes individual base-role tools such as `dsmm_builder`, `dsmm_plan_critic` and `dsmm_oracle_2nd`, plus `dsmm_category` for category targets. `"parameterized"` exposes `dsmm_role` with a required `role` parameter and `dsmm_category` with a required `category` parameter. Both parameters use canonical `dsmm-*` IDs, and empty groups have no entry. Native provider aliases remain `dsmm-role-<source-name>`.

Entries contain only currently admitted targets of the correct kind. Exact caller definition, provider identity, role matrix, enablement and native depth capability are checked again at execution. The merged entry name doesn't broaden authority: inherited allow/deny filters still constrain individual targets by canonical per-role tool names. Disabled or cross-kind targets refuse. See [Agent authority](agent-presets.md#delegation-authority).

## Locks, fallback and capture

Child preparation selects the primary or first resolvable configured candidate in order without a sacrificial request. No admissible candidate produces a visible no-request refusal, not silent baseline routing. Explicit `fallbackRoutes:[]` disables inheritance of a fallback chain. Omitted role strategy/retry fields inherit `runtimePolicy`; `startup-lock` is the default.

`startup-lock` keeps the admitted route across turns and bounded positively no-output-safe `RATE_LIMIT` retries. `rate-limit-fallback` may advance the ordered chain after the configured threshold, within finite switch/delay limits. Counters and locks aren't shared between roles or sessions; duplicate errors don't count twice, success resets consecutive counts, and exhausted chains don't wrap.

Only provider absence established through the public registration directory, or adapter-proven `UNKNOWN_MODEL`, can advance a remaining startup candidate before accepted output/tool fragments. A generic `NO_ADAPTER` from preparation, middleware or an unready registered adapter is not absence proof. Transport, authorization, quota, payment, context and cancelled failures don't authorize model hopping. Partial text, reasoning or tool output forbids automatic retry, including same-route retry. Ordinary roots remain on their native route. See [runtime recovery](runtime-recovery.md).

Resident Agents and freshly delegated children use immutable admitted policy, not a later draft or desired deployment. Cold continuation obtains current policy at its new activation. Child initial routes don't override later accepted native manual intent or valid fallback every turn. Omitted effort clears stale explicit effort. Profile storage, native persistence and execution ownership remain separate; see [profiles](profiles.md#storage-and-lifetime) and [compatibility](compatibility.md).

Native cold restoration establishes a new exact-Agent admission from current configuration and verified native ownership, not from serialized runtime authority. Old capture metadata may supply profile ID and explicit level intent only. A missing capture does not block a native DSMM descriptor. New epochs isolate historical route locks and retry counters. The existing DSMM owner performs admission → recovery preparation → role routing → parameter/model validation → final snapshot/capture → native `prepareCall`; stock-only integrations use the same preparation body once. Exact proposal, Agent, scope, signal and single-consumption checks remain mandatory.

## Observed route versus declared route

The child report compares initial route from real `invocation-capture` with live route from that child's `own-native-request-header`. Neither substitutes for the other. Missing capture is `missing-invocation-capture`; live unknown reasons include `no-own-request-header`, `invalid-own-request-header` and `not-observed`. A root header, inherited history prefix or configured primary isn't proof of the child's own executed route. Compatibility invocation projections are labeled as such, not presented as this comparison.

## Generic model parameters

All providers use the same native capabilities, `modelParameters`, role primary/fallback/level settings and explicit invocation controls. Omitted effort remains native-owned; DSMM introduces no brand default or advertised-effort fallback. `deepseekV4ProCalibration`, `deepseekV4ProDefaultReasoningEffort`, `deepseekFlashCalibration`, `deepseekFlashDefaultReasoningEffort` and the retired MaxReasoningPresets fields reject configuration input with `deprecated-field`. Operators edit invalid configuration explicitly; historical child evidence is not rewritten.

*Author's note: For an operator assigning child models; configure exact resources and verify the child's own request route rather than treating role names as model proof.*
