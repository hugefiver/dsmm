import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

let bashDirectory: string | undefined;
if (process.platform === "win32") {
  const git = spawnSync("git.exe", ["--exec-path"], { encoding: "utf8" });
  assert.ifError(git.error);
  assert.equal(git.status, 0, git.stderr);
  const bash = resolve(git.stdout.trim(), "../../..", "bin/bash.exe");
  assert.ok(existsSync(bash), "real shell coverage requires native Bash from the installed Git distribution");
  bashDirectory = dirname(bash);
}

// The process owner removes native-addon caches only after the SDK releases its DLLs.
for (const managed of [false, true]) {
  const kind = managed ? "managed" : "raw";
  for (const name of [
    `native readonly own-layer-only ${kind} bash/pwsh composes without masking local tools and preserves runtime denial`,
    `native Full Access readonly child blocks real ${kind} bash/pwsh before execution, direct and AgentLoop`,
    `native Full Access readonly child/scope-off rejects ${kind} shell; ordinary controls execute`,
    `live reviewer keeps real ${kind} shell denial across parent off and future defaults; retired owner cannot recover it`
  ]) {
    test(name, t => {
      const root = mkdtempSync(join(tmpdir(), "dsmm-readonly-shell-home-")), owner = randomUUID();
      writeFileSync(join(root, ".run-owner"), owner, { flag: "wx" });
      try {
        const env = { ...process.env };
        if (bashDirectory !== undefined) {
          const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
          env[pathKey] = `${bashDirectory}${delimiter}${env[pathKey] ?? ""}`;
        }
        for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "APPDATA", "LOCALAPPDATA", "DSH_HOME", "DSH_AGENTS_HOME"]) {
          const directory = join(root, key); mkdirSync(directory); env[key] = directory;
        }
        for (const key of ["BASH_ENV", "ENV", "HISTFILE", "NODE_TEST_CONTEXT"]) delete env[key];
        const loaders = ["--import", new URL("./prompt-source-loader.mjs", import.meta.url).href,
          ...env.DSMM_TEST_DSH_ENTRY === undefined ? [] : ["--import", new URL("./host-llm-source-loader.mjs", import.meta.url).href]];
        const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`;
        const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--experimental-strip-types", ...loaders, "--test-name-pattern", pattern,
          fileURLToPath(new URL("./native-readonly-shell-fixture.ts", import.meta.url))], {
          cwd: fileURLToPath(new URL("../", import.meta.url)), env, encoding: "utf8", timeout: 90000, maxBuffer: 4 * 1024 * 1024
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /^# pass 1\r?$/mu, "the isolated runner must execute its selected real SDK scenario\n" + result.stdout);
        t.diagnostic(result.stdout.trim());
      } finally {
        assert.equal(lstatSync(root).isSymbolicLink(), false);
        assert.equal(readFileSync(join(root, ".run-owner"), "utf8"), owner);
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }
}
