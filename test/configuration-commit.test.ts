import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ProfileStore } from "../src/profile-store.ts";
import { DsmmProfileRuntime } from "../src/profile-runtime.ts";
import { FixedConfigFileStore } from "../src/config-file-store.ts";
import { DsmmDeploymentConfig } from "../src/deployment-config.ts";
import { TYPERT_REMOTE } from "../src/profile-remote.ts";
import type { DshContext } from "../src/dsh-types.ts";
import { DSMM_CONFIG_SCHEMA, DSMM_NATIVE_CONFIG_SCHEMA, DSMM_SETTINGS_SCHEMA, resolveConfig, validateSparseConfig } from "../src/settings.ts";
import { DsmmProfileError, MAX_PROFILE_BYTES, parseProfileDocument } from "../src/profiles.ts";
import { createHash } from "node:crypto";

const body = JSON.stringify({ version: 1, id: "focus", settings: { defaultActive: true } });

for (const revoked of ["owner", "caller"] as const) test(`profile save refuses ${revoked} retirement while waiting for the document lock`, async () => {
  const root = mkdtempSync(join(tmpdir(), "dsmm-save-authority-"));
  let retire!: () => unknown, allowed = true;
  const store = new ProfileStore(join(root, "dsmm-profiles"), { lockPollMs: 1 });
  const runtime = new DsmmProfileRuntime({ effect(callback) { retire = callback() as () => unknown; } }, resolveConfig(), store);
  try {
    await runtime.initialize();
    const initial = await runtime.save({ id: "focus", content: body, expectedRevision: null });
    const lock = join(store.profileDir, ".lock");
    writeFileSync(lock, "transaction-test-owned lock\n", { flag: "wx" });
    const saving = runtime.save({ id: "focus", content: body.replace("true", "false"), expectedRevision: initial.revision }, revoked === "owner" ? undefined : () => {
      if (!allowed) throw new DsmmProfileError("not-owned", "Caller authority retired");
    });
    const refused = assert.rejects(saving, { code: revoked === "owner" ? "disposed" : "not-owned" });
    if (revoked === "owner") retire(); else allowed = false;
    unlinkSync(lock);
    await refused;
    assert.equal((await store.read("focus")).revision, initial.revision);
    assert.equal(readFileSync(join(store.profileDir, "focus.jsonc"), "utf8"), body);
    assert.deepEqual(readdirSync(store.profileDir), ["focus.jsonc"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("profile save rechecks trusted authority after staging and before rename", async t => {
  const root = mkdtempSync(join(tmpdir(), "dsmm-save-final-fence-"));
  const originalFsync = fs.fsyncSync;
  let renamed = false;
  const store = new ProfileStore(join(root, "dsmm-profiles"), { rename(source, target) { renamed = true; renameSync(source, target); } });
  try {
    const initial = await store.save({ id: "focus", content: body, expectedRevision: null });
    renamed = false;
    let syncs = 0, allowed = true;
    t.mock.method(fs, "fsyncSync", (fd: number) => {
      originalFsync(fd);
      if (++syncs === 2) allowed = false;
    });
    syncBuiltinESMExports();
    await assert.rejects(store.save({ id: "focus", content: body.replace("true", "false"), expectedRevision: initial.revision }, () => {
      if (!allowed) throw new DsmmProfileError("not-owned", "Caller authority retired");
    }), { code: "not-owned" });
    assert.equal(syncs, 2);
    assert.equal(renamed, false);
    assert.equal(readFileSync(join(store.profileDir, "focus.jsonc"), "utf8"), body);
    assert.deepEqual(readdirSync(store.profileDir), ["focus.jsonc"]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});

test("profile save preserves committed results when owner and caller retire during failed observation", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsmm-save-committed-"));
  let retire!: () => unknown, allowed = true, refuseObservation = false;
  const events: string[] = [];
  const store = new ProfileStore(join(root, "dsmm-profiles"), {
    rename(source, target) { events.push("rename"); renameSync(source, target); },
    observe() {
      if (!refuseObservation) return;
      events.push("observe"); retire(); allowed = false; throw new Error("Final observation unavailable");
    }
  });
  const runtime = new DsmmProfileRuntime({ effect(callback) { retire = callback() as () => unknown; } }, resolveConfig(), store);
  try {
    await runtime.initialize();
    const initial = await runtime.save({ id: "focus", content: body, expectedRevision: null });
    assert.equal(initial.revision, (await store.read("focus")).revision);
    const authority = () => { events.push("fence"); if (!allowed) throw new Error("Caller authority retired"); };
    const next = body.replace("true", "false");
    const valid = await runtime.save({ id: "focus", content: next, expectedRevision: initial.revision }, authority);
    assert.equal(valid.revision, (await store.read("focus")).revision);
    await assert.rejects(runtime.save({ id: "focus", content: body, expectedRevision: initial.revision }, authority), { code: "conflict" });
    assert.equal((await store.read("focus")).content, next);
    refuseObservation = true; events.length = 0;
    const committed = await runtime.save({ id: "focus", content: body, expectedRevision: valid.revision }, authority);
    assert.deepEqual(events.slice(-3), ["fence", "rename", "observe"]);
    assert.equal(committed.revision, "unavailable");
    assert.equal(committed.refreshRequired, true);
    assert.equal(committed.content, body);
    assert.equal(readFileSync(join(store.profileDir, "focus.jsonc"), "utf8"), body);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("saved revisions observe the final rename timestamps and match subsequent safe reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsmm-final-stat-"));
  try {
    let staged = "", final = "";
    const rename = (source: string, target: string) => {
      staged = lstatSync(source, { bigint: true }).ctimeNs.toString();
      renameSync(source, target);
      final = lstatSync(target, { bigint: true }).ctimeNs.toString();
    };
    const store = new FixedConfigFileStore(root, { rename });
    const saved = await store.save("{}", "absent");
    assert.equal(saved.revision, store.read().revision);
    assert.equal(saved.revision.endsWith(`-${final}`), true);
    assert.notEqual(final, staged, "rename changes ctime; staging metadata cannot be returned as the saved version");
    const profiles = new ProfileStore(join(root, "dsmm-profiles"), { rename });
    const draft = await profiles.save({ id: "focus", content: body, expectedRevision: null });
    assert.equal(draft.revision, (await profiles.read("focus")).revision);
    const selected = await profiles.select({ id: "focus", expectedRevision: draft.revision, expectedSelectionRevision: "absent" });
    assert.equal(selected.selection.selectionRevision, (await profiles.loadSelection()).selectionRevision);
    assert.equal(selected.selection.sourceRevision, draft.revision);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const failure of ["observe", "replace"] as const) test(`post-commit ${failure} preserves successful saves and publishes each selection once`, async () => {
  const root = mkdtempSync(join(tmpdir(), "dsmm-commit-observe-"));
  try {
    const events: string[] = [];
    const observe = (target: string) => {
      events.push("observe");
      if (failure === "observe") throw new Error("metadata unavailable");
      renameSync(target, `${target}.retained`); writeFileSync(target, "{}");
    };
    const global = new FixedConfigFileStore(root, { observe });
    assert.deepEqual(await global.save("{}", "absent"), { content: "{}", revision: "unavailable", refreshRequired: true });
    events.length = 0;
    const store = new ProfileStore(join(root, "dsmm-profiles"), { observe, rename(source, target) { events.push("rename"); renameSync(source, target); } });
    const saved = await store.save({ id: "focus", content: body, expectedRevision: null });
    assert.equal(saved.revision, "unavailable"); assert.equal(saved.refreshRequired, true); assert.equal(saved.content, body);
    events.length = 0;
    const globalSelection = await store.select({ id: null, expectedSelectionRevision: "absent" }, () => "prepared", {
      prepare() { events.push("prepare"); }, committed(_selection, prepared) { events.push("committed"); assert.equal(prepared, "prepared"); }
    });
    assert.deepEqual(events, ["prepare", "rename", "committed", "observe"]);
    assert.equal(globalSelection.selection.selectionRevision, "unavailable"); assert.equal(globalSelection.selection.refreshRequired, true);
    events.length = 0;
    const result = await store.selectSession({ sessionId: "session", id: null, expectedAdmissionEpoch: "a".repeat(64), expectedSelectionRevision: "absent" }, "b".repeat(64), () => "prepared", {
      assertCurrent() {}, prepare() { events.push("prepare"); }, committed(selection, prepared) {
        events.push("committed"); assert.equal(prepared, "prepared"); assert.equal(selection.admissionEpoch, "b".repeat(64));
      }
    });
    assert.deepEqual(events, ["prepare", "rename", "committed", "observe"]);
    assert.equal(result.selection.selectionRevision, "unavailable"); assert.equal(result.selection.refreshRequired, true);
    await assert.rejects(store.select({ id: null, expectedSelectionRevision: "unavailable" }), { code: "validation" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("precommit preparation failure preserves the old pointer and never publishes", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsmm-commit-prepare-"));
  try {
    const store = new ProfileStore(join(root, "dsmm-profiles"));
    const initial = await store.select({ id: null, expectedSelectionRevision: "absent" });
    const before = readFileSync(join(store.stateDir, ".selection.json"));
    let publications = 0;
    await assert.rejects(store.select({ id: null, expectedSelectionRevision: initial.selection.selectionRevision }, () => null, {
      prepare() { throw new Error("preparation refused"); }, committed() { publications++; }
    }));
    assert.equal(publications, 0); assert.deepEqual(readFileSync(join(store.stateDir, ".selection.json")), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("historical v1 pointer IDs load their referenced snapshot without rewriting or selecting the current draft", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsmm-old-pointer-"));
  try {
    const path = join(root, "dsmm-profiles"), revision = "a".repeat(64), epoch = "b".repeat(64);
    mkdirSync(join(path, ".revisions"), { recursive: true }); mkdirSync(join(path, ".sessions"));
    const pointer = JSON.stringify({ version: 1, id: "focus", revision });
    const session = JSON.stringify({ version: 1, id: "focus", revision, sessionId: "session", epoch });
    const sessionPath = join(path, ".sessions", `${createHash("sha256").update("session").digest("hex")}.json`);
    writeFileSync(join(path, ".revisions", `${revision}.jsonc`), body);
    writeFileSync(join(path, "focus.jsonc"), body.replace("true", "false"));
    writeFileSync(join(path, ".selection.json"), pointer); writeFileSync(sessionPath, session);
    const store = ProfileStore.fromLegacy(path);
    const selected = await store.loadSelection(), resumed = await store.loadSessionSelection("session");
    assert.equal(selected.document?.settings.defaultActive, true); assert.equal(selected.appliedRevision, revision);
    assert.equal(selected.sourceRevision, undefined); assert.equal(resumed.admissionEpoch, epoch);
    assert.equal(resumed.content, body); assert.equal(resumed.sourceRevision, undefined);
    assert.equal(readFileSync(join(path, ".selection.json"), "utf8"), pointer); assert.equal(readFileSync(sessionPath, "utf8"), session);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("global coordination cannot turn an already committed configuration into a failed save", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsmm-global-committed-"));
  try {
    const ctx: DshContext = { get<T>(name: string) { return (name === "profileContext" ? { home: root, dir: root } : undefined) as T | undefined; } };
    const deployment = new DsmmDeploymentConfig(ctx, {});
    deployment.coordinateWrites({ async global(_request, config, _assert, write) {
      await write(config); throw new Error("postcommit notification failed");
    } });
    const result = await deployment.saveGlobal({ expectedRevision: "absent", edits: [{ op: "set", path: ["defaultActive"], value: true }] }, () => {});
    assert.equal(result.refreshRequired, true);
    assert.deepEqual(result.config, { defaultActive: true });
    assert.equal((await deployment.readGlobal()).revision, result.revision);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("strict RPC codecs distinguish committed refresh responses from writable versions and admission identities", () => {
  const save = TYPERT_REMOTE.descriptors.find(row => row.namespace === "dsmmProfiles" && row.method === "save")!;
  assert.equal(save.result.mode, "strict");
  if (save.result.mode !== "strict") throw new Error("strict profile result required");
  const result = save.result.create();
  const committed = { id: "focus", content: body, revision: "unavailable", refreshRequired: true };
  assert.deepEqual(result.parse(committed), committed);
  assert.throws(() => result.parse({ ...committed, refreshRequired: false }));
  const parameter = save.parameters[0]!.codec;
  if (parameter.mode !== "strict") throw new Error("strict profile request required");
  assert.throws(() => parameter.create().parse({ id: "focus", content: body, expectedRevision: "unavailable" }));
  const session = TYPERT_REMOTE.descriptors.find(row => row.method === "selectSession")!;
  const request = session.parameters.find(row => row.name === "request")!.codec;
  if (request.mode !== "strict") throw new Error("strict session request required");
  assert.throws(() => request.create().parse({ sessionId: "session", id: null, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "stat-v1-1-2" }));
});

test("retired provider parameters are diagnosed rather than executed by configuration parsers", () => {
  for (const [field, value] of Object.entries({ deepseekV4ProCalibration: "strict", deepseekV4ProDefaultReasoningEffort: "high", deepseekFlashCalibration: "auto", deepseekFlashDefaultReasoningEffort: "low" })) {
    for (const parse of [DSMM_CONFIG_SCHEMA, DSMM_NATIVE_CONFIG_SCHEMA, DSMM_SETTINGS_SCHEMA, validateSparseConfig, resolveConfig]) {
      assert.throws(() => parse(JSON.parse(JSON.stringify({ [field]: value }))), error => error instanceof Error && "diagnostic" in error
        && (error.diagnostic as { code: string; field: string }).code === "deprecated-field"
        && (error.diagnostic as { field: string }).field === field);
    }
    assert.throws(() => parseProfileDocument(JSON.stringify({ version: 1, id: "focus", settings: { [field]: value } })), { reason: "deprecated-field", field: `settings.${field}` });
  }
});

for (const scope of ["global", "session"] as const) test(`a changed ${scope} pointer version during snapshot reading refuses admission without rewriting history`, async t => {
  const root = mkdtempSync(join(tmpdir(), "dsmm-pointer-version-"));
  const originalRead = fs.readSync;
  try {
    const store = new ProfileStore(join(root, "dsmm-profiles"));
    const draft = await store.save({ id: "focus", content: body, expectedRevision: null });
    const sessionId = "pointer-race", epoch = "e".repeat(64);
    const selected = scope === "global"
      ? await store.select({ id: "focus", expectedRevision: draft.revision, expectedSelectionRevision: "absent" })
      : await store.selectSession({ sessionId, id: "focus", expectedRevision: draft.revision, expectedSelectionRevision: "absent", expectedAdmissionEpoch: epoch }, epoch, () => null, { assertCurrent() {}, committed() {} });
    const pointerPath = scope === "global" ? join(store.stateDir, ".selection.json")
      : join(store.stateDir, ".sessions", `${createHash("sha256").update(sessionId).digest("hex")}.json`);
    let changed = false;
    const external = JSON.stringify({ version: 2, id: null, revision: null, ...(scope === "session" ? { sessionId, epoch } : {}) });
    t.mock.method(fs, "readSync", (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      const count = originalRead(fd, buffer, offset, length, position);
      if (!changed && buffer.length === MAX_PROFILE_BYTES + 1) {
        changed = true; writeFileSync(pointerPath, external);
      }
      return count;
    });
    syncBuiltinESMExports();
    const reader = ProfileStore.fromLegacy(store.profileDir);
    await assert.rejects(scope === "global" ? reader.loadSelection() : reader.loadSessionSelection(sessionId), { code: "conflict" });
    assert.equal(changed, true);
    assert.equal(readFileSync(join(store.profileDir, ".revisions", `${selected.selection.appliedRevision}.jsonc`), "utf8"), body);
    assert.equal(readFileSync(pointerPath, "utf8"), external);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});
