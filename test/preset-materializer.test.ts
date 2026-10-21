import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DSMM_ROLES, renderAgentCordis, renderPresetMetadata } from "../lib/roles.js";
import { DEFAULT_DSMM_SETTINGS, resolveConfig } from "../lib/settings.js";
import { enabledSkillNames } from "../lib/skills.js";
import {
  DSMM_MANAGED_PRESET_MARKER,
  DSMM_MANAGED_PRESET_MARKER_VERSION,
  materializeRolePresets,
  reconcileRolePresets,
  renderManagedPresetMarker,
  resolveManagedPresetRoot
} from "../lib/preset-materializer.js";
import { useIsolatedDshEnvironment } from "./dsh-test-environment.ts";

useIsolatedDshEnvironment();

const LEGACY_MARKER = "managed by dsmm\n";

test("renderManagedPresetMarker binds version one to the exact role", () => {
  assert.equal(DSMM_MANAGED_PRESET_MARKER_VERSION, 1);
  assert.equal(renderManagedPresetMarker("dsmm-reviewer"), "dsmm-managed-preset/v1\nrole=dsmm-reviewer\n");
});

function currentMarker(role: string): string {
  return `dsmm-managed-preset/v1\nrole=${role}\n`;
}

function settingsWithOnlyRoleEnabled(roleId: string) {
  return resolveConfig({
    presets: { materialize: true },
    roles: Object.fromEntries(DSMM_ROLES.map((role) => [role.id, role.id === roleId]))
  });
}

function settingsWithAllRolesDisabled(materialize = true) {
  return resolveConfig({
    presets: { materialize },
    roles: Object.fromEntries(DSMM_ROLES.map((role) => [role.id, false]))
  });
}

function roleDefinition(roleId: string) {
  const role = DSMM_ROLES.find((candidate) => candidate.id === roleId);
  assert.ok(role, `known role ${roleId}`);
  return role;
}

function writeManagedRole(root: string, roleId: string, marker: string, agent = "old agent\n", preset = "old preset\n"): string {
  const directory = join(root, roleId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "agent.cordis.yml"), agent, "utf8");
  writeFileSync(join(directory, "preset.yml"), preset, "utf8");
  writeFileSync(join(directory, DSMM_MANAGED_PRESET_MARKER), marker, "utf8");
  return directory;
}

function assertExactManagedRole(directory: string, roleId: string): void {
  const role = roleDefinition(roleId);
  assert.deepEqual(readdirSync(directory).sort(), [DSMM_MANAGED_PRESET_MARKER, "agent.cordis.yml", "preset.yml"].sort());
  assert.equal(readFileSync(join(directory, "agent.cordis.yml"), "utf8"), renderAgentCordis(role, undefined, [role.id]));
  assert.equal(readFileSync(join(directory, "preset.yml"), "utf8"), renderPresetMetadata(role));
  assert.equal(readFileSync(join(directory, DSMM_MANAGED_PRESET_MARKER), "utf8"), currentMarker(roleId));
}

function snapshotDirectory(directory: string): ReadonlyMap<string, string> {
  return new Map(readdirSync(directory).sort().map((entry) => [entry, readFileSync(join(directory, entry), "utf8")]));
}

function linkedPathFilesystem(linkedPath: string, file: boolean) {
  return {
    lstatSync(path: string) {
      if (path === linkedPath) {
        return {
          isSymbolicLink: () => true,
          isDirectory: () => !file,
          isFile: () => file
        };
      }
      return lstatSync(path);
    }
  };
}

function tempSiblings(root: string, roleId: string): readonly string[] {
  return readdirSync(root).filter((entry) => entry.startsWith(`.${roleId}.dsmm-`));
}

