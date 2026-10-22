# Runtime recovery and route strategies

DSMM 0.3.11 targets exactly DSH `0.2.1-rc.2`.

## Independent role strategies

Each role may use `startup-lock` (default) or explicit `rate-limit-fallback`. `runtimePolicy` supplies inherited defaults; role `strategy` / `rateLimit` overrides only explicit fields. Profiles contain no native accounts or credentials.

Child preparation admits the primary or first resolvable configured candidate in order without a sacrificial completion. A catalog isn't an authentication/network-health check. `startup-lock` retains the admitted route for bounded safe rate-limit retries. `rate-limit-fallback` may advance its ordered chain after the configured threshold. Success resets consecutive counts, duplicate failure delivery doesn't count twice, and exhausted chains don't wrap.

Ordinary roots retain native assembled provider/model/effort, even before the first selection event. Role/global primary and fallback chains don't automatically replace that route. **Use profile model** is a separate explicit selection action against admitted immutable configuration, not a retry or overlay Apply.

| Policy field | Default | Strict integer bound |
| --- | --- | --- |
| `maxRetries` | 3 | 0 to 10 |
| `initialDelayMs` | 500 | 0 to 30000 |
| `maxDelayMs` | 10000 | 0 to 30000 |
| `maxTotalDelayMs` | 30000 | 0 to 120000 |
| `switchAfterRateLimits` | 3 | 1 to 10 |
| `maxSwitches` | 2 | 0 to 10 |

`maxRetries` counts requests after the first on a route; the threshold includes the first distinct failure. Exhausted retry budget stops the attempt even before the switch threshold. Switches consume a finite scope budget. Invalid values refuse instead of becoming different defaults.

`roleRouting.<role>.fallbackRoutes` owns its full route/parameter sets. Explicit `[]` suppresses inherited alternatives; omission inherits the applicable chain. A fallback doesn't inherit primary-only parameters. Omitted effort clears stale explicit effort. `runtimeRecovery.enabled` isn't the role strategy selector, and retained generic status/code lists don't authorize arbitrary transport/server retries or channel hopping.

## Positive no-output proof and native execution

Every automatic retry or switch needs correlated positive no-output evidence from native `agent/request-error` and `agent/assistant-stream`. Missing, stale, ambiguous or mismatched Agent, admission, request, turn/step or generation evidence refuses replay. Partial text, reasoning or tool-call fragments forbid automatic replay, including same-route retries. Already executed tools aren't rerun.

Only public registration-directory proof of provider absence or adapter-proven `UNKNOWN_MODEL` may advance startup candidates without accepted output. A generic `NO_ADAPTER` from middleware or an unready registered adapter isn't absence proof. Authorization, payment/quota, context, cancellation and ambiguous transport/server failures don't authorize hopping; error wording isn't proof.

Fallback decisions stay in the native request loop. DSMM doesn't create another request scheduler, invoke providers independently, synthesize retry prompts or restart turns. Native adapter retry and DSMM candidate policy must remain bounded together. Where native evidence can't establish a reliable no-output boundary, report automatic fallback unavailable and require explicit retry rather than guessing.

An abortable middleware delay can honor valid `providerRetryAfterMs` only within per-delay and total budgets. Cancellation, owner/provider retirement, closed turn/step boundaries or superseded intent invalidate pending work before another dispatch. Duplicate errors can't reserve a second fallback.

Native model selection, including same-value reselection, is new intent. Assembly captures that intent for the request; a concurrently newer selection belongs to the next assembly, not a retrofit. Child initial routes are defaults, not every-turn overrides of accepted native intent or valid fallback. Existing Agents consume admitted policy, not later saved desired configuration. See [model routing](model-routing.md).

## Live continuation and activation

Idle continuation is separately opt-in under `runtimeRecovery.idleContinuation`; it doesn't follow from a fallback chain. It requires an eligible active live Agent and unfinished durable goal/todo evidence, with a finite per-Agent/turn cap. Steering failure consumes an attempt and doesn't reject turn shutdown. It grants no extra tool or role authority.

Role delegation uses official activation. Waiting uses `delivery:'caller'`; only native `completed` is normal completion. Failure, partial output and cancellation remain visible. After publication, cancellation uses the receipt's `dispose()` and awaits cleanup. Background must be selected before start with `delivery:'parent'`; an accepted child/message receipt isn't completion. Running waiting calls can't be transferred to background.

Supported exact live children may receive Queue/Steer or interrupt through native controls, subject to current direct-parent/operator authority and actual capabilities. Inbox acceptance and interrupt acknowledgment aren't completion. Unknown sends aren't automatically retried. Read-only descendant inspection grants no control.

## Cold resume and lifetime

