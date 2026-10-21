import { createHash } from "node:crypto";
import { Context, symbols } from "@deepseek-ai/cordis";
import { isDeepStrictEqual } from "node:util";
import type { DshContext } from "./dsh-types.js";
import { resolveDshHome } from "./dsh-home.js";
import { FixedConfigFileStore } from "./config-file-store.js";
import { copyJson, freezeSettings, resolveDeployment, validateDeploymentPath, validateSparseConfig, validateNativeConfig } from "./settings.js";
import type { DsmmDeploymentSnapshot, DsmmPluginConfig, DsmmNativeConfig } from "./settings.js";
import { DsmmProfileError } from "./profiles.js";
import { resolve } from "node:path";
import { diagnosticSourcePath, DsmmConfigValidationError, fieldLocation, inspectJsonDocument } from "./profile-diagnostics.js";
import { parseHostNativeCommands } from "./permission-native-command.js";

export type DeploymentPathEdit = { op: "set"; path: string[]; value: unknown } | { op: "unset"; path: string[] };
export interface GlobalConfigSaveRequest { expectedRevision: string; edits: DeploymentPathEdit[] }
export interface GlobalConfigSnapshot { config: DsmmPluginConfig; revision: string; refreshRequired?: true }
declare module "@deepseek-ai/cordis" { interface Context { dsmmDeploymentConfig: DsmmDeploymentConfig } }
export interface DeploymentWriteCoordinator {
  global(request: GlobalConfigSaveRequest, config: DsmmPluginConfig, assertAuthority: () => void,
    write: (config: DsmmPluginConfig) => Promise<GlobalConfigSnapshot>): Promise<GlobalConfigSnapshot>;
}

function configurationError(): never { throw new DsmmProfileError("validation", "Deepwork deployment configuration is invalid; restore valid plain JSON before saving or admitting a new session."); }

export function parseGlobalConfig(content: string | null): DsmmPluginConfig {
  if (content === null) return {};
  const inspected = inspectJsonDocument(content, false);
  const issue = inspected.diagnostics[0];
  if (issue !== undefined) throw new DsmmProfileError("validation", `${issue.field}: ${issue.reason}`, issue.field, issue.code, issue.location);
  if (inspected.tree?.type !== "object") configurationError();
  try {
    const config = validateSparseConfig(JSON.parse(content), true);
    if (config.permissionControl?.nativeCommands !== undefined) parseHostNativeCommands(config.permissionControl.nativeCommands);
    return config;
  } catch (error) {
    if (error instanceof DsmmConfigValidationError) throw new DsmmProfileError("validation", error.message, error.diagnostic.field, error.diagnostic.code, fieldLocation(content, inspected.tree, error.diagnostic.field, diagnosticSourcePath(error)));
    return configurationError();
  }
}

/** Only schema fields, never filesystem paths or array indexes. Full candidate is revalidated. */
export function editGlobalConfig(config: DsmmPluginConfig, edits: DeploymentPathEdit[]): DsmmPluginConfig {
  let result = copyJson(config) as Record<string, unknown>;
  if (!Array.isArray(edits) || edits.length > 128) configurationError();
  for (const input of edits) {
    const edit = copyJson(input);
    if (edit === null || typeof edit !== "object" || !["set", "unset"].includes(edit.op)
      || Object.keys(edit).some((key) => !["op", "path", ...edit.op === "set" ? ["value"] : []].includes(key))
      || edit.op === "set" && !Object.hasOwn(edit, "value")
      || !Array.isArray(edit.path) || edit.path.length === 0 || edit.path.length > 8
      || edit.path.some((key) => typeof key !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]*$/u.test(key) || ["constructor", "prototype", "__proto__"].includes(key))) configurationError();
    validateDeploymentPath(edit.path);
    let node = result;
    for (const key of edit.path.slice(0, -1)) {
      const child = node[key];
      if (child !== undefined && (child === null || typeof child !== "object" || Array.isArray(child))) configurationError();
      node = (node[key] ??= {}) as Record<string, unknown>;
    }
    const key = edit.path.at(-1)!;
    if (edit.op === "set") node[key] = copyJson(edit.value);
    else Reflect.deleteProperty(node, key);
    result = validateSparseConfig(result, true) as Record<string, unknown>;
  }
  const configResult = result as DsmmPluginConfig;
  if (configResult.permissionControl?.nativeCommands !== undefined) parseHostNativeCommands(configResult.permissionControl.nativeCommands);
  return configResult;
}

