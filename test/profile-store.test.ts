import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { ProfileStore } from "../lib/profile-store.js";
import { DsmmProfileError, MAX_PROFILE_BYTES, MAX_PROFILE_COUNT } from "../lib/profiles.js";
import { ABSENT_PROFILE_SELECTION_REVISION } from "../lib/profile-types.js";

function content(id = "focus", active = false): string {
  return `{ // retained user comment\n "version": 1, "id": "${id}", "label": "Fixture profile", "settings": { "defaultActive": ${active} }\n}\n`;
}

function fixture(): { directory: string; root: string; store: ProfileStore; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "dsmm-profiles-test-"));
  writeFileSync(join(directory, ".run-owner"), "dsmm-profile-store-test\n", { flag: "wx" });
  const root = join(directory, "dsmm-profiles");
  return { directory, root, store: new ProfileStore(root), cleanup: () => {
    assert.equal(lstatSync(directory).isSymbolicLink(), false);
    assert.equal(readFileSync(join(directory, ".run-owner"), "utf8"), "dsmm-profile-store-test\n");
    rmSync(directory, { recursive: true, force: true });
  } };
}

function fault(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof DsmmProfileError && error.code === code;
}

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

test("empty store uses unchanged deployment baseline without inventing a profile or pointer", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.store.describe(), { origin: "explicit", readOnly: false, profiles: [], selectedId: null, appliedRevision: null, selectionRevision: ABSENT_PROFILE_SELECTION_REVISION });
    assert.deepEqual(await f.store.loadSelection(), { selectedId: null, appliedRevision: null, selectionRevision: ABSENT_PROFILE_SELECTION_REVISION, document: null, content: null });
    assert.deepEqual(readdirSync(f.root), []);
  } finally { f.cleanup(); }
});

test("save/read preserve exact JSONC bytes and optimistic creation/edit conflicts preserve originals", async () => {
  const f = fixture();
  try {
    const raw = `\uFEFF${content()}`;
    const first = await f.store.save({ id: "focus", content: raw, expectedRevision: null });
    assert.equal(first.content, raw);
    assert.equal(first.revision, (await f.store.read("focus")).revision);
    assert.equal((await f.store.read("focus")).content, raw);
    assert.equal(readFileSync(join(f.root, "focus.jsonc"), "utf8"), raw);
    await assert.rejects(f.store.save({ id: "focus", content: content("focus", true), expectedRevision: null }), fault("conflict"));
    await assert.rejects(f.store.save({ id: "focus", content: content("focus", true), expectedRevision: "f".repeat(64) }), fault("conflict"));
    assert.equal(readFileSync(join(f.root, "focus.jsonc"), "utf8"), raw);
    const next = await f.store.save({ id: "focus", content: content("focus", true), expectedRevision: first.revision });
    assert.notEqual(next.revision, first.revision);
    assert.equal((await f.store.loadSelection()).selectedId, null, "saving a draft never selects it");
    await assert.rejects(f.store.save({ id: "focus", content: '{"version":1,"id":"focus","settings":{"credentials":"do-not-echo"}}', expectedRevision: next.revision }), fault("validation"));
    assert.equal((await f.store.read("focus")).revision, next.revision);
  } finally { f.cleanup(); }
});

test("direct and JSON RPC text saves reject lone UTF-16 surrogates before changing original bytes", async () => {
  const f = fixture();
  try {
    const first = await f.store.save({ id: "focus", content: content(), expectedRevision: null });
    const selected = await f.store.select({ id: "focus", expectedRevision: first.revision, expectedSelectionRevision: "absent" });
    const pointer = readFileSync(join(f.root, ".selection.json"));
    for (const unit of ["\uD800", "\uDC00"]) {
      for (const raw of [content().replace("Fixture profile", unit), `${content()}// ${unit}\n`]) {
        const request = { id: "focus", content: raw, expectedRevision: first.revision };
        await assert.rejects(f.store.save(request), fault("validation"));
        const wireRequest = JSON.parse(JSON.stringify(request)) as typeof request;
        assert.equal(wireRequest.content, raw, "JSON RPC transport preserves the ill-formed input string");
        await assert.rejects(f.store.save(wireRequest), fault("validation"));
        assert.equal(readFileSync(join(f.root, "focus.jsonc"), "utf8"), first.content);
        assert.equal(readFileSync(join(f.root, ".selection.json")).equals(pointer), true);
        assert.equal((await f.store.loadSelection()).selectionRevision, selected.selection.selectionRevision);
      }
    }
    assert.equal(readdirSync(f.root).some((name) => name.startsWith(".dsmm-tmp-")), false);
  } finally { f.cleanup(); }
});

