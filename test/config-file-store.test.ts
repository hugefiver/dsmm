import assert from "node:assert/strict";
import fs from "node:fs";
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { FixedConfigFileStore, MAX_CONFIG_FILE_BYTES } from "../lib/config-file-store.js";
import { DsmmProfileError } from "../lib/profiles.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dsmm-config-file-test-"));
  writeFileSync(join(directory, ".run-owner"), "dsmm-config-file-test\n", { flag: "wx" });
  const home = join(directory, "home");
  const root = join(home, "plugins", "dsmm");
  const path = join(root, "config.json");
  return { directory, home, root, path, store: new FixedConfigFileStore(home), cleanup() {
    assert.equal(lstatSync(directory).isSymbolicLink(), false);
    assert.equal(readFileSync(join(directory, ".run-owner"), "utf8"), "dsmm-config-file-test\n");
    rmSync(directory, { recursive: true, force: true });
  } };
}

function fault(code: string) {
  return (error: unknown) => error instanceof DsmmProfileError && error.code === code;
}

test("fixed config missing reads have no side effects and exact bytes/revisions are persisted only at the fixed path", async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.store.read(), { content: null, revision: "absent" });
    assert.equal(existsSync(f.home), false);
    assert.throws(() => new FixedConfigFileStore("relative"), fault("unsafe-path"));
    const raw = '\uFEFF{ "defaultActive": false }\n';
    const saved = await f.store.save(raw, "absent");
    assert.equal(saved.content, raw);
    assert.deepEqual(f.store.read(), saved);
    assert.equal(readFileSync(f.path, "utf8"), raw);
    assert.deepEqual(readdirSync(f.root), ["config.json"]);
    assert.equal(existsSync(join(f.home, "config.json")), false);
  } finally { f.cleanup(); }
});

