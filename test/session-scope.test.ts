import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSelectedAgentPreset } from "../lib/session-scope.js";

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
