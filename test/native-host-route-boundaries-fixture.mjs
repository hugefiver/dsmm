import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire, findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = fileURLToPath(new URL("../", import.meta.url));
const models = ["native-model", "configured-model", "fallback-model", "child-model"];
export const retryBounds = { maxRetries: 1, maxSwitches: 1, switchAfterRateLimits: 1,
  initialDelayMs: 0, maxDelayMs: 0, maxTotalDelayMs: 0 };

export async function hostFixture(entry) {
  assert.ok(entry, "DSMM_TEST_DSH_ENTRY must select a complete installed Host anchor");
  const nativeEntry = await realpath(resolve(entry));
  const native = createRequire(nativeEntry);
  const cli = join(dirname(native.resolve("@deepseek-ai/dsh/package.json")), "lib/bin.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsmm-host-boundaries-")));
  const owner = randomUUID(), marker = join(root, ".fixture-owner");
  await writeFile(marker, owner, { flag: "wx" });
  const home = join(root, "home"), workspace = join(root, "workspace");
  const profileDir = join(home, "profiles/boundaries");
  const packageDir = join(profileDir, "node_modules/@dsmm/dsmm");
  const f = { root, home, workspace, profileDir, packageDir, nativeEntry, cli,
    requests: [], serverErrors: [], processes: new Set(), runCount: 0,
    handler: (body, res) => sse(res, body, { content: "host-boundary-complete" }) };
  f.dispose = async () => {
    for (const child of f.processes) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await new Promise(resolveExit => child.exitCode !== null || child.signalCode !== null ? resolveExit() : child.once("exit", resolveExit));
    }
    if (f.server?.listening) {
      f.server.closeAllConnections();
      await new Promise((done, reject) => f.server.close(error => error ? reject(error) : done()));
    }
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    assert.equal(await realpath(root), root, "cleanup must target the original fixture directory");
    assert.equal(await readFile(marker, "utf8"), owner, "cleanup requires this fixture's ownership marker");
    await rm(root, { recursive: true, force: true });
  };
  try {
    await mkdir(packageDir, { recursive: true });
    await mkdir(workspace);
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    for (const name of ["lib", "locale", "prompts", "skills", "agent-presets", "cordis.patch.yml", "dsh-plugin.json", "package.json"]) {
      await cp(join(source, name), join(packageDir, name), { recursive: true });
    }
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      let metadata;
      if (name.startsWith("@deepseek-ai/") || name === "@earendil-works/pi-ai") {
        metadata = findPackageJSON(name, pathToFileURL(nativeEntry));
      } else {
        try { metadata = findPackageJSON(name, pathToFileURL(nativeEntry)); }
        catch { metadata = findPackageJSON(name, pathToFileURL(join(source, "package.json"))); }
      }
      assert.ok(metadata, `anchor dependency ${name} must exist`);
      const target = join(packageDir, "node_modules", name);
      await mkdir(dirname(target), { recursive: true });
      await symlink(await realpath(dirname(metadata)), target, process.platform === "win32" ? "junction" : "dir");
    }
    await cp(new URL("./native-host-route-boundaries-plugin.mjs", import.meta.url), join(packageDir, "native-host-route-boundaries-plugin.mjs"));
    await writeFile(join(profileDir, "package.json"), JSON.stringify({ private: true, type: "module", dsh: { profile: {
      bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "@dsmm/dsmm"]
    } } }));
    await writeFile(join(workspace, "observed.txt"), "original isolated content\n");
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    for (const key of Object.keys(env)) {
      if (/^(?:DSH_|DSMM_|XDG_)/iu.test(key) || /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)
        || /^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)$/iu.test(key)) delete env[key];
    }
    Object.assign(env, { DSH_HOME: home, DSH_AGENTS_HOME: join(root, "agents"), DSH_TELEMETRY_DISABLED: "1",
      HOME: home, USERPROFILE: home, APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"),
      XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_STATE_HOME: join(root, "xdg-state"), XDG_CACHE_HOME: join(root, "xdg-cache"),
      DSH_PERMISSION_MODE: "workspace-write", DSMM_HOST_KEY: "fictional-loopback-only", NO_PROXY: "127.0.0.1,localhost",
      DSMM_HOST_EVIDENCE: join(root, "plugin-evidence.jsonl") });
    f.env = env;
    f.server = createServer(async (req, res) => {
      try {
        assert.equal(req.method, "POST");
        assert.equal(req.headers.authorization, "Bearer fictional-loopback-only");
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        f.requests.push(body);
        await f.handler(body, res);
      } catch (error) {
        f.serverErrors.push(error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    await new Promise((done, reject) => { f.server.once("error", reject); f.server.listen(0, "127.0.0.1", done); });
    f.port = f.server.address().port;
    return f;
  } catch (error) { await f.dispose(); throw error; }
}

export async function configure(f, { settings = {}, reasoning = false, owner = "official", lifecycle = false, residentChild = false, microtaskFailure = false, requestControls = false } = {}) {
  const provider = { api: "openai-completions", baseURL: `http://127.0.0.1:${f.port}/v1`, apiKeyEnv: "DSMM_HOST_KEY",
    models: models.map(id => ({ id, ...(reasoning ? { reasoningEfforts: { medium: "medium", high: "high" } } : {}) })),
    compat: { maxTokensField: "max_tokens", ...(reasoning ? { supportsReasoningEffort: true } : {}) },
    retryPolicy: { mode: "normal", maxRetries: 0 }, ...(reasoning ? { reasoning: "medium" } : {}) };
  const patch = [
    { insert: [{ id: "agent-presets", name: "@deepseek-ai/dsh-agent-preset-registry", config: { default: "dsmm-orchestrator" } }] },
    { id: "session-title-llm", disabled: true },
    { id: "approval", config: { policy: "never" } },
    { id: "agent-default-model", config: { provider: "local", model: "native-model" } },
    { id: "llm-pi-ai", config: { providers: { local: provider } } },
    { id: "dsmm", config: { defaultActive: true, lsp: { enabled: false }, rootModelPolicy: "configured",
      roleRouting: { "dsmm-orchestrator": { primary: { provider: "local", model: "configured-model" } },
        "dsmm-quick": { primary: { provider: "local", model: "child-model" } } }, ...settings } },
  ];
  if (owner === "dsmm") patch.push({ id: "llm", disabled: true }, { insert: [{ id: "dsmm-llm", name: "@dsmm/dsmm/llm-runtime" }] });
  patch.push({ insert: [{ id: "host-boundaries-probe", name: join(f.packageDir, "native-host-route-boundaries-plugin.mjs"),
    inject: ["llm", "agents", "tools", "dsmmProfileRuntime"], config: { owner, lifecycle, residentChild, microtaskFailure, requestControls } }] });
  await writeFile(join(f.profileDir, "cordis.patch.yml"), JSON.stringify(patch));
}

export function sse(res, body, delta, finish = "stop") {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "isolated-host-boundary", object: "chat.completion.chunk", created: 1, model: body.model };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

export function toolCall(res, body, name, args) {
  const tool = body.tools?.find(row => row.function.name === name)?.function;
  assert.ok(tool, `actual HTTP schema must expose ${name}`);
  for (const key of Object.keys(args)) assert.ok(Object.hasOwn(tool.parameters.properties, key), `${name} must allow ${key}`);
  for (const key of tool.parameters.required ?? []) assert.ok(Object.hasOwn(args, key), `${name} requires ${key}`);
  sse(res, body, { tool_calls: [{ index: 0, id: `call-${body.messages.length}`, type: "function",
    function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
}

export function rateLimit(res) {
  res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
  res.end(JSON.stringify({ error: { message: "isolated quota", type: "rate_limit_error", code: "rate_limit_exceeded" } }));
}

export async function runCli(f, name, args = [], timeoutMs = 45_000) {
  f.requests = []; f.serverErrors = [];
  await writeFile(f.env.DSMM_HOST_EVIDENCE, "");
  const stem = join(f.root, `${++f.runCount}-${name}`);
  const out = await open(`${stem}.stdout`, "w"), err = await open(`${stem}.stderr`, "w");
  let child, timedOut = false, code;
  try {
    child = spawn(process.execPath, [f.cli, "--profile", "boundaries", "--json", ...args, name], {
      cwd: f.workspace, env: f.env, stdio: ["ignore", out.fd, err.fd]
    });
    f.processes.add(child);
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    try { code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); }); }
    finally { clearTimeout(timeout); }
  } finally {
    if (child?.exitCode !== null || child?.signalCode !== null) f.processes.delete(child);
    await out.close(); await err.close();
  }
  const stdout = await readFile(`${stem}.stdout`, "utf8"), stderr = await readFile(`${stem}.stderr`, "utf8");
  const parseLines = text => text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  const evidence = parseLines(await readFile(f.env.DSMM_HOST_EVIDENCE, "utf8"));
  assert.equal(timedOut, false, `${name} must settle without fixture cancellation; ${stderr}`);
  assert.deepEqual(f.serverErrors, [], "loopback HTTP fixture must execute without errors");
  return { code, stdout, stderr, events: parseLines(stdout), evidence, requests: [...f.requests] };
}

export function successful(result) {
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(result.events.some(event => event.type === "session"), "official CLI must announce its Session");
  assert.equal(result.events.findLast(event => event.type === "status" && event.phase === "turn_end")?.reason?.kind,
    "completed", `official CLI must complete its real turn: ${result.stdout}`);
  assert.ok(result.events.some(event => event.type === "final"), "official CLI must publish its final result");
  assert.ok(result.requests.length > 0, "the real provider adapter must reach loopback HTTP");
}
