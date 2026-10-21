import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const packageRequire = createRequire(new URL("../package.json", import.meta.url));
const anchor = process.env.DSMM_TEST_DSH_ENTRY ?? process.env.DSMM_COLD_PROFILE_SDK_ANCHOR;
assert.ok(anchor, "Set DSMM_TEST_DSH_ENTRY to the installed full DSH SDK package.json (no install is performed)");
const native = createRequire(anchor);
const root = await mkdtemp(join(tmpdir(), "dsmm-native-runtime-bundle-"));
const originalEnv = process.env;
const env = {};
for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
  if (originalEnv[key] !== undefined) env[key] = originalEnv[key];
}
for (const [key, directory] of Object.entries({ HOME: "user", USERPROFILE: "user", DSH_HOME: "dsh", DSH_AGENTS_HOME: "agents",
  XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_STATE_HOME: "state", XDG_CACHE_HOME: "cache",
  APPDATA: "appdata", LOCALAPPDATA: "localappdata", TEMP: "tmp", TMP: "tmp", TMPDIR: "tmp" })) {
  env[key] = join(root, directory); await mkdir(env[key], { recursive: true });
}
process.env = { ...env, DSH_TELEMETRY_MODE: "DISABLED", DSH_TELEMETRY_DISABLED: "1", NO_COLOR: "1" };

// Optional in-memory source checks keep the actual package manifest/exports and
// public Loader resolution. Normal suite execution consumes the built package.
const libUrl = new URL("../lib/", import.meta.url).href;
const sourceUrl = new URL("../src/", import.meta.url).href;
const ts = originalEnv.DSMM_NATIVE_RUNTIME_SOURCE === "1" ? packageRequire("typescript") : undefined;
let resolvingPeer = false;
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (!resolvingPeer && specifier.startsWith("@deepseek-ai/")) {
      resolvingPeer = true;
      try { return { url: pathToFileURL(native.resolve(specifier)).href, shortCircuit: true }; }
      finally { resolvingPeer = false; }
    }
    if (ts && context.parentURL && specifier.startsWith(".")) {
      const url = new URL(specifier, context.parentURL).href;
      if (url.startsWith(libUrl) && url.endsWith(".js") && existsSync(fileURLToPath(sourceUrl + url.slice(libUrl.length, -3) + ".ts"))) {
        return { url, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (ts && url.startsWith(libUrl) && url.endsWith(".js")) {
      const source = sourceUrl + url.slice(libUrl.length, -3) + ".ts";
      if (existsSync(fileURLToPath(source))) return { format: "module", source: ts.transpileModule(readFileSync(fileURLToPath(source), "utf8"), {
        fileName: fileURLToPath(source), compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
      }).outputText, shortCircuit: true };
    }
    return next(url, context);
  },
});
after(async () => {
  hook.deregister(); process.env = originalEnv;
  await rm(root, { recursive: true, force: true });
});

const load = name => import(pathToFileURL(native.resolve(name)).href);
const boot = await load("@deepseek-ai/dsh-app-boot");
const { runProfile } = await load("@deepseek-ai/dsh/profile-boot");
const { symbols } = await load("@deepseek-ai/cordis");
const { SubagentRuntime, SubagentError, SubagentDepthError } = await load("@deepseek-ai/dsh-subagent");
const { AgentLoop } = await load("@deepseek-ai/dsh-agent-loop");
const { LlmAdapter, ToolCallId, createUserMessage } = await load("@deepseek-ai/dsh-llm");
const { SessionId } = await load("@deepseek-ai/dsh-session");
const { DsmmSubagentRuntime } = await import(new URL("../lib/runtime-integration.js", import.meta.url));
const exact = value => value?.[symbols.original] ?? value;
const loopCalls = (adapter, agent) => adapter.calls.filter(call => call.sessionId === agent.id && call.purpose === undefined);

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

class DeterministicAdapter extends LlmAdapter {
  calls = [];
  beforeStream;
  async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ["text"] }; }
  async *stream(options) {
    this.calls.push(options);
    await this.beforeStream?.(options);
    options.signal?.throwIfAborted();
    const text = `native product acceptance result: ${options.model}`;
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

async function bounded(promise, label, ms = 15_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms); })]); }
  finally { clearTimeout(timer); }
}

