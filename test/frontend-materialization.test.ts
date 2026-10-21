import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { FRONTEND_PINS, frontendRecipe } = await import(new URL("../scripts/frontend-recipe.mjs", import.meta.url).href);
const { checkFrontendAssets, materializeFrontend } = await import(new URL("../scripts/materialize-frontend.mjs", import.meta.url).href);

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dsmm-frontend-test-"));
  writeFileSync(join(directory, ".run-owner"), "frontend-materialization.test.ts\n");
  mkdirSync(join(directory, "skills"));
  cpSync(join(root, "skills/frontend"), join(directory, "skills/frontend"), { recursive: true });
  return directory;
}
function cleanup(directory: string) {
  assert.equal(dirname(directory), tmpdir());
  assert.equal(readFileSync(join(directory, ".run-owner"), "utf8"), "frontend-materialization.test.ts\n");
  rmSync(directory, { recursive: true });
}

test("frontend mapping covers referenced resources and Python dependencies", () => {
  const rows: Array<{ source: string; target: string; upstream: string }> = frontendRecipe();
  assert.equal(new Set(rows.map((row) => row.target)).size, rows.length);
  assert.equal(rows.some((row) => row.target === "references/design/aside.md"), false);
  assert.ok(rows.some((row) => row.source === "design-systems/linear-app/DESIGN.md" && row.target === "references/design/linear.app.md"));
  assert.ok(rows.some((row) => row.source === "skills/brandkit/SKILL.md" && row.target === "references/design/imagegen-brandkit.md"));
  assert.ok(rows.some((row) => row.source === "skills/stitch-skill/DESIGN.md" && row.target === "references/design/stitch-design-example.md"));
  for (const target of ["data/app-interface.csv", "data/web-interface.csv", "data/google-fonts.csv", "data/stacks/threejs.csv", "data/stacks/angular.csv", "data/stacks/laravel.csv"]) assert.ok(rows.some((row) => row.target === `references/ui-ux-db/${target}`), target);
  assert.equal(checkFrontendAssets().outcome, "ready");
});

test("the bundled frontend command restricts persistence to the approved project output", () => {
  const directory = fixture();
  try {
    const resourceBase = realpathSync.native(join(directory, "skills/frontend"));
    const entry = readFileSync(join(resourceBase, "SKILL.md"), "utf8");
    const example = /```powershell\n([\s\S]*?)\n```/u.exec(entry)?.[1];
    assert.ok(example, "authored resource/cwd/output guidance must include its actual example");
    const projectPath = join(directory, "target-project");
    mkdirSync(projectPath);
    const project = realpathSync.native(projectPath), output = join(project, "approved-output");
    const capture = join(directory, "capture-cli.mjs");
    writeFileSync(capture, "console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n");
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const run = (cwd: string, approved: string) => spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command",
      `$skillResourceBase = ${quote(resourceBase)}; $targetProject = ${quote(project)}; $approvedOutputDir = ${quote(approved)}; function python3 { & ${quote(process.execPath)} ${quote(capture)} @args }; ${example}`], { cwd, encoding: "utf8", timeout: 30000 });
    // Only our capture stub runs. No imported/executed Python/vendor tool, no
    // hidden cd or invented native tool cwd field; actual process cwd is proof.
    const success = run(project, output);
    assert.equal(success.status, 0, success.stderr);
    const invocation = JSON.parse(success.stdout);
    assert.equal(invocation.cwd, project);
    assert.equal(invocation.args[0], join(resourceBase, "references/ui-ux-db/scripts/search.py"));
    assert.equal(invocation.args[invocation.args.indexOf("--output-dir") + 1], output);
    assert.ok(invocation.args.includes("--persist"));
    assert.equal(existsSync(join(resourceBase, "design-system")), false);
    const wrongCwd = run(resourceBase, output);
    assert.notEqual(wrongCwd.status, 0); assert.equal(wrongCwd.stdout.trim(), "");
    assert.match(wrongCwd.stderr, /Target project cwd is not active/u);
    const wrongOutput = run(project, resourceBase);
    assert.notEqual(wrongOutput.status, 0); assert.equal(wrongOutput.stdout.trim(), "");
    assert.match(wrongOutput.stderr, /Persistence must not write the installed skill tree/u);
  } finally { cleanup(directory); }
});

