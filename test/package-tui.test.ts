import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { DSMM_TUI_COMPONENT_ID, DSMM_TUI_CONTRIBUTIONS } from "../lib/tui-actions.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tuiPackageRoot = process.env.DSMM_TEST_TUI_PACKAGE_ROOT;

test("the packaged TUI admits the DSMM command declaration after Component projection", {
  skip: tuiPackageRoot === undefined ? "Set DSMM_TEST_TUI_PACKAGE_ROOT to an installed dsh-tui package to exercise its admission validator" : false
}, async () => {
  assert.ok(tuiPackageRoot);
  const requireTui = createRequire(join(tuiPackageRoot, "package.json"));
  const { parseManifest, projectManifest } = await import(pathToFileURL(requireTui.resolve("@dsh-std/manifest")).href);
  const { createContractIndex, validatePlugin } = await import(pathToFileURL(join(tuiPackageRoot, "lib/types/adapter/standard/admission.js")).href);
  const { loadSpecData } = await import(pathToFileURL(join(tuiPackageRoot, "lib/types/adapter/standard/registry.js")).href);
  const data = loadSpecData();
  assert.ok(data, "the packaged TUI admission catalog must be available");
  const manifest = parseManifest(readFileSync(join(root, "dsh-plugin.json"), "utf8"));
  projectManifest(manifest);
  validatePlugin(createContractIndex(data.registry, data.permissions), manifest);
  assert.equal(manifest.contributes.commands.length, 1);
  assert.deepEqual(manifest.permissions.map((permission: { name: string; scope: string }) => [permission.name, permission.scope]),
    [["commands.invoke", "com.hugefiver.dsmm.manage"]]);
});

test("package ships a host-only 0.15 TUI declaration bound to actual commands", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(root, "dsh-plugin.json"), "utf8"));
  assert.equal(manifest.manifestVersion, "0.15");
  assert.equal(manifest.id, DSMM_TUI_COMPONENT_ID);
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual(Object.keys(manifest.facets), ["host"]);
  assert.equal(manifest.facets.host.apiVersion, "v1alpha1");
  assert.equal(existsSync(join(root, manifest.facets.host.entry)), true);
  assert.deepEqual(manifest.requires.contracts, [{ apiVersion: "commands.dsh/v1alpha1", kind: "Command" }]);
  assert.deepEqual(manifest.contributes.commands.map((entry: { id: string }) => entry.id).sort(), Object.values(DSMM_TUI_CONTRIBUTIONS).sort());
  assert.deepEqual(manifest.permissions.map((entry: { name: string; scope: string }) => [entry.name, entry.scope]).sort(),
    Object.values(DSMM_TUI_CONTRIBUTIONS).map(scope => ["commands.invoke", scope]).sort());
  assert.equal(manifest.license, pkg.license);
  assert.equal(pkg.dsh.client.platform, "web", "the existing Web client metadata remains independent of the host manifest");
});
