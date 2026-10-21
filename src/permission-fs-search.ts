import type { Context } from "@deepseek-ai/cordis";
import * as Native from "@deepseek-ai/dsh-tool-fs-search";
import { DsmmPermissionController } from "./permission-controller.js";

export { Config, inject, name } from "@deepseek-ai/dsh-tool-fs-search";
export function apply(ctx: Context, config: Native.Config): ReturnType<typeof Native.apply> {
  return Native.apply(DsmmPermissionController.toolScope(ctx, "fs-search"), config);
}
