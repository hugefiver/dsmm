import assert from "node:assert/strict";
import { test } from "node:test";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { selectInitialModelRoute } from "../lib/role-routing.js";
import { nativeRoutingFixture, RoutingFixtureAdapter, runFixtureTurn } from "./native-routing-fixture.ts";

test("an independent Core locks the complete fallback only for directory-proven provider absence", async t => {
  const primary = { provider: "temporarily-absent", model: "primary" };
  const fallback = { provider: "fixture", model: "backup", reasoningEffort: "low", temperature: 0, maxTokens: 95, stop: ["END"] };
  const config = { defaultActive: true, rootModelPolicy: "configured" as const, permissionControl: { enabled: false },
    roleRouting: { "dsmm-orchestrator": { primary, fallbackRoutes: [fallback] } } };
  const f = await nativeRoutingFixture(config, { compiledCore: true, dsmmLlm: true });
  t.after(() => f.dispose());
  await f.dsmmFiber.dispose();
  await f.mountSuccessorCore(config);
  const root = await f.create({ agentPreset: "dsmm-orchestrator" });
  await runFixtureTurn(root);
  const notReady = new LlmError("Provider initialization is pending", "NO_ADAPTER");
  f.ctx.llm.registerAdapter([primary.provider], new class extends RoutingFixtureAdapter {
    override async resolveModel(): Promise<never> { throw notReady; }
  }());
  await runFixtureTurn(root);
  assert.deepEqual(f.adapter.calls.map(({ provider, model, reasoningEffort, temperature, maxTokens, stop }) =>
    ({ provider, model, reasoningEffort, temperature, maxTokens, stop })), [fallback, fallback]);
  assert.deepEqual(root.session.requestHeader()?.config, fallback);
  await assert.rejects(selectInitialModelRoute(f.ctx.llm, [primary, fallback], undefined, f.ctx.dsmmLlmRoutes), error => error === notReady);
});
