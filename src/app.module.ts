import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AgentsModule } from './agents/agents.module.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { ChainModule } from './chain/chain.module.js';
import { validateEnv } from './config/env.validation.js';
import { IndexerModule } from './indexer/indexer.module.js';
import { MetadataModule } from './metadata/metadata.module.js';
import { OracleModule } from './oracle/oracle.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { QueriesModule } from './queries/queries.module.js';
import { StakingModule } from './staking/staking.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnv,
    }),
    // Default limit for every route; stricter limits are set per route with @Throttle
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    PrismaModule,
    ChainModule,
    IndexerModule,
    AuthModule,
    MetadataModule,
    AgentsModule,
    QueriesModule,
    StakingModule,
    OracleModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
