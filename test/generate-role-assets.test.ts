import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";

const { generateRoleAssets } = await import(new URL("../scripts/generate-role-assets.mjs", import.meta.url).href);

test("role consistency check detects drift without rewriting generated assets", () => {
  const root = mkdtempSync(join(tmpdir(), "dsmm-role-assets-test-"));
  try {
    const generated = generateRoleAssets({ root });
    assert.equal(generated.differences.length, generated.outputs);
    assert.deepEqual(generateRoleAssets({ check: true, root }).differences, []);

    const artifact = generated.differences[0];
    assert.ok(artifact);
    const path = join(root, artifact);
    const expected = readFileSync(path, "utf8");
    const drifted = `${expected}\n`;
    writeFileSync(path, drifted);

    assert.deepEqual(generateRoleAssets({ check: true, root }).differences, [artifact]);
    assert.equal(readFileSync(path, "utf8"), drifted);
    assert.deepEqual(generateRoleAssets({ root }).differences, [artifact]);
    assert.equal(readFileSync(path, "utf8"), expected);
  } finally {
    assert.equal(dirname(root), tmpdir());
    rmSync(root, { recursive: true });
  }
});
