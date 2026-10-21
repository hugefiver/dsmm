import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from "@deepseek-ai/dsh-web";
import { HttpFetchProvider, DEFAULT_USER_AGENT } from "@deepseek-ai/dsh-web-fetch-http";
import type { HttpFetchLimits, HttpFetchResolver } from "@deepseek-ai/dsh-web-fetch-http";
import { proxyRouteFor } from "@deepseek-ai/dsh-http-proxy";
import { isIP } from "node:net";
import {
  FakeIpAddressPolicy, createFakeIpResolver, isFakeIpAddress, stripIpv6Brackets,
} from "./web-fetch-address-policy.js";
import type { AddressLookup } from "./web-fetch-address-policy.js";

export const name = "dsmm-http-fakeip";
export const FETCH_PROVIDER_ID = "dsmm-http-fakeip";
export const inject = ["web"];

export interface Config extends Partial<HttpFetchLimits> {
  readonly denyCidrs?: string[];
}

export const Config: z<Config> = z.object({
  maxResponseBytes: z.number().default(5_000_000),
  maxBodyChars: z.number().default(100_000),
  timeoutMs: z.number().default(30_000),
  maxRedirects: z.number().default(5),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  denyCidrs: z.array(z.string()).default([]),
});

function resolveLimits(config: Config): HttpFetchLimits {
  const limits = {
    maxResponseBytes: config.maxResponseBytes ?? 5_000_000,
    maxBodyChars: config.maxBodyChars ?? 100_000,
    timeoutMs: config.timeoutMs ?? 30_000,
    maxRedirects: config.maxRedirects ?? 5,
    userAgent: config.userAgent ?? DEFAULT_USER_AGENT,
  };
  for (const key of ["maxResponseBytes", "maxBodyChars", "timeoutMs"] as const) {
    if (!Number.isFinite(limits[key]) || limits[key] <= 0) throw new TypeError(`${key} must be positive and finite`);
  }
  if (limits.timeoutMs > 2_147_483_647) throw new TypeError("timeoutMs exceeds the Node timer range");
  if (!Number.isInteger(limits.maxRedirects) || limits.maxRedirects < 0) throw new TypeError("maxRedirects must be a nonnegative integer");
  return limits;
}

function assertRoute(url: URL, policy: FakeIpAddressPolicy): void {
  const host = stripIpv6Brackets(url.hostname);
  const literal = isIP(host) !== 0;
  if (literal && !policy.allows(host)) throw new WebError("literal address denied", "WEB_BLOCKED_URL");
  const route = proxyRouteFor(url);
  if (!route.proxied) return;
  if (isFakeIpAddress(host)) {
    throw new WebError("Fake-IP literals cannot safely use the native proxy path", "WEB_FAKEIP_PROXY_UNSUPPORTED");
  }
  if (policy.requiresLocalDeny && !literal) {
    throw new WebError("proxy DNS cannot enforce local address denies", "WEB_FAKEIP_PROXY_UNSUPPORTED");
  }
  // The proxy branch skips RFC 7050 discovery too; do not accept an IPv6
  // literal whose locally translated destination cannot be checked there.
  if (isIP(host) === 6 && !host.toLowerCase().startsWith("::ffff:")) {
    throw new WebError("proxy IPv6 literals cannot enforce local NAT64 checks", "WEB_FAKEIP_PROXY_UNSUPPORTED");
  }
}

/** Opt-in adapter; all HTTP transport and response handling remain native. */
export class FakeIpHttpFetchProvider implements WebFetchProvider {
  readonly id = FETCH_PROVIDER_ID;
  private readonly limits: HttpFetchLimits;
  private readonly policy: FakeIpAddressPolicy;
  private readonly resolver: HttpFetchResolver;

  constructor(config: Config = {}, lookup?: AddressLookup) {
    this.limits = resolveLimits(config);
    this.policy = new FakeIpAddressPolicy(config);
    this.resolver = createFakeIpResolver(this.policy, lookup);
  }

  available(): boolean {
    return new HttpFetchProvider(this.limits, this.resolver).available();
  }

  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) return Promise.reject(new WebError("web fetch aborted", "WEB_ABORTED"));
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return Promise.reject(new WebError("invalid fetch URL", "WEB_INVALID_URL"));
    }
    try {
      assertRoute(url, this.policy);
    } catch (error) {
      return Promise.reject(error);
    }
    // Same-origin redirects preserve the full routing key. Recheck inside the
    // resolver as well: rc.2 otherwise sends proxied Fake-IP literals direct.
    const resolve: HttpFetchResolver = (hostname, innerSignal) => {
      assertRoute(url, this.policy);
      return this.resolver(hostname, innerSignal);
    };
    // The public resolver seam cannot guard a later redirect's proxy branch.
    // Local denies and native IPv6 literal NAT64 checks require zero hops to
    // retain enforcement if process proxy policy changes during the request.
    const host = stripIpv6Brackets(url.hostname);
    const nativeIpv6Literal = isIP(host) === 6 && !host.toLowerCase().startsWith("::ffff:");
    const limits = this.policy.requiresLocalDeny || nativeIpv6Literal
      ? { ...this.limits, maxRedirects: 0 }
      : this.limits;
    return new HttpFetchProvider(limits, resolve).fetch(request, signal);
  }
}

/** Mount only when the operator has explicitly selected this adapter. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerFetchProvider(new FakeIpHttpFetchProvider(config));
}
