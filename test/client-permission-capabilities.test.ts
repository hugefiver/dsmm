import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";
import { build } from "esbuild";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { NativePermissionCapabilityView } from "../src/permission-native-rules.ts";
import type { PermissionRulesSaveResult } from "../src/permission-rules.ts";
import { parsePermissionRulesResult } from "../src/permission-remote.ts";
import { resolvePermissionControl } from "../src/permission-settings.ts";
import { permissionClient } from "../src/client/permission-client.ts";
import type { PermissionValue } from "../src/client/permission-client.ts";
import { PermissionController, permissionChanges } from "../src/client/permission-controller.ts";

const runtime = { savedRevision: "saved-source", runtimeRevision: "runtime-source", state: "updating" as const, mounted: true, restartRequired: false };
const limits: NativePermissionCapabilityView["limits"] = {
  outsideReads: "tool-call-boundary", finalInode: false, scopedMemory: "not-provided-by-native-rules", webFetch: "native-public-only",
  webSearchDestinations: "unsupported", proxyAddressBinding: "native-proxy-dependent", shellSockets: "native-executor-dependent", providerAuthMcp: "not-covered",
};
const capability = (): NativePermissionCapabilityView => ({ limits, runtime, tools: ["read", "glob", "grep", "shell", "webSearch", "webFetch"].map((kind, index) => ({
  name: `actual-registration-${index}`, kind: kind as NativePermissionCapabilityView["tools"][number]["kind"], approval: "native-once", scopedMemory: false,
})) });
const result = (): PermissionRulesSaveResult => ({ snapshot: { revision: "saved-source", policy: resolvePermissionControl() }, runtime });

test("strict capability codec retains actual registration kinds independently of source layout", async () => {
  const value = { ...result(), capabilities: capability() };
  assert.deepEqual(parsePermissionRulesResult(value), value);
  assert.equal(Object.hasOwn(parsePermissionRulesResult(result()), "capabilities"), false);
  assert.deepEqual(parsePermissionRulesResult({ ...value, capabilities: { ...capability(), tools: [] } }).capabilities!.tools, []);
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/permission-remote.ts", import.meta.url))], bundle: true, platform: "browser", format: "iife", globalName: "PermissionWire", write: false });
  const browser = createContext({ raw: JSON.stringify(value) }); new Script(bundle.outputFiles[0].text).runInContext(browser);
  const parsed = new Script("PermissionWire.parsePermissionRulesResult(JSON.parse(raw))").runInContext(browser);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), value);
});

test("strict capability codec rejects unknown fields, unsupported guarantees, invalid registrations and unbounded lists", () => {
  const capabilities = capability(), tool = capabilities.tools[0];
  const invalid = [null, undefined, {}, { ...capabilities, ready: true }, { ...capabilities, limits: { ...limits, coLocation: true } },
    { ...capabilities, limits: { ...limits, finalInode: true } }, { ...capabilities, runtime: { ...runtime, effective: true } },
    { ...capabilities, runtime: { ...runtime, state: "ready" } }, { ...capabilities, tools: {} },
    ...[{ ...tool, name: "" }, { ...tool, name: "x".repeat(513) }, { ...tool, name: "bad\nname" }, { ...tool, kind: "pwsh" },
      { ...tool, approval: "always" }, { ...tool, scopedMemory: true }, { ...tool, executorReady: true }].map(row => ({ ...capabilities, tools: [row] })),
    { ...capabilities, tools: [tool, tool] }, { ...capabilities, tools: Array.from({ length: 1025 }, (_, i) => ({ ...tool, name: `tool-${i}` })) },
  ];
  for (const value of invalid) assert.throws(() => parsePermissionRulesResult({ ...result(), capabilities: value }));
  let getterReads = 0;
  const unsafe = Object.defineProperty({ ...capabilities }, "tools", { enumerable: true, get() { getterReads++; return []; } });
  assert.throws(() => parsePermissionRulesResult({ ...result(), capabilities: unsafe })); assert.equal(getterReads, 0);
});

test("client treats malformed coverage as protocol failure rather than a ready or empty observation", async () => {
  let wire: unknown = { ...result(), capabilities: { ...capability(), tools: [{ ...capability().tools[0], scopedMemory: true }] } };
  const invoke = permissionClient({ rpc: { call: async () => ({ ok: true, value: wire }) } } as unknown as ConnectionHandle);
  await assert.rejects(invoke("describeRules", ["owned-root"], new AbortController().signal), { code: "protocol" });
  wire = result(); assert.equal((await invoke("describeRules", ["owned-root"], new AbortController().signal)).capabilities, undefined);
});

test("coverage refresh preserves draft CAS and save payload while disconnect keeps the display observation without authority", async () => {
  const controller = new PermissionController();
  const synced = { ...runtime, state: "synced" as const, runtimeRevision: "saved-source" };
  let observed: PermissionRulesSaveResult = { ...result(), runtime: synced, capabilities: { ...capability(), runtime: synced } };
  const requests: unknown[] = [];
  controller.bindConnection(async (method, args) => {
    if (method === "saveRules") requests.push(args[1]);
    return structuredClone(observed) as PermissionValue<typeof method>;
  }, {});
  controller.bindScope("owned-root", {}, "root");
  try {
    const generation = controller.store.getSnapshot().generation;
    await controller.refresh(generation); controller.edit(generation, { outsideReads: "deny" });
    const draft = controller.store.getSnapshot().draft, changes = permissionChanges(controller.store.getSnapshot());
    observed = { ...observed, capabilities: { ...capability(), runtime: synced, tools: [] } };
    await controller.refresh(generation);
    assert.equal(controller.store.getSnapshot().draft, draft); assert.equal(controller.store.getSnapshot().dirty, true);
    assert.deepEqual(controller.store.getSnapshot().rules!.capabilities!.tools, []);
    assert.deepEqual(permissionChanges(controller.store.getSnapshot()), changes);
    assert.equal(controller.canSave(generation), true); await controller.save(generation);
    assert.deepEqual(requests, [changes]); assert.equal(controller.store.getSnapshot().notice, "saved");
    assert.deepEqual(controller.store.getSnapshot().rules!.capabilities!.tools, []);
    controller.edit(generation, { outsideReads: "ask" });
    observed = { ...result(), runtime: synced }; await controller.refresh(generation);
    assert.equal(controller.store.getSnapshot().rules!.capabilities, undefined); assert.equal(controller.store.getSnapshot().draft!.outsideReads, "ask");
    controller.bindConnection(null);
    const detached = controller.store.getSnapshot();
    assert.equal(detached.rules, null); assert.equal(detached.display!.snapshot.revision, "saved-source");
    assert.equal(detached.rulesIssue, null); assert.equal(detached.draft!.outsideReads, "ask");
    assert.equal(controller.canSave(detached.generation), false); assert.equal(controller.canEdit(detached.generation), false);
  } finally { controller.dispose(); }
});

test("permission panel composes for the browser without importing native capability implementation", async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/client/PermissionsPanel.tsx", import.meta.url))], bundle: true,
    platform: "browser", format: "esm", write: false, external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"] });
  assert.ok(bundle.outputFiles[0].contents.length > 0);
});