test("reconcileRolePresets materializes only the dispatcher and removes other owned role directories", () => {
  usingFixture((root) => {
    const settings = resolveConfig({ presets: { materialize: true }, roles: { "dsmm-reviewer": false } });
    const reviewer = writeManagedRole(root, "dsmm-reviewer", currentMarker("dsmm-reviewer"));

    reconcileRolePresets({ root, settings });

    assert.equal(existsSync(reviewer), false, "a non-dispatcher owned directory is removed");
    const dispatcher = roleDefinition("dsmm-orchestrator");
    const presetDirectory = join(root, dispatcher.id);
    assert.equal(readFileSync(join(presetDirectory, "agent.cordis.yml"), "utf8"), renderAgentCordis(dispatcher, enabledSkillNames(settings), DSMM_ROLES.filter((candidate) => settings.roles[candidate.id]).map((candidate) => candidate.id)));
    assert.equal(readFileSync(join(presetDirectory, "preset.yml"), "utf8"), renderPresetMetadata(dispatcher));
    assert.equal(readFileSync(join(presetDirectory, DSMM_MANAGED_PRESET_MARKER), "utf8"), currentMarker(dispatcher.id));
    for (const role of DSMM_ROLES) {
      if (role.id === dispatcher.id) continue;
      assert.equal(existsSync(join(root, role.id)), false, `${role.id} is not materialized`);
    }
    const original = snapshotDirectory(presetDirectory);
    const off = resolveConfig({ modules: { deepwork: { enabled: false } }, presets: { materialize: false } });
    reconcileRolePresets({ root, settings: off });
    assert.deepEqual(snapshotDirectory(presetDirectory), original, "module off reconciliation preserves the existing export");
    materializeRolePresets({ root, settings: off });
    assert.deepEqual(snapshotDirectory(presetDirectory), original, "module off must not delete or rewrite previously materialized assets");
  });
});

test("reconcileRolePresets refuses an unmarked dispatcher directory and never claims foreign non-dispatcher roles", () => {
  usingFixture((root) => {
    const dispatcherDirectory = join(root, "dsmm-orchestrator");
    const userFile = join(dispatcherDirectory, "user.txt");
    mkdirSync(dispatcherDirectory, { recursive: true });
    writeFileSync(userFile, "keep this user content\n", "utf8");
    const reviewer = writeManagedRole(root, "dsmm-reviewer", currentMarker("dsmm-reviewer"));
    const reviewerBefore = snapshotDirectory(reviewer);

    assert.throws(
      () => reconcileRolePresets({ root, settings: resolveConfig({ presets: { materialize: true } }) }),
      /foreign|managed|marker/i
    );
    assert.equal(readFileSync(userFile, "utf8"), "keep this user content\n");
    assert.equal(existsSync(join(dispatcherDirectory, "agent.cordis.yml")), false);
    assert.deepEqual(snapshotDirectory(reviewer), reviewerBefore, "a foreign non-dispatcher directory stays untouched");
  });
});

test("reconcileRolePresets rejects malformed or role-mismatched markers without changing foreign content", () => {
  for (const [name, marker] of [
    ["wrong role", currentMarker("dsmm-planner")],
    ["malformed", "dsmm-managed-preset/v1\nrole=dsmm-orchestrator\nextra=true\n"]
  ]) {
    usingFixture((root) => {
      const directory = writeManagedRole(root, "dsmm-orchestrator", marker, "user agent\n", "user preset\n");
      const before = snapshotDirectory(directory);

      assert.throws(
        () => reconcileRolePresets({ root, settings: settingsWithOnlyRoleEnabled("dsmm-orchestrator") }),
        /foreign|marker|managed/i,
        `${name} marker is foreign`
      );
      assert.deepEqual(snapshotDirectory(directory), before, `${name} directory remains untouched`);
    });
  }
});

