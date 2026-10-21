import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import * as JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { appendModeRecord, appendRolePolicyRecord } from "../src/session-metadata.ts";
import { sessionEvents } from "../src/session-scope.ts";
import { isDeepworkActive } from "../src/state.ts";

test("official JSONL preserves model-hidden DSMM plugin records and native messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsmm-native-records-")), writerContext = new Context(), readerContext = new Context();
  try {
    await writerContext.plugin(JsonlSessionPersistence, { root, compression: "none" }).await();
    const session = Session.create(SessionId("dsmm-plugin-records"));
    appendModeRecord(session, true);
    appendRolePolicyRecord(session, { version: 1, role: "dsmm-reviewer", policy: "a".repeat(64) });
    session.append("user/message", createUserMessage({ content: [{ type: "text", text: "preserved native input" }], source: { kind: "user" } }), { surfaceOp: "append" });
    const writer = await writerContext.sessionPersistence.create(session.header);
    try { await writer.append(session.snapshotEvents()); await writer.flush(); } finally { await writer.close(); }
    await readerContext.plugin(JsonlSessionPersistence, { root, compression: "none" }).await();
    const reader = await readerContext.sessionPersistence.open(session.id, "read");
    try {
      const stored = await reader.read();
      assert.equal(stored.events[0]?.ignorable, true);
      assert.equal(stored.events[1]?.ignorable, true);
      const restored = Session.fromRestore(session.id, stored.events, reader.header, reader.inheritedEventCount, stored.eventState);
      assert.equal(isDeepworkActive(sessionEvents(restored)), true);
      assert.deepEqual(restored.deriveMessages(), session.deriveMessages());
      assert.equal(restored.deriveMessages().length, 1);
    } finally { await reader.close(); }
  } finally {
    try { await writerContext.fiber.dispose(); await readerContext.fiber.dispose(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
