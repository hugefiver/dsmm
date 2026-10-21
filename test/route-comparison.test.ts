import assert from "node:assert/strict";
import { test } from "node:test";
import type { DsmmInvocationView, DsmmRoleRouteComparison } from "../src/profile-types.ts";
import type { ChildSessionSnapshot, RoleControlChildView, RoleControlDescendantsSnapshot } from "../src/role-control-types.ts";
import { nativeControlFixture, gate, ROLE_CONTROL_REMOTE } from "./role-control-fixture.ts";
import { parseDsmmInvocationView, parseDsmmRoleRouteComparison } from "../src/profile-remote.ts";
import { parseChildSessionSnapshot, parseRoleControlDescendants, ROLE_CONTROL_HOST } from "../src/role-control-remote.ts";

const enabled = { enabled: true } as const;
const epoch = "a".repeat(64);
function comparison(childId = "child"): DsmmRoleRouteComparison {
  return { childId,
    initialRoute: { status: "known", source: "invocation-capture", route: { provider: "fixture", model: "capture/model-v1", reasoningEffort: "max" } },
    liveRoute: { status: "known", source: "own-native-request-header", route: { provider: "fixture:live", model: "live/model-v2", reasoningEffort: "adaptive" } } };
}
function invocation(childId?: string, routeComparison?: DsmmRoleRouteComparison): DsmmInvocationView {
  return { role: "dsmm-coding", label: "Coding", level: "max", routeSource: "level", route: { provider: "fixture", model: "unchanged-route" }, mode: "continuable",
    ...(childId === undefined ? {} : { childId }), ...(routeComparison === undefined ? {} : { routeComparison }) };
}
function child(routeComparison?: DsmmRoleRouteComparison): RoleControlChildView {
  return { id: "child", parentSessionId: "root", mode: "continuable", activity: "inactive", readonly: false,
    controls: { prompt: enabled, interrupt: enabled }, ...(routeComparison === undefined ? {} : { routeComparison }) };
}
function snapshot(row: RoleControlChildView): ChildSessionSnapshot {
  return { sessionId: "root", admissionEpoch: epoch, children: [row], capabilities: {
    prompt: enabled, interrupt: enabled, images: enabled,
    runtime: { binding: "stock", deliveryFenceReady: true, restartRequired: false } } };
}
function descendants(row: RoleControlChildView): RoleControlDescendantsSnapshot {
  return { sessionId: "root", admissionEpoch: epoch, descendants: [{ kind: "child", depth: 1, hasChildren: false, child: row }] };
}
function parsers(method: "describe" | "descendants") {
  return [ROLE_CONTROL_REMOTE.descriptors, ROLE_CONTROL_HOST.invocations].map(descriptors => {
    const codec = descriptors.find(entry => entry.method === method)!.result;
    if (codec.mode !== "strict") throw new Error("Strict result codec required");
    return codec.create().parse;
  });
}
test("comparison codecs preserve distinct initial/live routes and explicit unknown observations", () => {
  for (const value of [comparison(), ...(["no-own-request-header", "invalid-own-request-header", "not-observed"] as const).map(reason => ({ ...comparison(), liveRoute: { status: "unknown" as const, reason } })),
    { ...comparison(), initialRoute: { status: "unknown" as const, reason: "missing-invocation-capture" as const } }]) {
    assert.deepEqual(parseDsmmRoleRouteComparison(value), value);
    const view = invocation("child", value), row = { ...child(value), invocation: view };
    assert.deepEqual(parseDsmmInvocationView(view), view);
    assert.equal(view.route?.model, "unchanged-route");
    assert.deepEqual(parseChildSessionSnapshot(snapshot(row)), snapshot(row));
    assert.deepEqual(parseRoleControlDescendants(descendants(row)), descendants(row));
    for (const parse of parsers("describe")) assert.deepEqual(parse(snapshot(row)), snapshot(row));
    for (const parse of parsers("descendants")) assert.deepEqual(parse(descendants(row)), descendants(row));
  }
  assert.equal(Object.hasOwn(parseChildSessionSnapshot(snapshot(child())).children[0], "invocation"), false);
});
test("closed comparison grammar rejects secrets, malformed enums and foreign child identities", () => {
  const known = comparison();
  for (const value of [[], { ...known, childId: "" }, { ...known, apiKey: "SECRET" }, { ...known, initialRoute: [] },
    { ...known, liveRoute: { status: "unknown", reason: "profile-fallback" } },
    { ...known, liveRoute: { status: "known", source: "parent-request-header", route: {} } },
    { ...known, liveRoute: { status: ["known"], source: { value: "own-native-request-header" }, route: {} } },
    { ...known, initialRoute: { status: "known", source: "invocation-capture", route: { provider: "fixture", model: "x", apiKey: "SECRET" } } }]) {
    assert.throws(() => parseDsmmRoleRouteComparison(value), TypeError);
    for (const parse of parsers("describe")) assert.throws(() => parse(snapshot({ ...child(), routeComparison: value } as RoleControlChildView)), TypeError);
    for (const parse of parsers("descendants")) assert.throws(() => parse(descendants({ ...child(), routeComparison: value } as RoleControlChildView)), TypeError);
  }
  let accessed = false;
  assert.throws(() => parseDsmmRoleRouteComparison({ ...known, get liveRoute() { accessed = true; return known.liveRoute; } }), TypeError);
  assert.equal(accessed, false);
  for (const id of [undefined, "foreign"]) assert.throws(() => parseDsmmInvocationView(invocation(id, known)), TypeError);
  for (const parse of parsers("describe")) assert.throws(() => parse(snapshot(child(comparison("foreign")))), TypeError);
  for (const parse of parsers("descendants")) assert.throws(() => parse(descendants(child(comparison("foreign")))), TypeError);
});
test("Gateway projects the real child invocation and its own observed request without a fallback route", { timeout: 20000 }, async () => {
  const f = await nativeControlFixture(), entered = gate(), held = gate();
  f.adapter.beforeStream = () => { entered.release(); return held.promise; };
  try {
    const root = await f.create(), child = await f.start(root); await entered.promise;
    for (const method of ["describe", "descendants"] as const) {
      const result = await f.invoke(method, { sessionId: root.id }) as ChildSessionSnapshot | RoleControlDescendantsSnapshot;
      const rows = "children" in result ? result.children : result.descendants.flatMap(row => row.kind === "child" ? [row.child] : []);
      assert.equal(rows[0].routeComparison?.childId, child.id);
      assert.equal(rows[0].routeComparison?.initialRoute.status, "known");
      const live = rows[0].routeComparison?.liveRoute;
      assert.ok(live?.status === "known");
      assert.equal(live.route.model, f.adapter.calls[0].model);
      assert.equal(rows[0].invocation?.childId, child.id);
    }
  } finally { held.release(); await f.dispose(); }
});
