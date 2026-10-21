import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import type { LookupAddress } from "node:dns";
import ipaddr from "ipaddr.js";
import { createFakeIpResolver, FakeIpAddressPolicy, isFakeIpAddress } from "../src/web-fetch-address-policy.ts";
import type { AddressLookup } from "../src/web-fetch-address-policy.ts";

const signal = () => new AbortController().signal;
const ordinaryDiscovery = [{ address: "192.0.0.170", family: 4 }, { address: "192.0.0.171", family: 4 }];
function lookupReturning(answers: LookupAddress[], discovery = ordinaryDiscovery): AddressLookup {
  return async (host, options) => {
    assert.deepEqual(options, { all: true, order: "verbatim" });
    return host === "ipv4only.arpa" ? discovery : answers;
  };
}

test("only public unicast and exact 198.18/16, including mapped IPv4, are allowed", async () => {
  const policy = new FakeIpAddressPolicy();
  for (const address of ["198.18.0.0", "198.18.0.1", "198.18.255.255", "::ffff:198.18.0.0", "::ffff:c612:ffff"]) {
    assert.equal(isFakeIpAddress(address), true, address);
    assert.equal(policy.allows(address), true, address);
  }
  for (const address of ["198.19.0.0", "198.19.255.255", "::ffff:198.19.0.1", "127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "2002:0808:0808::", "2001::1", "64:ff9b::808:808", "64:ff9b:1::1", "::8.8.8.8", "::808:808", "::198.18.0.1", "bad", "2606:4700::1111%eth0"]) {
    assert.equal(policy.allows(address), false, address);
  }
  for (const address of ["8.8.8.8", "198.17.255.255", "198.20.0.0", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(policy.allows(address), true, address);
  }
  const addresses = [{ address: "198.18.0.0", family: 4 }, { address: "8.8.8.8", family: 4 }];
  assert.deepEqual(await createFakeIpResolver(policy, lookupReturning(addresses))("test.invalid", signal()), addresses);
});

test("one refused, malformed, or empty DNS answer set rejects the entire request", async () => {
  for (const answers of [
    [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }],
    [{ address: "198.18.0.1", family: 4 }, { address: "198.19.0.1", family: 4 }],
    [{ address: "8.8.8.8", family: 4 }, { address: "::ffff:127.0.0.1", family: 6 }],
  ]) {
    await assert.rejects(createFakeIpResolver(undefined, lookupReturning(answers))("test.invalid", signal()), { code: "WEB_BLOCKED_URL" });
  }
  for (const answers of [[], [{ address: "not-an-ip", family: 4 }], [{ address: "8.8.8.8", family: 6 }]]) {
    await assert.rejects(createFakeIpResolver(undefined, lookupReturning(answers))("test.invalid", signal()), { code: "WEB_PROVIDER_ERROR" });
  }
});

test("explicit denies dominate the exception and both mapped representations", async () => {
  const policy = new FakeIpAddressPolicy({ denyCidrs: ["198.18.0.1/16", "8.8.8.0/24", "2606:4700::/32"] });
  for (const address of ["198.18.255.255", "::ffff:198.18.0.1", "8.8.8.8", "::ffff:808:808", "2606:4700::1111"]) {
    assert.equal(policy.allows(address), false, address);
  }
  const mappedDeny = new FakeIpAddressPolicy({ denyCidrs: ["::ffff:198.18.0.1/112"] });
  assert.equal(mappedDeny.allows("198.18.255.255"), false);
  assert.equal(new FakeIpAddressPolicy({ denyCidrs: ["::ffff:0:0/96"] }).allows("8.8.8.8"), false);
  assert.equal(policy.allows("1.1.1.1"), true);
  await assert.rejects(createFakeIpResolver(policy, lookupReturning([{ address: "198.18.0.2", family: 4 }]))("test.invalid", signal()), { code: "WEB_BLOCKED_URL" });
  for (const deny of ["not-an-ip", "8.8.8.8/33", "::1/129", "198.18.0.1/-1", "8.8.8.8/", "8.8.8.8/24/1"]) {
    assert.throws(() => new FakeIpAddressPolicy({ denyCidrs: [deny] }), TypeError);
  }
});

function translated(prefixLength: number, ipv4: string): string {
  const bytes = ipaddr.parse("2606:4700:1234:5678::").toByteArray();
  bytes.fill(0, prefixLength / 8);
  const embedded = ipv4.split(".").map(Number);
  if (prefixLength === 96) bytes.splice(12, 4, ...embedded);
  else {
    const beforeReservedOctet = 8 - prefixLength / 8;
    bytes.splice(prefixLength / 8, beforeReservedOctet, ...embedded.slice(0, beforeReservedOctet));
    bytes.splice(9, 4 - beforeReservedOctet, ...embedded.slice(beforeReservedOctet));
  }
  return ipaddr.fromByteArray(bytes).toString();
}

test("RFC7050 discovery protects all RFC6052 layouts, including translated explicit denies", async () => {
  for (const length of [32, 40, 48, 56, 64, 96]) {
    const discovery = [{ address: translated(length, "192.0.0.170"), family: 6 }, { address: translated(length, "192.0.0.171"), family: 6 }];
    for (const embedded of ["10.0.0.1", "127.0.0.1", "198.18.0.1", "198.19.0.1"]) {
      const resolve = createFakeIpResolver(undefined, lookupReturning([{ address: translated(length, embedded), family: 6 }], discovery));
      await assert.rejects(resolve("test.invalid", signal()), { code: "WEB_BLOCKED_URL" });
    }
    const publicAnswers = [{ address: translated(length, "8.8.8.8"), family: 6 }];
    assert.deepEqual(await createFakeIpResolver(undefined, lookupReturning(publicAnswers, discovery))("test.invalid", signal()), publicAnswers);
    const deny = new FakeIpAddressPolicy({ denyCidrs: ["8.8.8.0/24"] });
    await assert.rejects(createFakeIpResolver(deny, lookupReturning(publicAnswers, discovery))("test.invalid", signal()), { code: "WEB_BLOCKED_URL" });
  }
});

test("NAT64 discovery failure or unrecognized answers never relax IPv6 policy", async () => {
  for (const discovery of [[], [{ address: "2606:4700::1111", family: 6 }], [{ address: "bad", family: 6 }]]) {
    await assert.rejects(createFakeIpResolver(undefined, lookupReturning([{ address: "2606:4700::1111", family: 6 }], discovery))("test.invalid", signal()), { code: "WEB_PROVIDER_ERROR" });
  }
  const lookup: AddressLookup = async host => {
    if (host === "ipv4only.arpa") throw new Error("DNS unavailable");
    return [{ address: "2606:4700::1111", family: 6 }];
  };
  await assert.rejects(createFakeIpResolver(undefined, lookup)("test.invalid", signal()));
});

test("cancellation rejects promptly before lookup, during lookup, and during discovery", async () => {
  let calls = 0;
  const lookup: AddressLookup = async () => { calls++; return new Promise(() => {}); };
  const before = new AbortController();
  before.abort();
  await assert.rejects(createFakeIpResolver(undefined, lookup)("test.invalid", before.signal));
  assert.equal(calls, 0);
  const during = new AbortController();
  const pending = createFakeIpResolver(undefined, lookup)("test.invalid", during.signal);
  during.abort();
  await assert.rejects(pending);
  assert.equal(getEventListeners(during.signal, "abort").length, 0);
  let discoveryStarted!: () => void;
  const started = new Promise<void>(resolve => { discoveryStarted = resolve; });
  const discoveryLookup: AddressLookup = async host => {
    if (host === "ipv4only.arpa") { discoveryStarted(); return new Promise(() => {}); }
    return [{ address: "2606:4700::1111", family: 6 }];
  };
  const discovery = new AbortController();
  const resolving = createFakeIpResolver(undefined, discoveryLookup)("test.invalid", discovery.signal);
  await started;
  discovery.abort();
  await assert.rejects(resolving);
  assert.equal(getEventListeners(discovery.signal, "abort").length, 0);
});

test("literal addresses bypass hostname lookup but mapped IPv6 still receives NAT64 checks", async () => {
  const hosts: string[] = [];
  const lookup: AddressLookup = async host => { hosts.push(host); return ordinaryDiscovery; };
  const resolve = createFakeIpResolver(undefined, lookup);
  assert.deepEqual(await resolve("198.18.0.1", signal()), [{ address: "198.18.0.1", family: 4 }]);
  assert.deepEqual(await resolve("[::ffff:c612:1]", signal()), [{ address: "::ffff:c612:1", family: 6 }]);
  assert.deepEqual(hosts, ["ipv4only.arpa"]);
});
