import { symbols } from "@deepseek-ai/cordis";
import type { DshAgentsRegistry, DshCommandInvocation, DshCommandsRegistry, DshContext } from "./dsh-types.js";
import { createDeepworkCommandDefinition, createDsmmStatusCommandDefinition } from "./commands.js";
import type { DsmmSettingsGetter } from "./settings.js";
import { DSMM_LOCALES } from "./settings.js";
import type { DeepworkModeController } from "./state.js";
import type { DsmmProfileRuntime } from "./profile-runtime.js";
import type { DsmmDeploymentConfig } from "./deployment-config.js";
import { createDsmmManagementCommandDefinition, DIALOG_TIMEOUT_MS, DSMM_TUI_CONTRIBUTIONS } from "./tui-actions.js";
import type { BeginDsmmTuiAction, DsmmTuiActionAuthority, TuiDialogsLike, TuiPluginHostLike, TuiSettingsField, TuiSettingsLike, TuiSettingsSection, TuiSettingsSectionsLike } from "./tui-types.js";

export interface DsmmTuiAdapterOptions {
  controller: DeepworkModeController;
  getSettings: DsmmSettingsGetter;
  profiles: DsmmProfileRuntime;
  deployment: DsmmDeploymentConfig;
  clock?: DsmmTuiClock;
}

export interface DsmmTuiClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DsmmTuiAdapterHandle {
  readonly managed: boolean;
  settled(): Promise<void>;
  dispose(): void;
}

interface ManagedOwner {
  owner: object;
  generationId: string;
  host: TuiPluginHostLike;
  commandsOwner: object;
  disposers: (() => void)[];
  grantWatcher?: () => void;
}

interface SettingsRegistration {
  owner: object;
  namespace: string;
  hostOwner: object;
  generationId: string;
  dispose(): void;
}

interface AdmissionRetry {
  owner: object;
  generationId: string;
  commandsOwner: object;
  failures: number;
  ready: boolean;
  timer?: unknown;
}

const INHERIT = "inherit";
const ACTION_TIMEOUT_MS = 120_000;
const ADMISSION_RETRY_INTERVAL_MS = 200;
const ADMISSION_RETRY_ATTEMPTS = 105;
const SYSTEM_CLOCK: DsmmTuiClock = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export function createDsmmTuiSettingsSection(namespace: string): TuiSettingsSection {
  const select = (path: readonly string[], label: string, values: readonly string[], descriptions?: Record<string, string>): TuiSettingsField => ({
    path, label, descriptions, kind: "select",
    options: [{ value: INHERIT, label: "Inherit", descriptions: { zh: "继承" } }, ...values.map(value => ({ value, label: value }))],
    format(value) { return typeof value === "string" && values.includes(value) ? value : INHERIT; },
    parse(text) { return text === INHERIT ? { kind: "clear" } : values.includes(text) ? { kind: "set", value: text } : undefined; }
  });
  const boolean = (path: readonly string[], label: string, descriptions?: Record<string, string>): TuiSettingsField => ({
    path, label, descriptions, kind: "select",
    options: [
      { value: INHERIT, label: "Inherit", descriptions: { zh: "继承" } },
      { value: "true", label: "Enabled", descriptions: { zh: "开启" } },
      { value: "false", label: "Disabled", descriptions: { zh: "关闭" } }
    ],
    format(value) { return value === true ? "true" : value === false ? "false" : INHERIT; },
    parse(text) { return text === INHERIT ? { kind: "clear" } : text === "true" ? { kind: "set", value: true } : text === "false" ? { kind: "set", value: false } : undefined; }
  });
  return {
    ns: namespace,
    title: "DSMM",
    descriptions: { zh: "DSMM" },
    groups: [{ id: "deployment", title: "Deployment", descriptions: { zh: "部署" }, mode: "inline" }],
    fields: [
      { ...select(["rootModelPolicy"], "Root model policy", ["native", "configured"], { zh: "根模型策略" }), group: "deployment" },
      { ...boolean(["defaultActive"], "Deepwork default", { zh: "Deepwork 默认状态" }), group: "deployment" },
      { ...select(["locale"], "Locale", DSMM_LOCALES, { zh: "语言" }), group: "deployment" },
      { ...select(["workflow", "policy"], "Workflow policy", ["risk-based", "legacy"], { zh: "工作流策略" }), group: "deployment" },
      { ...select(["subagents", "toolTopology"], "Subagent tool topology", ["per-role", "parameterized"], { zh: "子 Agent 工具拓扑" }), group: "deployment" }
    ]
  };
}

