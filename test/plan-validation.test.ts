import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { DshToolExecution } from "../lib/dsh-types.js";
import { validatePlanMutation } from "../lib/plan-validation.js";

const root = join(tmpdir(), "dsmm-plan-validation-logical-cwd");
function planExec(name: string, arguments_: unknown): DshToolExecution {
  return { name, arguments: arguments_, agent: { session: { header: { cwd: root }, append() {} } } };
}
function reason(name: string, arguments_: unknown): string | undefined {
  const decision = validatePlanMutation(planExec(name, arguments_));
  assert.ok(decision === undefined || decision.kind === "deny");
  return decision?.kind === "deny" ? decision.reason : undefined;
}

test("plan validation recognizes normalized and case-insensitive plan writes", () => {
  assert.equal(reason("write", { file_path: "docs/superpowers/plans/good.MD", content: "- [ ] valid\n" }), undefined);
  assert.equal(reason("WRITE", { file_path: "docs/superpowers/plans/uppercase.md", content: "- [x] valid\n" }), undefined);
  assert.equal(reason("read", { file_path: "docs/superpowers/plans/ignored.md", content: "- [] ignored\n" }), undefined);
  assert.equal(reason("write", { file_path: "docs/superpowers/notes/good.md", content: "- [] ignored\n" }), undefined);
  assert.match(reason("write", { file_path: ".omo/plans/../plans/bad.md", content: "- [] bad\n" }) ?? "", /malformed checklist/);
  assert.match(reason("write", { file_path: join(root, "DOCS", "SUPERPOWERS", "PLANS", "bad.md"), content: "- [todo] bad\n" }) ?? "", /malformed checklist/);
});

test("plan validation denies recognized plan paths outside the session cwd", () => {
  assert.match(reason("write", { file_path: "../outside/docs/superpowers/plans/bad.md", content: "- [ ] valid\n" }) ?? "", /outside session cwd/);
});

test("plan validation requires complete write content", () => {
  for (const content of [undefined, 3]) assert.equal(reason("write", { file_path: "docs/superpowers/plans/bad.md", content }), "[dsmm safety] cannot validate plan write: content must be a string");
});

test("protected plan edits refuse both malformed and valid fragments without pretending to reconstruct the document", () => {
  for (const [old_string, new_string] of [["[ ]", "[]"], ["valid", "updated"]]) {
    assert.match(reason("edit", { file_path: "docs/superpowers/plans/edit.md", old_string, new_string }) ?? "", /unsupported-full-preview/);
  }
  assert.match(reason("edit", { file_path: "docs/superpowers/plans/edit.md", old_string: "valid", new_string: "updated", content: "- [ ] fake preview\n", preview: { lines: ["- [ ] incomplete"] } }) ?? "", /unsupported-full-preview/);
});

test("protected plan edits leave matching and CAS to native tools, never a Node filesystem preview", () => {
  // The removed reconstruction checks bypassed host read/observation. Every
  // protected edit now refuses independently of the target's matching state.
  for (const old_string of ["[ ]", "missing"]) {
    for (const replace_all of [undefined, false, true]) {
      assert.match(reason("edit", { file_path: ".omo/plans/edit.md", old_string, new_string: "[x]", replace_all }) ?? "", /unsupported-full-preview/);
    }
  }
  assert.equal(reason("edit", { file_path: "src/ordinary.ts", old_string: "old", new_string: "new", replace_all: true }), undefined);
});

test("plan validation rejects malformed native edit argument contracts without reading even a missing target", () => {
  assert.match(reason("edit", { file_path: "docs/superpowers/plans/missing.md", old_string: "[ ]", new_string: "[x]" }) ?? "", /unsupported-full-preview/);
  assert.equal(reason("edit", { file_path: "docs/superpowers/plans/edit.md", old_string: "", new_string: "[x]" }), "[dsmm safety] cannot validate plan edit: old_string must be non-empty");
  assert.equal(reason("edit", { file_path: "docs/superpowers/plans/edit.md", old_string: "[ ]", new_string: 3 }), "[dsmm safety] cannot validate plan edit: new_string must be a string");
  assert.equal(reason("edit", { file_path: "docs/superpowers/plans/edit.md", old_string: "[ ]", new_string: "[x]", replace_all: "yes" }), "[dsmm safety] cannot validate plan edit: replace_all must be boolean");
});