async function profileFixture(t, { enabled, manual = false, limits, managedSettings = false, requestAdmission = false,
  stockPersistence = originalEnv.DSMM_TEST_STOCK_PERSISTENCE === "1" } = {}) {
  const name = `native-runtime-${randomUUID()}`;
  const dir = join(env.DSH_HOME, "profiles", name);
  await mkdir(join(dir, "node_modules", "@dsmm"), { recursive: true });
  await mkdir(join(dir, "node_modules", "@deepseek-ai"), { recursive: true });
  await symlink(packageRoot, join(dir, "node_modules", "@dsmm", "dsmm"), process.platform === "win32" ? "junction" : "dir");
  for (const bundle of ["dsh-base", "dsh-web-app"]) await symlink(dirname(native.resolve(`@deepseek-ai/${bundle}/package.json`)),
    join(dir, "node_modules", "@deepseek-ai", bundle), process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, private: true, type: "module",
    dependencies: { "@deepseek-ai/dsh-base": "0.2.0-rc.2", "@deepseek-ai/dsh-web-app": "0.2.0-rc.2", "@dsmm/dsmm": "*" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dsmm/dsmm"] } } }));
  const config = { presets: { materialize: false }, runtimeRecovery: { enabled: false },
    roleRouting: { "dsmm-reviewer": { primary: { provider: "acceptance", model: "reviewer" } } },
    ...(stockPersistence ? {} : { sessionPersistence: { root: join(dir, "sessions"), compression: "none" } }),
    ...(enabled === undefined ? {} : { runtime: { enabled } }) };
  const patches = [
    { id: "webserver", config: { host: "127.0.0.1", port: 0 } },
    { id: "web-runtime", config: { openBrowser: false, printUrl: false } },
    { id: "session-telemetry-otel", disabled: true },
    ...requestAdmission ? [{ id: "llm", name: "@deepseek-ai/dsh-llm", disabled: true },
      { insert: [{ id: "acceptance-llm", name: "@dsmm/dsmm/llm-runtime" }] }] : [],
    ...managedSettings ? [{ id: "settings", name: "@deepseek-ai/dsh-settings", disabled: true },
      { insert: [{ id: "acceptance-settings", name: "@dsmm/dsmm/managed-settings" }] }] : [],
    ...stockPersistence ? [] : [{ id: "session-persistence-jsonl", disabled: true }],
    { id: "dsmm", config },
    ...(limits ? [{ id: "subagent", config: limits }] : []),
    ...(manual ? boot.loadOverlayPatches("native-runtime-acceptance", join(packageRoot, "patches", "subagent-runtime.yml")) : []),
  ];
  if (manual && limits) patches.push({ id: "dsmm-subagent-runtime", config: limits });
  await writeFile(join(dir, "cordis.patch.yml"), JSON.stringify(patches));
  const handles = new Set();
  let ctx;
  const close = async () => {
    try { for (const handle of [...handles].reverse()) await handle.dispose(); }
    finally { handles.clear(); if (ctx) { const current = ctx; ctx = undefined; await bounded(current.fiber.dispose(), "profile dispose"); } }
  };
  t.after(close);
  const open = async () => {
    // Official package/profile launch: no prepare callback or builtin replacement.
    ({ ctx } = await bounded(runProfile({ profile: name, patchFiles: [], args: [],
      environment: boot.loadLayeredEnv("native-runtime-acceptance", dir) }), "official runProfile"));
    const unhealthy = [...ctx.loader.entries()].filter(entry => !entry.disabled && entry.options.name && entry.fiber?.state !== 2);
    assert.deepEqual(unhealthy.map(entry => ({ id: entry.options.id, name: entry.options.name, state: entry.fiber?.state })), []);
    for (const registration of ctx.registry.values()) for (const fiber of registration.fibers) {
      if (["tools", "connection", "typert", "profileContext"].some(service => service in fiber.inject)) await bounded(fiber.await(), "native Core service injection");
    }
    assert.ok(exact(ctx.agentLoop) instanceof AgentLoop);
    assert.ok(ctx.get("hmr"));
    assert.ok(ctx.get("dsmmCoreLlmOwner"));
    assert.ok(ctx.get("dsmmPermissionController"));
    const adapter = new DeterministicAdapter();
    ctx.llm.registerAdapter(["acceptance"], adapter);
    const create = async (dw = false) => {
      const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: root, ...(dw ? { agentPreset: "dsmm-orchestrator" } : {}) },
        agentOptions: { provider: "acceptance", model: "root" } });
      handles.add(handle); return handle.agent;
    };
    return { ctx, adapter, create };
  };
  return { open, close, dir };
}

