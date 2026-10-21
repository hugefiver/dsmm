import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { WebError, WebRuntime } from "@deepseek-ai/dsh-web";
import { HttpFetchProvider } from "@deepseek-ai/dsh-web-fetch-http";
import type { HttpFetchLimits } from "@deepseek-ai/dsh-web-fetch-http";
import { installProxyFromEnvironment, proxyRouteFor } from "@deepseek-ai/dsh-http-proxy";
import * as FakeIpPlugin from "../src/web-fetch-fakeip.ts";
import { FakeIpHttpFetchProvider, FETCH_PROVIDER_ID } from "../src/web-fetch-fakeip.ts";

const result = { url: "http://example.invalid/", statusCode: 404, body: { kind: "text" as const, content: "missing" }, truncated: false };
const limits: HttpFetchLimits = { maxResponseBytes: 100, maxBodyChars: 80, timeoutMs: 2_000, maxRedirects: 3, userAgent: "dsmm-native-test" };
function proxyEnvironment(values: Record<string, string>) {
  return { get(name: string) { const value = values[name]; return value === undefined ? undefined : { value }; } };
}

test("explicit native web selection consumes this plugin and disposal unregisters it", async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(WebRuntime, { fetchProvider: FETCH_PROVIDER_ID }).await();
  await assert.rejects(ctx.web.fetch({ url: result.url }), { code: "WEB_PROVIDER_CONFIGURED_MISSING" });
  const fetch = t.mock.method(HttpFetchProvider.prototype, "fetch", async () => result);
  const plugin = ctx.plugin(FakeIpPlugin, {});
  await plugin.await();
  assert.deepEqual(await ctx.web.fetch({ url: result.url }), result);
  assert.equal(fetch.mock.callCount(), 1);
  await plugin.dispose();
  await assert.rejects(ctx.web.fetch({ url: result.url }), { code: "WEB_PROVIDER_CONFIGURED_MISSING" });
});

test("the adapter does not claim the native http ID or alter its selection", async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(WebRuntime, { fetchProvider: "http" }).await();
  await ctx.plugin(FakeIpPlugin, {}).await();
  const native = new HttpFetchProvider(limits);
  const fetch = t.mock.method(native, "fetch", async () => result);
  ctx.web.registerFetchProvider(native);
  assert.equal(new FakeIpHttpFetchProvider().available(), true);
  assert.deepEqual(await ctx.web.fetch({ url: result.url }), result);
  assert.equal(fetch.mock.callCount(), 1);
});

