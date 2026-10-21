import assert from "node:assert/strict";
import { test } from "node:test";
import { remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import { resolvePermissionControl, permissionControlSchema } from "../src/permission-settings.ts";
import { applyPermissionRulesSave, importPermissionRules, operatorPermissionRulesSource, parsePermissionRulesSave, permissionRevision, PermissionRulesRuntimeSync } from "../src/permission-rules.ts";
import { parsePermissionRulesResult } from "../src/permission-remote.ts";
import type { PermissionRuleSnapshot, PermissionRulesBackend } from "../src/permission-rules.ts";
import { permissionFixture } from "./permission-fixture.ts";

const originalToken = "source:initial", savedToken = "源/settings:after-CAS";
const initial = (): PermissionRuleSnapshot => ({ revision: originalToken, policy: resolvePermissionControl() });
const imported = { kind: "user-import" as const, label: "owned explicit configuration" };
const shell = { id: "commit-exact", action: "allow" as const, match: { kind: "shell" as const, executable: "pwsh.exe", command: "git commit -m '中文'", workingDirectory: "owned-workspace" } };

test("permission policy defaults inherit native outside reads and admits explicit coarse web policies", () => {
  const policy = resolvePermissionControl(); assert.equal(policy.outsideReads, "inherit"); assert.equal(policy.enabled, true);
  assert.deepEqual(policy.webFetch, { enabled: true, rule: "inherit" }); assert.deepEqual(policy.rules, []);
  assert.deepEqual(permissionControlSchema({} as never), policy);
  assert.equal(resolvePermissionControl({ outsideReads: "ask", webSearch: { enabled: false } }).webSearch.enabled, false);
  assert.equal(resolvePermissionControl({ enabled: false }).outsideReads, "inherit");
  for (const outsideReads of ["sometimes", true, {}, 1]) assert.throws(() => resolvePermissionControl({ outsideReads } as never));
  assert.ok(Object.isFrozen(policy)); assert.ok(Object.isFrozen(policy.webFetch));
});

test("rule save grammar refuses client operator provenance and executable accessors while retaining Unicode commands", () => {
  const request = parsePermissionRulesSave({ expectedRevision: originalToken, upsert: [shell] });
  assert.equal(request.upsert![0].match.kind, "shell");
  assert.throws(() => parsePermissionRulesSave({ expectedRevision: originalToken, upsert: [{ ...shell, source: { kind: "operator" } }] }));
  assert.throws(() => parsePermissionRulesSave({ expectedRevision: originalToken, changes: { enabled: false } }));
  assert.throws(() => parsePermissionRulesSave({ expectedRevision: originalToken, upsert: [shell], revoke: [shell.id] }));
  let read = false;
  assert.throws(() => parsePermissionRulesSave({ expectedRevision: originalToken, get upsert() { read = true; return [shell]; } })); assert.equal(read, false);
  const rules = importPermissionRules([shell], "manual import", 1); assert.equal(rules[0].source.kind, "user-import");
  assert.throws(() => importPermissionRules([{ ...shell, source: { kind: "operator" } }] as never, "manual import", 1));
});

test("successful CAS revokes before notification and publishes only after acknowledgement", async () => {
  let revoked = 0;
  const sync = new PermissionRulesRuntimeSync(initial(), () => revoked++), old = sync.getPolicy(), signal = sync.signal;
  const ticket = sync.begin(originalToken); assert.equal(revoked, 1); assert.equal(signal.aborted, true); assert.throws(() => sync.getPolicy());
  const saved = { revision: savedToken, policy: applyPermissionRulesSave(old, { expectedRevision: originalToken, changes: { outsideReads: "deny" }, upsert: [shell] }, imported) };
  let release!: () => void; const held = new Promise<void>(yes => { release = yes; });
  const committing = sync.commit(ticket, saved, async snapshot => { assert.equal(snapshot.revision, savedToken); assert.throws(() => sync.getPolicy()); await held; });
  assert.deepEqual(sync.status(), { savedRevision: savedToken, runtimeRevision: originalToken, state: "updating", mounted: true, restartRequired: false });
  assert.throws(() => sync.begin(originalToken)); release(); await committing;
  assert.equal(sync.getPolicy().policy.outsideReads, "deny"); assert.equal(sync.getPolicy().revision, savedToken); assert.equal(sync.signal.aborted, false);
  assert.throws(() => sync.begin(originalToken)); assert.throws(() => applyPermissionRulesSave(saved, { expectedRevision: originalToken, revoke: [shell.id] }, imported));
  const revokedRule = applyPermissionRulesSave(saved, { expectedRevision: savedToken, revoke: [shell.id] }, imported); assert.equal(revokedRule.rules[0].revoked, true); assert.equal(revokedRule.rules[0].revision, 2);
});

test("notification failure remains unsynced, CAS failure rereads storage and old grants cannot revive", async () => {
  let revoked = 0; const sync = new PermissionRulesRuntimeSync(initial(), () => revoked++);
  const old = sync.getPolicy(), first = sync.begin(originalToken), rejected = { revision: savedToken, policy: applyPermissionRulesSave(old, { expectedRevision: originalToken, changes: { outsideReads: "allow" } }, imported) };
  await sync.recover(first, old, async () => {}); assert.equal(sync.getPolicy().policy.outsideReads, "inherit"); assert.equal(revoked, 2);
  await assert.rejects(sync.commit(first, rejected, async () => {}));
  const ticket = sync.begin(originalToken);
  await assert.rejects(sync.commit(ticket, rejected, async () => { throw new Error("owned notify failure"); }));
  assert.deepEqual(sync.status(), { savedRevision: savedToken, runtimeRevision: originalToken, state: "unsynced", mounted: true, restartRequired: false }); assert.throws(() => sync.getPolicy());
  const authoritative = { revision: "a:authoritative-reread", policy: resolvePermissionControl({ outsideReads: "deny" }) };
  await sync.recover(undefined, authoritative, async () => {}); assert.equal(sync.getPolicy().revision, authoritative.revision); assert.equal(sync.getPolicy().policy.outsideReads, "deny"); assert.equal(revoked, 4);
});

test("enabled is startup-pinned but disabling desired never delays dynamic permission revocation", async () => {
  const sync = new PermissionRulesRuntimeSync(initial(), () => {}), ticket = sync.begin(originalToken);
  await sync.commit(ticket, { revision: savedToken, policy: resolvePermissionControl({ enabled: false, outsideReads: "deny" }) }, async () => {});
  assert.equal(sync.status().mounted, true); assert.equal(sync.status().restartRequired, true); assert.equal(sync.getPolicy().policy.outsideReads, "deny");
  const cold = new PermissionRulesRuntimeSync(sync.getPolicy(), () => {}); assert.equal(cold.status().mounted, false);
});

test("late runtime acknowledgement after retirement cannot publish saved policy", async () => {
  const sync = new PermissionRulesRuntimeSync(initial(), () => {}), ticket = sync.begin(originalToken);
  let release!: () => void; const wait = new Promise<void>(yes => { release = yes; });
  const saving = sync.commit(ticket, { revision: savedToken, policy: resolvePermissionControl({ outsideReads: "allow" }) }, () => wait);
  sync.retire(); release(); await assert.rejects(saving); assert.throws(() => sync.getPolicy());
  assert.equal(sync.status().state, "unsynced"); assert.equal(sync.status().runtimeRevision, originalToken);
  let notified = false;
  await assert.rejects(sync.recover(undefined, initial(), async () => { notified = true; }));
  assert.equal(notified, false); assert.equal(sync.signal.aborted, true);
  assert.throws(() => sync.begin(sync.status().savedRevision));
  await assert.rejects(sync.commit(ticket, initial(), async () => { notified = true; }));
  assert.equal(notified, false); assert.throws(() => sync.getPolicy());
});

test("retirement during recovery revocation is terminal and repeated retirement is idempotent", async () => {
  let sync!: PermissionRulesRuntimeSync, retireWhileRevoking = false, revocations = 0, notifications = 0;
  sync = new PermissionRulesRuntimeSync(initial(), () => {
    revocations++;
    if (retireWhileRevoking) { retireWhileRevoking = false; sync.retire(); }
  });
  const ticket = sync.begin(originalToken); retireWhileRevoking = true;
  await assert.rejects(sync.recover(ticket, initial(), async () => { notifications++; }));
  assert.equal(notifications, 0); assert.equal(sync.signal.aborted, true); assert.throws(() => sync.getPolicy());
  const retiredRevocations = revocations; sync.retire(); sync.retire();
  assert.equal(revocations, retiredRevocations);
  await assert.rejects(sync.recover(undefined, initial(), async () => { notifications++; }));
  assert.equal(notifications, 0); assert.equal(sync.status().state, "unsynced");
});

test("source invalidation fences grants but can recover only while its owner remains live", async () => {
  let revoked = 0, notified = 0;
  const sync = new PermissionRulesRuntimeSync(initial(), () => revoked++), originalSignal = sync.signal;
  sync.invalidate();
  assert.equal(originalSignal.aborted, true); assert.equal(sync.status().state, "unsynced");
  assert.throws(() => sync.getPolicy());
  await sync.recover(undefined, { revision: savedToken, policy: resolvePermissionControl({ outsideReads: "deny" }) }, async () => { notified++; });
  assert.equal(sync.getPolicy().policy.outsideReads, "deny"); assert.notEqual(sync.signal, originalSignal);
  sync.retire(); const retiredRevokes = revoked;
  sync.invalidate(); assert.equal(revoked, retiredRevokes);
  await assert.rejects(sync.recover(undefined, initial(), async () => { notified++; }));
  assert.equal(notified, 1); assert.throws(() => sync.getPolicy());
});

test("synchronous invalidation during recovery revocation rejects before notify and permits a fresh authoritative recovery", async () => {
  for (const withTicket of [true, false]) {
    let invalidate = false, notifications = 0;
    const sync = new PermissionRulesRuntimeSync(initial(), () => {
      if (invalidate) { invalidate = false; sync.invalidate(); }
    });
    const ticket = withTicket ? sync.begin(originalToken) : undefined;
    if (!withTicket) sync.invalidate();
    const signal = sync.signal;
    invalidate = true;
    await assert.rejects(sync.recover(ticket, initial(), async () => { notifications++; }), { code: "stale" });
    assert.equal(notifications, 0); assert.equal(sync.status().state, "unsynced");
    assert.equal(signal.aborted, true); assert.throws(() => sync.getPolicy());
    await sync.recover(undefined, { revision: savedToken, policy: resolvePermissionControl({ outsideReads: "deny" }) }, async () => { notifications++; });
    assert.equal(notifications, 1); assert.equal(sync.getPolicy().revision, savedToken);
    assert.equal(sync.getPolicy().policy.outsideReads, "deny"); assert.notEqual(sync.signal, signal);
  }
});

test("recovery revocation cannot notify or clear a reentrant successor generation even when its callback throws", async () => {
  for (const fail of [false, true]) {
    let reenter = false, notifications = 0, successor!: Promise<unknown>, release!: () => void;
    const held = new Promise<void>(yes => { release = yes; });
    const authoritative = { revision: savedToken, policy: resolvePermissionControl({ outsideReads: "deny" }) };
    const sync = new PermissionRulesRuntimeSync(initial(), () => {
      if (!reenter) return;
      reenter = false; sync.invalidate();
      successor = sync.recover(undefined, authoritative, () => held);
      if (fail) throw new Error("owned revoke failure");
    });
    sync.invalidate(); reenter = true;
    try {
      await assert.rejects(sync.recover(undefined, initial(), async () => { notifications++; }));
      assert.equal(notifications, 0); assert.equal(sync.status().state, "updating");
      assert.equal(sync.status().savedRevision, savedToken); assert.throws(() => sync.getPolicy());
    } finally { release(); await successor; }
    assert.equal(sync.getPolicy().revision, savedToken); assert.equal(sync.signal.aborted, false);
  }
});

test("abort listeners may recover a new generation without the interrupted begin clearing it", async () => {
  let successor!: Promise<unknown>, release!: () => void;
  const held = new Promise<void>(yes => { release = yes; });
  const sync = new PermissionRulesRuntimeSync(initial(), () => {}), signal = sync.signal;
  signal.addEventListener("abort", () => {
    sync.invalidate();
    successor = sync.recover(undefined, { revision: savedToken, policy: resolvePermissionControl({ outsideReads: "deny" }) }, () => held);
  }, { once: true });
  try {
    assert.throws(() => sync.begin(originalToken), { code: "stale" });
    assert.equal(sync.status().state, "updating"); assert.throws(() => sync.getPolicy());
  } finally { release(); await successor; }
  assert.equal(sync.getPolicy().revision, savedToken); assert.equal(signal.aborted, true); assert.notEqual(sync.signal, signal);
});

test("late recovery acknowledgement or failure cannot overwrite a newer published generation", async () => {
  for (const fail of [false, true]) {
    let release!: () => void;
    const held = new Promise<void>(yes => { release = yes; });
    const sync = new PermissionRulesRuntimeSync(initial(), () => {});
    sync.invalidate();
    const recovering = sync.recover(undefined, initial(), async () => { await held; if (fail) throw new Error("owned late ACK failure"); });
    const refused = assert.rejects(recovering);
    sync.invalidate();
    await sync.recover(undefined, { revision: savedToken, policy: resolvePermissionControl({ outsideReads: "deny" }) }, async () => {});
    const current = sync.getPolicy(), signal = sync.signal;
    release(); await refused;
    assert.equal(sync.getPolicy(), current); assert.equal(sync.signal, signal); assert.equal(signal.aborted, false);
    assert.equal(sync.status().state, "synced"); assert.equal(current.revision, savedToken);
  }
});

test("central save RPC requires live Root operator, readonly and current CAS and fences previous policy lifetimes", { timeout: 10000 }, async () => {
  let saved = initial(), sync!: PermissionRulesRuntimeSync, writable = true;
  let hold: (() => Promise<void>) | undefined;
  const f = await permissionFixture(2000, { rules(permissions, ctx) {
    ctx.provide("settings", { writable: true }); ctx.provide("webServer", { host: "127.0.0.1" });
    sync = new PermissionRulesRuntimeSync(saved, () => permissions.revokePolicy());
    const backend: PermissionRulesBackend = {
      assertWritable() { if (!writable) throw new Error("owned readonly backend"); },
      async read(authority) { await hold?.(); authority.assertCurrent(); return saved; },
      async save(request, authority) {
        authority.assertCurrent(); const ticket = sync.begin(request.expectedRevision);
        const next = { revision: savedToken, policy: applyPermissionRulesSave(saved, request, operatorPermissionRulesSource(authority)) };
        authority.assertCurrent(); saved = next;
        await sync.commit(ticket, next, async () => {});
        return { snapshot: next, runtime: sync.status() };
      },
    }; return { backend, runtime: sync };
  } });
  const save = (expectedRevision: string) => f.invoke("saveRules", { sessionId: f.root.id, request: { expectedRevision, changes: { outsideReads: "deny" }, upsert: [shell] } });
  try {
    const signal = sync.signal;
    const result = await save(originalToken) as { snapshot: PermissionRuleSnapshot }; assert.equal(result.snapshot.policy.rules[0].source.kind, "operator");
    assert.equal(signal.aborted, true); assert.notEqual(sync.signal, signal);
    await assert.rejects(save(originalToken)); assert.equal(saved.revision, savedToken);
    writable = false; await assert.rejects(save(savedToken)); assert.equal(saved.revision, savedToken); writable = true;
    const other = await f.create(), foreign = f.ctx.connection.createPeer({ principal: { kind: "owner" } });
    const denied = { sessionId: other.id, request: { expectedRevision: savedToken, upsert: [shell] } }, unchanged = saved;
    await assert.rejects(f.invoke("saveRules", denied, foreign), error => {
      const remote = remoteErrorOf(error);
      return remote?.code === "dsmm-permissions/refused" && remote.details.code === "not-owned";
    });
    await assert.rejects(Promise.resolve().then(() => Reflect.apply(f.ctx.typertGateway.invoke, f.ctx.typertGateway,
      [{ namespace: "dsmmPermissions", method: "saveRules", args: denied }])));
    assert.equal(saved, unchanged);
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(yes => { entered = yes; }); const wait = new Promise<void>(yes => { release = yes; });
    hold = () => { entered(); return wait; };
    const previousPeer = f.ctx.connection.browserPeer;
    const raced = save(savedToken); await ready; await f.replaceConnection(); release(); await assert.rejects(raced); assert.equal(saved.revision, savedToken);
    await assert.rejects(f.invoke("saveRules", denied, previousPeer));
    assert.equal(saved, unchanged);
  } finally { await f.dispose(); }
});

test("opaque source token codecs and per-record counters are independent of runtime restart and master identity", () => {
  for (const token of ["源:opaque/version", "z:last", "a:first"]) assert.equal(permissionRevision(token), token);
  for (const token of [0, null, "", "x".repeat(4097), "bad\0token"]) assert.throws(() => parsePermissionRulesSave({ expectedRevision: token, upsert: [shell] }));
  const saved = { revision: savedToken, policy: resolvePermissionControl({ rules: importPermissionRules([shell], "saved import", 42) }) };
  const policy = applyPermissionRulesSave(saved, { expectedRevision: savedToken, upsert: [shell, { id: "other-rule", action: "deny", match: { kind: "webFetch" } }] }, imported);
  assert.deepEqual(policy.rules.map(rule => rule.revision), [43, 1]);
  const restart = new PermissionRulesRuntimeSync({ revision: savedToken, policy }, () => {});
  const result = parsePermissionRulesResult({ snapshot: restart.getPolicy(), runtime: restart.status() });
  assert.equal(result.snapshot.revision, savedToken); assert.equal(result.runtime.runtimeRevision, savedToken); assert.equal(result.snapshot.policy.rules[0].revision, 43);
});

test("no-op CAS with the same source token still revokes its old lifetime and cannot reuse an update ticket", async () => {
  let revoked = 0; const sync = new PermissionRulesRuntimeSync(initial(), () => revoked++), oldSignal = sync.signal;
  const first = sync.begin(originalToken); await sync.commit(first, initial(), async () => {});
  assert.equal(oldSignal.aborted, true); assert.notEqual(sync.signal, oldSignal); assert.equal(revoked, 1); assert.equal(sync.status().runtimeRevision, originalToken);
  const second = sync.begin(originalToken);
  await assert.rejects(sync.commit(first, initial(), async () => {}));
  await sync.recover(second, initial(), async () => {}); assert.equal(revoked, 3); assert.equal(sync.status().state, "synced");
});
