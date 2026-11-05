# Model routing

Providers, accounts and credentials remain native DSH configuration, never named-profile contents.

DSMM supports the Host range declared in [compatibility](compatibility.md), including DSH `0.2.1-rc.2` and `0.2.2-rc.1`. Standard calls use native prepared calls. The public Pi-AI completions seam supports self-contained literal and explicit model-mapping raw configurations; unsupported catalog-backed raw combinations are rejected without affecting standard calls.

## Root policy and child defaults

`rootModelPolicy` is a deployment setting with two values:

- **`native` (default):** roots retain native assembled provider/model/effort, including implicit defaults before the first `model/selection` event. Activating Deepwork, choosing a preset, saving/selecting a profile or refreshing a cold admission does not implicitly apply a root primary. **Use profile model** is the explicit native selection action against admitted configuration; later manual choices remain authoritative. Root retry preserves the native downstream configuration and does not automatically select a profile fallback channel.
- **`configured`:** admitted roots with Deepwork enabled and an effective DSMM role use that role's configured primary and ordered fallback routes. Without an explicit primary, the initial route inherits the native baseline. Ordinary sessions with Deepwork mode off and no effective DSMM role retain native routing. Configuration does not grant a role, enable a disabled module or bypass native capability checks.

Global and native-profile configuration may set this policy; named profiles cannot override it. Clearing a native-profile override restores inheritance from Global. The policy applies to the deployment, not to a detected client: a Web session in the same configured deployment follows it too. A separate Desktop deployment retains the default `native` behavior. Saving desired configuration does not replace an existing Agent's immutable admission; use the existing admission lifecycle to adopt changes.

An explicit primary takes precedence over a picker selection; inherited routing still uses the native baseline. On DSH 0.2.1, configured routing changes the request without writing the picker. On DSH 0.2.2, the public `agent.model.select()` boundary makes the admitted route visible as the pending selection before preparation. Neither path writes the saved native model preference. Status distinguishes the admitted policy and actual route from a declared model.

On 0.2.2, admission and maintenance prepare the selection before a request. Configured roots also bind their cached route on running/inbox boundaries, including the next turn after an idle picker change or mode activation. A running picker can race the next snapshot; a conflicting request then fails before dispatch rather than using an incorrect route. Request-time routing never schedules a deferred correction or removes route parameters to satisfy the Host check. Native roots continue to follow native selection.

Selection/proposal effort is distinct from the effective adapter default. With passthrough OFF, a configured effort does not override defaults: the proposal can omit effort while `prepareCall` resolves the adapter's default for HTTP. Explicit native effort remains explicit. DSMM's plugin metadata associates only its own newly appended selection events with their exact routes; it is not admission or delegation authority.

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

With passthrough **ON**, applicable routes retain bounded opaque JSON for a supported raw adapter. With **OFF**, opaque/custom parameters remain stored but aren't sent, and configured effort doesn't override native defaults. Native-root model/effort choices and child selection retain their existing authority; `rootModelPolicy: "configured"` explicitly selects configuration-led root routing instead. OFF doesn't erase configuration or force replacement effort.

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

The initial matching candidate preserves downstream-only request controls, while its explicitly configured fields take precedence. Same-route retries retain the failed request's complete explicit parameters. Every fallback owns its full parameter set across later steps and turns; primary-only properties never flow into it. Complete JSON values distinguish parameter-only changes at the same provider/model, while key order doesn't. Missing admission or an unsupported raw adapter must not silently fall through to native dispatch with parameters removed.

The native Root model-selection API remains its separate provider/model/effort contract. Its capability and manual-intent checks are independent of unavailable live overlay Apply; it doesn't write a profile selection pointer.

## Native dynamic request headers

On DSH `0.2.2-rc.1`, DSMM-owned standard and raw Pi-AI adapters preserve the native synchronous `llm-pi-ai/request-headers` hook. Borrowed raw adapters use the original provider registration scope; borrowed standard adapters keep their native hook without a duplicate invocation. Configuration and ownership checks use rc.1's public effective configuration and canonical live Fiber, while rc.2 retains its effective `fiber.config` source. Configuration changes and retired registrations invalidate prepared raw calls.

Each inference dispatch receives fresh headers and native frozen request metadata (`provider`, `model`, `sessionId`, `purpose`, `baseURL`). Native attribution remains authoritative after the waterfall. A hook exception follows the native `REQUEST_HEADERS` error path before inference I/O; cancellation and adapter retirement still prevent submission. Model discovery does not acquire an inference-header hook.

DSMM adds no business headers or header configuration. Credentials remain native-owned, and route JSON cannot supply headers or authentication fields. DSH `0.2.1-rc.2` retains its existing adapter behavior without a synthetic replacement hook.

## Invocation selection

Calls default to `level:"normal"`, meaning primary or inherited routing. There is no `levels.normal` setting. `low`, `high` and `max` must be configured for that exact target; an unconfigured requested level refuses before a model request. Orchestrator isn't a child delegation target and doesn't accept level configuration. Levels don't synthesize suffixed personas or change workflow ownership.

A level override is either `{reasoningEffort}` or a complete route with `provider`, `model` and optional effort/JSON parameters. Effort-only selection keeps the resolved model and applies the exact effort to candidate preparation. A complete route replaces the route parameters together; omitted effort isn't borrowed from the old route. Native host options are then honored, and an admitted invocation `route` has final override precedence.

Model-facing `route` is absent by default. Explicit deployment `subagents.allowRouteOverride:true` makes it available with the same effort-only/complete-route grammar; a named overlay can't grant this permission. A complete invocation route fixes initial preparation to that route and removes fallback routes. Effort-only overrides retain configured candidates with the requested effort. All paths still require native preflight and role/depth/filter admission. `modelSelectionSettings:false` remains in native child options.