test("reconcileRolePresets rejects linked role paths and linked managed files without changing destinations", () => {
  usingFixture((root) => {
    const external = writeManagedRole(join(root, "external"), "dsmm-orchestrator", currentMarker("dsmm-orchestrator"));
    const linkedDirectory = join(root, "dsmm-orchestrator");
    // Node 26 reports an inside-root junction as a plain directory, so the refusal
    // is verified through the link-reporting filesystem seam.
    const before = snapshotDirectory(external);

    assert.throws(
      () => reconcileRolePresets({ root, settings: settingsWithOnlyRoleEnabled("dsmm-orchestrator"), filesystem: linkedPathFilesystem(linkedDirectory, false) }),
      /link|symbolic|managed/i
    );
    assert.deepEqual(snapshotDirectory(external), before, "linked role destination remains untouched");
  });

  for (const fileName of [DSMM_MANAGED_PRESET_MARKER, "agent.cordis.yml", "preset.yml"]) {
    usingFixture((root) => {
      const directory = writeManagedRole(root, "dsmm-orchestrator", currentMarker("dsmm-orchestrator"));
      const linkPath = join(directory, fileName);
      const original = readFileSync(linkPath, "utf8");

      assert.throws(
        () => reconcileRolePresets({ root, settings: settingsWithOnlyRoleEnabled("dsmm-orchestrator"), filesystem: linkedPathFilesystem(linkPath, true) }),
        /link|symbolic|managed/i,
        `linked ${fileName} is rejected`
      );
      assert.equal(readFileSync(linkPath, "utf8"), original, `linked ${fileName} remains untouched`);
    });
  }
});

test("reconcileRolePresets rejects a canonical role path outside the canonical root", () => {
  usingFixture((root) => {
    const directory = writeManagedRole(root, "dsmm-orchestrator", currentMarker("dsmm-orchestrator"));
    const outsideParent = mkdtempSync(join(tmpdir(), "dsmm-preset-outside-"));
    try {
      const outside = join(outsideParent, "dsmm-orchestrator");
      mkdirSync(outside, { recursive: true });
      const before = snapshotDirectory(directory);
      const filesystem = {
        realpathSync(path: string) {
          return path === directory ? outside : path;
        }
      };

      assert.throws(
        () => reconcileRolePresets({ root, settings: settingsWithOnlyRoleEnabled("dsmm-orchestrator"), filesystem }),
        /outside|containment|root/i
      );
      assert.deepEqual(snapshotDirectory(directory), before);
    } finally {
      rmSync(outsideParent, { recursive: true, force: true });
    }
  });
});

test("reconcileRolePresets updates an exact current role and refuses current roles with extra entries", () => {
  usingFixture((root) => {
    const directory = writeManagedRole(root, "dsmm-orchestrator", currentMarker("dsmm-orchestrator"));

    reconcileRolePresets({ root, settings: settingsWithOnlyRoleEnabled("dsmm-orchestrator") });

    assertExactManagedRole(directory, "dsmm-orchestrator");
  });

  usingFixture((root) => {
    const directory = writeManagedRole(root, "dsmm-orchestrator", currentMarker("dsmm-orchestrator"));
    writeFileSync(join(directory, "user.txt"), "do not overwrite\n", "utf8");
    const before = snapshotDirectory(directory);

    assert.throws(
      () => reconcileRolePresets({ root, settings: settingsWithOnlyRoleEnabled("dsmm-orchestrator") }),
      /foreign|extra|managed/i
    );
    assert.deepEqual(snapshotDirectory(directory), before, "current marker with a user entry is not claimed");
  });
});

test("reconcileRolePresets migrates only an exact safe legacy role", () => {
  usingFixture((root) => {
    const directory = writeManagedRole(root, "dsmm-orchestrator", LEGACY_MARKER, "legacy agent\n", "legacy preset\n");

    reconcileRolePresets({ root, settings: settingsWithOnlyRoleEnabled("dsmm-orchestrator") });

    assertExactManagedRole(directory, "dsmm-orchestrator");
  });

  usingFixture((root) => {
    const directory = writeManagedRole(root, "dsmm-orchestrator", LEGACY_MARKER, "legacy agent\n", "legacy preset\n");
    writeFileSync(join(directory, "user.txt"), "keep\n", "utf8");
    const before = snapshotDirectory(directory);

    assert.throws(
      () => reconcileRolePresets({ root, settings: settingsWithOnlyRoleEnabled("dsmm-orchestrator") }),
      /foreign|extra|managed/i
    );
    assert.deepEqual(snapshotDirectory(directory), before, "legacy directory with extras is never migrated");

    assert.doesNotThrow(() => reconcileRolePresets({ root, settings: settingsWithAllRolesDisabled() }));
    assert.deepEqual(snapshotDirectory(directory), before, "legacy directory with extras is never removed");
  });
});

