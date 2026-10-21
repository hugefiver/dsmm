import { isAbsolute, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision, ToolDefinition, ToolExecution } from "@deepseek-ai/dsh-tools";
import { PermissionRefusal, permissionApprovalAdapter } from "./permission-control.js";
import type { PermissionExecutionIntegrity } from "./permission-control.js";
import { permissionOutcome } from "./permission-errors.js";
import { classifyPermissionShell, parsePermissionShellReadPaths } from "./permission-shell.js";
import type { PermissionShellIdentity } from "./permission-shell.js";
import { intersectPermissionActions } from "./permission-rules.js";
import type { PermissionRuleSnapshot, PermissionRulesRuntimeSync } from "./permission-rules.js";
import type { PermissionRulesStatus } from "./permission-rules.js";
import type { PermissionControlSettings, PermissionRuleAction } from "./permission-settings.js";
import { nativeStandingFullAccess } from "./permission-native-access.js";

export interface NativePermissionFsTarget { readonly targetKey: unknown; readonly displayPath: string }
/** Structural public FS capability; keys are never parsed as paths. */
export interface NativePermissionFileSystem {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<NativePermissionFsTarget>;
  contains(parent: NativePermissionFsTarget, child: NativePermissionFsTarget): boolean;
}
type FileSystem = NativePermissionFileSystem;
type FsTarget = NativePermissionFsTarget;
function unresolvedOutside(policy: PermissionControlSettings): PermissionRuleAction {
  const rules = policy.rules.filter(rule => !rule.revoked && rule.match.kind === "outside-read");
  if (policy.outsideReads === "deny" || rules.some(rule => rule.action === "deny")) return "deny";
  return policy.outsideReads === "inherit" && rules.length === 0 ? "inherit" : "ask";
}

