import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Address, Hex } from 'viem';
import { stakingPoolAbi } from '../chain/abis.js';
import { ChainService } from '../chain/chain.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const APY_WINDOW_DAYS = 30;

export interface StakingStats {
  totalStaked: string;
  stakingPositions: number;
  rewardsDistributed30d: string;
  apy: number;
}

export interface AgentStakingStats {
  agentId: string;
  totalStaked: string;
  stakerCount: number;
  rewardsDistributed30d: string;
  apy: number;
}

export interface StakePosition {
  agentId: string;
  amount: string;
  shares: string;
  pendingRewards: string;
  unbondingAmount: string;
  withdrawableAmount: string;
  nextUnlockTime: number;
}

@Injectable()
export class StakingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
  ) {}

  async stats(): Promise<StakingStats> {
    const since = new Date(Date.now() - APY_WINDOW_DAYS * 86_400_000);
    const [stake, rewards] = await Promise.all([
      this.prisma.agent.aggregate({ _sum: { totalStake: true, stakerCount: true } }),
      this.prisma.stakingEvent.aggregate({
        where: { kind: 'rewards_distributed', timestamp: { gte: since } },
        _sum: { amount: true },
      }),
    ]);

    const totalStaked = stake._sum.totalStake ?? new Prisma.Decimal(0);
    const distributed = rewards._sum.amount ?? new Prisma.Decimal(0);
    return {
      totalStaked: totalStaked.toFixed(0),
      stakingPositions: stake._sum.stakerCount ?? 0,
      rewardsDistributed30d: distributed.toFixed(0),
      apy: annualizedYield(distributed, totalStaked),
    };
  }

  async agentStats(agentId: string): Promise<AgentStakingStats> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { totalStake: true, stakerCount: true },
    });
    if (!agent) throw new NotFoundException('Agent not found');

    const since = new Date(Date.now() - APY_WINDOW_DAYS * 86_400_000);
    const rewards = await this.prisma.stakingEvent.aggregate({
      where: { agentId, kind: 'rewards_distributed', timestamp: { gte: since } },
      _sum: { amount: true },
    });
    const distributed = rewards._sum.amount ?? new Prisma.Decimal(0);

    return {
      agentId,
      totalStaked: agent.totalStake.toFixed(0),
      stakerCount: agent.stakerCount,
      rewardsDistributed30d: distributed.toFixed(0),
      apy: annualizedYield(distributed, agent.totalStake),
    };
  }

  /** Live positions for a staker, read from the contract for every agent they ever staked on */
  async positions(staker: string): Promise<StakePosition[]> {
    const agents = await this.prisma.stakingEvent.findMany({
      where: { staker: staker.toLowerCase(), kind: 'staked' },
      distinct: ['agentId'],
      select: { agentId: true },
    });

    const positions = await Promise.all(
      agents.map(async ({ agentId }) => {
        const info = await this.chain.publicClient.readContract({
          address: this.chain.addresses.stakingPool,
          abi: stakingPoolAbi,
          functionName: 'getStake',
          args: [agentId as Hex, staker as Address],
        });
        return {
          agentId,
          amount: info.amount.toString(),
          shares: info.shares.toString(),
          pendingRewards: info.pendingRewards.toString(),
          unbondingAmount: info.unbondingAmount.toString(),
          withdrawableAmount: info.withdrawableAmount.toString(),
          nextUnlockTime: Number(info.nextUnlockTime),
        };
      }),
    );

    return positions.filter(
      (position) =>
        position.shares !== '0' ||
        position.unbondingAmount !== '0' ||
        position.pendingRewards !== '0',
    );
  }
}

/** Rewards of the trailing window annualized against current stake, as a percentage */
function annualizedYield(rewards: Prisma.Decimal, staked: Prisma.Decimal): number {
  if (staked.isZero()) return 0;
  const yearly = rewards.mul(365).div(APY_WINDOW_DAYS);
  return Number(yearly.div(staked).mul(100).toDecimalPlaces(2));
}
