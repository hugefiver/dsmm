import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, writeFile, symlink, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createDsmmLlmColdStartup } from "../src/host-llm-startup.ts";
import { inspectSourceCandidateRuntime } from "./host-llm-candidate-support.mjs";

const native = createRequire(process.env.DSMM_TEST_DSH_ENTRY);
export const load = name => import(pathToFileURL(native.resolve(name)).href);

export async function fixture(t, controls = {}) {
  const parentPath = process.env.DSMM_TEST_TEMP_ROOT ?? join(tmpdir(), "opencode");
  if (process.env.DSMM_TEST_TEMP_ROOT === undefined) await mkdir(parentPath, { recursive: true });
  const parent = await realpath(parentPath);
  const root = await mkdtemp(join(parent, "dsmm-w1-review-"));
  const home = join(root, "home"), workspace = join(root, "workspace"), agentsHome = join(root, "agents");
  await Promise.all([home, workspace, agentsHome].map(path => mkdir(path)));
  const prior = Object.fromEntries(["DSH_HOME", "DSH_AGENTS_HOME", "DSH_TELEMETRY_DISABLED"].map(key => [key, process.env[key]]));
  process.env.DSH_HOME = home; process.env.DSH_AGENTS_HOME = agentsHome; process.env.DSH_TELEMETRY_DISABLED = "1";
  const bodies = [], errors = [], failures = [], requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    await controls.beforeRespond?.(bodies.at(-1));
    const status = controls.status?.(bodies.at(-1)) ?? 200;
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "isolated provider refusal", type: status === 429 ? "rate_limit_error" : "invalid_request_error", code: status === 429 ? "rate_limit_exceeded" : "unsupported_parameter" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "review-response", object: "chat.completion.chunk", created: 1, model: "gpt-6.1-sol" };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "complete" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let ctx;
  const activations = new Set();
  async function closeHost() {
    for (const run of activations) await run.dispose();
    activations.clear();
    await ctx?.fiber.dispose();
    ctx = undefined;
  }
  t.after(async () => {
    await controls.cleanup?.();
    await closeHost();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.equal(dirname(await realpath(root)), parent);
    await rm(root, { recursive: true });
  });
  const bootApi = await load("@deepseek-ai/dsh-app-boot");
  const { prepareProfile, PROFILE_ROOT_FILENAME } = await load("@deepseek-ai/dsh/profile-boot");
  const { createLaunchEnvironmentSnapshot } = await load("@deepseek-ai/dsh-launch-environment");
  const { AgentLoop } = await load("@deepseek-ai/dsh-agent-loop");
  const { createUserMessage, LlmError } = await load("@deepseek-ai/dsh-llm");
  const { SessionId } = await load("@deepseek-ai/dsh-session");
  const profileDir = bootApi.resolveProfileDir("review", home);
  const packageDir = join(profileDir, "node_modules", "@dsmm", "dsmm");
  await mkdir(packageDir, { recursive: true });
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const sourceTarget = target => target.startsWith("./lib/") ? target.replace("./lib/", "./src/").replace(/\.js$/u, ".ts") : target;
  const exports = Object.fromEntries(Object.entries(manifest.exports).map(([name, target]) => [name,
    name === "./client" ? target : typeof target === "string" ? sourceTarget(target) : { ...target, default: sourceTarget(target.default) }]));
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ ...manifest, main: "./src/index.ts", exports }));
  for (const name of ["src", "locale", "prompts", "skills", "agent-presets"]) {
    await symlink(fileURLToPath(new URL(`../${name}/`, import.meta.url)), join(packageDir, name), "junction");
  }
  await writeFile(join(packageDir, "cordis.patch.yml"), await readFile(new URL("../cordis.patch.yml", import.meta.url)));
  await writeFile(join(profileDir, "package.json"), JSON.stringify({ private: true, type: "module", dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "@dsmm/dsmm"] } } }));
  await writeFile(join(profileDir, "cordis.patch.yml"), JSON.stringify([
    { id: "headless-startup", disabled: true }, { id: "headless-runner", disabled: true }, { id: "session-persistence-jsonl", disabled: true },
    ...(controls.disableNativeBash ? [{ id: "tool-bash", disabled: true }] : []),
    { id: "llm-pi-ai", config: { providers: {} } }, { id: "agent", disabled: true }, { id: "subagent", disabled: true },
    { insert: [
      { id: "dsmm-agent-registry", name: "@dsmm/dsmm/agent-registry", config: {} },
      { id: "dsmm-subagent-runtime", name: "@dsmm/dsmm/subagent-runtime", inject: ["agents"], config: {} },
    ] },
    { id: "dsmm", inject: ["profileContext", "agents"], config: { presets: { root: join(root, "presets") }, lsp: { enabled: false }, defaultActive: true, sessionPersistence: { root: join(root, "sessions"), compression: "none" }, ...controls.dsmm } },
  ]));
  const profile = prepareProfile("review");
  const resolution = await bootApi.createRuntimeResolution({ installAnchor: process.env.DSMM_TEST_DSH_ENTRY, profile });
  const admissionLife = new AbortController();
  let ready, agent;
  async function bootHost() {
  const startup = createDsmmLlmColdStartup({
    agentLoop: AgentLoop.Config({ agents: [{ id: "review", sessionId: SessionId("dsmm-w1-review"), cwd: workspace, provider: "apai", model: "gpt-6.1-sol" }] }),
    provider: { settingsNamespace: "dsmm-llm-owner", config: { providers: { apai: {
      api: "openai-completions", baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: "DSMM_W1_REVIEW_FICTIONAL",
      models: ["gpt-6.1-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map(id => ({ id, contextWindow: controls.contextWindow ?? 262144 })), compat: { maxTokensField: controls.tokenField ?? "max_tokens" },
      retryPolicy: { mode: "normal", maxRetries: 0 },
    } } }, auth: { credentials: new InMemoryCredentialStore(), authContext: { env: async () => { throw new Error("Ambient auth is prohibited"); }, fileExists: async () => { throw new Error("Credential file reads are prohibited"); } } },
      resolveApiKey: controls.resolveApiKey ?? (async (provider, reference) => {
        assert.equal(provider, "apai"); assert.equal(reference, "DSMM_W1_REVIEW_FICTIONAL"); return "fictional-review-key";
      }) },
    ...(controls.production ? {} : { async establish(scope, providers) {
      return { async preflight(frame, proposal) {
        const runtime = scope.get("dsmmProfileRuntime"), admission = runtime.admission(frame.agent);
        if (!(await runtime.getSession(frame.agent)).deepwork.active) return { kind: "native" };
        const generation = providers.generation("apai");
        const bound = { agent: frame.agent, admission, capture: admission, epoch: admission.epoch, signal: admissionLife.signal,
          assertCurrent() { assert.equal(runtime.admission(frame.agent), admission); } };
        const config = { ...proposal, ...controls.config };
        return controls.stockPrepared ? { kind: "stock", config, admission: bound }
          : { kind: "dsmm", config, admission: bound, generation: controls.generation ? controls.generation(generation) : generation };
      } };
    } }),
  });
  const profileContext = { name: "review", dir: profile.dir, patchPath: profile.patchPath, installAnchor: process.env.DSMM_TEST_DSH_ENTRY,
    startedBundles: profile.layers.map(layer => layer.packageName), cwd: workspace, home, overlays: [...startup.patches], telemetryDisabledEnv: "1" };
  const created = Promise.withResolvers();
  created.promise.catch(() => {});
  ctx = await bootApi.boot("dsmm-w1-review", join(profile.dir, PROFILE_ROOT_FILENAME), bootApi.readProfilePatches("dsmm-w1-review", profileContext, profile), async host => {
    host.provide("profileContext", profileContext);
    host.provide("launchEnvironment", createLaunchEnvironmentSnapshot([{ source: "process", values: { DSH_HOME: home, DSH_AGENTS_HOME: agentsHome } }]));
    host.on("agent/created", ({ agent }) => { if (agent.id === "dsmm-w1-review") created.resolve(agent); }, { global: true });
    host.on("agent-loop/config-start-failed", ({ error }) => created.reject(error));
    host.on("agent/error", ({ error }) => errors.push(error));
    host.on("agent/request", async (_frame, next) => { const proposal = await next(); return controls.nativeConfig ?? proposal; }, { global: true });
    host.on("agent/request-error", (frame, next) => { failures.push(frame); return next(); }, { prepend: true, global: true });
    host.on("llm/stream", (request, next) => { requests.push(request); return next(); }, { global: true });
    await host.plugin(bootApi.PluginPackages, { resolution });
    await startup.prepare(host);
  });
  ready = startup.assertReady(); agent = await created.promise;
  inspectSourceCandidateRuntime(ctx, { mode: "manual" });
  }
  await bootHost();
  return { get ctx() { return ctx; }, get ready() { return ready; }, get agent() { return agent; }, bodies, errors, failures, requests, admissionLife, LlmError, activations,
    async restart(beforeBoot) { await closeHost(); await beforeBoot?.(); await bootHost(); },
    createRoot(id) { return ready.loop.create(SessionId(id), { provider: "apai", model: "gpt-6.1-sol" }, { cwd: workspace }); },
    start(text) { agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } })); },
    async run(text) { this.start(text); await agent.whenIdle(); },
    async mode(active) {
      const runtime = ctx.get("dsmmProfileRuntime"), snapshot = await runtime.getSession(agent);
      await runtime.selectMode({ sessionId: agent.id, active, expectedAdmissionEpoch: snapshot.admissionEpoch, expectedModeRevision: snapshot.deepwork.revision }, agent);
    },
  };
}

