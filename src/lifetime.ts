import type { Context, Fiber } from "@deepseek-ai/cordis";

/** Revoke synchronously when an owning scope begins unloading, before async cleanup. */
export function scopeLifetime(scope: Context, label: string, revoke: () => void, install: () => void = () => {}): () => void {
  return scope.effect(() => {
    const owners = new Map<Context, Fiber>();
    for (let fiber = scope.fiber; !owners.has(fiber.ctx); fiber = fiber.parent.fiber) owners.set(fiber.ctx, fiber);
    const retired = () => [...owners.values()].some(fiber => fiber.uid === null || fiber.state === 4 || fiber.state === 5);
    const plugin = scope.on("internal/plugin", fiber => { if (owners.has(fiber.ctx) && retired()) revoke(); }, { global: true, prepend: true });
    const status = scope.on("internal/status", fiber => { if (owners.has(fiber.ctx) && retired()) revoke(); }, { global: true, prepend: true });
    if (retired()) { plugin(); status(); revoke(); throw new Error("DSMM owner is retired"); }
    install();
    return () => { plugin(); status(); revoke(); };
  }, label);
}
