import { createServer, type Server } from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { Agent, request } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSafeUrl,
  createGuardedLookup,
  isPublicAddress,
  safeFetch,
  UnsafeUrlError,
  type AddressResolver,
} from './safe-fetch.js';

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
  ])('rejects internal address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
    'accepts public address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it('rejects non-IP strings', () => {
    expect(isPublicAddress('localhost')).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  it('requires https unless private targets are allowed', () => {
    expect(() => assertSafeUrl('http://example.com', false)).toThrow(UnsafeUrlError);
    expect(assertSafeUrl('http://localhost:4102/query', true).port).toBe('4102');
  });

  it('rejects other protocols, credentials, and literal internal IPs', () => {
    expect(() => assertSafeUrl('file:///etc/passwd', true)).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrl('https://user:pass@example.com', false)).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrl('https://169.254.169.254/latest', false)).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrl('https://[::1]/', false)).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrl('not a url', false)).toThrow(UnsafeUrlError);
  });
});

describe('safeFetch', () => {
  it('refuses hostnames that resolve to loopback at connect time', async () => {
    await expect(safeFetch('https://localhost/health', { timeoutMs: 2000 })).rejects.toThrow(
      /non-public address/,
    );
  });
});

/** Resolves every hostname to fixed addresses, so no real DNS is involved */
const stubResolver =
  (addresses: LookupAddress[]): AddressResolver =>
  (_hostname, _options, callback) =>
    callback(null, addresses);

function lookupOnce(
  lookup: LookupFunction,
  all: boolean,
): Promise<{ address: string | LookupAddress[]; family?: number }> {
  return new Promise((resolve, reject) => {
    lookup('agent.example', { all }, (error, address, family) =>
      error ? reject(error) : resolve({ address, family }),
    );
  });
}

describe('createGuardedLookup', () => {
  const publicAddresses: LookupAddress[] = [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ];

  it('returns every address when called with all: true', async () => {
    const lookup = createGuardedLookup(stubResolver(publicAddresses));
    await expect(lookupOnce(lookup, true)).resolves.toEqual({
      address: publicAddresses,
      family: undefined,
    });
  });

  it('returns the first address and its family otherwise', async () => {
    const lookup = createGuardedLookup(stubResolver(publicAddresses));
    await expect(lookupOnce(lookup, false)).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('rejects when any resolved address is internal, and when nothing resolves', async () => {
    const mixed = createGuardedLookup(
      stubResolver([...publicAddresses, { address: '10.0.0.5', family: 4 }]),
    );
    await expect(lookupOnce(mixed, true)).rejects.toThrow(UnsafeUrlError);
    await expect(lookupOnce(createGuardedLookup(stubResolver([])), false)).rejects.toThrow(
      /No addresses/,
    );
  });

  describe('through an undici agent', () => {
    let server: Server;
    let port: number;

    beforeAll(async () => {
      server = createServer((_req, res) => res.end('ok'));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const loopback = stubResolver([{ address: '127.0.0.1', family: 4 }]);

    it('connects to a hostname resolved by the injected resolver (happy eyeballs path)', async () => {
      // The local test server is loopback, so this agent allows every address; the resolution and
      // array handling are what is under test, the blocklist is covered above
      const agent = new Agent({
        connect: { lookup: createGuardedLookup(loopback, () => true), autoSelectFamily: true },
      });
      const response = await request(`http://agent.example:${port}/`, { dispatcher: agent });
      expect(response.statusCode).toBe(200);
      expect(await response.body.text()).toBe('ok');
      await agent.close();
    });

    it('refuses the connection when the hostname resolves to a blocked address', async () => {
      const agent = new Agent({
        connect: { lookup: createGuardedLookup(loopback), autoSelectFamily: true },
      });
      await expect(request(`http://agent.example:${port}/`, { dispatcher: agent })).rejects.toThrow(
        /non-public address/,
      );
      await agent.close();
    });
  });
});