test("selection commits a minimal pointer to immutable bytes, and changed drafts do not autoload", async () => {
  const f = fixture();
  try {
    const first = await f.store.save({ id: "focus", content: content(), expectedRevision: null });
    let validations = 0;
    const committed = await f.store.select({ id: "focus", expectedRevision: first.revision, expectedSelectionRevision: ABSENT_PROFILE_SELECTION_REVISION }, (document) => {
      validations++;
      assert.equal(document?.settings.defaultActive, false);
      assert.equal(existsSync(join(f.root, ".selection.json")), false, "validation precedes pointer commit");
      return { fixturePrepared: "ready" };
    });
    assert.equal(validations, 1);
    assert.deepEqual(committed.prepared, { fixturePrepared: "ready" });
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, ".selection.json"), "utf8")), { version: 2, id: "focus", revision: committed.selection.appliedRevision, sourceRevision: first.revision });
    assert.equal(readFileSync(join(f.root, ".revisions", `${committed.selection.appliedRevision}.jsonc`), "utf8"), first.content);
    const next = await f.store.save({ id: "focus", content: content("focus", true), expectedRevision: first.revision });
    const restarted = new ProfileStore(f.root);
    const loaded = await restarted.loadSelection();
    assert.equal(loaded.appliedRevision, committed.selection.appliedRevision);
    assert.equal(loaded.document?.settings.defaultActive, false);
    assert.equal(loaded.content, first.content);
    const snapshot = await restarted.describe();
    assert.equal(snapshot.profiles[0]?.revision, next.revision);
    assert.equal(snapshot.appliedRevision, committed.selection.appliedRevision);
    rmSync(join(f.root, "focus.jsonc"));
    assert.equal((await restarted.loadSelection()).appliedRevision, committed.selection.appliedRevision, "selection is independent of the mutable draft");
    const reset = await restarted.select({ id: null, expectedSelectionRevision: loaded.selectionRevision }, (document) => {
      assert.equal(document, null);
      return "baseline";
    });
    assert.equal(reset.prepared, "baseline");
    assert.equal(reset.selection.selectedId, null);
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, ".selection.json"), "utf8")), { version: 2, id: null, revision: null });
  } finally { f.cleanup(); }
});

test("selection requires both revision checks and failed candidate activation changes no pointer", async () => {
  const f = fixture();
  try {
    const first = await f.store.save({ id: "focus", content: content(), expectedRevision: null });
    await assert.rejects(f.store.select({ id: "focus", expectedRevision: "f".repeat(64), expectedSelectionRevision: "absent" }), fault("conflict"));
    await assert.rejects(f.store.select({ id: "focus", expectedRevision: first.revision, expectedSelectionRevision: "absent" }, () => { throw new Error("private config must not escape"); }), fault("activation"));
    assert.equal(existsSync(join(f.root, ".selection.json")), false);
    assert.equal(existsSync(join(f.root, ".revisions")), false);
    const selected = await f.store.select({ id: "focus", expectedRevision: first.revision, expectedSelectionRevision: "absent" });
    const pointer = readFileSync(join(f.root, ".selection.json"), "utf8");
    await assert.rejects(f.store.select({ id: null, expectedSelectionRevision: "absent" }), fault("conflict"));
    await assert.rejects(f.store.select({ id: "focus", expectedRevision: first.revision, expectedSelectionRevision: selected.selection.selectionRevision }, async () => {
      writeFileSync(join(f.root, "focus.jsonc"), content("focus", true));
      return "not-admitted";
    }), fault("conflict"));
    assert.equal(readFileSync(join(f.root, ".selection.json"), "utf8"), pointer);
    assert.equal((await f.store.loadSelection()).appliedRevision, selected.selection.appliedRevision);
  } finally { f.cleanup(); }
});

test("candidate callback cannot mutate the immutable content-bound selection document", async () => {
  const f = fixture();
  try {
    const first = await f.store.save({ id: "focus", content: content(), expectedRevision: null });
    const result = await f.store.select({ id: "focus", expectedRevision: first.revision, expectedSelectionRevision: "absent" }, (document) => {
      document!.settings.defaultActive = true;
      document!.id = "unexpected";
      return "prepared";
    });
    assert.equal(result.selection.document?.id, "focus");
    assert.equal(result.selection.document?.settings.defaultActive, false);
    assert.equal((await f.store.loadSelection()).document?.settings.defaultActive, false);
  } finally { f.cleanup(); }
});

test("losing the lock during asynchronous candidate validation prevents immutable and pointer publication", async () => {
  const f = fixture();
  let foreignFd: number | undefined;
  try {
    const first = await f.store.save({ id: "focus", content: content(), expectedRevision: null });
    await assert.rejects(f.store.select({ id: "focus", expectedRevision: first.revision, expectedSelectionRevision: "absent" }, async () => {
      unlinkSync(join(f.root, ".lock"));
      foreignFd = openSync(join(f.root, ".lock"), "wx");
      writeFileSync(foreignFd, "foreign-exclusive-lock\n");
      return "not-admitted";
    }), fault("conflict"));
    assert.equal(readFileSync(join(f.root, ".lock"), "utf8"), "foreign-exclusive-lock\n", "the previous writer must not delete the foreign owner's lock");
    assert.equal(existsSync(join(f.root, ".selection.json")), false);
    assert.equal(existsSync(join(f.root, ".revisions")), false);
    assert.equal(readFileSync(join(f.root, "focus.jsonc"), "utf8"), first.content);
  } finally {
    if (foreignFd !== undefined) closeSync(foreignFd);
    f.cleanup();
  }
});