test("reconcileRolePresets removes only disabled known current or safe legacy roles", () => {
  usingFixture((root) => {
    const currentDirectory = writeManagedRole(root, "dsmm-reviewer", currentMarker("dsmm-reviewer"));
    const legacyDirectory = writeManagedRole(root, "dsmm-planner", LEGACY_MARKER);
    const unknownDirectory = writeManagedRole(root, "custom-preset", currentMarker("dsmm-reviewer"));
    const unknownRoleDirectory = writeManagedRole(root, "dsmm-unknown", currentMarker("dsmm-reviewer"));

    reconcileRolePresets({ root, settings: settingsWithAllRolesDisabled(false) });

    assert.equal(existsSync(currentDirectory), false, "known current role is removed");
    assert.equal(existsSync(legacyDirectory), false, "known safe legacy role is removed");
    assert.equal(existsSync(unknownDirectory), true, "unknown directory is untouched");
    assert.equal(existsSync(unknownRoleDirectory), true, "unknown role name is untouched");
  });
});

test("reconcileRolePresets publishes new role directories atomically and cleans private siblings on failure", () => {
  usingFixture((root) => {
    const roleId = "dsmm-orchestrator";
    const finalDirectory = join(root, roleId);
    const writes: string[] = [];
    let renamed = false;
    reconcileRolePresets({
      root,
      settings: settingsWithOnlyRoleEnabled(roleId),
      filesystem: {
        writeFileSync(path: string, data: string, encoding: "utf8") {
          assert.equal(existsSync(finalDirectory), false, "final directory is absent while private files are written");
          writes.push(path);
          writeFileSync(path, data, encoding);
        },
        renameSync(from: string, to: string) {
          assert.equal(existsSync(finalDirectory), false, "final directory is absent before publication");
          assert.equal(from.startsWith(join(root, `.${roleId}.dsmm-`)), true, "temporary directory is a private sibling");
          assert.equal(to, finalDirectory);
          renamed = true;
          return renameSync(from, to);
        }
      }
    });
    assert.equal(renamed, true);
    assert.equal(writes.length, 3, "all three managed files are private before publication");
    assertExactManagedRole(finalDirectory, roleId);
  });

  for (const failure of ["write", "rename"] as const) {
    usingFixture((root) => {
      const roleId = "dsmm-orchestrator";
      const finalDirectory = join(root, roleId);
      const filesystem = failure === "write"
        ? {
            writeFileSync(path: string, data: string, encoding: "utf8") {
              if (path.endsWith("preset.yml")) throw new Error("injected write failure");
              return writeFileSync(path, data, encoding);
            }
          }
        : {
            renameSync() {
              throw new Error("injected rename failure");
            }
          };

      assert.throws(
        () => reconcileRolePresets({ root, settings: settingsWithOnlyRoleEnabled(roleId), filesystem }),
        new RegExp(`injected ${failure} failure`)
      );
      assert.equal(existsSync(finalDirectory), false, `${failure} failure never publishes a partial role`);
      assert.deepEqual(tempSiblings(root, roleId), [], `${failure} failure cleans the exact private sibling`);
    });
  }
});

test("reconcileRolePresets removes non-dispatcher owned directories only when dsmm-marked", () => {
  usingFixture((root) => {
    const reviewerDirectory = writeManagedRole(root, "dsmm-reviewer", currentMarker("dsmm-reviewer"));
    const clarifierDirectory = writeManagedRole(root, "dsmm-clarifier", currentMarker("dsmm-clarifier"));
    rmSync(join(reviewerDirectory, DSMM_MANAGED_PRESET_MARKER));

    reconcileRolePresets({ root, settings: resolveConfig({ presets: { materialize: true } }) });

    assert.equal(existsSync(clarifierDirectory), false, "marked non-dispatcher owned directory is removed");
    assert.equal(existsSync(reviewerDirectory), true, "unmarked non-dispatcher directory is preserved");
  });
});

