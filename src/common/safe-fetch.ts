import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, request } from 'undici';

/**
 * Outbound HTTP for user-controlled URLs (agent endpoints, metadata URIs).
 *
 * SSRF protections:
 * - only http(s), and only https unless private targets are explicitly allowed (local development)
 * - every resolved IP is checked at connect time, so DNS rebinding can't swap in an internal address
 * - redirects are not followed, responses are size- and time-limited
 */

const blockedRanges = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedRanges.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedRanges.addSubnet(network, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;

  if (family === 6) {
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) must be checked as IPv4
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return !blockedRanges.check(mapped[1], 'ipv4');
    return !blockedRanges.check(address, 'ipv6');
  }
  return !blockedRanges.check(address, 'ipv4');
}

export class UnsafeUrlError extends Error {}

export interface SafeFetchOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
  maxBytes?: number;
  allowPrivate?: boolean;
}

export interface SafeFetchResult {
  status: number;
  contentType: string;
  body: Buffer;
}

/**
 * Resolves every address for a hostname (the system resolver is `dns.lookup` with `all: true`).
 * Injectable so the guarded lookup can be exercised without real DNS.
 */
export type AddressResolver = (
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const systemResolver: AddressResolver = (hostname, options, callback) =>
  dnsLookup(hostname, { ...options, all: true }, callback);

/**
 * Builds a `net.connect` lookup that refuses hostnames resolving to any blocked address.
 *
 * Node calls the lookup with `all: true` when happy eyeballs (`autoSelectFamily`) is active and then
 * expects an address array; otherwise it expects a single address and its family.
 */
export function createGuardedLookup(
  resolve: AddressResolver = systemResolver,
  isAllowed: (address: string) => boolean = isPublicAddress,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, options, (error, addresses) => {
      if (error) return callback(error, '', 0);
      if (addresses.length === 0) {
        const notFound: NodeJS.ErrnoException = new Error(`No addresses found for ${hostname}`);
        notFound.code = 'ENOTFOUND';
        return callback(notFound, '', 0);
      }
      const unsafe = addresses.find((entry) => !isAllowed(entry.address));
      if (unsafe) {
        return callback(
          new UnsafeUrlError(`Refusing to connect to non-public address ${unsafe.address}`),
          '',
          0,
        );
      }
      if (options.all) return callback(null, addresses);
      const [first] = addresses;
      callback(null, first.address, first.family);
    });
  };
}

const publicOnlyAgent = new Agent({ connect: { lookup: createGuardedLookup() } });

const unrestrictedAgent = new Agent();

export function assertSafeUrl(rawUrl: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError('Invalid URL');
  }

  const allowedProtocols = allowPrivate ? ['http:', 'https:'] : ['https:'];
  if (!allowedProtocols.includes(url.protocol)) {
    throw new UnsafeUrlError(`Protocol ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('Credentials in URLs are not allowed');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && isIP(host) !== 0 && !isPublicAddress(host)) {
    throw new UnsafeUrlError(`Refusing to connect to non-public address ${host}`);
  }
  return url;
}

export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const {
    method = 'GET',
    body,
    timeoutMs = 10_000,
    maxBytes = 64 * 1024,
    allowPrivate = false,
  } = options;
  const url = assertSafeUrl(rawUrl, allowPrivate);

  const response = await request(url, {
    method,
    dispatcher: allowPrivate ? unrestrictedAgent : publicOnlyAgent,
    headers: {
      accept: 'application/json',
      'user-agent': 'verora-oracle/1.0',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    received += buffer.length;
    if (received > maxBytes) {
      response.body.destroy();
      throw new UnsafeUrlError(`Response exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  const contentType = response.headers['content-type'];
  return {
    status: response.statusCode,
    contentType: Array.isArray(contentType) ? (contentType[0] ?? '') : (contentType ?? ''),
    body: Buffer.concat(chunks),
  };
}

export function parseJsonBody<T>(result: SafeFetchResult): T {
  return JSON.parse(result.body.toString('utf8')) as T;
}
