import type { Context } from "@deepseek-ai/cordis";
import { SettingsForms } from "@deepseek-ai/dsh-settings";
import { permissionConfigEditorFacade } from "./deployment-permission-rules.js";
import type { PermissionConfigEditor } from "./deployment-permission-rules.js";

export const inject = SettingsForms.inject;
function isEditor(value: unknown): value is PermissionConfigEditor {
  return value !== null && typeof value === "object" && "edit" in value && typeof value.edit === "function";
}

/** Ordinary native settings service, with the caller-scoped editor transaction boundary. */
export function apply(ctx: Context): void {
  const editor: unknown = Reflect.get(ctx, "configEditor");
  if (!isEditor(editor)) throw new Error("The native configuration editor is unavailable.");
  new SettingsForms(ctx.extend({ configEditor: permissionConfigEditorFacade(editor) }));
}
