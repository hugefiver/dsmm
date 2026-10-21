import type { Context } from "@deepseek-ai/cordis";
import * as Native from "@deepseek-ai/dsh-tool-bash";
import type {} from "./permission-controller.js";

export { Config, name } from "@deepseek-ai/dsh-tool-bash";
export const inject = [...Native.inject, "dsmmPermissionController"];
export function apply(ctx: Context, config: Native.Config): void {
  Native.apply(ctx.dsmmPermissionController.shellScope(ctx, "bash"), config);
}
