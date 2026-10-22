import assert from "node:assert/strict";
import { test } from "node:test";
import * as Persona from "@deepseek-ai/dsh-persona";
import { buildRoleIdentity } from "../src/prompt-content.ts";
import { DSMM_ROLES } from "../src/roles.ts";
import { nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

const reviewer = DSMM_ROLES.find(role => role.id === "dsmm-reviewer")!;
const reviewerIdentity = buildRoleIdentity(reviewer);
const planner = DSMM_ROLES.find(role => role.id === "dsmm-planner")!;
const plannerIdentity = buildRoleIdentity(planner);
const orchestrator = DSMM_ROLES.find(role => role.id === "dsmm-orchestrator")!;
const orchestratorIdentity = buildRoleIdentity(orchestrator);

for (const nativePersona of [false, true]) {
  test(`admitted reviewer has its own request identity with inherited persona ${nativePersona}`, { timeout: 15000 }, async () => {
    const f = await nativeRoutingFixture({ defaultActive: true });
    try {
      const parent = await f.create({ agentPreset: "dsmm-orchestrator" });
      if (nativePersona) await parent.ctx.plugin(Persona, { prefix: orchestrator.persona }).await();
      await runFixtureTurn(parent);
      const parentRequest = f.adapter.calls.at(-1);
      assert.ok(parentRequest);
      const parentSystem = JSON.stringify(parentRequest.messages.filter(message => message.role === "system"));
      assert.ok(parentSystem.includes(JSON.stringify(orchestrator.persona).slice(1, -1)));
      assert.equal(parentSystem.split(orchestratorIdentity).length - 1, 1, "the parent request must carry exactly one orchestrator identity");
      assert.equal(parentSystem.includes(reviewerIdentity), false);
      assert.equal(parentSystem.includes(plannerIdentity), false);
      const child = await f.createAuxiliary("dsmm-reviewer", undefined, "one-shot", parent);
      const before = f.adapter.calls.length;
      await runFixtureTurn(child);
      assert.equal(f.adapter.calls.length, before + 1);
      const request = f.adapter.calls.at(-1)!;
      const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
      assert.ok(system.includes(JSON.stringify(reviewer.persona).slice(1, -1)), "the first queued child request must carry the complete generated reviewer persona");
      assert.equal(system.split(reviewerIdentity).length - 1, 1, "the child request must carry exactly one reviewer identity");
      assert.equal(system.includes(orchestratorIdentity), false, "a child must not inherit its parent's role identity");
      assert.equal(system.includes(plannerIdentity), false);
      const sibling = await f.createAuxiliary("dsmm-planner", undefined, "one-shot", parent);
      await runFixtureTurn(sibling);
      const siblingSystem = JSON.stringify(f.adapter.calls.at(-1)!.messages.filter(message => message.role === "system"));
      assert.ok(siblingSystem.includes(JSON.stringify(planner.persona).slice(1, -1)));
      assert.equal(siblingSystem.split(plannerIdentity).length - 1, 1, "the sibling request must carry exactly one planner identity");
      assert.equal(siblingSystem.includes(reviewerIdentity), false, "a child's persona must not leak into its sibling");
      assert.equal(siblingSystem.includes(orchestratorIdentity), false);
      await runFixtureTurn(parent);
      const nextParentSystem = JSON.stringify(f.adapter.calls.at(-1)!.messages.filter(message => message.role === "system"));
      assert.ok(nextParentSystem.includes(JSON.stringify(orchestrator.persona).slice(1, -1)));
      assert.equal(nextParentSystem.split(orchestratorIdentity).length - 1, 1, "the next parent request must retain exactly one orchestrator identity");
      assert.equal(nextParentSystem.includes(reviewerIdentity), false);
      assert.equal(nextParentSystem.includes(plannerIdentity), false);
      assert.equal(nextParentSystem.includes(orchestratorIdentity), JSON.stringify(parentRequest.messages).includes(orchestratorIdentity));
    } finally { await f.dispose(); }
  });
}
