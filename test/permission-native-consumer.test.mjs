import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, watch } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";

// Native subprocess spill storage belongs to the process, not an individual Context.
const ownedDirectories = [];
after(async () => {
  for (const { directory, parent } of ownedDirectories) {
    const exact = await realpath(directory);
    assert.equal(exact, directory); assert.equal(dirname(exact), parent);
    await rm(exact, { recursive: true, force: false });
  }
});

async function waitForOwnedFile(path) {
  const events = watch(dirname(path), { signal: AbortSignal.timeout(5000) });
  try {
    if (existsSync(path)) return;
    for await (const event of events) if (event.filename === basename(path)) return;
  } finally { await events.return(); }
}

test("product native consumer applies exact once modes, single SDK/A gates and direct-file refresh through Windows executor/Jobs", {
  skip: process.platform !== "win32" || !process.env.DSMM_TEST_DSH_ENTRY, timeout: 120000,
}, async () => {
  const { createRequire } = await import("node:module"), { pathToFileURL } = await import("node:url");
  const requireSdk = createRequire(process.env.DSMM_TEST_DSH_ENTRY);
  const sdk = name => import(pathToFileURL(requireSdk.resolve(`@deepseek-ai/${name}`)).href);
  const { Context } = await sdk("cordis"), { AgentRegistry } = await sdk("dsh-agent"), { AgentLoop } = await sdk("dsh-agent-loop");
  const { SessionStore, SessionId } = await sdk("dsh-session"), { SessionProjectionRegistry } = await sdk("dsh-session-projection");
  const { LlmRuntime, ToolCallId } = await sdk("dsh-llm"), { SystemPrompt } = await sdk("dsh-system-prompt"), { ToolRuntime } = await sdk("dsh-tools");
  const { ApprovalService, setApprovalPolicy } = await sdk("dsh-user-approval"), { SandboxPolicyService, setSandboxMode } = await sdk("dsh-sandbox-policy");
  const { LocalSandboxProvider } = await sdk("dsh-sandbox-local"), { LocalSubprocessRuntime } = await sdk("dsh-subprocess-local");
  const { SandboxPwshExecutor } = await sdk("dsh-pwsh-sandbox"), { LocalJobRegistry } = await sdk("dsh-jobs-local"), ShellEnv = await sdk("dsh-shell-env");
  const ToolJobs = await sdk("dsh-tool-jobs");
  const Native = await sdk("dsh-tool-pwsh");
  const { LocalFileSystem } = await sdk("dsh-fs-local"), WorkingDirectory = await sdk("dsh-working-directory");
  const { installPermissionController } = await import("../src/permission-controller.ts");
  const { installDeploymentPermissionRules } = await import("../src/deployment-permission-rules.ts");
  const { DsmmDeploymentConfig } = await import("../src/deployment-config.ts");
  const { DSMM_NATIVE_CONFIG_SCHEMA } = await import("../src/settings.ts");
  const { permissionHostProfile } = await import("./permission-host-fixture.ts");
  const { Loader } = await sdk("cordis-plugin-loader"), { ConfigEditor } = await sdk("dsh-config-editor"), { SettingsForms } = await sdk("dsh-settings");
  const { mountRootInclude, readProfilePatches } = await sdk("dsh-app-boot");
  const parent = await realpath(tmpdir()), owned = await mkdtemp(join(parent, "dsmm-product-permission-"));
  ownedDirectories.push({ directory: owned, parent });
  const workspace = join(owned, "workspace"), outside = join(owned, "outside"), home = join(owned, "home");
  const values = { DSH_HOME: home, TEMP: join(owned, "tmp"), TMP: join(owned, "tmp"), GOCACHE: join(owned, "go-cache"), GOTMPDIR: join(owned, "go-tmp"), GOPATH: join(owned, "gopath"), GOPROXY: "off", GOTOOLCHAIN: "local", GOENV: "off", GOWORK: "off" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const ctx = new Context(), lifetime = new AbortController(), facts = new WeakMap(), records = [], jobEvents = [];
  let handle, controller, interactions = 0, outcome = "allowed-once", askGate, downstreamAsk = false, entries = [], enabled = false;
  const goCommand = "go test -count=1 .", marker = join(outside, "go-marker.txt");
  const configPath = join(home, "plugins", "dsmm", "config.json");
  const commandEntry = (mode, args = ["-count=1", "."]) => ({ id: "owned-go", mode, match: { tool: "pwsh", executable: "go", subcommand: "test", args, workingDirectory: workspace }, sandboxMode: "danger-full-access" });
  const saveFile = async (nativeCommands = { enabled, entries }, extra = {}) => writeFile(configPath, JSON.stringify({ permissionControl: { nativeCommands, ...extra } }));
  try {
    for (const dir of new Set([workspace, outside, home, ...Object.values(values).filter(value => value.startsWith(owned))])) await mkdir(dir, { recursive: true });
    await mkdir(dirname(configPath), { recursive: true }); Object.assign(process.env, values);
    // Existing toolchain only; no download or project dependencies.
    const goVersion = execFileSync("go", ["version"], { encoding: "utf8" }).match(/go(\d+\.\d+)/)?.[1]; assert.ok(goVersion);
    await writeFile(join(workspace, "go.mod"), `module owned.invalid/permission\n\ngo ${goVersion}\n`);
    await writeFile(join(workspace, "owned_test.go"), `package owned\nimport("testing";"os";"fmt")\nfunc TestOwned(t *testing.T){if e:=os.WriteFile("../outside/go-marker.txt",[]byte("owned"),0600);e!=nil{t.Fatal(e)};fmt.Println("OWNED_NATIVE_GO") }\n`);
    await saveFile();
    for (const [plugin, config] of [[AgentRegistry], [SessionStore], [SessionProjectionRegistry], [LlmRuntime], [SystemPrompt, {}], [ToolRuntime, { mode: "native" }], [ApprovalService, { policy: "ask" }], [SandboxPolicyService, { mode: "workspace-write", workspaceRoot: workspace }], [LocalSubprocessRuntime], [LocalSandboxProvider, {}], [SandboxPwshExecutor, { cwd: workspace, timeoutMs: 30000, maxTimeoutMs: 90000, maxOutputBytes: 4096, graceMs: 200 }], [LocalJobRegistry, { pumpPollMs: 20 }], [ShellEnv, { dshHome: home }], [ToolJobs, {}], [AgentLoop, {}]]) await ctx.plugin(plugin, config).await();
    await ctx.plugin(LocalFileSystem, { cwd: workspace }).await();
    await ctx.plugin(WorkingDirectory.default, { defaultDirectory: workspace }).await();
    const profile = permissionHostProfile(owned, home, {});
    ctx.provide("profileContext", profile);
    await ctx.plugin(Loader).await();
    let deployment;
    // This native-consumer unit Host supplies execution facts, not Core admission.
    // Its policy source still belongs to a real Include entry and current native form.
    const unitHost = { name: "permission-native-consumer-unit-host", Config: DSMM_NATIVE_CONFIG_SCHEMA,
      apply(scope, config) { deployment = new DsmmDeploymentConfig(scope, config); } };
    ctx.loader.builtins["permission-fixture-core"] = { default: unitHost };
    assert.ok(await mountRootInclude(ctx, join(owned, "cordis.json"), readProfilePatches("dsh", profile)));
    await ctx.loader.await();
    const entry = ctx.loader.resolve("include:permission-core");
    await entry.fiber.await(); assert.equal(entry.fiber.state, 2);
    await ctx.plugin(ConfigEditor).await(); await ctx.plugin(SettingsForms).await();
    assert.ok(ctx.settings.describe().some(row => row.ns === entry.options.id));
    assert.equal(deployment.nativeEntry, entry);
    const backend = installDeploymentPermissionRules(ctx, { deployment, assertWritable() {}, revoke: () => controller?.permissions.revokePolicy(), notify: async () => { assert.ok(controller); } });
    controller = installPermissionController(ctx, { rules: backend.runtime, authority: {
      current(exec) { const current = facts.get(exec.agent); assert.ok(current); return current; },
      assertCurrent(authority, exec) { assert.equal(authority.agent, exec.agent); lifetime.signal.throwIfAborted(); },
    }, shellIdentity(_scope, kind) { return { executable: `unresolved-native-${kind}`, dialect: kind === "pwsh" ? "powershell" : "posix", commandField: "command", cwdField: "workdir" }; } });
    ctx.on("tools/execute", async (exec, next) => { records.push(exec); return next(); }, { global: true });
    ctx.on("tools/pre-execute", async (exec, next) => { const decision = await next(); return downstreamAsk && exec.name === "pwsh" ? { kind: "ask", reason: "Native same-call required approval" } : decision; }, { global: true });
    ctx.on("approval/request", async request => { interactions++; assert.equal(request.agent, handle.agent); if (askGate) await askGate(request); return outcome; }, { global: true });
    ctx.jobs.events.subscribe({ owners: "all" }, event => jobEvents.push(event));
    const nativeScope = controller.shellScope(ctx, "pwsh"), nativeTools = nativeScope.tools;
    let bodies = 0;
    // Observe original Native.apply body entry without changing its arguments, executor or output.
    const tools = { register(definition) { return nativeTools.register({ ...definition, execute(args, exec) { bodies++; return Reflect.apply(definition.execute, definition, [args, exec]); } }); } };
    const nativeFiber = ctx.plugin({ name: "owned-product-native", inject: Native.inject, apply(scope) { Native.apply(nativeScope.extend({ tools }), { enableRunInBackground: true, promoteOnTimeout: true }); } }); await nativeFiber.await();
    assert.equal(nativeFiber.state, 2); assert.ok(ctx.tools.get("pwsh"));
    handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: workspace }, agentOptions: { provider: "unused-local", model: "unused-local" } });
    const agent = handle.agent; facts.set(agent, { agent, root: agent, realm: agent.ctx, owner: ctx, ownerGeneration: 1, admissionRevision: "owned", permissionRevision: "owned", signal: lifetime.signal }); agent.session.append("turn/start", { turn: 1 });
    const call = (command = goCommand, extra = {}, signal = new AbortController().signal, callId = ToolCallId(randomUUID())) => ctx.tools.execute({ name: "pwsh", arguments: { command, description: "Execute one owned native fixture", workdir: workspace, timeoutMs: 90000, ...extra }, agent, signal, callId });
    const asks = () => agent.session.snapshotEvents().filter(event => event.type === "approval/asked").length;
    const beforeOff = bodies, off = await call(); assert.equal(bodies, beforeOff + 1); assert.equal(existsSync(marker), false); assert.equal(interactions, 0); assert.notEqual(off.value?.exitCode, 0);
    enabled = true; entries = [commandEntry("allow")]; await saveFile();
    const granted = await call(); assert.equal(granted.isError, false, JSON.stringify(granted)); assert.equal(granted.value.exitCode, 0, JSON.stringify(granted)); assert.equal(await readFile(marker, "utf8"), "owned"); assert.equal(interactions, 0); assert.equal(asks(), 1);
    assert.equal(ctx.sandboxPolicy.resolve({ session: agent.session }).mode, "workspace-write"); await rm(marker);
    entries = [commandEntry("ask")]; await saveFile();
    const rejectedBody = bodies; outcome = "rejected"; assert.equal((await call()).isError, true); assert.equal(bodies, rejectedBody); assert.equal(existsSync(marker), false);
    for (const value of ["cancelled", "unavailable"]) { outcome = value; assert.equal((await call()).isError, true); assert.equal(bodies, rejectedBody); }
    setApprovalPolicy(agent.session, "never"); const beforeNever = interactions; assert.equal((await call()).isError, true); assert.equal(interactions, beforeNever); assert.equal(bodies, rejectedBody); setApprovalPolicy(agent.session, "ask"); outcome = "allowed-once";
    downstreamAsk = true; const sdkAsks = asks(), sdkInteractions = interactions;
    const combined = await call(); assert.equal(combined.value.exitCode, 0, JSON.stringify(combined)); assert.equal(asks(), sdkAsks + 1); assert.equal(interactions, sdkInteractions + 1); await rm(marker);
    const runtimeSdk = createRequire(requireSdk.resolve("@deepseek-ai/dsh-sdk-minimal/package.json"));
    const { NodePtcRuntime } = await import(pathToFileURL(runtimeSdk.resolve("@deepseek-ai/dsh-ptc-runtime-node")).href);
    const leafArgs = { command: goCommand, description: "Execute one owned native fixture", workdir: workspace, timeoutMs: 90000 };
    const program = `return await tools.pwsh(${JSON.stringify(leafArgs)});`;
    await ctx.plugin(NodePtcRuntime, { timeoutMs: 90000, maxTimeoutMs: 90000 }).await();
    const ptcCall = () => ctx.tools.execute({ name: "run_code", arguments: { code: program, description: "Execute an owned native Go leaf" }, agent, callId: ToolCallId(randomUUID()), signal: new AbortController().signal });
    const ptcAsks = asks(), ptcInteractions = interactions, ptcBodies = bodies;
    const restoreNativePresentation = agent.ctx.tools.presentAs("ptc");
    try {
      const ptc = await ptcCall(); assert.equal(ptc.isError, false, JSON.stringify(ptc)); assert.equal(await readFile(marker, "utf8"), "owned"); assert.equal(bodies, ptcBodies + 1); assert.equal(asks(), ptcAsks + 1); assert.equal(interactions, ptcInteractions + 1); await rm(marker);
      outcome = "rejected"; assert.equal((await ptcCall()).isError, true); assert.equal(bodies, ptcBodies + 1); assert.equal(existsSync(marker), false); outcome = "allowed-once";
    } finally { restoreNativePresentation(); }
    const officialAsks = asks(), officialInteractions = interactions;
    const official = await call(goCommand, { sandbox_permissions: "danger-full-access", justification: "Owned Go test needs actual external cache and marker writes" });
    assert.equal(official.value.exitCode, 0, JSON.stringify(official)); assert.equal(asks(), officialAsks + 1); assert.equal(interactions, officialInteractions + 1); await rm(marker); downstreamAsk = false;
    setSandboxMode(agent.session, "read-only"); assert.equal((await call()).value.exitCode, 0); await rm(marker); setSandboxMode(agent.session, "workspace-write");
    const barrier = Promise.withResolvers(), seen = []; askGate = async request => { seen.push(request); if (seen.length === 2) barrier.resolve(); await barrier.promise; };
    const id = ToolCallId(randomUUID()), signal = new AbortController().signal, concurrent = await Promise.all([call(goCommand, {}, signal, id), call(goCommand, {}, signal, id)]);
    assert.ok(concurrent.every(result => result.value?.exitCode === 0), JSON.stringify(concurrent)); assert.equal(seen.length, 2); assert.notEqual(records.at(-1).token, records.at(-2).token); askGate = undefined; await rm(marker);
    const pending = Promise.withResolvers(), release = Promise.withResolvers(), abort = new AbortController(); askGate = async () => { pending.resolve(); await release.promise; };
    const waiting = call(goCommand, {}, abort.signal); await pending.promise; const waitingBodies = bodies; abort.abort(); assert.equal((await waiting).isError, true); assert.equal(bodies, waitingBodies); release.resolve(); askGate = undefined;
    // Next actual call sees narrowing, removal, disabled enhancement and malformed sources.
    entries = [commandEntry("allow", ["-count=2", "."])]; await saveFile(); const narrowed = await call(); assert.notEqual(narrowed.value?.exitCode, 0); assert.equal(existsSync(marker), false);
    await saveFile({ enabled: true, entries: [] }); assert.notEqual((await call()).value?.exitCode, 0);
    await saveFile({ enabled: false, entries: [commandEntry("allow")] }); assert.notEqual((await call()).value?.exitCode, 0);
    await writeFile(configPath, "not-json"); const invalidBodies = bodies; assert.equal((await call()).isError, true); assert.equal(bodies, invalidBodies);
    entries = [commandEntry("allow")]; await saveFile(); assert.equal((await call()).value.exitCode, 0); await rm(marker);
    await saveFile({ enabled: true, entries }, { rules: [{ id: "deny", action: "deny", match: { kind: "shell", executable: "unresolved-native-pwsh", command: goCommand, workingDirectory: workspace }, source: { kind: "user-import", label: "owned" }, revision: 1, revoked: false }] });
    const deniedBodies = bodies; assert.equal((await call()).isError, true); assert.equal(bodies, deniedBodies); assert.equal(existsSync(marker), false);
    await saveFile({ enabled: true, entries: [{ id: "background", mode: "allow", sandboxMode: "danger-full-access", match: { tool: "pwsh", executable: "Write-Output", args: ["owned-background"], workingDirectory: workspace } }] });
    const background = await call("Write-Output owned-background", { run_in_background: true }); assert.equal(background.isError, false, JSON.stringify(background)); assert.equal(background.value.kind, "background");
    assert.equal((await ctx.jobs.wait(background.value.jobId, 10000, agent.id)).status, "completed"); const output = ctx.jobs.readAt(background.value.jobId, 0, agent.id); assert.ok(output.chunks.some(chunk => chunk.text.includes("owned-background"))); ctx.jobs.remove(background.value.jobId, agent.id);
    assert.equal(ctx.jobs.list(agent.id).length, 0); assert.ok(jobEvents.length > 0);
    const baseSdk = createRequire(requireSdk.resolve("@deepseek-ai/dsh-base/package.json"));
    const { WebRuntime } = await import(pathToFileURL(baseSdk.resolve("@deepseek-ai/dsh-web")).href);
    const { HttpFetchProvider, Config: fetchConfig } = await import(pathToFileURL(baseSdk.resolve("@deepseek-ai/dsh-web-fetch-http")).href);
    const ManagedWeb = await import("../src/permission-web.ts");
    let providerCalls = 0, requests = 0, providerError;
    class ObservedHttpFetch extends HttpFetchProvider {
      async fetch(request, signal) {
        providerCalls++;
        try { return await super.fetch(request, signal); }
        catch (error) { providerError = error.code; throw error; }
      }
    }
    const server = createServer((_request, response) => { requests++; response.end("owned-private-response"); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      await ctx.plugin(WebRuntime, { fetchProvider: "http" }).await();
      ctx.web.registerFetchProvider(new ObservedHttpFetch(fetchConfig({})));
      await ctx.plugin(ManagedWeb, { search: false, fetch: true }).await();
      assert.ok(controller.toolCoverage(agent).some(tool => tool.kind === "webFetch"));
      const fetch = () => ctx.tools.execute({ name: "web_fetch", arguments: { url: `http://127.0.0.1:${server.address().port}/owned` }, agent, callId: ToolCallId(randomUUID()), signal: new AbortController().signal });
      await saveFile({ enabled: false, entries: [] }, { webFetch: { enabled: false, rule: "inherit" } });
      assert.equal((await fetch()).isError, true); assert.equal(providerCalls, 0);
      await saveFile({ enabled: false, entries: [] }, { webFetch: { enabled: true, rule: "inherit" } });
      assert.equal((await fetch()).isError, true); assert.equal(providerCalls, 1);
      assert.equal(providerError, "WEB_BLOCKED_URL"); assert.equal(requests, 0);
    } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  } finally {
    lifetime.abort(); await handle?.dispose(); await ctx.fiber.dispose();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("native same-level purpose, cancellation, timeout and spill reach the original Windows executor and Jobs", {
  skip: process.platform !== "win32" || !process.env.DSMM_TEST_DSH_ENTRY, timeout: 30000,
}, async () => {
  const { createRequire } = await import("node:module"), { pathToFileURL } = await import("node:url");
  const requireSdk = createRequire(process.env.DSMM_TEST_DSH_ENTRY), sdk = name => import(pathToFileURL(requireSdk.resolve(`@deepseek-ai/${name}`)).href);
  const { Context } = await sdk("cordis"), { AgentRegistry } = await sdk("dsh-agent"), { AgentLoop } = await sdk("dsh-agent-loop");
  const { SessionStore, SessionId } = await sdk("dsh-session"), { SessionProjectionRegistry } = await sdk("dsh-session-projection");
  const { LlmRuntime, ToolCallId } = await sdk("dsh-llm"), { SystemPrompt } = await sdk("dsh-system-prompt"), { ToolRuntime } = await sdk("dsh-tools");
  const { ApprovalService, setApprovalPolicy } = await sdk("dsh-user-approval"), { SandboxPolicyService } = await sdk("dsh-sandbox-policy");
  const { LocalSandboxProvider } = await sdk("dsh-sandbox-local"), { LocalSubprocessRuntime } = await sdk("dsh-subprocess-local");
  const { SandboxPwshExecutor } = await sdk("dsh-pwsh-sandbox"), { LocalJobRegistry } = await sdk("dsh-jobs-local"), ShellEnv = await sdk("dsh-shell-env"), Native = await sdk("dsh-tool-pwsh");
  const { LocalFileSystem } = await sdk("dsh-fs-local"), WorkingDirectory = await sdk("dsh-working-directory");
  const { installPermissionController } = await import("../src/permission-controller.ts"), { PermissionRulesRuntimeSync, importPermissionRules } = await import("../src/permission-rules.ts"), { resolvePermissionControl } = await import("../src/permission-settings.ts");
  const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
  const parent = await realpath(tmpdir()), owned = await mkdtemp(join(parent, "dsmm-native-boundary-"));
  ownedDirectories.push({ directory: owned, parent });
  const workspace = join(owned, "workspace"), home = join(owned, "home"), temporary = join(owned, "tmp");
  const previous = { DSH_HOME: process.env.DSH_HOME, TEMP: process.env.TEMP, TMP: process.env.TMP };
  const ctx = new Context(), lifetime = new AbortController(), facts = new WeakMap();
  let handle, controller, bodies = 0, interactions = 0, launches = 0, outcome = "allowed-once", answer, around;
  let executionReady;
  const raw = "Write-Output owned", identity = "unresolved-native-pwsh";
  const policy = value => resolvePermissionControl(value);
  try {
    await mkdir(workspace); await mkdir(home); await mkdir(temporary); Object.assign(process.env, { DSH_HOME: home, TEMP: temporary, TMP: temporary });
    for (const [plugin, config] of [[AgentRegistry], [SessionStore], [SessionProjectionRegistry], [LlmRuntime], [SystemPrompt, {}], [ToolRuntime, { mode: "native" }], [ApprovalService, { policy: "ask" }], [SandboxPolicyService, { mode: "workspace-write", workspaceRoot: workspace }], [LocalSubprocessRuntime], [LocalSandboxProvider, {}], [SandboxPwshExecutor, { cwd: workspace, timeoutMs: 10000, maxTimeoutMs: 10000, maxOutputBytes: 1024, graceMs: 200 }], [LocalJobRegistry, { pumpPollMs: 20 }], [ShellEnv, { dshHome: home }], [AgentLoop, {}]]) await ctx.plugin(plugin, config).await();
    await ctx.plugin(LocalFileSystem, { cwd: workspace }).await();
    await ctx.plugin(WorkingDirectory.default, { defaultDirectory: workspace }).await();
    const rules = importPermissionRules([{ id: "owned-purpose", action: "ask", match: { kind: "shell", executable: identity, command: raw, workingDirectory: workspace } }], "owned configuration", 1);
    const runtime = new PermissionRulesRuntimeSync({ revision: "owned-initial", policy: policy({ rules }) }, () => controller?.permissions.revokePolicy());
    controller = installPermissionController(ctx, { rules: runtime, authority: {
      current(exec) { const value = facts.get(exec.agent); assert.ok(value); return value; },
      assertCurrent() { lifetime.signal.throwIfAborted(); },
    }, shellIdentity() { return { executable: identity, dialect: "powershell", commandField: "command", cwdField: "workdir" }; } });
    ctx.on("approval/request", async request => { interactions++; return answer === undefined ? outcome : answer(request); }, { global: true });
    ctx.on("tools/execute", async (exec, next) => { if (around !== undefined) exec.signal = around.signal; return next(); }, { global: true });
    const scope = controller.shellScope(ctx, "pwsh"), originalShell = scope.shell, originalTools = scope.tools;
    const shell = new Proxy(originalShell, { get(_target, key) {
      if (key === "execute") return async spec => { const value = await Reflect.apply(originalShell.execute, originalShell, [spec]); launches++; executionReady?.resolve(spec.signal); return value; };
      const value = Reflect.get(originalShell, key, originalShell); return typeof value === "function" ? value.bind(originalShell) : value;
    } });
    const tools = { register(definition) { return originalTools.register({ ...definition, execute(args, exec) { bodies++; return Reflect.apply(definition.execute, definition, [args, exec]); } }); } };
    const nativeFiber = ctx.plugin({ name: "owned-native-boundary", inject: Native.inject, apply() { Native.apply(scope.extend({ shell, tools }), { enableRunInBackground: false, promoteOnTimeout: false }); } });
    await nativeFiber.await(); assert.equal(nativeFiber.state, 2); assert.ok(ctx.tools.get("pwsh"));
    handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: workspace }, agentOptions: { provider: "unused-local", model: "unused-local" } });
    const agent = handle.agent; facts.set(agent, { agent, root: agent, realm: agent.ctx, owner: ctx, ownerGeneration: 1, admissionRevision: "owned", permissionRevision: "owned", signal: lifetime.signal }); agent.session.append("turn/start", { turn: 1 });
    const call = (command = raw, extra = {}) => ctx.tools.execute({ name: "pwsh", arguments: { command, description: "Owned native boundary", workdir: workspace, ...extra }, callId: ToolCallId(randomUUID()), signal: new AbortController().signal, agent });
    const update = async value => { const ticket = runtime.begin(runtime.status().savedRevision); await runtime.commit(ticket, { revision: randomUUID(), policy: policy(value) }, async () => {}); };
    const explicit = { sandbox_permissions: "workspace-write", justification: "Use the current native workspace policy" };
    outcome = "rejected"; assert.equal((await call(raw, explicit)).isError, true); assert.equal(interactions, 1); assert.equal(bodies, 0); assert.equal(launches, 0);
    setApprovalPolicy(agent.session, "never"); assert.equal((await call(raw, explicit)).isError, true); assert.equal(interactions, 1); assert.equal(bodies, 0); setApprovalPolicy(agent.session, "ask");
    outcome = "allowed-once"; assert.equal((await call(raw, explicit)).isError, false); assert.equal(interactions, 2); assert.equal(launches, 1); assert.equal(ctx.sandboxPolicy.resolve({ session: agent.session }).mode, "workspace-write");
    await update({ nativeCommands: { enabled: true, entries: [{ id: "owned", mode: "ask", sandboxMode: "danger-full-access", match: { tool: "pwsh", executable: "Write-Output", args: ["owned"], workingDirectory: workspace } }] } });
    const requestReady = deferred(), release = deferred(); around = new AbortController();
    answer = async request => { requestReady.resolve(request); await release.promise; return "allowed-once"; };
    const waiting = call();
    try {
      const request = await requestReady.promise; assert.equal(request.signal.aborted, false); around.abort(); assert.equal(request.signal.aborted, true);
      assert.equal(bodies, 1); assert.equal(launches, 1); assert.equal((await waiting).isError, true);
    } finally { release.resolve(); await waiting; answer = undefined; around = undefined; }
    await update({}); around = new AbortController(); executionReady = deferred();
    const running = call("Start-Sleep -Seconds 20");
    try {
      const signal = await executionReady.promise; assert.equal(signal.aborted, false);
      const aborted = new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); around.abort();
      let timer;
      try { await Promise.race([aborted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Native executor signal did not cancel")), 5000); timer.unref(); })]); }
      finally { clearTimeout(timer); }
      assert.equal(signal.aborted, true); assert.equal((await running).isError, true); assert.equal(launches, 2); assert.equal(interactions, 3);
      assert.equal(ctx.jobs.list(agent.id).length, 0);
    } finally { for (const job of ctx.jobs.list(agent.id)) ctx.jobs.kill(job.id, agent.id, "Owned fixture cleanup"); await running; }
    const childScript = join(workspace, "owned-child.cjs"), childStarted = join(workspace, "child-started.json");
    await writeFile(childScript, `require('node:fs').writeFileSync(${JSON.stringify(childStarted)}, JSON.stringify({ pid: process.pid })); setTimeout(() => {}, 20000);`);
    const childReady = waitForOwnedFile(childStarted);
    around = new AbortController();
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const childRunning = call(`& ${quote(process.execPath)} ${quote(childScript)}`);
    let childPid, childStart;
    const currentChildStart = () => execFileSync("pwsh", ["-NoProfile", "-Command", `$p = Get-Process -Id ${childPid} -ErrorAction SilentlyContinue; if ($null -eq $p) { exit 0 }; $p.StartTime.ToUniversalTime().Ticks`], { encoding: "utf8" }).trim();
    try {
      await childReady;
      childPid = JSON.parse(await readFile(childStarted, "utf8")).pid;
      assert.ok(Number.isSafeInteger(childPid) && childPid > 0); childStart = currentChildStart(); assert.match(childStart, /^\d+$/u);
      around.abort(); assert.equal((await childRunning).isError, true);
      assert.notEqual(currentChildStart(), childStart); assert.equal(ctx.jobs.list(agent.id).length, 0);
    } finally {
      around.abort(); await childRunning;
      if (childStart !== undefined) execFileSync("pwsh", ["-NoProfile", "-Command", `$p = Get-Process -Id ${childPid} -ErrorAction SilentlyContinue; if ($null -eq $p) { exit 0 }; if ($p.StartTime.ToUniversalTime().Ticks -eq ${childStart}) { Stop-Process -Id ${childPid} -Force -ErrorAction Stop }`]);
    }
    around = undefined; executionReady = undefined;
    const timed = await call("Start-Sleep -Seconds 20", { timeoutMs: 200 });
    assert.equal(timed.value?.timedOut, true, JSON.stringify(timed));
    assert.equal(ctx.jobs.list(agent.id).length, 0);
    const spilled = await call("'owned-native-output-' * 2048");
    assert.equal(spilled.value?.exitCode, 0, JSON.stringify(spilled));
    assert.equal(spilled.value.stdout.truncated, true);
    const spillPath = await realpath(spilled.value.stdout.spillPath);
    assert.ok(ownedDirectories.some(({ directory }) => spillPath.startsWith(`${directory}\\`)));
    assert.equal((await readFile(spillPath, "utf8")).trim(), "owned-native-output-".repeat(2048));
    assert.equal(interactions, 3); assert.equal(ctx.jobs.list(agent.id).length, 0);
  } finally {
    lifetime.abort(); await handle?.dispose(); await ctx.fiber.dispose();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
