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
import { roleToolEn } from "../src/client/RoleToolView-locales.ts";

test("native lazy argument reads update requested labels and preserve dispatched, result and replay detail", {
  skip: !process.env.DSMM_TEST_DSH_ENTRY && "requires an explicit installed SDK anchor",
}, async () => {
  const sdk = createRequire(process.env.DSMM_TEST_DSH_ENTRY!);
  const { PartialArguments } = sdk("@deepseek-ai/dsh-util-values");
  const output = await build({ entryPoints: [fileURLToPath(new URL("../src/client/RoleToolView.tsx", import.meta.url))],
    bundle: true, write: false, platform: "browser", format: "cjs", jsx: "automatic",
    external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"] });
  const require = createRequire(import.meta.url), module = { exports: {} as typeof import("../src/client/RoleToolView.tsx") };
  runInThisContext(`(function(require,module,exports){${output.outputFiles[0].text}\n})`)((id: string) => {
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return {
      Button: (props: object) => createElement("button", props), CodeBlock: ({ code }: { code: string }) => createElement("pre", null, code),
      DisclosureRow: ({ title, children }: { title: string; children: ReactNode }) => createElement("section", null, title, children), StateDot: () => null,
    };
    return require(id);
  }, module, module.exports);
  const text = (tree: unknown): string => {
    if (Array.isArray(tree)) return tree.map(text).join("");
    if (!isValidElement<Record<string, unknown>>(tree)) return typeof tree === "string" ? tree : "";
    return typeof tree.type === "function" ? text((tree.type as (props: unknown) => unknown)(tree.props)) : text(tree.props.children);
  };
  const args = new PartialArguments(); let inspect = 0;
  const common = { toolName: "dsmm_role", callId: "stream-call", useDisclosure: () => ({ expanded: true, setExpanded() {}, toggle() {} }),
    inspect: () => { inspect++; }, t: (key: keyof typeof roleToolEn) => roleToolEn[key] };
  const render = (stage: ToolCallViewProps["phase"], block: object) => module.exports.RoleToolView({ ...common, phase: stage, block } as Parameters<typeof module.exports.RoleToolView>[0]);
  const block = { phase: "preparing", name: "dsmm_role", callId: common.callId, args, subCalls: [] };
  const heading = (tree: ReturnType<typeof module.exports.RoleToolView>): string => tree.props.children[0].props.title;
  assert.equal(render("preparing", block).props["data-identity"], "requested");
  assert.equal(heading(render("preparing", block)).includes("Builder"), false);
  args.append('{"role":"dsmm-builder'); assert.equal(args.refresh(), true);
  assert.equal(heading(render("preparing", block)).includes("Builder"), false);
  args.append('","level":"high","description":"streamed description","prompt":"'); assert.equal(args.refresh(), true);
  assert.equal(args.closed(), false);
  assert.ok(heading(render("preparing", block)).includes("Builder"));
  args.append('original input"}'); assert.equal(args.refresh(), true);
  const preparing = text(render("preparing", block));
  assert.ok(heading(render("preparing", block)).includes("Builder")); assert.match(preparing, /original input/u);
  const categoryArgs = new PartialArguments(); categoryArgs.append('{"category":"dsmm-coding","prompt":"'); categoryArgs.refresh();
  const category = module.exports.RoleToolView({ ...common, toolName: "dsmm_category", phase: "preparing", block: { ...block, name: "dsmm_category", args: categoryArgs } } as Parameters<typeof module.exports.RoleToolView>[0]);
  assert.ok(heading(category).includes("Coding"));
  const raw = '{ "role": "dsmm-builder", "level":"high", "prompt":"original input" }';
  assert.ok(text(render("start", { ...block, phase: "start", argsRaw: raw })).includes(raw));
  const result = { kind: "tool-result", callId: common.callId, call: { name: "dsmm_role", argsRaw: raw }, args: PartialArguments.fromText(raw),
    content: [{ type: "text", text: "complete result" }, { type: "image", data: "retained nontext" }], isError: false,
    meta: { role: "dsmm-reviewer", label: "Reviewer", level: "normal", routeSource: "primary", mode: "one-shot" }, subCalls: [] };
  for (const record of [result, { ...result, call: structuredClone(result.call), args: PartialArguments.fromText(raw) }]) {
    const tree = render("result", record), rendered = text(tree);
    assert.equal(tree.props["data-identity"], "actual"); assert.ok(heading(tree).includes("Reviewer"));
    assert.match(rendered, /complete result/u); assert.match(rendered, /retained nontext/u); assert.ok(rendered.includes(raw));
    const button = tree.props.children[1].props.children[1]; button.props.onClick();
  }
  assert.equal(inspect, 2);
  const interrupted = render("result", { ...result, isError: true, error: { code: "interrupted" } });
  assert.equal(interrupted.props["data-identity"], "requested");
  assert.equal(interrupted.props["data-state"], "stopped");
  assert.ok(heading(interrupted).includes("Builder"));
});

const available = process.env.DSMM_TEST_DSH_ENTRY && process.env.DSMM_TEST_PLAYWRIGHT_ENTRY;
test("native role tool cards expose invocation identity and preserve output and interaction", {
  timeout: 180_000,
  skip: available ? false : "requires explicit installed SDK and Playwright anchors",
}, t => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ["--test", fileURLToPath(new URL("./client-role-tool-view-native.test.mjs", import.meta.url))], {
    env, encoding: "utf8", timeout: 170_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr + child.stdout);
  t.diagnostic(child.stdout.trim());
});
