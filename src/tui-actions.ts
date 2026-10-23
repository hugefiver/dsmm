import type { DshCommandInvocation, DshCommandResult } from "./dsh-types.js";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { createDsmmStatusSnapshot, formatDsmmStatus } from "./status.js";
import { handleDsmmStatusCommand, parseDeepworkCommandInput } from "./commands.js";
import type { DsmmCommandDefinition } from "./commands.js";
import type { DsmmSettingsGetter, DsmmPluginConfig } from "./settings.js";
import type { DeepworkModeController } from "./state.js";
import type { DsmmProfileRuntime } from "./profile-runtime.js";
import type { DsmmDeploymentConfig, DeploymentPathEdit } from "./deployment-config.js";
import type { ProfileSnapshot, ProfileSummary } from "./profile-types.js";
import type { BeginDsmmTuiAction, DsmmTuiActionAuthority, TuiDialogOption } from "./tui-types.js";

export const DSMM_TUI_COMPONENT_ID = "com.hugefiver.dsmm";
export const DSMM_TUI_CONTRIBUTIONS = Object.freeze({
  manage: `${DSMM_TUI_COMPONENT_ID}.manage`
});

const DIALOG_TIMEOUT_MS = 30_000;
const INHERIT = "inherit";

export interface DsmmTuiActionDependencies {
  controller: DeepworkModeController;
  getSettings: DsmmSettingsGetter;
  profiles: DsmmProfileRuntime;
  deployment: DsmmDeploymentConfig;
  begin: BeginDsmmTuiAction;
}

interface GlobalField {
  id: string;
  label: string;
  path: readonly string[];
  values: readonly { id: string; label: string; value?: unknown }[];
  restart?: boolean;
}

const BOOLEAN_VALUES = Object.freeze([
  { id: INHERIT, label: "Inherit" },
  { id: "true", label: "Enabled", value: true },
  { id: "false", label: "Disabled", value: false }
]);

const GLOBAL_FIELDS: readonly GlobalField[] = Object.freeze([
  { id: "root-model-policy", label: "Root model policy", path: ["rootModelPolicy"], values: [
    { id: INHERIT, label: "Inherit" }, { id: "native", label: "Native", value: "native" }, { id: "configured", label: "Configured", value: "configured" }
  ] },
  { id: "default-active", label: "Deepwork default", path: ["defaultActive"], values: BOOLEAN_VALUES },
  { id: "locale", label: "Locale", path: ["locale"], values: [
    { id: INHERIT, label: "Inherit" }, ...["en", "zh-Hans", "zh-Hant", "ja", "ko", "de", "fr", "es", "pt-BR", "ru"].map(value => ({ id: value, label: value, value }))
  ] },
  { id: "workflow-policy", label: "Workflow policy", path: ["workflow", "policy"], values: [
    { id: INHERIT, label: "Inherit" }, { id: "risk-based", label: "Risk based", value: "risk-based" }, { id: "legacy", label: "Legacy", value: "legacy" }
  ] },
  { id: "tool-topology", label: "Subagent tool topology", path: ["subagents", "toolTopology"], values: [
    { id: INHERIT, label: "Inherit" }, { id: "per-role", label: "Per role", value: "per-role" }, { id: "parameterized", label: "Parameterized", value: "parameterized" }
  ] },
  { id: "deepwork-module", label: "Deepwork module", path: ["modules", "deepwork", "enabled"], values: BOOLEAN_VALUES, restart: true }
]);

