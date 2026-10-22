# DSMM for DeepSeek Harness

DSMM (`@dsmm/dsmm`) adds native configuration, role delegation and child controls to DeepSeek Harness. **DSMM** is the Plugins page and package title; **Deepwork** is its optional workflow module. It isn't an OpenCode compatibility layer.

**DSMM 0.3.11 targets exactly DSH `0.2.1-rc.2`** and Node.js 22 or later. The maintained source repository is [hugefiver/dsmm](https://github.com/hugefiver/dsmm).

## Configuration and profiles

**Plugins → DSMM bundle config** is the deployment editor. Choose sparse Global settings or the current native profile override, then open a module drawer. Each scope has independent Save, Refresh and Discard actions. Profile writes require the exact authorized native form and revision; unavailable forms never fall back to Global writes. Core configuration and permissions remain available without a session and with Deepwork off.

Resolution is **defaults → sparse Global deployment → explicit native entry/profile → admitted named overlay**. Objects merge, arrays replace, and explicit false, empty and same-default values remain pins. Unset removes only the current layer's key. Global storage is `<resolvedDshHome>/plugins/dsmm`; home resolution uses explicit `profileContext.home`, then `DSH_HOME`, then the native `~/.dsh` default.

**Settings → Deepwork Profiles** separates editor draft, saved revision, future-default pin and current-session admission. Save doesn't activate a revision. Future-default selection affects new sessions, not existing Agents or their children. Live overlay **Apply is unavailable** in rc.2: save and select a default for a new session instead. There is no queued Apply or implicit restart.

The Conversation menu's **Use profile model** is an independent native selection action using the admitted immutable configuration, not a later draft. The **Deepwork** toggle records explicit intent, including a same-default choice; DW presets default on, but explicit off wins without removing persona or permission boundaries. Model selection, mode switching and overlay Apply each have their own capability and refusal reason. Disabling Apply doesn't disable the other two. Sessionless controls don't create a session. See [Profiles](docs/profiles.md) and [settings/status](docs/settings-status.md).

Desired configuration, mounted startup capability and actual Agent admission are separate states. Saves don't remount services or update running task policy. Global and named stores use their own CAS/atomic-write boundaries; native profile forms use native revision CAS, not a cross-layer transaction. A committed save with failed observation remains saved with refresh required. An unconfirmed native mutation requires reread, not blind retry. Writes require the actual operator and valid connection/owner lifetime through precommit.

## Roles and execution

The inventory contains 11 base roles, 11 categories and fourteen configurable lazy skills. Only the Orchestrator is a selectable standing root and the only registered native preset; every other role is an internal delegation target whose children share the parent's standing composition. Cross-cutting defaults off. Preset discovery, root eligibility and model availability are separate checks. A role name doesn't prove a different model or grant authority.

Official **AgentRegistry, SubagentRuntime and JSONL namespace plugins own execution and storage**. DSMM binds immutable per-Agent configuration and per-call role policy through native preset/provider composition and awaited creation. There is no custom execution owner, manual-runtime selector or persistence companion to install. `preset-skills` is an internal Agent-scoped handle, not a public Loader plugin.

Role calls wait for the official activation result by default. Only native `stopReason: completed` is normal completion; failure, interruption and partial output remain distinct. After publication, cancellation uses the activation receipt's `dispose()` and waits for cleanup. If background execution is enabled, choose `run_in_background:true` **before starting**; delivery is then owned by the native parent notification path. An accepted child/message receipt isn't a completed task. A running waiting call can't be transferred to background.

Supported live direct-child controls use native Queue, Steer and interrupt under exact-parent and operator authority. Descendant inspection is read-only. Availability follows actual native capabilities, not a visible button or catalog row. Unknown send outcomes must not trigger automatic resend. **Resuming a persisted DSMM session builds a fresh admission from the current deployment**: history stays readable user intent, while delegation authority and child residency are never reconstructed from logs, labels or current settings. See [Agent presets and child control](docs/agent-presets.md).

Collapsed call rows show **Call Coding** / **调用 Coding** when the target is known; child labels use **Coding: task description**. Requested identity is distinct from validated actual execution identity. Partial arguments, failures, interruptions and current-format replay retain that distinction, including nested PTC calls. Native safety refusal views take precedence.

## Models and resources

Ordinary roots retain native provider/model/effort selection. Role calls default to `level:"normal"`; eligible targets may configure exact `low`, `high` and `max`. `subagents.toolTopology` chooses per-role or parameterized tools. Per-call `route` is absent unless deployment explicitly grants it; named profiles can't grant that permission. Child routes are initial defaults, not every-turn overrides of later native intent.

Standard supported requests use native prepared calls. Raw/custom parameters and Pi-AI stop-only requests use the minimal public Pi-AI `openai-completions` payload seam for self-contained literal or explicit model-mapping configurations. Catalog-backed raw combinations that can't be reliably reproduced are rejected regardless of native or DSMM parameter source. Standard Coding remains available, and native effort encoding and advertised capabilities remain unchanged. See [model routing](docs/model-routing.md) and [bounded recovery](docs/runtime-recovery.md).

Skills expose metadata first and read bodies on demand within the admitted Agent scope. Deepwork off hides DSMM skills, not Host/project resources or role restrictions. Non-DSMM ancestor resource winners remain authoritative. [Maintenance](docs/maintenance.md) covers source ownership, generation, packaged resources, licenses and attribution.

DSMM-managed external LSP remains disabled, including with `lsp.enabled:true`. It isn't automatically remounted by Save, restart or Deepwork activation. The retained external MCP configuration calls the `ocmm-lsp` executable from the published `ocmm` npm package; DSMM carries no LSP source, native build or LSP publication lane. DSH's own LSP and independently configured MCP are unaffected. See [LSP boundary](docs/lsp.md).

## Use a local artifact

Use an explicitly authorized locally packed artifact for evaluation. For a disposable CLI evaluation:

```powershell
$env:DSH_HOME = "<disposable-test-home>"
dsh --profile <test-profile> --from-default-profile headless --dump-config
dsh plugin --profile <test-profile> add <absolute-path-to-local-candidate.tgz>
dsh --profile <test-profile> --dump-config
```

Use an empty test home and a fresh profile. These examples aren't authorization to install software or change a real Desktop/TUI profile. Headless task execution requires a separately configured native provider and effective `defaultActive:true`; it doesn't select Agent presets. `/deepwork [off|message]` and inspection-only `/dsmm-status [json]` belong to the Host command adapter, not headless task text. `--dump-config` shows Loader composition, not full Global-aware admission.

Real installation must preserve providers/accounts, credentials, unrelated Loader rows and history. No old-profile or cold-history migration is supplied. Desktop plugin installation follows publication and requires the exact rc.2 Host; it doesn't upgrade the Host. See [compatibility](docs/compatibility.md) and [release policy](docs/releasing.md).

## Safety and network limits

DSH owns approval, sandboxing, depth and cancellation. DSMM narrows authority through role, tool and exact-call checks; it doesn't create a second approval queue or reusable grants. Native once approval applies only to that call and scope. See [native permissions](docs/native-permissions.md) and [safety guards](docs/safety-guards.md).

Search/Fetch remain explicitly selected native providers. The optional Fake-IP fetch adapter, its exact `/16` policy and network limits are documented in [Fake-IP fetch](docs/web-fetch-fakeip.md). The shell rejection source remains unknown; neither tool Allow nor disabling sandbox is a network fix.

Retired brand-specific routing fields reject rather than migrate. Unsupported configuration and history stay untouched.

## Development and release

The checked-in `src/`, `prompts/`, and `skills/` trees are the standalone maintenance sources. Build, test, role generation, frontend provenance, and package checks do not read a sibling repository. See [maintenance](docs/maintenance.md) and [release policy](docs/releasing.md).