test("reconcileRolePresets with materialize false removes known owned directories only", () => {
  usingFixture((root) => {
    reconcileRolePresets({ root, settings: resolveConfig({ presets: { materialize: true } }) });
    const foreignDirectory = join(root, "custom-preset");
    const legacyDirectory = join(root, "dsmm-legacy-role");
    writeFileSync(join(root, "custom-file.txt"), "keep\n", "utf8");
    rmSync(join(root, "dsmm-orchestrator", DSMM_MANAGED_PRESET_MARKER));
    mkdirSync(foreignDirectory, { recursive: true });
    writeFileSync(join(foreignDirectory, "preset.yml"), "id: custom-preset\n", "utf8");
    mkdirSync(legacyDirectory, { recursive: true });
    writeFileSync(join(legacyDirectory, DSMM_MANAGED_PRESET_MARKER), "managed by dsmm\n", "utf8");

    reconcileRolePresets({ root, settings: resolveConfig({ presets: { materialize: false } }) });

    assert.equal(existsSync(join(root, "dsmm-orchestrator")), true, "unmarked dsmm directory is preserved");
    assert.equal(existsSync(legacyDirectory), true, "unknown legacy-marked directory is preserved");
    assert.equal(existsSync(foreignDirectory), true, "unmarked custom directory is preserved");
    assert.equal(existsSync(join(root, "custom-file.txt")), true, "non-directory root files are preserved");
  });
});

test("materializeRolePresets writes enabled roles even when settings materialize is false", () => {
  usingFixture((root) => {
    materializeRolePresets({ root, settings: { ...DEFAULT_DSMM_SETTINGS, presets: { ...DEFAULT_DSMM_SETTINGS.presets, materialize: false } } });

    assert.equal(existsSync(join(root, "dsmm-orchestrator", DSMM_MANAGED_PRESET_MARKER)), true);
  });
});

test("materialized role composition does not publish private skills outside Agent admission", () => {
  usingFixture((root) => {
    const settings = resolveConfig({
      presets: { materialize: false },
      skills: { "writing-plans": false, "remove-ai-slops": false }
    });

    materializeRolePresets({ root, settings });

    const orchestrator = DSMM_ROLES.find((role) => role.id === "dsmm-orchestrator");
    assert.ok(orchestrator);
    const rendered = readFileSync(join(root, orchestrator.id, "agent.cordis.yml"), "utf8");
    assert.equal(rendered, renderAgentCordis(orchestrator, enabledSkillNames(settings)));
    assert.doesNotMatch(rendered, /@dsmm\/dsmm\/preset-skills|    skills:/u);
  });
});

test("all skills disabled still retains native project skill capability in the materialized role", () => {
  usingFixture((root) => {
    const settings = resolveConfig({
      presets: { materialize: false },
      skills: Object.fromEntries(enabledSkillNames(DEFAULT_DSMM_SETTINGS).map((skill) => [skill, false]))
    });

    materializeRolePresets({ root, settings });

    const rendered = readFileSync(join(root, "dsmm-orchestrator", "agent.cordis.yml"), "utf8");
    assert.doesNotMatch(rendered, /dsmm-preset-skills|    skills:/u);
    assert.match(rendered, /name: '@deepseek-ai\/dsh-tool-skill'/u);
  });
});

test("reconcileRolePresets materialize false no-ops when root is absent", () => {
  usingFixture((parent) => {
    const missingRoot = join(parent, "missing-root");

    assert.doesNotThrow(() => reconcileRolePresets({ root: missingRoot, settings: resolveConfig({ presets: { materialize: false } }) }));
    assert.equal(existsSync(missingRoot), false);
  });
});

test("resolveManagedPresetRoot falls back to DSH_HOME agent preset root", () => {
  assert.equal(
    resolveManagedPresetRoot(resolveConfig({ presets: { materialize: true } }), { DSH_HOME: "C:/tmp/dsh-home" }),
    join("C:/tmp/dsh-home", ".agent-presets")
  );
  assert.equal(resolveManagedPresetRoot(resolveConfig({ presets: { materialize: true } }), {}), undefined);
});

function usingFixture(callback: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "dsmm-presets-"));
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
