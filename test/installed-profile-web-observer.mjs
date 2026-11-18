import assert from "node:assert/strict";
import { appendFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const inject = ["web"];

export async function apply(ctx, { cli, profileDir, candidate, evidence }) {
  const record = row => appendFileSync(evidence, `${JSON.stringify(row)}\n`);
  const host = createRequire(cli);
  const web = realpathSync(host.resolve("@deepseek-ai/dsh-web"));
  const { WebRuntime } = await import(pathToFileURL(web));
  assert.ok(ctx.web instanceof WebRuntime, "mounted web runtime must belong to the CLI Host");
  if (candidate) {
    const profile = createRequire(join(profileDir, "package.json"));
    const adapter = realpathSync(profile.resolve("@dsmm/dsmm/web-fetch-fakeip"));
    assert.ok(adapter.startsWith(`${join(profileDir, "node_modules")}${sep}`), `adapter must physically reside in the selected profile: ${adapter}`);
    const installed = createRequire(adapter);
    const modules = {};
    for (const id of ["@deepseek-ai/dsh-web", "@deepseek-ai/dsh-web-fetch-http", "@deepseek-ai/dsh-http-proxy"]) {
      modules[id] = realpathSync(installed.resolve(id));
      assert.equal(modules[id], realpathSync(host.resolve(id)), `candidate and CLI must resolve the same ${id}`);
    }
    record({ adapter, modules });
  } else record({ web });
  ctx.on("session/event", (_session, event) => {
    if (event.type !== "tool/result") return;
    const { message, meta, error } = event.data;
    record({ callId: message.toolCallId, meta, code: error?.code });
  });
}
