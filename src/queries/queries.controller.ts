import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Paginated } from '../common/dto/pagination.dto.js';
import { HexIdPipe } from '../common/pipes/hex-id.pipe.js';
import { ListQueriesDto } from './dto/list-queries.dto.js';
import {
  QueriesService,
  type NetworkStats,
  type QueryDetailView,
  type QueryView,
} from './queries.service.js';

/** Read-only view of on-chain queries. Queries are created and paid on-chain via QueryConsumer. */
@ApiTags('Queries')
@Controller('queries')
export class QueriesController {
  constructor(private readonly queries: QueriesService) {}

  @Get()
  @ApiOperation({ summary: 'List indexed queries' })
  list(@Query() query: ListQueriesDto): Promise<Paginated<QueryView>> {
    return this.queries.list(query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Network-wide query and agent statistics' })
  stats(): Promise<NetworkStats> {
    return this.queries.stats();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a query with its responses and oracle delivery state' })
  get(@Param('id', new HexIdPipe(32)) id: string): Promise<QueryDetailView> {
    return this.queries.get(id);
  }
}
