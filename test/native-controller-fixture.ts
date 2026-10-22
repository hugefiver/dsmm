import assert from "node:assert/strict";
import type { Context } from "@deepseek-ai/cordis";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { nativeFixturePlugin } from "./native-routing-fixture.ts";

/** Native controller services backed only by fixture-local memory. */
export async function installFixtureController(ctx: Context): Promise<void> {
  const peer = "@deepseek-ai/dsh-api-session-controller";
  const load = (name: string) => nativeFixturePlugin(`@deepseek-ai/${name}`, peer);
  const credentials = await load("dsh-credentials");
  class MemoryCredentials extends credentials.CredentialProvider {
    readonly records = new Map<string, unknown>();
    async modifyRecord(key: string, modify: (current: unknown) => Promise<unknown>) {
      const next = await modify(this.records.get(key));
      if (next !== undefined) this.records.set(key, next);
      return this.records.get(key);
    }
  }
  await ctx.plugin(MemoryCredentials).await();
  class TextOnlyAttachments extends AttachmentStore {
    readonly imageLimits = { maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024, maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: ["image/png" as const] };
    async validateImage(): Promise<never> { throw new Error("Text fixture has no image decoder"); }
    async saveImage(): Promise<never> { throw new Error("Text fixture has no image storage"); }
    async readImage(): Promise<never> { throw new Error("Text fixture has no image storage"); }
  }
  await ctx.plugin(TextOnlyAttachments).await();
  ctx.provide("remoteAccess", { decide() { return { kind: "deny", reason: "policy" }; } });
  for (const name of ["dsh-typert-registry", "dsh-api-gateway", "dsh-client-connection", "dsh-client-file-upload", "dsh-agent-default-model"]) {
    const module = await load(name);
    await ctx.plugin(module.default ?? module, name === "dsh-agent-default-model" ? { provider: "fixture", model: "native-default" } : {}).await();
  }
  const domain = await load("dsh-storage-domain");
  const sdk = createRequire(createRequire(import.meta.url).resolve(peer));
  const storageSdk = createRequire(sdk.resolve("@deepseek-ai/dsh-storage-domain"));
  const storage = await import(pathToFileURL(storageSdk.resolve("@deepseek-ai/dsh-storage")).href);
  await ctx.plugin(storage.default).await();
  ctx.get("storage")!.backend.register("fixture", {
    kv: { async open(descriptor: { tables: readonly string[] }) {
      const tables: Record<string, Record<string, unknown>> = Object.fromEntries(descriptor.tables.map(name => [name, {}]));
      let global: unknown = null;
      return { async loadAll() { return structuredClone({ tables, global }); },
        async putRecord(table: string, key: string, value: unknown) { tables[table][key] = structuredClone(value); },
        async deleteRecord(table: string, key: string) { delete tables[table][key]; },
        async setGlobal(value: unknown) { global = structuredClone(value); }, async close() {} };
    } }, async close() {}
  });
  ctx.provide(storage.storageBackendServiceKey("fixture"), {});
  await ctx.plugin(domain, { backend: "fixture" }).await();
  const workspace = await load("dsh-workspace");
  await ctx.plugin(workspace.default, {}).await();
  const controller = await load("dsh-api-session-controller");
  assert.deepEqual(controller.SessionController.inject.filter((name: string) => ctx.get(name) === undefined), []);
  await ctx.plugin(controller.default, { nativeOpen: false }).await();
  assert.ok(ctx.get("sessionController"));
}