async function handleManagedDeepwork(deps: DsmmTuiActionDependencies, invocation: DshCommandInvocation, authority: DsmmTuiActionAuthority): Promise<DshCommandResult> {
  let committed = false;
  try {
    const parsed = parseDeepworkCommandInput(invocation.rawInput);
    const settings = deps.getSettings(invocation.agent);
    if (parsed.action === "on" && deps.getSettings.subagentRuntime !== undefined && !deps.getSettings.subagentRuntime().deliveryFenceReady) {
      return error("Deepwork runtime is unavailable; check native runtime settings and restart status.");
    }
    if (parsed.action === "on" && !settings.modules.deepwork.enabled) {
      return error("Deepwork module is not admitted in this session; mode cannot enable it.");
    }
    const expectedModeRevision = deps.controller.describe(invocation.agent, settings.defaultActive).revision;
    const target = sessionIdentity(invocation);
    const action = parsed.action === "on" ? "enable" : "disable";
    const detail = parsed.message === "" ? "" : ` and steer one message (${bounded(parsed.message, 120)})`;
    const confirmed = await authority.confirm("Confirm Deepwork action", `${action} Deepwork for session ${target}${detail}; mode revision ${expectedModeRevision}.`, action === "enable" ? "Enable" : "Disable");
    if (confirmed !== true) return error("Deepwork action cancelled; no change was started.");
    authority.assertCurrent();
    if (deps.controller.describe(invocation.agent, settings.defaultActive).revision !== expectedModeRevision) {
      return error("Deepwork mode changed; run the command again to confirm the current revision.");
    }
    let committedRevision: string | undefined;
    const outcome = await deps.controller.select(invocation.agent, parsed.action === "on", settings.defaultActive,
      () => authority.assertCurrent(), revision => { committed = true; committedRevision = revision; });
    committed ||= outcome === "committed";
    if (parsed.action === "on" && parsed.message !== "") {
      try {
        authority.assertCurrent();
        const steerRevision = committed ? committedRevision : expectedModeRevision;
        if (steerRevision === undefined || deps.controller.describe(invocation.agent, settings.defaultActive).revision !== steerRevision) {
          return committed
            ? success("Deepwork mode was committed, but the mode changed before the requested steer; no automatic retry was attempted.")
            : error("Deepwork mode changed before the requested steer; run the command again.");
        }
        await invocation.agent.steer?.(createUserMessage({ content: [{ type: "text", text: parsed.message }], source: { kind: "user" } }));
      } catch {
        return committed
          ? success("Deepwork mode was committed, but the requested steer was not confirmed; no automatic retry was attempted.")
          : error("The steer was refused before any confirmed mode change.");
      }
    }
    return parsed.action === "on" ? success("Entering deepwork mode.") : success("Leaving deepwork mode.");
  } catch (cause) {
    return committed
      ? success("Deepwork mode was committed, but the remaining action did not complete; no automatic retry was attempted.")
      : actionError(cause);
  }
}

export function createDsmmManagementCommandDefinition(deps: DsmmTuiActionDependencies): DsmmCommandDefinition {
  return {
    name: "dsmm",
    description: "Manage DSMM status, Deepwork and simple configuration",
    input: { hint: "[status [json]|deepwork [off|message]|config|profiles]" },
    handler: invocation => handleManagement(deps, invocation)
  };
}

async function handleManagement(deps: DsmmTuiActionDependencies, invocation: DshCommandInvocation): Promise<DshCommandResult> {
  const input = invocation.rawInput.trim();
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(input);
  const subcommand = match?.[1] ?? "";
  const argument = match?.[2] ?? "";
  if (!["", "status", "deepwork", "config", "profiles"].includes(subcommand)
    || (subcommand === "status" && argument !== "" && argument !== "json")
    || (["config", "profiles"].includes(subcommand) && argument !== "")) {
    return error("Usage: /dsmm [status [json]|deepwork [off|message]|config|profiles]");
  }
  let authority: DsmmTuiActionAuthority | undefined;
  try {
    authority = deps.begin(invocation, DSMM_TUI_CONTRIBUTIONS.manage, subcommand !== "status");
    let action = subcommand;
    if (action === "") {
      const selected = await authority.select("DSMM", [
        { id: "status", label: "Status", description: "Show desired and admitted state" },
        { id: "deepwork", label: "Deepwork", description: "Enable Deepwork for this session" },
        { id: "config", label: "Global configuration", description: "Edit a limited shared scalar" },
        { id: "profiles", label: "Named profiles", description: "Browse or select an existing profile" }
      ]);
      if (selected === undefined) return error("DSMM menu cancelled.");
      action = selected;
    }
    authority.assertCurrent();
    if (action === "status") {
      if (argument === "json") return handleDsmmStatusCommand(deps.controller, deps.getSettings, { ...invocation, rawInput: "json" });
      return await managementStatus(deps, invocation, authority);
    }
    if (action === "deepwork") return await handleManagedDeepwork(deps, { ...invocation, rawInput: argument }, authority);
    if (action === "config") return await manageGlobal(deps, authority);
    if (action === "profiles") return await manageProfiles(deps, invocation, authority);
    return error("The selected DSMM action is not available.");
  } catch (cause) {
    return actionError(cause);
  } finally {
    authority?.close();
  }
}

