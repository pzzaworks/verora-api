import type { ConfigService } from '@nestjs/config';
import {
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  type Hex,
} from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { queryConsumerAbi } from '../chain/abis.js';
import type { ChainService } from '../chain/chain.service.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { IndexerService } from './indexer.service.js';

const QUERY_CONSUMER: Hex = `0x${'2'.repeat(40)}`;
const QUERY_ID: Hex = `0x${'1'.repeat(64)}`;
const REQUESTER: Hex = `0x${'3'.repeat(40)}`;
const TX_HASH: Hex = `0x${'4'.repeat(64)}`;

function queryCreatedLog(blockNumber: bigint) {
  return {
    address: QUERY_CONSUMER,
    topics: encodeEventTopics({
      abi: queryConsumerAbi,
      eventName: 'QueryCreated',
      args: { queryId: QUERY_ID, requester: REQUESTER },
    }),
    data: encodeAbiParameters([{ type: 'string' }, { type: 'uint256' }], ['plaintext', 1n]),
    blockNumber,
    blockHash: `0x${'5'.repeat(64)}`,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

function createService(options: {
  cursor: bigint;
  safeHead: bigint;
  head: bigint;
  logs: unknown[];
  storedQueries: { id: string }[];
  readContract: () => Promise<unknown>;
}) {
  const prisma = {
    indexerState: {
      findUnique: vi.fn().mockResolvedValue({ lastBlock: options.cursor }),
      upsert: vi.fn().mockResolvedValue({}),
    },
    query: {
      findMany: vi.fn().mockResolvedValue(options.storedQueries),
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
  const getLogs = vi.fn().mockResolvedValue(options.logs);
  const chain = {
    getSafeBlockNumber: () => Promise.resolve(options.safeHead),
    publicClient: {
      getBlockNumber: () => Promise.resolve(options.head),
      getLogs,
      readContract: vi.fn(options.readContract),
    },
    addresses: {
      agentRegistry: `0x${'6'.repeat(40)}`,
      queryConsumer: QUERY_CONSUMER,
      stakingPool: `0x${'7'.repeat(40)}`,
      paymentRouter: `0x${'8'.repeat(40)}`,
      reputationManager: `0x${'9'.repeat(40)}`,
    },
    startBlock: 0n,
  };
  const config = { get: () => false } as unknown as ConfigService<EnvironmentVariables, true>;
  const service = new IndexerService(
    prisma as unknown as PrismaService,
    chain as unknown as ChainService,
    config,
  );
  return { service, prisma, getLogs };
}

const queryInfo = {
  requester: REQUESTER,
  queryType: 'plaintext',
  queryData: '0x',
  payment: 1n,
  deadline: 2_000_000_000n,
  assignedAgents: [`0x${'a'.repeat(64)}`],
  createdAt: 1_900_000_000n,
  status: 0,
};

describe('IndexerService.indexUnsafeQueries', () => {
  it('mirrors queries created above the safe head so the oracle can dispatch them', async () => {
    const { service, prisma, getLogs } = createService({
      cursor: 100n,
      safeHead: 100n,
      head: 105n,
      logs: [queryCreatedLog(103n)],
      storedQueries: [],
      readContract: () => Promise.resolve(queryInfo),
    });
    // Caught up with the safe head: records block 100 as the last indexed one
    await expect(service.indexNextRange()).resolves.toBe(true);
    await service.indexUnsafeQueries();

    expect(getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 101n, toBlock: 105n }),
    );
    expect(prisma.query.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.query.upsert.mock.calls[0]?.[0]).toMatchObject({
      where: { id: QUERY_ID },
      create: {
        blockNumber: 103n,
        txHash: TX_HASH,
        dispatches: { create: [{ agentId: queryInfo.assignedAgents[0] }] },
      },
    });
  });

  it('leaves queries it already mirrored alone', async () => {
    const { service, prisma } = createService({
      cursor: 100n,
      safeHead: 100n,
      head: 105n,
      logs: [queryCreatedLog(103n)],
      storedQueries: [{ id: QUERY_ID }],
      readContract: () => Promise.resolve(queryInfo),
    });
    await service.indexNextRange();
    await service.indexUnsafeQueries();
    expect(prisma.query.upsert).not.toHaveBeenCalled();
  });
});

describe('IndexerService.indexNextRange', () => {
  it('drops a mirrored query whose block the safe chain no longer has', async () => {
    const notFound = new ContractFunctionRevertedError({
      abi: queryConsumerAbi,
      data: encodeErrorResult({
        abi: queryConsumerAbi,
        errorName: 'QueryNotFound',
        args: [QUERY_ID],
      }),
      functionName: 'getQuery',
    });
    const { service, prisma } = createService({
      cursor: 100n,
      safeHead: 110n,
      head: 110n,
      logs: [],
      storedQueries: [{ id: QUERY_ID }],
      readContract: () => Promise.reject(notFound),
    });
    await service.indexNextRange();
    expect(prisma.query.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { blockNumber: { gte: 101n, lte: 110n }, id: { notIn: [] } },
    });
    expect(prisma.query.delete).toHaveBeenCalledWith({ where: { id: QUERY_ID } });
  });

  it('keeps a mirrored query that still exists on the safe chain', async () => {
    const { service, prisma } = createService({
      cursor: 100n,
      safeHead: 110n,
      head: 110n,
      logs: [],
      storedQueries: [{ id: QUERY_ID }],
      readContract: () => Promise.resolve(queryInfo),
    });
    await service.indexNextRange();
    expect(prisma.query.delete).not.toHaveBeenCalled();
  });
});
