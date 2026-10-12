import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { parseEventLogs, type Hex } from 'viem';
import {
  agentRegistryAbi,
  paymentRouterAbi,
  queryConsumerAbi,
  reputationManagerAbi,
  stakingPoolAbi,
} from '../chain/abis.js';
import { ChainService } from '../chain/chain.service.js';
import { describeError, errorKind } from '../common/errors.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { PrismaService } from '../prisma/prisma.service.js';

const CURSOR_ID = 'main';
const MAX_BLOCK_RANGE = 2000n;
const POLL_INTERVAL_MS = 2000;
const ERROR_BACKOFF_MS = 10_000;

const AGENT_STATUS = ['inactive', 'active', 'suspended', 'slashed'] as const;
const QUERY_STATUS = ['pending', 'in_progress', 'completed', 'failed'] as const;

const indexedAbi = [
  ...agentRegistryAbi,
  ...queryConsumerAbi,
  ...stakingPoolAbi,
  ...paymentRouterAbi,
  ...reputationManagerAbi,
] as const;

type ParsedLog = ReturnType<typeof parseEventLogs<typeof indexedAbi>>[number];

const STAKING_EVENT_KINDS: Record<string, string> = {
  Staked: 'staked',
  Unstaked: 'unstaked',
  Withdrawn: 'withdrawn',
  Slashed: 'slashed',
  RewardsDistributed: 'rewards_distributed',
  RewardsClaimed: 'rewards_claimed',
};

export interface IndexerStatus {
  enabled: boolean;
  lastIndexedBlock: string | null;
  safeHead: string | null;
  lagBlocks: number | null;
  /** Class name of the last indexing error (the message is only logged, it can carry RPC details) */
  lastErrorKind: string | null;
}

/**
 * Mirrors on-chain state into Postgres.
 *
 * - The cursor is persisted, so restarts resume where indexing stopped (no lost events).
 * - Only blocks at least `CONFIRMATIONS` deep are indexed, to stay clear of reorgs.
 * - Handlers re-read contract state at the batch's block and upsert, so replaying a range is harmless.
 * - The loop schedules the next run only after the current one finishes, so runs never overlap.
 */
