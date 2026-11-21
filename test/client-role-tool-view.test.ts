import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";
import { createElement, isValidElement } from "react";
import type { ReactNode } from "react";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import type { SessionTarget } from "@deepseek-ai/dsh-api-session-controller/client";
import type { RoleCallObservation } from "../src/role-control-types.ts";
import { roleToolEn, roleToolZh } from "../src/client/RoleToolView-locales.ts";

test("native lazy argument reads update requested labels and preserve dispatched, result and replay detail", async () => {
  const sdk = createRequire(process.env.DSMM_TEST_DSH_ENTRY ?? createRequire(import.meta.url).resolve("@deepseek-ai/dsh-client-ui-tool"));
  const { PartialArguments } = sdk("@deepseek-ai/dsh-util-values");
  const output = await build({ stdin: { contents: 'export { RoleToolView, registerRoleToolViews } from "./src/client/RoleToolView.tsx"; export { NativeToolView } from "./src/client/NativeToolView.tsx";', resolveDir: fileURLToPath(new URL("../", import.meta.url)) },
    bundle: true, write: false, platform: "browser", format: "cjs", jsx: "automatic",
    external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"] });
  const require = createRequire(import.meta.url), module = { exports: {} as typeof import("../src/client/RoleToolView.tsx") & Pick<typeof import("../src/client/NativeToolView.tsx"), "NativeToolView"> };
  runInThisContext(`(function(require,module,exports){${output.outputFiles[0].text}\n})`)((id: string) => {
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return {
      Button: (props: object) => createElement("button", props), CodeBlock: ({ code }: { code: string }) => createElement("pre", null, code),
      DisclosureRow: ({ title, children, collapsedContent, icon }: { title: string; children: ReactNode; collapsedContent?: ReactNode; icon?: ReactNode }) => createElement("section", { "data-title": title }, title, collapsedContent, children),
      StateDot: () => createElement("span", { "data-component": "state-dot" }),
      IconAgentPresetOutlineRegular: (props: object) => createElement("svg", { "data-icon": "IconAgentPresetOutlineRegular", ...props }),
      TextShimmer: ({ children }: { children: ReactNode }) => createElement("span", null, children),
      SegmentedControl: ({ id, options, value, onChange }: { id?: string; options: Array<{ value: string; label: string }>; value: string; onChange: (v: string) => void }) => createElement("div", { role: "tablist" }, options.map(opt => createElement("button", { key: opt.value, id: id ? `${id}-${opt.value}` : undefined, "aria-controls": id ? `${id}-${opt.value}-panel` : undefined, role: "tab", "aria-selected": opt.value === value, onClick: () => onChange(opt.value) }, opt.label))),
    };
    if (id === "react") {
      const realReact = require("react");
      return {
        ...realReact,
        useState: <T>(init: T): [T, (v: T | ((prev: T) => T)) => void] => [init, () => {}],
      };
    }
    return require(id);
  }, module, module.exports);
  const text = (tree: unknown): string => {
    if (Array.isArray(tree)) return tree.map(text).join("");
    if (!isValidElement<Record<string, unknown>>(tree)) return typeof tree === "string" ? tree : "";
    return typeof tree.type === "function" ? text((tree.type as (props: unknown) => unknown)(tree.props)) : text(tree.props.children);
  };
  const args = new PartialArguments(); let inspect = 0;
  const opened: SessionTarget[] = [];
  const workspace = { openSession: (target: SessionTarget) => { opened.push(target); } };
  const emptyObservation = { sessionId: "root", status: "live" as const, calls: new Map<string, RoleCallObservation>() };
  const common = { toolName: "dsmm_role", callId: "stream-call", sessionId: "root", useDisclosure: () => ({ expanded: true, setExpanded() {}, toggle() {} }),
    useRoleCalls: <T,>(selector: (state: typeof emptyObservation) => T) => selector(emptyObservation),
    useChildWorkspace: <T,>(selector: (value: typeof workspace) => T) => selector(workspace), useProjection: () => undefined,
    inspect: () => { inspect++; }, t: (key: keyof typeof roleToolEn) => roleToolEn[key] };
  const action = (row: { props: { children: unknown[] } }, label: string) => row.props.children.find(
    (node): node is React.ReactElement<{ children: string; onClick(): void }> =>
      isValidElement<{ children: string; onClick(): void }>(node) && node.props.children === label);
  const openRole = (tree: ReturnType<typeof module.exports.RoleToolView>) => action(tree.props.children[1], roleToolEn.openConversation);
  const render = (stage: ToolCallViewProps["phase"], block: object) => module.exports.RoleToolView({ ...common, phase: stage, block } as Parameters<typeof module.exports.RoleToolView>[0]);
  const block = { phase: "preparing", name: "dsmm_role", callId: common.callId, args, subCalls: [] };
  const heading = (tree: ReturnType<typeof module.exports.RoleToolView>): string => tree.props.children[0].props.title;
  const desc = (tree: ReturnType<typeof module.exports.RoleToolView>): string => text(tree.props.children[0].props.collapsedContent);
  assert.equal(render("preparing", block).props["data-identity"], "requested");
  assert.equal(heading(render("preparing", block)).includes("Builder"), false);
  args.append('{"role":"dsmm-builder'); assert.equal(args.refresh(), true);
  assert.equal(heading(render("preparing", block)).includes("Builder"), false);
  args.append('","level":"high","description":"streamed description","prompt":"'); assert.equal(args.refresh(), true);
  assert.equal(args.closed(), false);
  assert.equal(heading(render("preparing", block)), "Calling Builder");
  assert.match(desc(render("preparing", block)), /streamed description/u);
  assert.equal(heading(render("preparing", block)).includes("high"), false);
  const zhRender = (stage: ToolCallViewProps["phase"], b: object) => module.exports.RoleToolView({ ...common, t: (k: keyof typeof roleToolZh) => roleToolZh[k], phase: stage, block: b } as Parameters<typeof module.exports.RoleToolView>[0]);
  assert.equal(heading(zhRender("preparing", block)), "正在调用 Builder");
  assert.match(desc(zhRender("preparing", block)), /streamed description/u);
  args.append('original input"}'); assert.equal(args.refresh(), true);
  const preparing = text(render("preparing", block));
  assert.equal(heading(render("preparing", block)), "Calling Builder"); assert.match(preparing, /original input/u);
  const categoryArgs = new PartialArguments(); categoryArgs.append('{"category":"dsmm-coding","prompt":"'); categoryArgs.refresh();
  const category = module.exports.RoleToolView({ ...common, toolName: "dsmm_category", phase: "preparing", block: { ...block, name: "dsmm_category", args: categoryArgs } } as Parameters<typeof module.exports.RoleToolView>[0]);
  assert.equal(heading(category), "Calling Coding");
  const raw = '{ "role": "dsmm-builder", "level":"high", "prompt":"original input" }';
  assert.ok(text(render("start", { ...block, phase: "start", argsRaw: raw })).includes("original input"));
  assert.equal(heading(render("start", { ...block, phase: "start", argsRaw: raw })), "Call Builder");
  assert.equal(heading(zhRender("start", { ...block, phase: "start", argsRaw: raw })), "调用 Builder");
  const rawWithDesc = '{ "role": "dsmm-builder", "level":"high", "description":"task goal", "prompt":"original input" }';
  const startWithDesc = { ...block, phase: "start", argsRaw: rawWithDesc };
  const startTree = render("start", startWithDesc);
  assert.equal(startTree.props["data-state"], "running");
  assert.equal(heading(startTree), "Call Builder");
  assert.match(text(startTree), /Actual: unknown/u);
  assert.doesNotMatch(text(startTree), /Actual: fixture\//u);
  assert.match(desc(startTree), /task goal/u);
  assert.equal(heading(zhRender("start", startWithDesc)), "调用 Builder");
  assert.match(desc(zhRender("start", startWithDesc)), /task goal/u);
  const result = { kind: "tool-result", callId: common.callId, call: { name: "dsmm_role", argsRaw: raw }, args: PartialArguments.fromText(raw),
    content: [{ type: "text", text: "complete result" }, { type: "image", data: "retained nontext" }], isError: false,
    meta: { role: "dsmm-reviewer", label: "Reviewer", level: "normal", routeSource: "primary", mode: "one-shot" }, subCalls: [] };
  for (const record of [result, { ...result, call: structuredClone(result.call), args: PartialArguments.fromText(raw) }]) {
    const tree = render("result", record), rendered = text(tree);
    assert.equal(tree.props["data-identity"], "actual"); assert.equal(heading(tree), "Call Reviewer");
    assert.equal(heading(zhRender("result", record)), "调用 Reviewer");
    assert.equal(rendered.includes("complete result"), false);
    assert.equal(rendered.includes("retained nontext"), false);
    assert.match(rendered, /args\.role/u);
    assert.match(rendered, /meta\.routeSource/u);
    assert.match(rendered, /primary/u);
    assert.equal(openRole(tree), undefined);
  }
  assert.equal(openRole(startTree), undefined);
  assert.equal(openRole(render("result", { ...result, meta: { childId: "forged", mode: "continuable" } })), undefined);
  const confirmed = { ...result, meta: { ...result.meta, childId: "role-child", jobId: "role-job" } };
  openRole(render("result", confirmed))?.props.onClick();
  assert.deepEqual(opened, [{ parentSessionId: "root", childSessionId: "role-child", mode: "one-shot" }]);
  assert.equal(inspect, 0);
  assert.equal(openRole(render("result", { ...confirmed, isError: true })), undefined);
  assert.equal(openRole(render("result", { ...confirmed, meta: { ...confirmed.meta, phase: "reserved" } })), undefined);
  assert.equal(openRole(render("result", { ...result, meta: { ...result.meta, jobId: "role-job" } })), undefined);
  assert.equal(openRole(module.exports.RoleToolView({ ...common, useChildWorkspace: () => undefined,
    phase: "result", block: confirmed } as Parameters<typeof module.exports.RoleToolView>[0])), undefined);
  const nativeView = () => createElement("native-original");
  const nativeT = (key: string) => key;
  const renderNative = (record: object, overrides: object = {}) => module.exports.NativeToolView({
    ...common, toolName: "subagent", nativeView, nativeT, phase: "result", block: record, ...overrides,
  } as Parameters<typeof module.exports.NativeToolView>[0]);
  const openNative = (tree: ReturnType<typeof renderNative>) => {
    const original = tree.props.children[0];
    return original.props.t("row.inspect") === roleToolEn.openConversation
      ? { props: { onClick: original.props.inspect as () => void } } : undefined;
  };
  for (const record of [result, { ...result, isError: true, error: { code: "interrupted" } },
    { ...result, meta: { kind: "activation", name: "native-worker" } }]) {
    const native = renderNative(record);
    assert.equal(openNative(native), undefined);
    const original = native.props.children[0];
    assert.equal(original.type, nativeView);
    assert.equal(original.props.block, record, "the native presenter receives the entire original result including non-text output");
    assert.equal(original.props.inspect, common.inspect);
    assert.equal(original.props.useDisclosure, common.useDisclosure);
    assert.equal(original.props.t, nativeT);
  }
  const resultWithDesc = { ...result, call: { name: "dsmm_role", argsRaw: rawWithDesc } };
  assert.equal(heading(render("result", resultWithDesc)), "Call Reviewer");
  assert.match(desc(render("result", resultWithDesc)), /task goal/u);
  assert.equal(heading(zhRender("result", resultWithDesc)), "调用 Reviewer");
  assert.match(desc(zhRender("result", resultWithDesc)), /task goal/u);
  const interrupted = render("result", { ...result, isError: true, error: { code: "interrupted" } });
  assert.equal(interrupted.props["data-identity"], "requested");
  assert.equal(interrupted.props["data-state"], "stopped");
  assert.equal(heading(interrupted), "Call Builder");
  assert.equal(text(interrupted.props.children[1].props.children.find((c: any) => c?.props?.role === "status")), "Interrupted");
  const zhInterrupted = zhRender("result", { ...result, isError: true, error: { code: "interrupted" } });
  assert.equal(text(zhInterrupted.props.children[1].props.children.find((c: any) => c?.props?.role === "status")), "已中断");
  const continuableResult = { ...result, meta: { ...result.meta, mode: "continuable" } };
  assert.equal(render("result", continuableResult).props["data-state"], "result", "continuable alone is not background delivery");
  const bgResult = { ...result, meta: { ...result.meta, mode: "continuable", delivery: "parent", phase: "active" } };
  const bgTree = render("result", bgResult);
  assert.equal(bgTree.props["data-state"], "background");
  assert.equal(text(bgTree.props.children[1].props.children.find((c: any) => c?.props?.role === "status")), "Background");
  const zhBg = zhRender("result", bgResult);
  assert.equal(text(zhBg.props.children[1].props.children.find((c: any) => c?.props?.role === "status")), "后台调用");
  assert.equal(render("result", { ...bgResult, meta: { ...bgResult.meta, phase: "settled", stopReason: "completed" } }).props["data-state"], "result");
  const activeMeta = { ...bgResult.meta, childId: "background-child", route: { provider: "fixture", model: "initial" }, routeComparison: {
    childId: "background-child", initialRoute: { status: "known", source: "invocation-capture", route: { provider: "fixture", model: "initial" } },
    liveRoute: { status: "known", source: "own-native-request-header", route: { provider: "fixture", model: "old-actual", reasoningEffort: "high" } },
  } };
  for (const status of ["connecting", "unavailable"] as const) {
    const emptyState = { sessionId: "root", status, calls: new Map() };
    const staleTree = module.exports.RoleToolView({ ...common,
      useRoleCalls: <T,>(selector: (state: typeof emptyState) => T) => selector(emptyState), phase: "result",
      block: { ...bgResult, meta: activeMeta } } as Parameters<typeof module.exports.RoleToolView>[0]);
    const identity = text(staleTree.props.children[0].props.children.props.children[0]);
    assert.match(identity, /Initial: fixture\/initial/u);
    assert.match(identity, /Actual: unknown/u);
    assert.doesNotMatch(identity, /old-actual/u);
    assert.match(text(staleTree), /old-actual/u, "technical details retain the original persisted meta");
  }

  const observedCall = { parentSessionId: "root", parentAdmissionEpoch: "a".repeat(64), childAdmissionEpoch: "a".repeat(64),
    callId: common.callId, rootCallId: "root-call", childId: "child", runId: "run", role: "dsmm-builder", level: "high", routeSource: "level",
    initialRoute: { status: "known", source: "invocation-capture", route: { provider: "fixture", model: "initial", reasoningEffort: "max" } },
    actualRoute: { status: "known", source: "own-native-request-header", route: { provider: "fixture", model: "fallback" } },
    phase: "active", delivery: "caller" } as const;
  const observedState = { sessionId: "root", status: "live" as const, admissionEpoch: "a".repeat(64), calls: new Map([[common.callId, observedCall]]) };
  const observedTree = module.exports.RoleToolView({ ...common,
    useRoleCalls: <T,>(selector: (state: typeof observedState) => T) => selector(observedState), phase: "start", block: startWithDesc } as Parameters<typeof module.exports.RoleToolView>[0]);
  assert.equal(observedTree.props["data-identity"], "actual");
  assert.equal(observedTree.props["data-delivery"], "caller");
  assert.equal(observedTree.props["data-phase"], "active");
  assert.match(text(observedTree), /Initial: fixture\/initial · max/u);
  assert.match(text(observedTree), /Actual: fixture\/fallback · effort not reported/u);
  assert.doesNotMatch(text(observedTree), /Actual: fixture\/fallback · off/u);
  openRole(observedTree)?.props.onClick();
  assert.deepEqual(opened.at(-1), { parentSessionId: "root", childSessionId: "child", mode: "unknown" });
  const withRoleObservation = (call: RoleCallObservation, record = confirmed) => module.exports.RoleToolView({ ...common,
    useRoleCalls: (select: (state: typeof emptyObservation) => unknown) => select({ ...emptyObservation, calls: new Map([[common.callId, call]]) }),
    phase: "result", block: record } as Parameters<typeof module.exports.RoleToolView>[0]);
  assert.equal(openRole(withRoleObservation(observedCall)), undefined, "conflicting ids do not navigate");
  assert.equal(openRole(withRoleObservation({ ...observedCall, parentSessionId: "other-parent" }, result)), undefined);
  assert.equal(openRole(withRoleObservation({ ...observedCall, callId: "other-call" }, result)), undefined);
  assert.equal(openRole(withRoleObservation({ ...observedCall, phase: "reserved" }, result)), undefined);

  const nativeReceipt = { ...result, meta: { kind: "activation", subagentId: "native-child" } };
  const local = (mode: "one-shot" | "continuable" | "external" | "unknown") => () => [{ id: "native-child", mode, label: "native-worker" }];
  assert.equal(openNative(renderNative(nativeReceipt)), undefined, "the native receipt needs local catalog membership");
  assert.equal(openNative(renderNative(nativeReceipt, { useProjection: local("external") })), undefined);
  assert.equal(openNative(renderNative({ ...nativeReceipt, meta: { kind: "activation", name: "native-worker" } }, { useProjection: local("one-shot") })), undefined);
  openNative(renderNative(nativeReceipt, { toolName: "subagent_fork", useProjection: local("unknown") }))?.props.onClick();
  assert.deepEqual(opened.at(-1), { parentSessionId: "root", childSessionId: "native-child", mode: "unknown" });
  const nativeObservation = { ...observedCall, kind: "native", toolName: "subagent", nativeName: "native-worker", childId: "native-child",
    initialRoute: { status: "unknown", reason: "missing-invocation-capture" } } as const;
  const withNativeObservation = (call: RoleCallObservation) => ({
    useProjection: local("one-shot"),
    useRoleCalls: (select: (state: typeof emptyObservation) => unknown) => select({ ...emptyObservation, calls: new Map([[common.callId, call]]) }),
  });
  const nativeResultWithoutMeta = { ...result, meta: undefined };
  openNative(renderNative(nativeResultWithoutMeta, withNativeObservation(nativeObservation)))?.props.onClick();
  assert.deepEqual(opened.at(-1), { parentSessionId: "root", childSessionId: "native-child", mode: "one-shot" });
  assert.equal(openNative(renderNative({ ...nativeResultWithoutMeta, isError: true }, withNativeObservation(nativeObservation))), undefined);
  assert.equal(openNative(renderNative(nativeReceipt, withNativeObservation({ ...nativeObservation, childId: "different-child" }))),
    undefined, "a same-call native observation cannot contradict the activation receipt");
  const invalidatedCall = { ...observedCall, actualRoute: { status: "unknown", reason: "not-observed" } } as const;
  const invalidatedState = { ...observedState, status: "unavailable" as const, calls: new Map([[common.callId, invalidatedCall]]) };
  const invalidatedTree = module.exports.RoleToolView({ ...common,
    useRoleCalls: <T,>(selector: (state: typeof invalidatedState) => T) => selector(invalidatedState), phase: "start", block: startWithDesc } as Parameters<typeof module.exports.RoleToolView>[0]);
  assert.match(text(invalidatedTree), /Actual: unknown/u);
  assert.doesNotMatch(text(invalidatedTree), /Actual: fixture\/fallback/u);
  const observedFailure = module.exports.RoleToolView({ ...common,
    useRoleCalls: <T,>(selector: (state: typeof observedState) => T) => selector(observedState), phase: "result",
    block: { ...result, isError: true, error: { code: "failed" } } } as Parameters<typeof module.exports.RoleToolView>[0]);
  assert.equal(observedFailure.props["data-identity"], "actual");
  assert.match(text(observedFailure), /Actual: fixture\/fallback/u);

  for (const status of ["connecting", "unavailable", "stale", "live"] as const) {
    const state = { sessionId: "root", status, calls: new Map(), issue: status === "live" ? undefined : { kind: "domain" as const, code: "not-owned" as const } };
    const tree = module.exports.RoleToolView({ ...common,
      useRoleCalls: <T,>(selector: (value: typeof state) => T) => selector(state), phase: "start", block: startWithDesc } as Parameters<typeof module.exports.RoleToolView>[0]);
    const diagnostic = tree.props.children[0].props.children.props.children.find((node: ReactNode) => isValidElement<Record<string, unknown>>(node) && node.props["data-observation-status"] === status);
    assert.ok(diagnostic, "an empty call map still exposes observation status");
    assert.equal(tree.props["data-state"], "running", "observation failure is not a child execution failure");
    assert.equal(text(diagnostic).includes("domain/not-owned"), status !== "live");
  }
  const settledMeta = { ...activeMeta, phase: "settled", stopReason: "completed" };
  const settledTree = module.exports.RoleToolView({ ...common,
    useRoleCalls: <T,>(selector: (value: typeof observedState) => T) => selector(observedState), phase: "result",
    block: { ...bgResult, meta: settledMeta } } as Parameters<typeof module.exports.RoleToolView>[0]);
  assert.equal(settledTree.props["data-state"], "result");
  const settledIdentity = text(settledTree.props.children[0].props.children.props.children[0]);
  assert.match(settledIdentity, /Actual: fixture\/old-actual/u);
  assert.doesNotMatch(settledIdentity, /fallback/u, "settled persisted evidence wins over a live observation");
  const foreignCallState = { ...observedState, calls: new Map([["another-call", observedCall]]) };
  const foreignTree = module.exports.RoleToolView({ ...common,
    useRoleCalls: <T,>(selector: (value: typeof foreignCallState) => T) => selector(foreignCallState), phase: "start", block: startWithDesc } as Parameters<typeof module.exports.RoleToolView>[0]);
  assert.equal(foreignTree.props["data-identity"], "requested", "rootCallId and neighboring calls cannot substitute for callId");

  const settledCallA = { ...observedCall, callId: "call-a", phase: "settled", stopReason: "completed" } as const;
  const activeCallB = { ...observedCall, callId: "call-b", phase: "active" } as const;
  const concurrentState = { ...observedState, calls: new Map([["call-a", settledCallA], ["call-b", activeCallB]]) };
  const concurrentTreeA = module.exports.RoleToolView({ ...common, callId: "call-a",
    useRoleCalls: <T,>(selector: (value: typeof concurrentState) => T) => selector(concurrentState), phase: "start",
    block: { ...startWithDesc, callId: "call-a" } } as Parameters<typeof module.exports.RoleToolView>[0]);
  const concurrentTreeB = module.exports.RoleToolView({ ...common, callId: "call-b",
    useRoleCalls: <T,>(selector: (value: typeof concurrentState) => T) => selector(concurrentState), phase: "start",
    block: { ...startWithDesc, callId: "call-b" } } as Parameters<typeof module.exports.RoleToolView>[0]);
  assert.equal(concurrentTreeA.props["data-state"], "result");
  assert.equal(concurrentTreeA.props["data-phase"], "settled");
  assert.equal(concurrentTreeA.props.children[0].props.running, false);
  assert.equal(concurrentTreeB.props["data-state"], "running");
  assert.equal(concurrentTreeB.props["data-phase"], "active");
  assert.equal(concurrentTreeB.props.children[0].props.running, true);

  const registrations: Array<{ options: { key: string; inject(sessionId: string): { hooks: { roleCalls: object } } }; component: unknown }> = [];
  const sharedSource = { getSnapshot: () => observedState, subscribe: () => () => {} };
  module.exports.registerRoleToolViews({ effect() {}, inject() {}, locale: { register() {} }, slots: {
    inject(_name: string, install: () => void) { install(); },
    entries() { return []; }, subscribe() { return () => {}; },
    register(options: { key: string; inject(sessionId: string): { hooks: { roleCalls: object } } }, component: unknown) {
      registrations.push({ options, component }); return () => {};
    },
  } } as never, { source(sessionId: string) { assert.equal(sessionId, "root"); return sharedSource; } } as never);
  assert.ok(registrations.some(row => row.options.key === "dsmm_role"));
  const registered = registrations.find(row => row.options.key === "dsmm_role")!;
  assert.equal(registered.component, module.exports.RoleToolView);
  assert.equal(registered.options.inject("root").hooks.roleCalls, sharedSource);
});

const available = process.env.DSMM_TEST_DSH_ENTRY && process.env.DSMM_TEST_PLAYWRIGHT_ENTRY;
test("native role tool cards expose invocation identity and preserve output and interaction", {
  timeout: 180_000,
  skip: available ? false : "requires explicit installed SDK and Playwright anchors",
}, t => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--import", new URL("./host-llm-source-loader.mjs", import.meta.url).href, "--test", fileURLToPath(new URL("./client-role-tool-view-native.test.mjs", import.meta.url))], {
    env, encoding: "utf8", timeout: 170_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr + child.stdout);
  t.diagnostic(child.stdout.trim());
});
