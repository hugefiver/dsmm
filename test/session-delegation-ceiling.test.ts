import assert from "node:assert/strict";
import { test } from "node:test";
import { Session, SessionId, SessionLogOffset, appendPluginRecord } from "@deepseek-ai/dsh-session";
import { appendDelegationCeiling, readDelegationCeiling } from "../src/session-metadata.js";
import type { DsmmDelegationCeiling } from "../src/session-metadata.js";

const ceiling: DsmmDelegationCeiling = { version: 1, childId: "child", creatorId: "creator", rootId: "root",
  provider: "dsmm-role-coding", role: "dsmm-coding", level: "normal", profileId: null,
  readOnly: false, allow: ["read", "send_message"], deny: ["write"], targets: ["dsmm-code-search"], maxDepth: 2 };

test("delegation ceilings use only own native plugin records after a fork seed", () => {
  const parent = Session.create(SessionId("creator"));
  appendDelegationCeiling(parent, ceiling);
  const inherited = parent.snapshotEvents();
  const fresh = Session.create(SessionId("fork"));
  const child = Session.create(fresh.id, inherited, { ...fresh.header, origin: "subagent", parentSession: parent.id, isSeeded: true }, SessionLogOffset(inherited.length));
  assert.equal(readDelegationCeiling(child), undefined);
  const own = { ...ceiling, childId: child.id, role: null, level: null, maxDepth: null, allow: null };
  appendDelegationCeiling(child, own);
  assert.deepEqual(readDelegationCeiling(child), own);
  const restored = Session.create(child.id, child.snapshotEvents(), child.header, child.inheritedEventCount);
  assert.deepEqual(readDelegationCeiling(restored), own);
});

test("malformed and conflicting own ceiling records refuse admission", () => {
  const malformed = Session.create(SessionId("malformed"));
  appendPluginRecord(malformed, "plugin:dsmm/delegation-ceiling", { ...ceiling, maxDepth: -1 });
  assert.throws(() => readDelegationCeiling(malformed), { code: "UNAUTHORIZED" });
  const conflict = Session.create(SessionId("conflict"));
  appendDelegationCeiling(conflict, ceiling);
  appendDelegationCeiling(conflict, { ...ceiling, readOnly: true });
  assert.throws(() => readDelegationCeiling(conflict), { code: "UNAUTHORIZED" });
});