test("offline check detects missing resources without writes and explicit sync restores them", async () => {
  const directory = fixture();
  try {
    const noNetwork = () => { throw new Error("network must not be requested"); };
    assert.deepEqual(await materializeFrontend({ root: directory, fetchBytes: noNetwork }), { outcome: "ready", requests: 0, differences: [], files: frontendRecipe(directory).length });
    const target = "references/ui-ux-db/scripts/core.py", path = join(directory, "skills/frontend", target);
    rmSync(path);
    const failed = checkFrontendAssets(directory);
    assert.ok(failed.errors.some((error: string) => error.startsWith(`missing frontend resource: ${target} <-`)));
    assert.equal(existsSync(path), false);
    let requests = 0;
    const fixed = await materializeFrontend({ root: directory, async fetchBytes(url: string) {
      requests++;
      assert.equal(url, `https://raw.githubusercontent.com/nextlevelbuilder/ui-ux-pro-max-skill/${FRONTEND_PINS["ui-ux-pro-max"].commit}/src/ui-ux-pro-max/scripts/core.py`);
      return readFileSync(join(root, "skills/frontend", target));
    } });
    assert.equal(requests, 1); assert.deepEqual(fixed.differences, [target]);
    assert.equal(checkFrontendAssets(directory).outcome, "ready");
    rmSync(join(directory, "skills/frontend/references/design/stripe.md"));
    assert.ok(checkFrontendAssets(directory).errors.some((error: string) => error.startsWith("missing frontend resource: references/design/stripe.md <- nexu-io/open-design@")));
    assert.equal(existsSync(join(directory, "skills/frontend/references/design/stripe.md")), false);
  } finally { cleanup(directory); }
});

test("a missing fixed-tree path fails precisely before writes; materializer refuses foreign destinations", async () => {
  const directory = fixture();
  try {
    const inventory = JSON.parse(readFileSync(join(directory, "skills/frontend/.frontend-materialized.json"), "utf8"));
    rmSync(join(directory, "skills/frontend/.frontend-materialized.json"));
    const aside = readFileSync(join(directory, "skills/frontend/references/design/aside.md"));
    await assert.rejects(materializeFrontend({ root: directory, async fetchBytes(url: string) {
      const upstream = (Object.entries(FRONTEND_PINS) as Array<[string, { repository: string; commit: string }]>).find(([, pin]) => url === `https://api.github.com/repos/${pin.repository}/git/trees/${pin.commit}?recursive=1`)?.[0];
      assert.ok(upstream, url);
      return Buffer.from(JSON.stringify({ truncated: false, tree: inventory.files.filter((row: { upstream: string; source: string }) => row.upstream === upstream && row.source !== "design-systems/stripe/DESIGN.md").map((row: { source: string; blob: string }) => ({ path: row.source, sha: row.blob, type: "blob" })) }));
    } }), /fixed path missing: nexu-io\/open-design@6afe7eae156bfa29251a51fd0636649c257f7444\/design-systems\/stripe\/DESIGN.md -> references\/design\/stripe.md/u);
    assert.deepEqual(readFileSync(join(directory, "skills/frontend/references/design/aside.md")), aside);
    assert.equal(existsSync(join(directory, "skills/frontend/.frontend-materialized.json")), false);
    await assert.rejects(materializeFrontend({ root: join(directory, "not-owned") }), /marked test-owned root/u);
  } finally { cleanup(directory); }
});

