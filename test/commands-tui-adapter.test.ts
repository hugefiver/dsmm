import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import type { DshAgent, DshCommandInvocation, DshCommandsRegistry, DshContext } from "../lib/dsh-types.js";
import { DEFAULT_DSMM_SETTINGS } from "../lib/settings.js";
import type { DsmmProfileAdmission, DsmmSettingsGetter } from "../lib/settings.js";
import { DeepworkModeController } from "../lib/state.js";
import { createDsmmTuiSettingsSection, registerDsmmTuiAdapter } from "../lib/tui-adapter.js";
import type { DsmmTuiClock } from "../lib/tui-adapter.js";
import { DSMM_TUI_CONTRIBUTIONS } from "../lib/tui-actions.js";
import { DsmmProfileRuntime } from "../lib/profile-runtime.js";
import { ProfileStore } from "../lib/profile-store.js";
import { resolveConfig } from "../lib/settings.js";
import type { DsmmDeploymentConfig, GlobalConfigSaveRequest, GlobalConfigSnapshot } from "../lib/deployment-config.js";
import type { DsmmCommandDefinition } from "../lib/commands.js";
import { handleDsmmStatusCommand } from "../lib/commands.js";

class FakeCommands implements DshCommandsRegistry {
  readonly definitions = new Map<string, DsmmCommandDefinition>();
  register(definition: DsmmCommandDefinition): () => void {
    if (this.definitions.has(definition.name)) throw new Error(`duplicate ${definition.name}`);
    this.definitions.set(definition.name, definition);
    return () => { if (this.definitions.get(definition.name) === definition) this.definitions.delete(definition.name); };
  }
}

class FakeHost {
  readonly generationId: string;
  readonly definitions = new Map<string, DsmmCommandDefinition>();
  readonly grantListeners = new Set<() => void>();
  allowed = true;
  admitted = true;
  readonly grants = {
    allows: (_ctx: DshContext, permission: string, scope: string) => {
      assert.equal(permission, "commands.invoke");
      assert.equal(scope, "com.hugefiver.dsmm.manage");
      return this.allowed;
    },
    onChange: (_ctx: DshContext, listener: () => void) => {
      this.grantListeners.add(listener);
      return () => { this.grantListeners.delete(listener); };
    }
  };
  constructor(generationId: string) { this.generationId = generationId; }
  registerCommand(_ctx: DshContext, contributionId: string, definition: DsmmCommandDefinition): () => void {
    if (!this.admitted) throw Object.assign(new Error("component is not admitted yet"), { code: "COMPONENT_NOT_ADMITTED" });
    if (this.definitions.has(contributionId)) throw new Error(`duplicate ${contributionId}`);
    this.definitions.set(contributionId, definition);
    return () => { if (this.definitions.get(contributionId) === definition) this.definitions.delete(contributionId); };
  }
}

