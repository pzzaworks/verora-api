import { Module } from '@nestjs/common';
import { StakingController } from './staking.controller.js';
import { StakingService } from './staking.service.js';

@Module({
  controllers: [StakingController],
  providers: [StakingService],
})
export class StakingModule {}
