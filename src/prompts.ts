import type { DshLlmCallConfig } from "./dsh-types.js";
import type { ToolSchema } from "@deepseek-ai/dsh-llm";
import { readPromptAsset as asset, SOURCE_ROLE_CATALOG, splitCategory } from "./prompt-content.js";
import type { SourceRoleContent } from "./prompt-content.js";
import type { DsmmLocale, DsmmSettings } from "./settings.js";
import type { DsmmInvocationView, DsmmRoleAvailabilityState, SubagentRuntimeAdmissionView } from "./profile-types.js";
import type { DsmmCallableEntry } from "./role-subagents.js";
export { SOURCE_ROLE_CATALOG, buildRolePersona } from "./prompt-content.js";
export type { SourceRoleContent } from "./prompt-content.js";

const activation = `<dsmm-deepwork-mode>
Use this workflow only while the \`{{modeName}}\` mode is effectively active. This is an opt-in boundary: ordinary presets default off; DW roles default on, but explicit off wins and retains only persona/access. Never force common workflow or skills on merely from a role name.
\`workflow.policy=risk-based\` follows the source workflow below. Explicit \`workflow.policy=legacy\` retains the configured \`strictGates\`, \`reviewCap\` and \`finalReviewPolicy\` gates; it is compatibility policy, not extra authorization. Role scope, output and terminal delegation policy are authoritative over all workflow/model guidance.
Skills are native metadata and lazy bodies, never automatically injected. Load matching skills only through the actual native skill catalog. Treat \`[dsmm safety]\` messages as binding feedback. Implementing does not authorize a commit; a commit does not authorize push/tag/rebase/release.
</dsmm-deepwork-mode>`;

export const BASE_DEEPWORK_PROMPT = [activation, asset("deepwork/default.md"), asset("shared/shell-safety.md"), asset("shared/dsh-host-contract.md")].join("\n\n---\n\n");

// Prompt-only matching follows src/intent/model-family.ts, not model routing.
function modelName(fullId: string): string {
  const name = fullId.slice(fullId.lastIndexOf("/") + 1).toLowerCase();
  const vendors: Record<string, RegExp> = { openai: /^(?:gpt-|o\d|chatgpt-|codex-)/u, anthropic: /^claude-/u, google: /^gemini-/u, zhipu: /^glm-/u, deepseek: /^deepseek-/u };
  const parts = name.split("."), direct = parts.slice(1).join("."), regional = parts.slice(2).join(".");
  if (vendors[parts[0]]?.test(direct)) return direct;
  if (/^(?:[a-z]{2}|[a-z]{2}-[a-z]+-\d+)$/u.test(parts[0]) && vendors[parts[1]]?.test(regional)) return regional;
  return name;
}

export function promptModelVariants(role: string | undefined, model: string): string[] {
  const name = modelName(model);
  const gpt = name.includes("gpt") || model.toLowerCase().includes("codex");
  const opus = /^claude-opus-5(?:[-.]5)?(?:$|[-.](?:20\d{6}(?:[-.][a-z0-9]+)*|[a-z][a-z0-9-]*))$/iu.test(name.replace(/^global\.anthropic\./iu, "").replace(/@default$/iu, ""));
  const kimi = ["kimi-for-coding", "kimi-for-coding-highspeed"].includes(name) || /^(?:kimi-k2[.-]?[78]|k2[-.]?p[78])(?:$|[-_.])/u.test(name);
  const additive = gpt ? ["gpt"] : kimi ? ["kimi-k27"] : /^swe-2(?:[-.]|$)/u.test(name) ? ["swe-2"] : [];
  const base = role === "planner" ? "planner" : role === "orchestrator" && opus ? "claude-opus-5"
    : model.toLowerCase().includes("codex") ? "codex" : gpt ? "gpt" : name.startsWith("gemini-") ? "gemini" : name.includes("glm") ? "glm" : "default";
  return [...new Set([base, ...additive])].filter((variant) => variant !== "default");
}