function hash(input: unknown): string { return createHash("sha256").update(JSON.stringify(input)).digest("hex"); }
function presentValue(parsed: unknown, raw: unknown): unknown {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    if (parsed === null || typeof parsed !== "object") configurationError();
    return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, presentValue(Reflect.get(parsed, key), value)]));
  }
  return copyJson(parsed);
}
function sources(global: DsmmPluginConfig, profile: DsmmPluginConfig, settings: unknown): DsmmDeploymentSnapshot["sources"] {
  const result: DsmmDeploymentSnapshot["sources"] = {};
  const walk = (value: unknown, path: string[], lower: unknown, upper: unknown): void => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) walk(child, [...path, key], lower !== null && typeof lower === "object" ? Reflect.get(lower, key) : undefined, upper !== null && typeof upper === "object" ? Reflect.get(upper, key) : undefined);
    } else result[path.join(".")] = upper !== undefined ? "profile" : lower !== undefined ? "global" : "defaults";
  };
  walk(settings, [], global, profile);
  if (global.workflow?.policy === undefined && profile.workflow?.policy === undefined) {
    const legacyControls = (config: DsmmPluginConfig): boolean => ["strictGates", "reviewCap", "finalReviewPolicy"].some((key) => config.workflow !== undefined && Object.hasOwn(config.workflow, key));
    if (legacyControls(profile)) result["workflow.policy"] = "profile";
    else if (legacyControls(global)) result["workflow.policy"] = "global";
  }
  return result;
}

/** One native entry's desired reader and one fixed global base; no scheduler or mirror. */
export class DsmmDeploymentConfig {
  private writeCoordinator?: DeploymentWriteCoordinator;
  private permissionObservation?: {
    scope: readonly unknown[]; globalRevision: string; nativeRevision: string; revision: string;
    config: DsmmPluginConfig;
  };
  readonly home: string;
  readonly store: FixedConfigFileStore;
  readonly entryId: string;
  readonly hostProfileKey: string;
  get nativeEntry(): Context["fiber"]["entry"] | undefined { return Context.is(this.ctx) ? this.ctx.fiber.entry : undefined; }
  coordinateWrites(coordinator: DeploymentWriteCoordinator): () => void {
    if (this.writeCoordinator !== undefined) throw new DsmmProfileError("conflict", "Deployment writes already have an owner.");
    this.writeCoordinator = coordinator;
    return () => { if (this.writeCoordinator === coordinator) this.writeCoordinator = undefined; };
  }
  /** Synchronous source identity for permission dispatch fences; no form revision or process identity. */
  permissionSource() {
    const profile = this.profile(), file = this.store.read(), global = parseGlobalConfig(file.content);
    if (profile.revision === "unavailable") throw new DsmmProfileError("unavailable", "Native settings version is unavailable; permission authority requires a current Host descriptor.");
    const settings = resolveDeployment(global, profile.config);
    const original = (value: object | undefined): unknown => value === undefined ? undefined : Reflect.get(value, symbols.original) ?? value;
    const profileContext = this.ctx.get?.<{ home?: string; dir?: string }>("profileContext");
    const scope = [original(this.ctx.get?.("settings")), original(profileContext), profileContext?.home, profileContext?.dir,
      this.nativeEntry, this.nativeEntry?.fiber?.ctx];
    const previous = this.permissionObservation;
    if (previous !== undefined && scope.some((owner, index) => owner !== previous.scope[index])) {
      throw new DsmmProfileError("unavailable", "Permission source authority changed; the previous deployment owner cannot adopt it.");
    }
    const unchangedPolicy = previous !== undefined && previous.globalRevision === file.revision && isDeepStrictEqual(previous.config, profile.config);
    const revision = unchangedPolicy && previous.nativeRevision === profile.revision ? previous.revision
      : `deployment-v1:${this.hostProfileKey}:${file.revision}:${profile.revision}`;
    this.permissionObservation = { scope, globalRevision: file.revision, nativeRevision: profile.revision, revision,
      config: profile.config };
    return freezeSettings({ revision,
      globalRevision: file.revision, nativeRevision: profile.revision, global, profile: profile.config,
      policy: { ...settings.permissionControl, nativeCommands: parseHostNativeCommands(settings.permissionControl.nativeCommands) } });
  }
  constructor(private readonly ctx: DshContext, private readonly config: DsmmNativeConfig) {
    const profile = ctx.get?.<{ home?: string; dir?: string }>("profileContext");
    this.home = resolveDshHome(profile?.home);
    this.store = new FixedConfigFileStore(this.home);
    const entry = Context.is(ctx) ? ctx.fiber.entry : undefined;
    this.entryId = entry?.id ?? "trusted-direct";
    const identity = profile?.dir === undefined ? "trusted-direct" : resolve(profile.dir);
    this.hostProfileKey = hash([process.platform === "win32" ? identity.toLowerCase() : identity, this.entryId]);
  }

