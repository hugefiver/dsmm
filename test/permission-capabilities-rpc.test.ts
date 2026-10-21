import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionRulesBackend, PermissionRulesSaveResult } from "../src/permission-rules.ts";
import { applyPermissionRulesSave, PermissionRulesRuntimeSync } from "../src/permission-rules.ts";
import { resolvePermissionControl } from "../src/permission-settings.ts";
import { parsePermissionRulesResult } from "../src/permission-remote.ts";
import { permissionFixture } from "./permission-fixture.ts";
import { useIsolatedDshEnvironment } from "./dsh-test-environment.ts";

useIsolatedDshEnvironment();
async function fixture(separateConsumer = false) {
  return permissionFixture(2000, { rules(_permissions, ctx) {
    ctx.provide("settings", { writable: true }); ctx.provide("webServer", { host: "127.0.0.1" });
    const runtime = separateConsumer ? new PermissionRulesRuntimeSync({ revision: "source:initial", policy: resolvePermissionControl() }, () => {}) : ctx.dsmmPermissionController.rules;
    const backend: PermissionRulesBackend = { assertWritable() {}, async read(authority) { authority.assertCurrent(); return runtime.getPolicy(); },
      async save(request, authority) {
        authority.assertCurrent(); const previous = runtime.getPolicy(), ticket = runtime.begin(request.expectedRevision);
        const snapshot = { revision: "saved:next", policy: applyPermissionRulesSave(previous, request, { kind: "user-import", label: "owned RPC fixture" }) };
        await runtime.commit(ticket, snapshot, async () => {}); authority.assertCurrent();
        return { snapshot, runtime: runtime.status() };
      } };
    return { backend, runtime };
  } });
}

test("rules RPC keeps saved/synced state but omits coverage from an unrelated controller consumer", async () => {
  const f = await fixture(true);
  try {
    await f.mountManagedShell();
    const described = parsePermissionRulesResult(await f.invoke("describeRules", { sessionId: f.root.id }));
    assert.equal(described.runtime.mounted, true); assert.equal(described.runtime.state, "synced"); assert.equal(described.capabilities, undefined);
    const saved = parsePermissionRulesResult(await f.invoke("saveRules", { sessionId: f.root.id, request: { expectedRevision: described.snapshot.revision, changes: { outsideReads: "deny" } } }));
    assert.equal(saved.snapshot.policy.outsideReads, "deny"); assert.equal(saved.capabilities, undefined);
  } finally { await f.dispose(); }
});

test("rules describe/save project live exact Root registrations and never infer a same-name replacement", async () => {
  const f = await fixture();
  try {
    const describe = async () => parsePermissionRulesResult(await f.invoke("describeRules", { sessionId: f.root.id }));
    assert.deepEqual((await describe()).capabilities!.tools, []);
    const managed = await f.mountManagedShell();
    const observed = await describe(); assert.ok(observed.capabilities);
    assert.deepEqual(observed.capabilities.tools.map(tool => ({ name: tool.name, kind: tool.kind })), [{ name: "pwsh", kind: "shell" }]);
    const saved = parsePermissionRulesResult(await f.invoke("saveRules", { sessionId: f.root.id, request: { expectedRevision: observed.snapshot.revision, changes: { outsideReads: "ask" } } }));
    assert.equal(saved.capabilities!.runtime.runtimeRevision, saved.snapshot.revision); assert.deepEqual(saved.capabilities!.tools, observed.capabilities.tools);
    const definition = f.runtime.get("pwsh", f.root)!;
    await managed.dispose();
    const remove = f.runtime.register({ ...definition });
    try { assert.deepEqual((await describe()).capabilities!.tools, []); } finally { remove(); }
    f.controller.retire();
    const unavailable = await f.invoke("describeRules", { sessionId: f.root.id }) as PermissionRulesSaveResult;
    assert.equal(unavailable.capabilities, undefined); assert.equal(unavailable.runtime.state, "synced");
  } finally { await f.dispose(); }
});
