import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Paginated } from '../common/dto/pagination.dto.js';
import { HexIdPipe } from '../common/pipes/hex-id.pipe.js';
import { AgentsService, type AgentView } from './agents.service.js';
import { ListAgentsQueryDto } from './dto/list-agents.dto.js';

/** Read-only view of the on-chain agent registry. Agents register on-chain (app or SDK). */
@ApiTags('Agents')
@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  @ApiOperation({ summary: 'List indexed agents' })
  list(@Query() query: ListAgentsQueryDto): Promise<Paginated<AgentView>> {
    return this.agents.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an agent with resolved metadata and health' })
  get(@Param('id', new HexIdPipe(32)) id: string): Promise<AgentView> {
    return this.agents.get(id);
  }
}