function runtimeState(ctx, managed, { desired = managed, ready = managed, restart = false } = {}) {
  const owner = exact(ctx.subagents);
  assert.ok(owner instanceof SubagentRuntime);
  assert.equal(owner instanceof DsmmSubagentRuntime, managed);
  if (!managed) assert.equal(owner.constructor, SubagentRuntime);
  const owners = [...ctx.loader.entries()].filter(entry => entry.fiber?.state === 2
    && ["@deepseek-ai/dsh-subagent", "@dsmm/dsmm/subagent-runtime"].includes(entry.options.name));
  assert.equal(owners.length, 1, "There must be exactly one native runtime owner");
  const state = ctx.dsmmProfileRuntime.getSettings.subagentRuntime();
  assert.equal(state.binding, managed ? "dsmm" : "stock");
  assert.equal(state.desiredEnabled, desired);
  assert.equal(state.deliveryFenceReady, ready);
  assert.equal(state.restartRequired, restart);
  if (managed) assert.equal(owner.authority.view().deliveryFenceReady, ready);
  return owner;
}

async function turn(agent, text = "Complete the first native request") {
  agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
  await bounded(agent.whenIdle(), "native AgentLoop turn");
  const events = agent.session.snapshotEvents();
  assert.ok(events.some(event => event.type === "assistant/message" && JSON.stringify(event.data).includes("native product acceptance result")));
  assert.equal(events.filter(event => event.type === "turn/end").at(-1)?.data.reason.kind, "completed");
}

async function delegate(parent) {
  const result = await bounded(parent.ctx.tools.execute({ agent: parent, name: "dsmm_reviewer", arguments: { description: "Product native delegation", prompt: "Return deterministic useful child evidence" },
    callId: ToolCallId(randomUUID()), signal: new AbortController().signal }), "real DSMM reviewer tool");
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value.kind, "foreground");
  assert.equal(typeof result.value.invocation.childId, "string");
  assert.match(JSON.stringify(result.value.output), /native product acceptance result: reviewer/u);
  return result.value;
}

test("default runtime selection with compatible storage completes the first DW response and child delegation", { timeout: 45_000 }, async t => {
  const f = await profileFixture(t), { ctx, adapter, create } = await f.open();
  const owner = runtimeState(ctx, true);
  assert.ok(owner.getProvider("spawn")); assert.ok(owner.getProvider("fork"));
  const parent = await create(true);
  await turn(parent);
  const requests = loopCalls(adapter, parent);
  assert.equal(requests.length, 1, "The first native parent turn must complete in one AgentLoop request");
  assert.match(JSON.stringify(requests[0].messages), /DEEPWORK MODE ENABLED!/u);
  assert.ok(requests[0].tools.some(tool => tool.name === "dsmm_reviewer"));
  await delegate(parent);
  assert.ok(adapter.calls.some(call => call.model === "reviewer" && call.purpose === undefined));
});

test("runtime disabled cold-boots official stock and completes an ordinary native child", { timeout: 45_000 }, async t => {
  const f = await profileFixture(t, { enabled: false }), { ctx, adapter, create } = await f.open();
  runtimeState(ctx, false);
  const parent = await create(); await turn(parent);
  const run = await ctx.subagents.start("spawn", { parent, label: "ordinary stock child", prompt: [{ type: "text", text: "Complete an ordinary native child" }],
    signal: new AbortController().signal, agentOptions: { provider: "acceptance", model: "stock-child" } });
  try {
    await bounded(run.result, "stock child result");
    assert.ok(run.localAgent.session.snapshotEvents().some(event => event.type === "assistant/message" && JSON.stringify(event.data).includes("native product acceptance result: stock-child")));
    assert.ok(adapter.calls.some(call => call.model === "stock-child"));
  } finally { await run.dispose(); }
});