Invocation metadata reports role, label, effective level, route source (`inherited`, `primary`, `level`, or `invocation-route`), mode and actual IDs when available. Raw call arguments aren't evidence that a route executed.

## Tool topology and target filters

`subagents.toolTopology:"per-role"` exposes individual base-role tools such as `dsmm_builder`, `dsmm_plan_critic` and `dsmm_oracle_2nd`, plus `dsmm_category` for category targets. `"parameterized"` exposes `dsmm_role` with a required `role` parameter and `dsmm_category` with a required `category` parameter. Both parameters use canonical `dsmm-*` IDs, and empty groups have no entry. Native provider aliases remain `dsmm-role-<source-name>`.

Entries contain only currently admitted targets of the correct kind. Exact caller definition, provider identity, role matrix, enablement and native depth capability are checked again at execution. The merged entry name doesn't broaden authority: inherited allow/deny filters still constrain individual targets by canonical per-role tool names. Disabled or cross-kind targets refuse. See [Agent authority](agent-presets.md#delegation-authority).

## Locks, fallback and capture

Child preparation and eligible configured-root preparation select the primary or first resolvable configured candidate in order without a sacrificial request. No admissible candidate produces a visible no-request refusal, not silent baseline routing. Explicit `fallbackRoutes:[]` disables inheritance of a fallback chain. Omitted role strategy/retry fields inherit `runtimePolicy`; `startup-lock` is the default.

`startup-lock` keeps the admitted route across turns and bounded positively no-output-safe `RATE_LIMIT` retries. `rate-limit-fallback` may advance the ordered chain after the configured threshold, within finite switch/delay limits. Counters and locks aren't shared between roles or sessions; duplicate errors don't count twice, success resets consecutive counts, and exhausted chains don't wrap.

Only provider absence established through the public registration directory, or adapter-proven `UNKNOWN_MODEL`, can advance a remaining startup candidate before accepted output/tool fragments. A generic `NO_ADAPTER` from preparation, middleware or an unready registered adapter is not absence proof. Transport, authorization, quota, payment, context and cancelled failures don't authorize model hopping. Partial text, reasoning or tool output forbids automatic retry, including same-route retry. Roots using `native` remain on their native route; eligible `configured` roots use the same bounded fallback rules as configured role routing. See [runtime recovery](runtime-recovery.md).

Resident Agents and freshly delegated children use immutable admitted policy, not a later draft or desired deployment. Cold continuation obtains current policy at its new activation. Child initial routes don't override later accepted native manual intent or valid fallback every turn. Omitted effort clears stale explicit effort. Profile storage, native persistence and execution ownership remain separate; see [profiles](profiles.md#storage-and-lifetime) and [compatibility](compatibility.md).

Native cold restoration establishes a new exact-Agent admission from current configuration and verified native ownership, not from serialized runtime authority. Old capture metadata may supply profile ID and explicit level intent only. A missing capture does not block a native DSMM descriptor. New epochs isolate historical route locks and retry counters. The existing DSMM owner performs admission → recovery preparation → role routing → parameter/model validation → final snapshot/capture → native `prepareCall`; stock-only integrations use the same preparation body once. Exact proposal, Agent, scope, signal and single-consumption checks remain mandatory.

## Observed route versus declared route

The child report compares initial route from real `invocation-capture` with live route from that child's `own-native-request-header`. Neither substitutes for the other. Missing capture is `missing-invocation-capture`; live unknown reasons include `no-own-request-header`, `invalid-own-request-header` and `not-observed`. A root header, inherited history prefix or configured primary isn't proof of the child's own executed route. Compatibility invocation projections are labeled as such, not presented as this comparison.

Foreground tool cards subscribe through the native read-only Gateway stream before the result arrives. Observation carries only provider/model/effort, role/level and exact call/lifetime identity; additional execution parameters remain outside this DTO. Actual effort that the header does not report is shown as unreported. Disconnects or terminal authorization failures invalidate active actual evidence; settled observations stay frozen.

Provider call IDs can repeat across requests. Reuse never blocks delegation: ambiguous live card correlation is removed, while each final result retains its own child/run-bound comparison. Watching a child session requires verified live lineage and grants no additional prompt or interrupt authority. Closing observation leaves native execution and delivery ownership unchanged.

## Gemini 4 calibration

Models with an explicit Gemini 4 identity share the `gemini-4` additive calibration. Supported names include `gemini-4`, numerical minor versions, `gemini-4.x`/`gemini-4.x-pro`, compact `gemini4`/`gemini4.1`, and their `@default`/`:latest` suffixes. A wildcard name does not claim a precise numeric version. Bare `4.x` and a Gemini provider name alone do not select this calibration.

The first recognized model identity controls calibration. Role, planner and category prompt assembly retain their existing layer order and load the additive once; Deepwork-off behavior is unchanged.

## Generic model parameters

All providers use the same native capabilities, `modelParameters`, role primary/fallback/level settings and explicit invocation controls. Omitted effort remains native-owned; DSMM introduces no brand default or advertised-effort fallback. `deepseekV4ProCalibration`, `deepseekV4ProDefaultReasoningEffort`, `deepseekFlashCalibration`, `deepseekFlashDefaultReasoningEffort` and the retired MaxReasoningPresets fields reject configuration input with `deprecated-field`. Operators edit invalid configuration explicitly; historical child evidence is not rewritten.

*Author's note: For an operator assigning child models; configure exact resources and verify the child's own request route rather than treating role names as model proof.*
