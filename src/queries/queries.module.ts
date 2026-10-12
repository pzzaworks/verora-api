import { Module } from '@nestjs/common';
import { QueriesController } from './queries.controller.js';
import { QueriesService } from './queries.service.js';

@Module({
  controllers: [QueriesController],
  providers: [QueriesService],
})
export class QueriesModule {}