for (const mutation of ["remove", "replace", "rewrite"] as const) {
  const description = { remove: "removed", replace: "replaced", rewrite: "rewritten" }[mutation];
  test(`a ${description} audit lock retains the previously selected revision and does not remove foreign ownership`, async () => {
    const f = fixture();
    let foreignFd: number | undefined;
    try {
      const first = await f.store.save({ id: "focus", content: content(), expectedRevision: null });
      const selected = await f.store.select({ id: "focus", expectedRevision: first.revision, expectedSelectionRevision: "absent" });
      const next = await f.store.save({ id: "focus", content: content("focus", true), expectedRevision: first.revision });
      const previousPointer = readFileSync(join(f.root, ".selection.json"));
      await assert.rejects(f.store.select({ id: "focus", expectedRevision: next.revision, expectedSelectionRevision: selected.selection.selectionRevision }, async () => {
        const lockPath = join(f.root, ".lock");
        if (mutation === "remove") unlinkSync(lockPath);
        else if (mutation === "replace") {
          renameSync(lockPath, join(f.root, ".retired-lock"));
          foreignFd = openSync(lockPath, "wx");
          writeFileSync(foreignFd, "foreign-exclusive-lock\n");
        } else writeFileSync(lockPath, "foreign-rewritten-lock\n");
        return "not-admitted";
      }), fault("conflict"));
      assert.equal(readFileSync(join(f.root, ".selection.json")).equals(previousPointer), true);
      assert.equal(readFileSync(join(f.root, ".revisions", `${selected.selection.appliedRevision}.jsonc`), "utf8"), first.content);
      assert.equal(readdirSync(join(f.root, ".revisions")).length, 1);
      if (mutation === "remove") assert.equal(existsSync(join(f.root, ".lock")), false);
      else assert.equal(readFileSync(join(f.root, ".lock"), "utf8"), mutation === "replace" ? "foreign-exclusive-lock\n" : "foreign-rewritten-lock\n");
    } finally {
      if (foreignFd !== undefined) closeSync(foreignFd);
      f.cleanup();
    }
  });
}

test("root replacement during candidate audit is blocked by the OS or invalidates storage authority", async () => {
  const f = fixture();
  try {
    const first = await f.store.save({ id: "focus", content: content(), expectedRevision: null });
    const moved = join(f.directory, "previous-root");
    let blockedByOs = false;
    await assert.rejects(f.store.select({ id: "focus", expectedRevision: first.revision, expectedSelectionRevision: "absent" }, async () => {
      try { renameSync(f.root, moved); } catch (error) {
        blockedByOs = process.platform === "win32" && typeof error === "object" && error !== null && "code" in error && (error.code === "EPERM" || error.code === "EACCES");
        throw error;
      }
      mkdirSync(f.root);
      writeFileSync(join(f.root, "focus.jsonc"), content("focus", true));
      return "not-admitted";
    }), (error) => fault(blockedByOs ? "activation" : "unsafe-path")(error));
    assert.equal(existsSync(join(f.root, ".selection.json")), false);
    assert.equal(existsSync(join(moved, ".selection.json")), false);
    if (blockedByOs) {
      assert.equal(existsSync(moved), false);
      assert.equal(readFileSync(join(f.root, "focus.jsonc"), "utf8"), first.content);
    } else {
      assert.equal(readFileSync(join(moved, "focus.jsonc"), "utf8"), first.content);
      assert.equal(readFileSync(join(f.root, "focus.jsonc"), "utf8"), content("focus", true));
    }
    assert.equal(existsSync(join(f.root, ".lock")), false);
  } finally { f.cleanup(); }
});

test("regular directory substitution between calls invalidates a store's pinned root identity", async () => {
  const f = fixture();
  try {
    const first = await f.store.save({ id: "focus", content: content(), expectedRevision: null });
    const moved = join(f.directory, "previous-root");
    renameSync(f.root, moved);
    mkdirSync(f.root);
    writeFileSync(join(f.root, "focus.jsonc"), first.content);
    await assert.rejects(f.store.save({ id: "focus", content: content("focus", true), expectedRevision: first.revision }), fault("unsafe-path"));
    assert.equal(readFileSync(join(f.root, "focus.jsonc"), "utf8"), first.content);
    assert.equal(readFileSync(join(moved, "focus.jsonc"), "utf8"), first.content);
    assert.equal(existsSync(join(f.root, ".lock")), false);
  } finally { f.cleanup(); }
});