export function roleModelCalibration(role: SourceRoleContent | undefined, model: string): string {
  const variants = promptModelVariants(role?.sourceId, model);
  const layers = variants.map((variant) => asset(`deepwork/${variant}.md`));
  if (role?.kind === "category" && role.promptArtifact !== null) {
    const category = splitCategory(asset(role.promptArtifact.replace("prompts/source/", "")));
    const name = modelName(model);
    const family = model.toLowerCase().includes("codex") || name.includes("gpt") ? "gpt" : name.startsWith("gemini-") ? "gemini" : name.includes("glm") ? "glm" : name.includes("claude") ? "claude" : "unknown";
    // Categories carry only their own family layer + additive model calibration,
    // not the base-agent Gemini/GLM/planner workflow variants.
    return [category.calibrations.get(family), ...layers.filter((_layer, index) => ["gpt", "kimi-k27", "swe-2"].includes(variants[index]))].filter(Boolean).join("\n\n---\n\n");
  }
  return layers.join("\n\n---\n\n");
}

export interface DeepworkPromptOptions {
  route?: Pick<DshLlmCallConfig, "provider" | "model">;
  selectedPreset?: string;
  /** Existing effective-role resolver supplies content identity, not route authority. */
  roleId?: string | null;
  overrideSection?: string;
}

/** Host observations for this exact admitted Agent, not editor drafts or preset metadata. */
export interface DsmmPromptObservation {
  scope: "root" | "child";
  delegation: readonly DsmmCallableEntry[];
  /** Already policy-filtered native schemas, including controls that really are callable. */
  tools: readonly ToolSchema[];
  roleAvailability?: readonly DsmmRoleAvailabilityState[];
  invocation?: { view: Readonly<DsmmInvocationView>; routeKind: "initial" | "actual" };
  runtimeAdmission?: Readonly<SubagentRuntimeAdmissionView>;
  capabilities?: {
    continuable?: boolean;
    /** Existing exact live child delivery; never a cold-recovery claim. */
    nativeChildDelivery?: boolean;
    nativeBrowserPrompt?: { surface: string };
  };
}

const localeNames: Record<DsmmLocale, string> = {
  en: "English", "zh-Hans": "Simplified Chinese", "zh-Hant": "Traditional Chinese", ja: "Japanese", ko: "Korean",
  de: "German", fr: "French", es: "Spanish", "pt-BR": "Brazilian Portuguese", ru: "Russian"
};