for (const manual of [false, true]) for (const enabled of [true, false]) {
  test(`product ${manual ? "manual" : "automatic"} runtime enabled=${enabled} preserves explicit native limits`, { timeout: 45_000 }, async t => {
    const limits = { maxDepth: 1, maxActiveSubagents: 1 };
    const f = await profileFixture(t, { enabled, manual, limits }), { ctx, create, adapter } = await f.open();
    const owner = runtimeState(ctx, enabled);
    assert.equal(owner.resolveMaxDepth(), 1);
    assert.equal(owner.config.maxActiveSubagents.get(), 1);
    const parent = await create(), entered = gate(), output = gate();
    let child;
    adapter.beforeStream = async options => {
      if (options.model !== "limited-child" || options.purpose !== undefined) return;
      entered.release();
      options.signal.addEventListener("abort", output.release, { once: true });
      try { await output.promise; }
      finally { options.signal.removeEventListener("abort", output.release); }
    };
    const request = (agent, model) => ({ parent: agent, prompt: [{ type: "text", text: "Exercise the configured native child boundary" }],
      agentOptions: { provider: "acceptance", model }, maxDepth: owner.resolveMaxDepth() });
    const signal = new AbortController().signal;
    try {
      const first = await bounded(owner.startActivation({ provider: "spawn", label: "occupy the native parent capacity", signal, delivery: "caller",
        request: request(parent, "limited-child") }), "native limited child admission");
      child = ctx.agents.get(first.childId);
      assert.ok(child);
      await bounded(entered.promise, "limited child enters its real native AgentLoop");
      assert.equal(child.status, "running");
      await assert.rejects(owner.startActivation({ provider: "spawn", label: "exceed native parent capacity", signal, delivery: "caller",
        request: request(parent, "overflow-child") }), error => error instanceof SubagentError && error.code === "ACTIVATION_LIMIT_REACHED");
      await assert.rejects(owner.startActivation({ provider: "spawn", label: "exceed native depth", signal, delivery: "caller", request: request(child, "over-depth-child") }),
        error => error instanceof SubagentDepthError && error.attemptedDepth === 2 && error.maxDepth === 1);
      assert.equal(adapter.calls.some(call => ["overflow-child", "over-depth-child"].includes(call.model)), false);
      assert.deepEqual(ctx.agents.list().filter(agent => agent.session.header.parentSession === parent.id), [child]);
    } finally {
      adapter.beforeStream = undefined; output.release();
      if (child) await bounded(child.whenIdle(), "limited native child drains");
    }
    assert.ok(child.session.snapshotEvents().some(event => event.type === "assistant/message"
      && JSON.stringify(event.data).includes("native product acceptance result: limited-child")));
  });
}

for (const [managedSettings, changesPolicy] of [[true, false], [false, false], [true, true]]) test(`an active Core-admitted native request survives only runtime-only saves (managed settings=${managedSettings}, permission change=${changesPolicy})`, { timeout: 45_000 }, async t => {
  const f = await profileFixture(t, { enabled: true, managedSettings, requestAdmission: true });
  const { ctx, create, adapter } = await f.open();
  const parent = await create(true), admission = ctx.dsmmProfileRuntime.admission(parent);
  const permissions = exact(ctx.dsmmPermissionController), signal = permissions.rules.signal, policy = permissions.rules.getPolicy();
  const core = exact(ctx.dsmmCoreLlmOwner), mainEntry = [...ctx.loader.entries()].find(entry => entry.options.id === "dsmm"), main = mainEntry.fiber;
  const entered = gate(), output = gate();
  let request;
  adapter.beforeStream = async options => {
    if (options.sessionId !== parent.id || options.purpose !== undefined) return;
    request = options; entered.release();
    options.signal.addEventListener("abort", output.release, { once: true });
    try { await output.promise; }
    finally { options.signal.removeEventListener("abort", output.release); }
  };
  parent.followup(createUserMessage({ content: [{ type: "text", text: "Hold the actual admitted request across a native runtime save" }], source: { kind: "user" } }));
  try {
    await bounded(entered.promise, "active admitted adapter request");
    assert.equal(parent.status, "running");
    const descriptor = ctx.settings.describe().find(row => row.ns === "dsmm");
    const edits = [{ op: "set", path: ["runtime", "enabled"], value: false },
      ...changesPolicy ? [{ op: "set", path: ["permissionControl", "outsideReads"], value: "deny" }] : []];
    let detach;
    const reloaded = new Promise(resolve => { detach = ctx.on("app-boot/config-reload", resolve); });
    try {
      await ctx.settings.mutate(descriptor.ns, edits, descriptor.revision);
      await bounded(reloaded, "active request native HMR");
    } finally { detach(); }
    assert.equal(permissions.rules.status().state, "synced");
    assert.equal(signal.aborted, changesPolicy);
    assert.equal(permissions.rules.signal === signal, !changesPolicy);
    assert.equal(request.signal.aborted, changesPolicy);
    assert.equal(exact(ctx.dsmmPermissionController), permissions);
    assert.equal(exact(ctx.dsmmCoreLlmOwner), core);
    assert.equal(mainEntry.fiber, main);
    assert.equal(ctx.dsmmProfileRuntime.admission(parent), admission);
    runtimeState(ctx, true, { desired: false, ready: true, restart: true });
    if (changesPolicy) assert.equal(permissions.rules.getPolicy().policy.outsideReads, "deny");
    else {
      assert.equal(permissions.rules.getPolicy(), policy);
      await assert.rejects(ctx.settings.mutate(descriptor.ns, [{ op: "set", path: ["runtime", "enabled"], value: true }], descriptor.revision));
      assert.equal(request.signal.aborted, false);
      assert.equal(permissions.rules.signal, signal);
    }
  } finally {
    adapter.beforeStream = undefined; output.release();
    await bounded(parent.whenIdle(), "held admitted request settles");
  }
  assert.equal(loopCalls(adapter, parent).length, 1);
  const completed = parent.session.snapshotEvents().filter(event => event.type === "turn/end").at(-1)?.data.reason.kind;
  if (changesPolicy) assert.notEqual(completed, "completed");
  else {
    assert.equal(completed, "completed");
    assert.ok(parent.session.snapshotEvents().some(event => event.type === "assistant/message" && JSON.stringify(event.data).includes("native product acceptance result")));
  }
});

