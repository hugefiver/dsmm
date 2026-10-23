import type { DshCommandInvocation, DshCommandResult, DshContext } from "./dsh-types.js";
import type { DsmmCommandDefinition } from "./commands.js";

export interface TuiPluginHostLike {
  readonly generationId: string;
  readonly grants: {
    allows(pluginCtx: DshContext, permission: string, scope: string): boolean;
    onChange?(pluginCtx: DshContext, listener: () => void): (() => void) | undefined;
  };
  registerCommand(pluginCtx: DshContext, contributionId: string, definition: DsmmCommandDefinition): () => void;
}

export interface TuiDialogOption {
  id: string;
  label: string;
  description?: string;
}

export interface TuiDialogsLike {
  select(request: { title: string; options: readonly TuiDialogOption[]; signal?: AbortSignal; timeoutMs?: number }): Promise<string | undefined>;
  confirm(request: { title: string; message?: string; confirmLabel?: string; cancelLabel?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<boolean>;
  input(request: { title: string; placeholder?: string; initial?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<string | undefined>;
}

export type TuiSettingsFieldWrite = { kind: "set"; value: unknown } | { kind: "clear" };

export interface TuiSettingsFieldOption {
  value: string;
  label: string;
  descriptions?: Record<string, string>;
}

export interface TuiSettingsField {
  path: readonly string[];
  label: string;
  descriptions?: Record<string, string>;
  hint?: string;
  hintDescriptions?: Record<string, string>;
  group?: string;
  kind: "text" | "number" | "boolean" | "select";
  options?: readonly TuiSettingsFieldOption[];
  format?(value: unknown): string;
  parse?(text: string): TuiSettingsFieldWrite | undefined;
}

export interface TuiSettingsSection {
  ns: string;
  title: string;
  descriptions?: Record<string, string>;
  groups?: readonly { id: string; title: string; descriptions?: Record<string, string>; mode?: "inline" | "page" }[];
  fields: readonly TuiSettingsField[];
}

export interface TuiSettingsSectionsLike {
  register(section: TuiSettingsSection): () => void;
}

export interface TuiSettingsLike {
  describe(options?: { redactSecrets?: boolean }): readonly { ns: string; revision: number; value?: unknown; user?: unknown }[];
}

export interface DsmmTuiActionAuthority {
  readonly signal: AbortSignal;
  readonly agent: DshCommandInvocation["agent"];
  assertCurrent(): void;
  select(title: string, options: readonly TuiDialogOption[]): Promise<string | undefined>;
  confirm(title: string, message: string, confirmLabel?: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  close(): void;
}

export type BeginDsmmTuiAction = (
  invocation: DshCommandInvocation,
  contributionId: string,
  requireDialogs: boolean
) => DsmmTuiActionAuthority;

export type DsmmTuiCommandHandler = (invocation: DshCommandInvocation) => DshCommandResult | Promise<DshCommandResult>;