test("failed atomic replacement preserves both existing draft and selected pointer without delete-old-first", async () => {
  const f = fixture();
  try {
    const first = await f.store.save({ id: "focus", content: content(), expectedRevision: null });
    const selected = await f.store.select({ id: "focus", expectedRevision: first.revision, expectedSelectionRevision: "absent" });
    const pointer = readFileSync(join(f.root, ".selection.json"), "utf8");
    const failing = new ProfileStore(f.root, { rename(source, destination) {
      assert.equal(existsSync(source), true);
      assert.equal(existsSync(destination), true, "previous bytes must still exist when replacement is attempted");
      throw new Error("injected EPERM");
    } });
    await assert.rejects(failing.save({ id: "focus", content: content("focus", true), expectedRevision: first.revision }), fault("io"));
    assert.equal(readFileSync(join(f.root, "focus.jsonc"), "utf8"), first.content);
    await assert.rejects(failing.select({ id: null, expectedSelectionRevision: selected.selection.selectionRevision }), fault("io"));
    assert.equal(readFileSync(join(f.root, ".selection.json"), "utf8"), pointer);
    assert.equal(readdirSync(f.root).some((name) => name.startsWith(".dsmm-tmp-")), false);
    assert.equal(existsSync(join(f.root, ".lock")), false);
  } finally { f.cleanup(); }
});

test("external edits before saving trigger conflict instead of overwrite", async () => {
  const f = fixture();
  try {
    const first = await f.store.save({ id: "focus", content: content(), expectedRevision: null });
    const external = content("focus", true);
    writeFileSync(join(f.root, "focus.jsonc"), external);
    await assert.rejects(f.store.save({ id: "focus", content: content(), expectedRevision: first.revision }), fault("conflict"));
    assert.equal(readFileSync(join(f.root, "focus.jsonc"), "utf8"), external);
  } finally { f.cleanup(); }
});

test("concurrent UI saves with the same expected revision admit one winner and preserve its bytes", async () => {
  const f = fixture();
  try {
    const first = await f.store.save({ id: "focus", content: content(), expectedRevision: null });
    const other = new ProfileStore(f.root);
    const outcomes = await Promise.allSettled([
      f.store.save({ id: "focus", content: content("focus", true), expectedRevision: first.revision }),
      other.save({ id: "focus", content: `${content()}// Second editor\n`, expectedRevision: first.revision })
    ]);
    const success = outcomes.filter((result) => result.status === "fulfilled");
    const refused = outcomes.filter((result) => result.status === "rejected");
    assert.equal(success.length, 1);
    assert.equal(refused.length, 1);
    assert.ok(fault("conflict")((refused[0] as PromiseRejectedResult).reason));
    assert.equal((await f.store.read("focus")).revision, (success[0] as PromiseFulfilledResult<{ revision: string }>).value.revision);
  } finally { f.cleanup(); }
});

test("lock timeout never steals another process's lock or changes file bytes", async () => {
  const f = fixture();
  try {
    const first = await f.store.save({ id: "focus", content: content(), expectedRevision: null });
    writeFileSync(join(f.root, ".lock"), "foreign-lock\n");
    const impatient = new ProfileStore(f.root, { lockTimeoutMs: 30, lockPollMs: 5 });
    await assert.rejects(impatient.save({ id: "focus", content: content("focus", true), expectedRevision: first.revision }), fault("lock-timeout"));
    assert.equal(readFileSync(join(f.root, ".lock"), "utf8"), "foreign-lock\n");
    assert.equal(readFileSync(join(f.root, "focus.jsonc"), "utf8"), first.content);
  } finally { f.cleanup(); }
});

test("two real processes serialize selection and expose a structured lock timeout", async () => {
  const f = fixture();
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  try {
    await f.store.describe();
    const moduleUrl = pathToFileURL(resolve(import.meta.dirname, "../lib/profile-store.js")).href;
    const source = `import {ProfileStore} from ${JSON.stringify(moduleUrl)}; const store=new ProfileStore(${JSON.stringify(f.root)}); await store.select({id:null,expectedSelectionRevision:'absent'}, async()=>{const released=new Promise(resolve=>{process.stdin.resume();process.stdin.once('end',resolve);});process.send('LOCKED');await released;});process.disconnect();`;
    child = spawn(process.execPath, [...process.execArgv, "--input-type=module", "-e", source], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
    const owned = child;
    let stderr = "";
    owned.stdout!.resume();
    owned.stderr!.on("data", (chunk) => { stderr += chunk.toString(); });
    closed = new Promise((done) => owned.once("close", (code, signal) => done({ code, signal })));
    await new Promise<void>((done, fail) => {
      const detach = () => {
        clearTimeout(timeout);
        owned.off("error", onError);
        owned.off("close", onClose);
        owned.off("message", onMessage);
      };
      const onError = (error: Error) => { detach(); fail(error); };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        detach(); fail(new Error(`child lock probe closed before LOCKED (code=${code}, signal=${signal}): ${stderr}`));
      };
      const onMessage = (message: unknown) => { if (message === "LOCKED") { detach(); done(); } };
      const timeout = setTimeout(() => {
        detach(); fail(new Error(`child lock probe timed out (exit=${owned.exitCode}, signal=${owned.signalCode}): ${stderr}`));
      }, 5000);
      owned.once("error", onError);
      owned.once("close", onClose);
      owned.on("message", onMessage);
    });
    const impatient = new ProfileStore(f.root, { lockTimeoutMs: 30, lockPollMs: 5 });
    await assert.rejects(impatient.select({ id: null, expectedSelectionRevision: "absent" }), fault("lock-timeout"));
    assert.equal(existsSync(join(f.root, ".selection.json")), false);
    owned.stdin!.end();
    const completed = await closed;
    assert.equal(completed.code, 0, stderr);
    assert.equal(completed.signal, null, stderr);
    assert.equal((await f.store.loadSelection()).selectedId, null);
    assert.notEqual((await f.store.loadSelection()).selectionRevision, "absent");
  } finally {
    if (child !== undefined) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
    f.cleanup();
  }
});

