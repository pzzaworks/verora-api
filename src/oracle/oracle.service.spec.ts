import type { ConfigService } from '@nestjs/config';
import {
  BaseError,
  decodeFunctionData,
  encodeErrorResult,
  type Hex,
  type TransactionRequest,
} from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { queryConsumerAbi } from '../chain/abis.js';
import type { ChainService } from '../chain/chain.service.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { OracleService } from './oracle.service.js';

const CHAIN_NOW = new Date('2026-10-13T12:00:00Z');
const QUERY_ID: Hex = `0x${'1'.repeat(64)}`;

interface QueryUpdate {
  where: { id: string };
  data: { nextSettleAt?: Date; settleAttempts?: { increment: number }; oracleError?: string };
}

function createService(
  query: { deadline: Date; settleAttempts: number },
  responses: unknown,
  callError?: Error,
) {
  const update = vi.fn((_args: QueryUpdate) => Promise.resolve({}));
  const findMany = vi.fn().mockResolvedValue([{ id: QUERY_ID, queryType: 'price', ...query }]);
  const readContract =
    responses instanceof Error
      ? vi.fn().mockRejectedValue(responses)
      : vi.fn().mockResolvedValue(responses);
  const chain = {
    publicClient: {
      getBlock: () => Promise.resolve({ timestamp: BigInt(CHAIN_NOW.getTime() / 1000) }),
      readContract,
      call: callError ? vi.fn().mockRejectedValue(callError) : vi.fn().mockResolvedValue({}),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    },
    addresses: { queryConsumer: `0x${'2'.repeat(40)}` },
    oracleWallet: {
      account: { address: `0x${'3'.repeat(40)}` },
      sendTransaction: vi.fn((_tx: TransactionRequest) => Promise.resolve(`0x${'4'.repeat(64)}`)),
    },
  };
  const config = { get: () => false } as unknown as ConfigService<EnvironmentVariables, true>;
  const service = new OracleService(
    { query: { findMany, update } } as unknown as PrismaService,
    chain as unknown as ChainService,
    config,
  );
  return { service, update, findMany, sendTransaction: chain.oracleWallet.sendTransaction };
}

describe('OracleService.settleReady', () => {
  it('only selects queries whose settle backoff has elapsed', async () => {
    const { service, findMany } = createService(
      { deadline: new Date(CHAIN_NOW.getTime() + 3_600_000), settleAttempts: 0 },
      [],
    );
    await service.settleReady();
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { nextSettleAt: { lte: CHAIN_NOW } },
      orderBy: { nextSettleAt: 'asc' },
    });
  });

  it('backs a failing query off exponentially instead of retrying it every tick', async () => {
    const { service, update } = createService(
      { deadline: new Date(CHAIN_NOW.getTime() - 1000), settleAttempts: 2 },
      new Error('rpc down'),
    );
    await service.settleReady();

    const data = update.mock.calls[0]?.[0].data;
    expect(data?.settleAttempts).toEqual({ increment: 1 });
    expect(data?.oracleError).toBe('rpc down');
    expect(data?.nextSettleAt?.getTime()).toBe(CHAIN_NOW.getTime() + 15_000 * 4);
  });

  it('parks a query with nothing to settle until a recheck no later than its deadline', async () => {
    const deadline = new Date(CHAIN_NOW.getTime() + 10_000);
    const { service, update } = createService({ deadline, settleAttempts: 0 }, []);
    await service.settleReady();
    expect(update.mock.calls[0]?.[0].data.nextSettleAt).toEqual(deadline);
  });

  it('finalizes with only the agents whose responses the aggregation accepted', async () => {
    const agent = (digit: string): Hex => `0x${digit.repeat(64)}`;
    const { service, sendTransaction } = createService(
      { deadline: new Date(CHAIN_NOW.getTime() - 1000), settleAttempts: 0 },
      [
        { agentId: agent('a'), responseData: '0xaa' },
        { agentId: agent('b'), responseData: '0xbbbb' },
        { agentId: agent('c'), responseData: '0xaa' },
      ],
    );
    await service.settleReady();

    const data = sendTransaction.mock.calls[0]?.[0].data;
    expect(data).toBeDefined();
    const decoded = decodeFunctionData({ abi: queryConsumerAbi, data: data as Hex });
    expect(decoded.functionName).toBe('finalizeQuery');
    expect(decoded.args).toEqual([QUERY_ID, '0xaa', [agent('a'), agent('c')]]);
  });

  it('treats FinalizationWindowOpen on expiry as not yet, without an error or backoff', async () => {
    const revert = encodeErrorResult({
      abi: queryConsumerAbi,
      errorName: 'FinalizationWindowOpen',
      args: [QUERY_ID, 1n],
    });
    const callError = new BaseError('Execution reverted', {
      cause: Object.assign(new Error('revert'), { data: revert }),
    });
    const { service, update, sendTransaction } = createService(
      { deadline: new Date(CHAIN_NOW.getTime() - 1000), settleAttempts: 0 },
      [],
      callError,
    );
    await service.settleReady();

    expect(sendTransaction).not.toHaveBeenCalled();
    const data = update.mock.calls[0]?.[0].data;
    expect(data?.settleAttempts).toBeUndefined();
    expect(data?.oracleError).toBeUndefined();
    expect(data?.nextSettleAt?.getTime()).toBe(CHAIN_NOW.getTime() + 30_000);
  });
});