  private profile(): { config: DsmmPluginConfig; revision: string } {
    const entry = Context.is(this.ctx) ? this.ctx.fiber.entry : undefined;
    const raw: unknown = entry === undefined ? Object.fromEntries(Object.entries(this.config).flatMap(([key, parsed]) => {
      const value = parsed !== null && typeof parsed === "object" && "get" in parsed && typeof parsed.get === "function" ? parsed.get() : parsed;
      return value === undefined ? [] : [[key, value]];
    })) : entry.options.config ?? {};
    try {
      const presence = validateNativeConfig(raw);
      const snapshot: Record<string, unknown> = {};
      for (const key of Object.keys(presence)) {
        const parsed = Reflect.get(this.config, key) as unknown;
        const value = parsed !== null && typeof parsed === "object" && "get" in parsed && typeof parsed.get === "function" ? parsed.get() : parsed;
        snapshot[key] = presentValue(value, Reflect.get(presence, key));
      }
      const config = validateNativeConfig(snapshot);
      if (config.permissionControl?.nativeCommands !== undefined) parseHostNativeCommands(config.permissionControl.nativeCommands);
      const descriptor = entry === undefined ? undefined : this.ctx.get?.<{ describe(options?: { redactSecrets: boolean }): Array<{ ns: string; revision: number }> }>("settings")?.describe({ redactSecrets: true }).find(row => row.ns === entry.options.id);
      return { config, revision: descriptor === undefined ? "unavailable" : `native-v1-${descriptor.revision}` };
    } catch (error) { if (error instanceof DsmmConfigValidationError) throw error; return configurationError(); }
  }

  async readGlobal(): Promise<GlobalConfigSnapshot> {
    const file = await this.store.read();
    return { config: parseGlobalConfig(file.content), revision: file.revision };
  }
  async readDesired(): Promise<DsmmDeploymentSnapshot> {
    const profile = this.profile();
    const global = await this.readGlobal();
    let settings;
    try { settings = resolveDeployment(global.config, profile.config); } catch (error) { if (error instanceof DsmmConfigValidationError) throw error; return configurationError(); }
    const entry = Context.is(this.ctx) ? this.ctx.fiber.entry : undefined;
    const descriptor = entry === undefined ? undefined : this.ctx.get?.<{ describe(options?: { redactSecrets: boolean }): Array<{ ns: string; revision: number; base?: unknown; user?: unknown }> }>("settings")?.describe({ redactSecrets: true }).find((row) => row.ns === entry.options.id);
    if (this.profile().revision !== profile.revision || this.store.read().revision !== global.revision) throw new DsmmProfileError("conflict", "Deployment sources changed while projecting native state; refresh before retrying.");
    return freezeSettings({ settings, global: global.config, profile: profile.config, globalRevision: global.revision, nativeRevision: profile.revision,
      entryId: this.entryId, hostProfileKey: this.hostProfileKey, ...(entry === undefined ? {} : { nativeNamespace: entry.options.id }),
      ...(descriptor === undefined ? {} : { nativeFormRevision: descriptor.revision, nativeForm: {
        ...(descriptor.base === undefined ? {} : { base: descriptor.base }), ...(descriptor.user === undefined ? {} : { user: descriptor.user })
      } }), sources: sources(global.config, profile.config, settings) });
  }
  async saveGlobal(request: GlobalConfigSaveRequest, assertAuthority: () => void): Promise<GlobalConfigSnapshot> {
    assertAuthority();
    const current = await this.readGlobal();
    if (current.revision !== request.expectedRevision) throw new DsmmProfileError("conflict", "The global base changed; refresh before saving.");
    const config = editGlobalConfig(current.config, request.edits);
    try { resolveDeployment(config, this.profile().config); } catch (error) { if (error instanceof DsmmConfigValidationError) throw error; configurationError(); }
    let committed: GlobalConfigSnapshot | undefined;
    const write = async (candidate: DsmmPluginConfig): Promise<GlobalConfigSnapshot> => {
      const validated = validateSparseConfig(candidate, true);
      resolveDeployment(validated, this.profile().config);
      assertAuthority();
      const saved = await this.store.save(`${JSON.stringify(validated, null, 2)}\n`, request.expectedRevision, assertAuthority);
      committed = { config: validated, revision: saved.revision, ...(saved.refreshRequired ? { refreshRequired: true } : {}) };
      return committed;
    };
    try { return await (this.writeCoordinator === undefined ? write(config) : this.writeCoordinator.global(request, config, assertAuthority, write)); }
    catch (error) {
      if (committed !== undefined) return { ...committed, refreshRequired: true };
      throw error;
    }
  }
}