test("corrupt or missing immutable selections fail visibly rather than silently reverting baseline", async () => {
  const f = fixture();
  try {
    const first = await f.store.save({ id: "focus", content: content(), expectedRevision: null });
    const selected = await f.store.select({ id: "focus", expectedRevision: first.revision, expectedSelectionRevision: "absent" });
    const immutable = join(f.root, ".revisions", `${selected.selection.appliedRevision}.jsonc`);
    writeFileSync(immutable, "{}");
    await assert.rejects(new ProfileStore(f.root).loadSelection(), fault("corrupt-selection"));
    assert.equal((await f.store.describe()).selectionError?.code, "corrupt-selection");
    rmSync(immutable);
    await assert.rejects(f.store.loadSelection(), fault("corrupt-selection"));
    writeFileSync(join(f.root, ".selection.json"), '{"version":1,"id":null,"revision":null,"settings":{"credentials":"private"}}');
    await assert.rejects(f.store.loadSelection(), fault("corrupt-selection"));
    const snapshot = await f.store.describe();
    assert.equal(snapshot.selectionRevision, "unavailable");
    assert.equal(JSON.stringify(snapshot).includes("private"), false);
    await assert.rejects(f.store.select({ id: null, expectedSelectionRevision: "absent" }), fault("corrupt-selection"));
    writeFileSync(join(f.root, ".selection.json"), '{"version":1,"id":"focus","id":null,"revision":null}');
    await assert.rejects(f.store.loadSelection(), fault("corrupt-selection"));
  } finally { f.cleanup(); }
});

test("inventory sanitizes invalid files without returning their private raw contents", async () => {
  const f = fixture();
  try {
    await f.store.describe();
    writeFileSync(join(f.root, "invalid.jsonc"), '{"version":1,"id":"invalid","settings":{"apiKey":"private-value"}}');
    writeFileSync(join(f.root, "large.jsonc"), " ".repeat(MAX_PROFILE_BYTES + 1));
    writeFileSync(join(f.root, "WrongCase.jsonc"), content("focus"));
    const snapshot = await f.store.describe();
    assert.equal(snapshot.profiles.find((item) => item.id === "invalid")?.error?.code, "validation");
    assert.equal(snapshot.profiles.find((item) => item.id === "large")?.error?.code, "limit");
    assert.equal(snapshot.profiles.find((item) => item.id === "WrongCase")?.error?.code, "validation");
    assert.equal(JSON.stringify(snapshot).includes("private-value"), false);
    await assert.rejects(f.store.read("invalid"), fault("validation"));
    await assert.rejects(f.store.save({ id: "wrongcase", content: content("wrongcase"), expectedRevision: null }), fault("unsafe-path"));
    await assert.rejects(f.store.read("../escape"), fault("validation"));
    await assert.rejects(f.store.read("con"), fault("validation"));
  } finally { f.cleanup(); }
});