class DsmmTuiAdapter implements DsmmTuiAdapterHandle {
  private stickyManaged = false;
  private disposed = false;
  private raw?: { commandsOwner: object; disposers: (() => void)[] };
  private mediated?: ManagedOwner;
  private settings?: SettingsRegistration;
  private admissionRetry?: AdmissionRetry;
  private readonly operations = new Set<AbortController>();
  private listener?: () => void;
  private queue: Promise<void> = Promise.resolve();
  private warned = new Set<string>();

  get managed(): boolean { return this.stickyManaged; }

  constructor(private readonly ctx: DshContext, private readonly options: DsmmTuiAdapterOptions) {
    const remove = ctx.on?.("internal/service", (name: string) => {
      if (!["commands", "tuiPluginHost", "tuiDialogs", "tuiSettingsSections", "settings", "agents"].includes(name)) return;
      this.abortOperations();
      if (name === "tuiPluginHost") {
        const observed = softGet<unknown>(this.ctx, "tuiPluginHost");
        if (observed !== undefined) { this.stickyManaged = true; this.disposeRaw(); }
        const host = validHost(observed);
        if (this.mediated !== undefined && (host === undefined || original(host) !== this.mediated.owner
          || host.generationId !== this.mediated.generationId)) {
          this.disposeMediated();
          this.disposeSettings();
        }
      } else if (name === "commands") {
        const commands = softGet<DshCommandsRegistry>(this.ctx, "commands");
        const owner = originalMaybe(commands);
        if (this.raw !== undefined && this.raw.commandsOwner !== owner) this.disposeRaw();
        if (this.mediated !== undefined && this.mediated.commandsOwner !== owner) {
          this.disposeMediated();
          this.disposeSettings();
        }
      } else if (name === "tuiSettingsSections" || name === "settings") {
        this.disposeSettings();
      }
      this.schedule();
    }, { global: true });
    if (typeof remove === "function") this.listener = remove as () => void;
    ctx.effect?.(() => () => this.dispose());
    this.schedule();
  }

  settled(): Promise<void> { return this.queue; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortOperations();
    this.disposeRaw();
    this.disposeMediated();
    this.disposeSettings();
    this.clearAdmissionRetry();
    this.listener?.();
    this.listener = undefined;
  }

  private schedule(): void {
    this.queue = this.queue.then(() => this.reconcile()).catch(cause => {
      this.warn("reconcile", `DSMM TUI adapter reconciliation failed: ${safeMessage(cause)}`);
    });
  }

  private async reconcile(): Promise<void> {
    if (this.disposed) return;
    const observedHost = softGet<unknown>(this.ctx, "tuiPluginHost");
    if (observedHost !== undefined) this.stickyManaged = true;
    const commands = softGet<DshCommandsRegistry>(this.ctx, "commands");
    if (!this.stickyManaged) {
      this.disposeMediated();
      this.disposeSettings();
      this.ensureRaw(commands);
      return;
    }
    this.disposeRaw();
    const host = validHost(observedHost);
    if (host === undefined || commands === undefined) {
      this.clearAdmissionRetry();
      this.disposeMediated();
      this.disposeSettings();
      if (observedHost !== undefined && host === undefined) this.warn("host", "DSMM identified a TUI management service with an incompatible public interface; raw command fallback remains disabled.");
      return;
    }
    const hostOwner = original(host);
    const commandsOwner = original(commands as object);
    if (this.mediated === undefined || this.mediated.owner !== hostOwner || this.mediated.generationId !== host.generationId || this.mediated.commandsOwner !== commandsOwner) {
      this.disposeMediated();
      if (this.admissionRetryReady(hostOwner, host.generationId, commandsOwner)) {
        this.mediated = this.registerManaged(host, hostOwner, commandsOwner);
      }
    }
    await this.reconcileSettings(hostOwner, host.generationId);
  }

