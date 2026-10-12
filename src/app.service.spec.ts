import { describe, expect, it, vi } from 'vitest';
import { AppService } from './app.service.js';
import type { ChainService } from './chain/chain.service.js';
import type { IndexerService, IndexerStatus } from './indexer/indexer.service.js';
import type { PrismaService } from './prisma/prisma.service.js';

function createService(status: Partial<IndexerStatus> = {}, rpcError?: Error) {
  const prisma = { $queryRaw: vi.fn().mockResolvedValue([1]) };
  const getBlockNumber = rpcError
    ? vi.fn().mockRejectedValue(rpcError)
    : vi.fn().mockResolvedValue(100n);
  const indexer: IndexerStatus = {
    enabled: true,
    lastIndexedBlock: '90',
    safeHead: '95',
    lagBlocks: 5,
    lastErrorKind: null,
    ...status,
  };
  const service = new AppService(
    prisma as unknown as PrismaService,
    { publicClient: { getBlockNumber } } as unknown as ChainService,
    { getStatus: () => indexer } as unknown as IndexerService,
  );
  return { service, prisma, getBlockNumber };
}

describe('AppService.getHealth', () => {
  it('reports healthy and serves concurrent and repeated calls from one probe', async () => {
    const { service, prisma, getBlockNumber } = createService();
    const [first, second] = await Promise.all([service.getHealth(), service.getHealth()]);
    const third = await service.getHealth();

    expect(first.status).toBe('healthy');
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(getBlockNumber).toHaveBeenCalledTimes(1);
  });

  it('never includes error messages, only error class names', async () => {
    const secret = 'https://rpc.example/v3/secret-api-key';
    const { service } = createService(
      { lastErrorKind: 'HttpRequestError' },
      new Error(`request to ${secret} failed`),
    );
    const report = await service.getHealth();

    expect(report.status).toBe('unhealthy');
    expect(report.checks.indexer.lastErrorKind).toBe('HttpRequestError');
    expect(JSON.stringify(report)).not.toContain('secret-api-key');
  });

  it('does not degrade an instance that runs without the indexer', async () => {
    const { service } = createService({ enabled: false, lagBlocks: null, safeHead: null });
    expect((await service.getHealth()).status).toBe('healthy');
  });
});
