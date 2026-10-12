import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { HexIdPipe } from '../common/pipes/hex-id.pipe.js';
import {
  StakingService,
  type AgentStakingStats,
  type StakePosition,
  type StakingStats,
} from './staking.service.js';

/** Staking data. Staking itself happens on-chain through StakingPool. */
@ApiTags('Staking')
@Controller('staking')
export class StakingController {
  constructor(private readonly staking: StakingService) {}

  @Get('stats')
  @ApiOperation({
    summary: 'Network staking statistics (APY from the trailing 30 days of rewards)',
  })
  stats(): Promise<StakingStats> {
    return this.staking.stats();
  }

  @Get('agents/:agentId')
  @ApiOperation({ summary: 'Staking statistics for one agent' })
  agentStats(@Param('agentId', new HexIdPipe(32)) agentId: string): Promise<AgentStakingStats> {
    return this.staking.agentStats(agentId);
  }

  @Get('positions/:address')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Live stake positions of a wallet' })
  positions(@Param('address', new HexIdPipe(20)) address: string): Promise<StakePosition[]> {
    return this.staking.positions(address);
  }
}
