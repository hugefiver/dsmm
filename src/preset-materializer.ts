import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { DSMM_ROLES, DSMM_ROLE_IDS, renderAgentCordis, renderPresetMetadata } from "./roles.js";
import type { DsmmRoleId } from "./roles.js";
import { isRoleEnabled, isRootRoleEnabled } from "./settings.js";
import type { DsmmSettings } from "./settings.js";
import { enabledSkillNames } from "./skills.js";

export const DSMM_MANAGED_PRESET_MARKER = ".dsmm-managed-preset";
export const DSMM_MANAGED_PRESET_MARKER_VERSION = 1;

const LEGACY_MANAGED_PRESET_MARKER = "managed by dsmm\n";
const MANAGED_PRESET_FILES = ["agent.cordis.yml", "preset.yml", DSMM_MANAGED_PRESET_MARKER] as const;

interface PresetFilesystem {
  lstatSync(path: string): PresetFileStatus;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string): string[];
  realpathSync(path: string): string;
  renameSync(from: string, to: string): void;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
  writeFileSync(path: string, data: string, encoding: "utf8"): void;
}

const DEFAULT_PRESET_FILESYSTEM: PresetFilesystem = {
  lstatSync(path) {
    return lstatSync(path);
  },
  mkdirSync(path, options) {
    mkdirSync(path, options);
  },
  readFileSync(path, encoding) {
    return readFileSync(path, encoding);
  },
  readdirSync(path) {
    return readdirSync(path);
  },
  realpathSync(path) {
    return realpathSync(path);
  },
  renameSync(from, to) {
    renameSync(from, to);
  },
  rmSync(path, options) {
    rmSync(path, options);
  },
  writeFileSync(path, data, encoding) {
    writeFileSync(path, data, encoding);
  }
};

export interface RolePresetMaterializerOptions {
  root: string;
  settings: DsmmSettings;
  /** Test-only narrow filesystem seam for fault and link judgement coverage. */
  filesystem?: Partial<PresetFilesystem>;
}

type PresetOwnership = "absent" | "current" | "legacy" | "foreign";

interface PresetFileStatus {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}

interface KnownRoleDirectory {
  role: (typeof DSMM_ROLES)[number];
  directory: string;
  ownership: PresetOwnership;
}

export function renderManagedPresetMarker(role: DsmmRoleId): string {
  return `dsmm-managed-preset/v${DSMM_MANAGED_PRESET_MARKER_VERSION}\nrole=${role}\n`;
}

export function resolveManagedPresetRoot(settings: DsmmSettings, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (settings.presets.root !== undefined) return settings.presets.root;
  const dshHome = env.DSH_HOME;
  return dshHome === undefined || dshHome.length === 0 ? undefined : join(dshHome, ".agent-presets");
}

export function materializeRolePresets(options: RolePresetMaterializerOptions): void {
  reconcileRolePresets({
    ...options,
    settings: {
      ...options.settings,
      presets: { ...options.settings.presets, materialize: true }
    }
  });
}

export function reconcileRolePresets({ root, settings, filesystem: filesystemOverride }: RolePresetMaterializerOptions): void {
  if (!settings.modules.deepwork.enabled) return;
  if (root.length === 0) {
    throw new Error("dsmm preset materialization root must not be empty");
  }

  const filesystem: PresetFilesystem = { ...DEFAULT_PRESET_FILESYSTEM, ...filesystemOverride };
  const canonicalRoot = prepareManagedRoot(root, settings.presets.materialize, filesystem);
  if (canonicalRoot === undefined) return;

  const knownDirectories = DSMM_ROLES.map((role) => {
    const directory = join(root, role.id);
    return {
      role,
      directory,
      ownership: inspectKnownRoleDirectory(canonicalRoot, directory, role.id, filesystem)
    };
  });

  for (const knownDirectory of knownDirectories) {
    if (settings.presets.materialize && isRootRoleEnabled(settings, knownDirectory.role.id) && knownDirectory.ownership === "foreign") {
      throw new Error(`dsmm preset directory is foreign and will not be claimed: ${knownDirectory.directory}`);
    }
  }

  for (const knownDirectory of knownDirectories) {
    if (settings.presets.materialize && isRootRoleEnabled(settings, knownDirectory.role.id)) {
      if (knownDirectory.ownership === "absent") {
        publishNewRoleDirectory(canonicalRoot, root, knownDirectory.role.id, settings, filesystem);
      } else {
        updateOwnedRoleDirectory(canonicalRoot, knownDirectory, settings, filesystem);
      }
      continue;
    }

    if (knownDirectory.ownership === "current" || knownDirectory.ownership === "legacy") {
      removeOwnedRoleDirectory(canonicalRoot, knownDirectory, filesystem);
    }
  }
}

