import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BaseError,
  isHex,
  type Address,
  decodeErrorResult,
  encodeFunctionData,
  type Hex,
} from 'viem';
import {
  agentRegistryAbi,
  paymentRouterAbi,
  queryConsumerAbi,
  reputationManagerAbi,
  stakingPoolAbi,
  treasuryAbi,
} from '../chain/abis.js';
import { ChainService } from '../chain/chain.service.js';
import { describeError } from '../common/errors.js';
import { parseJsonBody, safeFetch } from '../common/safe-fetch.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { aggregateResponses } from './aggregation.js';
import {
  AGENT_PROTOCOL_VERSION,
  parseAgentResponse,
  responseDomain,
  responseMessage,
  responseTypes,
  type AgentQueryRequest,
} from './agent-protocol.js';

const LOOP_INTERVAL_MS = 3000;
const DISPATCH_BATCH = 20;
const SETTLE_BATCH = 10;
const MAX_ATTEMPTS = 5;
const AGENT_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
const SETTLE_BASE_BACKOFF_MS = 15_000;
const SETTLE_MAX_BACKOFF_MS = 10 * 60_000;
/** How often a query with no responses and no pending dispatches is re-checked before its deadline */
const SETTLE_WAITING_RECHECK_MS = 30_000;

type OracleCall =
  | { functionName: 'submitResponseFor'; args: readonly [Hex, Hex, Hex, Hex] }
  | { functionName: 'finalizeQuery'; args: readonly [Hex, Hex, readonly Hex[]] }
  | { functionName: 'failExpiredQuery'; args: readonly [Hex] };

/** Revert reasons that mean someone else already moved the query forward */
const ALREADY_HANDLED_ERRORS = new Set([
  'AlreadyResponded',
  'QueryNotPending',
  'QueryNotInProgress',
  'QueryExpired',
]);

/**
 * Revert reasons that mean "not yet" rather than failure: chain time has not passed the deadline
 * (QueryNotExpired), or responses arrived and the finalizer's grace window is open (FinalizationWindowOpen)
 */
const NOT_YET_ERRORS = new Set(['QueryNotExpired', 'FinalizationWindowOpen']);

/** Custom errors of every Verora contract, so reverts bubbled up from any of them decode by name */
const protocolErrorsAbi = [
  ...queryConsumerAbi,
  ...agentRegistryAbi,
  ...stakingPoolAbi,
  ...paymentRouterAbi,
  ...reputationManagerAbi,
  ...treasuryAbi,
].filter((item) => item.type === 'error');

/**
 * Oracle node: delivers on-chain queries to agents, relays their signed responses, and settles queries.
 *
 * All work is driven by database state written by the indexer (`Query.oracleState`, `QueryDispatch`),
 * so the oracle resumes after restarts and never depends on in-memory timers.
 */
