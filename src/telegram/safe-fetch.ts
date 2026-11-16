import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export const FETCH_LIMITS = Object.freeze({
  maxBytes: 512 * 1024,
  timeoutMs: 5000,
  maxRedirects: 3,
});

export interface FetchedResource {
  body: Buffer;
  mime: string;
  etag?: string;
  url: string;
}

/** Caller-owned cache. A hit never bypasses current DNS/redirect validation. */
export type ResourceCache = Map<string, FetchedResource>;

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  cache?: ResourceCache;
}

export function isPublicIP(address: string): boolean {
  try {
    let ip = ipaddr.parse(address);
    // kind() is not a discriminant in ipaddr.js's class declarations.
    if (ip instanceof ipaddr.IPv6 && ip.isIPv4MappedAddress()) {
      ip = ip.toIPv4Address();
    }
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}

export function validateResourceURL(input: string | URL): URL {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Resource URL must use public HTTP(S)");
  }
  if (url.username || url.password || url.port) {
    throw new Error("Resource credentials and non-default ports are forbidden");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicIP(host)) {
    throw new Error("SSRF: non-public IP address blocked");
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    throw new Error("SSRF: local hostname blocked");
  }
  url.hash = "";
  return url;
}

// Cached bodies are revalidated with ETag, never trusted as a reason to skip
// current DNS/redirect validation.
export async function safeFetch(
  input: string | URL,
  options: SafeFetchOptions = {},
): Promise<FetchedResource> {
  const { maxBytes, timeoutMs, maxRedirects } = { ...FETCH_LIMITS, ...options };
  const deadline = Date.now() + timeoutMs;
  const signal = options.signal;

  async function visit(
    inputURL: string | URL,
    redirects: number,
  ): Promise<FetchedResource> {
    signal?.throwIfAborted();
    const url = validateResourceURL(inputURL);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const remaining = () => Math.max(1, deadline - Date.now());
    if (Date.now() >= deadline) {
      throw new Error("Resource request time budget exceeded");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const family = isIP(host);
    const addresses = await Promise.race<LookupAddress[]>([
      family
        ? Promise.resolve([{ address: host, family }])
        : lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("DNS lookup timed out")),
          remaining(),
        );
      }),
    ]).finally(() => clearTimeout(timer));
    const pinned = addresses[0];
    if (!pinned || addresses.some((address) => !isPublicIP(address.address))) {
      throw new Error("SSRF: DNS resolved to a non-public address");
    }
    const cached = options.cache?.get(url.href);
    return new Promise<FetchedResource>((resolve, reject) => {
      const transport = url.protocol === "https:" ? https : http;
      const req = transport.request(
        url,
        {
          method: "GET",
          agent: false,
          signal,
          headers: {
            Accept: "*/*",
            "Accept-Encoding": "identity",
            ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
          },
          lookup(_hostname, opts, callback) {
            if (opts.all) callback(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          },
        },
        (res) => {
          const status = res.statusCode;
          if (
            status !== undefined &&
            [301, 302, 303, 307, 308].includes(status)
          ) {
            res.resume();
            if (redirects >= maxRedirects || !res.headers.location) {
              reject(new Error("Resource redirect limit exceeded"));
              return;
            }
            resolve(visit(new URL(res.headers.location, url), redirects + 1));
            return;
          }
          if (status === 304 && cached) {
            res.resume();
            if (cached.body.length > maxBytes) {
              reject(new Error("Cached resource exceeds size limit"));
              return;
            }
            resolve({ ...cached, url: url.href });
            return;
          }
          if (status !== 200) {
            res.resume();
            reject(new Error(`Resource HTTP ${status}`));
            return;
          }
          if (
            res.headers["content-encoding"] &&
            res.headers["content-encoding"] !== "identity"
          ) {
            res.destroy();
            reject(new Error("Encoded resource responses are forbidden"));
            return;
          }
          if (Number(res.headers["content-length"]) > maxBytes) {
            res.destroy();
            reject(new Error("Resource exceeds size limit"));
            return;
          }
          const parts: Buffer[] = [];
          let size = 0;
          res.on("data", (part: Buffer) => {
            size += part.length;
            if (size > maxBytes) {
              res.destroy(new Error("Resource exceeds size limit"));
            } else {
              parts.push(part);
            }
          });
          res.on("error", reject);
          res.on("end", () => {
            const result: FetchedResource = {
              body: Buffer.concat(parts),
              mime:
                String(res.headers["content-type"] || "")
                  .split(";")[0]
                  ?.trim()
                  .toLowerCase() ?? "",
              etag: res.headers.etag,
              url: url.href,
            };
            if (options.cache && result.etag) {
              if (options.cache.size >= 64) {
                const oldest = options.cache.keys().next();
                if (!oldest.done) options.cache.delete(oldest.value);
              }
              options.cache.set(url.href, result);
            }
            resolve(result);
          });
        },
      );
      const clock = setTimeout(
        () => req.destroy(new Error("Resource request timed out")),
        remaining(),
      );
      req.on("close", () => clearTimeout(clock));
      req.on("error", reject);
      req.end();
    });
  }
  return visit(input, 0);
}