function prepareManagedRoot(root: string, materialize: boolean, filesystem: PresetFilesystem): string | undefined {
  const rootStatus = lstatIfExists(root, filesystem);
  if (rootStatus === undefined) {
    if (!materialize) return undefined;
    filesystem.mkdirSync(root, { recursive: true });
  } else {
    assertDirectoryNotLinked(root, rootStatus, "preset root");
  }

  const verifiedRootStatus = lstatIfExists(root, filesystem);
  if (verifiedRootStatus === undefined) {
    throw new Error(`dsmm preset root disappeared after creation: ${root}`);
  }
  assertDirectoryNotLinked(root, verifiedRootStatus, "preset root");
  return filesystem.realpathSync(root);
}

function inspectKnownRoleDirectory(
  canonicalRoot: string,
  directory: string,
  role: DsmmRoleId,
  filesystem: PresetFilesystem
): PresetOwnership {
  const directoryStatus = lstatIfExists(directory, filesystem);
  if (directoryStatus === undefined) return "absent";

  assertDirectoryNotLinked(directory, directoryStatus, `preset directory for ${role}`);
  assertCanonicalChild(canonicalRoot, filesystem.realpathSync(directory), `preset directory for ${role}`);

  const entryNames = filesystem.readdirSync(directory).sort();
  if (!entryNames.includes(DSMM_MANAGED_PRESET_MARKER)) return "foreign";

  const markerPath = join(directory, DSMM_MANAGED_PRESET_MARKER);
  assertRegularUnlinkedFile(markerPath, `marker for ${role}`, filesystem);
  const marker = filesystem.readFileSync(markerPath, "utf8");
  const expectedMarker = renderManagedPresetMarker(role);

  if (marker === expectedMarker) {
    if (!hasExactManagedShape(entryNames)) {
      throw new Error(`dsmm current managed preset directory has unexpected entries and will not be claimed: ${directory}`);
    }
    assertManagedFilesAreRegular(directory, role, filesystem);
    return "current";
  }

  if (marker !== LEGACY_MANAGED_PRESET_MARKER) return "foreign";
  if (!hasExactManagedShape(entryNames)) return "foreign";
  assertManagedFilesAreRegular(directory, role, filesystem);
  return "legacy";
}

function hasExactManagedShape(entryNames: readonly string[]): boolean {
  return entryNames.length === MANAGED_PRESET_FILES.length
    && MANAGED_PRESET_FILES.every((name) => entryNames.includes(name));
}

function assertManagedFilesAreRegular(directory: string, role: DsmmRoleId, filesystem: PresetFilesystem): void {
  for (const fileName of MANAGED_PRESET_FILES) {
    assertRegularUnlinkedFile(join(directory, fileName), `${fileName} for ${role}`, filesystem);
  }
}

function updateOwnedRoleDirectory(
  canonicalRoot: string,
  knownDirectory: KnownRoleDirectory,
  settings: DsmmSettings,
  filesystem: PresetFilesystem
): void {
  if (knownDirectory.ownership !== "current" && knownDirectory.ownership !== "legacy") {
    throw new Error(`dsmm preset directory is not owned and cannot be updated: ${knownDirectory.directory}`);
  }

  const files = [
    ["agent.cordis.yml", renderAgentCordis(knownDirectory.role, enabledSkillNames(settings), enabledRoles(settings), settings.roleRouting)],
    ["preset.yml", renderPresetMetadata(knownDirectory.role)],
    [DSMM_MANAGED_PRESET_MARKER, renderManagedPresetMarker(knownDirectory.role.id)]
  ] as const;

  for (const [fileName, content] of files) {
    assertOwnershipUnchanged(canonicalRoot, knownDirectory, filesystem);
    filesystem.writeFileSync(join(knownDirectory.directory, fileName), content, "utf8");
  }
}

function removeOwnedRoleDirectory(canonicalRoot: string, knownDirectory: KnownRoleDirectory, filesystem: PresetFilesystem): void {
  if (knownDirectory.ownership !== "current" && knownDirectory.ownership !== "legacy") return;
  assertOwnershipUnchanged(canonicalRoot, knownDirectory, filesystem);
  filesystem.rmSync(knownDirectory.directory, { recursive: true, force: false });
}

function assertOwnershipUnchanged(canonicalRoot: string, knownDirectory: KnownRoleDirectory, filesystem: PresetFilesystem): void {
  const ownership = inspectKnownRoleDirectory(canonicalRoot, knownDirectory.directory, knownDirectory.role.id, filesystem);
  if (ownership !== knownDirectory.ownership) {
    throw new Error(`dsmm preset ownership changed before mutation: ${knownDirectory.directory}`);
  }
}

