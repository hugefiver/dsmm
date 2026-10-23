import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { setImmediate } from "node:timers/promises";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";
import * as Cordis from "@deepseek-ai/cordis";
import { Context } from "@deepseek-ai/cordis";
import type { Service } from "@deepseek-ai/cordis";
import * as ConnectionHost from "@deepseek-ai/dsh-client-connection";
import * as SlotCore from "@deepseek-ai/dsh-client-ui-slots";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import { remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import type * as ConnectionClient from "@deepseek-ai/dsh-client-connection/client";
import type * as RendererClient from "@deepseek-ai/dsh-client-ui-renderer/client";
import type * as LocaleClient from "@deepseek-ai/dsh-client-locale/client";
import type { SlotComponent, ComposedProps } from "@deepseek-ai/dsh-client-ui-slots";
import type { ProfilesInjected } from "../src/client/ProfilesSection.js";
import type { DeploymentPageProps } from "../src/client/DeploymentPage.js";
import { NS, en, zh } from "../src/client/locales.js";
import { DEPLOYMENT_NS, deploymentEn } from "../src/client/deployment-locales.js";
import { registerProfilesRpc } from "../src/profile-rpc.js";
import { ProfileStore } from "../src/profile-store.js";
import { DsmmProfileRuntime } from "../src/profile-runtime.js";
import { resolveConfig } from "../src/settings.js";
import type { DshAgent, DshContext } from "../src/dsh-types.js";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { SessionSnapshot, SessionEventWindow } from "@deepseek-ai/dsh-api-session-controller/client";
import type { StandardSourceBinding } from "@deepseek-ai/dsh-client-ui-slots";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { LlmAttemptId } from "@deepseek-ai/dsh-llm";
import type { SessionProfileSnapshot, SessionProfileSelectRequest } from "../src/profile-types.js";
import { nativeRoutingFixture } from "./native-routing-fixture.ts";

const require = createRequire(import.meta.url);
const sdk = createRequire(process.env.DSMM_TEST_DSH_ENTRY ?? new URL("../package.json", import.meta.url));
const connectionSdk = createRequire(require.resolve("@deepseek-ai/dsh-client-connection"));
const { CredentialProvider } = connectionSdk("@deepseek-ai/dsh-credentials") as { CredentialProvider: new (ctx: Context) => Service };
class MemoryCredentials extends CredentialProvider {
  private readonly records = new Map<string, unknown>();
  async modifyRecord(key: string, modify: (value: unknown) => Promise<unknown>) {
    const next = await modify(this.records.get(key)); if (next !== undefined) this.records.set(key, next); return this.records.get(key);
  }
}
type ClientPlugin = { inject: string[]; apply(ctx: Context): void | Promise<void> };
type StyleNode = { dataset: Record<string, string>; textContent: string; remove(): void };

// Startup-only DOM/render seams. Real SlotRegistry, LocaleRuntime, Connection,
// Gateway, Typert codecs and Cordis fibers run unchanged; this is not browser QA.
function startupDocument() {
  const styles = new Set<StyleNode>();
  return { styles, document: {
    createElement(tag: string): StyleNode {
      assert.equal(tag, "style");
      const node = { dataset: {}, textContent: "", remove() { styles.delete(node); } };
      return node;
    },
    head: { append(node: StyleNode) { styles.add(node); } },
  } };
}
function profileStyles(styles: Set<StyleNode>): number { return [...styles].filter(node => Object.hasOwn(node.dataset, "dsmmProfiles")).length; }
function surfaceStyle(styles: Set<StyleNode>, key: "dsmmProfiles" | "dsmmSettings" | "dsmmRoleToolStyles"): StyleNode {
  const owned = [...styles].filter(node => Object.hasOwn(node.dataset, key));
  assert.equal(owned.length, 1, `${key} owns exactly one live style`);
  return owned[0];
}
function surfaceStyles(styles: Set<StyleNode>) {
  const core = surfaceStyle(styles, "dsmmSettings"), profiles = surfaceStyle(styles, "dsmmProfiles"), roleTool = surfaceStyle(styles, "dsmmRoleToolStyles");
  const owners = [core, profiles, roleTool];
  assert.equal(new Set(owners).size, owners.length, "surfaces have distinct style owners");
  assert.deepEqual(styles, new Set(owners), "no duplicate or unowned client styles");
  return { core, profiles, roleTool };
}

async function nativeClient<T>(packageName: string, document: ReturnType<typeof startupDocument>["document"], sourceOverride?: string, wireRealm?: (parse: (text: string) => unknown) => void): Promise<T> {
  const loadBrowser = async () => {
    const manifestPath = require.resolve(`${packageName}/package.json`);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const entry = manifest.exports["./client"];
    return readFile(join(dirname(manifestPath), entry.browser ?? entry.default), "utf8");
  };
  const source = sourceOverride ?? await loadBrowser();
  let factory: ((require: (id: string) => unknown) => T) | undefined;
  const realm = createContext({ crypto: globalThis.crypto, AbortController, AbortSignal, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout, queueMicrotask, console,
    ...(packageName === "@dsmm/dsmm" ? { document } : {}),
    window: { __ModuleLoader__: { load(row: { factory: typeof factory }) { factory = row.factory; } } },
  });
  runInContext(source, realm);
  wireRealm?.(runInContext('(text) => JSON.parse(text, (_key, value) => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.assign(Object.create(null), value) : value)', realm));
  delete realm.window;
  assert.ok(factory, `${packageName} must register its actual lazy-CJS factory`);
  const notRendering = () => { throw new Error("Startup regression must not pretend to render a browser UI"); };
  return factory((id) => {
    if (id === "@deepseek-ai/cordis") return Cordis;
    if (id === "@deepseek-ai/dsh-client-ui-slots") return SlotCore;
    if (id === "react-dom") return { flushSync: notRendering };
    if (id === "react-dom/client") return { createRoot: notRendering, hydrateRoot: notRendering };
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return { Button: notRendering, Input: notRendering };
    if (id === "@deepseek-ai/dsh-client-store") return require(id);
    assert.ok(["react", "react/jsx-runtime"].includes(id), `unexpected native runtime dependency ${id}`);
    return require(id);
  });
}

const SettingsShell: SlotComponent<ComposedProps<"root", string, "settings.section" | "conversation.header.leading", undefined, object>> = (props) => [props.renderSlot("settings.section", { close() {} }), props.renderSlot("conversation.header.leading", {})];
const PluginsShell: SlotComponent<ComposedProps<"root", string, "plugins.bundle.config", undefined, object>> = props => props.renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: "@dsmm/dsmm" });