test("proxied Fake-IP/mapped literals and local-deny domains fail before native provider invocation", async t => {
  const restore = await installProxyFromEnvironment(proxyEnvironment({ HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" }), () => {});
  t.after(restore);
  const fetch = t.mock.method(HttpFetchProvider.prototype, "fetch", async () => result);
  for (const url of ["http://198.18.0.0/", "http://198.18.255.255/", "https://[::ffff:198.18.0.1]/"]) {
    assert.equal(proxyRouteFor(new URL(url)).proxied, true);
    await assert.rejects(new FakeIpHttpFetchProvider().fetch({ url }), { code: "WEB_FAKEIP_PROXY_UNSUPPORTED" });
  }
  await assert.rejects(new FakeIpHttpFetchProvider({ denyCidrs: ["198.18.0.0/16"] }).fetch({ url: "http://example.invalid/" }), { code: "WEB_FAKEIP_PROXY_UNSUPPORTED" });
  for (const url of ["http://198.19.0.1/", "http://10.0.0.1/", "http://[::ffff:127.0.0.1]/", "http://[64:ff9b::a00:1]/"]) {
    await assert.rejects(new FakeIpHttpFetchProvider().fetch({ url }), { code: "WEB_BLOCKED_URL" });
  }
  assert.equal(fetch.mock.callCount(), 0);
  // A proxy-domain request with no additional local deny is delegated, not
  // represented as locally validated DNS or as a direct Fake-IP connection.
  assert.deepEqual(await new FakeIpHttpFetchProvider().fetch({ url: "http://example.invalid/" }), result);
  assert.equal(fetch.mock.callCount(), 1);
});

test("explicit direct routing may delegate the Fake-IP literal but deny and cancellation still dominate", async t => {
  const restore = await installProxyFromEnvironment(proxyEnvironment({ HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "198.18.0.1" }), () => {});
  t.after(restore);
  const fetch = t.mock.method(HttpFetchProvider.prototype, "fetch", async () => result);
  const url = "http://198.18.0.1/";
  assert.equal(proxyRouteFor(new URL(url)).proxied, false);
  await new FakeIpHttpFetchProvider().fetch({ url });
  await assert.rejects(new FakeIpHttpFetchProvider({ denyCidrs: ["198.18.0.0/16"] }).fetch({ url }), { code: "WEB_BLOCKED_URL" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new FakeIpHttpFetchProvider().fetch({ url }, controller.signal), { code: "WEB_ABORTED" });
  assert.equal(fetch.mock.callCount(), 1);
});

test("the actual native resolver call enforces mixed answers and retains timeout classification", async () => {
  const mixed = new FakeIpHttpFetchProvider({}, async () => [{ address: "198.18.0.1", family: 4 }, { address: "10.0.0.1", family: 4 }]);
  await assert.rejects(mixed.fetch({ url: "http://dsmm-address-test.invalid/" }), { code: "WEB_BLOCKED_URL" });
  const timeout = new FakeIpHttpFetchProvider({ timeoutMs: 20 }, async () => new Promise(() => {}));
  // The native deadline is unref'ed; keep the test process alive until it fires.
  const keepAlive = setInterval(() => {}, 1_000);
  try { await assert.rejects(timeout.fetch({ url: "http://dsmm-address-test.invalid/" }), { code: "WEB_FETCH_TIMEOUT" }); }
  finally { clearInterval(keepAlive); }
});

test("IPv6 literal redirects cannot dispatch a second hop after proxy policy changes during DNS64 discovery", async t => {
  const { Agent, MockAgent } = createRequire(import.meta.resolve("@deepseek-ai/dsh-web-fetch-http"))("undici");
  const mock = new MockAgent();
  mock.disableNetConnect();
  const origin = "http://[2606:4700:4700::1111]";
  const url = `${origin}/start`;
  mock.get(origin).intercept({ path: "/start" }).reply(302, "", { headers: { location: "/next" } });
  mock.get(origin).intercept({ path: "/next" }).reply(200, "accepted", { headers: { "content-type": "text/plain" } });
  const dispatches: { path: string; viaProxy: boolean }[] = [];
  t.mock.method(Agent.prototype, "dispatch", function (this: object, options: { origin: string | URL; path: string }, handler: unknown) {
    const route = proxyRouteFor(new URL(options.origin));
    dispatches.push({ path: options.path, viaProxy: route.proxied && route.dispatcher === this });
    return mock.get(String(options.origin)).dispatch(options, handler);
  });
  const restoreDirect = await installProxyFromEnvironment(proxyEnvironment({}), () => {});
  let restoreProxy: (() => Promise<void>) | undefined;
  try {
    assert.equal(proxyRouteFor(new URL(url)).proxied, false);
    const provider = new FakeIpHttpFetchProvider({}, async hostname => {
      assert.equal(hostname, "ipv4only.arpa");
      restoreProxy = await installProxyFromEnvironment(proxyEnvironment({ HTTP_PROXY: "http://127.0.0.1:9" }), () => {});
      return [{ address: "192.0.0.170", family: 4 }, { address: "192.0.0.171", family: 4 }];
    });
    let responseStatus: number | undefined;
    let failure: unknown;
    try { responseStatus = (await provider.fetch({ url })).statusCode; }
    catch (error) { failure = error; }
    assert.equal(responseStatus, undefined, JSON.stringify({ responseStatus, dispatches }));
    assert.ok(failure instanceof WebError);
    assert.equal(failure.code, "WEB_REDIRECT_BLOCKED", JSON.stringify({ dispatches, error: String(failure), cause: String(failure.cause) }));
    assert.deepEqual(dispatches, [{ path: "/start", viaProxy: false }]);
    assert.equal(proxyRouteFor(new URL(url)).proxied, true);
    await assert.rejects(provider.fetch({ url }), { code: "WEB_FAKEIP_PROXY_UNSUPPORTED" });
    assert.equal(dispatches.length, 1);
  } finally {
    try { await restoreProxy?.(); }
    finally { try { await restoreDirect(); } finally { await mock.close(); } }
  }
});

test("safe adapter IPv4, mapped IPv4 and hostname redirects retain the configured hop budget", async t => {
  const { Agent, MockAgent } = createRequire(import.meta.resolve("@deepseek-ai/dsh-web-fetch-http"))("undici");
  const mock = new MockAgent();
  mock.disableNetConnect();
  t.mock.method(Agent.prototype, "dispatch", (options: { origin: string | URL }, handler: unknown) => mock.get(String(options.origin)).dispatch(options, handler));
  const restore = await installProxyFromEnvironment(proxyEnvironment({}), () => {});
  try {
    for (const origin of ["http://8.8.8.8", "http://[::ffff:808:808]", "http://dsmm-redirect.invalid"]) {
      mock.get(origin).intercept({ path: "/start" }).reply(302, "", { headers: { location: "/next" } });
      mock.get(origin).intercept({ path: "/next" }).reply(200, "accepted", { headers: { "content-type": "text/plain" } });
      const provider = new FakeIpHttpFetchProvider({ maxRedirects: 1 }, async hostname => hostname === "ipv4only.arpa"
        ? [{ address: "192.0.0.170", family: 4 }, { address: "192.0.0.171", family: 4 }]
        : [{ address: "8.8.8.8", family: 4 }]);
      const response = await provider.fetch({ url: `${origin}/start` });
      assert.equal(response.statusCode, 200);
      assert.equal(response.url, `${origin}/next`);
    }
    mock.assertNoPendingInterceptors();
  } finally {
    try { await restore(); } finally { await mock.close(); }
  }
});

test("native pinned transport preserves Host, re-resolves same-origin redirects, bounds bodies and returns non-2xx", { timeout: 10_000 }, async t => {
  const requests: string[] = [];
  const hosts: string[] = [];
  let hangStarted!: () => void;
  const hanging = new Promise<void>(resolve => { hangStarted = resolve; });
  const server = createServer((req, res) => {
    requests.push(req.url!); hosts.push(req.headers.host!);
    if (req.url === "/redirect") { res.writeHead(302, { location: "/missing" }); res.end(); }
    else if (req.url === "/cross") { res.writeHead(302, { location: "http://elsewhere.invalid/" }); res.end(); }
    else if (req.url === "/large") { res.writeHead(200, { "content-type": "text/plain", "content-length": "101" }); res.end("x".repeat(101)); }
    else if (req.url === "/stream") { res.writeHead(200, { "content-type": "text/plain" }); res.write("x".repeat(101)); res.end(); }
    else if (req.url === "/hang") { res.writeHead(200, { "content-type": "text/plain" }); res.write("waiting"); hangStarted(); }
    else { res.writeHead(404, { "content-type": "text/plain" }); res.end("missing"); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://dsmm-pinned-test.invalid:${address.port}`;
  let resolutions = 0;
  // Deliberately injected loopback is a native transport fixture, NOT the
  // production address policy and NOT evidence of a Fake-IP wire route.
  const provider = new HttpFetchProvider(limits, async hostname => {
    assert.equal(hostname, "dsmm-pinned-test.invalid"); resolutions++;
    return [{ address: "127.0.0.1", family: 4 }];
  });
  const missing = await provider.fetch({ url: `${origin}/redirect` });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.content, "missing");
  assert.equal(missing.url, `${origin}/missing`);
  assert.equal(resolutions, 2);
  assert.deepEqual(requests, ["/redirect", "/missing"]);
  assert.ok(hosts.every(host => host === `dsmm-pinned-test.invalid:${address.port}`));
  await assert.rejects(provider.fetch({ url: `${origin}/cross` }), { code: "WEB_REDIRECT_BLOCKED" });
  await assert.rejects(provider.fetch({ url: `${origin}/large` }), { code: "WEB_FETCH_TOO_LARGE" });
  const truncated = await provider.fetch({ url: `${origin}/stream` });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.body.content.length, 80);
  await assert.rejects(provider.fetch({ url: `http://user:secret@dsmm-pinned-test.invalid:${address.port}/` }), { code: "WEB_BLOCKED_URL" });
  await assert.rejects(provider.fetch({ url: "file:///not-http" }), { code: "WEB_INVALID_URL" });
  const controller = new AbortController();
  const pending = provider.fetch({ url: `${origin}/hang` }, controller.signal);
  const cancelled = assert.rejects(pending, { code: "WEB_ABORTED" });
  await hanging;
  controller.abort();
  await cancelled;
  let poisonedResolutions = 0;
  const poisoned = new HttpFetchProvider(limits, async () => {
    if (++poisonedResolutions === 2) throw new WebError("destination denied", "WEB_BLOCKED_URL");
    return [{ address: "127.0.0.1", family: 4 }];
  });
  const countBeforePoison = requests.length;
  await assert.rejects(poisoned.fetch({ url: `${origin}/redirect` }), { code: "WEB_BLOCKED_URL" });
  assert.equal(poisonedResolutions, 2);
  assert.deepEqual(requests.slice(countBeforePoison), ["/redirect"]);
  const noRedirects = new HttpFetchProvider({ ...limits, maxRedirects: 0 }, async () => [{ address: "127.0.0.1", family: 4 }]);
  await assert.rejects(noRedirects.fetch({ url: `${origin}/redirect` }), { code: "WEB_REDIRECT_BLOCKED" });
});
