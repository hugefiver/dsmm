import { lookup as systemLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { WebError } from "@deepseek-ai/dsh-web";
import type { HttpFetchResolver } from "@deepseek-ai/dsh-web-fetch-http";

// Address classification and RFC 6052/7050 extraction adapted from DeepSeek's
// MIT-licensed dsh-v0.2.1-rc.2 web-fetch-http/src/network.ts.
// Copyright (c) 2026 DeepSeek. Full notice: ../docs/web-fetch-fakeip.md.

export type AddressLookup = (
  hostname: string,
  options: { all: true; order: "verbatim" },
) => Promise<LookupAddress[]>;

export interface AddressPolicyOptions {
  /** Additional local denies; never additional allows. */
  readonly denyCidrs?: readonly string[];
}

type ParsedAddress = ipaddr.IPv4 | ipaddr.IPv6;
type DeniedRange = [ParsedAddress, number];
const PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96] as const;
interface Nat64Prefix {
  readonly bytes: readonly number[];
  readonly length: typeof PREFIX_LENGTHS[number];
}

export function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function parseAddress(input: string): ParsedAddress | undefined {
  const address = stripIpv6Brackets(input);
  const family = isIP(address);
  if (address.includes("%") || family === 0) return undefined;
  // Preserve IPv4-compatible vs mapped bits: ipaddr's dotted-tail parser
  // normalizes ::a.b.c.d to ::ffff:a.b.c.d, unlike the actual destination.
  const normalized = family === 6
    ? stripIpv6Brackets(new URL(`http://[${address}]/`).hostname)
    : address;
  return ipaddr.parse(normalized);
}

function effectiveAddress(address: ParsedAddress): ParsedAddress {
  return address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()
    ? address.toIPv4Address()
    : address;
}

export function isFakeIpAddress(input: string): boolean {
  const parsed = parseAddress(input);
  if (parsed === undefined) return false;
  const address = effectiveAddress(parsed);
  const bytes = address.toByteArray();
  return address instanceof ipaddr.IPv4 && bytes[0] === 198 && bytes[1] === 18;
}

function isPublicAddress(address: ParsedAddress): boolean {
  const effective = effectiveAddress(address);
  // Deprecated IPv4-compatible IPv6 is not a pinnable IPv6 destination.
  if (effective instanceof ipaddr.IPv6 && effective.match(ipaddr.IPv6.parse("::"), 96)) return false;
  return effective.range() === "unicast";
}

function parseDeniedRange(input: string): DeniedRange {
  const [host, length, ...extra] = input.split("/");
  const parsed = parseAddress(host);
  if (parsed === undefined || extra.length !== 0 || (length !== undefined && !/^\d+$/.test(length))) {
    throw new TypeError("denyCidrs must contain IP addresses or CIDRs");
  }
  let bits = length === undefined ? (parsed.kind() === "ipv4" ? 32 : 128) : Number(length);
  if (bits < 0 || bits > (parsed.kind() === "ipv4" ? 32 : 128)) {
    throw new TypeError("invalid deny CIDR prefix length");
  }
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress() && bits >= 96) {
    bits -= 96;
    return [parsed.toIPv4Address(), bits];
  }
  return [parsed, bits];
}

function isDenied(address: ParsedAddress, denied: readonly DeniedRange[]): boolean {
  const effective = effectiveAddress(address);
  // Test both representations so mapped CIDRs and ordinary IPv4 denies agree.
  const representations = [address, effective];
  if (effective instanceof ipaddr.IPv4) representations.push(effective.toIPv4MappedAddress());
  return denied.some(([range, bits]) => representations.some(candidate => {
    if (candidate instanceof ipaddr.IPv4 && range instanceof ipaddr.IPv4) return candidate.match(range, bits);
    if (candidate instanceof ipaddr.IPv6 && range instanceof ipaddr.IPv6) return candidate.match(range, bits);
    return false;
  }));
}

/** Local policy for literals and the complete DNS answer set. */
export class FakeIpAddressPolicy {
  private readonly denied: readonly DeniedRange[];

  constructor(options: AddressPolicyOptions = {}) {
    this.denied = (options.denyCidrs ?? []).map(parseDeniedRange);
  }

  get requiresLocalDeny(): boolean {
    return this.denied.length !== 0;
  }

  allows(input: string): boolean {
    const parsed = parseAddress(input);
    return parsed !== undefined && !isDenied(parsed, this.denied)
      && (isPublicAddress(parsed) || isFakeIpAddress(input));
  }

