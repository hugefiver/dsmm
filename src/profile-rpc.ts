import { symbols } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type { HostConnectionHandle } from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-typert-registry";
import { parseProfileErrorInfo, TYPERT_HOST } from "./profile-remote.js";
import type { ProfileReadResult, ProfileSaveRequest, ProfileSelectRequest, ProfileSnapshot, SessionModeSelectRequest, SessionProfileSelectRequest, SessionProfileSnapshot } from "./profile-types.js";
import { DsmmProfileError, profileErrorInfo } from "./profiles.js";
import type { DshAgent, DshAgentsRegistry } from "./dsh-types.js";
import type { DsmmDeploymentConfig, GlobalConfigSaveRequest, GlobalConfigSnapshot } from "./deployment-config.js";
import { projectDsmmModules } from "./modules.js";
import type { DsmmModuleState, DsmmMountedPermissionGetter } from "./modules.js";
import type { DsmmSettings } from "./settings.js";
import { DEFAULT_DSMM_SETTINGS, deploymentEditorSchema } from "./settings.js";
import type { DeploymentEditorSnapshot } from "./profile-types.js";
import { runtimeAdmissionView } from "./runtime-integration.js";
import type { DsmmProfileRuntime } from "./profile-runtime.js";
import { readOnlySettings, readOnlySettingSources } from "./status.js";

export interface ProfilesBackend {
  describe(): Promise<ProfileSnapshot>;
  read(id: string): Promise<ProfileReadResult>;
  save(request: ProfileSaveRequest, assertAuthority?: () => void): Promise<ProfileReadResult>;
  select(request: ProfileSelectRequest, assertAuthority?: () => void): Promise<ProfileSnapshot>;
  getSession(agent: DshAgent): Promise<SessionProfileSnapshot>;
  selectSession(request: SessionProfileSelectRequest, capturedAgent: DshAgent, signal?: AbortSignal, assertAuthority?: () => void): Promise<SessionProfileSnapshot>;
  selectMode?(request: SessionModeSelectRequest, capturedAgent: DshAgent, signal?: AbortSignal, assertAuthority?: () => void): Promise<SessionProfileSnapshot>;
}

/** Business service addressed only by native Typert Gateway invocations. */
export class DsmmProfilesHost extends TypertRemoteService {
  private readonly lifetime = new AbortController();

  constructor(ctx: Context, readonly backend: ProfilesBackend) {
    super(ctx, "dsmmProfiles");
    ctx.effect(() => () => this.lifetime.abort(), "dsmmProfiles: cancel scoped operations");
  }

  private async invoke<T>(operation: () => Promise<T>): Promise<T> {
    const invocation = this.ctx.invocation;
    if (invocation === undefined || invocation.peer === undefined) {
      throw new RemoteError("dsmm-profiles/peer-required", "Use Deepwork Profiles through the native Host connection.", {});
    }
    invocation.signal.throwIfAborted();
    invocation.peer.signal.throwIfAborted();
    try { return await operation(); }
    catch (error) { throw new RemoteError("dsmm-profiles/refused", "The Host refused the profile operation.", parseProfileErrorInfo(profileErrorInfo(error))); }
  }

  private captureAuthority(): () => void {
    assertLocalSettingsOperator(this.ctx);
    const invocation = this.ctx.invocation!;
    const connection = this.ctx.get("connection") as HostConnectionHandle;
    const owner: unknown = Reflect.get(connection, symbols.original) ?? connection;
    const signal = AbortSignal.any([invocation.signal, invocation.peer.signal, this.lifetime.signal]);
    const assertAuthority = (): void => {
      if (signal.aborted) throw new DsmmProfileError("cancelled", "The profile operation was cancelled before commit.");
      assertLocalSettingsOperator(this.ctx);
      const current = this.ctx.get("connection") as HostConnectionHandle;
      if ((Reflect.get(current, symbols.original) ?? current) !== owner || current.browserPeer !== invocation.peer) {
        throw new DsmmProfileError("not-owned", "The operator connection changed before committing the profile operation.");
      }
    };
    assertAuthority();
    return assertAuthority;
  }
  @Remote
  describe(): Promise<ProfileSnapshot> { return this.invoke(() => this.backend.describe()); }
  @Remote
  read(id: string): Promise<ProfileReadResult> { return this.invoke(() => this.backend.read(id)); }
  @Remote
  save(request: ProfileSaveRequest): Promise<ProfileReadResult> {
    return this.invoke(() => this.backend.save(request, this.captureAuthority()));
  }
  @Remote
  select(request: ProfileSelectRequest): Promise<ProfileSnapshot> {
    return this.invoke(() => this.backend.select(request, this.captureAuthority()));
  }