@Injectable()
export class IndexerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(IndexerService.name);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly enabled: boolean;
  private status: IndexerStatus;
  private readonly blockTimestamps = new Map<bigint, Date>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.enabled = config.get('INDEXER_ENABLED', { infer: true });
    this.status = {
      enabled: this.enabled,
      lastIndexedBlock: null,
      safeHead: null,
      lagBlocks: null,
      lastErrorKind: null,
    };
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Indexer disabled (INDEXER_ENABLED=false)');
      return;
    }
    this.schedule(0);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  getStatus(): IndexerStatus {
    return { ...this.status };
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    let delay = POLL_INTERVAL_MS;
    try {
      const caughtUp = await this.indexNextRange();
      if (!caughtUp) delay = 0;
      this.status.lastErrorKind = null;
    } catch (error) {
      delay = ERROR_BACKOFF_MS;
      this.status.lastErrorKind = errorKind(error);
      this.logger.error(`Indexing failed: ${describeError(error)}`);
    }
    this.schedule(delay);
  }

  /** Indexes one block range. Returns true when the indexer is caught up with the safe head. */
  async indexNextRange(): Promise<boolean> {
    const safeHead = await this.chain.getSafeBlockNumber();
    const cursor = await this.prisma.indexerState.findUnique({ where: { id: CURSOR_ID } });
    const fromBlock = cursor ? cursor.lastBlock + 1n : this.chain.startBlock;

    this.status.safeHead = safeHead.toString();
    if (fromBlock > safeHead) {
      this.updateLag(cursor?.lastBlock ?? fromBlock - 1n, safeHead);
      return true;
    }

    const toBlock =
      fromBlock + MAX_BLOCK_RANGE - 1n < safeHead ? fromBlock + MAX_BLOCK_RANGE - 1n : safeHead;
    const { addresses } = this.chain;

    const rawLogs = await this.chain.publicClient.getLogs({
      address: [
        addresses.agentRegistry,
        addresses.queryConsumer,
        addresses.stakingPool,
        addresses.paymentRouter,
        addresses.reputationManager,
      ],
      fromBlock,
      toBlock,
    });

    const logs = parseEventLogs({ abi: indexedAbi, logs: rawLogs });
    for (const log of logs) {
      await this.handleLog(log, toBlock);
    }

    await this.prisma.indexerState.upsert({
      where: { id: CURSOR_ID },
      create: { id: CURSOR_ID, lastBlock: toBlock },
      update: { lastBlock: toBlock },
    });

    this.updateLag(toBlock, safeHead);
    this.blockTimestamps.clear();
    if (logs.length > 0) {
      this.logger.log(`Indexed ${logs.length} events in blocks ${fromBlock}-${toBlock}`);
    }
    return toBlock === safeHead;
  }

  private updateLag(lastBlock: bigint, safeHead: bigint): void {
    this.status.lastIndexedBlock = lastBlock.toString();
    this.status.lagBlocks = Number(safeHead > lastBlock ? safeHead - lastBlock : 0n);
  }

  private async handleLog(log: ParsedLog, atBlock: bigint): Promise<void> {
    const address = log.address.toLowerCase();
    const { addresses } = this.chain;
    const args = log.args as Record<string, unknown>;

    if (address === addresses.agentRegistry.toLowerCase()) {
      if ('agentId' in args) await this.syncAgent(args.agentId as Hex, atBlock);
      return;
    }

    if (address === addresses.reputationManager.toLowerCase()) {
      if (log.eventName === 'ReputationUpdated')
        await this.syncReputation(args.agentId as Hex, atBlock);
      return;
    }

    if (address === addresses.queryConsumer.toLowerCase()) {
      if (!('queryId' in args)) return;
      const queryId = args.queryId as Hex;
      if (log.eventName === 'QueryCreated') {
        await this.syncQuery(queryId, atBlock, log.transactionHash, log.blockNumber);
      } else if (log.eventName === 'ResponseSubmitted') {
        await this.syncResponse(queryId, args.agentId as Hex, atBlock, log.transactionHash);
        await this.syncQuery(queryId, atBlock, log.transactionHash, log.blockNumber);
      } else if (log.eventName === 'QueryFinalized') {
        await this.syncQuery(
          queryId,
          atBlock,
          log.transactionHash,
          log.blockNumber,
          await this.blockTimestamp(log.blockNumber),
        );
      } else if (log.eventName === 'QueryCancelled') {
        await this.syncQuery(queryId, atBlock, log.transactionHash, log.blockNumber);
        await this.prisma.query.update({
          where: { id: queryId.toLowerCase() },
          data: { cancelled: true },
        });
      }
      return;
    }

    if (address === addresses.stakingPool.toLowerCase()) {
      const kind = STAKING_EVENT_KINDS[log.eventName];
      if (!kind) return;
      const agentId = (args.agentId as Hex).toLowerCase();
      await this.prisma.stakingEvent.upsert({
        where: { id: this.logId(log) },
        create: {
          id: this.logId(log),
          agentId,
          staker: typeof args.staker === 'string' ? args.staker.toLowerCase() : null,
          kind,
          amount: new Prisma.Decimal((args.amount as bigint).toString()),
          blockNumber: log.blockNumber,
          timestamp: await this.blockTimestamp(log.blockNumber),
        },
        update: {},
      });
      await this.syncStake(agentId as Hex, atBlock);
      return;
    }

    if (address === addresses.paymentRouter.toLowerCase() && log.eventName === 'PaymentProcessed') {
      await this.prisma.payment.upsert({
        where: { id: this.logId(log) },
        create: {
          id: this.logId(log),
          queryId: (args.queryId as Hex).toLowerCase(),
          agentId: (args.agentId as Hex).toLowerCase(),
          payee: (args.payee as string).toLowerCase(),
          amount: new Prisma.Decimal((args.amount as bigint).toString()),
          blockNumber: log.blockNumber,
          timestamp: await this.blockTimestamp(log.blockNumber),
        },
        update: {},
      });
    }
  }

  private logId(log: ParsedLog): string {
    return `${log.transactionHash}:${log.logIndex}`;
  }

  private async blockTimestamp(blockNumber: bigint): Promise<Date> {
    const cached = this.blockTimestamps.get(blockNumber);
    if (cached) return cached;
    const block = await this.chain.publicClient.getBlock({ blockNumber });
    const timestamp = new Date(Number(block.timestamp) * 1000);
    this.blockTimestamps.set(blockNumber, timestamp);
    return timestamp;
  }

  async syncAgent(agentId: Hex, atBlock: bigint): Promise<void> {
    const registry = {
      address: this.chain.addresses.agentRegistry,
      abi: agentRegistryAbi,
      blockNumber: atBlock,
    };
    const [info, status, adminSuspended] = await Promise.all([
      this.chain.publicClient.readContract({
        ...registry,
        functionName: 'getAgent',
        args: [agentId],
      }),
      this.chain.publicClient.readContract({
        ...registry,
        functionName: 'getAgentStatus',
        args: [agentId],
      }),
      this.chain.publicClient.readContract({
        ...registry,
        functionName: 'adminSuspended',
        args: [agentId],
      }),
    ]);

    const id = agentId.toLowerCase();
    const existing = await this.prisma.agent.findUnique({
      where: { id },
      select: { metadataUri: true },
    });
    const metadataChanged = existing?.metadataUri !== info.metadataURI;

    const data = {
      owner: info.owner.toLowerCase(),
      endpoint: info.endpoint,
      capabilities: [...info.capabilities],
      metadataUri: info.metadataURI,
      status: AGENT_STATUS.at(status) ?? 'inactive',
      adminSuspended,
      registeredAt: new Date(Number(info.registeredAt) * 1000),
      // A new metadata URI is resolved again by the metadata worker
      ...(metadataChanged
        ? {
            metadata: Prisma.DbNull,
            metadataFetchedAt: null,
            metadataError: null,
            metadataAttempts: 0,
            metadataRetryAt: null,
          }
        : {}),
    };

    await this.prisma.agent.upsert({ where: { id }, create: { id, ...data }, update: data });
  }

  private async syncReputation(agentId: Hex, atBlock: bigint): Promise<void> {
    const reputation = {
      address: this.chain.addresses.reputationManager,
      abi: reputationManagerAbi,
      blockNumber: atBlock,
    };
    const [score, stats] = await Promise.all([
      this.chain.publicClient.readContract({
        ...reputation,
        functionName: 'getReputation',
        args: [agentId],
      }),
      this.chain.publicClient.readContract({
        ...reputation,
        functionName: 'getQueryStats',
        args: [agentId],
      }),
    ]);

    await this.prisma.agent.updateMany({
      where: { id: agentId.toLowerCase() },
      data: {
        reputation: Number(score),
        totalQueries: Number(stats.totalQueries),
        successfulQueries: Number(stats.successfulQueries),
        failedQueries: Number(stats.failedQueries),
      },
    });
  }

  private async syncStake(agentId: Hex, atBlock: bigint): Promise<void> {
    const staking = {
      address: this.chain.addresses.stakingPool,
      abi: stakingPoolAbi,
      blockNumber: atBlock,
    };
    const [total, stakers] = await Promise.all([
      this.chain.publicClient.readContract({
        ...staking,
        functionName: 'getTotalStake',
        args: [agentId],
      }),
      this.chain.publicClient.readContract({
        ...staking,
        functionName: 'getStakerCount',
        args: [agentId],
      }),
    ]);

    await this.prisma.agent.updateMany({
      where: { id: agentId.toLowerCase() },
      data: { totalStake: new Prisma.Decimal(total.toString()), stakerCount: Number(stakers) },
    });
  }

  private async syncQuery(
    queryId: Hex,
    atBlock: bigint,
    txHash: Hex,
    blockNumber: bigint,
    finalizedAt?: Date,
  ): Promise<void> {
    const consumer = {
      address: this.chain.addresses.queryConsumer,
      abi: queryConsumerAbi,
      blockNumber: atBlock,
    };
    const info = await this.chain.publicClient.readContract({
      ...consumer,
      functionName: 'getQuery',
      args: [queryId],
    });
    const aggregated = finalizedAt
      ? await this.chain.publicClient.readContract({
          ...consumer,
          functionName: 'getAggregatedResult',
          args: [queryId],
        })
      : undefined;

    const id = queryId.toLowerCase();
    const status = QUERY_STATUS.at(info.status) ?? 'pending';
    const terminal = status === 'completed' || status === 'failed';

    const data = {
      status,
      ...(aggregated !== undefined ? { aggregatedResult: aggregated, finalizedAt } : {}),
      ...(terminal ? { oracleState: 'done' } : {}),
    };

    await this.prisma.query.upsert({
      where: { id },
      create: {
        id,
        requester: info.requester.toLowerCase(),
        queryType: info.queryType,
        queryData: info.queryData,
        payment: new Prisma.Decimal(info.payment.toString()),
        deadline: new Date(Number(info.deadline) * 1000),
        assignedAgents: info.assignedAgents.map((agent) => agent.toLowerCase()),
        createdAt: new Date(Number(info.createdAt) * 1000),
        txHash,
        blockNumber,
        dispatches: {
          create: info.assignedAgents.map((agent) => ({ agentId: agent.toLowerCase() })),
        },
        ...data,
      },
      update: data,
    });
  }

  private async syncResponse(
    queryId: Hex,
    agentId: Hex,
    atBlock: bigint,
    txHash: Hex,
  ): Promise<void> {
    const consumer = {
      address: this.chain.addresses.queryConsumer,
      abi: queryConsumerAbi,
      blockNumber: atBlock,
    };
    const responses = await this.chain.publicClient.readContract({
      ...consumer,
      functionName: 'getResponses',
      args: [queryId],
    });
    const response = responses.find(
      (entry) => entry.agentId.toLowerCase() === agentId.toLowerCase(),
    );
    if (!response) return;

    const key = { queryId: queryId.toLowerCase(), agentId: agentId.toLowerCase() };
    await this.prisma.queryResponse.upsert({
      where: { queryId_agentId: key },
      create: {
        ...key,
        responseData: response.responseData,
        submittedAt: new Date(Number(response.submittedAt) * 1000),
        txHash,
      },
      update: {},
    });
    await this.prisma.queryDispatch.updateMany({
      where: key,
      data: { status: 'relayed', lastError: null },
    });
  }
}