function publishNewRoleDirectory(
  canonicalRoot: string,
  root: string,
  role: DsmmRoleId,
  settings: DsmmSettings,
  filesystem: PresetFilesystem
): void {
  const finalDirectory = join(root, role);
  const temporaryDirectory = join(root, `.${role}.dsmm-${randomUUID()}`);
  let temporaryDirectoryCreated = false;

  try {
    if (lstatIfExists(finalDirectory, filesystem) !== undefined) {
      throw new Error(`dsmm preset directory appeared before publication and will not be replaced: ${finalDirectory}`);
    }

    filesystem.mkdirSync(temporaryDirectory);
    temporaryDirectoryCreated = true;
    const temporaryStatus = lstatIfExists(temporaryDirectory, filesystem);
    if (temporaryStatus === undefined) {
      throw new Error(`dsmm temporary preset directory disappeared after creation: ${temporaryDirectory}`);
    }
    assertDirectoryNotLinked(temporaryDirectory, temporaryStatus, `temporary preset directory for ${role}`);
    assertCanonicalChild(canonicalRoot, filesystem.realpathSync(temporaryDirectory), `temporary preset directory for ${role}`);

    filesystem.writeFileSync(join(temporaryDirectory, "agent.cordis.yml"), renderAgentCordis(findRole(role), enabledSkillNames(settings), enabledRoles(settings), settings.roleRouting), "utf8");
    filesystem.writeFileSync(join(temporaryDirectory, "preset.yml"), renderPresetMetadata(findRole(role)), "utf8");
    filesystem.writeFileSync(join(temporaryDirectory, DSMM_MANAGED_PRESET_MARKER), renderManagedPresetMarker(role), "utf8");

    if (lstatIfExists(finalDirectory, filesystem) !== undefined) {
      throw new Error(`dsmm preset directory appeared before publication and will not be replaced: ${finalDirectory}`);
    }
    filesystem.renameSync(temporaryDirectory, finalDirectory);
    temporaryDirectoryCreated = false;
  } finally {
    if (temporaryDirectoryCreated) {
      removePrivateTemporaryDirectory(canonicalRoot, temporaryDirectory, role, filesystem);
    }
  }
}

function removePrivateTemporaryDirectory(canonicalRoot: string, temporaryDirectory: string, role: DsmmRoleId, filesystem: PresetFilesystem): void {
  const temporaryStatus = lstatIfExists(temporaryDirectory, filesystem);
  if (temporaryStatus === undefined) return;
  assertDirectoryNotLinked(temporaryDirectory, temporaryStatus, `temporary preset directory for ${role}`);
  assertCanonicalChild(canonicalRoot, filesystem.realpathSync(temporaryDirectory), `temporary preset directory for ${role}`);
  filesystem.rmSync(temporaryDirectory, { recursive: true, force: false });
}

function findRole(roleId: DsmmRoleId): (typeof DSMM_ROLES)[number] {
  const role = DSMM_ROLES.find((candidate) => candidate.id === roleId);
  if (role === undefined) throw new Error(`unknown dsmm role: ${roleId}`);
  return role;
}

function enabledRoles(settings: DsmmSettings): DsmmRoleId[] {
  return DSMM_ROLE_IDS.filter((id) => isRoleEnabled(settings, id));
}

function assertDirectoryNotLinked(path: string, status: PresetFileStatus, label: string): void {
  if (status.isSymbolicLink()) {
    throw new Error(`dsmm ${label} must not be a symbolic link or junction: ${path}`);
  }
  if (!status.isDirectory()) {
    throw new Error(`dsmm ${label} must be a directory: ${path}`);
  }
}

function assertRegularUnlinkedFile(path: string, label: string, filesystem: PresetFilesystem): void {
  const status = filesystem.lstatSync(path);
  if (status.isSymbolicLink()) {
    throw new Error(`dsmm ${label} must not be a symbolic link: ${path}`);
  }
  if (!status.isFile()) {
    throw new Error(`dsmm ${label} must be a regular file: ${path}`);
  }
}

function assertCanonicalChild(canonicalRoot: string, canonicalChild: string, label: string): void {
  const childPath = relative(canonicalRoot, canonicalChild);
  if (childPath.length === 0 || childPath === ".." || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) {
    throw new Error(`dsmm ${label} escapes the canonical preset root: ${canonicalChild}`);
  }
}

function lstatIfExists(path: string, filesystem: PresetFilesystem): PresetFileStatus | undefined {
  try {
    const status = filesystem.lstatSync(path);
    return status === undefined ? undefined : status;
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
