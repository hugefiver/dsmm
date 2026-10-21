import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import dsmmPlugin from "../lib/index.js";
import type { DshContext } from "../lib/dsh-types.js";
import type { DsmmProfileRuntime } from "../lib/profile-runtime.js";
import { ProfileStore } from "../lib/profile-store.js";
import { nativeRoutingFixture } from "./native-routing-fixture.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function verifyPendingNativeStartup(plugin: typeof dsmmPlugin, t: TestContext): Promise<void> {
  const config = { defaultActive: true };
  const f = await nativeRoutingFixture(config, { headless: true });
  let startup: ReturnType<Context["plugin"]> | undefined;
  let settled: Promise<unknown> | undefined;
  const validation = gate(), auditing = gate();
  try {
    await f.ctx.plugin(TypertRegistry).await();
    await f.ctx.plugin(TypertGatewayService, {}).await();
    const runtime = f.ctx.get("dsmmProfileRuntime") as unknown as DsmmProfileRuntime;
    const saved = await runtime.save({ id: "locked-startup", content: '{"version":1,"id":"locked-startup","settings":{"roleRouting":{"dsmm-orchestrator":{"primary":{"provider":"fixture","model":"pinned-startup"}}}}}', expectedRevision: null });
    await runtime.select({ id: saved.id, expectedRevision: saved.revision, expectedSelectionRevision: "absent" });
    const retained = await f.create({ agentPreset: "dsmm-orchestrator" });
    const store = ProfileStore.fromCentral(f.home, f.profileDir, runtime.admission().deployment!.entryId);
    await f.dsmmFiber.dispose();
    assert.equal(f.agents.get(retained.id), retained, "native Agent lifetime is independent of reinstalling DSMM");
    const profileDir = store.profileDir;
    const pointer = await readFile(join(store.stateDir, ".selection.json"));
    const lock = join(profileDir, ".lock");
    const held = "other-owner lock: do not steal\n";
    await writeFile(lock, held, { flag: "wx", mode: 0o600 });
    t.mock.method(ProfileStore.prototype, "loadSelection", async () => {
      auditing.release();
      await validation.promise;
      throw new Error("fixture persisted admission read refusal");
    });
    let tools = 0;
    f.ctx.on("tools/pre-execute", async (_request, next) => { tools++; return next(); });
    f.adapter.streamChunks = async function* (): AsyncIterable<StreamChunk> {
      if (f.adapter.calls.length === 1) {
        yield { type: "block-end", index: 0, block: { type: "tool-call", id: ToolCallId("startup-read-probe"), name: "read", arguments: "{}" } };
        yield { type: "finish", reason: { kind: "tool-calls" } };
      } else {
        yield { type: "block-end", index: 0, block: { type: "text", text: "startup gate probe" } };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    };
    const entered = gate();
    startup = f.ctx.plugin({
      name: "dsmm-native-profile-reinstall-admission", inject: [...plugin.inject],
      apply(ready: Context) {
        const initialization = plugin.apply(ready as unknown as DshContext, config);
        entered.release();
        return initialization;
      },
    });
    settled = startup.await().then(() => undefined, (error: unknown) => error);
    await entered.promise;
    await Promise.race([auditing.promise, settled.then((failure) => {
      throw failure ?? new Error("Native startup settled before reading its persisted admission");
    })]);
    assert.equal(f.ctx.get("dsmmProfileRuntime"), undefined);
    await assert.rejects(f.create({ agentPreset: "dsmm-orchestrator" }));
    assert.equal(f.adapter.calls.length, 0, "pending native profile startup must admit no provider request");
    assert.equal(tools, 0, "pending native profile startup must execute no tools");
    assert.equal(retained.session.snapshotEvents().some((event) => event.type === "request/header" || event.type === "tool/call" || event.type === "tool/result"), false);
    validation.release();
    const failure = await settled;
    assert.ok(failure, "the paused native audit must visibly refuse startup");
    assert.equal(await readFile(lock, "utf8"), held);
    assert.deepEqual(await readFile(join(store.stateDir, ".selection.json")), pointer);
    assert.equal(f.ctx.get("dsmmProfileRuntime"), undefined);
    assert.equal(f.ctx.get("dsmmProfiles"), undefined);
    await assert.rejects(access(join(store.stateDir, ".sessions")), { code: "ENOENT" });
  } finally {
    validation.release();
    await settled;
    await startup?.dispose();
    await f.dispose();
  }
}

test("real native DSMM reinstall with pending admission read refuses fresh-root creation before readiness", async t => {
  await verifyPendingNativeStartup(dsmmPlugin, t);
});
