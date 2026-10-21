import { createHash } from "node:crypto";

/** Synthetic protocol data for validator tests, never native acceptance or release evidence. */
export function startupProfileFixture(artifactSha256 = "a".repeat(64)) {
  const home = "/tmp/startup-owned/home", hostProfileDir = `${home}/profiles/web`;
  const installedRoot = `${hostProfileDir}/node_modules/@dsmm/dsmm`, entryId = "dsmm";
  const profileDir = `${home}/plugins/dsmm/profiles`;
  const stateDir = `${profileDir}/.state/${createHash("sha256").update(JSON.stringify([hostProfileDir, entryId])).digest("hex")}`;
  const storage = { origin: "central", profileDir, stateDir, entryId, pointerPath: `${stateDir}/.selection.json`, lockPath: `${profileDir}/.lock`, home, hostProfileDir };
  const selection = { selectedId: "startup-lock-12345678-1234-1234-1234-123456789abc", appliedRevision: "b".repeat(64), selectionRevision: "c".repeat(64) };
  const corruptSelection = { contract: "central-read-lock-free-020", scenario: "corrupt-selection", failureCode: "corrupt-selection", artifactSha256, installedRoot, packageVersion: "0.2.0",
    phase: "before-native-loader", pathBasename: ".lock", startupOutcome: "refused", nativeExit: { code: 1, signal: null }, elapsedMs: 2050, processId: 43,
    pointerBeforeSha256: "e".repeat(64), pointerAfterSha256: "e".repeat(64), ownerBeforeSha256: "d".repeat(64), ownerAfterSha256: "d".repeat(64),
    documentBeforeSha256: selection.appliedRevision, documentAfterSha256: selection.appliedRevision, revisionBeforeSha256: selection.appliedRevision, revisionAfterSha256: selection.appliedRevision,
    dsmmRuntimeReady: false, observedOperations: { nativeRequestPreparations: 0, nativeToolDispatches: 0 },
    loaderEntries: [{ id: "dsmm", uid: 188, state: 2 }], loaderIdentity: { entryId, optionsId: "dsmm", name: "@dsmm/dsmm", uid: 188 },
    failedAdmission: { nativeOwnership: "public-parent-fiber-identity", loaderEntryId: "dsmm", loaderFiberUid: 188,
      failedFiber: { uid: 208, name: "installProfiles", state: 3 }, ancestry: [{ uid: 208, name: "installProfiles", state: 3 }, { uid: 188, name: "dsmm", state: 2 }] },
    rootRosterDisposition: "blocked-compositions", nativePresetIds: ["standard", "minimal", "dsmm-orchestrator", "dsmm-planner"],
    rootRoster: [{ id: "dsmm-orchestrator", broken: "synthetic corrupt selection" }, { id: "dsmm-planner", broken: "synthetic corrupt selection" }] };
  const proof = { contract: "central-read-lock-free-020", phase: "before-native-loader", scenario: "stable-selection", startupOutcome: "read-admitted-write-refused",
    artifactSha256, installedRoot, packageVersion: "0.2.0", nativeExit: { code: 0, signal: null }, elapsedMs: 2500, processId: 42, parentProcessId: 41,
    dsmmRuntimeReady: true, runtimeBackendIdentity: true, postAppReady: true, regularOwnedLock: true, rootDisposed: true, storage,
    observedOperations: { nativeRequestPreparations: 0, nativeToolDispatches: 0 },
    loaderEntries: [{ id: "dsmm", name: "@dsmm/dsmm", uid: 188, state: 2 }],
    loaderIdentity: { entryId, optionsId: "dsmm", name: "@dsmm/dsmm", uid: 188, startupEntryId: entryId }, selection, coldReviewCap: 7,
    root: { sessionId: "cold-native-root", admissionEpoch: "f".repeat(64), nativeOrigin: null, nativeParentSession: null, nativeOwnerIds: [], preset: "dsmm-orchestrator", scope: "global-default", ...selection, reviewCap: 7, requestOrToolEvents: 0 },
    write: { operation: "runtime.save", code: "lock-timeout", attemptedContentSha256: "e".repeat(64) },
    bytes: Object.fromEntries(Object.entries({ document: selection.appliedRevision, revision: selection.appliedRevision, pointer: selection.selectionRevision, owner: "d".repeat(64) }).map(([key, hash]) => [key, { beforeSha256: hash, afterSha256: hash }])),
    corruptSelection, restoredPointerSha256: selection.selectionRevision,
    cleanup: { originalPointerSha256: "a".repeat(64), restoredOriginalPointerSha256: "a".repeat(64), ownedLockRemoved: true, ownedDocumentRemoved: true, ownedRevisionRemoved: true } };
  const options = { artifactSha256, installedRoot, version: "0.2.0", sourceContract: "0.2.0", profileStorage: storage, ownedHome: home };
  return { proof, options };
}
