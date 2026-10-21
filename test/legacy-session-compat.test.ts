import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { nativeRoutingFixture, runFixtureTurn } from "./native-routing-fixture.ts";

function readPersistedLog(sessionsRoot: string): string {
  // Any persisted session log under the fixture's native sessions root.
  const read = (directory: string): string => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        const nested = read(path);
        if (nested !== "") return nested;
      } else if (entry.endsWith(".jsonl")) {
        return readFileSync(path, "utf8");
      }
    }
    return "";
  };
  const log = read(sessionsRoot);
  assert.notEqual(log, "", "the persisted session log must remain on disk");
  return log;
}

test("sessions written by earlier releases stay readable and refuse stale execution cleanly", async () => {
  const f = await nativeRoutingFixture({ defaultActive: true }, { nativePresets: true, persistence: true });
  try {
    // What a 0.3.x release wrote: a Deepwork root under the dispatcher composition.
    const legacy = await f.create({ agentPreset: "dsmm-orchestrator" });
    await runFixtureTurn(legacy);
    const sessionId = legacy.id, agentOptions = legacy.options;
    await f.disposeAgent(legacy);
    await f.ctx.sessionPersistence.flush();
    const log = readPersistedLog(join(f.profileDir, "sessions"));
    assert.match(log, /turn\/start/u, "the earlier release's events remain persisted verbatim");

    // Reopening a persisted DSMM session resumes with a fresh admission built
    // from the current deployment; the history stays readable user intent and
    // the model is never invoked by the resume itself.
    const calls = f.adapter.calls.length;
    const resumedHandle = await f.agents.resume({ resumeSessionId: sessionId, agentOptions,
      async setup(scope) { await f.ctx.agentPresets.mount(scope, "dsmm-orchestrator"); } });
    assert.equal(resumedHandle.agent.id, sessionId, "an earlier release's dispatcher session resumes");
    assert.ok(f.agents.get(sessionId), "the resumed agent is live");
    await resumedHandle.dispose();
    assert.equal(f.adapter.calls.length, calls, "resume itself never invokes the model");
    const reopened = readPersistedLog(join(f.profileDir, "sessions"));
    assert.ok(reopened.startsWith(log), "the earlier release's persisted history is never rewritten");

    // A composition that an earlier release registered but this release does not
    // (an opted-in role root) is refused by the native registry mount itself.
    const second = await f.agents.resume({ resumeSessionId: sessionId, agentOptions,
      async setup(scope) { await f.ctx.agentPresets.mount(scope, "dsmm-planner"); } }).then(() => "RESOLVED", error => error instanceof Error ? error.message : String(error));
    assert.match(second, /not-found|Unknown agent preset/u);
    assert.equal(f.agents.get(sessionId), undefined);
    assert.equal(f.adapter.calls.length, calls);

    // Ordinary non-DSMM history keeps resuming natively under a deployment that
    // does not opt new sessions into Deepwork by default.
    const plain = await nativeRoutingFixture({ defaultActive: false }, { nativePresets: true, persistence: true });
    try {
      const ordinary = await plain.create({ agentPreset: "standard" });
      await runFixtureTurn(ordinary);
      const ordinaryId = ordinary.id, ordinaryOptions = ordinary.options;
      await plain.disposeAgent(ordinary);
      await plain.ctx.sessionPersistence.flush();
      const third = await plain.agents.resume({ resumeSessionId: ordinaryId, agentOptions: ordinaryOptions,
        async setup(scope) { await plain.ctx.agentPresets.mount(scope, "standard"); } }).then(() => "RESOLVED", error => error instanceof Error ? error.message : String(error));
      assert.equal(third, "RESOLVED");
    } finally { await plain.dispose(); }
  } finally { await f.dispose(); }
});
