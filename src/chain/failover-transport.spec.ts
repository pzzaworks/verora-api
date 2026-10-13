import { createPublicClient } from 'viem';
import { sepolia } from 'viem/chains';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { failover } from './failover-transport.js';

const PRIMARY = 'https://primary.example/rpc';
const BACKUP = 'https://backup.example/rpc';

type Reply = { result: unknown } | { error: { code: number; message: string } } | 'down';

/** Stubs fetch so each endpoint answers JSON-RPC with `reply(url)`; returns the URLs hit, in order */
function stubEndpoints(reply: (url: string) => Reply): string[] {
  const hits: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      hits.push(url);
      const answer = reply(url);
      if (answer === 'down') return Promise.resolve(new Response('unavailable', { status: 503 }));
      const { id } = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        id: number;
      };
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id, ...answer }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return hits;
}

function client(onSwitch = vi.fn()) {
  return {
    onSwitch,
    publicClient: createPublicClient({
      chain: sepolia,
      transport: failover([PRIMARY, BACKUP], { timeout: 1000, onSwitch }),
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('failover transport', () => {
  it('stays on the primary while it answers', async () => {
    const hits = stubEndpoints(() => ({ result: '0x10' }));
    const { publicClient } = client();
    await publicClient.getBlockNumber({ cacheTime: 0 });
    await publicClient.getBlockNumber({ cacheTime: 0 });
    expect(hits).toEqual([PRIMARY, PRIMARY]);
  });

  it('moves to the next endpoint when one is down, and stays there without probing the failed one', async () => {
    const hits = stubEndpoints((url) => (url === PRIMARY ? 'down' : { result: '0x10' }));
    const { publicClient, onSwitch } = client();
    await expect(publicClient.getBlockNumber({ cacheTime: 0 })).resolves.toBe(16n);
    await expect(publicClient.getBlockNumber({ cacheTime: 0 })).resolves.toBe(16n);

    expect(hits).toEqual([PRIMARY, BACKUP, BACKUP]);
    expect(onSwitch).toHaveBeenCalledOnce();
    expect(onSwitch.mock.calls[0]?.slice(0, 2)).toEqual(['primary.example', 'backup.example']);
  });

  it('throws execution reverts as they are instead of trying another endpoint', async () => {
    const hits = stubEndpoints(() => ({ error: { code: 3, message: 'execution reverted' } }));
    const { publicClient } = client();
    await expect(
      publicClient.call({ to: '0x0000000000000000000000000000000000000001', data: '0x' }),
    ).rejects.toThrow(/reverted/);
    expect(hits).toEqual([PRIMARY]);
  });
});
