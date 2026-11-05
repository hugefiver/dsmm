import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { runCli, sse, successful, toolCall } from "./native-host-route-boundaries-fixture.mjs";
import { add, configurePatch, hostFixture, patch, patchResults, rejected, sequence, update } from "./native-apply-patch-fixture.mjs";

const entry = process.env.DSMM_TEST_DSH_ENTRY;
const read = path => ["read", { file_path: path }];
const apply = input => ["apply_patch", { input }];
const probe = (action, input) => ["native_apply_patch_probe", { action, input }];
const text = (f, path) => readFile(join(f.workspace, path), "utf8");
const seed = (f, path, value = "original\n") => writeFile(join(f.workspace, path), value);
const statuses = result => patchResults(result).at(-1)?.value?.operations?.map(row => row.status);

await test("isolated native apply_patch opt-in, observation and permission boundaries", {
  skip: entry === undefined ? "requires DSMM_TEST_DSH_ENTRY selecting a complete Host anchor" : false,
  timeout: 360_000
}, async t => {
  const f = await hostFixture(entry);
  try {
    const native = await import(pathToFileURL(createRequire(f.nativeEntry).resolve("@deepseek-ai/dsh-tool-fs")).href);
    const supported = Object.hasOwn(native.Config({}), "applyPatch");
    await t.test("default and supported explicit false omit the native mutation tool", async () => {
      for (const enabled of supported ? [undefined, false] : [undefined]) {
        await configurePatch(f, { enabled });
        const result = await sequence(f, `patch-default-${enabled}`, []);
        assert.equal(result.requests[0].tools.some(row => row.function.name === "apply_patch"), false);
      }
    });
    await configurePatch(f, supported ? { enabled: true } : {});
    const capability = await sequence(f, "patch-native-capability", []);
    assert.equal(capability.requests[0].tools.some(row => row.function.name === "apply_patch"), supported);
    if (!supported) {
      await t.test("Host without native apply_patch preserves its existing filesystem tools", () => {
        assert.ok(capability.requests[0].tools.some(row => row.function.name === "write"));
        assert.ok(capability.requests[0].tools.some(row => row.function.name === "edit"));
      });
      return;
    }
    assert.ok(capability.evidence.some(row => row.type === "patch-provider" && row.provider === "SandboxedFileSystem"));
    await t.test("real HTTP schema and native FS apply add/update/delete/move and canonical aliases", async () => {
      for (const path of ["update.txt", "delete.txt", "move.txt", "alias.txt"]) await seed(f, path);
      await mkdir(join(f.workspace, "sub"));
      const result = await sequence(f, "patch-multiple", [read("update.txt"), read("delete.txt"), read("move.txt"), read("alias.txt"),
        apply(patch(add("added.txt"), update("update.txt"), "*** Delete File: delete.txt",
          update("move.txt", "original", "moved", "moved.txt"), update(join(f.workspace, "sub", "..", "alias.txt"))))]);
      assert.equal(patchResults(result).at(-1).isError, false, JSON.stringify(patchResults(result)));
      assert.equal(await text(f, "added.txt"), "created\n"); assert.equal(await text(f, "update.txt"), "updated\n");
      assert.equal(existsSync(join(f.workspace, "delete.txt")), false); assert.equal(existsSync(join(f.workspace, "move.txt")), false);
      assert.equal(await text(f, "moved.txt"), "moved\n"); assert.equal(await text(f, "alias.txt"), "updated\n");
      const observed = result.evidence.filter(row => row.type === "patch-observation");
      assert.ok(observed.some(row => row.path.endsWith("move.txt") && row.observation.kind === "absent"));
      assert.ok(observed.some(row => row.path.endsWith("moved.txt") && row.observation.kind === "present"));
    });
    await t.test("syntax, hunk, missing and observation preflight failures leave every target unchanged", async () => {
      await seed(f, "guarded.txt"); await seed(f, "existing.txt", "existing\n");
      const cases = [
        [[], patch(add("uncommitted.txt"), update("guarded.txt")), "preflight", "FS_NOT_OBSERVED"],
        [[read("guarded.txt")], patch(add("uncommitted.txt"), update("guarded.txt", "missing")), "preflight", "FS_PATCH_MISMATCH"],
        [[], patch(add("uncommitted.txt"), add("existing.txt", "clobber")), "preflight", "FS_NOT_OBSERVED"],
        [[read("missing.txt")], patch(add("uncommitted.txt"), "*** Delete File: missing.txt"), "preflight", "FS_NOT_FOUND"],
        [[], "*** Begin Patch\n*** Add File: uncommitted.txt\n+new\nmalformed\n*** End Patch", "syntax", "PATCH_SYNTAX"]
      ];
      for (const [index, [steps, input, phase, code]] of cases.entries()) {
        rejected(await sequence(f, `patch-${phase}-${index}`, [...steps, apply(input)]), code);
        assert.equal(existsSync(join(f.workspace, "uncommitted.txt")), false);
        assert.equal(await text(f, "guarded.txt"), "original\n"); assert.equal(await text(f, "existing.txt"), "existing\n");
      }
    });
    await t.test("preflight reads grant no observation and external modifications invalidate read versions", async () => {
      await seed(f, "preflight-read.txt"); await seed(f, "existing.txt", "existing\n");
      const noObservation = await sequence(f, "patch-no-internal-observation", [read("preflight-read.txt"),
        apply(patch(update("preflight-read.txt", "missing"), add("existing.txt"))),
        ["edit", { file_path: "existing.txt", old_string: "existing", new_string: "forbidden", replace_all: false }]]);
      rejected(noObservation, "FS_PATCH_MISMATCH");
      assert.ok(noObservation.evidence.some(row => row.type === "tool-error" && row.code === "FS_NOT_OBSERVED"));
      assert.equal(noObservation.evidence.filter(row => row.type === "patch-observation" && row.path.endsWith("existing.txt")).length, 0);
      assert.equal(noObservation.evidence.filter(row => row.type === "patch-observation" && row.path.endsWith("preflight-read.txt")).length, 1,
        "native preflight text reads must not emit another model observation");
      const stale = await sequence(f, "patch-stale", [read("preflight-read.txt"), async (body, res) => {
        await seed(f, "preflight-read.txt", "externally changed\n");
        toolCall(res, body, "apply_patch", { input: patch(add("stale-uncommitted.txt"), update("preflight-read.txt")) });
      }]);
      rejected(stale, "FS_STALE_VERSION");
      assert.equal(await text(f, "preflight-read.txt"), "externally changed\n");
      assert.equal(existsSync(join(f.workspace, "stale-uncommitted.txt")), false);
    });
    await t.test("native provider confines relative traversal, absolute paths and both move endpoints", async () => {
      const outside = join(f.outside, "outside.txt"); await writeFile(outside, "original\n");
      for (const [index, input] of [
        patch(add("../workspace-neighbor/new.txt")), patch(update(outside)),
        patch("*** Delete File: ../workspace-neighbor/outside.txt"),
        patch(update("source.txt", "original", "moved", outside)),
        patch(update(outside, "original", "moved", "from-outside.txt"))
      ].entries()) {
        await seed(f, "source.txt");
        const result = await sequence(f, `patch-provider-deny-${index}`, [read(outside), read("source.txt"), apply(input)]);
        const row = patchResults(result).at(-1);
        assert.equal(row.isError, true, JSON.stringify(row));
        assert.ok(JSON.stringify(row).includes("FS_SANDBOX_DENIED"), JSON.stringify(row));
        assert.equal(await readFile(outside, "utf8"), "original\n");
        assert.equal(existsSync(join(f.outside, "new.txt")), false);
        assert.equal(await text(f, "source.txt"), "original\n");
        assert.equal(existsSync(join(f.workspace, "from-outside.txt")), false, "native sandbox validates both move endpoints before mutation");
      }
    });
    await t.test("native default temporary roots remain fully writable", async () => {
      const temporary = join(f.root, "default-temp.txt");
      const result = await sequence(f, "patch-default-temp", [apply(patch(add(temporary))),
        apply(patch(update(temporary, "created", "temp-updated")))]);
      assert.ok(patchResults(result).every(row => row.isError === false));
      assert.equal(await readFile(temporary, "utf8"), "temp-updated\n");
    });
    await t.test("commit failure preserves completed changes and skips successors", async () => {
      const result = await sequence(f, "patch-ordered-partial", [apply(patch(add("committed.txt"),
        add("../workspace-neighbor/commit-denied.txt"), add("never-committed.txt")))]);
      assert.deepEqual(statuses(result), ["completed", "failed", "skipped"], JSON.stringify(patchResults(result)));
      assert.equal(await text(f, "committed.txt"), "created\n");
      assert.equal(existsSync(join(f.outside, "commit-denied.txt")), false);
      assert.equal(existsSync(join(f.workspace, "never-committed.txt")), false);
    });
    await t.test("native move source-removal IO failure retains its real destination write", async () => {
      await seed(f, "move-source.txt");
      const result = await sequence(f, "patch-move-partial", [read("move-source.txt"),
        probe("move-partial", patch(update("move-source.txt", "original", "moved", "move-destination.txt"), add("after-move.txt")))]);
      const outcome = result.evidence.find(row => row.type === "patch-probe");
      assert.deepEqual(outcome?.value?.operations.map(row => row.status), ["failed", "skipped"], JSON.stringify(outcome));
      assert.equal(outcome.value.operations[0].changes.length, 1);
      assert.equal(result.evidence.filter(row => row.type === "patch-native-remove-fault").length, 1);
      assert.equal(await text(f, "move-source.txt"), "original\n");
      assert.equal(await text(f, "move-destination.txt"), "moved\n");
      assert.equal(existsSync(join(f.workspace, "after-move.txt")), false);
    });
    await t.test("native junction aliases share observation and cannot reach unauthorized targets", async caseContext => {
      await mkdir(join(f.workspace, "linked-real")); await seed(f, "linked-real/alias.txt");
      await seed(f, "source.txt"); await writeFile(join(f.outside, "outside.txt"), "original\n");
      try {
        await symlink(join(f.workspace, "linked-real"), join(f.workspace, "linked-in"), process.platform === "win32" ? "junction" : "dir");
        await symlink(f.outside, join(f.workspace, "linked-out"), process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (!["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error;
        caseContext.skip(`native link creation unavailable: ${error.code}`); return;
      }
      const internal = await sequence(f, "patch-canonical-link", [read("linked-in/alias.txt"), apply(patch(update("linked-real/alias.txt")))]);
      assert.equal(patchResults(internal).at(-1).isError, false);
      assert.equal(await text(f, "linked-in/alias.txt"), "updated\n");
      for (const [index, input] of [patch(add("linked-out/forbidden.txt")), patch(update("linked-out/outside.txt")),
        patch("*** Delete File: linked-out/outside.txt"), patch(update("source.txt", "original", "moved", "linked-out/moved.txt")),
        patch(update("linked-out/outside.txt", "original", "moved", "link-from-outside.txt"))].entries()) {
        const result = await sequence(f, `patch-link-denied-${index}`, [read("linked-out/outside.txt"), read("source.txt"), apply(input)]);
        rejected(result, "FS_SANDBOX_DENIED");
        assert.equal(await readFile(join(f.outside, "outside.txt"), "utf8"), "original\n");
        assert.equal(existsSync(join(f.outside, "forbidden.txt")), false);
        assert.equal(existsSync(join(f.outside, "moved.txt")), false);
      }
    });
    await t.test("native deny and approval never preserve all targets", async () => {
      for (const gate of ["deny", "ask"]) {
        await configurePatch(f, { enabled: true, gate });
        const result = await sequence(f, `patch-native-${gate}`, [apply(patch(add(`gate-${gate}.txt`)))]);
        assert.equal(patchResults(result).at(-1)?.isError, true, JSON.stringify(result.evidence));
        assert.ok(result.evidence.some(row => row.type === "patch-native-gate" && row.gate === gate));
        assert.equal(result.evidence.filter(row => row.type === "patch-approval-interaction").length, 0);
        assert.equal(existsSync(join(f.workspace, `gate-${gate}.txt`)), false);
      }
      await configurePatch(f, { enabled: true });
    });
    await t.test("cancellation before dispatch and between commits preserves the native boundary", async () => {
      const before = await sequence(f, "patch-cancel-before", [probe("cancel", patch(add("cancel-never.txt")))]);
      assert.equal(before.evidence.find(row => row.type === "patch-probe")?.isError, true);
      assert.equal(existsSync(join(f.workspace, "cancel-never.txt")), false);
      const during = await sequence(f, "patch-cancel-commit", [probe("cancel-commit", patch(add("cancel-first.txt"), add("cancel-next.txt")))]);
      assert.equal(during.evidence.find(row => row.type === "patch-probe")?.isError, true);
      assert.equal(await text(f, "cancel-first.txt"), "created\n");
      assert.equal(existsSync(join(f.workspace, "cancel-next.txt")), false);
    });
    await t.test("native tool ceiling and disposed Agent prevent dispatch", async () => {
      for (const action of ["ceiling", "retired"]) {
        const result = await sequence(f, `patch-${action}`, [probe(action, patch(add(`${action}-never.txt`)))]);
        assert.equal(result.events.find(event => event.type === "tool_result")?.status, "completed", JSON.stringify(result.events));
        assert.equal(result.evidence.find(row => row.type === "patch-probe")?.isError, true, JSON.stringify(result.evidence));
        assert.equal(existsSync(join(f.workspace, `${action}-never.txt`)), false);
      }
    });
    await t.test("readonly role and inherited parent ceiling reject forged child mutation calls", async () => {
      for (const [role, ceiling] of [["dsmm-code-search", false], ["dsmm-quick", true]]) {
        await configurePatch(f, { enabled: true, ceiling, settings: { roleRouting: {
          "dsmm-orchestrator": { primary: { provider: "local", model: "configured-model" } },
          [role]: { primary: { provider: "local", model: "child-model" } }
        } } });
        let parentCalls = 0, childCalls = 0;
        f.handler = (body, res) => {
          if (body.model === "child-model") {
            if (++childCalls === 1) {
              assert.equal(body.tools.some(row => row.function.name === "apply_patch"), false, "child admission must hide mutation");
              return sse(res, body, { tool_calls: [{ index: 0, id: "forged-patch", type: "function", function: {
                name: "apply_patch", arguments: JSON.stringify({ input: patch(add(`${role}-never.txt`)) })
              } }] }, "tool_calls");
            }
            return sse(res, body, { content: "isolated-child-complete" });
          }
          if (++parentCalls === 1) {
            assert.equal(body.tools.some(row => row.function.name === "apply_patch"), !ceiling);
            const kind = ceiling ? "category" : "role", direct = role.replaceAll("-", "_");
            const name = body.tools.some(row => row.function.name === direct) ? direct : `dsmm_${kind}`;
            const schema = body.tools.find(row => row.function.name === name)?.function;
            assert.ok(schema);
            const args = { description: "Verify inherited patch boundary", prompt: "Complete the isolated native boundary probe.",
              ...(name === direct ? {} : { [kind]: role }) };
            if (schema.parameters.properties.level) args.level = "normal";
            if (schema.parameters.properties.run_in_background) args.run_in_background = false;
            return toolCall(res, body, name, args);
          }
          return sse(res, body, { content: "native-apply-patch-complete" });
        };
        const result = await runCli(f, `patch-child-${role}`); successful(result);
        assert.ok(childCalls >= 2, JSON.stringify(result));
        assert.ok(patchResults(result).some(row => row.isError === true), JSON.stringify(result.evidence));
        assert.equal(existsSync(join(f.workspace, `${role}-never.txt`)), false);
      }
    });
  } finally { await f.dispose(); }
});