  /** Native Connection's exact browser Peer is authority, not a claimed Peer ID. */
  private async invokeSession<T>(sessionId: string, operation: (agent: DshAgent, signal: AbortSignal, assertAuthority: () => void) => Promise<T>, readOnly = false): Promise<T> {
    return this.invoke(async () => {
      const invocation = this.ctx.invocation!;
      const connection = this.ctx.get("connection") as HostConnectionHandle | undefined;
      if (connection === undefined || connection.browserPeer !== invocation.peer) {
        throw new DsmmProfileError("not-owned", "The native Host operator must own this session profile operation.");
      }
      // Cordis rebinds Service projections for each accessing Context. Its
      // public original symbol identifies the exact native authority owner.
      const connectionOwner: unknown = Reflect.get(connection, symbols.original) ?? connection;
      const signal = AbortSignal.any([invocation.signal, connection.browserPeer.signal, this.lifetime.signal]);
      const checkAuthority = (): DshAgentsRegistry => {
        if (signal.aborted) throw new DsmmProfileError("cancelled", "The session profile operation was cancelled; no late selection is allowed.");
        if (!readOnly) assertLocalSettingsOperator(this.ctx);
        const currentConnection = this.ctx.get("connection") as HostConnectionHandle | undefined;
        const currentOwner: unknown = currentConnection === undefined ? undefined : Reflect.get(currentConnection, symbols.original) ?? currentConnection;
        if (currentOwner !== connectionOwner || currentConnection?.browserPeer !== invocation.peer) {
          throw new DsmmProfileError("not-owned", "The native Host operator connection is no longer active.");
        }
        const agents = this.ctx.get("agents") as DshAgentsRegistry | undefined;
        if (agents === undefined || typeof agents.get !== "function" || typeof agents.roots !== "function" || typeof agents.list !== "function" || typeof agents.isOwnedBy !== "function") {
          throw new DsmmProfileError("unavailable", "Native session authority is unavailable.");
        }
        return agents;
      };
      let agents = checkAuthority();
      const captured = agents.get(sessionId);
      if (captured === undefined) throw new DsmmProfileError("unavailable", "Session admission is unknown; read-only configuration queries never resume history.", "sessionId");
      const agent = captured;
      const checkCaptured = (): void => {
        const current = checkAuthority();
        if (agent.id !== sessionId || agent.session.id !== sessionId || current.get(sessionId) !== agent
          || agent.session.header?.origin === "subagent" || !current.roots().includes(agent)
          || current.list().some((owner) => owner !== agent && current.isOwnedBy(sessionId, owner))) {
          throw new DsmmProfileError("not-owned", "Only an exact live ordinary root session can select a profile.", "sessionId");
        }
      };
      checkCaptured();
      const result = await operation(agent, signal, checkCaptured);
      // Mutation owns its final pre-commit fence in native maintenance. A
      // successful durable commit must not be relabeled as a failed write if
      // a queued wake/disposal wins immediately after maintenance releases.
      if (readOnly) checkCaptured();
      return result;
    });
  }

  @Remote
  describeSession(sessionId: string): Promise<SessionProfileSnapshot> {
    return this.invokeSession(sessionId, (agent) => this.backend.getSession(agent), true);
  }

