import assert from "node:assert/strict";
import { test } from "node:test";
import { TYPERT_REMOTE } from "../src/profile-remote.ts";

test("session RPC preserves independent action capabilities and rejects ambiguous capability data", () => {
  const selection = { selectedId: null, appliedRevision: null, selectionRevision: "absent" };
  const snapshot = {
    sessionId: "profile-actions", globalDefault: selection, selection,
    scope: "global-default", admissionEpoch: "a".repeat(64), switchAllowed: false,
    canSelectModel: true, canToggleMode: false, canApplyOverlay: false,
    toggleModeUnavailableReason: "maintenance", applyOverlayUnavailableReason: "new-session-required",
  };
  for (const method of ["describeSession", "selectSession", "selectMode"]) {
    const descriptor = TYPERT_REMOTE.descriptors.find(row => row.service === "dsmmProfiles" && row.method === method);
    assert.ok(descriptor?.result?.mode === "strict");
    const codec = descriptor.result.create();
    assert.deepEqual(codec.parse(snapshot), snapshot);
    assert.deepEqual(codec.parse({ ...snapshot, canSelectModel: false, selectModelUnavailableReason: "model-service-unavailable" }),
      { ...snapshot, canSelectModel: false, selectModelUnavailableReason: "model-service-unavailable" });
    for (const field of ["canSelectModel", "canToggleMode", "canApplyOverlay"] as const) {
      assert.throws(() => codec.parse({ ...snapshot, [field]: undefined }));
      assert.throws(() => codec.parse({ ...snapshot, [field]: "true" }));
    }
    assert.throws(() => codec.parse({ ...snapshot, applyOverlayUnavailableReason: "unknown" }));
  }
});
