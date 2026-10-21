import type { Context } from "@deepseek-ai/cordis";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { DsmmAwareLlmRuntime } from "./host-llm.js";
import { LivePiAiOwner } from "./live-pi-ai-owner.js";
import { createDsmmRoleLlmOwner } from "./role-llm-runtime.js";
import type { DsmmLlmHostOwner } from "./host-llm.js";

/** The selected profile's sole native LLM registry, installed by cold source migration. */
export class DsmmNativeLlmRuntime extends DsmmAwareLlmRuntime {
  private readonly providerOwner: LivePiAiOwner;
  constructor(ctx: Context) {
    let owner: DsmmLlmHostOwner;
    super(ctx, undefined, { preflight: (frame, proposal) => owner.preflight(frame, proposal) });
    this.providerOwner = new LivePiAiOwner(ctx, this);
    owner = createDsmmRoleLlmOwner(ctx, this.providerOwner);
    ctx.provide("dsmmLlmRoutes", this.providerOwner);
    ctx.inject(["dsmmCoreLlmOwner"], scope => this.bindRequestOwner(scope));
  }
  override registerAdapter(...args: Parameters<LlmRuntime["registerAdapter"]>) {
    const handle = super.registerAdapter(...args);
    return this.providerOwner.register(this.ctx, args[0], args[1], handle);
  }
}
export default DsmmNativeLlmRuntime;
