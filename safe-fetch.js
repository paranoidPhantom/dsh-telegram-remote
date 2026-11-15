import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export const FETCH_LIMITS = Object.freeze({ maxBytes: 512 * 1024, timeoutMs: 5000, maxRedirects: 3 });
export function isPublicIP(address) {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
    return ip.range() === 'unicast';
  } catch { return false; }
}
export function validateResourceURL(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Resource URL must use public HTTP(S)');
  if (url.username || url.password || url.port) throw new Error('Resource credentials and non-default ports are forbidden');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicIP(host)) throw new Error('SSRF: non-public IP address blocked');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('SSRF: local hostname blocked');
  url.hash = '';
  return url;
}

// A caller-owned bounded cache may be shared across builds. Cached bodies are revalidated
// with ETag, never trusted as a reason to skip current DNS/redirect validation.
export async function safeFetch(input, options = {}) {
  const { maxBytes, timeoutMs, maxRedirects } = { ...FETCH_LIMITS, ...options };
  const deadline = Date.now() + timeoutMs;
  const signal = options.signal;
  async function visit(inputURL, redirects) {
    signal?.throwIfAborted();
    const url = validateResourceURL(inputURL);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const remaining = () => Math.max(1, deadline - Date.now());
    if (Date.now() >= deadline) throw new Error('Resource request time budget exceeded');
    let timer;
    const addresses = await Promise.race([
      isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }]) : lookup(host, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS lookup timed out')), remaining()); })
    ]).finally(() => clearTimeout(timer));
    if (!addresses.length || addresses.some(a => !isPublicIP(a.address))) throw new Error('SSRF: DNS resolved to a non-public address');
    const pinned = addresses[0];
    const cached = options.cache?.get(url.href);
    return new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(url, {
        method: 'GET', agent: false, signal,
        headers: { Accept: '*/*', 'Accept-Encoding': 'identity', ...(cached?.etag ? { 'If-None-Match': cached.etag } : {}) },
        lookup(_hostname, opts, cb) {
          if (opts?.all) cb(null, [pinned]); else cb(null, pinned.address, pinned.family);
        }
      }, res => {
        const status = res.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          if (redirects >= maxRedirects || !res.headers.location) return reject(new Error('Resource redirect limit exceeded'));
          return resolve(visit(new URL(res.headers.location, url), redirects + 1));
        }
        if (status === 304 && cached) { res.resume(); if (cached.body.length > maxBytes) return reject(new Error('Cached resource exceeds size limit')); return resolve({ ...cached, url: url.href }); }
        if (status !== 200) { res.resume(); return reject(new Error(`Resource HTTP ${status}`)); }
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.destroy(); return reject(new Error('Encoded resource responses are forbidden')); }
        if (Number(res.headers['content-length']) > maxBytes) { res.destroy(); return reject(new Error('Resource exceeds size limit')); }
        const parts = []; let size = 0;
        res.on('data', part => { size += part.length; if (size > maxBytes) res.destroy(new Error('Resource exceeds size limit')); else parts.push(part); });
        res.on('error', reject);
        res.on('end', () => {
          const result = { body: Buffer.concat(parts), mime: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), etag: res.headers.etag, url: url.href };
          if (options.cache && result.etag) { if (options.cache.size >= 64) options.cache.delete(options.cache.keys().next().value); options.cache.set(url.href, result); }
          resolve(result);
        });
      });
      const clock = setTimeout(() => req.destroy(new Error('Resource request timed out')), remaining());
      req.on('close', () => clearTimeout(clock));
      req.on('error', reject);
      req.end();
    });
  }
  return visit(input, 0);
}
