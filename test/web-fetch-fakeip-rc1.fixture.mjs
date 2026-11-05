import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import "./prompt-source-loader.mjs";

assert.ok(process.env.DSMM_TEST_DSH_ENTRY, "requires an explicit installed DSH rc.1 anchor");
const native = createRequire(process.env.DSMM_TEST_DSH_ENTRY);
const source = new URL("../src/", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@deepseek-ai/") && (context.parentURL === import.meta.url || context.parentURL?.startsWith(source))) {
      return { url: pathToFileURL(native.resolve(specifier)).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { HttpFetchProvider } = await import("@deepseek-ai/dsh-web-fetch-http");
const { installProxyFromEnvironment, proxyRouteFor } = await import("@deepseek-ai/dsh-http-proxy");
const { FakeIpAddressPolicy } = await import("../src/web-fetch-address-policy.ts");
const { FakeIpHttpFetchProvider } = await import("../src/web-fetch-fakeip.ts");
const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = createRequire(native.resolve("@deepseek-ai/dsh-web-fetch-http"))("undici");
const limits = { maxResponseBytes: 100, maxBodyChars: 100, timeoutMs: 2_000, maxRedirects: 1, userAgent: "dsmm-test" };

// Test cases run in a disposable process; the Host's process dispatcher stays untouched.
test("rc.1 native IPv6 local denies fail closed while validated literals retain native transport", async t => {
  if (Object.hasOwn(new HttpFetchProvider(limits), "resolveAddresses")) {
    t.skip("requires resolver-free Host; resolver-capable Hosts use the existing safety coverage");
    return;
  }
  const restoreProxy = await installProxyFromEnvironment({ get() {} }, () => {});
  const previous = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  const originalDispatch = mock.dispatch;
  const dispatch = t.mock.method(mock, "dispatch", function (...args) {
    return originalDispatch.apply(this, args);
  });
  const originalFetch = HttpFetchProvider.prototype.fetch;
  const nativeFetch = t.mock.method(HttpFetchProvider.prototype, "fetch", function (...args) {
    return originalFetch.apply(this, args);
  });
  let lookups = 0;
  const lookup = async () => { lookups++; throw new Error("rc.1 must not use the removed resolver seam"); };
  try {
    await verifyBlocked({ nativeFetch, lookup });
    assert.equal(dispatch.mock.callCount(), 0);
    assert.equal(lookups, 0);
    await verifyNativeTransport({ mock, nativeFetch, lookup });
    assert.equal(dispatch.mock.callCount(), 5);
    assert.equal(lookups, 0);
    mock.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(previous);
    try { await mock.close(); } finally { await restoreProxy(); }
  }
});

async function verifyBlocked({ nativeFetch, lookup }) {
  const policy = new FakeIpAddressPolicy({ denyCidrs: ["8.8.8.0/24"] });
  assert.equal(policy.allowsTranslatedIpv4("8.8.8.8"), false);
  const provider = new FakeIpHttpFetchProvider({ ...limits, denyCidrs: ["8.8.8.0/24"] }, lookup);
  for (const host of ["2606:4700:1234:5678::808:808", "2606:4700:4700::1111"]) {
    assert.equal(policy.allows(host), true);
    const url = `http://[${host}]/`;
    assert.equal(proxyRouteFor(new URL(url)).proxied, false);
    await assert.rejects(provider.fetch({ url }), { code: "WEB_FAKEIP_PROXY_UNSUPPORTED" });
  }
  await assert.rejects(provider.fetch({ url: "http://dsmm-local-deny.invalid/" }), { code: "WEB_FAKEIP_PROXY_UNSUPPORTED" });
  for (const url of ["http://8.8.8.8/", "http://[::ffff:808:808]/", "http://10.0.0.1/"]) {
    await assert.rejects(provider.fetch({ url }), { code: "WEB_BLOCKED_URL" });
  }
  assert.equal(nativeFetch.mock.callCount(), 0);
}

async function verifyNativeTransport({ mock, nativeFetch, lookup }) {
  const provider = new FakeIpHttpFetchProvider({ ...limits, denyCidrs: ["8.8.8.0/24"] }, lookup);
  for (const origin of ["http://1.1.1.1", "http://[::ffff:101:101]"]) {
    mock.get(origin).intercept({ path: "/start" }).reply(302, "", { headers: { location: "/next" } });
    mock.get(origin).intercept({ path: "/next" }).reply(200, "accepted", { headers: { "content-type": "text/plain" } });
    const response = await provider.fetch({ url: `${origin}/start` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.content, "accepted");
    assert.equal(response.url, `${origin}/next`);
  }
  const origin = "http://[2606:4700:4700::1111]";
  mock.get(origin).intercept({ path: "/start" }).reply(302, "", { headers: { location: "/next" } });
  await assert.rejects(new FakeIpHttpFetchProvider(limits, lookup).fetch({ url: `${origin}/start` }), { code: "WEB_REDIRECT_BLOCKED" });
  assert.equal(nativeFetch.mock.callCount(), 3);
}