  @Remote
  selectSession(sessionId: string, request: SessionProfileSelectRequest): Promise<SessionProfileSnapshot> {
    // The redundant stable identity is a fence, never an authority assertion.
    // Check it before any native resume or profile-store operation.
    if (request.sessionId !== sessionId) {
      return this.invoke(async () => { throw new DsmmProfileError("validation", "The requested session identities must match.", "sessionId"); });
    }
    return this.invokeSession(sessionId, (agent, signal, assertAuthority) => this.backend.selectSession(request, agent, signal, assertAuthority));
  }

  @Remote
  selectMode(sessionId: string, request: SessionModeSelectRequest): Promise<SessionProfileSnapshot> {
    if (request.sessionId !== sessionId) {
      return this.invoke(async () => { throw new DsmmProfileError("validation", "The requested session identities must match.", "sessionId"); });
    }
    return this.invokeSession(sessionId, (agent, signal, assertAuthority) => {
      if (this.backend.selectMode === undefined) throw new DsmmProfileError("unavailable", "Session mode selection is unavailable.");
      return this.backend.selectMode(request, agent, signal, assertAuthority);
    });
  }
}

/** A peer is not write authority. Require the public local, writable Host carrier. */
export function assertLocalSettingsOperator(ctx: Context): void {
  const invocation = ctx.invocation;
  const connection = ctx.get("connection") as HostConnectionHandle | undefined;
  const webServer = ctx.get("webServer") as { host?: string } | undefined;
  const settings = ctx.get("settings") as { writable?: boolean } | undefined;
  if (invocation?.peer === undefined || connection?.browserPeer !== invocation.peer
    || webServer?.host !== "127.0.0.1" || settings?.writable !== true) {
    throw new DsmmProfileError("not-owned", "Global deployment edits require the authenticated operator of a local writable native Host.");
  }
  invocation.signal.throwIfAborted();
  invocation.peer.signal.throwIfAborted();
}

