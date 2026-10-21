import assert from "node:assert/strict";
import { after, before } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One isolated process layer per test file; explicit fixture homes remain authoritative. */
export function useIsolatedDshEnvironment(): void {
  let root: string;
  let original: Record<string, string | undefined>;
  const owner = "dsmm-test-environment";
  before(() => {
    assert.ok(existsSync(tmpdir()), "the temporary parent must exist");
    root = mkdtempSync(join(tmpdir(), "dsmm-test-environment-"));
    writeFileSync(join(root, ".run-owner"), owner, { flag: "wx" });
    original = { DSH_HOME: process.env.DSH_HOME, DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME };
    for (const [key, folder] of [["DSH_HOME", "home"], ["DSH_AGENTS_HOME", "agents"]]) {
      const path = join(root, folder);
      mkdirSync(path);
      process.env[key] = path;
    }
  });
  after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.equal(readFileSync(join(root, ".run-owner"), "utf8"), owner);
    rmSync(root, { recursive: true, force: true });
  });
}
