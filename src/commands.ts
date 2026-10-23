import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { DshCommandInvocation, DshCommandResult, DshCommandsRegistry, DshContext } from "./dsh-types.js";
import { DSMM_STATUS_COMMAND } from "./settings.js";
import type { DsmmSettingsGetter } from "./settings.js";
import type { DeepworkModeController } from "./state.js";
import { createDsmmStatusSnapshot, formatDsmmStatus } from "./status.js";

export { DSMM_STATUS_COMMAND };

export interface DeepworkCommandInput {
  action: "on" | "off";
  message: string;
}

export type DsmmCommandDefinition = Parameters<DshCommandsRegistry["register"]>[0];

export function parseDeepworkCommandInput(rawInput: string): DeepworkCommandInput {
  const message = rawInput.trim();
  return message === "off" ? { action: "off", message: "" } : { action: "on", message };
}

async function handleDeepworkCommand(
  controller: DeepworkModeController,
  getSettings: DsmmSettingsGetter,
  invocation: DshCommandInvocation
): Promise<DshCommandResult> {
  const parsed = parseDeepworkCommandInput(invocation.rawInput);
  if (parsed.action === "on" && getSettings.subagentRuntime !== undefined && !getSettings.subagentRuntime().deliveryFenceReady) return { kind: "error", text: "Deepwork runtime is unavailable; check native runtime settings and restart status." };
  if (parsed.action === "on" && !getSettings(invocation.agent).modules.deepwork.enabled) return { kind: "error", text: "Deepwork module is not admitted in this session; mode cannot enable it." };
  await controller.select(invocation.agent, parsed.action === "on", getSettings(invocation.agent).defaultActive);

  if (parsed.action === "on" && parsed.message !== "") {
    await invocation.agent.steer?.(createUserMessage({
      content: [{ type: "text", text: parsed.message }],
      source: { kind: "user" }
    }));
  }

  return parsed.action === "on"
    ? { kind: "success", text: "Entering deepwork mode." }
    : { kind: "success", text: "Leaving deepwork mode." };
}

export function handleDsmmStatusCommand(
  controller: DeepworkModeController,
  getSettings: DsmmSettingsGetter,
  invocation: DshCommandInvocation
): DshCommandResult {
  const input = invocation.rawInput.trim();
  if (input !== "" && input !== "json") return { kind: "error", text: "Usage: /dsmm-status [json]" };

  const settings = getSettings(invocation.agent);
  const snapshot = createDsmmStatusSnapshot({
    agent: invocation.agent,
    settings,
    admission: getSettings.admission?.(invocation.agent),
    modules: getSettings.moduleStates?.(invocation.agent),
    modeActive: controller.active(invocation.agent, settings.defaultActive)
  });
  return {
    kind: "success",
    text: input === "json" ? JSON.stringify(snapshot, null, 2) : formatDsmmStatus(snapshot)
  };
}

export function createDeepworkCommandDefinition(
  controller: DeepworkModeController,
  getSettings: DsmmSettingsGetter,
  handler: DsmmCommandDefinition["handler"] = invocation => handleDeepworkCommand(controller, getSettings, invocation)
): DsmmCommandDefinition {
  return {
    name: getSettings().modeName,
    description: "Enter or leave Deepwork mode",
    input: { hint: "[off|message]" },
    handler
  };
}

export function createDsmmStatusCommandDefinition(
  controller: DeepworkModeController,
  getSettings: DsmmSettingsGetter
): DsmmCommandDefinition {
  return {
    name: DSMM_STATUS_COMMAND,
    description: "Show Deepwork status",
    input: { hint: "[json]" },
    handler: invocation => handleDsmmStatusCommand(controller, getSettings, invocation)
  };
}

function commandDisposer(value: unknown): () => void {
  return typeof value === "function" ? value as () => void : () => {};
}

export function registerDeepworkCommand(
  readyCtx: DshContext,
  controller: DeepworkModeController,
  getSettings: DsmmSettingsGetter
): () => void {
  const commands = readyCtx.get?.<DshCommandsRegistry>("commands") ?? readyCtx.commands;
  return commands === undefined ? () => {} : commandDisposer(commands.register(createDeepworkCommandDefinition(controller, getSettings)));
}

export function registerDsmmStatusCommand(
  readyCtx: DshContext,
  controller: DeepworkModeController,
  getSettings: DsmmSettingsGetter
): () => void {
  const commands = readyCtx.get?.<DshCommandsRegistry>("commands") ?? readyCtx.commands;
  return commands === undefined ? () => {} : commandDisposer(commands.register(createDsmmStatusCommandDefinition(controller, getSettings)));
}