/** Supplied only by the owner of the actual registered definition/native execution context. */
export interface NativePermissionToolIdentity {
  readonly kind: "read" | "glob" | "grep" | "shell" | "webSearch" | "webFetch";
  readonly context: Context;
  readonly signal?: AbortSignal;
  readonly shell?: PermissionShellIdentity;
  /** Live proof FS and direct rg/Shell executor share path and workspace semantics. No name/cwd inference. */
  coLocated?(execution: Readonly<ToolExecution>, fs: FileSystem): boolean;
  assertCurrent(execution: Readonly<ToolExecution>): void;
  assertIntegrity?(execution: Readonly<ToolExecution>): void;
}
interface NativePermissionAuthority {
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
export interface NativePermissionRulesOptions {
  readonly runtime: PermissionRulesRuntimeSync;
  simpleCommandAllowed?(execution: Readonly<ToolExecution>): boolean;
  captureIntegrity?(execution: Readonly<ToolExecution>): PermissionExecutionIntegrity;
  /** Exact registration identity, never trust a matching tool name alone. */
  identify(definition: ToolDefinition, execution: Readonly<ToolExecution>): NativePermissionToolIdentity | undefined;
  /** Capture the invocation's original Core epoch after rule refresh. */
  captureAuthority?(execution: Readonly<ToolExecution>): NativePermissionAuthority;
  /** Pure restriction fallback for standalone consumers without an authority capture. */
  assertCurrent(execution: Readonly<ToolExecution>): void;
  /** Compose this exact registration's native request; never creates an independent approval UI. */
  managedShellDecision?(execution: Readonly<ToolExecution>, action: Exclude<PermissionRuleAction, "deny">, downstream: () => Promise<PreToolDecision>, snapshot: PermissionRuleSnapshot | undefined): Promise<PreToolDecision>;
}
interface NativeBinding {
  readonly definition: ToolDefinition;
  readonly body: ToolDefinition["execute"];
  readonly identity: NativePermissionToolIdentity;
  readonly snapshot?: PermissionRuleSnapshot;
  readonly nativeOnly: boolean;
  readonly args: unknown;
  readonly agent: ToolExecution["agent"];
  readonly name: string;
  readonly callId: ToolExecution["callId"];
  readonly integrity?: PermissionExecutionIntegrity;
  readonly authority?: NativePermissionAuthority;
  readonly signal: AbortSignal;
  readonly approval?: Context["approval"];
  readonly fs?: FileSystem;
  readonly workspaceRoot: string;
  provenCoLocation?: boolean;
}
type RuleBinding = NativeBinding & { readonly snapshot: PermissionRuleSnapshot };
function text(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0 || input.includes("\0")) throw new PermissionRefusal("validation");
  return input;
}
function args(exec: Readonly<ToolExecution>): Record<string, unknown> {
  if (exec.arguments === null || typeof exec.arguments !== "object" || Array.isArray(exec.arguments)) throw new PermissionRefusal("validation");
  return exec.arguments as Record<string, unknown>;
}
/** The public native search tools accept pattern/path/include only; no model-controlled rg flags. */
export function parseNativePermissionReadPaths(kind: "read" | "glob" | "grep", input: unknown): readonly string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new PermissionRefusal("validation");
  const row = input as Record<string, unknown>;
  if (kind === "read") return [text(row.file_path)];
  if (kind === "glob") text(row.pattern);
  else {
    if (typeof row.pattern !== "string" || row.pattern.length === 0) throw new PermissionRefusal("validation");
    if (row.include !== undefined) {
      const include = text(row.include); let depth = 0;
      if (include.startsWith("!")) throw new PermissionRefusal("validation");
      for (const char of include) {
        if (char === "{") depth++;
        else if (char === "}") depth = Math.max(0, depth - 1);
        else if (char === "," && depth === 0) throw new PermissionRefusal("validation");
      }
    }
  }
  return [row.path === undefined ? "." : text(row.path)];
}
/** Tool-call-boundary rules only. No body fence, scoped memory, socket isolation or final-inode guarantee. */
export function registerNativePermissionRules(ctx: Context, options: NativePermissionRulesOptions): () => void {
  if (!options.runtime.status().mounted) return () => {};
  const bindings = new Map<ToolExecution["token"], NativeBinding>();
  const asks = new WeakMap<object, { exec: Readonly<ToolExecution>; binding: NativeBinding }>();
  const lifetime = new AbortController();
  const tools = ctx.tools;
  const checkIntegrity = (exec: Readonly<ToolExecution>, binding: NativeBinding): void => {
    if (exec.signal.aborted || binding.signal.aborted) throw new PermissionRefusal("cancelled");
    if (exec.arguments !== binding.args || exec.agent !== binding.agent || exec.callId !== binding.callId || exec.name !== binding.name
      || tools.get(binding.name, binding.agent) !== binding.definition || binding.definition.execute !== binding.body) throw new PermissionRefusal("stale");
    if (exec.agent !== undefined && ctx.agents.get(exec.agent.id) !== exec.agent) throw new PermissionRefusal("not-owned");
    binding.identity.assertIntegrity?.(exec); binding.integrity?.assertCurrent();
  };
  const check = (exec: Readonly<ToolExecution>, binding: NativeBinding): void => {
    checkIntegrity(exec, binding);
    if (binding.nativeOnly) return;
    if (options.runtime.getPolicy() !== binding.snapshot) throw new PermissionRefusal("stale");
    if (binding.provenCoLocation && (binding.fs === undefined || binding.identity.coLocated?.(exec, binding.fs) !== true)) throw new PermissionRefusal("stale");
    if ((exec.agent?.session.header.cwd ?? "") !== binding.workspaceRoot) throw new PermissionRefusal("stale");
    binding.identity.assertCurrent(exec);
    if (binding.authority === undefined) options.assertCurrent(exec);
    else binding.authority.assertCurrent();
  };
  const outside = async (exec: Readonly<ToolExecution>, binding: RuleBinding, paths: readonly string[], cwd: string, direct: boolean, full = false): Promise<PermissionRuleAction> => {
    if (paths.length === 0) return "inherit";
    const fs = binding.fs;
    const configured = binding.snapshot.policy.outsideReads;
    if (fs === undefined || !isAbsolute(binding.workspaceRoot) || !isAbsolute(cwd) || direct && binding.identity.coLocated?.(exec, fs) !== true) {
      // Unknown backends cannot satisfy inside or a path-specific allow.
      return full ? "inherit" : unresolvedOutside(binding.snapshot.policy);
    }
    if (direct) binding.provenCoLocation = true;
    const root = await fs.resolve(binding.workspaceRoot, { signal: binding.signal }); check(exec, binding);
    const decisions: PermissionRuleAction[] = [];
    for (const path of paths) {
      let target: FsTarget, inside: boolean;
      try { target = await fs.resolve(path, { cwd, signal: binding.signal }); inside = fs.contains(root, target); }
      catch (error) { if (!full) throw error; checkIntegrity(exec, binding); continue; }
      check(exec, binding);
      if (inside) continue;
      const matched: PermissionRuleAction[] = [];
      for (const rule of binding.snapshot.policy.rules) {
        if (rule.revoked || rule.match.kind !== "outside-read") continue;
        let matches: boolean;
        try {
          const ruleTarget = await fs.resolve(rule.match.path, { cwd: binding.workspaceRoot, signal: binding.signal });
          matches = rule.match.scope === "tree" ? fs.contains(ruleTarget, target) : ruleTarget.targetKey === target.targetKey;
        }
        catch (error) { if (!full) throw error; checkIntegrity(exec, binding); continue; }
        check(exec, binding);
        if (matches) {
          if (full && rule.action === "deny") return "deny";
          matched.push(rule.action);
        }
      }
      const action = matched.length === 0 ? configured : intersectPermissionActions(matched);
      if (full && action === "deny") return "deny";
      decisions.push(action);
    }
    return intersectPermissionActions(decisions);
  };
  const evaluate = async (exec: Readonly<ToolExecution>, binding: RuleBinding): Promise<PermissionRuleAction> => {
    const { kind, shell } = binding.identity, policy = binding.snapshot.policy;
    const full = binding.nativeOnly;
    if (kind === "webSearch" || kind === "webFetch") {
      if (!policy[kind].enabled) return "deny";
      const action = intersectPermissionActions([policy[kind].rule, ...policy.rules.filter(rule => !rule.revoked && rule.match.kind === kind).map(rule => rule.action)]);
      return full && action !== "deny" ? "inherit" : action;
    }
    const cwd = binding.workspaceRoot;
    if (full) {
      const row = args(exec), explicitCwd = shell?.cwdField === undefined ? undefined : row[shell.cwdField];
      const workingDirectory = typeof explicitCwd !== "string" ? cwd : isAbsolute(explicitCwd) ? explicitCwd : resolve(cwd, explicitCwd);
      if (kind === "shell" && shell !== undefined && policy.rules.some(rule => !rule.revoked && rule.action === "deny"
        && rule.match.kind === "shell" && rule.match.executable === shell.executable && rule.match.command === row[shell.commandField]
        && rule.match.workingDirectory === workingDirectory)) return "deny";
      if (policy.outsideReads !== "deny" && !policy.rules.some(rule => !rule.revoked && rule.action === "deny" && rule.match.kind === "outside-read")) return "inherit";
      // Unavailable path facts are not an explicit blacklist match in full access.
      const parsed = kind === "shell" ? shell === undefined ? undefined : parsePermissionShellReadPaths(shell, exec.arguments, cwd, exec)
        : { paths: parseNativePermissionReadPaths(kind, exec.arguments), workingDirectory: cwd };
      if (parsed === undefined) return "inherit";
      const action = await outside(exec, binding, parsed.paths, parsed.workingDirectory, kind !== "read", true);
      return action === "deny" ? "deny" : "inherit";
    }
    if (kind !== "shell") return outside(exec, binding, parseNativePermissionReadPaths(kind, exec.arguments), cwd, kind !== "read");
    if (shell === undefined) return policy.rules.some(rule => !rule.revoked && rule.match.kind === "shell" && rule.action === "deny") ? "deny" : "inherit";
    const operation = classifyPermissionShell(shell, exec.arguments, cwd, exec);
    shell.readCapability?.assertCurrent(exec);
    const rules = policy.rules.filter(rule => !rule.revoked && rule.match.kind === "shell" && rule.match.executable === operation.executable
      && rule.match.command === operation.command && rule.match.workingDirectory === operation.workingDirectory).map(rule => rule.action);
    if (operation.effect !== "read") {
      // Unknown reads cannot bypass a configured hard outside-read boundary.
      const hardRead = operation.effect === "unknown" && (policy.outsideReads === "deny" || policy.rules.some(rule => !rule.revoked && rule.match.kind === "outside-read" && rule.action === "deny"));
      return intersectPermissionActions([...rules, ...hardRead ? ["deny" as const] : []]);
    }
    const parsed = parsePermissionShellReadPaths(shell, exec.arguments, cwd, exec);
    const access = parsed === undefined ? unresolvedOutside(policy)
      : await outside(exec, binding, parsed.paths, parsed.workingDirectory, true);
    return intersectPermissionActions([access, ...rules]);
  };
  const unhook = ctx.on("tools/pre-execute", async (exec, next): Promise<PreToolDecision> => {
    if (options.simpleCommandAllowed?.(exec)) return next();
    const definition = tools.get(exec.name, exec.agent);
    if (definition === undefined) return next();
    const identity = options.identify(definition, exec);
    if (identity === undefined) return next();
    const nativeOnly = nativeStandingFullAccess(identity.context, exec.agent);
    let snapshot: PermissionRuleSnapshot | undefined;
    try { snapshot = await options.runtime.refresh(); }
    catch (error) { if (!nativeOnly) throw error; }
    const authority = nativeOnly ? undefined : options.captureAuthority?.(exec);
    const integrity = options.captureIntegrity?.(exec);
    const binding: NativeBinding = { definition, body: definition.execute, identity, snapshot, nativeOnly, authority, integrity,
      args: exec.arguments, agent: exec.agent, name: exec.name, callId: exec.callId,
      signal: AbortSignal.any([exec.signal, lifetime.signal, ...identity.signal === undefined ? [] : [identity.signal], ...integrity?.signal === undefined ? [] : [integrity.signal]]), approval: ctx.get("approval"), fs: identity.context.get("fs") as FileSystem | undefined,
      workspaceRoot: exec.agent?.session.header.cwd ?? "" };
    bindings.set(exec.token, binding); check(exec, binding);
    let action: PermissionRuleAction = "inherit";
    if (snapshot !== undefined) {
      try { action = await evaluate(exec, binding as RuleBinding); }
      catch (error) { if (!nativeOnly) throw error; checkIntegrity(exec, binding); }
    }
    check(exec, binding);
    if (action === "deny") return { kind: "deny", reason: "DSMM native permission rule denied this tool call." };
    if (identity.kind === "shell" && options.managedShellDecision !== undefined) return options.managedShellDecision(exec, action, next, snapshot);
    const downstream = await next();
    if (exec.signal.aborted) return { kind: "cancel" };
    checkIntegrity(exec, binding);
    if (downstream.kind === "deny" || downstream.kind === "cancel") return downstream;
    if (nativeOnly) {
      if (downstream.kind !== "ask") return downstream;
      const displayReason = downstream.displayReason ?? Object.freeze({ en: downstream.reason ?? "" });
      asks.set(displayReason, { exec, binding });
      return { ...downstream, displayReason };
    }
    if (action === "ask") {
      const reason = `DSMM exact tool-call rule: ${exec.name} ${JSON.stringify(args(exec))}`;
      const combined = [downstream.kind === "ask" ? downstream.reason : undefined, reason].filter(Boolean).join("\n");
      const displayReason = Object.freeze({ en: combined, ...downstream.kind === "ask" && downstream.displayReason !== undefined ? Object.fromEntries(Object.entries(downstream.displayReason).map(([locale, text]) => [locale, `${text}\n${reason}`])) : {} });
      asks.set(displayReason, { exec, binding });
      return { kind: "ask", reason: combined, displayReason };
    }
    return downstream;
  }, { prepend: true, global: true });
  const unapproval = ctx.on("approval/request", permissionApprovalAdapter(ctx, async (request, next) => {
    const ask = request.displayReason === undefined ? undefined : asks.get(request.displayReason);
    if (ask === undefined || request.agent !== ask.exec.agent || request.signal !== ask.exec.signal || request.callId !== ask.exec.callId || request.toolName !== ask.exec.name) return next();
    checkIntegrity(ask.exec, ask.binding);
    return permissionOutcome(next, ask.binding.signal, "cancelled");
  }), { prepend: true, global: true });
  const unguard = tools.guard(exec => {
    const binding = bindings.get(exec.token); if (binding === undefined) return undefined;
    try { checkIntegrity(exec, binding); return undefined; } catch { return "Native tool execution identity is no longer current."; }
  });
  const unresult = ctx.on("tools/result", exec => { bindings.delete(exec.token); }, { global: true });
  const dispose = (): void => { lifetime.abort(); unhook(); unguard(); unresult(); unapproval(); bindings.clear(); };
  return ctx.effect(() => dispose);
}

export interface NativePermissionCapabilities {
  readonly outsideReads: "tool-call-boundary";
  readonly finalInode: false;
  readonly scopedMemory: "not-provided-by-native-rules";
  readonly webFetch: "native-public-only";
  readonly webSearchDestinations: "unsupported";
  readonly proxyAddressBinding: "native-proxy-dependent";
  readonly shellSockets: "native-executor-dependent";
  readonly providerAuthMcp: "not-covered";
}
export const NATIVE_PERMISSION_CAPABILITIES: NativePermissionCapabilities = Object.freeze({ outsideReads: "tool-call-boundary", finalInode: false,
  scopedMemory: "not-provided-by-native-rules", webFetch: "native-public-only", webSearchDestinations: "unsupported", proxyAddressBinding: "native-proxy-dependent",
  shellSockets: "native-executor-dependent", providerAuthMcp: "not-covered" });

export interface NativePermissionCapabilityView {
  readonly limits: NativePermissionCapabilities;
  readonly runtime: PermissionRulesStatus;
  /** Registry presence, not executor readiness, network reachability or final-body ownership. */
  readonly tools: readonly { readonly name: string; readonly kind: NativePermissionToolIdentity["kind"]; readonly approval: "native-once"; readonly scopedMemory: false }[];
}