  private ensureRaw(commands: DshCommandsRegistry | undefined): void {
    if (commands === undefined) { this.disposeRaw(); return; }
    const owner = original(commands as object);
    if (this.raw?.commandsOwner === owner) return;
    this.disposeRaw();
    const disposers: (() => void)[] = [];
    try {
      disposers.push(requireDisposer(commands.register(createDsmmStatusCommandDefinition(this.options.controller, this.options.getSettings))));
      if (this.options.getSettings().modules.deepwork.enabled) {
        disposers.push(requireDisposer(commands.register(createDeepworkCommandDefinition(this.options.controller, this.options.getSettings))));
      }
      this.raw = { commandsOwner: owner, disposers };
    } catch (cause) {
      disposeAll(disposers);
      this.warn("raw", `DSMM raw command registration failed: ${safeMessage(cause)}`);
    }
  }

  private registerManaged(host: TuiPluginHostLike, owner: object, commandsOwner: object): ManagedOwner | undefined {
    const disposers: (() => void)[] = [];
    try {
      const begin: BeginDsmmTuiAction = (invocation, contributionId, requireDialogs) => this.begin(invocation, contributionId, requireDialogs);
      const deps = { ...this.options, begin };
      disposers.push(requireDisposer(host.registerCommand(this.ctx, DSMM_TUI_CONTRIBUTIONS.manage, createDsmmManagementCommandDefinition(deps))));
      const watcher = host.grants.onChange?.(this.ctx, () => this.abortOperations());
      this.clearAdmissionRetry();
      return { owner, generationId: host.generationId, host, commandsOwner, disposers,
        ...(typeof watcher === "function" ? { grantWatcher: watcher } : {}) };
    } catch (cause) {
      disposeAll(disposers);
      if (componentNotAdmitted(cause)) {
        this.deferAdmissionRetry(owner, host.generationId, commandsOwner);
        return undefined;
      }
      this.clearAdmissionRetry();
      this.warn("managed", `DSMM mediated command registration was refused: ${safeMessage(cause)}. Raw fallback remains disabled.`);
      return undefined;
    }
  }