let sourceBundle: Promise<string> | undefined;
function currentClientSource(): Promise<string> {
  return sourceBundle ??= build({ entryPoints: [fileURLToPath(new URL("../src/client/index.ts", import.meta.url))], bundle: true, write: false, platform: "browser", format: "cjs", target: "es2022",
    external: ["@deepseek-ai/cordis", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-store", "react", "react/jsx-runtime", "react-dom", "react-dom/client"] })
    .then(result => `window.__ModuleLoader__.load({factory(require){const module={exports:{}};const exports=module.exports;${result.outputFiles[0].text}\nreturn module.exports;}});`);
}

type FixtureRpc = (endpoint: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<Awaited<ReturnType<ConnectionClient.ConnectionHandle["rpc"]["call"]>>> | undefined;
async function fixture(deferUi = false, fixtureRpc?: FixtureRpc, nativeHost?: Context) {
  const root = await mkdtemp(join(tmpdir(), "dsmm-client-startup-"));
  const host = nativeHost ?? new Context();
  const client = new Context();
  const dom = startupDocument();
  try {
    if (nativeHost === undefined) {
      const { RemoteAccessService } = sdk("@deepseek-ai/dsh-api-remote-access");
      await host.plugin(RemoteAccessService).await();
      await host.plugin(MemoryCredentials).await(); await host.plugin(ConnectionHost).await();
      // Operator carrier seams; native Connection peer and Gateway still enforce writes.
      host.provide("webServer", { host: "127.0.0.1" });
      host.provide("settings", { writable: true });
      await Promise.all([host.plugin(TypertRegistry).await(), host.plugin(TypertGatewayService, {}).await()]);
      const store = new ProfileStore(join(root, "dsmm-profiles"));
      const runtime = new DsmmProfileRuntime(host as unknown as DshContext, resolveConfig(), store);
      await runtime.initialize();
      await host.plugin({ name: "native-profile-host", inject: ["typert"], apply(ctx: Context) { registerProfilesRpc(ctx, runtime); } }).await();
    }
    await client.plugin(TypertRegistry).await();
    const gateway = host.typertGateway;
    gateway.registerRemoteEvents(signal => {
      const queue: { event: string; args: unknown[] }[] = [];
      let wake: (() => void) | undefined;
      const stop = host.on("api-session/added", summary => { queue.push({ event: "api-session/added", args: JSON.parse(JSON.stringify([summary])) }); wake?.(); }, { global: true });
      signal.addEventListener("abort", () => { stop(); wake?.(); }, { once: true });
      return (async function* () {
        while (!signal.aborted) {
          const item = queue.shift();
          if (item !== undefined) yield item;
          else await new Promise<void>(resolve => { wake = resolve; });
        }
      })();
    }, { home: "isolated-startup-test" });
    const calls: string[] = [], requests: string[] = [];
    let parseClientJson: (text: string) => unknown = JSON.parse;
    const connection = await nativeClient<typeof ConnectionClient>("@deepseek-ai/dsh-client-connection", dom.document);
    connection.installConnection(client, { interactions: "answer", transport: { ownsHost: true, rpc: {
      async call(channel, endpoint, payload, signal) {
        assert.equal(channel, "/api");
        requests.push(endpoint);
        if (endpoint.startsWith("dsmmProfiles/")) calls.push(endpoint);
        const [namespace, method] = endpoint.split("/");
        // Match the native JSON wire boundary between the isolated client realm
        // and Host codecs; VM-prototype request objects are not Host inputs.
        const args = (JSON.parse(JSON.stringify(payload)) as { args: Record<string, unknown> }).args;
        const response = fixtureRpc?.(endpoint, args, signal);
        const wire = <T,>(value: T): T => parseClientJson(JSON.stringify(value)) as T;
        if (response !== undefined) return response.then(wire);
        try { return wire({ ok: true, value: await gateway.invoke({ namespace, method, args, signal, peer: host.connection.browserPeer }) }); }
        catch (error) {
          const failure = remoteErrorOf(error);
          if (failure === undefined) throw error;
          return wire({ ok: false, error: { code: failure.code, message: failure.message, details: failure.details } });
        }
      },
      async *open(channel, endpoint, payload, signal, uplink) {
        assert.equal(channel, "/api");
        for await (const frame of await gateway.wireStream.open(endpoint, JSON.parse(JSON.stringify(payload)), uplink ?? (async function* () {})(), host.connection.browserPeer, signal)) {
          // Decode arrays in the consuming Gateway realm; strict record values
          // use null prototypes shared by the Gateway and contribution codecs.
          yield parseClientJson(JSON.stringify(frame));
        }
      },
    } } });
    const remoteModule = await nativeClient<ClientPlugin>("@deepseek-ai/dsh-api-gateway", dom.document, undefined, parse => { parseClientJson = parse; });
    const remoteFiber = client.plugin(remoteModule);
    await remoteFiber.await();
    const generation = (client.connection as unknown as ConnectionClient.ConnectionHandle).generation;
    for (let round = 0; round < 1000 && generation.getSnapshot() === undefined; round++) await setImmediate();
    assert.notEqual(generation.getSnapshot(), undefined, "startup fixture establishes the native Remote event generation");
    const renderer = await nativeClient<typeof RendererClient>("@deepseek-ai/dsh-client-ui-renderer", dom.document);
    const locale = await nativeClient<typeof LocaleClient>("@deepseek-ai/dsh-client-locale", dom.document);
    const productionSource = await currentClientSource();
    const production = await nativeClient<ClientPlugin>("@dsmm/dsmm", dom.document, productionSource);
    async function installUi() {
      await client.plugin(renderer).await();
      await client.plugin({ name: "native-standalone-locale", apply(ctx: Context) { ctx.provide("locale", new locale.LocaleRuntime(ctx)); } }).await();
    }
    if (!deferUi) await installUi();
    const entry = client.plugin(production);
    return { host, client, production, entry, remoteFiber, calls, requests, styles: dom.styles, installUi,
      declareSettings: () => client.slots.register({ name: "root", children: { "settings.section": { kind: "list", scope: "root" }, "conversation.header.leading": { kind: "single", scope: "root" } } }, SettingsShell),
      declarePlugins: () => client.slots.register({ name: "root", priority: 1, children: { "plugins.bundle.config": { kind: "keyed", scope: "root" } } }, PluginsShell),
      async dispose() { await client.fiber.dispose(); if (nativeHost === undefined) await host.fiber.dispose(); await rm(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    await client.fiber.dispose(); if (nativeHost === undefined) await host.fiber.dispose(); await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function namespaceChild(f: Awaited<ReturnType<typeof fixture>>, namespace: "dsmmProfiles" | "dsmmConfig" = "dsmmProfiles") {
  const fibers = [...f.client.registry.values()].flatMap((runtime) => [...runtime.fibers]);
  const children = fibers.filter((fiber) => fiber.parent.fiber.uid === f.entry.uid && Object.hasOwn(fiber.inject, `remote.${namespace}`));
  assert.equal(children.length, 1, "the production entry must own exactly one native namespace injection");
  return children[0];
}

function coreFace(f: Awaited<ReturnType<typeof fixture>>): Pick<DeploymentPageProps, "core" | "remote"> {
  const entries = f.client.slots.entries("plugins.bundle.config").filter(entry => entry.options.key === "@dsmm/dsmm");
  assert.equal(entries.length, 1, "one native core registration per declaration lifetime");
  assert.ok(entries[0].inject);
  return entries[0].inject() as unknown as Pick<DeploymentPageProps, "core" | "remote">;
}

function profilesFace(f: Awaited<ReturnType<typeof fixture>>): ProfilesInjected {
  const entries = f.client.slots.entries("settings.section").filter((entry) => entry.options.id === "dsmm-profiles");
  assert.equal(entries.length, 1, "one native settings registration per declaration lifetime");
  assert.ok(entries[0].inject);
  const face = entries[0].inject();
  assert.ok("hooks" in face && "refresh" in face && "save" in face && "apply" in face);
  return face as unknown as ProfilesInjected;
}

async function settled(face: ProfilesInjected): Promise<void> {
  for (let round = 0; round < 1000 && face.hooks.profiles.getSnapshot().busy !== null; round++) await setImmediate();
  assert.equal(face.hooks.profiles.getSnapshot().busy, null, "native profile request must settle");
}

test("native Settings resolves profile labels from the active locale without replacing its section", async () => {
  const f = await fixture();
  try {
    f.declareSettings();
    await f.entry.await();
    await namespaceChild(f).await();
    const rows = f.client.slots.entries("settings.section");
    const profiles = rows.filter(row => row.options.id === "dsmm-profiles");
    assert.equal(profiles.length, 1);
    const section = profiles[0];
    assert.equal(section.options.id, "dsmm-profiles");
    assert.equal(section.options.order, 30);
    assert.equal(section.locale, "settings.dsmm-profiles");
    assert.equal(SlotCore.resolveSlotLabel(section.options.label), en.title);
    f.client.locale.setLocale("zh");
    assert.equal(SlotCore.resolveSlotLabel(section.options.label), zh.title);
    assert.deepEqual(f.client.slots.entries("settings.section"), rows, "changing display locale must preserve the native section registrations");
    f.client.locale.setLocale("en");
    assert.equal(SlotCore.resolveSlotLabel(section.options.label), en.title);
    assert.equal(section.options.id, "dsmm-profiles");
    await settled(profilesFace(f));
  } finally { await f.dispose(); }
});

test("production client activates after mounting the independently injected native profile namespace", async () => {
  const f = await fixture();
  try {
    const collapseSettings = f.declareSettings();
    f.declarePlugins();
    await f.entry.await();
    assert.equal(f.entry.state, 2);
    const child = namespaceChild(f);
    await child.await();
    assert.equal(child.state, 2);
    assert.equal(profileStyles(f.styles), 1);
    surfaceStyles(f.styles);
    assert.equal(f.client.locale.bind(NS)("title"), en.title, "parent locale injection remains available in the native child");
    const face = profilesFace(f);
    await settled(face);
    assert.equal(face.hooks.profiles.getSnapshot().snapshot?.selectionRevision, "absent");
    assert.equal(face.hooks.profiles.getSnapshot().issue, null);
    assert.deepEqual(f.calls, ["dsmmProfiles/describe"]);
    await face.create();
    face.editId("native-startup");
    await face.save();
    assert.equal(face.hooks.profiles.getSnapshot().issue, null);
    assert.equal(face.hooks.profiles.getSnapshot().notice?.key, "saved");
    assert.equal(face.hooks.profiles.getSnapshot().snapshot?.selectedId, null, "saving is not applying");
    await face.apply();
    assert.equal(face.hooks.profiles.getSnapshot().snapshot?.selectedId, "native-startup");
    await collapseSettings();
    assert.equal(f.client.slots.entries("settings.section").length, 0);
    const collapseReplacement = f.declareSettings();
    assert.equal(profilesFace(f).hooks.profiles, face.hooks.profiles, "slot re-arrival does not duplicate the controller");
    await f.entry.dispose();
    assert.equal(f.styles.size, 0);
    assert.equal(f.client.locale.bind(NS)("title"), "title");
    assert.equal(f.client.slots.entries("settings.section").length, 0);
    assert.equal(f.client.get("remote.dsmmProfiles"), undefined, "the mounted contribution belongs to the production entry");
    assert.equal(f.client.slots.entries("plugins.bundle.config").length, 0);
    assert.equal(f.client.slots.entries("conversation.header.leading").length, 0);
    const calls = f.calls.length;
    const snapshot = face.hooks.profiles.getSnapshot();
    await face.refresh(); await face.save(); await face.apply(); await face.reset();
    assert.equal(f.calls.length, calls, "retained actions cannot send requests after their owner disposes");
    assert.equal(face.hooks.profiles.getSnapshot(), snapshot);
    await collapseReplacement();
  } finally { await f.dispose(); }
});

test("profile icon uses the persistent root leading slot at fallback priority and yields to foreign navigation", async () => {
  const f = await fixture();
  try {
    f.declareSettings(); await f.entry.await(); await namespaceChild(f).await();
    const leading = f.client.slots.entries("conversation.header.leading"); assert.equal(leading.length, 1);
    assert.equal(f.client.slots.spec("conversation.header.leading")?.scope, "root");
    assert.equal(leading[0].options.priority, Number.MAX_SAFE_INTEGER, "native lowest-numeric winner gives this entry the lowest precedence");
    assert.deepEqual(f.client.slots.entriesOfSlot("conversation.header.leading"), leading);
    assert.equal(f.client.slots.entries("conversation.session.header.utilities").length, 0, "there is only one profile control, not an active-only duplicate");
    const ForeignNavigation = () => null;
    const withdrawForeign = f.client.slots.register({ name: "conversation.header.leading", priority: 0 }, ForeignNavigation);
    assert.equal(f.client.slots.entriesOfSlot("conversation.header.leading")[0].component, ForeignNavigation, "foreign native navigation remains the active owner");
    withdrawForeign(); assert.equal(f.client.slots.entriesOfSlot("conversation.header.leading")[0], leading[0]);
  } finally { await f.dispose(); }
});

test("production client waits for genuine native UI providers before mounting its namespace", async () => {
  const f = await fixture(true);
  try {
    await f.entry.await();
    assert.equal(f.entry.state, 0);
    assert.equal(f.client.get("remote.dsmmProfiles"), undefined);
    assert.equal(f.styles.size, 0);
    assert.deepEqual(f.calls, []);
    await f.installUi();
    await f.entry.await();
    await namespaceChild(f).await();
    assert.equal(f.entry.state, 2);
    assert.equal(f.client.slots.entries("settings.section").length, 0);
    f.declareSettings();
    await settled(profilesFace(f));
    assert.equal(profileStyles(f.styles), 1);
    surfaceStyles(f.styles);
  } finally { await f.dispose(); }
});

test("native namespace withdrawal disposes its UI and remote re-arrival installs one fresh controller", async () => {
  const f = await fixture();
  try {
    f.declareSettings();
    f.declarePlugins();
    await f.entry.await();
    const child = namespaceChild(f);
    await child.await();
    const old = profilesFace(f);
    await settled(old);
    const styles = surfaceStyles(f.styles), core = coreFace(f);
    const coreChild = namespaceChild(f, "dsmmConfig");
    await coreChild.await();
    let notifications = 0;
    old.hooks.profiles.subscribe(() => notifications++);
    const namespace = [...f.client.registry.values()].flatMap((runtime) => [...runtime.fibers])
      .find((fiber) => fiber.runtime?.name === "remote.dsmmProfiles");
    assert.ok(namespace);
    await namespace.dispose();
    await child.await();
    assert.equal(child.state, 0, "only the namespace-dependent child stops when that service withdraws");
    assert.equal(f.entry.state, 2);
    assert.equal(f.client.get("remote.dsmmProfiles"), undefined);
    assert.equal(profileStyles(f.styles), 0);
    assert.deepEqual(f.styles, new Set([styles.core, styles.roleTool]), "named withdrawal preserves the core and parent RoleTool style owners");
    assert.equal(coreChild.state, 2);
    assert.equal(coreFace(f).core, core.core);
    assert.equal(f.client.locale.bind(DEPLOYMENT_NS)("title"), deploymentEn.title);
    assert.equal(f.client.locale.bind(NS)("title"), "title");
    assert.equal(f.client.slots.entries("settings.section").some(row => row.options.id === "dsmm-profiles"), false);
    assert.equal(f.client.slots.entries("conversation.header.leading").length, 0);
    const coreItems = f.client.slots.entries("plugins.bundle.config");
    assert.equal(coreItems.length, 1, "sessionless Plugins core survives named namespace withdrawal");
    assert.equal(coreItems[0].options.key, "@dsmm/dsmm");
    assert.equal(f.client.get("uiSession"), undefined);
    assert.equal(f.client.get("sessions"), undefined);
    const calls = f.calls.length;
    const snapshot = old.hooks.profiles.getSnapshot();
    await old.refresh(); await old.save(); await old.apply(); await old.reset();
    assert.equal(f.calls.length, calls);
    assert.equal(old.hooks.profiles.getSnapshot(), snapshot);
    assert.equal(notifications, 0);
    // Recreate the genuine Gateway provider, not a fabricated namespace value.
    await f.remoteFiber.restart();
    await f.entry.await();
    const replacement = namespaceChild(f);
    await replacement.await();
    assert.equal(replacement.state, 2);
    const current = profilesFace(f);
    assert.notEqual(current.hooks.profiles, old.hooks.profiles);
    await settled(current);
    assert.equal(current.hooks.profiles.getSnapshot().issue, null);
    const replacementStyles = surfaceStyles(f.styles);
    assert.notEqual(replacementStyles.profiles, styles.profiles);
    coreFace(f);
    assert.equal(f.client.slots.entries("conversation.header.leading").length, 1);
    assert.equal(f.client.locale.bind(NS)("title"), en.title);
    assert.deepEqual(f.calls, ["dsmmProfiles/describe", "dsmmProfiles/describe"]);
    const returnedCalls = f.calls.length;
    await old.refresh(); await old.save(); await old.apply(); await old.reset();
    assert.equal(f.calls.length, returnedCalls, "remote return cannot revive a disposed profile controller");
    assert.equal(old.hooks.profiles.getSnapshot(), snapshot);
    assert.equal(notifications, 0);
  } finally { await f.dispose(); }
});

test("dsmmConfig withdrawal isolates its native surface and remote return does not duplicate controllers", async () => {
  const f = await fixture();
  try {
    f.declareSettings(); f.declarePlugins();
    await f.entry.await();
    const fibers = { core: namespaceChild(f, "dsmmConfig"), profiles: namespaceChild(f) };
    await Promise.all(Object.values(fibers).map(fiber => fiber.await()));
    const styles = surfaceStyles(f.styles), core = coreFace(f), profiles = profilesFace(f);
    await settled(profiles);
    const provider = [...f.client.registry.values()].flatMap(runtime => [...runtime.fibers]).find(fiber => fiber.runtime?.name === "remote.dsmmConfig");
    assert.ok(provider);
    await provider.dispose();
    await Promise.all(Object.values(fibers).map(fiber => fiber.await()));
    assert.equal(f.entry.state, 2);
    assert.equal(f.client.get("remote.dsmmConfig"), undefined);
    assert.equal(fibers.profiles.state, 2);
    assert.equal(profilesFace(f).hooks.profiles, profiles.hooks.profiles);
    assert.equal(f.client.slots.entries("conversation.header.leading").length, 1);
    assert.equal(f.client.locale.bind(NS)("title"), en.title);
    const requests = f.requests.length;
    assert.equal(fibers.core.state, 0);
    assert.deepEqual(f.styles, new Set([styles.profiles, styles.roleTool]), "core withdrawal preserves the profiles and parent RoleTool style owners");
    assert.equal(f.client.locale.bind(DEPLOYMENT_NS)("title"), "title");
    const snapshot = core.core.getSnapshot();
    await core.core.refresh();
    assert.equal(core.core.getSnapshot(), snapshot, "retained core actions are inert after withdrawal");
    assert.equal(f.requests.length, requests, "withdrawn controllers cannot send native requests");
    await f.remoteFiber.restart(); await f.entry.await();
    await Promise.all([namespaceChild(f).await(), namespaceChild(f, "dsmmConfig").await()]);
    const replacementStyles = surfaceStyles(f.styles), currentCore = coreFace(f);
    await settled(profilesFace(f));
    assert.notEqual(currentCore.core, core.core);
    assert.notEqual(replacementStyles.core, styles.core);
    assert.equal(f.client.slots.entries("conversation.header.leading").length, 1);
    assert.equal(f.client.locale.bind(DEPLOYMENT_NS)("title"), deploymentEn.title);
    const returnedRequests = f.requests.length, coreSnapshot = core.core.getSnapshot();
    await core.core.refresh();
    assert.equal(f.requests.length, returnedRequests, "remote return cannot revive disposed controllers");
    assert.equal(core.core.getSnapshot(), coreSnapshot);
  } finally { await f.dispose(); }
});

test("unloading the client cancels a namespace-owned pending settings declaration wait", async () => {
  const f = await fixture();
  try {
    await f.entry.await();
    await namespaceChild(f).await();
    assert.equal(profileStyles(f.styles), 1);
    await f.entry.dispose();
    assert.equal(f.styles.size, 0);
    f.declareSettings();
    assert.equal(f.client.slots.entries("settings.section").length, 0);
    assert.equal(f.client.locale.bind(NS)("title"), "title");
  } finally { await f.dispose(); }
});

test("current native Session running transition rereads stale busy capability before allowing Profile CAS", async () => {
  const id = SessionId("started-native-root"), writes: SessionProfileSelectRequest[] = [];
  const selection = { selectedId: null, appliedRevision: null, selectionRevision: "absent" } as const;
  const busy: SessionProfileSnapshot = { sessionId: id, admissionEpoch: "live-epoch", selection, admittedSelection: selection, globalDefault: selection,
    scope: "global-default", switchAllowed: false, canApplyOverlay: false, applyOverlayUnavailableReason: "new-session-required", canToggleMode: false, toggleModeUnavailableReason: "busy", canSelectModel: false };
  let actual = busy, reads = 0;
  const f = await fixture(false, (endpoint, args) => {
    if (endpoint === "dsmmProfiles/describeSession") { reads++; return Promise.resolve({ ok: true, value: actual }); }
    if (endpoint === "dsmmProfiles/selectSession") { writes.push(args.request as SessionProfileSelectRequest); return Promise.resolve({ ok: true, value: actual }); }
  });
  const session = createSnapshotStore<SessionSnapshot>({ sessionId: id, running: true, pendingSubmissions: [], subagent: null, removed: false,
    openState: "open", openError: null, hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null, promptAttempted: true, awaitingFirstTurn: false });
  const current = createSnapshotStore<StandardSourceBinding>({ key: id, hooks: {}, keyedHooks: {}, props: {} });
  const eventSource = createSnapshotStore<SessionEventWindow>({ entries: [], revision: 0, hasMore: false, change: { kind: "replace", entries: [] } });
  const binding = { sessionId: id, session, eventSource };
  try {
    f.client.provide("sessions", { binding: (key: string) => key === id ? binding : undefined,
      list: createSnapshotStore({ ids: [id], byId: { [id]: {} } }) } as unknown as Context["sessions"]);
    f.client.provide("uiSession", { adapter: { current } } as unknown as Context["uiSession"]);
    f.declareSettings(); await f.entry.await(); await namespaceChild(f).await();
    const face = profilesFace(f);
    for (let round = 0; round < 1000 && (reads === 0 || face.hooks.profiles.getSnapshot().sessionBusy !== null); round++) await setImmediate();
    assert.equal(reads, 1); assert.equal(face.hooks.profiles.getSnapshot().session?.canApplyOverlay, false);
    eventSource.set({ ...eventSource.getSnapshot(), revision: 1, change: { kind: "settle-assistant", attemptId: LlmAttemptId("settled-attempt") } });
    const row = { type: "event" as const, event: Session.create(id).append("turn/end", { turn: 1, reason: { kind: "completed" } }) };
    eventSource.set({ ...eventSource.getSnapshot(), entries: [row], revision: 2, change: { kind: "append", entries: [row] } });
    current.set({ ...current.getSnapshot() });
    await setImmediate();
    assert.equal(reads, 1); assert.equal(session.getSnapshot().running, true);
    actual = { ...busy, switchAllowed: true, canApplyOverlay: true, applyOverlayUnavailableReason: undefined, canToggleMode: true, toggleModeUnavailableReason: undefined };
    session.set({ ...session.getSnapshot(), running: false });
    current.set({ ...current.getSnapshot() });
    for (let round = 0; round < 1000 && face.hooks.profiles.getSnapshot().sessionBusy !== null; round++) await setImmediate();
    assert.equal(reads, 2, "the exact Session observable must refresh capabilities after its driver stops");
    assert.equal(face.hooks.profiles.getSnapshot().session?.canApplyOverlay, true);
    await face.resetSession();
    assert.deepEqual(writes, [{ sessionId: id, id: null, expectedSelectionRevision: "absent", expectedAdmissionEpoch: "live-epoch" }]);
  } finally { await f.dispose(); }
});

test("historical open idle binding recovers after native Agent admission through the Remote added channel", async t => {
 for (const timing of ["after-error", "before-error"] as const) await t.test(timing, async child => {
  const native = await nativeRoutingFixture({}, { headless: true, controller: true, nativePermissionSettings: true });
  native.ctx.provide("webServer", { host: "127.0.0.1" });
   let admit!: () => void;
   const admission = new Promise<void>(resolve => { admit = resolve; });
   if (timing === "after-error") {
     const runtime = native.ctx.get("dsmmProfileRuntime") as unknown as DsmmProfileRuntime;
     const prepare = runtime.prepareRoot.bind(runtime);
     child.mock.method(runtime, "prepareRoot", async (...args: Parameters<DsmmProfileRuntime["prepareRoot"]>) => { await admission; return prepare(...args); });
   }
  let releaseError!: () => void, captured!: () => void, first = true;
  const errorDelivery = new Promise<void>(resolve => { releaseError = resolve; });
  const errorCaptured = new Promise<void>(resolve => { captured = resolve; });
  const f = await fixture(false, (endpoint, args) => {
    if (timing !== "before-error" || endpoint !== "dsmmProfiles/describeSession" || !first) return;
    first = false;
    return (async () => {
      try { await native.ctx.typertGateway.invoke({ namespace: "dsmmProfiles", method: "describeSession", args, peer: native.ctx.connection.browserPeer }); }
      catch (error) {
        const failure = remoteErrorOf(error); assert.ok(failure);
        captured(); await errorDelivery;
        return { ok: false as const, error: { code: failure.code, message: failure.message, details: failure.details } };
      }
      throw new Error("The historical Agent must not be ready at the first read");
    })();
   }, native.ctx);
  const id = SessionId("history-before-native-agent");
  const session = createSnapshotStore<SessionSnapshot>({ sessionId: id, running: false, pendingSubmissions: [], subagent: null, removed: false,
    openState: "open", openError: null, hasMore: false, loadingOlder: false, promptError: null, blank: false, lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false });
  const current = createSnapshotStore<StandardSourceBinding>({ key: id, hooks: {}, keyedHooks: {}, props: {} });
   const binding = { sessionId: id, session };
   let creating: ReturnType<typeof native.create> | undefined;
   let statuses = 0;
   const summaries: { available: boolean; admitted: boolean }[] = [];
   native.ctx.on("api-session/status", () => { statuses++; }, { global: true });
  try {
    f.client.provide("sessions", { binding: (key: string) => key === id ? binding : undefined } as unknown as Context["sessions"]);
    f.client.provide("uiSession", { adapter: { current } } as unknown as Context["uiSession"]);
    f.declareSettings(); await f.entry.await(); await namespaceChild(f).await();
    const face = profilesFace(f);
    if (timing === "before-error") await errorCaptured;
    else {
      for (let i = 0; i < 1000 && (f.calls.filter(call => call.endsWith("/describeSession")).length === 0 || face.hooks.profiles.getSnapshot().sessionBusy !== null); i++) await setImmediate();
      assert.equal(face.hooks.profiles.getSnapshot().sessionIssue?.kind, "domain");
      assert.equal(face.hooks.profiles.getSnapshot().sessionIssue?.field, "sessionId");
    }
    const waiting = face.hooks.profiles.getSnapshot().sessionReadinessPending;
     const runtime = native.ctx.get("dsmmProfileRuntime") as unknown as DsmmProfileRuntime;
     f.client.remote.$on("api-session/added", summary => {
       const agent = native.agents.get(id);
       if (summary.sessionId === id) summaries.push({ available: summary.agentAvailable, admitted: agent !== undefined && runtime.hasAdmission(agent as unknown as DshAgent) });
     });
     creating = native.create({}, undefined, { sessionId: id });
     if (timing === "after-error") {
       for (let i = 0; i < 1000 && face.hooks.profiles.getSnapshot().sessionIssue?.code !== "activation"; i++) await setImmediate();
       assert.equal(face.hooks.profiles.getSnapshot().sessionIssue?.code, "activation", "the first native true must query immediately, before admission completes");
       assert.equal(face.hooks.profiles.getSnapshot().sessionReadinessPending, false, "activation is immediately visible");
       assert.equal(f.calls.filter(call => call.endsWith("/describeSession")).length, 2);
     }
     admit();
     const agent = await creating;
     for (let i = 0; i < 1000 && summaries.length < 2; i++) await setImmediate();
     assert.deepEqual(summaries.map(summary => summary.available), [true, true]);
     assert.equal(summaries[1].admitted, true);
     if (timing === "after-error") assert.equal(summaries[0].admitted, false);
     releaseError();
    for (let i = 0; i < 1000 && face.hooks.profiles.getSnapshot().session === null; i++) await setImmediate();
    assert.equal(face.hooks.profiles.getSnapshot().session?.sessionId, agent.id, "same idle binding must recover without navigation or prompt");
    if (timing === "after-error") assert.equal(waiting, true);
    assert.equal(face.hooks.profiles.getSnapshot().sessionIssue, null);
    assert.equal(face.hooks.profiles.getSnapshot().sessionReadinessPending, false);
    assert.equal(session.getSnapshot().running, false);
     assert.equal(f.calls.filter(call => call.endsWith("/describeSession")).length, timing === "after-error" ? 3 : 2);
     assert.equal(statuses, 0);
    assert.ok(f.calls.every(call => ["dsmmProfiles/describe", "dsmmProfiles/describeSession"].includes(call)));
    assert.equal(native.adapter.calls.length, 0);
   } finally { admit(); releaseError(); await creating?.catch(() => {}); await f.dispose(); await native.dispose(); }
 });
});
