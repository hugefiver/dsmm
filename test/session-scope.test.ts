import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEffectiveDsmmRole, resolveSelectedAgentPreset } from "../lib/session-scope.js";
import { resolveAdmittedDsmmRole } from "../lib/role-policy.js";
import { resolveConfig } from "../lib/settings.js";
import type { DshAgent } from "../lib/dsh-types.js";

test("session role resolution requires a DSMM preset independently of activation defaults", () => {
  for (const defaultActive of [false, true]) for (const active of [false, true]) {
    const settings = resolveConfig({ defaultActive });
    for (const preset of [undefined, "standard", "custom-native", "dsmm-orchestrator"]) {
      const agent = { session: { header: { agentPreset: preset }, events: [], append() {} } } as DshAgent;
      const expected = preset === "dsmm-orchestrator" ? preset : undefined;
      assert.equal(resolveEffectiveDsmmRole(agent, settings, active), expected);
      assert.equal(resolveAdmittedDsmmRole(agent, settings, active), expected);
    }
    const disabled = { session: { header: { agentPreset: "dsmm-orchestrator" }, events: [], append() {} } } as DshAgent;
    assert.equal(resolveEffectiveDsmmRole(disabled, resolveConfig({ roles: { "dsmm-orchestrator": false } }), active), undefined);
  }
});

test("resolveSelectedAgentPreset uses newest valid event then header fallback", () => {
  const cases = [
    [undefined, undefined],
    [{ events: [], header: { agentPreset: "dsmm-reviewer" }, append() {} }, "dsmm-reviewer"],
    [{ events: [{ type: "agent-preset/selected", data: { agentPreset: "dsmm-reviewer" } }], header: { agentPreset: "standard" }, append() {} }, "dsmm-reviewer"],
    [{ events: [{ type: "agent-preset/selected", data: { agentPreset: "dsmm-reviewer" } }, { type: "agent-preset/selected", data: { agentPreset: "standard" } }], header: { agentPreset: "dsmm-plan-critic" }, append() {} }, "standard"],
    [{ events: [{ type: "agent-preset/selected", data: { agentPreset: "dsmm-reviewer" } }, { type: "agent-preset/selected", data: { agentPreset: 3 } }], header: { agentPreset: "standard" }, append() {} }, "dsmm-reviewer"],
    [{ events: [{ type: "agent-preset/selected", data: null }, { type: "agent-preset/selected", data: { agentPreset: 3 } }], header: { agentPreset: "dsmm-plan-critic" }, append() {} }, "dsmm-plan-critic"]
  ] as const;

  for (const [session, expected] of cases) {
    assert.equal(resolveSelectedAgentPreset(session), expected);
  }
});
