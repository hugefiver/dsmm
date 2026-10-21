import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Context } from "@deepseek-ai/cordis";
import type { DsmmNativeConfig } from "../src/settings.ts";
import type { DsmmPermissionController } from "../src/permission-controller.ts";

const require = createRequire(import.meta.url);
const sdk = createRequire(require.resolve("@deepseek-ai/dsh-agent-preset-registry"));
const settingsSdk = createRequire(sdk.resolve("@deepseek-ai/dsh-settings"));
const { Loader } = sdk("@deepseek-ai/cordis-plugin-loader");
const { ConfigEditor } = settingsSdk("@deepseek-ai/dsh-config-editor");
const { SettingsForms } = sdk("@deepseek-ai/dsh-settings");
const { loadProfileDirectory, mountRootInclude, readProfilePatches } = sdk("@deepseek-ai/dsh-app-boot");

/** A real Include-owned entry is required for SettingsForms to authenticate Core's policy source. */
export function permissionHostProfile(dir: string, home: string, config: DsmmNativeConfig) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "permission-host-fixture", private: true,
    dependencies: {}, dsh: { profile: { bundles: [] } } }), { flag: "wx" });
  writeFileSync(join(dir, "cordis.json"), "[]\n", { flag: "wx" });
  writeFileSync(join(dir, "cordis.patch.yml"), JSON.stringify([
    { insert: [{ id: "permission-core", name: "cordis:permission-fixture-core", config }] }
  ]), { flag: "wx" });
  const installAnchor = sdk.resolve("@deepseek-ai/dsh-app-boot");
  return { ...loadProfileDirectory("dsh", dir, installAnchor), home, installAnchor, overlays: [], startedBundles: [] };
}

export async function mountPermissionHostCore(ctx: Context,
  plugin: { apply(ctx: never, config?: DsmmNativeConfig): void | Promise<void> }) {
  if (ctx.get("loader") === undefined) await ctx.plugin(Loader).await();
  ctx.loader.builtins["permission-fixture-core"] = { default: { ...plugin,
    apply(scope: Context, config?: DsmmNativeConfig) {
      return plugin.apply(scope.extend({ baseUrl: new URL("../", import.meta.url).href }) as never, config);
    }
  } };
  const profile = ctx.get("profileContext")!;
  const include = await mountRootInclude(ctx, join(profile.dir, "cordis.json"), readProfilePatches("dsh", profile));
  assert.ok(include);
  await ctx.loader.await();
  const entry = ctx.loader.resolve("include:permission-core");
  assert.ok(entry.fiber);
  await entry.fiber.await();
  assert.equal(entry.fiber.state, 2);
  if (ctx.get("configEditor") === undefined) await ctx.plugin(ConfigEditor).await();
  if (ctx.get("settings") === undefined) await ctx.plugin(SettingsForms).await();
  assert.ok(ctx.settings.describe().some(row => row.ns === entry.options.id), "current native Core descriptor must be addressable");
  await waitForPermissionHost(ctx);
  return entry.fiber;
}

export async function waitForPermissionHost(ctx: Context,
  ready: (controller: DsmmPermissionController) => boolean = () => true): Promise<DsmmPermissionController> {
  const deadline = performance.now() + 5000;
  do {
    const controller = ctx.get("dsmmPermissionController");
    if (controller !== undefined && ready(controller)) return controller;
    await setTimeout(5);
  } while (performance.now() < deadline);
  assert.fail("Real Core permission owner and managed registrations did not become ready");
}