async function managementStatus(deps: DsmmTuiActionDependencies, invocation: DshCommandInvocation, authority: DsmmTuiActionAuthority): Promise<DshCommandResult> {
  const settings = deps.getSettings(invocation.agent);
  const admission = deps.getSettings.admission?.(invocation.agent);
  const snapshot = createDsmmStatusSnapshot({ agent: invocation.agent, settings, admission,
    modules: deps.getSettings.moduleStates?.(invocation.agent), modeActive: deps.controller.active(invocation.agent, settings.defaultActive) });
  const desired = await deps.deployment.readDesired();
  authority.assertCurrent();
  return success([
    formatDsmmStatus(snapshot),
    "",
    "Desired deployment (future admission)",
    `Root model policy: ${desired.settings.rootModelPolicy}`,
    `Default active: ${desired.settings.defaultActive}`,
    `Locale: ${desired.settings.locale ?? "inherit"}`,
    `Workflow policy: ${desired.settings.workflow.policy}`,
    `Tool topology: ${desired.settings.subagents.toolTopology}`,
    `Deepwork module desired: ${desired.settings.modules.deepwork.enabled}`,
    `Revisions: global=${desired.globalRevision}; native=${desired.nativeRevision}`
  ].join("\n"));
}

async function manageGlobal(deps: DsmmTuiActionDependencies, authority: DsmmTuiActionAuthority): Promise<DshCommandResult> {
  const snapshot = await deps.deployment.readGlobal();
  authority.assertCurrent();
  const fieldId = await authority.select("Global DSMM field", GLOBAL_FIELDS.map(field => ({ id: field.id, label: field.label,
    description: `${displayValue(getPath(snapshot.config, field.path))}${field.restart ? "; restart may be required" : ""}` })));
  if (fieldId === undefined) return error("Global configuration action cancelled.");
  const field = GLOBAL_FIELDS.find(candidate => candidate.id === fieldId);
  if (field === undefined) return error("The selected Global field is no longer available.");
  authority.assertCurrent();
  const valueId = await authority.select(`Set ${field.label}`, field.values.map(value => ({ id: value.id, label: value.label })));
  if (valueId === undefined) return error("Global configuration action cancelled.");
  const selected = field.values.find(value => value.id === valueId);
  if (selected === undefined) return error("The selected Global value is no longer available.");
  authority.assertCurrent();
  const before = displayValue(getPath(snapshot.config, field.path));
  const after = selected.id === INHERIT ? "inherit" : displayValue(selected.value);
  const message = `Change shared Global ${field.path.join(".")} from ${before} to ${after}, requested by session ${authorityIdentity(authority)} at revision ${snapshot.revision}. Existing admissions are unchanged.${field.restart ? " A Host restart may be required." : ""}`;
  if (await authority.confirm("Confirm Global DSMM change", message, "Save") !== true) return error("Global configuration action cancelled; no write was started.");
  authority.assertCurrent();
  const edit: DeploymentPathEdit = selected.id === INHERIT
    ? { op: "unset", path: [...field.path] }
    : { op: "set", path: [...field.path], value: selected.value };
  const saved = await deps.deployment.saveGlobal({ expectedRevision: snapshot.revision, edits: [edit] }, () => authority.assertCurrent());
  return success(`Saved Global ${field.path.join(".")}=${after}; desired revision is ${saved.revision}.${saved.refreshRequired ? " Refresh is required before another edit." : ""}`);
}

async function manageProfiles(deps: DsmmTuiActionDependencies, invocation: DshCommandInvocation, authority: DsmmTuiActionAuthority): Promise<DshCommandResult> {
  const operation = await authority.select("Named profiles", [
    { id: "browse", label: "Browse", description: "Show saved profile IDs, diagnostics and revisions" },
    { id: "future", label: "Select future default", description: "Set or clear the default for new sessions" },
    { id: "session", label: "Apply to current session", description: "Pin a profile or the deployment baseline" }
  ]);
  if (operation === undefined) return error("Named profile action cancelled.");
  authority.assertCurrent();
  const inventory = await deps.profiles.describe();
  authority.assertCurrent();
  if (operation === "browse") return success(formatProfileInventory(inventory));
  const target = await chooseProfile(authority, inventory);
  if (target === undefined) return error("Named profile action cancelled.");
  authority.assertCurrent();
  const id = target === null ? null : target.id;
  const revision = target === null ? undefined : target.revision ?? undefined;
  if (target !== null && revision === undefined) return error("The selected profile has no valid revision and cannot be applied.");
  if (operation === "future") {
    const message = `Change the future Global named-profile default to ${id ?? "deployment baseline"}, requested by session ${authorityIdentity(authority)}; selection revision ${inventory.selectionRevision}${revision === undefined ? "" : `; profile revision ${revision}`}. Current sessions are unchanged.`;
    if (await authority.confirm("Confirm future profile default", message, "Select") !== true) return error("Named profile action cancelled; no selection was started.");
    authority.assertCurrent();
    const selected = await deps.profiles.select({ id, expectedSelectionRevision: inventory.selectionRevision,
      ...(revision === undefined ? {} : { expectedRevision: revision }) }, () => authority.assertCurrent());
    return success(`Future named-profile default is ${selected.selectedId ?? "deployment baseline"}; current sessions were not changed.${selected.refreshRequired ? " The commit succeeded, but refresh is required before another profile action." : ""}`);
  }
  const session = await deps.profiles.getSession(invocation.agent);
  authority.assertCurrent();
  const message = `Apply ${id ?? "deployment baseline"} to live root session ${session.sessionId}; admission ${session.admissionEpoch}; selection revision ${session.selection.selectionRevision}${revision === undefined ? "" : `; profile revision ${revision}`}.`;
  if (await authority.confirm("Confirm session profile", message, "Apply") !== true) return error("Session profile action cancelled; no maintenance was started.");
  authority.assertCurrent();
  const selected = await deps.profiles.selectSession({ sessionId: session.sessionId, id,
    expectedSelectionRevision: session.selection.selectionRevision, expectedAdmissionEpoch: session.admissionEpoch,
    ...(revision === undefined ? {} : { expectedRevision: revision }) }, invocation.agent, authority.signal, () => authority.assertCurrent());
  const refreshRequired = selected.refreshRequired === true || selected.selection.refreshRequired === true;
  return success(`Session ${selected.sessionId} now admits ${selected.admittedSelection?.selectedId ?? "deployment baseline"}; admission epoch ${selected.admissionEpoch}.${refreshRequired ? " The commit succeeded, but refresh is required before another profile action." : ""}`);
}