Native history loading, reading, promotion, explicit/declarative restoration and durable restoration after provider unregistration follow DSH's own rules. DSMM doesn't add a global restoration gate or require an execution-admission SDK, owner slot or participant protocol. DSMM read-only history queries don't themselves call resume.

DSMM uses public serial `agent/created` callbacks for fresh admission. A role's first creation requires its exact pending parent/provider/invocation, standing composition, scope, tool filter and depth ceiling. Role binding precedes Agent-scoped installation; publication rechecks current owner, exact parent, cancellation and composition after installation. Fresh ordinary children of a non-controlled admitted parent inherit its captured configuration and tool ceiling without acquiring a role invocation.

Native `resume` doesn't enroll a reconstructed Agent in DSMM admission. Historical descriptors, role/preset labels, mode events and profile selections don't grant current DSMM role qualification. Fresh roots use current `prepareRoot` and root eligibility checks; saved profile-selection `admissionEpoch` and disk CAS retain their configuration-selection meaning, not execution authority. Old retry, approval and pending-call state isn't restored.

Restricted-role continuation can lose DSMM-specific readonly, tool-filter and depth captures on restoration. The current Host doesn't provide a supported guarantee of safe DSMM restricted-role continuation across restoration, unload/reinstall or restart. That capability is deferred; a restored native request isn't proof of valid DSMM role admission or preserved restrictions. This limitation doesn't block native restoration or ordinary configuration/UI saves.

Official Registry, Runtime and JSONL plugins own lifecycle and storage. DSMM live captures and callbacks retain their exact Agent and current owner checks; Agent-scoped guards remain fail-closed after that owner retires. They don't enroll other Agents or revoke native history globally. Ordinary unadmitted native tool calls, including managed shell calls, retain native approval/sandbox behavior and applicable permission rules through exact live registry, realm and lifetime checks, without acquiring DSMM role or configuration-write rights. Retired exact DSMM captures cannot use that native path. DSMM-specific entry points still require their applicable live admission and permission ceilings; native restoration doesn't provision those rights. No descriptor authorization ledger, persisted grant, cold migration, automatic history rewrite or cross-process automatic retry is provided.

Diagnostics omit request/provider bodies, credentials and goal/todo text.

## Known Host limitation: Windows sandbox and Git Schannel

DSH `0.2.1-rc.2` with the `windows-acl` backend can fail HTTPS Git operations under `workspace-write` with `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)`. This was reproduced on 2026-10-21 using a public repository and isolated Git configuration, without account authentication.

The same Git command succeeds outside the sandbox, fails through both the native DSH executor and the DSMM-managed native tool with unchanged effective sandbox policy, and succeeds inside the same sandbox when explicitly using OpenSSL. This isolates the failure to the Windows sandbox/Schannel interaction, not a DSMM-specific permission decision. The specific restricted-token flag, SID or integrity-level interaction remains undetermined; the error does not establish missing GitHub credentials.

An explicit per-command workaround, where the installed Git supports OpenSSL and its certificate trust configuration is suitable, is:

```powershell
git -c http.sslBackend=openssl ls-remote https://github.com/git/git.git HEAD
```

This changes the TLS trust backend, not the sandbox policy, and keeps certificate verification enabled. DSMM must not inject it silently, change global Git configuration, disable TLS verification or switch to full access to hide the failure.

Upstream fix status is unconfirmed. On a later DSH version, recheck the same read-only Git operation with Schannel through the native `workspace-write` executor and DSMM-managed path. A sandbox fix must also preserve denial of workspace-external writes; a successful full-access command is not a fix. No local Host or dependency patch is applied for this limitation.

### PowerShell in a Fake-IP environment

An isolated PowerShell 7 comparison on DSH `0.2.1-rc.2` confirmed HTTPS access to `https://example.com/` through a Mihomo route with a DNS answer in `198.18.0.0/16`. Node HTTPS/OpenSSL succeeded with certificate verification in the ordinary process, native `windows-acl` `workspace-write` executor and DSMM-managed pwsh tool. Windows curl/Schannel succeeded outside the sandbox but returned exit code 35 and `SEC_E_NO_CREDENTIALS` in both sandbox paths. These results establish connectivity for that Fake-IP route, not a general guarantee for every destination or proxy setup; they do not identify Fake-IP as the cause of the Schannel failure.

The comparison had no `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` or `NO_PROXY` environment variables. Propagation of explicitly configured proxies remains unverified. The DSMM tool result preserves the native command's exit code; an outer `isError: false` alone does not mean the command succeeded. The opt-in [Fake-IP web provider](web-fetch-fakeip.md) affects `ctx.web`, not shell routing or TLS. No bash, WSL or Git Bash network verification is claimed.