export async function applyRoleProfile(f, id, policy, settings = {}) {
  const runtime = f.ctx.get("dsmmProfileRuntime");
  const saved = await runtime.save({ id, expectedRevision: null, content: JSON.stringify({ version: 1, id,
    settings: { ...settings, roleRouting: { "dsmm-doc-search": policy } } }) });
  const session = await runtime.getSession(f.agent);
  return runtime.selectSession({ sessionId: f.agent.id, id, expectedRevision: saved.revision,
    expectedSelectionRevision: session.selection.selectionRevision, expectedAdmissionEpoch: session.admissionEpoch }, f.agent);
}

export async function startDoc(f, request = {}, delivery = "caller") {
  const { SessionId } = await load("@deepseek-ai/dsh-session");
  const childId = SessionId(randomUUID());
  let agent;
  const remove = f.ctx.on("agent/created", event => { if (event.agent.id === childId) agent = event.agent; }, { global: true });
  try {
    const run = await f.ctx.subagents.startActivation({ provider: "dsmm-role-doc-search", childId, label: "Isolated documentation", delivery,
      request: { parent: f.agent, prompt: [{ type: "text", text: "Read isolated documentation" }], ...request }, signal: new AbortController().signal });
    f.activations.add(run);
    assert.ok(agent);
    return { run, agent };
  } finally { remove(); }
}

export async function runDoc(f) {
  const { run, agent } = await startDoc(f);
  const capture = f.ctx.get("dsmmProfileRuntime").admission(agent).childCapture;
  try {
    const result = await run.result;
    return { result, header: agent.session.requestHeader(), capture };
  } finally { await run.dispose(); }
}