async function chooseProfile(authority: DsmmTuiActionAuthority, inventory: ProfileSnapshot): Promise<ProfileSummary | null | undefined> {
  const available = inventory.profiles.filter(profile => profile.error === undefined && typeof profile.revision === "string");
  const pageSize = 96;
  let page = 0;
  while (true) {
    const start = page * pageSize;
    const rows = available.slice(start, start + pageSize);
    const options: TuiDialogOption[] = [
      { id: "baseline", label: "Deployment baseline", description: "Clear the named-profile selection" },
      ...rows.map((profile, index) => ({ id: `profile:${start + index}`, label: bounded(profile.label?.trim() || profile.id, 120), description: `${profile.id}; revision ${profile.revision}` })),
      ...(page > 0 ? [{ id: "previous", label: "Previous page" }] : []),
      ...(start + pageSize < available.length ? [{ id: "next", label: "Next page" }] : [])
    ];
    const answer = await authority.select("Choose a saved profile", options);
    if (answer === undefined) return undefined;
    authority.assertCurrent();
    if (answer === "baseline") return null;
    if (answer === "previous") { page--; continue; }
    if (answer === "next") { page++; continue; }
    const match = /^profile:(\d+)$/u.exec(answer);
    if (match === null) return undefined;
    const selected = available[Number(match[1])];
    if (selected !== undefined) return selected;
  }
}

function formatProfileInventory(snapshot: ProfileSnapshot): string {
  const rows = snapshot.profiles.map(profile => `${profile.id} | ${bounded(profile.label?.trim() || "unlabelled", 80)} | ${profile.error?.code ?? profile.revision ?? "unavailable"}`);
  return [
    `Future default: ${snapshot.selectedId ?? "deployment baseline"}`,
    `Selection revision: ${snapshot.selectionRevision}`,
    `Store: ${snapshot.origin ?? "unknown"}; ${snapshot.readOnly ? "read-only" : "writable"}`,
    ...(rows.length === 0 ? ["No saved named profiles."] : rows)
  ].join("\n");
}

function getPath(value: DsmmPluginConfig, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

function displayValue(value: unknown): string {
  return value === undefined ? "inherit" : typeof value === "string" || typeof value === "boolean" ? String(value) : "configured";
}

function sessionIdentity(invocation: DshCommandInvocation): string {
  return bounded(invocation.agent.id ?? invocation.agent.session.id ?? "unknown", 80);
}

function authorityIdentity(authority: DsmmTuiActionAuthority): string {
  return bounded(authority.agent.id ?? authority.agent.session.id ?? "unknown", 80);
}

function bounded(value: string, limit: number): string {
  const clean = value.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 1))}…`;
}

function success(text: string): DshCommandResult { return { kind: "success", text }; }
function error(text: string): DshCommandResult { return { kind: "error", text }; }
function actionError(cause: unknown): DshCommandResult {
  if (cause instanceof Error && cause.name === "AbortError") return error("DSMM action cancelled; no new write was started.");
  return error(cause instanceof Error ? bounded(cause.message, 400) : "The Host refused the DSMM action.");
}

export { DIALOG_TIMEOUT_MS };
