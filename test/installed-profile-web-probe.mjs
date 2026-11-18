import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sse, successful, toolCall } from "./native-host-route-boundaries-fixture.mjs";

// node installed-profile-web-probe.mjs --baseline | <isolated DSH_HOME> <installed profile name>
const [target, profile] = process.argv.slice(2);
const baseline = target === "--baseline";
assert.ok(baseline ? !profile : target && profile && /^[\w-]+$/u.test(profile), "pass --baseline or <isolated DSH_HOME> <profile>");
assert.ok(process.env.DSMM_TEST_DSH_ENTRY, "set DSMM_TEST_DSH_ENTRY to the installed DSH CLI entry");
const cli = await realpath(process.env.DSMM_TEST_DSH_ENTRY);
const observer = fileURLToPath(new URL("./installed-profile-web-observer.mjs", import.meta.url));
const installedHome = baseline ? undefined : await realpath(target);
const root = await realpath(await mkdtemp(join(tmpdir(), "dsmm-installed-web-")));
const home = installedHome ?? join(root, "home");
const name = baseline ? "baseline" : profile;
const profileDir = join(home, "profiles", name);
const npmUrl = "https://registry.npmjs.org/is-number/7.0.0";
const deniedUrl = "http://127.0.0.1/";

try {
  if (baseline) {
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, "package.json"), JSON.stringify({ private: true, dsh: { profile: {
      bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]
    } } }));
  }
  await run("http");
  if (!baseline) await run("dsmm-http-fakeip");
} finally {
  assert.equal(await realpath(root), root);
  assert.equal(dirname(root), await realpath(tmpdir()));
  await rm(root, { recursive: true });
}

async function run(provider) {
  const fake = provider === "dsmm-http-fakeip";
  const url = fake ? deniedUrl : npmUrl;
  const requests = [], serverErrors = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, "Bearer isolated-loopback-only");
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push(body);
      if (requests.length === 1) toolCall(res, body, "web_fetch", { url });
      else sse(res, body, { content: "probe-complete" });
    } catch (error) { serverErrors.push(error); res.writeHead(500).end(); }
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  try {
    const evidence = join(root, `${provider}.jsonl`), patch = join(root, `${provider}.yml`);
    const inserted = [{ id: "installed-profile-observer", name: observer, config: { cli, profileDir, candidate: !baseline, evidence },
      inject: baseline ? ["web"] : ["web", "dsmmProfileRuntime"] }];
    await writeFile(evidence, "");
    if (fake) inserted.unshift({ id: provider, name: "@dsmm/dsmm/web-fetch-fakeip" });
    await writeFile(patch, JSON.stringify([
      { id: "session-title-llm", disabled: true },
      { id: "web", config: { fetchProvider: provider } },
      { id: "agent-default-model", config: { provider: "probe", model: "local" } },
      { id: "llm-pi-ai", config: { providers: { probe: {
        api: "openai-completions", baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: "PROBE_LOCAL_KEY",
        models: [{ id: "local" }], compat: { maxTokensField: "max_tokens" }, retryPolicy: { mode: "normal", maxRetries: 0 }
      } } } }, { insert: inserted }
    ]));
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, "--profile", name, "--patch", patch, "--json", "probe"], {
      cwd: root, timeout: 55_000, maxBuffer: 2_000_000,
      env: { PATH: process.env.PATH, HOME: root, DSH_HOME: home, DSH_AGENTS_HOME: join(root, "agents"),
        DSH_TELEMETRY_DISABLED: "1", PROBE_LOCAL_KEY: "isolated-loopback-only" }
    });
    assert.deepEqual(serverErrors, []);
    const events = stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line));
    successful({ code: 0, requests, stdout, stderr, events });
    assert.equal(requests.length, 2);
    const rows = (await readFile(evidence, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.equal(rows.length, 2, `expected a mounted observer and one tool result: ${stderr}`);
    const [identity, result] = rows;
    const reply = requests[1].messages.find(message => message.role === "tool");
    assert.ok(reply, "tool result must reach the next model request");
    assert.equal(result?.callId, reply.tool_call_id);
    if (fake) assert.equal(result.code, "WEB_BLOCKED_URL", JSON.stringify(result));
    else {
      assert.equal(result.meta?.statusCode, 200, JSON.stringify(result));
      assert.equal(result.meta.url, url);
      assert.ok(reply.content.includes('"name":"is-number"'), reply.content);
    }
    console.log(JSON.stringify({ profile: name, provider, url, status: result.meta?.statusCode, code: result.code, ...identity }));
  } finally {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
}
