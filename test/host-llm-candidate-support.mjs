import assert from "node:assert/strict";

/** Source-candidate runtime checks only; this does not produce release acceptance proof. */
export function inspectSourceCandidateRuntime(ctx, { mode = "default", deliveryFenceReady = true, deepworkMounted = true } = {}) {
  assert.ok(["default", "stock", "manual"].includes(mode));
  const entries = [...ctx.loader.entries()];
  const one = (id, name) => {
    const rows = entries.filter(entry => entry.options.id === id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].options.name, name);
    return rows[0];
  };
  const stock = one("subagent", "@deepseek-ai/dsh-subagent");
  const auto = one("dsmm-auto-subagent-runtime", "@dsmm/dsmm/subagent-runtime");
  const main = one("dsmm", "@dsmm/dsmm");
  const managed = entries.filter(entry => entry.options.name === "@dsmm/dsmm/subagent-runtime");
  assert.equal(managed.length, mode === "manual" ? 2 : 1);
  assert.equal(entries.filter(entry => entry.options.name === "@dsmm/dsmm").length, 1);
  assert.equal(main.fiber.state, 2);
  const owner = mode === "stock" ? stock : mode === "manual"
    ? one("dsmm-subagent-runtime", "@dsmm/dsmm/subagent-runtime") : auto;
  const loaded = [stock, ...managed].filter(entry => entry.fiber?.state === 2);
  assert.deepEqual(loaded, [owner], "The source candidate must have exactly one loaded runtime owner");
  for (const entry of [stock, ...managed]) assert.equal(entry.disabled, entry !== owner);
  assert.equal(entries.some(entry => entry.options.name === "@dsmm/dsmm/legacy-read-host"), false);
  const binding = ctx.get("dsmmProfileRuntime").getSettings.subagentRuntime();
  assert.equal(binding.binding, mode === "stock" ? "stock" : "dsmm");
  assert.equal(binding.desiredEnabled, mode !== "stock");
  assert.equal(binding.restartRequired, false);
  assert.equal(binding.deliveryFenceReady, mode !== "stock" && deepworkMounted && deliveryFenceReady);
  const integration = ctx.get("dsmmRuntimeIntegration");
  if (mode === "stock" || !deepworkMounted) assert.equal(integration, undefined);
  else {
    assert.ok(integration);
    assert.equal(integration.legacyRead, undefined);
    assert.equal(integration.runtime.authority.view().deliveryFenceReady, deliveryFenceReady);
  }
}