test("fixed config CAS rejects stale and external edits and cooperative writers admit only one winner", async () => {
  const f = fixture();
  try {
    const first = await f.store.save('{"defaultActive":false}\n', "absent");
    await assert.rejects(f.store.save("{}", "absent"), fault("conflict"));
    const other = new FixedConfigFileStore(f.home);
    const results = await Promise.allSettled([f.store.save('{"defaultActive":true}', first.revision), other.save('{"guards":{}}', first.revision)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(fault("conflict")(rejected.reason));
    const observed = f.store.read();
    const external = '{"defaultActive":false,"guards":{}}\n';
    writeFileSync(f.path, external);
    await assert.rejects(f.store.save("{}", observed.revision), fault("conflict"));
    assert.equal(f.store.read().content, external);
    assert.notEqual(f.store.read().revision, observed.revision);
  } finally { f.cleanup(); }
});

test("fixed config refuses invalid UTF-8, malformed input strings and oversized files without treating them as absence", async () => {
  const f = fixture();
  try {
    const first = await f.store.save("{}", "absent");
    await assert.rejects(f.store.save('"\uD800"', first.revision), fault("validation"));
    await assert.rejects(f.store.save(" ".repeat(MAX_CONFIG_FILE_BYTES + 1), first.revision), fault("limit"));
    await assert.rejects(f.store.save("é".repeat(MAX_CONFIG_FILE_BYTES), first.revision), fault("limit"));
    const invalid = Buffer.from([0xc3, 0x28]);
    writeFileSync(f.path, invalid);
    assert.throws(() => f.store.read(), fault("validation"));
    await assert.rejects(f.store.save("{}", "absent"), fault("validation"));
    assert.equal(readFileSync(f.path).equals(invalid), true);
    writeFileSync(f.path, " ".repeat(MAX_CONFIG_FILE_BYTES + 1));
    assert.throws(() => f.store.read(), fault("limit"));
    await assert.rejects(f.store.save("{}", first.revision), fault("limit"));
    assert.equal(readFileSync(f.path).length, MAX_CONFIG_FILE_BYTES + 1);
  } finally { f.cleanup(); }
});

test("fixed config fences trusted authority immediately before commit", async () => {
  const f = fixture();
  try {
    const first = await f.store.save("{}\n", "absent");
    const fenced = new FixedConfigFileStore(f.home);
    await assert.rejects(fenced.save('{"defaultActive":true}', first.revision, () => {
      assert.equal(existsSync(join(f.root, ".config.lock")), true);
      assert.equal(readdirSync(f.root).some((name) => name.startsWith(".dsmm-tmp-")), true);
      assert.equal(readFileSync(f.path, "utf8"), first.content);
      throw new DsmmProfileError("cancelled", "Trusted fixture authority expired.");
    }), fault("cancelled"));
    assert.equal(readFileSync(f.path, "utf8"), first.content);
    const events: string[] = [];
    const succeeding = new FixedConfigFileStore(f.home, { rename(source, destination) {
      events.push("rename");
      renameSync(source, destination);
    } });
    await succeeding.save("{}", first.revision, () => { events.push("fence"); });
    assert.deepEqual(events, ["fence", "rename"]);
    assert.deepEqual(readdirSync(f.root), ["config.json"]);
  } finally { f.cleanup(); }
});

test("fixed config lock is never stolen and rename failure preserves the previous bytes with no delete fallback", async () => {
  const f = fixture();
  try {
    const first = await f.store.save("{}\n", "absent");
    const lock = join(f.root, ".config.lock");
    writeFileSync(lock, "foreign owner\n");
    const impatient = new FixedConfigFileStore(f.home, { lockTimeoutMs: 0 });
    assert.equal(impatient.read().revision, first.revision, "read never takes or changes the lock");
    await assert.rejects(impatient.save("{}", first.revision), fault("lock-timeout"));
    assert.equal(readFileSync(lock, "utf8"), "foreign owner\n");
    unlinkSync(lock);
    const failed = new FixedConfigFileStore(f.home, { rename(source, destination) {
      assert.equal(existsSync(source), true);
      assert.equal(readFileSync(destination, "utf8"), first.content);
      throw new Error("injected rename refusal");
    } });
    await assert.rejects(failed.save("{}", first.revision), fault("io"));
    assert.equal(readFileSync(f.path, "utf8"), first.content);
    assert.deepEqual(readdirSync(f.root), ["config.json"]);
  } finally { f.cleanup(); }
});

test("fixed config rejects unsafe file types, hard links, directory symlinks and dangling links before any writes", async () => {
  const f = fixture();
  try {
    const first = await f.store.save("{}", "absent");
    unlinkSync(f.path);
    const outside = join(f.directory, "other-config.json");
    writeFileSync(outside, "{}");
    linkSync(outside, f.path);
    assert.throws(() => f.store.read(), fault("unsafe-path"));
    await assert.rejects(f.store.save("{}", first.revision), fault("unsafe-path"));
    assert.equal(readFileSync(outside, "utf8"), "{}");
    unlinkSync(f.path);
    mkdirSync(f.path);
    assert.throws(() => f.store.read(), fault("unsafe-path"));
    rmSync(f.path, { recursive: true });
    const redirected = join(f.directory, "redirected");
    mkdirSync(redirected);
    renameSync(f.root, join(f.directory, "old-root"));
    symlinkSync(redirected, f.root, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => new FixedConfigFileStore(f.home), fault("unsafe-path"));
    assert.throws(() => f.store.read(), fault("unsafe-path"));
    await assert.rejects(f.store.save("{}", "absent"), fault("unsafe-path"));
    assert.deepEqual(readdirSync(redirected), []);
    unlinkSync(f.root);
    symlinkSync(join(f.directory, "missing-target"), f.root, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => new FixedConfigFileStore(f.home), fault("unsafe-path"));
    assert.equal(existsSync(join(f.directory, "missing-target")), false);
  } finally { f.cleanup(); }
});

test("fixed config pins every existing ancestor even before a missing-store read and refuses replaced or removed roots", async () => {
  const f = fixture();
  try {
    const first = await f.store.save("{}", "absent");
    renameSync(f.root, join(f.directory, "retired-root"));
    mkdirSync(f.root);
    writeFileSync(f.path, first.content);
    assert.throws(() => f.store.read(), fault("unsafe-path"));
    await assert.rejects(f.store.save("{}\n", first.revision), fault("unsafe-path"));
    assert.equal(readFileSync(f.path, "utf8"), first.content);
    const current = new FixedConfigFileStore(f.home);
    rmSync(f.root, { recursive: true });
    assert.throws(() => current.read(), fault("unsafe-path"));
    await assert.rejects(current.save("{}", "absent"), fault("unsafe-path"));
    assert.equal(existsSync(f.root), false, "a pinned missing root must not be recreated");
    const missing = new FixedConfigFileStore(join(f.home, "nested-home"));
    assert.equal(missing.read().revision, "absent");
    renameSync(f.home, join(f.directory, "retired-home"));
    mkdirSync(f.home);
    assert.throws(() => missing.read(), fault("unsafe-path"));
    await assert.rejects(missing.save("{}", "absent"), fault("unsafe-path"));
    assert.equal(existsSync(join(f.home, "nested-home")), false);
  } finally { f.cleanup(); }
});

test("fixed config failed rename cleanup never removes a replacement owner's lock", async () => {
  const f = fixture();
  let fd: number | undefined;
  try {
    const first = await f.store.save("{}", "absent");
    const lock = join(f.root, ".config.lock");
    const failed = new FixedConfigFileStore(f.home, { rename() {
      renameSync(lock, join(f.root, ".retired-lock"));
      fd = openSync(lock, "wx");
      writeFileSync(fd, "foreign owner\n");
      throw new Error("injected failure with replacement lock");
    } });
    await assert.rejects(failed.save("{}\n", first.revision), fault("io"));
    assert.equal(readFileSync(lock, "utf8"), "foreign owner\n");
    assert.equal(readFileSync(f.path, "utf8"), first.content);
  } finally {
    if (fd !== undefined) closeSync(fd);
    f.cleanup();
  }
});

test("fixed config final recheck catches an external edit made after staging and preserves it", async (t) => {
  const f = fixture();
  const originalFsync = fs.fsyncSync;
  try {
    const first = await f.store.save("{}", "absent");
    let syncs = 0;
    const external = '{"defaultActive":false}\n';
    const hook = t.mock.method(fs, "fsyncSync", (fd: number) => {
      originalFsync(fd);
      if (++syncs === 2) writeFileSync(f.path, external);
    });
    syncBuiltinESMExports();
    await assert.rejects(f.store.save('{"defaultActive":true}', first.revision), fault("conflict"));
    assert.equal(syncs, 2, "lock and staging fsync must both be exercised");
    assert.equal(readFileSync(f.path, "utf8"), external);
    hook.mock.restore();
    syncBuiltinESMExports();
    assert.deepEqual(readdirSync(f.root), ["config.json"]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test("fixed config replacing its root during staging refuses commit and never traverses the replacement for cleanup", async (t) => {
  const f = fixture();
  const originalFsync = fs.fsyncSync;
  try {
    const first = await f.store.save("{}", "absent");
    let syncs = 0;
    let blockedByOs = false;
    const retired = join(f.directory, "retired-root");
    t.mock.method(fs, "fsyncSync", (fd: number) => {
      originalFsync(fd);
      if (++syncs !== 2) return;
      try { renameSync(f.root, retired); } catch (error) {
        blockedByOs = process.platform === "win32" && typeof error === "object" && error !== null && "code" in error && (error.code === "EPERM" || error.code === "EACCES");
        throw error;
      }
      mkdirSync(f.root);
      writeFileSync(f.path, "replacement bytes");
    });
    syncBuiltinESMExports();
    await assert.rejects(f.store.save("{}\n", first.revision), (error) => fault(blockedByOs ? "io" : "unsafe-path")(error));
    assert.equal(syncs, 2);
    if (blockedByOs) assert.equal(readFileSync(f.path, "utf8"), first.content);
    else {
      assert.equal(readFileSync(join(retired, "config.json"), "utf8"), first.content);
      assert.equal(readFileSync(f.path, "utf8"), "replacement bytes");
      assert.deepEqual(readdirSync(f.root), ["config.json"]);
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.cleanup();
  }
});
