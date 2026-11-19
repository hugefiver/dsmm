import type { Context } from "@deepseek-ai/cordis";
import type {} from "./lsp.js";

export const name = "dsmm-lsp";
export const inject = ["dsmmLspEntry", "tools"] as const;

export async function apply(ctx: Context): Promise<void> {
  await ctx.dsmmLspEntry(ctx);
}
