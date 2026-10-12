import { Module } from '@nestjs/common';
import { MetadataModule } from '../metadata/metadata.module.js';
import { AgentsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';

@Module({
  imports: [MetadataModule],
  controllers: [AgentsController],
  providers: [AgentsService],
})
export class AgentsModule {}