class ManualClock implements DsmmTuiClock {
  private readonly tasks = new Set<() => void>();
  setTimeout(callback: () => void, _delayMs: number): unknown { this.tasks.add(callback); return callback; }
  clearTimeout(handle: unknown): void { this.tasks.delete(handle as () => void); }
  runNext(): void {
    const task = this.tasks.values().next().value as (() => void) | undefined;
    assert.notEqual(task, undefined);
    this.tasks.delete(task!);
    task!();
  }
  get size(): number { return this.tasks.size; }
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function fixture(dialogs?: object, settings = DEFAULT_DSMM_SETTINGS) {
  const services = new Map<string, unknown>();
  const listeners = new Set<(name: string) => void>();
  const effects: (() => void)[] = [];
  const commands = new FakeCommands();
  services.set("commands", commands);
  if (dialogs !== undefined) services.set("tuiDialogs", dialogs);
  const ctx = {
    get(name: string, _strict?: boolean) { return services.get(name); },
    on(event: string, listener: (name: string) => void) {
      if (event === "internal/service") listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    effect(callback: () => () => void) { const dispose = callback(); effects.push(dispose); return () => {}; },
    logger: { warn() {} }
  } as unknown as DshContext;
  const emit = (name: string) => { for (const listener of listeners) listener(name); };
  const admission: DsmmProfileAdmission = { settings, profile: null, epoch: "a".repeat(64), scope: "global-default" };
  const getSettings = ((agent?: DshAgent) => {
    if (agent !== undefined && services.get("agents") === undefined) throw new Error("no Agent registry");
    return settings;
  }) as DsmmSettingsGetter;
  getSettings.admission = () => admission;
  getSettings.subagentRuntime = () => ({ binding: "stock", deliveryFenceReady: true, restartRequired: false });
  const desired = { settings: DEFAULT_DSMM_SETTINGS, global: {}, profile: {}, globalRevision: "global-1", nativeRevision: "native-1",
    nativeFormRevision: 1, nativeNamespace: "dsmm", entryId: "dsmm", hostProfileKey: "profile", sources: {} };
  let globalSave: GlobalConfigSaveRequest | undefined;
  const deployment = {
    async readDesired() { return desired; },
    async readGlobal(): Promise<GlobalConfigSnapshot> { return { config: {}, revision: "global-1" }; },
    async saveGlobal(request: GlobalConfigSaveRequest, authority: () => void): Promise<GlobalConfigSnapshot> {
      authority(); globalSave = request; return { config: {}, revision: "global-2" };
    }
  } as unknown as DsmmDeploymentConfig;
  const profiles = {} as DsmmProfileRuntime;
  const controller = new DeepworkModeController(ctx, () => true, () => true);
  return { ctx, services, commands, effects, emit, getSettings, admission, deployment, profiles, controller,
    globalSave: () => globalSave };
}

test("TUI settings use the exact native namespace and typed inherit clears", () => {
  const section = createDsmmTuiSettingsSection("real-native-entry");
  assert.equal(section.ns, "real-native-entry");
  assert.deepEqual(section.fields.map(field => field.path.join(".")), [
    "rootModelPolicy", "defaultActive", "locale", "workflow.policy", "subagents.toolTopology"
  ]);
  assert.equal(section.fields.some(field => field.path.includes("profile") || field.path.includes("model")), false);
  const policy = section.fields[0]!;
  assert.deepEqual(policy.parse?.("inherit"), { kind: "clear" });
  assert.deepEqual(policy.parse?.("configured"), { kind: "set", value: "configured" });
  const enabled = section.fields[1]!;
  assert.equal(enabled.format?.(false), "false");
  assert.deepEqual(enabled.parse?.("false"), { kind: "set", value: false });
  assert.deepEqual(enabled.parse?.("inherit"), { kind: "clear" });
});

test("late TUI ownership disposes raw commands and never restores them after service loss", async () => {
  const f = fixture();
  const sections = { registered: undefined as ReturnType<typeof createDsmmTuiSettingsSection> | undefined,
    register(section: ReturnType<typeof createDsmmTuiSettingsSection>) { this.registered = section; return () => { if (this.registered === section) this.registered = undefined; }; } };
  f.services.set("settings", { describe: () => [{ ns: "dsmm", revision: 1 }] });
  f.services.set("tuiSettingsSections", sections);
  const adapter = registerDsmmTuiAdapter(f.ctx, { controller: f.controller, getSettings: f.getSettings, profiles: f.profiles, deployment: f.deployment });
  await adapter.settled();
  assert.deepEqual([...f.commands.definitions.keys()].sort(), ["deepwork", "dsmm-status"]);

  const first = new FakeHost("generation-1");
  f.services.set("tuiPluginHost", first); f.emit("tuiPluginHost");
  await adapter.settled();
  assert.equal(adapter.managed, true);
  assert.equal(f.commands.definitions.size, 0);
  assert.deepEqual([...first.definitions.keys()].sort(), Object.values(DSMM_TUI_CONTRIBUTIONS).sort());
  assert.deepEqual([...first.definitions.values()].map(definition => definition.name), ["dsmm"]);
  assert.equal(sections.registered?.ns, "dsmm");

  f.services.delete("tuiPluginHost"); f.emit("tuiPluginHost");
  await adapter.settled();
  assert.equal(first.definitions.size, 0);
  assert.equal(f.commands.definitions.size, 0, "identified TUI loss must not restore raw commands");
  assert.equal(sections.registered, undefined);

  const second = new FakeHost("generation-2");
  f.services.set("tuiPluginHost", second); f.emit("tuiPluginHost");
  await adapter.settled();
  assert.deepEqual([...second.definitions.keys()].sort(), Object.values(DSMM_TUI_CONTRIBUTIONS).sort());
  adapter.dispose();
  assert.equal(second.definitions.size, 0);
});

test("Desktop keeps the default commands and configured modeName without TUI ownership", async () => {
  for (const modeName of ["deepwork", "focus"]) {
    const f = fixture(undefined, { ...DEFAULT_DSMM_SETTINGS, modeName });
    const adapter = registerDsmmTuiAdapter(f.ctx, { controller: f.controller, getSettings: f.getSettings, profiles: f.profiles, deployment: f.deployment });
    await adapter.settled();
    assert.equal(adapter.managed, false);
    assert.deepEqual([...f.commands.definitions.keys()].sort(), [modeName, "dsmm-status"].sort());
    const session = Session.create(SessionId(`desktop-${modeName}`));
    const agent: DshAgent = { id: session.id, session, async runMaintenance(task) { return task(new AbortController().signal); } };
    f.services.set("agents", { get: () => agent });
    assert.equal((await f.commands.definitions.get(modeName)!.handler({ agent, rawInput: "" })).kind, "success");
    assert.equal(f.controller.active(agent, false), true);
    assert.equal((await f.commands.definitions.get(modeName)!.handler({ agent, rawInput: "off" })).kind, "success");
    assert.equal(f.controller.active(agent, false), false);
    adapter.dispose();
    assert.equal(f.commands.definitions.size, 0);
  }
});

test("single managed command dispatches status and structured status without dialogs or writes", async () => {
  const f = fixture();
  const host = new FakeHost("generation-status");
  f.services.set("tuiPluginHost", host);
  const session = Session.create(SessionId("tui-status"));
  const agent: DshAgent = { id: session.id, session };
  f.services.set("agents", { get: () => agent });
  const adapter = registerDsmmTuiAdapter(f.ctx, { controller: f.controller, getSettings: f.getSettings, profiles: f.profiles, deployment: f.deployment });
  await adapter.settled();
  assert.deepEqual([...host.definitions.values()].map(definition => definition.name), ["dsmm"]);
  const command = host.definitions.get(DSMM_TUI_CONTRIBUTIONS.manage)!;
  assert.equal((await command.handler({ agent, rawInput: "status" })).kind, "success");
  const structured = await command.handler({ agent, rawInput: " status   json " });
  assert.equal(structured.kind, "success");
  assert.deepEqual(JSON.parse(structured.text ?? ""), JSON.parse(handleDsmmStatusCommand(f.controller, f.getSettings, { agent, rawInput: "json" }).text ?? ""));
  assert.equal((await command.handler({ agent, rawInput: "status json extra" })).kind, "error");
  assert.equal(f.globalSave(), undefined);
  assert.equal(session.snapshotEvents().length, 0);
  adapter.dispose();
});

test("single managed command dispatches Deepwork messages, off and menu actions", async () => {
  const f = fixture({ select: async () => "deepwork", input: async () => undefined, confirm: async () => true });
  const host = new FakeHost("generation-dispatch");
  f.services.set("tuiPluginHost", host);
  const session = Session.create(SessionId("tui-dispatch"));
  const steered: unknown[] = [];
  const agent: DshAgent = { id: session.id, session, steer: async message => { steered.push(message); },
    async runMaintenance(task) { return task(new AbortController().signal); } };
  f.services.set("agents", { get: () => agent });
  const adapter = registerDsmmTuiAdapter(f.ctx, { controller: f.controller, getSettings: f.getSettings, profiles: f.profiles, deployment: f.deployment });
  await adapter.settled();
  const command = host.definitions.get(DSMM_TUI_CONTRIBUTIONS.manage)!;
  assert.equal((await command.handler({ agent, rawInput: "deepwork continue carefully" })).kind, "success");
  assert.equal(f.controller.active(agent, false), true);
  assert.equal(steered.length, 1);
  assert.equal((await command.handler({ agent, rawInput: "deepwork off" })).kind, "success");
  assert.equal(f.controller.active(agent, false), false);
  assert.equal(steered.length, 1);
  assert.equal((await command.handler({ agent, rawInput: "" })).kind, "success");
  assert.equal(f.controller.active(agent, false), true);
  assert.equal(steered.length, 1);
  adapter.dispose();
});

test("the single exact grant gates every managed subcommand and never enables raw fallback", async () => {
  let dialogs = 0;
  const f = fixture({ select: async () => { dialogs++; return undefined; }, input: async () => undefined, confirm: async () => { dialogs++; return true; } });
  const host = new FakeHost("generation-grant");
  host.allowed = false;
  f.services.set("tuiPluginHost", host);
  const session = Session.create(SessionId("tui-denied"));
  const agent: DshAgent = { id: session.id, session };
  f.services.set("agents", { get: () => agent });
  const adapter = registerDsmmTuiAdapter(f.ctx, { controller: f.controller, getSettings: f.getSettings, profiles: f.profiles, deployment: f.deployment });
  await adapter.settled();
  const command = host.definitions.get(DSMM_TUI_CONTRIBUTIONS.manage)!;
  for (const rawInput of ["", "status", "status json", "deepwork", "deepwork off", "config", "profiles"]) {
    assert.equal((await command.handler({ agent, rawInput })).kind, "error");
  }
  assert.equal(dialogs, 0);
  assert.equal(f.globalSave(), undefined);
  assert.equal(session.snapshotEvents().length, 0);
  f.services.delete("tuiPluginHost"); f.emit("tuiPluginHost");
  await adapter.settled();
  assert.equal((await command.handler({ agent, rawInput: "deepwork" })).kind, "error");
  assert.equal(f.commands.definitions.size, 0);
  adapter.dispose();
});

test("cancelled configuration and menu actions do not write", async () => {
  const selections: (string | undefined)[] = [undefined, "default-active", "true", undefined];
  const f = fixture({ select: async () => selections.shift(), input: async () => undefined, confirm: async () => false });
  const host = new FakeHost("generation-cancel");
  f.services.set("tuiPluginHost", host);
  const session = Session.create(SessionId("tui-cancel"));
  const agent: DshAgent = { id: session.id, session };
  f.services.set("agents", { get: () => agent });
  const adapter = registerDsmmTuiAdapter(f.ctx, { controller: f.controller, getSettings: f.getSettings, profiles: f.profiles, deployment: f.deployment });
  await adapter.settled();
  const command = host.definitions.get(DSMM_TUI_CONTRIBUTIONS.manage)!;
  for (const rawInput of ["config", "config", ""]) assert.equal((await command.handler({ agent, rawInput })).kind, "error");
  assert.equal((await command.handler({ agent, rawInput: "deepwork", signal: AbortSignal.abort() })).kind, "error");
  assert.equal(f.globalSave(), undefined);
  assert.equal(session.snapshotEvents().length, 0);
  adapter.dispose();
});

test("the managed dispatcher cannot enable a disabled Deepwork module", async () => {
  let confirmations = 0;
  const settings = { ...DEFAULT_DSMM_SETTINGS, modules: { ...DEFAULT_DSMM_SETTINGS.modules, deepwork: { enabled: false } } };
  const f = fixture({ select: async () => undefined, input: async () => undefined, confirm: async () => { confirmations++; return true; } }, settings);
  const host = new FakeHost("generation-disabled");
  f.services.set("tuiPluginHost", host);
  const session = Session.create(SessionId("tui-disabled"));
  const agent: DshAgent = { id: session.id, session };
  f.services.set("agents", { get: () => agent });
  const adapter = registerDsmmTuiAdapter(f.ctx, { controller: f.controller, getSettings: f.getSettings, profiles: f.profiles, deployment: f.deployment });
  await adapter.settled();
  assert.equal((await host.definitions.get(DSMM_TUI_CONTRIBUTIONS.manage)!.handler({ agent, rawInput: "deepwork" })).kind, "error");
  assert.equal(confirmations, 0);
  assert.equal(session.snapshotEvents().length, 0);
  adapter.dispose();
});

test("a delayed public admission retries on the same live owners without a service event", async () => {
  const clock = new ManualClock();
  const f = fixture();
  const host = new FakeHost("generation-admission");
  host.admitted = false;
  f.services.set("tuiPluginHost", host);
  const adapter = registerDsmmTuiAdapter(f.ctx, { controller: f.controller, getSettings: f.getSettings,
    profiles: f.profiles, deployment: f.deployment, clock });
  await adapter.settled();
  assert.equal(adapter.managed, true);
  assert.equal(host.definitions.size, 0);
  assert.equal(f.commands.definitions.size, 0);
  assert.equal(clock.size, 1);

  host.admitted = true;
  clock.runNext();
  await adapter.settled();
  assert.deepEqual([...host.definitions.keys()].sort(), Object.values(DSMM_TUI_CONTRIBUTIONS).sort());
  adapter.dispose();
  assert.equal(clock.size, 0);
});

test("managed Deepwork requires strict confirmation and owner loss cancels a pending action", async () => {
  let confirm: "false" | "pending" | "true" = "false";
  const dialogs = {
    select: async () => undefined,
    input: async () => undefined,
    confirm(request: { signal?: AbortSignal }) {
      if (confirm === "false") return Promise.resolve(false);
      if (confirm === "true") return Promise.resolve(true);
      return new Promise<boolean>(resolve => request.signal?.addEventListener("abort", () => resolve(false), { once: true }));
    }
  };
  const f = fixture(dialogs);
  const host = new FakeHost("generation-1");
  f.services.set("tuiPluginHost", host);
  const session = Session.create(SessionId("tui-deepwork"));
  const agent: DshAgent = { id: session.id, session, async runMaintenance(task) { return task(new AbortController().signal); } };
  f.services.set("agents", { get: (id: string) => id === agent.id ? agent : undefined, list: () => [agent], roots: () => [agent], isOwnedBy: () => false });
  const adapter = registerDsmmTuiAdapter(f.ctx, { controller: f.controller, getSettings: f.getSettings, profiles: f.profiles, deployment: f.deployment });
  await adapter.settled();
  const command = host.definitions.get(DSMM_TUI_CONTRIBUTIONS.manage)!;

  assert.equal((await command.handler({ agent, rawInput: "deepwork" })).kind, "error");
  assert.equal(session.snapshotEvents().length, 0);
  confirm = "true";
  assert.equal((await command.handler({ agent, rawInput: "deepwork" })).kind, "success");
  assert.equal(session.snapshotEvents().filter(event => event.type === "plugin:dsmm/mode").length, 1);

  await f.controller.select(agent, false);
  confirm = "pending";
  const pending = command.handler({ agent, rawInput: "deepwork" });
  await Promise.resolve();
  f.services.delete("tuiPluginHost"); f.emit("tuiPluginHost");
  assert.equal((await pending).kind, "error");
  await adapter.settled();
  assert.equal(session.snapshotEvents().filter(event => event.type === "plugin:dsmm/mode").length, 2, "only the explicit reset before the pending action committed");
  assert.equal(f.commands.definitions.size, 0);
  adapter.dispose();
});

test("managed Deepwork does not steer after its committed mode revision is replaced", async () => {
  const dialogs = { select: async () => undefined, input: async () => undefined, confirm: async () => true };
  const f = fixture(dialogs);
  const host = new FakeHost("generation-mode-revision");
  f.services.set("tuiPluginHost", host);
  const session = Session.create(SessionId("tui-mode-revision"));
  let steers = 0;
  const agent: DshAgent = {
    id: session.id,
    session,
    async steer() { steers++; },
    async runMaintenance(task) {
      const result = await task(new AbortController().signal);
      await f.controller.selectIdle(agent, false, false);
      return result;
    }
  };
  f.services.set("agents", { get: (id: string) => id === agent.id ? agent : undefined, list: () => [agent], roots: () => [agent], isOwnedBy: () => false });
  const adapter = registerDsmmTuiAdapter(f.ctx, { controller: f.controller, getSettings: f.getSettings, profiles: f.profiles, deployment: f.deployment });
  await adapter.settled();

  const result = await host.definitions.get(DSMM_TUI_CONTRIBUTIONS.manage)!.handler({ agent, rawInput: "deepwork continue carefully" });
  assert.equal(result.kind, "success");
  assert.match(result.text, /committed/u);
  assert.equal(steers, 0);
  assert.equal(f.controller.active(agent, false), false);
  assert.equal(session.snapshotEvents().filter(event => event.type === "plugin:dsmm/mode").length, 2);
  adapter.dispose();
});

test("managed Global edit confirms one allowlisted scalar and preserves revision CAS", async () => {
  const selections = ["default-active", "true"];
  const dialogs = { select: async () => selections.shift(), input: async () => undefined, confirm: async () => true };
  const f = fixture(dialogs);
  const host = new FakeHost("generation-1");
  f.services.set("tuiPluginHost", host);
  const session = Session.create(SessionId("tui-global"));
  const agent: DshAgent = { id: session.id, session };
  f.services.set("agents", { get: (id: string) => id === agent.id ? agent : undefined, list: () => [agent], roots: () => [agent], isOwnedBy: () => false });
  const adapter = registerDsmmTuiAdapter(f.ctx, { controller: f.controller, getSettings: f.getSettings, profiles: f.profiles, deployment: f.deployment });
  await adapter.settled();
  const result = await host.definitions.get(DSMM_TUI_CONTRIBUTIONS.manage)!.handler({ agent, rawInput: "config" } satisfies DshCommandInvocation);
  assert.equal(result.kind, "success");
  assert.deepEqual(f.globalSave(), { expectedRevision: "global-1", edits: [{ op: "set", path: ["defaultActive"], value: true }] });
  adapter.dispose();
});

test("one action deadline reaches the write authority after confirmation", async () => {
  const selections = ["default-active", "true"];
  const dialogs = { select: async () => selections.shift(), input: async () => undefined, confirm: async () => true };
  const clock = new ManualClock();
  const entered = gate(), release = gate();
  let writes = 0;
  const f = fixture(dialogs);
  const deployment = {
    async readGlobal(): Promise<GlobalConfigSnapshot> { return { config: {}, revision: "global-deadline" }; },
    async saveGlobal(_request: GlobalConfigSaveRequest, authority: () => void): Promise<GlobalConfigSnapshot> {
      authority(); entered.release(); await release.promise; authority(); writes++;
      return { config: {}, revision: "global-written" };
    }
  } as unknown as DsmmDeploymentConfig;
  const host = new FakeHost("generation-deadline");
  f.services.set("tuiPluginHost", host);
  const session = Session.create(SessionId("tui-deadline"));
  const agent: DshAgent = { id: session.id, session };
  f.services.set("agents", { get: (id: string) => id === agent.id ? agent : undefined, list: () => [agent], roots: () => [agent], isOwnedBy: () => false });
  const adapter = registerDsmmTuiAdapter(f.ctx, { controller: f.controller, getSettings: f.getSettings, profiles: f.profiles, deployment, clock });
  await adapter.settled();

  const pending = host.definitions.get(DSMM_TUI_CONTRIBUTIONS.manage)!.handler({ agent, rawInput: "config" });
  await entered.promise;
  clock.runNext();
  release.release();
  const result = await pending;
  assert.equal(result.kind, "error");
  assert.equal(writes, 0);
  adapter.dispose();
  assert.equal(clock.size, 0);
});

test("configuration rechecks the grant, Host generation and exact Agent after confirmation", async () => {
  for (const change of ["grant", "generation", "agent"] as const) {
    const selections = ["default-active", "true"];
    const f = fixture({ select: async () => selections.shift(), input: async () => undefined, confirm: async () => {
      if (change === "grant") host.allowed = false;
      if (change === "generation") f.services.set("tuiPluginHost", new FakeHost("generation-replaced"));
      if (change === "agent") f.services.set("agents", { get: () => ({ ...agent }) });
      return true;
    } });
    const host = new FakeHost("generation-confirm");
    f.services.set("tuiPluginHost", host);
    const session = Session.create(SessionId(`tui-confirm-${change}`));
    const agent: DshAgent = { id: session.id, session };
    f.services.set("agents", { get: () => agent });
    const adapter = registerDsmmTuiAdapter(f.ctx, { controller: f.controller, getSettings: f.getSettings, profiles: f.profiles, deployment: f.deployment });
    await adapter.settled();
    assert.equal((await host.definitions.get(DSMM_TUI_CONTRIBUTIONS.manage)!.handler({ agent, rawInput: "config" })).kind, "error");
    assert.equal(f.globalSave(), undefined);
    assert.equal(session.snapshotEvents().length, 0);
    assert.equal(f.commands.definitions.size, 0);
    adapter.dispose();
  }
});

test("managed named-profile Apply forwards the captured session and profile CAS", async () => {
  const selections = ["session", "profile:0"];
  const dialogs = { select: async () => selections.shift(), input: async () => undefined, confirm: async () => true };
  const f = fixture(dialogs);
  const host = new FakeHost("generation-1");
  f.services.set("tuiPluginHost", host);
  const session = Session.create(SessionId("tui-profile"));
  const agent: DshAgent = { id: session.id, session, status: "idle", async runMaintenance(task) { return task(new AbortController().signal); } };
  f.services.set("agents", { get: (id: string) => id === agent.id ? agent : undefined, list: () => [agent], roots: () => [agent], isOwnedBy: () => false });
  const profileRevision = "b".repeat(64);
  let request: unknown;
  const profiles = {
    async describe() {
      return { selectedId: null, appliedRevision: null, selectionRevision: "global-selection", profiles: [
        { id: "focus", label: "Focus", revision: profileRevision }
      ], origin: "central", readOnly: false };
    },
    async getSession() {
      return { sessionId: agent.id, globalDefault: { selectedId: null, appliedRevision: null, selectionRevision: "global-selection" },
        selection: { selectedId: null, appliedRevision: null, selectionRevision: "session-selection" }, scope: "global-default",
        admissionEpoch: f.admission.epoch, switchAllowed: false, canSelectModel: false, canToggleMode: true, canApplyOverlay: true };
    },
    async selectSession(input: unknown, captured: DshAgent, signal: AbortSignal, authority: () => void) {
      authority(); assert.equal(captured, agent); assert.equal(signal.aborted, false); request = input;
      return { sessionId: agent.id,
        selection: { selectedId: "focus", appliedRevision: profileRevision, selectionRevision: "unavailable", refreshRequired: true },
        admittedSelection: { selectedId: "focus" }, admissionEpoch: "c".repeat(64) };
    }
  } as unknown as DsmmProfileRuntime;
  const adapter = registerDsmmTuiAdapter(f.ctx, { controller: f.controller, getSettings: f.getSettings, profiles, deployment: f.deployment });
  await adapter.settled();
  const result = await host.definitions.get(DSMM_TUI_CONTRIBUTIONS.manage)!.handler({ agent, rawInput: "profiles" });
  assert.equal(result.kind, "success");
  assert.match(result.text, /refresh is required/iu);
  assert.deepEqual(request, { sessionId: agent.id, id: "focus", expectedSelectionRevision: "session-selection",
    expectedAdmissionEpoch: f.admission.epoch, expectedRevision: profileRevision });
  adapter.dispose();
});

test("managed future profile selection reports actual committed refresh-required success", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "dsmm-tui-profile-"));
  let refuseObservation = false;
  const store = new ProfileStore(join(rootDir, "dsmm-profiles"), { observe() { if (refuseObservation) throw new Error("post-commit observation unavailable"); } });
  const runtime = new DsmmProfileRuntime({}, resolveConfig(), store);
  try {
    await runtime.initialize();
    const saved = await runtime.save({ id: "focus", content: JSON.stringify({ version: 1, id: "focus", settings: { defaultActive: true } }), expectedRevision: null });
    const selections = ["future", "profile:0"];
    const dialogs = { select: async () => selections.shift(), input: async () => undefined, confirm: async () => true };
    const f = fixture(dialogs);
    const host = new FakeHost("generation-profile-refresh");
    f.services.set("tuiPluginHost", host);
    const session = Session.create(SessionId("tui-profile-refresh"));
    const agent: DshAgent = { id: session.id, session };
    f.services.set("agents", { get: (id: string) => id === agent.id ? agent : undefined, list: () => [agent], roots: () => [agent], isOwnedBy: () => false });
    refuseObservation = true;
    const adapter = registerDsmmTuiAdapter(f.ctx, { controller: f.controller, getSettings: f.getSettings, profiles: runtime, deployment: f.deployment });
    await adapter.settled();
    const result = await host.definitions.get(DSMM_TUI_CONTRIBUTIONS.manage)!.handler({ agent, rawInput: "profiles" });
    assert.equal(result.kind, "success");
    assert.match(result.text, /refresh is required/iu);
    assert.equal((await runtime.admission()).selectedId, saved.id);
    adapter.dispose();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("mode authority is checked inside maintenance immediately before commit", async () => {
  const session = Session.create(SessionId("tui-mode-authority"));
  const agent: DshAgent = { id: session.id, session, async runMaintenance(task) { return task(new AbortController().signal); } };
  const controller = new DeepworkModeController({});
  let checks = 0;
  await assert.rejects(controller.select(agent, true, false, () => {
    checks++;
    if (checks === 3) throw new Error("authority revoked");
  }), /authority revoked/u);
  assert.equal(checks, 3);
  assert.equal(session.snapshotEvents().length, 0);
});