test("unsafe root ancestors, junctions, regular-file substitutions and hard links are rejected", async (t) => {
  const f = fixture();
  try {
    const actual = join(f.directory, "actual");
    mkdirSync(actual);
    const linkedParent = join(f.directory, "linked-parent");
    try { symlinkSync(actual, linkedParent, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { t.skip(`Directory links unavailable: ${error instanceof Error ? error.name : "unknown"}`); return; }
    await assert.rejects(new ProfileStore(join(linkedParent, "dsmm-profiles")).describe(), fault("unsafe-path"));
    assert.equal(existsSync(join(actual, "dsmm-profiles")), false);
    const first = await f.store.save({ id: "focus", content: content(), expectedRevision: null });
    mkdirSync(join(f.root, "directory.jsonc"));
    await assert.rejects(f.store.read("directory"), fault("unsafe-path"));
    const outside = join(f.directory, "outside.jsonc");
    writeFileSync(outside, content("hardlinked"));
    linkSync(outside, join(f.root, "hardlinked.jsonc"));
    await assert.rejects(f.store.read("hardlinked"), fault("unsafe-path"));
    await assert.rejects(f.store.save({ id: "hardlinked", content: content("hardlinked", true), expectedRevision: sha(content("hardlinked")) }), fault("unsafe-path"));
    assert.equal(readFileSync(outside, "utf8"), content("hardlinked"));
    const moved = join(f.directory, "moved-profiles");
    renameSync(f.root, moved);
    symlinkSync(moved, f.root, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(f.store.save({ id: "focus", content: content("focus", true), expectedRevision: first.revision }), fault("unsafe-path"));
    assert.equal(readFileSync(join(moved, "focus.jsonc"), "utf8"), first.content);
  } finally { f.cleanup(); }
});

test("profile inventory is bounded and does not create another file after its limit", async () => {
  const f = fixture();
  try {
    await f.store.describe();
    for (let i = 0; i < MAX_PROFILE_COUNT; i++) writeFileSync(join(f.root, `profile-${i}.jsonc`), content(`profile-${i}`));
    await assert.rejects(f.store.save({ id: "overflow", content: content("overflow"), expectedRevision: null }), fault("limit"));
    assert.equal(existsSync(join(f.root, "overflow.jsonc")), false);
    assert.equal((await f.store.describe()).profiles.length, MAX_PROFILE_COUNT);
  } finally { f.cleanup(); }
});

function centralFixture(f: ReturnType<typeof fixture>, entry = "dsmm-entry", profile = "host-a", options = {}): ProfileStore {
  const host = join(f.directory, profile);
  mkdirSync(host, { recursive: true });
  return ProfileStore.fromCentral(join(f.directory, "home"), host, entry, options);
}

const sessionCommit = { assertCurrent() {}, committed() {} };

test("central missing reads create no directories or locks and the trusted factory is not an arbitrary root escape", async () => {
  const f = fixture();
  try {
    const store = centralFixture(f);
    assert.deepEqual(await store.describe(), { origin: "central", readOnly: false, profiles: [], selectedId: null, appliedRevision: null, selectionRevision: "absent" });
    assert.equal((await store.loadSelection()).selectionRevision, "absent");
    assert.equal((await store.loadSessionSelection("session-a")).selectionRevision, "absent");
    await assert.rejects(store.read("focus"), fault("not-found"));
    assert.equal(existsSync(join(f.directory, "home")), false);
    assert.equal(existsSync(f.root), false);
    assert.throws(() => new ProfileStore(join(f.directory, "profiles")), fault("unsafe-path"));
    assert.throws(() => ProfileStore.fromCentral("relative", join(f.directory, "host-a"), "entry"), fault("unsafe-path"));
    assert.throws(() => ProfileStore.fromCentral(join(f.directory, "home"), join(f.directory, "missing-host"), "entry"), fault("unsafe-path"));
    assert.throws(() => centralFixture(f, "\u0000entry"), fault("validation"));
    assert.throws(() => ProfileStore.fromCentral(join(f.directory, "home"), `${join(f.directory, "host-a")}/../host-a`, "entry"), fault("unsafe-path"));
  } finally { f.cleanup(); }
});

test("central shared documents retain snapshot pins while host and entry selection/session versions are isolated", async () => {
  const f = fixture();
  try {
    const a = centralFixture(f);
    const b = centralFixture(f, "dsmm-entry", "host-b");
    const otherEntry = centralFixture(f, "another-entry");
    assert.equal(a.profileDir, join(f.directory, "home", "plugins", "dsmm", "profiles"));
    assert.equal(a.profileDir, b.profileDir);
    assert.equal(a.stateDir, join(a.profileDir, ".state", sha(JSON.stringify([process.platform === "win32" ? join(f.directory, "host-a").toLowerCase() : join(f.directory, "host-a"), "dsmm-entry"]))));
    assert.notEqual(a.stateDir, b.stateDir);
    assert.notEqual(a.stateDir, otherEntry.stateDir);
    const first = await a.save({ id: "focus", content: `\uFEFF${content()}`, expectedRevision: null });
    assert.equal((await b.read("focus")).content, first.content);
    const selected = await a.select({ id: "focus", expectedRevision: first.revision, expectedSelectionRevision: "absent" });
    const session = await a.selectSession({ sessionId: "same-session", id: "focus", expectedRevision: first.revision, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "a".repeat(64) }, "b".repeat(64), () => "ready", sessionCommit);
    assert.equal((await b.loadSelection()).selectionRevision, "absent");
    assert.equal((await otherEntry.loadSelection()).selectionRevision, "absent");
    assert.equal((await b.loadSessionSelection("same-session")).selectionRevision, "absent");
    const next = await b.save({ id: "focus", content: content("focus", true), expectedRevision: first.revision });
    assert.equal((await a.loadSelection()).appliedRevision, selected.selection.appliedRevision);
    assert.equal((await a.loadSessionSelection("same-session")).content, first.content);
    const bSelected = await b.select({ id: "focus", expectedRevision: next.revision, expectedSelectionRevision: "absent" });
    await assert.rejects(a.select({ id: null, expectedSelectionRevision: bSelected.selection.selectionRevision }), fault("conflict"));
    await assert.rejects(a.selectSession({ sessionId: "same-session", id: null, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "b".repeat(64) }, "c".repeat(64), () => null, sessionCommit), fault("conflict"));
    assert.equal((await a.loadSelection()).selectionRevision, selected.selection.selectionRevision);
    assert.equal((await a.loadSessionSelection("same-session")).selectionRevision, session.selection.selectionRevision);
    assert.equal(readFileSync(join(a.profileDir, ".revisions", `${selected.selection.appliedRevision}.jsonc`), "utf8"), first.content);
    assert.equal(existsSync(join(a.profileDir, ".selection.json")), false);
    assert.equal(existsSync(join(a.profileDir, ".sessions")), false);
    const reopened = centralFixture(f);
    assert.equal((await reopened.loadSessionSelection("same-session")).appliedRevision, session.selection.appliedRevision);
    assert.equal(readdirSync(a.profileDir).includes(".lock"), false);
  } finally { f.cleanup(); }
});

test("central scopes cooperate on the same documents lock and recheck scoped state after awaited validation", async () => {
  const f = fixture();
  try {
    const a = centralFixture(f);
    const b = centralFixture(f, "dsmm-entry", "host-b", { lockTimeoutMs: 0 });
    const draft = await a.save({ id: "focus", content: content(), expectedRevision: null });
    await a.select({ id: "focus", expectedRevision: draft.revision, expectedSelectionRevision: "absent" }, async () => {
      assert.equal(existsSync(join(a.profileDir, ".lock")), true);
      await assert.rejects(b.save({ id: "focus", content: content("focus", true), expectedRevision: draft.revision }), fault("lock-timeout"));
    });
    const selection = await a.loadSelection();
    const external = Buffer.from('{"version":1,"id":null,"revision":null}\n');
    await assert.rejects(a.select({ id: null, expectedSelectionRevision: selection.selectionRevision }, () => {
      writeFileSync(join(a.stateDir, ".selection.json"), external);
    }), fault("conflict"));
    assert.equal(readFileSync(join(a.stateDir, ".selection.json")).equals(external), true);
    const request = { sessionId: "session", id: null, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "a".repeat(64) };
    await assert.rejects(a.selectSession(request, "b".repeat(64), () => {
      const sessions = join(a.stateDir, ".sessions");
      mkdirSync(sessions);
      writeFileSync(join(sessions, `${sha("session")}.json`), JSON.stringify({ version: 1, sessionId: "session", id: null, revision: null, epoch: "c".repeat(64) }));
    }, sessionCommit), fault("conflict"));
  } finally { f.cleanup(); }
});

test("central state namespace and trusted Host identity replacements invalidate storage authority", async () => {
  const f = fixture();
  try {
    const store = centralFixture(f);
    await store.select({ id: null, expectedSelectionRevision: "absent" });
    renameSync(store.stateDir, `${store.stateDir}-retired`);
    mkdirSync(store.stateDir);
    await assert.rejects(store.loadSelection(), fault("unsafe-path"));
    await assert.rejects(store.select({ id: null, expectedSelectionRevision: "absent" }), fault("unsafe-path"));
    assert.equal(readdirSync(store.stateDir).length, 0);
    const b = centralFixture(f, "entry-b", "host-b");
    renameSync(join(f.directory, "host-b"), join(f.directory, "host-b-retired"));
    mkdirSync(join(f.directory, "host-b"));
    await assert.rejects(b.describe(), fault("unsafe-path"));
  } finally { f.cleanup(); }
});

test("central state junctions are refused without writing or reading a different scope", async () => {
  const f = fixture();
  try {
    const store = centralFixture(f);
    await store.save({ id: "focus", content: content(), expectedRevision: null });
    const outside = join(f.directory, "foreign-state");
    mkdirSync(outside);
    symlinkSync(outside, join(store.profileDir, ".state"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(store.loadSelection(), fault("unsafe-path"));
    await assert.rejects(store.loadSessionSelection("session"), fault("unsafe-path"));
    await assert.rejects(store.select({ id: null, expectedSelectionRevision: "absent" }), fault("unsafe-path"));
    assert.equal(readdirSync(outside).length, 0);
  } finally { f.cleanup(); }
});

test("legacy reads retain full immutable and session pins without locks or writes and a central same ID never takes over", async () => {
  const f = fixture();
  try {
    const first = await f.store.save({ id: "focus", content: `\uFEFF${content()}`, expectedRevision: null });
    const selected = await f.store.select({ id: "focus", expectedRevision: first.revision, expectedSelectionRevision: "absent" });
    const session = await f.store.selectSession({ sessionId: "cold", id: "focus", expectedRevision: first.revision, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "a".repeat(64) }, "b".repeat(64), () => null, sessionCommit);
    await f.store.save({ id: "focus", content: content("focus", true), expectedRevision: first.revision });
    const before = fileTree(f.root);
    writeFileSync(join(f.root, ".lock"), "foreign lock remains untouched\n");
    const legacy = ProfileStore.fromLegacy(f.root);
    assert.equal(legacy.profileDir, f.root);
    const snapshot = await legacy.describe();
    assert.equal(snapshot.origin, "legacy");
    assert.equal(snapshot.readOnly, true);
    assert.match(snapshot.writeRestriction!, /import/u);
    assert.equal((await legacy.loadSelection()).content, first.content);
    assert.equal((await legacy.loadSessionSelection("cold")).appliedRevision, session.selection.appliedRevision);
    assert.equal((await legacy.read("focus")).content, content("focus", true));
    const central = centralFixture(f);
    const centralDraft = await central.save({ id: "focus", content: `${content()}// central same ID\n`, expectedRevision: null });
    await central.select({ id: "focus", expectedRevision: centralDraft.revision, expectedSelectionRevision: "absent" });
    assert.equal((await legacy.loadSelection()).appliedRevision, selected.selection.appliedRevision);
    await assert.rejects(legacy.save({ id: "focus", content: content(), expectedRevision: first.revision }), fault("unavailable"));
    await assert.rejects(legacy.select({ id: null, expectedSelectionRevision: "absent" }), fault("unavailable"));
    await assert.rejects(legacy.selectSession({ sessionId: "cold", id: null, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "a".repeat(64) }, "b".repeat(64), () => null, sessionCommit), fault("unavailable"));
    assert.equal(readFileSync(join(f.root, ".lock"), "utf8"), "foreign lock remains untouched\n");
    unlinkSync(join(f.root, ".lock"));
    assert.deepEqual(fileTree(f.root), before);
  } finally { f.cleanup(); }
});

test("legacy refuses missing or corrupt pointers/revisions and pins the original real root", async () => {
  const f = fixture();
  try {
    const draft = await f.store.save({ id: "focus", content: content(), expectedRevision: null });
    const legacy = ProfileStore.fromLegacy(f.root);
    await assert.rejects(legacy.loadSelection(), fault("corrupt-selection"));
    assert.equal((await legacy.describe()).selectionError?.code, "corrupt-selection");
    assert.equal(existsSync(join(f.root, ".lock")), false);
    const selected = await f.store.select({ id: "focus", expectedRevision: draft.revision, expectedSelectionRevision: "absent" });
    const session = await f.store.selectSession({ sessionId: "cold", id: "focus", expectedRevision: draft.revision, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "a".repeat(64) }, "b".repeat(64), () => null, sessionCommit);
    unlinkSync(join(f.root, ".revisions", `${selected.selection.appliedRevision}.jsonc`));
    unlinkSync(join(f.root, ".revisions", `${session.selection.appliedRevision}.jsonc`));
    await assert.rejects(legacy.loadSelection(), fault("corrupt-selection"));
    await assert.rejects(legacy.loadSessionSelection("cold"), fault("corrupt-selection"));
    writeFileSync(join(f.root, ".revisions", `${selected.selection.appliedRevision}.jsonc`), "{}");
    await assert.rejects(legacy.loadSelection(), fault("corrupt-selection"));
    writeFileSync(join(f.root, ".selection.json"), '{"version":1,"id":null,"revision":null,"id":"focus"}');
    await assert.rejects(legacy.loadSelection(), fault("corrupt-selection"));
    renameSync(f.root, join(f.directory, "legacy-retired"));
    mkdirSync(f.root);
    await assert.rejects(legacy.loadSelection(), fault("unsafe-path"));
    assert.equal(readdirSync(f.root).length, 0);
  } finally { f.cleanup(); }
});

function fileTree(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (lstatSync(path).isDirectory()) {
      for (const [child, bytes] of Object.entries(fileTree(path))) files[`${name}/${child}`] = bytes;
    } else files[name] = readFileSync(path).toString("hex");
  }
  return files;
}

test("fixture-only explicit non-destructive copy preserves raw drafts/revisions/scoped sidecars and refuses conflicting targets", async () => {
  const f = fixture();
  try {
    const raw = `\uFEFF${content()}// explicit fixture copy only\n`;
    const draft = await f.store.save({ id: "focus", content: raw, expectedRevision: null });
    const selected = await f.store.select({ id: "focus", expectedRevision: draft.revision, expectedSelectionRevision: "absent" });
    await f.store.selectSession({ sessionId: "cold", id: "focus", expectedRevision: draft.revision, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "a".repeat(64) }, "b".repeat(64), () => null, sessionCommit);
    const original = fileTree(f.root);
    const target = centralFixture(f);
    const conflicting = await target.save({ id: "focus", content: content("focus", true), expectedRevision: null });
    await assert.rejects(target.save({ id: "focus", content: raw, expectedRevision: null }), fault("conflict"));
    assert.equal((await target.read("focus")).revision, conflicting.revision);
    const clean = ProfileStore.fromCentral(join(f.directory, "copy-home"), join(f.directory, "host-a"), "entry");
    await clean.save({ id: "focus", content: raw, expectedRevision: null });
    cpSync(join(f.root, ".revisions"), join(clean.profileDir, ".revisions"), { recursive: true, errorOnExist: true, force: false });
    mkdirSync(clean.stateDir, { recursive: true });
    cpSync(join(f.root, ".selection.json"), join(clean.stateDir, ".selection.json"), { errorOnExist: true, force: false });
    cpSync(join(f.root, ".sessions"), join(clean.stateDir, ".sessions"), { recursive: true, errorOnExist: true, force: false });
    assert.equal((await clean.read("focus")).content, raw);
    assert.equal((await clean.loadSelection()).appliedRevision, selected.selection.appliedRevision);
    assert.equal((await clean.loadSessionSelection("cold")).content, raw);
    assert.throws(() => cpSync(join(f.root, ".selection.json"), join(clean.stateDir, ".selection.json"), { errorOnExist: true, force: false }));
    assert.deepEqual(fileTree(f.root), original);
  } finally { f.cleanup(); }
});
