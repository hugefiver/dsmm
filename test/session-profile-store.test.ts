import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { ProfileStore, MAX_SESSION_PROFILE_CHOICES } from "../lib/profile-store.js";
import type { SessionProfileSelectRequest } from "../lib/profile-types.js";

const epoch = "e".repeat(64);
const body = (active = true) => JSON.stringify({ version: 1, id: "focus", settings: { defaultActive: active } });
const key = (id: string) => createHash("sha256").update(id).digest("hex");
const request = (sessionId: string, revision?: string): SessionProfileSelectRequest => ({ sessionId, id: revision === undefined ? null : "focus", ...(revision === undefined ? {} : { expectedRevision: revision }), expectedSelectionRevision: "absent", expectedAdmissionEpoch: epoch });
const commit = () => ({ assertCurrent() {}, committed() {} });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dsmm-session-store-"));
  const root = join(directory, "dsmm-profiles");
  return { directory, root, store: new ProfileStore(root), path: (id: string) => join(root, ".sessions", `${key(id)}.json`), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("session choices use hashed opaque IDs, independent CAS, exact pins and explicit baseline", async () => {
  const f = fixture();
  try {
    const saved = await f.store.save({ id: "focus", content: body(), expectedRevision: null });
    const global = await f.store.select({ id: "focus", expectedRevision: saved.revision, expectedSelectionRevision: "absent" });
    const globalBytes = readFileSync(join(f.root, ".selection.json"));
    const unusual = "native/opaque:session-id";
    const a = await f.store.selectSession(request(unusual, saved.revision), epoch, () => "prepared", {
      assertCurrent() {}, committed(selection, prepared) {
        assert.equal(prepared, "prepared");
        assert.equal(readFileSync(f.path(unusual), "utf8").includes(selection.admissionEpoch!), true, "publication observes already committed bytes");
      }
    });
    const b = await f.store.selectSession(request("b"), "b".repeat(64), () => null, commit());
    assert.deepEqual(readdirSync(join(f.root, ".sessions")).sort(), [`${key(unusual)}.json`, `${key("b")}.json`].sort());
    assert.equal(readFileSync(join(f.root, ".selection.json")).equals(globalBytes), true);
    assert.equal((await f.store.loadSelection()).selectionRevision, global.selection.selectionRevision);
    assert.equal((await f.store.loadSessionSelection("absent")).admissionEpoch, null);
    assert.equal(b.selection.selectedId, null);
    assert.notEqual(b.selection.selectionRevision, "absent", "baseline is an explicit durable choice, not absence");
    await f.store.save({ id: "focus", content: body(false), expectedRevision: saved.revision });
    unlinkSync(join(f.root, "focus.jsonc"));
    assert.equal((await new ProfileStore(f.root).loadSessionSelection(unusual)).content, saved.content);
    await assert.rejects(f.store.selectSession(request(unusual), epoch, () => null, commit()), { code: "conflict" });
    assert.equal((await f.store.loadSessionSelection(unusual)).selectionRevision, a.selection.selectionRevision);
  } finally { f.cleanup(); }
});

test("async external sidecar/draft edits and final liveness fences never publish late settings", async () => {
  for (const mutation of ["sidecar", "draft", "fence"] as const) {
    const f = fixture(); let publications = 0;
    try {
      const saved = await f.store.save({ id: "focus", content: body(), expectedRevision: null });
      let alive = true;
      await assert.rejects(f.store.selectSession(request("a", saved.revision), epoch, async () => {
        if (mutation === "sidecar") { mkdirSync(join(f.root, ".sessions")); writeFileSync(f.path("a"), JSON.stringify({ version: 1, sessionId: "a", id: null, revision: null, epoch })); }
        if (mutation === "draft") writeFileSync(join(f.root, "focus.jsonc"), body(false));
        if (mutation === "fence") alive = false;
        return "not-published";
      }, { assertCurrent() { if (!alive) throw Object.assign(new Error("native epoch fence"), { code: "conflict" }); }, committed() { publications++; } }));
      assert.equal(publications, 0);
      assert.equal((await f.store.loadSessionSelection("a")).selectedId, null);
      assert.equal(existsSync(f.path("a")), mutation === "sidecar");
      assert.equal(existsSync(join(f.root, ".lock")), false);
    } finally { f.cleanup(); }
  }
});

test("session commit failure retains old sidecar and callback; replaced lock is never stolen", async () => {
  const f = fixture();
  try {
    const initial = await f.store.selectSession(request("a"), epoch, () => null, commit());
    const before = readFileSync(f.path("a"));
    const failing = new ProfileStore(f.root, { rename(source, destination) {
      if (basename(destination) === `${key("a")}.json`) throw new Error("fixture atomic commit failure");
      renameSync(source, destination);
    } });
    let publications = 0;
    await assert.rejects(failing.selectSession({ ...request("a"), expectedSelectionRevision: initial.selection.selectionRevision }, "f".repeat(64), () => null, { assertCurrent() {}, committed() { publications++; } }), { code: "io" });
    assert.equal(publications, 0); assert.equal(readFileSync(f.path("a")).equals(before), true);
    await assert.rejects(f.store.selectSession({ ...request("a"), expectedSelectionRevision: initial.selection.selectionRevision }, "f".repeat(64), async () => {
      renameSync(join(f.root, ".lock"), join(f.root, ".retired-lock"));
      writeFileSync(join(f.root, ".lock"), "foreign-lock");
      return null;
    }, commit()), { code: "conflict" });
    assert.equal(readFileSync(join(f.root, ".lock"), "utf8"), "foreign-lock");
    assert.equal(readFileSync(f.path("a")).equals(before), true);
    assert.equal(readdirSync(join(f.root, ".sessions")).some((name) => name.startsWith(".dsmm-tmp-")), false);
  } finally { f.cleanup(); }
});

test("corrupt session identity, duplicate fields, missing or invalid immutable pins refuse cold loading", async () => {
  const f = fixture();
  try {
    const saved = await f.store.save({ id: "focus", content: body(), expectedRevision: null });
    const selected = await f.store.selectSession(request("a", saved.revision), epoch, () => null, commit());
    const original = readFileSync(f.path("a"), "utf8");
    for (const corrupt of [original.replace('"sessionId":"a"', '"sessionId":"b"'), original.replace('"version":2', '"version":2,"version":2'), "{}", "x"]) {
      writeFileSync(f.path("a"), corrupt);
      await assert.rejects(new ProfileStore(f.root).loadSessionSelection("a"), { code: "corrupt-selection" });
    }
    writeFileSync(f.path("a"), original);
    const pin = join(f.root, ".revisions", `${selected.selection.appliedRevision}.jsonc`);
    writeFileSync(pin, "{}");
    await assert.rejects(new ProfileStore(f.root).loadSessionSelection("a"), { code: "corrupt-selection" });
    unlinkSync(pin);
    await assert.rejects(new ProfileStore(f.root).loadSessionSelection("a"), { code: "corrupt-selection" });
  } finally { f.cleanup(); }
});

test("session files and directories reject hard links, symlinks/junctions and inventory overflow", async () => {
  for (const kind of ["hardlink", "symlink", "directory", "overflow"] as const) {
    const f = fixture();
    try {
      await f.store.loadSelection();
      mkdirSync(join(f.root, ".sessions"));
      if (kind === "overflow") {
        for (let index = 0; index < MAX_SESSION_PROFILE_CHOICES; index++) writeFileSync(join(f.root, ".sessions", `${index}.json`), "{}");
        await assert.rejects(f.store.selectSession(request("a"), epoch, () => null, commit()), { code: "limit" });
      } else if (kind === "directory") {
        rmdirSync(join(f.root, ".sessions"));
        const outside = join(f.directory, "outside"); mkdirSync(outside);
        symlinkSync(outside, join(f.root, ".sessions"), process.platform === "win32" ? "junction" : "dir");
        await assert.rejects(f.store.loadSessionSelection("a"), { code: "unsafe-path" });
      } else {
        const original = join(f.directory, "external.json"); writeFileSync(original, "{}");
        if (kind === "hardlink") linkSync(original, f.path("a"));
        else {
          try { symlinkSync(original, f.path("a")); } catch (error) {
            if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") continue;
            throw error;
          }
        }
        await assert.rejects(f.store.loadSessionSelection("a"), { code: "unsafe-path" });
      }
      assert.equal(existsSync(join(f.root, ".selection.json")), false);
    } finally { f.cleanup(); }
  }
});

test("session startup shares the bounded profile lock and never steals contention", async () => {
  const f = fixture();
  try {
    await f.store.loadSelection();
    writeFileSync(join(f.root, ".lock"), "preexisting-native-startup-lock");
    await assert.rejects(new ProfileStore(f.root, { lockTimeoutMs: 5, lockPollMs: 1 }).loadSessionSelection("a"), { code: "lock-timeout" });
    assert.equal(readFileSync(join(f.root, ".lock"), "utf8"), "preexisting-native-startup-lock");
    assert.equal(existsSync(join(f.root, ".sessions")), false);
  } finally { f.cleanup(); }
});

test("the final supported sidecar slot and updates at capacity exclude only the operation's own staging file", async () => {
  const f = fixture();
  try {
    await f.store.loadSelection(); mkdirSync(join(f.root, ".sessions"));
    for (let index = 0; index < MAX_SESSION_PROFILE_CHOICES - 1; index++) writeFileSync(join(f.root, ".sessions", `${index}.json`), "{}");
    const last = await f.store.selectSession(request("last"), epoch, () => null, commit());
    assert.equal(readdirSync(join(f.root, ".sessions")).length, MAX_SESSION_PROFILE_CHOICES);
    const updated = await f.store.selectSession({ ...request("last"), expectedSelectionRevision: last.selection.selectionRevision }, "c".repeat(64), () => null, commit());
    assert.notEqual(updated.selection.selectionRevision, last.selection.selectionRevision);
    await assert.rejects(f.store.selectSession(request("over-capacity"), epoch, () => null, commit()), { code: "limit" });
    assert.equal(readdirSync(join(f.root, ".sessions")).length, MAX_SESSION_PROFILE_CHOICES);
  } finally { f.cleanup(); }
});
