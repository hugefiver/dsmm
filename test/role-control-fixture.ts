import { randomUUID } from "node:crypto";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import * as Connection from "@deepseek-ai/dsh-client-connection";
import { nativeFixturePlugin, nativeRoutingFixture } from "./native-routing-fixture.ts";
export { remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
export { ROLE_CONTROL_REMOTE } from "../lib/role-control-remote.js";

export function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
export async function nativeControlFixture() {
  const f = await nativeRoutingFixture({ defaultActive: true, subagents: { enableRunInBackground: true } }, { nativePresets: true });
  const { CredentialProvider } = await nativeFixturePlugin("@deepseek-ai/dsh-credentials", "@deepseek-ai/dsh-client-connection");
  class MemoryCredentials extends CredentialProvider {
    readonly records = new Map<string, unknown>();
    async modifyRecord(key: string, modify: (current: unknown) => Promise<unknown>) {
      const next = await modify(this.records.get(key));
      if (next !== undefined) this.records.set(key, next);
      return this.records.get(key);
    }
  }
  try {
    f.ctx.provide("remoteAccess", { decide() { return { kind: "deny", reason: "policy" }; } });
    await f.ctx.plugin(TypertRegistry).await();
    await f.ctx.plugin(TypertGatewayService, {}).await();
    await f.ctx.plugin(MemoryCredentials).await();
    let connection = f.ctx.plugin(Connection);
    await connection.await();
    const ready = async () => {
      for (const registration of f.ctx.registry.values()) for (const fiber of registration.fibers)
        if ("typert" in fiber.inject || "connection" in fiber.inject) await fiber.await();
    };
    await ready();
    const invoke = (method: string, args: Record<string, unknown>, signal?: AbortSignal) => f.ctx.typertGateway.invoke({
      namespace: "dsmmChildren", method, args, peer: f.ctx.connection.browserPeer, ...(signal === undefined ? {} : { signal }),
    });
    const start = async (parent: Agent, description = "Native control task") => {
      const result = await parent.ctx.tools.execute({ agent: parent, name: "dsmm_category", callId: ToolCallId(randomUUID()),
        arguments: { category: "dsmm-coding", description, prompt: "Return a local answer", run_in_background: true }, signal: new AbortController().signal });
      if (result.isError) throw new Error(JSON.stringify(result));
      const child = f.agents.list().filter(agent => f.agents.isOwnedBy(agent.id, parent)).at(-1);
      if (!child) throw new Error("Native child was not published");
      return child;
    };
    const request = (parent: Agent, childSessionId: string, text: string, delivery: "queue" | "steer" = "queue") => ({
      requestId: randomUUID(), parentSessionId: parent.id, childSessionId, mode: "continuable" as const, delivery,
      content: [{ type: "text" as const, text }],
    });
    return { ...f, invoke, start, request, async replaceConnection() { await connection.dispose(); connection = f.ctx.plugin(Connection); await connection.await(); await ready(); } };
  } catch (error) { await f.dispose(); throw error; }
}
