import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { useIsolatedDshEnvironment } from "./dsh-test-environment.ts";

useIsolatedDshEnvironment();
import type {
  AgentRequestErrorFrame,
  AgentTurnStoppingFrame,
  DshEpochHeader,
  DshGoalChangeEventData,
  DshGoalSnapshot,
  DshLlmFailure,
  DshRequestErrorAction,
  DshRequestHeaderEventData,
  DshStepBoundaryEventData,
  DshTodoItem,
  DshTodoWriteEventData,
  DsmmStatusSnapshot,
  DsmmRecoveryRoute,
  DsmmModelRoute,
  DsmmRoleRoutingConfig,
  DsmmRuntimeRecoverySettings,
  DurableRecoveryWork,
  RecoveryFailureDecision
} from "../src/index.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const publicRuntimeRecoveryTypes = null as unknown as [
  RecoveryFailureDecision,
  DurableRecoveryWork,
  DsmmRecoveryRoute,
  DsmmModelRoute,
  DsmmRoleRoutingConfig,
  DsmmRuntimeRecoverySettings,
  DshLlmFailure,
  DshEpochHeader,
  AgentRequestErrorFrame,
  DshRequestErrorAction,
  AgentTurnStoppingFrame,
  DshStepBoundaryEventData,
  DshRequestHeaderEventData,
  DshTodoItem,
  DshTodoWriteEventData,
  DshGoalSnapshot,
  DshGoalChangeEventData,
  DsmmStatusSnapshot
];
void publicRuntimeRecoveryTypes;