@Injectable()
export class OracleService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OracleService.name);
  private readonly enabled: boolean;
  private readonly allowPrivateEndpoints: boolean;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.enabled = config.get('ORACLE_ENABLED', { infer: true });
    this.allowPrivateEndpoints = config.get('ALLOW_PRIVATE_AGENT_ENDPOINTS', { infer: true });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('Oracle disabled (ORACLE_ENABLED=false)');
      return;
    }
    await this.verifyFinalizerRole();
    this.schedule(0);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    try {
      await this.dispatchPending();
      await this.settleReady();
    } catch (error) {
      this.logger.error(`Oracle loop failed: ${this.describe(error)}`);
    }
    this.schedule(LOOP_INTERVAL_MS);
  }

  /** The finalizer role is granted by the contract owner at deploy time; the oracle never grants it itself */
  private async verifyFinalizerRole(): Promise<void> {
    const authorized = await this.chain.publicClient.readContract({
      address: this.chain.addresses.queryConsumer,
      abi: queryConsumerAbi,
      functionName: 'authorizedFinalizers',
      args: [this.chain.oracleWallet.account.address],
    });
    if (!authorized) {
      this.logger.warn(
        `Oracle signer ${this.chain.oracleWallet.account.address} is not an authorized finalizer; ` +
          'responses will still be relayed but queries can only settle through expiry.',
      );
    }
  }

  /** Sends due dispatches to agents and relays valid signed responses */
  async dispatchPending(): Promise<void> {
    const now = await this.chainTime();
    const dispatches = await this.prisma.queryDispatch.findMany({
      where: {
        status: 'pending',
        nextAttemptAt: { lte: now },
        query: {
          status: { in: ['pending', 'in_progress'] },
          deadline: { gt: now },
          cancelled: false,
        },
      },
      include: { query: true },
      orderBy: { nextAttemptAt: 'asc' },
      take: DISPATCH_BATCH,
    });

    await Promise.all(
      dispatches.map(async (dispatch) => {
        try {
          await this.deliver(dispatch.query, dispatch.agentId as Hex);
          await this.prisma.queryDispatch.update({
            where: { queryId_agentId: { queryId: dispatch.queryId, agentId: dispatch.agentId } },
            data: { status: 'relayed', attempts: { increment: 1 }, lastError: null },
          });
        } catch (error) {
          const attempts = dispatch.attempts + 1;
          const backoff = Math.min(5000 * 2 ** dispatch.attempts, MAX_BACKOFF_MS);
          await this.prisma.queryDispatch.update({
            where: { queryId_agentId: { queryId: dispatch.queryId, agentId: dispatch.agentId } },
            data: {
              attempts,
              status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
              nextAttemptAt: new Date(Date.now() + backoff),
              lastError: this.describe(error).slice(0, 500),
            },
          });
          this.logger.warn(
            `Dispatch ${dispatch.queryId}/${dispatch.agentId} attempt ${attempts} failed: ${this.describe(error)}`,
          );
        }
      }),
    );
  }

  private async deliver(
    query: { id: string; requester: string; queryType: string; queryData: string; deadline: Date },
    agentId: Hex,
  ): Promise<void> {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new Error('Agent is not indexed');

    const request: AgentQueryRequest = {
      version: AGENT_PROTOCOL_VERSION,
      chainId: this.chain.chain.id,
      queryConsumer: this.chain.addresses.queryConsumer,
      queryId: query.id as Hex,
      agentId,
      requester: query.requester as Address,
      queryType: query.queryType,
      queryData: query.queryData as Hex,
      deadline: Math.floor(query.deadline.getTime() / 1000),
    };

    const result = await safeFetch(agent.endpoint, {
      method: 'POST',
      body: request,
      timeoutMs: AGENT_TIMEOUT_MS,
      maxBytes: 64 * 1024,
      allowPrivate: this.allowPrivateEndpoints,
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Agent returned HTTP ${result.status}`);
    }

    const { responseData, signature } = parseAgentResponse(parseJsonBody<unknown>(result));

    // Verify before spending gas; supports EOA and ERC-1271 owners
    const valid = await this.chain.publicClient.verifyTypedData({
      address: agent.owner as Address,
      domain: responseDomain(this.chain.chain.id, this.chain.addresses.queryConsumer),
      types: responseTypes,
      primaryType: 'Response',
      // Query type and data come from the index (read from the contract), never from the agent's reply
      message: responseMessage(
        { queryId: query.id as Hex, queryType: query.queryType, queryData: query.queryData as Hex },
        agentId,
        responseData,
      ),
      signature,
    });
    if (!valid) throw new Error('Agent response signature is not from the agent owner');

    await this.write({
      functionName: 'submitResponseFor',
      args: [query.id as Hex, agentId, responseData, signature],
    });
  }

  /** Finalizes or expires queries whose dispatching is over */
  async settleReady(): Promise<void> {
    // Deadlines are enforced against block time, which can drift from wall-clock time
    const now = await this.chainTime();
    const queries = await this.prisma.query.findMany({
      where: {
        oracleState: 'dispatching',
        status: { in: ['pending', 'in_progress'] },
        // Queries that failed to settle or have nothing to settle yet wait their turn, so they can't
        // hold the batch and starve the queries behind them
        nextSettleAt: { lte: now },
        OR: [{ deadline: { lte: now } }, { dispatches: { none: { status: 'pending' } } }],
      },
      orderBy: { nextSettleAt: 'asc' },
      take: SETTLE_BATCH,
    });

    for (const query of queries) {
      try {
        const settled = await this.settle(query.id as Hex, query.queryType, query.deadline <= now);
        if (!settled) {
          // Nothing to settle yet: agents may still answer on-chain before the deadline, or the chain
          // refused expiry for now. Re-check soon, and no later than the deadline while it is ahead.
          const soon = now.getTime() + SETTLE_WAITING_RECHECK_MS;
          const recheck = query.deadline > now ? Math.min(soon, query.deadline.getTime()) : soon;
          await this.prisma.query.update({
            where: { id: query.id },
            data: { nextSettleAt: new Date(recheck) },
          });
        }
      } catch (error) {
        const backoff = Math.min(
          SETTLE_BASE_BACKOFF_MS * 2 ** query.settleAttempts,
          SETTLE_MAX_BACKOFF_MS,
        );
        await this.prisma.query.update({
          where: { id: query.id },
          data: {
            oracleError: this.describe(error).slice(0, 500),
            settleAttempts: { increment: 1 },
            nextSettleAt: new Date(now.getTime() + backoff),
          },
        });
        this.logger.warn(`Settling ${query.id} failed: ${this.describe(error)}`);
      }
    }
  }

  private async chainTime(): Promise<Date> {
    const block = await this.chain.publicClient.getBlock({ blockTag: 'latest' });
    return new Date(Number(block.timestamp) * 1000);
  }

  /**
   * Finalizes a query that has responses, or expires one that has none once its deadline passed.
   * Returns false when there is nothing to settle yet.
   */
  private async settle(queryId: Hex, queryType: string, expired: boolean): Promise<boolean> {
    // Read live chain state: the indexer may lag behind the latest block
    const responses = await this.chain.publicClient.readContract({
      address: this.chain.addresses.queryConsumer,
      abi: queryConsumerAbi,
      functionName: 'getResponses',
      args: [queryId],
    });

    if (responses.length > 0) {
      const { result, accepted } = aggregateResponses(
        queryType,
        responses.map((response) => response.responseData),
      );
      // Accepted responders are paid and credited; an empty list fails the query and refunds the requester
      const acceptedIndexes = new Set(accepted);
      const acceptedAgents = responses
        .filter((_, index) => acceptedIndexes.has(index))
        .map((response) => response.agentId);
      await this.write({ functionName: 'finalizeQuery', args: [queryId, result, acceptedAgents] });
    } else if (expired) {
      // Only for queries without responses: with responses the contract keeps a finalization window
      // open (FinalizationWindowOpen), and a response may land between the read above and this call
      try {
        await this.write({ functionName: 'failExpiredQuery', args: [queryId] });
      } catch (error) {
        const revert = this.revertName(error);
        if (revert !== null && NOT_YET_ERRORS.has(revert)) return false;
        throw error;
      }
    } else {
      return false;
    }

    await this.prisma.query.update({
      where: { id: queryId },
      data: { oracleState: 'done', oracleError: null },
    });
    return true;
  }

  /** Simulates first (so reverts never cost gas), then sends and waits for the receipt */
  private async write(call: OracleCall): Promise<void> {
    const wallet = this.chain.oracleWallet;
    const to = this.chain.addresses.queryConsumer;
    const data = encodeFunctionData({ abi: queryConsumerAbi, ...call });
    const { functionName } = call;
    try {
      await this.chain.publicClient.call({ account: wallet.account, to, data });
      const hash = await wallet.sendTransaction({ to, data });
      const receipt = await this.chain.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success')
        throw new Error(`${functionName} transaction ${hash} reverted`);
    } catch (error) {
      if (this.isAlreadyHandled(error)) return;
      throw error;
    }
  }

  private isAlreadyHandled(error: unknown): boolean {
    const errorName = this.revertName(error);
    return errorName !== null && ALREADY_HANDLED_ERRORS.has(errorName);
  }

  /** Decodes a protocol custom error from a failed call, if there is one */
  private revertName(error: unknown): string | null {
    if (!(error instanceof BaseError)) return null;
    // Revert data sits on different causes depending on the RPC path (call, estimateGas, send)
    const raw = error.walk((cause) => revertData(cause) !== undefined);
    const data = revertData(raw);
    if (!data) return null;
    try {
      return decodeErrorResult({ abi: protocolErrorsAbi, data }).errorName;
    } catch {
      return null;
    }
  }

  private describe(error: unknown): string {
    const revert = this.revertName(error);
    if (revert) return `reverted with ${revert}`;
    return describeError(error);
  }
}

function revertData(cause: unknown): Hex | undefined {
  if (typeof cause !== 'object' || cause === null || !('data' in cause)) return undefined;
  const { data } = cause;
  if (typeof data === 'string' && isHex(data) && data.length >= 10) return data;
  if (typeof data === 'object' && data !== null && 'data' in data) {
    const nested = data.data;
    if (typeof nested === 'string' && isHex(nested) && nested.length >= 10) return nested;
  }
  return undefined;
}
