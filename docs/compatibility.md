# DSMM compatibility and upgrade boundaries

**DSMM 0.3.13 targets exactly DSH `0.2.1-rc.2`** and Node.js 22 or later. Older SDKs and automatically drifting versions aren't supported targets.

## Supported integration

Official AgentRegistry, SubagentRuntime and JSONL namespace plugins own execution and storage. Basic role delegation uses native activation results and cancellation. There is no DSMM Registry/Runtime owner to select, manual-runtime overlay to install or persistence companion to configure. Keep the native storage root, compression and unrelated Loader entries unchanged.

Native Web surfaces are Plugins bundle configuration, Settings Profiles, the compact Conversation menu and delegation call views. CLI/headless use native deployment and tools; headless doesn't select Agent presets. TUI and Desktop retain their own carriers and exposed UI capabilities; Web controls aren't necessarily exposed in TUI.

`preset-skills` is internal Agent-scoped installation, not a public Loader plugin. DSMM-managed external LSP stays disabled even with stored `lsp.enabled:true`; native DSH LSP and independently configured MCP remain unaffected. See [LSP boundary](lsp.md).

### Conversation process summaries

DSH `0.2.1-rc.2` classifies message-level process summaries by tool name: only `subagent` and `subagent_*` enter its subagent category. DSMM delegation tools therefore appear under the generic tools summary even when their individual call cards display the native subagent icon. The separate turn-level delegation classifier has the same name restriction.

The public tool-view slot controls individual call cards, not these summary classifiers. This Host version exposes no dedicated classification contribution or process-group header extension; DSMM retains the native summary behavior. Correct subagent grouping requires a public tool-category contribution consumed by both classifiers, or native recognition of DSMM delegation tools. Recheck in-progress and completed summaries during an authorized DSH upgrade; card appearance alone is not evidence of correct grouping.

## Configuration and actions

Core configuration and native permissions work without a session or active Deepwork. Resolution is defaults → sparse Global → explicit native entry/profile → admitted immutable named overlay. Objects merge, arrays replace, and false/empty/same-default pins remain explicit. Unset only removes the edited layer.

Global and exact native-profile saves are independent. Native form identity/revision and base/user provenance are required; no fallback Global write or cross-layer transaction is implied. Named documents, future-default pointers and actual admission remain separate. Desired saves don't change mounted capability or a running Agent's policy. Without a session, actual admission is unknown.

Save and future-default selection remain available under their own authority. Native **Use profile model** and **Deepwork mode** have independent capabilities. Use profile model consumes the admitted configuration and respects newer native manual model/effort intent, including same-value reselection. Root requests retain native assembled selection/defaults; refreshing an admission does not implicitly select its profile primary or authorize a root fallback channel. See [Profiles](profiles.md) and [settings/status](settings-status.md).

Stores use separate CAS and atomic-write boundaries. Committed saves aren't rolled back in the response because observation/notification failed: report refresh-required or unsynchronized status. An unconfirmed native mutation requires authoritative reread before retry. Operator, connection and owner lifetime remain valid through precommit; client claims or loopback-looking URLs don't authorize writes.

## Execution and recovery

### Native history composition

DSMM runs against the unpatched native DSH packages: it installs no Host-side patches and injects no bootstrap flags. Historical sessions stay readable through native history surfaces, and a persisted DSMM session resumes with a fresh admission built from the current deployment; persisted mode choices remain user intent, while old delegation authority never survives.

Root and native continuable-child activations load current DSMM prompts/skills/roles and the selected profile ID's latest valid content. Explicit baseline and global-default sources remain distinct. Old immutable revisions and runtime captures are not required for a valid native DSMM descriptor. Missing identity or conflicting/unsafe selection metadata refuses; missing or invalid current named content does not fall back. Parent ownership, catalog/own descriptor, provider, independent composition, readonly/filter/depth and cancellation boundaries are validated before publication. Resident Agents do not hot-switch. Settled one-shot children stay non-resumable.

DSH `0.2.1-rc.2` still checks image capabilities against historical `agent.options` before request routing in affected root model-switch and cold-child flows. Text requests can use a current available route while images fail because the historical model is missing or lacks image support. DSH exposes no public atomic route/options update for that preflight; DSMM leaves the refusal intact and does not modify readonly options or fake capabilities. Resolution requires a public route-aware preflight or supported pre-activation options hook. Recheck both root and child scenarios during each authorized DSH upgrade.

Native continuation replays persisted persona and toolFilter. Current DSMM role tools do not store a persona override, so their role prompt is freshly installed. A historical format embedding a complete DSMM prompt into a native persona registration cannot be replaced through the available DSMM-owned registration interfaces. Such native content/filter restrictions remain effective; an independent historical preset that no longer resolves fails explicitly. A later Host public interface for replacing that owned persona/composition, with native restrictions preserved, is required before claiming that format fully refreshed. Labels or model-produced role text alone never supply missing native/host-owned role identity.

### Execution ownership

Role calls wait for native activation results by default; only `completed` is normal completion. Cancellation after publication uses activation disposal and cleanup. Enabled background execution selects `delivery: 'parent'` before start. The accepted child/message receipt and interrupt acknowledgment aren't completion. Running waiting tasks can't transfer to background.

Queue/Steer can enter native cold continuation for supported direct children under exact-parent/operator authority. Listing and interrupt do not wake children; descendant views remain read-only. A cold prompt availability means continuation can be attempted, not that a model has executed. Missing native capability disables the operation; unknown sends aren't automatically resent. See [Agent presets](agent-presets.md).

Resuming a persisted DSMM session builds a fresh admission from the current deployment and validates its mounted composition again; configuration, PluginRecord metadata, labels or child IDs never reconstruct authorization. A resumed child without its exact live parent stays refused: delegated authority exists only on the live parent that admitted it. Preserve readable history; don't substitute a persona, reset a session or import old data automatically. Native factory load/repair can precede the created guard, so a refusal doesn't promise the log was never opened. Clear/compact can retain policy only with the exact live object and admission, not inferred lineage.

Standard supported model calls use native prepared calls. Raw/custom and Pi-AI stop-only calls use the minimal public completions seam for self-contained literal or explicit model-mapping configurations. Catalog-backed raw combinations that can't be reliably reproduced are rejected for both native and DSMM parameter sources, without disabling standard Coding. Native effort encoding/capability metadata isn't rewritten. See [model routing](model-routing.md).

## Retired compatibility surfaces

No old SDK branch, legacy-read host, cold-profile migration, session repair or custom-owner selector is a 0.3.13 activation path. Old libraries, captures and unmarked history aren't copied, rewritten, repaired or adopted by same-name fallback. Retired brand calibration/default-effort and MaxReasoningPresets fields reject with `deprecated-field`; edit configuration deliberately using generic routes and parameters.

Published **0.3.0 retains its rc.1 identity**, immutable tag, package, assets and version-bound receipt grammar. Historical release controls interpret those records under their original identity, not as a runtime compatibility branch.

## Installation boundaries

Evaluate an authorized built artifact in an isolated home/profile as in the [README](../README.md#use-a-local-artifact). Real Desktop/TUI/CLI plugin installation needs exact authorization and the matching rc.2 Host; it doesn't authorize upgrading the Host, touching credentials/history or copying a Desktop profile into another carrier.

Desktop plugin installation follows publication and requires the exact rc.2 Host; it doesn't authorize a Host upgrade. [Release controls](releasing.md) define publication and delivery. [Fake-IP fetch](web-fetch-fakeip.md) owns network details and limits; shell rejection remains unresolved. [Native permissions](native-permissions.md) defines approval scope.