  private async reconcileSettings(hostOwner: object, generationId: string): Promise<void> {
    const sections = softGet<TuiSettingsSectionsLike>(this.ctx, "tuiSettingsSections");
    const settings = softGet<TuiSettingsLike>(this.ctx, "settings");
    if (sections === undefined || settings === undefined || typeof sections.register !== "function" || typeof settings.describe !== "function") {
      this.disposeSettings();
      return;
    }
    const sectionsOwner = original(sections as object);
    const settingsOwner = original(settings as object);
    let desired;
    try { desired = await this.options.deployment.readDesired(); }
    catch (cause) {
      this.disposeSettings();
      this.warn("namespace-read", `DSMM TUI settings are unavailable: ${safeMessage(cause)}`);
      return;
    }
    if (!this.currentHost(hostOwner, generationId) || this.disposed
      || originalMaybe(softGet<TuiSettingsSectionsLike>(this.ctx, "tuiSettingsSections")) !== sectionsOwner
      || originalMaybe(softGet<TuiSettingsLike>(this.ctx, "settings")) !== settingsOwner) return;
    const namespace = desired.nativeNamespace;
    if (typeof namespace !== "string" || namespace.length === 0) {
      this.disposeSettings();
      this.warn("namespace-missing", "DSMM TUI settings require the Host's real native namespace; none is available.");
      return;
    }
    let descriptor;
    try { descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === namespace); }
    catch (cause) {
      this.disposeSettings();
      this.warn("namespace-describe", `DSMM could not verify its native settings namespace: ${safeMessage(cause)}`);
      return;
    }
    if (descriptor === undefined || typeof descriptor.revision !== "number") {
      this.disposeSettings();
      this.warn("namespace-incompatible", `DSMM native settings namespace "${namespace}" is not served by the public settings descriptor.`);
      return;
    }
    if (this.settings?.owner === sectionsOwner && this.settings.namespace === namespace
      && this.settings.hostOwner === hostOwner && this.settings.generationId === generationId) return;
    this.disposeSettings();
    try {
      const dispose = requireDisposer(sections.register(createDsmmTuiSettingsSection(namespace)));
      const currentSections = softGet<TuiSettingsSectionsLike>(this.ctx, "tuiSettingsSections");
      const currentSettings = softGet<TuiSettingsLike>(this.ctx, "settings");
      if (!this.currentHost(hostOwner, generationId) || this.disposed || currentSections === undefined || currentSettings === undefined
        || original(currentSections as object) !== sectionsOwner || original(currentSettings as object) !== settingsOwner) { dispose(); return; }
      this.settings = { owner: sectionsOwner, namespace, hostOwner, generationId, dispose };
    } catch (cause) {
      this.warn("settings-register", `DSMM TUI settings registration was refused for native namespace "${namespace}": ${safeMessage(cause)}`);
    }
  }

  private begin(invocation: DshCommandInvocation, contributionId: string, requireDialogs: boolean): DsmmTuiActionAuthority {
    const mounted = this.mediated;
    if (mounted === undefined || !this.currentHost(mounted.owner, mounted.generationId)) throw new Error("DSMM TUI management is unavailable.");
    if (!mounted.host.grants.allows(this.ctx, "commands.invoke", contributionId)) throw new Error("DSMM TUI command permission is not granted.");
    const agents = softGet<DshAgentsRegistry>(this.ctx, "agents");
    const agent = invocation.agent;
    const id = agent.id ?? agent.session.id;
    if (agents === undefined || typeof id !== "string" || agents.get(id) !== agent) throw new Error("The command is not bound to an exact live Agent.");
    const agentsOwner = original(agents as object);
    const admission = this.options.getSettings.admission?.(agent);
    const dialogs = requireDialogs ? softGet<TuiDialogsLike>(this.ctx, "tuiDialogs") : undefined;
    if (requireDialogs && (dialogs === undefined || typeof dialogs.select !== "function" || typeof dialogs.confirm !== "function" || typeof dialogs.input !== "function")) {
      throw new Error("Managed TUI dialogs are unavailable; no action was started.");
    }
    const dialogsOwner = dialogs === undefined ? undefined : original(dialogs as object);
    const local = new AbortController();
    const deadline = new AbortController();
    const clock = this.options.clock ?? SYSTEM_CLOCK;
    const deadlineTimer = clock.setTimeout(() => deadline.abort(), ACTION_TIMEOUT_MS);
    this.operations.add(local);
    const signal = invocation.signal === undefined
      ? AbortSignal.any([local.signal, deadline.signal])
      : AbortSignal.any([local.signal, deadline.signal, invocation.signal]);
    const assertCurrent = (): void => {
      if (signal.aborted || this.disposed) throw abortError();
      if (this.mediated !== mounted || !this.currentHost(mounted.owner, mounted.generationId)
        || !mounted.host.grants.allows(this.ctx, "commands.invoke", contributionId)) throw new Error("DSMM TUI command authority changed.");
      const currentAgents = softGet<DshAgentsRegistry>(this.ctx, "agents");
      if (currentAgents === undefined || original(currentAgents as object) !== agentsOwner || currentAgents.get(id) !== agent) throw new Error("The exact live Agent changed.");
      if (admission !== undefined) {
        const current = this.options.getSettings.admission?.(agent);
        if (current !== admission || current?.epoch !== admission.epoch) throw new Error("The DSMM admission changed.");
      }
      if (dialogsOwner !== undefined) {
        const currentDialogs = softGet<TuiDialogsLike>(this.ctx, "tuiDialogs");
        if (currentDialogs === undefined || original(currentDialogs as object) !== dialogsOwner) throw new Error("The managed dialog owner changed.");
      }
    };
    const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
      assertCurrent();
      const result = await operation();
      assertCurrent();
      return result;
    };
    let closed = false;
    return {
      signal,
      agent,
      assertCurrent,
      select: (title, options) => checked(() => dialogs!.select({ title, options, signal, timeoutMs: DIALOG_TIMEOUT_MS })),
      confirm: (title, message, confirmLabel) => checked(() => dialogs!.confirm({ title, message,
        ...(confirmLabel === undefined ? {} : { confirmLabel }), cancelLabel: "Cancel", signal, timeoutMs: DIALOG_TIMEOUT_MS })),
      input: (title, placeholder) => checked(() => dialogs!.input({ title, ...(placeholder === undefined ? {} : { placeholder }), signal, timeoutMs: DIALOG_TIMEOUT_MS })),
      close: () => { if (closed) return; closed = true; clock.clearTimeout(deadlineTimer); this.operations.delete(local); local.abort(); }
    };
  }

  private currentHost(owner: object, generationId: string): boolean {
    const host = validHost(softGet<unknown>(this.ctx, "tuiPluginHost"));
    return host !== undefined && original(host) === owner && host.generationId === generationId;
  }

  private abortOperations(): void {
    for (const operation of this.operations) operation.abort();
    this.operations.clear();
  }

  private admissionRetryReady(owner: object, generationId: string, commandsOwner: object): boolean {
    const retry = this.admissionRetry;
    if (retry === undefined) return true;
    if (retry.owner !== owner || retry.generationId !== generationId || retry.commandsOwner !== commandsOwner) {
      this.clearAdmissionRetry();
      return true;
    }
    return retry.ready && retry.failures < ADMISSION_RETRY_ATTEMPTS;
  }

  private deferAdmissionRetry(owner: object, generationId: string, commandsOwner: object): void {
    let retry = this.admissionRetry;
    if (retry === undefined || retry.owner !== owner || retry.generationId !== generationId || retry.commandsOwner !== commandsOwner) {
      this.clearAdmissionRetry();
      retry = { owner, generationId, commandsOwner, failures: 0, ready: false };
      this.admissionRetry = retry;
    }
    retry.failures++;
    retry.ready = false;
    if (retry.failures >= ADMISSION_RETRY_ATTEMPTS) {
      this.warn(`managed-admission-${generationId}`, "DSMM TUI command registration did not become admitted within the bounded readiness window; raw fallback remains disabled.");
      return;
    }
    const clock = this.options.clock ?? SYSTEM_CLOCK;
    retry.timer = clock.setTimeout(() => {
      if (this.admissionRetry !== retry) return;
      retry.timer = undefined;
      if (this.disposed || !this.currentHost(owner, generationId)
        || originalMaybe(softGet<DshCommandsRegistry>(this.ctx, "commands")) !== commandsOwner) {
        this.clearAdmissionRetry();
        return;
      }
      retry.ready = true;
      this.schedule();
    }, ADMISSION_RETRY_INTERVAL_MS);
  }

  private clearAdmissionRetry(): void {
    const retry = this.admissionRetry;
    if (retry?.timer !== undefined) (this.options.clock ?? SYSTEM_CLOCK).clearTimeout(retry.timer);
    this.admissionRetry = undefined;
  }

  private disposeRaw(): void { if (this.raw !== undefined) disposeAll(this.raw.disposers); this.raw = undefined; }
  private disposeMediated(): void {
    if (this.mediated !== undefined) {
      this.mediated.grantWatcher?.();
      disposeAll(this.mediated.disposers);
    }
    this.mediated = undefined;
    this.abortOperations();
  }
  private disposeSettings(): void { this.settings?.dispose(); this.settings = undefined; }
  private warn(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.ctx.logger?.warn(message);
  }
}

