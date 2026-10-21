import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { Config } from "../src/index.js";
import { DsmmDeploymentConfig } from "../src/deployment-config.js";
import { nativeAgentContext, scopeOf } from "../src/native-scope.js";
import type { DshAgent } from "../src/dsh-types.js";
import type { DsmmPluginConfig } from "../src/settings.js";

test("a native Loader from another Cordis copy preserves entry identity and sparse deployment overrides", {
  skip: process.env.DSMM_TEST_DSH_ENTRY === undefined ? "requires an explicit native installation anchor" : false,
}, async t => {
  const native = createRequire(process.env.DSMM_TEST_DSH_ENTRY!);
  const { Context: NativeContext } = native("@deepseek-ai/cordis");
  const { Loader } = native("@deepseek-ai/cordis-plugin-loader");
  const ctx = new NativeContext();
  t.after(() => ctx.fiber.dispose());
  assert.equal(ctx instanceof Context, false, "exercise a genuinely separate Cordis constructor");
  assert.equal(Context.is(ctx), true);
  assert.equal(Context.is({ get() {}, fiber: ctx.fiber }), false);

  await mkdir(join(tmpdir(), "opencode"), { recursive: true });
  const parent = await realpath(join(tmpdir(), "opencode"));
  const root = await mkdtemp(join(parent, "dsmm-cross-copy-context-"));
  t.after(async () => {
    const exact = await realpath(root); assert.equal(exact, root); assert.equal(dirname(exact), parent);
    await rm(exact, { recursive: true });
  });
  const globalDir = join(root, "plugins", "dsmm");
  await mkdir(globalDir, { recursive: true });
  await writeFile(join(globalDir, "config.json"), JSON.stringify({ defaultActive: true }));
  ctx.provide("profileContext", { home: root, dir: join(root, "profile") });
  await ctx.plugin(Loader, { baseUrl: new URL("../", import.meta.url).href }).await();
  let deployment!: DsmmDeploymentConfig;
  ctx.loader.builtins["cross-copy-deployment"] = { default: {
    name: "cross-copy-deployment", Config,
    apply(scope: Context, config: DsmmPluginConfig) { deployment = new DsmmDeploymentConfig(scope, config); },
  } };
  const id = await ctx.loader.create({ name: "cordis:cross-copy-deployment", config: {} });
  await ctx.loader.await();
  const entry = ctx.loader.resolve(id);
  await entry.fiber.await();
  assert.ok(deployment.nativeEntry === entry, "retain the actual native Loader entry");
  const inherited = await deployment.readDesired();
  assert.equal(inherited.entryId, entry.id);
  assert.equal(inherited.nativeNamespace, entry.options.id);
  assert.deepEqual(inherited.profile, {});
  assert.equal(inherited.settings.defaultActive, true);

  await entry.update({ config: { defaultActive: false } });
  await ctx.loader.await();
  const overridden = await deployment.readDesired();
  assert.deepEqual(overridden.profile, { defaultActive: false });
  assert.equal(overridden.settings.defaultActive, false);
});

test("exact Agent scopes recognize another Cordis copy without accepting global, shared or unbranded contexts", {
  skip: process.env.DSMM_TEST_DSH_ENTRY === undefined ? "requires an explicit native installation anchor" : false,
}, async t => {
  const native = createRequire(process.env.DSMM_TEST_DSH_ENTRY!);
  const { Context: NativeContext } = native("@deepseek-ai/cordis");
  const require = createRequire(import.meta.url);
  const sdk = createRequire(require.resolve("@deepseek-ai/dsh-agent-preset-registry"));
  const { createScope } = sdk("@deepseek-ai/dsh-scope");
  const host = new NativeContext();
  t.after(() => host.fiber.dispose());
  const agent: DshAgent = { session: { append() {} } };
  const exact = createScope(host, agent).ctx;
  agent.ctx = exact;
  assert.equal(exact instanceof Context, false);
  assert.equal(Context.is(exact), true);
  assert.equal(scopeOf(exact), agent);
  assert.ok(nativeAgentContext(agent) === exact);

  const shared = createScope(host, {}).ctx;
  for (const ctx of [host, shared, { get() {}, fiber: exact.fiber }]) {
    agent.ctx = ctx;
    assert.throws(() => nativeAgentContext(agent));
  }
  assert.throws(() => nativeAgentContext({ session: agent.session, ctx: exact }));
});
