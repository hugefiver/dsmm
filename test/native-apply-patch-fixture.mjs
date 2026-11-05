import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configure, hostFixture as nativeHostFixture, runCli, sse, successful, toolCall } from "./native-host-route-boundaries-fixture.mjs";

export async function hostFixture(entry) {
  const f = await nativeHostFixture(entry);
  const root = await realpath(await mkdtemp(join(fileURLToPath(new URL("../", import.meta.url)), ".native-apply-patch-")));
  const owner = randomUUID(), marker = join(root, ".fixture-owner"), dispose = f.dispose;
  await writeFile(marker, owner, { flag: "wx" });
  f.workspace = join(root, "workspace");
  f.outside = join(root, "workspace-neighbor");
  await mkdir(f.workspace); await mkdir(f.outside);
  f.dispose = async () => {
    await dispose();
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    assert.equal(await realpath(root), root);
    assert.equal(await readFile(marker, "utf8"), owner);
    await rm(root, { recursive: true, force: false });
  };
  return f;
}

export const patch = (...operations) => ["*** Begin Patch", ...operations, "*** End Patch"].join("\n");
export const add = (path, text = "created") => `*** Add File: ${path}\n+${text}`;
export const update = (path, before = "original", after = "updated", destination) =>
  `*** Update File: ${path}\n${destination === undefined ? "" : `*** Move to: ${destination}\n`}@@\n-${before}\n+${after}`;

export async function configurePatch(f, { enabled, gate, ceiling = false, settings } = {}) {
  await configure(f, { settings });
  await cp(new URL("./native-apply-patch-plugin.mjs", import.meta.url), join(f.packageDir, "native-apply-patch-plugin.mjs"));
  const path = join(f.profileDir, "cordis.patch.yml");
  const rows = JSON.parse(await readFile(path, "utf8"));
  rows.push({ insert: [{ id: "native-apply-patch-fs", name: "@dsmm/dsmm/permission-fs",
    config: { read: false, readImage: false, write: false, edit: false, ...(enabled === undefined ? {} : { applyPatch: enabled }) } }] });
  rows.push({ insert: [{ id: "native-apply-patch-probe", name: join(f.packageDir, "native-apply-patch-plugin.mjs"),
    config: { gate, ceiling } }] });
  await writeFile(path, JSON.stringify(rows));
}

export async function sequence(f, name, steps, args = []) {
  let index = 0;
  f.handler = async (body, res) => {
    const step = steps[index++];
    if (step === undefined) return sse(res, body, { content: "native-apply-patch-complete" });
    if (typeof step === "function") return step(body, res);
    return toolCall(res, body, step[0], step[1]);
  };
  const result = await runCli(f, name, args);
  successful(result);
  return result;
}

export function patchResults(result) {
  return result.evidence.filter(row => row.type === "patch-result");
}

export function rejected(result, code) {
  const rows = patchResults(result), last = rows.at(-1);
  assert.equal(last?.isError, true, JSON.stringify(rows));
  assert.equal(last?.error?.info?.code, code, JSON.stringify(rows));
  return last;
}