for (const enabled of [true, false]) test(`native Settings save and HMR retain owners until cold reopen (${enabled} -> ${!enabled})`, { timeout: 60_000 }, async t => {
  const f = await profileFixture(t, { enabled });
  const { ctx, create, adapter } = await f.open();
  const parent = await create(enabled), admission = ctx.dsmmProfileRuntime.admission(parent);
  const owner = runtimeState(ctx, enabled);
  const main = [...ctx.loader.entries()].find(entry => entry.options.id === "dsmm");
  const mainFiber = main.fiber, core = exact(ctx.get("dsmmCoreLlmOwner")), permissions = exact(ctx.get("dsmmPermissionController"));
  const descriptor = ctx.settings.describe().find(row => row.ns === "dsmm");
  assert.ok(descriptor);
  const editor = await ctx.typertGateway.invoke({ namespace: "dsmmConfig", method: "describeSettings", args: {}, peer: ctx.connection.operator });
  assert.equal(editor.subagentRuntime.desiredEnabled, enabled);
  assert.equal(editor.nativeSchema.fields.runtime.fields.enabled.type, "boolean");
  await assert.rejects(ctx.settings.mutate(descriptor.ns, [{ op: "set", path: ["runtime", "enabled"], value: "false" }], descriptor.revision));
  let reload;
  const reloaded = new Promise(resolve => { reload = ctx.on("app-boot/config-reload", resolve); });
  try {
    await ctx.settings.mutate(descriptor.ns, [{ op: "set", path: ["runtime", "enabled"], value: !enabled }], descriptor.revision);
    await bounded(reloaded, "native file-watcher HMR");
  } finally { reload(); }
  assert.equal(exact(ctx.subagents), owner);
  assert.equal(main.fiber, mainFiber);
  assert.equal(exact(ctx.get("dsmmCoreLlmOwner")), core);
  assert.equal(exact(ctx.get("dsmmPermissionController")), permissions);
  assert.equal(ctx.dsmmProfileRuntime.admission(parent), admission);
  runtimeState(ctx, enabled, { desired: !enabled, ready: enabled, restart: true });
  const pending = await ctx.typertGateway.invoke({ namespace: "dsmmConfig", method: "describeSettings", args: {}, peer: ctx.connection.operator });
  assert.equal(pending.subagentRuntime.desiredEnabled, !enabled);
  assert.equal(pending.subagentRuntime.restartRequired, true);
  await turn(parent, "A desired runtime switch must preserve this admitted parent");
  const requests = loopCalls(adapter, parent);
  assert.equal(requests.length, 1, "The admitted parent must complete one native AgentLoop request after HMR");
  assert.equal(requests[0].signal.aborted, false);
  await f.close();
  const reopened = await f.open();
  runtimeState(reopened.ctx, !enabled);
  const next = await reopened.create(!enabled);
  await turn(next, "The persisted native runtime switch must converge on cold reopen");
  if (!enabled) await delegate(next);
});