export function registerDsmmTuiAdapter(ctx: DshContext, options: DsmmTuiAdapterOptions): DsmmTuiAdapterHandle {
  return new DsmmTuiAdapter(ctx, options);
}

function softGet<T>(ctx: DshContext, name: string): T | undefined {
  return (ctx.get as undefined | ((name: string, strict?: boolean) => T | undefined))?.call(ctx, name, false);
}

function validHost(value: unknown): TuiPluginHostLike | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const host = value as Partial<TuiPluginHostLike>;
  return typeof host.generationId === "string" && host.generationId.length > 0 && typeof host.registerCommand === "function"
    && host.grants !== undefined && typeof host.grants.allows === "function" ? host as TuiPluginHostLike : undefined;
}

function original<T extends object>(value: T): object { return Reflect.get(value, symbols.original) ?? value; }
function originalMaybe(value: unknown): object | undefined { return value !== null && typeof value === "object" ? original(value) : undefined; }
function requireDisposer(value: unknown): () => void {
  if (typeof value !== "function") throw new Error("Host registration did not expose a disposer");
  return value as () => void;
}
function disposeAll(disposers: readonly (() => void)[]): void {
  for (const dispose of [...disposers].reverse()) { try { dispose(); } catch {} }
}
function abortError(): Error { const error = new Error("DSMM TUI action was cancelled."); error.name = "AbortError"; return error; }
function safeMessage(cause: unknown): string { return cause instanceof Error ? cause.message.replace(/[\u0000-\u001F\u007F]/gu, " ").slice(0, 400) : "unknown error"; }
function componentNotAdmitted(cause: unknown): boolean {
  return cause !== null && typeof cause === "object" && Reflect.get(cause, "code") === "COMPONENT_NOT_ADMITTED";
}