  /** Native transition/NAT64 destinations do not inherit the Fake-IP exception. */
  allowsTranslatedIpv4(input: string): boolean {
    const parsed = parseAddress(input);
    return parsed instanceof ipaddr.IPv4 && isPublicAddress(parsed) && !isDenied(parsed, this.denied);
  }
}

/** Resolve once; the native provider pins exactly this validated, nonempty set. */
export function createFakeIpResolver(
  policy = new FakeIpAddressPolicy(),
  lookup: AddressLookup = systemLookup,
): HttpFetchResolver {
  return async (hostname, signal) => {
    checkAbort(signal);
    const host = stripIpv6Brackets(hostname);
    const family = isIP(host);
    const resolved = family === 0
      ? await raceLookup(() => lookup(host, { all: true, order: "verbatim" }), signal)
      : [{ address: host, family }];
    if (resolved.length === 0) throw new WebError("DNS returned no addresses", "WEB_PROVIDER_ERROR");
    const addresses: { address: string; family: 4 | 6 }[] = [];
    for (const entry of resolved) {
      if ((entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family) {
        throw new WebError("DNS returned an invalid address", "WEB_PROVIDER_ERROR");
      }
      if (!policy.allows(entry.address)) throw new WebError("destination address denied", "WEB_BLOCKED_URL");
      addresses.push({ address: entry.address, family: entry.family });
    }
    if (addresses.some(entry => entry.family === 6)) {
      const prefixes = await discoverNat64Prefixes(lookup, signal);
      for (const { address, family } of addresses) {
        if (family !== 6) continue;
        const bytes = ipaddr.parse(address).toByteArray();
        for (const prefix of prefixes) {
          if (!prefix.bytes.every((byte, index) => bytes[index] === byte)) continue;
          const embedded = embeddedIpv4(bytes, prefix.length);
          if (embedded === undefined || !policy.allowsTranslatedIpv4(embedded)) {
            throw new WebError("NAT64 destination address denied", "WEB_BLOCKED_URL");
          }
        }
      }
    }
    checkAbort(signal);
    return addresses;
  };
}

async function discoverNat64Prefixes(lookup: AddressLookup, signal: AbortSignal): Promise<Nat64Prefix[]> {
  const answers = await raceLookup(() => lookup("ipv4only.arpa", { all: true, order: "verbatim" }), signal);
  if (answers.length === 0) throw new WebError("NAT64 discovery returned no addresses", "WEB_PROVIDER_ERROR");
  const prefixes: Nat64Prefix[] = [];
  const seen = new Set<string>();
  for (const entry of answers) {
    if ((entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family) {
      throw new WebError("NAT64 discovery returned an invalid address", "WEB_PROVIDER_ERROR");
    }
    if (entry.family === 4) {
      if (entry.address !== "192.0.0.170" && entry.address !== "192.0.0.171") {
        throw new WebError("unrecognized NAT64 discovery answer", "WEB_PROVIDER_ERROR");
      }
      continue;
    }
    const bytes = ipaddr.parse(entry.address).toByteArray();
    let recognized = false;
    for (const length of PREFIX_LENGTHS) {
      const embedded = embeddedIpv4(bytes, length);
      if (embedded !== "192.0.0.170" && embedded !== "192.0.0.171") continue;
      recognized = true;
      const prefixBytes = bytes.slice(0, length / 8);
      const key = `${length}:${prefixBytes.join(".")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      prefixes.push({ bytes: prefixBytes, length });
    }
    if (!recognized) throw new WebError("unrecognized NAT64 discovery answer", "WEB_PROVIDER_ERROR");
  }
  return prefixes;
}

function embeddedIpv4(bytes: readonly number[], prefixLength: Nat64Prefix["length"]): string | undefined {
  if (prefixLength === 96) return bytes.slice(12, 16).join(".");
  if (bytes[8] !== 0) return undefined;
  const start = prefixLength / 8;
  const beforeReservedOctet = 8 - start;
  return [...bytes.slice(start, start + beforeReservedOctet), ...bytes.slice(9, 9 + 4 - beforeReservedOctet)].join(".");
}

function checkAbort(signal: AbortSignal): void {
  // Leave timeout classification to the native provider's deadline owner.
  if (signal.aborted) throw new Error("address resolution aborted", { cause: signal.reason });
}

function raceLookup<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("address resolution aborted", { cause: signal.reason }));
    signal.addEventListener("abort", abort, { once: true });
    const finish = () => signal.removeEventListener("abort", abort);
    start().then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
  });
}