test("materialization rejects dangling resource, inventory and parent links before an outside-owned-subtree write", async (t) => {
  for (const kind of ["resource", "inventory", "parent"] as const) await t.test(kind, async () => {
    const directory = fixture();
    try {
      const inventory = JSON.parse(readFileSync(join(directory, "skills/frontend/.frontend-materialized.json"), "utf8"));
      const target = kind === "resource" ? "references/ui-ux-db/scripts/core.py" : kind === "inventory" ? ".frontend-materialized.json" : "references/ui-ux-db/scripts";
      const link = join(directory, "skills/frontend", target), sentinel = join(directory, `absent-${kind}`);
      rmSync(link, { recursive: kind === "parent" });
      if (kind === "parent") mkdirSync(sentinel); else writeFileSync(sentinel, "controlled live target\n");
      symlinkSync(sentinel, link, kind === "parent" ? "junction" : "file");
      assert.throws(() => checkFrontendAssets(directory), /linked or not a regular owned file/u, "the existing live-link guard must remain effective");
      rmSync(sentinel, { recursive: kind === "parent" });
      let requests = 0;
      await assert.rejects(materializeFrontend({ root: directory, async fetchBytes(url: string) {
        requests++;
        const upstream = (Object.entries(FRONTEND_PINS) as Array<[string, { repository: string; commit: string }]>).find(([, pin]) => url.includes(`${pin.repository}/`) && url.includes(pin.commit))?.[0];
        assert.ok(upstream, url);
        if (url.startsWith("https://api.github.com/")) return Buffer.from(JSON.stringify({ truncated: false, tree: inventory.files.filter((row: { upstream: string }) => row.upstream === upstream).map((row: { source: string; blob: string }) => ({ path: row.source, sha: row.blob, type: "blob" })) }));
        const row = inventory.files.find((file: { upstream: string; source: string }) => file.upstream === upstream && url.endsWith(`/${file.source}`));
        assert.ok(row, url);
        return readFileSync(join(root, "skills/frontend", row.target));
      } }), /linked or not a regular owned file/u);
      assert.equal(existsSync(sentinel), false, `${kind}: dangling link must not create the run-owned external sentinel`);
      assert.equal(requests, 0, `${kind}: reject before fetching any source`);
    } finally { cleanup(directory); }
  });
});

test("actual tarball ships every frontend resource and native skill resourceBase resolves in a standalone checkout", async () => {
  const directory = fixture();
  try {
    const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd pack --ignore-scripts --json --pack-destination %DSMM_FRONTEND_PACK_DIR%"] : ["pack", "--ignore-scripts", "--json", "--pack-destination", directory];
    const packed = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 120000, env: { ...process.env, DSMM_FRONTEND_PACK_DIR: `"${directory}"` } });
    assert.equal(packed.status, 0, packed.stderr);
    const receipt = JSON.parse(packed.stdout)[0];
    const paths = new Set(receipt.files.map((file: { path: string }) => file.path));
    for (const row of frontendRecipe() as Array<{ target: string }>) assert.ok(paths.has(`skills/frontend/${row.target}`), row.target);
    assert.ok(paths.has("skills/frontend/.frontend-materialized.json"));
    const extract = spawnSync("tar", ["-xzf", join(directory, receipt.filename), "-C", directory], { encoding: "utf8", timeout: 30000 });
    assert.equal(extract.status, 0, extract.stderr);
    const staged = join(directory, "package");
    // Supply existing declared SDK peers, never install a package or create a
    // source-checkout dependency in the distribution itself.
    const pinnedEntry = process.env.DSMM_TEST_DSH_ENTRY;
    const peers = createRequire(pinnedEntry === undefined ? import.meta.url : realpathSync.native(pinnedEntry));
    mkdirSync(join(staged, "node_modules/@deepseek-ai"), { recursive: true });
    for (const name of ["cordis", "dsh-agent-preset-registry"]) {
      const installed = dirname(peers.resolve(`@deepseek-ai/${name}/package.json`));
      symlinkSync(installed, join(staged, "node_modules/@deepseek-ai", name), "junction");
    }
    const module = await import(pathToFileURL(join(staged, "lib/skills.js")).href);
    const loaded = await module.readBundledSkill("frontend", new AbortController().signal);
    assert.deepEqual(loaded.resourceBase, { kind: "directory", path: join(staged, "skills/frontend") });
    assert.equal(checkFrontendAssets(staged).outcome, "ready");
    assert.equal(readdirSync(directory).filter((file) => file.endsWith(".tgz")).length, 1);
  } finally { cleanup(directory); }
});