test("public package entries resolve delivered files and expose native bundle configuration", () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

  assert.equal(pkg.name, "@dsmm/dsmm");
  assert.equal(Object.hasOwn(pkg, "private"), false);
  assert.deepEqual(pkg.publishConfig, { registry: "https://registry.npmjs.org/", access: "public" });
  assert.equal(pkg.type, "module");
  assert.equal(pkg.main, "./lib/index.js");
  assert.equal(pkg.types, "./lib/index.d.ts");
  for (const [entry, target] of Object.entries(pkg.exports)) {
    const specifier = entry === "." ? pkg.name : `${pkg.name}${entry.slice(1)}`;
    const resolved = fileURLToPath(import.meta.resolve(specifier));
    assert.equal(existsSync(resolved), true, entry);
    if (target !== null && typeof target === "object" && "types" in target) {
      const declaration: unknown = target.types;
      assert.ok(typeof declaration === "string", `${entry} types target`);
      assert.equal(existsSync(join(packageRoot, declaration)), true, declaration);
    }
  }
  assert.equal(Object.hasOwn(pkg, "browser"), false);
  assert.equal(Object.hasOwn(pkg.exports, "./typert"), false, "Host registers its owned Typert contribution explicitly, without auto-loading a duplicate");
  assert.equal(Object.keys(pkg.dependencies).some((name) => /react|esbuild|playwright/iu.test(name)), false, "browser tooling is not a server runtime dependency");

  assert.deepEqual(pkg.dsh, { client: { platform: "web", inject: ["@deepseek-ai/dsh-api-gateway", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-renderer"], external: [] }, bundle: { patch: "./cordis.patch.yml" } });
});

test("exported native plugin metadata displays DSMM Core in both languages without renaming the package", () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, "@dsmm/dsmm");
  for (const language of ["en", "zh"]) {
    const resource = `locale/${language}.json`;
    assert.equal(pkg.exports[`./${resource}`], `./${resource}`);
    const metadata = JSON.parse(readFileSync(join(packageRoot, resource), "utf8"));
    assert.deepEqual(Object.keys(metadata), ["meta"]);
    assert.deepEqual(Object.keys(metadata.meta).sort(), ["description", "title"]);
    assert.equal(metadata.meta.title, "DSMM");
    assert.equal(typeof metadata.meta.description, "string");
    assert.ok(metadata.meta.description.trim().length > 0);
  }
});

test("README local documentation links are shipped by the package", () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
  const localDocs = [...new Set([...readme.matchAll(/\[[^\]]+\]\((docs\/[^)#]+)\)/gu)].map((match) => match[1]))];

  for (const path of localDocs) {
    assert.ok(pkg.files.includes(path), `${path} is included in package files`);
    assert.equal(existsSync(join(packageRoot, path)), true, `${path} exists`);
  }
});

test("source entry exports a dsh plugin function and config schema", async () => {
  const mod = await import("../src/index.js");
  assert.equal(mod.name, "dsmm");
  assert.deepEqual(mod.inject, ["profileContext", "agents"]);
  assert.equal(typeof mod.Config, "function");
  assert.equal(typeof mod.Config.toJSON, "function");
  assert.equal(typeof mod.apply, "function");
  assert.equal(mod.default.name, mod.name);
  assert.deepEqual(mod.default.inject, mod.inject);
  assert.equal(mod.default.Config, mod.Config);
  assert.equal(typeof mod.default.apply, "function");
  for (const name of [
    "classifyModelFamily",
    "registerModelRouting",
    "resolveSelectedAgentPreset",
    "classifyRecoveryFailure",
    "foldAttemptedRecoveryRoutes",
    "foldDurableRecoveryWork",
    "selectFallbackRoute",
    "registerRuntimeRecovery"
  ]) {
    assert.equal(typeof mod[name as keyof typeof mod], "function", name);
  }
  assert.equal(mod.DSMM_STATUS_COMMAND, "dsmm-status");
  assert.equal(mod.DSMM_STATUS_VERSION, 1);
  assert.equal(typeof mod.createDsmmStatusSnapshot, "function");
  assert.equal(typeof mod.formatDsmmStatus, "function");
  assert.equal(typeof mod.registerDsmmStatusCommand, "function");
  assert.equal(existsSync(join(packageRoot, "lib", "status.js")), true);
  assert.equal(existsSync(join(packageRoot, "lib", "status.d.ts")), true);
});

test("default Loader entry awaits initialization and propagates its rejection", async (t) => {
  const mod = await import("../src/index.js");
  const ctx = new Context();
  const pluginContext: Pick<Context, "get"> = ctx;
  let rejectDesired!: (reason: unknown) => void;
  const desired = new Promise<never>((_resolve, reject) => { rejectDesired = reject; });
  t.mock.method(mod.DsmmDeploymentConfig.prototype, "readDesired", () => desired);
  try {
    const completion = mod.default.apply(pluginContext, {});
    assert.ok(completion && typeof completion.then === "function");
    let settled = false;
    void completion.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    const failure = new Error("initialization failed");
    const rejected = assert.rejects(completion, (error: unknown) => error === failure);
    rejectDesired(failure);
    await rejected;
  } finally {
    await ctx.fiber.dispose();
  }
});

test("source includes the deepwork session event augmentation", () => {
  const declarations = readFileSync(join(packageRoot, "src", "dsh-events.ts"), "utf8");
  const entrypoint = readFileSync(join(packageRoot, "src", "index.ts"), "utf8");

  assert.match(declarations, /deepwork\/mode/);
  assert.match(entrypoint, /dsh-events\.js/);
});

test("source and generated root entry declare the public status type contract", () => {
  const sourceEntrypoint = readFileSync(join(packageRoot, "src", "index.ts"), "utf8");
  const generatedEntrypoint = readFileSync(join(packageRoot, "lib", "index.d.ts"), "utf8");
  const generatedStatusRuntime = readFileSync(join(packageRoot, "lib", "status.js"), "utf8");
  const generatedStatusDeclarations = readFileSync(join(packageRoot, "lib", "status.d.ts"), "utf8");

  assert.match(sourceEntrypoint, /export type \{ DsmmStatusSnapshot \} from "\.\/status\.js"/u);
  assert.match(generatedEntrypoint, /export \{ DSMM_STATUS_COMMAND, registerDsmmStatusCommand \} from "\.\/commands\.js"/u);
  assert.match(generatedEntrypoint, /export \{ DSMM_STATUS_VERSION, createDsmmStatusSnapshot, formatDsmmStatus \} from "\.\/status\.js"/u);
  assert.match(generatedEntrypoint, /export type \{ DsmmStatusSnapshot \} from "\.\/status\.js"/u);
  assert.match(generatedStatusRuntime, /export const DSMM_STATUS_VERSION = 1;/u);
  assert.match(generatedStatusDeclarations, /export declare const DSMM_STATUS_VERSION: 1;/u);
  assert.match(generatedStatusDeclarations, /export interface DsmmStatusSnapshot/u);
});

test("compiled package includes native client and profile runtime assets without deployment definitions", () => {
  for (const name of ["profiles", "profile-types", "profile-store", "profile-runtime", "profile-rpc", "profile-remote", "session-metadata"]) {
    for (const extension of ["js", "d.ts"]) {
      assert.equal(existsSync(join(packageRoot, "lib", `${name}.${extension}`)), true, `${name}.${extension}`);
    }
  }
  assert.equal(existsSync(join(packageRoot, "lib", "client.js")), true);
  assert.equal(existsSync(join(packageRoot, "lib", "client", "index.d.ts")), true);
  const patch = readFileSync(join(packageRoot, "cordis.patch.yml"), "utf8");
  assert.doesNotMatch(patch, /^\s*(?:profiles|runtimeProfiles|selectedProfile|profileDefinitions):/mu);
  const remote = readFileSync(join(packageRoot, "lib", "profile-remote.js"), "utf8");
  assert.match(remote, /TYPERT_REMOTE/u);
  assert.match(remote, /TYPERT_HOST/u);
  assert.doesNotMatch(remote, /["']node:|profile-store\.js|settings\.js/u, "remote descriptor is browser-safe wire data, not Host configuration");
  const rpc = readFileSync(join(packageRoot, "lib", "profile-rpc.js"), "utf8");
  assert.match(rpc, /typert\.register\(TYPERT_HOST\)/u);
  assert.match(rpc, /invocation\.peer/u, "profile management requires a native authenticated invocation peer");
});
