import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import type { Stats, BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { parseTree } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import { ABSENT_PROFILE_SELECTION_REVISION } from "./profile-types.js";
import type { ProfileReadResult, ProfileSaveRequest, ProfileSelectRequest, ProfileSelectionState, ProfileSnapshot, ProfileSummary, SessionProfileSelectRequest } from "./profile-types.js";
import { DsmmProfileError, MAX_PROFILE_BYTES, MAX_PROFILE_COUNT, MAX_PROFILE_DIRECTORY_ENTRIES, MAX_PROFILE_REVISIONS, parseProfileDocument, validateProfileDocument, profileErrorInfo, validateProfileId, validateProfileRevision } from "./profiles.js";
import type { DsmmProfileDocument } from "./profiles.js";
import type { ProfileDiagnostic } from "./profile-diagnostics.js";
import { inspectJsonDocument } from "./profile-diagnostics.js";
import { parseChildAdmissionCapture } from "./child-capture.js";
import type { ChildAdmissionCapture } from "./child-capture.js";
import { isProfileReference } from "./config-revision.js";
import { validateAdmissionEpoch } from "./profiles.js";

export type SaveProfileRequest = ProfileSaveRequest;
export type SelectProfileRequest = ProfileSelectRequest;

export interface LoadedProfileSelection extends ProfileSelectionState {
  warnings?: ProfileDiagnostic[];
  document: DsmmProfileDocument | null;
  content: string | null;
}

export interface LoadedSessionProfileSelection extends LoadedProfileSelection {
  sessionId: string;
  admissionEpoch: string | null;
}

export const MAX_SESSION_PROFILE_CHOICES = 1024;

export interface SessionProfileCommit<T> {
  /** Fallible installation preparation before the final fence/rename; never publication. */
  prepare?(selection: LoadedSessionProfileSelection, prepared: T): void | Promise<void>;
  /** Trusted native liveness/cancellation fence; invoked immediately before rename. */
  assertCurrent(): void;
  /** Synchronous publication after durable commit. Must not throw or await. */
  committed(selection: LoadedSessionProfileSelection, prepared: T): void;
}
export interface ProfileCommit<T> {
  prepare(selection: LoadedProfileSelection, prepared: T): void;
  committed(selection: LoadedProfileSelection, prepared: T): void;
}

export interface ProfileStoreOptions {
  lockTimeoutMs?: number;
  lockPollMs?: number;
  /** Narrow test seam for a failed atomic replacement; never delete the old target. */
  rename?: (source: string, destination: string) => void;
  /** Optional observation seam, after rename and synchronous admission publication. */
  observe?: (path: string) => void;
}

interface ProfileFile {
  identity: BigIntStats;
  bytes: Buffer;
  content: string;
  revision: string;
}

interface ProfileDraft extends ProfileFile {
  warnings?: ProfileDiagnostic[];
  document: DsmmProfileDocument;
}

interface SelectionPointer {
  version: 1 | 2;
  id: string | null;
  revision: string | null;
  sourceRevision?: string;
}

interface SessionSelectionPointer extends SelectionPointer {
  sessionId: string;
  epoch: string;
}

const trustedLayout = Symbol("trusted profile storage layout");
const LEGACY_WRITE_RESTRICTION = "Legacy profiles are read-only. Explicitly import them before saving or changing selections.";
type DirectoryIdentities = Map<string, Stats>;
interface TrustedStoreOptions extends ProfileStoreOptions {
  [trustedLayout]: { origin: "central" | "legacy"; stateDir: string; hostProfile?: string };
}

export interface ProfileStoreMetadata {
  origin: "central" | "legacy" | "explicit";
  readOnly: boolean;
  writeRestriction?: string;
}

/** This directory is supplied by the Host, never by a remote method parameter. */
export class ProfileStore {
  readonly profileDir: string;
  readonly stateDir: string;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly rename: (source: string, destination: string) => void;
  private readonly observe?: (path: string) => void;
  private rootIdentity?: Stats;
  readonly origin: ProfileStoreMetadata["origin"];
  private readonly hostProfile?: string;
  private readonly identities: DirectoryIdentities = new Map();

  constructor(profileDir: string, options: ProfileStoreOptions = {}) {
    const layout = (options as Partial<TrustedStoreOptions>)[trustedLayout];
    if (!isAbsolute(profileDir) || dirname(resolve(profileDir)) === resolve(profileDir) || (layout === undefined && basename(resolve(profileDir)) !== "dsmm-profiles")) {
      throw new DsmmProfileError("unsafe-path", "The Host must supply its native profile's dsmm-profiles directory.");
    }
    this.profileDir = resolve(profileDir);
    this.stateDir = layout?.stateDir ?? this.profileDir;
    this.origin = layout?.origin ?? "explicit";
    this.hostProfile = layout?.hostProfile;
    this.timeoutMs = boundedOption(options.lockTimeoutMs, 2000, 0, 30000);
    this.pollMs = boundedOption(options.lockPollMs, 25, 1, 1000);
    this.rename = options.rename ?? renameSync;
    this.observe = options.observe;
  }

  static fromCentral(home: string, canonicalHostProfile: string, actualEntryId: string, options: ProfileStoreOptions = {}): ProfileStore {
    const root = trustedHome(home);
    validateTrustedDirectoryPath(canonicalHostProfile);
    if (resolve(canonicalHostProfile) !== canonicalHostProfile) throw new DsmmProfileError("unsafe-path", "A canonical Host profile identity is required.");
    validateDirectories(canonicalHostProfile, false);
    if (typeof actualEntryId !== "string" || actualEntryId.length < 1 || actualEntryId.length > 256 || actualEntryId.trim().length === 0
      || /[\u0000-\u001f\u007f]/u.test(actualEntryId) || Buffer.from(actualEntryId, "utf8").toString("utf8") !== actualEntryId) {
      throw new DsmmProfileError("validation", "A bounded native entry identity is required.", "actualEntryId");
    }
    const identity = process.platform === "win32" ? canonicalHostProfile.toLowerCase() : canonicalHostProfile;
    const profileDir = join(root, "plugins", "dsmm", "profiles");
    const stateDir = join(profileDir, ".state", digest(Buffer.from(JSON.stringify([identity, actualEntryId]), "utf8")));
    const trusted: TrustedStoreOptions = { ...options, [trustedLayout]: { origin: "central", stateDir, hostProfile: canonicalHostProfile } };
    const store = new ProfileStore(profileDir, trusted);
    store.validateRoot(false);
    store.validateState(false);
    return store;
  }

  static fromLegacy(legacyDir: string, options: ProfileStoreOptions = {}): ProfileStore {
    validateTrustedDirectoryPath(legacyDir);
    if (basename(resolve(legacyDir)) !== "dsmm-profiles") throw new DsmmProfileError("unsafe-path", "The legacy store must be the Host's exact dsmm-profiles directory.");
    const root = resolve(legacyDir);
    const trusted: TrustedStoreOptions = { ...options, [trustedLayout]: { origin: "legacy", stateDir: root } };
    const store = new ProfileStore(root, trusted);
    store.validateRoot(false);
    return store;
  }

  async describe(): Promise<ProfileSnapshot & ProfileStoreMetadata> {
    return this.readOperation(() => {
      const entries = this.inventory();
      const profiles: ProfileSummary[] = entries.map((name) => {
        const id = name.slice(0, -6);
        try {
          validateProfileId(id);
          if (name !== `${id}.jsonc`) throw new DsmmProfileError("unsafe-path", "Profile filename must use lowercase .jsonc and match its ID.");
          const draft = this.draft(id, entries);
          return { id, ...(draft.document.label === undefined ? {} : { label: draft.document.label.trim() === "" ? id : draft.document.label }), revision: draft.revision, ...warningFields(draft) };
        } catch (error) {
          return { id: safeInventoryId(id), revision: null, error: profileErrorInfo(error) };
        }
      });
      try {
        const selected = this.selection();
        return { ...this.metadata(), profiles, selectedId: selected.selectedId, appliedRevision: selected.appliedRevision, selectionRevision: selected.selectionRevision, ...(selected.sourceRevision === undefined ? {} : { sourceRevision: selected.sourceRevision }), ...(selected.warnings === undefined ? {} : { selectedWarnings: selected.warnings }) };
      } catch (error) {
        // An error is not a successful fallback to the baseline.
        return { ...this.metadata(), profiles, selectedId: null, appliedRevision: null, selectionRevision: "unavailable", selectionError: profileErrorInfo(error, "corrupt-selection") };
      }
    });
  }

  async read(id: string): Promise<ProfileReadResult> {
    validateProfileId(id);
    return this.readOperation(() => this.readResult(this.draft(id, this.inventory())));
  }

  /** The optional fence belongs to the trusted server caller, never the saved document. */
  async save(request: ProfileSaveRequest, assertCurrent?: () => void): Promise<ProfileReadResult> {
    this.assertWritable();
    assertCurrent?.();
    validateProfileId(request.id);
    const document = parseProfileDocument(request.content, request.id);
    const warnings = validateProfileDocument(request.content, request.id).diagnostics;
    if (request.expectedRevision !== null) validateProfileRevision(request.expectedRevision);
    return this.locked((assertLock) => {
      assertCurrent?.();
      const entries = this.inventory();
      const name = this.draftName(request.id, entries);
      const current = name === undefined ? undefined : this.draft(request.id, entries);
      if ((current?.revision ?? null) !== request.expectedRevision) conflict("The profile changed since it was opened. Reload it before saving.");
      if (current === undefined && entries.length >= MAX_PROFILE_COUNT) throw new DsmmProfileError("limit", "At most 128 Deepwork profiles are supported.");
      const bytes = Buffer.from(request.content, "utf8");
      const target = join(this.profileDir, `${request.id}.jsonc`);
      const owned = this.atomicReplace(target, bytes, () => {
        const latestNames = this.inventory();
        const latest = this.draftName(request.id, latestNames) === undefined ? null : this.draft(request.id, latestNames).revision;
        if (latest !== request.expectedRevision) conflict("The profile was edited externally during save. Reload it before saving.");
      }, assertLock, assertCurrent);
      const observed = observeCommitted(target, owned, this.observe);
      return { ...this.readResult({ content: request.content, revision: observed.revision, document, ...(warnings.length ? { warnings } : {}) }), ...observed };
    });
  }

  async loadSelection(): Promise<LoadedProfileSelection> {
    return this.readOperation(() => this.selection());
  }

  async loadSessionSelection(sessionId: string): Promise<LoadedSessionProfileSelection> {
    validateSessionProfileId(sessionId);
    return this.readOperation(() => this.sessionSelection(sessionId));
  }

  async selectSession<T>(request: SessionProfileSelectRequest, epoch: string,
    validateCandidate: (document: DsmmProfileDocument | null) => T | Promise<T>,
    commit: SessionProfileCommit<T>): Promise<{ selection: LoadedSessionProfileSelection; prepared: T }> {
    this.assertWritable();
    validateSessionProfileId(request.sessionId);
    validateSelectionRequest(request);
    validateAdmissionEpoch(epoch);
    return this.locked(async (assertLock) => {
      commit.assertCurrent();
      if (this.sessionSelection(request.sessionId).selectionRevision !== request.expectedSelectionRevision) conflict("The session profile changed. Refresh before selecting again.");
      const draft = request.id === null ? undefined : this.draft(request.id, this.inventory());
      if (draft !== undefined && draft.revision !== request.expectedRevision) conflict("The profile changed before selection. Reload and select its latest revision.");
      let prepared: T;
      try { prepared = await validateCandidate(draft === undefined ? null : structuredClone(draft.document)); }
      catch (error) {
        if (error instanceof DsmmProfileError) throw error;
        throw new DsmmProfileError("activation", "The candidate profile could not be activated; the previous session selection was retained.");
      }
      const directory = join(this.stateDir, ".sessions");
      const target = join(directory, `${sessionChoiceKey(request.sessionId)}.json`);
      const fence = (temporary?: string): void => {
        commit.assertCurrent();
        if (this.sessionSelection(request.sessionId, temporary).selectionRevision !== request.expectedSelectionRevision) conflict("The session selection was edited externally. Refresh before selecting again.");
        if (draft !== undefined && this.draft(request.id!, this.inventory()).revision !== draft.revision) conflict("The draft changed during activation. Reload and select again.");
        validateDirectories(directory, false, false, this.identities);
        // The one exclusive atomic staging file is not a session choice.
        const entries = boundedEntries(directory, MAX_SESSION_PROFILE_CHOICES + (temporary === undefined ? 0 : 1))
          .filter((name) => temporary === undefined || name !== basename(temporary));
        if (status(target) === undefined && entries.length >= MAX_SESSION_PROFILE_CHOICES) throw new DsmmProfileError("limit", "The session profile choice inventory is full; no selection was committed.");
      };
      assertLock();
      commit.assertCurrent();
      validateDirectories(directory, true, false, this.identities);
      fence();
      const revision = draft === undefined ? null : this.publishRevision(draft, assertLock);
      const source = draft === undefined ? {} : { sourceRevision: draft.revision };
      const pointer: SessionSelectionPointer = { version: 2, sessionId: request.sessionId, id: request.id, revision, epoch, ...source };
      const bytes = Buffer.from(`${JSON.stringify(pointer)}\n`, "utf8");
      const selection: LoadedSessionProfileSelection = { sessionId: request.sessionId, admissionEpoch: epoch,
        selectedId: request.id, appliedRevision: revision, selectionRevision: "unavailable", document: draft?.document ?? null, content: draft?.content ?? null, ...source, ...warningFields(draft) };
      try { await commit.prepare?.(selection, prepared); }
      catch (error) {
        if (error instanceof DsmmProfileError) throw error;
        throw new DsmmProfileError("activation", "The candidate installation could not be prepared; the previous session selection was retained.");
      }
      const owned = this.atomicReplace(target, bytes, fence, assertLock);
      commit.committed(selection, prepared);
      const observed = observeCommitted(target, owned, this.observe);
      selection.selectionRevision = observed.revision;
      if (observed.refreshRequired) selection.refreshRequired = true;
      return { selection, prepared };
    });
  }

  async select<T = undefined>(request: ProfileSelectRequest, validateCandidate?: (document: DsmmProfileDocument | null) => T | Promise<T>, commit?: ProfileCommit<T>, assertCurrent?: () => void): Promise<{ selection: LoadedProfileSelection; prepared: T }> {
    this.assertWritable();
    assertCurrent?.();
    validateSelectionRequest(request);
    return this.locked(async (assertLock) => {
      assertCurrent?.();
      const current = this.selection();
      if (current.selectionRevision !== request.expectedSelectionRevision) conflict("The selected profile changed. Refresh before selecting again.");
      const draft = request.id === null ? undefined : this.draft(request.id, this.inventory());
      if (draft !== undefined && draft.revision !== request.expectedRevision) conflict("The profile changed before selection. Reload and select its latest revision.");
      let prepared: T;
      try {
        prepared = await validateCandidate?.(draft === undefined ? null : structuredClone(draft.document)) as T;
      } catch (error) {
        if (error instanceof DsmmProfileError) throw error;
        throw new DsmmProfileError("activation", "The candidate profile could not be activated; the previous selection was retained.");
      }
      // The audit may await native work. Recheck security and CAS afterwards.
      assertCurrent?.();
      assertLock();
      this.assertSelectionRevision(request.expectedSelectionRevision);
      if (draft !== undefined && this.draft(request.id!, this.inventory()).revision !== draft.revision) conflict("The draft changed during activation. Reload and select again.");
      const revision = draft === undefined ? null : this.publishRevision(draft, assertLock);
      const source = draft === undefined ? {} : { sourceRevision: draft.revision };
      const pointer: SelectionPointer = { version: 2, id: request.id, revision, ...source };
      const bytes = Buffer.from(`${JSON.stringify(pointer)}\n`, "utf8");
      this.validateState(true);
      const selection: LoadedProfileSelection = { selectedId: request.id, appliedRevision: revision, selectionRevision: "unavailable", document: draft?.document ?? null, content: draft?.content ?? null, ...source, ...warningFields(draft) };
      commit?.prepare(selection, prepared);
      const target = join(this.stateDir, ".selection.json");
      const owned = this.atomicReplace(target, bytes, () => {
        this.assertSelectionRevision(request.expectedSelectionRevision);
        if (draft !== undefined && this.draft(request.id!, this.inventory()).revision !== draft.revision) conflict("The draft changed during selection. Reload and select again.");
      }, assertLock, assertCurrent);
      commit?.committed(selection, prepared);
      const observed = observeCommitted(target, owned, this.observe);
      selection.selectionRevision = observed.revision;
      if (observed.refreshRequired) selection.refreshRequired = true;
      return { selection, prepared };
    });
  }

  private readResult(draft: Pick<ProfileDraft, "document" | "revision" | "content" | "warnings">): ProfileReadResult {
    return { id: draft.document.id, ...(draft.document.label === undefined ? {} : { label: draft.document.label }), revision: draft.revision, content: draft.content, ...warningFields(draft) };
  }

  private inventory(): string[] {
    if (!this.validateRoot(false)) return [];
    const names = boundedEntries(this.profileDir, MAX_PROFILE_DIRECTORY_ENTRIES).filter((name) => !name.startsWith(".") && /\.jsonc$/iu.test(name)).sort();
    if (names.length > MAX_PROFILE_COUNT) throw new DsmmProfileError("limit", "Profile inventory exceeds the 128-profile limit.");
    const seen = new Set<string>();
    for (const name of names) {
      const key = name.toLowerCase();
      if (seen.has(key)) throw new DsmmProfileError("unsafe-path", "Profile filenames collide case-insensitively; rename the conflicting files manually.");
      seen.add(key);
    }
    return names;
  }

  private draftName(id: string, entries: string[]): string | undefined {
    const expected = `${id}.jsonc`;
    const found = entries.find((name) => name.toLowerCase() === expected);
    if (found !== undefined && found !== expected) throw new DsmmProfileError("unsafe-path", "An existing profile has a conflicting filename case; rename it manually.");
    return found;
  }

  private draft(id: string, entries: string[]): ProfileDraft {
    validateProfileId(id);
    const name = this.draftName(id, entries);
    if (name === undefined) throw new DsmmProfileError("not-found", "The requested Deepwork profile does not exist.");
    const file = regularFile(join(this.profileDir, name), MAX_PROFILE_BYTES);
    return { ...file, ...validatedProfile(file.content, id) };
  }

  private selection(): LoadedProfileSelection {
    this.validateRoot(false);
    this.validateState(false);
    const path = join(this.stateDir, ".selection.json");
    if (status(path) === undefined) {
      if (this.origin === "legacy") throw new DsmmProfileError("corrupt-selection", "The legacy selection is missing. Restore its original pointer and immutable revision explicitly.");
      return { selectedId: null, appliedRevision: null, selectionRevision: ABSENT_PROFILE_SELECTION_REVISION, document: null, content: null };
    }
    try {
      const file = regularFile(path, 1024);
      const pointer = parseSelectionPointer(file.content);
      if (pointer.id === null) return { selectedId: null, appliedRevision: null, selectionRevision: file.revision, document: null, content: null };
      validateDirectories(join(this.profileDir, ".revisions"), false);
      const immutable = regularFile(join(this.profileDir, ".revisions", `${pointer.revision}.jsonc`), MAX_PROFILE_BYTES);
      assertPointerVersion(path, file);
      return { selectedId: pointer.id, appliedRevision: pointer.revision, selectionRevision: file.revision, ...(pointer.sourceRevision === undefined ? {} : { sourceRevision: pointer.sourceRevision }), ...validatedProfile(immutable.content, pointer.id), content: immutable.content };
    } catch (error) {
      if (error instanceof DsmmProfileError && (error.code === "unsafe-path" || error.code === "conflict")) throw error;
      if (error instanceof DsmmProfileError && error.reason !== undefined) throw new DsmmProfileError("corrupt-selection", error.message, error.field, error.reason, error.location);
      throw new DsmmProfileError("corrupt-selection", "The selected profile pointer or immutable revision is missing or invalid. Repair it explicitly; the baseline was not silently selected.");
    }
  }

  private sessionSelection(sessionId: string, temporary?: string): LoadedSessionProfileSelection {
    this.validateRoot(false);
    this.validateState(false);
    const absent: LoadedSessionProfileSelection = { sessionId, admissionEpoch: null, selectedId: null, appliedRevision: null,
      selectionRevision: ABSENT_PROFILE_SELECTION_REVISION, document: null, content: null };
    const directory = join(this.stateDir, ".sessions");
    if (status(directory) === undefined) return absent;
    validateDirectories(directory, false);
    const entries = boundedEntries(directory, MAX_SESSION_PROFILE_CHOICES + (temporary === undefined ? 0 : 1))
      .filter((name) => temporary === undefined || name !== basename(temporary));
    if (entries.length > MAX_SESSION_PROFILE_CHOICES) throw new DsmmProfileError("limit", "The session profile choice inventory exceeds its supported limit.");
    const path = join(directory, `${sessionChoiceKey(sessionId)}.json`);
    if (status(path) === undefined) return absent;
    try {
      const file = regularFile(path, 2048);
      const pointer = parseSessionSelectionPointer(file.content, sessionId);
      if (pointer.id === null) return { ...absent, admissionEpoch: pointer.epoch, selectionRevision: file.revision };
      validateDirectories(join(this.profileDir, ".revisions"), false);
      const immutable = regularFile(join(this.profileDir, ".revisions", `${pointer.revision}.jsonc`), MAX_PROFILE_BYTES);
      assertPointerVersion(path, file);
      return { sessionId, admissionEpoch: pointer.epoch, selectedId: pointer.id, appliedRevision: pointer.revision,
        selectionRevision: file.revision, ...(pointer.sourceRevision === undefined ? {} : { sourceRevision: pointer.sourceRevision }), ...validatedProfile(immutable.content, pointer.id), content: immutable.content };
    } catch (error) {
      if (error instanceof DsmmProfileError && (error.code === "unsafe-path" || error.code === "conflict")) throw error;
      if (error instanceof DsmmProfileError && error.reason !== undefined) throw new DsmmProfileError("corrupt-selection", error.message, error.field, error.reason, error.location);
      throw new DsmmProfileError("corrupt-selection", "The session profile choice or immutable revision is missing or invalid. Repair it explicitly; no global or baseline fallback was admitted.");
    }
  }

  private assertSelectionRevision(expected: string): void {
    if (this.selection().selectionRevision !== expected) conflict("The selection was edited externally. Refresh before selecting again.");
  }

  private publishRevision(draft: ProfileDraft, assertLock: () => void): string {
    assertLock();
    const directory = join(this.profileDir, ".revisions");
    validateDirectories(directory, true);
    const revision = `snapshot-v1-${randomUUID()}`;
    const path = join(directory, `${revision}.jsonc`);
    if (boundedEntries(directory, MAX_PROFILE_REVISIONS).length >= MAX_PROFILE_REVISIONS) throw new DsmmProfileError("limit", "The immutable revision inventory is full; no selection was committed.");
    let fd: number | undefined;
    let created = false;
    try {
      assertLock();
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      created = true;
      writeAll(fd, draft.bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (created) unlinkSync(path);
      throw error;
    }
    return revision;
  }

  private atomicReplace(target: string, bytes: Buffer, beforeRename: (temporary: string) => void, assertLock: () => void, assertCurrent?: () => void): BigIntStats {
    return atomicReplace(target, bytes, beforeRename, () => {
      assertLock();
      validateDirectories(dirname(target), false, false, this.identities);
    }, this.rename, assertCurrent);
  }

  private validateRoot(create: boolean): boolean {
    if (this.hostProfile !== undefined) validateDirectories(this.hostProfile, false, false, this.identities);
    if (!validateDirectories(this.profileDir, create, this.origin === "central", this.identities)) return false;
    const current = lstatSync(this.profileDir);
    if (this.rootIdentity !== undefined && !sameFile(this.rootIdentity, current)) {
      throw new DsmmProfileError("unsafe-path", "The profile storage directory was replaced during this Host's lifetime; no operation was committed.");
    }
    this.rootIdentity ??= current;
    return true;
  }

  private validateState(create: boolean): boolean {
    return validateDirectories(this.stateDir, create, this.origin === "central", this.identities);
  }

  private metadata(): ProfileStoreMetadata {
    return { origin: this.origin, readOnly: this.origin === "legacy", ...(this.origin === "legacy" ? { writeRestriction: LEGACY_WRITE_RESTRICTION } : {}) };
  }
  get readOnly(): boolean { return this.origin === "legacy"; }
  get writeRestriction(): string | undefined { return this.readOnly ? LEGACY_WRITE_RESTRICTION : undefined; }

  private assertWritable(): void {
    if (this.origin === "legacy") throw new DsmmProfileError("unavailable", LEGACY_WRITE_RESTRICTION);
  }

  /** Host-only immutable state. No RPC exposes this writer or a filesystem path. */
  async createChildAdmission(input: ChildAdmissionCapture, assertCurrent?: () => void): Promise<ChildAdmissionCapture> {
    this.assertWritable();
    const capture = parseChildAdmissionCapture(input);
    if (capture.version !== 3) throw new DsmmProfileError("validation", "New child admissions require capture v3.");
    const revision = digest(Buffer.from(JSON.stringify(capture), "utf8"));
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, revision, capture })}\n`, "utf8");
    if (bytes.length > MAX_PROFILE_BYTES) throw new DsmmProfileError("limit", "Child admission exceeds the supported size.");
    return this.locked(assertLock => {
      // The Host's synchronous admission fence runs after lock acquisition and
      // before any child namespace or record write; this operation never awaits.
      assertLock(); assertCurrent?.();
      const directory = join(this.stateDir, ".children", "v1");
      this.validateState(true);
      validateDirectories(directory, true, false, this.identities);
      const path = join(directory, `${sessionChoiceKey(capture.childSessionId)}.json`);
      const existing = this.childAdmission(capture.childSessionId, capture.parentSessionId);
      if (existing !== null) {
        if (JSON.stringify(existing) !== JSON.stringify(capture)) conflict("An immutable child admission already exists; it cannot be overwritten.");
        return existing;
      }
      if (boundedEntries(directory, MAX_SESSION_PROFILE_CHOICES).length >= MAX_SESSION_PROFILE_CHOICES) throw new DsmmProfileError("limit", "The child admission inventory is full.");
      assertLock();
      let fd: number | undefined, owned: Stats | undefined;
      try {
        fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        owned = fstatSync(fd);
        assertRegular(owned);
        writeAll(fd, bytes);
        fsyncSync(fd);
        assertLock();
        validateDirectories(directory, false, false, this.identities);
        const named = status(path);
        if (named === undefined || !sameFile(owned, named)) conflict("Child admission identity changed during creation.");
        return capture;
      } catch (error) {
        if (owned !== undefined) {
          try { assertLock(); const named = status(path); if (named !== undefined && sameFile(owned, named)) unlinkSync(path); } catch { /* Preserve a replacement or an invalidated root. */ }
        }
        throw error;
      } finally { if (fd !== undefined) closeSync(fd); }
    });
  }

  async readChildAdmission(childId: string, parentId: string): Promise<ChildAdmissionCapture | null> {
    validateSessionProfileId(childId); validateSessionProfileId(parentId);
    return this.readOperation(() => this.childAdmission(childId, parentId));
  }

  /** Only a trusted native session-deleted handler may call this; drain never does. */
  async deleteChildAdmission(childId: string, parentId: string): Promise<void> {
    this.assertWritable(); validateSessionProfileId(childId); validateSessionProfileId(parentId);
    await this.locked(assertLock => {
      const capture = this.childAdmission(childId, parentId);
      if (capture === null) return;
      const path = join(this.stateDir, ".children", "v1", `${sessionChoiceKey(childId)}.json`);
      const file = regularFile(path, MAX_PROFILE_BYTES), owned = lstatSync(path);
      assertLock();
      if (!sameFile(owned, lstatSync(path)) || !regularFile(path, MAX_PROFILE_BYTES).bytes.equals(file.bytes)) conflict("Child capture changed before native deletion cleanup.");
      unlinkSync(path);
    });
  }

  private childAdmission(childId: string, parentId: string): ChildAdmissionCapture | null {
    this.validateRoot(false); this.validateState(false);
    const directory = join(this.stateDir, ".children", "v1");
    // Validate an existing parent sidecar directory even if the version path is absent.
    if (!validateDirectories(join(this.stateDir, ".children"), false, true, this.identities)) return null;
    if (boundedEntries(join(this.stateDir, ".children"), 16).some(name => name !== "v1")) throw new DsmmProfileError("corrupt-selection", "The child capture namespace has an unsupported version; legacy recovery is not allowed.");
    if (!validateDirectories(directory, false, true, this.identities)) return null;
    const path = join(directory, `${sessionChoiceKey(childId)}.json`);
    if (status(path) === undefined) return null;
    const file = regularFile(path, MAX_PROFILE_BYTES);
    try {
      const inspected = inspectJsonDocument(file.content, false);
      if (inspected.diagnostics.length) throw new Error("Invalid child JSON");
      const envelope = JSON.parse(file.content) as Record<string, unknown>;
      if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope) || Object.keys(envelope).length !== 3 || envelope.version !== 1 || !Object.hasOwn(envelope, "revision") || !Object.hasOwn(envelope, "capture")) throw new Error("Invalid capture envelope");
      validateAdmissionEpoch(envelope.revision, "revision");
      if (digest(Buffer.from(JSON.stringify(envelope.capture), "utf8")) !== envelope.revision) throw new Error("Capture integrity mismatch");
      const capture = parseChildAdmissionCapture(envelope.capture);
      if (capture.childSessionId !== childId || capture.parentSessionId !== parentId) throw new Error("Child capture identity mismatch");
      return capture;
    } catch { throw new DsmmProfileError("corrupt-selection", "The existing child admission is invalid; legacy recovery is not allowed."); }
  }

  private async readOperation<T>(operation: () => T): Promise<T> {
    if (this.origin === "explicit") return this.locked(operation);
    try {
      const result = operation();
      this.validateRoot(false);
      this.validateState(false);
      return result;
    } catch (error) {
      if (error instanceof DsmmProfileError) throw error;
      throw new DsmmProfileError("io", "Deepwork profile storage could not be read safely.");
    }
  }

  private async locked<T>(operation: (assertLock: () => void) => T | Promise<T>): Promise<T> {
    this.assertWritable();
    return locked(this.profileDir, ".lock", (create) => { this.validateRoot(create); }, this.timeoutMs, this.pollMs, operation);
  }
}

async function locked<T>(directory: string, lockName: string, validateRoot: (create: boolean) => void, timeoutMs: number, pollMs: number,
  operation: (assertLock: () => void) => T | Promise<T>): Promise<T> {
    let fd: number | undefined;
    let ownedStatus: Stats | undefined;
    let ownedBytes: Buffer | undefined;
    const lockPath = join(directory, lockName);
    const assertLock = (): void => {
      validateRoot(false);
      const current = status(lockPath);
      if (fd === undefined || ownedStatus === undefined || ownedBytes === undefined || current === undefined || !sameFile(ownedStatus, current) || !sameFile(ownedStatus, fstatSync(fd))) {
        conflict("Profile lock ownership changed during this operation. No selection was committed; retry after the current owner finishes.");
      }
      assertRegular(current);
      assertRegular(fstatSync(fd));
      if (!regularFile(lockPath, 256).bytes.equals(ownedBytes)) conflict("The profile lock was altered during this operation. No selection was committed; retry after the current owner finishes.");
    };
    try {
      validateRoot(true);
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        validateRoot(false);
        try {
          fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
          ownedStatus = fstatSync(fd);
          ownedBytes = Buffer.from(`${process.pid} ${randomUUID()}\n`, "utf8");
          writeAll(fd, ownedBytes);
          fsyncSync(fd);
          break;
        } catch (error) {
          if (fd !== undefined || errorCode(error) !== "EEXIST") throw error;
          const existing = status(lockPath);
          if (existing !== undefined) assertRegular(existing);
          if (performance.now() >= deadline) throw new DsmmProfileError("lock-timeout", "Another process owns the profile lock. Retry after it finishes; locks are never stolen.");
          await new Promise<void>((done) => setTimeout(done, Math.min(pollMs, Math.max(1, deadline - performance.now()))));
        }
      }
      assertLock();
      return await operation(assertLock);
    } catch (error) {
      if (error instanceof DsmmProfileError) throw error;
      throw new DsmmProfileError("io", "Deepwork profile storage failed. Existing files and the previous selection were retained.");
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* A committed pointer must remain a successful transaction. */ }
        try {
          validateRoot(false);
          const current = status(lockPath);
          if (ownedStatus !== undefined && ownedBytes !== undefined && current !== undefined && sameFile(ownedStatus, current) && current.isFile() && !current.isSymbolicLink() && regularFile(lockPath, 256).bytes.equals(ownedBytes)) unlinkSync(lockPath);
        } catch { /* Do not delete a replacement lock or traverse an altered root. */ }
      }
    }
}

function atomicReplace(target: string, bytes: Buffer, beforeRename: (temporary: string) => void, assertAuthority: () => void,
  rename: (source: string, destination: string) => void, assertCurrent?: () => void): BigIntStats {
  assertAuthority();
  if (status(target) !== undefined) assertRegular(status(target)!);
  const temporary = join(dirname(target), `.dsmm-tmp-${randomUUID()}`);
  let fd: number | undefined;
  let created = false;
  let owned: Stats | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    owned = fstatSync(fd);
    const ownedIdentity = fstatSync(fd, { bigint: true });
    assertRegular(owned);
    writeAll(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertAuthority();
    if (status(target) !== undefined) assertRegular(status(target)!);
    beforeRename(temporary);
    assertAuthority();
    const staged = regularFile(temporary, bytes.length);
    if (!sameFile(owned, lstatSync(temporary)) || !staged.bytes.equals(bytes)) conflict("The staged file changed before commit. No file was replaced.");
    assertCurrent?.();
    rename(temporary, target);
    created = false;
    return ownedIdentity;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) {
      try {
        assertAuthority();
        const current = status(temporary);
        if (owned !== undefined && current !== undefined && sameFile(owned, current)) unlinkSync(temporary);
      } catch { /* Never traverse an altered root or remove another owner's staging file. */ }
    }
  }
}

function validateTrustedDirectoryPath(path: string): void {
  if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)
    || Buffer.from(path, "utf8").toString("utf8") !== path || dirname(resolve(path)) === resolve(path)) {
    throw new DsmmProfileError("unsafe-path", "A bounded absolute trusted Host directory is required.");
  }
}

function trustedHome(home: string): string {
  validateTrustedDirectoryPath(home);
  const root = resolve(home);
  validateDirectories(root, false, true);
  return root;
}

/** @internal Shared only by the fixed config file adapter; not a wire-path storage API. */
export const profileStoreFilePrimitives = { trustedHome, validateDirectories, status, regularFile, observeCommitted, boundedOption, locked, atomicReplace };

function statRevision(stat: BigIntStats): string { return `stat-v1-${stat.mtimeNs}-${stat.ctimeNs}`; }
function assertPointerVersion(path: string, file: ProfileFile): void {
  if (observeCommitted(path, file.identity).revision !== file.revision) conflict("The selection version changed while reading its snapshot.");
}
function observeCommitted(path: string, owned: BigIntStats, observe?: (path: string) => void): { revision: string; refreshRequired?: true } {
  try {
    observe?.(path);
    validateDirectories(dirname(path), false);
    const named = lstatSync(path, { bigint: true });
    assertRegular(named);
    if (named.dev !== owned.dev || named.ino !== owned.ino) throw new Error("Committed target was replaced");
    return { revision: statRevision(named) };
  } catch { return { revision: "unavailable", refreshRequired: true }; }
}

function boundedOption(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new DsmmProfileError("validation", "Profile lock timing is outside supported bounds.");
  return value;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function status(path: string): Stats | undefined {
  try { return lstatSync(path); } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function validateDirectories(directory: string, create: boolean, allowMissing = false, identities?: DirectoryIdentities): boolean {
  const absolute = resolve(directory);
  const root = parse(absolute).root;
  const parts: string[] = [];
  for (let current = absolute; current !== root; current = dirname(current)) parts.unshift(current);
  parts.unshift(root);
  for (const path of parts) {
    let found = status(path);
    if (found === undefined && identities?.has(path)) throw new DsmmProfileError("unsafe-path", "A pinned storage directory disappeared; storage authority was invalidated.");
    if (found === undefined && create) {
      try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
      found = status(path);
    }
    if (found === undefined && allowMissing) {
      return false;
    }
    if (found === undefined || found.isSymbolicLink() || !found.isDirectory()) throw new DsmmProfileError("unsafe-path", "Profile directories and every ancestor must be real directories, not links or junctions.");
    const canonical = resolve(realpathSync(path));
    if ((process.platform === "win32" ? canonical.toLowerCase() : canonical) !== (process.platform === "win32" ? path.toLowerCase() : path)) {
      throw new DsmmProfileError("unsafe-path", "Profile storage must not traverse redirected directories or reparse points.");
    }
    const pinned = identities?.get(path);
    if (pinned !== undefined && !sameFile(pinned, found)) throw new DsmmProfileError("unsafe-path", "A storage directory was replaced; storage authority was invalidated.");
    identities?.set(path, found);
  }
  return true;
}

function assertRegular(found: Stats | BigIntStats): void {
  if (found.isSymbolicLink() || !found.isFile() || (found.nlink !== 1 && found.nlink !== 1n)) throw new DsmmProfileError("unsafe-path", "Profile files and lock files must be regular, unlinked files, not symlinks, junctions, directories or hard links.");
}

function sameFile(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function regularFile(path: string, maximum: number): ProfileFile {
  validateDirectories(dirname(path), false);
  const before = status(path);
  if (before === undefined) throw new DsmmProfileError("not-found", "The required profile file does not exist.");
  assertRegular(before);
  if (before.size > maximum) throw new DsmmProfileError("limit", "Profile storage contains an oversized file.");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    validateDirectories(dirname(path), false);
    const opened = fstatSync(fd);
    const openedVersion = fstatSync(fd, { bigint: true });
    assertRegular(opened);
    if (!sameFile(before, opened)) conflict("The profile file changed while it was opened. Retry the operation.");
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, size);
      if (count === 0) break;
      size += count;
    }
    if (size > maximum) throw new DsmmProfileError("limit", "Profile storage contains an oversized file.");
    const after = fstatSync(fd);
    const afterVersion = fstatSync(fd, { bigint: true });
    const named = status(path);
    const namedVersion = lstatSync(path, { bigint: true });
    validateDirectories(dirname(path), false);
    assertRegular(after);
    if (named !== undefined) assertRegular(named);
    if (named === undefined || !sameFile(opened, named) || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) conflict("The profile file was edited while being read. Retry the operation.");
    if (statRevision(openedVersion) !== statRevision(afterVersion) || statRevision(afterVersion) !== statRevision(namedVersion) || afterVersion.ino !== namedVersion.ino || afterVersion.dev !== namedVersion.dev) conflict("The file version changed while being read.");
    const bytes = buffer.subarray(0, size);
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new DsmmProfileError("validation", "Profile files must contain valid UTF-8 text.", "content"); }
    return { bytes, content, revision: statRevision(afterVersion), identity: afterVersion };
  } finally { closeSync(fd); }
}

function boundedEntries(directory: string, maximum: number): string[] {
  const handle = opendirSync(directory);
  const entries: string[] = [];
  try {
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      if (entries.length >= maximum) throw new DsmmProfileError("limit", "Profile storage inventory exceeds its supported limit.");
      entries.push(entry.name);
    }
  } finally { handle.closeSync(); }
  return entries;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (count === 0) throw new Error("Incomplete profile file write");
    offset += count;
  }
}

function parseSelectionPointer(content: string): SelectionPointer {
  const errors: ParseError[] = [];
  const tree = parseTree(content, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  if (tree?.type !== "object" || errors.length > 0) throw new DsmmProfileError("corrupt-selection", "The selected profile pointer must contain unique fields in valid JSON.");
  let input: unknown;
  try { input = JSON.parse(content) as unknown; } catch { throw new DsmmProfileError("corrupt-selection", "The selected profile pointer is not valid JSON."); }
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new DsmmProfileError("corrupt-selection", "The selected profile pointer must be a versioned object.");
  const record = input as Record<string, unknown>;
  const allowed = ["version", "id", "revision", ...record.version === 2 ? ["sourceRevision"] : []];
  if (tree.children?.length !== Object.keys(record).length || !["version", "id", "revision"].every((key) => Object.hasOwn(record, key)) || Object.keys(record).some(key => !allowed.includes(key)) || (record.version !== 1 && record.version !== 2)) throw new DsmmProfileError("corrupt-selection", "The selected profile pointer has an unsupported shape or version.");
  if (record.id === null && record.revision === null && !Object.hasOwn(record, "sourceRevision")) return { version: record.version, id: null, revision: null };
  validateProfileId(record.id);
  if (!isProfileReference(record.revision)) throw new DsmmProfileError("corrupt-selection", "Invalid snapshot reference.");
  if (record.version === 1) validateAdmissionEpoch(record.revision, "revision");
  if (Object.hasOwn(record, "sourceRevision")) validateProfileRevision(record.sourceRevision, "sourceRevision");
  return { version: record.version, id: record.id, revision: record.revision, ...(typeof record.sourceRevision === "string" ? { sourceRevision: record.sourceRevision } : {}) };
}

export function validateSessionProfileId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.length < 1 || id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id) || Buffer.from(id, "utf8").toString("utf8") !== id) {
    throw new DsmmProfileError("validation", "A bounded native session ID is required.", "sessionId");
  }
}

function sessionChoiceKey(sessionId: string): string { return digest(Buffer.from(sessionId, "utf8")); }

function validateSelectionRequest(request: ProfileSelectRequest): void {
  if (request.id !== null) {
    validateProfileId(request.id);
    validateProfileRevision(request.expectedRevision);
  } else if (request.expectedRevision !== undefined) {
    throw new DsmmProfileError("validation", "Baseline selection must not include a draft revision.", "expectedRevision");
  }
  if (request.expectedSelectionRevision !== ABSENT_PROFILE_SELECTION_REVISION) validateProfileRevision(request.expectedSelectionRevision, "expectedSelectionRevision");
}

function parseSessionSelectionPointer(content: string, sessionId: string): SessionSelectionPointer {
  const errors: ParseError[] = [];
  const tree = parseTree(content, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  if (tree?.type !== "object" || errors.length > 0) throw new DsmmProfileError("corrupt-selection", "The session choice must contain unique fields in valid JSON.");
  const record = JSON.parse(content) as Record<string, unknown>;
  const allowed = ["version", "sessionId", "id", "revision", "epoch", ...record.version === 2 ? ["sourceRevision"] : []];
  if (tree.children?.length !== Object.keys(record).length || Object.keys(record).some(key => !allowed.includes(key)) || !["version", "sessionId", "id", "revision", "epoch"].every((key) => Object.hasOwn(record, key)) || record.sessionId !== sessionId) {
    throw new DsmmProfileError("corrupt-selection", "The session choice identity, shape or version is invalid.");
  }
  validateAdmissionEpoch(record.epoch);
  const selection = parseSelectionPointer(JSON.stringify({ version: record.version, id: record.id, revision: record.revision, ...Object.hasOwn(record, "sourceRevision") ? { sourceRevision: record.sourceRevision } : {} }));
  return { ...selection, sessionId, epoch: record.epoch };
}

function conflict(message: string): never {
  throw new DsmmProfileError("conflict", message);
}

function safeInventoryId(id: string): string {
  return /^[a-zA-Z0-9_-]{1,64}$/u.test(id) ? id : "invalid-profile";
}

function warningFields(value?: { warnings?: ProfileDiagnostic[] }): { warnings?: ProfileDiagnostic[] } {
  return value?.warnings === undefined ? {} : { warnings: value.warnings };
}
function validatedProfile(content: string, id: string): { document: DsmmProfileDocument; warnings?: ProfileDiagnostic[] } {
  const result = validateProfileDocument(content, id);
  if (result.document === undefined) parseProfileDocument(content, id);
  return { document: result.document!, ...(result.diagnostics.length ? { warnings: result.diagnostics } : {}) };
}