export function buildDsmmLocaleGuidance(settings: Pick<DsmmSettings, "locale">): string {
  return `<dsmm-visible-output-language>
${JSON.stringify({ capturedLocale: settings.locale ?? null, visibleOutputLanguage: settings.locale === undefined ? null : localeNames[settings.locale] })}
${settings.locale === undefined ? "No DSMM locale is captured; inherit applicable host/user language guidance, otherwise use the current request and conversation context." : `This Agent's immutable captured locale is ${settings.locale} (${localeNames[settings.locale]}). Use it as the default for visible replies, plans and role/category output.`}
The current user's explicit output-language request takes precedence. Preserve that instruction in child assignments. A parent's later profile change does not rewrite this child's captured preference. Preserve code, identifiers, commands, paths, protocol fields and exact quotations verbatim. This affects visible output only: it neither promises an internal reasoning language nor changes the host UI/project locale. Do not infer configuration or authority with natural-language matching.
</dsmm-visible-output-language>`;
}

function toolProperties(tool: ToolSchema): Record<string, Record<string, unknown>> {
  return (tool.parameters.properties ?? {}) as Record<string, Record<string, unknown>>;
}

// Output projection must not serialize credentials/extra properties on structurally compatible DTOs.
function projectInvocation({ routeKind, view }: NonNullable<DsmmPromptObservation["invocation"]>) {
  return { routeKind, view: {
    role: view.role, label: view.label, level: view.level, routeSource: view.routeSource, mode: view.mode,
    ...(view.route === undefined ? {} : { route: { provider: view.route.provider, model: view.route.model,
      ...(view.route.reasoningEffort === undefined ? {} : { reasoningEffort: view.route.reasoningEffort }) } }),
    ...(view.runId === undefined ? {} : { runId: view.runId }), ...(view.childId === undefined ? {} : { childId: view.childId }),
    ...(view.jobId === undefined ? {} : { jobId: view.jobId })
  } };
}

/** Register independently of the common-mode section, in the exact Agent scope. */
export function buildDsmmAgentGuidance(settings: DsmmSettings, observed: DsmmPromptObservation): string {
  const availability = new Map(observed.roleAvailability?.map(row => [row.id, row]));
  const delegation = observed.delegation.flatMap(entry => {
    const tool = observed.tools.find(tool => tool.name === entry.name);
    if (tool === undefined) return [];
    const properties = toolProperties(tool);
    const targetEnum = entry.targetParameter === undefined ? undefined : properties[entry.targetParameter]?.enum;
    const targets = entry.targets.filter(id => (!availability.has(id) || availability.get(id)!.admitted)
      && (entry.targetParameter === undefined || Array.isArray(targetEnum) && targetEnum.includes(id)));
    if (targets.length === 0) return [];
    const levelEnum = properties.level?.enum;
    return [{ tool: entry.name, kind: entry.kind, ...(entry.targetParameter === undefined ? {} : { targetParameter: entry.targetParameter }),
      targets: targets.map(id => ({ id, ...(properties.level === undefined ? {} : { levels: (["normal", "low", "high", "max"] as const)
        .filter(level => Array.isArray(levelEnum) && levelEnum.includes(level) && (level === "normal" || settings.roleRouting[id]?.levels?.[level] !== undefined)) }) })),
      parameters: Object.keys(properties).filter(name => (name !== "route" || settings.subagents.allowRouteOverride)
        && (name !== "run_in_background" || settings.subagents.enableRunInBackground)),
      routeOverride: settings.subagents.allowRouteOverride && properties.route !== undefined,
      background: settings.subagents.enableRunInBackground && properties.run_in_background !== undefined }];
  });
  const controls = observed.tools.filter(tool => ["send_message", "interrupt_agent", "job_output", "job_list", "job_kill", "dsmm_children"].includes(tool.name));
  const runtime = observed.runtimeAdmission === undefined ? undefined : {
    binding: observed.runtimeAdmission.binding, deliveryFenceReady: observed.runtimeAdmission.deliveryFenceReady,
    restartRequired: observed.runtimeAdmission.restartRequired,
    ...(observed.runtimeAdmission.reason === undefined ? {} : { reason: observed.runtimeAdmission.reason })
  };
  const ready = runtime?.binding === "stock" && runtime.deliveryFenceReady;
  const liveDelivery = ready && observed.capabilities?.nativeChildDelivery === true;
  const lifecycle = {
    backgroundEnabled: settings.subagents.enableRunInBackground,
    continuable: observed.capabilities?.continuable === true && ready,
    nativeChildDelivery: liveDelivery,
    sendMessage: liveDelivery && controls.some(tool => tool.name === "send_message"),
    childToParentReporting: observed.scope === "child" && controls.some(tool => tool.name === "send_message"),
    browserPromptSurface: liveDelivery ? observed.capabilities?.nativeBrowserPrompt?.surface ?? null : null,
    ...(runtime === undefined ? {} : { runtimeAdmission: runtime })
  };
  const sections = [buildDsmmLocaleGuidance(settings), `<dsmm-admitted-delegation>
${JSON.stringify({ scope: observed.scope, topology: settings.subagents.toolTopology, delegation,
    controls: controls.map(tool => ({ tool: tool.name, parameters: Object.keys(toolProperties(tool)) })),
    ...(observed.roleAvailability === undefined ? {} : { roleAvailability: observed.roleAvailability.map(row => ({ id: row.id, admitted: row.admitted, ...(row.reason === undefined ? {} : { reason: row.reason }) })) }) }, null, 2)}
</dsmm-admitted-delegation>
Only the listed callable entries and target enums are observed here. Role availability alone is not tool availability. Inspect their native schemas; do not invent suffix roles, fields or tools. Omitted level and normal retain the default route; low/high/max are selectable only for the listed configured target levels, not workflow rigor or a fixed reasoning effort. Each level is a complete provider/model selection or an effort-only override with exact native preflight. Route override is deployment opt-in and additionally requires an exposed route parameter: provider/model must be paired; changing models discards the previous effort; effort-only uses the selected model's exact supported effort. An explicit complete invocation route does not silently use role fallback. Reusing a child does not reselect its role, level or route. Layout/level never enlarge target, read-only, inherited tool, ownership or depth authority. The ordinary root native model picker remains authoritative. Missing required planning/review capability returns to the stage owner, not a bypass.
`];
  if (observed.invocation !== undefined) sections.push(`<dsmm-observed-invocation>\n${JSON.stringify(projectInvocation(observed.invocation), null, 2)}\n</dsmm-observed-invocation>\nThe routeKind labels this observation: initial is preflighted start, not a claim about the current fallback route; actual is supplied by observed native request/status. Level is resource selection, never added permissions or a smaller verification obligation.`);
  sections.push(`<dsmm-child-lifecycle>
<dsmm-child-lifecycle-state>\n${JSON.stringify(lifecycle, null, 2)}\n</dsmm-child-lifecycle-state>
${settings.subagents.enableRunInBackground ? "Background is enabled in this Agent's captured deployment policy; only tools that expose run_in_background may request it." : "Background is disabled in this Agent's captured policy; do not request it."}
Role calls wait for the native activation result by default. Explicit run_in_background:true chooses native parent delivery before starting and returns accepted child/message identity, not a completion or a job handle. Running calls cannot transfer foreground/background ownership. Partial output with a non-completed stop reason is not success and must not be replayed automatically.
${lifecycle.sendMessage ? "Exposed send_message can address a permitted exact live adjacent child. Running delivery reaches the nearest step; an idle live child can accept a next turn. Cold DSMM recovery is unavailable. An inbox receipt means accepted, not executed/completed. Each child retains its immutable admission; messages, metadata and later profile saves cannot grant authority." : "No live child messaging tool is observed here; do not invent one or infer it from role metadata."}
${lifecycle.browserPromptSurface !== null ? `The actual native user surface ${lifecycle.browserPromptSurface} uses queue/steer for continuable children, with native attachment validation. Its operator/connection/session/epoch/lifetime gate precedes inbox acceptance. Do not impersonate an Agent sender. After acceptance do not automatically retry; an unknown disconnect outcome needs verification, not a guessed idempotency guarantee.` : "No operator-gated native user queue/steer surface is established here; do not announce an unconnected DSMM RPC."}
${controls.some(tool => tool.name === "interrupt_agent") ? "Exposed interrupt_agent requests cancellation, not proof of completion or a message-delivery fence." : "No child interruption tool is observed here."}
${lifecycle.childToParentReporting ? "Native child-to-parent reporting retains exact-sender/adjacency semantics; it does not grant delegation authority." : ""}
Official Registry, SubagentRuntime and JSONL services own execution, result delivery and persistence. DSMM execution guards require a trusted live admission; they do not claim to veto every native inbox acceptance. Owner teardown cancels owned work and surviving Agent guards remain fail-closed. Do not replace native services, recover permissions from logs, or change Host configuration automatically.
Native capacity/depth, provider support, direct-parent ownership, captured permissions and cancellation remain mandatory in every branch. No OpenCode task_id/resume/retry protocol is supplied.
</dsmm-child-lifecycle>`);
  return sections.join("\n\n---\n\n");
}

export function buildDeepworkPrompt(
  settings: DsmmSettings,
  options: DeepworkPromptOptions = {}
): string {
  const role = SOURCE_ROLE_CATALOG.find((role) => role.id === (options.roleId === undefined ? options.selectedPreset : options.roleId));
  const common = role === undefined ? BASE_DEEPWORK_PROMPT : [activation, asset("deepwork/default.md")].join("\n\n---\n\n");
  const family = roleModelCalibration(role, options.route?.model ?? "");
  const base = [options.overrideSection?.trim() || common, family === "" ? "" : `<workflow-model-calibration>\nThe role prompt is authoritative for scope, permissions and output. Model calibration never grants tools or changes the native route.\n\n${family}\n</workflow-model-calibration>`].filter(Boolean).join("\n\n---\n\n").replaceAll("{{modeName}}", settings.modeName);
  const workflowPolicy = settings.workflow.policy === "legacy" ? `<dsmm-workflow-policy>
policy: legacy
strictGates: ${String(settings.workflow.strictGates)}
reviewCap: ${String(settings.workflow.reviewCap)}
finalReviewPolicy: ${settings.workflow.finalReviewPolicy}
</dsmm-workflow-policy>` : `<dsmm-workflow-policy>policy: risk-based</dsmm-workflow-policy>`;
  return `${base}\n\n${workflowPolicy}`;
}