export class DsmmConfigHost extends TypertRemoteService {
  private readonly lifetime = new AbortController();
  constructor(ctx: Context, private readonly backend: DsmmDeploymentConfig, private readonly startup?: DsmmSettings,
    private readonly runtime?: () => DsmmProfileRuntime | undefined, private readonly startupSources?: Record<string, string>,
    private readonly getMountedPermission?: DsmmMountedPermissionGetter) {
    super(ctx, "dsmmConfig");
    ctx.effect(() => () => this.lifetime.abort());
  }
  private captureReadAuthority(): () => void {
    assertLocalSettingsOperator(this.ctx);
    const connection = this.ctx.get("connection")!;
    const owner: unknown = Reflect.get(connection, symbols.original) ?? connection;
    const lifetime = this.lifetime.signal;
    return () => {
      if (lifetime.aborted) throw new DsmmProfileError("disposed", "The deployment editor was disposed; no late read is allowed.");
      assertLocalSettingsOperator(this.ctx);
      const current = this.ctx.get("connection")!;
      if ((Reflect.get(current, symbols.original) ?? current) !== owner) throw new DsmmProfileError("not-owned", "The operator connection changed; refresh before reading.");
    };
  }
  @Remote
  async describeSettings(): Promise<DeploymentEditorSnapshot> {
    try {
      const assertAuthority = this.captureReadAuthority();
      if (this.startup === undefined) throw new DsmmProfileError("unavailable", "The startup capture is unavailable.");
      const desired = await this.backend.readDesired();
      assertAuthority();
      const runtime = this.runtime?.() ?? this.ctx.get("dsmmProfileRuntime") as DsmmProfileRuntime | undefined;
      return { entryId: desired.entryId, namespace: desired.nativeNamespace ?? null, hostProfileKey: desired.hostProfileKey,
        global: desired.global as Record<string, unknown>, globalRevision: desired.globalRevision,
        profile: { ...desired.profile }, nativeRevision: desired.nativeRevision,
        nativeFormRevision: desired.nativeFormRevision ?? null, nativeForm: desired.nativeForm === undefined ? null : { base: desired.nativeForm.base ?? null, user: desired.nativeForm.user ?? null },
        desired: { ...readOnlySettings(desired.settings) }, sources: readOnlySettingSources(desired.sources),
        startup: { ...readOnlySettings(this.startup) }, defaults: DEFAULT_DSMM_SETTINGS as unknown as Record<string, unknown>,
        ...(this.startupSources === undefined ? {} : { startupSources: readOnlySettingSources(this.startupSources) }),
        schema: deploymentEditorSchema(), nativeSchema: deploymentEditorSchema(true),
        subagentRuntime: runtimeAdmissionView(this.ctx), nextRoot: runtime?.previewDeployment(desired) ?? null,
        modules: projectDsmmModules(this.startup, desired, undefined, true, this.getMountedPermission) };
    } catch (error) { throw new RemoteError("dsmm-profiles/refused", "The Host refused the deployment operation.", parseProfileErrorInfo(profileErrorInfo(error))); }
  }
  @Remote
  async describe(): Promise<GlobalConfigSnapshot> {
    try {
      const assertAuthority = this.captureReadAuthority();
      const snapshot = await this.backend.readGlobal();
      assertAuthority();
      return snapshot;
    }
    catch (error) { throw new RemoteError("dsmm-profiles/refused", "The Host refused the deployment operation.", parseProfileErrorInfo(profileErrorInfo(error))); }
  }
  @Remote
  async describeModules(): Promise<DsmmModuleState[]> {
    try {
      const assertAuthority = this.captureReadAuthority();
      if (this.startup === undefined) throw new DsmmProfileError("unavailable", "The startup module capture is unavailable.");
      const desired = await this.backend.readDesired();
      assertAuthority();
      return projectDsmmModules(this.startup, desired, undefined, true, this.getMountedPermission);
    } catch (error) { throw new RemoteError("dsmm-profiles/refused", "The Host refused the deployment operation.", parseProfileErrorInfo(profileErrorInfo(error))); }
  }
  @Remote
  async save(request: GlobalConfigSaveRequest): Promise<GlobalConfigSnapshot> {
    try {
      assertLocalSettingsOperator(this.ctx);
      const connection = this.ctx.get("connection")!;
      const owner: unknown = Reflect.get(connection, symbols.original) ?? connection;
      const assertAuthority = (): void => {
        if (this.lifetime.signal.aborted) throw new DsmmProfileError("disposed", "The deployment editor was disposed; no late write is allowed.");
        assertLocalSettingsOperator(this.ctx);
        const current = this.ctx.get("connection")!;
        if ((Reflect.get(current, symbols.original) ?? current) !== owner) throw new DsmmProfileError("not-owned", "The operator connection changed; refresh before saving.");
      };
      return await this.backend.saveGlobal(request, assertAuthority);
    } catch (error) { throw new RemoteError("dsmm-profiles/refused", "The Host refused the deployment operation.", parseProfileErrorInfo(profileErrorInfo(error))); }
  }
}

declare module "@deepseek-ai/cordis" { interface Context { dsmmProfiles: DsmmProfilesHost; dsmmConfig: DsmmConfigHost } }

/** The caller supplies the owned injection fiber; withdrawal stays native. */
export function registerProfilesRpc(ctx: Context, backend: ProfilesBackend, deployment?: DsmmDeploymentConfig): DsmmProfilesHost {
  const service = new DsmmProfilesHost(ctx, backend);
  ctx.typert.register(TYPERT_HOST);
  if (deployment !== undefined) new DsmmConfigHost(ctx, deployment);
  return service;
}

/** Core-owned injection; works without any DW or profile business service. */
export function registerConfigRpc(ctx: Context, deployment: DsmmDeploymentConfig, startup: DsmmSettings, runtime?: () => DsmmProfileRuntime | undefined, startupSources?: Record<string, string>, getMountedPermission?: DsmmMountedPermissionGetter): DsmmConfigHost {
  const service = new DsmmConfigHost(ctx, deployment, startup, runtime, startupSources, getMountedPermission);
  ctx.typert.register(TYPERT_HOST);
  return service;
}
